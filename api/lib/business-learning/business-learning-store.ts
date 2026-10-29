// ─── R7-C Business Learning Engine — durable store ───
//
// DB-authoritative persistence. Convergence anchors are durable unique keys
// (no in-memory dedupe): learningId, the natural key (userId, evidenceBundleId,
// learningType, subjectType, subjectId, upstreamStateFingerprint) and
// evidenceBundleId for records; learningLifecycleEventId for lifecycle facts.
// Status transitions are optimistic-CAS guarded (version); stale writes fail
// closed. Rows are immutable after acceptance — the recordHash proves
// byte-stability; drift is tampering (LEARNING_EVIDENCE_CONFLICT).
//
// Optional caller executor seam (house discipline): the default getDb()
// client and a transaction callback client both satisfy the shape.

import { and, eq, type SQL } from "drizzle-orm";
import {
  businessLearningRecords,
  businessLearningLifecycleEvents,
  type BusinessLearningRecordRow,
  type BusinessLearningLifecycleEventRow,
  type InsertBusinessLearningRecordRow,
  type InsertBusinessLearningLifecycleEventRow,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  LearningIdentityConflictError,
  LearningStateError,
  LearningTamperError,
  type LearningDuplicateClassification,
} from "./business-learning-contract";
import { deriveRecordHash } from "./business-learning-identity";
import type { LearningContextScope } from "./business-learning-context";

type Db = ReturnType<typeof getDb>;

export interface LearningStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
}

