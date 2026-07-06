/**
 * Premium Leaflet V2 – business evidence curation.
 *
 * Turns raw business/campaign data into a structured brief by:
 *   - inferring the business category,
 *   - selecting a layout density mode,
 *   - curating services into primary/secondary buckets,
 *   - building contact/proof lines.
 */

import type { PremiumLeafletV2Brief, PremiumV2BusinessCategory, PremiumV2LayoutDensity, PremiumV2Service, PremiumV2VisualStyle } from "./types";
import { getCategoryPreset, sortServicesByPreset } from "./presets";

export interface BusinessEvidence {
  displayName?: string;
  name?: string;
  logo?: string;
  brandColors?: string[];
  visualStyle?: string;
  website?: string;
  email?: string;
  phone?: string;
  whatsappNumber?: string;
  whatsapp?: string;
  location?: string;
  address?: string;
  industry?: string;
  productOrService?: string;
  targetCustomer?: string;
  brandTone?: string;
  brandVoiceNotes?: string;
  websiteEvidence?: {
    businessCategory?: string;
    productsServices?: string[];
    targetCustomers?: string[];
    location?: string;
  } | null;
}

export interface CampaignEvidence {
  name?: string;
  goal?: string;
  primaryOutcome?: string;
  targetBuyer?: string;
  mainPainPoint?: string;
  productOrService?: string;
  offerDetails?: string;
  preferredCta?: string;
  excludedOffers?: string;
  contentStyle?: string;
  coreMessage?: string;
}

export interface ApprovedCopyPack {
  headline?: string;
  subheadline?: string;
  benefitBullets?: string[];
  cta?: string;
  footerContact?: { location?: string };
  proofPoints?: string[];
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim());
  return [];
}

export function hasKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/** Word-boundary keyword check: "print" matches "printing" but not "planning". */
export function hasWordKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => {
    const pattern = new RegExp(`\\b${kw.toLowerCase()}`, "i");
    return pattern.test(lower);
  });
}

export function inferBusinessCategory(business: BusinessEvidence, campaign?: CampaignEvidence): PremiumV2BusinessCategory {
  const source = [
    asString(business.websiteEvidence?.businessCategory),
    asString(business.industry),
    asString(business.productOrService),
    asString(campaign?.productOrService),
    asString(business.name),
    asString(campaign?.name),
  ]
    .filter(Boolean)
    .join(" ");

  if (hasWordKeyword(source, ["print", "printing", "courier", "copy", "scan", "laminat", "binding", "banner", "flyer", "business card", "canvas"])) {
    return "print_courier";
  }
  if (hasWordKeyword(source, ["restaurant", "cafe", "food", "coffee", "meal", "menu", "catering", "bakery"])) {
    return "food_restaurant";
  }
  if (hasWordKeyword(source, ["salon", "beauty", "spa", "hair", "nail", "makeup", "esthetician", "wellness"])) {
    return "beauty_wellness";
  }
  if (hasWordKeyword(source, ["plumber", "electrician", "cleaner", "cleaning", "repair", "handyman", "contractor", "maintenance", "hvac", "pest"])) {
    return "local_services";
  }
  if (hasWordKeyword(source, ["retail", "shop", "store", "boutique", "product", "sale", "discount"])) {
    return "retail_product";
  }
  if (hasWordKeyword(source, ["consultant", "consulting", "lawyer", "accountant", "agency", "advisor", "professional", "financial", "insurance", "coach"])) {
    return "professional_services";
  }
  if (hasWordKeyword(source, ["training", "course", "education", "learn", "academy", "tutor", "workshop"])) {
    return "training_education";
  }
  if (hasWordKeyword(source, ["logistics", "transport", "delivery", "freight", "moving", "storage", "warehouse", "shipping"])) {
    return "logistics";
  }
  if (hasWordKeyword(source, ["health", "medical", "dental", "clinic", "pharmacy", "therapy", "wellness"])) {
    return "healthcare_wellness";
  }
  return "general";
}

