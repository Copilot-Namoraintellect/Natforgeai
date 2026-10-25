/**
 * R6-B — feature model unit tests (B2).
 *
 * Pure validation coverage for the authoritative feature catalog:
 * closed-vocabulary enforcement, finite/range checks, forbidden-feature
 * rejection, deterministic vector construction, and provenance presence.
 */
import { describe, it, expect } from "vitest";
import {
  buildFeatureVector,
  assertAllowedFeatureNames,
  type RawScoringInputs,
} from "./feature-model";
import { FORBIDDEN_FEATURE_VALUES } from "./scoring-contract";


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

function raw(overrides: Partial<RawScoringInputs> = {}): RawScoringInputs {
  return {
    candidates: [
      {
        opportunityId: "opp1:aabb",
        opportunityType: "purchase_interest",
        evidenceStrength: "HIGH",
        campaignId: 5,
        contradictionCount: 0,
      },
    ],
    evidence: [
      {
        interpretationId: "int-1",
        kind: "signal_interpretation",
        contributesToStrength: true,
        opportunityTypeAtEvaluation: "purchase_interest",
        overallConfidence: "high",
        relevance: "relevant",
        occurredAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      },
    ],
    lead: { leadCampaignId: 5 },
    ...overrides,
  };
}

describe("buildFeatureVector", () => {
  it("builds a deterministic vector with provenance for valid R5 inputs", () => {
    const a = buildFeatureVector(raw());
    const b = buildFeatureVector(raw());
    expect(a).toEqual(b);
    expect(a.hasAnyEvidence).toBe(true);
    expect(a.primaryOpportunityType).toBe("purchase_interest");
    expect(a.fitTypeRelevance).toBe(1.0);
    expect(a.fitCampaignAlignment).toBe(1.0);
    expect(a.explicitHighCount).toBe(1);
    expect(a.explicitMediumCount).toBe(0);
    expect(a.evidenceStrengthOrdinal).toBe("HIGH");
    expect(a.latestObservedAtMs).toBe(NOW.getTime() - 60 * 60 * 1000);
    for (const key of Object.keys(a.provenance)) {
      expect(a.provenance[key].billable).toBe(false);
    }
  });

  it("counts explicit medium evidence with partial relevance", () => {
    const v = buildFeatureVector(
      raw({
        evidence: [
          {
            interpretationId: "int-2",
            kind: "signal_interpretation",
            contributesToStrength: true,
            opportunityTypeAtEvaluation: "service_enquiry",
            overallConfidence: "medium",
            relevance: "partially_relevant",
            occurredAt: NOW.toISOString(),
          },
        ],
        candidates: [
          {
            opportunityId: "opp1:ccdd",
            opportunityType: "service_enquiry",
            evidenceStrength: "MEDIUM",
            campaignId: null,
            contradictionCount: 0,
          },
        ],
      })
    );
    expect(v.explicitMediumCount).toBe(1);
    expect(v.explicitHighCount).toBe(0);
  });

  it("counts only contributing engagement receipts", () => {
    const v = buildFeatureVector(
      raw({
        evidence: [
          ...raw().evidence,
          {
            interpretationId: "int-1",
            kind: "engagement_receipt",
            contributesToStrength: true,
            opportunityTypeAtEvaluation: "purchase_interest",
            overallConfidence: "high",
            relevance: "relevant",
            occurredAt: NOW.toISOString(),
          },
          {
            interpretationId: "int-3",
            kind: "engagement_receipt",
            contributesToStrength: false,
            opportunityTypeAtEvaluation: "purchase_interest",
            overallConfidence: "low",
            relevance: "not_relevant",
            occurredAt: NOW.toISOString(),
          },
        ],
      })
    );
    expect(v.validatedReceiptCount).toBe(1);
  });

  it("rejects unknown opportunity type (fail closed)", async () => {
    const bad = raw();
    bad.candidates[0].opportunityType = "wealth_score";
    await expectErrorCode(() => buildFeatureVector(bad), "UNKNOWN_OPPORTUNITY_TYPE");
  });

  it("rejects unknown evidence strength (fail closed)", async () => {
    const bad = raw();
    bad.candidates[0].evidenceStrength = "CERTAIN";
    await expectErrorCode(() => buildFeatureVector(bad), "UNKNOWN_EVIDENCE_STRENGTH");
  });

  it("rejects non-integer / negative contradiction counts", async () => {
    const bad = raw();
    bad.candidates[0].contradictionCount = -1;
    await expectErrorCode(() => buildFeatureVector(bad), "INVALID_FEATURE_VALUE");
    const nan = raw();
    nan.candidates[0].contradictionCount = Number.NaN;
    await expectErrorCode(() => buildFeatureVector(nan), "INVALID_FEATURE_VALUE");
  });

  it("rejects malformed occurredAt timestamps", async () => {
    const bad = raw();
    bad.evidence[0].occurredAt = "not-a-date";
    await expectErrorCode(() => buildFeatureVector(bad), "INVALID_FEATURE_VALUE");
  });

  it("handles empty evidence safely (missing data explicit)", () => {
    const v = buildFeatureVector(raw({ candidates: [], evidence: [] }));
    expect(v.hasAnyEvidence).toBe(false);
    expect(v.latestObservedAtMs).toBeNull();
    expect(v.evidenceStrengthOrdinal).toBe("UNKNOWN");
    expect(v.primaryOpportunityType).toBe("unknown");
  });
});

describe("assertAllowedFeatureNames", () => {
  it("accepts the v1 deterministic feature names", () => {
    expect(() =>
      assertAllowedFeatureNames(["explicitHighCount", "validatedReceiptCount", "ageHours"])
    ).not.toThrow();
  });

  it("rejects every forbidden protected-trait / demographic feature", async () => {
    for (const name of FORBIDDEN_FEATURE_VALUES) {
      await expectErrorCode(() => assertAllowedFeatureNames([name]), "FORBIDDEN_FEATURE");
    }
  });
});
