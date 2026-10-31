// ─── R9-C Dependency & Scheduling Intelligence — durable store ───
//
// DB-authoritative persistence. Convergence anchors are durable unique keys
// (no in-memory dedupe): dependencyId + the (user, mission, plan, endpoints,
// type) natural key for edges; (user, mission, plan, planFingerprint) for plan
// snapshots; scheduleId for schedules; lifecycleEventId for msl1 facts.
// Schedule status transitions are optimistic-CAS guarded (version). Edge and
// schedule rows are immutable after acceptance — evidenceHash/schedule
// fingerprint drift is tampering and fails closed.
//
// Optional caller executor seam (house convention): the default getDb()
// client and a transaction callback client both satisfy the shape.

import { and, desc, eq, type SQL } from "drizzle-orm";
import {
  missionDependencyEdges,
  missionSchedules,
  missionScheduleLifecycleEvents,
  missionTaskPlanSnapshots,
  type MissionDependencyEdgeRow,
  type MissionScheduleLifecycleEventRow,
  type MissionScheduleRow,
  type MissionTaskPlanSnapshotRow,
  type InsertMissionDependencyEdgeRow,
  type InsertMissionScheduleLifecycleEventRow,
  type InsertMissionScheduleRow,
  type InsertMissionTaskPlanSnapshotRow,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  MissionSchedulingIdentityConflictError,
  MissionSchedulingStateConflictError,
  MissionSchedulingTamperError,
  type MissionSchedulingDuplicateClassification,
} from "./mission-scheduling-contract";
import {
  deriveDependencyEvidenceHash,
  deriveDependencyId,
  type DependencyIdentityInput,
} from "./mission-scheduling-identity";

type Db = ReturnType<typeof getDb>;

export interface MissionSchedulingStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
}

export function resolveMissionSchedulingDb(executor?: MissionSchedulingStoreExecutor): MissionSchedulingStoreExecutor {
  return executor ?? getDb();
}

function isDuplicateKeyError(err: unknown): boolean {
  const seen = new WeakSet<object>();
  let current: unknown = err;
  let depth = 0;
  while (current && typeof current === "object" && depth < 5) {
    if (seen.has(current)) break;
    seen.add(current);
    const e = current as Record<string, unknown>;
    if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true;
    current = e.cause;
    depth += 1;
  }
  return false;
}

export interface MissionSchedulingWriteResult<T> {
  row: T;
  inserted: boolean;
  duplicateClassification: MissionSchedulingDuplicateClassification;
}

// ─── Plan snapshots ───

