// ─── R8-A Strategic Memory — durable store ───
//
// DB-authoritative persistence. Convergence anchors are durable unique keys
// (no in-memory dedupe): memoryId and (userId, businessId, sourceAuthority,
// sourceIdentity, memoryType) for records; memoryLifecycleEventId for
// lifecycle facts. Status transitions are optimistic-CAS guarded (version);
// stale writes fail closed. Record rows are immutable after acceptance — the
// evidenceHash proves byte-stability; drift is tampering
// (STRATEGIC_MEMORY_EVIDENCE_CONFLICT).
//
// Optional caller executor seam (house convention): the default getDb()
// client and a transaction callback client both satisfy the shape.

import { and, desc, eq, type SQL } from "drizzle-orm";
import {
  strategicMemoryRecords,
  strategicMemoryLifecycleEvents,
  type StrategicMemoryRecordRow,
  type StrategicMemoryLifecycleEventRow,
  type InsertStrategicMemoryRecordRow,
  type InsertStrategicMemoryLifecycleEventRow,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  StrategicMemoryIdentityConflictError,
  StrategicMemoryStateConflictError,
  StrategicMemoryTamperError,
  type StrategicMemoryDuplicateClassification,
} from "./strategic-memory-contract";
import { deriveMemoryEvidenceHash, type StrategicMemoryContextScope } from "./strategic-memory-identity";

type Db = ReturnType<typeof getDb>;

export interface StrategicMemoryStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
}

