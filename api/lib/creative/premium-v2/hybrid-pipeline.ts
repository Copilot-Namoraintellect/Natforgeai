/**
 * Premium Leaflet Hybrid Pipeline – Orchestrator.
 *
 * Runs the full hybrid creative pipeline:
 *   Combined Creative Plan (BrandKit + Brief + Visual Direction)
 *   → Background
 *   → HTML Render
 *   → Vision Critic
 *   → Revision Loop (reuses background for layout/text issues)
 *
 * Falls back to the deterministic V2 renderer if any AI stage fails or if the
 * hybrid pipeline is disabled. Preserves the previous approved asset on failure.
 *
 * Transparency rules:
 * - Every result reports attempted/succeeded/final-used per OpenAI stage.
 * - Rejected hybrid attempts are kept in sampleMode so they can be inspected.
 * - Deterministic fallback never reports perfect critic scores.
 * - Vision critic failures (quota/API/unavailable) are never permissive passes.
 */

import { env } from "../../env";
import type { BusinessEvidence, CampaignEvidence } from "./curation";
import { applyBrandAssetGate, type BrandAssetResolution } from "../brand-asset-resolver";
import { planCreativeWithAI } from "./plan-ai";
import { renderV2FromBrief } from "./renderer";
import { buildPremiumV2Brief } from "./brief";
import { validatePremiumV2Quality } from "./quality";
import type {
  HybridPipelineInput,
  HybridPipelineResult,
  HybridBrandKit,
  AICreativeBrief,
  VisualDirection,
  HybridPipelineMetadata,
  HybridFinalDecision,
  VisionCriticResult,
  HybridPipelineAttempt,
} from "./pipeline-types";
import { type ContentFidelityResult } from "./content-fidelity";
import { evaluateCopyQuality, visibleTextFromBrief, type CopyQualityResult } from "./copy-quality";
import { selectBestHybridVariant } from "./variant-selector";
import type { PremiumDesignContractResult } from "./premium-design-contract";
import type { LayoutScoreResult } from "./layout-scoring";
import { type LogoCropCriticResult } from "./vision-critic";

