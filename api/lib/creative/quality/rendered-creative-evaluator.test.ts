import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { buildRenderMetricsBindingFingerprint, evaluateTrustedRenderedCreative, isTrustedRenderedCreativeEvidence } from "./rendered-creative-evaluator";
import type { V2RenderLayoutMetrics } from "../premium-v2/renderer";
import { evaluatePremiumCandidate } from "./premium-rubric";
import { evaluateContentCompliance, type ProposedCreativeContent } from "../compliance/content-compliance";
import { compileApprovedCreativeContract } from "../contracts/creative-contract";
import { compileDirectionPlans } from "./creative-direction-planner";

const metrics = (): V2RenderLayoutMetrics => ({
  width: 1200, height: 628, ctaBoundingBox: { x: 500, y: 500, w: 180, h: 54 },
  footerY: 520, footerHeight: 54, minFontSizeUsed: 16, primaryCardCount: 3,
  secondaryCardCount: 0, layoutDensity: "premium_services", didCrowd: false,
  logoComposited: false, usedContentHeight: 400, availableContentHeight: 500,
  primaryWithDescriptionCount: 0,
});
const render = () => sharp({ create: { width: 1200, height: 628, channels: 3, background: "#ffffff" } }).png().toBuffer();

describe("rendered-creative-evaluator", () => {
  it("creates deterministic SHA-256 evidence from actual bytes", async () => {
    const bytes = await render();
    const first = await evaluateTrustedRenderedCreative({ renderedBytes: bytes, layoutMetrics: metrics() });
    const second = await evaluateTrustedRenderedCreative({ renderedBytes: bytes, layoutMetrics: metrics() });
    expect(first).toEqual(second);
    expect(first.accepted && first.evidence.renderedBytesSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("changes the fingerprint when render bytes change", async () => {
    const first = await evaluateTrustedRenderedCreative({ renderedBytes: await render(), layoutMetrics: metrics() });
    const changed = await evaluateTrustedRenderedCreative({ renderedBytes: await sharp({ create: { width: 1200, height: 628, channels: 3, background: "#000000" } }).png().toBuffer(), layoutMetrics: metrics() });
    expect(first.accepted && changed.accepted && first.evidence.renderedBytesSha256).not.toBe(changed.accepted && changed.evidence.renderedBytesSha256);
  });

  it.each(["jpeg", "webp"] as const)("accepts valid %s render bytes", async (format) => {
    const renderedBytes = await sharp({
      create: { width: 1200, height: 628, channels: 3, background: "#ffffff" },
    })[format]().toBuffer();
    const result = await evaluateTrustedRenderedCreative({ renderedBytes, layoutMetrics: metrics() });
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.evidence.renderedBytesSha256).toBe(
        createHash("sha256").update(renderedBytes).digest("hex")
      );
    }
  });

  it("rejects a truncated PNG and a decodable unsupported format distinctly", async () => {
    const png = await render();
    const truncated = await evaluateTrustedRenderedCreative({ renderedBytes: png.subarray(0, 20), layoutMetrics: metrics() });
    const tiff = await sharp({ create: { width: 1200, height: 628, channels: 3, background: "#ffffff" } }).tiff().toBuffer();
    const unsupported = await evaluateTrustedRenderedCreative({ renderedBytes: tiff, layoutMetrics: metrics() });
    expect(truncated).toEqual({ accepted: false, evidence: null, reasonCodes: ["RENDER_BYTES_CORRUPT"] });
    expect(unsupported).toEqual({ accepted: false, evidence: null, reasonCodes: ["RENDER_FORMAT_UNSUPPORTED"] });
  });

  it.each([
    ["invalid bytes", Buffer.from("not an image"), metrics(), "RENDER_BYTES_CORRUPT"],
    ["mismatched dimensions", null, { ...metrics(), width: 1199 }, "RENDER_DIMENSIONS_MISMATCH"],
    ["missing metrics", null, null, "RENDER_METRICS_INVALID_OR_MISSING"],
    ["clipping", null, { ...metrics(), didCrowd: true }, "RENDER_CLIPPING_OR_SAFE_BOUNDS_FAILED"],
    ["CTA bounds", null, { ...metrics(), ctaBoundingBox: { x: 1, y: 500, w: 180, h: 54 } }, "RENDER_CTA_OUTSIDE_SAFE_BOUNDS"],
    ["font size", null, { ...metrics(), minFontSizeUsed: 11 }, "RENDER_FONT_SIZE_TOO_SMALL"],
    ["non-finite metric", null, { ...metrics(), minFontSizeUsed: Number.NaN }, "RENDER_METRICS_INVALID_OR_MISSING"],
    ["impossible CTA", null, { ...metrics(), ctaBoundingBox: { x: 500, y: 500, w: -1, h: 54 } }, "RENDER_METRICS_INVALID_OR_MISSING"],
  ])("fails closed for %s", async (_name, suppliedBytes, layoutMetrics, reasonCode) => {
    const result = await evaluateTrustedRenderedCreative({ renderedBytes: suppliedBytes ?? await render(), layoutMetrics: layoutMetrics as V2RenderLayoutMetrics });
    expect(result).toEqual({ accepted: false, evidence: null, reasonCodes: [reasonCode] });
  });

  it("records high stack utilisation as diagnostic-only (real 3@1 fixture metrics, density ≈ 0.9809)", async () => {
    const renderedBytes = await sharp({
      create: { width: 1080, height: 1350, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();
    const layoutMetrics: V2RenderLayoutMetrics = {
      width: 1080,
      height: 1350,
      ctaBoundingBox: { x: 160, y: 1118, w: 760, h: 72 },
      footerY: 1238,
      footerHeight: 112,
      minFontSizeUsed: 20,
      primaryCardCount: 4,
      secondaryCardCount: 3,
      layoutDensity: "premium_services",
      didCrowd: false,
      logoComposited: true,
      usedContentHeight: 924,
      availableContentHeight: 942,
      primaryWithDescriptionCount: 4,
    };
    const result = await evaluateTrustedRenderedCreative({ renderedBytes, layoutMetrics });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    // The density value remains observable, but it cannot reject: the
    // renderer reported no crowding and everything sits within bounds.
    expect(layoutMetrics.usedContentHeight / layoutMetrics.availableContentHeight).toBeCloseTo(0.9809, 3);
    expect(result.evidence.reasonCodes).toContain("RENDER_DENSITY_DIAGNOSTIC");
    expect(result.evidence.reasonCodes).not.toContain("RENDER_DENSITY_OUT_OF_RANGE");
  });

  it("supplies accepted evidence to the rubric and rejects self-rated evidence", async () => {
    const contract = compileApprovedCreativeContract({ campaignId: 1, userId: 1, businessId: 1, businessName: "Acme", strategyRunId: 1, approvalRequestId: 1, approvedAt: "2026-01-01T00:00:00.000Z", approvedStrategyFingerprint: "fp", funnelStage: "consideration", campaignInputCta: "Request a Consultation", targetAudience: "operators", offer: "Walkthrough", businessCapabilities: ["Payments", "Balances", "Reservations"], requiredBenefitCount: 3, brandConstraints: [], requiredContactDetails: [], prohibitedClaims: [] });
    const candidate: ProposedCreativeContent = { headline: "Payments", primaryText: "Payments balances and reservations for operators.", benefits: ["Payments", "Balances", "Reservations"], cta: "Request a Consultation", funnelStage: "consideration", targetAudience: "operators", offer: "Walkthrough", businessName: "Acme", protectedFields: { businessName: "Acme" }, requiredContactDetails: [] };
    const evidence = await evaluateTrustedRenderedCreative({ renderedBytes: await render(), layoutMetrics: metrics() });
    expect(evidence.accepted).toBe(true);
    const input = { candidateId: "c", candidate, contract, directionPlan: compileDirectionPlans({ workflowOperationId: "op", contract }).directions[0], complianceResult: evaluateContentCompliance({ contract, proposed: candidate }) };
    const verified = evaluatePremiumCandidate({ ...input, renderedEvidence: evidence.accepted ? evidence.evidence : null });
    const selfRated = evaluatePremiumCandidate({ ...input, renderedEvidence: { source: "render_evaluator", renderedAssetFingerprint: "a".repeat(64), layoutAndVisualHierarchyScore: 100, legibilityAndAccessibilityScore: 100, evaluatorVersion: "self-rated", reasonCodes: [] } as never });
    expect(verified.dimensionResults.filter((dimension) => dimension.evaluationStatus === "scored")).toHaveLength(7);
    expect(selfRated.premiumAcceptanceStatus).toBe("render_evaluation_required");
  });

  it("trusts only the exact frozen evaluator evidence object", async () => {
    const result = await evaluateTrustedRenderedCreative({ renderedBytes: await render(), layoutMetrics: metrics() });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(isTrustedRenderedCreativeEvidence(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(isTrustedRenderedCreativeEvidence({ ...result.evidence })).toBe(false);
    expect(isTrustedRenderedCreativeEvidence(JSON.parse(JSON.stringify(result.evidence)))).toBe(false);
    expect(isTrustedRenderedCreativeEvidence({ ...result.evidence, layoutAndVisualHierarchyScore: 100 })).toBe(false);
  });

  it("binds the same measured metrics deterministically and records structured evidence", async () => {
    const bytes = await render();
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    const first = buildRenderMetricsBindingFingerprint(fingerprint, metrics());
    const second = buildRenderMetricsBindingFingerprint(fingerprint, metrics());
    const changed = buildRenderMetricsBindingFingerprint(fingerprint, { ...metrics(), usedContentHeight: 401 });
    const result = await evaluateTrustedRenderedCreative({ renderedBytes: bytes, layoutMetrics: metrics() });
    expect(first).toBe(second);
    expect(first).not.toBe(changed);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.evidence.reasonCodes.length).toBeGreaterThan(0);
      expect(result.evidence.evidenceRefs.length).toBeGreaterThan(0);
      expect(result.evidence.reasonCodes).toContain("CONTRAST_NOT_EVALUABLE");
    }
  });

  it("returns trusted valid low layout and legibility scores from real metrics", async () => {
    const lowLayout = await evaluateTrustedRenderedCreative({ renderedBytes: await render(), layoutMetrics: { ...metrics(), ctaBoundingBox: { x: 100, y: 100, w: 800, h: 400 } } });
    const lowLegibility = await evaluateTrustedRenderedCreative({ renderedBytes: await render(), layoutMetrics: { ...metrics(), minFontSizeUsed: 14 } });
    expect(lowLayout.accepted && lowLayout.evidence.layoutAndVisualHierarchyScore).toBeLessThan(70);
    expect(lowLegibility.accepted && lowLegibility.evidence.legibilityAndAccessibilityScore).toBeLessThan(70);
  });
});