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
  /** Authorised channels/platforms supplied by the campaign brief. */
  platforms?: string | null;
}

export type BusinessTypeClassification = "B2B" | "B2C" | "mixed" | "not_specified";

export interface GroundedCreativeBrief extends CreativeBriefFingerprintInput {
  /** Stable SHA-256 fingerprint of the campaign brief. */
  fingerprint: string;
  /** Resolved business type; never silently defaults to B2C. */
  businessType: BusinessTypeClassification;
  /** Authorised channels/platforms derived from the brief, normalised. */
  authorisedChannels?: string[];
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
  "platforms",
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
  const platforms = campaignInput.platforms || "";
  const authorisedChannels = parseAuthorisedChannels(platforms);

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
    platforms,
    fingerprint,
    businessType,
    authorisedChannels,
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
  field: "productOrService" | "coreMessage" | "targetBuyer" | "mainPainPoint" | "primaryOutcome";
  text: string;
  requiredTokens: string[];
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
  // Phase 3 correction: bounded security/secure equivalence covers the
  // verb/adjective form of an explicitly authorised security capability.
  // "securities" (financial instruments) is intentionally excluded.
  ["security", "secure", "securely", "secures", "secured", "securing"],
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
  const coreMessage = brief.coreMessage || "";
  const targetBuyer = brief.targetBuyer || "";
  const mainPainPoint = brief.mainPainPoint || "";
  const primaryOutcome = brief.primaryOutcome || "";
  const offerDetails = brief.offerDetails || "";

  const productClauses = splitProductClauses(productOrService).map((text) => ({
    field: "productOrService" as const,
    text,
    requiredTokens: extractRequiredTokens(text),
  }));

  // Feature clauses are derived from the core message, if it adds detail beyond
  // the product/service statement; otherwise they mirror product clauses.
  const featureClauses =
    coreMessage && coreMessage.trim().length > 0 && coreMessage !== productOrService
      ? splitProductClauses(coreMessage).map((text) => ({
          field: "coreMessage" as const,
          text,
          requiredTokens: extractRequiredTokens(text),
        }))
      : productClauses;

  const outcomeTexts: string[] = [];
  if (primaryOutcome) {
    outcomeTexts.push(primaryOutcome);
  }
  for (const clause of productClauses) {
    for (const token of clause.requiredTokens) {
      if (isGenericGroundingWord(simpleStem(token))) {
        // outcome-flavoured token embedded in product description
        outcomeTexts.push(clause.text);
        break;
      }
    }
  }

  // Authoritative sources by category:
  // - capabilities/features: productOrService and coreMessage
  // - outcomes: primaryOutcome, plus outcome-flavoured product clauses
  // - channels: platforms / authorisedChannels
  // - offers: offerDetails
  // - programmes: productOrService, coreMessage, offerDetails (only if explicitly named)
  // - comparisons: productOrService, coreMessage, offerDetails
  const programmeSources = [productOrService, coreMessage, offerDetails]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join(" ");

