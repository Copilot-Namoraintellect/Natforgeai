/**
 * R6-B — rule-first scoring engine unit tests (B3, B6).
 *
 * Deterministic model verification against docs/contracts/lead-scoring-contract.md §4:
 * bounded components, exact overall weighting, band partition, reason-code
 * emission, weight-tamper rejection, and honest confidence separation.
 */
import { describe, it, expect } from "vitest";
import { buildFeatureVector, type RawScoringInputs } from "./feature-model";
import { computeScore, scoreBandFor, assertValidWeights } from "./scoring-engine";
import { deriveScoreConfidence } from "./score-confidence";
import type { ScoringFeatureVector } from "./feature-model";


async function expectErrorCode(fn: () => unknown, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  expect.unreachable(`expected error code ${code}`);
}

const NOW = new Date("2026-06-28T12:00:00.000Z");
const HOUR = 3.6e6;
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();

function vector(overrides: Partial<ScoringFeatureVector> = {}): ScoringFeatureVector {
  return {
    hasAnyEvidence: true,
    fitTypeRelevance: 1.0,
    fitCampaignAlignment: 1.0,
    intentTypeBase: 50,
    explicitHighCount: 2,
    explicitMediumCount: 0,
    validatedReceiptCount: 1,
    distinctInterpretationCount: 3,
    contributingEvidenceCount: 3,
    evidenceStrengthOrdinal: "HIGH",
    contradictionCount: 0,
    primaryOpportunityType: "purchase_interest",
    latestObservedAtMs: NOW.getTime() - HOUR,
    provenance: {},
    ...overrides,
  };
}

describe("computeScore — model exactness", () => {
  it("computes the documented weighted sum with bounded components", () => {
    const result = computeScore(vector(), { now: NOW });
    // intent 90, fit 100, engagement 65, recency 100, opportunity 80
    expect(result.components).toEqual({
      intent: 90,
      fit: 100,
      engagement: 65,
      recency: 100,
      opportunity: 80,
    });
    expect(result.contributions).toEqual({ fit: 25, intent: 27, engagement: 9.75, recency: 15, opportunity: 12 });
    expect(result.overallScore).toBe(89); // round(88.75)
    expect(result.scoreBand).toBe("VERY_HIGH");
  });

  it("is deterministic for the same feature snapshot and clock", () => {
    const a = computeScore(vector(), { now: NOW });
    const b = computeScore(vector(), { now: NOW });
    expect(a).toEqual(b);
  });

  it("clamps pathological inputs to [0,100] without NaN/Infinity", () => {
    const result = computeScore(
      vector({ explicitHighCount: 999, contributingEvidenceCount: 9999, validatedReceiptCount: 99 }),
      { now: NOW }
    );
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(100);
    expect(Number.isFinite(result.overallScore)).toBe(true);
  });

  it("rejects tampered scoring weights (fail closed)", async () => {
    await expectErrorCode(() => computeScore(vector(), { now: NOW, weights: { fit: 2, intent: 0, engagement: 0, recency: 0, opportunity: 0 } }), "INVALID_SCORING_WEIGHTS");
    await expectErrorCode(
      () => computeScore(vector(), { now: NOW, weights: { fit: 0.6, intent: 0.6, engagement: 0, recency: 0, opportunity: 0 } }),
      "INVALID_SCORING_WEIGHTS"
    );
    await expectErrorCode(
      () => computeScore(vector(), { now: NOW, weights: { fit: Number.NaN, intent: 0.3, engagement: 0.15, recency: 0.15, opportunity: 0.15 } }),
      "INVALID_SCORING_WEIGHTS"
    );
    await expectErrorCode(() => assertValidWeights({ fit: -0.1, intent: 0.3, engagement: 0.15, recency: 0.15, opportunity: 0.15 }), "INVALID_SCORING_WEIGHTS");
    // Infinity weight — the rogue-agent "alter scoring weights" attempt.
    await expectErrorCode(
      () => computeScore(vector(), { now: NOW, weights: { fit: Infinity, intent: 0.3, engagement: 0.15, recency: 0.15, opportunity: 0.15 } }),
      "INVALID_SCORING_WEIGHTS"
    );
  });

  it("rejects a non-finite scoring clock", async () => {
    await expectErrorCode(() => computeScore(vector(), { now: new Date(Number.NaN) }), "INVALID_SCORING_CLOCK");
  });
});

