// ─── R8-A Strategic Memory — downstream reasoning projection (read-only) ───
//
// PURE module. Builds the frozen read-only projection through which R8-B/C/D/E
// consume strategic memory (`strategic-memory-to-reasoning/v1`, see
// docs/contracts/strategic-memory-to-reasoning-contract.md). Downstream may
// read and must never mutate; this projection carries no execution authority
// and asserts the verbatim causation/attribution disclaimers on every record.

import type { StrategicMemoryContextScope } from "./strategic-memory-identity";

export const STRATEGIC_MEMORY_PROJECTION_VERSION = "strategic-memory-to-reasoning/v1" as const;

export const STRATEGIC_MEMORY_CAUSATION_DISCLAIMER =
  "Strategic memory is durable context, not causal proof. This projection does not assert that any marketing activity, attribution credit or optimisation caused any business outcome." as const;
export const STRATEGIC_MEMORY_ATTRIBUTION_DISCLAIMER =
  "Attribution-derived memory is association evidence, not causal proof. Credit allocation, causal scores and channel weights remain R7-B derivations on their own authority." as const;

/** Exact top-level key allowlist of the frozen downstream projection. */
export const STRATEGIC_MEMORY_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "memoryId",
  "businessId",
  "memoryType",
  "subjectType",
  "subjectId",
  "statementType",
  "factStatus",
  "statement",
  "confidenceClass",
  "evidenceRefs",
  "sourceAuthority",
  "sourceVersion",
  "sourceIdentity",
  "basis",
  "limitations",
  "validFrom",
  "validUntil",
  "observedAt",
  "recordedAt",
  "supersedesMemoryId",
  "contradictsMemoryIds",
  "contradictedByMemoryIds",
  "contextScope",
  "lifecycle",
  "causationClaimed",
  "causationDisclaimer",
  "attributionClaimed",
  "attributionDisclaimer",
] as const;

export type StrategicMemoryProjectionKey = (typeof STRATEGIC_MEMORY_PROJECTION_FIELD_KEYS)[number];

export interface StrategicMemoryProjection {
  readonly contractVersion: typeof STRATEGIC_MEMORY_PROJECTION_VERSION;
  readonly memoryId: string;
  readonly businessId: number;
  readonly memoryType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly statementType: string;
  readonly factStatus: string;
  readonly statement: unknown;
  readonly confidenceClass: string;
  readonly evidenceRefs: readonly string[];
  readonly sourceAuthority: string;
  readonly sourceVersion: string;
  readonly sourceIdentity: string;
  readonly basis: unknown;
  readonly limitations: readonly string[];
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly observedAt: string;
  readonly recordedAt: string;
  readonly supersedesMemoryId: string | null;
  readonly contradictsMemoryIds: readonly string[];
  /** Successors that declared a contradiction against this record — the contradiction stays visible. */
  readonly contradictedByMemoryIds: readonly string[];
  readonly contextScope: StrategicMemoryContextScope;
  readonly lifecycle: {
    readonly statuses: readonly string[];
    readonly currentStatus: string;
    readonly eventCount: number;
  };
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
  readonly attributionClaimed: false;
  readonly attributionDisclaimer: string;
}

export interface MemoryRowLike {
  memoryId: string;
  businessId: number | string;
  memoryType: string;
  subjectType: string;
  subjectId: string;
  statementType: string;
  factStatus: string;
  statement: unknown;
  confidenceClass: string;
  evidenceRefs: unknown;
  sourceAuthority: string;
  sourceVersion: string;
  sourceIdentity: string;
  basis: unknown;
  limitations: unknown;
  validFrom: string;
  validUntil: string | null;
  observedAt: string;
  recordedAt: string;
  supersedesMemoryId: string | null;
  contradictsMemoryIds: unknown;
  contextScope: unknown;
}

export interface MemoryLifecycleRowLike {
  lifecycleType: string;
  targetStatus: string;
}

/** Pure projection builder — a deterministic function of the durable row. */
export function buildStrategicMemoryProjection(
  row: MemoryRowLike,
  lifecycleRows: readonly MemoryLifecycleRowLike[] = [],
  contradictedByMemoryIds: readonly string[] = []
): StrategicMemoryProjection {
  const statuses = lifecycleRows.map((f) => f.targetStatus);
  return Object.freeze({
    contractVersion: STRATEGIC_MEMORY_PROJECTION_VERSION,
    memoryId: row.memoryId,
    businessId: Number(row.businessId),
    memoryType: row.memoryType,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    statementType: row.statementType,
    factStatus: row.factStatus,
    statement: row.statement,
    confidenceClass: row.confidenceClass,
    evidenceRefs: Object.freeze([...(row.evidenceRefs as string[])]),
    sourceAuthority: row.sourceAuthority,
    sourceVersion: row.sourceVersion,
    sourceIdentity: row.sourceIdentity,
    basis: row.basis,
    limitations: Object.freeze([...(row.limitations as string[])]),
    validFrom: row.validFrom,
    validUntil: row.validUntil ?? null,
    observedAt: row.observedAt,
    recordedAt: row.recordedAt,
    supersedesMemoryId: row.supersedesMemoryId ?? null,
    contradictsMemoryIds: Object.freeze([...(row.contradictsMemoryIds as string[])]),
    contradictedByMemoryIds: Object.freeze([...contradictedByMemoryIds]),
    contextScope: Object.freeze({ ...(row.contextScope as StrategicMemoryContextScope) }),
    lifecycle: Object.freeze({
      statuses: Object.freeze(statuses),
      currentStatus: row.factStatus,
      eventCount: lifecycleRows.length,
    }),
    causationClaimed: false,
    causationDisclaimer: STRATEGIC_MEMORY_CAUSATION_DISCLAIMER,
    attributionClaimed: false,
    attributionDisclaimer: STRATEGIC_MEMORY_ATTRIBUTION_DISCLAIMER,
  } satisfies StrategicMemoryProjection);
}
