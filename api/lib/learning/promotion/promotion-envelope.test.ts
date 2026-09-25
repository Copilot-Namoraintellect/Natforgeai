import { describe, it, expect } from "vitest";
import {
  buildApprovedPromotionEnvelope,
  envelopeMatchesContext,
  type ApprovedPromotionEnvelope,
} from "./promotion-envelope";
import {
  buildLearningPromotionContext,
  buildLearningPromotionProposalFingerprint,
  type LearningPromotionCoordinates,
} from "./promotion-contract";
import type { EvidenceItem } from "../contracts/learning-derivation";

const coordinates: LearningPromotionCoordinates = {
  learningRecordId: 501,
  campaignId: 7,
  evaluationVersion: "learning-v1",
  learningEngine: "learning-engine",
  learningEngineVersion: "learning-v1",
  learningInputDigest: "abc123digest",
  recommendationId: "rec_align_offer_conversion",
  targetEngine: "strategy",
  adjustmentType: "improve_offer_conversion_alignment",
  summary: "Re-examine offer and audience alignment.",
  rationale: "Conversion rate is below the configured partial band.",
  evidenceRefs: ["obs:1", "obs:2", "rule:cvr"],
};

const context = buildLearningPromotionContext({
  coordinates,
  proposalFingerprint: buildLearningPromotionProposalFingerprint(coordinates),
});

const recordEvidence: EvidenceItem[] = [
  { kind: "observation", ref: "obs:1", note: "clicks=60 on instagram at 2026-05-02 (analytics row 9)" },
  { kind: "observation", ref: "obs:2", note: "conversions=1 on instagram at 2026-05-02 (analytics row 10)" },
  { kind: "rule", ref: "rule:cvr", note: "conversion_rate_below_partial_band" },
  { kind: "assumption", ref: "cpa_target", note: "budget-relative target assumption" },
  { kind: "observation", ref: "obs:unreferenced", note: "not cited by the recommendation" },
];

function buildEnvelope() {
  return buildApprovedPromotionEnvelope({
    context,
    approvalRequestId: 77,
    decidedAt: "2026-07-01T12:00:00.000Z",
    decidedByUserId: 22,
    recordEvidence,
  });
}

describe("approved promotion envelope", () => {
  it("binds the exact proposal coordinates and the explicit decision", () => {
    const envelope = buildEnvelope();
    expect(envelope.envelopeVersion).toBe(1);
    expect(envelope.proposalFingerprint).toBe(context.proposalFingerprint);
    expect(envelope.approvalRequestId).toBe(77);
    expect(envelope.decision).toBe("approved");
    expect(envelope.decidedAt).toBe("2026-07-01T12:00:00.000Z");
    expect(envelope.decidedByUserId).toBe(22);
    expect(envelope.campaignId).toBe(7);
    expect(envelope.learningRecordId).toBe(501);
    expect(envelope.evaluationVersion).toBe("learning-v1");
    expect(envelope.learningAuthority).toEqual({
      engine: "learning-engine",
      engineVersion: "learning-v1",
      inputDigest: "abc123digest",
    });
    expect(envelope.targetEngine).toBe("strategy");
  });

  it("never reclassifies the recommendation as fact", () => {
    const envelope = buildEnvelope();
    expect(envelope.promoted.provenanceClass).toBe("approved_recommendation");
    expect(envelope.promoted.recommendationId).toBe("rec_align_offer_conversion");
    expect(envelope.promoted.targetEngine).toBe("strategy");
    expect(envelope.promoted.adjustmentType).toBe("improve_offer_conversion_alignment");
    expect(envelope.promoted.evidenceRefs).toEqual(["obs:1", "obs:2", "rule:cvr"]);
  });

  it("keeps observed evidence and derived findings distinct from the approved adjustment", () => {
    const envelope = buildEnvelope();
    expect(envelope.evidence.map((e) => e.ref)).toEqual(["obs:1", "obs:2", "rule:cvr"]);
    expect(envelope.evidence.find((e) => e.ref === "obs:1")?.provenanceClass).toBe("observed_evidence");
    expect(envelope.evidence.find((e) => e.ref === "rule:cvr")?.provenanceClass).toBe("derived_finding");
    expect(
      envelope.evidence.every((e) => e.provenanceClass !== "approved_recommendation")
    ).toBe(true);
  });

  it("classifies assumption-kind evidence as stated_assumption", () => {
    const withAssumption = buildApprovedPromotionEnvelope({
      context: buildLearningPromotionContext({
        coordinates: { ...coordinates, evidenceRefs: ["cpa_target"] },
        proposalFingerprint: buildLearningPromotionProposalFingerprint({
          ...coordinates,
          evidenceRefs: ["cpa_target"],
        }),
      }),
      approvalRequestId: 77,
      decidedAt: "2026-07-01T12:00:00.000Z",
      decidedByUserId: 22,
      recordEvidence,
    });
    expect(withAssumption.evidence[0].provenanceClass).toBe("stated_assumption");
  });
});

describe("envelope fail-closed revalidation", () => {
  it("accepts an envelope that exactly matches its context", () => {
    expect(
      envelopeMatchesContext({ envelope: buildEnvelope(), context, approvalRequestId: 77 })
    ).toBe(true);
  });

  it("rejects an envelope tampered after sealing", () => {
    const tampered = JSON.parse(JSON.stringify(buildEnvelope())) as ApprovedPromotionEnvelope;
    tampered.promoted.summary = "altered after approval";
    expect(envelopeMatchesContext({ envelope: tampered, context, approvalRequestId: 77 })).toBe(false);

    const wrongProposal = buildEnvelope();
    expect(
      envelopeMatchesContext({ envelope: wrongProposal, context, approvalRequestId: 78 })
    ).toBe(false);
  });
});
