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
import { eq, and, desc, asc } from "drizzle-orm";
import { logInfo, logWarn, logError } from "../logger";
import { safeText } from "./brand-palette";
import {
  ctaMatchesSelectedStage,
  extractFunnelCtaMap as extractFunnelCtaMapShared,
  normalizeFunnelStage,
  selectStageCta,
} from "./cta-utils";
import {
  runShadowMessageApproval,
} from "./message-approval/shadow-runner";
import {
  type CanaryApprovalProof,
  type MessageApprovalContextLock,
  type MessageAssessment,
  type MessagePackCandidate,
  type V2ApprovalEnvelope,
} from "./message-approval/contracts";
import { evaluateMessageCandidate } from "./message-approval/evaluator";
import { adaptLegacyMessagePack } from "./message-approval/legacy-adapter";
import { createMessagePackCandidate } from "./message-approval/candidate";
import { createApprovedMessagePack } from "./message-approval/approve";
import {
  computeEvaluationKey,
} from "./message-approval/hash";
import { resolveCanarySelection, type CanarySelectionResult } from "./message-approval/canary-selector";
import { adaptApprovedToCampaignMessagePack } from "./message-approval/compatibility-adapter";
import { type LegacyLoadedShadowContextInput } from "./message-approval/integration/legacy-shadow-context";
import { buildMessageApprovalContextLock } from "./message-approval/context-lock";
import { verifyCanaryApprovalProof } from "./message-approval/canary-proof";
import {
  computeCreativeBriefFingerprint,
  isApprovedMessagePackCompatible,
} from "./brief-grounding";
import {
  extractApprovedStrategyLineage,
  observeIfEnabled,
  resolveExpectedApprovedStrategyFingerprint,
} from "./contracts/observe-quality-authority";

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

export type MessagePackSource =
  | "user_structured_copy"
  | "ai_refined_pack"
  | "fallback_user_pack"
  | "fallback_deterministic"
  | "latest_message_pack"
  | "stale_metadata"
  | "manual_restore";

export interface CampaignMessagePack {
  headline: string;
  subheadline: string;
  benefitBullets: string[];
  cta: string;
  footerContact: FooterContact;
  proofPoints?: string[];
  platformCaptions: PlatformCaption[];
  validation: CopyValidationResult;
  /** Where this pack came from. Used when ranking multiple saved packs. */
  messagePackSource?: MessagePackSource;
  /** True if the headline/CTA contain generic marketing filler. */
  isGeneric?: boolean;
  /** Higher is more specific/business-focused. */
  specificityScore?: number;
  /** Set when a newer, better pack replaces this one. */
  supersededBy?: number;
  /** Set when this pack was explicitly invalidated and should never be reused. */
  invalidatedAt?: string;
  invalidationReason?: string;
  /** Additive Slice 2 canary approval identity metadata. */
  v2ApprovalEnvelope?: V2ApprovalEnvelope;
  /** Stable fingerprint of the campaign brief that produced this pack. */
  creativeBriefFingerprint?: string;
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
  campaignObjective?: string;
  funnelStage?: "awareness" | "consideration" | "conversion" | "retention";
  /**
   * Optional raw refinement instruction. When provided, the validator may
   * extract additional target-customer and pain-point terms from it so the
   * user's explicit copy is not rejected just because it differs from the
   * original campaign brief.
   */
  refinementInstruction?: string;
}

export function extractFunnelCtaMap(raw: string | null | undefined): Record<"awareness" | "consideration" | "conversion" | "retention", string> {
  return extractFunnelCtaMapShared(raw);
}

export function selectFunnelCta(raw: string | null | undefined, objectiveOrStage?: string | null): string {
  return selectStageCta(raw, objectiveOrStage);
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
  "streamlined financial solutions",
  "comprehensive solutions",
  "grow and succeed",
];

const EXPLICITLY_BANNED_PROMPT_PHRASES = [
  "your business",
  "transform your business",
  "revolutionize your business",
  "streamlined financial solutions",
  "comprehensive solutions",
  "grow and succeed",
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

export const GENERIC_HEADLINE_PATTERNS = [
  /seamless\s+\w+\s+solutions?/i,
  /modern\s+\w+\s+solutions?/i,
  /financial\s+solutions?/i,
  /solutions?\s+for\s+modern\s+businesses?/i,
  /transform\s+your\s+business/i,
  /transform\s+how\s+you/i,
  /unlock\s+success/i,
  /unlock\s+your\s+potential/i,
  /unlock\s+new\s+possibilities/i,
  /best\s+choice\s+for\s+your\s+business/i,
  /empower\s+your\s+business/i,
  /elevate\s+your\s+business/i,
  /your\s+business\s+with/i,
  /your\s+business\s+to/i,
  /for\s+modern\s+businesses?/i,
];

const DETERMINISTIC_FALLBACK_MIN_APPROVAL_SCORE = 85;

export function isGenericHeadline(headline: string): boolean {
  if (!headline) return true;
  return GENERIC_HEADLINE_PATTERNS.some((p) => p.test(headline));
}

export function isGenericCta(cta: string): boolean {
  if (!cta) return true;
  return GENERIC_CTA_PATTERNS.some((p) => p.test(cta));
}

export function specificityScore(pack: CampaignMessagePack): number {
  const allCopy = [pack.headline, pack.subheadline, ...pack.benefitBullets, pack.cta].join(" ");
  let score = 0;
  // Reward length and concrete long words.
  score += allCopy.length / 8;
  score += (allCopy.match(/\b\w{6,}\b/g) || []).length * 2;
  score += pack.benefitBullets.length * 4;
  // Penalise generic marketing filler.
  if (isGenericHeadline(pack.headline)) score -= 50;
  if (isGenericCta(pack.cta)) score -= 35;
  for (const phrase of GENERIC_PHRASES) {
    if (allCopy.toLowerCase().includes(phrase)) score -= 12;
  }
  // Reward business-specific punctuation-free specificity: numbers, Rand, times.
  score += (allCopy.match(/\b(R\d+|\d+\s*(min|minutes|hours|days|%))\b/gi) || []).length * 8;
  return Math.max(0, Math.round(score));
}

function normalizeGenericText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasGenericPlaceholderLanguage(pack: CampaignMessagePack): boolean {
  const allCopy = normalizeGenericText(
    [
      pack.headline,
      pack.subheadline,
      ...(Array.isArray(pack.benefitBullets) ? pack.benefitBullets : []),
      pack.cta,
      ...(Array.isArray(pack.platformCaptions)
        ? pack.platformCaptions.map((c) =>
            c
              ? `${c.platform || ""} ${c.caption || ""} ${c.cta || ""} ${Array.isArray(c.hashtags) ? c.hashtags.join(" ") : ""}`
              : ""
          )
        : []),
      ...(Array.isArray(pack.proofPoints) ? pack.proofPoints : []),
    ].join(" ")
  );
  return GENERIC_PLACEHOLDERS.some((placeholder) => allCopy.includes(normalizeGenericText(placeholder)));
}

export function isGenericPack(pack: CampaignMessagePack): boolean {
  return isGenericHeadline(pack.headline) || isGenericCta(pack.cta) || hasGenericPlaceholderLanguage(pack);
}

function normaliseValidationResult(validation?: CopyValidationResult): CopyValidationResult {
  const v = validation || ({ passed: false, score: 0, rejections: [], warnings: [] } as CopyValidationResult);
  return {
    passed: Boolean(v.passed),
    score: Number.isFinite(Number(v.score)) ? Number(v.score) : 0,
    rejections: Array.isArray(v.rejections) ? v.rejections.map((r) => String(r)) : [],
    warnings: Array.isArray(v.warnings) ? v.warnings.map((w) => String(w)) : [],
  };
}

function isApprovedDeterministicFallback(pack: CampaignMessagePack): boolean {
  const validation = normaliseValidationResult(pack.validation);
  return (
    pack.messagePackSource === "fallback_deterministic" &&
    validation.passed &&
    validation.score >= DETERMINISTIC_FALLBACK_MIN_APPROVAL_SCORE &&
    validation.rejections.length === 0
  );
}

function deriveGenericityFromFinalCopy(pack: CampaignMessagePack): boolean {
  // A deterministic fallback that fully passes validation is treated as non-generic.
  if (isApprovedDeterministicFallback(pack)) return false;
  return isGenericPack(pack);
}

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
  | "trades"
  | "education"
  | "healthcare"
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
  if (/\b(plumb|plumber|plumbing|electrical|electrician|handyman|builder|building|carpenter|carpentry|roofer|roofing|tiler|tiling|painter|painting|hvac|aircon|air conditioning|garden|landscap|pool|security|locksmith)\b/.test(haystack)) return "trades";
  if (/\b(education|training|course|tutor|school|academy|learn|learning|workshop|coaching|bootcamp|coding course)\b/.test(haystack)) return "education";
  if (/\b(health|wellness|therapy|physio|chiro|diet|nutrition|yoga|pilates|meditation|massage|care|clinic)\b/.test(haystack)) return "healthcare";
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
    case "trades":
      return ["Request a Quote", "Book a Call-Out", "Get an Estimate", "Contact Us"];
    case "education":
      return ["Enrol Now", "Book a Session", "View Courses", "Get More Info"];
    case "healthcare":
      return ["Book a Session", "Schedule a Consultation", "Get in Touch", "View Services"];
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
    const cleaned = sanitize(source).toLowerCase();
    const chunks = cleaned
      .split(/[,;|]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 3);
    for (const chunk of chunks) {
      terms.add(chunk);
      chunk
        .split(/\s+(?:and|or|with|for)\s+|\//)
        .map((t) => t.trim())
        .filter((t) => t.length > 3)
        .forEach((t) => terms.add(t));
    }
  };
  addTerms(ctx.productOrService);
  (ctx.websiteEvidence?.productsServices || []).forEach(addTerms);
  return Array.from(terms);
}

function extractGroundedServiceTerms(ctx: ValidationContext): string[] {
  const genericStopWords = new Set([
    "business",
    "services",
    "service",
    "solutions",
    "solution",
    "platform",
    "support",
    "quality",
    "professional",
    "trusted",
    "local",
    "modern",
  ]);

  const terms = new Set<string>();
  const add = (value?: string) => {
    if (!value) return;
    const cleaned = sanitize(value).toLowerCase();
    if (!cleaned) return;
    const chunks = cleaned
      .split(/[,;|]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 3);

    for (const chunk of chunks) {
      terms.add(chunk);
      chunk
        .split(/\s+(?:and|or|with|for)\s+|\//)
        .map((t) => t.trim())
        .filter((t) => t.length > 3 && !genericStopWords.has(t))
        .forEach((t) => terms.add(t));
    }
  };

  add(ctx.productOrService);
  (ctx.websiteEvidence?.productsServices || []).forEach(add);
  return Array.from(terms).filter((t) => t.length > 3 && !genericStopWords.has(t));
}

function extractQuotedPhrases(issues: string[]): string[] {
  const phrases = new Set<string>();
  for (const issue of issues) {
    const matches = issue.match(/"([^"]+)"/g) || [];
    for (const m of matches) {
      const cleaned = sanitize(m.replace(/^"|"$/g, ""));
      if (cleaned) phrases.add(cleaned);
    }
  }
  return Array.from(phrases);
}

