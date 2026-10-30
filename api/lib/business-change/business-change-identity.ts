// ─── R8-B Business Change Intelligence — deterministic identity ───
//
// PURE module: tenant + business + subject + change type + previous/current
// state fingerprints → changeKey → changeId; lifecycle fact identity (bcl1:);
// compared-state fingerprints; and the immutable-core evidence hash. Identity
// is server-derived only; the tenant and business are bound inside every hash
// so cross-tenant/cross-business collision or correlation is impossible. No
// wall-clock, no randomness — replaying the same authoritative inputs
// reproduces the same identity. No fuzzy comparison. No I/O.

import { canonicalJson, sha256Hex } from "./business-change-contract";

/** Prefixes make identities self-describing in logs and handoff envelopes. */
export const BUSINESS_CHANGE_ID_PREFIX = "chg1:" as const;
export const BUSINESS_CHANGE_LIFECYCLE_ID_PREFIX = "bcl1:" as const;

/** Sentinel memory reference for a newly observed state not yet in memory. */
export const NO_MEMORY_SENTINEL = "mem0:none" as const;

/** Closed state-reference shape (contract §3.5). */
export interface BusinessChangeStateRef {
  authority: string;
  memoryId: string;
  sourceIdentity: string;
  sourceVersion: string;
  statementType: "FACT" | "ASSUMPTION";
  stateFingerprint: string;
}

export function canonicalStateRef(ref: BusinessChangeStateRef): string {
  return canonicalJson({
    authority: ref.authority,
    memoryId: ref.memoryId,
    sourceIdentity: ref.sourceIdentity,
    sourceVersion: ref.sourceVersion,
    statementType: ref.statementType,
    stateFingerprint: ref.stateFingerprint,
  });
}

/**
 * Compared-state fingerprint: binds the exact canonical-normalised state view
 * material (template + normalised fields) under its authority + identity +
 * frozen version. Representation-only differences never alter the
 * fingerprint (normalisation happens in the state-view builders), so trivial
 * representation drift can never mint a change. Drift between a retained row
 * and a recomputed fingerprint is tampering (CHANGE_EVIDENCE_CONFLICT).
 */
export function deriveStateFingerprint(input: {
  authority: string;
  identity: string;
  version: string;
  template: string;
  fields: Record<string, unknown>;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      authority: input.authority,
      identity: input.identity,
      version: input.version,
      template: input.template,
      fields: input.fields,
    })
  );
}

/**
 * Compared-state VALUE fingerprint: sha256 over the canonical-normalised
 * state view alone (template + normalised fields), independent of the
 * source authority/identity/version. Two observations of the same semantic
 * state through DIFFERENT source rows (e.g. a revert captured by a newer
 * snapshot) share this value fingerprint while their version-bound
 * fingerprints differ — it is the deterministic anchor for revert /
 * contradiction detection (contract §9.2). Identity and immutability always
 * use the version-bound fingerprint; this one never participates in identity.
 */
export function deriveStateValueFingerprint(template: string, fields: Record<string, unknown>): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      template,
      fields,
    })
  );
}

/**
 * changeKey: opaque 64-hex identity binding tenant + business + subject +
 * change type + previous/current authoritative state fingerprints.
 * tenantUserId/businessId inside the hash anchor the scope: identical compared
 * states under a different tenant or business can never collide.
 */
export function deriveChangeKey(input: {
  tenantUserId: number;
  businessId: number;
  subjectType: string;
  subjectId: string;
  changeType: string;
  previousStateFingerprint: string;
  currentStateFingerprint: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      changeType: input.changeType,
      previousStateFingerprint: input.previousStateFingerprint,
      currentStateFingerprint: input.currentStateFingerprint,
    })
  );
}

export function deriveChangeId(changeKey: string): string {
  return `${BUSINESS_CHANGE_ID_PREFIX}${changeKey}`;
}

/**
 * bcl1 lifecycle fact identity: deterministic over the exact fact material.
 * Replays of the same fact reproduce the same id, so retries converge on one
 * durable row.
 */
export function deriveChangeLifecycleKey(input: {
  changeId: string;
  lifecycleType: string;
  targetStatus: string;
  successorChangeId: string | null;
  sourceIdentity: string | null;
  occurredAt: string;
  reasonCode: string | null;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      changeId: input.changeId,
      lifecycleType: input.lifecycleType,
      targetStatus: input.targetStatus,
      successorChangeId: input.successorChangeId ?? null,
      sourceIdentity: input.sourceIdentity ?? null,
      occurredAt: input.occurredAt,
      reasonCode: input.reasonCode ?? null,
    })
  );
}

export function buildChangeLifecycleEventId(lifecycleKey: string): string {
  return `${BUSINESS_CHANGE_LIFECYCLE_ID_PREFIX}${lifecycleKey}`;
}

/**
 * Evidence hash: binds the immutable core of a business-change record. The
 * hashed fragment is rebuilt field-by-field — callers cannot smuggle extra
 * keys into the hash. `recordedAt`, `detectedAt` and `effectiveAt` (timing
 * provenance; for attestations effectiveAt defaults to acceptance time) are
 * deliberately excluded: re-observing the same compared states later must
 * converge as an idempotent replay, not conflict on clock drift. The
 * convergence anchor is exactly the compared before/after state pair plus
 * the bound classifications/source/lineage. Drift between a retained row
 * and this hash is tampering and fails closed (CHANGE_EVIDENCE_CONFLICT).
 */
export function deriveChangeEvidenceHash(input: {
  userId: number;
  businessId: number;
  changeDomain: string;
  changeType: string;
  subjectType: string;
  subjectId: string;
  previousStateRef: BusinessChangeStateRef;
  currentStateRef: BusinessChangeStateRef;
  evidenceRefs: string[];
  sourceAuthority: string;
  sourceVersion: string;
  significanceClass: string;
  confidenceClass: string;
  supersedesChangeId: string | null;
  limitations: string[];
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      userId: input.userId,
      businessId: input.businessId,
      changeDomain: input.changeDomain,
      changeType: input.changeType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      previousStateRef: canonicalStateRef(input.previousStateRef),
      currentStateRef: canonicalStateRef(input.currentStateRef),
      evidenceRefs: [...input.evidenceRefs].sort(),
      sourceAuthority: input.sourceAuthority,
      sourceVersion: input.sourceVersion,
      significanceClass: input.significanceClass,
      confidenceClass: input.confidenceClass,
      supersedesChangeId: input.supersedesChangeId ?? null,
      limitations: [...input.limitations].sort(),
    })
  );
}
