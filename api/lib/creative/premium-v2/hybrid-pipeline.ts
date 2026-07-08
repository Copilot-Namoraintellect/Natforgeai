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
import { applyBrandAssetGate } from "../brand-asset-resolver";
import { planCreativeWithAI } from "./plan-ai";
import { generateBackground } from "./background-generator";
import { renderHybridLeaflet, type HybridRenderBrief } from "./html-renderer";
import { critiqueRenderedLeaflet } from "./vision-critic";
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
  let fallbackReason: string | null = null;
  let quotaError = false;

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
    if (planResult.fallbackReason) fallbackReason = planResult.fallbackReason;

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
    let visualDirection = initialVisualDirection;

    let revisionCount = 0;
    const maxRevisions = Math.max(0, env.hybridLeafletMaxRevisions);
    let lastBackgroundBuffer: Buffer | null = null;
    const attempts: HybridPipelineAttempt[] = [];
    let rejectionCritic: VisionCriticResult | null = null;
    let critic: VisionCriticResult | undefined;
    let lastRenderMetrics: import("./pipeline-types").HybridRenderMetrics | undefined;

    while (revisionCount <= maxRevisions) {
      const reuseBackground = revisionCount > 0 && shouldReuseBackground(critic?.improvementSuggestions || []);
      if (!reuseBackground) openAICallCount++; // background generation call
      const render = await renderOnce(input, brandKit, brief, visualDirection, reuseBackground ? lastBackgroundBuffer : null);
      lastRenderMetrics = render.metrics;
      stage.background.attempted = true;
      if (render.backgroundBuffer) {
        lastBackgroundBuffer = render.backgroundBuffer;
        stage.background.succeeded = true;
      }

      critic = await critiqueRenderedLeaflet(
        render.buffer,
        business.displayName || business.name || "Business",
        brandAsset
      );
      stage.visionCritic.attempted = true;
      stage.visionCritic.succeeded = !critic.unavailable;
      openAICallCount++; // critic call

      if (sampleMode) {
        attempts.push({ buffer: render.buffer, critic, visualDirection, metrics: lastRenderMetrics });
      }

      if (critic.unavailable) {
        quotaError = !!critic.quotaError;
        fallbackReason = critic.criticalIssues[0] || "Vision critic unavailable";
        rejectionCritic = critic;
        console.warn(`[HybridPipeline] ${fallbackReason}. Falling back to deterministic V2 renderer.`);
        break;
      }

      const realLogoExpected = !!brandAsset && brandAsset.realLogoExpected;
      const logoRenderedCorrectly =
        !realLogoExpected ||
        (critic.realLogoPresent && !critic.fallbackBadgeUsed && critic.logoMatchesBrand && !critic.logoDistortedOrCropped);

      if (critic.passed && logoRenderedCorrectly) {
        return buildResult(
          input,
          brandKit,
          brief,
          visualDirection,
          render.buffer,
          critic,
          revisionCount,
          false,
          stage,
          openAICallCount,
          attempts,
          lastRenderMetrics
        );
      }

      if (realLogoExpected && !logoRenderedCorrectly) {
        rejectionCritic = critic;
        fallbackReason = "Hybrid attempt did not render the real brand logo correctly";
        console.warn(`[HybridPipeline] ${fallbackReason}. Falling back to deterministic V2 renderer.`);
        break;
      }

      rejectionCritic = critic;

      if (revisionCount >= maxRevisions) {
        fallbackReason = `Critic rejected after ${revisionCount} revision(s)`;
        console.warn(`[HybridPipeline] ${fallbackReason}. Falling back to deterministic V2 renderer.`);
        break;
      }

      console.log(`[HybridPipeline] Revision ${revisionCount + 1} triggered: ${critic.improvementSuggestions.join("; ")}`);
      visualDirection = reviseVisualDirection(visualDirection, critic.improvementSuggestions);
      revisionCount++;
    }

    return runDeterministicFallback(input, brandKit, brief, attempts, {
      reason: fallbackReason || "Hybrid critic did not pass",
      quotaError,
      openAICallCount,
      stage,
      rejectionCritic,
      lastRenderMetrics,
    });
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

interface RenderOutput {
  buffer: Buffer;
  backgroundBuffer: Buffer | null;
  metrics?: import("./pipeline-types").HybridRenderMetrics;
}

