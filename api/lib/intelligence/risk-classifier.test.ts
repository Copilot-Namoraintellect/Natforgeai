import { describe, expect, it } from "vitest";
import {
  classifyRisks,
  deriveOpportunityIndicators,
  resolveRecommendedHandling,
  type ClassifyRisksArgs,
} from "./risk-classifier";
import type { HandlingClass, RiskFlagEntry } from "./interpretation-contract";

function riskArgs(overrides: Partial<ClassifyRisksArgs> = {}): ClassifyRisksArgs {
  return {
    text: "thanks for the great service",
    intent: "praise",
    sentiment: "positive",
    urgency: "low",
    modelRiskHints: [],
    ...overrides,
  };
}

function flagsOf(entries: readonly RiskFlagEntry[]): string[] {
  return entries.map((entry) => entry.flag);
}

describe("classifyRisks — marker classes", () => {
  it("refund/dispute markers → refund_dispute_or_complaint", () => {
    const result = classifyRisks(riskArgs({ text: "I want a refund for my order", intent: "complaint", sentiment: "negative" }));
    expect(flagsOf(result.riskFlags)).toContain("refund_dispute_or_complaint");
  });

  it("legal-threat markers → legal_compliance_sensitive with word boundaries", () => {
    expect(
      flagsOf(classifyRisks(riskArgs({ text: "I will sue your company" })).riskFlags)
    ).toContain("legal_compliance_sensitive");
    // "pursue" contains "sue" but must not match.
    expect(
      flagsOf(classifyRisks(riskArgs({ text: "we will pursue all avenues" })).riskFlags)
    ).not.toContain("legal_compliance_sensitive");
  });

  it("detects email and phone PII → privacy_sensitive", () => {
    const email = classifyRisks(riskArgs({ text: "reach me at jane.doe@example.com please" }));
    expect(flagsOf(email.riskFlags)).toContain("privacy_sensitive");
    const phone = classifyRisks(riskArgs({ text: "call me on 082 555 1234" }));
    expect(flagsOf(phone.riskFlags)).toContain("privacy_sensitive");
  });

  it("negative sentiment × critical urgency → high_emotion_escalation", () => {
    const result = classifyRisks(
      riskArgs({ intent: "complaint", sentiment: "negative", urgency: "critical" })
    );
    expect(flagsOf(result.riskFlags)).toContain("high_emotion_escalation");
  });

  it("negative sentiment × complaint intent → reputational_risk", () => {
    const result = classifyRisks(
      riskArgs({ intent: "complaint", sentiment: "negative", urgency: "normal" })
    );
    expect(flagsOf(result.riskFlags)).toContain("reputational_risk");
  });

  it("passes validated model hints through with model_hint evidence", () => {
    const result = classifyRisks(riskArgs({ modelRiskHints: ["self_harm_safety_concern"] }));
    expect(result.riskFlags).toEqual([
      { flag: "self_harm_safety_concern", evidence: "model_hint" },
    ]);
    expect(result.handlingOverride).toBe("safety_escalation");
  });

  it("dedups by flag with first evidence winning", () => {
    const result = classifyRisks(
      riskArgs({
        text: "I want a refund, this is awful",
        intent: "complaint",
        sentiment: "negative",
        modelRiskHints: ["refund_dispute_or_complaint", "privacy_sensitive"],
      })
    );
    const refundEntries = result.riskFlags.filter((e) => e.flag === "refund_dispute_or_complaint");
    expect(refundEntries).toHaveLength(1);
    expect(refundEntries[0].evidence).toBe("model_hint");
  });

  it("mints normal_engagement only for praise/informational intent with no other flags", () => {
    const praise = classifyRisks(riskArgs());
    expect(flagsOf(praise.riskFlags)).toEqual(["normal_engagement"]);
    expect(praise.handlingOverride).toBeNull();

    const informational = classifyRisks(riskArgs({ intent: "information_request" }));
    expect(flagsOf(informational.riskFlags)).toEqual(["normal_engagement"]);

    const complaint = classifyRisks(
      riskArgs({ text: "I want a refund", intent: "complaint", sentiment: "negative" })
    );
    expect(flagsOf(complaint.riskFlags)).not.toContain("normal_engagement");
  });

  it("returns empty riskFlags when nothing applies (empty = no risk)", () => {
    const result = classifyRisks(
      riskArgs({ text: "maybe later", intent: "objection", sentiment: "neutral" })
    );
    expect(result.riskFlags).toEqual([]);
    expect(result.handlingOverride).toBeNull();
  });

  it("derives the handling override from the strongest risk class", () => {
    expect(
      classifyRisks(riskArgs({ modelRiskHints: ["abusive_or_harassing"] })).handlingOverride
    ).toBe("safety_escalation");
    expect(
      classifyRisks(riskArgs({ text: "I want a refund", intent: "complaint", sentiment: "negative" }))
        .handlingOverride
    ).toBe("human_review");
  });
});

