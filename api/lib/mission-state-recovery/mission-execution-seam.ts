// ─── R9-E Mission State & Recovery — R9-D execution evidence seam ───
//
// Consumes R9-D execution authority READ-ONLY through the frozen
// mission-execution-to-state-recovery/v1 vocabulary (contract @ R9-D
// 2b7735e): execution_actions + execution_attempts rows, behind guarded
// information-schema checks. Execution history is immutable input — this
// seam never writes any R9-D table, never mints attempts, never re-classifies
// results (R9-D's conservative classification is trusted verbatim and
// re-validated against the closed vocabularies).
//
// Fail-closed posture: absent execution tables ⇒ EMPTY EVIDENCE (a mission
// with no execution history derives PENDING states; a task whose recovery
// candidate requires an attempt fails closed at proposal time). A malformed
// execution row (unknown status vocabulary / broken hash pattern) throws —
// derived state must never be built from corrupted execution evidence.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  EXECUTION_ACTION_ID_PATTERN,
  EXECUTION_ATTEMPT_ID_PATTERN,
  MISSION_ID_PATTERN,
  MISSION_STATE_INPUT_MALFORMED,
  R9_DISPATCH_STATES,
  R9_EXECUTION_FAILURE_CLASSES,
  R9_EXECUTION_UNCERTAINTY_CLASSES,
  R9_RESULT_STATUSES,
  MissionStateUpstreamError,
  isIsoUtc,
} from "./mission-state-recovery-contract";

// ─── Row views ───

export interface ExecutionActionView {
  readonly executionActionId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly missionId: string;
  readonly planId: string;
  readonly scheduleId: string;
  readonly taskId: string;
  readonly taskType: string;
  readonly actionType: string;
  readonly actionParametersHash: string;
  readonly governanceDecisionId: string;
  readonly authorizationFingerprint: string;
  readonly adapterType: string;
  readonly capability: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly dispatchState: string;
  readonly attemptCount: number;
}

export interface ExecutionAttemptView {
  readonly attemptId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly executionActionId: string;
  readonly attemptNumber: number;
  readonly adapterType: string;
  readonly capability: string;
  readonly externalReference: string | null;
  readonly resultStatus: string | null;
  readonly failureClass: string;
  readonly uncertaintyClass: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

export interface MissionExecutionAuthority {
  listActionsForMission(userId: number, missionId: string): Promise<ExecutionActionView[]>;
  listActionsForTask(userId: number, missionId: string, taskId: string): Promise<ExecutionActionView[]>;
  listAttemptsForAction(userId: number, executionActionId: string): Promise<ExecutionAttemptView[]>;
}

// ─── Shared row shapers (identical semantics in production + in-memory) ───

export function shapeExecutionActionRow(row: Record<string, unknown>): ExecutionActionView {
  const executionActionId = String(row.executionActionId ?? "");
  if (!EXECUTION_ACTION_ID_PATTERN.test(executionActionId)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, "execution action row has malformed identity.");
  }
  const missionId = String(row.missionId ?? "");
  if (!MISSION_ID_PATTERN.test(missionId)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, `action ${executionActionId} has malformed missionId.`);
  }
  const dispatchState = String(row.dispatchState ?? "");
  if (!(R9_DISPATCH_STATES as readonly string[]).includes(dispatchState)) {
    throw new MissionStateUpstreamError(
      MISSION_STATE_INPUT_MALFORMED,
      `action ${executionActionId} has unknown dispatchState ${dispatchState}.`
    );
  }
  return {
    executionActionId,
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    missionId,
    planId: String(row.planId ?? ""),
    scheduleId: String(row.scheduleId ?? ""),
    taskId: String(row.taskId ?? ""),
    taskType: String(row.taskType ?? ""),
    actionType: String(row.actionType ?? ""),
    actionParametersHash: String(row.actionParametersHash ?? ""),
    governanceDecisionId: String(row.governanceDecisionId ?? ""),
    authorizationFingerprint: String(row.authorizationFingerprint ?? ""),
    adapterType: String(row.adapterType ?? ""),
    capability: String(row.capability ?? ""),
    validFrom: isIsoUtc(String(row.validFrom ?? "")) ? String(row.validFrom) : "",
    validUntil: isIsoUtc(String(row.validUntil ?? "")) ? String(row.validUntil) : "",
    dispatchState,
    attemptCount: Number(row.attemptCount ?? 0),
  };
}

export function shapeExecutionAttemptRow(row: Record<string, unknown>): ExecutionAttemptView {
  const attemptId = String(row.attemptId ?? "");
  if (!EXECUTION_ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, "execution attempt row has malformed identity.");
  }
  const resultStatus = row.resultStatus === null || row.resultStatus === undefined ? null : String(row.resultStatus);
  if (resultStatus !== null && !(R9_RESULT_STATUSES as readonly string[]).includes(resultStatus)) {
    throw new MissionStateUpstreamError(
      MISSION_STATE_INPUT_MALFORMED,
      `attempt ${attemptId} has unknown resultStatus ${resultStatus}.`
    );
  }
  const failureClass = String(row.failureClass ?? "NONE");
  if (!(R9_EXECUTION_FAILURE_CLASSES as readonly string[]).includes(failureClass)) {
    throw new MissionStateUpstreamError(
      MISSION_STATE_INPUT_MALFORMED,
      `attempt ${attemptId} has unknown failureClass ${failureClass}.`
    );
  }
  const uncertaintyClass = String(row.uncertaintyClass ?? "NONE");
  if (!(R9_EXECUTION_UNCERTAINTY_CLASSES as readonly string[]).includes(uncertaintyClass)) {
    throw new MissionStateUpstreamError(
      MISSION_STATE_INPUT_MALFORMED,
      `attempt ${attemptId} has unknown uncertaintyClass ${uncertaintyClass}.`
    );
  }
  return {
    attemptId,
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    executionActionId: String(row.executionActionId ?? ""),
    attemptNumber: Number(row.attemptNumber ?? 0),
    adapterType: String(row.adapterType ?? ""),
    capability: String(row.capability ?? ""),
    externalReference: typeof row.externalReference === "string" && row.externalReference.length > 0 ? row.externalReference : null,
    resultStatus,
    failureClass,
    uncertaintyClass,
    startedAt: isIsoUtc(String(row.startedAt ?? "")) ? String(row.startedAt) : null,
    completedAt: isIsoUtc(String(row.completedAt ?? "")) ? String(row.completedAt) : null,
    createdAt: String(row.createdAt ?? ""),
  };
}

