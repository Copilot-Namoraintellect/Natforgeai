// ─── R10-E Observability — durable store (E6) ───
//
// DB-authoritative persistence over the R10-E-owned tables. The convergence
// anchors are durable unique keys (eventId / incidentId /
// (environment, dedupKey) / observationId): retried or raced writes re-read
// the committed row and converge (idempotent_replay). Rows are insert-only —
// corrections are new lifecycle facts; evidence is never deleted.
//
// The canonical tables live in @db/schema (single source of truth; the 0038
// migration artefact is provisional — NOT executed; R10-X owns canonical R10
// sequencing). Every call site supplies an executor through the structural
// seam below — the same select/insert chain shape a Drizzle client or
// transaction callback provides. The bridge binds a real client/tx to these
// handles; tests bind the in-memory fake.

import {
  operationalEvents,
  operationalIncidents,
  operationalIncidentLifecycleEvents,
  operationalAlerts,
  serviceHealthObservations,
} from "@db/schema";
import { ObservabilityInputError } from "./observability-contract";

// ─── Table handles (canonical @db/schema imports) ───

export type ObservabilityTableHandle =
  | typeof operationalEvents
  | typeof operationalIncidents
  | typeof operationalIncidentLifecycleEvents
  | typeof operationalAlerts
  | typeof serviceHealthObservations;

// ─── Predicate model ───

export type StorePredicate =
  | { readonly kind: "eq"; readonly field: string; readonly value: unknown }
  | { readonly kind: "gte"; readonly field: string; readonly value: unknown }
  | { readonly kind: "lte"; readonly field: string; readonly value: unknown }
  | { readonly kind: "and"; readonly conditions: readonly StorePredicate[] };

export function eq(field: string, value: unknown): StorePredicate {
  return Object.freeze({ kind: "eq", field, value });
}

export function gte(field: string, value: unknown): StorePredicate {
  return Object.freeze({ kind: "gte", field, value });
}

export function lte(field: string, value: unknown): StorePredicate {
  return Object.freeze({ kind: "lte", field, value });
}

export function and(...conditions: StorePredicate[]): StorePredicate {
  return Object.freeze({ kind: "and", conditions: Object.freeze([...conditions]) });
}

