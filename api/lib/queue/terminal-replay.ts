import { and, eq, isNull, or } from "drizzle-orm";
import { queueReplayActiveClaims, queueReplayRequests, queueTerminalFailures } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  isMySqlDuplicateKeyError,
  sanitizeBoundedText,
  sanitizeErrorSummary,
  type TerminalQueueName,
} from "./terminal-failure";

/**
 * Durable operator replay-request authority (WBS9D1).
 *
 * Records queue-specific replay INTENT only. No BullMQ add/retry/remove, no
 * workflow-trigger mutation, no claim re-arm, and no publishing status
 * mutation happen in this slice — that execution authority is WBS9D2.
 *
 * Identity and classification are copied from the durable terminal-failure
 * record, never trusted from caller text: a stale content ownerToken can
 * therefore never be blindly retried through this authority.
 */

export type ReplayRequestStatus = "requested" | "claimed" | "enqueued" | "resolved" | "failed";
export type TerminalReplayMode = "publishing_requeue" | "content_domain_recovery";

/** Pure queue-specific replay classification. */
export function classifyTerminalReplay(queueName: TerminalQueueName): TerminalReplayMode {
  return queueName === "publishing" ? "publishing_requeue" : "content_domain_recovery";
}

export class TerminalReplayTargetNotFoundError extends Error {
  readonly terminalFailureId: number;
  constructor(terminalFailureId: number) {
    super(`Terminal failure ${terminalFailureId} does not exist`);
    this.name = "TerminalReplayTargetNotFoundError";
    this.terminalFailureId = terminalFailureId;
  }
}

export class TerminalReplayRequestNotFoundError extends Error {
  readonly replayRequestId: number;
  constructor(replayRequestId: number) {
    super(`Replay request ${replayRequestId} does not exist`);
    this.name = "TerminalReplayRequestNotFoundError";
    this.replayRequestId = replayRequestId;
  }
}

export class TerminalReplayKeyConflictError extends Error {
  readonly replayKey: string;
  constructor(replayKey: string) {
    super(`Replay key ${replayKey} is already bound to a different replay request`);
    this.name = "TerminalReplayKeyConflictError";
    this.replayKey = replayKey;
  }
}

export class TerminalReplayInvalidTransitionError extends Error {
  readonly replayRequestId: number;
  readonly from: string;
  readonly to: string;
  constructor(replayRequestId: number, from: string, to: string) {
    super(`Replay request ${replayRequestId} cannot transition from ${from} to ${to}`);
    this.name = "TerminalReplayInvalidTransitionError";
    this.replayRequestId = replayRequestId;
    this.from = from;
    this.to = to;
  }
}

type DbClient = ReturnType<typeof getDb>;

/**
 * Structural executor seam, consistent with the terminal-failure and billing
 * executor patterns: the default getDb() client and a Drizzle transaction
 * client both satisfy this shape.
 */
export interface TerminalReplayExecutor {
  select: DbClient["select"];
  insert: DbClient["insert"];
  update: DbClient["update"];
  delete: DbClient["delete"];
}

function resolveDb(executor?: TerminalReplayExecutor): TerminalReplayExecutor {
  return executor ?? getDb();
}

/**
 * Run claim/release mutations inside a single transaction when the resolved
 * client supports it (the default getDb() client and Drizzle transaction
 * clients do). The callback receives the transactional executor; on throw the
 * whole unit rolls back, so the active-claim row and the request status change
 * can never diverge.
 */
async function runInTransaction<T>(
  db: TerminalReplayExecutor,
  fn: (tx: TerminalReplayExecutor) => Promise<T>
): Promise<T> {
  const client = db as TerminalReplayExecutor & {
    transaction?: (cb: (tx: TerminalReplayExecutor) => Promise<T>) => Promise<T>;
  };
  if (typeof client.transaction === "function") {
    return client.transaction((tx) => fn(tx));
  }
  return fn(db);
}

/**
 * Public transaction boundary for replay executors (WBS9D2+): runs fn against
 * one transactional executor so coupled mutations (e.g. application-state
 * compensation + replay-request failure) commit or roll back together.
 */
export async function withTerminalReplayTransaction<T>(
  fn: (tx: TerminalReplayExecutor) => Promise<T>,
  executor?: TerminalReplayExecutor
): Promise<T> {
  return runInTransaction(resolveDb(executor), fn);
}

/** Internal marker: the terminalFailureId unique authority rejected the claim. */
class ActiveClaimTakenError extends Error {
  constructor() {
    super("An active claim already exists for this terminal failure");
    this.name = "ActiveClaimTakenError";
  }
}

/** Internal marker: the guarded status transition did not apply. */
class ClaimInvalidStateError extends Error {
  constructor() {
    super("Replay request is not in a claimable state");
    this.name = "ClaimInvalidStateError";
  }
}

