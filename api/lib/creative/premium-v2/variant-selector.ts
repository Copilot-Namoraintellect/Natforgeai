/**
 * Premium Leaflet Hybrid Pipeline – Multi-Variant Selector.
 *
 * Generates up to three layout variants for a single creative plan, scores each
 * with deterministic layout metrics, copy/content fidelity and the OpenAI vision
 * critic, then selects the best variant. Only the best variant is returned; if
 * none pass the Premium Design Contract the safest hybrid variant is retained
 * for human review.
 */

import sharp from "sharp";
import type { BusinessEvidence, CampaignEvidence } from "./curation";
import type {
  AICreativeBrief,
  HybridBrandKit,
  HybridRenderMetrics,
  HybridPipelineAttempt,
  PremiumCopyPack,
  VisualDirection,
} from "./pipeline-types";
import type { BrandAssetResolution } from "../brand-asset-resolver";
import { renderHybridLeaflet } from "./html-renderer";
import { generateBackground } from "./background-generator";
import { critiqueRenderedLeaflet, critiqueLogoCrop, type LogoCropCriticResult } from "./vision-critic";
import { evaluateContentFidelity, type ContentFidelityResult } from "./content-fidelity";
import { evaluateCopyQuality, type CopyQualityResult } from "./copy-quality";
import { buildPremiumCopyPack } from "./copy-pack";
import { scoreLayout, type LayoutScoreResult } from "./layout-scoring";
import { evaluatePremiumDesignContract, type PremiumDesignContractResult } from "./premium-design-contract";

export interface VariantResult {
  index: number;
  label: string;
  visualDirection: VisualDirection;
  buffer: Buffer;
  backgroundBuffer: Buffer | null;
  html: string;
  metrics: HybridRenderMetrics;
  contentFidelity: ContentFidelityResult;
  copyQuality: CopyQualityResult;
  copyPack: PremiumCopyPack;
  rawCritic: import("./pipeline-types").VisionCriticResult;
  logoCropCritic?: LogoCropCriticResult;
  layoutScores: LayoutScoreResult;
  contract: PremiumDesignContractResult;
}

export interface VariantSelection {
  selectedIndex: number;
  variants: VariantResult[];
  best: VariantResult;
}

