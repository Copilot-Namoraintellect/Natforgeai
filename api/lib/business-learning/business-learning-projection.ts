// ─── R7-C Business Learning Engine — read-only projections ───
//
// PURE module (no I/O; the experiment projection takes an explicit clock for
// freshness). Projects durable learning rows into the frozen downstream
// views. Every projection carries the verbatim causation disclaimer:
// learning is association evidence, never causal proof. Downstream (R7-D /
// R7-E) may consume and must never mutate.

import type { BusinessLearningRecordRow, BusinessLearningLifecycleEventRow } from "@db/schema";
import {
  BUSINESS_LEARNING_CONTRACT_VERSION,
  BUSINESS_LEARNING_TO_EXPERIMENT_CONTRACT_VERSION,
  type LearningStatus,
} from "./business-learning-contract";
import type { LearningContextScope } from "./business-learning-context";

export const LEARNING_CAUSATION_DISCLAIMER =
  "Learning records are association evidence derived from governed outcomes and attributed journey activity. This projection does not assert that any subject caused any business outcome." as const;

// ─── Current learning projection (frozen record view) ───

export const LEARNING_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "learningId",
  "businessId",
  "learningType",
  "subjectType",
  "subjectId",
  "outcomeTypeFamily",
  "contextScope",
  "statement",
  "outcomeIds",
  "attributionIds",
  "supportCount",
  "contradictionCount",
  "confidenceClass",
  "evidenceClass",
  "noveltyClass",
  "status",
  "limitations",
  "sourceVersions",
  "validUntil",
  "supersedesLearningId",
  "derivedAt",
  "lifecycle",
  "causationClaimed",
  "causationDisclaimer",
] as const;

export type LearningProjectionKey = (typeof LEARNING_PROJECTION_FIELD_KEYS)[number];

export interface LearningProjection {
  readonly contractVersion: typeof BUSINESS_LEARNING_CONTRACT_VERSION;
  readonly learningId: string;
  readonly businessId: number;
  readonly learningType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcomeTypeFamily: string;
  readonly contextScope: LearningContextScope;
  readonly statement: unknown;
  readonly outcomeIds: readonly string[];
  readonly attributionIds: readonly string[];
  readonly supportCount: number;
  readonly contradictionCount: number;
  readonly confidenceClass: string;
  readonly evidenceClass: string;
  readonly noveltyClass: string;
  readonly status: LearningStatus;
  readonly limitations: readonly string[];
  readonly sourceVersions: Readonly<Record<string, string>>;
  readonly validUntil: string | null;
  readonly supersedesLearningId: string | null;
  readonly derivedAt: string;
  readonly lifecycle: {
    readonly statuses: readonly string[];
    readonly currentStatus: string;
    readonly eventCount: number;
  };
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
}

export function buildLearningProjection(
  row: BusinessLearningRecordRow,
  lifecycleRows: readonly BusinessLearningLifecycleEventRow[] = []
): LearningProjection {
  return Object.freeze({
    contractVersion: BUSINESS_LEARNING_CONTRACT_VERSION,
    learningId: row.learningId,
    businessId: Number(row.businessId),
    learningType: row.learningType,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    outcomeTypeFamily: row.outcomeTypeFamily,
    contextScope: row.contextScope as LearningContextScope,
    statement: row.statement,
    outcomeIds: Object.freeze([...(row.outcomeIds as string[])]),
    attributionIds: Object.freeze([...(row.attributionIds as string[])]),
    supportCount: Number(row.supportCount),
    contradictionCount: Number(row.contradictionCount),
    confidenceClass: row.confidenceClass,
    evidenceClass: row.evidenceClass,
    noveltyClass: row.noveltyClass,
    status: row.status as LearningStatus,
    limitations: Object.freeze([...(row.limitations as string[])]),
    sourceVersions: Object.freeze({ ...(row.sourceVersions as Record<string, string>) }),
    validUntil: row.validUntil ?? null,
    supersedesLearningId: row.supersedesLearningId ?? null,
    derivedAt: row.derivedAt,
    lifecycle: Object.freeze({
      statuses: Object.freeze(lifecycleRows.map((fact) => fact.status)),
      currentStatus: row.status,
      eventCount: lifecycleRows.length,
    }),
    causationClaimed: false,
    causationDisclaimer: LEARNING_CAUSATION_DISCLAIMER,
  } satisfies LearningProjection);
}

/**
 * Current record per (learningType, subjectType, subjectId): the latest
 * non-SUPERSEDED / non-DEPRECATED record, contradictions resolved to the
 * newest direction-bearing record (contract §9).
 */
