/**
 * Campaign Message Architect
 *
 * A reusable, industry-agnostic layer that turns business profile, website
 * evidence and campaign brief into customer-facing, business-specific campaign
 * copy. The layer validates its own output before any image/video rendering
 * consumes credits.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { runAgent } from "../agents/runner";
import { getDb } from "../../queries/connection";
import { campaigns, campaignAssets, businesses } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { logInfo, logWarn, logError } from "../logger";
import { safeText } from "./brand-palette";

// ─── Public types ───

export interface FooterContact {
  phone?: string;
  whatsapp?: string;
  email?: string;
  website?: string;
  location?: string;
}

export interface PlatformCaption {
  platform: string;
  caption: string;
  cta: string;
  hashtags: string[];
}

export interface CampaignMessagePack {
  headline: string;
  subheadline: string;
  benefitBullets: string[];
  cta: string;
  footerContact: FooterContact;
  proofPoints?: string[];
  platformCaptions: PlatformCaption[];
  validation: CopyValidationResult;
}

export interface CopyValidationResult {
  passed: boolean;
  score: number;
  rejections: string[];
  warnings: string[];
}

export interface ValidationContext {
  businessName: string;
  campaignName: string;
  productOrService: string;
  targetCustomer?: string;
  mainPainPoint?: string;
  offerDetails?: string;
  excludedOffers?: string;
  preferredCta?: string;
  location?: string;
  industry?: string;
  websiteEvidence?: {
    businessCategory?: string;
    productsServices?: string[];
    targetCustomers?: string[];
    location?: string;
  };
}

// ─── Shared constants ───

export const GENERIC_PHRASES = [
  "marketing campaign",
  "transform your business",
  "transform how you",
  "revolutionise",
  "revolutionize",
  "unlock success",
  "unlock your potential",
  "unlock new possibilities",
  "discover the best",
  "join thousands",
  "join the revolution",
  "join our community",
  "live greener",
  "trade smarter",
  "explore unique experiences",
  "get 20% off",
  "get 50% off",
  "first month free",
  "limited spots",
  "limited time",
  "act now",
  "hurry",
  "don't miss out",
  "don't miss",
  "amazing deal",
  "special offer",
  "welcome",
  "hello",
  "thanks",
];

export const GENERIC_CTA_PATTERNS = [
  /learn more/i,
  /click here/i,
  /read more/i,
  /find out more/i,
  /discover more/i,
  /explore more/i,
  /get started/i,
  /start now/i,
  /sign up today/i,
  /^submit$/i,
  /^more info$/i,
  /^details$/i,
  /^contact us$/i,
];

export const INVENTED_OFFER_PATTERNS = [
  /\b\d{1,2}%\s*off\b/i,
  /\bfree\s+(trial|assessment|quote|consultation|audit|ebook|guide|report|month|delivery|shipping)\b/i,
  /\bdiscount\b/i,
  /\bdiscounted\s+price\b/i,
  /\bloan\b/i,
  /\bBNPL\b/i,
  /\bguarantee\b/i,
  /\bmoney[- ]?back\b/i,
  /\bsame[- ]?day\s+(service|delivery|shipping|turnaround)\b/i,
  /\blimited[- ]?time\b/i,
  /\blimited[- ]?spots\b/i,
];

export const GENERIC_PLACEHOLDERS = [
  "your business",
  "your brand",
  "your company",
  "[your business]",
  "[your brand]",
  "[company]",
  "[product]",
  "[service]",
];

// ─── CTA expectations by business category ───

export type BusinessCategory =
  | "fintech"
  | "restaurant"
  | "print"
  | "beauty"
  | "cleaning"
  | "retail"
  | "consulting"
  | "service"
  | "other";

export function detectBusinessCategory(ctx: ValidationContext): BusinessCategory {
  const haystack = [
    ctx.industry,
    ctx.websiteEvidence?.businessCategory,
    ctx.productOrService,
    ctx.businessName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/\b(payout|fintech|payment|finance|bank|wallet|tip|commission)\b/.test(haystack)) return "fintech";
  if (/\b(restaurant|takeaway|food|kitchen|cafe|bakery|grill)\b/.test(haystack)) return "restaurant";
  if (/\b(print|copy|courier|branding|stationery|banner|flyer|poster|business card)\b/.test(haystack)) return "print";
  if (/\b(salon|barber|beauty|hair|nails|spa|makeup|skincare)\b/.test(haystack)) return "beauty";
  if (/\b(clean|cleaning|maid|domestic|office clean)\b/.test(haystack)) return "cleaning";
  if (/\b(shop|store|retail|e-?commerce|online store|boutique)\b/.test(haystack)) return "retail";
  if (/\b(consult|consulting|advisor|coach|agency|professional|legal|account)\b/.test(haystack)) return "consulting";
  if (/\b(service|local service)\b/.test(haystack)) return "service";
  return "other";
}

export function expectedCtasForCategory(category: BusinessCategory): string[] {
  switch (category) {
    case "fintech":
      return ["Book a Demo", "Request a Walkthrough", "See How It Works", "Schedule a Consultation"];
    case "restaurant":
      return ["Order Now", "View Menu", "Book a Table", "WhatsApp Us", "Visit Us Today"];
    case "print":
      return ["Request a Quote Today", "Get a Quote", "Order Printing", "Contact Us for Printing"];
    case "beauty":
      return ["Book Now", "Book Your Appointment", "WhatsApp Us", "Visit the Salon"];
    case "cleaning":
      return ["Get a Quote", "Book a Clean", "Schedule a Cleaning", "Request a Quote"];
    case "retail":
      return ["Shop Now", "Visit Store", "Order Online", "Browse the Collection"];
    case "consulting":
      return ["Book a Consultation", "Schedule a Consultation", "Request a Quote", "Book a Demo"];
    case "service":
    case "other":
    default:
      return ["Request a Quote", "Book a Consultation", "Contact Us", "Get in Touch"];
  }
}

// ─── Validation helpers ───

function sanitize(value: unknown): string {
  return safeText(value);
}

function termMatches(text: string, term: string): boolean {
  // Whole-word or hyphenated-word match to avoid substring false positives
  // (e.g. "custom" inside "customers").
  const pattern = new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
  return pattern.test(text);
}

function extractProductTerms(ctx: ValidationContext): string[] {
  const terms = new Set<string>();
  const addTerms = (source?: string) => {
    if (!source) return;
    source
      .split(/[,;]+/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 3)
      .forEach((t) => terms.add(t));
  };
  addTerms(ctx.productOrService);
  (ctx.websiteEvidence?.productsServices || []).forEach(addTerms);
  return Array.from(terms);
}

function extractTargetCustomerTerms(ctx: ValidationContext): string[] {
  const terms = new Set<string>();
  const addTerms = (source?: string) => {
    if (!source) return;
    source
      .split(/[,;]+/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 3)
      .forEach((t) => terms.add(t));
  };
  addTerms(ctx.targetCustomer);
  (ctx.websiteEvidence?.targetCustomers || []).forEach(addTerms);
  return Array.from(terms);
}

function extractPainPointTerms(ctx: ValidationContext): string[] {
  if (!ctx.mainPainPoint) return [];
  return ctx.mainPainPoint
    .split(/[,;]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 3);
}

function normaliseForComparison(value: string): string {
  return sanitize(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isHeadlineCampaignNameOnly(headline: string, ctx: ValidationContext): boolean {
  const clean = normaliseForComparison(headline);
  const campaignClean = normaliseForComparison(ctx.campaignName);
  const businessClean = normaliseForComparison(ctx.businessName);
  if (!clean || clean.length === 0) return true;
  if (clean === campaignClean || clean === businessClean) return true;

  // Also reject "<Name> Marketing Campaign" pattern
  const headlineLower = sanitize(headline).toLowerCase();
  const businessLower = sanitize(ctx.businessName).toLowerCase();
  const campaignLower = sanitize(ctx.campaignName).toLowerCase();
  const marketingCampaignSuffix = /\s+marketing\s+campaign\s*$/;
  if (businessLower && marketingCampaignSuffix.test(headlineLower) && headlineLower.startsWith(businessLower)) return true;
  if (campaignLower && marketingCampaignSuffix.test(headlineLower) && headlineLower.startsWith(campaignLower)) return true;

  return false;
}

function hasExplicitOffer(ctx: ValidationContext): boolean {
  const offer = sanitize(ctx.offerDetails);
  if (!offer || offer.toLowerCase() === "none") return false;
  return offer.length > 0;
}

function offerContainsFree(ctx: ValidationContext): boolean {
  return /\bfree\b/i.test(sanitize(ctx.offerDetails));
}

// ─── Quality scoring ───

export function validateCampaignCopy(
  pack: CampaignMessagePack,
  ctx: ValidationContext
): CopyValidationResult {
  const rejections: string[] = [];
  const warnings: string[] = [];
  let score = 100;

  const allCopy = [
    pack.headline,
    pack.subheadline,
    ...pack.benefitBullets,
    pack.cta,
    ...(pack.platformCaptions || []).map((c) => `${c.caption} ${c.cta}`),
  ]
    .join(" ")
    .toLowerCase();

  // 1. Headline must not be campaign/business name only
  if (isHeadlineCampaignNameOnly(pack.headline, ctx)) {
    rejections.push("Headline is the campaign or business name only.");
    score -= 40;
  }

  // 2. Must reference specific product/service
  const productTerms = extractProductTerms(ctx);
  const hasProductTerm = productTerms.some((t) => termMatches(allCopy, t));
  if (!hasProductTerm && productTerms.length > 0) {
    rejections.push("Copy does not reference the specific product/service being promoted.");
    score -= 35;
  }

  // 3. Must reference target customer or pain point
  const customerTerms = extractTargetCustomerTerms(ctx);
  const painTerms = extractPainPointTerms(ctx);
  const hasCustomer = customerTerms.some((t) => termMatches(allCopy, t));
  const hasPain = painTerms.some((t) => termMatches(allCopy, t));
  if (!hasCustomer && !hasPain && (customerTerms.length > 0 || painTerms.length > 0)) {
    rejections.push("Copy does not reference the target customer or their pain point.");
    score -= 35;
  }

  // 4. CTA must not be generic or mismatched
  const cta = sanitize(pack.cta);
  const category = detectBusinessCategory(ctx);
  const expectedCtas = expectedCtasForCategory(category);
  const isGenericCta = GENERIC_CTA_PATTERNS.some((p) => p.test(cta));
  if (isGenericCta) {
    rejections.push(`CTA "${cta}" is too generic for this business type.`);
    score -= 30;
  }
  const matchesExpected = expectedCtas.some((expected) => cta.toLowerCase().includes(expected.toLowerCase()));
  const preferredCta = sanitize(ctx.preferredCta).toLowerCase();
  const matchesPreferred = preferredCta.length > 0 && cta.toLowerCase().includes(preferredCta);
  if (!matchesExpected && !matchesPreferred && expectedCtas.length > 0) {
    warnings.push(`CTA "${cta}" may not match the expected action for a ${category} business (${expectedCtas.join(", ")}).`);
    score -= 10;
  }
  // Preferred CTA wins if provided
  if (ctx.preferredCta && !matchesPreferred) {
    warnings.push(`CTA does not reflect the preferred CTA "${ctx.preferredCta}".`);
    score -= 10;
  }

  // 5. No invented offers
  if (!hasExplicitOffer(ctx)) {
    for (const pattern of INVENTED_OFFER_PATTERNS) {
      const match = allCopy.match(pattern);
      if (match) {
        rejections.push(`Invented offer detected (no offer was provided): "${match[0]}"`);
        score -= 30;
        break;
      }
    }
  } else {
    // If offer is provided, ensure "free assessment" only appears when free is explicit
    if (/\bfree\s+assessment\b/i.test(allCopy) && !offerContainsFree(ctx)) {
      rejections.push("'Free assessment' used but offer does not explicitly include free.");
      score -= 25;
    }
  }

  // 6. Excluded offers check
  if (ctx.excludedOffers) {
    const excluded = ctx.excludedOffers
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    for (const ex of excluded) {
      if (allCopy.includes(ex)) {
        rejections.push(`Excluded phrase used: "${ex}"`);
        score -= 20;
      }
    }
  }

  // 7. Generic phrase check
  for (const phrase of GENERIC_PHRASES) {
    if (allCopy.includes(phrase.toLowerCase())) {
      rejections.push(`Generic phrase detected: "${phrase}"`);
      score -= 15;
    }
  }

  // 8. Placeholder check
  for (const placeholder of GENERIC_PLACEHOLDERS) {
    if (allCopy.includes(placeholder.toLowerCase())) {
      rejections.push(`Placeholder language detected: "${placeholder}"`);
      score -= 25;
    }
  }

  // 9. Measurable/concrete benefit warning
  const benefitText = [...pack.benefitBullets, pack.subheadline].join(" ").toLowerCase();
  const concreteMarkers = /\b(save|reduce|cut|faster|quicker|more|increase|improve|less|hours|minutes|r\d|percent|%|days|weeks)\b/i;
  if (!concreteMarkers.test(benefitText)) {
    warnings.push("Copy lacks a measurable or concrete benefit (e.g. save time, reduce cost, faster results).");
    score -= 10;
  }

  // 10. Could apply to any business warning
  const genericBusinessWords = ["business", "company", "brand", "customers", "clients", "service", "quality", "professional", "trusted", "local"];
  const genericOnly = genericBusinessWords.filter((w) => termMatches(allCopy, w));
  if (!hasProductTerm && genericOnly.length >= 4) {
    warnings.push("Copy could apply to any business; add specific products/services or outcomes.");
    score -= 10;
  }

  // 11. Structural checks
  if (!pack.headline || sanitize(pack.headline).length < 5) {
    rejections.push("Headline is missing or too short.");
    score -= 30;
  }
  if (!pack.subheadline || sanitize(pack.subheadline).length < 10) {
    rejections.push("Subheadline is missing or too short.");
    score -= 20;
  }
  if (!Array.isArray(pack.benefitBullets) || pack.benefitBullets.length < 3) {
    rejections.push("At least three specific benefit bullets are required.");
    score -= 20;
  }
  if (!pack.cta || sanitize(pack.cta).length < 3) {
    rejections.push("CTA is missing or too short.");
    score -= 20;
  }

  score = Math.max(0, Math.min(100, score));

  return {
    passed: rejections.length === 0,
    score,
    rejections,
    warnings,
  };
}

// ─── Deterministic fallback builder ───

/**
 * Build a message pack deterministically from evidence and brief.
 * Used in tests and as a fallback when the LLM is unavailable.
 * The output is still run through validateCampaignCopy.
 */
