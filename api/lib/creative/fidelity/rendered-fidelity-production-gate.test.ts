import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateRenderedFidelityProductionGate,
  getRenderedFidelityGateMode,
} from "./rendered-fidelity-production-gate";
import type { RenderedCreativeSemanticContent } from "./rendered-semantic-fidelity";
import * as gateAdapter from "./rendered-semantic-fidelity-gate";
import type { QualityAuthorityObservationInput } from "../contracts/observe-quality-authority";
import type { ApprovedStrategyLineage } from "../contracts/creative-contract";

const APPROVED_HEADLINE = "Streamline B2B Payment Orchestration";

const LINEAGE: ApprovedStrategyLineage = {
  campaignId: 30,
  userId: 22,
  strategyRunId: 253,
  approvalRequestId: 36,
  approvedStrategyFingerprint: "strategy-fp",
  approvedAt: "2026-07-01T08:00:00.000Z",
  status: "approved",
  strategyRunStatus: "completed",
};

function makeAuthority(
  overrides: Partial<QualityAuthorityObservationInput> = {}
): QualityAuthorityObservationInput {
  return {
    campaignId: 30,
    userId: 22,
    businessId: 24,
    businessName: "Zuto Hub",
    lineage: { ...LINEAGE },
    expectedApprovedStrategyFingerprint: "strategy-fp",
    funnelStage: "consideration",
    campaignWideCta: "Request a Consultation",
    campaignInputCta: "Request a Consultation",
    targetAudience: "B2B finance teams and merchant operators",
    offer: "Book a guided walkthrough",
    offerRequired: false,
    businessCapabilities: [
      "B2B payment orchestration",
      "prefunded merchant-account administration",
      "balance verification",
      "transaction reservations",
      "controlled payment-instruction services",
    ],
    legacySelectedCta: "Request a Consultation",
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

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.RENDERED_FIDELITY_GATE_MODE;
});

describe("getRenderedFidelityGateMode", () => {
  it("defaults to observe (shadow) when the variable is unset", () => {
    delete process.env.RENDERED_FIDELITY_GATE_MODE;
    const result = getRenderedFidelityGateMode();
    expect(result.requestedMode).toBeNull();
    expect(result.effectiveMode).toBe("observe");
    expect(result.warning).toBeNull();
  });

  it("honours explicit off / observe / enforce values case-insensitively", () => {
    expect(getRenderedFidelityGateMode("off").effectiveMode).toBe("off");
    expect(getRenderedFidelityGateMode("observe").effectiveMode).toBe("observe");
    expect(getRenderedFidelityGateMode("ENFORCE").effectiveMode).toBe("enforce");
    expect(getRenderedFidelityGateMode(" Enforce ").effectiveMode).toBe("enforce");
  });

  it("allows enforce (no QUALITY_AUTHORITY_MODE-style embargo)", () => {
    const result = getRenderedFidelityGateMode("enforce");
    expect(result.effectiveMode).toBe("enforce");
    expect(result.warning).toBeNull();
  });

  it("degrades unknown values to observe with a warning", () => {
    const result = getRenderedFidelityGateMode("banana");
    expect(result.requestedMode).toBe("banana");
    expect(result.effectiveMode).toBe("observe");
    expect(result.warning).toMatch(/Unknown RENDERED_FIDELITY_GATE_MODE/);
  });

  it("treats an empty value as unset (observe)", () => {
    expect(getRenderedFidelityGateMode("").effectiveMode).toBe("observe");
    expect(getRenderedFidelityGateMode("   ").effectiveMode).toBe("observe");
  });
});

