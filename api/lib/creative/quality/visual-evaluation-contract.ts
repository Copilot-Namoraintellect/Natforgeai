/**
 * WBS12F – Deterministic Normalized Visual Evaluation Contract.
 *
 * Explicit visual-quality evaluation that is independent from semantic
 * fidelity. Semantic copy (headlines, captions, CTA wording, benefits) is
 * owned by message-approval/content-compliance and is deliberately NOT an
 * input here: this contract consumes only renderer-authored geometry,
 * brand-palette colours, brand-asset render diagnostics, visual-direction
 * choices and (optionally) adapted vision-critic scores. It never reads,
 * rewrites or re-approves copy.
 *
 * Contract properties:
 * - seven normalized dimensions, each scored 0-100 with an explicit
 *   threshold; a dimension below its threshold is reported as an explicit
 *   failure dimension;
 * - deterministic evidence is authoritative; adapted vision-critic evidence
 *   only fills dimensions deterministic evidence cannot observe (provenance
 *   is recorded per dimension);
 * - fail-closed: a dimension with no usable evidence is
 *   "insufficient_evidence" and blocks a "passed" verdict;
 * - pure and provider-free: same input evidence always yields the same
 *   result; no network, no LLM, no database.
 */

export const VISUAL_EVALUATION_CONTRACT_VERSION = "wbs12f.visual-evaluation-contract.v1";

export type VisualDimensionId =
  | "visual_hierarchy"
  | "layout_balance"
  | "brand_consistency"
  | "image_quality"
  | "typography"
  | "readability_contrast"
  | "professional_finish";

export const VISUAL_DIMENSION_IDS: readonly VisualDimensionId[] = [
  "visual_hierarchy",
  "layout_balance",
  "brand_consistency",
  "image_quality",
  "typography",
  "readability_contrast",
  "professional_finish",
];

export interface VisualDimensionConfig {
  dimensionId: VisualDimensionId;
  /** Explicit minimum normalized score (0-100). Below this = failure dimension. */
  threshold: number;
  /** Weight in the overall normalized score. Weights sum to 1. */
  weight: number;
}

export const VISUAL_DIMENSION_CONFIGS: readonly VisualDimensionConfig[] = [
  { dimensionId: "visual_hierarchy", threshold: 70, weight: 0.15 },
  { dimensionId: "layout_balance", threshold: 65, weight: 0.15 },
  { dimensionId: "brand_consistency", threshold: 70, weight: 0.15 },
  { dimensionId: "image_quality", threshold: 65, weight: 0.1 },
  { dimensionId: "typography", threshold: 70, weight: 0.1 },
  { dimensionId: "readability_contrast", threshold: 70, weight: 0.15 },
  { dimensionId: "professional_finish", threshold: 70, weight: 0.2 },
];

/** Renderer-authored geometry (structurally satisfied by V2RenderLayoutMetrics). */
export interface RenderGeometryEvidence {
  width: number;
  height: number;
  ctaBoundingBox: { x: number; y: number; w: number; h: number };
  footerY?: number;
  minFontSizeUsed: number;
  didCrowd: boolean;
  usedContentHeight: number;
  availableContentHeight: number;
  primaryCardCount: number;
  secondaryCardCount: number;
}

/** Brand-asset render diagnostics (structurally satisfied by HybridRenderMetrics). */
export interface BrandRenderDiagnosticsEvidence {
  realLogoExpected?: boolean;
  realLogoRendered?: boolean;
  fallbackBadgeRendered?: boolean;
  logoMaskedOrCropped?: boolean;
  logoRenderedHeight?: number;
  logoVisibleArea?: number;
  logoRenderMode?: "image" | "fallback_badge";
  logoImageErrors?: string[];
}

/** Resolved palette actually used for the render (structurally satisfied by HybridBrandKit). */
export interface PaletteEvidence {
  primary?: string | null;
  secondary?: string | null;
  accent?: string | null;
  background?: string | null;
  text?: string | null;
  source?: string | null;
}

