/**
 * Premium Leaflet Hybrid Pipeline – Visual Direction Planner.
 *
 * Uses OpenAI Structured Outputs to choose a layout preset, density, hero
 * treatment, background direction and CTA style based on the creative brief
 * and brand kit. Produces a detailed prompt for the background generator.
 */

import { generateObject } from "ai";
import { structuredModel } from "../../agents/openai";
import { env } from "../../env";
import type { AICreativeBrief, HybridBrandKit, VisualDirection } from "./pipeline-types";
import { VisualDirectionSchema, type WithFallback } from "./pipeline-types";
import { inferBusinessCategory } from "./curation";
import type { BusinessEvidence, CampaignEvidence } from "./curation";

export function defaultDirection(business: BusinessEvidence, campaign?: CampaignEvidence): VisualDirection {
  const category = inferBusinessCategory(business, campaign);
  const base: Omit<VisualDirection, "layoutPreset" | "density" | "heroTreatment" | "backgroundDirection" | "backgroundPrompt" | "ctaTreatment" | "colourUsageNote"> = {
    serviceLayout: "featured",
  };
  switch (category) {
    case "food_restaurant":
      return {
        ...base,
        layoutPreset: "premium_food_offer",
        density: "balanced",
        heroTreatment: "photo_full_bleed",
        backgroundDirection: "photographic_hero",
        backgroundPrompt: "Warm, appetising food photography background with soft bokeh, no text, no logos, no signage, no people faces, subtle warm tones.",
        ctaTreatment: "rounded_pill",
        colourUsageNote: "Use rich reds/oranges as primary, gold accent for the CTA, white cards.",
      };
    case "retail_product":
      return {
        ...base,
        layoutPreset: "premium_retail_promo",
        density: "balanced",
        heroTreatment: "shape_accent",
        backgroundDirection: "abstract_brand_gradient",
        backgroundPrompt: "Smooth abstract gradient with soft geometric shapes, no text, no logos, no products, clean premium feel.",
        ctaTreatment: "solid_button",
        colourUsageNote: "Use brand primary for hero, accent colour for CTA and offer badge.",
      };
    case "professional_services":
      return {
        ...base,
        layoutPreset: "premium_professional_clean",
        density: "minimal",
        heroTreatment: "solid_brand_block",
        backgroundDirection: "clean_white",
        backgroundPrompt: "Clean white background with very subtle navy/grey abstract shapes, no text, no logos, no people, corporate premium.",
        ctaTreatment: "outline_button",
        colourUsageNote: "Navy primary, muted secondary, gold accent for CTA.",
      };
    case "beauty_wellness":
      return {
        ...base,
        layoutPreset: "premium_local_service",
        density: "balanced",
        heroTreatment: "gradient_abstract",
        backgroundDirection: "soft_noise_texture",
        backgroundPrompt: "Soft pastel gradient with gentle texture, no text, no logos, no faces, calming luxury spa feel.",
        ctaTreatment: "rounded_pill",
        colourUsageNote: "Soft pinks/mauves primary, rose accent, white space.",
      };
    case "training_education":
      return {
        ...base,
        layoutPreset: "premium_professional_clean",
        density: "balanced",
        heroTreatment: "shape_accent",
        backgroundDirection: "geometric_shapes",
        backgroundPrompt: "Modern geometric shapes in brand greens and golds, no text, no logos, no people, professional learning environment.",
        ctaTreatment: "solid_button",
        colourUsageNote: "Green primary, teal secondary, gold accent.",
      };
    case "local_services":
    default:
      return {
        ...base,
        layoutPreset: "premium_local_service",
        density: "balanced",
        heroTreatment: "shape_accent",
        backgroundDirection: "abstract_brand_gradient",
        backgroundPrompt: "Abstract gradient in brand colours with subtle texture, no text, no logos, no signage, trustworthy local service feel.",
        ctaTreatment: "block_banner",
        colourUsageNote: "Brand primary for header, accent for CTA, white cards.",
      };
  }
}

export async function buildVisualDirection(
  business: BusinessEvidence,
  campaign: CampaignEvidence | undefined,
  brandKit: HybridBrandKit,
  brief: AICreativeBrief
): Promise<WithFallback<VisualDirection>> {
  if (!env.openaiApiKey || !env.enableHybridLeafletPipeline) {
    return { value: defaultDirection(business, campaign), usedOpenAI: false };
  }

  const system = `You are a senior visual designer planning a 1080x1350 marketing leaflet. Choose a layout preset, hero treatment, background direction and CTA style. Output a detailed background prompt that is STRICTLY text-free, logo-free, signage-free and contact-detail-free. Return strict JSON.`;

  const prompt = `Business: ${business.displayName || business.name}\nIndustry: ${business.industry}\nHeadline: ${brief.headline}\nSubheadline: ${brief.subheadline}\nPrimary services: ${brief.primaryServices.map((s) => s.name).join(", ")}\nCTA: ${brief.cta}\nBrand colours: primary=${brandKit.primary}, secondary=${brandKit.secondary}, accent=${brandKit.accent}.`;

  try {
    const { object } = await generateObject({
      model: structuredModel,
      schema: VisualDirectionSchema,
      system,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.5,
    });
    return { value: object, usedOpenAI: true };
  } catch (err: any) {
    const reason = `AI visual direction failed: ${err.message}`;
    console.warn(`[HybridVisualDirection] ${reason}. Falling back to default.`);
    return { value: defaultDirection(business, campaign), usedOpenAI: false, fallbackReason: reason };
  }
}
