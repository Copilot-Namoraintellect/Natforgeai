// ─── R9-D Execution Coordination — durable store ───
//
// Insert-first persistence over the stream-local execution tables with
// durable unique anchors (structural exact-once). Rows are immutable;
// mutable state lives behind optimistic-CAS version guards; hash drift on
// immutable cores fails closed (EXECUTION_TAMPER). The store never touches
// upstream (R9-A/B/C/F) or legacy execution tables.

import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  executionActions,
  executionAttempts,
  executionLifecycleEvents,
  type ExecutionActionRow,
  type ExecutionAttemptRow,
  type ExecutionLifecycleEventRow,
  type InsertExecutionActionRow,
  type InsertExecutionAttemptRow,
  type InsertExecutionLifecycleEventRow,
} from "@db/schema";
import {
  ExecutionIdentityConflictError,
  ExecutionStateConflictError,
  ExecutionTamperError,
  type ExecutionDuplicateClassification,
} from "./execution-coordination-contract";

type Db = ReturnType<typeof getDb>;
export type ExecutionStoreExecutor = Db | undefined;

export function resolveExecutionDb(executor?: ExecutionStoreExecutor): Db {
  return executor ?? getDb();
}

function isDuplicateEntryError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  const message = String((err as { message?: unknown })?.message ?? "");
  return code === "ER_DUP_ENTRY" || message.includes("Duplicate entry") || message.includes("duplicate key");
}

// ─── Execution actions (dispatch intents) ───

export interface InsertExecutionActionResult {
  readonly row: ExecutionActionRow;
  readonly duplicateClassification: ExecutionDuplicateClassification;
}

