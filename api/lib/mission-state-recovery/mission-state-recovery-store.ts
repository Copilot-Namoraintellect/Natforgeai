// ─── R9-E Mission State, Recovery & Observability — durable store ───
//
// Insert-first persistence over the stream-local R9-E tables with durable
// unique anchors (structural exact-once). Immutable-core hash drift fails
// closed (MISSION_STATE_TAMPER); mutable lifecycle state lives behind
// optimistic-CAS version guards. The store never touches upstream
// (R9-A/B/C/D/F) or legacy execution tables.

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  missionOperationalTimelineEvents,
  missionRecoveryCandidates,
  missionStateRecords,
  missionTaskStates,
  type InsertMissionOperationalTimelineEventRow,
  type InsertMissionRecoveryCandidateRow,
  type InsertMissionStateRecordRow,
  type InsertMissionTaskStateRow,
  type MissionOperationalTimelineEventRow,
  type MissionRecoveryCandidateRow,
  type MissionStateRecordRow,
  type MissionTaskStateRow,
} from "@db/schema";
import {
  MISSION_STATE_REPLAY_CONFLICT,
  MISSION_STATE_TAMPER,
  MissionStateIdentityConflictError,
  MissionStateTamperError,
  type MissionDuplicateClassification,
} from "./mission-state-recovery-contract";

type Db = ReturnType<typeof getDb>;
export type MissionStateStoreExecutor = Db | undefined;

export function resolveMissionStateDb(executor?: MissionStateStoreExecutor): Db {
  return executor ?? getDb();
}

function isDuplicateEntryError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  const message = String((err as { message?: unknown })?.message ?? "");
  return code === "ER_DUP_ENTRY" || message.includes("Duplicate entry") || message.includes("duplicate key");
}

// ─── Mission state records ───

export interface InsertMissionStateRecordResult {
  readonly row: MissionStateRecordRow;
  readonly duplicateClassification: MissionDuplicateClassification;
}

