// ─── R8-B Business Change Intelligence — durable store ───
//
// DB-authoritative persistence. Convergence anchors are durable unique keys
// (no in-memory dedupe): changeId and (userId, businessId, subjectType,
// subjectId, changeType, previousStateFingerprint, currentStateFingerprint)
// for change events; changeLifecycleEventId for lifecycle facts. Status
// transitions are optimistic-CAS guarded (version); stale writes fail closed.
// Change rows are immutable after acceptance — the evidenceHash proves
// byte-stability; drift is tampering (CHANGE_EVIDENCE_CONFLICT).
//
// Optional caller executor seam (house convention): the default getDb()
// client and a transaction callback client both satisfy the shape.

import { and, desc, eq, type SQL } from "drizzle-orm";
import {
  businessChangeEvents,
  businessChangeLifecycleEvents,
  type BusinessChangeEventRow,
  type BusinessChangeLifecycleEventRow,
  type InsertBusinessChangeEventRow,
  type InsertBusinessChangeLifecycleEventRow,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  BusinessChangeIdentityConflictError,
  BusinessChangeStateConflictError,
  BusinessChangeTamperError,
  type BusinessChangeDuplicateClassification,
} from "./business-change-contract";
import {
  deriveChangeEvidenceHash,
  type BusinessChangeStateRef,
} from "./business-change-identity";

type Db = ReturnType<typeof getDb>;

export interface BusinessChangeStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
}