export function buildDeterministicMessagePack(
  ctx: ValidationContext
): CampaignMessagePack {
  const category = detectBusinessCategory(ctx);
  const product = sanitize(ctx.productOrService) || "our service";
  const customer = sanitize(ctx.targetCustomer) || "our customers";
  const pain = sanitize(ctx.mainPainPoint) || "save time and reduce hassle";
  const offer = hasExplicitOffer(ctx) ? sanitize(ctx.offerDetails) : "";
  const location = sanitize(ctx.location) || sanitize(ctx.websiteEvidence?.location);
  const cta = ctx.preferredCta
    ? sanitize(ctx.preferredCta)
    : expectedCtasForCategory(category)[0];

  let headline = `${product} for ${customer}`;
  let subheadline = `We help ${customer.toLowerCase()} ${pain.toLowerCase()}.`;

  if (offer) {
    headline = `${product} — ${offer}`;
    subheadline = `Built for ${customer.toLowerCase()} who want ${pain.toLowerCase()} without the usual hassle.`;
  }

  // Avoid campaign/business name headline
  if (isHeadlineCampaignNameOnly(headline, ctx)) {
    headline = `Reliable ${product} for ${customer}`;
  }

  const benefitBullets = [
    `Targeted to ${customer.toLowerCase()} and the way you actually work.`,
    `Clear, upfront process so you avoid delays and confusion.`,
    `${location ? `Based in ${location} and ready when you are.` : "Built to fit your schedule and priorities."}`,
  ];

  const pack: CampaignMessagePack = {
    headline,
    subheadline,
    benefitBullets,
    cta,
    footerContact: {
      phone: (ctx.websiteEvidence as any)?.phone,
      whatsapp: (ctx.websiteEvidence as any)?.whatsapp,
      email: (ctx.websiteEvidence as any)?.email,
      website: (ctx.websiteEvidence as any)?.website,
      location,
    },
    proofPoints: [],
    platformCaptions: [],
    validation: { passed: false, score: 0, rejections: [], warnings: [] },
  };

  pack.validation = validateCampaignCopy(pack, ctx);
  return pack;
}

