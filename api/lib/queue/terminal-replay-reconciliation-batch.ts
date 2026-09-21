import { asc, eq } from "drizzle-orm";
import { queueReplayRequests } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  ReplayReconciliationInvariantError,
  reconcileTerminalReplayRequest,
  type ReconcileOutcome,
} from "./terminal-replay-reconciliation";
import {
  TerminalReplayInvalidTransitionError,
  TerminalReplayRequestNotFoundError,
  type TerminalReplayExecutor,
  type TerminalReplayMode,
} from "./terminal-replay";

/**
 * Bounded terminal-replay reconciliation batch driver (WBS9D3B).
 *
 * Orchestration only: selects outstanding queue_replay_requests with
 * status=enqueued in one deterministic snapshot, invokes the WBS9D3A durable
 * reconciler sequentially (one request at a time), isolates per-request
 * failures, and returns a sanitized operational report.
 *
 * NOT a scheduler: no timers, no boot-time start, no workers, no Redis, no
 * BullMQ. D3A remains the only terminal-outcome authority — this module never
 * updates queue_replay_requests, never touches queue_replay_active_claims, and
 * never classifies outcomes from business tables. Overlapping batch
 * invocations are safe because D3A's guarded terminal transition is the
 * request concurrency authority.
 */

export const TERMINAL_REPLAY_BATCH_DEFAULT_LIMIT = 25;
export const TERMINAL_REPLAY_BATCH_MAX_LIMIT = 100;

export type TerminalReplayBatchItemOutcome =
  | "resolved"
  | "failed"
  | "pending"
  | "already_terminal"
  | "error";

export interface TerminalReplayBatchItem {
  replayRequestId: number;
  outcome: TerminalReplayBatchItemOutcome;
  mode?: TerminalReplayMode;
  /** Bounded pending reason, or the fixed "reconciliation_error". */
  reason?: string;
  /** Bounded operational classification only (never raw error text). */
  errorCode?: string;
}

export interface TerminalReplayBatchReport {
  selectedCount: number;
  attemptedCount: number;
  resolvedCount: number;
  failedCount: number;
  pendingCount: number;
  alreadyTerminalCount: number;
  errorCount: number;
  limit: number;
  items: TerminalReplayBatchItem[];
}

export interface ReconcileTerminalReplayBatchInput {
  limit?: number;
  clock?: () => Date;
  executor?: TerminalReplayExecutor;
  reconcileRequest?: typeof reconcileTerminalReplayRequest;
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit)) {
    throw new TypeError("limit must be an integer");
  }
  if (limit <= 0) {
    throw new RangeError("limit must be greater than 0");
  }
  if (limit > TERMINAL_REPLAY_BATCH_MAX_LIMIT) {
    throw new RangeError(`limit must not exceed ${TERMINAL_REPLAY_BATCH_MAX_LIMIT}`);
  }
}

/**
 * Bounded error classification: only well-known bounded error authorities
 * contribute a code. Raw exception text is never copied into the report.
 */
function classifyReconciliationError(err: unknown): { errorCode?: string } {
  if (err instanceof ReplayReconciliationInvariantError) {
    return { errorCode: err.code };
  }
  if (err instanceof TerminalReplayRequestNotFoundError) {
    return { errorCode: "replay_request_not_found" };
  }
  if (err instanceof TerminalReplayInvalidTransitionError) {
    return { errorCode: "invalid_transition" };
  }
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && /^[A-Z_]{3,32}$/.test(code)) {
    // Bounded uppercase operational codes only (e.g. TRPC codes).
    return { errorCode: code };
  }
  return {};
}

function toBatchItem(
  replayRequestId: number,
  result: ReconcileOutcome
): TerminalReplayBatchItem {
  if (result.outcome === "pending") {
    return {
      replayRequestId,
      outcome: "pending",
      mode: result.mode,
      reason: result.reason,
    };
  }
  if (result.outcome === "already_terminal") {
    return { replayRequestId, outcome: "already_terminal", reason: result.status };
  }
  return { replayRequestId, outcome: result.outcome, mode: result.mode };
}

export async function reconcileTerminalReplayBatch({
  limit = TERMINAL_REPLAY_BATCH_DEFAULT_LIMIT,
  clock = () => new Date(),
  executor,
  reconcileRequest = reconcileTerminalReplayRequest,
}: ReconcileTerminalReplayBatchInput = {}): Promise<TerminalReplayBatchReport> {
  validateLimit(limit);
  const db = executor ?? getDb();

  // Candidate snapshot: selected ONCE per pass, deterministic order, bounded.
  const rows = await db
    .select({ id: queueReplayRequests.id })
    .from(queueReplayRequests)
    .where(eq(queueReplayRequests.status, "enqueued"))
    .orderBy(asc(queueReplayRequests.id))
    .limit(limit);
  const candidateIds = rows.map((row) => row.id);

  const items: TerminalReplayBatchItem[] = [];
  let resolvedCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let alreadyTerminalCount = 0;
  let errorCount = 0;

  // Sequential, one D3A invocation per candidate. No Promise.all, no retry
  // loop: each D3A call owns its concurrency authority, and pending rows stay
  // enqueued for a later pass.
  for (const replayRequestId of candidateIds) {
    try {
      const result = await reconcileRequest({ replayRequestId, clock, executor: db });
      items.push(toBatchItem(replayRequestId, result));
      if (result.outcome === "resolved") resolvedCount++;
      else if (result.outcome === "failed") failedCount++;
      else if (result.outcome === "pending") pendingCount++;
      else if (result.outcome === "already_terminal") alreadyTerminalCount++;
    } catch (err) {
      errorCount++;
      items.push({
        replayRequestId,
        outcome: "error",
        reason: "reconciliation_error",
        ...classifyReconciliationError(err),
      });
    }
  }

  return {
    selectedCount: candidateIds.length,
    attemptedCount: items.length,
    resolvedCount,
    failedCount,
    pendingCount,
    alreadyTerminalCount,
    errorCount,
    limit,
    items,
  };
}
