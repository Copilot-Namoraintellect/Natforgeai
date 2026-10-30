// ─── R8-C Market & External Signal Intelligence — durable store ───
//
// DB-authoritative persistence for the external-source registry, external
// signals and immutable lifecycle facts. Convergence anchors are durable
// unique keys (no in-memory dedupe): (userId, originKey) for sources;
// (userId, sourceId, eventKey) for signals; unique xsf1: ids for facts.
// Signal rows are immutable in their evidenceHash-bound core; derived classes
// and lineage-derived id lists are recomputed server-side and CAS-guarded.

import { and, desc, eq, type SQL } from "drizzle-orm";
import {
  externalSignalLifecycleEvents,
  externalSignals,
  externalSources,
  type ExternalSignalLifecycleEventRow,
  type ExternalSignalRow,
  type ExternalSourceRow,
  type InsertExternalSignalLifecycleEventRow,
  type InsertExternalSignalRow,
  type InsertExternalSourceRow,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  MarketSignalIdentityConflictError,
  MarketSignalTamperError,
  type MarketSignalDuplicateClassification,
} from "./market-signal-contract";
import { deriveEvidenceHash, type MarketSignalImmutableCore } from "./market-signal-identity";

type Db = ReturnType<typeof getDb>;

export interface MarketSignalStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
}