function sanitiseGroundedCapability(value: string): string {
  let clean = sanitize(value);
  if (!clean) return "";

  const lower = clean.toLowerCase();
  if (EXPLICITLY_BANNED_PROMPT_PHRASES.some((p) => lower.includes(p.toLowerCase()))) {
    return "";
  }

  // Drop category headings and slogans that are not actionable capabilities.
  if (/(comprehensive|streamlined|modern|trusted|premium)\s+(financial\s+)?solutions?/i.test(clean)) return "";
  if (/(transform|grow|succeed|dignifying|empower)\b/i.test(clean) && !/(payout|disbursement|settlement|commission|tip|reconciliation|supplier|delivery)/i.test(clean)) {
    return "";
  }
  if (/^zuto\s*hub$/i.test(clean) || /^zurohub$/i.test(clean)) return "";

  clean = clean.replace(/[.!?]+$/g, "").trim();
  return clean;
}

function isActionableCapability(value: string): boolean {
  const clean = sanitize(value).toLowerCase();
  if (!clean || clean.length < 8) return false;
  if (/(your\s+business|transform\s+your\s+business|comprehensive\s+solutions|grow\s+and\s+succeed)/i.test(clean)) return false;

  return /(payout|disbursement|settlement|commission|tip|reconciliation|supplier|delivery|tracking|payroll|payments?)/i.test(clean);
}

function buildGroundedFacts(ctx: ValidationContext): {
  businessName: string;
  industry: string;
  productOrService: string;
  targetCustomers: string[];
  capabilities: string[];
  selectedStageCta: string;
} {
  const targetCustomers = [
    ...(ctx.websiteEvidence?.targetCustomers || []),
    ctx.targetCustomer || "",
  ]
    .flatMap((v) => sanitize(v).split(/[,;|]+/))
    .map((t) => t.trim())
    .filter((t, i, arr) => t.length > 2 && arr.indexOf(t) === i)
    .slice(0, 6);

  const capabilities = [
    ...(ctx.websiteEvidence?.productsServices || []),
    ctx.productOrService || "",
  ]
    .flatMap((v) => sanitize(v).split(/[,;|]+/))
    .map((t) => sanitiseGroundedCapability(t.trim()))
    .filter((t, i, arr) => t.length > 3 && arr.indexOf(t) === i)
    .filter((t) => isActionableCapability(t))
    .slice(0, 8);

  return {
    businessName: String(ctx.businessName || "").trim() || "Not specified",
    industry: sanitize(ctx.industry || ctx.websiteEvidence?.businessCategory) || "Not specified",
    productOrService: sanitiseGroundedCapability(sanitize(ctx.productOrService)) || sanitize(ctx.productOrService) || "Not specified",
    targetCustomers,
    capabilities,
    selectedStageCta: selectFunnelCta(ctx.preferredCta, ctx.funnelStage || ctx.campaignObjective),
  };
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
  // Allow the user's refinement instruction to supply additional customer
  // segments so explicit structured copy is not blocked by the original brief.
  if (ctx.refinementInstruction) {
    const instruction = sanitize(ctx.refinementInstruction).toLowerCase();
    // Extract likely audience phrases that appear after customer-facing labels.
    const audiencePatterns = /(?:for|to|target|audience|customer|teams?)\s*[:\-—]?\s*([^.\n]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = audiencePatterns.exec(instruction)) !== null) {
      match[1]
        .split(/[,;]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 3)
        .forEach((t) => terms.add(t));
    }
  }
  return Array.from(terms);
}

