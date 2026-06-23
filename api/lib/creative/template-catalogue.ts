import { env } from "../env";
import type { TemplateFormat } from "./providers/template-renderer";

export type PremiumTemplateId =
  | "retail_product_promo"
  | "service_business_promo"
  | "offer_discount_campaign"
  | "corporate_professional"
  | "local_store_promo";

export type PremiumTemplateCategory =
  | "service"
  | "retail"
  | "offer"
  | "corporate"
  | "local";

export interface PremiumTemplate {
  id: PremiumTemplateId;
  name: string;
  label: string;
  description: string;
  category: PremiumTemplateCategory;
  previewImageUrl: string;
  formats: TemplateFormat[];
  defaultFormat: TemplateFormat;
  aspectRatios: Record<TemplateFormat, string>;
  supportedBusinessTypes: string[];
  supportedCampaignIntents: string[];
  requiredFields: string[];
  optionalFields: string[];
}

const TEMPLATES: PremiumTemplate[] = [
  {
    id: "service_business_promo",
    name: "Service Business Promo",
    label: "Service Business",
    description: "Header, service grid and anchored call-to-action",
    category: "service",
    previewImageUrl: "/templates/previews/service_business_promo.svg",
    formats: ["leaflet", "social_square", "social_story"],
    defaultFormat: "leaflet",
    aspectRatios: {
      leaflet: "4:5",
      social_square: "1:1",
      social_story: "9:16",
      social_reel: "9:16",
    },
    supportedBusinessTypes: [
      "service",
      "printing",
      "courier",
      "salon",
      "beauty",
      "repair",
      "consulting",
      "professional services",
      "cleaning",
      "maintenance",
      "health",
      "fitness",
      "education",
      "training",
    ],
    supportedCampaignIntents: [
      "promotion",
      "service launch",
      "booking",
      "awareness",
      "lead generation",
    ],
    requiredFields: ["businessName", "logoUrl", "headline", "offer", "cta", "services"],
    optionalFields: ["subheadline", "whatsapp", "email", "website", "location"],
  },
  {
    id: "retail_product_promo",
    name: "Retail Product Promo",
    label: "Retail / Product",
    description: "Hero product visual, centred offer and product cues",
    category: "retail",
    previewImageUrl: "/templates/previews/retail_product_promo.svg",
    formats: ["leaflet", "social_square", "social_story"],
    defaultFormat: "leaflet",
    aspectRatios: {
      leaflet: "4:5",
      social_square: "1:1",
      social_story: "9:16",
      social_reel: "9:16",
    },
    supportedBusinessTypes: [
      "retail",
      "shop",
      "ecommerce",
      "gift",
      "craft",
      "product",
      "fashion",
      "food",
      "bakery",
      "boutique",
      "market",
    ],
    supportedCampaignIntents: [
      "product promotion",
      "sale",
      "new arrival",
      "launch",
      "awareness",
    ],
    requiredFields: ["businessName", "logoUrl", "headline", "offer", "cta"],
    optionalFields: ["subheadline", "services", "whatsapp", "email", "website", "location"],
  },
  {
    id: "offer_discount_campaign",
    name: "Offer / Discount Campaign",
    label: "Offer / Discount",
    description: "Bold centred offer sticker and simple CTA",
    category: "offer",
    previewImageUrl: "/templates/previews/offer_discount_campaign.svg",
    formats: ["leaflet", "social_square", "social_story"],
    defaultFormat: "leaflet",
    aspectRatios: {
      leaflet: "4:5",
      social_square: "1:1",
      social_story: "9:16",
      social_reel: "9:16",
    },
    supportedBusinessTypes: ["retail", "service", "shop", "restaurant", "food", "salon", "gym", "event"],
    supportedCampaignIntents: [
      "discount",
      "sale",
      "seasonal promo",
      "limited offer",
      "opening",
      "flash sale",
      "clearance",
    ],
    requiredFields: ["businessName", "logoUrl", "headline", "offer", "cta"],
    optionalFields: ["subheadline", "services", "whatsapp", "email", "website", "location"],
  },
  {
    id: "corporate_professional",
    name: "Corporate Professional",
    label: "Corporate",
    description: "Clean B2B layout with formal typography and trust signals",
    category: "corporate",
    previewImageUrl: "/templates/previews/corporate_professional.svg",
    formats: ["leaflet", "social_square", "social_story"],
    defaultFormat: "leaflet",
    aspectRatios: {
      leaflet: "4:5",
      social_square: "1:1",
      social_story: "9:16",
      social_reel: "9:16",
    },
    supportedBusinessTypes: [
      "b2b",
      "consulting",
      "financial services",
      "it services",
      "technology",
      "software",
      "legal",
      "accounting",
      "insurance",
      "corporate",
      "agency",
    ],
    supportedCampaignIntents: [
      "brand awareness",
      "lead generation",
      "service promotion",
      "partnership",
      "consultation",
    ],
    requiredFields: ["businessName", "logoUrl", "headline", "offer", "cta"],
    optionalFields: ["subheadline", "services", "whatsapp", "email", "website", "location"],
  },
  {
    id: "local_store_promo",
    name: "Local Store Promo",
    label: "Local Store",
    description: "Friendly neighbourhood layout with community-focused messaging",
    category: "local",
    previewImageUrl: "/templates/previews/local_store_promo.svg",
    formats: ["leaflet", "social_square", "social_story"],
    defaultFormat: "leaflet",
    aspectRatios: {
      leaflet: "4:5",
      social_square: "1:1",
      social_story: "9:16",
      social_reel: "9:16",
    },
    supportedBusinessTypes: [
      "local shop",
      "franchise",
      "community business",
      "retail",
      "service",
      "restaurant",
      "cafe",
      "grocery",
      "butchery",
      "hardware",
    ],
    supportedCampaignIntents: [
      "local awareness",
      "foot traffic",
      "opening",
      "sale",
      "community event",
      "loyalty",
    ],
    requiredFields: ["businessName", "logoUrl", "headline", "offer", "cta"],
    optionalFields: ["subheadline", "services", "whatsapp", "email", "website", "location"],
  },
];

