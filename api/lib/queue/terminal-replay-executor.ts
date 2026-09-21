import { and, eq } from "drizzle-orm";
import {
  creditTransactions,
  publishingQueue,
  queueReplayActiveClaims,
  queueReplayRequests,
  queueTerminalFailures,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  inspectPublishingJob,
  removePublishingJobById,
  schedulePublishingJob,
  toPublishingBullMqJobId,
} from "./bullmq";
import { sanitizeBoundedText } from "./terminal-failure";
import {
  TerminalReplayRequestNotFoundError,
  claimTerminalReplayRequest,
  markTerminalReplayEnqueued,
  markTerminalReplayFailed,
  markTerminalReplayResolved,
  withTerminalReplayTransaction,
  type TerminalReplayExecutor,
} from "./terminal-replay";

/**
 * Controlled publishing terminal replay executor (WBS9D2A).
 *
 * Consumes the WBS9D1 replay-request authority and safely reaches:
 *   requested -> claimed -> publishing row rearmed -> deterministic BullMQ
 *   replay enqueued -> replay request status enqueued.
 *
 * The request intentionally remains "enqueued" here; worker completion /
 * final reconciliation is a later slice. The terminalFailureId active-claim
 * guard stays held while enqueued.
 *
 * Safety properties:
 * - The re-armed publishing row is BullMQ-only: nextRetryAt = null and the
 *   legacy cron predicate (buildDuePostsCondition) only selects retrying rows
 *   with a non-null, due nextRetryAt.
 * - failed -> retrying is permitted ONLY when exactly one durable publishing
 *   deduction attributable to the same queue item exists (already charged);
 *   publishSinglePost skips the deduction while retrying. Zero or ambiguous
 *   evidence fails closed — this slice never mutates billing.
 * - A live deterministic BullMQ job is treated as "already established by
 *   THIS replay" only with the full ownership marker match.
 */

/** Canonical one-credit publishing deduction (stored negative = spent). */
const PUBLISHING_DEDUCTION_CREDIT_AMOUNT = 1;

export type PublishingTerminalReplayOutcome =
  | { outcome: "enqueued"; replayRequestId: number; replayBullmqJobId: string }
  | { outcome: "already_enqueued"; replayRequestId: number; replayBullmqJobId: string | null }
  | { outcome: "already_completed"; replayRequestId: number }
  | { outcome: "terminal"; replayRequestId: number; status: "resolved" | "failed" };

export class PublishingReplayValidationError extends Error {
  readonly code:
    | "operator_mismatch"
    | "wrong_replay_mode"
    | "queue_mismatch"
    | "terminal_failure_missing"
    | "failure_key_mismatch"
    | "original_identity_mismatch"
    | "deterministic_identity_mismatch"
    | "missing_publishing_queue_item_id"
    | "queue_item_not_found"
    | "state_not_replayable"
    | "claim_rejected"
    | "claim_authority_violation";
  readonly replayRequestId?: number;

  constructor(
    code: PublishingReplayValidationError["code"],
    message: string,
    replayRequestId?: number
  ) {
    super(message);
    this.name = "PublishingReplayValidationError";
    this.code = code;
    this.replayRequestId = replayRequestId;
  }
}

export type PublishingReplayExecutor = TerminalReplayExecutor;

export interface ExecutePublishingTerminalReplayInput {
  replayRequestId: number;
  requestedByUserId: number;
  clock?: () => Date;
  executor?: PublishingReplayExecutor;
}

function resolveDb(executor?: PublishingReplayExecutor): PublishingReplayExecutor {
  return executor ?? getDb();
}

function fail(
  code: PublishingReplayValidationError["code"],
  message: string,
  replayRequestId?: number
): never {
  throw new PublishingReplayValidationError(code, message, replayRequestId);
}

function safeError(prefix: string, err: unknown): Error {
  const detail = sanitizeBoundedText((err as { message?: unknown } | null | undefined)?.message, 300);
  return new Error(detail ? `${prefix}: ${detail}` : prefix);
}