// ─── LLM-based architect ───

const ArchitectOutputSchema = z.object({
  headline: z.string(),
  subheadline: z.string(),
  benefitBullets: z.array(z.string()).min(3).max(5),
  cta: z.string(),
  footerContact: z.object({
    phone: z.string().nullable(),
    whatsapp: z.string().nullable(),
    email: z.string().nullable(),
    website: z.string().nullable(),
    location: z.string().nullable(),
  }),
  proofPoints: z.array(z.string()).nullable(),
  platformCaptions: z.array(
    z.object({
      platform: z.string(),
      caption: z.string(),
      cta: z.string(),
      hashtags: z.array(z.string()).nullable(),
    })
  ),
});

export interface BuildApprovedMessagePackOptions {
  userId: number;
  campaignId: number;
  skipBilling?: boolean;
  maxAttempts?: number;
}

function buildValidationContext(business: any, campaign: any): ValidationContext {
  const evidence = (business?.websiteEvidence || {}) as any;
  return {
    businessName: sanitize(business?.name),
    campaignName: sanitize(campaign?.name),
    productOrService: sanitize(campaign?.productOrService || business?.productOrService),
    targetCustomer: sanitize(campaign?.targetBuyer || business?.targetCustomer || business?.targetAudience),
    mainPainPoint: sanitize(campaign?.mainPainPoint),
    offerDetails: sanitize(campaign?.offerDetails),
    excludedOffers: sanitize(campaign?.excludedOffers || business?.avoidWords),
    preferredCta: sanitize(campaign?.preferredCta || campaign?.ctaStrategy),
    location: sanitize(campaign?.location || business?.location || evidence?.location),
    industry: sanitize(business?.industry || evidence?.businessCategory),
    websiteEvidence: {
      businessCategory: evidence?.businessCategory,
      productsServices: evidence?.productsServices || [],
      targetCustomers: evidence?.targetCustomers || [],
      location: evidence?.location,
    },
  };
}