  return {
    fingerprint: brief.fingerprint,
    productOrService,
    productClauses,
    coreMessage,
    targetBuyer,
    mainPainPoint,
    primaryOutcome,
    preferredCta: brief.preferredCta || undefined,
    offerDetails: brief.offerDetails || undefined,
    excludedOffers: splitExcludedOffers(brief.excludedOffers),
    authorized: {
      capabilities: productClauses,
      features: featureClauses,
      outcomes: outcomeTexts,
      channels: brief.authorisedChannels || [],
      offers: parseAuthorisedOfferClauses(offerDetails),
      programmes: buildProgrammeAuthorizations(programmeSources),
      comparisons: buildComparisonAuthorizations(brief),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — Domain-independent authorised-content contract and provenance
// validation.  The model output is never the authority for factual claims.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classification of provenance diagnostics.  These labels are stable and
 * domain-independent; they describe *why* a piece of generated text is or is
 * not acceptable, not what the specific business domain is.
 */
export type ProvenanceClassification =
  | "authoritative"
  | "safe_execution"
  | "unauthorised_claim"
  | "unauthorised_programme"
  | "unauthorised_channel"
  | "unauthorised_offer"
  | "unsupported_comparison";

export interface ProvenanceDiagnostic {
  /** Output field path, e.g. "personas[0].goals[0]". */
  field: string;
  /** Generated text being classified. */
  generatedText: string;
  /** Authority source from the contract, if any. */
  authoritySource?: string;
  classification: ProvenanceClassification;
  reason: string;
  /** Remediation performed, if any. */
  remediation?: "replaced" | "removed" | "none";
}

export interface AuthorizedContentContract {
  /** Authorised product/service capabilities derived from productOrService/coreMessage. */
  capabilities: GroundingClause[];
  /** Authorised features derived from productOrService/coreMessage clauses. */
  features: GroundingClause[];
  /** Authorised outcomes/benefits derived from primaryOutcome and product clauses. */
  outcomes: string[];
  /** Authorised channels/platforms derived from the brief's platforms field. */
  channels: string[];
  /** Authorised offers parsed from offerDetails. */
  offers: string[];
  /**
   * Authorised programmes (webinar, consultation, assessment, etc.).
   * Authority sources: productOrService, coreMessage, offerDetails.
   * A programme is authorised only when explicitly named in one of those fields.
   */
  programmes: string[];
  /** Authorised comparison/superlative claims; empty unless explicitly present in brief. */
  comparisons: string[];
}

export interface GroundingContract {
  /** Stable fingerprint of the authoritative brief. */
  fingerprint: string;
  /** Original authoritative product/service statement. */
  productOrService: string;
  /** Material product/service clauses derived from the brief. */
  productClauses: GroundingClause[];
  /** Authoritative core message, if supplied. */
  coreMessage: string;
  /** Authoritative target buyer statement. */
  targetBuyer: string;
  /** Authoritative main pain point statement. */
  mainPainPoint: string;
  /** Authoritative primary outcome, if supplied. */
  primaryOutcome: string;
  /** Authoritative preferred CTA, if supplied. */
  preferredCta?: string;
  /** Authoritative offer details, if supplied. */
  offerDetails?: string;
  /** Parsed excluded-offer terms. */
  excludedOffers: string[];
  /** Authorised content categories derived only from the brief. */
  authorized: AuthorizedContentContract;
}

/**
 * Parse a comma, semicolon or newline separated channel string into normalised
 * channel names.  Empty or non-string input yields an empty array.
 */
function parseAuthorisedChannels(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(/[,;\n]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Bounded, domain-independent safe execution taxonomy.  These are generic
 * marketing/execution actions that do not assert product facts, outcomes or
 * capabilities.  They may be used in funnel tactics, persona goals, campaign
 * themes and platform strategy without requiring explicit product authorisation.
 */
export const SAFE_EXECUTION_TERMS = new Set([
  // generic marketing verbs
  "reach", "reachs", "reaching",
  "engage", "engages", "engaging",
  "connect", "connects", "connecting",
  "build", "builds", "building",
  "create", "creates", "creating",
  "share", "shares", "sharing",
  "post", "posts", "posting",
  "publish", "publishes", "publishing",
  "distribute", "distributes", "distributing",
  "promote", "promotes", "promoting",
  "advertise", "advertises", "advertising",
  "run", "runs", "running",
  "launch", "launches", "launching",
  "drive", "drives", "driving",
  "convert", "converts", "converting",
  "nurture", "nurtures", "nurturing",
  "retain", "retains", "retaining",
  "measure", "measures", "measuring",
  "track", "tracks", "tracking",
  "test", "tests", "testing",
  "optimise", "optimises", "optimising",
  "optimize", "optimizes", "optimizing",
  "guide", "guides", "guiding",
  "educate", "educates", "educating",
  "inform", "informs", "informing",
  "remind", "reminds", "reminding",
  "follow", "follows", "following",
  "up", // as in "follow up"
  // funnel/stage nouns
  "awareness", "consideration", "conversion", "retention",
  "funnel", "stage", "journey",
  "content", "message", "messages",
  "ad", "ads",
  "campaign", "campaigns",
  "audience", "audiences",
  "traffic",
  "lead", "leads",
  "prospect", "prospects",
  "engagement",
  "impression", "impressions",
  "click", "clicks",
  "booking", "bookings",
  "signup", "signups", "sign-up", "sign-ups",
  "demo", // as a stage ("book a demo") only when not a programme
  "demonstration",
  "call",
  "request",
  "response",
  "reply",
  // content formats that are execution-only
  "image", "images",
  "video", "videos",
  "carousel", "carousels",
  "story", "stories",
  "reel", "reels",
  "testimonial", "testimonials",
  "review", "reviews",
  "case", "study", "case study", "case studies",
  "post", // as in social post
  "article", "articles",
  "update", "updates",
  // timing/frequency
  "weekly", "monthly", "daily",
  "per", "week", "month", "day",
  "morning", "afternoon", "evening",
  // relationship words without product fact
  "customer", "customers",
  "client", "clients",
  "user", "users",
  "buyer", "buyers",
  "audience",
  "community",
  "team", "teams",
  "decision", "maker", "makers",
  // location/context (must still avoid invented demographics)
  "local",
]);

/**
 * Programme formats that require explicit authorisation.  These introduce a
 * service, offer or ongoing commitment that must be grounded in the brief.
 */
export const PROGRAMME_TAXONOMY = [
  "webinar",
  "webinars",
  "workshop",
  "workshops",
  "seminar",
  "seminars",
  "consultation",
  "consultations",
  "assessment",
  "assessments",
  "audit",
  "audits",
  "demo",
  "demos",
  "demonstration",
  "demonstrations",
  "trial",
  "trials",
  "free trial",
  "free trials",
  "newsletter",
  "newsletters",
  "loyalty",
  "programme",
  "program",
  "programmes",
  "programs",
  "customer support",
  "help desk",
  "helpdesk",
  "support desk",
  "account manager",
  "account management",
  "e-book",
  "ebook",
  "whitepaper",
  "whitepapers",
  "report",
  "reports",
  "calculator",
  "calculators",
  "guarantee",
  "guarantees",
  "warranty",
  "warranties",
];

/**
 * Comparison and superlative patterns that require explicit authorisation.
 */
export const COMPARISON_TAXONOMY = [
  "unparalleled",
  "unmatched",
  "unbeatable",
  "best",
  "leading",
  "top",
  "number one",
  "#1",
  "guaranteed",
  "guarantee",
  "promise",
  "promised",
  "risk-free",
  "risk free",
  "no risk",
  "effortless",
  "seamless",
  "ultimate",
  "superior",
  "premier",
  "first-class",
  "first class",
  "world-class",
  "world class",
  "only",
  "fastest",
  "easiest",
  "most reliable",
  "most trusted",
];

/**
 * Factual capability/outcome words that require explicit authorisation in the
 * brief.  These are common business claims that, if introduced by the model,
 * would invent product capabilities or outcomes not grounded in the brief.
 */
export const CLAIM_REQUIRING_AUTHORIZATION_TAXONOMY = [
  "security",
  "secure",
  "safeguard",
  "safeguards",
  "compliance",
  "compliant",
  "comply",
  "regulatory",
  "regulation",
  "cash flow",
  "cashflow",
  "cash-flow",
  "automation",
  "automate",
  "automated",
  "automatic",
  "automatically",
  "efficiency",
  "efficient",
  "efficiently",
  "control",
  "controls",
  "controlled",
  "customer support",
  "support desk",
  "help desk",
  "service enhancements",
  "latest offerings",
  "new features",
];

/**
 * Common channel/platform names for detection.  Authorised channels are always
 * taken from the brief; this list is used only to spot unauthorised mentions.
 */
export const KNOWN_CHANNELS = new Set([
  "facebook",
  "instagram",
  "linkedin",
  "twitter",
  "x",
  "tiktok",
  "youtube",
  "google",
  "search",
  "email",
  "sms",
  "whatsapp",
  "website",
  "blog",
  "pinterest",
  "snapchat",
  "reddit",
  "telegram",
  "display",
  "ppc",
  "retargeting",
]);

function normalizeProvenanceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeProvenanceText(value: string): string[] {
  return normalizeProvenanceText(value)
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phraseExists(haystack: string, needle: string): boolean {
  const normalizedHaystack = normalizeProvenanceText(haystack);
  const normalizedNeedle = normalizeProvenanceText(needle);
  if (!normalizedHaystack || !normalizedNeedle) return false;

  const tokens = normalizedNeedle.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  const escaped = tokens.map(escapeRegex).join("\\s+");
  const regex = new RegExp(`\\b${escaped}\\b`, "i");
  return regex.test(normalizedHaystack);
}

/**
 * Check whether a claim-requiring taxonomy term is authorised by the brief.
 * Uses the same deterministic stemming/equivalence helpers as field grounding
 * so morphological variants (e.g. "controlled" authorising "control") are
 * recognised without falling back to loose substring matching.
 */
function isClaimTermAuthorized(source: string, term: string): boolean {
  const normalizedSource = normalizeProvenanceText(source);
  const normalizedTerm = normalizeProvenanceText(term);
  if (!normalizedSource || !normalizedTerm) return false;

  if (normalizedTerm.includes(" ")) {
    const tokens = normalizedTerm.split(/\s+/).map(escapeRegex);
    const regex = new RegExp(`\\b${tokens.join("\\s+")}\\b`, "i");
    return regex.test(normalizedSource);
  }

  return outputContainsToken(source, term);
}

function parseAuthorisedOfferClauses(offerDetails: string | undefined): string[] {
  if (!offerDetails) return [];
  return offerDetails
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the set of authorised programme formats.
 * Programmes are authorised only when explicitly named in one of the
 * authoritative brief fields: productOrService, coreMessage, or offerDetails.
 * The presence of an offer does not automatically authorise unrelated
 * programme formats.
 */
function buildProgrammeAuthorizations(sourcesText: string): string[] {
  if (!sourcesText) return [];
  const normalized = normalizeProvenanceText(sourcesText);
  const authorised = new Set<string>();
  for (const programme of PROGRAMME_TAXONOMY) {
    if (normalized.includes(programme)) {
      authorised.add(programme);
      // Also add the stemmed/canonical form so a plural brief authorises
      // singular output and vice versa.
      const stemmed = simpleStem(programme);
      if (stemmed && stemmed !== programme) authorised.add(stemmed);
    }
  }
  return Array.from(authorised);
}

function buildComparisonAuthorizations(brief: GroundedCreativeBrief): string[] {
  const sources = [
    brief.productOrService,
    brief.coreMessage,
    brief.offerDetails,
  ].filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  const authorised: string[] = [];
  for (const comparison of COMPARISON_TAXONOMY) {
    for (const source of sources) {
      if (phraseExists(source, comparison)) {
        authorised.push(comparison);
        break;
      }
    }
  }
  return authorised;
}

/**
 * Authoritative sources that can explicitly authorise factual claims.  A claim
 * is authorised only if the exact phrase appears in one of these brief fields.
 */
function buildClaimAuthorizationSource(contract: GroundingContract): string {
  return [
    contract.productOrService,
    contract.coreMessage,
    contract.offerDetails,
    contract.primaryOutcome,
  ]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join(" ");
}

interface TextField {
  path: string;
  text: string;
}

function* walkTextFields(output: unknown, path = "output"): Generator<TextField> {
  if (output == null) return;
  if (typeof output === "string") {
    if (output.trim()) yield { path, text: output };
    return;
  }
  if (Array.isArray(output)) {
    for (let i = 0; i < output.length; i++) {
      yield* walkTextFields(output[i], `${path}[${i}]`);
    }
    return;
  }
  if (typeof output === "object") {
    for (const [key, value] of Object.entries(output)) {
      yield* walkTextFields(value, `${path}.${key}`);
    }
  }
}

export interface ProvenanceValidationResult {
  valid: boolean;
  diagnostics: ProvenanceDiagnostic[];
}

function isPreferredCtaField(path: string, contract: GroundingContract): boolean {
  if (!contract.preferredCta) return false;
  return path.includes("ctas");
}

/**
 * Remove occurrences of the preferred CTA from text so that execution fields
 * (funnel tactics, goals, platform purpose) can reference the authorised CTA
 * without being flagged for embedded programme words such as "demo".
 */
function removePreferredCta(text: string, contract: GroundingContract): string {
  if (!contract.preferredCta) return text;
  const normalizedCta = normalizeProvenanceText(contract.preferredCta);
  if (!normalizedCta) return text;
  const escaped = normalizedCta.split(/\s+/).map(escapeRegex).join("\\s+");
  const regex = new RegExp(`\\b${escaped}\\b`, "gi");
  return text.replace(regex, " ").replace(/\s+/g, " ").trim();
}

/**
 * Domain-independent provenance validation.  Every user-facing text field is
 * classified against the authorised-content contract and bounded taxonomies.
 * A field fails only if it contains a comparison, programme, claim-requiring
 * word or channel that is not explicitly authorised by the brief.  Neutral
 * marketing execution language is not rejected.
 *
 * With fail-closed materialisation, this validator is defence in depth: every
 * field should already be canonical. It remains as a safety net for any
 * residual unsafe content.
 */
export function validateProvenance(
  output: Record<string, unknown>,
  contract: GroundingContract
): ProvenanceValidationResult {
  const diagnostics: ProvenanceDiagnostic[] = [];
  const claimAuthorizationSource = buildClaimAuthorizationSource(contract);

  for (const { path, text } of walkTextFields(output, "output")) {
    // Skip fingerprint and purely numeric fields.
    if (path === "output.creativeBriefFingerprint") continue;

    // The preferred CTA is always authorised inside CTA fields.
    if (isPreferredCtaField(path, contract) && contract.preferredCta && phraseExists(text, contract.preferredCta)) {
      continue;
    }

    // Execution fields may reference the preferred CTA; strip it before
    // checking programmes/claims so "Book a Demo" does not flag "demo".
    const textToCheck = isPreferredCtaField(path, contract) ? text : removePreferredCta(text, contract);
    if (!textToCheck) continue;

    // Unsupported comparisons/superlatives. Check every taxonomy term present
    // in the field, not only the first, so an authorised term cannot smuggle an
    // unauthorised one through the same field.
    let fieldHasUnauthorized = false;
    for (const comparison of COMPARISON_TAXONOMY) {
      if (phraseExists(textToCheck, comparison) && !phraseExists(claimAuthorizationSource, comparison)) {
        diagnostics.push({
          field: path,
          generatedText: text,
          classification: "unsupported_comparison",
          reason: `Unsupported comparative/superlative claim: "${comparison}". Only comparisons explicitly present in the brief are allowed.`,
          remediation: "removed",
        });
        fieldHasUnauthorized = true;
      }
    }
    if (fieldHasUnauthorized) continue;

    // Unauthorised programmes. Use the same stemming/equivalence check as field
    // grounding so a singular authorised programme also covers plural output.
    fieldHasUnauthorized = false;
    for (const programme of PROGRAMME_TAXONOMY) {
      if (
        phraseExists(textToCheck, programme) &&
        !contract.authorized.programmes.some((p) => isClaimTermAuthorized(textToCheck, p))
      ) {
        diagnostics.push({
          field: path,
          generatedText: text,
          classification: "unauthorised_programme",
          reason: `Unauthorised programme or service format: "${programme}". Programme formats must be explicitly authorised by the brief.`,
          remediation: "removed",
        });
        fieldHasUnauthorized = true;
      }
    }
    if (fieldHasUnauthorized) continue;

    // Factual claims that require explicit authorisation (security, compliance,
    // cash flow, automation, customer support, etc.).
    fieldHasUnauthorized = false;
    for (const claimTerm of CLAIM_REQUIRING_AUTHORIZATION_TAXONOMY) {
      if (phraseExists(textToCheck, claimTerm) && !isClaimTermAuthorized(claimAuthorizationSource, claimTerm)) {
        diagnostics.push({
          field: path,
          generatedText: text,
          classification: "unauthorised_claim",
          reason: `Unsupported factual claim: "${claimTerm}". The brief does not authorise this capability, outcome or service.`,
          remediation: "removed",
        });
        fieldHasUnauthorized = true;
      }
    }
    if (fieldHasUnauthorized) continue;

    // Unauthorised channels.
    const tokens = tokenizeProvenanceText(textToCheck);
    for (const token of tokens) {
      if (KNOWN_CHANNELS.has(token) && !contract.authorized.channels.includes(token)) {
        diagnostics.push({
          field: path,
          generatedText: text,
          classification: "unauthorised_channel",
          reason: `Unauthorised channel "${token}". Only channels explicitly supplied by the brief are allowed.`,
          remediation: "removed",
        });
        break;
      }
    }
  }

  return {
    valid: diagnostics.length === 0,
    diagnostics,
  };
}
