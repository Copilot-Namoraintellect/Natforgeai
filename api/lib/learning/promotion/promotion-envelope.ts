/**
 * Approved learning promotion envelope (WBS15.6) — pure builders.
 *
 * Approval does NOT mutate historical BI/Strategy. Instead, approving an
 * exact immutable proposal seals a durable, self-contained envelope that a
 * FUTURE BI or Strategy generation cycle (WBS15.7) can explicitly consume.
 *
 * The envelope preserves the semantic distinction between:
 * - observed evidence (analytics observations cited by reference),
 * - derived findings (rule/assumption derivations),
 * - the approved recommendation/adjustment (human-approved, fingerprint-bound).
 *
 * Nothing here reads or writes a database.
 */

import type { EvidenceItem } from "../contracts/learning-derivation";
import type { LearningPromotionContext, LearningPromotionProvenanceClass } from "./promotion-contract";
import { LEARNING_PROMOTION_CONTRACT_VERSION } from "./promotion-contract";

/** One evidence citation inside an envelope, with its provenance class. */
export interface EnvelopeEvidenceItem {
  ref: string;
  provenanceClass: LearningPromotionProvenanceClass;
  note: string | null;
}

/** The promoted adjustment — an approved recommendation, never a "fact". */
export interface EnvelopePromotedAdjustment {
  provenanceClass: "approved_recommendation";
  recommendationId: string;
  targetEngine: string;
  adjustmentType: string;
  summary: string;
  rationale: string;
  evidenceRefs: string[];
}

/**
 * Durable approved promotion envelope. This is the exact shape sealed into
 * the learning_promotion_resolved audit event metadata and returned to future
 * consumers.
 */
export interface ApprovedPromotionEnvelope {
  envelopeVersion: typeof LEARNING_PROMOTION_CONTRACT_VERSION;
  /** Proposal identity — the same fingerprint bound at proposal time. */
  proposalFingerprint: string;
  approvalRequestId: number;
  decision: "approved";
  /** Explicit human decision timestamp (the approval decision time). */
  decidedAt: string;
  /** The user who made the explicit approval decision. */
  decidedByUserId: number;
  campaignId: number;
  learningRecordId: number;
  evaluationVersion: string;
  learningAuthority: {
    engine: string;
    engineVersion: string;
    inputDigest: string;
  };
  targetEngine: string;
  promoted: EnvelopePromotedAdjustment;
  evidence: EnvelopeEvidenceItem[];
}

function provenanceForEvidenceItem(item: EvidenceItem): LearningPromotionProvenanceClass {
  switch (item.kind) {
    case "observation":
      return "observed_evidence";
    case "rule":
      return "derived_finding";
    case "assumption":
      return "stated_assumption";
  }
}

/**
 * Build the sealed envelope from an immutable proposal context plus the
 * decision facts. The evidence list is derived from the learning record's own
 * evidence items, filtered to the recommendation's evidenceRefs and labelled
 * with their original provenance — the approved adjustment never reclassifies
 * its supporting evidence.
 */
export function buildApprovedPromotionEnvelope(input: {
  context: LearningPromotionContext;
  approvalRequestId: number;
  decidedAt: string;
  decidedByUserId: number;
  recordEvidence: EvidenceItem[];
}): ApprovedPromotionEnvelope {
  const { coordinates } = input.context;

  const referenced = new Set(coordinates.evidenceRefs);
  const evidence: EnvelopeEvidenceItem[] = input.recordEvidence
    .filter((item) => referenced.has(item.ref))
    .map((item) => ({
      ref: item.ref,
      provenanceClass: provenanceForEvidenceItem(item),
      note: item.note,
    }));

  return {
    envelopeVersion: LEARNING_PROMOTION_CONTRACT_VERSION,
    proposalFingerprint: input.context.proposalFingerprint,
    approvalRequestId: input.approvalRequestId,
    decision: "approved",
    decidedAt: input.decidedAt,
    decidedByUserId: input.decidedByUserId,
    campaignId: coordinates.campaignId,
    learningRecordId: coordinates.learningRecordId,
    evaluationVersion: coordinates.evaluationVersion,
    learningAuthority: {
      engine: coordinates.learningEngine,
      engineVersion: coordinates.learningEngineVersion,
      inputDigest: coordinates.learningInputDigest,
    },
    targetEngine: coordinates.targetEngine,
    promoted: {
      provenanceClass: "approved_recommendation",
      recommendationId: coordinates.recommendationId,
      targetEngine: coordinates.targetEngine,
      adjustmentType: coordinates.adjustmentType,
      summary: coordinates.summary,
      rationale: coordinates.rationale,
      evidenceRefs: [...coordinates.evidenceRefs],
    },
    evidence,
  };
}

/**
 * Fail-closed revalidation of an envelope's immutable copies against the
 * proposal context it claims to be sealed from. The audit row and the
 * approval-row context must agree exactly, otherwise the envelope is not
 * consumable.
 */
export function envelopeMatchesContext(input: {
  envelope: ApprovedPromotionEnvelope;
  context: LearningPromotionContext;
  approvalRequestId: number;
}): boolean {
  const { envelope, context } = input;
  const { coordinates } = context;
  return (
    envelope.envelopeVersion === LEARNING_PROMOTION_CONTRACT_VERSION &&
    envelope.proposalFingerprint === context.proposalFingerprint &&
    envelope.approvalRequestId === input.approvalRequestId &&
    envelope.decision === "approved" &&
    envelope.campaignId === coordinates.campaignId &&
    envelope.learningRecordId === coordinates.learningRecordId &&
    envelope.evaluationVersion === coordinates.evaluationVersion &&
    envelope.learningAuthority.engine === coordinates.learningEngine &&
    envelope.learningAuthority.engineVersion === coordinates.learningEngineVersion &&
    envelope.learningAuthority.inputDigest === coordinates.learningInputDigest &&
    envelope.targetEngine === coordinates.targetEngine &&
    envelope.promoted.recommendationId === coordinates.recommendationId &&
    envelope.promoted.targetEngine === coordinates.targetEngine &&
    envelope.promoted.adjustmentType === coordinates.adjustmentType &&
    envelope.promoted.summary === coordinates.summary &&
    envelope.promoted.rationale === coordinates.rationale &&
    envelope.promoted.provenanceClass === "approved_recommendation" &&
    JSON.stringify(envelope.promoted.evidenceRefs) === JSON.stringify(coordinates.evidenceRefs)
  );
}