export async function runHybridPipeline(input: HybridPipelineInput): Promise<HybridPipelineResult> {
  if (!env.enableHybridLeafletPipeline || !env.openaiApiKey) {
    return runDeterministicFallback(input, undefined, undefined, undefined, {
      reason: !env.enableHybridLeafletPipeline
        ? "Hybrid pipeline feature flag disabled"
        : "OPENAI_API_KEY not configured",
    });
  }

  const business = input.business as BusinessEvidence;
  const campaign = (input.campaign || {}) as CampaignEvidence;
  const sampleMode = input.sampleMode ?? false;

  let openAICallCount = 0;

  // Track attempted/succeeded per stage.
  const stage = {
    brandKit: { attempted: false, succeeded: false },
    brief: { attempted: false, succeeded: false },
    visualDirection: { attempted: false, succeeded: false },
    background: { attempted: false, succeeded: false },
    visionCritic: { attempted: false, succeeded: false },
  };

  try {
    const planResult = await planCreativeWithAI(business, campaign);
    stage.brandKit.attempted = true;
    stage.brief.attempted = true;
    stage.visualDirection.attempted = true;
    stage.brandKit.succeeded = planResult.usedOpenAI;
    stage.brief.succeeded = planResult.usedOpenAI;
    stage.visualDirection.succeeded = planResult.usedOpenAI;
    openAICallCount += planResult.usedOpenAI ? 1 : 0;

    const { brandKit, brief, visualDirection: initialVisualDirection } = planResult.value;
    const brandAsset = brandKit.brandAsset;
    const gate = brandAsset ? applyBrandAssetGate(brandAsset) : { passed: true, label: "Brand Assets OK", criticalIssues: [], warnings: [] };
    if (!gate.passed) {
      console.warn(`[HybridPipeline] Brand asset gate failed: ${gate.criticalIssues.join("; ")}`);
      return runDeterministicFallback(input, brandKit, brief, [], {
        reason: `Brand Asset Review Required: ${gate.criticalIssues.join("; ")}`,
        openAICallCount,
        stage,
        finalDecisionOverride: "fallback_used",
      });
    }
    const attempts: HybridPipelineAttempt[] = [];
    const openAICallCountRef = { value: openAICallCount };

    const variantSelection = await selectBestHybridVariant({
      business,
      campaign,
      brandKit,
      brief,
      brandAsset,
      baseVisualDirection: initialVisualDirection,
      openAICallCountRef,
      sampleMode,
      attempts,
    });
    openAICallCount = openAICallCountRef.value;

    stage.background.attempted = true;
    stage.background.succeeded = variantSelection.variants.length > 0;
    stage.visionCritic.attempted = true;
    stage.visionCritic.succeeded = !variantSelection.best.rawCritic.unavailable;

    const best = variantSelection.best;

    if (best.rawCritic.unavailable) {
      return runDeterministicFallback(input, brandKit, brief, attempts, {
        reason: best.rawCritic.criticalIssues[0] || "Vision critic unavailable",
        quotaError: best.rawCritic.quotaError,
        openAICallCount,
        stage,
        rejectionCritic: best.rawCritic,
        lastRenderMetrics: best.metrics,
        lastContentFidelity: best.contentFidelity,
        lastCopyQuality: best.copyQuality,
      });
    }

    const brandFidelity = computeBrandFidelityAdjudication(best.metrics, best.rawCritic, brandAsset, best.logoCropCritic);
    const adjudication = buildAdjudicatedCritic(best.rawCritic, brandFidelity, best.contentFidelity, best.logoCropCritic);
    const effectiveCritic = adjudication.critic;

    // Final decision is now driven by the Premium Design Contract.
    if (best.contract.passed) {
      return buildResult(
        input,
        brandKit,
        brief,
        best.visualDirection,
        best.buffer,
        effectiveCritic,
        0,
        false,
        stage,
        openAICallCount,
        attempts,
        best.metrics,
        brandFidelity,
        best.contentFidelity,
        best.copyQuality,
        best.rawCritic,
        adjudication,
        best.contract,
        best.layoutScores,
        variantSelection.selectedIndex,
        variantSelection.variants.length,
        "premium_ready"
      );
    }

    if (!best.contract.safeToRetainHybrid) {
      const inventedOffer = best.contentFidelity?.inventedOfferDetected;
      const copyQualityFailed = !best.copyQuality.copyQualityPassed;
      const contentIssue = inventedOffer || copyQualityFailed;

      let reason: string;
      if (inventedOffer) {
        reason = `Invented offer detected: ${best.contentFidelity?.detectedOfferSnippet || "unsupported promotional language"}`;
      } else if (copyQualityFailed) {
        reason = `Copy quality review required: ${best.copyQuality.copyQualityIssues.join("; ")}`;
      } else if (brandFidelity?.criticConflict && brandFidelity.criticConflictReason) {
        reason = brandFidelity.criticConflictReason;
      } else {
        reason = `Premium Design Contract failed: ${best.contract.issues.join("; ")}`;
      }

      return runDeterministicFallback(input, brandKit, brief, attempts, {
        reason,
        openAICallCount,
        stage,
        rejectionCritic: best.rawCritic,
        lastRenderMetrics: best.metrics,
        lastContentFidelity: best.contentFidelity,
        lastCopyQuality: best.copyQuality,
        brandFidelity,
        finalDecisionOverride: contentIssue ? "content_review_required" : "fallback_used",
      });
    }

    const finalDecision: HybridFinalDecision =
      best.contentFidelity?.inventedOfferDetected || !best.copyQuality.copyQualityPassed
        ? "content_review_required"
        : "hybrid_review_required";

    return buildResult(
      input,
      brandKit,
      brief,
      best.visualDirection,
      best.buffer,
      effectiveCritic,
      0,
      false,
      stage,
      openAICallCount,
      attempts,
      best.metrics,
      brandFidelity,
      best.contentFidelity,
      best.copyQuality,
      best.rawCritic,
      adjudication,
      best.contract,
      best.layoutScores,
      variantSelection.selectedIndex,
      variantSelection.variants.length,
      finalDecision
    );
  } catch (err: any) {
    const reason = `Pipeline failed: ${err.message}`;
    console.warn(`[HybridPipeline] ${reason}. Falling back to deterministic V2 renderer.`);
    return runDeterministicFallback(input, undefined, undefined, undefined, {
      reason,
      openAICallCount,
      stage,
    });
  }
}

interface BrandFidelityAdjudication {
  structuralBrandFidelityPassed: boolean;
  visionBrandFidelityPassed: boolean;
  criticConflict: boolean;
  criticConflictReason: string | null;
  fullImageVsCropConflict: boolean;
  fullImageVsCropConflictReason: string | null;
  logoCropCritic?: LogoCropCriticResult;
}

