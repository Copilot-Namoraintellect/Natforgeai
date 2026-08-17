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
import { getServiceMicrocopy } from "./copy";

export interface BusinessEvidence {
  id?: string | number;
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
  creativeBriefFingerprint?: string;
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

export function asArray(value: unknown): string[] {
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
    const pattern = new RegExp(`\\b${kw.toLowerCase()}\\b`, "i");
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
  _serviceCount = 0
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

  // Food businesses with many items still render as a premium service menu,
  // not a plain catalogue, unless the user explicitly asks for a brochure.

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

function canonicalKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PRINT_PRODUCTS = [
  "business card",
  "flyer",
  "banner",
  "poster",
  "large format",
  "canvas",
  "wall canvas",
  "brochure",
  "booklet",
  "sticker",
  "sign",
  "display",
];

function isGenericPrint(name: string): boolean {
  const lower = canonicalKey(name);
  return lower === "printing" || lower === "print" || lower === "custom printing";
}

function hasSpecificPrintProduct(services: string[]): boolean {
  return services.some((s) => PRINT_PRODUCTS.some((p) => canonicalKey(s).includes(p)));
}

const SYNONYM_OVERRIDES: Record<string, string> = {
  "courier services": "Courier Services",
  courier: "Courier Services",
  copying: "Copies",
  copies: "Copies",
  scans: "Scanning",
  scanning: "Scanning",
  "copying services": "Copies",
  "scanning services": "Scanning",
  milkshakes: "Shakes",
  milkshake: "Shakes",
};

function groupRelatedServices(services: string[]): string[] {
  const keys = services.map((s) => canonicalKey(s));
  const hasBusinessCards = keys.includes("business cards");
  const hasFlyers = keys.includes("flyers");
  const hasCopies = keys.includes("copies");
  const hasScanning = keys.includes("scanning");

  const result: string[] = [];
  let groupedBusinessCards = false;
  let groupedCopies = false;

  for (const s of services) {
    const key = canonicalKey(s);
    if (hasBusinessCards && hasFlyers && (key === "business cards" || key === "flyers")) {
      if (!groupedBusinessCards) {
        result.push("Business Cards & Flyers");
        groupedBusinessCards = true;
      }
      continue;
    }
    if (hasCopies && hasScanning && (key === "copies" || key === "scanning")) {
      if (!groupedCopies) {
        result.push("Copies & Scans");
        groupedCopies = true;
      }
      continue;
    }
    result.push(s);
  }

  return result;
}

export function normalizeServices(rawServices: string[], _category: PremiumV2BusinessCategory = "general"): string[] {
  const cleaned = rawServices
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\s+/g, " ").replace(/[,.;:!]+$/, "").trim());

  // Apply synonym overrides and remove generic print if specific products exist.
  const specificPrintExists = hasSpecificPrintProduct(cleaned);
  const merged: { original: string; key: string; canonical: string }[] = [];

  for (const s of cleaned) {
    const lower = canonicalKey(s);
    if (specificPrintExists && isGenericPrint(s)) continue;

    const replacement = SYNONYM_OVERRIDES[lower];
    const value = replacement || s;
    const key = canonicalKey(value);

    // Skip duplicates by canonical key; keep first occurrence's casing.
    if (merged.some((m) => m.key === key)) continue;
    merged.push({ original: value, key, canonical: key });
  }

  return groupRelatedServices(merged.map((m) => m.original));
}

function cleanServiceName(name: string): string {
  return name.replace(/\s+/g, " ").replace(/[,.;:!]+$/, "").trim();
}

export function isAllServicesRequest(refinementInstruction?: string): boolean {
  if (!refinementInstruction) return false;
  const lower = refinementInstruction.toLowerCase();
  return hasKeyword(lower, ["all services", "all products", "include everything", "list all", "show all"]);
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ""))
    .join(" ");
}

function enrichServiceName(name: string, _category: PremiumV2BusinessCategory): string {
  const lower = canonicalKey(name);
  // Expand courier to a clearer title.
  if (lower === "courier services" || lower === "courier") return "Courier Services";
  if (lower === "large format printing" || lower === "large format prints") return "Large Format Printing";
  if (lower === "wall canvas prints" || lower === "canvas") return "Wall Canvas Prints";
  return titleCase(name);
}

export function curateServices(
  rawServices: string[],
  density: PremiumV2LayoutDensity,
  category: PremiumV2BusinessCategory = "general"
): { primaryServices: PremiumV2Service[]; secondaryServices: PremiumV2Service[] } {
  const cleaned = normalizeServices(rawServices, category);
  const preset = getCategoryPreset(category);
  const ordered = sortServicesByPreset(cleaned, preset);

  let primaryLimit = 4;
  if (density === "premium_minimal") primaryLimit = 3;
  else if (density === "offer_focused") primaryLimit = 4;
  else if (density === "corporate_professional") primaryLimit = 4;
  else if (density === "local_promo") primaryLimit = 4;
  else if (density === "catalogue_brochure") primaryLimit = 8;
  else primaryLimit = 4;

  // For non-catalogue modes, never exceed 5 primary cards.
  if (density !== "catalogue_brochure" && primaryLimit > 5) primaryLimit = 5;

  const primaryNames = ordered.slice(0, primaryLimit);
  const secondaryNames = ordered.slice(primaryLimit).slice(0, 8);

  const primaryServices: PremiumV2Service[] = primaryNames.map((name) => {
    const displayName = enrichServiceName(name, category);
    return {
      name: displayName,
      description: getServiceMicrocopy(category, displayName),
      isPrimary: true,
    };
  });

  const secondaryServices: PremiumV2Service[] = secondaryNames.map((name) => ({
    name: titleCase(cleanServiceName(name)),
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

// Re-export a sync palette helper for callers that already have a brand kit.
// The canonical resolver is async and lives in ./brand-kit.
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