describe("computeScore — band partition", () => {
  it.each([
    [0, "VERY_LOW"],
    [19, "VERY_LOW"],
    [20, "LOW"],
    [39, "LOW"],
    [40, "MEDIUM"],
    [59, "MEDIUM"],
    [60, "HIGH"],
    [79, "HIGH"],
    [80, "VERY_HIGH"],
    [100, "VERY_HIGH"],
  ] as const)("score %i → band %s", (score, band) => {
    expect(scoreBandFor(score)).toBe(band);
  });
});

describe("computeScore — evidence semantics (mirrors B9 cases)", () => {
  it("explicit high purchase intent scores above weak interest", () => {
    const strong = computeScore(vector(), { now: NOW });
    const weak = computeScore(
      vector({
        explicitHighCount: 0,
        explicitMediumCount: 1,
        intentTypeBase: 40,
        evidenceStrengthOrdinal: "LOW",
        validatedReceiptCount: 0,
        distinctInterpretationCount: 1,
        contributingEvidenceCount: 1,
        fitCampaignAlignment: 0.5,
      }),
      { now: NOW }
    );
    expect(strong.overallScore).toBeGreaterThan(weak.overallScore);
    expect(weak.overallScore).toBeLessThan(60); // not HIGH band
  });

  it("strong fit + intent produces a stronger score than intent alone", () => {
    const full = computeScore(vector(), { now: NOW });
    const misaligned = computeScore(vector({ fitTypeRelevance: 0.4, fitCampaignAlignment: 0.3 }), { now: NOW });
    expect(full.overallScore).toBeGreaterThan(misaligned.overallScore);
  });

  it("praise-only evidence does not produce a high sales score", () => {
    // Real path: repeated evidenced praise (R5-D R10 referral candidate).
    const praise = computeScore(
      buildFeatureVector({
        candidates: [
          { opportunityId: "opp1:praise", opportunityType: "referral_or_advocacy", evidenceStrength: "MEDIUM", campaignId: 1, contradictionCount: 0 },
        ],
        evidence: [
          { interpretationId: "i-p1", kind: "signal_interpretation", contributesToStrength: true, opportunityTypeAtEvaluation: "referral_or_advocacy", overallConfidence: "high", relevance: "relevant", occurredAt: iso(2) },
          { interpretationId: "i-p2", kind: "signal_interpretation", contributesToStrength: true, opportunityTypeAtEvaluation: "referral_or_advocacy", overallConfidence: "high", relevance: "relevant", occurredAt: iso(1) },
        ],
        lead: { leadCampaignId: 1 },
      }),
      { now: NOW }
    );
    expect(praise.overallScore).toBeLessThan(60);
    expect(praise.reasonCodes).toContain("PRAISE_ONLY_EVIDENCE");
  });

  it("complaint-only evidence does not automatically score as sales-ready", () => {
    const complaint = computeScore(
      buildFeatureVector({
        candidates: [
          { opportunityId: "opp1:complaint", opportunityType: "unresolved_complaint_opportunity", evidenceStrength: "MEDIUM", campaignId: 1, contradictionCount: 0 },
        ],
        evidence: [
          { interpretationId: "i-c1", kind: "signal_interpretation", contributesToStrength: true, opportunityTypeAtEvaluation: "unresolved_complaint_opportunity", overallConfidence: "high", relevance: "relevant", occurredAt: iso(2) },
          { interpretationId: "i-c2", kind: "signal_interpretation", contributesToStrength: true, opportunityTypeAtEvaluation: "unresolved_complaint_opportunity", overallConfidence: "high", relevance: "relevant", occurredAt: iso(1) },
        ],
        lead: { leadCampaignId: 1 },
      }),
      { now: NOW }
    );
    expect(complaint.overallScore).toBeLessThan(60);
    expect(complaint.reasonCodes).toContain("UNRESOLVED_COMPLAINT_SIGNAL");
  });

  it("repeated opportunity evidence strengthens the score", () => {
    const single = computeScore(vector({ distinctInterpretationCount: 1, contributingEvidenceCount: 1, explicitHighCount: 1 }), { now: NOW });
    const repeated = computeScore(vector({ distinctInterpretationCount: 3, contributingEvidenceCount: 3, explicitHighCount: 2 }), { now: NOW });
    expect(repeated.overallScore).toBeGreaterThan(single.overallScore);
    expect(repeated.reasonCodes).toContain("REPEATED_INTENT_SIGNALS");
  });

  it("stale evidence reduces the recency contribution", () => {
    const fresh = computeScore(vector(), { now: NOW });
    const stale = computeScore(vector({ latestObservedAtMs: NOW.getTime() - 500 * HOUR }), { now: NOW });
    expect(stale.components.recency).toBeLessThan(fresh.components.recency);
    expect(stale.reasonCodes).toContain("STALE_EVIDENCE");
  });

  it("missing evidence is handled safely (VERY_LOW score, UNKNOWN confidence)", () => {
    // Real path: a lead with no opportunity evidence at all.
    const empty = computeScore(
      buildFeatureVector({ candidates: [], evidence: [], lead: { leadCampaignId: null } }),
      { now: NOW }
    );
    expect(empty.overallScore).toBeLessThan(20);
    expect(empty.scoreBand).toBe("VERY_LOW");
    expect(empty.confidence).toBe("UNKNOWN");
    expect(empty.reasonCodes).toContain("INSUFFICIENT_EVIDENCE");
    expect(Number.isFinite(empty.overallScore)).toBe(true);
  });

  it("a high score can carry LOW confidence (honest separation)", () => {
    // High intent/fit evidence but LOW evidence strength + contradiction:
    // numeric score stays high while confidence is explicitly LOW.
    const highValueLowConfidence = computeScore(
      vector({ evidenceStrengthOrdinal: "LOW", contradictionCount: 1 }),
      { now: NOW }
    );
    expect(highValueLowConfidence.overallScore).toBeGreaterThanOrEqual(60);
    expect(highValueLowConfidence.confidence).toBe("LOW");
    expect(highValueLowConfidence.reasonCodes).toContain("CONTRADICTING_EVIDENCE");
    expect(highValueLowConfidence.reasonCodes).toContain("LOW_EVIDENCE_STRENGTH");
  });

  it("reason codes stay within the closed bounded vocabulary", () => {
    const result = computeScore(vector({ contradictionCount: 1, validatedReceiptCount: 0 }), { now: NOW });
    expect(result.reasonCodes.length).toBeLessThanOrEqual(8);
  });
});