function extractPainPointTerms(ctx: ValidationContext): string[] {
  const terms = new Set<string>();
  const addTerms = (source?: string) => {
    if (!source) return;
    source
      .split(/[,;]+/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 3)
      .forEach((t) => terms.add(t));
  };
  addTerms(ctx.mainPainPoint);
  // Allow the user's refinement instruction to supply additional pain/outcome
  // language so explicit structured copy is not blocked by the original brief.
  if (ctx.refinementInstruction) {
    const instruction = sanitize(ctx.refinementInstruction).toLowerCase();
    const painPatterns = /(?:pain|problem|frustration|delay|wait|stop|avoid|manual|reconciliation|settlement|admin)\s*[:\-—]?\s*([^.\n]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = painPatterns.exec(instruction)) !== null) {
      match[1]
        .split(/[,;]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 3)
        .forEach((t) => terms.add(t));
    }
  }
  return Array.from(terms);
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

  // 2b. Must mention at least one grounded service/use-case from evidence.
  const groundedServiceTerms = extractGroundedServiceTerms(ctx);
  const hasGroundedService = groundedServiceTerms.some((t) => termMatches(allCopy, t));
  if (!hasGroundedService && groundedServiceTerms.length > 0) {
    rejections.push("Copy must mention at least one real service or use case from business evidence.");
    score -= 30;
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
  const selectedPreferredCta = selectFunnelCta(ctx.preferredCta, ctx.funnelStage || ctx.campaignObjective);
  const matchesPreferred = ctaMatchesSelectedStage({
    cta,
    preferredCta: ctx.preferredCta,
    objectiveOrStage: ctx.funnelStage || ctx.campaignObjective,
  });
  const isGenericCta = GENERIC_CTA_PATTERNS.some((p) => p.test(cta));
  const isGenericHead = isGenericHeadline(pack.headline);
  if (isGenericHead) {
    rejections.push(`Headline "${sanitize(pack.headline)}" is too generic for this business context.`);
    score -= 30;
  }
  if (isGenericCta && !matchesPreferred) {
    rejections.push(`CTA "${cta}" is too generic for this business type.`);
    score -= 30;
  }
  const matchesExpected = expectedCtas.some((expected) => cta.toLowerCase().includes(expected.toLowerCase()));

  // The preferred CTA field sometimes contains a funnel-stage strategy list
  // (e.g. "Awareness: Learn more... Consideration: Join... Conversion: Get started...").
  // Treat that as a set of acceptable CTAs rather than one exact required string.
  if (!matchesExpected && !matchesPreferred && expectedCtas.length > 0) {
    warnings.push(`CTA "${cta}" may not match the expected action for a ${category} business (${expectedCtas.join(", ")}).`);
    score -= 10;
  }
  // Preferred CTA wins if provided
  if (ctx.preferredCta && !matchesPreferred) {
    warnings.push(`CTA does not reflect the preferred CTA for this campaign stage: "${selectedPreferredCta}".`);
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
  const concreteBusinessTerms = [...productTerms, ...painTerms, ...customerTerms].filter((t) => t.length > 3);
  const hasConcreteBenefit =
    concreteMarkers.test(benefitText) ||
    concreteBusinessTerms.some((term) => termMatches(benefitText, term));
  if (!hasConcreteBenefit) {
    rejections.push("Benefit bullets are too generic. Add concrete customer outcomes grounded in the business context.");
    score -= 20;
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
  const pain = sanitize(ctx.mainPainPoint) || "reduce manual administration";
  const offer = hasExplicitOffer(ctx) ? sanitize(ctx.offerDetails) : "";
  const location = sanitize(ctx.location) || sanitize(ctx.websiteEvidence?.location);
  const cta = ctx.preferredCta
    ? selectFunnelCta(ctx.preferredCta, ctx.funnelStage || ctx.campaignObjective)
    : expectedCtasForCategory(category)[0];

  const groundedFacts = buildGroundedFacts(ctx);
  const capabilities = groundedFacts.capabilities.length > 0 ? groundedFacts.capabilities : [product];
  const targetCustomers = groundedFacts.targetCustomers.length > 0 ? groundedFacts.targetCustomers : [customer];

  let headline = category === "fintech" ? "Simplify Staff and Business Payouts" : `Simplify ${product}`;
  let subheadline = `${groundedFacts.businessName} helps ${targetCustomers.slice(0, 2).join(" and ").toLowerCase()} manage ${capabilities
    .slice(0, 2)
    .join(" and ")
    .toLowerCase()} with less manual reconciliation.`;

  if (offer) {
    headline = `${product} — ${offer}`;
    subheadline = `Built for ${customer.toLowerCase()} who want ${pain.toLowerCase()} without the usual hassle.`;
  }

  // Avoid campaign/business name headline
  if (isHeadlineCampaignNameOnly(headline, ctx)) {
    headline = `Reliable ${product} for ${customer}`;
  }

  const capabilityA = sanitize(capabilities[0] || product);
  const capabilityB = sanitize(capabilities[1] || "restaurant and supplier payouts");
  const capabilityC = sanitize(capabilities[2] || "payout tracking and reconciliation");

  const benefitBullets = [
    `Manage ${capabilityA.toLowerCase()} from one platform.`,
    `Streamline ${capabilityB.toLowerCase()} with less manual administration.`,
    `Track ${capabilityC.toLowerCase()}${location ? ` for teams in ${location}` : ""}.`,
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
  forceRebuild?: boolean;
  qualityIssues?: string[];
  onLegacyContextLoaded?: (context: LegacyLoadedShadowContextInput) => void;
  resolvedAuthority?: ResolvedArchitectAuthority;
  privacyMode?: "standard" | "safe";
}

function isSafeLoggingMode(mode: BuildApprovedMessagePackOptions["privacyMode"]): boolean {
  return mode === "safe";
}

function buildValidationContext(business: any, campaign: any): ValidationContext {
  const evidence = (business?.websiteEvidence || {}) as any;
  const firstFunnelStage = Array.isArray(campaign?.funnelStages) && campaign.funnelStages.length > 0
    ? sanitize(campaign.funnelStages[0]?.stage)
    : "";
  const authoritativeBusinessName = sanitize(business?.name);
  const campaignProductOrService =
    sanitiseGroundedCapability(sanitize(campaign?.productOrService)) || sanitize(campaign?.productOrService);
  const businessProductOrService =
    sanitiseGroundedCapability(sanitize(business?.productOrService)) || sanitize(business?.productOrService);
  return {
    businessName: authoritativeBusinessName,
    campaignName: sanitize(campaign?.name),
    productOrService: campaignProductOrService || businessProductOrService,
    targetCustomer: sanitize(campaign?.targetBuyer || business?.targetCustomer || business?.targetAudience),
    mainPainPoint: sanitize(campaign?.mainPainPoint),
    offerDetails: sanitize(campaign?.offerDetails),
    excludedOffers: sanitize(campaign?.excludedOffers || business?.avoidWords),
    preferredCta: sanitize(campaign?.preferredCta || campaign?.ctaStrategy),
    campaignObjective: sanitize(campaign?.goal || campaign?.primaryOutcome),
    funnelStage: normalizeFunnelStage(firstFunnelStage || sanitize(campaign?.primaryOutcome || campaign?.goal)),
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
  const groundedFacts = buildGroundedFacts(ctx);
  const groundedCapabilities = groundedFacts.capabilities.length > 0 ? groundedFacts.capabilities : [ctx.productOrService];
  const selectedStageCta = groundedFacts.selectedStageCta || "Learn More";

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
- Campaign stage CTA: ${selectedStageCta}
- Exclusions (never use): ${ctx.excludedOffers || "None"}
- Platforms: ${platforms.join(", ")}

GROUNDED FACTS (MUST BE REFLECTED IN COPY):
- Business: ${groundedFacts.businessName}
- Industry: ${groundedFacts.industry}
- Product/service: ${groundedFacts.productOrService}
- Target customers: ${(groundedFacts.targetCustomers || []).join(", ") || "Not specified"}
- Core capabilities:
${groundedCapabilities.map((cap) => `  - ${cap}`).join("\n")}

You must mention at least one core capability above in the headline, subheadline, benefits or platform captions.

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
- EXPLICITLY BANNED PHRASES:
${EXPLICITLY_BANNED_PROMPT_PHRASES.map((p) => `  - ${p}`).join("\n")}
- NEVER invent offers, discounts, free items, loans, BNPL, guarantees, same-day service, or limited-time deals unless the explicit offer above includes them.
- ALWAYS explain what the business does, who it helps, and why the customer should act.
- ALWAYS ground claims in the business evidence and brief above.
- NEVER invent percentages, savings rates, speed claims, or performance claims unless directly supported by provided evidence.
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

async function buildApprovedMessagePackLegacy(
  opts: BuildApprovedMessagePackOptions
): Promise<CampaignMessagePack> {
  const db = getDb();
  const { userId, campaignId, skipBilling, maxAttempts = 2 } = opts;
  const safeLogging = isSafeLoggingMode(opts.privacyMode);

  const preloadedContext = opts.resolvedAuthority?.loadedContext;
  let campaign = preloadedContext?.campaign as any;
  let business = (preloadedContext?.business || null) as any;

  if (!campaign || !campaign.id) {
    const [loadedCampaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!loadedCampaign) throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
    campaign = loadedCampaign;

    if (loadedCampaign.businessId) {
      const [b] = await db.select().from(businesses).where(eq(businesses.id, loadedCampaign.businessId)).limit(1);
      business = b;
    }
  }

  if (!business) business = {};

  const ctx = buildValidationContext(business, campaign);
  opts.onLegacyContextLoaded?.({
    campaignId,
    business,
    campaign,
    validationContext: {
      businessName: ctx.businessName,
      industry: ctx.industry,
      productOrService: ctx.productOrService,
      targetCustomer: ctx.targetCustomer,
      mainPainPoint: ctx.mainPainPoint,
      campaignObjective: ctx.campaignObjective,
      funnelStage: ctx.funnelStage,
      preferredCta: ctx.preferredCta,
    },
  });
  const platforms = (campaign.platforms || "Instagram, Facebook, TikTok, LinkedIn")
    .split(/[,;]+/)
    .map((p: string) => p.trim())
    .filter(Boolean);

  let attempt = 0;
  let lastPack: CampaignMessagePack | undefined;
  let usedDeterministicFallback = false;
  const basePrompt = architectPrompt(ctx, platforms);
  let prompt = basePrompt;
  let retryQualityIssues: string[] = [];
  const groundedFactsUsed = buildGroundedFacts(ctx);

  // Slice 1 observation: compare legacy-selected CTA with the new CreativeContract authority.
  // This block must not change the returned pack or any persisted state.
  {
    const workflowContext = (campaign?.workflowContext || {}) as Record<string, unknown>;
    const lineage = extractApprovedStrategyLineage(workflowContext, campaignId, userId);
    observeIfEnabled("campaign message architect observation", {
      campaignId,
      userId,
      businessId: Number.isFinite(Number(business?.id || campaign.businessId))
        ? Number(business?.id || campaign.businessId)
        : 0,
      lineage,
      expectedApprovedStrategyFingerprint: resolveExpectedApprovedStrategyFingerprint(workflowContext),
      funnelStage: ctx.funnelStage || normalizeFunnelStage(ctx.campaignObjective),
      campaignInputCta: ctx.preferredCta || null,
      offerActionCta: null,
      targetAudience: ctx.targetCustomer || "",
      offer: ctx.offerDetails || null,
      businessCapabilities: ctx.websiteEvidence?.productsServices || [],
      legacySelectedCta: groundedFactsUsed.selectedStageCta || "",
    });
  }

  while (attempt < maxAttempts) {
    attempt++;
    logInfo("[CampaignMessageArchitect] building message pack", safeLogging
      ? {
          campaignId,
          attempt,
          skipBilling: !!skipBilling,
          stageCode: "legacy_build_attempt",
          status: "started",
        }
      : {
          campaignId,
          userId,
          attempt,
          skipBilling: !!skipBilling,
          selectedStageCta: groundedFactsUsed.selectedStageCta,
          groundedFactsUsed,
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
    } catch {
      logError("[CampaignMessageArchitect] LLM generation failed", safeLogging
        ? {
            campaignId,
            attempt,
            errorCode: "CREATIVE_GENERATION_FAILED",
            stageCode: "legacy_build_run_agent",
            status: "failed",
          }
        : {
            campaignId,
            userId,
            attempt,
            errorCode: "CREATIVE_GENERATION_FAILED",
            stageCode: "legacy_build_run_agent",
          });
      if (attempt === maxAttempts) {
        // Fallback to deterministic pack
        usedDeterministicFallback = true;
        lastPack = buildDeterministicMessagePack(ctx);
        break;
      }
      continue;
    }

    const pack = normaliseArchitectOutput(raw, ctx);
    lastPack = pack;

    if (pack.validation.passed) {
      logInfo("[CampaignMessageArchitect] message pack approved", safeLogging
        ? {
            campaignId,
            attempt,
            score: pack.validation.score,
            passed: true,
            stageCode: "legacy_build_validation",
          }
        : {
            campaignId,
            userId,
            score: pack.validation.score,
          });
      break;
    }

    logWarn("[CampaignMessageArchitect] message pack rejected", safeLogging
      ? {
          campaignId,
          attempt,
          passed: false,
          stageCode: "legacy_build_validation",
          rejectionCount: pack.validation.rejections.length,
          warningCount: pack.validation.warnings.length,
        }
      : {
          campaignId,
          userId,
          attempt,
          rejections: pack.validation.rejections,
          warnings: pack.validation.warnings,
        });

    retryQualityIssues = [...pack.validation.rejections, ...pack.validation.warnings];

    if (attempt < maxAttempts) {
      const rejectedPhrases = extractQuotedPhrases(retryQualityIssues);
      logInfo("[CampaignMessageArchitect] retrying message pack generation", safeLogging
        ? {
            campaignId,
            attempt,
            stageCode: "legacy_build_retry",
            retryIssueCount: retryQualityIssues.length,
            rejectedPhraseCount: rejectedPhrases.length,
          }
        : {
            campaignId,
            userId,
            attempt,
            retryQualityIssues,
            rejectedPhrases,
          });
      prompt = `${basePrompt}\n\nPREVIOUS ATTEMPT FAILED QUALITY CHECK. FIX THESE EXACT ISSUES AND REGENERATE:\n${pack.validation.rejections
        .map((r) => `- ${r}`)
        .join("\n")}\n\nVALIDATION WARNINGS TO ADDRESS:\n${pack.validation.warnings
        .map((w) => `- ${w}`)
        .join("\n") || "- None"}\n\nEXACT REJECTED PHRASES TO AVOID:\n${rejectedPhrases.map((p) => `- ${p}`).join("\n") || "- None"}\n\nAlso address warnings where possible. Never invent offers or use generic phrases.`;
    }
  }

  if (!lastPack || !lastPack.validation.passed) {
    usedDeterministicFallback = true;
    lastPack = buildDeterministicMessagePack(ctx);
    const fallbackValidation = validateCampaignCopy(lastPack, ctx);
    lastPack.validation = fallbackValidation;
    logInfo("[CampaignMessageArchitect] deterministic fallback generated", safeLogging
      ? {
          campaignId,
          fallbackUsed: true,
          stageCode: "legacy_build_deterministic_fallback",
          fallbackValidationScore: fallbackValidation.score,
          fallbackValidationRejectionCount: fallbackValidation.rejections.length,
          retryIssueCount: retryQualityIssues.length,
          passed: fallbackValidation.passed,
        }
      : {
          campaignId,
          userId,
          fallbackUsed: true,
          fallbackValidationScore: fallbackValidation.score,
          fallbackValidationRejections: fallbackValidation.rejections,
          retryQualityIssues,
          groundedFactsUsed,
          selectedStageCta: groundedFactsUsed.selectedStageCta,
        });
  }

  lastPack.messagePackSource = usedDeterministicFallback ? "fallback_deterministic" : "ai_refined_pack";
  // Even if validation still fails, we return the pack but callers should check validation.passed.
  return lastPack;
}

// ─── Storage / retrieval helpers ───

export function enrichMessagePackMetadata(pack: CampaignMessagePack): CampaignMessagePack {
  const validation = normaliseValidationResult(pack.validation);
  return {
    ...pack,
    validation,
    isGeneric: deriveGenericityFromFinalCopy({ ...pack, validation }),
    specificityScore: specificityScore(pack),
  };
}

export async function loadAllApprovedMessagePacks(
  campaignId: number
): Promise<Array<{ pack: CampaignMessagePack; assetId: number; createdAt: Date }>> {
  const db = getDb();
  const rows = await db
    .select({ id: campaignAssets.id, metadata: campaignAssets.metadata, createdAt: campaignAssets.createdAt })
    .from(campaignAssets)
    .where(and(eq(campaignAssets.campaignId, campaignId), eq(campaignAssets.assetType, "message_pack" as any)))
    .orderBy(desc(campaignAssets.createdAt))
    .limit(1000);

  return rows
    .map((row) => {
      const meta = (row.metadata || {}) as any;
      const pack = meta?.approvedMessagePack as CampaignMessagePack | undefined;
      if (!pack) return null;
      return {
        pack: enrichMessagePackMetadata({
          ...pack,
          messagePackSource: pack.messagePackSource || meta.messagePackSource || "ai_refined_pack",
          invalidatedAt: pack.invalidatedAt || meta.invalidatedAt,
          invalidationReason: pack.invalidationReason || meta.invalidationReason,
        }),
        assetId: row.id,
        createdAt: new Date(row.createdAt || Date.now()),
      };
    })
    .filter(Boolean) as Array<{ pack: CampaignMessagePack; assetId: number; createdAt: Date }>;
}

const SOURCE_RANK: Record<MessagePackSource, number> = {
  user_structured_copy: 1,
  fallback_user_pack: 2,
  manual_restore: 3,
  ai_refined_pack: 4,
  fallback_deterministic: 5,
  latest_message_pack: 6,
  stale_metadata: 7,
};

export function selectBestApprovedMessagePack(
  items: Array<{ pack: CampaignMessagePack; assetId: number; createdAt: Date }>
): CampaignMessagePack | null {
  if (!items.length) return null;

  const activeItems = items.filter((item) => !item.pack.invalidatedAt);
  if (!activeItems.length) return null;

  const scored = activeItems.map((item) => {
    const pack = item.pack;
    const sourceRank = SOURCE_RANK[pack.messagePackSource || "ai_refined_pack"] ?? 99;
    const genericPenalty = pack.isGeneric ? 10_000 : 0;
    const passedBonus = pack.validation?.passed ? 0 : 5_000;
    const score = pack.validation?.score ?? 0;
    const specificity = pack.specificityScore ?? 0;
    const total = genericPenalty + passedBonus + sourceRank * 100 - score - specificity * 2;
    return { item, pack, total };
  });

  scored.sort((a, b) => {
    if (a.total !== b.total) return a.total - b.total;
    // Tie-break: newer first, then higher specificity.
    const dateDiff = b.item.createdAt.getTime() - a.item.createdAt.getTime();
    if (dateDiff !== 0) return dateDiff;
    return (b.pack.specificityScore ?? 0) - (a.pack.specificityScore ?? 0);
  });

  return scored[0].pack;
}

export async function loadApprovedMessagePack(campaignId: number): Promise<CampaignMessagePack | null> {
  const items = await loadAllApprovedMessagePacks(campaignId);
  const best = selectBestApprovedMessagePack(items);
  if (best) {
    logInfo("[CampaignMessageArchitect] selected best approved message pack", {
      campaignId,
      source: best.messagePackSource,
      isGeneric: best.isGeneric,
      specificityScore: best.specificityScore,
      validationScore: best.validation?.score,
    });
  }
  return best;
}

export async function saveApprovedMessagePack(
  userId: number,
  campaignId: number,
  pack: CampaignMessagePack,
  options?: { mode?: "legacy" | "canary"; proof?: CanaryApprovalProof }
): Promise<number> {
  const db = getDb();
  const saveMode = options?.mode || "legacy";

  // Ground the pack to the current campaign brief so later edits can detect
  // stale approved packs without a schema migration.
  const [campaignForFingerprint] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  const creativeBriefFingerprint = campaignForFingerprint
    ? computeCreativeBriefFingerprint(campaignForFingerprint)
    : pack.creativeBriefFingerprint ?? "";

  const enriched = enrichMessagePackMetadata({
    ...pack,
    creativeBriefFingerprint,
    messagePackSource: pack.messagePackSource || "ai_refined_pack",
    validation: normaliseValidationResult(pack.validation),
  });

  if (saveMode === "canary") {
    if (!options?.proof || !enriched.v2ApprovalEnvelope) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Canary save requires approval proof and envelope." });
    }
    verifyCanaryApprovalProof(enriched, options.proof);
  } else {
    if (!enriched.validation.passed) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Message pack failed validation and cannot be approved.",
      });
    }

    if (enriched.isGeneric) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Generic message packs cannot be approved. Please regenerate with business-specific copy.",
      });
    }
  }

  const [{ insertId }] = await db.insert(campaignAssets).values({
    userId,
    campaignId,
    assetType: "message_pack" as any,
    title: "Approved Campaign Message Pack",
    status: "ready",
    metadata: {
      approvedMessagePack: enriched,
      creativeBriefFingerprint,
      generatedAt: new Date().toISOString(),
      score: enriched.validation.score,
      passed: enriched.validation.passed,
      messagePackSource: enriched.messagePackSource,
      isGeneric: enriched.isGeneric,
      specificityScore: enriched.specificityScore,
      v2ApprovalEnvelope: enriched.v2ApprovalEnvelope,
    } as any,
  });

  // Mark previous generic message packs as superseded by this newer, better pack.
  const previous = await db
    .select({ id: campaignAssets.id, metadata: campaignAssets.metadata })
    .from(campaignAssets)
    .where(and(eq(campaignAssets.campaignId, campaignId), eq(campaignAssets.assetType, "message_pack" as any)))
    .orderBy(asc(campaignAssets.createdAt))
    .limit(1000);

  for (const row of previous) {
    if (row.id === insertId) continue;
    const meta = (row.metadata || {}) as any;
    const previousPack = meta?.approvedMessagePack as CampaignMessagePack | undefined;
    if (previousPack && (previousPack.isGeneric || isGenericPack(previousPack)) && !meta.supersededBy) {
      await db
        .update(campaignAssets)
        .set({
          metadata: {
            ...meta,
            approvedMessagePack: {
              ...previousPack,
              supersededBy: insertId,
            },
            supersededBy: insertId,
          } as any,
        })
        .where(eq(campaignAssets.id, row.id));
    }
  }

  if (campaignForFingerprint) {
    const workflowContext = (campaignForFingerprint.workflowContext || {}) as any;
    await db
      .update(campaigns)
      .set({
        workflowContext: {
          ...workflowContext,
          approvedMessagePack: enriched,
          approvedMessagePackAt: new Date().toISOString(),
          creativeBriefFingerprint,
          v2ApprovalEnvelope: enriched.v2ApprovalEnvelope || workflowContext.v2ApprovalEnvelope,
        } as any,
      })
      .where(eq(campaigns.id, campaignId));
  }

  return insertId;
}