describe("deriveOpportunityIndicators", () => {
  it("purchase_interest + positive + relevant → purchase_intent_detected", () => {
    const result = deriveOpportunityIndicators({
      intent: "purchase_interest",
      sentiment: "positive",
      relevance: "relevant",
      opportunityHints: [],
    });
    expect(result.map((e) => e.indicator)).toEqual(["purchase_intent_detected"]);
  });

  it("purchase_interest + not_relevant relevance produces no purchase indicator", () => {
    const result = deriveOpportunityIndicators({
      intent: "purchase_interest",
      sentiment: "positive",
      relevance: "not_relevant",
      opportunityHints: [],
    });
    expect(result.map((e) => e.indicator)).not.toContain("purchase_intent_detected");
  });

  it("partnership_interest → partnership_or_b2b_signal", () => {
    const result = deriveOpportunityIndicators({
      intent: "partnership_interest",
      sentiment: "neutral",
      relevance: "unknown",
      opportunityHints: [],
    });
    expect(result.map((e) => e.indicator)).toContain("partnership_or_b2b_signal");
  });

  it("praise + positive → high_value_praise", () => {
    const result = deriveOpportunityIndicators({
      intent: "praise",
      sentiment: "positive",
      relevance: "relevant",
      opportunityHints: [],
    });
    expect(result.map((e) => e.indicator)).toContain("high_value_praise");
  });

  it("complaint/support_request + negative → support_recovery_moment", () => {
    for (const intent of ["complaint", "support_request"] as const) {
      const result = deriveOpportunityIndicators({
        intent,
        sentiment: "negative",
        relevance: "relevant",
        opportunityHints: [],
      });
      expect(result.map((e) => e.indicator)).toContain("support_recovery_moment");
    }
  });

  it("passes validated model hints through and returns [] when nothing applies", () => {
    const withHints = deriveOpportunityIndicators({
      intent: "objection",
      sentiment: "neutral",
      relevance: "unknown",
      opportunityHints: ["repeat_engagement_signal", "none"],
    });
    expect(withHints.map((e) => e.indicator)).toEqual(["repeat_engagement_signal"]);
    expect(withHints[0].evidence).toBe("model_hint");

    const empty = deriveOpportunityIndicators({
      intent: "objection",
      sentiment: "neutral",
      relevance: "unknown",
      opportunityHints: [],
    });
    expect(empty).toEqual([]);
  });
});

describe("resolveRecommendedHandling — contract §11 order", () => {
  const base = {
    riskFlags: [] as readonly RiskFlagEntry[],
    overallConfidence: "high" as const,
    intent: "information_request" as const,
    relevance: "relevant" as const,
    opportunityIndicators: [] as const,
  };

  it("1. safety-critical flag → safety_escalation (even with opportunities + high confidence)", () => {
    const handling: HandlingClass = resolveRecommendedHandling({
      ...base,
      riskFlags: [{ flag: "self_harm_safety_concern", evidence: "marker" }],
      opportunityIndicators: [{ indicator: "purchase_intent_detected", evidence: "x" }],
    });
    expect(handling).toBe("safety_escalation");
  });

  it("2. any other gating risk flag → human_review", () => {
    expect(
      resolveRecommendedHandling({
        ...base,
        riskFlags: [{ flag: "refund_dispute_or_complaint", evidence: "marker" }],
      })
    ).toBe("human_review");
  });

  it("2. low or unknown overall confidence → human_review (confidence gating)", () => {
    expect(resolveRecommendedHandling({ ...base, overallConfidence: "low" })).toBe("human_review");
    expect(resolveRecommendedHandling({ ...base, overallConfidence: "unknown" })).toBe(
      "human_review"
    );
  });

  it("3. opportunity + confidence ≥ medium → opportunity_candidate", () => {
    expect(
      resolveRecommendedHandling({
        ...base,
        overallConfidence: "medium",
        opportunityIndicators: [{ indicator: "purchase_intent_detected", evidence: "x" }],
      })
    ).toBe("opportunity_candidate");
  });

  it("4. engagement-suitable intent + ≥ medium + relevance ≠ not_relevant → candidate_for_engagement", () => {
    expect(resolveRecommendedHandling({ ...base, overallConfidence: "medium" })).toBe(
      "candidate_for_engagement"
    );
    expect(
      resolveRecommendedHandling({ ...base, relevance: "partially_relevant" })
    ).toBe("candidate_for_engagement");
    expect(resolveRecommendedHandling({ ...base, relevance: "not_relevant" })).toBe("monitor");
    expect(
      resolveRecommendedHandling({ ...base, intent: "objection", overallConfidence: "medium" })
    ).toBe("monitor");
  });

  it("5. definitive spam/irrelevant/abuse intent → no_action", () => {
    for (const intent of ["spam", "irrelevant", "abuse"] as const) {
      expect(resolveRecommendedHandling({ ...base, intent })).toBe("no_action");
    }
  });

  it("6. otherwise → monitor", () => {
    expect(
      resolveRecommendedHandling({
        ...base,
        intent: "objection",
        overallConfidence: "medium",
        relevance: "not_relevant",
      })
    ).toBe("monitor");
  });

  it("non-gating positive flags do not force human_review", () => {
    expect(
      resolveRecommendedHandling({
        ...base,
        riskFlags: [{ flag: "normal_engagement", evidence: "positive signal" }],
      })
    ).toBe("candidate_for_engagement");
  });
});