/** Visual direction chosen for the render (structurally satisfied by VisualDirection). */
export interface VisualDirectionEvidence {
  density?: string | null;
  serviceLayout?: string | null;
  heroTreatment?: string | null;
  ctaTreatment?: string | null;
  backgroundDirection?: string | null;
}

/** One adapted vision dimension score (produced by the vision-critic adapter). */
export interface AdaptedVisionDimension {
  score: number | null;
  observed: boolean;
}

/** Adapted vision-critic evidence (produced by the vision-critic adapter). */
export interface AdaptedVisionEvidence {
  version: string;
  available: boolean;
  unavailableReason: string | null;
  dimensions: Record<VisualDimensionId, AdaptedVisionDimension>;
}

export interface VisualEvaluationEvidenceInput {
  renderMetrics?: RenderGeometryEvidence | null;
  brandRenderDiagnostics?: BrandRenderDiagnosticsEvidence | null;
  palette?: PaletteEvidence | null;
  visualDirection?: VisualDirectionEvidence | null;
  vision?: AdaptedVisionEvidence | null;
}

export type VisualDimensionEvidenceProvenance = "deterministic" | "vision_critic" | "none";

export interface VisualDimensionEvaluation {
  dimensionId: VisualDimensionId;
  threshold: number;
  weight: number;
  /** Normalized 0-100 score; null only when evaluationStatus is "insufficient_evidence". */
  score: number | null;
  /** True only when a score exists and meets the explicit threshold. */
  passed: boolean;
  evaluationStatus: "evaluated" | "insufficient_evidence";
  provenance: VisualDimensionEvidenceProvenance;
  /** Corroborating vision-critic score for this dimension, when one was supplied. */
  corroboratingVisionScore: number | null;
  reasonCodes: string[];
}

export type VisualEvaluationVerdict = "passed" | "failed" | "insufficient_evidence";

export interface VisualQualityContractResult {
  contractVersion: string;
  verdict: VisualEvaluationVerdict;
  /** Weighted normalized score; null while any dimension lacks evidence. */
  normalizedScore: number | null;
  dimensions: VisualDimensionEvaluation[];
  /** Explicit failure dimensions: evaluated but below their threshold. */
  failedDimensions: VisualDimensionEvaluation[];
  insufficientDimensions: VisualDimensionId[];
  reasonCodes: string[];
}

const CONFIG_BY_DIMENSION = new Map(
  VISUAL_DIMENSION_CONFIGS.map((config) => [config.dimensionId, config])
);

export function getVisualDimensionConfig(
  dimensionId: VisualDimensionId
): VisualDimensionConfig {
  const config = CONFIG_BY_DIMENSION.get(dimensionId);
  if (!config) {
    throw new Error(`Unknown visual dimension: ${dimensionId}`);
  }
  return { ...config };
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

interface DeterministicDimensionScore {
  score: number;
  reasonCodes: string[];
}

// ---------------------------------------------------------------------------
// Colour helpers (local, dependency-free; hex normalization mirrors
// ../brand-palette normaliseHex semantics).
// ---------------------------------------------------------------------------

function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace("#", "").trim();
  if (/^[0-9A-Fa-f]{3}$/.test(clean)) {
    return `#${clean.split("").map((c) => c + c).join("").toUpperCase()}`;
  }
  if (/^[0-9A-Fa-f]{6}$/.test(clean)) {
    return `#${clean.toUpperCase()}`;
  }
  return null;
}