export interface RequestTerminalFailureReplayInput {
  /** Explicit deterministic operator request key. No Date.now/random material. */
  replayKey: string;
  terminalFailureId: number;
  requestedByUserId: number;
  reason?: string | null;
}

export interface RequestTerminalFailureReplayResult {
  record: typeof queueReplayRequests.$inferSelect;
  alreadyRequested: boolean;
}

/**
 * Create (or reuse) the durable replay request for a terminal failure.
 *
 * Queue/job identity and replay mode are copied from the committed
 * queue_terminal_failures row, so caller-supplied queue material can never
 * forge them. The unique constraint on replayKey is the idempotency
 * authority: an exact replay reuses the row; a conflicting request with the
 * same key fails closed.
 */
export async function requestTerminalFailureReplay(
  input: RequestTerminalFailureReplayInput,
  executor?: TerminalReplayExecutor
): Promise<RequestTerminalFailureReplayResult> {
  if (typeof input.replayKey !== "string" || input.replayKey.trim().length === 0) {
    throw new TypeError("replayKey must be a non-empty string");
  }
  const db = resolveDb(executor);

  const [failure] = await db
    .select()
    .from(queueTerminalFailures)
    .where(eq(queueTerminalFailures.id, input.terminalFailureId))
    .limit(1);
  if (!failure) {
    throw new TerminalReplayTargetNotFoundError(input.terminalFailureId);
  }

  const values = {
    replayKey: input.replayKey,
    terminalFailureId: failure.id,
    failureKey: failure.failureKey,
    queueName: failure.queueName,
    originalBullmqJobId: failure.bullmqJobId,
    requestedByUserId: input.requestedByUserId,
    reason: sanitizeBoundedText(input.reason, 1000),
    status: "requested" as const,
    replayMode: classifyTerminalReplay(failure.queueName),
  };

  try {
    const [header] = await db.insert(queueReplayRequests).values(values);
    const record = {
      ...values,
      id: Number((header as { insertId?: number }).insertId),
    } as typeof queueReplayRequests.$inferSelect;
    return { record, alreadyRequested: false };
  } catch (error) {
    if (!isMySqlDuplicateKeyError(error)) throw error;
    const [existing] = await db
      .select()
      .from(queueReplayRequests)
      .where(eq(queueReplayRequests.replayKey, input.replayKey))
      .limit(1);
    if (!existing) throw error;
    const sameRequest =
      existing.terminalFailureId === failure.id &&
      existing.requestedByUserId === input.requestedByUserId;
    if (!sameRequest) {
      throw new TerminalReplayKeyConflictError(input.replayKey);
    }
    return { record: existing, alreadyRequested: true };
  }
}

export type ClaimTerminalReplayResult =
  | { claimed: true; request: typeof queueReplayRequests.$inferSelect }
  | {
      claimed: false;
      reason: "invalid_state" | "already_active";
      request: typeof queueReplayRequests.$inferSelect;
    };

async function releaseActiveClaim(
  db: TerminalReplayExecutor,
  terminalFailureId: number,
  replayRequestId: number
): Promise<void> {
  // No blanket catch: a genuine delete failure must propagate so the
  // surrounding transaction rolls the terminal request transition back.
  // "Zero rows deleted" is not an error (no active guard is expected on some
  // paths, e.g. requested -> failed).
  await db
    .delete(queueReplayActiveClaims)
    .where(
      and(
        eq(queueReplayActiveClaims.terminalFailureId, terminalFailureId),
        eq(queueReplayActiveClaims.replayRequestId, replayRequestId)
      )
    );
}

/**
 * Durable conditional claim, transactionally safe.
 *
 * The unique PRIMARY KEY on queue_replay_active_claims.terminalFailureId is
 * the concurrency authority: exactly one request per terminal failure can be
 * actively claimed/enqueuing, decided by the database — not by pre-reads.
 * Guard acquisition and the guarded status transition commit or roll back as
 * one unit, so after any intermediate failure there is never
 * "request claimed without an active claim" nor "active claim while the
 * request is still requested".
 *
 * The pre-read below is a fast path only; it decides nothing. A row that
 * reads as 'requested' can still lose the claim to the unique authority, and
 * the conditional UPDATE inside the transaction re-verifies state.
 */