async function renderOnce(
  input: HybridPipelineInput,
  brandKit: HybridBrandKit,
  brief: AICreativeBrief,
  visualDirection: VisualDirection,
  reuseBackground: Buffer | null = null
): Promise<RenderOutput> {
  const brandAsset = brandKit.brandAsset;
  const [backgroundBuffer, logoBuffer] = await Promise.all([
    reuseBackground ? Promise.resolve(reuseBackground) : generateBackground(visualDirection),
    brandAsset?.logoBuffer ? Promise.resolve(brandAsset.logoBuffer) : brandKit.logoUrl ? fetchLogo(brandKit.logoUrl) : Promise.resolve(null),
  ]);

  console.log(`[HybridPipeline renderOnce] brandAsset exists: ${!!brandAsset}, logoSourceType: ${brandAsset?.logoSourceType ?? "n/a"}, realLogoExpected: ${brandAsset?.realLogoExpected ?? "n/a"}, logoResolved: ${brandAsset?.logoResolved ?? "n/a"}, logoBuffer length: ${logoBuffer?.length ?? 0}, brandKit.logoUrl: ${brandKit.logoUrl ?? "n/a"}`);

  const renderBrief: HybridRenderBrief = {
    businessName: input.business.displayName || input.business.name || "Business",
    headline: brief.headline,
    subheadline: brief.subheadline,
    primaryServices: brief.primaryServices.map((s) => ({ name: s.name, description: s.description })),
    secondaryServices: brief.secondaryServices.map((s) => ({ name: s.name })),
    benefits: brief.benefits,
    cta: brief.cta,
    offerLine: brief.offerLine,
    contact: {
      phone: input.business.phone || undefined,
      website: input.business.website || undefined,
      location: input.business.location || undefined,
    },
    brandAsset: brandKit.brandAsset,
  };

  const { buffer, metrics } = await renderHybridLeaflet(renderBrief, brandKit, visualDirection, backgroundBuffer, logoBuffer, brandKit.brandAsset);
  console.log(`[HybridPipeline renderOnce] render metrics: ${JSON.stringify(metrics)}`);
  return { buffer, backgroundBuffer, metrics };
}

async function fetchLogo(logoUrl: string): Promise<Buffer | null> {
  try {
    const res = await fetch(logoUrl);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

function shouldReuseBackground(suggestions: string[]): boolean {
  const text = suggestions.join(" ").toLowerCase();
  const layoutIssues = ["text", "font", "readability", "contrast", "cta", "clipped", "hierarchy", "logo", "layout", "empty", "crowded", "typography"];
  const backgroundIssues = ["background", "texture", "gradient", "bland", "plain", "boring", "photo"];
  return layoutIssues.some((w) => text.includes(w)) && !backgroundIssues.some((w) => text.includes(w));
}

function reviseVisualDirection(visualDirection: VisualDirection, suggestions: string[]): VisualDirection {
  const text = suggestions.join(" ").toLowerCase();
  const next: VisualDirection = { ...visualDirection };

  if (text.match(/cta|clipped|button|small/)) {
    next.ctaTreatment = "block_banner";
  }

  if (text.match(/readability|contrast|font|text|small|blurry|typography/)) {
    next.density = "minimal";
    next.heroTreatment = "solid_brand_block";
  }

  if (text.match(/generic|template|cheap|boring/)) {
    next.heroTreatment = next.heroTreatment === "solid_brand_block" ? "shape_accent" : "solid_brand_block";
    next.backgroundDirection = next.backgroundDirection === "abstract_brand_gradient" ? "dark_premium" : "abstract_brand_gradient";
  }

  if (text.match(/premium|luxury|rich|flat/)) {
    next.backgroundDirection = next.backgroundDirection === "clean_white" ? "soft_noise_texture" : "dark_premium";
  }

  if (text.match(/logo|brand/)) {
    next.heroTreatment = "shape_accent";
  }

  if (text.match(/hierarchy|crowded|clutter|empty space/)) {
    next.density = next.density === "dense" ? "balanced" : "minimal";
  }

  return next;
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

  const finalDecision: HybridFinalDecision = options.finalDecisionOverride || (options.quotaError ? "hybrid_review_required" : "fallback_used");

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

  const stage = options.stage || {
    brandKit: { attempted: false, succeeded: false },
    brief: { attempted: false, succeeded: false },
    visualDirection: { attempted: false, succeeded: false },
    background: { attempted: false, succeeded: false },
    visionCritic: { attempted: false, succeeded: false },
  };

  const lastMetrics = options.lastRenderMetrics;
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
  renderMetrics?: import("./pipeline-types").HybridRenderMetrics
): HybridPipelineResult {
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
    fallbackReason: null,
    quotaError: false,
    openAICallCount,
    revisionCount,
    finalDecision: critic.passed ? "premium_ready" : "hybrid_review_required",
    rejectionCritic: null,
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
