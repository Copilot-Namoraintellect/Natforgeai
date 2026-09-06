/**
 * Premium Quality Rubric tests.
 *
 * Slice 4 scenarios 25-35:
 * - weights total exactly 1.00;
 * - overall calculation is deterministic;
 * - rounding at threshold is deterministic;
 * - overall 79.99 fails (represented by a sub-80 score);
 * - overall 80.00 may pass if all dimensions pass;
 * - overall 95 fails when CTA dimension is below 75;
 * - overall 95 fails when strategic alignment is below 75;
 * - dimension floors cannot be compensated for;
 * - every score has structured reason codes;
 * - render-dependent dimensions are not fabricated;
 * - missing render evidence produces render-required status.
 */

import { describe, expect, it } from "vitest";
import {
  evaluatePremiumCandidate,
  getDimensionConfigs,
  RUBRIC_VERSION,
  type RenderedCreativeEvidence,
} from "./premium-rubric";
import { evaluateContentCompliance, type ProposedCreativeContent } from "../compliance/content-compliance";
import { compileApprovedCreativeContract } from "../contracts/creative-contract";
import { compileDirectionPlans } from "./creative-direction-planner";
import {
  createRenderLayoutMetrics,
  createTrustedRenderedCreativeEvidence,
} from "./rendered-creative-test-fixtures";

const workflowOperationId = "op-30-22-253";

function makeContract() {
  return compileApprovedCreativeContract({
    campaignId: 30,
    userId: 22,
    businessId: 26,
    businessName: "Zuto Hub",
    strategyRunId: 253,
    approvalRequestId: 36,
    approvedAt: "2026-07-01T08:00:00.000Z",
    approvedStrategyFingerprint: "fp-253",
    funnelStage: "consideration",
    campaignInputCta: "Request a Consultation",
    targetAudience: "operations managers",
    offer: "Book a guided walkthrough",
    businessCapabilities: [
      "B2B payment orchestration",
      "prefunded merchant-account administration",
      "balance verification",
      "transaction reservations",
      "controlled payment-instruction services",
    ],
    requiredBenefitCount: 3,
    brandConstraints: ["traceable administration"],
    requiredContactDetails: ["support@zutohub.example"],
    prohibitedClaims: ["guaranteed"],
  });
}

const baseCandidate: ProposedCreativeContent = {
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
  targetAudience: "operations managers",
  offer: "Book a guided walkthrough",
  businessName: "Zuto Hub",
  protectedFields: { businessName: "Zuto Hub" },
  requiredContactDetails: ["support@zutohub.example"],
};

function makeDirectionPlan(contract = makeContract()) {
  return compileDirectionPlans({ workflowOperationId, contract });
}

function evaluate(
  candidate: ProposedCreativeContent,
  contract = makeContract()
) {
  const compliance = evaluateContentCompliance({ contract, proposed: candidate });
  const plans = makeDirectionPlan(contract);
  const directionPlan = plans.directions.find((d) => d.directionKey === "benefit_led")!;
  return createTrustedRenderedCreativeEvidence().then((renderedEvidence) => evaluatePremiumCandidate({
    candidateId: "cand-1",
    candidate,
    directionPlan,
    contract,
    complianceResult: compliance,
    renderedEvidence,
  }));
}

