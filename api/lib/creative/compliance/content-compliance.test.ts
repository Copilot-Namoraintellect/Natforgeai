import { describe, expect, it } from "vitest";
import { evaluateContentCompliance, type ProposedCreativeContent } from "./content-compliance";
import { type ApprovedCreativeContract } from "../contracts/creative-contract";

function makeContract(overrides: Partial<ApprovedCreativeContract> = {}): ApprovedCreativeContract {
  return {
    kind: "approved",
    contractVersion: 1,
    contractFingerprint: "contract-fp",
    campaignId: 30,
    userId: 22,
    businessId: 24,
    businessName: "Zuto Hub",
    funnelStage: "consideration",
    approvedStrategyFingerprint: "strategy-fp",
    strategyRunId: 253,
    approvalRequestId: 36,
    approvedAt: "2026-07-01T08:00:00.000Z",
    cta: {
      text: "Request a Consultation",
      source: "strategy_stage",
      locked: true,
    },
    offer: {
      text: "Book a guided walkthrough",
      source: "approved_strategy",
      locked: true,
      required: false,
    },
    targetAudience: "B2B finance teams and merchant operators",
    groundedClaims: [
      "B2B payment orchestration",
      "prefunded merchant-account administration",
      "balance verification",
      "transaction reservations",
      "controlled payment-instruction services",
    ],
    groundedBenefitEvidence: [],
      approvedEvidence: [],
      authorityEvidenceIds: [],
    minimumBenefitCount: 3,
    brandConstraints: [],
    requiredContactDetails: [],
    prohibitedClaims: ["guaranteed instant wealth", "risk free returns"],
    ...overrides,
  };
}

function makeProposed(overrides: Partial<ProposedCreativeContent> = {}): ProposedCreativeContent {
  return {
    headline: "Streamline B2B Payment Orchestration",
    primaryText:
      "Zuto Hub provides prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
    benefits: [
      "Verify available prefunded balances before payment instructions are issued",
      "Reserve transaction amounts with traceable administration",
      "Issue controlled payment instructions from a central account",
    ],
    cta: "Request a Consultation",
    funnelStage: "consideration",
    targetAudience: "B2B finance teams and merchant operators",
    offer: "Book a guided walkthrough",
    businessName: "Zuto Hub",
    protectedFields: {
      businessName: "Zuto Hub",
    },
    ...overrides,
  };
}