export function resolveMarketSignalDb(executor?: MarketSignalStoreExecutor): MarketSignalStoreExecutor {
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

export interface MarketSignalStoreWriteResult<T> {
  row: T;
  inserted: boolean;
  duplicateClassification: MarketSignalDuplicateClassification;
}

// ─── Source registry ───

export async function getSourceByOriginKey(
  userId: number,
  originKey: string,
  executor?: MarketSignalStoreExecutor
): Promise<ExternalSourceRow | null> {
  const db = resolveMarketSignalDb(executor);
  const [row] = await db
    .select()
    .from(externalSources)
    .where(and(eq(externalSources.userId, userId), eq(externalSources.originKey, originKey)))
    .limit(1);
  return row ?? null;
}

export async function getSourceById(
  userId: number,
  sourceId: string,
  executor?: MarketSignalStoreExecutor
): Promise<ExternalSourceRow | null> {
  const db = resolveMarketSignalDb(executor);
  const [row] = await db
    .select()
    .from(externalSources)
    .where(and(eq(externalSources.userId, userId), eq(externalSources.sourceId, sourceId)))
    .limit(1);
  return row ?? null;
}

export async function listSources(
  userId: number,
  filters: { registryClass?: string; limit?: number } = {},
  executor?: MarketSignalStoreExecutor
): Promise<ExternalSourceRow[]> {
  const db = resolveMarketSignalDb(executor);
  const conditions: SQL[] = [eq(externalSources.userId, userId)];
  if (filters.registryClass !== undefined) {
    conditions.push(eq(externalSources.registryClass, filters.registryClass as never));
  }
  const limit = Math.min(filters.limit ?? 200, 500);
  return db
    .select()
    .from(externalSources)
    .where(and(...conditions))
    .orderBy(desc(externalSources.id))
    .limit(limit);
}

/** Insert-first source registration; equivalent origins converge idempotently. */
export async function insertSource(
  row: InsertExternalSourceRow,
  executor?: MarketSignalStoreExecutor
): Promise<MarketSignalStoreWriteResult<ExternalSourceRow>> {
  const db = resolveMarketSignalDb(executor);
  try {
    await db.insert(externalSources).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getSourceByOriginKey(Number(row.userId), row.originKey, executor);
    if (existing) {
      if (existing.sourceId !== row.sourceId) {
        throw new MarketSignalIdentityConflictError(
          "MARKET_SIGNAL_REPLAY_CONFLICT",
          `Source identity conflict for origin ${row.originKey}.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await getSourceByOriginKey(Number(row.userId), row.originKey, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

// ─── Signal record integrity (immutable core, hash-verified) ───

function toHashableCore(row: ExternalSignalRow): MarketSignalImmutableCore {
  return {
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    signalType: row.signalType,
    subjectType: row.subjectType,
    subjectRef: row.subjectRef,
    claimAspect: row.claimAspect,
    sourceId: row.sourceId,
    sourceType: row.sourceType,
    sourceUriRef: row.sourceUriRef,
    eventKey: row.eventKey,
    claimText: row.claimText,
    observedAt: row.observedAt,
    publishedAt: row.publishedAt ?? null,
    freshnessPolicyVersion: row.freshnessPolicyVersion,
    contradictsSignalIds: (row.contradictingSignalIds as string[]) ?? [],
    supersedesSignalId: row.supersedesSignalId ?? null,
  };
}

/** Recompute the immutable-core hash; drift fails closed (tampering). */
export function assertSignalIntegrity(row: ExternalSignalRow): void {
  const expected = deriveEvidenceHash(toHashableCore(row));
  if (expected !== row.evidenceHash) {
    throw new MarketSignalTamperError(
      "MARKET_SIGNAL_EVIDENCE_CONFLICT",
      `external_signals row ${row.id} (${row.signalId}) hash drift detected; refusing to use tampered evidence.`
    );
  }
}

export interface SignalNaturalKey {
  userId: number;
  sourceId: string;
  eventKey: string;
}

export async function getSignalByNaturalKey(
  key: SignalNaturalKey,
  executor?: MarketSignalStoreExecutor
): Promise<ExternalSignalRow | null> {
  const db = resolveMarketSignalDb(executor);
  const [row] = await db
    .select()
    .from(externalSignals)
    .where(
      and(
        eq(externalSignals.userId, key.userId),
        eq(externalSignals.sourceId, key.sourceId),
        eq(externalSignals.eventKey, key.eventKey)
      )
    )
    .limit(1);
  if (row) assertSignalIntegrity(row);
  return row ?? null;
}

export async function getSignalById(
  userId: number,
  signalId: string,
  executor?: MarketSignalStoreExecutor
): Promise<ExternalSignalRow | null> {
  const db = resolveMarketSignalDb(executor);
  const [row] = await db
    .select()
    .from(externalSignals)
    .where(and(eq(externalSignals.userId, userId), eq(externalSignals.signalId, signalId)))
    .limit(1);
  if (row) assertSignalIntegrity(row);
  return row ?? null;
}

/**
 * Insert-first signal persistence. Identical replays converge; conflicting
 * material under the same natural identity fails closed (replay conflict).
 */
export async function insertSignal(
  row: InsertExternalSignalRow,
  executor?: MarketSignalStoreExecutor
): Promise<MarketSignalStoreWriteResult<ExternalSignalRow>> {
  const db = resolveMarketSignalDb(executor);
  try {
    await db.insert(externalSignals).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getSignalByNaturalKey(
      { userId: Number(row.userId), sourceId: row.sourceId, eventKey: row.eventKey },
      executor
    );
    if (existing) {
      if (existing.evidenceHash !== row.evidenceHash || existing.signalId !== row.signalId) {
        throw new MarketSignalIdentityConflictError(
          "MARKET_SIGNAL_REPLAY_CONFLICT",
          `MARKET_SIGNAL_REPLAY_CONFLICT: signal (userId=${row.userId}, sourceId=${row.sourceId}, eventKey=${row.eventKey}) was replayed with conflicting material.`
        );
      }
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await getSignalByNaturalKey(
    { userId: Number(row.userId), sourceId: row.sourceId, eventKey: row.eventKey },
    executor
  );
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

/** CAS-guarded update of the server-derived denormalized columns only. */
export async function updateSignalDerivedState(
  userId: number,
  signalId: string,
  expectedVersion: number,
  patch: Partial<
    Pick<
      InsertExternalSignalRow,
      | "freshnessClass"
      | "corroborationStatus"
      | "corroboratingSignalIds"
      | "contradictingSignalIds"
      | "relevanceClass"
      | "relevanceEvidence"
      | "confidenceClass"
      | "signalStatus"
      | "sourceTrustClass"
      | "injectionSuspected"
      | "limitations"
      | "version"
    >
  >,
  executor?: MarketSignalStoreExecutor
): Promise<ExternalSignalRow | null> {
  const db = resolveMarketSignalDb(executor);
  await db
    .update(externalSignals)
    .set(patch)
    .where(
      and(
        eq(externalSignals.userId, userId),
        eq(externalSignals.signalId, signalId),
        eq(externalSignals.version, expectedVersion)
      )
    );
  const row = await getSignalById(userId, signalId, executor);
  return row;
}

export interface ListSignalsFilter {
  businessId?: number;
  signalType?: string;
  signalStatus?: string;
  relevanceClass?: string;
  sourceTrustClass?: string;
  freshnessClass?: string;
  claimKey?: string;
  claimFamilyKey?: string;
  limit?: number;
}

export async function listSignals(
  userId: number,
  filters: ListSignalsFilter = {},
  executor?: MarketSignalStoreExecutor
): Promise<ExternalSignalRow[]> {
  const db = resolveMarketSignalDb(executor);
  const conditions: SQL[] = [eq(externalSignals.userId, userId)];
  if (filters.businessId !== undefined) conditions.push(eq(externalSignals.businessId, filters.businessId));
  if (filters.signalType !== undefined) conditions.push(eq(externalSignals.signalType, filters.signalType as never));
  if (filters.signalStatus !== undefined)
    conditions.push(eq(externalSignals.signalStatus, filters.signalStatus as never));
  if (filters.relevanceClass !== undefined)
    conditions.push(eq(externalSignals.relevanceClass, filters.relevanceClass as never));
  if (filters.sourceTrustClass !== undefined)
    conditions.push(eq(externalSignals.sourceTrustClass, filters.sourceTrustClass as never));
  if (filters.freshnessClass !== undefined)
    conditions.push(eq(externalSignals.freshnessClass, filters.freshnessClass as never));
  if (filters.claimKey !== undefined) conditions.push(eq(externalSignals.claimKey, filters.claimKey));
  if (filters.claimFamilyKey !== undefined)
    conditions.push(eq(externalSignals.claimFamilyKey, filters.claimFamilyKey));
  const limit = Math.min(filters.limit ?? 100, 500);
  const rows = await db
    .select()
    .from(externalSignals)
    .where(and(...conditions))
    .orderBy(desc(externalSignals.id))
    .limit(limit);
  for (const row of rows) assertSignalIntegrity(row);
  return rows;
}

// ─── Lifecycle facts (immutable, append-only) ───

export async function listLifecycleEvents(
  userId: number,
  signalId: string,
  executor?: MarketSignalStoreExecutor
): Promise<ExternalSignalLifecycleEventRow[]> {
  const db = resolveMarketSignalDb(executor);
  const rows = await db
    .select()
    .from(externalSignalLifecycleEvents)
    .where(and(eq(externalSignalLifecycleEvents.userId, userId), eq(externalSignalLifecycleEvents.signalId, signalId)))
    .orderBy(desc(externalSignalLifecycleEvents.id))
    .limit(200);
  return rows;
}

export async function listLifecycleEventsForSignals(
  userId: number,
  signalIds: readonly string[],
  executor?: MarketSignalStoreExecutor
): Promise<ExternalSignalLifecycleEventRow[]> {
  const db = resolveMarketSignalDb(executor);
  if (signalIds.length === 0) return [];
  const rows = await db
    .select()
    .from(externalSignalLifecycleEvents)
    .where(eq(externalSignalLifecycleEvents.userId, userId))
    .orderBy(desc(externalSignalLifecycleEvents.id))
    .limit(1000);
  const wanted = new Set(signalIds);
  return rows.filter((r) => wanted.has(r.signalId));
}

/** Insert-first lifecycle fact; deterministic ids converge idempotently. */
export async function insertLifecycleEvent(
  row: InsertExternalSignalLifecycleEventRow,
  executor?: MarketSignalStoreExecutor
): Promise<MarketSignalStoreWriteResult<ExternalSignalLifecycleEventRow>> {
  const db = resolveMarketSignalDb(executor);
  try {
    await db.insert(externalSignalLifecycleEvents).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const [existing] = await db
      .select()
      .from(externalSignalLifecycleEvents)
      .where(eq(externalSignalLifecycleEvents.signalLifecycleEventId, row.signalLifecycleEventId))
      .limit(1);
    if (existing) {
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const [inserted] = await db
    .select()
    .from(externalSignalLifecycleEvents)
    .where(eq(externalSignalLifecycleEvents.signalLifecycleEventId, row.signalLifecycleEventId))
    .limit(1);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}