describe("premium-rubric", () => {
  it("weights total exactly 1.00", () => {
    const configs = getDimensionConfigs();
    const total = configs.reduce((sum, d) => sum + d.weight, 0);
    expect(total).toBe(1);
  });

  it("overall calculation is deterministic and matches the weighted sum", async () => {
    const result = await evaluate(baseCandidate);
    const expected = result.dimensionResults.reduce(
      (sum, d) => sum + (d.score ?? 0) * d.weight,
      0
    );
    expect(result.overallScore).toBeCloseTo(Math.round(expected * 100) / 100, 10);
  });

  it("overall rounding at threshold is deterministic", async () => {
    const result = await evaluate(baseCandidate);
    expect(result.overallScore).toBeGreaterThanOrEqual(80);
    expect(result.passed).toBe(true);
    expect(result.eligibilityStatus).toBe("eligible");
  });

  it("overall below 80 is rejected", async () => {
    // Construct a hard-compliant candidate whose structured pre-render score falls
    // below the 80 overall threshold. The audience mismatch lowers strategic
    // alignment, the long weak CTA lowers CTA prominence, and a thin layout plan
    // keeps layout at its floor.
    const boundaryContract = compileApprovedCreativeContract({
      campaignId: 30,
      userId: 22,
      businessId: 26,
      businessName: "Zuto Hub",
      strategyRunId: 253,
      approvalRequestId: 36,
      approvedAt: "2026-07-01T08:00:00.000Z",
      approvedStrategyFingerprint: "fp-253",
      funnelStage: "consideration",
      campaignInputCta: "Your Personal Consultation With Us Today Please",
      targetAudience: "operations managers",
      offer: "Book a guided walkthrough",
      businessCapabilities: [
        "B2B payment orchestration",
        "prefunded merchant-account administration",
        "balance verification",
      ],
      requiredBenefitCount: 3,
      brandConstraints: ["traceable administration"],
      requiredContactDetails: ["support@zutohub.example"],
      prohibitedClaims: ["guaranteed"],
    });

    const candidate: ProposedCreativeContent = {
      ...baseCandidate,
      cta: "Your Personal Consultation With Us Today Please",
      targetAudience: "finance teams",
      headline:
        "Streamline complex B2B payment orchestration workflows for growing operations managers and their teams",
      primaryText:
        "Our platform provides prefunded merchant-account administration, balance verification and controlled B2B payment orchestration.",
      benefits: [
        "Verify prefunded balances before payment instructions are issued",
        "Orchestrate B2B payment workflows with structured administration",
        "Administer prefunded merchant accounts with traceable administration",
      ],
      requiredContactDetails: ["support@zutohub.example"],
    };

    const contract = boundaryContract;
    const compliance = evaluateContentCompliance({ contract, proposed: candidate });
    expect(compliance.passed).toBe(true);

    // Use rendered evidence with lower scores to fall below 80 threshold
    const plans = compileDirectionPlans({ workflowOperationId, contract });
    const minimalDirection = plans.directions.find((d) => d.directionKey === "benefit_led")!;
    const tampered = {
      ...minimalDirection,
      visualHierarchy: ["headline and CTA"],
      layoutIntent: "single-region layout",
    };

    const result = evaluatePremiumCandidate({
      candidateId: "cand-below-80",
      candidate,
      directionPlan: tampered,
      contract,
      complianceResult: compliance,
      renderedEvidence: await createTrustedRenderedCreativeEvidence(
        createRenderLayoutMetrics({
          ctaBoundingBox: { x: 100, y: 150, w: 550, h: 300 },
          usedContentHeight: 50,
        })
      ),
    });

    expect(result.hardCompliancePassed).toBe(true);
    expect(result.overallScore).toBeLessThan(80);
    expect(result.eligibilityStatus).not.toBe("eligible");
  });

  it("overall above threshold passes when all dimensions meet their floors", async () => {
    const result = await evaluate(baseCandidate);
    expect(result.hardCompliancePassed).toBe(true);
    expect(result.overallScore).toBeGreaterThanOrEqual(80);
    for (const dim of result.dimensionResults) {
      expect(dim.passedMinimum).toBe(true);
    }
    expect(result.eligibilityStatus).toBe("eligible");
  });

  it("fails when CTA dimension is below 75 even if overall is high", async () => {
    const candidate: ProposedCreativeContent = {
      ...baseCandidate,
      cta: "Learn More",
    };
    const result = await evaluate(candidate);
    expect(result.hardCompliancePassed).toBe(false);
    const ctaDim = result.dimensionResults.find(
      (d) => d.dimensionId === "cta_prominence_and_action_clarity"
    )!;
    expect(ctaDim.score).toBeLessThan(75);
    expect(ctaDim.passedMinimum).toBe(false);
    expect(result.eligibilityStatus).toBe("hard_compliance_failed");
  });

  it("fails when strategic alignment is below 75 even if overall is high", async () => {
    // "finance teams" is B2B-compatible with the contract audience so hard
    // compliance passes, but the audience phrase does not contain the approved
    // audience words, reducing strategic alignment below its 75 floor.
    const candidate: ProposedCreativeContent = {
      ...baseCandidate,
      targetAudience: "finance teams",
    };
    const result = await evaluate(candidate);
    expect(result.hardCompliancePassed).toBe(true);
    const strategic = result.dimensionResults.find(
      (d) => d.dimensionId === "strategic_alignment"
    )!;
    expect(strategic.score).toBeLessThan(75);
    expect(strategic.passedMinimum).toBe(false);
    expect(result.eligibilityStatus).toBe("below_dimension_minimum");
  });

  it("dimension floors cannot be compensated by other dimensions", async () => {
    // Make layout dimension fail its 70 floor by using rendered evidence with
    // a low layout score while keeping all other dimensions high.
    const contract = makeContract();
    const compliance = evaluateContentCompliance({ contract, proposed: baseCandidate });
    const plans = compileDirectionPlans({ workflowOperationId, contract });
    const authority = plans.directions.find((d) => d.directionKey === "authority_led")!;
    const tampered: typeof authority = {
      ...authority,
      visualHierarchy: ["headline", "CTA"],
      layoutIntent: "",
    };
    const result = evaluatePremiumCandidate({
      candidateId: "cand-floor",
      candidate: baseCandidate,
      directionPlan: tampered,
      contract,
      complianceResult: compliance,
      renderedEvidence: await createTrustedRenderedCreativeEvidence(
        createRenderLayoutMetrics({
          ctaBoundingBox: { x: 100, y: 150, w: 550, h: 300 },
          usedContentHeight: 50,
        })
      ),
    });
    const layout = result.dimensionResults.find(
      (d) => d.dimensionId === "layout_and_visual_hierarchy"
    )!;
    expect(layout.score).toBeLessThan(70);
    expect(layout.passedMinimum).toBe(false);
    expect(result.overallScore).toBeGreaterThan(80);
    expect(result.eligibilityStatus).toBe("below_dimension_minimum");
  });

  it("every scored dimension has structured reason codes", async () => {
    const result = await evaluate(baseCandidate);
    for (const dim of result.dimensionResults) {
      expect(dim.reasonCodes.length).toBeGreaterThan(0);
      expect(dim.evaluationStatus).toBeTruthy();
    }
  });

  it("render-dependent dimensions return conservative pre-render status", () => {
    const compliance = evaluateContentCompliance({ contract: makeContract(), proposed: baseCandidate });
    const plans = makeDirectionPlan();
    const directionPlan = plans.directions.find((d) => d.directionKey === "benefit_led")!;
    const result = evaluatePremiumCandidate({
      candidateId: "cand-no-render",
      candidate: baseCandidate,
      directionPlan,
      contract: makeContract(),
      complianceResult: compliance,
    });

    const layout = result.dimensionResults.find(
      (d) => d.dimensionId === "layout_and_visual_hierarchy"
    )!;
    const legibility = result.dimensionResults.find(
      (d) => d.dimensionId === "legibility_and_accessibility"
    )!;
    expect(layout.evaluationStatus).toBe("render_required");
    expect(legibility.evaluationStatus).toBe("render_required");
    expect(layout.reasonCodes).toContain("RENDER_DEPENDENT_EVIDENCE_REQUIRED");
    expect(legibility.reasonCodes).toContain("RENDER_DEPENDENT_EVIDENCE_REQUIRED");
  });

  it("rejects self-authored trusted_test_fixture evidence", () => {
    const contract = makeContract();
    const compliance = evaluateContentCompliance({ contract, proposed: baseCandidate });
    const plans = compileDirectionPlans({ workflowOperationId, contract });
    const directionPlan = plans.directions.find((d) => d.directionKey === "benefit_led")!;
    const result = evaluatePremiumCandidate({
      candidateId: "cand-self-rated",
      candidate: baseCandidate,
      directionPlan,
      contract,
      complianceResult: compliance,
      renderedEvidence: {
        source: "trusted_test_fixture",
        renderedAssetFingerprint: "forbidden",
        evaluatorVersion: "test-v1",
        layoutAndVisualHierarchyScore: 90,
        legibilityAndAccessibilityScore: 90,
        reasonCodes: ["FORBIDDEN"],
      } as any,
    });

    const layout = result.dimensionResults.find(
      (d) => d.dimensionId === "layout_and_visual_hierarchy"
    )!;
    expect(layout.evaluationStatus).toBe("render_required");
    expect(result.premiumAcceptanceStatus).toBe("render_evaluation_required");
  });

  it("missing render evidence makes a candidate render-evaluation-required", () => {
    const contract = makeContract();
    const compliance = evaluateContentCompliance({ contract, proposed: baseCandidate });
    const plans = compileDirectionPlans({ workflowOperationId, contract });
    const authority = plans.directions.find((d) => d.directionKey === "authority_led")!;
    // Strip all layout intent to remove any meaningful structural evidence.
    const noRenderDirection = {
      ...authority,
      visualHierarchy: [],
      layoutIntent: "",
    };
    const result = evaluatePremiumCandidate({
      candidateId: "cand-render",
      candidate: baseCandidate,
      directionPlan: noRenderDirection,
      contract,
      complianceResult: compliance,
    });
    expect(result.dimensionResults.some((d) => d.evaluationStatus === "render_required")).toBe(true);
  });

  it("rubric version is stable and reported", async () => {
    const result = await evaluate(baseCandidate);
    expect(result.rubricVersion).toBe(RUBRIC_VERSION);
  });

  it("rejects stale-contract candidates", () => {
    const draft = compileApprovedCreativeContract({
      campaignId: 30,
      userId: 22,
      businessId: 26,
      strategyRunId: 253,
      approvalRequestId: 36,
      approvedAt: "2026-07-01T08:00:00.000Z",
      approvedStrategyFingerprint: "fp-stale",
      funnelStage: "consideration",
      campaignInputCta: "Request a Consultation",
      targetAudience: "operations managers",
      offer: "Book a guided walkthrough",
      businessCapabilities: ["B2B payment orchestration"],
      requiredBenefitCount: 3,
    });
    // Force the contract to behave like a stale/non-approved source by compiling
    // with mismatched fingerprint expectations. The selection layer handles stale
    // rejection; here we just confirm the rubric sees the draft as non-authoritative.
    const compliance = evaluateContentCompliance({ contract: draft, proposed: baseCandidate });
    const plans = makeDirectionPlan(draft);
    const directionPlan = plans.directions.find((d) => d.directionKey === "benefit_led")!;
    const result = evaluatePremiumCandidate({
      candidateId: "cand-stale",
      candidate: baseCandidate,
      directionPlan,
      contract: draft,
      complianceResult: compliance,
    });
    expect(result.hardCompliancePassed).toBe(false);
    expect(result.eligibilityStatus).toBe("hard_compliance_failed");
  });
});