export function listPremiumTemplates(): PremiumTemplate[] {
  return TEMPLATES;
}

export function getPremiumTemplate(id: PremiumTemplateId): PremiumTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function resolveProviderTemplateId(
  provider: string | undefined,
  templateId: PremiumTemplateId
): string | undefined {
  const key = String(provider ?? "").toLowerCase();
  switch (key) {
    case "bannerbear":
      return resolveBannerbearTemplateId(templateId);
    case "templatedio":
    case "templated.io":
      return resolveTemplatedIoTemplateId(templateId);
    default:
      return undefined;
  }
}

function resolveBannerbearTemplateId(templateId: PremiumTemplateId): string | undefined {
  switch (templateId) {
    case "retail_product_promo":
      return env.bannerbearTemplateRetailProductPromo;
    case "service_business_promo":
      return env.bannerbearTemplateServiceBusinessPromo;
    case "offer_discount_campaign":
      return env.bannerbearTemplateOfferDiscountCampaign;
    case "corporate_professional":
      return env.bannerbearTemplateCorporateProfessional;
    case "local_store_promo":
      return env.bannerbearTemplateLocalStorePromo;
    default:
      return undefined;
  }
}

function resolveTemplatedIoTemplateId(templateId: PremiumTemplateId): string | undefined {
  switch (templateId) {
    case "retail_product_promo":
      return env.templatedIoTemplateRetailProductPromo;
    case "service_business_promo":
      return env.templatedIoTemplateServiceBusinessPromo;
    case "offer_discount_campaign":
      return env.templatedIoTemplateOfferDiscountCampaign;
    case "corporate_professional":
      return env.templatedIoTemplateCorporateProfessional;
    case "local_store_promo":
      return env.templatedIoTemplateLocalStorePromo;
    default:
      return undefined;
  }
}

