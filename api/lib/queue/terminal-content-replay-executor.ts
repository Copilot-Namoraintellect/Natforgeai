import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agentRuns,
  creativeGenerationClaims,
  queueReplayActiveClaims,
  queueReplayRequests,
  queueTerminalFailures,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import { env } from "../env";
import {
  calculateLeaseExpiresAt,
  generateOwnerToken,
  rearmCreativeGenerationClaim,
  releaseCreativeGenerationClaim,
  terminalizeStaleCreativeGenerationClaim,
  type CreativeGenerationClaim,
} from "../creative/creative-generation-claim";
import {
  inspectContentGenerationJob,
  removeContentGenerationJobById,
  scheduleContentGenerationJob,
  toContentGenerationBullMqJobId,
} from "./bullmq";
import { sanitizeBoundedText } from "./terminal-failure";
import {
  TerminalReplayBindingConflictError,
  TerminalReplayRequestNotFoundError,
  bindContentRecoveryClaim,
  claimTerminalReplayRequest,
  markTerminalReplayEnqueued,
  markTerminalReplayFailed,
  markTerminalReplayResolved,
  rotateContentRecoveryClaimOwnerHash,
  withTerminalReplayTransaction,
  type TerminalReplayExecutor,
} from "./terminal-replay";

/**
 * Controlled content-generation domain recovery executor (WBS9D2B).
 *
 * Consumes the WBS9D1 replay-request authority and recovers the EXACT
 * creative-generation claim lineage of the terminally-failed BullMQ job —
 * through the existing claim authority, with fresh ownership. It never
 * reuses the stale BullMQ payload or the stale ownerToken: recovery is bound
 * durably (claim id + SHA-256 owner-token fingerprint) on the existing
 * queue_replay_requests row before anything reaches Redis.
 *
 * Flow: replay request -> claim replay authority -> prove terminal/deterministic
 * identity -> load authoritative agent run -> identify exact claim lineage
 * -> fresh claim ownership (rearm / stale terminalize + rearm) -> durable
 * replay->claim binding -> reconcile deterministic BullMQ state -> enqueue
 * with current claimId + current ownerToken -> request enqueued.
 *
 * No billing mutation, no provider call, no worker start, no agentRuns
 * rewrite. Recovery only restores execution authority.
 */

export type ContentTerminalReplayOutcome =
  | { outcome: "enqueued"; replayRequestId: number; replayBullmqJobId: string }
  | { outcome: "already_enqueued"; replayRequestId: number; replayBullmqJobId: string | null }
  | { outcome: "already_completed"; replayRequestId: number }
  | { outcome: "terminal"; replayRequestId: number; status: "resolved" | "failed" };

export class ContentReplayValidationError extends Error {
  readonly code:
    | "operator_mismatch"
    | "wrong_replay_mode"
    | "queue_mismatch"
    | "terminal_failure_missing"
    | "failure_key_mismatch"
    | "original_identity_mismatch"
    | "deterministic_identity_mismatch"
    | "missing_agent_run_id"
    | "agent_run_not_found"
    | "agent_run_lineage_mismatch"
    | "agent_run_type_mismatch"
    | "agent_run_state_not_recoverable"
    | "claim_lineage_not_found"
    | "claim_lineage_ambiguous"
    | "claim_evidence_conflict"
    | "healthy_running_claim_protected"
    | "stale_terminalization_failed"
    | "rearm_failed"
    | "binding_invalid"
    | "binding_conflict"
    | "claim_rejected"
    | "claim_authority_violation";

  constructor(
    code: ContentReplayValidationError["code"],
    message: string,
    public readonly replayRequestId?: number
  ) {
    super(message);
    this.name = "ContentReplayValidationError";
    this.code = code;
  }
}

export type ContentReplayExecutor = TerminalReplayExecutor;

export interface ExecuteContentTerminalReplayInput {
  replayRequestId: number;
  requestedByUserId: number;
  clock?: () => Date;
  executor?: ContentReplayExecutor;
}

