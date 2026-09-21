import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentRuns,
  creativeGenerationClaims,
  publishingQueue,
  queueReplayActiveClaims,
  queueReplayRequests,
  queueTerminalFailures,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  toContentGenerationBullMqJobId,
  toPublishingBullMqJobId,
} from "./bullmq";
import {
  TerminalReplayRequestNotFoundError,
  markTerminalReplayFailed,
  markTerminalReplayResolved,
  type TerminalReplayExecutor,
  type TerminalReplayMode,
} from "./terminal-replay";

/**
 * Durable replay outcome reconciliation authority (WBS9D3A).
 *
 * Closes successful WBS9 replay requests after their queue work produced a
 * durable DOMAIN outcome. READ-ONLY with respect to publishing/content
 * business state: the only mutation is queue_replay_requests
 * enqueued -> resolved | failed through the existing governed terminal-replay
 * authority, which releases queue_replay_active_claims atomically.
 *
 * Redis/BullMQ state is intentionally NOT the outcome authority. Historical
 * queue_terminal_failures rows are origin evidence only — D2A/D2B reuse the
 * same deterministic BullMQ job id, so they can never prove the REPLAY's own
 * outcome.
 */

export type ReconcileOutcome =
  | { outcome: "resolved"; replayRequestId: number; mode: TerminalReplayMode }
  | { outcome: "failed"; replayRequestId: number; mode: TerminalReplayMode }
  | {
      outcome: "pending";
      replayRequestId: number;
      mode: TerminalReplayMode;
      reason: ReconcilePendingReason;
    }
  | {
      outcome: "already_terminal";
      replayRequestId: number;
      status: "resolved" | "failed";
    };

export type ReconcilePendingReason =
  | "request_not_enqueued"
  | "publishing_in_progress"
  | "publishing_inconclusive"
  | "content_in_progress"
  | "content_inconclusive";

export class ReplayReconciliationInvariantError extends Error {
  readonly code:
    | "active_guard_missing_or_foreign"
    | "terminal_failure_missing"
    | "failure_identity_mismatch"
    | "deterministic_identity_mismatch"
    | "domain_identity_mismatch"
    | "content_binding_missing"
    | "owner_token_fingerprint_mismatch";

  constructor(
    code: ReplayReconciliationInvariantError["code"],
    message: string,
    public readonly replayRequestId?: number
  ) {
    super(message);
    this.name = "ReplayReconciliationInvariantError";
    this.code = code;
  }
}

export type ReconciliationExecutor = TerminalReplayExecutor;

export interface ReconcileTerminalReplayRequestInput {
  replayRequestId: number;
  clock?: () => Date;
  executor?: ReconciliationExecutor;
}

const PUBLISHING_FAILURE_REASON = "Publishing replay reached durable failed state";
const CONTENT_FAILURE_REASON = "Content replay reached durable failed state";

function resolveDb(executor?: ReconciliationExecutor): ReconciliationExecutor {
  return executor ?? getDb();
}

