import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { generateObject } from "ai";
import { strategyAgentPrompt } from "./prompts";
import { getDb } from "../../queries/connection";
import { agentRuns, campaigns } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { buildGroundedCreativeBrief } from "../creative/brief-grounding";
import { deductCredits, recordAiUsage } from "../billing/credit-engine";
import { enforceCostControl } from "../billing/cost-control";
import { getEstimatedAgentCost } from "../billing/cost-tracker";
import { defaultModel } from "./openai";
import { calculateTokenCost } from "../billing/cost-tracker";
import { emitAgentProviderAlert } from "./provider-error";

function parseBudgetNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    // Extract first numeric value from strings like "$50,000 in the first year"
    const cleaned = value.replace(/[$,]/g, "").replace(/\s+/g, " ");
    const match = cleaned.match(/(\d+(?:\.\d+)?)/);
    if (match) return parseFloat(match[1]);
  }
  return 0;
}

const StrategyOutputSchema = z.object({
  personas: z.array(
    z.object({
      name: z.string(),
      demographics: z.string(),
      painPoints: z.array(z.string()),
      goals: z.array(z.string()),
      platforms: z.array(z.string()),
    })
  ),
  positioning: z.string(),
  valueProposition: z.string(),
  coreMessage: z.string(),
  campaignTheme: z.string(),
  platformStrategy: z.array(
    z.object({
      platform: z.string(),
      purpose: z.string(),
      contentTypes: z.array(z.string()),
      postingFrequency: z.string(),
    })
  ),
  funnelStages: z.array(
    z.object({
      stage: z.string(),
      goal: z.string(),
      tactics: z.array(z.string()),
      metrics: z.array(z.string()),
    })
  ),
  offers: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      targetStage: z.string(),
      value: z.string(),
    })
  ),
  ctas: z.array(
    z.object({
      stage: z.string(),
      cta: z.string(),
      placement: z.string(),
    })
  ),
  budgetRecommendation: z.object({
    total: z.union([z.number(), z.string()]).transform(parseBudgetNumber),
    allocation: z.array(
      z.object({
        channel: z.string(),
        amount: z.union([z.number(), z.string()]).transform(parseBudgetNumber),
        percentage: z.union([z.number(), z.string()]).transform(parseBudgetNumber),
      })
    ),
  }),
});

export type StrategyOutput = z.infer<typeof StrategyOutputSchema>;

export interface StrategyValidationInput {
  output: StrategyOutput & { creativeBriefFingerprint?: string };
  currentFingerprint: string;
  brief: {
    productOrService?: string | null;
    targetBuyer?: string | null;
    mainPainPoint?: string | null;
    preferredCta?: string | null;
    primaryOutcome?: string | null;
    offerDetails?: string | null;
    excludedOffers?: string | null;
    coreMessage?: string | null;
  };
}

export interface StrategyValidationResult {
  valid: boolean;
  reason?: string;
}

export interface StrategyAgentRunResult {
  runId: number;
  output: StrategyOutput;
  promptTokens: number;
  completionTokens: number;
  actualCostUsdMicro: number;
  estimatedCostUsdMicro: number;
}

function normalizeValidationText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(haystack: string, needle: string): boolean {
  if (!needle || !haystack) return false;
  const normalizedHaystack = normalizeValidationText(haystack);
  const normalizedNeedle = normalizeValidationText(needle);
  if (!normalizedNeedle) return false;
  return normalizedHaystack.includes(normalizedNeedle);
}

// Capability-level validation helpers.
//
// These replace literal substring matching for product/service, target buyer and
// main pain point with a deterministic, rule-based check that accepts compound
// descriptions and surface-form variations (word order, plural/singular,
// hyphenation) while rejecting missing core capabilities or generic-only matches.
//
// A small, static set of explicitly documented equivalent-term groups is also
// supported for B2B payout/financial terminology. It is not a general semantic
// paraphrase engine and does not use AI/model calls.

const VALIDATION_STOP_WORDS = new Set([
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
]);

const GENERIC_MECHANISM_WORDS = new Set([
  "platform", "platforms", "system", "systems", "solution", "solutions", "service", "services", "tool",
  "tools", "app", "apps", "application", "applications", "software", "website", "websites", "portal",
  "portals", "hub", "hubs", "product", "products",
]);

