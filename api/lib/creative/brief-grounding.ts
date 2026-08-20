/**
 * Shared creative-brief grounding resolver.
 *
 * Phase 1 — Campaign #30 hardening:
 * - Computes a stable creative-brief fingerprint from the current campaign
 *   brief (no volatile fields such as updatedAt).
 * - Treats approved message packs whose stored fingerprint does not match the
 *   current brief as stale, so historical workflowContext/approvedMessagePack
 *   content cannot override a corrected campaign brief.
 * - Resolves business type (B2B/B2C) from campaign + business evidence instead
 *   of silently defaulting to B2C.
 *
 * Phase 2A — Strategy reliability:
 * - Builds an immutable grounding contract from the authoritative brief.
 * - Provides deterministic, role-aware tokenisation helpers used by the
 *   strategy agent for materialisation and validation.
 */

import { createHash } from "crypto";

export interface CreativeBriefFingerprintInput {
  productOrService?: string | null;
  targetBuyer?: string | null;
  mainPainPoint?: string | null;
  preferredCta?: string | null;
  primaryOutcome?: string | null;
  targetAudience?: string | null;
  coreMessage?: string | null;
  offerDetails?: string | null;
  excludedOffers?: string | null;
  referenceStyle?: string | null;
  contentStyle?: string | null;
}

export type BusinessTypeClassification = "B2B" | "B2C" | "mixed" | "not_specified";

export interface GroundedCreativeBrief extends CreativeBriefFingerprintInput {
  /** Stable SHA-256 fingerprint of the campaign brief. */
  fingerprint: string;
  /** Resolved business type; never silently defaults to B2C. */
  businessType: BusinessTypeClassification;
}

const FINGERPRINT_FIELDS: (keyof CreativeBriefFingerprintInput)[] = [
  "productOrService",
  "targetBuyer",
  "mainPainPoint",
  "preferredCta",
  "primaryOutcome",
  "targetAudience",
  "coreMessage",
  "offerDetails",
  "excludedOffers",
  "referenceStyle",
  "contentStyle",
];

/**
 * Normalize a value for fingerprinting.
 *
 * Rules:
 * - null / undefined -> ""
 * - Unicode NFC normalization (best-effort; falls back gracefully)
 * - Trim leading/trailing whitespace
 * - Collapse repeated internal whitespace to one space
 *
 * Preserves punctuation, case, wording and negation so that substantive text
 * changes alter the fingerprint while formatting-only changes do not.
 */
function normalizeFingerprintValue(value: unknown): string {
  if (typeof value !== "string") return "";
  let normalized = value.trim().replace(/\s+/g, " ");
  if (typeof normalized.normalize === "function") {
    try {
      normalized = normalized.normalize("NFC");
    } catch {
      // NFC unsupported in this environment; keep the original string.
    }
  }
  return normalized;
}

function sanitizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pickCampaignBriefInput(campaign: unknown): CreativeBriefFingerprintInput {
  if (!campaign || typeof campaign !== "object") return {};
  const c = campaign as Record<string, unknown>;
  const input: CreativeBriefFingerprintInput = {};
  for (const field of FINGERPRINT_FIELDS) {
    (input as Record<string, string | undefined>)[field] = sanitizeString(c[field]);
  }
  return input;
}

/**
 * Compute a stable SHA-256 fingerprint for a creative brief.
 * Only the listed brief fields participate; volatile fields such as updatedAt
 * are intentionally excluded.
 */
