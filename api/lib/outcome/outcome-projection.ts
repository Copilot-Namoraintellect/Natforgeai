// ─── R7-A Conversion Outcome Intelligence — R7-B/R7-C read-only projection ───
//
// PURE module: projects a durable business outcome row + its lifecycle rows
// into the frozen conversion-outcome/v1 view consumed downstream (R7-B
// attribution, R7-C learning). The projection exposes outcome identity,
// classification, current lifecycle state, verified/provisional value with
// currency, lineage, and evidence provenance. It NEVER asserts causation or
// attribution: both are disclaimed verbatim on every projection. Downstream
// must not mutate R7-A authority — all projected fields are read-only views of
// immutable rows. No I/O, no clock.

import {
  OUTCOME_PROJECTION_CONTRACT_VERSION,
  type OutcomeStatus,
} from "./outcome-contract";
import { outcomeCurrencyExponent } from "./outcome-value";
import type {
  BusinessOutcomeRow,
  BusinessOutcomeLifecycleEventRow,
} from "@db/schema";

/** Exact top-level key allowlist of the downstream projection (asserted in tests). */
export const OUTCOME_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "outcomeId",
  "businessId",
  "leadId",
  "leadIdentityVersion",
  "conversionId",
  "outcomeType",
  "outcomeStatus",
  "valueType",
  "amountMinor",
  "currency",
  "currencyExponent",
  "quantity",
  "metricUnit",
  "evidenceSource",
  "evidenceAuthority",
  "evidenceIdentity",
  "evidenceHash",
  "occurredAt",
  "recordedAt",
  "reversesOutcomeId",
  "renewsOutcomeId",
  "supersedesOutcomeId",
  "lifecycle",
  "causationClaimed",
  "causationDisclaimer",
  "attributionClaimed",
  "attributionDisclaimer",
] as const;

export type OutcomeProjectionKey = (typeof OUTCOME_PROJECTION_FIELD_KEYS)[number];

export function getOutcomeProjectionKeys(): readonly OutcomeProjectionKey[] {
  return OUTCOME_PROJECTION_FIELD_KEYS;
}

export interface OutcomeProjection {
  readonly contractVersion: typeof OUTCOME_PROJECTION_CONTRACT_VERSION;
  readonly outcomeId: string;
  readonly businessId: number;
  readonly leadId: number | null;
  readonly leadIdentityVersion: string | null;
  readonly conversionId: string;
  readonly outcomeType: string;
  readonly outcomeStatus: string;
  readonly valueType: string;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly currencyExponent: number | null;
  readonly quantity: number | null;
  readonly metricUnit: string | null;
  readonly evidenceSource: string;
  readonly evidenceAuthority: string;
  readonly evidenceIdentity: string;
  readonly evidenceHash: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly reversesOutcomeId: string | null;
  readonly renewsOutcomeId: string | null;
  readonly supersedesOutcomeId: string | null;
  readonly lifecycle: {
    readonly statuses: readonly OutcomeStatus[];
    readonly currentStatus: string;
    readonly eventCount: number;
  };
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
  readonly attributionClaimed: false;
  readonly attributionDisclaimer: string;
}

export const OUTCOME_CAUSATION_DISCLAIMER =
  "Outcome evidence only. This projection does not assert that any campaign, publication, opportunity, engagement or marketing activity caused this business outcome." as const;

export const OUTCOME_ATTRIBUTION_DISCLAIMER =
  "Outcome evidence does not imply attribution. Credit allocation, causal scores and channel weights are R7-B derivations on their own authority, never derived from this projection's fields." as const;

/**
 * Build the frozen downstream projection of one business outcome. Current
 * status is the row's CAS-guarded status; the lifecycle summary exposes the
 * immutable fact history. No causal or attribution field exists.
 */
export function buildOutcomeProjection(
  row: BusinessOutcomeRow,
  lifecycleRows: readonly BusinessOutcomeLifecycleEventRow[] = []
): OutcomeProjection {
  const amountMinor =
    row.amountMinor === null || row.amountMinor === undefined ? null : Number(row.amountMinor);
  const currency = row.currency ?? null;

  return Object.freeze({
    contractVersion: OUTCOME_PROJECTION_CONTRACT_VERSION,
    outcomeId: row.outcomeId,
    businessId: Number(row.businessId),
    leadId: row.leadId === null || row.leadId === undefined ? null : Number(row.leadId),
    leadIdentityVersion: row.leadIdentityVersion ?? null,
    conversionId: row.conversionId,
    outcomeType: row.outcomeType,
    outcomeStatus: row.outcomeStatus,
    valueType: row.valueType,
    amountMinor,
    currency,
    currencyExponent: outcomeCurrencyExponent(currency),
    quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
    metricUnit: row.metricUnit ?? null,
    evidenceSource: row.evidenceSource,
    evidenceAuthority: row.evidenceAuthority,
    evidenceIdentity: row.evidenceIdentity,
    evidenceHash: row.evidenceHash,
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    reversesOutcomeId: row.reversesOutcomeId ?? null,
    renewsOutcomeId: row.renewsOutcomeId ?? null,
    supersedesOutcomeId: row.supersedesOutcomeId ?? null,
    lifecycle: Object.freeze({
      statuses: Object.freeze(
        lifecycleRows.map((fact) => fact.outcomeStatus as OutcomeStatus)
      ),
      currentStatus: row.outcomeStatus,
      eventCount: lifecycleRows.length,
    }),
    causationClaimed: false,
    causationDisclaimer: OUTCOME_CAUSATION_DISCLAIMER,
    attributionClaimed: false,
    attributionDisclaimer: OUTCOME_ATTRIBUTION_DISCLAIMER,
  });
}
