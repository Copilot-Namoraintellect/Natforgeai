// ─── R7-A Conversion Outcome Intelligence — deterministic identity ───
//
// PURE module: tenant + business + canonical conversion + authoritative
// business-outcome evidence → outcomeKey → outcomeId; lifecycle fact identity;
// and the immutable-core evidence hash. Identity is server-derived only; the
// tenant and business are bound inside every hash so cross-tenant/cross-
// business collision or correlation is impossible. No wall-clock, no
// randomness — replaying the same authoritative inputs reproduces the same
// identity. No fuzzy matching. No I/O.

import { canonicalJson, sha256Hex } from "./outcome-contract";
import type { OutcomeLifecycleType, OutcomeStatus } from "./outcome-contract";

/** Prefixes make identities self-describing in logs and handoff envelopes. */
export const OUTCOME_ID_PREFIX = "out1:" as const;
export const OUTCOME_LIFECYCLE_ID_PREFIX = "obf1:" as const;

/**
 * outcomeKey: opaque 64-hex identity binding tenant + business + canonical
 * conversion + authoritative business-outcome evidence (source + identity).
 * tenantUserId/businessId inside the hash anchor the scope: identical upstream
 * evidence under a different tenant or business can never collide.
 */
export function deriveOutcomeKey(input: {
  tenantUserId: number;
  businessId: number;
  conversionId: string;
  evidenceSource: string;
  evidenceIdentity: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      conversionId: input.conversionId,
      evidenceSource: input.evidenceSource,
      evidenceIdentity: input.evidenceIdentity,
    })
  );
}

export function deriveOutcomeId(outcomeKey: string): string {
  return `${OUTCOME_ID_PREFIX}${outcomeKey}`;
}

/**
 * outcomeLifecycleEventId: deterministic identity for one lifecycle fact on an
 * outcome. Replays of the same provider/verification fact reproduce the same
 * id, so retries converge on one durable row.
 */
export function deriveOutcomeLifecycleKey(input: {
  outcomeId: string;
  lifecycleType: OutcomeLifecycleType;
  outcomeStatus: OutcomeStatus;
  amountMinor: number | null;
  currency: string | null;
  externalLifecycleId: string | null;
  occurredAt: string;
  reasonCode: string | null;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      outcomeId: input.outcomeId,
      lifecycleType: input.lifecycleType,
      outcomeStatus: input.outcomeStatus,
      amountMinor: input.amountMinor ?? null,
      currency: input.currency ?? null,
      externalLifecycleId: input.externalLifecycleId ?? null,
      occurredAt: input.occurredAt,
      reasonCode: input.reasonCode ?? null,
    })
  );
}

export function buildOutcomeLifecycleEventId(lifecycleKey: string): string {
  return `${OUTCOME_LIFECYCLE_ID_PREFIX}${lifecycleKey}`;
}

/**
 * Evidence hash: binds the immutable core of a business outcome. The hashed
 * fragment is rebuilt field-by-field — callers cannot smuggle extra keys into
 * the hash. Drift between a retained row and this hash is tampering evidence
 * and fails closed (OUTCOME_EVIDENCE_CONFLICT). No PII participates.
 */
export function deriveOutcomeEvidenceHash(input: {
  userId: number;
  businessId: number;
  leadId: number | null;
  leadIdentityVersion: string | null;
  conversionId: string;
  outcomeType: string;
  valueType: string;
  amountMinor: number | null;
  currency: string | null;
  quantity: number | null;
  metricUnit: string | null;
  evidenceSource: string;
  evidenceAuthority: string;
  evidenceIdentity: string;
  occurredAt: string;
  recordedAt: string;
  reversesOutcomeId: string | null;
  renewsOutcomeId: string | null;
  supersedesOutcomeId: string | null;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      userId: input.userId,
      businessId: input.businessId,
      leadId: input.leadId ?? null,
      leadIdentityVersion: input.leadIdentityVersion ?? null,
      conversionId: input.conversionId,
      outcomeType: input.outcomeType,
      valueType: input.valueType,
      amountMinor: input.amountMinor ?? null,
      currency: input.currency ?? null,
      quantity: input.quantity ?? null,
      metricUnit: input.metricUnit ?? null,
      evidenceSource: input.evidenceSource,
      evidenceAuthority: input.evidenceAuthority,
      evidenceIdentity: input.evidenceIdentity,
      occurredAt: input.occurredAt,
      recordedAt: input.recordedAt,
      reversesOutcomeId: input.reversesOutcomeId ?? null,
      renewsOutcomeId: input.renewsOutcomeId ?? null,
      supersedesOutcomeId: input.supersedesOutcomeId ?? null,
    })
  );
}
