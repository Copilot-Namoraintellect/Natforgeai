// ─── R8-C Market & External Signal Intelligence — downstream projection (C8) ───
//
// PURE builder for the read-only external-signal/v1 projection consumed by
// R8-D strategic reasoning and R8-E opportunity/risk intelligence. The key
// allowlist is FROZEN — consumers may rebuild projections from durable rows
// but must never extend the allowlist. Every projection carries verbatim
// causation + attribution disclaimers; a signal is evidence, never authority.

import type { ExternalSignalRow } from "@db/schema";
import {
  MARKET_SIGNAL_ATTRIBUTION_DISCLAIMER,
  MARKET_SIGNAL_CAUSATION_DISCLAIMER,
  MARKET_SIGNAL_PROJECTION_VERSION,
  MarketSignalInputError,
} from "./market-signal-contract";

/** Exact projection field allowlist (asserted in acceptance). */
export const EXTERNAL_SIGNAL_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "signalId",
  "businessId",
  "signalType",
  "subjectType",
  "subjectRef",
  "claimAspect",
  "sourceId",
  "sourceType",
  "sourceUriRef",
  "sourceRegistryClass",
  "sourceTrustClass",
  "confidenceClass",
  "freshnessClass",
  "freshnessPolicyVersion",
  "corroborationStatus",
  "corroboratingSignalIds",
  "contradictingSignalIds",
  "contradictedBySignalIds",
  "relevanceClass",
  "relevanceEvidence",
  "signalStatus",
  "observedAt",
  "publishedAt",
  "ingestedAt",
  "supersedesSignalId",
  "supersededBySignalId",
  "contentIsolation",
  "injectionSuspected",
  "limitations",
  "modelAssistance",
  "causationClaimed",
  "causationDisclaimer",
  "attributionClaimed",
  "attributionDisclaimer",
] as const;

export type ExternalSignalProjectionKey = (typeof EXTERNAL_SIGNAL_PROJECTION_FIELD_KEYS)[number];

export interface ExternalSignalProjection {
  readonly contractVersion: typeof MARKET_SIGNAL_PROJECTION_VERSION;
  readonly signalId: string;
  readonly businessId: number;
  readonly signalType: string;
  readonly subjectType: string;
  readonly subjectRef: string;
  readonly claimAspect: string;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly sourceUriRef: string;
  readonly sourceRegistryClass: string;
  readonly sourceTrustClass: string;
  readonly confidenceClass: string;
  readonly freshnessClass: string;
  readonly freshnessPolicyVersion: string;
  readonly corroborationStatus: string;
  readonly corroboratingSignalIds: readonly string[];
  readonly contradictingSignalIds: readonly string[];
  readonly contradictedBySignalIds: readonly string[];
  readonly relevanceClass: string;
  readonly relevanceEvidence: unknown;
  readonly signalStatus: string;
  readonly observedAt: string;
  readonly publishedAt: string | null;
  readonly ingestedAt: string;
  readonly supersedesSignalId: string | null;
  readonly supersededBySignalId: string | null;
  readonly contentIsolation: string;
  readonly injectionSuspected: boolean;
  readonly limitations: readonly string[];
  readonly modelAssistance: unknown;
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
  readonly attributionClaimed: false;
  readonly attributionDisclaimer: string;
}

export interface ExternalSignalProjectionContext {
  /** Signals in the same claim family that contradict this one (visible both ways). */
  readonly contradictedBySignalIds: readonly string[];
  /** The signal that superseded this one (null when current). */
  readonly supersededBySignalId: string | null;
}

/**
 * Build the frozen external-signal/v1 projection from one durable row +
 * lineage context. Read-only: no field is ever client-mutable, and causation /
 * attribution are disclaimed verbatim on every projection.
 */