const GENERIC_OUTCOME_WORDS = new Set([
  "help", "helps", "helping", "grow", "growth", "success", "successful", "succeed", "increase", "boost",
  "improve", "better", "best", "more", "less", "greater", "maximize", "optimize", "benefit", "benefits",
]);

// Small, conservative equivalent-term groups derived from the existing B2B
// canonical concept set used by brief-grounding.ts. These are deterministic,
// narrowly scoped to financial/payout business terminology, and intentionally
// do not include broad or ambiguous synonyms (e.g. "owner" is not equivalent
// to "manager", "restaurant" is not equivalent to "eatery").
const CAPABILITY_EQUIVALENT_GROUPS = [
  ["payout", "payouts", "disbursement", "disbursements"],
] as const;

function tokenizeValidationText(value: string): string[] {
  return normalizeValidationText(value)
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function simpleStem(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("ied") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  if (word.endsWith("ed") && word.length > 3) return word.slice(0, -2);
  if (word.endsWith("ing") && word.length > 4) return word.slice(0, -3);
  return word;
}

function isGenericCapabilityWord(word: string): boolean {
  return GENERIC_MECHANISM_WORDS.has(word) || GENERIC_OUTCOME_WORDS.has(word);
}

function extractCapabilityTokens(phrase: string): { all: string[]; core: string[] } {
  const all = tokenizeValidationText(phrase)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length > 1 && !VALIDATION_STOP_WORDS.has(t));
  const core = all.filter((t) => !isGenericCapabilityWord(t));
  return { all, core };
}

function equivalentCapabilityStems(token: string): Set<string> {
  const normalized = normalizeValidationText(token).replace(/^-+|-+$/g, "");
  const stems = new Set<string>();
  stems.add(normalized);
  stems.add(simpleStem(normalized));

  for (const group of CAPABILITY_EQUIVALENT_GROUPS) {
    if (group.includes(normalized as any)) {
      for (const equivalent of group) {
        stems.add(equivalent);
        stems.add(simpleStem(equivalent));
      }
    }
  }

  return stems;
}

function outputContainsCapabilityToken(outputText: string, token: string): boolean {
  const outputTokens = tokenizeValidationText(outputText);
  const outputStems = new Set(outputTokens.map(simpleStem));

  for (const stem of equivalentCapabilityStems(token)) {
    if (outputStems.has(stem)) return true;
  }
  return false;
}

function validateCapabilityCoverage(
  outputText: string,
  briefPhrase: string | null | undefined,
  label: string
): StrategyValidationResult | null {
  if (!briefPhrase || !briefPhrase.trim()) return null;

  const { all, core } = extractCapabilityTokens(briefPhrase);
  if (all.length === 0) return null;

  const normalizedOutput = normalizeValidationText(outputText);
  if (!normalizedOutput) {
    return {
      valid: false,
      reason: `Strategy output is empty; cannot validate ${label}: ${briefPhrase}.`,
    };
  }

  // Core capabilities must be preserved. A missing core capability cannot be
  // compensated for by a generic mechanism or outcome word.
  const missingCore: string[] = [];
  for (const token of core) {
    if (!outputContainsCapabilityToken(outputText, token)) {
      missingCore.push(token);
    }
  }

  if (missingCore.length > 0) {
    return {
      valid: false,
      reason: `Strategy output does not materially represent ${label}: ${briefPhrase}. Missing core capabilities: ${missingCore.slice(0, 3).join(", ")}.`,
    };
  }

  // If the brief contains only generic mechanism/outcome words, require a
  // strong majority of them to be present so the output is not purely generic.
  if (core.length === 0) {
    const presentAll = all.filter((t) => outputContainsCapabilityToken(outputText, t));
    if (presentAll.length < Math.max(1, Math.ceil(all.length * 0.67))) {
      return {
        valid: false,
        reason: `Strategy output does not materially represent ${label}: ${briefPhrase}. The description is too generic.`,
      };
    }
  }

  return null;
}

