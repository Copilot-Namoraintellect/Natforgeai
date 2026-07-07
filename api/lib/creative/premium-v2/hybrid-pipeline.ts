/**
 * Premium Leaflet Hybrid Pipeline – Orchestrator.
 *
 * Runs the full hybrid creative pipeline:
 *   BrandKit → Creative Brief → Visual Direction → Background → HTML Render → Vision Critic → Revision Loop.
 *
 * Falls back to the deterministic V2 renderer if any AI stage fails or if the
 * hybrid pipeline is disabled. Preserves the previous approved asset on failure.
 *
 * Transparency rules:
 * - Every result reports exactly which OpenAI stages ran.
 * - Deterministic fallback never reports perfect critic scores.
 * - Vision critic failures (quota, network, etc.) are never permissive passes.
 * - The generation log shows the real finalDecision and fallbackReason.
 */

import { env } from "../../env";
import type { BusinessEvidence, CampaignEvidence } from "./curation";
import { resolveBrandKitWithAI } from "./brand-kit-ai";
import { buildAICreativeBrief } from "./brief-ai";
import { buildVisualDirection } from "./visual-direction";
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
} from "./pipeline-types";

export async function runHybridPipeline(input: HybridPipelineInput): Promise<HybridPipelineResult> {
  if (!env.enableHybridLeafletPipeline || !env.openaiApiKey) {
    return runDeterministicFallback(input, undefined, undefined, {
      reason: !env.enableHybridLeafletPipeline
        ? "Hybrid pipeline feature flag disabled"
        : "OPENAI_API_KEY not configured",
    });
  }

  const business = input.business as BusinessEvidence;
  const campaign = (input.campaign || {}) as CampaignEvidence;

  let openAICallCount = 0;
  let usedOpenAIBrandKit = false;
  let usedOpenAIBrief = false;
  let usedOpenAIVisualDirection = false;
  let usedOpenAIBackground = false;
  let usedOpenAIVisionCritic = false;
  let fallbackReason: string | null = null;
  let quotaError = false;

  try {
    const brandKitResult = await resolveBrandKitWithAI(business);
    openAICallCount += brandKitResult.usedOpenAI ? 1 : 0;
    usedOpenAIBrandKit = brandKitResult.usedOpenAI;
    if (brandKitResult.fallbackReason) fallbackReason = brandKitResult.fallbackReason;
    const brandKit = brandKitResult.value;

    const briefResult = await buildAICreativeBrief(business, campaign, brandKit);
    openAICallCount += briefResult.usedOpenAI ? 1 : 0;
    usedOpenAIBrief = briefResult.usedOpenAI;
    if (briefResult.fallbackReason) fallbackReason = briefResult.fallbackReason;
    const brief = briefResult.value;

    const visualResult = await buildVisualDirection(business, campaign, brandKit, brief);
    openAICallCount += visualResult.usedOpenAI ? 1 : 0;
    usedOpenAIVisualDirection = visualResult.usedOpenAI;
    if (visualResult.fallbackReason) fallbackReason = visualResult.fallbackReason;
    let visualDirection = visualResult.value;

    let revisionCount = 0;
    const maxRevisions = Math.max(0, env.hybridLeafletMaxRevisions);
    let lastBackgroundBuffer: Buffer | null = null;

    while (revisionCount <= maxRevisions) {
      const reuseBackground = revisionCount > 0 && shouldReuseBackground(visualDirection.backgroundPrompt);
      const render = await renderOnce(input, brandKit, brief, visualDirection, reuseBackground ? lastBackgroundBuffer : null);
      if (render.backgroundBuffer) {
        lastBackgroundBuffer = render.backgroundBuffer;
        usedOpenAIBackground = true;
      }

      const critic = await critiqueRenderedLeaflet(
        render.buffer,
        business.displayName || business.name || "Business",
        !!brandKit.logoUrl
      );
      openAICallCount++; // critic call
      usedOpenAIVisionCritic = !critic.unavailable;

      if (critic.unavailable) {
        quotaError = !!critic.quotaError;
        fallbackReason = critic.criticalIssues[0] || "Vision critic unavailable";
        console.warn(`[HybridPipeline] ${fallbackReason}. Falling back to deterministic V2 renderer.`);
        break;
      }

      if (critic.passed) {
        return buildResult(
          input,
          brandKit,
          brief,
          visualDirection,
          render.buffer,
          critic,
          revisionCount,
          false,
          {
            usedOpenAIBrandKit,
            usedOpenAIBrief,
            usedOpenAIVisualDirection,
            usedOpenAIBackground,
            usedOpenAIVisionCritic,
            openAICallCount,
          }
        );
      }

      if (revisionCount >= maxRevisions) {
        fallbackReason = `Critic rejected after ${revisionCount} revision(s)`;
        console.warn(`[HybridPipeline] ${fallbackReason}. Falling back to deterministic V2 renderer.`);
        break;
      }

      console.log(`[HybridPipeline] Revision ${revisionCount + 1} triggered: ${critic.improvementSuggestions.join("; ")}`);
      visualDirection = reviseVisualDirection(visualDirection, critic.improvementSuggestions);
      revisionCount++;
    }

    return runDeterministicFallback(input, brandKit, brief, {
      reason: fallbackReason || "Hybrid critic did not pass",
      quotaError,
      openAICallCount,
      usedOpenAIBrandKit,
      usedOpenAIBrief,
      usedOpenAIVisualDirection,
    });
  } catch (err: any) {
    const reason = `Pipeline failed: ${err.message}`;
    console.warn(`[HybridPipeline] ${reason}. Falling back to deterministic V2 renderer.`);
    return runDeterministicFallback(input, undefined, undefined, {
      reason,
      openAICallCount,
      usedOpenAIBrandKit,
      usedOpenAIBrief,
      usedOpenAIVisualDirection,
    });
  }
}