export async function claimTerminalReplayRequest(
  replayRequestId: number,
  opts?: { claimedAt?: Date },
  executor?: TerminalReplayExecutor
): Promise<ClaimTerminalReplayResult> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(queueReplayRequests)
    .where(eq(queueReplayRequests.id, replayRequestId))
    .limit(1);
  if (!row) throw new TerminalReplayRequestNotFoundError(replayRequestId);
  if (row.status !== "requested") {
    return { claimed: false, reason: "invalid_state", request: row };
  }

  try {
    return await runInTransaction(db, async (tx) => {
      try {
        await tx.insert(queueReplayActiveClaims).values({
          terminalFailureId: row.terminalFailureId,
          replayRequestId: row.id,
        });
      } catch (error) {
        if (isMySqlDuplicateKeyError(error)) throw new ActiveClaimTakenError();
        throw error;
      }

      const claimedAt = opts?.claimedAt ?? new Date();
      const [header] = await tx
        .update(queueReplayRequests)
        .set({ status: "claimed", claimedAt })
        .where(
          and(
            eq(queueReplayRequests.id, row.id),
            eq(queueReplayRequests.status, "requested")
          )
        );
      if (Number((header as { affectedRows?: number }).affectedRows) !== 1) {
        throw new ClaimInvalidStateError();
      }
      return {
        claimed: true,
        request: {
          ...row,
          status: "claimed",
          claimedAt,
        } as typeof queueReplayRequests.$inferSelect,
      };
    });
  } catch (error) {
    if (error instanceof ActiveClaimTakenError) {
      return { claimed: false, reason: "already_active", request: row };
    }
    if (error instanceof ClaimInvalidStateError) {
      return { claimed: false, reason: "invalid_state", request: row };
    }
    throw error;
  }
}

/** Allowed durable state transitions; resolved/failed are terminal.
 *  claimed may resolve directly when the target is discovered already
 *  completed (used by the WBS9D2A publishing executor after claiming). */
const VALID_TRANSITIONS: Record<ReplayRequestStatus, ReplayRequestStatus[]> = {
  requested: ["claimed", "failed"],
  claimed: ["enqueued", "resolved", "failed"],
  enqueued: ["resolved", "failed"],
  resolved: [],
  failed: [],
};

async function guardedTransition(
  db: TerminalReplayExecutor,
  replayRequestId: number,
  to: ReplayRequestStatus,
  set: Record<string, unknown>
): Promise<typeof queueReplayRequests.$inferSelect> {
  const allowedFrom = (Object.keys(VALID_TRANSITIONS) as ReplayRequestStatus[]).filter((s) =>
    VALID_TRANSITIONS[s].includes(to)
  );
  for (const from of allowedFrom) {
    const [header] = await db
      .update(queueReplayRequests)
      .set({ ...set, status: to })
      .where(
        and(
          eq(queueReplayRequests.id, replayRequestId),
          eq(queueReplayRequests.status, from)
        )
      );
    if (Number((header as { affectedRows?: number }).affectedRows) === 1) {
      const [updated] = await db
        .select()
        .from(queueReplayRequests)
        .where(eq(queueReplayRequests.id, replayRequestId))
        .limit(1);
      return updated;
    }
  }
  const [current] = await db
    .select()
    .from(queueReplayRequests)
    .where(eq(queueReplayRequests.id, replayRequestId))
    .limit(1);
  if (!current) throw new TerminalReplayRequestNotFoundError(replayRequestId);
  throw new TerminalReplayInvalidTransitionError(replayRequestId, current.status, to);
}

/** claimed -> enqueued. The active-claim guard is retained (still active). */
export async function markTerminalReplayEnqueued(
  replayRequestId: number,
  opts?: { enqueuedAt?: Date; replayBullmqJobId?: string | null },
  executor?: TerminalReplayExecutor
): Promise<typeof queueReplayRequests.$inferSelect> {
  const db = resolveDb(executor);
  return guardedTransition(db, replayRequestId, "enqueued", {
    enqueuedAt: opts?.enqueuedAt ?? new Date(),
    replayBullmqJobId: sanitizeBoundedText(opts?.replayBullmqJobId, 191),
  });
}

/** enqueued -> resolved. Atomically releases the terminalFailureId authority. */
export async function markTerminalReplayResolved(
  replayRequestId: number,
  opts?: { resolvedAt?: Date },
  executor?: TerminalReplayExecutor
): Promise<typeof queueReplayRequests.$inferSelect> {
  const db = resolveDb(executor);
  return runInTransaction(db, async (tx) => {
    const record = await guardedTransition(tx, replayRequestId, "resolved", {
      resolvedAt: opts?.resolvedAt ?? new Date(),
    });
    await releaseActiveClaim(tx, record.terminalFailureId, replayRequestId);
    return record;
  });
}

/** requested/claimed/enqueued -> failed. Atomically releases the authority. */
export async function markTerminalReplayFailed(
  replayRequestId: number,
  opts?: { failedAt?: Date; error?: unknown },
  executor?: TerminalReplayExecutor
): Promise<typeof queueReplayRequests.$inferSelect> {
  const db = resolveDb(executor);
  return runInTransaction(db, async (tx) => {
    const record = await guardedTransition(tx, replayRequestId, "failed", {
      failedAt: opts?.failedAt ?? new Date(),
      lastErrorSummary: sanitizeErrorSummary(
        (opts?.error as { message?: unknown } | null | undefined)?.message ?? opts?.error
      ),
    });
    await releaseActiveClaim(tx, record.terminalFailureId, replayRequestId);
    return record;
  });
}