function computeBrandFidelityAdjudication(
  renderMetrics: import("./pipeline-types").HybridRenderMetrics | undefined,
  critic: VisionCriticResult,
  brandAsset: BrandAssetResolution | undefined,
  logoCropCritic?: LogoCropCriticResult
): BrandFidelityAdjudication {
  const realLogoExpected = !!brandAsset && brandAsset.realLogoExpected;

  // Structural truth comes from the renderer itself.
  const structuralBrandFidelityPassed =
    !realLogoExpected ||
    (renderMetrics?.realLogoRendered === true &&
      renderMetrics?.fallbackBadgeRendered === false &&
      renderMetrics?.logoMaskedOrCropped === false);

  // What the full-image critic thinks about the logo on its own.
  const fullImageLogoPassed =
    !realLogoExpected ||
    (critic.realLogoPresent && !critic.fallbackBadgeUsed && !critic.logoDistortedOrCropped && critic.logoMatchesBrand);

  // Focused logo-crop critic result, when available.
  const cropLogoPassed = logoCropCritic
    ? logoCropCritic.realLogoPresent && !logoCropCritic.fallbackBadgeUsed && !logoCropCritic.logoDistortedOrCropped && logoCropCritic.logoMatchesExpected
    : undefined;

  // Prefer the focused logo-crop critic when available; otherwise fall back to the full-image critic's logo fields.
  const visionBrandFidelityPassed = cropLogoPassed ?? fullImageLogoPassed;

  // Critic conflict occurs when structural renderer truth says logo is fine but the final vision verdict disagrees.
  const criticConflict = realLogoExpected && structuralBrandFidelityPassed && !visionBrandFidelityPassed;

  let criticConflictReason: string | null = null;
  if (criticConflict) {
    const source = cropLogoPassed !== undefined ? "logo-crop critic" : "full-image critic";
    if (cropLogoPassed !== undefined) {
      criticConflictReason = `Vision ${source} contradicted renderer logo diagnostics. Renderer: realLogoRendered=${renderMetrics?.realLogoRendered}, fallbackBadgeRendered=${renderMetrics?.fallbackBadgeRendered}, logoMaskedOrCropped=${renderMetrics?.logoMaskedOrCropped}. Logo-crop critic: realLogoPresent=${logoCropCritic!.realLogoPresent}, fallbackBadgeUsed=${logoCropCritic!.fallbackBadgeUsed}, logoDistortedOrCropped=${logoCropCritic!.logoDistortedOrCropped}, logoMatchesExpected=${logoCropCritic!.logoMatchesExpected}.`;
    } else {
      criticConflictReason = `Vision ${source} contradicted renderer logo diagnostics. Renderer: realLogoRendered=${renderMetrics?.realLogoRendered}, fallbackBadgeRendered=${renderMetrics?.fallbackBadgeRendered}, logoMaskedOrCropped=${renderMetrics?.logoMaskedOrCropped}. Critic: realLogoPresent=${critic.realLogoPresent}, fallbackBadgeUsed=${critic.fallbackBadgeUsed}, logoDistortedOrCropped=${critic.logoDistortedOrCropped}, logoMatchesBrand=${critic.logoMatchesBrand}, brandFidelityPassed=${critic.brandFidelityPassed}.`;
    }
  }

  // Record when the full-image critic disagrees with the logo-crop/reference evidence, even though the crop resolves the final verdict.
  const fullImageVsCropConflict =
    realLogoExpected && !!logoCropCritic && !fullImageLogoPassed && cropLogoPassed === true;

  let fullImageVsCropConflictReason: string | null = null;
  if (fullImageVsCropConflict) {
    fullImageVsCropConflictReason = `Full-image critic reported logo issues but logo-crop/reference check overruled it. Full-image: realLogoPresent=${critic.realLogoPresent}, fallbackBadgeUsed=${critic.fallbackBadgeUsed}, logoDistortedOrCropped=${critic.logoDistortedOrCropped}, logoMatchesBrand=${critic.logoMatchesBrand}. Logo-crop: realLogoPresent=${logoCropCritic!.realLogoPresent}, fallbackBadgeUsed=${logoCropCritic!.fallbackBadgeUsed}, logoDistortedOrCropped=${logoCropCritic!.logoDistortedOrCropped}, logoMatchesExpected=${logoCropCritic!.logoMatchesExpected}.`;
  }

  return {
    structuralBrandFidelityPassed,
    visionBrandFidelityPassed,
    criticConflict,
    criticConflictReason,
    fullImageVsCropConflict,
    fullImageVsCropConflictReason,
    logoCropCritic,
  };
}