// ─── Production port: raw SQL behind guarded information-schema checks ───

type SqlExecutor = { execute: ReturnType<typeof getDb>["execute"] };

function normalizeSqlRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    const first = result[0];
    if (Array.isArray(first)) return first as Array<Record<string, unknown>>;
    if (first && typeof first === "object") return [first as Record<string, unknown>];
    return [];
  }
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

async function executionTableExists(db: SqlExecutor, table: string): Promise<boolean> {
  try {
    const rows = normalizeSqlRows(
      await db.execute(sql`
        SELECT COUNT(*) AS c FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}
      `)
    );
    const first = rows[0];
    return Number(first ? Number(first.c ?? 0) : 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Injected production port. Never writes. Absent execution tables ⇒ empty
 * evidence (a mission that was never executed is legitimately all-PENDING);
 * malformed rows throw — never derive from corrupted evidence.
 */
export function createMissionExecutionAuthority(executor?: SqlExecutor): MissionExecutionAuthority {
  const db = executor ?? getDb();

  async function guarded(table: string): Promise<void> {
    if (!(await executionTableExists(db, table))) return; // absent ⇒ empty evidence
  }

  return {
    async listActionsForMission(userId, missionId) {
      if (!MISSION_ID_PATTERN.test(missionId)) return [];
      await guarded("execution_actions");
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT executionActionId, userId, businessId, missionId, planId, scheduleId, taskId, taskType,
                 actionType, actionParametersHash, governanceDecisionId, authorizationFingerprint,
                 adapterType, capability, validFrom, validUntil, dispatchState, attemptCount
          FROM execution_actions WHERE userId = ${userId} AND missionId = ${missionId}
          ORDER BY executionActionId ASC
          LIMIT 100
        `)
      );
      return rows.map(shapeExecutionActionRow);
    },
    async listActionsForTask(userId, missionId, taskId) {
      if (!MISSION_ID_PATTERN.test(missionId)) return [];
      await guarded("execution_actions");
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT executionActionId, userId, businessId, missionId, planId, scheduleId, taskId, taskType,
                 actionType, actionParametersHash, governanceDecisionId, authorizationFingerprint,
                 adapterType, capability, validFrom, validUntil, dispatchState, attemptCount
          FROM execution_actions WHERE userId = ${userId} AND missionId = ${missionId} AND taskId = ${taskId}
          ORDER BY executionActionId ASC
          LIMIT 50
        `)
      );
      return rows.map(shapeExecutionActionRow);
    },
    async listAttemptsForAction(userId, executionActionId) {
      if (!EXECUTION_ACTION_ID_PATTERN.test(executionActionId)) return [];
      await guarded("execution_attempts");
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT attemptId, userId, businessId, executionActionId, attemptNumber, adapterType, capability,
                 externalReference, resultStatus, failureClass, uncertaintyClass, startedAt, completedAt, createdAt
          FROM execution_attempts WHERE userId = ${userId} AND executionActionId = ${executionActionId}
          ORDER BY attemptNumber DESC
          LIMIT 100
        `)
      );
      return rows.map(shapeExecutionAttemptRow);
    },
  };
}

// ─── In-memory port over planted raw rows (identical validation) ───

export interface FakeExecutionRow {
  readonly table: string;
  readonly row: Record<string, unknown>;
}

export function createInMemoryMissionExecutionAuthority(
  rows: readonly FakeExecutionRow[]
): MissionExecutionAuthority {
  const ofTable = (table: string) => rows.filter((r) => r.table === table).map((r) => r.row);
  return {
    async listActionsForMission(userId, missionId) {
      if (!MISSION_ID_PATTERN.test(missionId)) return [];
      return ofTable("execution_actions")
        .filter((r) => Number(r.userId) === userId && r.missionId === missionId)
        .map(shapeExecutionActionRow);
    },
    async listActionsForTask(userId, missionId, taskId) {
      if (!MISSION_ID_PATTERN.test(missionId)) return [];
      return ofTable("execution_actions")
        .filter((r) => Number(r.userId) === userId && r.missionId === missionId && r.taskId === taskId)
        .map(shapeExecutionActionRow);
    },
    async listAttemptsForAction(userId, executionActionId) {
      if (!EXECUTION_ACTION_ID_PATTERN.test(executionActionId)) return [];
      return ofTable("execution_attempts")
        .filter((r) => Number(r.userId) === userId && r.executionActionId === executionActionId)
        .sort((a, b) => Number(b.attemptNumber ?? 0) - Number(a.attemptNumber ?? 0))
        .map(shapeExecutionAttemptRow);
    },
  };
}