export function resolveCurrentLearningRecord(
  records: readonly BusinessLearningRecordRow[]
): BusinessLearningRecordRow | null {
  const candidates = records.filter((r) => r.status !== "SUPERSEDED" && r.status !== "DEPRECATED");
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => {
    if (a.derivedAt !== b.derivedAt) return a.derivedAt < b.derivedAt ? -1 : 1;
    return Number(a.id) - Number(b.id);
  }).slice(-1)[0];
}

// ─── Experiment / optimisation projection (frozen downstream view) ───

export const BUSINESS_LEARNING_EXPERIMENT_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "learningId",
  "businessId",
  "learningType",
  "subjectType",
  "subjectId",
  "outcomeTypeFamily",
  "contextScope",
  "confidenceClass",
  "evidenceClass",
  "supportCount",
  "contradictionCount",
  "noveltyClass",
  "status",
  "outcomeIds",
  "attributionIds",
  "limitations",
  "derivedAt",
  "validUntil",
  "freshness",
  "governanceAuthorityRequired",
  "causationClaimed",
  "causationDisclaimer",
] as const;

export type BusinessLearningExperimentProjectionKey =
  (typeof BUSINESS_LEARNING_EXPERIMENT_PROJECTION_FIELD_KEYS)[number];

export interface LearningFreshness {
  readonly stale: boolean;
  readonly provisional: boolean;
  readonly contradictionUnresolved: boolean;
}

export interface BusinessLearningExperimentProjection {
  readonly contractVersion: typeof BUSINESS_LEARNING_TO_EXPERIMENT_CONTRACT_VERSION;
  readonly learningId: string;
  readonly businessId: number;
  readonly learningType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcomeTypeFamily: string;
  readonly contextScope: LearningContextScope;
  readonly confidenceClass: string;
  readonly evidenceClass: string;
  readonly supportCount: number;
  readonly contradictionCount: number;
  readonly noveltyClass: string;
  readonly status: LearningStatus;
  readonly outcomeIds: readonly string[];
  readonly attributionIds: readonly string[];
  readonly limitations: readonly string[];
  readonly derivedAt: string;
  readonly validUntil: string | null;
  readonly freshness: LearningFreshness;
  readonly governanceAuthorityRequired: "R7-F";
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
}

/** Learning freshness horizon (policy constant, snapshot at projection). */
export const LEARNING_FRESHNESS_DAYS = 90 as const;

function isStale(row: BusinessLearningRecordRow, nowMs: number): boolean {
  if (row.validUntil !== null && row.validUntil !== undefined) {
    const untilMs = Date.parse(row.validUntil);
    if (!Number.isNaN(untilMs) && untilMs < nowMs) return true;
  }
  const derivedMs = Date.parse(row.derivedAt);
  if (Number.isNaN(derivedMs)) return true;
  return nowMs - derivedMs > LEARNING_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Builds the frozen read-only projection consumed by R7-D experimentation
 * and R7-E optimisation. `freshness` is governance-eligibility metadata for
 * R7-F policies — it narrows nothing and widens nothing; downstream must
 * separately obtain R7-F authority before any material action.
 */
export function buildExperimentOptimisationProjection(
  row: BusinessLearningRecordRow,
  now: Date
): BusinessLearningExperimentProjection {
  const nowMs = now.getTime();
  const freshness: LearningFreshness = Object.freeze({
    stale: isStale(row, nowMs),
    provisional: row.evidenceClass === "PROVISIONAL" || row.evidenceClass === "MIXED",
    contradictionUnresolved: row.status === "CONTRADICTED" || Number(row.contradictionCount) > 0,
  });
  return Object.freeze({
    contractVersion: BUSINESS_LEARNING_TO_EXPERIMENT_CONTRACT_VERSION,
    learningId: row.learningId,
    businessId: Number(row.businessId),
    learningType: row.learningType,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    outcomeTypeFamily: row.outcomeTypeFamily,
    contextScope: row.contextScope as LearningContextScope,
    confidenceClass: row.confidenceClass,
    evidenceClass: row.evidenceClass,
    supportCount: Number(row.supportCount),
    contradictionCount: Number(row.contradictionCount),
    noveltyClass: row.noveltyClass,
    status: row.status as LearningStatus,
    outcomeIds: Object.freeze([...(row.outcomeIds as string[])]),
    attributionIds: Object.freeze([...(row.attributionIds as string[])]),
    limitations: Object.freeze([...(row.limitations as string[])]),
    derivedAt: row.derivedAt,
    validUntil: row.validUntil ?? null,
    freshness,
    governanceAuthorityRequired: "R7-F",
    causationClaimed: false,
    causationDisclaimer: LEARNING_CAUSATION_DISCLAIMER,
  } satisfies BusinessLearningExperimentProjection);
}
