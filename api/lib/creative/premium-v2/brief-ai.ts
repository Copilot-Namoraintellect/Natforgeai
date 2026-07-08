/**
 * Premium Leaflet Hybrid Pipeline – Creative Brief Builder.
 *
 * Uses OpenAI Structured Outputs to generate a campaign angle, headline,
 * subheadline, primary/secondary services, benefits and CTA. Normalises the
 * output and guarantees the subheadline never equals the raw customer pain point.
 */

import { generateObject } from "ai";
import { structuredModel } from "../../agents/openai";
import { env } from "../../env";
import { asString } from "./curation";
import type { BusinessEvidence, CampaignEvidence } from "./curation";
import { AICreativeBriefSchema, type AICreativeBrief, type HybridBrandKit, type WithFallback } from "./pipeline-types";
import { buildCommercialHeadline, buildCommercialSubheadline, buildCommercialBenefits, getServiceMicrocopy } from "./copy";
import { cleanCopy } from "./copy-quality";
import { inferBusinessCategory } from "./curation";

function buildEvidencePrompt(business: BusinessEvidence, campaign?: CampaignEvidence): string {
  const name = asString(business.displayName || business.name);
  const industry = asString(business.industry);
  const location = asString(business.location || business.address);
  const productOrService = asString(business.productOrService);
  const targetCustomer = asString(business.targetCustomer || campaign?.targetBuyer);
  const mainPainPoint = asString(campaign?.mainPainPoint);
  const goal = asString(campaign?.goal || campaign?.primaryOutcome);
  const offerDetails = asString(campaign?.offerDetails);
  const preferredCta = asString(campaign?.preferredCta);

  return [
    `Business: ${name}`,
    `Industry: ${industry}`,
    location ? `Location: ${location}` : "",
    `Products/Services: ${productOrService}`,
    targetCustomer ? `Target customer: ${targetCustomer}` : "",
    mainPainPoint ? `Customer pain point (internal only, do NOT use verbatim): ${mainPainPoint}` : "",
    goal ? `Campaign goal: ${goal}` : "",
    offerDetails ? `Offer: ${offerDetails}` : "",
    preferredCta ? `Preferred CTA: ${preferredCta}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function polishBrief(raw: AICreativeBrief): AICreativeBrief {
  const next: AICreativeBrief = {
    ...raw,
    headline: cleanCopy(raw.headline),
    subheadline: cleanCopy(raw.subheadline),
    cta: cleanCopy(raw.cta),
    primaryServices: raw.primaryServices.map((s) => ({
      ...s,
      name: cleanCopy(s.name).replace(/\.$/, ""),
      description: cleanCopy(s.description || ""),
    })),
    secondaryServices: raw.secondaryServices.map((s) => ({
      ...s,
      name: cleanCopy(s.name).replace(/\.$/, ""),
    })),
    benefits: raw.benefits.map((b) => cleanCopy(b)),
  };
  return next;
}

function deduplicateServiceDescriptions(services: { name: string; description: string | null; isPrimary: boolean }[], category: string) {
  const seen = new Set<string>();
  for (const s of services) {
    const key = (s.description || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
    if (!key || !seen.has(key)) {
      if (key) seen.add(key);
      continue;
    }
    // Duplicate description – rewrite using microcopy or a name-driven fallback.
    const microcopy = getServiceMicrocopy(category, s.name);
    if (microcopy.toLowerCase() !== key) {
      s.description = microcopy;
    } else {
      s.description = `Professional ${s.name.toLowerCase()} for everyday business.`;
    }
  }
}

function repairCta(cta: string): string {
  const cleaned = cleanCopy(cta).replace(/\.$/, "");
  if (/^get\s+touch$/i.test(cleaned)) return "Get in Touch";
  if (/^get\s+quote$/i.test(cleaned)) return "Get a Quote";
  if (/^contact$/i.test(cleaned)) return "Contact Us Today";
  if (/^request$/i.test(cleaned)) return "Request a Quote Today";
  if (cleaned.split(/\s+/).length < 2) return "Get in Touch";
  return cleaned;
}

export function normaliseBrief(raw: AICreativeBrief, business: BusinessEvidence, campaign?: CampaignEvidence): AICreativeBrief {
  const painPoint = (asString(campaign?.mainPainPoint) || "").toLowerCase().trim();
  const rawSub = raw.subheadline.trim();
  const category = inferBusinessCategory(business, campaign);

  // Guard: subheadline must never be the raw pain point.
  if (painPoint && rawSub.toLowerCase() === painPoint) {
    raw.subheadline = buildCommercialSubheadline(business, campaign);
  }

  // Ensure at least one primary service.
  if (!raw.primaryServices.length) {
    raw.primaryServices = [
      { name: (asString(business.productOrService) || "").split(",")[0].trim() || "Our Service", description: "Professional support you can rely on.", isPrimary: true },
    ];
  }

  // Limit primary cards to reduce generic grid feel and repeated descriptions.
  raw.primaryServices = raw.primaryServices.slice(0, 3);

  // Deduplicate services between primary and secondary.
  const primaryNames = new Set(raw.primaryServices.map((s) => s.name.toLowerCase()));
  raw.secondaryServices = raw.secondaryServices.filter((s) => !primaryNames.has(s.name.toLowerCase()));

  const polished = polishBrief(raw);
  polished.cta = repairCta(polished.cta);

  // Ensure no duplicate descriptions across primary service cards.
  deduplicateServiceDescriptions(polished.primaryServices, category);

  return polished;
}

export async function buildAICreativeBrief(
  business: BusinessEvidence,
  campaign: CampaignEvidence | undefined,
  brandKit: HybridBrandKit
): Promise<WithFallback<AICreativeBrief>> {
  if (!env.openaiApiKey || !env.enableHybridLeafletPipeline) {
    return { value: deterministicBrief(business, campaign), usedOpenAI: false };
  }

  const system = `You are a senior marketing copywriter. Create premium, customer-facing leaflet copy for a local business. The copy must feel human, benefit-led and category-appropriate. Never state the raw customer pain point as the subheadline. Convert pain points into positive outcomes. Keep service names short and description-driven. Return strict JSON matching the requested schema.`;

  const prompt = `${buildEvidencePrompt(business, campaign)}\n\nBrand colours (use for tone, not copy): primary=${brandKit.primary}, secondary=${brandKit.secondary}, accent=${brandKit.accent}.`;

  try {
    const { object } = await generateObject({
      model: structuredModel,
      schema: AICreativeBriefSchema,
      system,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
    });
    return { value: normaliseBrief(object, business, campaign), usedOpenAI: true };
  } catch (err: any) {
    const reason = `AI brief generation failed: ${err.message}`;
    console.warn(`[HybridBrief] ${reason}. Falling back to deterministic copy.`);
    return { value: deterministicBrief(business, campaign), usedOpenAI: false, fallbackReason: reason };
  }
}

export function deterministicBrief(business: BusinessEvidence, campaign?: CampaignEvidence): AICreativeBrief {
  const productOrService = asString(business.productOrService) || "";
  const services = productOrService
    .split(/,|;/)
    .map((s) => s.trim())
    .filter(Boolean);
  const category = inferBusinessCategory(business, campaign);
  const primary = services.slice(0, 4).map((name) => ({
    name,
    description: getServiceMicrocopy(category, name) || "Professional support you can rely on.",
    isPrimary: true as const,
  }));
  const secondary = services.slice(4, 8).map((name) => ({ name, description: null, isPrimary: false as const }));

  const brief: AICreativeBrief = {
    angle: buildCommercialSubheadline(business, campaign),
    headline: buildCommercialHeadline(business, campaign),
    subheadline: buildCommercialSubheadline(business, campaign),
    primaryServices: primary,
    secondaryServices: secondary,
    benefits: buildCommercialBenefits(business, campaign),
    cta: asString(campaign?.preferredCta) || "Get in Touch",
    offerLine: asString(campaign?.offerDetails) || null,
  };
  return polishBrief(brief);
}