describe("content-compliance", () => {
  it("passes a fully compliant proposed creative", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed(),
    });
    expect(result.passed).toBe(true);
    expect(result.distinctGroundedBenefitCount).toBeGreaterThanOrEqual(3);
    expect(result.failedRuleIds).toEqual([]);
  });

  it("fails when the CTA does not match the locked contract CTA", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed({ cta: "Learn More" }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.ruleId === "CTA_LOCKED")).toBe(true);
  });

  it("passes when the correct locked CTA is used", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed({ cta: "Request a Consultation" }),
    });
    expect(result.passed).toBe(true);
    expect(result.evaluatedRules.find((r) => r.ruleId === "CTA_LOCKED")?.status).toBe("pass");
  });

  it("fails when an invented discount offer is proposed", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed({ offer: "Get 50% off your first month" }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.ruleId === "OFFER_AUTHORISED")).toBe(true);
  });

  it("fails when a free consultation is invented", () => {
    const result = evaluateContentCompliance({
      contract: makeContract({
        offer: { text: "Book a consultation", source: "approved_strategy", locked: true, required: false },
      }),
      proposed: makeProposed({ offer: "Book a free consultation" }),
    });
    expect(result.passed).toBe(false);
    const offerFailure = result.failures.find((f) => f.ruleId === "OFFER_AUTHORISED");
    expect(offerFailure?.reasonCode).toBe("INVENTED_FREE_OFFER");
  });

  it("allows optional approved offer to be omitted", () => {
    const result = evaluateContentCompliance({
      contract: makeContract({ offer: { text: null, source: "none", locked: true, required: false } }),
      proposed: makeProposed({ offer: null }),
    });
    expect(result.passed).toBe(true);
  });

  it("fails when a required approved offer is omitted", () => {
    const result = evaluateContentCompliance({
      contract: makeContract({
        offer: { text: "Book a guided walkthrough", source: "approved_strategy", locked: true, required: true },
      }),
      proposed: makeProposed({ offer: null }),
    });
    expect(result.passed).toBe(false);
    const offerFailure = result.failures.find((f) => f.ruleId === "OFFER_AUTHORISED");
    expect(offerFailure?.reasonCode).toBe("REQUIRED_OFFER_OMITTED");
  });

  it("allows a required approved offer that is present", () => {
    const result = evaluateContentCompliance({
      contract: makeContract({
        offer: { text: "Book a guided walkthrough", source: "approved_strategy", locked: true, required: true },
      }),
      proposed: makeProposed({ offer: "Book a guided walkthrough" }),
    });
    expect(result.passed).toBe(true);
  });

  it("fails when funnel stage mismatches", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed({ funnelStage: "awareness" }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.ruleId === "FUNNEL_STAGE")).toBe(true);
  });

  it("fails when B2C audience conflicts with B2B contract", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed({ targetAudience: "Individual consumers shopping online" }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.ruleId === "AUDIENCE_CONSISTENCY")).toBe(true);
  });

  it("allows compatible nonliteral audience wording", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed({
        targetAudience: "Finance teams managing merchant operations",
      }),
    });
    expect(result.passed).toBe(true);
  });

  it("fails when protected business name is changed", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed({
        businessName: "Zuto Hub",
        protectedFields: { businessName: "Zuto Payments Inc" },
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.ruleId === "PROTECTED_FACTS")).toBe(true);
  });

  it("fails when a benefit lacks evidence", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed({
        benefits: [
          "Guaranteed fraud prevention",
          "Faster settlements",
          "Support for every payment method",
        ],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.ruleId === "CLAIM_GROUNDING")).toBe(true);
  });

  it("fails when fewer than three distinct grounded benefits are supplied", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed({
        benefits: [
          "Verify available prefunded balances",
          "Verify available prefunded balances",
        ],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.ruleId === "BENEFIT_GROUNDING")).toBe(true);
  });

  it("fails when unsupported claims are present", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed({
        headline: "Guaranteed fraud prevention for every transaction",
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.ruleId === "UNSUPPORTED_CLAIMS")).toBe(true);
  });

  it("fails when placeholder content is present", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed({ headline: "[Your business] transforms payments" }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.ruleId === "PLACEHOLDER_CONTENT")).toBe(true);
  });

  it("fails when a required field is missing", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed({ headline: "" }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.ruleId === "STRUCTURED_SCHEMA")).toBe(true);
  });

  it("fails when prohibited claims are present", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed({
        primaryText: "Our service delivers risk free returns on every payout.",
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.ruleId === "UNSUPPORTED_CLAIMS")).toBe(true);
  });

  it("fails closed when the contract is not approved", () => {
    const contract = makeContract({ kind: "draft" } as any);
    const result = evaluateContentCompliance({
      contract: contract as any,
      proposed: makeProposed(),
    });
    expect(result.passed).toBe(false);
    const lineage = result.evaluatedRules.find((r) => r.ruleId === "CONTRACT_LINEAGE");
    expect(lineage?.status).toBe("fail");
  });

  it("reports rule IDs and evaluator version", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed(),
    });
    expect(result.evaluatorVersion).toContain("slice2");
    expect(result.evaluatedRules.every((r) => r.ruleId && r.status && r.reasonCode)).toBe(true);
  });

  it("does not treat prior AI-generated output as authoritative evidence", () => {
    const result = evaluateContentCompliance({
      contract: makeContract({
        groundedClaims: ["balance verification"],
      }),
      proposed: makeProposed({
        headline: "AI-generated headline about fraud prevention",
        benefits: [
          "Guaranteed fraud prevention",
          "Regulatory compliance built in",
          "Save money with automated payouts",
        ],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.ruleId === "CLAIM_GROUNDING")).toBe(true);
    expect(result.failures.some((f) => f.ruleId === "UNSUPPORTED_CLAIMS")).toBe(true);
  });

  it("classifies missing audience metadata deterministically via structured schema", () => {
    const result = evaluateContentCompliance({
      contract: makeContract(),
      proposed: makeProposed({ targetAudience: "" }),
    });
    expect(result.passed).toBe(false);
    const schemaFailure = result.failures.find((f) => f.ruleId === "STRUCTURED_SCHEMA");
    expect(schemaFailure?.reasonCode).toBe("MISSING_REQUIRED_FIELD");
  });

  describe("Campaign 30 regression matrix", () => {
    function campaign30Contract(overrides: Partial<ApprovedCreativeContract> = {}) {
      return makeContract({
        campaignId: 30,
        userId: 22,
        strategyRunId: 253,
        approvalRequestId: 36,
        approvedStrategyFingerprint: "fp-253",
        businessName: "Zuto Hub",
        funnelStage: "consideration",
        cta: { text: "Request a Consultation", source: "strategy_stage", locked: true },
        offer: { text: "Book a guided walkthrough", source: "approved_strategy", locked: true, required: false },
        targetAudience: "B2B finance teams and merchant operators",
        groundedClaims: [
          "B2B payment orchestration",
          "prefunded merchant-account administration",
          "balance verification",
          "transaction reservations",
          "controlled payment-instruction services",
        ],
        minimumBenefitCount: 3,
        ...overrides,
      });
    }

    function campaign30Proposed(overrides: Partial<ProposedCreativeContent> = {}) {
      return makeProposed({
        headline: "Streamline B2B Payment Orchestration",
        primaryText:
          "Zuto Hub provides prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
        benefits: [
          "Verify available prefunded balances before payment instructions are issued",
          "Reserve transaction amounts with traceable administration",
          "Issue controlled payment instructions from a central account",
        ],
        cta: "Request a Consultation",
        funnelStage: "consideration",
        targetAudience: "B2B finance teams and merchant operators",
        offer: "Book a guided walkthrough",
        businessName: "Zuto Hub",
        protectedFields: { businessName: "Zuto Hub" },
        ...overrides,
      });
    }

    it("positive fixture passes all hard-compliance rules", () => {
      const result = evaluateContentCompliance({
        contract: campaign30Contract(),
        proposed: campaign30Proposed(),
      });
      expect(result.passed).toBe(true);
      expect(result.failedRuleIds).toEqual([]);
      expect(result.distinctGroundedBenefitCount).toBeGreaterThanOrEqual(3);
      const ctaRule = result.evaluatedRules.find((r) => r.ruleId === "CTA_LOCKED");
      expect(ctaRule?.status).toBe("pass");
      expect(ctaRule?.reasonCode).toBe("CTA_MATCHES_CONTRACT");
    });

    it("negative A: Learn More CTA fails CTA_LOCKED", () => {
      const result = evaluateContentCompliance({
        contract: campaign30Contract(),
        proposed: campaign30Proposed({ cta: "Learn More" }),
      });
      expect(result.passed).toBe(false);
      const failure = result.failures.find((f) => f.ruleId === "CTA_LOCKED");
      expect(failure?.reasonCode).toBe("CTA_MISMATCH");
    });

    it("negative B: only two distinct grounded benefits fails BENEFIT_GROUNDING", () => {
      const result = evaluateContentCompliance({
        contract: campaign30Contract(),
        proposed: campaign30Proposed({
          benefits: [
            "Verify available prefunded balances before payment instructions are issued",
            "Verify available prefunded balances before payment instructions are issued",
          ],
        }),
      });
      expect(result.passed).toBe(false);
      const failure = result.failures.find((f) => f.ruleId === "BENEFIT_GROUNDING");
      expect(failure?.reasonCode).toBe("INSUFFICIENT_DISTINCT_GROUNDED_BENEFITS");
    });

    it("negative C: three paraphrases of one capability produce one distinct benefit and fail", () => {
      const result = evaluateContentCompliance({
        contract: campaign30Contract({
          groundedClaims: ["balance verification"],
        }),
        proposed: campaign30Proposed({
          benefits: [
            "Verify available prefunded balances",
            "Verify your prefunded balance",
            "Check prefunded balances before paying",
          ],
        }),
      });
      expect(result.passed).toBe(false);
      expect(result.distinctGroundedBenefitCount).toBe(1);
      const failure = result.failures.find((f) => f.ruleId === "BENEFIT_GROUNDING");
      expect(failure?.reasonCode).toBe("INSUFFICIENT_DISTINCT_GROUNDED_BENEFITS");
    });

    it("negative D: invented fraud-prevention claim fails", () => {
      const result = evaluateContentCompliance({
        contract: campaign30Contract(),
        proposed: campaign30Proposed({
          headline: "Guaranteed fraud prevention for every transaction",
        }),
      });
      expect(result.passed).toBe(false);
      expect(
        result.failures.some(
          (f) => f.ruleId === "UNSUPPORTED_CLAIMS" || f.ruleId === "CLAIM_GROUNDING"
        )
      ).toBe(true);
    });

    it("negative E: invented multiple-payment-method claim fails", () => {
      const result = evaluateContentCompliance({
        contract: campaign30Contract(),
        proposed: campaign30Proposed({
          primaryText: "Accept every payment method your customers prefer",
        }),
      });
      expect(result.passed).toBe(false);
      expect(
        result.failures.some(
          (f) => f.ruleId === "UNSUPPORTED_CLAIMS" || f.ruleId === "CLAIM_GROUNDING"
        )
      ).toBe(true);
    });

    it("negative F: free consultation invented from approved consultation fails", () => {
      const result = evaluateContentCompliance({
        contract: campaign30Contract({
          offer: { text: "Book a consultation", source: "approved_strategy", locked: true, required: false },
        }),
        proposed: campaign30Proposed({ offer: "Book a free consultation" }),
      });
      expect(result.passed).toBe(false);
      const failure = result.failures.find((f) => f.ruleId === "OFFER_AUTHORISED");
      expect(failure?.reasonCode).toBe("INVENTED_FREE_OFFER");
    });
  });
});