/**
 * READ-ONLY billing evidence authority (WBS9D2A correction 3).
 *
 * A failed row may be re-armed to retrying only when exactly one durable
 * publishing deduction attributable to the SAME queue item exists — because
 * publishSinglePost skips the deduction while retrying. Absence of a ledger
 * row cannot be treated as proof of "never charged" (the legacy publishing
 * path has no deterministic reservation contract), and multiple/conflicting
 * rows are ambiguous. Both fail closed.
 *
 * Identity comes only from durable columns + metadata: userId, type,
 * amount magnitude, metadata.queueItemId, metadata.platform (when present).
 * Description text is never used as identity.
 */
async function establishBillingEvidence(
  tx: PublishingReplayExecutor,
  queueRow: { userId: number; platform: string },
  queueItemId: number
): Promise<Error | null> {
  const candidates = await tx
    .select()
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.userId, queueRow.userId),
        eq(creditTransactions.type, "publishing_deduction")
      )
    )
    .limit(100);

  const compatible = candidates.filter((row) => {
    const meta = row.metadata as { queueItemId?: unknown; platform?: unknown } | null;
    if (meta?.queueItemId !== queueItemId) return false;
    if (meta?.platform != null && meta.platform !== queueRow.platform) return false;
    if (Math.abs(row.amount) !== PUBLISHING_DEDUCTION_CREDIT_AMOUNT) return false;
    return true;
  });

  if (compatible.length === 1) return null;
  if (compatible.length === 0) {
    return new Error(
      `No existing publishing deduction found for queue item ${queueItemId}; replay would risk an uncharged or double charge`
    );
  }
  return new Error(
    `Ambiguous billing evidence for queue item ${queueItemId}: ${compatible.length} matching deductions`
  );
}