export async function insertExecutionAction(
  row: InsertExecutionActionRow,
  executor?: ExecutionStoreExecutor
): Promise<InsertExecutionActionResult> {
  const db = resolveExecutionDb(executor);
  try {
    await db.insert(executionActions).values(row);
    const inserted = await getExecutionActionById(Number(row.userId), String(row.executionActionId), executor);
    if (!inserted) throw new ExecutionTamperError("EXECUTION_TAMPER", "execution action insert not readable.");
    return { row: inserted, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const existing = await getExecutionActionById(Number(row.userId), String(row.executionActionId), executor);
    if (existing && actionMaterialMatches(existing, row)) {
      return { row: existing, duplicateClassification: "idempotent_replay" };
    }
    // Same idempotency anchor with different material is a conflict.
    const byKey = await getExecutionActionByIdempotency(Number(row.userId), String(row.idempotencyKey), executor);
    if (byKey && byKey.executionActionId !== row.executionActionId) {
      throw new ExecutionIdentityConflictError(
        "EXECUTION_REPLAY_CONFLICT",
        "idempotency anchor already binds a different execution action."
      );
    }
    if (existing && !actionMaterialMatches(existing, row)) {
      throw new ExecutionIdentityConflictError(
        "EXECUTION_REPLAY_CONFLICT",
        "execution action identity replayed with conflicting material."
      );
    }
    throw err;
  }
}

function actionMaterialMatches(existing: ExecutionActionRow, inserted: InsertExecutionActionRow): boolean {
  return (
    existing.executionActionId === inserted.executionActionId &&
    existing.userId === inserted.userId &&
    existing.businessId === inserted.businessId &&
    existing.missionId === inserted.missionId &&
    existing.planId === inserted.planId &&
    existing.scheduleId === inserted.scheduleId &&
    existing.taskId === inserted.taskId &&
    existing.actionType === inserted.actionType &&
    existing.actionParametersHash === inserted.actionParametersHash &&
    existing.governanceDecisionId === inserted.governanceDecisionId &&
    existing.authorizationFingerprint === inserted.authorizationFingerprint &&
    existing.adapterType === inserted.adapterType &&
    existing.capability === inserted.capability &&
    existing.dispatchFingerprint === inserted.dispatchFingerprint &&
    JSON.stringify(existing.inputRefs) === JSON.stringify(inserted.inputRefs)
  );
}

export async function getExecutionActionById(
  userId: number,
  executionActionId: string,
  executor?: ExecutionStoreExecutor
): Promise<ExecutionActionRow | null> {
  const db = resolveExecutionDb(executor);
  const [row] = await db
    .select()
    .from(executionActions)
    .where(and(eq(executionActions.userId, userId), eq(executionActions.executionActionId, executionActionId)))
    .limit(1);
  return row ?? null;
}

export async function getExecutionActionByIdempotency(
  userId: number,
  idempotencyKey: string,
  executor?: ExecutionStoreExecutor
): Promise<ExecutionActionRow | null> {
  const db = resolveExecutionDb(executor);
  const [row] = await db
    .select()
    .from(executionActions)
    .where(and(eq(executionActions.userId, userId), eq(executionActions.idempotencyKey, idempotencyKey)))
    .limit(1);
  return row ?? null;
}

export async function listExecutionActionsByMission(
  userId: number,
  missionId: string,
  executor?: ExecutionStoreExecutor
): Promise<ExecutionActionRow[]> {
  const db = resolveExecutionDb(executor);
  return db
    .select()
    .from(executionActions)
    .where(and(eq(executionActions.userId, userId), eq(executionActions.missionId, missionId)))
    .orderBy(desc(executionActions.createdAt))
    .limit(100);
}

/**
 * Optimistic-CAS dispatch-state transition. Illegal from-states and stale
 * versions fail closed — simultaneous dispatchers cannot double-dispatch.
 */
export async function transitionDispatchState(input: {
  userId: number;
  executionActionId: string;
  expectedVersion: number;
  fromStates: readonly string[];
  toState: string;
  attemptCount?: number;
  executor?: ExecutionStoreExecutor;
}): Promise<ExecutionActionRow> {
  const db = resolveExecutionDb(input.executor);
  const current = await getExecutionActionById(input.userId, input.executionActionId, input.executor);
  if (!current) {
    throw new ExecutionStateConflictError("EXECUTION_ACTION_NOT_FOUND", "execution action not found.");
  }
  if (!input.fromStates.includes(current.dispatchState)) {
    throw new ExecutionStateConflictError(
      "INVALID_DISPATCH_STATE",
      `dispatch state ${current.dispatchState} cannot transition to ${input.toState}.`
    );
  }
  if (current.version !== input.expectedVersion) {
    throw new ExecutionStateConflictError(
      "INVALID_DISPATCH_STATE",
      `stale version ${input.expectedVersion}; current version is ${current.version}.`
    );
  }
  const set: Record<string, unknown> = {
    dispatchState: input.toState,
    version: current.version + 1,
    updatedAt: new Date(),
  };
  if (input.attemptCount !== undefined) set["attemptCount"] = input.attemptCount;
  await db
    .update(executionActions)
    .set(set as never)
    .where(
      and(
        eq(executionActions.userId, input.userId),
        eq(executionActions.executionActionId, input.executionActionId),
        eq(executionActions.version, input.expectedVersion)
      )
    );
  const updated = await getExecutionActionById(input.userId, input.executionActionId, input.executor);
  if (!updated || updated.version !== current.version + 1) {
    throw new ExecutionStateConflictError("INVALID_DISPATCH_STATE", "dispatch state transition lost a race.");
  }
  if (updated.dispatchState !== input.toState) {
    throw new ExecutionTamperError("EXECUTION_TAMPER", "dispatch state transition observed drift.");
  }
  return updated;
}

// ─── Execution attempts ───

export interface InsertExecutionAttemptResult {
  readonly row: ExecutionAttemptRow;
  readonly duplicateClassification: ExecutionDuplicateClassification;
}

export async function insertExecutionAttempt(
  row: InsertExecutionAttemptRow,
  executor?: ExecutionStoreExecutor
): Promise<InsertExecutionAttemptResult> {
  const db = resolveExecutionDb(executor);
  try {
    await db.insert(executionAttempts).values(row);
    const inserted = await getExecutionAttemptById(Number(row.userId), String(row.attemptId), executor);
    if (!inserted) throw new ExecutionTamperError("EXECUTION_TAMPER", "execution attempt insert not readable.");
    return { row: inserted, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const existing = await getExecutionAttemptById(Number(row.userId), String(row.attemptId), executor);
    if (existing && attemptMaterialMatches(existing, row)) {
      return { row: existing, duplicateClassification: "idempotent_replay" };
    }
    if (existing && !attemptMaterialMatches(existing, row)) {
      throw new ExecutionIdentityConflictError(
        "EXECUTION_REPLAY_CONFLICT",
        "execution attempt identity replayed with conflicting material."
      );
    }
    throw err;
  }
}

function attemptMaterialMatches(existing: ExecutionAttemptRow, inserted: InsertExecutionAttemptRow): boolean {
  return (
    existing.attemptId === inserted.attemptId &&
    existing.userId === inserted.userId &&
    existing.executionActionId === inserted.executionActionId &&
    existing.attemptNumber === inserted.attemptNumber &&
    existing.dispatchFingerprint === inserted.dispatchFingerprint &&
    existing.adapterType === inserted.adapterType &&
    existing.capability === inserted.capability
  );
}

export async function getExecutionAttemptById(
  userId: number,
  attemptId: string,
  executor?: ExecutionStoreExecutor
): Promise<ExecutionAttemptRow | null> {
  const db = resolveExecutionDb(executor);
  const [row] = await db
    .select()
    .from(executionAttempts)
    .where(and(eq(executionAttempts.userId, userId), eq(executionAttempts.attemptId, attemptId)))
    .limit(1);
  return row ?? null;
}

export async function listExecutionAttemptsForAction(
  userId: number,
  executionActionId: string,
  limit = 50,
  executor?: ExecutionStoreExecutor
): Promise<ExecutionAttemptRow[]> {
  const db = resolveExecutionDb(executor);
  return db
    .select()
    .from(executionAttempts)
    .where(and(eq(executionAttempts.userId, userId), eq(executionAttempts.executionActionId, executionActionId)))
    .orderBy(desc(executionAttempts.attemptNumber))
    .limit(limit);
}

export async function getLatestExecutionAttemptForAction(
  userId: number,
  executionActionId: string,
  executor?: ExecutionStoreExecutor
): Promise<ExecutionAttemptRow | null> {
  const attempts = await listExecutionAttemptsForAction(userId, executionActionId, 1, executor);
  return attempts[0] ?? null;
}

/**
 * Predecessor dependency check: a SUCCEEDED attempt bound to the same
 * mission + task proves execution-side completion for HARD ordering edges.
 */
export async function findSucceededExecutionAttemptForTask(
  userId: number,
  missionId: string,
  taskId: string,
  executor?: ExecutionStoreExecutor
): Promise<ExecutionAttemptRow | null> {
  const db = resolveExecutionDb(executor);
  const actions = await db
    .select({ executionActionId: executionActions.executionActionId })
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.missionId, missionId),
        eq(executionActions.taskId, taskId)
      )
    );
  const ids = actions.map((a) => a.executionActionId);
  if (ids.length === 0) return null;
  const [row] = await db
    .select()
    .from(executionAttempts)
    .where(
      and(
        eq(executionAttempts.userId, userId),
        inArray(executionAttempts.executionActionId, ids),
        eq(executionAttempts.resultStatus, "SUCCEEDED")
      )
    )
    .orderBy(desc(executionAttempts.completedAt))
    .limit(1);
  return row ?? null;
}

// ─── Lifecycle facts ───

export async function insertExecutionLifecycleEvent(
  row: InsertExecutionLifecycleEventRow,
  executor?: ExecutionStoreExecutor
): Promise<{ readonly duplicateClassification: ExecutionDuplicateClassification }> {
  const db = resolveExecutionDb(executor);
  try {
    await db.insert(executionLifecycleEvents).values(row);
    return { duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    return { duplicateClassification: "idempotent_replay" };
  }
}

export async function listExecutionLifecycleForAction(
  userId: number,
  executionActionId: string,
  executor?: ExecutionStoreExecutor
): Promise<ExecutionLifecycleEventRow[]> {
  const db = resolveExecutionDb(executor);
  return db
    .select()
    .from(executionLifecycleEvents)
    .where(
      and(
        eq(executionLifecycleEvents.userId, userId),
        eq(executionLifecycleEvents.executionActionId, executionActionId)
      )
    )
    .orderBy(desc(executionLifecycleEvents.createdAt))
    .limit(200);
}