export async function getPlanSnapshotByFingerprint(
  userId: number,
  planFingerprint: string,
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionTaskPlanSnapshotRow | null> {
  const db = resolveMissionSchedulingDb(executor);
  const [row] = await db
    .select()
    .from(missionTaskPlanSnapshots)
    .where(and(eq(missionTaskPlanSnapshots.userId, userId), eq(missionTaskPlanSnapshots.planFingerprint, planFingerprint)))
    .limit(1);
  return row ?? null;
}

/** Latest snapshot version for the (user, mission, plan) coordinate. */
export async function getCurrentPlanSnapshot(
  userId: number,
  missionId: string,
  planId: string,
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionTaskPlanSnapshotRow | null> {
  const db = resolveMissionSchedulingDb(executor);
  const [row] = await db
    .select()
    .from(missionTaskPlanSnapshots)
    .where(
      and(
        eq(missionTaskPlanSnapshots.userId, userId),
        eq(missionTaskPlanSnapshots.missionId, missionId),
        eq(missionTaskPlanSnapshots.planId, planId)
      )
    )
    .orderBy(desc(missionTaskPlanSnapshots.id))
    .limit(1);
  return row ?? null;
}

export async function listPlanSnapshots(
  userId: number,
  missionId: string,
  planId: string,
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionTaskPlanSnapshotRow[]> {
  const db = resolveMissionSchedulingDb(executor);
  return db
    .select()
    .from(missionTaskPlanSnapshots)
    .where(
      and(
        eq(missionTaskPlanSnapshots.userId, userId),
        eq(missionTaskPlanSnapshots.missionId, missionId),
        eq(missionTaskPlanSnapshots.planId, planId)
      )
    )
    .orderBy(desc(missionTaskPlanSnapshots.id));
}

/** Tenant-scoped scan locating which plan snapshot declares a task id. */
export async function findTaskScopeInTenant(
  userId: number,
  taskId: string,
  executor?: MissionSchedulingStoreExecutor
): Promise<{ missionId: string; planId: string; businessId: number; planFingerprint: string } | null> {
  const db = resolveMissionSchedulingDb(executor);
  const rows = await db
    .select()
    .from(missionTaskPlanSnapshots)
    .where(eq(missionTaskPlanSnapshots.userId, userId))
    .orderBy(desc(missionTaskPlanSnapshots.id))
    .limit(500);
  for (const row of rows) {
    const taskIds = Array.isArray(row.taskIds) ? (row.taskIds as unknown[]) : [];
    if (taskIds.includes(taskId)) {
      return {
        missionId: row.missionId,
        planId: row.planId,
        businessId: Number(row.businessId),
        planFingerprint: row.planFingerprint,
      };
    }
  }
  return null;
}

/**
 * Insert-first plan snapshot persistence. Same (coordinate, fingerprint)
 * replayed with identical material converges; the same coordinate with
 * different material is a legitimate B-side plan revision (new fingerprint
 * version) — conflicting material under the SAME fingerprint fails closed.
 */
export async function insertPlanSnapshot(
  row: InsertMissionTaskPlanSnapshotRow,
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionSchedulingWriteResult<MissionTaskPlanSnapshotRow>> {
  const db = resolveMissionSchedulingDb(executor);
  try {
    await db.insert(missionTaskPlanSnapshots).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getPlanSnapshotByFingerprint(Number(row.userId), row.planFingerprint, executor);
    if (existing) {
      if (existing.planHash !== row.planHash) {
        throw new MissionSchedulingIdentityConflictError(
          "SCHEDULING_REPLAY_CONFLICT",
          `plan snapshot fingerprint ${row.planFingerprint} was replayed with conflicting material.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await getPlanSnapshotByFingerprint(Number(row.userId), row.planFingerprint, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

// ─── Dependency edges ───

export async function getDependencyByDependencyId(
  userId: number,
  dependencyId: string,
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionDependencyEdgeRow | null> {
  const db = resolveMissionSchedulingDb(executor);
  const [row] = await db
    .select()
    .from(missionDependencyEdges)
    .where(and(eq(missionDependencyEdges.userId, userId), eq(missionDependencyEdges.dependencyId, dependencyId)))
    .limit(1);
  return row ?? null;
}

export async function getDependencyByNaturalKey(
  userId: number,
  missionId: string,
  planId: string,
  predecessorTaskId: string,
  successorTaskId: string,
  dependencyType: string,
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionDependencyEdgeRow | null> {
  const db = resolveMissionSchedulingDb(executor);
  const [row] = await db
    .select()
    .from(missionDependencyEdges)
    .where(
      and(
        eq(missionDependencyEdges.userId, userId),
        eq(missionDependencyEdges.missionId, missionId),
        eq(missionDependencyEdges.planId, planId),
        eq(missionDependencyEdges.predecessorTaskId, predecessorTaskId),
        eq(missionDependencyEdges.successorTaskId, successorTaskId),
        eq(missionDependencyEdges.dependencyType, dependencyType)
      )
    )
    .limit(1);
  return row ?? null;
}

export interface ListEdgesFilter {
  missionId: string;
  planId: string;
  dependencyType?: string;
  hardOrSoft?: string;
  limit?: number;
}

export async function listDependencies(
  userId: number,
  filters: ListEdgesFilter,
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionDependencyEdgeRow[]> {
  const db = resolveMissionSchedulingDb(executor);
  const conditions: SQL[] = [
    eq(missionDependencyEdges.userId, userId),
    eq(missionDependencyEdges.missionId, filters.missionId),
    eq(missionDependencyEdges.planId, filters.planId),
  ];
  if (filters.dependencyType !== undefined) {
    conditions.push(eq(missionDependencyEdges.dependencyType, filters.dependencyType as never));
  }
  if (filters.hardOrSoft !== undefined) {
    conditions.push(eq(missionDependencyEdges.hardOrSoft, filters.hardOrSoft as never));
  }
  const limit = Math.min(filters.limit ?? 500, MAX_EDGES_LIST);
  return db
    .select()
    .from(missionDependencyEdges)
    .where(and(...conditions))
    .orderBy(desc(missionDependencyEdges.id))
    .limit(limit);
}

const MAX_EDGES_LIST = 1000;

function edgeIdentityInputFromRow(row: MissionDependencyEdgeRow): DependencyIdentityInput {
  return {
    tenantUserId: Number(row.userId),
    businessId: Number(row.businessId),
    missionId: row.missionId,
    planId: row.planId,
    predecessorTaskId: row.predecessorTaskId,
    successorTaskId: row.successorTaskId,
    dependencyType: row.dependencyType as DependencyIdentityInput["dependencyType"],
    hardOrSoft: row.hardOrSoft as DependencyIdentityInput["hardOrSoft"],
    source: row.source as DependencyIdentityInput["source"],
    reason: row.reason,
  };
}

/** Recompute the immutable-core hash; drift fails closed (tampering). */
export function assertDependencyEvidenceIntegrity(row: MissionDependencyEdgeRow): void {
  const expected = deriveDependencyEvidenceHash(edgeIdentityInputFromRow(row));
  if (expected !== row.evidenceHash) {
    throw new MissionSchedulingTamperError(
      "SCHEDULING_TAMPER",
      `mission_dependency_edges row ${row.id} (${row.dependencyId}) hash drift detected; refusing to use tampered dependency evidence.`
    );
  }
}

/** Identity re-derivation check: stored dependencyId must match its material. */
export function assertDependencyIdentityIntegrity(row: MissionDependencyEdgeRow): void {
  const expected = deriveDependencyId(edgeIdentityInputFromRow(row));
  if (expected !== row.dependencyId) {
    throw new MissionSchedulingTamperError(
      "SCHEDULING_TAMPER",
      `mission_dependency_edges row ${row.id} has dependencyId inconsistent with its material.`
    );
  }
}

/**
 * Insert-first edge persistence. Duplicate submissions converge by durable
 * unique keys; conflicting material under the same identity fails closed.
 */
export async function insertDependencyEdge(
  row: InsertMissionDependencyEdgeRow,
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionSchedulingWriteResult<MissionDependencyEdgeRow>> {
  const db = resolveMissionSchedulingDb(executor);
  try {
    await db.insert(missionDependencyEdges).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing =
      (await getDependencyByDependencyId(Number(row.userId), row.dependencyId, executor)) ??
      (await getDependencyByNaturalKey(
        Number(row.userId),
        row.missionId,
        row.planId,
        row.predecessorTaskId,
        row.successorTaskId,
        row.dependencyType,
        executor
      ));
    if (existing) {
      if (existing.evidenceHash !== row.evidenceHash) {
        throw new MissionSchedulingIdentityConflictError(
          "SCHEDULING_REPLAY_CONFLICT",
          `dependency (userId=${row.userId}, mission=${row.missionId}, plan=${row.planId}, ${row.predecessorTaskId}→${row.successorTaskId}:${row.dependencyType}) was replayed with conflicting material.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await getDependencyByDependencyId(Number(row.userId), row.dependencyId, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

// ─── Schedules ───

export async function getScheduleByScheduleId(
  userId: number,
  scheduleId: string,
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionScheduleRow | null> {
  const db = resolveMissionSchedulingDb(executor);
  const [row] = await db
    .select()
    .from(missionSchedules)
    .where(and(eq(missionSchedules.userId, userId), eq(missionSchedules.scheduleId, scheduleId)))
    .limit(1);
  return row ?? null;
}

export interface ListSchedulesFilter {
  missionId?: string;
  planId?: string;
  status?: string;
  limit?: number;
}

export async function listSchedules(
  userId: number,
  filters: ListSchedulesFilter = {},
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionScheduleRow[]> {
  const db = resolveMissionSchedulingDb(executor);
  const conditions: SQL[] = [eq(missionSchedules.userId, userId)];
  if (filters.missionId !== undefined) conditions.push(eq(missionSchedules.missionId, filters.missionId));
  if (filters.planId !== undefined) conditions.push(eq(missionSchedules.planId, filters.planId));
  if (filters.status !== undefined) conditions.push(eq(missionSchedules.status, filters.status as never));
  const limit = Math.min(filters.limit ?? 100, 500);
  return db
    .select()
    .from(missionSchedules)
    .where(and(...conditions))
    .orderBy(desc(missionSchedules.id))
    .limit(limit);
}

export async function insertSchedule(
  row: InsertMissionScheduleRow,
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionSchedulingWriteResult<MissionScheduleRow>> {
  const db = resolveMissionSchedulingDb(executor);
  try {
    await db.insert(missionSchedules).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getScheduleByScheduleId(Number(row.userId), row.scheduleId, executor);
    if (existing) {
      if (existing.scheduleFingerprint !== row.scheduleFingerprint) {
        throw new MissionSchedulingIdentityConflictError(
          "SCHEDULING_REPLAY_CONFLICT",
          `schedule ${row.scheduleId} exists with a conflicting fingerprint.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await getScheduleByScheduleId(Number(row.userId), row.scheduleId, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

/** Optimistic-CAS guarded status transition; stale writes fail closed. */
export async function transitionScheduleStatus(
  userId: number,
  scheduleId: string,
  expectedVersion: number,
  newStatus: string,
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionScheduleRow> {
  const db = resolveMissionSchedulingDb(executor);
  const result = await db
    .update(missionSchedules)
    .set({ status: newStatus, version: expectedVersion + 1, updatedAt: new Date() })
    .where(
      and(
        eq(missionSchedules.userId, userId),
        eq(missionSchedules.scheduleId, scheduleId),
        eq(missionSchedules.version, expectedVersion)
      )
    );
  const header = result as unknown as Record<string, unknown>;
  const affected = Number(header.affectedRows ?? header.rowsAffected ?? 0);
  if (affected === 0) {
    const current = await getScheduleByScheduleId(userId, scheduleId, executor);
    if (!current) {
      throw new MissionSchedulingStateConflictError("SCHEDULING_STALE_STATE", `schedule ${scheduleId} not found for user ${userId}.`);
    }
    throw new MissionSchedulingStateConflictError(
      "SCHEDULING_STALE_STATE",
      `schedule ${scheduleId} is at version ${current.version}; expected ${expectedVersion}. Stale write rejected.`
    );
  }
  const updated = await getScheduleByScheduleId(userId, scheduleId, executor);
  return updated!;
}

// ─── Schedule lifecycle facts (immutable, append-only) ───

export async function getScheduleLifecycleEventById(
  lifecycleEventId: string,
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionScheduleLifecycleEventRow | null> {
  const db = resolveMissionSchedulingDb(executor);
  const [row] = await db
    .select()
    .from(missionScheduleLifecycleEvents)
    .where(eq(missionScheduleLifecycleEvents.lifecycleEventId, lifecycleEventId))
    .limit(1);
  return row ?? null;
}

function lifecycleFieldsMatch(
  existing: MissionScheduleLifecycleEventRow,
  row: InsertMissionScheduleLifecycleEventRow
): boolean {
  return (
    existing.scheduleId === row.scheduleId &&
    Number(existing.userId) === Number(row.userId) &&
    existing.lifecycleType === row.lifecycleType &&
    existing.targetStatus === row.targetStatus &&
    (existing.successorScheduleId ?? null) === (row.successorScheduleId ?? null) &&
    (existing.sourceIdentity ?? null) === (row.sourceIdentity ?? null) &&
    existing.occurredAt === row.occurredAt &&
    (existing.reasonCode ?? null) === (row.reasonCode ?? null)
  );
}

export async function insertScheduleLifecycleEvent(
  row: InsertMissionScheduleLifecycleEventRow,
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionSchedulingWriteResult<MissionScheduleLifecycleEventRow>> {
  const db = resolveMissionSchedulingDb(executor);
  try {
    await db.insert(missionScheduleLifecycleEvents).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getScheduleLifecycleEventById(row.lifecycleEventId, executor);
    if (existing) {
      if (!lifecycleFieldsMatch(existing, row)) {
        throw new MissionSchedulingIdentityConflictError(
          "SCHEDULING_LIFECYCLE_CONFLICT",
          `schedule lifecycle event ${row.lifecycleEventId} exists with different material content.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await getScheduleLifecycleEventById(row.lifecycleEventId, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

export async function listScheduleLifecycleEvents(
  userId: number,
  scheduleId: string,
  executor?: MissionSchedulingStoreExecutor
): Promise<MissionScheduleLifecycleEventRow[]> {
  const db = resolveMissionSchedulingDb(executor);
  return db
    .select()
    .from(missionScheduleLifecycleEvents)
    .where(
      and(
        eq(missionScheduleLifecycleEvents.userId, userId),
        eq(missionScheduleLifecycleEvents.scheduleId, scheduleId)
      )
    )
    .orderBy(desc(missionScheduleLifecycleEvents.id));
}
