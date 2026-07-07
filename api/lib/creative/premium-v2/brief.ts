/**
 * Premium Leaflet V2 – structured brief builder.
 *
 * Converts raw business/campaign/post inputs into a deterministic, testable
 * PremiumLeafletV2Brief. The brief is then consumed by the V2 renderer.
 */

import type {
  PremiumLeafletV2Brief,
  PremiumV2BrandKit,
  PremiumV2BusinessCategory,
  PremiumV2LayoutDensity,
  PremiumV2RefinementMode,
  PremiumV2VisualStyle,
} from "./types";
import {
  inferBusinessCategory,
  inferLayoutDensity,
  inferVisualStyle,
  curateServices,
  buildContactLines,
  buildProofPoints,
  inferLogoPlacement,
  buildDefaultCta,
  normalizeServices,
  asString,
  hasKeyword,
  isAllServicesRequest,
} from "./curation";
import type { BusinessEvidence, CampaignEvidence, ApprovedCopyPack } from "./curation";
import { resolveBrandKit } from "./brand-kit";
import { buildCommercialBenefits, buildCommercialHeadline, buildCommercialSubheadline, isWeak, rejectWeakCopy } from "./copy";

export interface BuildPremiumV2BriefInput {
  business: any;
  campaign?: any;
  post?: any;
  approvedMessagePack?: ApprovedCopyPack | null;
  refinementInstruction?: string;
  brandKit?: PremiumV2BrandKit;
}

function toBusinessEvidence(business: any): BusinessEvidence {
  if (!business) return {};
  return {
    displayName: business.displayName,
    name: business.name,
    logo: business.logo,
    brandColors: business.brandColors,
    visualStyle: business.visualStyle,
    website: business.website,
    email: business.email,
    phone: business.phone,
    whatsappNumber: business.whatsappNumber,
    whatsapp: business.whatsapp,
    location: business.location,
    address: business.address,
    industry: business.industry,
    productOrService: business.productOrService,
    targetCustomer: business.targetCustomer,
    brandTone: business.brandTone,
    brandVoiceNotes: business.brandVoiceNotes,
    websiteEvidence: business.websiteEvidence,
  };
}

function toCampaignEvidence(campaign: any): CampaignEvidence {
  if (!campaign) return {};
  return {
    name: campaign.name,
    goal: campaign.goal,
    primaryOutcome: campaign.primaryOutcome,
    targetBuyer: campaign.targetBuyer,
    mainPainPoint: campaign.mainPainPoint,
    productOrService: campaign.productOrService,
    offerDetails: campaign.offerDetails,
    preferredCta: campaign.preferredCta,
    excludedOffers: campaign.excludedOffers,
    contentStyle: campaign.contentStyle,
    coreMessage: campaign.coreMessage,
  };
}

export function parseRefinementMode(instruction?: string): PremiumV2RefinementMode {
  if (!instruction) return "general";
  const text = instruction.toLowerCase();

  // Design/visual-only instructions should be detected before specific copy modes.
  if (hasKeyword(text, ["design only", "design-only", "visual only", "layout only", "just the design", "colour scheme", "color scheme", "background colour", "background color", "font", "darker background", "lighter background", "move the logo", "move logo", "logo placement"])) return "design_only";
  if (hasKeyword(text, ["catalogue", "brochure", "full list", "all services listed", "menu layout"])) return "catalogue_layout";
  if (hasKeyword(text, ["minimal", "clean", "simple", "less clutter", "reduce clutter", "fewer services", "less services"])) return "reduce_clutter";
  if (hasKeyword(text, ["offer", "discount", "deal", "sale", "promo", "special"])) return "emphasise_offer";
  if (hasKeyword(text, ["location", "near me", "local", "address"])) return "emphasise_location";
  if (hasKeyword(text, ["corporate", "professional", "formal", "b2b"])) return "full_redesign";
  if (hasKeyword(text, ["add service", "include", "more services", "add product", "include product", "all services", "all products"])) return "add_services";
  if (hasKeyword(text, ["stronger cta", "better cta", "call to action", "bigger cta"])) return "stronger_cta";
  if (hasKeyword(text, ["more premium", "luxury", "high-end", "upscale", "sophisticated"])) return "more_premium";
  if (hasKeyword(text, ["copy", "headline", "wording", "text", "rewrite"])) return "improve_copy";
  if (hasKeyword(text, ["visual", "layout", "colour", "color", "font", "style", "spacing", "typography"])) return "design_only";
  return "general";
}

function refineModeToLayoutDensity(
  mode: PremiumV2RefinementMode,
  business: BusinessEvidence,
  campaign: CampaignEvidence,
  serviceCount: number
): PremiumV2LayoutDensity {
  if (mode === "catalogue_layout") return "catalogue_brochure";
  if (mode === "reduce_clutter") return "premium_minimal";
  if (mode === "emphasise_offer") return "offer_focused";
  if (mode === "emphasise_location") return "local_promo";
  if (mode === "more_premium") return "premium_minimal";
  if (mode === "full_redesign") return "corporate_professional";
  if (mode === "add_services" && serviceCount > 5) return "premium_services";
  if (mode === "fewer_services") return "premium_minimal";
  return inferLayoutDensity(business, campaign, undefined, serviceCount);
}

