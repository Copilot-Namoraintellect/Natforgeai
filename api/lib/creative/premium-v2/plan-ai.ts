/**
 * Premium Leaflet Hybrid Pipeline – Combined Creative Planner.
 *
 * Produces BrandKit + Creative Brief + Visual Direction in a single OpenAI
 * structured-output call when the hybrid pipeline is enabled. This cuts the
 * typical per-fixture OpenAI call count from 4 (brand, brief, visual,
 * background) to 3 (plan, background, critic).
 *
 * Falls back to deterministic planning if OpenAI is unavailable or fails.
 */

import { generateObject } from "ai";
import { structuredModel } from "../../agents/openai";
import { env } from "../../env";
import { asString } from "./curation";
import type { BusinessEvidence, CampaignEvidence } from "./curation";
import { deterministicBrief } from "./brief-ai";
import { defaultDirection } from "./visual-direction";
import { resolveBrandAssets } from "../brand-asset-resolver";
import {
  CreativePlanOpenAISchema,
  type CreativePlan,
  type WithFallback,
} from "./pipeline-types";

function toDataUri(buffer: Buffer, contentType: string): string {
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function inferContentType(buffer: Buffer): string {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return "image/webp";
  return "image/png";
}

function buildSystemPrompt(): string {
  return [
    "You are a senior creative director for a local-business marketing design system.",
    "Given the business evidence and optional logo, output a complete creative plan in strict JSON.",
    "The plan must include: a brand kit, a customer-facing creative brief, and visual direction for a 1080x1350 leaflet.",
    "All hex colours must be 6-digit. Background prompts must be strictly text-free, logo-free, signage-free and contact-detail-free.",
    "Never state the raw customer pain point as the subheadline; convert pain points into positive outcomes.",
  ].join(" ");
}

function buildUserPrompt(business: BusinessEvidence, campaign?: CampaignEvidence): string {
  const name = asString(business.displayName || business.name);
  const industry = asString(business.industry);
  const location = asString(business.location || business.address);
  const productOrService = asString(business.productOrService);
  const targetCustomer = asString(business.targetCustomer || campaign?.targetBuyer);
  const mainPainPoint = asString(campaign?.mainPainPoint);
  const goal = asString(campaign?.goal || campaign?.primaryOutcome);
  const offerDetails = asString(campaign?.offerDetails);
  const preferredCta = asString(campaign?.preferredCta);

  const parts = [
    `Business: ${name}`,
    `Industry: ${industry}`,
    location ? `Location: ${location}` : "",
    `Products/Services: ${productOrService}`,
    targetCustomer ? `Target customer: ${targetCustomer}` : "",
    mainPainPoint ? `Customer pain point (internal only, do NOT use verbatim): ${mainPainPoint}` : "",
    goal ? `Campaign goal: ${goal}` : "",
    offerDetails ? `Offer: ${offerDetails}` : "",
    preferredCta ? `Preferred CTA: ${preferredCta}` : "",
  ];
  return parts.filter(Boolean).join("\n");
}

async function deterministicPlan(
  business: BusinessEvidence,
  campaign?: CampaignEvidence
): Promise<CreativePlan> {
  const [brandAsset, brief, visualDirection] = await Promise.all([
    resolveBrandAssets(business, campaign, { fetchBuffer: true }),
    deterministicBrief(business, campaign),
    defaultDirection(business, campaign),
  ]);
  const brandKit: CreativePlan["brandKit"] = {
    primary: "#0F172A",
    secondary: "#334155",
    accent: "#3B82F6",
    background: "#FFFFFF",
    text: "#0F172A",
    textMuted: "#475569",
    source: brandAsset.logoResolved ? "logo" : "default",
    logoUrl: brandAsset.logoResolved ? brandAsset.logoSourceUrl : null,
    logoDescription: null,
    typographyNote: null,
    brandAsset,
  };
  return { brandKit, brief, visualDirection };
}

export async function planCreativeWithAI(
  business: BusinessEvidence,
  campaign?: CampaignEvidence
): Promise<WithFallback<CreativePlan>> {
  if (!env.openaiApiKey || !env.enableHybridLeafletPipeline) {
    return { value: await deterministicPlan(business, campaign), usedOpenAI: false };
  }

  const brandAsset = await resolveBrandAssets(business, campaign, { fetchBuffer: true });
  const logoBuffer = brandAsset.logoBuffer || null;

  try {
    const userContent: any[] = [{ type: "text", text: buildUserPrompt(business, campaign) }];
    if (logoBuffer) {
      userContent.unshift({
        type: "image",
        image: toDataUri(logoBuffer, inferContentType(logoBuffer)),
      });
    }

    const { object: rawObject } = await generateObject({
      model: structuredModel,
      schema: CreativePlanOpenAISchema,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: userContent }],
      temperature: 0.4,
    });

    const object = rawObject as unknown as CreativePlan;

    if (!object.brandKit.logoUrl && brandAsset.logoSourceUrl) {
      object.brandKit.logoUrl = brandAsset.logoSourceUrl;
    }
    if (!object.brandKit.logoUrl) {
      object.brandKit.logoUrl = null;
    }
    object.brandKit.brandAsset = brandAsset;

    console.log(`[HybridPlanner] brandAsset attached to plan: exists=${!!object.brandKit.brandAsset}, logoSourceType=${object.brandKit.brandAsset?.logoSourceType ?? "n/a"}, realLogoExpected=${object.brandKit.brandAsset?.realLogoExpected ?? "n/a"}, logoResolved=${object.brandKit.brandAsset?.logoResolved ?? "n/a"}, logoBufferLength=${object.brandKit.brandAsset?.logoBuffer?.length ?? 0}`);

    return { value: object, usedOpenAI: true };
  } catch (err: any) {
    const reason = `Creative planning failed: ${err.message}`;
    console.warn(`[HybridPlanner] ${reason}. Falling back to deterministic plan.`);
    return { value: await deterministicPlan(business, campaign), usedOpenAI: false, fallbackReason: reason };
  }
}
