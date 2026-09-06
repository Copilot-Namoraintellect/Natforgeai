import { createHash } from "node:crypto";
import sharp from "sharp";

import type { RenderedCreativeEvidence } from "./premium-rubric";
import type { V2RenderLayoutMetrics } from "../premium-v2/renderer";

export const RENDERED_CREATIVE_EVALUATOR_VERSION = "slice5.trusted-render-evaluator.v1";

export interface TrustedInternalRenderRecord {
  renderedBytes: Buffer;
  layoutMetrics: V2RenderLayoutMetrics;
}

const trustedEvidence = new WeakSet<object>();

/** In-process only: serialized, copied, or reconstructed evidence is never trusted. */
export function isTrustedRenderedCreativeEvidence(value: unknown): value is RenderedCreativeEvidence {
  return !!value && typeof value === "object" && trustedEvidence.has(value as object);
}

export type RenderedCreativeEvaluation =
  | {
      accepted: true;
      evidence: RenderedCreativeEvidence;
      reasonCodes: string[];
    }
  | {
      accepted: false;
      evidence: null;
      reasonCodes: string[];
    };

const SUPPORTED_FORMATS = new Set(["png", "jpeg", "webp"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function canonicalMetrics(metrics: V2RenderLayoutMetrics) {
  return {
    width: metrics.width,
    height: metrics.height,
    ctaBoundingBox: metrics.ctaBoundingBox,
    footerY: metrics.footerY,
    footerHeight: metrics.footerHeight,
    minFontSizeUsed: metrics.minFontSizeUsed,
    primaryCardCount: metrics.primaryCardCount,
    secondaryCardCount: metrics.secondaryCardCount,
    layoutDensity: metrics.layoutDensity,
    didCrowd: metrics.didCrowd,
    logoComposited: metrics.logoComposited,
    usedContentHeight: metrics.usedContentHeight,
    availableContentHeight: metrics.availableContentHeight,
    primaryWithDescriptionCount: metrics.primaryWithDescriptionCount,
  };
}

export function buildRenderMetricsBindingFingerprint(
  renderedAssetFingerprint: string,
  metrics: V2RenderLayoutMetrics
): string {
  return createHash("sha256")
    .update(JSON.stringify({ renderedAssetFingerprint, evaluatorVersion: RENDERED_CREATIVE_EVALUATOR_VERSION, rendererMetricVersion: "premium-v2.layout.v1", metrics: canonicalMetrics(metrics) }))
    .digest("hex");
}

function rejected(reasonCode: string): RenderedCreativeEvaluation {
  return { accepted: false, evidence: null, reasonCodes: [reasonCode] };
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidMetrics(metrics: V2RenderLayoutMetrics): boolean {
  const cta = metrics.ctaBoundingBox;
  return (
    isFinitePositive(metrics.width) &&
    isFinitePositive(metrics.height) &&
    isFinitePositive(cta.x) &&
    isFinitePositive(cta.y) &&
    isFinitePositive(cta.w) &&
    isFinitePositive(cta.h) &&
    Number.isFinite(metrics.minFontSizeUsed) &&
    typeof metrics.didCrowd === "boolean" &&
    isFinitePositive(metrics.availableContentHeight) &&
    Number.isFinite(metrics.usedContentHeight)
  );
}

function scoreMetrics(metrics: V2RenderLayoutMetrics): Pick<RenderedCreativeEvidence, "layoutAndVisualHierarchyScore" | "legibilityAndAccessibilityScore"> {
  const ctaAreaRatio = (metrics.ctaBoundingBox.w * metrics.ctaBoundingBox.h) /
    (metrics.width * metrics.height);
  // Layout prominence is derived only from deterministic, renderer-authored
  // geometry (CTA prominence). Content-stack utilisation
  // (usedContentHeight / availableContentHeight) is recorded as a diagnostic
  // (RENDER_DENSITY_DIAGNOSTIC) and plays no role in scoring: the renderer
  // already guarantees fit by compressing cards and reporting didCrowd, so a
  // near-full stack is designed behaviour, not a measurable aesthetic defect.
  // No credit is awarded for proximity to any ideal fill ratio.
  const layoutAndVisualHierarchyScore = Math.round(
    Math.max(0, Math.min(100, 100 - Math.abs(ctaAreaRatio - 0.04) * 250))
  );
  // Contrast is unavailable in V2 metrics and deliberately receives no points.
  const legibilityAndAccessibilityScore = Math.round(
    Math.max(0, Math.min(100, 35 + Math.min(40, metrics.minFontSizeUsed * 2)))
  );
  return { layoutAndVisualHierarchyScore, legibilityAndAccessibilityScore };
}

/**
 * Evaluates an in-memory render produced by trusted internal code. It never
 * fetches a URL or accepts a caller-supplied fingerprint as authoritative.
 */
export async function evaluateTrustedRenderedCreative(
  record: TrustedInternalRenderRecord
): Promise<RenderedCreativeEvaluation> {
  if (!record || !Buffer.isBuffer(record.renderedBytes) || record.renderedBytes.length === 0) {
    return rejected("RENDER_BYTES_EMPTY");
  }
  if (!record.layoutMetrics || !isValidMetrics(record.layoutMetrics)) {
    return rejected("RENDER_METRICS_INVALID_OR_MISSING");
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(record.renderedBytes, { failOn: "error" }).metadata();
  } catch {
    return rejected("RENDER_BYTES_CORRUPT");
  }

  if (!metadata.format || !SUPPORTED_FORMATS.has(metadata.format)) {
    return rejected("RENDER_FORMAT_UNSUPPORTED");
  }
  if (metadata.width !== record.layoutMetrics.width || metadata.height !== record.layoutMetrics.height) {
    return rejected("RENDER_DIMENSIONS_MISMATCH");
  }

  const metrics = record.layoutMetrics;
  const cta = metrics.ctaBoundingBox;
  const safeInsetX = metrics.width * 0.05;
  const safeInsetY = metrics.height * 0.05;
  if (metrics.didCrowd || metrics.usedContentHeight > metrics.availableContentHeight) return rejected("RENDER_CLIPPING_OR_SAFE_BOUNDS_FAILED");
  if (
    cta.x < safeInsetX || cta.y < safeInsetY ||
    cta.x + cta.w > metrics.width - safeInsetX ||
    cta.y + cta.h > metrics.height - safeInsetY
  ) return rejected("RENDER_CTA_OUTSIDE_SAFE_BOUNDS");
  if (metrics.minFontSizeUsed < 14) return rejected("RENDER_FONT_SIZE_TOO_SMALL");
  // Content-stack density is diagnostic only. A high usedContentHeight ratio
  // never independently rejects: the renderer compresses cards to fit and
  // reports genuine crowding via didCrowd, so stack utilisation is recorded
  // (RENDER_DENSITY_DIAGNOSTIC) without gate or scoring authority.

  const renderedBytesSha256 = createHash("sha256").update(record.renderedBytes).digest("hex");
  if (!SHA256_PATTERN.test(renderedBytesSha256)) return rejected("RENDER_FINGERPRINT_INVALID");
  const scores = scoreMetrics(metrics);
  const reasonCodes = [
    "RENDER_BYTES_VERIFIED",
    "RENDER_LAYOUT_METRICS_V2_VERIFIED",
    "RENDER_DENSITY_DIAGNOSTIC",
    "CONTRAST_NOT_EVALUABLE",
  ];
  const evidenceRefs = [
    `asset:sha256:${renderedBytesSha256}`,
    `metrics:binding:${buildRenderMetricsBindingFingerprint(renderedBytesSha256, metrics)}`,
  ];
  const evidence = Object.freeze({
    source: "render_evaluator" as const,
    renderedAssetFingerprint: renderedBytesSha256,
    renderedBytesSha256,
    verification: "trusted_render_bytes_v1" as const,
    evaluatorVersion: RENDERED_CREATIVE_EVALUATOR_VERSION,
    metricsBindingFingerprint: buildRenderMetricsBindingFingerprint(renderedBytesSha256, metrics),
    ...scores,
    reasonCodes,
    evidenceRefs,
  });
  trustedEvidence.add(evidence);
  return {
    accepted: true,
    reasonCodes,
    evidence,
  };
}