function architectPrompt(ctx: ValidationContext, platforms: string[]): string {
  const category = detectBusinessCategory(ctx);
  const categoryCtas = expectedCtasForCategory(category).join('", "');
  const explicitOffer = hasExplicitOffer(ctx) ? ctx.offerDetails : "None — do NOT invent offers, discounts, free trials, free assessments, guarantees, same-day service, limited-time deals, loans, BNPL or loyalty programmes.";

  return `You are a senior conversion copywriter for NatForgeAI. Write a customer-facing campaign message pack for the business below.

BUSINESS GROUND TRUTH:
- Business name: ${ctx.businessName}
- Industry/category: ${ctx.industry || "Not specified"}
- Products/Services: ${(ctx.websiteEvidence?.productsServices || [ctx.productOrService]).join(", ")}
- Target customers: ${(ctx.websiteEvidence?.targetCustomers || [ctx.targetCustomer]).join(", ")}
- Location: ${ctx.location || "Not specified"}
- Website evidence category: ${ctx.websiteEvidence?.businessCategory || "Not specified"}

CAMPAIGN BRIEF:
- Campaign name: ${ctx.campaignName}
- Product/Service being promoted: ${ctx.productOrService}
- Target buyer: ${ctx.targetCustomer || "Not specified"}
- Main pain point: ${ctx.mainPainPoint || "Not specified"}
- Explicit offer (use ONLY this): ${explicitOffer}
- Preferred CTA: ${ctx.preferredCta || "Not specified"}
- Exclusions (never use): ${ctx.excludedOffers || "None"}
- Platforms: ${platforms.join(", ")}

REQUIRED OUTPUT:
1. Headline — customer-facing, specific, never the campaign name only, never "Marketing Campaign".
2. Subheadline — explains the value proposition in one line.
3. Three benefit bullets or cards — each must mention a concrete outcome, product feature, or customer relief.
4. CTA — action-driven and matched to the business type. For this business, preferred CTAs are: "${categoryCtas}". Only use "Free" in the CTA if the explicit offer above contains "free".
5. Footer/contact details — phone, WhatsApp, email, website, location (use only verified details).
6. Optional proof points or trust signals — only include if there is real evidence (e.g. years in business, verified reviews, local presence). Do NOT invent testimonials, awards, or numbers.
7. Platform-specific caption adaptations — one per platform listed above, each with caption, CTA, and hashtags.

COPY RULES:
- NEVER use generic phrases such as "Marketing Campaign", "Transform your business", "Revolutionise", "Unlock success", "Unlock your potential", "Discover the best", "Join thousands" or similar.
- NEVER invent offers, discounts, free items, loans, BNPL, guarantees, same-day service, or limited-time deals unless the explicit offer above includes them.
- ALWAYS explain what the business does, who it helps, and why the customer should act.
- ALWAYS ground claims in the business evidence and brief above.
- NEVER use placeholders like [Your Business], YourBrandName, [Company] or [Product].
- If the location is South Africa, use South African Rand (R) only if a real price exists in the offer.

Return strict JSON matching the provided schema. Every field must be present. Use null for missing optional values.`;
}

