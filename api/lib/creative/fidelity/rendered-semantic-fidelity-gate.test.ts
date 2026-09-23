import { describe, expect, it, vi } from "vitest";
import {
  evaluateRenderedSemanticFidelity,
  RENDERED_SEMANTIC_FIDELITY_EVALUATOR_VERSION,
  type RenderedCreativeSemanticContent,
} from "./rendered-semantic-fidelity";
import {
  evaluateRenderedSemanticFidelityGate,
  type RenderedSemanticFidelityGateDecision,
} from "./rendered-semantic-fidelity-gate";
import type { ApprovedCreativeContract } from "../contracts/creative-contract";

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

function gate(
  mode: "observe" | "enforce",
  contractOverrides: Partial<ApprovedCreativeContract> = {},
  renderedOverrides: Partial<RenderedCreativeSemanticContent> = {},
  approvedHeadline: string | null = APPROVED_HEADLINE
): RenderedSemanticFidelityGateDecision {
  return evaluateRenderedSemanticFidelityGate({
    contract: makeContract(contractOverrides),
    approvedHeadline,
    rendered: makeRendered(renderedOverrides),
    mode,
  });
}

describe("rendered-semantic-fidelity-gate", () => {
  it("passes a faithful render in enforce mode without blocking", () => {
    const decision = gate("enforce");
    expect(decision.mode).toBe("enforce");
    expect(decision.blocked).toBe(false);
    expect(decision.wouldBlock).toBe(false);
    expect(decision.reasonCodes).toEqual([]);
    expect(decision.evaluation?.passed).toBe(true);
    expect(decision.contractFingerprint).toBe("contract-fp");
    expect(decision.evidenceSetFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(decision.evaluatorVersion).toBe(
      RENDERED_SEMANTIC_FIDELITY_EVALUATOR_VERSION
    );
  });

  it("records wouldBlock in observe mode without blocking production", () => {
    const decision = gate("observe", {}, { cta: "Learn More" });
    expect(decision.mode).toBe("observe");
    expect(decision.blocked).toBe(false);
    expect(decision.wouldBlock).toBe(true);
    expect(decision.evaluation?.passed).toBe(false);
    expect(decision.reasonCodes).toContain("RENDERED_CTA_OVERRIDES_APPROVED");
  });

  it("blocks fail-closed in enforce mode on a failed evaluation", () => {
    const decision = gate("enforce", {}, { cta: "Learn More" });
    expect(decision.mode).toBe("enforce");
    expect(decision.blocked).toBe(true);
    expect(decision.wouldBlock).toBe(true);
    expect(decision.reasonCodes).toEqual(["RENDERED_CTA_OVERRIDES_APPROVED"]);
  });

  it("blocks on malformed rendered input in enforce mode and reports the evaluator code", () => {
    const decision = evaluateRenderedSemanticFidelityGate({
      contract: makeContract(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: null as unknown as RenderedCreativeSemanticContent,
      mode: "enforce",
    });
    expect(decision.blocked).toBe(true);
    expect(decision.wouldBlock).toBe(true);
    expect(decision.reasonCodes).toEqual(["FIDELITY_INPUT_INVALID"]);
  });

  it("does not block malformed input in observe mode but records wouldBlock", () => {
    const decision = evaluateRenderedSemanticFidelityGate({
      contract: makeContract(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: undefined as unknown as RenderedCreativeSemanticContent,
      mode: "observe",
    });
    expect(decision.blocked).toBe(false);
    expect(decision.wouldBlock).toBe(true);
    expect(decision.reasonCodes).toEqual(["FIDELITY_INPUT_INVALID"]);
  });

  it("blocks on an introduced unsupported claim with the evaluator's exact code", () => {
    const decision = gate(
      "enforce",
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
    expect(decision.blocked).toBe(true);
    expect(decision.reasonCodes).toContain("UNSUPPORTED_CLAIM_INTRODUCED");
  });

  it("blocks on a missing approved CTA with the evaluator's exact code", () => {
    const decision = gate("enforce", {}, { cta: null });
    expect(decision.blocked).toBe(true);
    expect(decision.reasonCodes).toContain("MISSING_RENDERED_CTA");
  });

  it("blocks on a missing approved headline with the evaluator's exact code", () => {
    const decision = gate("enforce", {}, { headline: null });
    expect(decision.blocked).toBe(true);
    expect(decision.reasonCodes).toContain("MISSING_RENDERED_HEADLINE");
  });

  it("preserves the evaluator's reason codes verbatim rather than inventing new ones", () => {
    const contract = makeContract();
    const rendered = makeRendered({ cta: "Learn More", headline: null });
    const evaluation = evaluateRenderedSemanticFidelity({
      contract,
      approvedHeadline: APPROVED_HEADLINE,
      rendered,
    });
    const decision = evaluateRenderedSemanticFidelityGate({
      contract,
      approvedHeadline: APPROVED_HEADLINE,
      rendered,
      mode: "enforce",
    });
    expect(decision.reasonCodes).toEqual(
      evaluation.failures.map((failure) => failure.reasonCode)
    );
    expect(decision.evaluation).toEqual(evaluation);
  });

  it("treats an unrecognised runtime mode as observe and never blocks", () => {
    const decision = evaluateRenderedSemanticFidelityGate({
      contract: makeContract(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered({ cta: "Learn More" }),
      mode: "enfoce" as unknown as "enforce",
    });
    expect(decision.mode).toBe("observe");
    expect(decision.blocked).toBe(false);
    expect(decision.wouldBlock).toBe(true);
  });

  it("produces identical decisions for identical inputs (deterministic replay)", () => {
    const first = gate("enforce", {}, { cta: null });
    const second = gate("enforce", {}, { cta: null });
    expect(first).toEqual(second);
    const third = gate("observe", {}, { headline: "Something else entirely" });
    const fourth = gate("observe", {}, { headline: "Something else entirely" });
    expect(third).toEqual(fourth);
  });

  it("never mutates the approved contract or rendered observation", () => {
    const contract = makeContract();
    const rendered = makeRendered({ cta: "Learn More" });
    const contractBefore = structuredClone(contract);
    const renderedBefore = structuredClone(rendered);
    evaluateRenderedSemanticFidelityGate({
      contract,
      approvedHeadline: APPROVED_HEADLINE,
      rendered,
      mode: "enforce",
    });
    expect(contract).toEqual(contractBefore);
    expect(rendered).toEqual(renderedBefore);
  });

  it("blocks fail-closed in enforce mode when the evaluation is unavailable", async () => {
    vi.resetModules();
    vi.doMock("./rendered-semantic-fidelity", () => ({
      evaluateRenderedSemanticFidelity: () => {
        throw new Error("delegate exploded");
      },
      RENDERED_SEMANTIC_FIDELITY_EVALUATOR_VERSION:
        RENDERED_SEMANTIC_FIDELITY_EVALUATOR_VERSION,
    }));
    const gatedModule = await import("./rendered-semantic-fidelity-gate");
    const decision = gatedModule.evaluateRenderedSemanticFidelityGate({
      contract: makeContract(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered(),
      mode: "enforce",
    });
    expect(decision.evaluation).toBeNull();
    expect(decision.wouldBlock).toBe(true);
    expect(decision.blocked).toBe(true);
    expect(decision.reasonCodes).toEqual(["FIDELITY_EVALUATION_ERROR"]);
    expect(decision.contractFingerprint).toBe("");
    expect(decision.evidenceSetFingerprint).toBe("");
    expect(decision.evaluatorVersion).toBe(
      RENDERED_SEMANTIC_FIDELITY_EVALUATOR_VERSION
    );
    vi.resetModules();
  });
});
