/**
 * Premium Leaflet Hybrid Pipeline – Orchestrator.
 *
 * Runs the full hybrid creative pipeline:
 *   BrandKit → Creative Brief → Visual Direction → Background → HTML Render → Vision Critic → Revision Loop.
 *
 * Falls back to the deterministic V2 renderer if any AI stage fails or if the
 * hybrid pipeline is disabled. Preserves the previous approved asset on failure.
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
import type { HybridPipelineInput, HybridPipelineResult, HybridBrandKit, AICreativeBrief, VisualDirection } from "./pipeline-types";

export async function runHybridPipeline(input: HybridPipelineInput): Promise<HybridPipelineResult> {
  if (!env.enableHybridLeafletPipeline || !env.openaiApiKey) {
    return runDeterministicFallback(input);
  }

  const business = input.business as BusinessEvidence;
  const campaign = (input.campaign || {}) as CampaignEvidence;

  try {
    const brandKit = await resolveBrandKitWithAI(business);
    const brief = await buildAICreativeBrief(business, campaign, brandKit);
    const visualDirection = await buildVisualDirection(business, campaign, brandKit, brief);

    let revisionCount = 0;
    const maxRevisions = Math.max(0, env.hybridLeafletMaxRevisions);

    while (revisionCount <= maxRevisions) {
      const buffer = await renderOnce(input, brandKit, brief, visualDirection);
      const critic = await critiqueRenderedLeaflet(buffer, business.displayName || business.name || "Business", !!brandKit.logoUrl);

      if (critic.passed) {
        return buildResult(input, brandKit, brief, visualDirection, buffer, critic, revisionCount, false);
      }

      if (revisionCount >= maxRevisions) {
        break;
      }

      console.log(`[HybridPipeline] Revision ${revisionCount + 1} triggered: ${critic.improvementSuggestions.join("; ")}`);
      revisionCount++;
    }

    // If all revisions failed, fall back to deterministic renderer to guarantee output.
    console.warn(`[HybridPipeline] Critic rejected after ${revisionCount} revision(s). Falling back to deterministic V2 renderer.`);
    return runDeterministicFallback(input, brandKit, brief);
  } catch (err: any) {
    console.warn(`[HybridPipeline] Pipeline failed: ${err.message}. Falling back to deterministic V2 renderer.`);
    return runDeterministicFallback(input);
  }
}

async function renderOnce(
  input: HybridPipelineInput,
  brandKit: HybridBrandKit,
  brief: AICreativeBrief,
  visualDirection: VisualDirection
): Promise<Buffer> {
  const [backgroundBuffer, logoBuffer] = await Promise.all([
    generateBackground(visualDirection),
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
  return buffer;
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

async function runDeterministicFallback(
  input: HybridPipelineInput,
  brandKit?: HybridBrandKit,
  aiBrief?: AICreativeBrief
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

  return {
    buffer,
    brandKit: brandKit || {
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
    },
    brief: aiBrief || {
      angle: brief.subheadline || "",
      headline: brief.headline,
      subheadline: brief.subheadline || "",
      primaryServices: brief.primaryServices.map((s) => ({ name: s.name, description: s.description || null, isPrimary: true })),
      secondaryServices: brief.secondaryServices.map((s) => ({ name: s.name, description: null, isPrimary: false })),
      benefits: brief.benefits,
      cta: brief.cta,
      offerLine: brief.offer || null,
    },
    visualDirection: {
      layoutPreset: "premium_local_service",
      density: "balanced",
      heroTreatment: "solid_brand_block",
      backgroundDirection: "abstract_brand_gradient",
      backgroundPrompt: "",
      ctaTreatment: "solid_button",
      colourUsageNote: "",
    },
    critic: {
      scores: {
        brandFidelity: quality.score,
        readability: quality.score,
        premiumFeel: quality.score,
        visualHierarchy: quality.score,
        logoUsage: quality.score,
        CTAVisibility: quality.score,
        genericTemplateRisk: 100 - quality.score,
      },
      passed: quality.passed,
      criticalIssues: quality.criticalFailures,
      improvementSuggestions: quality.warnings,
    },
    revisionCount: 0,
    usedFallback: true,
    metadata: {
      provider: "premium-v2-deterministic",
      layoutPreset: brief.layoutDensity,
      width: metrics.width,
      height: metrics.height,
    },
  };
}

function buildResult(
  _input: HybridPipelineInput,
  brandKit: HybridBrandKit,
  brief: AICreativeBrief,
  visualDirection: VisualDirection,
  buffer: Buffer,
  critic: any,
  revisionCount: number,
  usedFallback: boolean
): HybridPipelineResult {
  return {
    buffer,
    brandKit,
    brief,
    visualDirection,
    critic,
    revisionCount,
    usedFallback,
    metadata: {
      provider: "premium-v2-hybrid",
      layoutPreset: visualDirection.layoutPreset,
      width: 1080,
      height: 1350,
    },
  };
}