function invariant(
  code: ReplayReconciliationInvariantError["code"],
  message: string,
  replayRequestId?: number
): never {
  throw new ReplayReconciliationInvariantError(code, message, replayRequestId);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function reconcileTerminalReplayRequest({
  replayRequestId,
  clock = () => new Date(),
  executor,
}: ReconcileTerminalReplayRequestInput): Promise<ReconcileOutcome> {
  const db = resolveDb(executor);
  const now = () => clock();

  const [request] = await db
    .select()
    .from(queueReplayRequests)
    .where(eq(queueReplayRequests.id, replayRequestId))
    .limit(1);
  if (!request) throw new TerminalReplayRequestNotFoundError(replayRequestId);

  // Terminal rerun: never reopens, never reacquires/releases another guard.
  if (request.status === "resolved" || request.status === "failed") {
    return { outcome: "already_terminal", replayRequestId, status: request.status };
  }
  // Only enqueued requests are reconcilable in D3A.
  if (request.status !== "enqueued") {
    return {
      outcome: "pending",
      replayRequestId,
      mode: request.replayMode,
      reason: "request_not_enqueued",
    };
  }

  // D. An enqueued replay must retain its D1 active guard.
  const guards = await db
    .select()
    .from(queueReplayActiveClaims)
    .where(eq(queueReplayActiveClaims.terminalFailureId, request.terminalFailureId))
    .limit(2);
  if (
    guards.length !== 1 ||
    guards[0].replayRequestId !== request.id
  ) {
    invariant(
      "active_guard_missing_or_foreign",
      `Replay request ${replayRequestId} has no retained active guard for terminal failure ${request.terminalFailureId}`,
      replayRequestId
    );
  }

  // E. Historical terminal failure: origin identity evidence ONLY — never
  // replay-outcome evidence (D2A/D2B reuse the same deterministic job id).
  const [failure] = await db
    .select()
    .from(queueTerminalFailures)
    .where(eq(queueTerminalFailures.id, request.terminalFailureId))
    .limit(1);
  if (!failure) {
    invariant(
      "terminal_failure_missing",
      `Terminal failure ${request.terminalFailureId} does not exist`,
      replayRequestId
    );
  }
  if (
    failure.failureKey !== request.failureKey ||
    failure.queueName !== request.queueName ||
    failure.bullmqJobId !== request.originalBullmqJobId
  ) {
    invariant(
      "failure_identity_mismatch",
      `Replay request ${replayRequestId} is inconsistent with terminal failure ${failure.id}`,
      replayRequestId
    );
  }

  if (request.replayMode === "publishing_requeue") {
    if (request.queueName !== "publishing") {
      invariant("failure_identity_mismatch", `Replay request ${replayRequestId} queue/mode mismatch`, replayRequestId);
    }
    return reconcilePublishing(db, request, failure, now, replayRequestId);
  }
  if (request.replayMode === "content_domain_recovery") {
    if (request.queueName !== "content_generation") {
      invariant("failure_identity_mismatch", `Replay request ${replayRequestId} queue/mode mismatch`, replayRequestId);
    }
    return reconcileContent(db, request, failure, now, replayRequestId);
  }
  invariant("failure_identity_mismatch", `Replay request ${replayRequestId} has an unknown replay mode`, replayRequestId);
}

type RequestRow = typeof queueReplayRequests.$inferSelect;
type FailureRow = typeof queueTerminalFailures.$inferSelect;

async function reconcilePublishing(
  db: ReconciliationExecutor,
  request: RequestRow,
  failure: FailureRow,
  now: () => Date,
  replayRequestId: number
): Promise<ReconcileOutcome> {
  if (failure.publishingQueueItemId == null || failure.agentRunId != null) {
    invariant(
      "domain_identity_mismatch",
      `Terminal failure ${failure.id} is not a publishing replay target`,
      replayRequestId
    );
  }
  const expectedJobId = toPublishingBullMqJobId(failure.publishingQueueItemId);
  assertDeterministicIdentity(expectedJobId, failure, request, replayRequestId);

  const [row] = await db
    .select()
    .from(publishingQueue)
    .where(eq(publishingQueue.id, failure.publishingQueueItemId))
    .limit(1);
  if (!row) {
    invariant(
      "domain_identity_mismatch",
      `Publishing queue item ${failure.publishingQueueItemId} does not exist`,
      replayRequestId
    );
  }
  if (
    row.userId !== failure.userId ||
    (failure.campaignId != null && row.campaignId !== failure.campaignId)
  ) {
    invariant(
      "domain_identity_mismatch",
      `Publishing queue item ${row.id} does not agree with the terminal-failure lineage`,
      replayRequestId
    );
  }

  if (row.status === "published") {
    if (!row.publishedAt) {
      return {
        outcome: "pending",
        replayRequestId,
        mode: "publishing_requeue",
        reason: "publishing_inconclusive",
      };
    }
    await markTerminalReplayResolved(request.id, { resolvedAt: now() }, db);
    return { outcome: "resolved", replayRequestId, mode: "publishing_requeue" };
  }
  if (row.status === "failed") {
    await markTerminalReplayFailed(
      request.id,
      { failedAt: now(), error: new Error(PUBLISHING_FAILURE_REASON) },
      db
    );
    return { outcome: "failed", replayRequestId, mode: "publishing_requeue" };
  }
  if (row.status === "retrying") {
    return {
      outcome: "pending",
      replayRequestId,
      mode: "publishing_requeue",
      reason: "publishing_in_progress",
    };
  }
  return {
    outcome: "pending",
    replayRequestId,
    mode: "publishing_requeue",
    reason: "publishing_inconclusive",
  };
}

async function reconcileContent(
  db: ReconciliationExecutor,
  request: RequestRow,
  failure: FailureRow,
  now: () => Date,
  replayRequestId: number
): Promise<ReconcileOutcome> {
  if (failure.agentRunId == null || failure.publishingQueueItemId != null) {
    invariant(
      "domain_identity_mismatch",
      `Terminal failure ${failure.id} is not a content-generation replay target`,
      replayRequestId
    );
  }
  if (failure.campaignId == null) {
    invariant(
      "domain_identity_mismatch",
      `Terminal failure ${failure.id} has no authoritative campaign`,
      replayRequestId
    );
  }
  const expectedJobId = toContentGenerationBullMqJobId(failure.agentRunId);
  assertDeterministicIdentity(expectedJobId, failure, request, replayRequestId);

  if (request.contentRecoveryClaimId == null || request.contentRecoveryOwnerTokenHash == null) {
    invariant(
      "content_binding_missing",
      `Replay request ${replayRequestId} lacks its durable content-recovery binding`,
      replayRequestId
    );
  }

  const [run] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, failure.agentRunId))
    .limit(1);
  if (!run) {
    invariant(
      "domain_identity_mismatch",
      `Agent run ${failure.agentRunId} does not exist`,
      replayRequestId
    );
  }
  const runInput = (run.input ?? {}) as { jobType?: unknown };
  if (
    run.userId !== failure.userId ||
    run.campaignId !== failure.campaignId ||
    run.agentType !== "creative" ||
    runInput.jobType !== "content_generation_job"
  ) {
    invariant(
      "domain_identity_mismatch",
      `Agent run ${run.id} does not prove the authoritative content-generation lineage`,
      replayRequestId
    );
  }

  const [claim] = await db
    .select()
    .from(creativeGenerationClaims)
    .where(eq(creativeGenerationClaims.id, request.contentRecoveryClaimId))
    .limit(1);
  if (!claim) {
    // The exact bound claim is gone: ambiguous, not provable. Keep guard.
    return {
      outcome: "pending",
      replayRequestId,
      mode: "content_domain_recovery",
      reason: "content_inconclusive",
    };
  }
  if (
    claim.userId !== run.userId ||
    claim.campaignId !== run.campaignId ||
    claim.operationSource !== "job" ||
    claim.operationReferenceId !== run.id
  ) {
    invariant(
      "domain_identity_mismatch",
      `Bound claim ${claim.id} lineage does not match agent run ${run.id}`,
      replayRequestId
    );
  }
  if (sha256Hex(claim.ownerToken) !== request.contentRecoveryOwnerTokenHash) {
    invariant(
      "owner_token_fingerprint_mismatch",
      `Bound claim ${claim.id} owner-token fingerprint does not match the durable binding`,
      replayRequestId
    );
  }

  const runCompleted = run.status === "completed";
  const runFailed = run.status === "failed";
  const claimCompleted = claim.status === "completed";
  const claimFailed = claim.status === "failed";

  if (runCompleted && claimCompleted) {
    await markTerminalReplayResolved(request.id, { resolvedAt: now() }, db);
    return { outcome: "resolved", replayRequestId, mode: "content_domain_recovery" };
  }
  if (runFailed && claimFailed) {
    await markTerminalReplayFailed(
      request.id,
      { failedAt: now(), error: new Error(CONTENT_FAILURE_REASON) },
      db
    );
    return { outcome: "failed", replayRequestId, mode: "content_domain_recovery" };
  }
  if (
    (run.status === "running" || run.status === "pending") &&
    claim.status === "running"
  ) {
    return {
      outcome: "pending",
      replayRequestId,
      mode: "content_domain_recovery",
      reason: "content_in_progress",
    };
  }
  // Partial/ambiguous close: never resolve, never fail, keep guard.
  return {
    outcome: "pending",
    replayRequestId,
    mode: "content_domain_recovery",
    reason: "content_inconclusive",
  };
}

function assertDeterministicIdentity(
  expectedJobId: string,
  failure: FailureRow,
  request: RequestRow,
  replayRequestId: number
): void {
  if (
    failure.bullmqJobId !== expectedJobId ||
    request.originalBullmqJobId !== expectedJobId ||
    request.replayBullmqJobId !== expectedJobId
  ) {
    invariant(
      "deterministic_identity_mismatch",
      `Replay request ${replayRequestId} deterministic BullMQ identity does not round-trip`,
      replayRequestId
    );
  }
}
