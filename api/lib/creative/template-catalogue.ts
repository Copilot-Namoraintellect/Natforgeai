import { env } from "../env";
import type { TemplateFormat } from "./providers/template-renderer";

export type PremiumTemplateId = "retail_product_promo" | "service_business_promo" | "offer_discount_campaign";

export interface PremiumTemplate {
  id: PremiumTemplateId;
  label: string;
  description: string;
  formats: TemplateFormat[];
  defaultFormat: TemplateFormat;
  aspectRatios: Record<TemplateFormat, string>;
}

const TEMPLATES: PremiumTemplate[] = [
  {
    id: "retail_product_promo",
    label: "Retail / Product Promo",
    description: "Hero product visual, centred offer and product cues",
    formats: ["leaflet", "social_square", "social_story"],
    defaultFormat: "leaflet",
    aspectRatios: {
      leaflet: "4:5",
      social_square: "1:1",
      social_story: "9:16",
      social_reel: "9:16",
    },
  },
  {
    id: "service_business_promo",
    label: "Service Business Promo",
    description: "Header, service grid and anchored call-to-action",
    formats: ["leaflet", "social_square", "social_story"],
    defaultFormat: "leaflet",
    aspectRatios: {
      leaflet: "4:5",
      social_square: "1:1",
      social_story: "9:16",
      social_reel: "9:16",
    },
  },
  {
    id: "offer_discount_campaign",
    label: "Offer / Discount Campaign",
    description: "Bold centred offer sticker and simple CTA",
    formats: ["leaflet", "social_square", "social_story"],
    defaultFormat: "leaflet",
    aspectRatios: {
      leaflet: "4:5",
      social_square: "1:1",
      social_story: "9:16",
      social_reel: "9:16",
    },
  },
];

export function listPremiumTemplates(): PremiumTemplate[] {
  return TEMPLATES;
}

export function getPremiumTemplate(id: PremiumTemplateId): PremiumTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function resolveProviderTemplateId(provider: string | undefined, templateId: PremiumTemplateId): string | undefined {
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
    default:
      return undefined;
  }
}

export function resolveAspectRatio(templateId: PremiumTemplateId, format: TemplateFormat): string {
  const template = getPremiumTemplate(templateId);
  return template?.aspectRatios[format] || "4:5";
}

export interface PremiumTemplateStatus {
  ready: boolean;
  provider?: string;
  missing?: string[];
  templates: PremiumTemplate[];
}

/**
 * A premium template provider is only considered ready when:
 * - the feature flag is enabled,
 * - a provider is explicitly chosen,
 * - the provider API key is present, and
 * - every NatForgeAI template is mapped to a provider template UID.
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
      return { ready: false, provider, missing: missingTemplates.map((id) => `BANNERBEAR_TEMPLATE_${id.toUpperCase()}`), templates };
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
      return { ready: false, provider, missing: missingTemplates.map((id) => `TEMPLATED_IO_TEMPLATE_${id.toUpperCase()}`), templates };
    }
    return { ready: true, provider, templates };
  }

  return { ready: false, provider, missing: ["PREMIUM_TEMPLATE_PROVIDER"], templates };
}