export function resolveStrategicMemoryDb(executor?: StrategicMemoryStoreExecutor): StrategicMemoryStoreExecutor {
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

export interface StrategicMemoryStoreWriteResult<T> {
  row: T;
  inserted: boolean;
  duplicateClassification: StrategicMemoryDuplicateClassification;
}

// ─── Evidence integrity (immutable rows, hash-verified) ───

function evidenceHashInputFromRow(row: StrategicMemoryRecordRow) {
  return {
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    memoryType: row.memoryType,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    statementType: row.statementType,
    statement: row.statement,
    evidenceRefs: row.evidenceRefs as string[],
    sourceAuthority: row.sourceAuthority,
    sourceVersion: row.sourceVersion,
    sourceIdentity: row.sourceIdentity,
    confidenceClass: row.confidenceClass,
    basis: row.basis,
    limitations: row.limitations as string[],
    validFrom: row.validFrom,
    validUntil: row.validUntil ?? null,
    observedAt: row.observedAt,
    supersedesMemoryId: row.supersedesMemoryId ?? null,
    contradictsMemoryIds: row.contradictsMemoryIds as string[],
    contextScope: row.contextScope as StrategicMemoryContextScope,
  };
}

/** Recompute the immutable-core hash; drift fails closed (tampering). */
export function assertStrategicMemoryEvidenceIntegrity(row: StrategicMemoryRecordRow): void {
  const expected = deriveMemoryEvidenceHash(evidenceHashInputFromRow(row));
  if (expected !== row.evidenceHash) {
    throw new StrategicMemoryTamperError(
      "STRATEGIC_MEMORY_EVIDENCE_CONFLICT",
      `strategic_memory_records row ${row.id} (${row.memoryId}) hash drift detected; refusing to use tampered memory.`
    );
  }
}

// ─── Memory records ───

export async function getMemoryByMemoryId(
  userId: number,
  memoryId: string,
  executor?: StrategicMemoryStoreExecutor
): Promise<StrategicMemoryRecordRow | null> {
  const db = resolveStrategicMemoryDb(executor);
  const [row] = await db
    .select()
    .from(strategicMemoryRecords)
    .where(and(eq(strategicMemoryRecords.userId, userId), eq(strategicMemoryRecords.memoryId, memoryId)))
    .limit(1);
  return row ?? null;
}

export async function getMemoryByNaturalKey(
  userId: number,
  businessId: number,
  sourceAuthority: string,
  sourceIdentity: string,
  memoryType: string,
  executor?: StrategicMemoryStoreExecutor
): Promise<StrategicMemoryRecordRow | null> {
  const db = resolveStrategicMemoryDb(executor);
  const [row] = await db
    .select()
    .from(strategicMemoryRecords)
    .where(
      and(
        eq(strategicMemoryRecords.userId, userId),
        eq(strategicMemoryRecords.businessId, businessId),
        eq(strategicMemoryRecords.sourceAuthority, sourceAuthority),
        eq(strategicMemoryRecords.sourceIdentity, sourceIdentity),
        eq(strategicMemoryRecords.memoryType, memoryType)
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * Insert-first persistence. Duplicate submissions and concurrent records of
 * the same logical memory converge: one insert wins, losers re-read through
 * the durable unique keys and verify the evidence fingerprint. A stored row
 * whose evidenceHash disagrees with the replayed material is an identity
 * conflict and fails closed (conflicting replay).
 */
export async function insertStrategicMemoryRecord(
  row: InsertStrategicMemoryRecordRow,
  executor?: StrategicMemoryStoreExecutor
): Promise<StrategicMemoryStoreWriteResult<StrategicMemoryRecordRow>> {
  const db = resolveStrategicMemoryDb(executor);
  try {
    await db.insert(strategicMemoryRecords).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing =
      (await getMemoryByMemoryId(Number(row.userId), row.memoryId, executor)) ??
      (await getMemoryByNaturalKey(
        Number(row.userId),
        row.businessId,
        row.sourceAuthority,
        row.sourceIdentity,
        row.memoryType,
        executor
      ));
    if (existing) {
      if (existing.evidenceHash !== row.evidenceHash) {
        throw new StrategicMemoryIdentityConflictError(
          "STRATEGIC_MEMORY_IDENTITY_CONFLICT",
          `STRATEGIC_MEMORY_IDENTITY_CONFLICT: memory (userId=${row.userId}, sourceAuthority=${row.sourceAuthority}, sourceIdentity=${row.sourceIdentity}, memoryType=${row.memoryType}) was replayed with conflicting material.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await getMemoryByMemoryId(Number(row.userId), row.memoryId, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

/**
 * Optimistic-CAS guarded fact-status transition. Stale writes (version
 * drift) fail closed with STRATEGIC_MEMORY_STALE_STATE. Returns the updated
 * row.
 */
export async function transitionMemoryStatus(
  userId: number,
  memoryId: string,
  expectedVersion: number,
  newStatus: string,
  executor?: StrategicMemoryStoreExecutor
): Promise<StrategicMemoryRecordRow> {
  const db = resolveStrategicMemoryDb(executor);
  const result = await db
    .update(strategicMemoryRecords)
    .set({ factStatus: newStatus, version: expectedVersion + 1 })
    .where(
      and(
        eq(strategicMemoryRecords.userId, userId),
        eq(strategicMemoryRecords.memoryId, memoryId),
        eq(strategicMemoryRecords.version, expectedVersion)
      )
    );
  const header = result as unknown as Record<string, unknown>;
  const affected = Number(header.affectedRows ?? header.rowsAffected ?? 0);
  if (affected === 0) {
    const current = await getMemoryByMemoryId(userId, memoryId, executor);
    if (!current) {
      throw new StrategicMemoryStateConflictError(
        "STRATEGIC_MEMORY_STALE_STATE",
        `memory ${memoryId} not found for user ${userId}.`
      );
    }
    throw new StrategicMemoryStateConflictError(
      "STRATEGIC_MEMORY_STALE_STATE",
      `memory ${memoryId} is at version ${current.version}; expected ${expectedVersion}. Stale write rejected.`
    );
  }
  const updated = await getMemoryByMemoryId(userId, memoryId, executor);
  return updated!;
}

export interface ListMemoryFilter {
  businessId?: number;
  memoryType?: string;
  factStatus?: string;
  subjectType?: string;
  subjectId?: string;
  sourceAuthority?: string;
  limit?: number;
}

export async function listMemories(
  userId: number,
  filters: ListMemoryFilter = {},
  executor?: StrategicMemoryStoreExecutor
): Promise<StrategicMemoryRecordRow[]> {
  const db = resolveStrategicMemoryDb(executor);
  const conditions: SQL[] = [eq(strategicMemoryRecords.userId, userId)];
  if (filters.businessId !== undefined) {
    conditions.push(eq(strategicMemoryRecords.businessId, filters.businessId));
  }
  if (filters.memoryType !== undefined) {
    conditions.push(eq(strategicMemoryRecords.memoryType, filters.memoryType as never));
  }
  if (filters.factStatus !== undefined) {
    conditions.push(eq(strategicMemoryRecords.factStatus, filters.factStatus as never));
  }
  if (filters.subjectType !== undefined) {
    conditions.push(eq(strategicMemoryRecords.subjectType, filters.subjectType as never));
  }
  if (filters.subjectId !== undefined) {
    conditions.push(eq(strategicMemoryRecords.subjectId, filters.subjectId));
  }
  if (filters.sourceAuthority !== undefined) {
    conditions.push(eq(strategicMemoryRecords.sourceAuthority, filters.sourceAuthority));
  }
  const limit = Math.min(filters.limit ?? 100, 500);
  return db
    .select()
    .from(strategicMemoryRecords)
    .where(and(...conditions))
    .orderBy(desc(strategicMemoryRecords.id))
    .limit(limit);
}

// ─── Lifecycle facts (immutable, append-only) ───

export async function getMemoryLifecycleEventById(
  memoryLifecycleEventId: string,
  executor?: StrategicMemoryStoreExecutor
): Promise<StrategicMemoryLifecycleEventRow | null> {
  const db = resolveStrategicMemoryDb(executor);
  const [row] = await db
    .select()
    .from(strategicMemoryLifecycleEvents)
    .where(eq(strategicMemoryLifecycleEvents.memoryLifecycleEventId, memoryLifecycleEventId))
    .limit(1);
  return row ?? null;
}

function lifecycleFieldsMatch(
  existing: StrategicMemoryLifecycleEventRow,
  row: InsertStrategicMemoryLifecycleEventRow
): boolean {
  return (
    existing.memoryId === row.memoryId &&
    Number(existing.userId) === Number(row.userId) &&
    existing.lifecycleType === row.lifecycleType &&
    existing.targetStatus === row.targetStatus &&
    (existing.successorMemoryId ?? null) === (row.successorMemoryId ?? null) &&
    (existing.sourceIdentity ?? null) === (row.sourceIdentity ?? null) &&
    existing.occurredAt === row.occurredAt &&
    (existing.reasonCode ?? null) === (row.reasonCode ?? null)
  );
}

/**
 * Insert-first lifecycle persistence. A replayed fact reproduces the same
 * memoryLifecycleEventId and converges (idempotent_replay). A collision with
 * different material is conflicting reuse and fails closed
 * (STRATEGIC_MEMORY_LIFECYCLE_CONFLICT).
 */
export async function insertStrategicMemoryLifecycleEvent(
  row: InsertStrategicMemoryLifecycleEventRow,
  executor?: StrategicMemoryStoreExecutor
): Promise<StrategicMemoryStoreWriteResult<StrategicMemoryLifecycleEventRow>> {
  const db = resolveStrategicMemoryDb(executor);
  try {
    await db.insert(strategicMemoryLifecycleEvents).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getMemoryLifecycleEventById(row.memoryLifecycleEventId, executor);
    if (existing) {
      if (!lifecycleFieldsMatch(existing, row)) {
        throw new StrategicMemoryIdentityConflictError(
          "STRATEGIC_MEMORY_LIFECYCLE_CONFLICT",
          `memory lifecycle event ${row.memoryLifecycleEventId} exists with different material content.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await getMemoryLifecycleEventById(row.memoryLifecycleEventId, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

export async function listMemoryLifecycleEvents(
  userId: number,
  memoryId: string,
  executor?: StrategicMemoryStoreExecutor
): Promise<StrategicMemoryLifecycleEventRow[]> {
  const db = resolveStrategicMemoryDb(executor);
  return db
    .select()
    .from(strategicMemoryLifecycleEvents)
    .where(
      and(
        eq(strategicMemoryLifecycleEvents.userId, userId),
        eq(strategicMemoryLifecycleEvents.memoryId, memoryId)
      )
    )
    .orderBy(desc(strategicMemoryLifecycleEvents.id));
}