function isLogoRelatedIssue(text: string): boolean {
  return /\b(brand fidelity|logo|fallback badge|real logo|real brand logo)\b/i.test(text);
}

function isLogoRelatedSuggestion(text: string): boolean {
  return /\b(logo|badge|fallback|monogram)\b/i.test(text);
}

interface AdjudicatedCritic {
  critic: VisionCriticResult;
  overruledIssues: string[];
  notes: string[];
}

function buildAdjudicatedCritic(
  rawCritic: VisionCriticResult,
  brandFidelity: BrandFidelityAdjudication,
  contentFidelity: ContentFidelityResult | undefined,
  logoCropCritic: LogoCropCriticResult | undefined
): AdjudicatedCritic {
  const overruledIssues: string[] = [];
  const notes: string[] = [];

  const effective: VisionCriticResult = {
    ...rawCritic,
    scores: { ...rawCritic.scores },
    criticalIssues: rawCritic.criticalIssues.slice(),
    improvementSuggestions: rawCritic.improvementSuggestions.slice(),
  };

  // If the logo-crop/reference evidence overrules the full-image critic's logo verdict,
  // remove logo-related blockers from the effective critic.
  if (brandFidelity.fullImageVsCropConflict) {
    notes.push("Full-image critic logo issues overruled by logo-crop/reference check.");

    const keptCritical: string[] = [];
    for (const issue of rawCritic.criticalIssues) {
      if (isLogoRelatedIssue(issue)) {
        overruledIssues.push(issue);
      } else {
        keptCritical.push(issue);
      }
    }
    effective.criticalIssues = keptCritical;

    effective.improvementSuggestions = rawCritic.improvementSuggestions.filter(
      (s) => !isLogoRelatedSuggestion(s)
    );

    effective.scores.brandFidelity = Math.max(effective.scores.brandFidelity, 80);
    effective.scores.logoUsage = Math.max(effective.scores.logoUsage, 80);

    if (logoCropCritic) {
      effective.realLogoPresent = logoCropCritic.realLogoPresent;
      effective.logoMatchesBrand = logoCropCritic.logoMatchesExpected;
      effective.fallbackBadgeUsed = logoCropCritic.fallbackBadgeUsed;
      effective.logoDistortedOrCropped = logoCropCritic.logoDistortedOrCropped;
    }
    effective.brandFidelityPassed = true;
  }

  // Content-fidelity invented offer is enforced by the dedicated gate, but reflect it in the effective critic too.
  if (contentFidelity?.inventedOfferDetected) {
    notes.push(`Content fidelity flagged invented offer: ${contentFidelity.detectedOfferSnippet || "unknown"}.`);
    if (!effective.criticalIssues.some((i) => /invented|offer/i.test(i))) {
      effective.criticalIssues.push("Invented offer detected by content fidelity gate");
    }
  }

  effective.passed = effective.criticalIssues.length === 0 && !contentFidelity?.inventedOfferDetected;

  return { critic: effective, overruledIssues, notes };
}

interface FallbackOptions {
  reason: string;
  finalDecisionOverride?: HybridFinalDecision;
  quotaError?: boolean;
  openAICallCount?: number;
  stage?: {
    brandKit: { attempted: boolean; succeeded: boolean };
    brief: { attempted: boolean; succeeded: boolean };
    visualDirection: { attempted: boolean; succeeded: boolean };
    background: { attempted: boolean; succeeded: boolean };
    visionCritic: { attempted: boolean; succeeded: boolean };
  };
  rejectionCritic?: VisionCriticResult | null;
  lastRenderMetrics?: import("./pipeline-types").HybridRenderMetrics;
  lastContentFidelity?: ContentFidelityResult;
  lastCopyQuality?: CopyQualityResult;
  brandFidelity?: BrandFidelityAdjudication;
}

