// ─── R8-D Strategic Reasoning — deterministic identities ───
//
// evb1: evidence-bundle identity — same authoritative evidence set (ids +
// bound versions/timestamps/scope) ⇒ same bundle (contract §4).
// hyp1: hypothesis identity — deterministic per reasoning material.
// rsn1: reasoning identity — deterministic convergence anchor
//       (userId, reasoningId); conflicting replay fails closed.
// srl1: append-only lifecycle fact identity.

import {
  canonicalJson,
  sha256Hex,
  type StrategicHypothesisType,
  type StrategicImplicationType,
} from "./strategic-reasoning-contract";

export const EVIDENCE_BUNDLE_ID_PREFIX = "evb1:" as const;
export const HYPOTHESIS_ID_PREFIX = "hyp1:" as const;
export const REASONING_ID_PREFIX = "rsn1:" as const;
export const LIFECYCLE_EVENT_ID_PREFIX = "srl1:" as const;

/** One resolved evidence item bound into a bundle. */
export interface BoundEvidenceItem {
  readonly ref: string;
  readonly evidenceClass: "INTERNAL_MEMORY" | "INTERNAL_CHANGE" | "EXTERNAL_SIGNAL";
  readonly sourceVersion: string;
  readonly status: string;
  readonly observedAt: string;
  readonly recordedAt: string;
}

export function deriveEvidenceBundleId(input: {
  businessId: number;
  items: readonly BoundEvidenceItem[];
}): string {
  const items = [...input.items]
    .map((item) => ({
      ref: item.ref,
      evidenceClass: item.evidenceClass,
      sourceVersion: item.sourceVersion,
      status: item.status,
      observedAt: item.observedAt,
      recordedAt: item.recordedAt,
    }))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return (
    EVIDENCE_BUNDLE_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        businessId: input.businessId,
        items,
      })
    )
  );
}

/** Fingerprint over the resolved evidence rows (tamper-evident binding). */
export function deriveEvidenceFingerprint(input: {
  businessId: number;
  items: readonly BoundEvidenceItem[];
}): string {
  const items = [...input.items]
    .map((item) => ({
      ref: item.ref,
      evidenceClass: item.evidenceClass,
      sourceVersion: item.sourceVersion,
      status: item.status,
      observedAt: item.observedAt,
      recordedAt: item.recordedAt,
    }))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return sha256Hex(canonicalJson({ v: 1, kind: "evidence-fingerprint", businessId: input.businessId, items }));
}

export function deriveHypothesisId(input: {
  evidenceBundleId: string;
  hypothesisType: StrategicHypothesisType;
  supportingRefs: readonly string[];
}): string {
  const refs = [...input.supportingRefs].sort();
  return (
    HYPOTHESIS_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        evidenceBundleId: input.evidenceBundleId,
        hypothesisType: input.hypothesisType,
        supportingRefs: refs,
      })
    )
  );
}

/** Fingerprint over the material conclusion fields (replay-conflict anchor). */
export function deriveReasoningFingerprint(input: {
  evidenceBundleId: string;
  hypothesisId: string;
  hypothesisType: StrategicHypothesisType;
  implicationType: StrategicImplicationType;
  supportingRefs: readonly string[];
  contradictingRefs: readonly string[];
  missingEvidence: readonly string[];
  confidenceClass: string;
  uncertaintyClasses: readonly string[];
  limitations: readonly string[];
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      evidenceBundleId: input.evidenceBundleId,
      hypothesisId: input.hypothesisId,
      hypothesisType: input.hypothesisType,
      implicationType: input.implicationType,
      supportingRefs: [...input.supportingRefs].sort(),
      contradictingRefs: [...input.contradictingRefs].sort(),
      missingEvidence: [...input.missingEvidence].sort(),
      confidenceClass: input.confidenceClass,
      uncertaintyClasses: [...input.uncertaintyClasses].sort(),
      limitations: [...input.limitations],
    })
  );
}

export function deriveReasoningId(input: {
  businessId: number;
  evidenceBundleId: string;
  reasoningFingerprint: string;
}): string {
  return (
    REASONING_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        businessId: input.businessId,
        evidenceBundleId: input.evidenceBundleId,
        reasoningFingerprint: input.reasoningFingerprint,
      })
    )
  );
}

export function deriveLifecycleEventId(input: {
  reasoningId: string;
  lifecycleType: string;
  targetStatus: string;
  successorReasoningId: string | null;
  occurredAt: string;
  reasonCode: string | null;
}): string {
  return (
    LIFECYCLE_EVENT_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        reasoningId: input.reasoningId,
        lifecycleType: input.lifecycleType,
        targetStatus: input.targetStatus,
        successorReasoningId: input.successorReasoningId,
        occurredAt: input.occurredAt,
        reasonCode: input.reasonCode,
      })
    )
  );
}