function extractServices(
  business: BusinessEvidence,
  campaign: CampaignEvidence,
  approvedPack?: ApprovedCopyPack | null,
  preserveApprovedCopy = false
): string[] {
  const sources: string[] = [];

  if (approvedPack?.benefitBullets?.length) {
    sources.push(...approvedPack.benefitBullets);
    // Design-only refinements must preserve the approved service list exactly;
    // do not mix in business evidence that would reorder or dilute the message.
    if (preserveApprovedCopy) {
      return normalizeServices(sources);
    }
  }

  const websiteServices = business.websiteEvidence?.productsServices;
  if (Array.isArray(websiteServices) && websiteServices.length) {
    sources.push(...websiteServices);
  }

  if (campaign.productOrService) {
    sources.push(...campaign.productOrService.split(/[\n,;]+/));
  }
  if (business.productOrService) {
    sources.push(...business.productOrService.split(/[\n,;]+/));
  }

  return sources;
}

function extractBenefits(
  business: BusinessEvidence,
  campaign: CampaignEvidence,
  approvedPack?: ApprovedCopyPack | null
): string[] {
  const benefits: string[] = [];
  if (approvedPack?.benefitBullets?.length) {
    benefits.push(...approvedPack.benefitBullets.slice(0, 4));
  }

  if (!benefits.length) {
    return buildCommercialBenefits(business, campaign).slice(0, 4);
  }

  return benefits
    .map((b) => rejectWeakCopy(b, ""))
    .filter(Boolean)
    .slice(0, 4);
}

function buildComplianceNotes(business: BusinessEvidence, campaign: CampaignEvidence): string[] {
  const notes: string[] = [];
  if (inferBusinessCategory(business, campaign) === "healthcare_wellness") {
    notes.push("Healthcare claims must comply with local advertising regulations.");
  }
  if (campaign.excludedOffers) {
    notes.push(`Excluded offers/terms: ${campaign.excludedOffers}`);
  }
  return notes;
}

function resolveHeadline(
  business: BusinessEvidence,
  campaign: CampaignEvidence,
  post: any,
  approvedPack?: ApprovedCopyPack | null
): string {
  const approved = asString(approvedPack?.headline);
  if (approved) return approved;

  const postHeadline = asString(post?.headline);
  if (postHeadline && !isWeak(postHeadline)) return postHeadline;

  const coreMessage = asString(campaign.coreMessage);
  if (coreMessage && !isWeak(coreMessage)) return coreMessage;

  return buildCommercialHeadline(business, campaign);
}

function resolveSubheadline(
  business: BusinessEvidence,
  campaign: CampaignEvidence,
  post: any,
  approvedPack?: ApprovedCopyPack | null
): string {
  const approved = asString(approvedPack?.subheadline);
  if (approved) return approved;

  const postHook = asString(post?.hook);
  if (postHook && !isWeak(postHook)) return postHook;

  // Never use the raw customer pain point as customer-facing copy.
  return buildCommercialSubheadline(business, campaign);
}

export async function buildPremiumV2Brief(input: BuildPremiumV2BriefInput): Promise<PremiumLeafletV2Brief> {
  const { business: rawBusiness, campaign: rawCampaign, post, approvedMessagePack, refinementInstruction, brandKit: injectedBrandKit } = input;

  const business = toBusinessEvidence(rawBusiness);
  const campaign = toCampaignEvidence(rawCampaign || {});
  const category: PremiumV2BusinessCategory = inferBusinessCategory(business, campaign);
  const refinementMode = parseRefinementMode(refinementInstruction);
  const allServicesRequested = isAllServicesRequest(refinementInstruction);

  const preserveApprovedCopy = refinementMode === "design_only";
  const rawServices = extractServices(business, campaign, approvedMessagePack, preserveApprovedCopy);

  // "All services" means: show the most important services prominently and
  // include the rest compactly. It must NOT default to a catalogue unless the
  // user explicitly asked for a brochure/catalogue layout.
  let preliminaryDensity: PremiumV2LayoutDensity = refineModeToLayoutDensity(
    refinementMode,
    business,
    campaign,
    rawServices.length
  );
  if (allServicesRequested && preliminaryDensity !== "catalogue_brochure") {
    preliminaryDensity = rawServices.length > 5 ? "premium_services" : "premium_minimal";
  }

  const { primaryServices, secondaryServices } = curateServices(rawServices, preliminaryDensity, category);

  // Layout density respects the inferred/refinement-driven mode. A large service
  // list is curated into primary + secondary strip unless the user explicitly
  // asked for a catalogue/brochure layout.
  const layoutDensity: PremiumV2LayoutDensity = preliminaryDensity;

  const headline = resolveHeadline(business, campaign, post, approvedMessagePack || undefined);
  const subheadline = resolveSubheadline(business, campaign, post, approvedMessagePack || undefined);

  const cta =
    asString(approvedMessagePack?.cta) ||
    asString(campaign.preferredCta) ||
    asString(post?.cta) ||
    buildDefaultCta(campaign, business);

  const offer = asString(campaign.offerDetails);
  const benefits = extractBenefits(business, campaign, approvedMessagePack);
  const contact = buildContactLines(business, approvedMessagePack || undefined);
  const proofPoints = buildProofPoints(business, campaign);
  const visualStyle: PremiumV2VisualStyle = inferVisualStyle(business, campaign);

  const brandKit = injectedBrandKit || (await resolveBrandKit(business, campaign));
  const logoUrl = brandKit.logoUrl;

  const brief: PremiumLeafletV2Brief = {
    businessName: asString(business.displayName || business.name) || "Your Business",
    businessCategory: category,
    campaignGoal: asString(campaign.goal || campaign.primaryOutcome),
    targetCustomer: asString(campaign.targetBuyer || business.targetCustomer),
    customerPainPoint: asString(campaign.mainPainPoint),
    headline,
    subheadline,
    primaryServices,
    secondaryServices,
    offer,
    benefits,
    cta,
    contact,
    visualStyle,
    layoutDensity,
    brandPalette: brandKit.palette,
    logoUrl,
    brandAsset: brandKit.brandAsset,
    logoPlacement: inferLogoPlacement(layoutDensity),
    proofPoints,
    complianceNotes: buildComplianceNotes(business, campaign),
    refinementMode,
    refinementInstruction: refinementInstruction?.trim(),
    _evidence: {
      industry: business.industry,
      productOrService: business.productOrService,
      targetBuyer: campaign.targetBuyer,
      mainPainPoint: campaign.mainPainPoint,
      offerDetails: campaign.offerDetails,
      websiteEvidenceCategory: business.websiteEvidence?.businessCategory,
      websiteEvidenceServices: business.websiteEvidence?.productsServices,
    },
  };

  return brief;
}