export function computeCreativeBriefFingerprint(input: CreativeBriefFingerprintInput): string {
  const payload: Record<string, string> = {};
  for (const field of FINGERPRINT_FIELDS) {
    payload[field] = normalizeFingerprintValue(input[field]);
  }
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

const B2B_EVIDENCE = new Set([
  "b2b",
  "business",
  "businesses",
  "enterprise",
  "enterprises",
  "company",
  "companies",
  "corporate",
  "organisation",
  "organization",
  "organisations",
  "organizations",
  "merchant",
  "merchants",
  "platform",
  "platforms",
  "manager",
  "managers",
  "management",
  "operations",
  "finance lead",
  "finance leads",
  "finance team",
  "finance teams",
  "decision maker",
  "decision makers",
  "decision-maker",
  "decision-makers",
  "supplier",
  "suppliers",
  "vendor",
  "vendors",
  "payroll",
  "disbursement",
  "disbursements",
  "payout",
  "payouts",
  "workforce",
  "staff",
  "employer",
  "employers",
  "professional",
  "professionals",
  "office",
  "offices",
  "clinic",
  "clinics",
  "practice",
  "practices",
  "studio",
  "studios",
  "agency",
  "agencies",
]);

const B2C_EVIDENCE = new Set([
  "b2c",
  "individual",
  "individuals",
  "consumer",
  "consumers",
  "personal",
  "homeowner",
  "homeowners",
  "parent",
  "parents",
  "family",
  "families",
  "shopper",
  "shoppers",
  "diner",
  "diners",
  "guest",
  "guests",
  "resident",
  "residents",
  "for myself",
  "myself",
  "individual consumer",
  "individual consumers",
]);

function tokenizeForClassification(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function extractClassificationPhrases(text: string): Set<string> {
  const phrases = new Set<string>();
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  phrases.add(normalized);
  // Include 2-grams so multi-word signals such as "finance leads" are captured.
  const tokens = normalized.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length - 1; i++) {
    phrases.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return phrases;
}

function hasEvidence(text: string, evidenceSet: Set<string>): boolean {
  const phrases = extractClassificationPhrases(text);
  for (const phrase of phrases) {
    if (evidenceSet.has(phrase)) return true;
  }
  const tokens = tokenizeForClassification(text);
  for (const token of tokens) {
    if (evidenceSet.has(token)) return true;
  }
  return false;
}

export interface BusinessTypeClassificationInput {
  explicit?: BusinessTypeClassification | null;
  targetBuyer?: string | null;
  productOrService?: string | null;
  businessIndustry?: string | null;
  websiteTargetCustomers?: string[] | null;
  coreMessage?: string | null;
  contentStyle?: string | null;
}

/**
 * Resolve the business type for a campaign.
 *
 * Precedence:
 * 1. Explicit classification, when supplied and valid.
 * 2. Inferred from campaign/business/website evidence:
 *    - organisational buyers/merchants/platforms/managers/businesses => B2B
 *    - clear individual-consumer evidence => B2C
 *    - conflicting or absent evidence => mixed / not_specified
 *
 * Never silently defaults to B2C.
 */
export function classifyBusinessType(input: BusinessTypeClassificationInput): BusinessTypeClassification {
  if (input.explicit && ["B2B", "B2C", "mixed", "not_specified"].includes(input.explicit)) {
    return input.explicit;
  }

  const parts = [
    input.targetBuyer,
    input.productOrService,
    input.businessIndustry,
    input.coreMessage,
    input.contentStyle,
    ...(Array.isArray(input.websiteTargetCustomers) ? input.websiteTargetCustomers : []),
  ]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean)
    .join(" ");

  const hasB2B = hasEvidence(parts, B2B_EVIDENCE);
  const hasB2C = hasEvidence(parts, B2C_EVIDENCE);

  if (hasB2B && hasB2C) return "mixed";
  if (hasB2B) return "B2B";
  if (hasB2C) return "B2C";
  return "not_specified";
}

export interface GroundingInput {
  campaign: unknown;
  business?: unknown;
  explicitBusinessType?: BusinessTypeClassification | null;
}

/**
 * Build a grounded creative brief with the required precedence:
 * 1. Current persisted campaign brief.
 * 2. Linked business profile for missing optional context only.
 * 3. Safe fallback.
 *
 * The fingerprint is computed from the current campaign brief only, so changes
 * to business fallback data do not accidentally invalidate an approved pack.
 */
export function buildGroundedCreativeBrief(input: GroundingInput): GroundedCreativeBrief {
  const campaign = input.campaign && typeof input.campaign === "object" ? (input.campaign as Record<string, unknown>) : {};
  const business = input.business && typeof input.business === "object" ? (input.business as Record<string, unknown>) : {};

  const campaignInput = pickCampaignBriefInput(campaign);

  // Required/primary fields come from the campaign only.
  const productOrService = campaignInput.productOrService || "";
  const targetBuyer = campaignInput.targetBuyer || "";
  const mainPainPoint = campaignInput.mainPainPoint || "";
  const preferredCta = campaignInput.preferredCta || "";

  // Optional fields fall back to the linked business profile when the campaign
  // does not provide them.
  const targetAudience =
    campaignInput.targetAudience || sanitizeString(business.targetAudience) || sanitizeString(business.targetCustomer) || "";
  const coreMessage = campaignInput.coreMessage || "";
  const offerDetails = campaignInput.offerDetails || "";
  const excludedOffers =
    campaignInput.excludedOffers || sanitizeString(business.avoidWords) || "";
  const referenceStyle = campaignInput.referenceStyle || "";
  const contentStyle =
    campaignInput.contentStyle || sanitizeString(business.brandTone) || sanitizeString(business.visualStyle) || "";
  const primaryOutcome = campaignInput.primaryOutcome || "";

  const fingerprint = computeCreativeBriefFingerprint(campaignInput);

  const websiteTargetCustomers = Array.isArray((business.websiteEvidence as any)?.targetCustomers)
    ? ((business.websiteEvidence as any).targetCustomers as string[]).filter((s): s is string => typeof s === "string")
    : undefined;

  const businessType = classifyBusinessType({
    explicit: input.explicitBusinessType,
    targetBuyer,
    productOrService,
    businessIndustry: sanitizeString(business.industry),
    websiteTargetCustomers,
    coreMessage,
    contentStyle,
  });

  return {
    productOrService,
    targetBuyer,
    mainPainPoint,
    preferredCta,
    primaryOutcome,
    targetAudience,
    coreMessage,
    offerDetails,
    excludedOffers,
    referenceStyle,
    contentStyle,
    fingerprint,
    businessType,
  };
}

/**
 * Check whether an approved message pack is compatible with the current brief.
 * Packs without a stored fingerprint are treated as legacy/stale.
 */
export function isApprovedMessagePackCompatible(
  pack: unknown,
  currentFingerprint: string
): boolean {
  if (!pack || typeof pack !== "object") return false;
  const stored = (pack as Record<string, unknown>).creativeBriefFingerprint;
  if (typeof stored !== "string" || stored.length === 0) return false;
  return stored === currentFingerprint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2A — Grounding contract and deterministic tokenisation helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface GroundingClause {
  field: "productOrService" | "targetBuyer" | "mainPainPoint";
  text: string;
  requiredTokens: string[];
}

export interface GroundingContract {
  /** Stable fingerprint of the authoritative brief. */
  fingerprint: string;
  /** Material product/service clauses derived from the brief. */
  productClauses: GroundingClause[];
  /** Authoritative core message, if supplied. */
  coreMessage: string;
  /** Authoritative target buyer statement. */
  targetBuyer: string;
  /** Authoritative main pain point statement. */
  mainPainPoint: string;
  /** Authoritative preferred CTA, if supplied. */
  preferredCta?: string;
  /** Authoritative offer details, if supplied. */
  offerDetails?: string;
  /** Parsed excluded-offer terms. */
  excludedOffers: string[];
}

/** Words that carry no material capability and must be ignored by the validator. */
const GROUNDING_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "for", "with", "without", "of", "in", "on", "at", "to", "from", "by",
  "about", "into", "through", "during", "before", "after", "above", "below", "between", "among", "is", "are",
  "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "this", "that", "these", "those", "i", "you", "he", "she", "it",
  "we", "they", "them", "their", "our", "us", "me", "my", "your", "his", "her", "its", "ours", "theirs", "who",
  "what", "which", "when", "where", "why", "how", "all", "each", "every", "both", "few", "more", "most", "other",
  "some", "such", "no", "not", "only", "own", "same", "so", "than", "too", "very", "just", "now", "then", "here",
  "there", "once", "again", "also", "back", "still", "already", "yet", "soon", "today", "new", "old", "first",
  "last", "long", "great", "little", "big", "high", "low", "early", "late", "right", "left", "best", "better",
  "good", "bad", "easy", "hard", "fast", "slow", "quick", "much", "many", "most", "more", "less", "least",
  "enough", "well", "down", "off", "over", "under", "further", "furthermore", "however", "therefore", "thus",
  "hence", "because", "since", "while", "whereas", "although", "though", "unless", "until", "whether",
  "either", "neither", "none", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  // Phase 2A grammatical/context words
  "make", "made", "makes", "difficult", "help", "helps", "helping", "does", "did",
]);

