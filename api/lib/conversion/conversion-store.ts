// ─── R6-E Conversion Tracking — durable store ───
//
// DB-authoritative persistence. Convergence anchors are durable unique keys
// (no in-memory dedupe): conversionId and (userId, sourceSystem,
// externalConversionId) for conversion events; lifecycleEventId and
// (conversionId, externalLifecycleId) for lifecycle events. Outcome-status
// transitions are optimistic-CAS guarded (version); stale writes fail closed.
// Conversion rows are immutable after acceptance — the evidenceHash proves
// byte-stability; drift is tampering (CONVERSION_EVIDENCE_CONFLICT).
//
// Optional caller executor seam (same discipline as opportunity-store): the
// default getDb() client and a transaction callback client both satisfy the
// shape.

import { and, desc, eq, type SQL } from "drizzle-orm";
import {
  conversionEvents,
  conversionLifecycleEvents,
  type ConversionEventRow,
  type ConversionLifecycleEventRow,
  type InsertConversionEventRow,
  type InsertConversionLifecycleEventRow,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  ConversionIdentityConflictError,
  ConversionStateConflictError,
  ConversionTamperError,
  type ConversionDuplicateClassification,
  type ConversionType,
} from "./conversion-contract";
import { deriveEvidenceHash } from "./conversion-identity";

type Db = ReturnType<typeof getDb>;

export interface ConversionStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
}