async function runDeterministicFallback(
  input: HybridPipelineInput,
  brandKit?: HybridBrandKit,
  aiBrief?: AICreativeBrief,
  attempts?: HybridPipelineAttempt[],
  options: FallbackOptions = { reason: "Unknown" }
): Promise<HybridPipelineResult> {
  const brief = await buildPremiumV2Brief({
    business: input.business,
    campaign: input.campaign,
    post: input.post,
    approvedMessagePack: input.approvedMessagePack,
    refinementInstruction: input.refinementInstruction,
    brandKit: brandKit
      ? { palette: brandKit, source: brandKit.source, logoUrl: brandKit.logoUrl || undefined, brandAsset: brandKit.brandAsset }
      : undefined,
  });

  const { buffer, metrics } = await renderV2FromBrief(brief);
  const quality = validatePremiumV2Quality(brief, metrics);

  // Fallback outputs must not report perfect hybrid scores.
  const cappedScore = Math.min(quality.score, 82);
  const genericRisk = Math.max(100 - cappedScore, 25);
  const fallbackCritic: VisionCriticResult = {
    scores: {
      brandFidelity: cappedScore,
      readability: cappedScore,
      premiumFeel: Math.min(cappedScore, 78),
      visualHierarchy: cappedScore,
      logoUsage: cappedScore,
      CTAVisibility: Math.min(cappedScore, 85),
      genericTemplateRisk: genericRisk,
    },
    passed: false,
    unavailable: false,
    quotaError: !!options.quotaError,
    criticalIssues: [options.reason],
    improvementSuggestions: [
      "Hybrid pipeline fell back to deterministic renderer.",
      ...(options.quotaError ? ["OpenAI quota/API error occurred; review before publishing."] : []),
    ],
    realLogoPresent: false,
    logoMatchesBrand: false,
    fallbackBadgeUsed: true,
    logoDistortedOrCropped: false,
    brandFidelityPassed: false,
  };

  const deterministicBrandKit: HybridBrandKit = brandKit || {
    primary: brief.brandPalette.primary,
    secondary: brief.brandPalette.secondary,
    accent: brief.brandPalette.accent,
    background: brief.brandPalette.background,
    text: brief.brandPalette.text,
    textMuted: brief.brandPalette.textMuted,
    source: "default",
    logoUrl: brief.logoUrl || null,
    logoDescription: null,
    typographyNote: null,
    brandAsset: brief.brandAsset,
  };
  if (brandKit && !deterministicBrandKit.brandAsset) {
    deterministicBrandKit.brandAsset = brief.brandAsset;
  }

  const deterministicBrief: AICreativeBrief = aiBrief || {
    angle: brief.subheadline || "",
    headline: brief.headline,
    subheadline: brief.subheadline || "",
    primaryServices: brief.primaryServices.map((s) => ({ name: s.name, description: s.description || null, isPrimary: true })),
    secondaryServices: brief.secondaryServices.map((s) => ({ name: s.name, description: null, isPrimary: false })),
    benefits: brief.benefits,
    cta: brief.cta,
    offerLine: brief.offer || null,
  };

  const fallbackCopyQuality = options.lastCopyQuality ?? evaluateCopyQuality(visibleTextFromBrief(deterministicBrief));

  let finalDecision: HybridFinalDecision = options.finalDecisionOverride || (options.quotaError ? "hybrid_review_required" : "fallback_used");
  if (!options.finalDecisionOverride && options.lastContentFidelity?.inventedOfferDetected) {
    finalDecision = "content_review_required";
  } else if (!options.finalDecisionOverride && !fallbackCopyQuality.copyQualityPassed) {
    finalDecision = "content_review_required";
  }

  const stage = options.stage || {
    brandKit: { attempted: false, succeeded: false },
    brief: { attempted: false, succeeded: false },
    visualDirection: { attempted: false, succeeded: false },
    background: { attempted: false, succeeded: false },
    visionCritic: { attempted: false, succeeded: false },
  };

  const lastMetrics = options.lastRenderMetrics;
  const brandFidelity = options.brandFidelity;
  const contentFidelity = options.lastContentFidelity;
  const metadata: HybridPipelineMetadata = {
    provider: "premium-v2-deterministic",
    layoutPreset: brief.layoutDensity,
    width: metrics.width,
    height: metrics.height,
    attemptedOpenAIBrandKit: stage.brandKit.attempted,
    succeededOpenAIBrandKit: stage.brandKit.succeeded,
    attemptedOpenAIBrief: stage.brief.attempted,
    succeededOpenAIBrief: stage.brief.succeeded,
    attemptedOpenAIVisualDirection: stage.visualDirection.attempted,
    succeededOpenAIVisualDirection: stage.visualDirection.succeeded,
    attemptedOpenAIBackground: stage.background.attempted,
    succeededOpenAIBackground: stage.background.succeeded,
    finalUsedOpenAIBackground: false,
    attemptedOpenAIVisionCritic: stage.visionCritic.attempted,
    succeededOpenAIVisionCritic: stage.visionCritic.succeeded,
    finalUsedOpenAIVisionCritic: false,
    usedDeterministicFallback: true,
    fallbackReason: options.reason,
    quotaError: !!options.quotaError,
    openAICallCount: options.openAICallCount ?? 0,
    revisionCount: 0,
    finalDecision,
    rejectionCritic: options.rejectionCritic || null,
    structuralBrandFidelityPassed: brandFidelity?.structuralBrandFidelityPassed,
    visionBrandFidelityPassed: brandFidelity?.visionBrandFidelityPassed,
    criticConflict: brandFidelity?.criticConflict,
    criticConflictReason: brandFidelity?.criticConflictReason ?? null,
    offerExpected: contentFidelity?.offerExpected,
    offerSource: contentFidelity?.offerSource ?? null,
    offerRendered: contentFidelity?.offerRendered,
    inventedOfferDetected: contentFidelity?.inventedOfferDetected,
    contentFidelityPassed: contentFidelity?.contentFidelityPassed,
    detectedOfferSnippet: contentFidelity?.detectedOfferSnippet ?? null,
    visibleRenderedText: contentFidelity?.visibleRenderedText,
    copyQualityPassed: fallbackCopyQuality.copyQualityPassed,
    copyQualityIssues: fallbackCopyQuality.copyQualityIssues.slice(),
    cleanedVisibleText: fallbackCopyQuality.cleanedVisibleText,
    copyQualityScore: fallbackCopyQuality.copyQualityScore,
    logoCropRealLogoPresent: brandFidelity?.fullImageVsCropConflict ? brandFidelity.logoCropCritic?.realLogoPresent : undefined,
    logoCropLogoMatchesExpected: brandFidelity?.fullImageVsCropConflict ? brandFidelity.logoCropCritic?.logoMatchesExpected : undefined,
    logoCropFallbackBadgeUsed: brandFidelity?.fullImageVsCropConflict ? brandFidelity.logoCropCritic?.fallbackBadgeUsed : undefined,
    logoCropLogoDistortedOrCropped: brandFidelity?.fullImageVsCropConflict ? brandFidelity.logoCropCritic?.logoDistortedOrCropped : undefined,
    fullImageVsCropConflict: brandFidelity?.fullImageVsCropConflict,
    fullImageVsCropConflictReason: brandFidelity?.fullImageVsCropConflictReason ?? null,
    realLogoExpected: lastMetrics?.realLogoExpected,
    realLogoRendered: lastMetrics?.realLogoRendered,
    logoNaturalWidth: lastMetrics?.logoNaturalWidth,
    logoNaturalHeight: lastMetrics?.logoNaturalHeight,
    logoRenderedWidth: lastMetrics?.logoRenderedWidth,
    logoRenderedHeight: lastMetrics?.logoRenderedHeight,
    logoVisibleArea: lastMetrics?.logoVisibleArea,
    logoRenderMode: lastMetrics?.logoRenderMode,
    fallbackBadgeRendered: lastMetrics?.fallbackBadgeRendered,
    logoMaskedOrCropped: lastMetrics?.logoMaskedOrCropped,
    logoDataUriUsed: lastMetrics?.logoDataUriUsed,
    logoFetchUsed: lastMetrics?.logoFetchUsed,
    // Premium Design Contract (fallback never passes)
    premiumDesignContractPassed: false,
    premiumDesignContractIssues: ["Deterministic fallback used"],
    safeToRetainHybrid: false,
    safeToAutoPublish: false,
    safeToChargePremiumCredits: false,
    needsHumanReview: false,
    layoutScore: undefined,
    ctaDominanceScore: undefined,
    hierarchyScore: undefined,
    templateRiskScore: undefined,
    copyScore: undefined,
    brandScore: undefined,
    selectedVariantIndex: undefined,
    variantCount: undefined,
  };

  return {
    buffer,
    brandKit: deterministicBrandKit,
    brief: deterministicBrief,
    visualDirection: {
      layoutPreset: "premium_local_service",
      density: "balanced",
      heroTreatment: "solid_brand_block",
      backgroundDirection: "abstract_brand_gradient",
      backgroundPrompt: "",
      ctaTreatment: "solid_button",
      serviceLayout: "grid",
      colourUsageNote: "",
    },
    critic: fallbackCritic,
    revisionCount: 0,
    usedFallback: true,
    metadata,
    attempts,
  };
}