/**
 * Fields that make affirmative product-defining claims. Product/service
 * capability coverage is verified only from these fields so that mentioning a
 * capability in a persona pain point, funnel tactic or platform content type
 * cannot falsely satisfy the product-grounding gate.
 */
function gatherProductDefiningText(output: StrategyOutput): string {
  return [output.coreMessage, output.positioning, output.valueProposition]
    .filter(Boolean)
    .join(" ");
}

/**
 * Fields relevant to target-buyer and pain-point coverage. These include the
 * product-defining fields and the persona blocks, but not funnel tactics,
 * platform content, CTAs or offers, which can mention the buyer or pain point
 * without actually representing them.
 */
function gatherBuyerAndPainPointText(output: StrategyOutput): string {
  const parts: string[] = [
    output.coreMessage,
    output.positioning,
    output.valueProposition,
    output.campaignTheme,
  ];
  for (const persona of output.personas) {
    parts.push(persona.name, persona.demographics, ...persona.painPoints, ...persona.goals);
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * Detects whether a tactic or claim is clearly educational rather than an
 * affirmative product offer. Educational context (e.g. "publish a guide on
 * managing credit risk") may mention a capability without claiming the product
 * provides it.
 */
function isEducationalContext(text: string): boolean {
  const normalized = normalizeValidationText(text);
  const educationalPatterns = [
    /\b(educate|educating|education)\b/,
    /\b(guide|guidebook|whitepaper|ebook|report)\s+(on|about|to)\b/,
    /\bpublish\s+(a\s+)?(guide|whitepaper|ebook|report)\b/,
    /\bmanaging\s+\w+\s+risk\b/,
    /\brisk\s+(in|for|of)\b/,
    /\bchallenges?\s+(in|of|for)\b/,
    /\blearn\s+(about|how)\b/,
  ];
  return educationalPatterns.some((pattern) => pattern.test(normalized));
}

/**
 * Affirmative product-claim collector. Unsupported product claims are only
 * checked in fields where the strategy asserts what the product provides.
 * Contextual fields such as persona pain points, goals, demographics, funnel
 * metrics or platform posting frequency must not trigger a product-claim
 * rejection on their own.
 *
 * Funnel tactics are included because they can actively market an unauthorized
 * product, but purely educational tactics are excluded.
 */
function gatherAffirmativeProductClaimText(output: StrategyOutput): string {
  const parts: string[] = [
    output.coreMessage,
    output.positioning,
    output.valueProposition,
  ];
  for (const fs of output.funnelStages) {
    for (const tactic of fs.tactics) {
      if (!isEducationalContext(tactic)) {
        parts.push(tactic);
      }
    }
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * Complete output text collector used for offer/claim scanning, stale-term
 * detection and excluded-offer checks. These gates must continue to inspect
 * every user-facing field because incentives and excluded terms can be
 * hidden anywhere in the strategy.
 */
function gatherOutputText(output: StrategyOutput): string {
  const parts: string[] = [
    output.coreMessage,
    output.positioning,
    output.valueProposition,
    output.campaignTheme,
  ];
  for (const persona of output.personas) {
    parts.push(persona.name, persona.demographics, ...persona.painPoints, ...persona.goals, ...persona.platforms);
  }
  for (const ps of output.platformStrategy) {
    parts.push(ps.platform, ps.purpose, ...ps.contentTypes, ps.postingFrequency);
  }
  for (const fs of output.funnelStages) {
    parts.push(fs.stage, fs.goal, ...fs.tactics, ...fs.metrics);
  }
  for (const offer of output.offers) {
    parts.push(offer.name, offer.description, offer.targetStage, offer.value);
  }
  for (const cta of output.ctas) {
    parts.push(cta.stage, cta.cta, cta.placement);
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * Deterministic pre-validation grounding. If the model-generated product-defining
 * fields do not materially represent the brief's Product/Service, the
 * authoritative brief text is placed into coreMessage. This is the smallest
 * deterministic guarantee that the semantic validator has a coherent,
 * capability-complete product definition to evaluate. It does not invent
 * capabilities; it only restates the brief itself.
 */
export function groundProductDefiningFields(
  output: StrategyOutput,
  brief: { productOrService?: string | null }
): StrategyOutput {
  if (!brief.productOrService || !brief.productOrService.trim()) {
    return output;
  }

  const productText = gatherProductDefiningText(output);
  const validation = validateCapabilityCoverage(
    productText,
    brief.productOrService,
    "the product/service"
  );

  if (validation && !validation.valid) {
    const grounded = brief.productOrService.trim();
    const coreMessage = grounded.endsWith(".") ? grounded : `${grounded}.`;
    return { ...output, coreMessage };
  }

  return output;
}

// Deterministic detection of unauthorised offers or incentives that may be
// hidden outside the offers array (e.g. in CTAs, core message, funnel
// tactics). These patterns are conservative and only reject recognised
// incentive language. Ordinary informational CTAs such as "learn more" or
// "book a demo" are not flagged.
const UNAUTHORISED_OFFER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bfree\s+trial\b/i, label: "free trial" },
  { pattern: /\bfree\s+access\b/i, label: "free access" },
  { pattern: /\bfree\s+(consultation|consultations)\b/i, label: "free consultation" },
  { pattern: /\bfree\s+(assessment|assessments)\b/i, label: "free assessment" },
  { pattern: /\bfree\s+(audit|audits)\b/i, label: "free audit" },
  { pattern: /\bfree\s+(demo|demos)\b/i, label: "free demo" },
  { pattern: /\bcomplimentary\s+(consultation|consultations)\b/i, label: "complimentary consultation" },
  { pattern: /\bcomplimentary\s+(assessment|assessments)\b/i, label: "complimentary assessment" },
  { pattern: /\bcomplimentary\s+(audit|audits)\b/i, label: "complimentary audit" },
  { pattern: /\bcomplimentary\s+(demo|demos)\b/i, label: "complimentary demo" },
  { pattern: /\bno-cost\s+(consultation|consultations)\b/i, label: "no-cost consultation" },
  { pattern: /\bno-cost\s+(assessment|assessments)\b/i, label: "no-cost assessment" },
  { pattern: /\bno-cost\s+(audit|audits)\b/i, label: "no-cost audit" },
  { pattern: /\bno-cost\s+(demo|demos)\b/i, label: "no-cost demo" },
  { pattern: /\bdiscount\b/i, label: "discount" },
  { pattern: /\bcoupon\b/i, label: "coupon" },
  { pattern: /\blimited[\s-]?time\b/i, label: "limited-time incentive" },
  { pattern: /\bgiveaway\b/i, label: "giveaway" },
  { pattern: /\bbonus\b/i, label: "bonus" },
  { pattern: /\bpromotional\s+credit\b/i, label: "promotional credit" },
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Determines whether a phrase is explicitly authorised in a source text.
 * A phrase is NOT authorised if it only appears in a negated statement such as
 * "no free trial" or "not a discount". This prevents excluded or negated terms
 * from accidentally granting authorization.
 */
function isPhraseExplicitlyAuthorised(sourceText: string | null | undefined, phrase: string): boolean {
  if (!sourceText || !sourceText.trim()) return false;
  const normalizedSource = normalizeValidationText(sourceText);
  const normalizedPhrase = normalizeValidationText(phrase);
  if (!normalizedPhrase || !normalizedSource.includes(normalizedPhrase)) return false;

  const escapedPhrase = normalizedPhrase
    .split(/\s+/)
    .map(escapeRegex)
    .join("\\s+");
  const negationPattern = new RegExp(`\\b(no|not)\\s+${escapedPhrase}\\b`, "i");
  if (negationPattern.test(normalizedSource)) return false;
  return true;
}

function detectUnauthorizedOffers(
  outputText: string,
  offerDetails?: string | null
): string[] {
  const found = new Set<string>();
  for (const { pattern, label } of UNAUTHORISED_OFFER_PATTERNS) {
    if (pattern.test(outputText) && !isPhraseExplicitlyAuthorised(offerDetails, label)) {
      found.add(label);
    }
  }
  return Array.from(found);
}

// Deterministic detection of product claims that are unsupported by the brief.
// A claim is rejected only when it is a material claim in the output and is not
// explicitly authorised by the campaign brief's product/service or core message.
// The authorizeLabels are simpler lookup forms so that a brief authorising
// "fraud prevention" also permits "fraud reduction" output, and vice versa.
const UNSUPPORTED_PRODUCT_CLAIM_PATTERNS: Array<{ pattern: RegExp; label: string; authorizeLabels: string[] }> = [
  { pattern: /\bfraud\s+(prevention|reduction)\b/i, label: "fraud prevention or reduction", authorizeLabels: ["fraud"] },
  { pattern: /\bmultiple\s+payment\s+methods?\b/i, label: "multiple payment methods", authorizeLabels: ["multiple payment methods"] },
  { pattern: /\bcredits?\b/i, label: "credit", authorizeLabels: ["credit"] },
  { pattern: /\b(loans?|lending)\b/i, label: "loan or lending", authorizeLabels: ["loan", "lending"] },
];

function detectUnsupportedProductClaims(
  output: StrategyOutput,
  brief: StrategyValidationInput["brief"]
): string[] {
  const found = new Set<string>();
  const claimText = gatherAffirmativeProductClaimText(output);
  const authorizationSource = [brief.productOrService, brief.coreMessage].filter(Boolean).join(" ");
  for (const { pattern, label, authorizeLabels } of UNSUPPORTED_PRODUCT_CLAIM_PATTERNS) {
    if (!pattern.test(claimText)) continue;
    const authorised = authorizeLabels.some((authLabel) =>
      isPhraseExplicitlyAuthorised(authorizationSource, authLabel)
    );
    if (!authorised) found.add(label);
  }
  return Array.from(found);
}

/**
 * Pure strategy-output validation gate.
 *
 * Confirms that a generated strategy is grounded in the current campaign brief
 * before any approval request or lineage is created. Returns a safe diagnostic
 * when validation fails so the caller can mark the run failed and release the
 * claim without exposing raw output to users.
 */
export function validateStrategyOutput({
  output,
  currentFingerprint,
  brief,
}: StrategyValidationInput): StrategyValidationResult {
  // 1. Fingerprint match — proves the strategy was produced from the current brief.
  if (output.creativeBriefFingerprint !== currentFingerprint) {
    return {
      valid: false,
      reason: "Strategy output fingerprint does not match the current campaign brief.",
    };
  }

  const productText = gatherProductDefiningText(output);
  const buyerAndPainText = gatherBuyerAndPainPointText(output);
  const outputText = gatherOutputText(output);

  // 2. Product/service materially represented (capability-level).
  // Product claims are checked only in product-defining fields so that
  // mentioning a capability as a customer problem or tactic does not pass.
  const productValidation = validateCapabilityCoverage(
    productText,
    brief.productOrService,
    "the product/service"
  );
  if (productValidation) return productValidation;

  // 3. Target buyer materially represented (capability-level).
  const buyerValidation = validateCapabilityCoverage(buyerAndPainText, brief.targetBuyer, "the target buyer");
  if (buyerValidation) return buyerValidation;

  // 4. Main pain point addressed (capability-level).
  const painValidation = validateCapabilityCoverage(
    buyerAndPainText,
    brief.mainPainPoint,
    "the main pain point"
  );
  if (painValidation) return painValidation;

  // 5. Preferred CTA used in the CTA strategy.
  if (brief.preferredCta) {
    const ctaText = output.ctas.map((c) => c.cta).join(" ");
    if (!containsPhrase(ctaText, brief.preferredCta)) {
      return {
        valid: false,
        reason: `Strategy output does not use the preferred CTA: ${brief.preferredCta}.`,
      };
    }
  }

  // 6. Excluded offers/claims absent.
  if (brief.excludedOffers) {
    const excluded = brief.excludedOffers
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const term of excluded) {
      if (containsPhrase(outputText, term)) {
        return {
          valid: false,
          reason: `Strategy output contains excluded offer or claim: ${term}.`,
        };
      }
    }
  }

  // 7. Stale conflicting audience classifications absent.
  const staleTerms = [
    "small businesses",
    "payroll",
    "employee payouts",
    "credit access",
    "mass disbursements",
  ];
  const briefText = [brief.productOrService, brief.targetBuyer, brief.mainPainPoint, brief.offerDetails, brief.excludedOffers]
    .filter(Boolean)
    .join(" ");
  for (const term of staleTerms) {
    if (!containsPhrase(briefText, term) && containsPhrase(outputText, term)) {
      return {
        valid: false,
        reason: `Strategy output contains stale audience classification: ${term}.`,
      };
    }
  }

  // 8. Offers empty unless explicitly authorised by the brief.
  const hasOfferDetails = !!(brief.offerDetails && brief.offerDetails.trim().length > 0);
  if (!hasOfferDetails && output.offers.length > 0) {
    return {
      valid: false,
      reason: "Strategy output invented offers that were not authorised by the campaign brief.",
    };
  }

  // 9. Unauthorised offers or incentives hidden outside the offers array.
  const unauthorisedOffers = detectUnauthorizedOffers(outputText, brief.offerDetails);
  if (unauthorisedOffers.length > 0) {
    return {
      valid: false,
      reason: `Strategy output contains unauthorised offer or incentive: ${unauthorisedOffers.join(", ")}.`,
    };
  }

  // 10. Unsupported product claims not authorised by the brief.
  // Only affirmative product-claim fields are checked so that describing a
  // customer problem or contextual challenge does not trigger a false positive.
  const unsupportedClaims = detectUnsupportedProductClaims(output, brief);
  if (unsupportedClaims.length > 0) {
    return {
      valid: false,
      reason: `Strategy output contains unsupported product claim: ${unsupportedClaims.join(", ")}.`,
    };
  }

  return { valid: true };
}

/**
 * Pure validation gate for an existing strategy run output against the current
 * persisted campaign brief. Rejects runs whose fingerprint matches but whose
 * content is not semantically grounded in the brief.
 */
export function validateStrategyOutputAgainstCampaign(
  output: unknown,
  campaign: unknown
): StrategyValidationResult {
  const brief = buildGroundedCreativeBrief({ campaign });
  const raw = (output || {}) as Record<string, unknown>;
  const parseResult = StrategyOutputSchema.safeParse(raw);
  if (!parseResult.success) {
    return { valid: false, reason: "Strategy output is not a valid strategy structure." };
  }
  const outputWithFingerprint: StrategyOutput & { creativeBriefFingerprint?: string } = {
    ...parseResult.data,
    creativeBriefFingerprint:
      typeof raw.creativeBriefFingerprint === "string" ? raw.creativeBriefFingerprint : undefined,
  };
  return validateStrategyOutput({
    output: outputWithFingerprint,
    currentFingerprint: brief.fingerprint,
    brief,
  });
}

/**
 * Charge exactly 3 credits for a validated strategy run and record AI usage.
 * Idempotent: repeated calls with the same runId debit the wallet only once.
 */
export async function chargeForStrategyRun(
  userId: number,
  campaignId: number,
  result: StrategyAgentRunResult
): Promise<void> {
  const amount = getEstimatedAgentCost("strategy");
  await deductCredits({
    userId,
    amount,
    type: "agent_deduction",
    description: "Strategy generation",
    idempotencyKey: `strategy-run-${result.runId}`,
    metadata: { agentType: "strategy", campaignId, runId: result.runId },
  });

  await recordAiUsage({
    userId,
    campaignId,
    agentType: "strategy",
    model: "gpt-4o-mini",
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    actualCostUsdMicro: result.actualCostUsdMicro,
    estimatedCostUsdMicro: result.estimatedCostUsdMicro,
    creditsDeducted: amount,
    metadata: { runId: result.runId },
  });
}

export async function runStrategyAgent({
  userId,
  campaignId,
  business,
  strategyText,
  campaignBrief,
  onRunCreated,
}: {
  userId: number;
  campaignId: number;
  business: {
    name: string;
    industry?: string | null;
    location?: string | null;
    productOrService?: string | null;
    targetCustomer?: string | null;
    brandTone?: string | null;
    mainGoal?: string | null;
    monthlyBudget?: number | null;
    preferredPlatforms?: string | null;
    website?: string | null;
    websiteEvidence?: unknown;
  };
  strategyText?: string;
  campaignBrief?: {
    name?: string;
    goal?: string;
    targetAudience?: string;
    coreMessage?: string;
    platforms?: string;
    budget?: number;
    primaryOutcome?: string;
    targetBuyer?: string;
    mainPainPoint?: string;
    productOrService?: string;
    offerDetails?: string;
    preferredCta?: string;
    excludedOffers?: string;
    referenceStyle?: string;
    contentStyle?: string;
  };
  /**
   * Called inside the same database transaction that creates the strategy run.
   * Receives the new run ID and the transaction object. If this callback throws,
   * the transaction rolls back and the run row is never committed, so the
   * caller can release the claim as failed without leaving an orphaned run.
   */
  onRunCreated?: (runId: number, tx: any) => void | Promise<void>;
}): Promise<StrategyAgentRunResult> {
  const db = getDb();

  // Load the persisted campaign so the fingerprint is computed from the
  // current brief, even when the caller did not pass an explicit campaignBrief.
  const [currentCampaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.userId, userId), eq(campaigns.id, campaignId)))
    .limit(1);

  const previousCampaigns = currentCampaign?.businessId
    ? await db
        .select({ id: campaigns.id, workflowContext: campaigns.workflowContext })
        .from(campaigns)
        .where(
          and(
            eq(campaigns.userId, userId),
            eq(campaigns.businessId, currentCampaign.businessId)
          )
        )
        .orderBy(desc(campaigns.createdAt))
        .limit(10)
    : [];

  const audienceIntelligenceSummaries = previousCampaigns
    .filter((c) => c.id !== campaignId)
    .map((c) => {
      const ctx = (c.workflowContext || {}) as Record<string, unknown>;
      const summary = ctx?.audienceIntelligenceSummary as Record<string, unknown> | undefined;
      return summary?.executiveSummary ? String(summary.executiveSummary) : null;
    })
    .filter((s): s is string => !!s)
    .slice(0, 3);

  const prompt = strategyAgentPrompt({
    businessName: business.name,
    industry: business.industry ?? undefined,
    location: business.location ?? undefined,
    productOrService: business.productOrService ?? undefined,
    targetCustomer: business.targetCustomer ?? undefined,
    brandTone: business.brandTone ?? undefined,
    mainGoal: business.mainGoal ?? undefined,
    monthlyBudget: business.monthlyBudget ?? undefined,
    preferredPlatforms: business.preferredPlatforms ?? undefined,
    website: business.website ?? undefined,
    websiteEvidence: business.websiteEvidence,
    strategyText,
    campaignBrief,
    audienceIntelligenceSummaries,
  });

  const estimatedCost = getEstimatedAgentCost("strategy");

  // Preserve the pre-flight cost control that runAgent normally performs when
  // billing is enabled. We skip billing inside runAgent so that the 3-credit
  // charge can be tied to the strategy run ID and applied only after output
  // validation passes.
  const costControl = await enforceCostControl(userId, estimatedCost);
  if (!costControl.allowed) {
    throw new TRPCError({
      code: "PAYMENT_REQUIRED",
      message: costControl.reason || "Insufficient credits for strategy generation.",
    });
  }

  // Create the run row and, atomically within the same transaction, attach it
  // to the caller's regeneration claim. The transaction commits before any AI
  // generation occurs, so a committed run always has its claim reference. If
  // the callback throws (e.g. claim attachment collision), the transaction
  // rolls back and no run row is persisted.
  const systemPrompt =
    "You are a world-class marketing strategist. You create detailed, actionable marketing strategies for businesses. Always respond with valid structured data.";
  const runId = await db.transaction(async (tx) => {
    const [insertResult] = await tx.insert(agentRuns).values({
      userId,
      campaignId,
      agentType: "strategy",
      status: "running",
      input: { prompt, system: systemPrompt },
      startedAt: new Date(),
    });

    const newRunId = Number(insertResult.insertId);
    if (onRunCreated) {
      await onRunCreated(newRunId, tx);
    }
    return newRunId;
  });

  // Generate the strategy output outside the transaction. The run row is
  // already committed and linked to the claim, so a later failure here leaves
  // the reference intact.
  let generatedOutput: StrategyOutput;
  let promptTokens = 0;
  let completionTokens = 0;
  let actualCostUsdMicro = 0;
  let estimatedCostUsdMicro = 0;

  try {
    const genResult = await generateObject({
      model: defaultModel,
      system: systemPrompt,
      prompt,
      schema: StrategyOutputSchema,
    });

    generatedOutput = genResult.object as StrategyOutput;
    const usage = (genResult as any).usage;
    promptTokens = usage?.promptTokens ?? 0;
    completionTokens = usage?.completionTokens ?? 0;

    const costs = calculateTokenCost(defaultModel as any, promptTokens, completionTokens);
    actualCostUsdMicro = costs.actualCostUsdMicro;
    estimatedCostUsdMicro = costs.estimatedCostUsdMicro;
  } catch (error: any) {
    await db
      .update(agentRuns)
      .set({
        status: "failed",
        error: error.message || String(error),
        completedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));

    // Preserve provider/quota observability parity with the generic agent runner.
    // This alert is best-effort: if it fails, the original generation error is
    // still thrown and the linked run remains failed.
    await emitAgentProviderAlert({
      agentType: "strategy",
      runId,
      userId,
      error,
    }).catch(() => {});

    throw error;
  }

  // Compute the fingerprint of the brief that produced this strategy so later
  // workflow steps can detect whether the campaign brief changed afterwards.
  const fingerprintSource = campaignBrief
    ? ({ ...campaignBrief } as Record<string, unknown>)
    : currentCampaign ?? {};
  const brief = buildGroundedCreativeBrief({ campaign: fingerprintSource });
  const briefFingerprint = brief.fingerprint;

  // Deterministic grounding: if the model-generated product-defining fields do
  // not materially represent the brief, replace coreMessage with the brief's own
  // Product/Service text. This is the smallest deterministic guarantee that
  // required capabilities survive prompt drift before semantic validation runs.
  const groundedOutput = groundProductDefiningFields(generatedOutput, brief);

  const outputWithFingerprint = {
    ...groundedOutput,
    creativeBriefFingerprint: briefFingerprint,
  };

  // Pure validation gate: reject stale/ungrounded strategy output before any
  // charge, approval request, lineage or workflow transition.
  const validation = validateStrategyOutput({
    output: outputWithFingerprint,
    currentFingerprint: briefFingerprint,
    brief,
  });

  if (!validation.valid) {
    // Mark the run failed with a safe diagnostic. The caller releases the claim
    // and reports a sanitized error; no credits are charged and no approval is
    // created.
    await db
      .update(agentRuns)
      .set({
        status: "failed",
        error: validation.reason,
        completedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));

    throw new TRPCError({
      code: "UNPROCESSABLE_CONTENT",
      message: validation.reason || "Strategy output failed validation. Please review the campaign brief and retry.",
    });
  }

  // Only after validation succeeds do we record the run as completed. This
  // guarantees that a validation-failed run is never transiently or permanently
  // stored as completed, and that agentRuns, the returned result and the
  // campaign record all reference the same grounded strategy.
  await db
    .update(agentRuns)
    .set({
      status: "completed",
      output: outputWithFingerprint as any,
      completedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId));

  // Save strategy output to campaign
  await db
    .update(campaigns)
    .set({
      strategyDocument: strategyText || null,
      personas: groundedOutput.personas as any,
      funnelStages: groundedOutput.funnelStages as any,
      offers: groundedOutput.offers as any,
      ctaStrategy: groundedOutput.ctas.map((c) => `${c.stage}: ${c.cta}`).join("\n"),
      workflowContext: {
        strategyGeneratedAt: new Date().toISOString(),
        strategyRunId: runId,
        strategyFingerprint: briefFingerprint,
        positioning: groundedOutput.positioning,
        valueProposition: groundedOutput.valueProposition,
        coreMessage: groundedOutput.coreMessage,
        campaignTheme: groundedOutput.campaignTheme,
        budgetRecommendation: groundedOutput.budgetRecommendation,
        location: business.location || null,
        industry: business.industry || null,
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  return {
    runId,
    output: groundedOutput,
    promptTokens,
    completionTokens,
    actualCostUsdMicro,
    estimatedCostUsdMicro,
  };
}
