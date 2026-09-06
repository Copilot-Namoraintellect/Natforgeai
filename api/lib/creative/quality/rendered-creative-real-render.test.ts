import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { renderV2FromBrief } from "../premium-v2/renderer";
import type { PremiumLeafletV2Brief } from "../premium-v2/types";
import {
  buildRenderMetricsBindingFingerprint,
  evaluateTrustedRenderedCreative,
  isTrustedRenderedCreativeEvidence,
} from "./rendered-creative-evaluator";
import { evaluatePremiumCandidate } from "./premium-rubric";
import {
  evaluateContentCompliance,
  type ProposedCreativeContent,
} from "../compliance/content-compliance";
import { compileApprovedCreativeContract } from "../contracts/creative-contract";
import { compileDirectionPlans } from "./creative-direction-planner";
import {
  createRenderedQualityObservationScope,
  observeRenderedQualityScope,
  registerRenderedQualityEvidence,
} from "../contracts/rendered-quality-observation-scope";
import { InMemoryRenderedEvidenceRegistry } from "./rendered-evidence-registry";
import { InMemoryWorkflowOperationRegistry } from "../../workflow/workflow-operation";

const previousMode = process.env.QUALITY_AUTHORITY_MODE;

function makeBrief(): PremiumLeafletV2Brief {
  return {
    businessName: "Test Biz",
    businessCategory: "local_services",
    headline: "Professional service you can trust",
    subheadline: "Fast, reliable help for your home.",
    primaryServices: [
      { name: "Repairs", isPrimary: true },
      { name: "Installations", isPrimary: true },
      { name: "Maintenance", isPrimary: true },
    ],
    secondaryServices: [{ name: "Consultations", isPrimary: false }],
    benefits: ["Fast", "Reliable", "Affordable"],
    cta: "Call Us Today",
    contact: { phone: "123 456 7890", website: "https://test.test" },
    visualStyle: "modern",
    layoutDensity: "premium_services",
    brandPalette: {
      primary: "#1E3A8A",
      secondary: "#F59E0B",
      accent: "#10B981",
      background: "#FFFFFF",
      text: "#0F172A",
      textMuted: "#475569",
    },
    logoPlacement: "header",
    proofPoints: [{ label: "Serves", value: "Local homeowners" }],
  };
}

const candidate: ProposedCreativeContent = {
  headline: "Payments",
  primaryText: "Payments balances and reservations for operators.",
  benefits: ["Payments", "Balances", "Reservations"],
  cta: "Request a Consultation",
  funnelStage: "consideration",
  targetAudience: "operators",
  offer: "Walkthrough",
  businessName: "Acme",
  protectedFields: { businessName: "Acme" },
  requiredContactDetails: [],
};

const contractInput = {
  campaignId: 1,
  userId: 1,
  businessId: 1,
  businessName: "Acme",
  strategyRunId: 1,
  approvalRequestId: 1,
  approvedAt: "2026-01-01T00:00:00.000Z",
  approvedStrategyFingerprint: "fp",
  funnelStage: "consideration" as const,
  campaignInputCta: "Request a Consultation",
  targetAudience: "operators",
  offer: "Walkthrough",
  businessCapabilities: ["Payments", "Balances", "Reservations"] as readonly string[],
  requiredBenefitCount: 3,
  brandConstraints: [] as readonly string[],
  requiredContactDetails: [] as readonly string[],
  prohibitedClaims: [] as readonly string[],
};