function channelLuminance(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number | null {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  const num = parseInt(normalized.slice(1), 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** WCAG 2.x contrast ratio between two colours; null when either is unusable. */
export function contrastRatio(foregroundHex: string, backgroundHex: string): number | null {
  const l1 = relativeLuminance(foregroundHex);
  const l2 = relativeLuminance(backgroundHex);
  if (l1 === null || l2 === null) return null;
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function contrastScore(ratio: number): { score: number; reasonCode: string } {
  if (ratio >= 7) return { score: 100, reasonCode: "CONTRAST_RATIO_EXCELLENT" };
  if (ratio >= 4.5) return { score: 90, reasonCode: "CONTRAST_RATIO_AA" };
  if (ratio >= 3) return { score: 70, reasonCode: "CONTRAST_RATIO_AA_LARGE" };
  if (ratio >= 2) return { score: 40, reasonCode: "CONTRAST_RATIO_LOW" };
  return { score: 15, reasonCode: "CONTRAST_RATIO_CRITICALLY_LOW" };
}

// ---------------------------------------------------------------------------
// Deterministic dimension scorers. Each returns null when its evidence is
// absent or unusable (insufficient evidence), never a fabricated score.
// ---------------------------------------------------------------------------

function scoreVisualHierarchy(input: VisualEvaluationEvidenceInput): DeterministicDimensionScore | null {
  const metrics = input.renderMetrics;
  if (!metrics) return null;
  const { width, height, ctaBoundingBox: cta } = metrics;
  if (
    !isFiniteNumber(width) || width <= 0 ||
    !isFiniteNumber(height) || height <= 0 ||
    !isFiniteNumber(cta.x) || !isFiniteNumber(cta.y) ||
    !isFiniteNumber(cta.w) || cta.w <= 0 ||
    !isFiniteNumber(cta.h) || cta.h <= 0
  ) {
    return null;
  }

  const reasons: string[] = [];
  const ctaAreaRatio = (cta.w * cta.h) / (width * height);
  // Same prominence model as the trusted rendered-creative evaluator:
  // ideal CTA area share is ~4% of canvas; deviation is penalized linearly.
  let score = 100 - Math.abs(ctaAreaRatio - 0.04) * 250;
  reasons.push(`CTA_AREA_SHARE_${ctaAreaRatio.toFixed(4)}`);

  const safeInsetX = width * 0.05;
  const safeInsetY = height * 0.05;
  if (
    cta.x < safeInsetX || cta.y < safeInsetY ||
    cta.x + cta.w > width - safeInsetX ||
    cta.y + cta.h > height - safeInsetY
  ) {
    score -= 40;
    reasons.push("CTA_OUTSIDE_SAFE_BOUNDS");
  } else {
    reasons.push("CTA_WITHIN_SAFE_BOUNDS");
  }

  if (isFiniteNumber(metrics.footerY) && cta.y + cta.h > metrics.footerY + 4) {
    score -= 30;
    reasons.push("CTA_OVERLAPS_FOOTER");
  }

  if (metrics.didCrowd === true) {
    score -= 35;
    reasons.push("RENDER_CROWDED");
  } else {
    reasons.push("RENDER_NOT_CROWDED");
  }

  return { score: clampScore(score), reasonCodes: reasons };
}

function scoreLayoutBalance(input: VisualEvaluationEvidenceInput): DeterministicDimensionScore | null {
  const metrics = input.renderMetrics;
  if (!metrics) return null;
  const { width, height, ctaBoundingBox: cta } = metrics;
  if (
    !isFiniteNumber(width) || width <= 0 ||
    !isFiniteNumber(height) || height <= 0 ||
    !isFiniteNumber(metrics.usedContentHeight) || metrics.usedContentHeight < 0 ||
    !isFiniteNumber(metrics.availableContentHeight) || metrics.availableContentHeight <= 0 ||
    !isFiniteNumber(metrics.primaryCardCount) || metrics.primaryCardCount < 0
  ) {
    return null;
  }

  const reasons: string[] = [];
  const utilization = metrics.usedContentHeight / metrics.availableContentHeight;
  let score: number;
  if (utilization > 1) {
    score = 20;
    reasons.push("CONTENT_STACK_OVERFLOW");
  } else if (utilization >= 0.9) {
    score = 100;
    reasons.push("CONTENT_STACK_WELL_USED");
  } else if (utilization >= 0.5) {
    score = 90;
    reasons.push("CONTENT_STACK_BALANCED");
  } else if (utilization >= 0.35) {
    score = 75;
    reasons.push("CONTENT_STACK_SPARSE");
  } else {
    score = 55;
    reasons.push("CONTENT_STACK_UNDERUSED");
  }

  if (metrics.primaryCardCount === 0) {
    score -= 10;
    reasons.push("NO_PRIMARY_CARDS");
  } else if (metrics.primaryCardCount > 4) {
    score -= 10;
    reasons.push("TOO_MANY_PRIMARY_CARDS");
  } else {
    reasons.push("PRIMARY_CARD_COUNT_BALANCED");
  }

  if (isFiniteNumber(cta.x) && isFiniteNumber(cta.w) && width > 0) {
    const ctaCenterOffset = Math.abs(cta.x + cta.w / 2 - width / 2) / width;
    if (ctaCenterOffset <= 0.02) {
      score += 5;
      reasons.push("CTA_HORIZONTALLY_CENTERED");
    } else if (ctaCenterOffset > 0.15) {
      score -= 10;
      reasons.push("CTA_OFF_CENTER");
    }
  }

  if (input.visualDirection?.density === "dense") {
    score -= 15;
    reasons.push("DENSE_LAYOUT_DIRECTION");
  } else if (input.visualDirection?.density === "minimal") {
    score += 5;
    reasons.push("MINIMAL_LAYOUT_DIRECTION");
  }

  return { score: clampScore(score), reasonCodes: reasons };
}

const BRAND_DERIVED_PALETTE_SOURCES = new Set(["logo", "brandColors", "websiteEvidence"]);

function scoreBrandConsistency(input: VisualEvaluationEvidenceInput): DeterministicDimensionScore | null {
  const diagnostics = input.brandRenderDiagnostics;
  const palette = input.palette;
  if (!diagnostics && !palette) return null;

  const reasons: string[] = [];
  let score = 100;

  if (palette) {
    if (palette.source && BRAND_DERIVED_PALETTE_SOURCES.has(palette.source)) {
      reasons.push(`PALETTE_SOURCE_${palette.source.toUpperCase()}`);
    } else {
      score -= 25;
      reasons.push("GENERIC_DEFAULT_PALETTE");
    }
  }

  if (diagnostics) {
    const realLogoExpected = diagnostics.realLogoExpected === true;
    const fallbackBadgeRendered =
      diagnostics.fallbackBadgeRendered === true || diagnostics.logoRenderMode === "fallback_badge";
    if (realLogoExpected && fallbackBadgeRendered) {
      score -= 50;
      reasons.push("FALLBACK_BADGE_WHILE_REAL_LOGO_EXPECTED");
    } else if (realLogoExpected && diagnostics.realLogoRendered === false) {
      score -= 40;
      reasons.push("REAL_LOGO_NOT_RENDERED");
    } else if (realLogoExpected && (diagnostics.realLogoRendered === true || diagnostics.logoRenderMode === "image")) {
      reasons.push("REAL_LOGO_RENDERED");
    } else if (!realLogoExpected) {
      reasons.push("REAL_LOGO_NOT_EXPECTED");
    }

    if (diagnostics.logoMaskedOrCropped === true) {
      score -= 30;
      reasons.push("LOGO_MASKED_OR_CROPPED");
    }
    if (Array.isArray(diagnostics.logoImageErrors) && diagnostics.logoImageErrors.length > 0) {
      score -= 20;
      reasons.push("LOGO_IMAGE_ERRORS");
    }
  }

  return { score: clampScore(score), reasonCodes: reasons };
}

function scoreImageQuality(input: VisualEvaluationEvidenceInput): DeterministicDimensionScore | null {
  const diagnostics = input.brandRenderDiagnostics;
  if (!diagnostics) return null;

  const reasons: string[] = [];

  if (diagnostics.realLogoExpected !== true) {
    // No brand imagery was expected; nothing verifiable, neutral pass-through.
    return { score: 75, reasonCodes: ["NO_LOGO_EXPECTED_IMAGE_DIAGNOSTICS_NEUTRAL"] };
  }

  let score: number | null = null;
  const area = diagnostics.logoVisibleArea;
  const height = diagnostics.logoRenderedHeight;
  if (isFiniteNumber(area) && area > 0) {
    if (area >= 8000) score = 100;
    else if (area >= 4000) score = 85;
    else if (area >= 1500) score = 65;
    else score = 45;
    reasons.push(`LOGO_VISIBLE_AREA_${area}`);
  }
  if (isFiniteNumber(height) && height > 0) {
    const heightScore =
      height >= 70 ? 100 :
      height >= 55 ? 90 :
      height >= 40 ? 70 : 45;
    reasons.push(`LOGO_RENDERED_HEIGHT_${height}`);
    score = score === null ? heightScore : Math.round((score + heightScore) / 2);
  }
  if (score === null) return null;

  if (diagnostics.fallbackBadgeRendered === true || diagnostics.logoRenderMode === "fallback_badge") {
    score = Math.min(score, 40);
    reasons.push("IMAGE_FALLBACK_BADGE_RENDERED");
  }
  if (diagnostics.logoMaskedOrCropped === true) {
    score = Math.min(score, 50);
    reasons.push("IMAGE_LOGO_MASKED_OR_CROPPED");
  }
  if (Array.isArray(diagnostics.logoImageErrors) && diagnostics.logoImageErrors.length > 0) {
    score = Math.min(score, 40);
    reasons.push("IMAGE_LOGO_ERRORS_PRESENT");
  }

  return { score: clampScore(score), reasonCodes: reasons };
}

function scoreTypography(input: VisualEvaluationEvidenceInput): DeterministicDimensionScore | null {
  const minFontSize = input.renderMetrics?.minFontSizeUsed;
  if (!isFiniteNumber(minFontSize) || minFontSize <= 0) return null;

  if (minFontSize >= 24) return { score: 100, reasonCodes: [`MIN_FONT_SIZE_${minFontSize}`, "TYPOGRAPHY_SCALE_STRONG"] };
  if (minFontSize >= 20) return { score: 90, reasonCodes: [`MIN_FONT_SIZE_${minFontSize}`, "TYPOGRAPHY_SCALE_ADEQUATE"] };
  if (minFontSize >= 18) return { score: 80, reasonCodes: [`MIN_FONT_SIZE_${minFontSize}`, "TYPOGRAPHY_SCALE_ADEQUATE"] };
  if (minFontSize >= 16) return { score: 70, reasonCodes: [`MIN_FONT_SIZE_${minFontSize}`, "TYPOGRAPHY_SCALE_MARGINAL"] };
  if (minFontSize >= 14) return { score: 55, reasonCodes: [`MIN_FONT_SIZE_${minFontSize}`, "TYPOGRAPHY_SCALE_WEAK"] };
  return { score: 35, reasonCodes: [`MIN_FONT_SIZE_${minFontSize}`, "TYPOGRAPHY_SCALE_TOO_SMALL"] };
}

function scoreReadabilityContrast(input: VisualEvaluationEvidenceInput): DeterministicDimensionScore | null {
  const palette = input.palette;
  if (!palette) return null;

  const textHex = normalizeHex(palette.text);
  const backgroundHex = normalizeHex(palette.background);
  const accentHex = normalizeHex(palette.accent ?? palette.primary);

  const checks: { label: string; ratio: number | null }[] = [];
  if (textHex && backgroundHex) {
    checks.push({ label: "TEXT_ON_BACKGROUND", ratio: contrastRatio(textHex, backgroundHex) });
  }
  if (textHex && accentHex) {
    checks.push({ label: "TEXT_ON_ACCENT", ratio: contrastRatio(textHex, accentHex) });
  }
  const usable = checks.filter((check) => check.ratio !== null);
  if (usable.length === 0) return null;

  let worst = usable[0];
  for (const check of usable.slice(1)) {
    if ((check.ratio as number) < (worst.ratio as number)) worst = check;
  }

  const { score, reasonCode } = contrastScore(worst.ratio as number);
  const reasons = usable.map(
    (check) => `${check.label}_RATIO_${(check.ratio as number).toFixed(2)}`
  );
  reasons.push(reasonCode);
  if (!textHex || !backgroundHex) reasons.push("PALETTE_INCOMPLETE_CONTRAST_PARTIAL");
  return { score, reasonCodes: reasons };
}

function scoreProfessionalFinish(input: VisualEvaluationEvidenceInput): DeterministicDimensionScore | null {
  const hasAnyEvidence =
    !!input.renderMetrics ||
    !!input.brandRenderDiagnostics ||
    !!input.palette ||
    !!input.visualDirection;
  if (!hasAnyEvidence) return null;

  const reasons: string[] = [];
  let score = 100;

  const diagnostics = input.brandRenderDiagnostics;
  if (diagnostics) {
    if (
      diagnostics.realLogoExpected === true &&
      (diagnostics.fallbackBadgeRendered === true || diagnostics.logoRenderMode === "fallback_badge")
    ) {
      score -= 50;
      reasons.push("FINISH_FALLBACK_BADGE");
    }
    if (diagnostics.logoMaskedOrCropped === true) {
      score -= 20;
      reasons.push("FINISH_LOGO_MASKED_OR_CROPPED");
    }
    if (Array.isArray(diagnostics.logoImageErrors) && diagnostics.logoImageErrors.length > 0) {
      score -= 20;
      reasons.push("FINISH_LOGO_IMAGE_ERRORS");
    }
  }

  if (input.renderMetrics?.didCrowd === true) {
    score -= 40;
    reasons.push("FINISH_RENDER_CROWDED");
  }

  if (input.palette && (!input.palette.source || !BRAND_DERIVED_PALETTE_SOURCES.has(input.palette.source))) {
    score -= 15;
    reasons.push("FINISH_GENERIC_DEFAULT_PALETTE");
  }

  if (
    input.visualDirection?.serviceLayout === "grid" &&
    isFiniteNumber(input.renderMetrics?.primaryCardCount) &&
    (input.renderMetrics as RenderGeometryEvidence).primaryCardCount >= 3
  ) {
    score -= 15;
    reasons.push("FINISH_GENERIC_CARD_GRID");
  }

  if (reasons.length === 0) reasons.push("FINISH_CLEAN");
  return { score: clampScore(score), reasonCodes: reasons };
}

// ---------------------------------------------------------------------------
// Contract evaluation.
// ---------------------------------------------------------------------------

function resolveDimension(
  dimensionId: VisualDimensionId,
  input: VisualEvaluationEvidenceInput
): VisualDimensionEvaluation {
  const config = CONFIG_BY_DIMENSION.get(dimensionId) as VisualDimensionConfig;
  const visionDimension = input.vision?.dimensions[dimensionId] ?? null;

  let deterministic: DeterministicDimensionScore | null = null;
  switch (dimensionId) {
    case "visual_hierarchy":
      deterministic = scoreVisualHierarchy(input);
      break;
    case "layout_balance":
      deterministic = scoreLayoutBalance(input);
      break;
    case "brand_consistency":
      deterministic = scoreBrandConsistency(input);
      break;
    case "image_quality":
      deterministic = scoreImageQuality(input);
      break;
    case "typography":
      deterministic = scoreTypography(input);
      break;
    case "readability_contrast":
      deterministic = scoreReadabilityContrast(input);
      break;
    case "professional_finish":
      deterministic = scoreProfessionalFinish(input);
      break;
  }

  const corroboratingVisionScore =
    visionDimension && visionDimension.observed && visionDimension.score !== null
      ? visionDimension.score
      : null;

  if (deterministic) {
    const score = clampScore(deterministic.score);
    return {
      dimensionId,
      threshold: config.threshold,
      weight: config.weight,
      score,
      passed: score >= config.threshold,
      evaluationStatus: "evaluated",
      provenance: "deterministic",
      corroboratingVisionScore,
      reasonCodes: deterministic.reasonCodes,
    };
  }

  const visionAvailable =
    input.vision?.available === true &&
    visionDimension !== null &&
    visionDimension.observed === true &&
    visionDimension.score !== null;

  if (visionAvailable) {
    const score = clampScore((visionDimension as AdaptedVisionDimension).score as number);
    return {
      dimensionId,
      threshold: config.threshold,
      weight: config.weight,
      score,
      passed: score >= config.threshold,
      evaluationStatus: "evaluated",
      provenance: "vision_critic",
      corroboratingVisionScore,
      reasonCodes: ["DETERMINISTIC_EVIDENCE_UNAVAILABLE_VISION_OBSERVED"],
    };
  }

  return {
    dimensionId,
    threshold: config.threshold,
    weight: config.weight,
    score: null,
    passed: false,
    evaluationStatus: "insufficient_evidence",
    provenance: "none",
    corroboratingVisionScore,
    reasonCodes:
      input.vision && input.vision.available === false
        ? [`VISION_EVIDENCE_UNAVAILABLE${input.vision.unavailableReason ? `:${input.vision.unavailableReason}` : ""}`]
        : ["DETERMINISTIC_EVIDENCE_UNAVAILABLE"],
  };
}

/**
 * Evaluates the normalized visual-quality contract over the supplied evidence.
 * Pure and deterministic: identical evidence always produces an identical
 * result. Never reads or mutates semantic copy.
 */
export function evaluateVisualQualityContract(
  input: VisualEvaluationEvidenceInput
): VisualQualityContractResult {
  const dimensions = VISUAL_DIMENSION_IDS.map((dimensionId) =>
    resolveDimension(dimensionId, input)
  );

  const insufficientDimensions = dimensions
    .filter((dimension) => dimension.evaluationStatus === "insufficient_evidence")
    .map((dimension) => dimension.dimensionId);
  const failedDimensions = dimensions.filter(
    (dimension) => dimension.evaluationStatus === "evaluated" && !dimension.passed
  );

  let verdict: VisualEvaluationVerdict;
  let normalizedScore: number | null;
  if (insufficientDimensions.length > 0) {
    verdict = "insufficient_evidence";
    normalizedScore = null;
  } else if (failedDimensions.length > 0) {
    verdict = "failed";
    normalizedScore =
      Math.round(
        dimensions.reduce((sum, dimension) => sum + (dimension.score as number) * dimension.weight, 0) *
          100
      ) / 100;
  } else {
    verdict = "passed";
    normalizedScore =
      Math.round(
        dimensions.reduce((sum, dimension) => sum + (dimension.score as number) * dimension.weight, 0) *
          100
      ) / 100;
  }

  const reasonCodes: string[] = [`CONTRACT_VERSION_${VISUAL_EVALUATION_CONTRACT_VERSION}`];
  if (verdict === "passed") reasonCodes.push("ALL_DIMENSIONS_MEET_THRESHOLDS");
  if (verdict === "failed") {
    reasonCodes.push("FAILURE_DIMENSIONS_PRESENT");
    for (const failed of failedDimensions) {
      reasonCodes.push(`FAILED_DIMENSION_${failed.dimensionId}_${failed.score}`);
    }
  }
  if (verdict === "insufficient_evidence") {
    reasonCodes.push("INSUFFICIENT_EVIDENCE_FAIL_CLOSED");
    for (const missing of insufficientDimensions) {
      reasonCodes.push(`INSUFFICIENT_DIMENSION_${missing}`);
    }
  }

  return {
    contractVersion: VISUAL_EVALUATION_CONTRACT_VERSION,
    verdict,
    normalizedScore,
    dimensions,
    failedDimensions,
    insufficientDimensions,
    reasonCodes,
  };
}