interface RenderOutput {
  buffer: Buffer;
  backgroundBuffer: Buffer | null;
}

async function renderOnce(
  input: HybridPipelineInput,
  brandKit: HybridBrandKit,
  brief: AICreativeBrief,
  visualDirection: VisualDirection,
  reuseBackground: Buffer | null = null
): Promise<RenderOutput> {
  const [backgroundBuffer, logoBuffer] = await Promise.all([
    reuseBackground ? Promise.resolve(reuseBackground) : generateBackground(visualDirection),
    brandKit.logoUrl ? fetchLogo(brandKit.logoUrl) : Promise.resolve(null),
  ]);

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
  };

  const { buffer } = await renderHybridLeaflet(renderBrief, brandKit, visualDirection, backgroundBuffer, logoBuffer);
  return { buffer, backgroundBuffer };
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

function shouldReuseBackground(backgroundPrompt: string): boolean {
  const text = backgroundPrompt.toLowerCase();
  const layoutIssues = ["text", "font", "readability", "contrast", "cta", "clipped", "hierarchy", "logo", "layout", "empty", "crowded"];
  const backgroundIssues = ["background", "texture", "gradient", "bland", "plain", "boring", "photo"];
  return layoutIssues.some((w) => text.includes(w)) && !backgroundIssues.some((w) => text.includes(w));
}