describe("real Premium V2 render end-to-end acceptance", () => {
  it("real renderer output produces trusted evidence accepted through rubric, registry, and observer", async () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    try {
      // 1. Real renderer output (no synthetic helper image).
      const { buffer, metrics } = await renderV2FromBrief(makeBrief());

      // 2. Rendered evaluator over the actual bytes and actual V2 metrics.
      const evaluation = await evaluateTrustedRenderedCreative({
        renderedBytes: buffer,
        layoutMetrics: metrics,
      });
      expect(evaluation.accepted).toBe(true);
      if (!evaluation.accepted) return;
      const evidence = evaluation.evidence;
      expect(isTrustedRenderedCreativeEvidence(evidence)).toBe(true);
      expect(Object.isFrozen(evidence)).toBe(true);

      // Byte fingerprint is SHA-256 of the exact real PNG bytes; metrics are
      // deterministically bound to that fingerprint.
      const bytesSha256 = createHash("sha256").update(buffer).digest("hex");
      expect(evidence.renderedBytesSha256).toBe(bytesSha256);
      expect(evidence.renderedAssetFingerprint).toBe(bytesSha256);
      expect(evidence.metricsBindingFingerprint).toBe(
        buildRenderMetricsBindingFingerprint(bytesSha256, metrics)
      );
      expect(evidence.evidenceRefs.length).toBeGreaterThan(0);

      // 3. Premium rubric over the exact evaluator-created evidence.
      const contract = compileApprovedCreativeContract(contractInput);
      const directionPlan = compileDirectionPlans({
        workflowOperationId: "op",
        contract,
      }).directions.find((d) => d.directionKey === "benefit_led")!;
      const complianceResult = evaluateContentCompliance({ contract, proposed: candidate });
      const rubric = evaluatePremiumCandidate({
        candidateId: "real-render-candidate",
        candidate,
        contract,
        directionPlan,
        complianceResult,
        renderedEvidence: evidence,
      });
      const layout = rubric.dimensionResults.find(
        (d) => d.dimensionId === "layout_and_visual_hierarchy"
      )!;
      const legibility = rubric.dimensionResults.find(
        (d) => d.dimensionId === "legibility_and_accessibility"
      )!;
      expect(layout.score).not.toBeNull();
      expect(legibility.score).not.toBeNull();
      expect(layout.score!).toBeGreaterThanOrEqual(70);
      expect(legibility.score!).toBeGreaterThanOrEqual(70);
      expect(rubric.finalPremiumScore).not.toBeNull();

      // 4. Existing orchestration owner state and request-scoped registries.
      const workflowRegistry = new InMemoryWorkflowOperationRegistry();
      const { operation } = workflowRegistry.registerOperation({
        operationType: "creative_generation",
        operationSource: "automatic",
        operationReferenceId: "1",
        campaignId: 1,
        userId: 1,
        businessId: 1,
        contractFingerprint: "fp",
        strategyRunId: 1,
        approvalRequestId: 1,
        claimId: null,
        approvedAt: "2026-01-01T00:00:00.000Z",
      });
      workflowRegistry.transitionOperation(operation.workflowOperationId, "running");
      const evidenceRegistry = new InMemoryRenderedEvidenceRegistry();
      const registerSpy = vi.spyOn(evidenceRegistry, "register");

      const scope = createRenderedQualityObservationScope({
        ...contractInput,
        lineage: {
          campaignId: 1,
          userId: 1,
          strategyRunId: 1,
          approvalRequestId: 1,
          approvedStrategyFingerprint: "fp",
          approvedAt: "2026-01-01T00:00:00.000Z",
          status: "approved",
          strategyRunStatus: "completed",
        },
        expectedApprovedStrategyFingerprint: "fp",
        campaignWideCta: "Request a Consultation",
        offerRequired: true,
        legacySelectedCta: "Request a Consultation",
        proposedContent: candidate,
        operationType: "creative_generation",
        operationSource: "automatic",
        operationReferenceId: 1,
        attemptType: "render",
        registry: workflowRegistry,
        workflowOperationId: operation.workflowOperationId,
        renderedEvidenceRegistry: evidenceRegistry,
      });
      expect(scope).not.toBeNull();

      // 5. Selection is not authorized before trusted rendered evidence.
      const before = observeRenderedQualityScope(scope);
      expect(before!.selectedCandidateId).toBeNull();
      expect(before!.renderEvidenceObservationStatus).toBe("missing_evidence");

      // 6. Registration binds the exact evaluator object (no clone).
      const registration = registerRenderedQualityEvidence(scope, evidence);
      expect(registration.status).toBe("registered");
      expect(registerSpy).toHaveBeenCalledTimes(1);
      const [identity, registeredEvidence] = registerSpy.mock.calls[0];
      expect(identity.workflowOperationId).toBe(operation.workflowOperationId);
      expect(registeredEvidence).toBe(evidence);

      // 7. Rendered-quality observer selects with the registry-bound evidence.
      const observation = observeRenderedQualityScope(scope);
      expect(observation!.renderEvidenceObservationStatus).toBe("evaluated");
      expect(observation!.trustedRenderedEvidenceCount).toBe(1);
      expect(observation!.finalPremiumScore).not.toBeNull();
      expect(observation!.qualityAuthorityWouldAccept).toBe(true);
      expect(observation!.selectedCandidateId).not.toBeNull();
      expect(observation!.workflowOperationId).toBe(operation.workflowOperationId);
      expect(observation!.operationStatus).toBe("running");

      // 8. The owner operation remains running; nothing was finalized.
      expect(workflowRegistry.findOperation(operation.workflowOperationId)!.status).toBe("running");
    } finally {
      if (previousMode === undefined) delete process.env.QUALITY_AUTHORITY_MODE;
      else process.env.QUALITY_AUTHORITY_MODE = previousMode;
    }
  });
});