describe("deriveScoreConfidence", () => {
  it("returns UNKNOWN with no usable evidence basis", () => {
    expect(
      deriveScoreConfidence(vector({ hasAnyEvidence: false, evidenceStrengthOrdinal: "UNKNOWN" }), { nowMs: NOW.getTime() })
    ).toBe("UNKNOWN");
  });

  it("caps at LOW for contradictions or LOW evidence strength", () => {
    expect(deriveScoreConfidence(vector({ evidenceStrengthOrdinal: "LOW" }), { nowMs: NOW.getTime() })).toBe("LOW");
    expect(deriveScoreConfidence(vector({ contradictionCount: 1 }), { nowMs: NOW.getTime() })).toBe("LOW");
  });

  it("caps at MEDIUM for single-source, receipt-less, or stale evidence", () => {
    expect(
      deriveScoreConfidence(
        vector({ distinctInterpretationCount: 1, validatedReceiptCount: 0, evidenceStrengthOrdinal: "MEDIUM" }),
        { nowMs: NOW.getTime() }
      )
    ).toBe("MEDIUM");
    expect(
      deriveScoreConfidence(vector({ latestObservedAtMs: NOW.getTime() - 200 * HOUR, evidenceStrengthOrdinal: "HIGH" }), {
        nowMs: NOW.getTime(),
      })
    ).toBe("MEDIUM");
  });

  it("reaches HIGH only with strong, fresh, repeated, receipt-validated evidence", () => {
    expect(deriveScoreConfidence(vector(), { nowMs: NOW.getTime() })).toBe("HIGH");
  });
});

describe("buildFeatureVector → computeScore integration", () => {
  it("end-to-end deterministic replay for identical raw inputs", () => {
    const raw: RawScoringInputs = {
      candidates: [
        { opportunityId: "opp1:x", opportunityType: "service_enquiry", evidenceStrength: "MEDIUM", campaignId: 9, contradictionCount: 0 },
      ],
      evidence: [
        { interpretationId: "i1", kind: "signal_interpretation", contributesToStrength: true, opportunityTypeAtEvaluation: "service_enquiry", overallConfidence: "medium", relevance: "relevant", occurredAt: iso(10) },
        { interpretationId: "i2", kind: "signal_interpretation", contributesToStrength: true, opportunityTypeAtEvaluation: "service_enquiry", overallConfidence: "high", relevance: "relevant", occurredAt: iso(8) },
      ],
      lead: { leadCampaignId: 9 },
    };
    const a = computeScore(buildFeatureVector(raw), { now: NOW });
    const b = computeScore(buildFeatureVector(raw), { now: NOW });
    expect(a).toEqual(b);
  });
});