/** Generic mechanism words that should not satisfy a capability clause on their own. */
const GROUNDING_GENERIC_MECHANISM_WORDS = new Set([
  "platform", "platforms", "system", "systems", "solution", "solutions", "service", "services", "tool",
  "tools", "app", "apps", "application", "applications", "software", "website", "websites", "portal",
  "portals", "hub", "hubs", "product", "products",
]);

/** Generic outcome words that should not satisfy a capability clause on their own. */
const GROUNDING_GENERIC_OUTCOME_WORDS = new Set([
  "grow", "growth", "success", "successful", "succeed", "increase", "boost",
  "improve", "better", "best", "more", "less", "greater", "maximize", "optimize", "benefit", "benefits",
]);

/**
 * Bounded, deterministic equivalence groups for genuine business terminology.
 * These are explicit synonyms within a narrow domain, not a general paraphrase
 * engine and not a part-of-speech model.
 */
export const GROUNDING_EQUIVALENCE_GROUPS = [
  ["payout", "payouts", "disbursement", "disbursements"],
  ["reserve", "reserves", "reserved", "reserving", "reservation", "reservations"],
  ["verify", "verifies", "verified", "verifying", "verification"],
  ["administer", "administers", "administered", "administering", "administration"],
] as const;

export function normalizeGroundingText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeGroundingText(value: string): string[] {
  return normalizeGroundingText(value)
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function simpleStem(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("ied") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  if (word.endsWith("ed") && word.length > 3) return word.slice(0, -2);
  if (word.endsWith("ing") && word.length > 4) return word.slice(0, -3);
  return word;
}

export function isGenericGroundingWord(word: string): boolean {
  return GROUNDING_GENERIC_MECHANISM_WORDS.has(word) || GROUNDING_GENERIC_OUTCOME_WORDS.has(word);
}

export function extractRequiredTokens(text: string): string[] {
  return tokenizeGroundingText(text)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length > 1 && !GROUNDING_STOP_WORDS.has(t) && !isGenericGroundingWord(t));
}

