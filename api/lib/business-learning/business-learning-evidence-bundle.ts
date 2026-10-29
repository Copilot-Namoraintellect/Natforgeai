// ─── R7-C Business Learning Engine — deterministic evidence bundle ───
//
// PURE module (no I/O, no clock). An evidence bundle binds the exact source
// authorities a learning record is reproducible from: canonical outcome ids,
// canonical attribution ids, the tenant + business scope, the consumed
// source contract versions, and the upstream integrity hashes. The same
// authoritative evidence set always yields the same evidenceBundleId; no raw
// evidence text, secrets or PII ever enters the hash.

import {
  canonicalJson,
  sha256Hex,
  EVIDENCE_BUNDLE_ID_PATTERN,
  LearningIdentityConflictError,
  type LearningError,
} from "./business-learning-contract";
import type {
  ConsumedAttributionProjection,
  ConsumedOutcomeProjection,
} from "./business-learning-upstream-seam";

/** Canonical evidence-bundle identity material (§4 of the contract). */
export interface LearningEvidenceBundle {
  readonly evidenceBundleId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly outcomeIds: readonly string[];
  readonly attributionIds: readonly string[];
  readonly sourceVersions: Readonly<Record<string, string>>;
  readonly outcomeFingerprints: readonly string[];
  readonly attributionFingerprints: readonly string[];
  readonly bundleFingerprint: string;
}

export const EVIDENCE_BUNDLE_ID_PREFIX = "evb1:" as const;

/** Sorted copy — bundle identity is order-insensitive over id sets. */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Deterministic evidence-bundle identity over the validated source
 * authorities. Tenant and business are bound inside the hash: identical
 * upstream evidence under a different tenant or business is a different
 * bundle, never a duplicate.
 */
export function buildEvidenceBundle(input: {
  userId: number;
  businessId: number;
  outcomes: readonly ConsumedOutcomeProjection[];
  attributions: readonly ConsumedAttributionProjection[];
  sourceVersions: Readonly<Record<string, string>>;
}): LearningEvidenceBundle {
  const outcomeIds = sortedUnique(input.outcomes.map((o) => o.outcomeId));
  const attributionIds = sortedUnique(input.attributions.map((a) => a.attributionId));

  const evidenceBundleKey = sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.userId,
      businessId: input.businessId,
      outcomeIds,
      attributionIds,
      sourceVersions: input.sourceVersions,
    })
  );

  // Fingerprints are bound in id-sorted order so the bundle core is stable
  // regardless of input ordering.
  const outcomeById = new Map(input.outcomes.map((o) => [o.outcomeId, o]));
  const attributionById = new Map(input.attributions.map((a) => [a.attributionId, a]));
  const outcomeFingerprints = outcomeIds.map((id) => outcomeById.get(id)!.evidenceHash);
  const attributionFingerprints = attributionIds.map(
    (id) => attributionById.get(id)!.journeyHash
  );

  const bundleFingerprint = sha256Hex(
    canonicalJson({
      v: 1,
      evidenceBundleKey,
      outcomeFingerprints,
      attributionFingerprints,
    })
  );

  return Object.freeze({
    evidenceBundleId: EVIDENCE_BUNDLE_ID_PREFIX + evidenceBundleKey,
    userId: input.userId,
    businessId: input.businessId,
    outcomeIds: Object.freeze(outcomeIds),
    attributionIds: Object.freeze(attributionIds),
    sourceVersions: Object.freeze({ ...input.sourceVersions }),
    outcomeFingerprints: Object.freeze(outcomeFingerprints),
    attributionFingerprints: Object.freeze(attributionFingerprints),
    bundleFingerprint,
  });
}

/** Recomputes the bundle fingerprint from a persisted bundle row. */
export function recomputedBundleFingerprint(bundle: {
  evidenceBundleId: string;
  outcomeFingerprints: readonly string[];
  attributionFingerprints: readonly string[];
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      evidenceBundleKey: bundle.evidenceBundleId,
      outcomeFingerprints: bundle.outcomeFingerprints,
      attributionFingerprints: bundle.attributionFingerprints,
    })
  );
}

/** Drift between a retained bundle and its fingerprint is tampering. */
export function assertBundleIntegrity(bundle: LearningEvidenceBundle): void {
  if (recomputedBundleFingerprint(bundle) !== bundle.bundleFingerprint) {
    throw new LearningIdentityConflictError(
      "LEARNING_EVIDENCE_BUNDLE_CONFLICT",
      `Evidence bundle ${bundle.evidenceBundleId} fingerprint drift detected; refusing to use tampered evidence.`
    );
  }
}

export function isEvidenceBundleId(value: string): boolean {
  return EVIDENCE_BUNDLE_ID_PATTERN.test(value);
}

/** Type guard narrowing a generic LearningError by code. */
export function hasLearningCode(error: unknown, code: string): error is LearningError {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as LearningError).code === code
  );
}