function buildResult(
  _input: HybridPipelineInput,
  brandKit: HybridBrandKit,
  brief: AICreativeBrief,
  visualDirection: VisualDirection,
  buffer: Buffer,
  critic: VisionCriticResult,
  revisionCount: number,
  usedFallback: boolean,
  stage: {
    brandKit: { attempted: boolean; succeeded: boolean };
    brief: { attempted: boolean; succeeded: boolean };
    visualDirection: { attempted: boolean; succeeded: boolean };
    background: { attempted: boolean; succeeded: boolean };
    visionCritic: { attempted: boolean; succeeded: boolean };
  },
  openAICallCount: number,
  attempts: HybridPipelineAttempt[],
  renderMetrics?: import("./pipeline-types").HybridRenderMetrics,
  brandFidelity?: BrandFidelityAdjudication,
  contentFidelity?: ContentFidelityResult,
  copyQuality?: CopyQualityResult,
  rawCritic?: VisionCriticResult,
  adjudication?: AdjudicatedCritic,
  contract?: PremiumDesignContractResult,
  layoutScores?: LayoutScoreResult,
  selectedVariantIndex?: number,
  variantCount?: number,
  passedFinalDecision?: HybridFinalDecision
): HybridPipelineResult {
  const finalDecision = passedFinalDecision ?? "hybrid_review_required";

  let fallbackReason: string | null = null;
  let finalDecisionSource = "premium_design_contract";
  if (finalDecision === "hybrid_review_required") {
    if (brandFidelity?.criticConflict && brandFidelity.criticConflictReason) {
      fallbackReason = brandFidelity.criticConflictReason;
      finalDecisionSource = "brand_fidelity_critic_conflict";
    } else if (contract && !contract.passed) {
      fallbackReason = `Design quality review required: ${contract.issues.join("; ")}`;
      finalDecisionSource = "premium_design_contract";
    } else {
      fallbackReason = critic.criticalIssues.length
        ? `Design quality review required: ${critic.criticalIssues.join("; ")}`
        : "Design quality review required";
      finalDecisionSource = "adjudicated_effective_critic_non_logo_review";
    }
  } else if (finalDecision === "content_review_required") {
    if (contentFidelity?.inventedOfferDetected) {
      fallbackReason = `Invented offer detected: ${contentFidelity.detectedOfferSnippet || "unsupported promotional language"}`;
      finalDecisionSource = "content_fidelity_gate";
    } else if (copyQuality && !copyQuality.copyQualityPassed) {
      fallbackReason = `Copy quality review required: ${copyQuality.copyQualityIssues.join("; ")}`;
      finalDecisionSource = "copy_quality_gate";
    } else {
      fallbackReason = "Content review required";
      finalDecisionSource = "content_fidelity_gate";
    }
  }

  const metadata: HybridPipelineMetadata = {
    provider: "premium-v2-hybrid",
    layoutPreset: visualDirection.layoutPreset,
    width: 1080,
    height: 1350,
    attemptedOpenAIBrandKit: stage.brandKit.attempted,
    succeededOpenAIBrandKit: stage.brandKit.succeeded,
    attemptedOpenAIBrief: stage.brief.attempted,
    succeededOpenAIBrief: stage.brief.succeeded,
    attemptedOpenAIVisualDirection: stage.visualDirection.attempted,
    succeededOpenAIVisualDirection: stage.visualDirection.succeeded,
    attemptedOpenAIBackground: true,
    succeededOpenAIBackground: stage.background.succeeded,
    finalUsedOpenAIBackground: stage.background.succeeded,
    attemptedOpenAIVisionCritic: true,
    succeededOpenAIVisionCritic: true,
    finalUsedOpenAIVisionCritic: true,
    usedDeterministicFallback: false,
    fallbackReason,
    quotaError: false,
    openAICallCount,
    revisionCount,
    finalDecision,
    finalDecisionSource,
    rejectionCritic: null,
    rawFullImageCriticPassed: rawCritic?.passed,
    effectiveCriticPassed: critic.passed,
    effectiveCriticalIssues: critic.criticalIssues.slice(),
    overruledFullImageLogoIssues: adjudication?.overruledIssues.slice(),
    adjudicationNotes: adjudication?.notes.slice(),
    structuralBrandFidelityPassed: brandFidelity?.structuralBrandFidelityPassed,
    visionBrandFidelityPassed: brandFidelity?.visionBrandFidelityPassed,
    criticConflict: brandFidelity?.criticConflict,
    criticConflictReason: brandFidelity?.criticConflictReason ?? null,
    offerExpected: contentFidelity?.offerExpected,
    offerSource: contentFidelity?.offerSource ?? null,
    offerRendered: contentFidelity?.offerRendered,
    inventedOfferDetected: contentFidelity?.inventedOfferDetected,
    contentFidelityPassed: contentFidelity?.contentFidelityPassed,
    detectedOfferSnippet: contentFidelity?.detectedOfferSnippet ?? null,
    visibleRenderedText: contentFidelity?.visibleRenderedText,
    copyQualityPassed: copyQuality?.copyQualityPassed,
    copyQualityIssues: copyQuality ? copyQuality.copyQualityIssues.slice() : undefined,
    cleanedVisibleText: copyQuality?.cleanedVisibleText,
    copyQualityScore: copyQuality?.copyQualityScore,
    logoCropRealLogoPresent: brandFidelity?.fullImageVsCropConflict ? brandFidelity.logoCropCritic?.realLogoPresent : undefined,
    logoCropLogoMatchesExpected: brandFidelity?.fullImageVsCropConflict ? brandFidelity.logoCropCritic?.logoMatchesExpected : undefined,
    logoCropFallbackBadgeUsed: brandFidelity?.fullImageVsCropConflict ? brandFidelity.logoCropCritic?.fallbackBadgeUsed : undefined,
    logoCropLogoDistortedOrCropped: brandFidelity?.fullImageVsCropConflict ? brandFidelity.logoCropCritic?.logoDistortedOrCropped : undefined,
    fullImageVsCropConflict: brandFidelity?.fullImageVsCropConflict,
    fullImageVsCropConflictReason: brandFidelity?.fullImageVsCropConflictReason ?? null,
    // Premium Design Contract
    premiumDesignContractPassed: contract?.passed ?? false,
    premiumDesignContractIssues: contract?.issues.slice() ?? [],
    safeToRetainHybrid: contract?.safeToRetainHybrid ?? false,
    safeToAutoPublish: contract?.safeToAutoPublish ?? false,
    safeToChargePremiumCredits: contract?.safeToChargePremiumCredits ?? false,
    needsHumanReview: contract?.needsHumanReview ?? false,
    // Deterministic layout scoring
    layoutScore: layoutScores?.layoutScore,
    ctaDominanceScore: layoutScores?.ctaDominanceScore,
    hierarchyScore: layoutScores?.hierarchyScore,
    templateRiskScore: layoutScores?.templateRiskScore,
    copyScore: layoutScores?.copyScore,
    brandScore: layoutScores?.brandScore,
    // Variant selection
    selectedVariantIndex,
    variantCount,

    // Brand-asset render diagnostics
    realLogoExpected: renderMetrics?.realLogoExpected,
    realLogoRendered: renderMetrics?.realLogoRendered,
    logoNaturalWidth: renderMetrics?.logoNaturalWidth,
    logoNaturalHeight: renderMetrics?.logoNaturalHeight,
    logoRenderedWidth: renderMetrics?.logoRenderedWidth,
    logoRenderedHeight: renderMetrics?.logoRenderedHeight,
    logoVisibleArea: renderMetrics?.logoVisibleArea,
    logoRenderMode: renderMetrics?.logoRenderMode,
    fallbackBadgeRendered: renderMetrics?.fallbackBadgeRendered,
    logoMaskedOrCropped: renderMetrics?.logoMaskedOrCropped,
    logoDataUriUsed: renderMetrics?.logoDataUriUsed,
    logoFetchUsed: renderMetrics?.logoFetchUsed,
  };

  return {
    buffer,
    brandKit,
    brief,
    visualDirection,
    critic,
    revisionCount,
    usedFallback,
    metadata,
    attempts,
  };
}
