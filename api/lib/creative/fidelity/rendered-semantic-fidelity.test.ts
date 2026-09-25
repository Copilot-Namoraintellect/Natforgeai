import { describe, expect, it } from "vitest";
import {
  evaluateRenderedSemanticFidelity,
  RENDERED_SEMANTIC_FIDELITY_EVALUATOR_VERSION,
  type RenderedCreativeSemanticContent,
  type RenderedSemanticFidelityResult,
} from "./rendered-semantic-fidelity";
import type {
  ApprovedCreativeContract,
  CreativeContract,
} from "../contracts/creative-contract";

const APPROVED_HEADLINE = "Streamline B2B Payment Orchestration";

function makeContract(
  overrides: Partial<ApprovedCreativeContract> = {}
): ApprovedCreativeContract {
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

function makeRendered(
  overrides: Partial<RenderedCreativeSemanticContent> = {}
): RenderedCreativeSemanticContent {
  return {
    headline: APPROVED_HEADLINE,
    subheadline:
      "Zuto Hub provides prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
    cta: "Request a Consultation",
    offer: "Book a guided walkthrough",
    claims: [
      "Verify available prefunded balances before payment instructions are issued",
      "Reserve transaction amounts with traceable administration",
      "Issue controlled payment instructions from a central account",
    ],
    contactDetails: [],
    businessName: "Zuto Hub",
    ...overrides,
  };
}

function evaluate(
  contractOverrides: Partial<ApprovedCreativeContract> = {},
  renderedOverrides: Partial<RenderedCreativeSemanticContent> = {},
  approvedHeadline: string | null = APPROVED_HEADLINE
): RenderedSemanticFidelityResult {
  return evaluateRenderedSemanticFidelity({
    contract: makeContract(contractOverrides),
    approvedHeadline,
    rendered: makeRendered(renderedOverrides),
  });
}

function checkOf(result: RenderedSemanticFidelityResult, checkId: string) {
  return result.checks.find((c) => c.checkId === checkId);
}

describe("rendered-semantic-fidelity", () => {
  it("passes a fully faithful rendered creative", () => {
    const result = evaluate();
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.missingApprovedElements).toEqual([]);
    expect(result.introducedUnsupportedClaims).toEqual([]);
    expect(result.evaluatorVersion).toBe(
      RENDERED_SEMANTIC_FIDELITY_EVALUATOR_VERSION
    );
    expect(checkOf(result, "LINEAGE_AUTHORITATIVE")?.status).toBe("pass");
    expect(checkOf(result, "APPROVED_HEADLINE_PRESENT")?.status).toBe("pass");
    expect(checkOf(result, "APPROVED_CTA_PRESENT")?.status).toBe("pass");
    expect(checkOf(result, "APPROVED_OFFER_PRESENT")?.status).toBe("pass");
    expect(checkOf(result, "APPROVED_CLAIMS_PRESENT")?.status).toBe("pass");
    expect(checkOf(result, "INTRODUCED_UNSUPPORTED_CLAIMS")?.status).toBe("pass");
  });

  it("fails closed when the contract is not approved", () => {
    const draft = { ...makeContract(), kind: "draft" } as CreativeContract;
    const result = evaluateRenderedSemanticFidelity({
      contract: draft as ApprovedCreativeContract,
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered(),
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].checkId).toBe("LINEAGE_AUTHORITATIVE");
    expect(result.failures[0].reasonCode).toBe("LINEAGE_NOT_AUTHORITATIVE");
    expect(
      result.checks
        .filter((c) => c.checkId !== "LINEAGE_AUTHORITATIVE")
        .every((c) => c.status === "not_applicable")
    ).toBe(true);
  });

  it("fails closed on malformed input", () => {
    const result = evaluateRenderedSemanticFidelity(null as unknown as {
      contract: ApprovedCreativeContract;
      rendered: RenderedCreativeSemanticContent;
    });
    expect(result.passed).toBe(false);
    expect(result.failures[0].reasonCode).toBe("FIDELITY_INPUT_INVALID");
  });

  it("detects a missing approved headline when none was rendered", () => {
    const result = evaluate({}, { headline: null });
    expect(result.passed).toBe(false);
    const check = checkOf(result, "APPROVED_HEADLINE_PRESENT");
    expect(check?.status).toBe("fail");
    expect(check?.reasonCode).toBe("MISSING_RENDERED_HEADLINE");
    expect(result.missingApprovedElements).toContainEqual({
      kind: "headline",
      expected: APPROVED_HEADLINE,
      observed: null,
      reasonCode: "MISSING_RENDERED_HEADLINE",
    });
  });

  it("detects a rendered headline that diverges from the approved headline", () => {
    const result = evaluate({}, { headline: "A completely different heading" });
    expect(result.passed).toBe(false);
    const check = checkOf(result, "APPROVED_HEADLINE_PRESENT");
    expect(check?.status).toBe("fail");
    expect(check?.reasonCode).toBe("APPROVED_HEADLINE_NOT_RENDERED");
    expect(
      result.missingApprovedElements.some(
        (m) => m.kind === "headline" && m.observed === "A completely different heading"
      )
    ).toBe(true);
  });

  it("accepts a headline that matches modulo case and punctuation", () => {
    const result = evaluate(
      {},
      { headline: "Streamline B2B payment orchestration!" }
    );
    expect(checkOf(result, "APPROVED_HEADLINE_PRESENT")?.status).toBe("pass");
  });

  it("treats the headline check as not_applicable when no approved headline exists", () => {
    const result = evaluate({}, { headline: null }, null);
    expect(result.passed).toBe(true);
    expect(checkOf(result, "APPROVED_HEADLINE_PRESENT")?.status).toBe(
      "not_applicable"
    );
  });

  it("detects a missing approved CTA when none was rendered", () => {
    const result = evaluate({}, { cta: null });
    expect(result.passed).toBe(false);
    const check = checkOf(result, "APPROVED_CTA_PRESENT");
    expect(check?.status).toBe("fail");
    expect(check?.reasonCode).toBe("MISSING_RENDERED_CTA");
    expect(result.missingApprovedElements).toContainEqual({
      kind: "cta",
      expected: "Request a Consultation",
      observed: null,
      reasonCode: "MISSING_RENDERED_CTA",
    });
  });

  it("detects a rendered CTA that overrides the approved CTA", () => {
    const result = evaluate({}, { cta: "Learn More" });
    expect(result.passed).toBe(false);
    const check = checkOf(result, "APPROVED_CTA_PRESENT");
    expect(check?.status).toBe("fail");
    expect(check?.reasonCode).toBe("RENDERED_CTA_OVERRIDES_APPROVED");
    expect(
      result.missingApprovedElements.some(
        (m) => m.kind === "cta" && m.observed === "Learn More"
      )
    ).toBe(true);
  });

  it("accepts a rendered CTA that extends the approved CTA text", () => {
    const result = evaluate({}, { cta: "Request a Consultation Today" });
    expect(checkOf(result, "APPROVED_CTA_PRESENT")?.status).toBe("pass");
  });

  it("detects a missing required approved offer", () => {
    const result = evaluate(
      {
        offer: {
          text: "Book a guided walkthrough",
          source: "approved_strategy",
          locked: true,
          required: true,
        },
      },
      { offer: null }
    );
    expect(result.passed).toBe(false);
    const check = checkOf(result, "APPROVED_OFFER_PRESENT");
    expect(check?.status).toBe("fail");
    expect(check?.reasonCode).toBe("MISSING_RENDERED_OFFER");
    expect(result.missingApprovedElements).toContainEqual({
      kind: "offer",
      expected: "Book a guided walkthrough",
      observed: null,
      reasonCode: "MISSING_RENDERED_OFFER",
    });
  });

  it("detects invented commercial terms when no offer was approved", () => {
    const result = evaluate(
      { offer: { text: null, source: "none", locked: true, required: false } },
      { offer: "Get 50% off your first month" }
    );
    expect(result.passed).toBe(false);
    const check = checkOf(result, "APPROVED_OFFER_PRESENT");
    expect(check?.status).toBe("fail");
    expect(check?.reasonCode).toBe("INVENTED_DISCOUNT");
  });

  it("detects invented terms added to an approved offer", () => {
    const result = evaluate(
      {
        offer: {
          text: "Book a consultation",
          source: "approved_strategy",
          locked: true,
          required: false,
        },
      },
      { offer: "Book a free consultation" }
    );
    expect(result.passed).toBe(false);
    expect(checkOf(result, "APPROVED_OFFER_PRESENT")?.reasonCode).toBe(
      "INVENTED_FREE_OFFER"
    );
  });

  it("detects approved claims missing from the render when the minimum is unmet", () => {
    const result = evaluate(
      {},
      {
        claims: ["Prefunded merchant-account administration"],
      }
    );
    expect(result.passed).toBe(false);
    const check = checkOf(result, "APPROVED_CLAIMS_PRESENT");
    expect(check?.status).toBe("fail");
    expect(check?.reasonCode).toBe("MISSING_APPROVED_CLAIMS");
  });

  it("fails closed when no claims were rendered but claims are required", () => {
    const result = evaluate({}, { claims: [] });
    expect(result.passed).toBe(false);
    expect(checkOf(result, "APPROVED_CLAIMS_PRESENT")?.reasonCode).toBe(
      "NO_RENDERED_CLAIMS"
    );
  });

  it("detects an introduced unsupported claim not backed by approved evidence", () => {
    const result = evaluate(
      {},
      {
        claims: [
          "Verify available prefunded balances before payment instructions are issued",
          "Reserve transaction amounts with traceable administration",
          "Issue controlled payment instructions from a central account",
          "AI-powered fraud prevention on every payment",
        ],
      }
    );
    expect(result.passed).toBe(false);
    const check = checkOf(result, "INTRODUCED_UNSUPPORTED_CLAIMS");
    expect(check?.status).toBe("fail");
    expect(check?.reasonCode).toBe("UNSUPPORTED_CLAIM_INTRODUCED");
    expect(result.introducedUnsupportedClaims).toContainEqual({
      field: "claims[3]",
      text: "AI-powered fraud prevention on every payment",
      reasonCode: "UNSUPPORTED_CLAIM_INTRODUCED",
    });
    // The grounded minimum is still met, so only the introduced-claim check fails.
    expect(checkOf(result, "APPROVED_CLAIMS_PRESENT")?.status).toBe("pass");
  });

  it("detects an ungrounded headline as an introduced claim", () => {
    const result = evaluate(
      {},
      { headline: "Quantum leap synergy for modern teams" }
    );
    expect(result.passed).toBe(false);
    expect(result.introducedUnsupportedClaims).toContainEqual({
      field: "headline",
      text: "Quantum leap synergy for modern teams",
      reasonCode: "UNGROUNDED_CLAIM_INTRODUCED",
    });
  });

  it("detects prohibited claims rendered into the artifact", () => {
    const result = evaluate(
      {},
      {
        claims: [
          "guaranteed instant wealth for your business",
          "prefunded merchant-account administration",
          "balance verification",
          "transaction reservations",
        ],
      }
    );
    expect(result.passed).toBe(false);
    const check = checkOf(result, "PROHIBITED_CLAIMS_ABSENT");
    expect(check?.status).toBe("fail");
    expect(check?.reasonCode).toBe("PROHIBITED_CLAIM_PRESENT");
  });

  it("detects missing required contact details", () => {
    const result = evaluate(
      { requiredContactDetails: ["phone", "email"] },
      { contactDetails: ["phone"] }
    );
    expect(result.passed).toBe(false);
    const check = checkOf(result, "REQUIRED_CONTACT_DETAILS_PRESENT");
    expect(check?.status).toBe("fail");
    expect(check?.reasonCode).toBe("MISSING_REQUIRED_CONTACT_DETAIL");
  });

  it("detects an altered business name", () => {
    const result = evaluate({}, { businessName: "Zuto Hub Plus" });
    expect(result.passed).toBe(false);
    const check = checkOf(result, "BUSINESS_NAME_PRESERVED");
    expect(check?.status).toBe("fail");
    expect(check?.reasonCode).toBe("BUSINESS_NAME_ALTERED");
  });

  it("records partially grounded rendered claims as warnings without failing", () => {
    const result = evaluate(
      {},
      {
        claims: [
          "Verify available prefunded balances before payment instructions are issued",
          "Reserve transaction amounts with traceable administration",
          "Issue controlled payment instructions from a central account",
          "Prefunded merchant-account administration with guaranteed fraud prevention shields",
        ],
      }
    );
    expect(checkOf(result, "APPROVED_CLAIMS_PRESENT")?.status).toBe("pass");
    expect(checkOf(result, "INTRODUCED_UNSUPPORTED_CLAIMS")?.status).toBe("pass");
    expect(result.passed).toBe(true);
    expect(
      result.diagnostics.some((d) => d.includes("partially grounded"))
    ).toBe(true);
  });

  it("reports absent approved claims in diagnostics without failing when the minimum is met", () => {
    const result = evaluate({}, { subheadline: null });
    expect(result.passed).toBe(true);
    expect(
      result.diagnostics.some((d) =>
        d.includes('Approved claim "transaction reservations" does not appear')
      )
    ).toBe(true);
  });

  it("is deterministic across repeated evaluations", () => {
    const first = evaluate();
    const second = evaluate();
    expect(first).toEqual(second);
  });

  it("does not mutate its inputs", () => {
    const contract = makeContract();
    const rendered = makeRendered();
    const contractBefore = structuredClone(contract);
    const renderedBefore = structuredClone(rendered);
    evaluateRenderedSemanticFidelity({
      contract,
      approvedHeadline: APPROVED_HEADLINE,
      rendered,
    });
    expect(contract).toEqual(contractBefore);
    expect(rendered).toEqual(renderedBefore);
  });

  it("exposes contract and evidence-set fingerprints for traceability", () => {
    const result = evaluate();
    expect(result.contractFingerprint).toBe("contract-fp");
    expect(result.evidenceSetFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