function resolveDb(executor?: ContentReplayExecutor): ContentReplayExecutor {
  return executor ?? getDb();
}

function fail(
  code: ContentReplayValidationError["code"],
  message: string,
  replayRequestId?: number
): never {
  throw new ContentReplayValidationError(code, message, replayRequestId);
}

function safeError(prefix: string, err: unknown): Error {
  const detail = sanitizeBoundedText(
    (err as { message?: unknown } | null | undefined)?.message,
    300
  );
  return new Error(detail ? `${prefix}: ${detail}` : prefix);
}

/** Deterministic SHA-256 fingerprint; the raw ownerToken is never persisted. */
export function fingerprintOwnerToken(ownerToken: string): string {
  return createHash("sha256").update(ownerToken).digest("hex");
}

function leaseValidAt(claim: CreativeGenerationClaim, now: Date): boolean {
  return claim.leaseExpiresAt != null && claim.leaseExpiresAt.getTime() > now.getTime();
}

function leaseStaleAt(claim: CreativeGenerationClaim, now: Date, staleBefore: Date): boolean {
  if (claim.leaseExpiresAt != null) return claim.leaseExpiresAt.getTime() < now.getTime();
  return claim.updatedAt != null && claim.updatedAt.getTime() < staleBefore.getTime();
}

function staleBeforeBound(now: Date): Date {
  return new Date(now.getTime() - env.creativeGenerationRunningLeaseSeconds * 1000);
}

async function rearmBoundClaim(
  tx: ContentReplayExecutor,
  claimId: number,
  freshToken: string,
  userId: number,
  campaignId: number,
  agentRunId: number,
  replayRequestId: number
): Promise<void> {
  const rearmed = await rearmCreativeGenerationClaim({
    userId,
    campaignId,
    operationSource: "job",
    operationReferenceId: agentRunId,
    ownerToken: freshToken,
    leaseExpiresAt: calculateLeaseExpiresAt(env.creativeGenerationRunningLeaseSeconds),
    db: tx,
  });
  if (!rearmed) {
    throw new ContentReplayValidationError(
      "rearm_failed",
      `Creative claim ${claimId} could not be re-armed`,
      replayRequestId
    );
  }
}

async function rotateBoundHash(
  tx: ContentReplayExecutor,
  replayRequestId: number,
  claimId: number,
  expectedOwnerTokenHash: string,
  freshToken: string,
  preparedAt: Date,
  forLoggingId: number
): Promise<void> {
  try {
    await rotateContentRecoveryClaimOwnerHash(
      {
        replayRequestId,
        claimId,
        expectedOwnerTokenHash,
        nextOwnerTokenHash: fingerprintOwnerToken(freshToken),
        preparedAt,
      },
      tx
    );
  } catch (err) {
    if (err instanceof TerminalReplayBindingConflictError) {
      throw new ContentReplayValidationError(
        "binding_conflict",
        `Replay request ${forLoggingId} binding rotation conflicted`,
        forLoggingId
      );
    }
    throw err;
  }
}

