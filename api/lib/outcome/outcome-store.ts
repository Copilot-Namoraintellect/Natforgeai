// ─── R7-A Conversion Outcome Intelligence — durable store ───
//
// DB-authoritative persistence. Convergence anchors are durable unique keys
// (no in-memory dedupe): outcomeId and (userId, conversionId, evidenceSource,
// evidenceIdentity) for outcomes; outcomeLifecycleEventId and
// (outcomeId, externalLifecycleId) for lifecycle facts. Status transitions are
// optimistic-CAS guarded (version); stale writes fail closed. Outcome rows are
// immutable after acceptance — the evidenceHash proves byte-stability; drift is
// tampering (OUTCOME_EVIDENCE_CONFLICT).
//
// Optional caller executor seam (same discipline as conversion-store): the
// default getDb() client and a transaction callback client both satisfy the
// shape.

import { and, desc, eq, type SQL } from "drizzle-orm";
import {
  businessOutcomes,
  businessOutcomeLifecycleEvents,
  type BusinessOutcomeRow,
  type BusinessOutcomeLifecycleEventRow,
  type InsertBusinessOutcomeRow,
  type InsertBusinessOutcomeLifecycleEventRow,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  OutcomeIdentityConflictError,
  OutcomeStateConflictError,
  OutcomeTamperError,
  type OutcomeDuplicateClassification,
} from "./outcome-contract";
import { deriveOutcomeEvidenceHash } from "./outcome-identity";

type Db = ReturnType<typeof getDb>;

export interface OutcomeStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
}

