// ─── R10-D Provider & Integration Resilience — durable store ───
//
// Insert-first persistence over the stream-local R10-D tables with durable
// unique anchors (structural exact-once). Immutable-core drift fails closed
// (PROVIDER_TAMPER); mutable lifecycle state lives behind optimistic-CAS
// version guards. The store never touches upstream (R9-A/B/C/D/E/F) or
// legacy execution tables — R9-D is read-only through the execution seam.

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  providerAccountBindings,
  providerCallbackEvents,
  providerCircuitBreakerStates,
  providerDispatchRequests,
  providerReconciliationRecords,
  type InsertProviderAccountBindingRow,
  type InsertProviderCallbackEventRow,
  type InsertProviderCircuitBreakerStateRow,
  type InsertProviderDispatchRequestRow,
  type InsertProviderReconciliationRecordRow,
  type ProviderAccountBindingRow,
  type ProviderCallbackEventRow,
  type ProviderCircuitBreakerStateRow,
  type ProviderDispatchRequestRow,
  type ProviderReconciliationRecordRow,
} from "@db/schema";
import {
  PROVIDER_REPLAY_CONFLICT,
  PROVIDER_TAMPER,
  ProviderIdentityConflictError,
  ProviderStateConflictError,
  ProviderTamperError,
} from "./provider-resilience-contract";

type Db = ReturnType<typeof getDb>;
export type ProviderStoreExecutor = Db | undefined;

export function resolveProviderDb(executor?: ProviderStoreExecutor): Db {
  return executor ?? getDb();
}

function isDuplicateEntryError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  const message = String((err as { message?: unknown })?.message ?? "");
  return (
    code === "ER_DUP_ENTRY" ||
    message.includes("Duplicate entry") ||
    message.includes("duplicate key")
  );
}

// ─── Provider account bindings ───

export interface InsertBindingResult {
  readonly row: ProviderAccountBindingRow;
  readonly duplicateClassification: "none" | "idempotent_replay";
}