export class TerminalReplayBindingConflictError extends Error {
  readonly replayRequestId: number;
  constructor(replayRequestId: number) {
    super(
      `Replay request ${replayRequestId} is already bound to a different content-recovery claim`
    );
    this.name = "TerminalReplayBindingConflictError";
    this.replayRequestId = replayRequestId;
  }
}

/**
 * Bounded durable binding helper (WBS9D2B): correlates a claimed replay
 * request with the exact re-armed creative-generation claim.
 *
 * First exact binding wins; exact replay reuses it (idempotent). A different
 * claim id or owner-token fingerprint fails closed. Only the SHA-256
 * fingerprint of the ownerToken is persisted — never the raw token.
 *
 * Callers invoke this inside the same transaction as the claim re-arm so a
 * crash can never leave a re-armed running claim without durable proof of
 * which replay request owns it.
 */
export async function bindContentRecoveryClaim(
  replayRequestId: number,
  binding: { claimId: number; ownerTokenHash: string },
  executor?: TerminalReplayExecutor
): Promise<{ bound: boolean }> {
  const db = resolveDb(executor);
  const [header] = await db
    .update(queueReplayRequests)
    .set({
      contentRecoveryClaimId: binding.claimId,
      contentRecoveryOwnerTokenHash: binding.ownerTokenHash,
      contentRecoveryPreparedAt: new Date(),
    })
    .where(
      and(
        eq(queueReplayRequests.id, replayRequestId),
        eq(queueReplayRequests.status, "claimed"),
        or(
          isNull(queueReplayRequests.contentRecoveryClaimId),
          and(
            eq(queueReplayRequests.contentRecoveryClaimId, binding.claimId),
            eq(queueReplayRequests.contentRecoveryOwnerTokenHash, binding.ownerTokenHash)
          )
        )
      )
    );

  if (Number((header as { affectedRows?: number }).affectedRows) === 1) {
    return { bound: true };
  }

  const [current] = await db
    .select()
    .from(queueReplayRequests)
    .where(eq(queueReplayRequests.id, replayRequestId))
    .limit(1);
  if (
    current &&
    current.contentRecoveryClaimId === binding.claimId &&
    current.contentRecoveryOwnerTokenHash === binding.ownerTokenHash
  ) {
    return { bound: false };
  }
  throw new TerminalReplayBindingConflictError(replayRequestId);
}

/**
 * Guarded owner-token-hash rotation (WBS9D2B correction): after the stale
 * terminalization + re-arm of an expired replay-owned bound claim, the
 * durable binding must move from the old fingerprint to the new one without
 * ever last-writer-wins. The claim ID is never replaced. Only fingerprints
 * are persisted — never a raw ownerToken.
 *
 * Callers invoke this inside the same transaction as the stale
 * terminalization + re-arm so a crash can never leave the claim re-armed
 * with a new token while the binding still carries the old hash (or vice
 * versa).
 */
export async function rotateContentRecoveryClaimOwnerHash(
  input: {
    replayRequestId: number;
    claimId: number;
    expectedOwnerTokenHash: string;
    nextOwnerTokenHash: string;
    preparedAt?: Date;
  },
  executor?: TerminalReplayExecutor
): Promise<{ rotated: boolean }> {
  const db = resolveDb(executor);
  const [header] = await db
    .update(queueReplayRequests)
    .set({
      contentRecoveryOwnerTokenHash: input.nextOwnerTokenHash,
      contentRecoveryPreparedAt: input.preparedAt ?? new Date(),
    })
    .where(
      and(
        eq(queueReplayRequests.id, input.replayRequestId),
        eq(queueReplayRequests.status, "claimed"),
        eq(queueReplayRequests.contentRecoveryClaimId, input.claimId),
        eq(queueReplayRequests.contentRecoveryOwnerTokenHash, input.expectedOwnerTokenHash)
      )
    );

  if (Number((header as { affectedRows?: number }).affectedRows) === 1) {
    return { rotated: true };
  }

  const [current] = await db
    .select()
    .from(queueReplayRequests)
    .where(eq(queueReplayRequests.id, input.replayRequestId))
    .limit(1);
  if (
    current &&
    current.contentRecoveryClaimId === input.claimId &&
    current.contentRecoveryOwnerTokenHash === input.nextOwnerTokenHash
  ) {
    // Exact replay of an already-applied rotation.
    return { rotated: false };
  }
  throw new TerminalReplayBindingConflictError(input.replayRequestId);
}