export function resolveOutcomeDb(executor?: OutcomeStoreExecutor): OutcomeStoreExecutor {
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

export interface OutcomeStoreWriteResult<T> {
  row: T;
  inserted: boolean;
  duplicateClassification: OutcomeDuplicateClassification;
}

// ─── Evidence integrity (immutable rows, hash-verified) ───

function evidenceHashInputFromRow(row: BusinessOutcomeRow) {
  return {
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    leadId: row.leadId === null || row.leadId === undefined ? null : Number(row.leadId),
    leadIdentityVersion: row.leadIdentityVersion ?? null,
    conversionId: row.conversionId,
    outcomeType: row.outcomeType,
    valueType: row.valueType,
    amountMinor: row.amountMinor === null || row.amountMinor === undefined ? null : Number(row.amountMinor),
    currency: row.currency ?? null,
    quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
    metricUnit: row.metricUnit ?? null,
    evidenceSource: row.evidenceSource,
    evidenceAuthority: row.evidenceAuthority,
    evidenceIdentity: row.evidenceIdentity,
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    reversesOutcomeId: row.reversesOutcomeId ?? null,
    renewsOutcomeId: row.renewsOutcomeId ?? null,
    supersedesOutcomeId: row.supersedesOutcomeId ?? null,
  };
}

/** Recompute the immutable-core hash; drift fails closed (tampering). */
export function assertOutcomeEvidenceIntegrity(row: BusinessOutcomeRow): void {
  const expected = deriveOutcomeEvidenceHash(evidenceHashInputFromRow(row));
  if (expected !== row.evidenceHash) {
    throw new OutcomeTamperError(
      "OUTCOME_EVIDENCE_CONFLICT",
      `business_outcomes row ${row.id} (${row.outcomeId}) hash drift detected; refusing to use tampered evidence.`
    );
  }
}

// ─── Business outcomes ───

export async function getOutcomeByNaturalKey(
  userId: number,
  conversionId: string,
  evidenceSource: string,
  evidenceIdentity: string,
  executor?: OutcomeStoreExecutor
): Promise<BusinessOutcomeRow | null> {
  const db = resolveOutcomeDb(executor);
  const [row] = await db
    .select()
    .from(businessOutcomes)
    .where(
      and(
        eq(businessOutcomes.userId, userId),
        eq(businessOutcomes.conversionId, conversionId),
        eq(businessOutcomes.evidenceSource, evidenceSource),
        eq(businessOutcomes.evidenceIdentity, evidenceIdentity)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function getOutcomeByOutcomeId(
  userId: number,
  outcomeId: string,
  executor?: OutcomeStoreExecutor
): Promise<BusinessOutcomeRow | null> {
  const db = resolveOutcomeDb(executor);
  const [row] = await db
    .select()
    .from(businessOutcomes)
    .where(and(eq(businessOutcomes.userId, userId), eq(businessOutcomes.outcomeId, outcomeId)))
    .limit(1);
  return row ?? null;
}

/**
 * Insert-first persistence. Duplicate submissions and concurrent records of
 * the same logical outcome converge: one insert wins, losers re-read through
 * the durable unique keys and verify the evidence fingerprint. A stored row
 * whose evidenceHash disagrees with the replayed material is an identity
 * conflict and fails closed.
 */
export async function insertBusinessOutcome(
  row: InsertBusinessOutcomeRow,
  executor?: OutcomeStoreExecutor
): Promise<OutcomeStoreWriteResult<BusinessOutcomeRow>> {
  const db = resolveOutcomeDb(executor);
  try {
    await db.insert(businessOutcomes).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing =
      (await getOutcomeByNaturalKey(
        Number(row.userId),
        row.conversionId,
        row.evidenceSource,
        row.evidenceIdentity,
        executor
      )) ?? (await getOutcomeByOutcomeId(Number(row.userId), row.outcomeId, executor));
    if (existing) {
      if (existing.evidenceHash !== row.evidenceHash) {
        throw new OutcomeIdentityConflictError(
          "OUTCOME_IDENTITY_CONFLICT",
          `OUTCOME_IDENTITY_CONFLICT: outcome (userId=${row.userId}, conversionId=${row.conversionId}, evidenceSource=${row.evidenceSource}, evidenceIdentity=${row.evidenceIdentity}) was replayed with conflicting evidence material.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await getOutcomeByOutcomeId(Number(row.userId), row.outcomeId, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

/**
 * Optimistic-CAS guarded outcome-status transition. Stale writes (version
 * drift) fail closed with OUTCOME_STALE_STATE. Returns the updated row.
 */
export async function transitionOutcomeStatus(
  userId: number,
  outcomeId: string,
  expectedVersion: number,
  newStatus: string,
  executor?: OutcomeStoreExecutor
): Promise<BusinessOutcomeRow> {
  const db = resolveOutcomeDb(executor);
  const result = await db
    .update(businessOutcomes)
    .set({ outcomeStatus: newStatus, version: expectedVersion + 1 })
    .where(
      and(
        eq(businessOutcomes.userId, userId),
        eq(businessOutcomes.outcomeId, outcomeId),
        eq(businessOutcomes.version, expectedVersion)
      )
    );
  // MySQL2 update resolves a ResultSetHeader-like object with affectedRows;
  // some drivers expose rowsAffected. Read either, fail closed on absence.
  const header = result as unknown as Record<string, unknown>;
  const affected = Number(header.affectedRows ?? header.rowsAffected ?? 0);
  if (affected === 0) {
    const current = await getOutcomeByOutcomeId(userId, outcomeId, executor);
    if (!current) {
      throw new OutcomeStateConflictError(
        "OUTCOME_STALE_STATE",
        `outcome ${outcomeId} not found for user ${userId}.`
      );
    }
    throw new OutcomeStateConflictError(
      "OUTCOME_STALE_STATE",
      `outcome ${outcomeId} is at version ${current.version}; expected ${expectedVersion}. Stale write rejected.`
    );
  }
  const updated = await getOutcomeByOutcomeId(userId, outcomeId, executor);
  return updated!;
}

export interface ListOutcomesFilter {
  businessId?: number;
  leadId?: number;
  conversionId?: string;
  outcomeType?: string;
  outcomeStatus?: string;
  valueType?: string;
  limit?: number;
}

export async function listOutcomes(
  userId: number,
  filters: ListOutcomesFilter = {},
  executor?: OutcomeStoreExecutor
): Promise<BusinessOutcomeRow[]> {
  const db = resolveOutcomeDb(executor);
  const conditions: SQL[] = [eq(businessOutcomes.userId, userId)];
  if (filters.businessId !== undefined) {
    conditions.push(eq(businessOutcomes.businessId, filters.businessId));
  }
  if (filters.leadId !== undefined) {
    conditions.push(eq(businessOutcomes.leadId, filters.leadId));
  }
  if (filters.conversionId !== undefined) {
    conditions.push(eq(businessOutcomes.conversionId, filters.conversionId));
  }
  if (filters.outcomeType !== undefined) {
    conditions.push(eq(businessOutcomes.outcomeType, filters.outcomeType as never));
  }
  if (filters.outcomeStatus !== undefined) {
    conditions.push(eq(businessOutcomes.outcomeStatus, filters.outcomeStatus as never));
  }
  if (filters.valueType !== undefined) {
    conditions.push(eq(businessOutcomes.valueType, filters.valueType as never));
  }
  const limit = Math.min(filters.limit ?? 100, 500);
  return db
    .select()
    .from(businessOutcomes)
    .where(and(...conditions))
    .orderBy(desc(businessOutcomes.id))
    .limit(limit);
}

// ─── Lifecycle events (immutable, append-only) ───

export async function getOutcomeLifecycleEventById(
  outcomeLifecycleEventId: string,
  executor?: OutcomeStoreExecutor
): Promise<BusinessOutcomeLifecycleEventRow | null> {
  const db = resolveOutcomeDb(executor);
  const [row] = await db
    .select()
    .from(businessOutcomeLifecycleEvents)
    .where(eq(businessOutcomeLifecycleEvents.outcomeLifecycleEventId, outcomeLifecycleEventId))
    .limit(1);
  return row ?? null;
}

export async function getOutcomeLifecycleEventByExternalKey(
  outcomeId: string,
  externalLifecycleId: string,
  executor?: OutcomeStoreExecutor
): Promise<BusinessOutcomeLifecycleEventRow | null> {
  const db = resolveOutcomeDb(executor);
  const [row] = await db
    .select()
    .from(businessOutcomeLifecycleEvents)
    .where(
      and(
        eq(businessOutcomeLifecycleEvents.outcomeId, outcomeId),
        eq(businessOutcomeLifecycleEvents.externalLifecycleId, externalLifecycleId)
      )
    )
    .limit(1);
  return row ?? null;
}

function outcomeLifecycleFieldsMatch(
  existing: BusinessOutcomeLifecycleEventRow,
  row: InsertBusinessOutcomeLifecycleEventRow
): boolean {
  return (
    existing.outcomeId === row.outcomeId &&
    Number(existing.userId) === Number(row.userId) &&
    existing.lifecycleType === row.lifecycleType &&
    existing.outcomeStatus === row.outcomeStatus &&
    (existing.amountMinor === null || existing.amountMinor === undefined
      ? row.amountMinor === null || row.amountMinor === undefined
      : Number(existing.amountMinor) === Number(row.amountMinor)) &&
    (existing.currency ?? null) === (row.currency ?? null) &&
    (existing.externalLifecycleId ?? null) === (row.externalLifecycleId ?? null) &&
    existing.occurredAt === row.occurredAt &&
    (existing.reasonCode ?? null) === (row.reasonCode ?? null)
  );
}

/**
 * Insert-first lifecycle persistence. A replayed fact reproduces the same
 * outcomeLifecycleEventId and converges (idempotent_replay). A collision on
 * (outcomeId, externalLifecycleId) with a DIFFERENT event id is conflicting
 * reuse of the provider lifecycle identity and fails closed
 * (OUTCOME_LIFECYCLE_CONFLICT).
 */
export async function insertOutcomeLifecycleEvent(
  row: InsertBusinessOutcomeLifecycleEventRow,
  executor?: OutcomeStoreExecutor
): Promise<OutcomeStoreWriteResult<BusinessOutcomeLifecycleEventRow>> {
  const db = resolveOutcomeDb(executor);
  try {
    await db.insert(businessOutcomeLifecycleEvents).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getOutcomeLifecycleEventById(row.outcomeLifecycleEventId, executor);
    if (existing) {
      if (!outcomeLifecycleFieldsMatch(existing, row)) {
        throw new OutcomeIdentityConflictError(
          "OUTCOME_LIFECYCLE_CONFLICT",
          `outcome lifecycle event ${row.outcomeLifecycleEventId} exists with different material content.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    if (row.externalLifecycleId !== null && row.externalLifecycleId !== undefined) {
      const byExternal = await getOutcomeLifecycleEventByExternalKey(
        row.outcomeId,
        row.externalLifecycleId,
        executor
      );
      if (byExternal) {
        throw new OutcomeIdentityConflictError(
          "OUTCOME_LIFECYCLE_CONFLICT",
          `provider lifecycle id ${row.externalLifecycleId} on ${row.outcomeId} already maps to a different lifecycle event (${byExternal.outcomeLifecycleEventId}).`
        );
      }
    }
    throw err;
  }
  const inserted = await getOutcomeLifecycleEventById(row.outcomeLifecycleEventId, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

export async function listOutcomeLifecycleEvents(
  userId: number,
  outcomeId: string,
  executor?: OutcomeStoreExecutor
): Promise<BusinessOutcomeLifecycleEventRow[]> {
  const db = resolveOutcomeDb(executor);
  return db
    .select()
    .from(businessOutcomeLifecycleEvents)
    .where(
      and(
        eq(businessOutcomeLifecycleEvents.userId, userId),
        eq(businessOutcomeLifecycleEvents.outcomeId, outcomeId)
      )
    )
    .orderBy(desc(businessOutcomeLifecycleEvents.id));
}
