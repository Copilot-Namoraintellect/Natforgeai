import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { PremiumV2Renderer, renderV2FromBrief } from "./renderer";
import type { PremiumLeafletV2Brief } from "./types";
import { isTrustedRenderedCreativeEvidence } from "../quality/rendered-creative-evaluator";
import * as renderedCreativeEvaluator from "../quality/rendered-creative-evaluator";
import { createRenderedQualityObservationScope } from "../contracts/rendered-quality-observation-scope";
import { InMemoryRenderedEvidenceRegistry } from "../quality/rendered-evidence-registry";
import { InMemoryWorkflowOperationRegistry } from "../../workflow/workflow-operation";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeBrief(overrides: Partial<PremiumLeafletV2Brief> = {}): PremiumLeafletV2Brief {
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
    ...overrides,
  };
}

describe("renderV2FromBrief", () => {
  it("produces a 1080x1350 PNG", async () => {
    const { buffer, metrics } = await renderV2FromBrief(makeBrief());
    const meta = await sharp(buffer).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
    expect(metrics.width).toBe(1080);
    expect(metrics.height).toBe(1350);
  });

  it("renders a catalogue layout for many services", async () => {
    const brief = makeBrief({
      layoutDensity: "catalogue_brochure",
      primaryServices: Array.from({ length: 12 }, (_, i) => ({ name: `Service ${i + 1}`, isPrimary: true })),
      secondaryServices: [],
    });
    const { buffer } = await renderV2FromBrief(brief);
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });

  it("does not clip CTA or footer", async () => {
    const { metrics } = await renderV2FromBrief(makeBrief());
    const { ctaBoundingBox, footerY, footerHeight, height } = metrics;
    expect(ctaBoundingBox.y).toBeGreaterThanOrEqual(0);
    expect(ctaBoundingBox.y + ctaBoundingBox.h).toBeLessThanOrEqual(height);
    expect(footerY + footerHeight).toBeLessThanOrEqual(height);
  });

  it("reports layout metrics for the quality gate", async () => {
    const { metrics } = await renderV2FromBrief(makeBrief());
    expect(metrics.primaryCardCount).toBe(3);
    expect(metrics.secondaryCardCount).toBe(1);
    expect(metrics.minFontSizeUsed).toBeGreaterThanOrEqual(14);
  });
});

