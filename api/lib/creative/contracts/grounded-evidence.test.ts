import { describe, expect, it } from "vitest";
import {
  computeEvidenceIdentity,
  buildEvidenceIdentityCanonical,
  buildGroundedBenefits,
  buildGroundedBenefitsFromCapabilities,
  validateClaim,
  validateOffer,
  validateAudience,
  isUnsupportedClaim,
  isInventedOffer,
  compileEvidenceSet,
  compileGroundedEvidence,
  type EvidenceSet,
  type GroundedEvidenceItem,
} from "./grounded-evidence";
import { type ApprovedCreativeContract } from "./creative-contract";

function makeEvidenceSet(items: GroundedEvidenceItem[]): EvidenceSet {
  return {
    evidenceSetFingerprint: "test-fingerprint",
    items,
    evidenceById: new Map(items.map((item) => [item.evidenceId, item])),
  };
}

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

describe("grounded-evidence", () => {
    it("equivalent normalized evidence produces the same evidence ID", () => {
      const id1 = computeEvidenceIdentity({
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "  Balance   Verification  ",
      });
      const id2 = computeEvidenceIdentity({
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "balance verification",
      });
      expect(id1).toBe(id2);
    });

    it("materially changed evidence produces a different ID", () => {
      const id1 = computeEvidenceIdentity({
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "balance verification",
      });
      const id2 = computeEvidenceIdentity({
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "transaction reservations",
      });
      expect(id1).not.toBe(id2);
    });

    it("object key order does not affect evidence ID", () => {
      const id1 = computeEvidenceIdentity({
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "balance verification",
      });
      const id2 = computeEvidenceIdentity({
        canonicalText: "balance verification",
        sourceFingerprint: "fp1",
        sourceField: "approvedStrategy.businessCapabilities",
        evidenceType: "business_capability",
      });
      expect(id1).toBe(id2);
    });

    it("evidence ID does not contain raw sensitive business text", () => {
      const id = computeEvidenceIdentity({
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "Super Secret Competitive Capability",
      });
      expect(id.includes("Super Secret Competitive Capability")).toBe(false);
      expect(id).toMatch(/^[a-f0-9]{64}$/);
    });

    it("canonical identity payload explicitly contains evidenceType, sourceField, sourceFingerprint and canonicalText", () => {
      const canonical = buildEvidenceIdentityCanonical({
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "  Balance   Verification  ",
      });
      const parsed = JSON.parse(canonical);
      expect(parsed).toEqual({
        canonicalText: "balance verification",
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
      });
      expect(Object.keys(parsed).sort()).toEqual([
        "canonicalText",
        "evidenceType",
        "sourceField",
        "sourceFingerprint",
      ]);
    });

    it("changed evidence type changes the evidence ID", () => {
      const id1 = computeEvidenceIdentity({
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "balance verification",
      });
      const id2 = computeEvidenceIdentity({
        evidenceType: "verified_business_fact",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "balance verification",
      });
      expect(id1).not.toBe(id2);
    });

    it("changed source fingerprint changes the evidence ID", () => {
      const id1 = computeEvidenceIdentity({
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "balance verification",
      });
      const id2 = computeEvidenceIdentity({
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp2",
        canonicalText: "balance verification",
      });
      expect(id1).not.toBe(id2);
    });

    it("display-only formatting does not change the evidence ID", () => {
      const id1 = computeEvidenceIdentity({
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "Balance verification",
      });
      const id2 = computeEvidenceIdentity({
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "  balance   verification  ",
      });
      expect(id1).toBe(id2);
    });

    it("displayText does not participate in evidence identity", () => {
      const contractA = makeContract({
        groundedClaims: ["balance verification"],
      });
      const contractB = makeContract({
        groundedClaims: ["  balance   verification  "],
      });
      const setA = compileEvidenceSet(contractA, contractA.contractFingerprint);
      const setB = compileEvidenceSet(contractB, contractB.contractFingerprint);
      const capsA = setA.items.filter((item) => item.evidenceType === "business_capability");
      const capsB = setB.items.filter((item) => item.evidenceType === "business_capability");
      expect(capsA.length).toBe(1);
      expect(capsB.length).toBe(1);
      expect(capsA[0].evidenceId).toBe(capsB[0].evidenceId);
      expect(capsA[0].displayText).not.toBe(capsB[0].displayText);
    });

    it("no runtime timestamp or random identifier affects evidence identity", () => {
      const base = {
        evidenceType: "business_capability" as const,
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "balance verification",
      };
      const id1 = computeEvidenceIdentity(base);
      const id2 = computeEvidenceIdentity(base);
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("evidence set compilation", () => {
    it("compiles evidence from an approved contract", () => {
      const contract = makeContract();
      const set = compileEvidenceSet(contract, contract.contractFingerprint);
      expect(set.items.length).toBeGreaterThan(0);
      expect(set.evidenceSetFingerprint).toBeTruthy();
      const capabilityItems = set.items.filter(
        (item) => item.evidenceType === "business_capability"
      );
      expect(capabilityItems.length).toBe(contract.groundedClaims.length);
    });

    it("returns an empty evidence set for a draft contract", () => {
      const contract = makeContract({ kind: "draft" } as any);
      const set = compileEvidenceSet(contract as any, contract.contractFingerprint);
      expect(set.items).toEqual([]);
      expect(set.evidenceSetFingerprint).toBe("");
    });

    it("does not duplicate equivalent evidence", () => {
      const contract = makeContract({
        groundedClaims: [
          "balance verification",
          "  balance   verification  ",
          "transaction reservations",
        ],
      });
      const set = compileEvidenceSet(contract, contract.contractFingerprint);
      const capabilityItems = set.items.filter(
        (item) => item.evidenceType === "business_capability"
      );
      expect(capabilityItems.length).toBe(2);
    });

    it("rejected, stale or pending strategy does not become evidence", () => {
      const draft = makeContract({ kind: "draft" } as any);
      const set = compileEvidenceSet(draft as any, draft.contractFingerprint);
      expect(set.items).toEqual([]);
      expect(set.evidenceSetFingerprint).toBe("");
    });
  });

  describe("benefit construction and distinctness", () => {
    it("builds three distinct benefits from three grounded capabilities", () => {
      const contract = makeContract({
        groundedClaims: [
          "balance verification",
          "transaction reservations",
          "controlled payment-instruction services",
        ],
      });
      const compiled = compileGroundedEvidence(contract);
      const groundedBenefits = compiled.benefits.filter(
        (b) => b.validationStatus === "grounded"
      );
      expect(groundedBenefits.length).toBe(3);
      expect(compiled.distinctBenefitCount).toBe(3);
    });

    it("does not count one capability paraphrased three ways as three distinct benefits", () => {
      const contract = makeContract({
        groundedClaims: [
          "balance verification",
          "verify balances",
          "verifying available balances",
        ],
      });
      const compiled = compileGroundedEvidence(contract);
      const distinct = compiled.distinctBenefitCount;
      expect(distinct).toBeLessThan(3);
    });

    it("emits ungrounded placeholders when capabilities are insufficient", () => {
      const contract = makeContract({
        groundedClaims: ["balance verification"],
        minimumBenefitCount: 3,
      });
      const compiled = compileGroundedEvidence(contract);
      expect(compiled.benefits.length).toBe(3);
      expect(
        compiled.benefits.filter((b) => b.validationStatus === "ungrounded").length
      ).toBe(2);
    });

    it("counts three legitimately different capabilities as three distinct benefits", () => {
      const contract = makeContract({
        groundedClaims: [
          "balance verification",
          "transaction reservations",
          "controlled payment-instruction services",
        ],
      });
      const compiled = compileGroundedEvidence(contract);
      expect(compiled.distinctBenefitCount).toBe(3);
    });

    it("counts three paraphrases of one capability as one distinct benefit", () => {
      const contract = makeContract({
        groundedClaims: [
          "balance verification",
          "verify balances",
          "verifying available balances",
        ],
      });
      const compiled = compileGroundedEvidence(contract);
      expect(compiled.distinctBenefitCount).toBe(1);
    });

    it("keeps the same distinct count when evidence IDs are listed in reverse order", () => {
      const compiledA = compileGroundedEvidence(
        makeContract({ groundedClaims: ["balance verification", "transaction reservations"] })
      );
      const compiledB = compileGroundedEvidence(
        makeContract({ groundedClaims: ["transaction reservations", "balance verification"] })
      );
      expect(compiledA.distinctBenefitCount).toBe(2);
      expect(compiledB.distinctBenefitCount).toBe(2);
    });
  });

  describe("grounded claim validation", () => {
    it("passes a claim directly supported by business evidence", () => {
      const evidence: GroundedEvidenceItem = {
        evidenceId: "ev1",
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "balance verification",
        displayText: "balance verification",
        locked: false,
      };
      const set = makeEvidenceSet([evidence]);
      const claim = validateClaim("Verify balances before issuing payment instructions", set);
      expect(claim.validationStatus).toBe("grounded");
      expect(claim.evidenceIds).toContain("ev1");
    });

    it("fails an unsupported claim", () => {
      const evidence: GroundedEvidenceItem = {
        evidenceId: "ev1",
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: "fp1",
        canonicalText: "balance verification",
        displayText: "balance verification",
        locked: false,
      };
      const set = makeEvidenceSet([evidence]);
      const claim = validateClaim("Guaranteed fraud prevention across all transactions", set);
      expect(claim.validationStatus).toBe("ungrounded");
      expect(claim.evidenceIds.length).toBe(0);
    });

    it("does not treat generic marketing language as evidence", () => {
      const contract = makeContract({
        groundedClaims: ["balance verification", "transaction reservations"],
      });
      const compiled = compileGroundedEvidence(contract);
      const claim = validateClaim(
        "Unlock your potential and transform your business today",
        compiled.evidenceSet
      );
      expect(claim.validationStatus).toBe("ungrounded");
    });

    it("does not match a phrase inside an unrelated larger word", () => {
      const set = makeEvidenceSet([
        {
          evidenceId: "ev-credit",
          evidenceType: "business_capability",
          sourceField: "approvedStrategy.businessCapabilities",
          sourceFingerprint: "fp1",
          canonicalText: "credit",
          displayText: "credit",
          locked: false,
        },
      ]);
      const accredited = validateClaim("Our platform is fully accredited", set);
      expect(accredited.validationStatus).toBe("ungrounded");
    });

    it("does not match 'free' inside 'freedom'", () => {
      const set = makeEvidenceSet([
        {
          evidenceId: "ev-free",
          evidenceType: "approved_offer",
          sourceField: "approvedStrategy.offer",
          sourceFingerprint: "fp1",
          canonicalText: "free",
          displayText: "free",
          locked: false,
        },
      ]);
      const claim = validateClaim("Experience the freedom to choose", set);
      expect(claim.validationStatus).toBe("ungrounded");
    });

    it("does not authorise a negated claim", () => {
      const set = makeEvidenceSet([
        {
          evidenceId: "ev-credit",
          evidenceType: "business_capability",
          sourceField: "approvedStrategy.businessCapabilities",
          sourceFingerprint: "fp1",
          canonicalText: "credit",
          displayText: "credit",
          locked: false,
        },
      ]);
      const negated = validateClaim("We do not provide credit", set);
      expect(negated.validationStatus).toBe("ungrounded");
    });

    it("classifies a composite claim with one grounded and one unsupported clause as partially grounded", () => {
      const set = makeEvidenceSet([
        {
          evidenceId: "ev-balance",
          evidenceType: "business_capability",
          sourceField: "approvedStrategy.businessCapabilities",
          sourceFingerprint: "fp1",
          canonicalText: "balance verification",
          displayText: "balance verification",
          locked: false,
        },
      ]);
      const claim = validateClaim(
        "Balance verification keeps you safe and guarantees fraud prevention",
        set
      );
      expect(claim.validationStatus).toBe("partially_grounded");
      expect(claim.evidenceIds).toContain("ev-balance");
    });

    it("only evidence IDs present in the evidence set can ground a claim", () => {
      const set = makeEvidenceSet([
        {
          evidenceId: "ev-real",
          evidenceType: "business_capability",
          sourceField: "approvedStrategy.businessCapabilities",
          sourceFingerprint: "fp1",
          canonicalText: "balance verification",
          displayText: "balance verification",
          locked: false,
        },
      ]);
      const claim = validateClaim("Verify balances before issuing payment instructions", set);
      expect(claim.evidenceIds).toContain("ev-real");
      expect(claim.evidenceIds).not.toContain("ev-fabricated");
      expect(claim.evidenceIds.length).toBe(1);
    });
  });

  describe("unsupported claim detection", () => {
    it("flags invented fraud prevention", () => {
      const contract = makeContract();
      const compiled = compileGroundedEvidence(contract);
      expect(
        isUnsupportedClaim(
          "Our platform guarantees fraud prevention for every payment",
          compiled.evidenceSet
        )
      ).toBe(true);
    });

    it("flags invented multiple payment methods", () => {
      const contract = makeContract();
      const compiled = compileGroundedEvidence(contract);
      expect(
        isUnsupportedClaim(
          "Accept every payment method your customers prefer",
          compiled.evidenceSet
        )
      ).toBe(true);
    });

    it("allows supported capabilities", () => {
      const contract = makeContract();
      const compiled = compileGroundedEvidence(contract);
      expect(
        isUnsupportedClaim(
          "Use balance verification before issuing payment instructions",
          compiled.evidenceSet
        )
      ).toBe(false);
    });
  });

  describe("offer validation", () => {
    it("flags invented free consultation when only consultation is approved", () => {
      const contract = makeContract({
        offer: { text: "Book a consultation", source: "approved_strategy", locked: true, required: false },
      });
      const result = validateOffer("Book a free consultation", contract);
      expect(result.valid).toBe(false);
      expect(result.code).toBe("INVENTED_FREE_OFFER");
    });

    it("allows optional approved offer to be omitted", () => {
      const contract = makeContract({ offer: { text: null, source: "none", locked: true, required: false } });
      const result = validateOffer("", contract);
      expect(result.valid).toBe(true);
    });

    it("flags invented discount", () => {
      const contract = makeContract();
      const result = validateOffer("Get 50% off today", contract);
      expect(result.valid).toBe(false);
      expect(result.code).toBe("INVENTED_DISCOUNT");
    });

    it("flags offer override", () => {
      const contract = makeContract({
        offer: { text: "Book a guided walkthrough", source: "approved_strategy", locked: true, required: false },
      });
      const result = validateOffer("Start your free trial now", contract);
      expect(result.valid).toBe(false);
    });
  });

  describe("audience validation", () => {
    it("allows compatible nonliteral audience wording", () => {
      const contract = makeContract();
      const result = validateAudience(
        "Built for finance teams managing merchant operations",
        contract
      );
      expect(result.consistent).toBe(true);
    });

    it("flags conflicting B2C audience against B2B contract", () => {
      const contract = makeContract();
      const result = validateAudience(
        "Perfect for individual consumers shopping online",
        contract
      );
      expect(result.consistent).toBe(false);
      expect(result.code).toBe("AUDIENCE_B2C_CONFLICT_WITH_B2B_CONTRACT");
    });
  });

  describe("buildGroundedBenefitsFromCapabilities", () => {
    it("produces deterministic benefit IDs for the same input", () => {
      const result1 = buildGroundedBenefitsFromCapabilities(
        ["balance verification", "transaction reservations"],
        2,
        "fp"
      );
      const result2 = buildGroundedBenefitsFromCapabilities(
        ["balance verification", "transaction reservations"],
        2,
        "fp"
      );
      expect(result1.benefits.map((b) => b.benefitId)).toEqual(
        result2.benefits.map((b) => b.benefitId)
      );
    });

    it("fills ungrounded placeholders when capabilities are insufficient", () => {
      const result = buildGroundedBenefitsFromCapabilities(
        ["balance verification"],
        3,
        "fp"
      );
      expect(result.benefits.length).toBe(3);
      expect(result.benefits.filter((b) => b.validationStatus === "ungrounded").length).toBe(2);
    });
  });

  describe("inventedOffer helper", () => {
    it("detects invented free trial", () => {
      const result = isInventedOffer("Start your free trial", null);
      expect(result.invented).toBe(true);
      expect(result.code).toBe("INVENTED_FREE_TRIAL");
    });

    it("allows approved offer phrase", () => {
      const result = isInventedOffer("Book a free consultation", "Book a free consultation");
      expect(result.invented).toBe(false);
    });
  });