describe("evaluateRenderedFidelityProductionGate", () => {
  it("is not_requested in off mode and never evaluates", () => {
    const spy = vi.spyOn(gateAdapter, "evaluateRenderedSemanticFidelityGate");
    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "off",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered(),
    });
    expect(outcome.status).toBe("not_requested");
    expect(outcome.notRequestedReason).toBe("gate_mode_off");
    expect(outcome.blocked).toBe(false);
    expect(outcome.wouldBlock).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("is not_requested when no approved lineage exists, in both modes", () => {
    for (const mode of ["observe", "enforce"] as const) {
      const outcome = evaluateRenderedFidelityProductionGate({
        mode,
        authority: makeAuthority({ lineage: null }),
        approvedHeadline: APPROVED_HEADLINE,
        rendered: makeRendered(),
      });
      expect(outcome.status).toBe("not_requested");
      expect(outcome.notRequestedReason).toMatch(/^lineage_not_authoritative:/);
      expect(outcome.blocked).toBe(false);
    }
  });

  it("is not_requested when the lineage fingerprint is stale, even in enforce mode", () => {
    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "enforce",
      authority: makeAuthority({ expectedApprovedStrategyFingerprint: "different-fp" }),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered(),
    });
    expect(outcome.status).toBe("not_requested");
    expect(outcome.notRequestedReason).toBe("lineage_not_authoritative:stale_strategy");
    expect(outcome.blocked).toBe(false);
  });

  it("observes a faithful render in observe mode without wouldBlock", () => {
    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "observe",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered(),
    });
    expect(outcome.status).toBe("observed");
    expect(outcome.mode).toBe("observe");
    expect(outcome.blocked).toBe(false);
    expect(outcome.wouldBlock).toBe(false);
    expect(outcome.reasonCodes).toEqual([]);
    expect(outcome.evaluation?.passed).toBe(true);
    expect(outcome.contractFingerprint).toBeTruthy();
    expect(outcome.evidenceSetFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports wouldBlock with verbatim reason codes in observe mode but never blocks", () => {
    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "observe",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered({ cta: "Learn More" }),
    });
    expect(outcome.status).toBe("observed");
    expect(outcome.blocked).toBe(false);
    expect(outcome.wouldBlock).toBe(true);
    expect(outcome.reasonCodes).toContain("RENDERED_CTA_OVERRIDES_APPROVED");
  });

  it("blocks a missing approved CTA in enforce mode", () => {
    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "enforce",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered({ cta: "Learn More" }),
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.mode).toBe("enforce");
    expect(outcome.blocked).toBe(true);
    expect(outcome.wouldBlock).toBe(true);
    expect(outcome.reasonCodes).toEqual(["RENDERED_CTA_OVERRIDES_APPROVED"]);
    expect(outcome.message).toContain("RENDERED_CTA_OVERRIDES_APPROVED");
    expect(outcome.message).not.toContain("Learn More");
  });

  it("blocks a missing approved headline in enforce mode", () => {
    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "enforce",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered({ headline: "A completely different headline" }),
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasonCodes).toContain("APPROVED_HEADLINE_NOT_RENDERED");
  });

  it("blocks an unsupported introduced claim in enforce mode", () => {
    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "enforce",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered({
        claims: [
          "Verify available prefunded balances before payment instructions are issued",
          "Reserve transaction amounts with traceable administration",
          "Issue controlled payment instructions from a central account",
          "AI-powered fraud prevention on every payment",
        ],
      }),
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasonCodes).toContain("UNSUPPORTED_CLAIM_INTRODUCED");
  });

  it("blocks missing required grounded claims in enforce mode", () => {
    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "enforce",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered({ claims: [] }),
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasonCodes).toContain("NO_RENDERED_CLAIMS");
  });

  it("passes a faithful render in enforce mode", () => {
    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "enforce",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered(),
    });
    expect(outcome.status).toBe("passed");
    expect(outcome.blocked).toBe(false);
    expect(outcome.wouldBlock).toBe(false);
    expect(outcome.evaluation?.passed).toBe(true);
  });

  it("fails closed on malformed rendered input in enforce mode", () => {
    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "enforce",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: null as unknown as RenderedCreativeSemanticContent,
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.blocked).toBe(true);
    expect(outcome.reasonCodes).toEqual(["FIDELITY_INPUT_INVALID"]);
  });

  it("fails closed in enforce mode and observes in observe mode when the evaluation is unavailable", () => {
    vi.spyOn(gateAdapter, "evaluateRenderedSemanticFidelityGate").mockImplementation(
      () => {
        throw new Error("delegate boom");
      }
    );

    const enforceOutcome = evaluateRenderedFidelityProductionGate({
      mode: "enforce",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered(),
    });
    expect(enforceOutcome.status).toBe("blocked");
    expect(enforceOutcome.blocked).toBe(true);
    expect(enforceOutcome.wouldBlock).toBe(true);
    expect(enforceOutcome.reasonCodes).toEqual(["FIDELITY_EVALUATION_ERROR"]);
    expect(enforceOutcome.evaluation).toBeNull();

    const observeOutcome = evaluateRenderedFidelityProductionGate({
      mode: "observe",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered(),
    });
    expect(observeOutcome.status).toBe("observed");
    expect(observeOutcome.blocked).toBe(false);
    expect(observeOutcome.wouldBlock).toBe(true);
    expect(observeOutcome.reasonCodes).toEqual(["FIDELITY_EVALUATION_ERROR"]);
  });

  it("never throws even when the authority input is garbage", () => {
    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "enforce",
      authority: null as unknown as QualityAuthorityObservationInput,
      approvedHeadline: null,
      rendered: makeRendered(),
    });
    expect(outcome.status).toBe("not_requested");
    expect(outcome.blocked).toBe(false);
  });

  it("resolves RENDERED_FIDELITY_GATE_MODE from the environment by default", () => {
    process.env.RENDERED_FIDELITY_GATE_MODE = "enforce";
    const outcome = evaluateRenderedFidelityProductionGate({
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered({ cta: "Learn More" }),
    });
    expect(outcome.mode).toBe("enforce");
    expect(outcome.status).toBe("blocked");
  });

  it("degrades an unrecognised override to observe and surfaces the warning", () => {
    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "banana",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered({ cta: "Learn More" }),
    });
    expect(outcome.status).toBe("observed");
    expect(outcome.blocked).toBe(false);
    expect(outcome.modeWarning).toMatch(/Unknown RENDERED_FIDELITY_GATE_MODE/);
  });

  it("treats a missing approved headline as not required", () => {
    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "enforce",
      authority: makeAuthority(),
      approvedHeadline: null,
      rendered: makeRendered({ headline: null }),
    });
    expect(outcome.status).toBe("passed");
  });
});