export function resolveBusinessChangeDb(executor?: BusinessChangeStoreExecutor): BusinessChangeStoreExecutor {
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

export interface BusinessChangeStoreWriteResult<T> {
  row: T;
  inserted: boolean;
  duplicateClassification: BusinessChangeDuplicateClassification;
}

// ─── Evidence integrity (immutable rows, hash-verified) ───

function evidenceHashInputFromRow(row: BusinessChangeEventRow) {
  return {
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    changeDomain: row.changeDomain,
    changeType: row.changeType,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    previousStateRef: row.previousStateRef as BusinessChangeStateRef,
    currentStateRef: row.currentStateRef as BusinessChangeStateRef,
    evidenceRefs: row.evidenceRefs as string[],
    sourceAuthority: row.sourceAuthority,
    sourceVersion: row.sourceVersion,
    significanceClass: row.significanceClass,
    confidenceClass: row.confidenceClass,
    detectedAt: row.detectedAt,
    effectiveAt: row.effectiveAt,
    supersedesChangeId: row.supersedesChangeId ?? null,
    limitations: row.limitations as string[],
  };
}

/** Recompute the immutable-core hash; drift fails closed (tampering). */
export function assertBusinessChangeEvidenceIntegrity(row: BusinessChangeEventRow): void {
  const expected = deriveChangeEvidenceHash(evidenceHashInputFromRow(row));
  if (expected !== row.evidenceHash) {
    throw new BusinessChangeTamperError(
      "CHANGE_EVIDENCE_CONFLICT",
      `business_change_events row ${row.id} (${row.changeId}) hash drift detected; refusing to use tampered change evidence.`
    );
  }
}

// ─── Change events ───

export async function getChangeByChangeId(
  userId: number,
  changeId: string,
  executor?: BusinessChangeStoreExecutor
): Promise<BusinessChangeEventRow | null> {
  const db = resolveBusinessChangeDb(executor);
  const [row] = await db
    .select()
    .from(businessChangeEvents)
    .where(and(eq(businessChangeEvents.userId, userId), eq(businessChangeEvents.changeId, changeId)))
    .limit(1);
  return row ?? null;
}

export async function getChangeByNaturalKey(
  userId: number,
  businessId: number,
  subjectType: string,
  subjectId: string,
  changeType: string,
  previousStateFingerprint: string,
  currentStateFingerprint: string,
  executor?: BusinessChangeStoreExecutor
): Promise<BusinessChangeEventRow | null> {
  const db = resolveBusinessChangeDb(executor);
  const [row] = await db
    .select()
    .from(businessChangeEvents)
    .where(
      and(
        eq(businessChangeEvents.userId, userId),
        eq(businessChangeEvents.businessId, businessId),
        eq(businessChangeEvents.subjectType, subjectType),
        eq(businessChangeEvents.subjectId, subjectId),
        eq(businessChangeEvents.changeType, changeType),
        eq(businessChangeEvents.previousStateFingerprint, previousStateFingerprint),
        eq(businessChangeEvents.currentStateFingerprint, currentStateFingerprint)
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * Insert-first persistence. Duplicate submissions and concurrent detections
 * of the same logical change converge: one insert wins, losers re-read through
 * the durable unique keys and verify the evidence fingerprint. A stored row
 * whose evidenceHash disagrees with the replayed material is an identity
 * conflict and fails closed (conflicting replay).
 */
export async function insertBusinessChangeEvent(
  row: InsertBusinessChangeEventRow,
  executor?: BusinessChangeStoreExecutor
): Promise<BusinessChangeStoreWriteResult<BusinessChangeEventRow>> {
  const db = resolveBusinessChangeDb(executor);
  try {
    await db.insert(businessChangeEvents).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing =
      (await getChangeByChangeId(Number(row.userId), row.changeId, executor)) ??
      (await getChangeByNaturalKey(
        Number(row.userId),
        row.businessId,
        row.subjectType,
        row.subjectId,
        row.changeType,
        row.previousStateFingerprint,
        row.currentStateFingerprint,
        executor
      ));
    if (existing) {
      if (existing.evidenceHash !== row.evidenceHash) {
        // The compared-state pair is the convergence anchor (B2). The same
        // before/after observed from a DIFFERENT source authority is
        // independent corroboration (contract §9.3), never a conflict; the
        // caller mints exactly one confirmation fact. The same source with
        // different bound material is conflicting replay and fails closed.
        if (existing.sourceAuthority !== row.sourceAuthority) {
          return { row: existing, inserted: false, duplicateClassification: "corroborating_replay" };
        }
        throw new BusinessChangeIdentityConflictError(
          "CHANGE_IDENTITY_CONFLICT",
          `CHANGE_IDENTITY_CONFLICT: change (userId=${row.userId}, subject=${row.subjectType}:${row.subjectId}, changeType=${row.changeType}) was replayed with conflicting material.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await getChangeByChangeId(Number(row.userId), row.changeId, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

/**
 * Optimistic-CAS guarded status transition. Stale writes (version drift) fail
 * closed with CHANGE_STALE_STATE. Returns the updated row.
 */
export async function transitionChangeStatus(
  userId: number,
  changeId: string,
  expectedVersion: number,
  newStatus: string,
  executor?: BusinessChangeStoreExecutor
): Promise<BusinessChangeEventRow> {
  const db = resolveBusinessChangeDb(executor);
  const result = await db
    .update(businessChangeEvents)
    .set({ status: newStatus, version: expectedVersion + 1 })
    .where(
      and(
        eq(businessChangeEvents.userId, userId),
        eq(businessChangeEvents.changeId, changeId),
        eq(businessChangeEvents.version, expectedVersion)
      )
    );
  const header = result as unknown as Record<string, unknown>;
  const affected = Number(header.affectedRows ?? header.rowsAffected ?? 0);
  if (affected === 0) {
    const current = await getChangeByChangeId(userId, changeId, executor);
    if (!current) {
      throw new BusinessChangeStateConflictError("CHANGE_STALE_STATE", `change ${changeId} not found for user ${userId}.`);
    }
    throw new BusinessChangeStateConflictError(
      "CHANGE_STALE_STATE",
      `change ${changeId} is at version ${current.version}; expected ${expectedVersion}. Stale write rejected.`
    );
  }
  const updated = await getChangeByChangeId(userId, changeId, executor);
  return updated!;
}

export interface ListChangesFilter {
  businessId?: number;
  changeDomain?: string;
  changeType?: string;
  status?: string;
  subjectType?: string;
  subjectId?: string;
  sourceAuthority?: string;
  limit?: number;
}

export async function listChanges(
  userId: number,
  filters: ListChangesFilter = {},
  executor?: BusinessChangeStoreExecutor
): Promise<BusinessChangeEventRow[]> {
  const db = resolveBusinessChangeDb(executor);
  const conditions: SQL[] = [eq(businessChangeEvents.userId, userId)];
  if (filters.businessId !== undefined) {
    conditions.push(eq(businessChangeEvents.businessId, filters.businessId));
  }
  if (filters.changeDomain !== undefined) {
    conditions.push(eq(businessChangeEvents.changeDomain, filters.changeDomain as never));
  }
  if (filters.changeType !== undefined) {
    conditions.push(eq(businessChangeEvents.changeType, filters.changeType as never));
  }
  if (filters.status !== undefined) {
    conditions.push(eq(businessChangeEvents.status, filters.status as never));
  }
  if (filters.subjectType !== undefined) {
    conditions.push(eq(businessChangeEvents.subjectType, filters.subjectType as never));
  }
  if (filters.subjectId !== undefined) {
    conditions.push(eq(businessChangeEvents.subjectId, filters.subjectId));
  }
  if (filters.sourceAuthority !== undefined) {
    conditions.push(eq(businessChangeEvents.sourceAuthority, filters.sourceAuthority));
  }
  const limit = Math.min(filters.limit ?? 100, 500);
  return db
    .select()
    .from(businessChangeEvents)
    .where(and(...conditions))
    .orderBy(desc(businessChangeEvents.id))
    .limit(limit);
}

// ─── Lifecycle facts (immutable, append-only) ───

export async function getChangeLifecycleEventById(
  changeLifecycleEventId: string,
  executor?: BusinessChangeStoreExecutor
): Promise<BusinessChangeLifecycleEventRow | null> {
  const db = resolveBusinessChangeDb(executor);
  const [row] = await db
    .select()
    .from(businessChangeLifecycleEvents)
    .where(eq(businessChangeLifecycleEvents.changeLifecycleEventId, changeLifecycleEventId))
    .limit(1);
  return row ?? null;
}

function lifecycleFieldsMatch(
  existing: BusinessChangeLifecycleEventRow,
  row: InsertBusinessChangeLifecycleEventRow
): boolean {
  return (
    existing.changeId === row.changeId &&
    Number(existing.userId) === Number(row.userId) &&
    existing.lifecycleType === row.lifecycleType &&
    existing.targetStatus === row.targetStatus &&
    (existing.successorChangeId ?? null) === (row.successorChangeId ?? null) &&
    (existing.sourceIdentity ?? null) === (row.sourceIdentity ?? null) &&
    existing.occurredAt === row.occurredAt &&
    (existing.reasonCode ?? null) === (row.reasonCode ?? null)
  );
}

/**
 * Insert-first lifecycle persistence. A replayed fact reproduces the same
 * changeLifecycleEventId and converges (idempotent_replay). A collision with
 * different material is conflicting reuse and fails closed
 * (CHANGE_LIFECYCLE_CONFLICT).
 */
export async function insertBusinessChangeLifecycleEvent(
  row: InsertBusinessChangeLifecycleEventRow,
  executor?: BusinessChangeStoreExecutor
): Promise<BusinessChangeStoreWriteResult<BusinessChangeLifecycleEventRow>> {
  const db = resolveBusinessChangeDb(executor);
  try {
    await db.insert(businessChangeLifecycleEvents).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getChangeLifecycleEventById(row.changeLifecycleEventId, executor);
    if (existing) {
      if (!lifecycleFieldsMatch(existing, row)) {
        throw new BusinessChangeIdentityConflictError(
          "CHANGE_LIFECYCLE_CONFLICT",
          `change lifecycle event ${row.changeLifecycleEventId} exists with different material content.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await getChangeLifecycleEventById(row.changeLifecycleEventId, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

export async function listChangeLifecycleEvents(
  userId: number,
  changeId: string,
  executor?: BusinessChangeStoreExecutor
): Promise<BusinessChangeLifecycleEventRow[]> {
  const db = resolveBusinessChangeDb(executor);
  return db
    .select()
    .from(businessChangeLifecycleEvents)
    .where(
      and(
        eq(businessChangeLifecycleEvents.userId, userId),
        eq(businessChangeLifecycleEvents.changeId, changeId)
      )
    )
    .orderBy(desc(businessChangeLifecycleEvents.id));
}
