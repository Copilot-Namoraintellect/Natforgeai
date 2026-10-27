// ─── R6-E Conversion Tracking — R7 attribution projection ───
//
// PURE module: projects a durable conversion row + its lifecycle rows into the
// frozen conversion-to-attribution/v1 view consumed downstream (R7). The
// projection exposes value as EITHER verified (financial-authority trust
// classes) OR reported (everything else) — never both — and carries provenance
// lineage only. It NEVER asserts causation: no attributedCampaignId, no
// attributionScore, no causal field. No I/O, no clock.

import {
  CONVERSION_PROJECTION_CONTRACT_VERSION,
  type ConversionOutcomeStatus,
  type ConversionTrustClass,
} from "./conversion-contract";
import { isFinancialAuthorityTrustClass } from "./conversion-trust";
import { currencyExponent } from "./conversion-value";
import type {
  ConversionEventRow,
  ConversionLifecycleEventRow,
} from "@db/schema";

/** Exact top-level key allowlist of the R7 projection (asserted in tests). */
export const PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "conversionId",
  "businessId",
  "leadId",
  "leadIdentityVersion",
  "conversionType",
  "occurredAt",
  "observedAt",
  "outcomeStatus",
  "sourceSystem",
  "sourceTrustClass",
  "reportedAmount",
  "reportedCurrency",
  "verifiedAmount",
  "verifiedCurrency",
  "currencyExponent",
  "reversesConversionId",
  "provenance",
  "lifecycle",
  "evidenceReference",
  "causationClaimed",
  "causationDisclaimer",
] as const;

export type R7ProjectionKey = (typeof PROJECTION_FIELD_KEYS)[number];

export function getR7ProjectionKeys(): readonly R7ProjectionKey[] {
  return PROJECTION_FIELD_KEYS;
}

export interface R7ConversionProjection {
  readonly contractVersion: typeof CONVERSION_PROJECTION_CONTRACT_VERSION;
  readonly conversionId: string;
  readonly businessId: number;
  readonly leadId: number | null;
  readonly leadIdentityVersion: string | null;
  readonly conversionType: string;
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly outcomeStatus: string;
  readonly sourceSystem: string;
  readonly sourceTrustClass: string;
  readonly reportedAmount: number | null;
  readonly reportedCurrency: string | null;
  readonly verifiedAmount: number | null;
  readonly verifiedCurrency: string | null;
  readonly currencyExponent: number | null;
  readonly reversesConversionId: string | null;
  readonly provenance: {
    readonly sourceOpportunityId: string | null;
    readonly sourceEngagementReceiptId: string | null;
    readonly sourceSignalId: string | null;
    readonly sourceCampaignId: number | null;
    readonly sourcePublicationId: number | null;
  };
  readonly lifecycle: {
    readonly statuses: readonly ConversionOutcomeStatus[];
    readonly currentStatus: string;
    readonly eventCount: number;
  };
  readonly evidenceReference: null;
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
}

export const CAUSATION_DISCLAIMER =
  "Provenance lineage only. This projection does not assert that any campaign, publication, opportunity or engagement caused this conversion." as const;

/**
 * Build the frozen R7 projection. Monetary value is verified only for
 * financial-authority trust classes; otherwise it is reported
 * (non-authoritative) only. `leadId`/`leadIdentityVersion` are exposed only
 * where an authoritative server-verified linkage exists (null otherwise) and
 * `reversesConversionId` carries reversal lineage — references only, never
 * causation. `evidenceReference` stays internal to the evidence row.
 */
export function buildR7ConversionProjection(
  row: ConversionEventRow,
  lifecycleRows: readonly ConversionLifecycleEventRow[] = []
): R7ConversionProjection {
  const authoritative = isFinancialAuthorityTrustClass(
    row.sourceTrustClass as ConversionTrustClass
  );
  const amount = row.amount === null || row.amount === undefined ? null : Number(row.amount);
  const currency = row.currency ?? null;

  return Object.freeze({
    contractVersion: CONVERSION_PROJECTION_CONTRACT_VERSION,
    conversionId: row.conversionId,
    businessId: Number(row.businessId),
    leadId: row.leadId === null || row.leadId === undefined ? null : Number(row.leadId),
    leadIdentityVersion: row.leadIdentityVersion ?? null,
    conversionType: row.conversionType,
    occurredAt: row.occurredAt,
    observedAt: row.observedAt,
    outcomeStatus: row.outcomeStatus,
    sourceSystem: row.sourceSystem,
    sourceTrustClass: row.sourceTrustClass,
    reportedAmount: authoritative ? null : amount,
    reportedCurrency: authoritative ? null : currency,
    verifiedAmount: authoritative ? amount : null,
    verifiedCurrency: authoritative ? currency : null,
    currencyExponent: currencyExponent(currency),
    reversesConversionId: row.reversesConversionId ?? null,
    provenance: Object.freeze({
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
    }),
    lifecycle: Object.freeze({
      statuses: Object.freeze(
        lifecycleRows.map((lifecycle) => lifecycle.outcomeStatus as ConversionOutcomeStatus)
      ),
      currentStatus: row.outcomeStatus,
      eventCount: lifecycleRows.length,
    }),
    evidenceReference: null,
    causationClaimed: false,
    causationDisclaimer: CAUSATION_DISCLAIMER,
  });
}