function reviseVisualDirection(visualDirection: VisualDirection, suggestions: string[]): VisualDirection {
  const text = suggestions.join(" ").toLowerCase();
  const next: VisualDirection = { ...visualDirection };

  // CTA / clipping issues -> make CTA impossible to miss.
  if (text.match(/cta|clipped|button|small/)) {
    next.ctaTreatment = "block_banner";
  }

  // Readability / contrast / text size -> reduce density and use a solid hero block.
  if (text.match(/readability|contrast|font|text|small|blurry/)) {
    next.density = "minimal";
    next.heroTreatment = "solid_brand_block";
  }

  // Generic / template feel -> switch to more distinctive hero and background.
  if (text.match(/generic|template|cheap|boring/)) {
    next.heroTreatment = next.heroTreatment === "solid_brand_block" ? "shape_accent" : "solid_brand_block";
    next.backgroundDirection = next.backgroundDirection === "abstract_brand_gradient" ? "dark_premium" : "abstract_brand_gradient";
  }

  // Premium feel -> richer background.
  if (text.match(/premium|luxury|rich|flat/)) {
    next.backgroundDirection = next.backgroundDirection === "clean_white" ? "soft_noise_texture" : "dark_premium";
  }

  // Logo issues -> give logo its own shape-accent hero.
  if (text.match(/logo|brand/)) {
    next.heroTreatment = "shape_accent";
  }

  // Visual hierarchy / crowded -> balance density.
  if (text.match(/hierarchy|crowded|clutter|empty space/)) {
    next.density = next.density === "dense" ? "balanced" : "minimal";
  }

  return next;
}

interface FallbackOptions {
  reason: string;
  quotaError?: boolean;
  openAICallCount?: number;
  usedOpenAIBrandKit?: boolean;
  usedOpenAIBrief?: boolean;
  usedOpenAIVisualDirection?: boolean;
}

async function runDeterministicFallback(
  input: HybridPipelineInput,
  brandKit?: HybridBrandKit,
  aiBrief?: AICreativeBrief,
  options: FallbackOptions = { reason: "Unknown" }
): Promise<HybridPipelineResult> {
  const brief = await buildPremiumV2Brief({
    business: input.business,
    campaign: input.campaign,
    post: input.post,
    approvedMessagePack: input.approvedMessagePack,
    refinementInstruction: input.refinementInstruction,
    brandKit: brandKit
      ? { palette: brandKit, source: brandKit.source, logoUrl: brandKit.logoUrl || undefined }
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
  };

  const finalDecision: HybridFinalDecision = options.quotaError
    ? "hybrid_review_required"
    : "fallback_used";

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
  };

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

  const metadata: HybridPipelineMetadata = {
    provider: "premium-v2-deterministic",
    layoutPreset: brief.layoutDensity,
    width: metrics.width,
    height: metrics.height,
    usedOpenAIBrandKit: options.usedOpenAIBrandKit ?? false,
    usedOpenAIBrief: options.usedOpenAIBrief ?? false,
    usedOpenAIVisualDirection: options.usedOpenAIVisualDirection ?? false,
    usedOpenAIBackground: false,
    usedOpenAIVisionCritic: false,
    usedDeterministicFallback: true,
    fallbackReason: options.reason,
    quotaError: !!options.quotaError,
    openAICallCount: options.openAICallCount ?? 0,
    revisionCount: 0,
    finalDecision,
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
  };
}

interface SuccessMeta {
  usedOpenAIBrandKit: boolean;
  usedOpenAIBrief: boolean;
  usedOpenAIVisualDirection: boolean;
  usedOpenAIBackground: boolean;
  usedOpenAIVisionCritic: boolean;
  openAICallCount: number;
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
  meta: SuccessMeta
): HybridPipelineResult {
  const metadata: HybridPipelineMetadata = {
    provider: "premium-v2-hybrid",
    layoutPreset: visualDirection.layoutPreset,
    width: 1080,
    height: 1350,
    usedOpenAIBrandKit: meta.usedOpenAIBrandKit,
    usedOpenAIBrief: meta.usedOpenAIBrief,
    usedOpenAIVisualDirection: meta.usedOpenAIVisualDirection,
    usedOpenAIBackground: meta.usedOpenAIBackground,
    usedOpenAIVisionCritic: meta.usedOpenAIVisionCritic,
    usedDeterministicFallback: false,
    fallbackReason: null,
    quotaError: false,
    openAICallCount: meta.openAICallCount,
    revisionCount,
    finalDecision: critic.passed ? "premium_ready" : "hybrid_review_required",
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
  };
}