/** Synchronous variant for callers that already have a resolved BrandKit. */
export function buildPremiumV2BriefSync(input: BuildPremiumV2BriefInput & { brandKit: PremiumV2BrandKit }): PremiumLeafletV2Brief {
  const { business: rawBusiness, campaign: rawCampaign, post, approvedMessagePack, refinementInstruction, brandKit } = input;

  const business = toBusinessEvidence(rawBusiness);
  const campaign = toCampaignEvidence(rawCampaign || {});
  const category: PremiumV2BusinessCategory = inferBusinessCategory(business, campaign);
  const refinementMode = parseRefinementMode(refinementInstruction);
  const allServicesRequested = isAllServicesRequest(refinementInstruction);

  const preserveApprovedCopy = refinementMode === "design_only";
  const rawServices = extractServices(business, campaign, approvedMessagePack, preserveApprovedCopy);

  let preliminaryDensity: PremiumV2LayoutDensity = refineModeToLayoutDensity(
    refinementMode,
    business,
    campaign,
    rawServices.length
  );
  if (allServicesRequested && preliminaryDensity !== "catalogue_brochure") {
    preliminaryDensity = rawServices.length > 5 ? "premium_services" : "premium_minimal";
  }

  const { primaryServices, secondaryServices } = curateServices(rawServices, preliminaryDensity, category);
  const layoutDensity: PremiumV2LayoutDensity = preliminaryDensity;

  const headline = resolveHeadline(business, campaign, post, approvedMessagePack || undefined);
  const subheadline = resolveSubheadline(business, campaign, post, approvedMessagePack || undefined);

  const cta =
    asString(approvedMessagePack?.cta) ||
    asString(campaign.preferredCta) ||
    asString(post?.cta) ||
    buildDefaultCta(campaign, business);

  const offer = asString(campaign.offerDetails);
  const benefits = extractBenefits(business, campaign, approvedMessagePack);
  const contact = buildContactLines(business, approvedMessagePack || undefined);
  const proofPoints = buildProofPoints(business, campaign);
  const visualStyle: PremiumV2VisualStyle = inferVisualStyle(business, campaign);

  return {
    businessName: asString(business.displayName || business.name) || "Your Business",
    businessCategory: category,
    campaignGoal: asString(campaign.goal || campaign.primaryOutcome),
    targetCustomer: asString(campaign.targetBuyer || business.targetCustomer),
    customerPainPoint: asString(campaign.mainPainPoint),
    headline,
    subheadline,
    primaryServices,
    secondaryServices,
    offer,
    benefits,
    cta,
    contact,
    visualStyle,
    layoutDensity,
    brandPalette: brandKit.palette,
    logoUrl: brandKit.logoUrl,
    brandAsset: brandKit.brandAsset,
    logoPlacement: inferLogoPlacement(layoutDensity),
    proofPoints,
    complianceNotes: buildComplianceNotes(business, campaign),
    refinementMode,
    refinementInstruction: refinementInstruction?.trim(),
    _evidence: {
      industry: business.industry,
      productOrService: business.productOrService,
      targetBuyer: campaign.targetBuyer,
      mainPainPoint: campaign.mainPainPoint,
      offerDetails: campaign.offerDetails,
      websiteEvidenceCategory: business.websiteEvidence?.businessCategory,
      websiteEvidenceServices: business.websiteEvidence?.productsServices,
    },
  };
}