/**
 * One-time helper to restore a specific, non-generic approved message pack and
 * mark any existing generic packs as superseded. Useful for recovering campaigns
 * that received a weak AI-refined pack before the generic-ranking logic existed.
 */
export async function restorePreferredMessagePackForCampaign(
  campaignId: number,
  userId: number,
  pack: CampaignMessagePack
): Promise<number> {
  const enriched = enrichMessagePackMetadata({
    ...pack,
    messagePackSource: "manual_restore",
  });

  logInfo("[CampaignMessageArchitect] restoring preferred message pack", {
    campaignId,
    userId,
    headline: enriched.headline,
    isGeneric: enriched.isGeneric,
    specificityScore: enriched.specificityScore,
  });

  return saveApprovedMessagePack(userId, campaignId, enriched);
}

export async function invalidateApprovedMessagePack(
  campaignId: number,
  reason: string,
  issues: string[] = []
): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ id: campaignAssets.id, metadata: campaignAssets.metadata })
    .from(campaignAssets)
    .where(and(eq(campaignAssets.campaignId, campaignId), eq(campaignAssets.assetType, "message_pack" as any)))
    .orderBy(desc(campaignAssets.createdAt))
    .limit(1);

  const target = rows[0];
  if (!target) return 0;

  const meta = (target.metadata || {}) as any;
  const existingPack = (meta.approvedMessagePack || {}) as CampaignMessagePack;

  await db
    .update(campaignAssets)
    .set({
      metadata: {
        ...meta,
        passed: false,
        invalidatedAt: new Date().toISOString(),
        invalidationReason: reason,
        invalidationIssues: issues,
        approvedMessagePack: {
          ...existingPack,
          invalidatedAt: new Date().toISOString(),
          invalidationReason: reason,
          validation: {
            ...(existingPack.validation || { passed: false, score: 0, rejections: [], warnings: [] }),
            passed: false,
            rejections: [
              ...((existingPack.validation?.rejections || []) as string[]),
              ...issues,
            ],
          },
        },
      } as any,
    })
    .where(eq(campaignAssets.id, target.id));

  return target.id;
}

export interface RefineMessagePackOptions {
  userId: number;
  campaignId: number;
  existingPack: CampaignMessagePack;
  refinementInstruction: string;
  skipBilling?: boolean;
  maxAttempts?: number;
  onLegacyContextLoaded?: (context: LegacyLoadedShadowContextInput) => void;
  resolvedAuthority?: ResolvedArchitectAuthority;
  privacyMode?: "standard" | "safe";
}

/**
 * Parse a refinement instruction that may contain explicit structured sections
 * such as Headline, Subheadline, Benefits, CTA and Footer. This lets users
 * supply a complete message pack as the source of truth instead of hoping the
 * AI keeps their wording.
 *
 * Supports common formats:
 *   Headline: ...
 *   **Headline**: ...
 *   ## Headline
 *   - Benefit: ...
 *   1. Benefit: ...
 */