export function resolveConversionDb(executor?: ConversionStoreExecutor): ConversionStoreExecutor {
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

export interface ConversionStoreWriteResult<T> {
  row: T;
  inserted: boolean;
  duplicateClassification: ConversionDuplicateClassification;
}

// ─── Evidence integrity (immutable rows, hash-verified) ───

function evidenceHashInputFromRow(row: ConversionEventRow) {
  return {
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    leadId: row.leadId === null || row.leadId === undefined ? null : Number(row.leadId),
    leadIdentityVersion: row.leadIdentityVersion ?? null,
    externalConversionId: row.externalConversionId,
    sourceSystem: row.sourceSystem,
    conversionType: row.conversionType as ConversionType,
    occurredAt: row.occurredAt,
    observedAt: row.observedAt,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    currency: row.currency ?? null,
    sourceOpportunityId: row.sourceOpportunityId ?? null,
    sourceEngagementReceiptId: row.sourceEngagementReceiptId ?? null,
    sourceSignalId: row.sourceSignalId ?? null,
    sourceCampaignId:
      row.sourceCampaignId === null || row.sourceCampaignId === undefined
        ? null
        : Number(row.sourceCampaignId),
    sourcePublicationId:
      row.sourcePublicationId === null || row.sourcePublicationId === undefined
        ? null
        : Number(row.sourcePublicationId),
    evidenceReference: row.evidenceReference ?? null,
    reversesConversionId: row.reversesConversionId ?? null,
  };
}

/** Recompute the immutable-core hash; drift fails closed (tampering). */
export function assertConversionEvidenceIntegrity(row: ConversionEventRow): void {
  const expected = deriveEvidenceHash(evidenceHashInputFromRow(row));
  if (expected !== row.evidenceHash) {
    throw new ConversionTamperError(
      "CONVERSION_EVIDENCE_CONFLICT",
      `conversion_events row ${row.id} (${row.conversionId}) hash drift detected; refusing to use tampered evidence.`
    );
  }
}

// ─── Conversion events ───

export async function getConversionByNaturalKey(
  userId: number,
  sourceSystem: string,
  externalConversionId: string,
  executor?: ConversionStoreExecutor
): Promise<ConversionEventRow | null> {
  const db = resolveConversionDb(executor);
  const [row] = await db
    .select()
    .from(conversionEvents)
    .where(
      and(
        eq(conversionEvents.userId, userId),
        eq(conversionEvents.sourceSystem, sourceSystem),
        eq(conversionEvents.externalConversionId, externalConversionId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function getConversionByConversionId(
  userId: number,
  conversionId: string,
  executor?: ConversionStoreExecutor
): Promise<ConversionEventRow | null> {
  const db = resolveConversionDb(executor);
  const [row] = await db
    .select()
    .from(conversionEvents)
    .where(
      and(eq(conversionEvents.userId, userId), eq(conversionEvents.conversionId, conversionId))
    )
    .limit(1);
  return row ?? null;
}

/**
 * Insert-first persistence. Duplicate submissions and concurrent ingests of
 * the same logical conversion converge: one insert wins, losers reread through
 * the durable unique keys and verify the evidence fingerprint. A stored row
 * whose evidenceHash disagrees with the replayed material is an identity
 * conflict and fails closed.
 */
export async function insertConversionEvent(
  row: InsertConversionEventRow,
  executor?: ConversionStoreExecutor
): Promise<ConversionStoreWriteResult<ConversionEventRow>> {
  const db = resolveConversionDb(executor);
  try {
    await db.insert(conversionEvents).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing =
      (await getConversionByNaturalKey(
        Number(row.userId),
        row.sourceSystem,
        row.externalConversionId,
        executor
      )) ?? (await getConversionByConversionId(Number(row.userId), row.conversionId, executor));
    if (existing) {
      if (existing.evidenceHash !== row.evidenceHash) {
        throw new ConversionIdentityConflictError(
          "CONVERSION_IDENTITY_CONFLICT",
          `CONVERSION_IDENTITY_CONFLICT: conversion (userId=${row.userId}, sourceSystem=${row.sourceSystem}, externalConversionId=${row.externalConversionId}) was replayed with conflicting evidence material.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await getConversionByConversionId(Number(row.userId), row.conversionId, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

/**
 * Optimistic-CAS guarded outcome-status transition. Stale writes (version
 * drift) fail closed with CONVERSION_STALE_STATE. Returns the updated row.
 */
export async function transitionOutcomeStatus(
  userId: number,
  conversionId: string,
  expectedVersion: number,
  newStatus: string,
  executor?: ConversionStoreExecutor
): Promise<ConversionEventRow> {
  const db = resolveConversionDb(executor);
  const result = await db
    .update(conversionEvents)
    .set({ outcomeStatus: newStatus, version: expectedVersion + 1 })
    .where(
      and(
        eq(conversionEvents.userId, userId),
        eq(conversionEvents.conversionId, conversionId),
        eq(conversionEvents.version, expectedVersion)
      )
    );
  // MySQL2 update resolves a ResultSetHeader-like object with affectedRows;
  // some drivers expose rowsAffected. Read either, fail closed on absence.
  const header = result as unknown as Record<string, unknown>;
  const affected = Number(header.affectedRows ?? header.rowsAffected ?? 0);
  if (affected === 0) {
    const current = await getConversionByConversionId(userId, conversionId, executor);
    if (!current) {
      throw new ConversionStateConflictError(
        "CONVERSION_STALE_STATE",
        `conversion ${conversionId} not found for user ${userId}.`
      );
    }
    throw new ConversionStateConflictError(
      "CONVERSION_STALE_STATE",
      `conversion ${conversionId} is at version ${current.version}; expected ${expectedVersion}. Stale write rejected.`
    );
  }
  const updated = await getConversionByConversionId(userId, conversionId, executor);
  return updated!;
}

export interface ListConversionsFilter {
  businessId?: number;
  leadId?: number;
  conversionType?: string;
  outcomeStatus?: string;
  sourceTrustClass?: string;
  limit?: number;
}

export async function listConversions(
  userId: number,
  filters: ListConversionsFilter = {},
  executor?: ConversionStoreExecutor
): Promise<ConversionEventRow[]> {
  const db = resolveConversionDb(executor);
  const conditions: SQL[] = [eq(conversionEvents.userId, userId)];
  if (filters.businessId !== undefined) {
    conditions.push(eq(conversionEvents.businessId, filters.businessId));
  }
  if (filters.leadId !== undefined) {
    conditions.push(eq(conversionEvents.leadId, filters.leadId));
  }
  if (filters.conversionType !== undefined) {
    conditions.push(eq(conversionEvents.conversionType, filters.conversionType as never));
  }
  if (filters.outcomeStatus !== undefined) {
    conditions.push(eq(conversionEvents.outcomeStatus, filters.outcomeStatus as never));
  }
  if (filters.sourceTrustClass !== undefined) {
    conditions.push(eq(conversionEvents.sourceTrustClass, filters.sourceTrustClass as never));
  }
  const limit = Math.min(filters.limit ?? 100, 500);
  return db
    .select()
    .from(conversionEvents)
    .where(and(...conditions))
    .orderBy(desc(conversionEvents.id))
    .limit(limit);
}

// ─── Lifecycle events (immutable, append-only) ───

export async function getLifecycleEventById(
  lifecycleEventId: string,
  executor?: ConversionStoreExecutor
): Promise<ConversionLifecycleEventRow | null> {
  const db = resolveConversionDb(executor);
  const [row] = await db
    .select()
    .from(conversionLifecycleEvents)
    .where(eq(conversionLifecycleEvents.lifecycleEventId, lifecycleEventId))
    .limit(1);
  return row ?? null;
}

export async function getLifecycleEventByExternalKey(
  conversionId: string,
  externalLifecycleId: string,
  executor?: ConversionStoreExecutor
): Promise<ConversionLifecycleEventRow | null> {
  const db = resolveConversionDb(executor);
  const [row] = await db
    .select()
    .from(conversionLifecycleEvents)
    .where(
      and(
        eq(conversionLifecycleEvents.conversionId, conversionId),
        eq(conversionLifecycleEvents.externalLifecycleId, externalLifecycleId)
      )
    )
    .limit(1);
  return row ?? null;
}

function lifecycleFieldsMatch(
  existing: ConversionLifecycleEventRow,
  row: InsertConversionLifecycleEventRow
): boolean {
  return (
    existing.conversionId === row.conversionId &&
    Number(existing.userId) === Number(row.userId) &&
    existing.lifecycleType === row.lifecycleType &&
    existing.outcomeStatus === row.outcomeStatus &&
    (existing.amount === null || existing.amount === undefined
      ? row.amount === null || row.amount === undefined
      : Number(existing.amount) === Number(row.amount)) &&
    (existing.currency ?? null) === (row.currency ?? null) &&
    (existing.externalLifecycleId ?? null) === (row.externalLifecycleId ?? null) &&
    existing.occurredAt === row.occurredAt &&
    (existing.reasonCode ?? null) === (row.reasonCode ?? null)
  );
}

/**
 * Insert-first lifecycle persistence. A replayed provider lifecycle event
 * reproduces the same lifecycleEventId and converges (idempotent_replay). A
 * collision on (conversionId, externalLifecycleId) with a DIFFERENT event id
 * is conflicting reuse of the provider lifecycle identity and fails closed
 * (CONVERSION_LIFECYCLE_CONFLICT).
 */
export async function insertLifecycleEvent(
  row: InsertConversionLifecycleEventRow,
  executor?: ConversionStoreExecutor
): Promise<ConversionStoreWriteResult<ConversionLifecycleEventRow>> {
  const db = resolveConversionDb(executor);
  try {
    await db.insert(conversionLifecycleEvents).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getLifecycleEventById(row.lifecycleEventId, executor);
    if (existing) {
      if (!lifecycleFieldsMatch(existing, row)) {
        throw new ConversionIdentityConflictError(
          "CONVERSION_LIFECYCLE_CONFLICT",
          `lifecycle event ${row.lifecycleEventId} exists with different material content.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    if (row.externalLifecycleId !== null && row.externalLifecycleId !== undefined) {
      const byExternal = await getLifecycleEventByExternalKey(
        row.conversionId,
        row.externalLifecycleId,
        executor
      );
      if (byExternal) {
        throw new ConversionIdentityConflictError(
          "CONVERSION_LIFECYCLE_CONFLICT",
          `provider lifecycle id ${row.externalLifecycleId} on ${row.conversionId} already maps to a different lifecycle event (${byExternal.lifecycleEventId}).`
        );
      }
    }
    throw err;
  }
  const inserted = await getLifecycleEventById(row.lifecycleEventId, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

export async function listLifecycleEvents(
  userId: number,
  conversionId: string,
  executor?: ConversionStoreExecutor
): Promise<ConversionLifecycleEventRow[]> {
  const db = resolveConversionDb(executor);
  return db
    .select()
    .from(conversionLifecycleEvents)
    .where(
      and(
        eq(conversionLifecycleEvents.userId, userId),
        eq(conversionLifecycleEvents.conversionId, conversionId)
      )
    )
    .orderBy(desc(conversionLifecycleEvents.id));
}