function normaliseArchitectOutput(raw: any, ctx: ValidationContext): CampaignMessagePack {
  const o = raw || {};
  const footer = o.footerContact || {};
  const pack: CampaignMessagePack = {
    headline: sanitize(o.headline) || buildDeterministicMessagePack(ctx).headline,
    subheadline: sanitize(o.subheadline) || "",
    benefitBullets: Array.isArray(o.benefitBullets) ? o.benefitBullets.map(String).filter(Boolean) : [],
    cta: sanitize(o.cta) || expectedCtasForCategory(detectBusinessCategory(ctx))[0],
    footerContact: {
      phone: sanitize(footer.phone) || undefined,
      whatsapp: sanitize(footer.whatsapp) || undefined,
      email: sanitize(footer.email) || undefined,
      website: sanitize(footer.website) || undefined,
      location: sanitize(footer.location) || ctx.location,
    },
    proofPoints: Array.isArray(o.proofPoints) ? o.proofPoints.map(String).filter(Boolean) : undefined,
    platformCaptions: Array.isArray(o.platformCaptions)
      ? o.platformCaptions
          .map((c: any) => ({
            platform: sanitize(c.platform) || "",
            caption: sanitize(c.caption) || "",
            cta: sanitize(c.cta) || "",
            hashtags: Array.isArray(c.hashtags) ? c.hashtags.map(String).filter(Boolean) : [],
          }))
          .filter((c: PlatformCaption) => c.platform)
      : [],
    validation: { passed: false, score: 0, rejections: [], warnings: [] },
  };
  pack.validation = validateCampaignCopy(pack, ctx);
  return pack;
}