export function parseStructuredRefinementInstruction(
  instruction: string,
  existingPack: CampaignMessagePack
): Partial<CampaignMessagePack> | null {
  if (!instruction || typeof instruction !== "string") return null;

  const lines = instruction.split(/\r?\n/);
  const result: Partial<CampaignMessagePack> = {};
  let currentSection: string | null = null;
  const bullets: string[] = [];
  const proofPoints: string[] = [];

  const sectionAliases: Record<string, string> = {
    headline: "headline",
    "head line": "headline",
    subheadline: "subheadline",
    "sub-headline": "subheadline",
    "sub headline": "subheadline",
    benefits: "benefits",
    "benefit bullets": "benefits",
    "benefit cards": "benefits",
    "benefit points": "benefits",
    "key benefits": "benefits",
    cta: "cta",
    "call to action": "cta",
    "call-to-action": "cta",
    footer: "footer",
    "footer contact": "footer",
    "contact details": "footer",
    "proof points": "proofPoints",
    "trust signals": "proofPoints",
    "proof points / trust signals": "proofPoints",
  };

  function normaliseSection(value: string): string | null {
    const cleaned = value.toLowerCase().replace(/[^a-z0-9\s/-]/g, "").trim();
    return sectionAliases[cleaned] || null;
  }

  function stripLabel(line: string, section: string): string {
    // Remove markdown bold, leading bullets/numbers, and the section label.
    return line
      .replace(/^\s*[-*•\d]+\.?\s*/, "")
      .replace(/^\*\*|\*\*$/g, "")
      .replace(new RegExp(`^\\s*${section}\\s*[:\-—]\\s*`, "i"), "")
      .replace(/^\s*[:\-—]\s*/, "")
      .trim();
  }

  function detectSection(line: string): { section: string; content: string } | null {
    // Match lines like "Headline: my headline", "**Headline**", "## Headline",
    // "- Headline:", or just "Headline".
    const contentMatch = line.match(
      /^\s*(?:#{1,4}\s+|[-*•\d]+\.?\s*)?(?:\*\*)?\s*([A-Za-z0-9\s/-]+?)\s*(?:\*\*)?\s*[:\-—]\s+(.+)$/
    );
    if (contentMatch) {
      const section = normaliseSection(contentMatch[1]);
      if (section) return { section, content: contentMatch[2].trim() };
    }
    const headingMatch = line.match(
      /^\s*(?:#{1,4}\s+|[-*•\d]+\.?\s*)?(?:\*\*)?\s*([A-Za-z0-9\s/-]+?)\s*(?:\*\*)?\s*[:\-—]?\s*$/
    );
    if (headingMatch) {
      const section = normaliseSection(headingMatch[1]);
      if (section) return { section, content: "" };
    }
    return null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      currentSection = null;
      continue;
    }

    const detected = detectSection(line);
    if (detected) {
      currentSection = detected.section;
      const content = detected.content || "";
      if (content && detected.section !== "benefits" && detected.section !== "proofPoints") {
        if (detected.section === "headline") result.headline = content;
        else if (detected.section === "subheadline") result.subheadline = content;
        else if (detected.section === "cta") result.cta = content;
      }
      continue;
    }

    if (currentSection === "benefits") {
      const bullet = stripLabel(line, "benefit");
      if (bullet) bullets.push(bullet);
    } else if (currentSection === "proofPoints") {
      const point = stripLabel(line, "proof");
      if (point) proofPoints.push(point);
    } else if (currentSection && line) {
      const content = stripLabel(line, currentSection);
      if (content) {
        if (currentSection === "headline" && !result.headline) result.headline = content;
        else if (currentSection === "subheadline" && !result.subheadline) result.subheadline = content;
        else if (currentSection === "cta" && !result.cta) result.cta = content;
      }
    }
  }

  if (bullets.length > 0) result.benefitBullets = bullets;
  if (proofPoints.length > 0) result.proofPoints = proofPoints;

  // If the instruction only contains free-form text without any recognised
  // sections, return null so the AI treats it as a normal refinement request.
  const hasAnyField = result.headline || result.subheadline || result.benefitBullets?.length || result.cta || result.proofPoints?.length;
  if (!hasAnyField) return null;

  // Fill missing fields from the existing approved pack so the partial pack is
  // complete enough to validate and compare.
  return {
    headline: result.headline || existingPack.headline,
    subheadline: result.subheadline || existingPack.subheadline,
    benefitBullets: result.benefitBullets?.length ? result.benefitBullets : existingPack.benefitBullets,
    cta: result.cta || existingPack.cta,
    footerContact: existingPack.footerContact,
    platformCaptions: existingPack.platformCaptions,
    proofPoints: result.proofPoints?.length ? result.proofPoints : existingPack.proofPoints,
    validation: existingPack.validation,
  };
}

const DESIGN_ONLY_KEYWORDS = [
  "visual",
  "design",
  "layout",
  "look",
  "feel",
  "style",
  "theme",
  "background",
  "colour",
  "color",
  "font",
  "typography",
  "template",
  "image",
  "picture",
  "premium",
  "professional",
  "modern",
  "clean",
  "minimal",
  "luxury",
  "corporate",
  "restaurant",
  "fintech",
  "brighter",
  "darker",
  "larger text",
  "bigger text",
  "smaller text",
  "more spacing",
  "more space",
  "spread out",
  "less clutter",
  "simpler",
  "center",
  "centre",
  "centered",
  "aligned",
  "vertical",
  "horizontal",
  "polish",
  "improve",
  "better",
  "make it look",
  "visual appeal",
  "readability",
  "brand colours",
  "brand colors",
  "brand fit",
];

const COPY_SECTION_KEYWORDS = [
  "headline",
  "subheadline",
  "sub-headline",
  "sub headline",
  "benefits",
  "benefit bullets",
  "benefit cards",
  "benefit points",
  "key benefits",
  "cta",
  "call to action",
  "call-to-action",
  "copy",
  "wording",
  "text",
  "message",
  "tagline",
  "footer",
  "footer contact",
  "contact details",
  "proof points",
  "trust signals",
];

// Strong visual/layout phrases that should force a design-only classification
// even if the instruction also mentions copy words such as "keep the copy".
const DESIGN_OVERRIDE_KEYWORDS = [
  "move logo",
  "move the logo",
  "logo to the top",
  "logo top",
  "top-right",
  "top right",
  "remove title",
  "remove the title",
  "remove headline",
  "remove the headline",
  "hide title",
  "hide the title",
  "hide business name",
  "hide sub-headline",
  "hide subheadline",
  "remove sub-headline",
  "remove subheadline",
  "add services section",
  "add a services section",
  "add service labels",
  "service labels",
  "services as labels",
  "compact services",
  "compact service",
  "cleaner layout",
  "cleaner service grid",
  "simpler background",
  "more whitespace",
  "more white space",
  "darker background",
  "brighter colours",
  "brighter colors",
  "center offer",
  "centre offer",
  "redesign the leaflet",
  "redesign only",
  "design only",
  "make the text more readable",
  "premium layout",
  "cleaner premium layout",
  "services section with these labels",
];

// Phrases that make it clear the user wants to keep the existing copy.
const COPY_PRESERVATION_PHRASES = [
  "keep the approved",
  "keep approved",
  "keep the copy",
  "keep copy",
  "keep the headline",
  "keep headline",
  "keep the subheadline",
  "keep subheadline",
  "keep the cta",
  "keep cta",
  "keep the benefits",
  "keep benefits",
  "keep the approved copy exactly",
  "do not change",
  "do not rewrite",
  "don't change",
  "don't rewrite",
  "do not rewrite the headline",
  "do not rewrite the cta",
  "do not rewrite the subheadline",
  "do not rewrite the benefits",
  "do not rewrite the headline, cta, subheadline, or benefits",
  "redesign the leaflet only",
  "design only",
  "preserve the",
  "preserve approved",
  "same copy",
  "same headline",
  "same cta",
  "same benefits",
];

// Explicit rewrite requests that should prevent design-only classification.
const COPY_INTENT_KEYWORDS = [
  "rewrite",
  "change the headline",
  "change headline",
  "new headline",
  "different headline",
  "update the headline",
  "change the cta",
  "change cta",
  "new cta",
  "different cta",
  "update the cta",
  "change the subheadline",
  "change subheadline",
  "new subheadline",
  "update the subheadline",
  "update the copy",
  "update copy",
  "reword",
  "re-word",
  "make the headline",
  "make the cta",
  "make the subheadline",
  "write a new",
  "new copy",
];

/**
 * Detect whether a refinement instruction is purely about visual/design/style
 * and should not trigger a copy rewrite.
 *
 * Instructions that preserve copy ("keep the approved copy") while asking for
 * layout changes ("move the logo", "remove the title", "add service labels")
 * are treated as design-only.
 */
export function isDesignOnlyRefinementInstruction(instruction: string): boolean {
  if (!instruction || typeof instruction !== "string") return false;
  const lower = instruction.toLowerCase();

  // Strip negated copy-rewrite verbs so "do not rewrite the headline" is not
  // mistaken for a rewrite request.
  const intentLower = lower.replace(
    /\b(?:do not|don't|never)\s+(rewrite|change|update|modify|alter)\b/g,
    "PRESERVE"
  );

  // Explicit copy-rewrite intent always takes precedence.
  const hasCopyIntent = COPY_INTENT_KEYWORDS.some((kw) => intentLower.includes(kw));
  if (hasCopyIntent) return false;

  // Strong layout/visual instructions force design-only mode, even when the
  // user mentions copy words such as "keep the approved copy".
  const hasDesignOverride = DESIGN_OVERRIDE_KEYWORDS.some((kw) => lower.includes(kw));
  if (hasDesignOverride) return true;

  // If the user names explicit copy sections but also preserves existing copy,
  // it is still a design/layout request rather than a rewrite request.
  const hasCopySection = COPY_SECTION_KEYWORDS.some((kw) => lower.includes(kw));
  const hasPreservation = COPY_PRESERVATION_PHRASES.some((kw) => lower.includes(kw));
  if (hasCopySection && !hasPreservation) return false;

  const hasDesignKeyword = DESIGN_ONLY_KEYWORDS.some((kw) => lower.includes(kw));
  return hasDesignKeyword;
}

function refinementPrompt(ctx: ValidationContext, existingPack: CampaignMessagePack, instruction: string, platforms: string[], userPack?: CampaignMessagePack): string {
  const category = detectBusinessCategory(ctx);
  const categoryCtas = expectedCtasForCategory(category).join('", "');
  const explicitOffer = hasExplicitOffer(ctx) ? ctx.offerDetails : "None — do NOT invent offers, discounts, free trials, free assessments, guarantees, same-day service, limited-time deals, loans, BNPL or loyalty programmes.";

  const userPackBlock = userPack
    ? `
USER-PROVIDED STRUCTURED COPY — THIS IS THE SOURCE OF TRUTH. YOU MAY POLISH WORDING BUT YOU MUST NOT REPLACE IT WITH GENERIC PHRASES LIKE "YOUR BUSINESS", "TRANSFORM YOUR BUSINESS", OR "UNLOCK SUCCESS".
- Headline: ${userPack.headline}
- Subheadline: ${userPack.subheadline}
- Benefits: ${userPack.benefitBullets.join(" | ")}
- CTA: ${userPack.cta}
- Footer/Contact: ${JSON.stringify(userPack.footerContact)}
- Proof Points: ${(userPack.proofPoints || []).join(" | ") || "None"}
`
    : "";

  return `You are a senior conversion copywriter for NatForgeAI. Refine an existing campaign message pack using the user's specific instruction below.

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

EXISTING APPROVED MESSAGE PACK (preserve what works, only change what the instruction asks for):
- Headline: ${existingPack.headline}
- Subheadline: ${existingPack.subheadline}
- Benefits: ${existingPack.benefitBullets.join(" | ")}
- CTA: ${existingPack.cta}
- Footer/Contact: ${JSON.stringify(existingPack.footerContact)}
- Proof Points: ${(existingPack.proofPoints || []).join(" | ") || "None"}
${userPackBlock}
USER REFINEMENT INSTRUCTION (apply precisely; do not ignore):
${instruction}

REQUIRED OUTPUT:
1. Headline — customer-facing, specific, never the campaign name only, never "Marketing Campaign".
2. Subheadline — explains the value proposition in one line.
3. Three benefit bullets or cards — each must mention a concrete outcome, product feature, or customer relief.
4. CTA — action-driven and matched to the business type. For this business, preferred CTAs are: "${categoryCtas}". Only use "Free" in the CTA if the explicit offer above contains "free".
5. Footer/contact details — phone, WhatsApp, email, website, location (use only verified details).
6. Optional proof points or trust signals — only include if there is real evidence. Do NOT invent testimonials, awards, or numbers.
7. Platform-specific caption adaptations — one per platform listed above, each with caption, CTA, and hashtags.

COPY RULES:
- NEVER use generic phrases such as "Marketing Campaign", "Transform your business", "Revolutionise", "Unlock success", "Unlock your potential", "Discover the best", "Join thousands" or similar.
- NEVER invent offers, discounts, free items, loans, BNPL, guarantees, same-day service, or limited-time deals unless the explicit offer above includes them.
- ALWAYS explain what the business does, who it helps, and why the customer should act.
- ALWAYS ground claims in the business evidence and brief above.
- NEVER use placeholders like [Your Business], YourBrandName, [Company] or [Product]. NEVER output "your business", "your company" or "your brand".
- Respect the user's refinement instruction above all else, unless it conflicts with the offer/exclusion rules.
- If the user provided structured copy above, keep its meaning, target customer language and pain-point language intact. You may only tighten wording.

Return strict JSON matching the provided schema. Every field must be present. Use null for missing optional values.`;
}

async function refineApprovedMessagePackLegacy(
  opts: RefineMessagePackOptions
): Promise<CampaignMessagePack> {
  const db = getDb();
  const { userId, campaignId, existingPack, refinementInstruction, skipBilling, maxAttempts = 2 } = opts;
  const safeLogging = isSafeLoggingMode(opts.privacyMode);

  const preloadedContext = opts.resolvedAuthority?.loadedContext;
  let campaign = preloadedContext?.campaign as any;
  let business = (preloadedContext?.business || null) as any;

  if (!campaign || !campaign.id) {
    const [loadedCampaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!loadedCampaign) throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
    campaign = loadedCampaign;

    if (loadedCampaign.businessId) {
      const [b] = await db.select().from(businesses).where(eq(businesses.id, loadedCampaign.businessId)).limit(1);
      business = b;
    }
  }

  if (!business) business = {};

  const ctx = buildValidationContext(business, campaign);
  opts.onLegacyContextLoaded?.({
    campaignId,
    business,
    campaign,
    validationContext: {
      businessName: ctx.businessName,
      industry: ctx.industry,
      productOrService: ctx.productOrService,
      targetCustomer: ctx.targetCustomer,
      mainPainPoint: ctx.mainPainPoint,
      campaignObjective: ctx.campaignObjective,
      funnelStage: ctx.funnelStage,
      preferredCta: ctx.preferredCta,
    },
  });
  const platforms = (campaign.platforms || "Instagram, Facebook, TikTok, LinkedIn")
    .split(/[,;]+/)
    .map((p: string) => p.trim())
    .filter(Boolean);

  // 1. If the user supplied explicit structured copy (Headline, Subheadline,
  // Benefits, CTA, Footer), extract it deterministically and treat it as the
  // source of truth. The AI may polish wording but must not replace it with
  // generic placeholder language.
  const parsedUserPack = parseStructuredRefinementInstruction(refinementInstruction, existingPack);
  let userPack: CampaignMessagePack | undefined;
  if (parsedUserPack) {
    userPack = {
      headline: parsedUserPack.headline || existingPack.headline,
      subheadline: parsedUserPack.subheadline || existingPack.subheadline,
      benefitBullets: parsedUserPack.benefitBullets?.length ? parsedUserPack.benefitBullets : existingPack.benefitBullets,
      cta: parsedUserPack.cta || existingPack.cta,
      footerContact: parsedUserPack.footerContact || existingPack.footerContact,
      platformCaptions: parsedUserPack.platformCaptions?.length ? parsedUserPack.platformCaptions : existingPack.platformCaptions,
      proofPoints: parsedUserPack.proofPoints?.length ? parsedUserPack.proofPoints : existingPack.proofPoints,
      validation: { passed: false, score: 0, rejections: [], warnings: [] },
    };
    userPack.validation = validateCampaignCopy(userPack, ctx);
  }

  let attempt = 0;
  let lastPack: CampaignMessagePack | undefined;
  let placeholderRetryUsed = false;
  let prompt = refinementPrompt(ctx, existingPack, refinementInstruction, platforms, userPack);

  while (attempt < maxAttempts) {
    attempt++;
    logInfo("[CampaignMessageArchitect] refining message pack", safeLogging
      ? {
          campaignId,
          attempt,
          skipBilling: !!skipBilling,
          hasUserProvidedPack: !!userPack,
          stageCode: "legacy_refine_attempt",
          status: "started",
        }
      : {
          campaignId,
          userId,
          attempt,
          skipBilling: !!skipBilling,
          hasUserProvidedPack: !!userPack,
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
          "You are a senior conversion copywriter. You refine campaign copy based on user instructions. Never use generic marketing filler. Never invent offers. Always return valid JSON matching the schema exactly.",
        skipBilling,
      });
      raw = result.output;
    } catch {
      logError("[CampaignMessageArchitect] refinement generation failed", safeLogging
        ? {
            campaignId,
            attempt,
            errorCode: "CREATIVE_REFINEMENT_GENERATION_FAILED",
            stageCode: "legacy_refine_run_agent",
            status: "failed",
          }
        : {
            campaignId,
            userId,
            attempt,
            errorCode: "CREATIVE_REFINEMENT_GENERATION_FAILED",
            stageCode: "legacy_refine_run_agent",
          });
      if (attempt === maxAttempts) {
        break;
      }
      continue;
    }

    const pack = normaliseArchitectOutput(raw, ctx);
    lastPack = pack;

    if (pack.validation.passed) {
      logInfo("[CampaignMessageArchitect] refined message pack approved", safeLogging
        ? {
            campaignId,
            attempt,
            score: pack.validation.score,
            passed: true,
            stageCode: "legacy_refine_validation",
          }
        : {
            campaignId,
            userId,
            score: pack.validation.score,
          });
      break;
    }

    logWarn("[CampaignMessageArchitect] refined message pack rejected", safeLogging
      ? {
          campaignId,
          attempt,
          passed: false,
          stageCode: "legacy_refine_validation",
          rejectionCount: pack.validation.rejections.length,
          warningCount: pack.validation.warnings.length,
        }
      : {
          campaignId,
          userId,
          attempt,
          rejections: pack.validation.rejections,
          warnings: pack.validation.warnings,
        });

    // Auto-retry once specifically for placeholder/generic language without
    // consuming a user-visible retry click.
    const hasPlaceholderIssue = pack.validation.rejections.some((r) =>
      /placeholder|your business|your company|your brand|generic phrase/i.test(r)
    );
    if (hasPlaceholderIssue && !placeholderRetryUsed && userPack) {
      placeholderRetryUsed = true;
      prompt = `${refinementPrompt(
        ctx,
        existingPack,
        refinementInstruction,
        platforms,
        userPack
      )}\n\nCRITICAL: Your previous output contained generic placeholder language. Use the USER-PROVIDED STRUCTURED COPY above as the source of truth. Do not replace it with "your business", "your company", "transform your business", or similar generic phrases.`;
      // We do not increment attempt here because this is the automatic
      // placeholder-recovery retry; instead, continue the loop normally.
      continue;
    }

    if (attempt < maxAttempts) {
      prompt = `${prompt}\n\nPREVIOUS ATTEMPT FAILED QUALITY CHECK. FIX THESE ISSUES AND REGENERATE:\n${pack.validation.rejections
        .map((r) => `- ${r}`)
        .join("\n")}\n\nAlso address warnings where possible. Never invent offers or use generic phrases.`;
    }
  }

  // 4. Fallback: if the AI-refined pack failed validation but the user-provided
  // structured pack passes validation, use the user-provided pack.
  if (lastPack && !lastPack.validation.passed && userPack && userPack.validation.passed) {
    logInfo("[CampaignMessageArchitect] falling back to user-provided structured pack", {
      campaignId,
      userId,
      source: "fallback_user_pack",
      aiRejections: lastPack.validation.rejections,
    });
    userPack.messagePackSource = "fallback_user_pack";
    return userPack;
  }

  if (!lastPack && userPack && userPack.validation.passed) {
    logInfo("[CampaignMessageArchitect] using user-provided structured pack (no AI output)", {
      campaignId,
      userId,
      source: "user_structured_copy",
    });
    userPack.messagePackSource = "user_structured_copy";
    return userPack;
  }

  if (!lastPack) {
    lastPack = existingPack;
  }

  const finalSource: MessagePackSource =
    lastPack === userPack
      ? "user_structured_copy"
      : lastPack === existingPack
      ? "latest_message_pack"
      : "ai_refined_pack";
  lastPack.messagePackSource = finalSource;
  logInfo("[CampaignMessageArchitect] refinement resolved", safeLogging
    ? {
        campaignId,
        source: finalSource,
        passed: lastPack.validation.passed,
        score: lastPack.validation.score,
        stageCode: "legacy_refine_resolved",
      }
    : {
        campaignId,
        userId,
        source: finalSource,
        passed: lastPack.validation.passed,
        score: lastPack.validation.score,
      });

  return lastPack;
}

async function ensureApprovedMessagePackLegacy(
  opts: BuildApprovedMessagePackOptions
): Promise<CampaignMessagePack> {
  const db = getDb();
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, opts.campaignId))
    .limit(1);
  const currentFingerprint = campaign
    ? computeCreativeBriefFingerprint(campaign)
    : "";

  const loaded = await loadApprovedMessagePack(opts.campaignId);
  const existing = loaded && isApprovedMessagePackCompatible(loaded, currentFingerprint) ? loaded : null;

  if (loaded && !existing) {
    logInfo("[CampaignMessageArchitect] ignoring stale approved message pack", {
      campaignId: opts.campaignId,
      userId: opts.userId,
      reason: "creative_brief_fingerprint_mismatch",
    });
  }

  if (existing?.isGeneric) {
    const invalidatedId = await invalidateApprovedMessagePack(
      opts.campaignId,
      "generic_pack_blocked",
      ["Previously approved pack is generic and cannot be reused."]
    );
    logWarn("[CampaignMessageArchitect] invalidated generic approved pack", {
      campaignId: opts.campaignId,
      userId: opts.userId,
      oldPackInvalidated: invalidatedId > 0,
    });
  }

  const canReuseExisting =
    !!existing &&
    existing.validation?.passed &&
    !existing.isGeneric &&
    !opts.forceRebuild;

  if (canReuseExisting) {
    logInfo("[CampaignMessageArchitect] reusing approved message pack", {
      campaignId: opts.campaignId,
      userId: opts.userId,
    });
    return observeMessageApprovalV2Shadow(existing, opts, "reuse_existing_pack", opts.resolvedAuthority);
  }

  if (opts.forceRebuild && existing) {
    const invalidatedId = await invalidateApprovedMessagePack(opts.campaignId, "creative_quality_gate_failed", opts.qualityIssues || []);
    logInfo("[CampaignMessageArchitect] force rebuild requested", {
      campaignId: opts.campaignId,
      userId: opts.userId,
      oldPackInvalidated: invalidatedId > 0,
      retryQualityIssues: opts.qualityIssues || [],
    });

    const refinementInstruction = [
      "Refine the message pack to resolve these exact issues:",
      ...(opts.qualityIssues || []).map((issue) => `- ${issue}`),
      "Do not produce generic copy.",
      "Ensure the copy explicitly references the business product or service.",
    ].join("\n");

    const refined = await refineApprovedMessagePackLegacy({
      userId: opts.userId,
      campaignId: opts.campaignId,
      existingPack: existing,
      refinementInstruction,
      skipBilling: opts.skipBilling,
      maxAttempts: opts.maxAttempts,
      onLegacyContextLoaded: opts.onLegacyContextLoaded,
      resolvedAuthority: opts.resolvedAuthority,
    });

    const enrichedRefined = enrichMessagePackMetadata(refined);
    if (enrichedRefined.validation.passed && !enrichedRefined.isGeneric) {
      await saveApprovedMessagePack(opts.userId, opts.campaignId, enrichedRefined);
      return observeMessageApprovalV2Shadow(
        enrichedRefined,
        opts,
        "force_rebuild_refined_pack",
        opts.resolvedAuthority
      );
    }
  }

  const pack = await buildApprovedMessagePackLegacy({
    ...opts,
    onLegacyContextLoaded: opts.onLegacyContextLoaded,
    resolvedAuthority: opts.resolvedAuthority,
  });
  const enrichedPack = enrichMessagePackMetadata(pack);
  if (enrichedPack.validation.passed && !enrichedPack.isGeneric) {
    await saveApprovedMessagePack(opts.userId, opts.campaignId, enrichedPack);
  }
  return observeMessageApprovalV2Shadow(
    enrichedPack,
    opts,
    "fresh_or_fallback_pack",
    opts.resolvedAuthority
  );
}