export async function executeContentTerminalReplay({
  replayRequestId,
  requestedByUserId,
  clock = () => new Date(),
  executor,
}: ExecuteContentTerminalReplayInput): Promise<ContentTerminalReplayOutcome> {
  const db = resolveDb(executor);
  const now = () => clock();

  const [request] = await db
    .select()
    .from(queueReplayRequests)
    .where(eq(queueReplayRequests.id, replayRequestId))
    .limit(1);
  if (!request) throw new TerminalReplayRequestNotFoundError(replayRequestId);

  // D. Fail-closed authority checks — never trust caller-supplied identity.
  if (request.requestedByUserId !== requestedByUserId) {
    fail("operator_mismatch", `Replay request ${replayRequestId} belongs to a different operator`, replayRequestId);
  }
  if (request.replayMode !== "content_domain_recovery") {
    fail("wrong_replay_mode", `Replay request ${replayRequestId} is not a content_domain_recovery`, replayRequestId);
  }
  if (request.queueName !== "content_generation") {
    fail("queue_mismatch", `Replay request ${replayRequestId} is not for the content_generation queue`, replayRequestId);
  }

  // Restart-safe state dispatch.
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

  // Durable terminal-failure identity.
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
  if (failure.queueName !== "content_generation") {
    fail("queue_mismatch", `Terminal failure ${failure.id} is not a content_generation failure`, replayRequestId);
  }
  if (failure.bullmqJobId !== request.originalBullmqJobId) {
    fail("original_identity_mismatch", `Replay request ${replayRequestId} original job identity is inconsistent`, replayRequestId);
  }

  // Authoritative agentRunId: the durable field, proven by round-trip.
  if (failure.agentRunId == null) {
    fail("missing_agent_run_id", `Terminal failure ${failure.id} has no agentRunId`, replayRequestId);
  }
  const agentRunId = failure.agentRunId;
  const deterministicJobId = toContentGenerationBullMqJobId(agentRunId);
  if (failure.bullmqJobId !== deterministicJobId) {
    fail(
      "deterministic_identity_mismatch",
      `Terminal failure ${failure.id} BullMQ id does not match deterministic identity ${deterministicJobId}`,
      replayRequestId
    );
  }

  const [run] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, agentRunId))
    .limit(1);
  if (!run) {
    fail("agent_run_not_found", `Agent run ${agentRunId} does not exist`, replayRequestId);
  }
  if (
    run.userId !== failure.userId ||
    failure.campaignId == null ||
    run.campaignId !== failure.campaignId
  ) {
    fail("agent_run_lineage_mismatch", `Agent run ${agentRunId} does not match the terminal-failure lineage`, replayRequestId);
  }
  const runInput = (run.input ?? {}) as { jobType?: unknown };
  if (run.agentType !== "creative" || runInput.jobType !== "content_generation_job") {
    fail("agent_run_type_mismatch", `Agent run ${agentRunId} is not a content-generation job run`, replayRequestId);
  }

  // Claim replay authority first (governed requested -> claimed).
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
    const claimResult = await claimTerminalReplayRequest(request.id, { claimedAt: now() }, db);
    if (!claimResult.claimed) {
      fail(
        "claim_rejected",
        `Replay request ${replayRequestId} claim rejected: ${claimResult.reason}`,
        replayRequestId
      );
    }
  }

  // E. Completed target: claimed -> resolved, zero claim/Redis mutation.
  if (run.status === "completed") {
    await markTerminalReplayResolved(request.id, { resolvedAt: now() }, db);
    return { outcome: "already_completed", replayRequestId };
  }
  if (run.status !== "failed" && run.status !== "running") {
    await markTerminalReplayFailed(
      request.id,
      { failedAt: now(), error: new Error(`Agent run ${agentRunId} is "${run.status}" and is not recovery-authorised`) },
      db
    );
    fail("agent_run_state_not_recoverable", `Agent run ${agentRunId} is "${run.status}"`, replayRequestId);
  }

  // F. Exact claim lineage — the same authority used by the content-router
  // job path: (userId, campaignId, operationSource "job", reference agentRunId).
  const claimCandidates = await db
    .select()
    .from(creativeGenerationClaims)
    .where(
      and(
        eq(creativeGenerationClaims.userId, failure.userId),
        eq(creativeGenerationClaims.campaignId, failure.campaignId),
        eq(creativeGenerationClaims.operationSource, "job"),
        eq(creativeGenerationClaims.operationReferenceId, agentRunId)
      )
    )
    .limit(2);
  if (claimCandidates.length === 0) {
    await markTerminalReplayFailed(
      request.id,
      { failedAt: now(), error: new Error(`No exact creative-generation claim exists for agent run ${agentRunId}`) },
      db
    );
    fail("claim_lineage_not_found", `No exact creative-generation claim exists for agent run ${agentRunId}`, replayRequestId);
  }
  if (claimCandidates.length > 1) {
    await markTerminalReplayFailed(
      request.id,
      { failedAt: now(), error: new Error(`Ambiguous creative-generation claim evidence for agent run ${agentRunId}`) },
      db
    );
    fail("claim_lineage_ambiguous", `Ambiguous creative-generation claim evidence for agent run ${agentRunId}`, replayRequestId);
  }
  const claim = claimCandidates[0];

  // G/H. Establish (or verify) fresh claim ownership + durable binding.
  const bindingHash = request.contentRecoveryOwnerTokenHash;
  const boundClaimId = request.contentRecoveryClaimId;
  let currentToken: string;

  if (boundClaimId != null || bindingHash != null) {
    // J windows 2/3 + long-downtime restart: the durable binding must prove
    // THIS replay owns the claim. Any failed proof keeps the request claimed
    // (guard retained) and propagates; we never release the guard falsely and
    // never mark the request failed without conclusive ownership proof.
    if (boundClaimId !== claim.id) {
      fail("binding_invalid", `Replay binding points at claim ${boundClaimId}, not the authoritative claim ${claim.id}`, replayRequestId);
    }
    if (claim.operationSource !== "job" || claim.operationReferenceId !== agentRunId) {
      fail("binding_invalid", `Bound claim ${claim.id} lineage no longer matches agent run ${agentRunId}`, replayRequestId);
    }
    if (fingerprintOwnerToken(claim.ownerToken) !== bindingHash) {
      fail("binding_invalid", `Bound claim ${claim.id} owner-token fingerprint does not match the durable binding`, replayRequestId);
    }

    if (claim.status === "running" && leaseValidAt(claim, now())) {
      // Valid lease: existing resume behavior (windows 2/3).
      currentToken = claim.ownerToken;
    } else if (claim.status === "running" && leaseStaleAt(claim, now(), staleBeforeBound(now()))) {
      // Long downtime: the replay-owned claim's lease expired before the
      // Redis handoff. Identity is proven above, so this stale claim belongs
      // to THIS replay: terminalize -> re-arm SAME claim with a fresh token
      // -> rotate the binding hash, all in ONE transaction. Never a new
      // logical claim; never a raw token persisted.
      const staleBefore = staleBeforeBound(now());
      const freshToken = generateOwnerToken();
      await withTerminalReplayTransaction(async (tx) => {
        const terminalized = await terminalizeStaleCreativeGenerationClaim({
          claimId: claim.id,
          userId: failure.userId,
          campaignId: failure.campaignId!,
          staleBefore,
          db: tx,
        });
        if (!terminalized.terminalized) {
          throw new ContentReplayValidationError(
            "stale_terminalization_failed",
            `Bound claim ${claim.id} stale terminalization did not apply`,
            replayRequestId
          );
        }
        await rearmBoundClaim(tx, claim.id, freshToken, failure.userId, failure.campaignId!, agentRunId, replayRequestId);
        await rotateBoundHash(tx, request.id, claim.id, bindingHash!, freshToken, now(), replayRequestId);
      }, db);
      currentToken = freshToken;
    } else if (claim.status === "failed") {
      // Bound claim was terminalized while we were down (e.g. by the stale
      // sweep). Ownership is durably proven; re-arm SAME claim + rotate.
      const freshToken = generateOwnerToken();
      await withTerminalReplayTransaction(async (tx) => {
        await rearmBoundClaim(tx, claim.id, freshToken, failure.userId, failure.campaignId!, agentRunId, replayRequestId);
        await rotateBoundHash(tx, request.id, claim.id, bindingHash!, freshToken, now(), replayRequestId);
      }, db);
      currentToken = freshToken;
    } else {
      fail("binding_invalid", `Bound claim ${claim.id} is "${claim.status}" and cannot be conclusively recovered`, replayRequestId);
    }
  } else if (claim.status === "failed") {
    // Fresh recovery of a terminal failed claim: fresh ownerToken via the
    // existing re-arm authority, transactionally coupled with the durable
    // replay->claim binding (C.6).
    const freshToken = generateOwnerToken();
    await withTerminalReplayTransaction(async (tx) => {
      const rearmed = await rearmCreativeGenerationClaim({
        userId: failure.userId,
        campaignId: failure.campaignId!,
        operationSource: "job",
        operationReferenceId: agentRunId,
        ownerToken: freshToken,
        leaseExpiresAt: calculateLeaseExpiresAt(env.creativeGenerationRunningLeaseSeconds),
        db: tx,
      });
      if (!rearmed) {
        throw new ContentReplayValidationError(
          "rearm_failed",
          `Creative claim ${claim.id} could not be re-armed`,
          replayRequestId
        );
      }
      await bindContentRecoveryClaimInTx(request.id, claim.id, freshToken, tx, replayRequestId);
    }, db);
    currentToken = freshToken;
  } else if (claim.status === "running") {
    // Stale running claim: existing stale-authority terminalization first,
    // then re-arm + binding in one transaction. A healthy live claim owned by
    // another execution is never stolen.
    const staleBefore = new Date(
      now().getTime() - env.creativeGenerationRunningLeaseSeconds * 1000
    );
    if (!leaseStaleAt(claim, now(), staleBefore)) {
      await markTerminalReplayFailed(
        request.id,
        { failedAt: now(), error: new Error(`Creative claim ${claim.id} is a healthy running claim owned by another execution`) },
        db
      );
      fail("healthy_running_claim_protected", `Creative claim ${claim.id} is healthy and foreign`, replayRequestId);
    }
    const freshToken = generateOwnerToken();
    await withTerminalReplayTransaction(async (tx) => {
      const terminalized = await terminalizeStaleCreativeGenerationClaim({
        claimId: claim.id,
        userId: failure.userId,
        campaignId: failure.campaignId!,
        staleBefore,
        db: tx,
      });
      if (!terminalized.terminalized) {
        throw new ContentReplayValidationError(
          "stale_terminalization_failed",
          `Creative claim ${claim.id} stale terminalization did not apply`,
          replayRequestId
        );
      }
      const rearmed = await rearmCreativeGenerationClaim({
        userId: failure.userId,
        campaignId: failure.campaignId!,
        operationSource: "job",
        operationReferenceId: agentRunId,
        ownerToken: freshToken,
        leaseExpiresAt: calculateLeaseExpiresAt(env.creativeGenerationRunningLeaseSeconds),
        db: tx,
      });
      if (!rearmed) {
        throw new ContentReplayValidationError(
          "rearm_failed",
          `Creative claim ${claim.id} could not be re-armed after stale terminalization`,
          replayRequestId
        );
      }
      await bindContentRecoveryClaimInTx(request.id, claim.id, freshToken, tx, replayRequestId);
    }, db);
    currentToken = freshToken;
  } else {
    // claim completed while the run says failed: conflicting durable evidence.
    await markTerminalReplayFailed(
      request.id,
      { failedAt: now(), error: new Error(`Creative claim ${claim.id} is completed but agent run ${agentRunId} is failed`) },
      db
    );
    fail("claim_evidence_conflict", `Creative claim ${claim.id} contradicts agent run ${agentRunId}`, replayRequestId);
  }

  // H/I. Deterministic BullMQ reconciliation (Redis, outside any DB tx).
  let inspection;
  try {
    inspection = await inspectContentGenerationJob(deterministicJobId);
  } catch (err) {
    return handlePostOwnershipFailure(request.id, claim.id, currentToken, safeError("Content replay job inspection failed", err), now, db);
  }

  const durableIdentityMatches =
    inspection.data?.jobId === agentRunId &&
    inspection.data?.userId === run.userId &&
    inspection.data?.campaignId === run.campaignId;

  let scheduleNeeded = true;
  if (inspection.exists) {
    if (!durableIdentityMatches) {
      return handlePostOwnershipFailure(
        request.id,
        claim.id,
        currentToken,
        new Error(`Existing BullMQ job ${deterministicJobId} payload does not match agent run ${agentRunId}`),
        now,
        db
      );
    }

    if (inspection.state === "failed") {
      // Terminal evidence, not live work: may be replaced after identity proof.
      try {
        await removeContentGenerationJobById(deterministicJobId);
      } catch (err) {
        return handlePostOwnershipFailure(
          request.id,
          claim.id,
          currentToken,
          safeError("Content replay could not remove stale terminal job", err),
          now,
          db
        );
      }
    } else if (
      resume &&
      (inspection.state === "waiting" ||
        inspection.state === "delayed" ||
        inspection.state === "active") &&
      inspection.data?.replayRequestId === request.id &&
      inspection.data?.claimId === claim.id &&
      fingerprintOwnerToken(inspection.data?.ownerToken ?? "") === bindingHash
    ) {
      // J window 3: queue.add succeeded, mark-enqueued crashed. Full ownership
      // evidence matches — reconcile without a second re-arm/acquire/add.
      scheduleNeeded = false;
    } else {
      // Live job with no/foreign marker, wrong claim/token/identity: fail
      // closed; never delete potentially-live unowned work.
      return handlePostOwnershipFailure(
        request.id,
        claim.id,
        currentToken,
        new Error(`Live BullMQ job ${deterministicJobId} cannot be proven to belong to this replay`),
        now,
        db
      );
    }
  }

  if (scheduleNeeded) {
    try {
      await scheduleContentGenerationJob({
        jobId: agentRunId,
        userId: run.userId,
        campaignId: run.campaignId!,
        // Never reuse the stale payload; idempotent-completion semantics stay
        // with the existing job contract.
        regenerate: false,
        claimId: claim.id,
        ownerToken: currentToken,
        replayRequestId: request.id,
      });
    } catch (err) {
      return handlePostOwnershipFailure(
        request.id,
        claim.id,
        currentToken,
        safeError("Content replay enqueue failed", err),
        now,
        db
      );
    }
  }

  await markTerminalReplayEnqueued(
    request.id,
    { enqueuedAt: now(), replayBullmqJobId: deterministicJobId },
    db
  );
  return { outcome: "enqueued", replayRequestId, replayBullmqJobId: deterministicJobId };
}