export async function insertMissionStateRecord(
  row: InsertMissionStateRecordRow,
  executor?: MissionStateStoreExecutor
): Promise<InsertMissionStateRecordResult> {
  const db = resolveMissionStateDb(executor);
  try {
    await db.insert(missionStateRecords).values(row);
    const inserted = await getMissionStateRecordById(Number(row.userId), String(row.missionStateId), executor);
    if (!inserted) throw new MissionStateTamperError(MISSION_STATE_TAMPER, "mission state insert not readable.");
    return { row: inserted, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const existing = await getMissionStateRecordById(Number(row.userId), String(row.missionStateId), executor);
    if (existing && missionStateMaterialMatches(existing, row)) {
      return { row: existing, duplicateClassification: "idempotent_replay" };
    }
    throw new MissionStateIdentityConflictError(
      MISSION_STATE_REPLAY_CONFLICT,
      "mission state identity replayed with conflicting material."
    );
  }
}

function missionStateMaterialMatches(existing: MissionStateRecordRow, inserted: InsertMissionStateRecordRow): boolean {
  return (
    existing.missionStateId === inserted.missionStateId &&
    existing.userId === inserted.userId &&
    existing.businessId === inserted.businessId &&
    existing.missionId === inserted.missionId &&
    existing.planId === inserted.planId &&
    existing.scheduleId === inserted.scheduleId &&
    existing.missionStatus === inserted.missionStatus &&
    existing.healthClass === inserted.healthClass &&
    existing.derivedFromVersion === inserted.derivedFromVersion &&
    existing.observedAt === inserted.observedAt
  );
}

export async function getMissionStateRecordById(
  userId: number,
  missionStateId: string,
  executor?: MissionStateStoreExecutor
): Promise<MissionStateRecordRow | null> {
  const db = resolveMissionStateDb(executor);
  const [row] = await db
    .select()
    .from(missionStateRecords)
    .where(and(eq(missionStateRecords.userId, userId), eq(missionStateRecords.missionStateId, missionStateId)))
    .limit(1);
  return row ?? null;
}

/** The most recent observation for the exact mission+schedule scope. */
export async function getLatestMissionStateRecord(
  userId: number,
  missionId: string,
  scheduleId: string | null,
  executor?: MissionStateStoreExecutor
): Promise<MissionStateRecordRow | null> {
  const db = resolveMissionStateDb(executor);
  const conditions = scheduleId
    ? and(eq(missionStateRecords.userId, userId), eq(missionStateRecords.missionId, missionId), eq(missionStateRecords.scheduleId, scheduleId))
    : and(eq(missionStateRecords.userId, userId), eq(missionStateRecords.missionId, missionId));
  const [row] = await db
    .select()
    .from(missionStateRecords)
    .where(conditions)
    .orderBy(desc(missionStateRecords.createdAt), desc(missionStateRecords.id))
    .limit(1);
  return row ?? null;
}

export async function listMissionStateRecords(
  userId: number,
  missionId: string,
  limit = 50,
  executor?: MissionStateStoreExecutor
): Promise<MissionStateRecordRow[]> {
  const db = resolveMissionStateDb(executor);
  return db
    .select()
    .from(missionStateRecords)
    .where(and(eq(missionStateRecords.userId, userId), eq(missionStateRecords.missionId, missionId)))
    .orderBy(desc(missionStateRecords.createdAt), desc(missionStateRecords.id))
    .limit(limit);
}

// ─── Task states ───

export interface InsertMissionTaskStateResult {
  readonly row: MissionTaskStateRow;
  readonly duplicateClassification: MissionDuplicateClassification;
}

export async function insertMissionTaskState(
  row: InsertMissionTaskStateRow,
  executor?: MissionStateStoreExecutor
): Promise<InsertMissionTaskStateResult> {
  const db = resolveMissionStateDb(executor);
  try {
    await db.insert(missionTaskStates).values(row);
    const inserted = await getMissionTaskStateById(Number(row.userId), String(row.taskStateId), executor);
    if (!inserted) throw new MissionStateTamperError(MISSION_STATE_TAMPER, "task state insert not readable.");
    return { row: inserted, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const existing = await getMissionTaskStateById(Number(row.userId), String(row.taskStateId), executor);
    if (existing && taskStateMaterialMatches(existing, row)) {
      return { row: existing, duplicateClassification: "idempotent_replay" };
    }
    throw new MissionStateIdentityConflictError(
      MISSION_STATE_REPLAY_CONFLICT,
      "task state identity replayed with conflicting material."
    );
  }
}

function taskStateMaterialMatches(existing: MissionTaskStateRow, inserted: InsertMissionTaskStateRow): boolean {
  return (
    existing.taskStateId === inserted.taskStateId &&
    existing.userId === inserted.userId &&
    existing.businessId === inserted.businessId &&
    existing.missionId === inserted.missionId &&
    existing.taskId === inserted.taskId &&
    existing.status === inserted.status &&
    existing.stateHash === inserted.stateHash &&
    existing.lastUpdatedAt === inserted.lastUpdatedAt
  );
}

export async function getMissionTaskStateById(
  userId: number,
  taskStateId: string,
  executor?: MissionStateStoreExecutor
): Promise<MissionTaskStateRow | null> {
  const db = resolveMissionStateDb(executor);
  const [row] = await db
    .select()
    .from(missionTaskStates)
    .where(and(eq(missionTaskStates.userId, userId), eq(missionTaskStates.taskStateId, taskStateId)))
    .limit(1);
  return row ?? null;
}

/** Latest task state per task for a mission (newest version wins per task). */
export async function listLatestMissionTaskStates(
  userId: number,
  missionId: string,
  limit = 200,
  executor?: MissionStateStoreExecutor
): Promise<MissionTaskStateRow[]> {
  const db = resolveMissionStateDb(executor);
  return db
    .select()
    .from(missionTaskStates)
    .where(and(eq(missionTaskStates.userId, userId), eq(missionTaskStates.missionId, missionId)))
    .orderBy(desc(missionTaskStates.lastUpdatedAt), desc(missionTaskStates.id))
    .limit(limit);
}

// ─── Recovery candidates ───

export interface InsertMissionRecoveryCandidateResult {
  readonly row: MissionRecoveryCandidateRow;
  readonly duplicateClassification: MissionDuplicateClassification;
}

export async function insertMissionRecoveryCandidate(
  row: InsertMissionRecoveryCandidateRow,
  executor?: MissionStateStoreExecutor
): Promise<InsertMissionRecoveryCandidateResult> {
  const db = resolveMissionStateDb(executor);
  try {
    await db.insert(missionRecoveryCandidates).values(row);
    const inserted = await getMissionRecoveryCandidateById(Number(row.userId), String(row.recoveryCandidateId), executor);
    if (!inserted) throw new MissionStateTamperError(MISSION_STATE_TAMPER, "recovery candidate insert not readable.");
    return { row: inserted, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const existing = await getMissionRecoveryCandidateById(Number(row.userId), String(row.recoveryCandidateId), executor);
    if (existing && recoveryCandidateMaterialMatches(existing, row)) {
      return { row: existing, duplicateClassification: "idempotent_replay" };
    }
    throw new MissionStateIdentityConflictError(
      MISSION_STATE_REPLAY_CONFLICT,
      "recovery candidate identity replayed with conflicting material."
    );
  }
}

function recoveryCandidateMaterialMatches(
  existing: MissionRecoveryCandidateRow,
  inserted: InsertMissionRecoveryCandidateRow
): boolean {
  return (
    existing.recoveryCandidateId === inserted.recoveryCandidateId &&
    existing.userId === inserted.userId &&
    existing.businessId === inserted.businessId &&
    existing.missionId === inserted.missionId &&
    existing.taskId === inserted.taskId &&
    existing.latestAttemptId === inserted.latestAttemptId &&
    existing.recoveryType === inserted.recoveryType &&
    existing.proposalHash === inserted.proposalHash
  );
}

export async function getMissionRecoveryCandidateById(
  userId: number,
  recoveryCandidateId: string,
  executor?: MissionStateStoreExecutor
): Promise<MissionRecoveryCandidateRow | null> {
  const db = resolveMissionStateDb(executor);
  const [row] = await db
    .select()
    .from(missionRecoveryCandidates)
    .where(
      and(eq(missionRecoveryCandidates.userId, userId), eq(missionRecoveryCandidates.recoveryCandidateId, recoveryCandidateId))
    )
    .limit(1);
  return row ?? null;
}

export async function listMissionRecoveryCandidates(
  userId: number,
  missionId: string,
  filters: { taskId?: string; status?: string } = {},
  limit = 100,
  executor?: MissionStateStoreExecutor
): Promise<MissionRecoveryCandidateRow[]> {
  const db = resolveMissionStateDb(executor);
  const conditions = [eq(missionRecoveryCandidates.userId, userId), eq(missionRecoveryCandidates.missionId, missionId)];
  if (filters.taskId) conditions.push(eq(missionRecoveryCandidates.taskId, filters.taskId));
  if (filters.status) conditions.push(eq(missionRecoveryCandidates.status, filters.status));
  return db
    .select()
    .from(missionRecoveryCandidates)
    .where(and(...conditions))
    .orderBy(desc(missionRecoveryCandidates.createdAt), desc(missionRecoveryCandidates.id))
    .limit(limit);
}

/**
 * Optimistic-CAS recovery status transition. Illegal from-states and stale
 * versions fail closed — concurrent operators cannot double-transition.
 */
export async function transitionRecoveryStatus(input: {
  userId: number;
  recoveryCandidateId: string;
  expectedVersion: number;
  fromStatuses: readonly string[];
  toStatus: string;
  set?: Record<string, unknown>;
  executor?: MissionStateStoreExecutor;
}): Promise<MissionRecoveryCandidateRow> {
  const db = resolveMissionStateDb(input.executor);
  const current = await getMissionRecoveryCandidateById(input.userId, input.recoveryCandidateId, input.executor);
  if (!current) {
    throw new MissionStateIdentityConflictError(MISSION_STATE_REPLAY_CONFLICT, "recovery candidate not found.");
  }
  if (!input.fromStatuses.includes(current.status)) {
    throw new MissionStateTamperError(
      MISSION_STATE_TAMPER,
      `recovery status ${current.status} cannot transition to ${input.toStatus}.`
    );
  }
  if (current.version !== input.expectedVersion) {
    throw new MissionStateIdentityConflictError(
      MISSION_STATE_REPLAY_CONFLICT,
      `stale version ${input.expectedVersion}; current version is ${current.version}.`
    );
  }
  const set: Record<string, unknown> = {
    status: input.toStatus,
    version: current.version + 1,
    updatedAt: new Date(),
    ...(input.set ?? {}),
  };
  await db
    .update(missionRecoveryCandidates)
    .set(set as never)
    .where(
      and(
        eq(missionRecoveryCandidates.userId, input.userId),
        eq(missionRecoveryCandidates.recoveryCandidateId, input.recoveryCandidateId),
        eq(missionRecoveryCandidates.version, input.expectedVersion)
      )
    );
  const updated = await getMissionRecoveryCandidateById(input.userId, input.recoveryCandidateId, input.executor);
  if (!updated || updated.version !== current.version + 1) {
    throw new MissionStateIdentityConflictError(MISSION_STATE_REPLAY_CONFLICT, "recovery status transition lost a race.");
  }
  if (updated.status !== input.toStatus) {
    throw new MissionStateTamperError(MISSION_STATE_TAMPER, "recovery status transition observed drift.");
  }
  return updated;
}

// ─── Operational timeline (append-only) ───

export async function insertMissionTimelineEvent(
  row: InsertMissionOperationalTimelineEventRow,
  executor?: MissionStateStoreExecutor
): Promise<{ readonly duplicateClassification: MissionDuplicateClassification }> {
  const db = resolveMissionStateDb(executor);
  try {
    await db.insert(missionOperationalTimelineEvents).values(row);
    return { duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    return { duplicateClassification: "idempotent_replay" };
  }
}

export async function listMissionTimelineEvents(
  userId: number,
  missionId: string,
  limit = 200,
  executor?: MissionStateStoreExecutor
): Promise<MissionOperationalTimelineEventRow[]> {
  const db = resolveMissionStateDb(executor);
  return db
    .select()
    .from(missionOperationalTimelineEvents)
    .where(and(eq(missionOperationalTimelineEvents.userId, userId), eq(missionOperationalTimelineEvents.missionId, missionId)))
    .orderBy(desc(missionOperationalTimelineEvents.occurredAt), desc(missionOperationalTimelineEvents.id))
    .limit(limit);
}