function observeMessageApprovalV2Shadow(
  legacyPack: CampaignMessagePack,
  opts: BuildApprovedMessagePackOptions,
  workflowRunId: string | null,
  resolvedAuthority?: ResolvedArchitectAuthority
): CampaignMessagePack {
  const authority = resolvedAuthority || opts.resolvedAuthority;
  if (!authority || authority.mode !== "shadow" || !authority.contextLock) return legacyPack;

  const started = Date.now();
  const lock = authority.contextLock;
  try {
    runShadowMessageApproval({
      mode: "shadow",
      campaignId: opts.campaignId,
      workflowRunId,
      candidateId: `shadow-candidate-${opts.campaignId}-${Date.now()}`,
      assessmentId: `shadow-assessment-${opts.campaignId}-${Date.now()}`,
      legacyPack,
      businessDna: lock.businessDna,
      campaignStrategy: lock.campaignStrategy,
      policy: lock.policy,
      contextDiagnostics: lock.diagnostics,
      now: () => Date.now(),
      nowIso: () => new Date().toISOString(),
      log: (result) => {
        logInfo(
          "[CampaignMessageArchitect][V2Shadow] message approval comparison",
          {
            ...result,
            event: "v2_shadow_observation",
          } as unknown as Record<string, unknown>
        );
      },
    });
  } catch {
    logWarn("[CampaignMessageArchitect][V2Shadow] observation skipped", {
      event: "v2_shadow_observation_skipped",
      campaignId: opts.campaignId,
      workflowRunId,
      durationMs: Math.max(0, Date.now() - started),
      stage: "shadow_observation",
      errorCode: "SHADOW_OBSERVATION_FAILED",
    });
  }

  return legacyPack;
}

