import { describe, it, expect } from "vitest";
import {
  LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE,
  LEARNING_PROMOTION_CONTEXT_SOURCE,
  LEARNING_PROMOTION_CONTRACT_VERSION,
  buildLearningPromotionContext,
  buildLearningPromotionIdempotencyKey,
  buildLearningPromotionProposalFingerprint,
  extractLearningPromotionContext,
  type LearningPromotionCoordinates,
} from "./promotion-contract";

function sampleCoordinates(overrides: Partial<LearningPromotionCoordinates> = {}): LearningPromotionCoordinates {
  return {
    learningRecordId: 501,
    campaignId: 7,
    evaluationVersion: "learning-v1",
    learningEngine: "learning-engine",
    learningEngineVersion: "learning-v1",
    learningInputDigest: "abc123digest",
    recommendationId: "rec_align_offer_conversion",
    targetEngine: "strategy",
    adjustmentType: "improve_offer_conversion_alignment",
    summary: "Re-examine offer, audience and post-click alignment to convert existing clicks.",
    rationale: "Conversion rate 0.80% is below the configured partial band (1.00%) on 60 clicks.",
    evidenceRefs: ["obs:1", "obs:2"],
    ...overrides,
  };
}

describe("learning promotion proposal fingerprint", () => {
  it("is deterministic for identical material input", () => {
    const a = buildLearningPromotionProposalFingerprint(sampleCoordinates());
    const b = buildLearningPromotionProposalFingerprint(sampleCoordinates());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is insensitive to key insertion order of the coordinates object", () => {
    const ordered = sampleCoordinates();
    const shuffled: Record<string, unknown> = {};
    for (const key of Object.keys(ordered).reverse()) {
      shuffled[key] = ordered[key as keyof LearningPromotionCoordinates];
    }
    expect(buildLearningPromotionProposalFingerprint(shuffled as unknown as LearningPromotionCoordinates)).toBe(
      buildLearningPromotionProposalFingerprint(ordered)
    );
  });

  it("changes when any bound coordinate changes", () => {
    const base = buildLearningPromotionProposalFingerprint(sampleCoordinates());
    expect(buildLearningPromotionProposalFingerprint(sampleCoordinates({ learningRecordId: 502 }))).not.toBe(base);
    expect(buildLearningPromotionProposalFingerprint(sampleCoordinates({ campaignId: 8 }))).not.toBe(base);
    expect(buildLearningPromotionProposalFingerprint(sampleCoordinates({ evaluationVersion: "learning-v2" }))).not.toBe(base);
    expect(buildLearningPromotionProposalFingerprint(sampleCoordinates({ learningInputDigest: "other" }))).not.toBe(base);
    expect(buildLearningPromotionProposalFingerprint(sampleCoordinates({ recommendationId: "rec_other" }))).not.toBe(base);
    expect(buildLearningPromotionProposalFingerprint(sampleCoordinates({ targetEngine: "creative" }))).not.toBe(base);
    expect(buildLearningPromotionProposalFingerprint(sampleCoordinates({ summary: "different" }))).not.toBe(base);
    expect(buildLearningPromotionProposalFingerprint(sampleCoordinates({ evidenceRefs: ["obs:9"] }))).not.toBe(base);
  });

  it("contains no timestamps: proposing the same recommendation twice yields one identity", () => {
    const first = buildLearningPromotionProposalFingerprint(sampleCoordinates());
    const second = buildLearningPromotionProposalFingerprint(sampleCoordinates());
    expect(first).toBe(second);
    expect(buildLearningPromotionIdempotencyKey(first)).toBe(`lp:${first}`);
  });
});

describe("learning promotion context", () => {
  it("round-trips a valid context", () => {
    const coordinates = sampleCoordinates();
    const fingerprint = buildLearningPromotionProposalFingerprint(coordinates);
    const context = buildLearningPromotionContext({ coordinates, proposalFingerprint: fingerprint });
    expect(context.source).toBe(LEARNING_PROMOTION_CONTEXT_SOURCE);
    expect(context.contractVersion).toBe(LEARNING_PROMOTION_CONTRACT_VERSION);

    const extracted = extractLearningPromotionContext(JSON.parse(JSON.stringify(context)));
    expect(extracted).toEqual(context);
  });

  it("rejects a context whose coordinates were tampered with (fingerprint rebinding)", () => {
    const coordinates = sampleCoordinates();
    const fingerprint = buildLearningPromotionProposalFingerprint(coordinates);
    const context = buildLearningPromotionContext({ coordinates, proposalFingerprint: fingerprint });
    const tampered = JSON.parse(JSON.stringify(context));
    tampered.coordinates.summary = "silently altered adjustment";
    expect(extractLearningPromotionContext(tampered)).toBeNull();
  });

  it("rejects non-promotion, malformed and wrong-version contexts", () => {
    expect(extractLearningPromotionContext(null)).toBeNull();
    expect(extractLearningPromotionContext({ source: "engagement_inbound" })).toBeNull();
    expect(extractLearningPromotionContext({ source: LEARNING_PROMOTION_CONTEXT_SOURCE })).toBeNull();
    expect(
      extractLearningPromotionContext({
        source: LEARNING_PROMOTION_CONTEXT_SOURCE,
        contractVersion: 999,
        proposalFingerprint: "x",
        coordinates: sampleCoordinates(),
      })
    ).toBeNull();
    expect(
      extractLearningPromotionContext({
        source: LEARNING_PROMOTION_CONTEXT_SOURCE,
        contractVersion: LEARNING_PROMOTION_CONTRACT_VERSION,
        proposalFingerprint: "x",
        coordinates: { ...sampleCoordinates(), evidenceRefs: [1, 2] },
      })
    ).toBeNull();
  });

  it("carrier type is the inert enum label; the discriminator is the authority", () => {
    // Documented contract: approval_requests.approvalType carries this value,
    // but no promotion code path trusts the label alone.
    expect(LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE).toBe("high_value_proposal");
  });
});