export function resolveAspectRatio(templateId: PremiumTemplateId, format: TemplateFormat): string {
  const template = getPremiumTemplate(templateId);
  return template?.aspectRatios[format] || "4:5";
}

function normalizeAffinity(value?: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function scoreTemplate(
  template: PremiumTemplate,
  businessType?: string,
  campaignIntent?: string
): number {
  let score = 0;
  const normalizedBusinessType = normalizeAffinity(businessType);
  const normalizedCampaignIntent = normalizeAffinity(campaignIntent);

  for (const affinity of template.supportedBusinessTypes) {
    if (normalizedBusinessType.includes(affinity.toLowerCase())) score += 2;
  }

  for (const intent of template.supportedCampaignIntents) {
    if (normalizedCampaignIntent.includes(intent.toLowerCase())) score += 2;
  }

  // Prefer templates whose category appears verbatim in the inputs.
  if (normalizedBusinessType.includes(template.category)) score += 1;
  if (normalizedCampaignIntent.includes(template.category)) score += 1;

  return score;
}

export function getBestTemplateForCampaign(
  business?: { type?: string | null; category?: string | null; industry?: string | null },
  campaign?: { primaryOutcome?: string | null; goal?: string | null; intent?: string | null }
): PremiumTemplateId {
  const businessType = business?.type || business?.category || business?.industry || "";
  const campaignIntent = campaign?.primaryOutcome || campaign?.goal || campaign?.intent || "";

  const scored = TEMPLATES.map((template) => ({
    template,
    score: scoreTemplate(template, businessType, campaignIntent),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.template.id || "service_business_promo";
}

export interface PremiumTemplateStatus {
  ready: boolean;
  provider?: string;
  missing?: string[];
  templates: PremiumTemplate[];
}

/**
 * External premium template provider readiness (Bannerbear / Templated.io).
 * Internal premium templates are always available and do not depend on this check.
 */
export function getPremiumTemplateStatus(): PremiumTemplateStatus {
  const templates = listPremiumTemplates();
  const provider = env.premiumTemplateProvider || undefined;

  if (!env.enablePremiumTemplateProvider) {
    return { ready: false, provider, missing: ["ENABLE_PREMIUM_TEMPLATE_PROVIDER"], templates };
  }

  if (!provider) {
    return { ready: false, provider, missing: ["PREMIUM_TEMPLATE_PROVIDER"], templates };
  }

  const key = provider.toLowerCase();

  if (key === "bannerbear") {
    if (!env.bannerbearApiKey) {
      return { ready: false, provider, missing: ["BANNERBEAR_API_KEY"], templates };
    }
    const missingTemplates = templates
      .map((t) => t.id)
      .filter((id) => !resolveProviderTemplateId(provider, id));
    if (missingTemplates.length > 0) {
      return {
        ready: false,
        provider,
        missing: missingTemplates.map((id) => `BANNERBEAR_TEMPLATE_${id.toUpperCase()}`),
        templates,
      };
    }
    return { ready: true, provider, templates };
  }

  if (key === "templatedio" || key === "templated.io") {
    if (!env.templatedIoApiKey) {
      return { ready: false, provider, missing: ["TEMPLATED_IO_API_KEY"], templates };
    }
    const missingTemplates = templates
      .map((t) => t.id)
      .filter((id) => !resolveProviderTemplateId(provider, id));
    if (missingTemplates.length > 0) {
      return {
        ready: false,
        provider,
        missing: missingTemplates.map((id) => `TEMPLATED_IO_TEMPLATE_${id.toUpperCase()}`),
        templates,
      };
    }
    return { ready: true, provider, templates };
  }

  return { ready: false, provider, missing: ["PREMIUM_TEMPLATE_PROVIDER"], templates };
}