export async function executePublishingTerminalReplay({
  replayRequestId,
  requestedByUserId,
  clock = () => new Date(),
  executor,
}: ExecutePublishingTerminalReplayInput): Promise<PublishingTerminalReplayOutcome> {
  const db = resolveDb(executor);
  const now = () => clock();

  const [request] = await db
    .select()
    .from(queueReplayRequests)
    .where(eq(queueReplayRequests.id, replayRequestId))
    .limit(1);
  if (!request) throw new TerminalReplayRequestNotFoundError(replayRequestId);

  // A. Fail-closed authority checks — never trust caller-supplied identity.
  if (request.requestedByUserId !== requestedByUserId) {
    fail("operator_mismatch", `Replay request ${replayRequestId} belongs to a different operator`, replayRequestId);
  }
  if (request.replayMode !== "publishing_requeue") {
    fail("wrong_replay_mode", `Replay request ${replayRequestId} is not a publishing_requeue`, replayRequestId);
  }
  if (request.queueName !== "publishing") {
    fail("queue_mismatch", `Replay request ${replayRequestId} is not for the publishing queue`, replayRequestId);
  }

  // B. Restart-safe state dispatch.
  if (request.status === "resolved" || request.status === "failed") {
    return { outcome: "terminal", replayRequestId, status: request.status };
  }
  if (request.status === "enqueued") {
    return {
      outcome: "already_enqueued",
      replayRequestId,
      replayBullmqJobId: request.replayBullmqJobId,
    };
  }

  // The durable terminal-failure row is authoritative for identity. These
  // checks run BEFORE any claim so invalid targets fail closed without
  // touching the claim authority.
  const [failure] = await db
    .select()
    .from(queueTerminalFailures)
    .where(eq(queueTerminalFailures.id, request.terminalFailureId))
    .limit(1);
  if (!failure) {
    fail("terminal_failure_missing", `Terminal failure ${request.terminalFailureId} does not exist`, replayRequestId);
  }
  if (failure.failureKey !== request.failureKey) {
    fail("failure_key_mismatch", `Replay request ${replayRequestId} failureKey does not match the terminal failure`, replayRequestId);
  }
  if (failure.queueName !== "publishing") {
    fail("queue_mismatch", `Terminal failure ${failure.id} is not a publishing failure`, replayRequestId);
  }
  if (failure.bullmqJobId !== request.originalBullmqJobId) {
    fail("original_identity_mismatch", `Replay request ${replayRequestId} original job identity is inconsistent`, replayRequestId);
  }
  if (failure.publishingQueueItemId == null) {
    fail("missing_publishing_queue_item_id", `Terminal failure ${failure.id} has no publishingQueueItemId`, replayRequestId);
  }

  const queueItemId = failure.publishingQueueItemId;
  const deterministicJobId = toPublishingBullMqJobId(queueItemId);
  if (failure.bullmqJobId !== deterministicJobId) {
    fail(
      "deterministic_identity_mismatch",
      `Terminal failure ${failure.id} BullMQ id does not match deterministic identity ${deterministicJobId}`,
      replayRequestId
    );
  }

  const [queueRow] = await db
    .select()
    .from(publishingQueue)
    .where(eq(publishingQueue.id, queueItemId))
    .limit(1);
  if (!queueRow) {
    fail("queue_item_not_found", `Publishing queue item ${queueItemId} does not exist`, replayRequestId);
  }

  // Claim authority FIRST (correction 4): fresh requests claim here; claimed
  // requests verify the durable active claim belongs to THIS request before
  // resuming. Publication state is inspected after the claim.
  let resume = false;
  if (request.status === "claimed") {
    const [claim] = await db
      .select()
      .from(queueReplayActiveClaims)
      .where(eq(queueReplayActiveClaims.terminalFailureId, request.terminalFailureId))
      .limit(1);
    if (!claim || claim.replayRequestId !== request.id) {
      fail(
        "claim_authority_violation",
        `Replay request ${replayRequestId} holds no verified active claim`,
        replayRequestId
      );
    }
    resume = true;
  } else {
    const claimResult = await claimTerminalReplayRequest(
      request.id,
      { claimedAt: now() },
      db
    );
    if (!claimResult.claimed) {
      fail(
        "claim_rejected",
        `Replay request ${replayRequestId} claim rejected: ${claimResult.reason}`,
        replayRequestId
      );
    }
  }

  // D. Allowed application state, inspected AFTER the claim: governed
  // requested -> claimed -> resolved for already-completed targets.
  if (queueRow.status === "published") {
    await markTerminalReplayResolved(request.id, { resolvedAt: now() }, db);
    return { outcome: "already_completed", replayRequestId };
  }
  if (queueRow.status !== "failed" && !(queueRow.status === "retrying" && resume)) {
    // retrying is only admissible as restart recovery for THIS claimed request.
    const error = new Error(
      `Publishing queue item ${queueItemId} is "${queueRow.status}" and is not replay-authorised`
    );
    await markTerminalReplayFailed(request.id, { failedAt: now(), error }, db);
    fail("state_not_replayable", error.message, replayRequestId);
  }

  // E. Billing evidence + guarded re-arm, one DB transaction. No Redis in
  // here. The re-armed row is BullMQ-only: nextRetryAt = null (legacy cron
  // cannot select it). Skipped only when restart recovery already re-armed.
  if (queueRow.status === "failed") {
    let rereadPublished = false;
    let billingBlocked = false;
    await withTerminalReplayTransaction(async (tx) => {
      const evidenceError = await establishBillingEvidence(tx, queueRow, queueItemId);
      if (evidenceError) {
        // Fail closed: no re-arm, and the replay request fails in the same
        // transaction so the active claim is released atomically.
        await markTerminalReplayFailed(request.id, { failedAt: now(), error: evidenceError }, tx);
        billingBlocked = true;
        return;
      }

      const [header] = await tx
        .update(publishingQueue)
        // retryCount / maxRetries / lastError / safety / approval evidence untouched.
        .set({ status: "retrying", nextRetryAt: null })
        .where(and(eq(publishingQueue.id, queueItemId), eq(publishingQueue.status, "failed")));
      if (Number((header as { affectedRows?: number }).affectedRows) === 1) return;

      // Guard miss: reread in the same transaction and re-apply state rules.
      const [reread] = await tx
        .select()
        .from(publishingQueue)
        .where(eq(publishingQueue.id, queueItemId))
        .limit(1);
      if (!reread) {
        throw new PublishingReplayValidationError(
          "queue_item_not_found",
          `Publishing queue item ${queueItemId} disappeared before re-arm`,
          replayRequestId
        );
      }
      if (reread.status === "published") {
        rereadPublished = true;
        return;
      }
      if (reread.status === "retrying" && resume) return; // crash window: already re-armed
      throw new PublishingReplayValidationError(
        "state_not_replayable",
        `Publishing queue item ${queueItemId} is "${reread.status}" and is not replay-authorised`,
        replayRequestId
      );
    }, db);

    if (billingBlocked) {
      return { outcome: "terminal", replayRequestId, status: "failed" };
    }
    if (rereadPublished) {
      await markTerminalReplayResolved(request.id, { resolvedAt: now() }, db);
      return { outcome: "already_completed", replayRequestId };
    }
  }

  // F. Existing deterministic BullMQ job reconciliation (Redis, outside tx).
  let inspection;
  try {
    inspection = await inspectPublishingJob(deterministicJobId);
  } catch (err) {
    const safe = safeError("Publishing replay job inspection failed", err);
    await compensateAndFail(request.id, queueItemId, safe, now, db);
    return { outcome: "terminal", replayRequestId, status: "failed" };
  }

  const durableIdentityMatches =
    inspection.data?.queueItemId === queueItemId &&
    inspection.data?.userId === queueRow.userId &&
    inspection.data?.platform === queueRow.platform;

  let scheduleNeeded = true;
  if (inspection.exists) {
    if (!durableIdentityMatches) {
      const safe = new Error(
        `Existing BullMQ job ${deterministicJobId} payload does not match queue item ${queueItemId}`
      );
      await compensateAndFail(request.id, queueItemId, safe, now, db);
      return { outcome: "terminal", replayRequestId, status: "failed" };
    }

    if (inspection.state === "failed") {
      // Stale terminal evidence for the same queue item: may be replaced.
      try {
        await removePublishingJobById(deterministicJobId);
      } catch (err) {
        const safe = safeError("Publishing replay could not remove stale terminal job", err);
        await compensateAndFail(request.id, queueItemId, safe, now, db);
        return { outcome: "terminal", replayRequestId, status: "failed" };
      }
    } else if (
      resume &&
      (inspection.state === "waiting" ||
        inspection.state === "delayed" ||
        inspection.state === "active") &&
      inspection.data?.replayRequestId === request.id
    ) {
      // Live job with the full ownership marker during restart recovery:
      // this is the replay already scheduled for THIS claimed request.
      scheduleNeeded = false;
    } else {
      // Live job that cannot be proven to belong to this replay (including
      // jobs with no or a foreign replayRequestId): fail closed, never
      // delete potentially live work.
      const safe = new Error(
        `Live BullMQ job ${deterministicJobId} cannot be proven to belong to this replay`
      );
      await compensateAndFail(request.id, queueItemId, safe, now, db);
      return { outcome: "terminal", replayRequestId, status: "failed" };
    }
  }

  // G. Enqueue with the existing deterministic identity and ownership marker.
  if (scheduleNeeded) {
    try {
      await schedulePublishingJob(queueItemId, queueRow.userId, queueRow.platform, now(), {
        replayRequestId: request.id,
      });
    } catch (err) {
      const safe = safeError("Publishing replay enqueue failed", err);
      await compensateAndFail(request.id, queueItemId, safe, now, db);
      return { outcome: "terminal", replayRequestId, status: "failed" };
    }
  }

  await markTerminalReplayEnqueued(
    request.id,
    { enqueuedAt: now(), replayBullmqJobId: deterministicJobId },
    db
  );
  return { outcome: "enqueued", replayRequestId, replayBullmqJobId: deterministicJobId };
}

/**
 * Enqueue-failure compensation, transactionally coupled with the replay
 * request failure. Redis is already outside this boundary. The application
 * restore is guarded so it cannot overwrite a later legitimate mutation.
 */
async function compensateAndFail(
  replayRequestId: number,
  queueItemId: number,
  reason: Error,
  now: () => Date,
  db: PublishingReplayExecutor
): Promise<void> {
  await withTerminalReplayTransaction(async (tx) => {
    await tx
      .update(publishingQueue)
      .set({ status: "failed", nextRetryAt: null })
      .where(and(eq(publishingQueue.id, queueItemId), eq(publishingQueue.status, "retrying")));
    await markTerminalReplayFailed(replayRequestId, { failedAt: now(), error: reason }, tx);
  }, db);
}