export function resolveLearningDb(executor?: LearningStoreExecutor): LearningStoreExecutor {
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

export interface LearningStoreWriteResult<T> {
  row: T;
  inserted: boolean;
  duplicateClassification: LearningDuplicateClassification;
}

// ─── JSON normalisation (rows may arrive pre-parsed or as JSON strings) ───

function jsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function normalizeRecord(row: BusinessLearningRecordRow): BusinessLearningRecordRow {
  return {
    ...row,
    contextScope: jsonColumn(row.contextScope, {}) as LearningContextScope,
    statement: jsonColumn(row.statement, {}),
    outcomeIds: jsonColumn(row.outcomeIds, [] as string[]),
    attributionIds: jsonColumn(row.attributionIds, [] as string[]),
    limitations: jsonColumn(row.limitations, [] as string[]),
    sourceVersions: jsonColumn(row.sourceVersions, {} as Record<string, string>),
  } as BusinessLearningRecordRow;
}

export function recordHashInputFromRow(row: BusinessLearningRecordRow) {
  return {
    learningId: row.learningId,
    evidenceBundleId: row.evidenceBundleId,
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    learningType: row.learningType,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    outcomeTypeFamily: row.outcomeTypeFamily,
    contextScope: row.contextScope as LearningContextScope,
    statement: row.statement,
    outcomeIds: row.outcomeIds as string[],
    attributionIds: row.attributionIds as string[],
    upstreamStateFingerprint: row.upstreamStateFingerprint,
    supportCount: Number(row.supportCount),
    contradictionCount: Number(row.contradictionCount),
    confidenceClass: row.confidenceClass,
    evidenceClass: row.evidenceClass,
    noveltyClass: row.noveltyClass,
    limitations: row.limitations as string[],
    sourceVersions: row.sourceVersions as Record<string, string>,
    narrativeDraft: row.narrativeDraft ?? null,
    validUntil: row.validUntil ?? null,
    supersedesLearningId: row.supersedesLearningId ?? null,
    derivedAt: row.derivedAt,
  };
}

/** Recompute the immutable-core hash; drift fails closed (tampering). */
export function assertLearningRecordIntegrity(row: BusinessLearningRecordRow): void {
  const expected = deriveRecordHash(recordHashInputFromRow(row));
  if (expected !== row.recordHash) {
    throw new LearningTamperError(
      "LEARNING_EVIDENCE_CONFLICT",
      `business_learning_records row ${row.id} (${row.learningId}) hash drift detected; refusing to use tampered evidence.`
    );
  }
}

// ─── Reads ───

export async function getLearningByLearningId(
  userId: number,
  learningId: string,
  executor?: LearningStoreExecutor
): Promise<BusinessLearningRecordRow | null> {
  const db = resolveLearningDb(executor);
  const [row] = await db
    .select()
    .from(businessLearningRecords)
    .where(and(eq(businessLearningRecords.userId, userId), eq(businessLearningRecords.learningId, learningId)))
    .limit(1);
  if (!row) return null;
  const normalized = normalizeRecord(row);
  assertLearningRecordIntegrity(normalized);
  return normalized;
}

export async function getLearningByNaturalKey(
  userId: number,
  evidenceBundleId: string,
  learningType: string,
  subjectType: string,
  subjectId: string,
  upstreamStateFingerprint: string,
  executor?: LearningStoreExecutor
): Promise<BusinessLearningRecordRow | null> {
  const db = resolveLearningDb(executor);
  const [row] = await db
    .select()
    .from(businessLearningRecords)
    .where(
      and(
        eq(businessLearningRecords.userId, userId),
        eq(businessLearningRecords.evidenceBundleId, evidenceBundleId),
        eq(businessLearningRecords.learningType, learningType),
        eq(businessLearningRecords.subjectType, subjectType),
        eq(businessLearningRecords.subjectId, subjectId),
        eq(businessLearningRecords.upstreamStateFingerprint, upstreamStateFingerprint)
      )
    )
    .limit(1);
  if (!row) return null;
  const normalized = normalizeRecord(row);
  assertLearningRecordIntegrity(normalized);
  return normalized;
}

/** All records for the subject — novelty comparison and current projection. */
export async function listLearningBySubject(
  userId: number,
  subjectType: string,
  subjectId: string,
  executor?: LearningStoreExecutor
): Promise<BusinessLearningRecordRow[]> {
  const db = resolveLearningDb(executor);
  const rows = await db
    .select()
    .from(businessLearningRecords)
    .where(
      and(
        eq(businessLearningRecords.userId, userId),
        eq(businessLearningRecords.subjectType, subjectType),
        eq(businessLearningRecords.subjectId, subjectId)
      )
    );
  return rows.map((row) => {
    const normalized = normalizeRecord(row);
    assertLearningRecordIntegrity(normalized);
    return normalized;
  });
}

/** All records for the tenant (bounded listing + dependent lookups). */
export async function listLearningForUser(
  userId: number,
  executor?: LearningStoreExecutor
): Promise<BusinessLearningRecordRow[]> {
  const db = resolveLearningDb(executor);
  const rows = await db.select().from(businessLearningRecords).where(eq(businessLearningRecords.userId, userId));
  return rows.map((row) => {
    const normalized = normalizeRecord(row);
    assertLearningRecordIntegrity(normalized);
    return normalized;
  });
}

/** Records whose evidence bundle cites the given outcome id. */
export async function findLearningByOutcomeId(
  userId: number,
  outcomeId: string,
  executor?: LearningStoreExecutor
): Promise<BusinessLearningRecordRow[]> {
  const all = await listLearningForUser(userId, executor);
  return all.filter((row) => (row.outcomeIds as string[]).includes(outcomeId));
}

/** Records whose evidence bundle cites the given attribution id. */
export async function findLearningByAttributionId(
  userId: number,
  attributionId: string,
  executor?: LearningStoreExecutor
): Promise<BusinessLearningRecordRow[]> {
  const all = await listLearningForUser(userId, executor);
  return all.filter((row) => (row.attributionIds as string[]).includes(attributionId));
}

export async function listLifecycleEventsForLearning(
  userId: number,
  learningId: string,
  executor?: LearningStoreExecutor
): Promise<BusinessLearningLifecycleEventRow[]> {
  const db = resolveLearningDb(executor);
  return db
    .select()
    .from(businessLearningLifecycleEvents)
    .where(
      and(
        eq(businessLearningLifecycleEvents.userId, userId),
        eq(businessLearningLifecycleEvents.learningId, learningId)
      )
    );
}

// ─── Writes (insert-first, exact-once) ───

function sameRecordMaterial(
  a: BusinessLearningRecordRow,
  b: BusinessLearningRecordRow
): boolean {
  return deriveRecordHash(recordHashInputFromRow(a)) === deriveRecordHash(recordHashInputFromRow(b));
}

export async function insertLearningRecord(
  row: InsertBusinessLearningRecordRow,
  executor?: LearningStoreExecutor
): Promise<LearningStoreWriteResult<BusinessLearningRecordRow>> {
  const db = resolveLearningDb(executor);
  try {
    await db.insert(businessLearningRecords).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Converge by the durable anchors: learningId first, then natural key.
    const byId = await getLearningByLearningId(Number(row.userId), String(row.learningId), executor);
    const stored =
      byId ??
      (await getLearningByNaturalKey(
        Number(row.userId),
        String(row.evidenceBundleId),
        String(row.learningType),
        String(row.subjectType),
        String(row.subjectId),
        String(row.upstreamStateFingerprint),
        executor
      ));
    if (!stored) throw err;
    assertLearningRecordIntegrity(stored);
    if (!sameRecordMaterial(stored as BusinessLearningRecordRow, row as BusinessLearningRecordRow)) {
      throw new LearningIdentityConflictError(
        "LEARNING_REPLAY_CONFLICT",
        `Learning identity ${String(row.learningId)} was already persisted with different material; failing closed.`
      );
    }
    return { row: stored, inserted: false, duplicateClassification: "idempotent_replay" };
  }
  const stored = await getLearningByLearningId(Number(row.userId), String(row.learningId), executor);
  if (!stored) {
    throw new LearningStateError(
      "LEARNING_STALE_STATE",
      "Learning row was inserted but could not be re-read."
    );
  }
  return { row: stored, inserted: true, duplicateClassification: "none" };
}

export async function insertLearningLifecycleEvent(
  row: InsertBusinessLearningLifecycleEventRow,
  executor?: LearningStoreExecutor
): Promise<LearningStoreWriteResult<BusinessLearningLifecycleEventRow>> {
  const db = resolveLearningDb(executor);
  try {
    await db.insert(businessLearningLifecycleEvents).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const db2 = resolveLearningDb(executor);
    const [stored] = await db2
      .select()
      .from(businessLearningLifecycleEvents)
      .where(
        and(
          eq(businessLearningLifecycleEvents.userId, Number(row.userId)),
          eq(businessLearningLifecycleEvents.learningLifecycleEventId, String(row.learningLifecycleEventId))
        )
      )
      .limit(1);
    if (!stored) throw err;
    return { row: stored, inserted: false, duplicateClassification: "idempotent_replay" };
  }
  const db2 = resolveLearningDb(executor);
  const [stored] = await db2
    .select()
    .from(businessLearningLifecycleEvents)
    .where(
      and(
        eq(businessLearningLifecycleEvents.userId, Number(row.userId)),
        eq(businessLearningLifecycleEvents.learningLifecycleEventId, String(row.learningLifecycleEventId))
      )
    )
    .limit(1);
  if (!stored) {
    throw new LearningStateError(
      "LEARNING_STALE_STATE",
      "Lifecycle fact was inserted but could not be re-read."
    );
  }
  return { row: stored, inserted: true, duplicateClassification: "none" };
}

// ─── CAS status transitions ───

export interface LearningStatusTransitionResult {
  row: BusinessLearningRecordRow;
  transitioned: boolean;
  duplicateClassification: LearningDuplicateClassification;
}

/**
 * Optimistic-CAS status transition. A concurrent or repeated transition
 * converges: if the stored row already carries the target status, the call
 * is an idempotent replay; persistent staleness fails closed
 * (LEARNING_STALE_STATE).
 */
export async function transitionLearningStatus(
  userId: number,
  learningId: string,
  expectedVersion: number,
  fromStatuses: readonly string[],
  toStatus: string,
  executor?: LearningStoreExecutor
): Promise<LearningStatusTransitionResult> {
  const db = resolveLearningDb(executor);
  const conditions: SQL[] = [
    eq(businessLearningRecords.userId, userId),
    eq(businessLearningRecords.learningId, learningId),
    eq(businessLearningRecords.version, expectedVersion),
  ];
  const result = await db
    .update(businessLearningRecords)
    .set({ status: toStatus, version: expectedVersion + 1 })
    .where(and(...conditions));
  if (affectedRowsOf(result) === 1) {
    const row = await getLearningByLearningId(userId, learningId, executor);
    if (!row) {
      throw new LearningStateError("LEARNING_STALE_STATE", "Transitioned row could not be re-read.");
    }
    return { row, transitioned: true, duplicateClassification: "none" };
  }

  // Converge or fail: re-read and inspect.
  const stored = await getLearningByLearningId(userId, learningId, executor);
  if (stored && stored.status === toStatus) {
    return { row: stored, transitioned: false, duplicateClassification: "idempotent_replay" };
  }
  throw new LearningStateError(
    "LEARNING_STALE_STATE",
    `Learning ${learningId} is at version ${stored?.version ?? "unknown"} with status ${stored?.status ?? "unknown"}; expected version ${expectedVersion} in [${fromStatuses.join(",")}].`
  );
}

function affectedRowsOf(result: unknown): number {
  const header = (Array.isArray(result) ? result[0] : result) as
    | { affectedRows?: number; rowsAffected?: number }
    | undefined;
  return Number(header?.affectedRows ?? header?.rowsAffected ?? 0);
}