interface ResolvedArchitectAuthority {
  readonly mode: "off" | "shadow" | "canary";
  readonly canarySelected: boolean;
  readonly businessId: number | null;
  readonly selection: CanarySelectionResult;
  readonly loadedContext: LegacyLoadedShadowContextInput | null;
  readonly contextLock: MessageApprovalContextLock | null;
  readonly diagnostics: {
    readonly stageCode: string;
    readonly reason: string;
  };
}

async function resolveArchitectAuthority(campaignId: number, userId: number): Promise<ResolvedArchitectAuthority> {
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  const businessId = campaign?.businessId ? Number(campaign.businessId) : null;
  const selection = resolveCanarySelection({ campaignId, businessId, userId });

  logInfo("[CampaignMessageArchitect][V2Mode] resolved mode", {
    campaignId,
    mode: selection.mode,
    selected: selection.selected,
    reason: selection.reason,
    bucket: selection.bucket,
    percent: selection.percent,
  });

  const mode: "off" | "shadow" | "canary" =
    selection.mode === "shadow"
      ? "shadow"
      : selection.mode === "canary" && selection.selected
      ? "canary"
      : "off";

  if (mode === "off") {
    return Object.freeze({
      mode,
      canarySelected: false,
      businessId,
      selection,
      loadedContext: null,
      contextLock: null,
      diagnostics: {
        stageCode: "legacy_authority",
        reason: selection.reason,
      },
    });
  }

  const loadedContext = await loadContextInput(campaignId);
  const contextLock = buildMessageApprovalContextLock({
    mode,
    campaignId,
    loadedContext,
  });

  return Object.freeze({
    mode,
    canarySelected: mode === "canary",
    businessId,
    selection,
    loadedContext,
    contextLock,
    diagnostics: {
      stageCode: mode === "shadow" ? "shadow_context_lock_ready" : "canary_context_lock_ready",
      reason: selection.reason,
    },
  });
}

async function loadContextInput(campaignId: number): Promise<LegacyLoadedShadowContextInput> {
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  let business: any = null;
  if (campaign?.businessId) {
    const [b] = await db.select().from(businesses).where(eq(businesses.id, campaign.businessId)).limit(1);
    business = b;
  }
  const ctx = buildValidationContext(business || {}, campaign || {});
  return {
    campaignId,
    business: business || {},
    campaign: campaign || {},
    validationContext: {
      businessName: ctx.businessName,
      industry: ctx.industry,
      productOrService: ctx.productOrService,
      targetCustomer: ctx.targetCustomer,
      mainPainPoint: ctx.mainPainPoint,
      campaignObjective: ctx.campaignObjective,
      funnelStage: ctx.funnelStage,
      preferredCta: ctx.preferredCta,
    },
  };
}

async function loadEligibleStoredCanaryRows(campaignId: number): Promise<Array<{ pack: CampaignMessagePack; assetId: number; createdAt: Date }>> {
  const db = getDb();
  const rows = await db
    .select({ id: campaignAssets.id, metadata: campaignAssets.metadata, createdAt: campaignAssets.createdAt, status: campaignAssets.status })
    .from(campaignAssets)
    .where(and(eq(campaignAssets.campaignId, campaignId), eq(campaignAssets.assetType, "message_pack" as any)))
    .orderBy(desc(campaignAssets.createdAt))
    .limit(1000);

  return rows
    .map((row) => {
      const meta = (row.metadata || {}) as any;
      const pack = meta.approvedMessagePack as CampaignMessagePack | undefined;
      if (!pack) return null;
      if (pack.invalidatedAt || meta.invalidatedAt) return null;
      if (pack.supersededBy || meta.supersededBy) return null;
      if (String(row.status || "").toLowerCase() === "archived" || meta.archivedAt) return null;
      if (typeof pack.headline !== "string" || typeof pack.cta !== "string" || !Array.isArray(pack.benefitBullets)) return null;
      return {
        pack,
        assetId: Number(row.id),
        createdAt: new Date(row.createdAt || Date.now()),
      };
    })
    .filter(Boolean) as Array<{ pack: CampaignMessagePack; assetId: number; createdAt: Date }>;
}

async function supersedeMessagePackAsset(assetId: number, newAssetId: number): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ metadata: campaignAssets.metadata })
    .from(campaignAssets)
    .where(eq(campaignAssets.id, assetId))
    .limit(1);
  const meta = (rows[0]?.metadata || {}) as any;
  const existingPack = (meta.approvedMessagePack || {}) as CampaignMessagePack;

  await db
    .update(campaignAssets)
    .set({
      metadata: {
        ...meta,
        supersededBy: newAssetId,
        approvedMessagePack: {
          ...existingPack,
          supersededBy: newAssetId,
        },
      } as any,
    })
    .where(eq(campaignAssets.id, assetId));
}

type CandidateRecord = {
  candidate: MessagePackCandidate;
  assessment: MessageAssessment;
  approved: ReturnType<typeof createApprovedMessagePack> | null;
  candidateSource: MessagePackCandidate["source"];
  originTimestamp: number;
};

function createCandidateFromPack(input: {
  lock: MessageApprovalContextLock;
  campaignId: number;
  source: MessagePackCandidate["source"];
  legacyPack: CampaignMessagePack;
  candidateId: string;
  createdAtIso: string;
}): MessagePackCandidate {
  return createMessagePackCandidate({
    candidateId: input.candidateId,
    campaignId: input.campaignId,
    createdAtIso: input.createdAtIso,
    source: input.source,
    copy: {
      copySchemaVersion: "v2.1",
      headline: input.legacyPack.headline,
      subheadline: input.legacyPack.subheadline,
      benefitBulletsOrdered: input.legacyPack.benefitBullets,
      cta: input.legacyPack.cta,
      proofPointsOrdered: Array.isArray(input.legacyPack.proofPoints) ? input.legacyPack.proofPoints : [],
      platformCaptionsOrdered: Array.isArray(input.legacyPack.platformCaptions)
        ? input.legacyPack.platformCaptions.map((caption) => ({
            platform: caption.platform,
            caption: caption.caption,
            cta: caption.cta,
            hashtagsOrdered: Array.isArray(caption.hashtags) ? caption.hashtags : [],
          }))
        : [],
      footer: {
        phone: input.legacyPack.footerContact?.phone ?? null,
        whatsapp: input.legacyPack.footerContact?.whatsapp ?? null,
        email: input.legacyPack.footerContact?.email ?? null,
        website: input.legacyPack.footerContact?.website ?? null,
        location: input.legacyPack.footerContact?.location ?? null,
      },
    },
    businessDnaSnapshotId: input.lock.businessDnaSnapshotId,
    evidenceHashSha256: input.lock.evidenceHashSha256,
    campaignStrategySnapshotId: input.lock.campaignStrategySnapshotId,
    strategyHashSha256: input.lock.strategyHashSha256,
    qualityPolicyId: input.lock.policyId,
    qualityPolicyVersion: input.lock.policyVersion,
    policyHashSha256: input.lock.policyHashSha256,
    provenance: {
      adaptedFromLegacy: false,
      originSource: input.legacyPack.messagePackSource ?? "unknown",
      modelName: null,
      diagnostics: {
        legacyIsGeneric: typeof input.legacyPack.isGeneric === "boolean" ? input.legacyPack.isGeneric : null,
        legacyValidationPassed: input.legacyPack.validation?.passed ?? null,
        legacyValidationScore: input.legacyPack.validation?.score ?? null,
        legacyValidationRejections: input.legacyPack.validation?.rejections || [],
      },
    },
  });
}

function evaluateCandidateOnce(
  lock: MessageApprovalContextLock,
  candidate: MessagePackCandidate,
  cache: Map<string, CandidateRecord>
): CandidateRecord {
  const evaluationKey = computeEvaluationKey({
    copyHashSha256: candidate.copyHashSha256,
    evidenceHashSha256: lock.evidenceHashSha256,
    strategyHashSha256: lock.strategyHashSha256,
    policyHashSha256: lock.policyHashSha256,
  });
  const existing = cache.get(evaluationKey);
  if (existing) {
    logInfo("[CampaignMessageArchitect][V2Canary] duplicate candidate key reused", {
      campaignId: lock.campaignId,
      contextLockId: lock.contextLockId,
      evaluationKey,
      reusedCandidateId: existing.candidate.candidateId,
      reusedAssessmentId: existing.assessment.assessmentId,
    });
    return existing;
  }

  const assessment = evaluateMessageCandidate({
    assessmentId: `canary-assessment-${lock.campaignId}-${Date.now()}`,
    evaluatedAtIso: new Date().toISOString(),
    candidate,
    businessDna: lock.businessDna,
    campaignStrategy: lock.campaignStrategy,
    policy: lock.policy,
  });

  const approved = assessment.decision === "approved"
    ? createApprovedMessagePack({
        approvedRevisionId: `canary-rev-${lock.campaignId}-${Date.now()}`,
        approvedAtIso: new Date().toISOString(),
        candidate,
        assessment,
        policy: lock.policy,
      })
    : null;

  const record: CandidateRecord = {
    candidate,
    assessment,
    approved,
    candidateSource: candidate.source,
    originTimestamp: Date.now(),
  };
  cache.set(evaluationKey, record);
  return record;
}