export async function buildApprovedMessagePack(
  opts: BuildApprovedMessagePackOptions
): Promise<CampaignMessagePack> {
  const db = getDb();
  const { userId, campaignId, skipBilling, maxAttempts = 2 } = opts;

  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign) throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });

  let business: any = null;
  if (campaign.businessId) {
    const [b] = await db.select().from(businesses).where(eq(businesses.id, campaign.businessId)).limit(1);
    business = b;
  }
  if (!business) business = {};

  const ctx = buildValidationContext(business, campaign);
  const platforms = (campaign.platforms || "Instagram, Facebook, TikTok, LinkedIn")
    .split(/[,;]+/)
    .map((p: string) => p.trim())
    .filter(Boolean);

  let attempt = 0;
  let lastPack: CampaignMessagePack | undefined;
  let prompt = architectPrompt(ctx, platforms);

  while (attempt < maxAttempts) {
    attempt++;
    logInfo("[CampaignMessageArchitect] building message pack", {
      campaignId,
      userId,
      attempt,
      skipBilling: !!skipBilling,
    });

    let raw: any;
    try {
      const result = await runAgent({
        userId,
        campaignId,
        agentType: "creative",
        prompt,
        schema: ArchitectOutputSchema,
        system:
          "You are a senior conversion copywriter. You write tight, business-specific campaign copy. Never use generic marketing filler. Never invent offers. Always return valid JSON matching the schema exactly.",
        skipBilling,
      });
      raw = result.output;
    } catch (err: any) {
      logError("[CampaignMessageArchitect] LLM generation failed", {
        campaignId,
        userId,
        attempt,
        error: err.message,
      });
      if (attempt === maxAttempts) {
        // Fallback to deterministic pack
        lastPack = buildDeterministicMessagePack(ctx);
        break;
      }
      continue;
    }

    const pack = normaliseArchitectOutput(raw, ctx);
    lastPack = pack;

    if (pack.validation.passed) {
      logInfo("[CampaignMessageArchitect] message pack approved", {
        campaignId,
        userId,
        score: pack.validation.score,
      });
      break;
    }

    logWarn("[CampaignMessageArchitect] message pack rejected", {
      campaignId,
      userId,
      attempt,
      rejections: pack.validation.rejections,
      warnings: pack.validation.warnings,
    });

    if (attempt < maxAttempts) {
      prompt = `${prompt}\n\nPREVIOUS ATTEMPT FAILED QUALITY CHECK. FIX THESE ISSUES AND REGENERATE:\n${pack.validation.rejections
        .map((r) => `- ${r}`)
        .join("\n")}\n\nAlso address warnings where possible. Never invent offers or use generic phrases.`;
    }
  }

  if (!lastPack) {
    lastPack = buildDeterministicMessagePack(ctx);
  }

  // Even if validation still fails, we return the pack but callers should check validation.passed.
  return lastPack;
}