export async function insertProviderAccountBinding(
  row: InsertProviderAccountBindingRow,
  executor?: ProviderStoreExecutor
): Promise<InsertBindingResult> {
  const db = resolveProviderDb(executor);
  try {
    await db.insert(providerAccountBindings).values(row);
    const inserted = await getProviderAccountBindingById(
      Number(row.userId),
      String(row.bindingId),
      executor
    );
    if (!inserted)
      throw new ProviderTamperError(
        PROVIDER_TAMPER,
        "provider binding insert not readable."
      );
    return { row: inserted, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const existing = await getProviderAccountBindingById(
      Number(row.userId),
      String(row.bindingId),
      executor
    );
    if (existing && bindingMaterialMatches(existing, row)) {
      return { row: existing, duplicateClassification: "idempotent_replay" };
    }
    throw new ProviderIdentityConflictError(
      PROVIDER_REPLAY_CONFLICT,
      "provider binding identity replayed with conflicting material."
    );
  }
}

function bindingMaterialMatches(
  existing: ProviderAccountBindingRow,
  inserted: InsertProviderAccountBindingRow
): boolean {
  return (
    existing.bindingId === inserted.bindingId &&
    existing.userId === inserted.userId &&
    existing.businessId === inserted.businessId &&
    existing.providerId === inserted.providerId &&
    existing.providerAccountId === inserted.providerAccountId &&
    existing.capability === inserted.capability &&
    existing.actionType === inserted.actionType &&
    existing.status === inserted.status &&
    existing.credentialFingerprint === inserted.credentialFingerprint
  );
}

export async function getProviderAccountBindingById(
  userId: number,
  bindingId: string,
  executor?: ProviderStoreExecutor
): Promise<ProviderAccountBindingRow | null> {
  const db = resolveProviderDb(executor);
  const [row] = await db
    .select()
    .from(providerAccountBindings)
    .where(
      and(
        eq(providerAccountBindings.userId, userId),
        eq(providerAccountBindings.bindingId, bindingId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function listProviderAccountBindings(
  userId: number,
  filters: { providerId?: string; status?: string; limit?: number } = {},
  executor?: ProviderStoreExecutor
): Promise<ProviderAccountBindingRow[]> {
  const db = resolveProviderDb(executor);
  return db
    .select()
    .from(providerAccountBindings)
    .where(
      and(
        eq(providerAccountBindings.userId, userId),
        filters.providerId
          ? eq(providerAccountBindings.providerId, filters.providerId)
          : undefined,
        filters.status
          ? eq(providerAccountBindings.status, filters.status)
          : undefined
      )
    )
    .orderBy(desc(providerAccountBindings.id))
    .limit(Math.min(100, Math.max(1, filters.limit ?? 100)));
}

export async function updateProviderAccountBindingStatus(
  userId: number,
  bindingId: string,
  expectedVersion: number,
  nextStatus: string,
  executor?: ProviderStoreExecutor
): Promise<ProviderAccountBindingRow> {
  const db = resolveProviderDb(executor);
  const result = await db
    .update(providerAccountBindings)
    .set({ status: nextStatus, version: expectedVersion + 1 })
    .where(
      and(
        eq(providerAccountBindings.userId, userId),
        eq(providerAccountBindings.bindingId, bindingId),
        eq(providerAccountBindings.version, expectedVersion)
      )
    );
  const affected = Number(
    (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0
  );
  if (affected !== 1) {
    throw new ProviderStateConflictError(
      PROVIDER_REPLAY_CONFLICT,
      "binding status CAS failed; the binding was modified concurrently."
    );
  }
  const row = await getProviderAccountBindingById(userId, bindingId, executor);
  if (!row)
    throw new ProviderTamperError(
      PROVIDER_TAMPER,
      "binding update not readable."
    );
  return row;
}

// ─── Provider dispatch requests ───

export interface InsertDispatchResult {
  readonly row: ProviderDispatchRequestRow;
  readonly duplicateClassification: "none" | "idempotent_replay";
}

export async function insertProviderDispatchRequest(
  row: InsertProviderDispatchRequestRow,
  executor?: ProviderStoreExecutor
): Promise<InsertDispatchResult> {
  const db = resolveProviderDb(executor);
  try {
    await db.insert(providerDispatchRequests).values(row);
    const inserted = await getProviderDispatchRequestById(
      Number(row.userId),
      String(row.requestId),
      executor
    );
    if (!inserted)
      throw new ProviderTamperError(
        PROVIDER_TAMPER,
        "provider dispatch insert not readable."
      );
    return { row: inserted, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const existing = await getProviderDispatchRequestById(
      Number(row.userId),
      String(row.requestId),
      executor
    );
    if (existing && dispatchMaterialMatches(existing, row)) {
      return { row: existing, duplicateClassification: "idempotent_replay" };
    }
    throw new ProviderIdentityConflictError(
      PROVIDER_REPLAY_CONFLICT,
      "provider dispatch identity replayed with conflicting material."
    );
  }
}

function dispatchMaterialMatches(
  existing: ProviderDispatchRequestRow,
  inserted: InsertProviderDispatchRequestRow
): boolean {
  return (
    existing.requestId === inserted.requestId &&
    existing.userId === inserted.userId &&
    existing.bindingId === inserted.bindingId &&
    existing.executionActionId === inserted.executionActionId &&
    existing.attemptId === inserted.attemptId &&
    existing.parametersHash === inserted.parametersHash &&
    existing.businessId === inserted.businessId &&
    existing.providerId === inserted.providerId &&
    existing.providerAccountId === inserted.providerAccountId &&
    existing.capability === inserted.capability &&
    existing.actionType === inserted.actionType
  );
}

export async function getProviderDispatchRequestById(
  userId: number,
  requestId: string,
  executor?: ProviderStoreExecutor
): Promise<ProviderDispatchRequestRow | null> {
  const db = resolveProviderDb(executor);
  const [row] = await db
    .select()
    .from(providerDispatchRequests)
    .where(
      and(
        eq(providerDispatchRequests.userId, userId),
        eq(providerDispatchRequests.requestId, requestId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function findProviderDispatchByNaturalKey(
  userId: number,
  bindingId: string,
  executionActionId: string,
  attemptId: string,
  executor?: ProviderStoreExecutor
): Promise<ProviderDispatchRequestRow | null> {
  const db = resolveProviderDb(executor);
  const [row] = await db
    .select()
    .from(providerDispatchRequests)
    .where(
      and(
        eq(providerDispatchRequests.userId, userId),
        eq(providerDispatchRequests.bindingId, bindingId),
        eq(providerDispatchRequests.executionActionId, executionActionId),
        eq(providerDispatchRequests.attemptId, attemptId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function listProviderDispatchRequests(
  userId: number,
  filters: { bindingId?: string; providerId?: string; limit?: number } = {},
  executor?: ProviderStoreExecutor
): Promise<ProviderDispatchRequestRow[]> {
  const db = resolveProviderDb(executor);
  return db
    .select()
    .from(providerDispatchRequests)
    .where(
      and(
        eq(providerDispatchRequests.userId, userId),
        filters.bindingId
          ? eq(providerDispatchRequests.bindingId, filters.bindingId)
          : undefined,
        filters.providerId
          ? eq(providerDispatchRequests.providerId, filters.providerId)
          : undefined
      )
    )
    .orderBy(desc(providerDispatchRequests.id))
    .limit(Math.min(100, Math.max(1, filters.limit ?? 100)));
}

export async function updateProviderDispatchState(
  userId: number,
  requestId: string,
  expectedVersion: number,
  next: Partial<{
    state: string;
    classification: string | null;
    failureClass: string | null;
    providerReference: string | null;
    retryAfterMs: number | null;
    evidenceHash: string | null;
    circuitStateAtDispatch: string | null;
    dispatchedAt: string | null;
    completedAt: string | null;
  }>,
  executor?: ProviderStoreExecutor
): Promise<ProviderDispatchRequestRow> {
  const db = resolveProviderDb(executor);
  const set: Record<string, unknown> = {
    state: next.state,
    classification: next.classification,
    failureClass: next.failureClass,
    providerReference: next.providerReference,
    retryAfterMs: next.retryAfterMs,
    evidenceHash: next.evidenceHash,
    circuitStateAtDispatch: next.circuitStateAtDispatch,
    dispatchedAt: next.dispatchedAt,
    completedAt: next.completedAt,
    version: expectedVersion + 1,
  };
  const result = await db
    .update(providerDispatchRequests)
    .set(set)
    .where(
      and(
        eq(providerDispatchRequests.userId, userId),
        eq(providerDispatchRequests.requestId, requestId),
        eq(providerDispatchRequests.version, expectedVersion)
      )
    );
  const affected = Number(
    (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0
  );
  if (affected !== 1) {
    throw new ProviderStateConflictError(
      PROVIDER_REPLAY_CONFLICT,
      "dispatch state CAS failed; the dispatch request was modified concurrently."
    );
  }
  const row = await getProviderDispatchRequestById(userId, requestId, executor);
  if (!row)
    throw new ProviderTamperError(
      PROVIDER_TAMPER,
      "dispatch update not readable."
    );
  return row;
}

// ─── Provider callback events ───

export interface InsertCallbackResult {
  readonly row: ProviderCallbackEventRow;
  readonly duplicateClassification: "none" | "idempotent_replay";
}

export async function insertProviderCallbackEvent(
  row: InsertProviderCallbackEventRow,
  executor?: ProviderStoreExecutor
): Promise<InsertCallbackResult> {
  const db = resolveProviderDb(executor);
  try {
    await db.insert(providerCallbackEvents).values(row);
    const inserted = await getProviderCallbackEventById(
      Number(row.userId),
      String(row.callbackId),
      executor
    );
    if (!inserted)
      throw new ProviderTamperError(
        PROVIDER_TAMPER,
        "provider callback insert not readable."
      );
    return { row: inserted, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const existing = await getProviderCallbackEventById(
      Number(row.userId),
      String(row.callbackId),
      executor
    );
    if (existing && callbackMaterialMatches(existing, row)) {
      return { row: existing, duplicateClassification: "idempotent_replay" };
    }
    throw new ProviderIdentityConflictError(
      PROVIDER_REPLAY_CONFLICT,
      "provider callback identity replayed with conflicting material."
    );
  }
}

function callbackMaterialMatches(
  existing: ProviderCallbackEventRow,
  inserted: InsertProviderCallbackEventRow
): boolean {
  return (
    existing.callbackId === inserted.callbackId &&
    existing.userId === inserted.userId &&
    existing.providerId === inserted.providerId &&
    existing.providerAccountId === inserted.providerAccountId &&
    existing.providerEventId === inserted.providerEventId &&
    existing.payloadHash === inserted.payloadHash &&
    existing.disposition === inserted.disposition &&
    existing.requestId === inserted.requestId &&
    existing.businessId === inserted.businessId
  );
}

export async function getProviderCallbackEventById(
  userId: number,
  callbackId: string,
  executor?: ProviderStoreExecutor
): Promise<ProviderCallbackEventRow | null> {
  const db = resolveProviderDb(executor);
  const [row] = await db
    .select()
    .from(providerCallbackEvents)
    .where(
      and(
        eq(providerCallbackEvents.userId, userId),
        eq(providerCallbackEvents.callbackId, callbackId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function findProviderCallbackByNaturalKey(
  providerId: string,
  providerAccountId: string,
  providerEventId: string,
  executor?: ProviderStoreExecutor
): Promise<ProviderCallbackEventRow | null> {
  const db = resolveProviderDb(executor);
  const [row] = await db
    .select()
    .from(providerCallbackEvents)
    .where(
      and(
        eq(providerCallbackEvents.providerId, providerId),
        eq(providerCallbackEvents.providerAccountId, providerAccountId),
        eq(providerCallbackEvents.providerEventId, providerEventId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function listProviderCallbackEvents(
  userId: number,
  filters: { requestId?: string; limit?: number } = {},
  executor?: ProviderStoreExecutor
): Promise<ProviderCallbackEventRow[]> {
  const db = resolveProviderDb(executor);
  return db
    .select()
    .from(providerCallbackEvents)
    .where(
      and(
        eq(providerCallbackEvents.userId, userId),
        filters.requestId
          ? eq(providerCallbackEvents.requestId, filters.requestId)
          : undefined
      )
    )
    .orderBy(desc(providerCallbackEvents.id))
    .limit(Math.min(100, Math.max(1, filters.limit ?? 100)));
}

// ─── Provider reconciliation records ───

export interface InsertReconciliationResult {
  readonly row: ProviderReconciliationRecordRow;
  readonly duplicateClassification: "none" | "idempotent_replay";
}

export async function insertProviderReconciliationRecord(
  row: InsertProviderReconciliationRecordRow,
  executor?: ProviderStoreExecutor
): Promise<InsertReconciliationResult> {
  const db = resolveProviderDb(executor);
  try {
    await db.insert(providerReconciliationRecords).values(row);
    const inserted = await getProviderReconciliationRecordById(
      Number(row.userId),
      String(row.reconciliationId),
      executor
    );
    if (!inserted)
      throw new ProviderTamperError(
        PROVIDER_TAMPER,
        "provider reconciliation insert not readable."
      );
    return { row: inserted, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const existing = await getProviderReconciliationRecordById(
      Number(row.userId),
      String(row.reconciliationId),
      executor
    );
    if (existing && reconciliationMaterialMatches(existing, row)) {
      return { row: existing, duplicateClassification: "idempotent_replay" };
    }
    throw new ProviderIdentityConflictError(
      PROVIDER_REPLAY_CONFLICT,
      "provider reconciliation identity replayed with conflicting material."
    );
  }
}

function reconciliationMaterialMatches(
  existing: ProviderReconciliationRecordRow,
  inserted: InsertProviderReconciliationRecordRow
): boolean {
  return (
    existing.reconciliationId === inserted.reconciliationId &&
    existing.userId === inserted.userId &&
    existing.requestId === inserted.requestId &&
    existing.outcome === inserted.outcome &&
    existing.evidenceHash === inserted.evidenceHash
  );
}

export async function getProviderReconciliationRecordById(
  userId: number,
  reconciliationId: string,
  executor?: ProviderStoreExecutor
): Promise<ProviderReconciliationRecordRow | null> {
  const db = resolveProviderDb(executor);
  const [row] = await db
    .select()
    .from(providerReconciliationRecords)
    .where(
      and(
        eq(providerReconciliationRecords.userId, userId),
        eq(providerReconciliationRecords.reconciliationId, reconciliationId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function listProviderReconciliationRecords(
  userId: number,
  filters: { requestId?: string; limit?: number } = {},
  executor?: ProviderStoreExecutor
): Promise<ProviderReconciliationRecordRow[]> {
  const db = resolveProviderDb(executor);
  return db
    .select()
    .from(providerReconciliationRecords)
    .where(
      and(
        eq(providerReconciliationRecords.userId, userId),
        filters.requestId
          ? eq(providerReconciliationRecords.requestId, filters.requestId)
          : undefined
      )
    )
    .orderBy(desc(providerReconciliationRecords.id))
    .limit(Math.min(100, Math.max(1, filters.limit ?? 100)));
}

// ─── Provider circuit breaker states ───

export async function getOrInsertCircuitState(
  row: InsertProviderCircuitBreakerStateRow,
  executor?: ProviderStoreExecutor
): Promise<{ row: ProviderCircuitBreakerStateRow; inserted: boolean }> {
  const db = resolveProviderDb(executor);
  const existing = await getCircuitStateByScope(
    Number(row.userId),
    String(row.providerId),
    String(row.providerAccountId),
    String(row.actionType),
    executor
  );
  if (existing) return { row: existing, inserted: false };
  try {
    await db.insert(providerCircuitBreakerStates).values(row);
    const inserted = await getCircuitStateById(
      Number(row.userId),
      String(row.circuitId),
      executor
    );
    if (!inserted)
      throw new ProviderTamperError(
        PROVIDER_TAMPER,
        "circuit state insert not readable."
      );
    return { row: inserted, inserted: true };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const raced = await getCircuitStateById(
      Number(row.userId),
      String(row.circuitId),
      executor
    );
    if (raced) return { row: raced, inserted: false };
    throw err;
  }
}

export async function getCircuitStateById(
  userId: number,
  circuitId: string,
  executor?: ProviderStoreExecutor
): Promise<ProviderCircuitBreakerStateRow | null> {
  const db = resolveProviderDb(executor);
  const [row] = await db
    .select()
    .from(providerCircuitBreakerStates)
    .where(
      and(
        eq(providerCircuitBreakerStates.userId, userId),
        eq(providerCircuitBreakerStates.circuitId, circuitId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function getCircuitStateByScope(
  userId: number,
  providerId: string,
  providerAccountId: string,
  actionType: string,
  executor?: ProviderStoreExecutor
): Promise<ProviderCircuitBreakerStateRow | null> {
  const db = resolveProviderDb(executor);
  const [row] = await db
    .select()
    .from(providerCircuitBreakerStates)
    .where(
      and(
        eq(providerCircuitBreakerStates.userId, userId),
        eq(providerCircuitBreakerStates.providerId, providerId),
        eq(providerCircuitBreakerStates.providerAccountId, providerAccountId),
        eq(providerCircuitBreakerStates.actionType, actionType)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function updateCircuitState(
  userId: number,
  circuitId: string,
  expectedVersion: number,
  next: Partial<{
    circuitState: string;
    failureCount: number;
    successCount: number;
    openedAtMs: number | null;
    windowStartMs: number;
    halfOpenProbesInFlight: number;
  }>,
  executor?: ProviderStoreExecutor
): Promise<ProviderCircuitBreakerStateRow> {
  const db = resolveProviderDb(executor);
  const set: Record<string, unknown> = {
    circuitState: next.circuitState,
    failureCount: next.failureCount,
    successCount: next.successCount,
    openedAtMs: next.openedAtMs,
    windowStartMs: next.windowStartMs,
    halfOpenProbesInFlight: next.halfOpenProbesInFlight,
    version: expectedVersion + 1,
  };
  const result = await db
    .update(providerCircuitBreakerStates)
    .set(set)
    .where(
      and(
        eq(providerCircuitBreakerStates.userId, userId),
        eq(providerCircuitBreakerStates.circuitId, circuitId),
        eq(providerCircuitBreakerStates.version, expectedVersion)
      )
    );
  const affected = Number(
    (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0
  );
  if (affected !== 1) {
    throw new ProviderStateConflictError(
      PROVIDER_REPLAY_CONFLICT,
      "circuit state CAS failed; the circuit was modified concurrently."
    );
  }
  const row = await getCircuitStateById(userId, circuitId, executor);
  if (!row)
    throw new ProviderTamperError(
      PROVIDER_TAMPER,
      "circuit update not readable."
    );
  return row;
}