export function buildExternalSignalProjection(
  row: ExternalSignalRow,
  ctx: ExternalSignalProjectionContext
): ExternalSignalProjection {
  return {
    contractVersion: MARKET_SIGNAL_PROJECTION_VERSION,
    signalId: row.signalId,
    businessId: Number(row.businessId),
    signalType: row.signalType,
    subjectType: row.subjectType,
    subjectRef: row.subjectRef,
    claimAspect: row.claimAspect,
    sourceId: row.sourceId,
    sourceType: row.sourceType,
    sourceUriRef: row.sourceUriRef,
    sourceRegistryClass: row.registryClass,
    sourceTrustClass: row.sourceTrustClass,
    confidenceClass: row.confidenceClass,
    freshnessClass: row.freshnessClass,
    freshnessPolicyVersion: row.freshnessPolicyVersion,
    corroborationStatus: row.corroborationStatus,
    corroboratingSignalIds: (row.corroboratingSignalIds as string[]) ?? [],
    contradictingSignalIds: (row.contradictingSignalIds as string[]) ?? [],
    contradictedBySignalIds: [...ctx.contradictedBySignalIds],
    relevanceClass: row.relevanceClass,
    relevanceEvidence: row.relevanceEvidence,
    signalStatus: row.signalStatus,
    observedAt: row.observedAt,
    publishedAt: row.publishedAt ?? null,
    ingestedAt: row.ingestedAt,
    supersedesSignalId: row.supersedesSignalId ?? null,
    supersededBySignalId: ctx.supersededBySignalId,
    contentIsolation: row.contentIsolation,
    injectionSuspected: row.injectionSuspected === "true",
    limitations: (row.limitations as string[]) ?? [],
    modelAssistance: row.modelAssistance ?? null,
    causationClaimed: false,
    causationDisclaimer: MARKET_SIGNAL_CAUSATION_DISCLAIMER,
    attributionClaimed: false,
    attributionDisclaimer: MARKET_SIGNAL_ATTRIBUTION_DISCLAIMER,
  };
}

/**
 * Validate a consumed projection at a downstream seam: exact key allowlist +
 * frozen version + verbatim disclaimers + non-authority invariants. Unknown or
 * missing keys fail closed (MARKET_SIGNAL_PROJECTION_VERSION_UNSUPPORTED).
 */
export function validateExternalSignalProjection(projection: unknown): ExternalSignalProjection {
  if (typeof projection !== "object" || projection === null) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_PROJECTION_VERSION_UNSUPPORTED",
      "external-signal projection must be an object."
    );
  }
  const record = projection as Record<string, unknown>;
  if (record.contractVersion !== MARKET_SIGNAL_PROJECTION_VERSION) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_PROJECTION_VERSION_UNSUPPORTED",
      `external-signal projection version ${String(record.contractVersion)} is not supported.`
    );
  }
  const keys = Object.keys(record);
  const allowed = new Set<string>(EXTERNAL_SIGNAL_PROJECTION_FIELD_KEYS);
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new MarketSignalInputError(
        "MARKET_SIGNAL_PROJECTION_VERSION_UNSUPPORTED",
        `external-signal projection carries unknown field "${key}".`
      );
    }
  }
  for (const key of EXTERNAL_SIGNAL_PROJECTION_FIELD_KEYS) {
    if (!(key in record)) {
      throw new MarketSignalInputError(
        "MARKET_SIGNAL_PROJECTION_VERSION_UNSUPPORTED",
        `external-signal projection is missing field "${key}".`
      );
    }
  }
  if (record.causationClaimed !== false || record.attributionClaimed !== false) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_PROJECTION_VERSION_UNSUPPORTED",
      "external-signal projection must never claim causation or attribution."
    );
  }
  if (
    record.causationDisclaimer !== MARKET_SIGNAL_CAUSATION_DISCLAIMER ||
    record.attributionDisclaimer !== MARKET_SIGNAL_ATTRIBUTION_DISCLAIMER
  ) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_PROJECTION_VERSION_UNSUPPORTED",
      "external-signal projection disclaimers drifted from the frozen verbatim text."
    );
  }
  return record as unknown as ExternalSignalProjection;
}