describe("PremiumV2Renderer", () => {
  it("requires a v2Brief on the request", async () => {
    const renderer = new PremiumV2Renderer();
    const result = await renderer.render({} as any);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/v2Brief/);
  });

  it("renders successfully with a valid v2Brief", async () => {
    const renderer = new PremiumV2Renderer();
    const brief = makeBrief();
    const direct = await renderV2FromBrief(brief);
    const result = await renderer.render({ v2Brief: brief } as any);
    expect(result.success).toBe(true);
    expect(result.imageBase64).toBeTruthy();
    expect(result.extension).toBe("png");
    expect(result.metadata?.v2LayoutMetrics).toBeTruthy();
    expect(Buffer.from(result.imageBase64!, "base64")).toEqual(direct.buffer);
    expect(result.metadata?.v2LayoutMetrics).toEqual(direct.metrics);
    const evaluation = (result.metadata as any)?.renderEvaluation;
    expect(evaluation?.accepted).toBe(true);
    expect(isTrustedRenderedCreativeEvidence(evaluation?.evidence)).toBe(true);
  });

  it("preserves the completed render when evaluator evaluation throws", async () => {
    const brief = makeBrief();
    const direct = await renderV2FromBrief(brief);
    const evaluateSpy = vi
      .spyOn(renderedCreativeEvaluator, "evaluateTrustedRenderedCreative")
      .mockRejectedValue(new Error("evaluator fault"));
    const result = await new PremiumV2Renderer().render({ v2Brief: brief } as any);

    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(Buffer.from(result.imageBase64!, "base64")).toEqual(direct.buffer);
    expect(result.metadata?.v2LayoutMetrics).toEqual(direct.metrics);
    expect((result.metadata as any)?.renderEvaluation).toEqual({
      accepted: false,
      evidence: null,
      reasonCodes: ["RENDER_EVALUATOR_INTERNAL_ERROR"],
    });
  });

  it("fails closed when the request carries a forged observation scope", async () => {
    const renderer = new PremiumV2Renderer();
    const brief = makeBrief();
    const result = await renderer.render({
      v2Brief: brief,
      qualityObservationScope: {},
    } as any);

    expect(result.success).toBe(true);
    expect((result.metadata as any)?.qualityObservationRegistration).toEqual({
      status: "not_requested",
    });
  });

  it("registers accepted evaluator evidence through a real scope without cloning", async () => {
    const previousMode = process.env.QUALITY_AUTHORITY_MODE;
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    try {
      // Existing Slice 3-4 orchestration owner state.
      const workflowRegistry = new InMemoryWorkflowOperationRegistry();
      const { operation } = workflowRegistry.registerOperation({
        operationType: "creative_generation",
        operationSource: "automatic",
        operationReferenceId: "7",
        campaignId: 30,
        userId: 5,
        businessId: 9,
        contractFingerprint: "approved-strategy-fingerprint",
        strategyRunId: 11,
        approvalRequestId: 22,
        claimId: null,
        approvedAt: "2026-08-01T00:00:00.000Z",
      });
      workflowRegistry.transitionOperation(operation.workflowOperationId, "running");
      const evidenceRegistry = new InMemoryRenderedEvidenceRegistry();
      const registerSpy = vi.spyOn(evidenceRegistry, "register");

      const scope = createRenderedQualityObservationScope({
        campaignId: 30,
        userId: 5,
        businessId: 9,
        businessName: "Test Biz",
        lineage: {
          campaignId: 30,
          userId: 5,
          strategyRunId: 11,
          approvalRequestId: 22,
          approvedStrategyFingerprint: "approved-strategy-fingerprint",
          approvedAt: "2026-08-01T00:00:00.000Z",
          status: "approved",
          strategyRunStatus: "completed",
        },
        expectedApprovedStrategyFingerprint: "approved-strategy-fingerprint",
        funnelStage: "conversion",
        campaignWideCta: "Call Us Today",
        campaignInputCta: "Call Us Today",
        targetAudience: "Local homeowners",
        offer: "10% off",
        businessCapabilities: ["Repairs", "Installations", "Maintenance"],
        legacySelectedCta: "Call Us Today",
        proposedContent: {
          headline: "Professional service you can trust",
          primaryText: "Fast, reliable help for your home.",
          benefits: ["Fast", "Reliable", "Affordable"],
          cta: "Call Us Today",
          funnelStage: "conversion",
          targetAudience: "Local homeowners",
          offer: "10% off",
          businessName: "Test Biz",
          protectedFields: { businessName: "Test Biz" },
        },
        operationType: "creative_generation",
        operationSource: "automatic",
        operationReferenceId: 7,
        registry: workflowRegistry,
        workflowOperationId: operation.workflowOperationId,
        renderedEvidenceRegistry: evidenceRegistry,
      });
      expect(scope).not.toBeNull();

      const result = await new PremiumV2Renderer().render({
        v2Brief: makeBrief(),
        qualityObservationScope: scope,
      } as any);

      expect(result.success).toBe(true);
      expect((result.metadata as any)?.qualityObservationRegistration).toEqual({
        status: "registered",
        renderedAssetFingerprint: expect.any(String),
      });
      expect(registerSpy).toHaveBeenCalledTimes(1);
      const [identity, evidence] = registerSpy.mock.calls[0];
      expect(identity.workflowOperationId).toBe(operation.workflowOperationId);
      // The exact evaluator-created object was registered: no clone, no
      // serialization round-trip.
      expect(evidence).toBe((result.metadata as any).renderEvaluation.evidence);
      expect(isTrustedRenderedCreativeEvidence(evidence)).toBe(true);
      expect(workflowRegistry.findOperation(operation.workflowOperationId)!.status).toBe("running");
    } finally {
      if (previousMode === undefined) delete process.env.QUALITY_AUTHORITY_MODE;
      else process.env.QUALITY_AUTHORITY_MODE = previousMode;
    }
  });
});