export function inferLayoutDensity(
  business: BusinessEvidence,
  campaign: CampaignEvidence,
  refinementMode?: string,
  serviceCount = 0
): PremiumV2LayoutDensity {
  const offerSignal = asString(campaign.offerDetails) || "";
  const styleSignal = asString(campaign.contentStyle) || "";
  const nameSignal = asString(campaign.name) || "";
  const strongInstruction = `${offerSignal} ${styleSignal}`.trim();

  // Explicit refinement mode always wins.
  if (refinementMode === "catalogue_layout") return "catalogue_brochure";
  if (refinementMode === "premium_minimal") return "premium_minimal";
  if (refinementMode === "offer_focused") return "offer_focused";
  if (refinementMode === "corporate_professional") return "corporate_professional";
  if (refinementMode === "local_promo") return "local_promo";

  // Category preset default density (unless campaign language strongly indicates otherwise).
  const category = inferBusinessCategory(business, campaign);
  const preset = getCategoryPreset(category);

  if (category === "food_restaurant" && serviceCount > 5) return "catalogue_brochure";

  // Strong campaign-level signals (offer details / explicit content style) can override the category default.
  // Campaign names alone are a weaker signal and should not override the category default.
  if (hasKeyword(strongInstruction, ["catalogue", "brochure", "menu", "full list", "all services listed"])) {
    return "catalogue_brochure";
  }
  if (hasKeyword(strongInstruction, ["minimal", "clean", "simple", "premium minimal"])) {
    return "premium_minimal";
  }
  if (category === "retail_product" && hasKeyword(`${strongInstruction} ${nameSignal}`, ["offer", "sale", "deal", "promo", "special"])) {
    return "offer_focused";
  }
  if (hasKeyword(strongInstruction, ["offer", "discount", "promo", "deal", "sale", "special"])) {
    return "offer_focused";
  }
  if (hasKeyword(strongInstruction, ["corporate", "professional", "b2b", "formal"])) {
    return "corporate_professional";
  }
  if (hasKeyword(`${strongInstruction} ${nameSignal}`, ["local", "neighbourhood", "community", "shop local"])) {
    return "local_promo";
  }

  return preset.defaultDensity;
}

export function inferVisualStyle(business: BusinessEvidence, campaign?: CampaignEvidence): PremiumV2VisualStyle {
  const hints = [
    asString(business.visualStyle),
    asString(business.brandTone),
    asString(business.brandVoiceNotes),
    asString(campaign?.contentStyle),
  ].join(" ");

  if (hasKeyword(hints, ["luxury", "elegant", "high-end", "sophisticated"])) return "luxury";
  if (hasKeyword(hints, ["bold", "energetic", "loud", "street", "impact"])) return "bold";
  if (hasKeyword(hints, ["minimal", "clean", "simple", "modern"])) return "minimal";
  if (hasKeyword(hints, ["friendly", "warm", "approachable", "casual"])) return "friendly";
  if (hasKeyword(hints, ["classic", "traditional", "trust", "established"])) return "classic";

  const category = inferBusinessCategory(business, campaign);
  return getCategoryPreset(category).defaultVisualStyle;
}

export function normalizeServices(rawServices: string[]): string[] {
  return rawServices
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      // Remove trailing punctuation and excessive descriptors.
      return s.replace(/\s+/g, " ").replace(/[,.;:!]+$/, "").trim();
    })
    .filter((s, i, arr) => arr.indexOf(s) === i);
}

function cleanServiceName(name: string): string {
  return name.replace(/\s+/g, " ").replace(/[,.;:!]+$/, "").trim();
}

export function isAllServicesRequest(refinementInstruction?: string): boolean {
  if (!refinementInstruction) return false;
  const lower = refinementInstruction.toLowerCase();
  return hasKeyword(lower, ["all services", "all products", "include everything", "list all", "show all"]);
}

