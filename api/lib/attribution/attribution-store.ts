// ─── R7-B Attribution Intelligence — durable store ───
//
// DB-authoritative persistence for attribution results and supersession
// facts. Convergence anchors are durable unique keys (no in-memory dedupe):
// attributionId + (userId, outcomeId, modelType, modelVersion, windowStart,
// windowEnd, journeyHash) for results; attributionLifecycleEventId for facts.
// Rows are immutable — no update path. The recordHash proves byte-stability;
// drift on any read is tampering (ATTRIBUTION_EVIDENCE_CONFLICT).

import { and, desc, eq, type SQL } from "drizzle-orm";
import {
  attributionLifecycleEvents,
  attributionResults,
  type AttributionLifecycleEventRow,
  type AttributionResultRow,
  type InsertAttributionLifecycleEventRow,
  type InsertAttributionResultRow,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  AttributionIdentityConflictError,
  AttributionTamperError,
  type AttributionDuplicateClassification,
} from "./attribution-contract";
import { deriveRecordHash } from "./attribution-identity";

type Db = ReturnType<typeof getDb>;

export interface AttributionStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
}

export function resolveAttributionDb(executor?: AttributionStoreExecutor): AttributionStoreExecutor {
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

export interface AttributionStoreWriteResult<T> {
  row: T;
  inserted: boolean;
  duplicateClassification: AttributionDuplicateClassification;
}

// ─── Record integrity (immutable rows, hash-verified) ───

function toHashableRow(row: AttributionResultRow) {
  return {
    attributionId: row.attributionId,
    attributionKey: row.attributionKey,
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    outcomeId: row.outcomeId,
    leadId: row.leadId === null || row.leadId === undefined ? null : Number(row.leadId),
    leadIdentityVersion: row.leadIdentityVersion ?? null,
    conversionId: row.conversionId,
    outcomeType: row.outcomeType,
    outcomeStatus: row.outcomeStatus,
    outcomeAmountMinor:
      row.outcomeAmountMinor === null || row.outcomeAmountMinor === undefined
        ? null
        : Number(row.outcomeAmountMinor),
    outcomeCurrency: row.outcomeCurrency ?? null,
    modelType: row.modelType,
    modelVersion: row.modelVersion,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    journeyHash: row.journeyHash,
    touchpoints: row.touchpoints,
    excludedTouchpoints: row.excludedTouchpoints,
    totalCreditBps: Number(row.totalCreditBps),
    confidenceClass: row.confidenceClass,
    evidenceClass: row.evidenceClass,
    policyVersion: row.policyVersion,
    sourceVersions: row.sourceVersions,
    supersedesAttributionId: row.supersedesAttributionId ?? null,
    calculatedAt: row.calculatedAt,
  };
}

/** Recompute the immutable-core hash; drift fails closed (tampering). */
export function assertAttributionRecordIntegrity(row: AttributionResultRow): void {
  const expected = deriveRecordHash(toHashableRow(row));
  if (expected !== row.recordHash) {
    throw new AttributionTamperError(
      "ATTRIBUTION_EVIDENCE_CONFLICT",
      `attribution_results row ${row.id} (${row.attributionId}) hash drift detected; refusing to use tampered evidence.`
    );
  }
}

// ─── Results ───

export async function getAttributionById(
  userId: number,
  attributionId: string,
  executor?: AttributionStoreExecutor
): Promise<AttributionResultRow | null> {
  const db = resolveAttributionDb(executor);
  const [row] = await db
    .select()
    .from(attributionResults)
    .where(and(eq(attributionResults.userId, userId), eq(attributionResults.attributionId, attributionId)))
    .limit(1);
  if (row) assertAttributionRecordIntegrity(row);
  return row ?? null;
}

export interface AttributionNaturalKey {
  userId: number;
  outcomeId: string;
  modelType: string;
  modelVersion: string;
  windowStart: string;
  windowEnd: string;
  journeyHash: string;
}

export async function getAttributionByNaturalKey(
  key: AttributionNaturalKey,
  executor?: AttributionStoreExecutor
): Promise<AttributionResultRow | null> {
  const db = resolveAttributionDb(executor);
  const [row] = await db
    .select()
    .from(attributionResults)
    .where(
      and(
        eq(attributionResults.userId, key.userId),
        eq(attributionResults.outcomeId, key.outcomeId),
        eq(attributionResults.modelType, key.modelType),
        eq(attributionResults.modelVersion, key.modelVersion),
        eq(attributionResults.windowStart, key.windowStart),
        eq(attributionResults.windowEnd, key.windowEnd),
        eq(attributionResults.journeyHash, key.journeyHash)
      )
    )
    .limit(1);
  if (row) assertAttributionRecordIntegrity(row);
  return row ?? null;
}

/**
 * Insert-first persistence. Identical replays and concurrent duplicates
 converge: one insert wins, losers re-read through the durable unique keys
 * and verify the record fingerprint. A stored row whose recordHash disagrees
 * with the replayed material is a conflict and fails closed.
 */
export async function insertAttributionResult(
  row: InsertAttributionResultRow,
  executor?: AttributionStoreExecutor
): Promise<AttributionStoreWriteResult<AttributionResultRow>> {
  const db = resolveAttributionDb(executor);
  try {
    await db.insert(attributionResults).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getAttributionByNaturalKey(
      {
        userId: Number(row.userId),
        outcomeId: row.outcomeId,
        modelType: row.modelType,
        modelVersion: row.modelVersion,
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
        journeyHash: row.journeyHash,
      },
      executor
    );
    if (existing) {
      if (existing.recordHash !== row.recordHash || existing.attributionId !== row.attributionId) {
        throw new AttributionIdentityConflictError(
          "ATTRIBUTION_REPLAY_CONFLICT",
          `ATTRIBUTION_REPLAY_CONFLICT: attribution (userId=${row.userId}, outcomeId=${row.outcomeId}, model=${row.modelType}@${row.modelVersion}) was replayed with conflicting material.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await getAttributionByNaturalKey(
    {
      userId: Number(row.userId),
      outcomeId: row.outcomeId,
      modelType: row.modelType,
      modelVersion: row.modelVersion,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      journeyHash: row.journeyHash,
    },
    executor
  );
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

export interface ListAttributionsFilter {
  outcomeId?: string;
  businessId?: number;
  modelType?: string;
  limit?: number;
}

export async function listAttributions(
  userId: number,
  filters: ListAttributionsFilter = {},
  executor?: AttributionStoreExecutor
): Promise<AttributionResultRow[]> {
  const db = resolveAttributionDb(executor);
  const conditions: SQL[] = [eq(attributionResults.userId, userId)];
  if (filters.outcomeId !== undefined) {
    conditions.push(eq(attributionResults.outcomeId, filters.outcomeId));
  }
  if (filters.businessId !== undefined) {
    conditions.push(eq(attributionResults.businessId, filters.businessId));
  }
  if (filters.modelType !== undefined) {
    conditions.push(eq(attributionResults.modelType, filters.modelType as never));
  }
  const limit = Math.min(filters.limit ?? 100, 500);
  const rows = await db
    .select()
    .from(attributionResults)
    .where(and(...conditions))
    .orderBy(desc(attributionResults.id))
    .limit(limit);
  for (const row of rows) assertAttributionRecordIntegrity(row);
  return rows;
}

/** Latest active result per (outcomeId, modelType, modelVersion): newest row
 *  not superseded by any newer row. Used for supersession linking. */
export async function findSupersedeTarget(
  userId: number,
  outcomeId: string,
  modelType: string,
  modelVersion: string,
  executor?: AttributionStoreExecutor
): Promise<AttributionResultRow | null> {
  const db = resolveAttributionDb(executor);
  const rows = await db
    .select()
    .from(attributionResults)
    .where(
      and(
        eq(attributionResults.userId, userId),
        eq(attributionResults.outcomeId, outcomeId),
        eq(attributionResults.modelType, modelType),
        eq(attributionResults.modelVersion, modelVersion)
      )
    )
    .orderBy(desc(attributionResults.id))
    .limit(50);
  for (const row of rows) assertAttributionRecordIntegrity(row);
  if (rows.length === 0) return null;
  const superseded = new Set(
    rows.map((r) => r.supersedesAttributionId).filter((v): v is string => v !== null)
  );
  const active = rows.find((r) => !superseded.has(r.attributionId));
  return active ?? rows[0];
}

// ─── Lifecycle events (immutable, append-only) ───

export async function insertAttributionLifecycleEvent(
  row: InsertAttributionLifecycleEventRow,
  executor?: AttributionStoreExecutor
): Promise<AttributionStoreWriteResult<AttributionLifecycleEventRow>> {
  const db = resolveAttributionDb(executor);
  try {
    await db.insert(attributionLifecycleEvents).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const [existing] = await db
      .select()
      .from(attributionLifecycleEvents)
      .where(
        eq(attributionLifecycleEvents.attributionLifecycleEventId, row.attributionLifecycleEventId)
      )
      .limit(1);
    if (existing) {
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const [inserted] = await db
    .select()
    .from(attributionLifecycleEvents)
    .where(eq(attributionLifecycleEvents.attributionLifecycleEventId, row.attributionLifecycleEventId))
    .limit(1);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}
