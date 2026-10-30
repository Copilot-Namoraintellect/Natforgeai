// ─── R8-E Strategic Opportunity & Risk — deterministic identities (E2) ───
//
// sor1: candidate identity — same authoritative basis (tenant + business +
// kind/type + governing reasoning + subject/context + bound evidence
// snapshot) ⇒ same candidate; conflicting replay under the same identity
// fails closed (contract §3). sorl1: append-only lifecycle fact identity.
// No fuzzy candidate merging exists anywhere in this stream.

import {
  canonicalJson,
  sha256Hex,
  type CandidateKind,
  type CandidateType,
} from "./strategic-opportunity-risk-contract";

export const CANDIDATE_ID_PREFIX = "sor1:" as const;
export const LIFECYCLE_EVENT_ID_PREFIX = "sorl1:" as const;

/** One governing reasoning contribution to the evidence bundle fingerprint. */
export interface ReasoningEvidenceAnchor {
  readonly reasoningId: string;
  readonly evidenceBundleId: string;
}
//
// The frozen 34-key R8-D projection does not expose the raw evidence
// fingerprint; the deterministic evb1: evidenceBundleId already binds the
// exact resolved evidence set (any evidence change mints a new bundle), so
// (reasoningId, evidenceBundleId) is the authoritative anchor pair.

/**
 * Deterministic subject/context key: the sorted anchor-evidence refs of the
 * governing reasoning projections. Bounded, exact, never fuzzy.
 */
export function deriveSubjectKey(anchorRefs: readonly string[]): string {
  const refs = [...new Set(anchorRefs)].sort();
  return refs.join("|").slice(0, 512);
}

/** Fingerprint of the bound upstream evidence snapshot (tamper-evident). */
export function deriveEvidenceBundleFingerprint(input: {
  businessId: number;
  anchors: readonly ReasoningEvidenceAnchor[];
}): string {
  const anchors = [...input.anchors]
    .map((a) => ({
      reasoningId: a.reasoningId,
      evidenceBundleId: a.evidenceBundleId,
    }))
    .sort((a, b) => (a.reasoningId < b.reasoningId ? -1 : a.reasoningId > b.reasoningId ? 1 : 0));
  return sha256Hex(canonicalJson({ v: 1, businessId: input.businessId, anchors }));
}

/** Deterministic candidate identity (contract §3). */
export function deriveCandidateId(input: {
  userId: number;
  businessId: number;
  candidateKind: CandidateKind;
  candidateType: CandidateType;
  reasoningIds: readonly string[];
  subjectKey: string;
  evidenceBundleFingerprint: string;
}): string {
  return (
    CANDIDATE_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        userId: input.userId,
        businessId: input.businessId,
        candidateKind: input.candidateKind,
        candidateType: input.candidateType,
        reasoningIds: [...input.reasoningIds].sort(),
        subjectKey: input.subjectKey,
        evidenceBundleFingerprint: input.evidenceBundleFingerprint,
      })
    )
  );
}

/**
 * Fingerprint over the immutable material candidate core (replay-conflict
 * anchor). Any material change ⇒ different fingerprint ⇒ under the same
 * convergence anchor this is a conflicting replay (fail closed); a legitimate
 * change mints a NEW superseding candidate instead.
 */
export function deriveCandidateFingerprint(input: {
  candidateId: string;
  impactClass: string;
  urgencyClass: string;
  timeHorizon: string;
  confidenceClass: string;
  evidenceQualityScore: number;
  priorityScore: number;
  priorityClass: string;
  strategicRiskClass: string | null;
  governanceDecisionId: string | null;
  governanceDecision: string | null;
  status: string;
  validUntil: string | null;
  supersedesCandidateId: string | null;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      candidateId: input.candidateId,
      impactClass: input.impactClass,
      urgencyClass: input.urgencyClass,
      timeHorizon: input.timeHorizon,
      confidenceClass: input.confidenceClass,
      evidenceQualityScore: input.evidenceQualityScore,
      priorityScore: input.priorityScore,
      priorityClass: input.priorityClass,
      strategicRiskClass: input.strategicRiskClass,
      governanceDecisionId: input.governanceDecisionId,
      governanceDecision: input.governanceDecision,
      status: input.status,
      validUntil: input.validUntil,
      supersedesCandidateId: input.supersedesCandidateId,
    })
  );
}

/** Deterministic lifecycle fact identity. */
export function deriveLifecycleEventId(input: {
  candidateId: string;
  lifecycleType: string;
  targetStatus: string;
  successorCandidateId: string | null;
  occurredAt: string;
  reasonCode: string | null;
}): string {
  return (
    LIFECYCLE_EVENT_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        candidateId: input.candidateId,
        lifecycleType: input.lifecycleType,
        targetStatus: input.targetStatus,
        successorCandidateId: input.successorCandidateId,
        occurredAt: input.occurredAt,
        reasonCode: input.reasonCode,
      })
    )
  );
}

/** Deterministic relation identity between two candidates. */
export function deriveRelationId(input: {
  candidateId: string;
  relatedCandidateId: string;
  relation: string;
}): string {
  const pair = [input.candidateId, input.relatedCandidateId].sort();
  return sha256Hex(
    canonicalJson({ v: 1, pair, relation: input.relation })
  );
}