export function curateServices(
  rawServices: string[],
  density: PremiumV2LayoutDensity,
  category: PremiumV2BusinessCategory = "general"
): { primaryServices: PremiumV2Service[]; secondaryServices: PremiumV2Service[] } {
  const cleaned = normalizeServices(rawServices);
  const preset = getCategoryPreset(category);
  const ordered = sortServicesByPreset(cleaned, preset);

  let primaryLimit = 5;
  if (density === "premium_minimal") primaryLimit = 3;
  else if (density === "offer_focused") primaryLimit = 4;
  else if (density === "corporate_professional") primaryLimit = 4;
  else if (density === "local_promo") primaryLimit = 4;
  else if (density === "catalogue_brochure") primaryLimit = 8;
  else primaryLimit = 5;

  // For non-catalogue modes, never exceed 5 primary cards.
  if (density !== "catalogue_brochure" && primaryLimit > 5) primaryLimit = 5;

  const primaryNames = ordered.slice(0, primaryLimit);
  const secondaryNames = ordered.slice(primaryLimit);

  const primaryServices: PremiumV2Service[] = primaryNames.map((name) => ({
    name: cleanServiceName(name),
    isPrimary: true,
  }));

  const secondaryServices: PremiumV2Service[] = secondaryNames.map((name) => ({
    name: cleanServiceName(name),
    isPrimary: false,
  }));

  return { primaryServices, secondaryServices };
}

export function buildContactLines(business: BusinessEvidence, approvedPack?: ApprovedCopyPack): PremiumLeafletV2Brief["contact"] {
  return {
    phone: asString(business.phone),
    whatsapp: asString(business.whatsappNumber || business.whatsapp),
    email: asString(business.email),
    website: asString(business.website),
    location: asString(approvedPack?.footerContact?.location || business.address || business.location),
  };
}

export function buildProofPoints(business: BusinessEvidence, campaign?: CampaignEvidence): PremiumLeafletV2Brief["proofPoints"] {
  const points: PremiumLeafletV2Brief["proofPoints"] = [];
  const location = asString(business.address || business.location || campaign?.name);
  if (location) points.push({ label: "Location", value: location });
  if (business.websiteEvidence?.targetCustomers?.length) {
    points.push({ label: "Serves", value: business.websiteEvidence.targetCustomers.slice(0, 2).join(", ") });
  }
  return points;
}

export function resolveBrandPaletteV2(business: BusinessEvidence): PremiumLeafletV2Brief["brandPalette"] {
  const colors = asArray(business.brandColors);
  const primary = colors[0] || "#0F172A";
  const secondary = colors[1] || "#334155";
  const accent = colors[2] || "#3B82F6";
  return {
    primary,
    secondary,
    accent,
    background: "#FFFFFF",
    text: "#0F172A",
    textMuted: "#475569",
  };
}

export function inferLogoPlacement(density: PremiumV2LayoutDensity): PremiumLeafletV2Brief["logoPlacement"] {
  if (density === "offer_focused") return "hero";
  if (density === "corporate_professional") return "header";
  return "header";
}

export function buildDefaultHeadline(business: BusinessEvidence, campaign?: CampaignEvidence): string {
  const category = inferBusinessCategory(business, campaign);
  const preset = getCategoryPreset(category);
  return preset.headlineTemplate(business, campaign);
}

export function buildDefaultSubheadline(business: BusinessEvidence, campaign?: CampaignEvidence): string {
  const category = inferBusinessCategory(business, campaign);
  const preset = getCategoryPreset(category);
  return preset.subheadlineTemplate(business, campaign);
}

export function buildDefaultCta(campaign?: CampaignEvidence, business?: BusinessEvidence): string {
  const category = business ? inferBusinessCategory(business, campaign) : "general";
  return asString(campaign?.preferredCta) || getCategoryPreset(category).defaultCta;
}