async function fetchLogoBuffer(logoUrl: string): Promise<Buffer | null> {
  try {
    const res = await fetch(logoUrl);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

function isLogoRelatedIssue(text: string): boolean {
  return /\b(brand fidelity|logo|fallback badge|real logo|real brand logo)\b/i.test(text);
}

function computeEffectiveCriticPassed(
  critic: import("./pipeline-types").VisionCriticResult,
  logoCropCritic?: LogoCropCriticResult
): boolean {
  if (critic.passed) return true;
  if (!logoCropCritic) return false;

  const fullImageLogoPassed =
    critic.realLogoPresent && !critic.fallbackBadgeUsed && !critic.logoDistortedOrCropped && critic.logoMatchesBrand;
  const cropLogoPassed =
    logoCropCritic.realLogoPresent &&
    !logoCropCritic.fallbackBadgeUsed &&
    !logoCropCritic.logoDistortedOrCropped &&
    logoCropCritic.logoMatchesExpected;

  if (!fullImageLogoPassed && cropLogoPassed) {
    const keptIssues = critic.criticalIssues.filter((i) => !isLogoRelatedIssue(i));
    return keptIssues.length === 0;
  }
  return false;
}

function buildBrandFidelity(
  metrics: HybridRenderMetrics,
  critic: import("./pipeline-types").VisionCriticResult,
  brandAsset: BrandAssetResolution | undefined,
  logoCropCritic?: LogoCropCriticResult
) {
  const realLogoExpected = !!brandAsset && brandAsset.realLogoExpected;
  const structuralBrandFidelityPassed =
    !realLogoExpected ||
    (metrics.realLogoRendered === true && metrics.fallbackBadgeRendered === false && metrics.logoMaskedOrCropped === false);
  const fullImageLogoPassed =
    !realLogoExpected ||
    (critic.realLogoPresent && !critic.fallbackBadgeUsed && !critic.logoDistortedOrCropped && critic.logoMatchesBrand);
  const cropLogoPassed = logoCropCritic
    ? logoCropCritic.realLogoPresent && !logoCropCritic.fallbackBadgeUsed && !logoCropCritic.logoDistortedOrCropped && logoCropCritic.logoMatchesExpected
    : undefined;
  const visionBrandFidelityPassed = cropLogoPassed ?? fullImageLogoPassed;
  return { structuralBrandFidelityPassed, visionBrandFidelityPassed };
}

function makeVariantVisualDirection(base: VisualDirection, label: string): VisualDirection {
  const common: Partial<VisualDirection> = { ctaTreatment: "block_banner", serviceLayout: "featured" };
  switch (label) {
    case "editorial":
      return {
        ...base,
        ...common,
        layoutPreset: "premium_editorial_featured",
        heroTreatment: "shape_accent",
        density: "balanced",
      };
    case "cta-banner":
      return {
        ...base,
        ...common,
        layoutPreset: "premium_local_service_featured",
        heroTreatment: "solid_brand_block",
        density: "minimal",
      };
    case "spotlight":
      return {
        ...base,
        ...common,
        layoutPreset: "premium_product_spotlight",
        heroTreatment: "shape_accent",
        serviceLayout: "split",
        density: "balanced",
      };
    default:
      return base;
  }
}

export async function selectBestHybridVariant(
  input: {
    business: BusinessEvidence;
    campaign?: CampaignEvidence;
    brandKit: HybridBrandKit;
    brief: AICreativeBrief;
    brandAsset?: BrandAssetResolution;
    baseVisualDirection: VisualDirection;
    openAICallCountRef?: { value: number };
    sampleMode?: boolean;
    attempts?: HybridPipelineAttempt[];
  }
): Promise<VariantSelection> {
  const { business, campaign, brandKit, brief, brandAsset, baseVisualDirection } = input;
  const copyPack = buildPremiumCopyPack(business, campaign, brief, baseVisualDirection);
  const realLogoExpected = !!brandAsset && brandAsset.realLogoExpected;

  // Resolve logo once.
  const logoBuffer =
    brandAsset?.logoBuffer ?? (brandKit.logoUrl ? await fetchLogoBuffer(brandKit.logoUrl) : null);

  // Generate a single background to reuse across variants (saves cost and keeps brand consistent).
  const backgroundBuffer = await generateBackground(baseVisualDirection);
  if (!backgroundBuffer) {
    throw new Error("Background generation failed: unable to produce a background image.");
  }
  if (input.openAICallCountRef) input.openAICallCountRef.value += 1;

  const labels = ["editorial", "cta-banner", "spotlight"];
  const variants: VariantResult[] = [];

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const visualDirection = makeVariantVisualDirection(baseVisualDirection, label);

    const renderResult = await renderHybridLeaflet(
      {
        businessName: (business.displayName || business.name || "Business") as string,
        headline: copyPack.headline,
        subheadline: copyPack.subheadline,
        primaryServices: copyPack.services.map((s) => ({ name: s.title, description: s.body })),
        secondaryServices: [],
        benefits: copyPack.proofPoints,
        cta: copyPack.cta,
        offerLine: brief.offerLine,
        contact: {
          phone: (business.phone as string) || undefined,
          website: (business.website as string) || undefined,
          location: (business.location as string) || undefined,
        },
        brandAsset,
        copyPack,
      },
      brandKit,
      visualDirection,
      backgroundBuffer,
      logoBuffer,
      brandAsset
    );

    const contentFidelity = evaluateContentFidelity(business, campaign || {}, brief, renderResult.html);
    const copyQuality = evaluateCopyQuality(contentFidelity.visibleRenderedText);

    const rawCritic = await critiqueRenderedLeaflet(
      renderResult.buffer,
      (business.displayName || business.name || "Business") as string,
      brandAsset
    );
    if (input.openAICallCountRef) input.openAICallCountRef.value += 1;

    // Focused logo crop critic.
    let logoCropCritic: LogoCropCriticResult | undefined;
    if (realLogoExpected && logoBuffer) {
      try {
        const cropBuffer = await sharp(renderResult.buffer).extract({ left: 0, top: 0, width: 1080, height: 170 }).png().toBuffer();
        logoCropCritic = await critiqueLogoCrop(cropBuffer, logoBuffer, (business.displayName || business.name || "Business") as string);
      } catch {
        // ignore
      }
    }

    const brandFidelity = buildBrandFidelity(renderResult.metrics, rawCritic, brandAsset, logoCropCritic);
    const layoutScores = scoreLayout({
      metrics: renderResult.metrics,
      visualDirection,
      copyPack,
      copyQuality,
      contentFidelity,
      realLogoExpected,
    });

    const effectiveCriticPassed = computeEffectiveCriticPassed(rawCritic, logoCropCritic) && !contentFidelity.inventedOfferDetected;
    const contract = evaluatePremiumDesignContract({
      metadata: {},
      metrics: renderResult.metrics,
      copyPack,
      copyQuality,
      contentFidelity,
      brandFidelity,
      effectiveCriticPassed,
      usedDeterministicFallback: false,
      layoutScores,
      visualDirection,
    });

    const variant: VariantResult = {
      index: i,
      label,
      visualDirection,
      buffer: renderResult.buffer,
      backgroundBuffer,
      html: renderResult.html,
      metrics: renderResult.metrics,
      contentFidelity,
      copyQuality,
      copyPack,
      rawCritic,
      logoCropCritic,
      layoutScores,
      contract,
    };

    variants.push(variant);

    if (input.sampleMode && input.attempts) {
      input.attempts.push({ buffer: variant.buffer, critic: variant.rawCritic, visualDirection, metrics: variant.metrics });
    }
  }

  // Score each variant. Passing the contract is a strong bonus; otherwise use layout score minus penalties.
  const scored = variants.map((v) => {
    const issuePenalty = v.contract.issues.length * 12;
    const criticBonus = v.rawCritic.passed ? 20 : 0;
    const contractBonus = v.contract.passed ? 200 : 0;
    const score = v.layoutScores.layoutScore + criticBonus + contractBonus - issuePenalty;
    return { variant: v, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].variant;

  return { selectedIndex: best.index, variants, best };
}
