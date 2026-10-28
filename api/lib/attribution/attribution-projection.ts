// ─── R7-B Attribution Intelligence — downstream learning projection ───
//
// PURE module (no I/O, no clock). Projects one durable attribution result
// into the frozen attribution-to-learning/v1 view consumed by R7-C. Read-only:
// R7-C may consume ids, outcome reference, model/version, allocated credit,
// confidence/evidence class, lineage, and calculation time — and must never
// mutate R7-B authority. Every projection carries the verbatim causation
// disclaimer: allocated credit is association evidence, not causal proof.

import type { AttributionResultRow } from "@db/schema";
import {
  ATTRIBUTION_CAUSATION_DISCLAIMER,
  ATTRIBUTION_LEARNING_CONTRACT_VERSION,
  type AttributionExcludedTouchpoint,
  type AttributionTouchpoint,
} from "./attribution-contract";

/** Exact top-level key allowlist of the downstream projection (asserted in tests). */
export const ATTRIBUTION_LEARNING_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "attributionId",
  "outcomeId",
  "outcomeStatus",
  "outcomeType",
  "businessId",
  "leadId",
  "conversionId",
  "modelType",
  "modelVersion",
  "windowStart",
  "windowEnd",
  "touchpoints",
  "excludedTouchpoints",
  "totalCreditBps",
  "confidenceClass",
  "evidenceClass",
  "policyVersion",
  "sourceVersions",
  "supersedesAttributionId",
  "journeyHash",
  "calculatedAt",
  "causationClaimed",
  "causationDisclaimer",
  "attributionClaimed",
] as const;

export type AttributionLearningProjectionKey =
  (typeof ATTRIBUTION_LEARNING_PROJECTION_FIELD_KEYS)[number];

export interface AttributionLearningProjection {
  readonly contractVersion: typeof ATTRIBUTION_LEARNING_CONTRACT_VERSION;
  readonly attributionId: string;
  readonly outcomeId: string;
  readonly outcomeStatus: string;
  readonly outcomeType: string;
  readonly businessId: number;
  readonly leadId: number | null;
  readonly conversionId: string;
  readonly modelType: string;
  readonly modelVersion: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly touchpoints: readonly AttributionTouchpoint[];
  readonly excludedTouchpoints: readonly AttributionExcludedTouchpoint[];
  readonly totalCreditBps: number;
  readonly confidenceClass: string;
  readonly evidenceClass: string;
  readonly policyVersion: string;
  readonly sourceVersions: unknown;
  readonly supersedesAttributionId: string | null;
  readonly journeyHash: string;
  readonly calculatedAt: string;
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
  readonly attributionClaimed: true;
}

/** Build the frozen downstream projection of one attribution result. */
export function buildAttributionLearningProjection(
  row: AttributionResultRow
): AttributionLearningProjection {
  return Object.freeze({
    contractVersion: ATTRIBUTION_LEARNING_CONTRACT_VERSION,
    attributionId: row.attributionId,
    outcomeId: row.outcomeId,
    outcomeStatus: row.outcomeStatus,
    outcomeType: row.outcomeType,
    businessId: Number(row.businessId),
    leadId: row.leadId === null || row.leadId === undefined ? null : Number(row.leadId),
    conversionId: row.conversionId,
    modelType: row.modelType,
    modelVersion: row.modelVersion,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    touchpoints: Object.freeze(
      ((row.touchpoints ?? []) as AttributionTouchpoint[]).map((t) => Object.freeze(t))
    ),
    excludedTouchpoints: Object.freeze(
      ((row.excludedTouchpoints ?? []) as AttributionExcludedTouchpoint[]).map((t) =>
        Object.freeze(t)
      )
    ),
    totalCreditBps: Number(row.totalCreditBps),
    confidenceClass: row.confidenceClass,
    evidenceClass: row.evidenceClass,
    policyVersion: row.policyVersion,
    sourceVersions: row.sourceVersions,
    supersedesAttributionId: row.supersedesAttributionId ?? null,
    journeyHash: row.journeyHash,
    calculatedAt: row.calculatedAt,
    causationClaimed: false,
    causationDisclaimer: ATTRIBUTION_CAUSATION_DISCLAIMER,
    attributionClaimed: true,
  } satisfies AttributionLearningProjection);
}