async function bindContentRecoveryClaimInTx(
  replayRequestId: number,
  claimId: number,
  ownerToken: string,
  tx: ContentReplayExecutor,
  forLoggingId: number
): Promise<void> {
  try {
    await bindContentRecoveryClaim(
      replayRequestId,
      { claimId, ownerTokenHash: fingerprintOwnerToken(ownerToken) },
      tx
    );
  } catch (err: any) {
    if (err instanceof TerminalReplayBindingConflictError) {
      throw new ContentReplayValidationError(
        "binding_conflict",
        `Replay request ${forLoggingId} is already bound to a different content-recovery claim`,
        forLoggingId
      );
    }
    throw err;
  }
}

/**
 * K. Post-ownership failure handling. We hold the current ownerToken (fresh
 * this run, or hash-verified from the live claim row), so guarded
 * compensation is possible: owner-token-guarded claim terminalization +
 * replay-request failure in ONE transaction, then the guard releases.
 *
 * If compensation cannot prove ownership (release rejected), the replay
 * request stays claimed and the guard stays held — never a running claim
 * with released authority.
 */
async function handlePostOwnershipFailure(
  replayRequestId: number,
  claimId: number,
  currentOwnerToken: string,
  reason: Error,
  now: () => Date,
  db: ContentReplayExecutor
): Promise<ContentTerminalReplayOutcome> {
  try {
    await withTerminalReplayTransaction(async (tx) => {
      await releaseCreativeGenerationClaim({
        claimId,
        ownerToken: currentOwnerToken,
        status: "failed",
        db: tx,
      });
      await markTerminalReplayFailed(replayRequestId, { failedAt: now(), error: reason }, tx);
    }, db);
    return { outcome: "terminal", replayRequestId, status: "failed" };
  } catch (compensationError) {
    // Compensation could not prove/regain ownership: keep the request claimed
    // and the guard held; propagate so controlled reconciliation can decide.
    throw safeError("Content replay compensation failed; replay request left claimed", compensationError);
  }
}