function buildV2RefinementInstruction(baseInstruction: string | null, assessment: MessageAssessment): string {
  const hardIssues = assessment.hardIssues.map((issue) => `- [${issue.code}] ${issue.message}`);
  const warnings = assessment.warnings.map((issue) => `- [${issue.code}] ${issue.message}`);
  const ctaIssues = assessment.hardIssues.filter((issue) => issue.code.includes("CTA")).map((issue) => `- ${issue.message}`);
  const groundingIssues = assessment.hardIssues
    .filter((issue) => issue.code.includes("GROUNDING") || issue.code.includes("ALIGNMENT"))
    .map((issue) => `- ${issue.message}`);

  return [
    baseInstruction ? `ORIGINAL REFINEMENT INSTRUCTION:\n${baseInstruction}` : "",
    "V2 MESSAGE AUTHORITY REJECTION. APPLY THESE EXACT CORRECTIONS:",
    "HARD ISSUES:",
    hardIssues.join("\n") || "- None",
    "WARNINGS TO ADDRESS:",
    warnings.join("\n") || "- None",
    "CTA DETAILS:",
    ctaIssues.join("\n") || "- None",
    "GROUNDING DETAILS:",
    groundingIssues.join("\n") || "- None",
    "Do not rely on previous legacy validator rejection strings; fix the V2 findings above.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function runCanaryMessageApprovalFlow(input: {
  kind: "ensure" | "build" | "refine";
  ensureOptions: BuildApprovedMessagePackOptions;
  refineOptions?: RefineMessagePackOptions;
  authority: ResolvedArchitectAuthority;
}): Promise<CampaignMessagePack> {
  const lock = input.authority.contextLock;
  const loadedContext = input.authority.loadedContext;
  if (!lock || !loadedContext || input.authority.mode !== "canary") {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Missing canary authority context lock." });
  }

  const cache = new Map<string, CandidateRecord>();
  let sequence = 0;

  const evaluateGeneratedPack = (pack: CampaignMessagePack, source: MessagePackCandidate["source"]): CandidateRecord => {
    sequence += 1;
    const candidate = createCandidateFromPack({
      lock,
      campaignId: input.ensureOptions.campaignId,
      source,
      legacyPack: pack,
      candidateId: `canary-candidate-${lock.campaignId}-${sequence}-${Date.now()}`,
      createdAtIso: new Date().toISOString(),
    });
    return evaluateCandidateOnce(lock, candidate, cache);
  };

  const stored = await loadEligibleStoredCanaryRows(input.ensureOptions.campaignId);
  const storedApproved: Array<CandidateRecord & { assetId: number; createdAt: Date }> = [];
  for (const item of stored) {
    const candidate = adaptLegacyMessagePack({
      campaignId: input.ensureOptions.campaignId,
      candidateId: `stored-${item.assetId}-${Date.now()}`,
      createdAtIso: new Date().toISOString(),
      businessDnaSnapshotId: lock.businessDnaSnapshotId,
      evidenceHashSha256: lock.evidenceHashSha256,
      campaignStrategySnapshotId: lock.campaignStrategySnapshotId,
      strategyHashSha256: lock.strategyHashSha256,
      qualityPolicyId: lock.policyId,
      qualityPolicyVersion: lock.policyVersion,
      policyHashSha256: lock.policyHashSha256,
      legacyPack: item.pack,
      preferredSource: "existing_approved",
    });
    const result = evaluateCandidateOnce(lock, candidate, cache);
    if (result.approved) {
      storedApproved.push({ ...result, assetId: item.assetId, createdAt: item.createdAt });
    }
  }

  if (input.kind === "ensure" && !input.ensureOptions.forceRebuild && storedApproved.length > 0) {
    storedApproved.sort((a, b) => {
      if (a.assessment.score !== b.assessment.score) return b.assessment.score - a.assessment.score;
      const dateDiff = b.createdAt.getTime() - a.createdAt.getTime();
      if (dateDiff !== 0) return dateDiff;
      return b.assetId - a.assetId;
    });
    const selected = storedApproved[0];
    const adapted = adaptApprovedToCampaignMessagePack({
      approved: selected.approved!,
      assessment: selected.assessment,
      contextLock: lock,
      candidateSource: selected.candidateSource,
      specificityScore,
    });
    return adapted.pack;
  }

  let priorBestAssetId: number | null = null;
  if (input.ensureOptions.forceRebuild && storedApproved.length > 0) {
    const sortedStored = [...storedApproved].sort((a, b) => {
      if (a.assessment.score !== b.assessment.score) return b.assessment.score - a.assessment.score;
      const dateDiff = b.createdAt.getTime() - a.createdAt.getTime();
      if (dateDiff !== 0) return dateDiff;
      return b.assetId - a.assetId;
    });
    priorBestAssetId = sortedStored[0].assetId;
  }

  let approvedGenerated: CandidateRecord | null = null;

  if (input.kind === "refine" && input.refineOptions) {
    let refined = await refineApprovedMessagePackLegacy({
      ...input.refineOptions,
      maxAttempts: 1,
      privacyMode: "safe",
      resolvedAuthority: input.authority,
    });

    for (let retry = 0; retry < 2; retry++) {
      const evaluated = evaluateGeneratedPack(refined, "ai_refined");
      if (evaluated.approved) {
        approvedGenerated = evaluated;
        break;
      }

      if (retry === 1) break;

      const refinementInstruction = buildV2RefinementInstruction(
        input.refineOptions.refinementInstruction,
        evaluated.assessment
      );

      refined = await refineApprovedMessagePackLegacy({
        ...input.refineOptions,
        existingPack: refined,
        refinementInstruction,
        maxAttempts: 1,
        privacyMode: "safe",
        resolvedAuthority: input.authority,
      });
    }
  } else {
    const initial = await buildApprovedMessagePackLegacy({
      ...input.ensureOptions,
      maxAttempts: 1,
      privacyMode: "safe",
      resolvedAuthority: input.authority,
    });
    const initialEvaluated = evaluateGeneratedPack(initial, "ai_initial");
    if (initialEvaluated.approved) {
      approvedGenerated = initialEvaluated;
    } else {
      let currentPack = initial;
      let currentFeedback = buildV2RefinementInstruction(null, initialEvaluated.assessment);

      for (let retry = 0; retry < 2; retry++) {
        const refined = await refineApprovedMessagePackLegacy({
        userId: input.ensureOptions.userId,
        campaignId: input.ensureOptions.campaignId,
          existingPack: currentPack,
          refinementInstruction: currentFeedback,
        skipBilling: input.ensureOptions.skipBilling,
        maxAttempts: 1,
          privacyMode: "safe",
          resolvedAuthority: input.authority,
      });

        const evaluated = evaluateGeneratedPack(refined, "ai_refined");
        if (evaluated.approved) {
          approvedGenerated = evaluated;
          break;
        }

        currentPack = refined;
        currentFeedback = buildV2RefinementInstruction(null, evaluated.assessment);
      }
    }
  }

  if (!approvedGenerated) {
    const deterministicPack = buildDeterministicMessagePack(
      buildValidationContext(loadedContext.business || {}, loadedContext.campaign || {})
    );
    deterministicPack.messagePackSource = "fallback_deterministic";
    const evaluated = evaluateGeneratedPack(deterministicPack, "deterministic_fallback");
    if (evaluated.approved) {
      approvedGenerated = evaluated;
    }
  }

  if (approvedGenerated) {
    const adapted = adaptApprovedToCampaignMessagePack({
      approved: approvedGenerated.approved!,
      assessment: approvedGenerated.assessment,
      contextLock: lock,
      candidateSource: approvedGenerated.candidateSource,
      specificityScore,
    });

    const newAssetId = await saveApprovedMessagePack(
      input.ensureOptions.userId,
      input.ensureOptions.campaignId,
      adapted.pack,
      {
        mode: "canary",
        proof: adapted.proof,
      }
    );

    if (input.ensureOptions.forceRebuild && priorBestAssetId && priorBestAssetId !== newAssetId) {
      await supersedeMessagePackAsset(priorBestAssetId, newAssetId);
    }

    return adapted.pack;
  }

  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "V2 message approval rejected all candidates.",
  });
}

export async function buildApprovedMessagePack(
  opts: BuildApprovedMessagePackOptions
): Promise<CampaignMessagePack> {
  const authority = await resolveArchitectAuthority(opts.campaignId, opts.userId);
  if (authority.mode === "canary" && authority.canarySelected) {
    return runCanaryMessageApprovalFlow({ kind: "build", ensureOptions: { ...opts, resolvedAuthority: authority }, authority });
  }

  const pack = await buildApprovedMessagePackLegacy({ ...opts, resolvedAuthority: authority });
  return observeMessageApprovalV2Shadow(pack, { ...opts, resolvedAuthority: authority }, "build_pack", authority);
}

export async function refineApprovedMessagePack(
  opts: RefineMessagePackOptions
): Promise<CampaignMessagePack> {
  const authority = await resolveArchitectAuthority(opts.campaignId, opts.userId);
  if (authority.mode === "canary" && authority.canarySelected) {
    return runCanaryMessageApprovalFlow({
      kind: "refine",
      ensureOptions: {
        userId: opts.userId,
        campaignId: opts.campaignId,
        skipBilling: opts.skipBilling,
        maxAttempts: opts.maxAttempts,
        resolvedAuthority: authority,
      },
      refineOptions: { ...opts, resolvedAuthority: authority },
      authority,
    });
  }

  const refined = await refineApprovedMessagePackLegacy({ ...opts, resolvedAuthority: authority });
  return observeMessageApprovalV2Shadow(
    refined,
    {
      userId: opts.userId,
      campaignId: opts.campaignId,
      skipBilling: opts.skipBilling,
      maxAttempts: opts.maxAttempts,
      resolvedAuthority: authority,
    },
    "refine_pack",
    authority
  );
}

export async function ensureApprovedMessagePack(
  opts: BuildApprovedMessagePackOptions
): Promise<CampaignMessagePack> {
  const authority = await resolveArchitectAuthority(opts.campaignId, opts.userId);
  if (authority.mode === "canary" && authority.canarySelected) {
    return runCanaryMessageApprovalFlow({ kind: "ensure", ensureOptions: { ...opts, resolvedAuthority: authority }, authority });
  }
  return ensureApprovedMessagePackLegacy({ ...opts, resolvedAuthority: authority });
}