export function getEquivalentStems(token: string): Set<string> {
  const normalized = normalizeGroundingText(token).replace(/^-+|-+$/g, "");
  const stems = new Set<string>();
  stems.add(normalized);
  stems.add(simpleStem(normalized));

  for (const group of GROUNDING_EQUIVALENCE_GROUPS) {
    if (group.some((member) => member === normalized)) {
      for (const equivalent of group) {
        stems.add(equivalent);
        stems.add(simpleStem(equivalent));
      }
    }
  }

  return stems;
}

export function outputContainsToken(outputText: string, token: string): boolean {
  const outputTokens = tokenizeGroundingText(outputText);
  const outputStems = new Set(outputTokens.map(simpleStem));

  for (const stem of getEquivalentStems(token)) {
    if (outputStems.has(stem)) return true;
  }
  return false;
}

export function clauseCoversText(clause: GroundingClause, text: string): boolean {
  if (!clause.requiredTokens.length) return true;
  const normalizedText = normalizeGroundingText(text);
  if (!normalizedText) return false;
  return clause.requiredTokens.every((token) => outputContainsToken(text, token));
}

function splitProductClauses(text: string): string[] {
  if (!text) return [];
  return text
    .split(/[,;]+/)
    .flatMap((part) => part.split(/\band\b/i))
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitExcludedOffers(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build an immutable grounding contract from the authoritative grounded brief.
 * The contract is the single source of truth for materialisation and validation;
 * the model output is never used as authority.
 */
export function buildGroundingContract(brief: GroundedCreativeBrief): GroundingContract {
  const productOrService = brief.productOrService || brief.coreMessage || "";
  const targetBuyer = brief.targetBuyer || "";
  const mainPainPoint = brief.mainPainPoint || "";
  return {
    fingerprint: brief.fingerprint,
    productClauses: splitProductClauses(productOrService).map((text) => ({
      field: "productOrService",
      text,
      requiredTokens: extractRequiredTokens(text),
    })),
    coreMessage: brief.coreMessage || "",
    targetBuyer,
    mainPainPoint,
    preferredCta: brief.preferredCta || undefined,
    offerDetails: brief.offerDetails || undefined,
    excludedOffers: splitExcludedOffers(brief.excludedOffers),
  };
}