export interface StoreOrderTerm {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

export function asc(field: string): StoreOrderTerm {
  return Object.freeze({ field, direction: "asc" });
}

export function desc(field: string): StoreOrderTerm {
  return Object.freeze({ field, direction: "desc" });
}

// ─── Structural executor seam ───

export interface ObservabilityRowQuery {
  readonly all: () => Promise<unknown[]>;
  readonly limit: (n: number) => Promise<unknown[]>;
  readonly orderBy: (...terms: StoreOrderTerm[]) => ObservabilityRowQuery;
}

export interface ObservabilitySelectTarget {
  readonly where: (predicate: StorePredicate) => ObservabilityRowQuery;
  readonly orderBy: (...terms: StoreOrderTerm[]) => ObservabilityRowQuery;
  readonly all: () => Promise<unknown[]>;
  readonly limit: (n: number) => Promise<unknown[]>;
}

/**
 * Structural seam: the bridge binds a Drizzle client / transaction callback
 * to this select/insert chain shape (translating the local predicate
 * descriptors into Drizzle SQL over the canonical @db/schema tables); tests
 * bind the table-name-keyed in-memory fake.
 */
export interface ObservabilityStoreExecutor {
  readonly select: () => {
    readonly from: (table: ObservabilityTableHandle) => ObservabilitySelectTarget;
  };
  readonly insert: (
    table: ObservabilityTableHandle
  ) => { readonly values: (row: Record<string, unknown>) => Promise<unknown> };
  readonly update: (table: ObservabilityTableHandle) => {
    readonly set: (values: Record<string, unknown>) => {
      readonly where: (predicate: StorePredicate) => Promise<{ affectedRows?: number }>;
    };
  };
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

// ─── operational_events ───

export interface OperationalEventRecord {
  readonly eventId: string;
  readonly schemaVersion: number;
  readonly contractVersion: string;
  readonly eventType: string;
  readonly environment: string;
  readonly releaseVersion: string | null;
  readonly service: string;
  readonly component: string;
  readonly operation: string;
  readonly severity: string;
  readonly status: string;
  readonly correlationId: string | null;
  readonly tenantId: number | null;
  readonly businessId: number | null;
  readonly missionId: string | null;
  readonly taskId: string | null;
  readonly executionAttemptId: string | null;
  readonly provider: string | null;
  readonly providerReference: string | null;
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly diagnosticCode: string;
  readonly safeMetadata: unknown;
  readonly eventHash: string;
  readonly createdAt?: Date;
}

export type InsertOperationalEventRecord = OperationalEventRecord;

export interface ObservabilityWriteResult {
  readonly inserted: boolean;
  readonly duplicateClassification: "none" | "idempotent_replay";
}

export async function findOperationalEvent(
  eventId: string,
  executor: ObservabilityStoreExecutor
): Promise<OperationalEventRecord | null> {
  const [row] = (await executor
    .select()
    .from(operationalEvents)
    .where(eq("eventId", eventId))
    .limit(1)) as unknown[];
  return (row as OperationalEventRecord | undefined) ?? null;
}

export async function insertOperationalEvent(
  row: InsertOperationalEventRecord,
  executor: ObservabilityStoreExecutor
): Promise<ObservabilityWriteResult> {
  try {
    await executor.insert(operationalEvents).values({ ...row });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findOperationalEvent(row.eventId, executor);
    if (existing && existing.eventHash === row.eventHash) {
      return { inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw new ObservabilityInputError(
      "OBSERVABILITY_REPLAY_CONFLICT",
      `operational event ${row.eventId} exists with different material content; refusing to overwrite durable evidence.`
    );
  }
  return { inserted: true, duplicateClassification: "none" };
}

export interface OperationalEventFilter {
  readonly eventType?: string;
  readonly service?: string;
  readonly severity?: string;
  readonly diagnosticCode?: string;
  readonly tenantId?: number | null;
  readonly businessId?: number;
  readonly missionId?: string;
  readonly correlationId?: string;
  readonly fromOccurredAt?: string;
  readonly toOccurredAt?: string;
}

export async function listOperationalEvents(
  filter: OperationalEventFilter,
  order: StoreOrderTerm[],
  limit: number,
  executor: ObservabilityStoreExecutor
): Promise<OperationalEventRecord[]> {
  const conditions: StorePredicate[] = [];
  if (filter.eventType !== undefined) conditions.push(eq("eventType", filter.eventType));
  if (filter.service !== undefined) conditions.push(eq("service", filter.service));
  if (filter.severity !== undefined) conditions.push(eq("severity", filter.severity));
  if (filter.diagnosticCode !== undefined) conditions.push(eq("diagnosticCode", filter.diagnosticCode));
  if (filter.tenantId !== undefined) conditions.push(eq("tenantId", filter.tenantId));
  if (filter.businessId !== undefined) conditions.push(eq("businessId", filter.businessId));
  if (filter.missionId !== undefined) conditions.push(eq("missionId", filter.missionId));
  if (filter.correlationId !== undefined) conditions.push(eq("correlationId", filter.correlationId));
  if (filter.fromOccurredAt !== undefined) conditions.push(gte("occurredAt", filter.fromOccurredAt));
  if (filter.toOccurredAt !== undefined) conditions.push(lte("occurredAt", filter.toOccurredAt));
  let query =
    conditions.length > 0
      ? executor.select().from(operationalEvents).where(and(...conditions))
      : executor.select().from(operationalEvents);
  if (order.length > 0) query = query.orderBy(...order);
  const rows = await query.limit(limit);
  return rows as unknown as OperationalEventRecord[];
}

export async function countOperationalEvents(
  filter: OperationalEventFilter,
  executor: ObservabilityStoreExecutor
): Promise<number> {
  const rows = await listOperationalEvents(filter, [], 100000, executor);
  return rows.length;
}

// ─── operational_incidents ───

export interface OperationalIncidentRecord {
  readonly incidentId: string;
  readonly environment: string;
  readonly service: string;
  readonly component: string;
  readonly failureClass: string;
  readonly scope: string;
  readonly tenantId: number | null;
  readonly businessId: number | null;
  readonly severity: string;
  readonly status: string;
  readonly title: string;
  readonly summary: string;
  readonly safetyState: string;
  readonly executionContinuing: boolean;
  readonly autonomousActionSuspended: boolean;
  readonly operatorAttentionRequired: boolean;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly occurrenceCount: number;
  readonly evidenceEventIds: unknown;
  readonly correlationKey: string;
  readonly version: number;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export type InsertOperationalIncidentRecord = OperationalIncidentRecord;

export async function findOperationalIncident(
  incidentId: string,
  executor: ObservabilityStoreExecutor
): Promise<OperationalIncidentRecord | null> {
  const [row] = (await executor
    .select()
    .from(operationalIncidents)
    .where(eq("incidentId", incidentId))
    .limit(1)) as unknown[];
  return (row as OperationalIncidentRecord | undefined) ?? null;
}

export async function insertOperationalIncident(
  row: InsertOperationalIncidentRecord,
  executor: ObservabilityStoreExecutor
): Promise<ObservabilityWriteResult> {
  try {
    await executor.insert(operationalIncidents).values({ ...row });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findOperationalIncident(row.incidentId, executor);
    if (existing) return { inserted: false, duplicateClassification: "idempotent_replay" };
    throw err;
  }
  return { inserted: true, duplicateClassification: "none" };
}

export interface IncidentFilter {
  readonly tenantId?: number | null;
  readonly businessId?: number;
  readonly scope?: string;
  readonly service?: string;
  readonly status?: string;
}

export async function listOperationalIncidents(
  filter: IncidentFilter,
  limit: number,
  executor: ObservabilityStoreExecutor
): Promise<OperationalIncidentRecord[]> {
  const conditions: StorePredicate[] = [];
  if (filter.tenantId !== undefined) conditions.push(eq("tenantId", filter.tenantId));
  if (filter.businessId !== undefined) conditions.push(eq("businessId", filter.businessId));
  if (filter.scope !== undefined) conditions.push(eq("scope", filter.scope));
  if (filter.service !== undefined) conditions.push(eq("service", filter.service));
  if (filter.status !== undefined) conditions.push(eq("status", filter.status));
  let query =
    conditions.length > 0
      ? executor.select().from(operationalIncidents).where(and(...conditions))
      : executor.select().from(operationalIncidents);
  query = query.orderBy(desc("lastSeenAt"), desc("incidentId"));
  const rows = await query.limit(limit);
  return rows as unknown as OperationalIncidentRecord[];
}

/** CAS status update; returns false when the version anchor does not match. */
export async function updateIncidentState(
  incidentId: string,
  expectedVersion: number,
  next: {
    readonly status?: string;
    readonly lastSeenAt?: string;
    readonly occurrenceCount?: number;
    readonly evidenceEventIds?: unknown;
  },
  executor: ObservabilityStoreExecutor
): Promise<boolean> {
  const set: Record<string, unknown> = { version: expectedVersion + 1 };
  if (next.status !== undefined) set.status = next.status;
  if (next.lastSeenAt !== undefined) set.lastSeenAt = next.lastSeenAt;
  if (next.occurrenceCount !== undefined) set.occurrenceCount = next.occurrenceCount;
  if (next.evidenceEventIds !== undefined) set.evidenceEventIds = next.evidenceEventIds;
  const result = await executor
    .update(operationalIncidents)
    .set(set)
    .where(and(eq("incidentId", incidentId), eq("version", expectedVersion)));
  return (result.affectedRows ?? 0) > 0;
}

// ─── operational_incident_lifecycle_events ───

export interface IncidentLifecycleEventRecord {
  readonly lifecycleEventId: string;
  readonly incidentId: string;
  readonly tenantId: number | null;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly actorType: string;
  readonly actorUserId: number | null;
  readonly suppressionAuthority: string | null;
  readonly reason: string;
  readonly occurredAt: string;
  readonly eventHash: string;
  readonly createdAt?: Date;
}

export type InsertIncidentLifecycleEventRecord = IncidentLifecycleEventRecord;

export async function insertIncidentLifecycleEvent(
  row: InsertIncidentLifecycleEventRecord,
  executor: ObservabilityStoreExecutor
): Promise<ObservabilityWriteResult> {
  try {
    await executor.insert(operationalIncidentLifecycleEvents).values({ ...row });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    return { inserted: false, duplicateClassification: "idempotent_replay" };
  }
  return { inserted: true, duplicateClassification: "none" };
}

export async function listIncidentLifecycleEvents(
  incidentId: string,
  executor: ObservabilityStoreExecutor
): Promise<IncidentLifecycleEventRecord[]> {
  const rows = await executor
    .select()
    .from(operationalIncidentLifecycleEvents)
    .where(eq("incidentId", incidentId))
    .orderBy(asc("occurredAt"), asc("lifecycleEventId"))
    .all();
  return rows as unknown as IncidentLifecycleEventRecord[];
}

// ─── operational_alerts ───

export interface OperationalAlertRecord {
  readonly alertId: string;
  readonly environment: string;
  readonly dedupKey: string;
  readonly ruleId: string;
  readonly severity: string;
  readonly status: string;
  readonly title: string;
  readonly summary: string;
  readonly affectedTarget: string;
  readonly safetyState: string;
  readonly executionContinuing: boolean;
  readonly autonomousActionSuspended: boolean;
  readonly operatorAttentionRequired: boolean;
  readonly incidentId: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly occurrenceCount: number;
  readonly version: number;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export type InsertOperationalAlertRecord = OperationalAlertRecord;

export async function findOpenAlertByIdentity(
  environment: string,
  dedupKey: string,
  executor: ObservabilityStoreExecutor
): Promise<OperationalAlertRecord | null> {
  const [row] = (await executor
    .select()
    .from(operationalAlerts)
    .where(and(eq("environment", environment), eq("dedupKey", dedupKey)))
    .limit(1)) as unknown[];
  return (row as OperationalAlertRecord | undefined) ?? null;
}

export async function insertOperationalAlert(
  row: InsertOperationalAlertRecord,
  executor: ObservabilityStoreExecutor
): Promise<ObservabilityWriteResult> {
  try {
    await executor.insert(operationalAlerts).values({ ...row });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findOpenAlertByIdentity(row.environment, row.dedupKey, executor);
    if (existing) return { inserted: false, duplicateClassification: "idempotent_replay" };
    throw err;
  }
  return { inserted: true, duplicateClassification: "none" };
}

export async function findOperationalAlert(
  alertId: string,
  executor: ObservabilityStoreExecutor
): Promise<OperationalAlertRecord | null> {
  const [row] = (await executor
    .select()
    .from(operationalAlerts)
    .where(eq("alertId", alertId))
    .limit(1)) as unknown[];
  return (row as OperationalAlertRecord | undefined) ?? null;
}

export interface AlertFilter {
  readonly status?: string;
  readonly severity?: string;
  readonly ruleId?: string;
}

export async function listOperationalAlerts(
  filter: AlertFilter,
  limit: number,
  executor: ObservabilityStoreExecutor
): Promise<OperationalAlertRecord[]> {
  const conditions: StorePredicate[] = [];
  if (filter.status !== undefined) conditions.push(eq("status", filter.status));
  if (filter.severity !== undefined) conditions.push(eq("severity", filter.severity));
  if (filter.ruleId !== undefined) conditions.push(eq("ruleId", filter.ruleId));
  let query =
    conditions.length > 0
      ? executor.select().from(operationalAlerts).where(and(...conditions))
      : executor.select().from(operationalAlerts);
  query = query.orderBy(desc("lastSeenAt"), desc("alertId"));
  const rows = await query.limit(limit);
  return rows as unknown as OperationalAlertRecord[];
}

/** CAS alert presentation-state update. */
export async function updateAlertState(
  alertId: string,
  expectedVersion: number,
  next: {
    readonly status?: string;
    readonly lastSeenAt?: string;
    readonly occurrenceCount?: number;
  },
  executor: ObservabilityStoreExecutor
): Promise<boolean> {
  const set: Record<string, unknown> = { version: expectedVersion + 1 };
  if (next.status !== undefined) set.status = next.status;
  if (next.lastSeenAt !== undefined) set.lastSeenAt = next.lastSeenAt;
  if (next.occurrenceCount !== undefined) set.occurrenceCount = next.occurrenceCount;
  const result = await executor
    .update(operationalAlerts)
    .set(set)
    .where(and(eq("alertId", alertId), eq("version", expectedVersion)));
  return (result.affectedRows ?? 0) > 0;
}

// ─── service_health_observations ───

export interface ServiceHealthObservationRecord {
  readonly observationId: string;
  readonly environment: string;
  readonly dimension: string;
  readonly service: string;
  readonly healthClass: string;
  readonly evidenceSummary: unknown;
  readonly unknownInputs: unknown;
  readonly evidenceHash: string;
  readonly observedAt: string;
  readonly releaseVersion: string | null;
  readonly version: number;
  readonly createdAt?: Date;
}

export type InsertServiceHealthObservationRecord = ServiceHealthObservationRecord;

export async function insertServiceHealthObservation(
  row: InsertServiceHealthObservationRecord,
  executor: ObservabilityStoreExecutor
): Promise<ObservabilityWriteResult> {
  try {
    await executor.insert(serviceHealthObservations).values({ ...row });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    return { inserted: false, duplicateClassification: "idempotent_replay" };
  }
  return { inserted: true, duplicateClassification: "none" };
}

export interface HealthObservationFilter {
  readonly dimension?: string;
  readonly service?: string;
}

export async function listServiceHealthObservations(
  filter: HealthObservationFilter,
  limit: number,
  executor: ObservabilityStoreExecutor
): Promise<ServiceHealthObservationRecord[]> {
  const conditions: StorePredicate[] = [];
  if (filter.dimension !== undefined) conditions.push(eq("dimension", filter.dimension));
  if (filter.service !== undefined) conditions.push(eq("service", filter.service));
  let query =
    conditions.length > 0
      ? executor.select().from(serviceHealthObservations).where(and(...conditions))
      : executor.select().from(serviceHealthObservations);
  query = query.orderBy(desc("observedAt"), desc("observationId"));
  const rows = await query.limit(limit);
  return rows as unknown as ServiceHealthObservationRecord[];
}