// ─── Storage / retrieval helpers ───

export async function loadApprovedMessagePack(campaignId: number): Promise<CampaignMessagePack | null> {
  const db = getDb();
  const [asset] = await db
    .select({ metadata: campaignAssets.metadata })
    .from(campaignAssets)
    .where(and(eq(campaignAssets.campaignId, campaignId), eq(campaignAssets.assetType, "message_pack" as any)))
    .orderBy(desc(campaignAssets.createdAt))
    .limit(1);

  if (!asset?.metadata) return null;
  const meta = asset.metadata as any;
  if (meta?.approvedMessagePack) {
    return meta.approvedMessagePack as CampaignMessagePack;
  }
  return null;
}

export async function saveApprovedMessagePack(
  userId: number,
  campaignId: number,
  pack: CampaignMessagePack
): Promise<void> {
  const db = getDb();
  await db.insert(campaignAssets).values({
    userId,
    campaignId,
    assetType: "message_pack" as any,
    title: "Approved Campaign Message Pack",
    status: "ready",
    metadata: {
      approvedMessagePack: pack,
      generatedAt: new Date().toISOString(),
      score: pack.validation.score,
      passed: pack.validation.passed,
    } as any,
  });

  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (campaign) {
    const workflowContext = (campaign.workflowContext || {}) as any;
    await db
      .update(campaigns)
      .set({
        workflowContext: {
          ...workflowContext,
          approvedMessagePack: pack,
          approvedMessagePackAt: new Date().toISOString(),
        } as any,
      })
      .where(eq(campaigns.id, campaignId));
  }
}

export async function ensureApprovedMessagePack(
  opts: BuildApprovedMessagePackOptions
): Promise<CampaignMessagePack> {
  const existing = await loadApprovedMessagePack(opts.campaignId);
  if (existing && existing.validation?.passed) {
    logInfo("[CampaignMessageArchitect] reusing approved message pack", {
      campaignId: opts.campaignId,
      userId: opts.userId,
    });
    return existing;
  }
  const pack = await buildApprovedMessagePack(opts);
  if (pack.validation.passed) {
    await saveApprovedMessagePack(opts.userId, opts.campaignId, pack);
  }
  return pack;
}
