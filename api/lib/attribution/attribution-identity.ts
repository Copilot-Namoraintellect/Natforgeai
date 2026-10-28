// ─── R7-B Attribution Intelligence — deterministic identity ───
//
// PURE module (no I/O, no clock). Attribution identity is a pure function of
// the authoritative calculation material — no wall-clock, no randomness.
// Identity inputs bind the tenant inside the hash so cross-tenant correlation
// is impossible. `calculatedAt` is provenance only and never participates in
// any identity or integrity hash (replaying identical material at a different
// time converges to the same durable row).

import { canonicalJson, sha256Hex, type AttributionTouchpoint } from "./attribution-contract";

export const ATTRIBUTION_ID_PREFIX = "atr1:" as const;

/**
 * Fingerprint of the eligible touchpoint set: one canonical entry per
 * touchpoint over (type, sourceIdentity, occurredAt, creditBps). This is the
 * exact-once natural-anchor component that lets new evidence mint a new
 * result (new journeyHash) rather than collide with history.
 */
export function deriveJourneyHash(touchpoints: readonly AttributionTouchpoint[]): string {
  const entries = touchpoints.map((t) => ({
    type: t.type,
    sourceIdentity: t.sourceIdentity,
    occurredAt: t.occurredAt,
    creditBps: t.creditBps,
  }));
  return sha256Hex(canonicalJson({ v: 1, touchpoints: entries }));
}

export interface AttributionIdentityInput {
  readonly tenantUserId: number;
  readonly businessId: number;
  readonly outcomeId: string;
  readonly modelType: string;
  readonly modelVersion: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly journeyHash: string;
  readonly totalCreditBps: number;
  readonly confidenceClass: string;
  readonly evidenceClass: string;
  readonly outcomeStatus: string;
  readonly policyVersion: string;
}

/**
 * Deterministic attribution identity over the full calculation material.
 * The same material always yields the same identity; any truthful change
 * (new evidence, new model/policy version, new outcome state) yields a new
 * identity (and therefore a new, supersession-linked result).
 */
export function deriveAttributionKey(input: AttributionIdentityInput): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      outcomeId: input.outcomeId,
      modelType: input.modelType,
      modelVersion: input.modelVersion,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      journeyHash: input.journeyHash,
      totalCreditBps: input.totalCreditBps,
      confidenceClass: input.confidenceClass,
      evidenceClass: input.evidenceClass,
      outcomeStatus: input.outcomeStatus,
      policyVersion: input.policyVersion,
    })
  );
}

export function toAttributionId(attributionKey: string): string {
  return `${ATTRIBUTION_ID_PREFIX}${attributionKey}`;
}

/** Deterministic touchpoint id: stable per (type, sourceIdentity). */
export function deriveTouchpointId(type: string, sourceIdentity: string): string {
  const digest = sha256Hex(canonicalJson({ v: 1, type, sourceIdentity })).slice(0, 24);
  return `tpp:${type.toLowerCase()}:${digest}`;
}

/**
 * sha256 over the canonical immutable core of a persisted attribution result.
 * Every material column participates except the serial PK and createdAt.
 * Drift between a retained row and this hash is tampering and fails closed on
 * every read (ATTRIBUTION_EVIDENCE_CONFLICT).
 */
export function deriveRecordHash(row: {
  attributionId: string;
  attributionKey: string;
  userId: number;
  businessId: number;
  outcomeId: string;
  leadId: number | null;
  leadIdentityVersion: string | null;
  conversionId: string;
  outcomeType: string;
  outcomeStatus: string;
  outcomeAmountMinor: number | null;
  outcomeCurrency: string | null;
  modelType: string;
  modelVersion: string;
  windowStart: string;
  windowEnd: string;
  journeyHash: string;
  touchpoints: unknown;
  excludedTouchpoints: unknown;
  totalCreditBps: number;
  confidenceClass: string;
  evidenceClass: string;
  policyVersion: string;
  sourceVersions: unknown;
  supersedesAttributionId: string | null;
  calculatedAt: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      attributionId: row.attributionId,
      attributionKey: row.attributionKey,
      userId: row.userId,
      businessId: row.businessId,
      outcomeId: row.outcomeId,
      leadId: row.leadId,
      leadIdentityVersion: row.leadIdentityVersion,
      conversionId: row.conversionId,
      outcomeType: row.outcomeType,
      outcomeStatus: row.outcomeStatus,
      outcomeAmountMinor: row.outcomeAmountMinor,
      outcomeCurrency: row.outcomeCurrency,
      modelType: row.modelType,
      modelVersion: row.modelVersion,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      journeyHash: row.journeyHash,
      touchpoints: row.touchpoints,
      excludedTouchpoints: row.excludedTouchpoints,
      totalCreditBps: row.totalCreditBps,
      confidenceClass: row.confidenceClass,
      evidenceClass: row.evidenceClass,
      policyVersion: row.policyVersion,
      sourceVersions: row.sourceVersions,
      supersedesAttributionId: row.supersedesAttributionId,
      calculatedAt: row.calculatedAt,
    })
  );
}
