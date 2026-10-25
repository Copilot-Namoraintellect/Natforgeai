// ─── R6-E Conversion Tracking — deterministic identity ───
//
// PURE module: tenant + source system + external conversion id →
// conversionKey → conversionId, lifecycle
// event identity, and the immutable-core evidence hash. Identity is
// server-derived only; the tenant userId is bound inside every hash so
// cross-tenant collision/correlation is impossible. No wall-clock, no
// randomness — replaying the same authoritative inputs reproduces the same
// identity. No I/O.

import {
  canonicalJson,
  sha256Hex,
  type ConversionOutcomeStatus,
  type ConversionType,
} from "./conversion-contract";

/** Prefixes make identities self-describing in logs and handoff envelopes. */
export const CONVERSION_ID_PREFIX = "cnv1:" as const;
export const LIFECYCLE_EVENT_ID_PREFIX = "clf1:" as const;

/**
 * conversionKey: opaque 64-hex identity binding tenant + source system +
 * external conversion id. tenantUserId inside the hash anchors the tenant:
 * identical upstream evidence under a different tenant can never collide.
 */
export function deriveConversionKey(input: {
  tenantUserId: number;
  sourceSystem: string;
  externalConversionId: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      sourceSystem: input.sourceSystem,
      externalConversionId: input.externalConversionId,
    })
  );
}

export function deriveConversionId(conversionKey: string): string {
  return `${CONVERSION_ID_PREFIX}${conversionKey}`;
}

/**
 * lifecycleEventId: deterministic identity for one lifecycle fact on a
 * conversion. Replays of the same provider lifecycle event reproduce the same
 * id, so provider retries converge on one durable row.
 */
export function deriveLifecycleEventId(input: {
  conversionId: string;
  lifecycleType: string;
  outcomeStatus: ConversionOutcomeStatus;
  amount: number | null;
  currency: string | null;
  externalLifecycleId: string | null;
  occurredAt: string;
  reasonCode: string | null;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      conversionId: input.conversionId,
      lifecycleType: input.lifecycleType,
      outcomeStatus: input.outcomeStatus,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      externalLifecycleId: input.externalLifecycleId ?? null,
      occurredAt: input.occurredAt,
      reasonCode: input.reasonCode ?? null,
    })
  );
}

export function buildLifecycleEventId(lifecycleKey: string): string {
  return `${LIFECYCLE_EVENT_ID_PREFIX}${lifecycleKey}`;
}

/**
 * Evidence hash: binds the immutable core of a conversion event. The hashed
 * fragment is rebuilt field-by-field — callers cannot smuggle extra keys into
 * the hash. Drift between a retained row and this hash is tampering evidence
 * and fails closed (CONVERSION_EVIDENCE_CONFLICT). No PII participates.
 */
export function deriveEvidenceHash(input: {
  userId: number;
  businessId: number;
  leadId: number | null;
  leadIdentityVersion: string | null;
  externalConversionId: string;
  sourceSystem: string;
  conversionType: ConversionType;
  occurredAt: string;
  observedAt: string;
  amount: number | null;
  currency: string | null;
  sourceOpportunityId: string | null;
  sourceEngagementReceiptId: string | null;
  sourceSignalId: string | null;
  sourceCampaignId: number | null;
  sourcePublicationId: number | null;
  evidenceReference: string | null;
  reversesConversionId: string | null;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      userId: input.userId,
      businessId: input.businessId,
      leadId: input.leadId ?? null,
      leadIdentityVersion: input.leadIdentityVersion ?? null,
      externalConversionId: input.externalConversionId,
      sourceSystem: input.sourceSystem,
      conversionType: input.conversionType,
      occurredAt: input.occurredAt,
      observedAt: input.observedAt,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      sourceOpportunityId: input.sourceOpportunityId ?? null,
      sourceEngagementReceiptId: input.sourceEngagementReceiptId ?? null,
      sourceSignalId: input.sourceSignalId ?? null,
      sourceCampaignId: input.sourceCampaignId ?? null,
      sourcePublicationId: input.sourcePublicationId ?? null,
      evidenceReference: input.evidenceReference ?? null,
      reversesConversionId: input.reversesConversionId ?? null,
    })
  );
}
