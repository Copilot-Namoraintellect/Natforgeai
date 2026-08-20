import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  generateObject,
  NoObjectGeneratedError,
  TypeValidationError,
} from "ai";
import { strategyAgentPrompt } from "./prompts";
import { getDb } from "../../queries/connection";
import { agentRuns, campaigns } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import {
  buildGroundedCreativeBrief,
  buildGroundingContract,
  type GroundedCreativeBrief,
  type GroundingContract,
  clauseCoversText,
  extractRequiredTokens,
  outputContainsToken,
  validateProvenance,
} from "../creative/brief-grounding";
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

// Schema change in Phase 2A:
// - personas and ctas are now required to contain at least one entry so that
//   deterministic materialisation has an authoritative field to repair.
export const StrategyOutputSchema = z.object({
  personas: z.array(
    z.object({
      name: z.string(),
      demographics: z.string(),
      painPoints: z.array(z.string()),
      goals: z.array(z.string()),
      platforms: z.array(z.string()),
    })
  ).min(1, "At least one persona is required."),
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
  ).min(1, "At least one CTA is required."),
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
  brief: Omit<GroundedCreativeBrief, "fingerprint" | "businessType"> &
    Partial<Pick<GroundedCreativeBrief, "fingerprint" | "businessType">>;
}

export interface ValidationDiagnostic {
  gate: string;
  authoritativeField: string;
  expectedClauses: string[];
  missingClauses: string[];
  inspectedOutputFields: string[];
  reason: string;
}

export interface StrategyValidationResult {
  valid: boolean;
  reason?: string;
  diagnostics?: ValidationDiagnostic[];
}

export interface StrategyAgentRunResult {
  runId: number;
  output: StrategyOutput;
  promptTokens: number;
  completionTokens: number;
  actualCostUsdMicro: number;
  estimatedCostUsdMicro: number;
}

/**
 * Typed discriminator for agentRuns.output values.
 *
 * Failure envelopes (generated_candidate, failed_validation, failed_generation,
 * failed_schema) carry an `outcome` property. Successful completed runs carry a
 * flat StrategyOutput plus `creativeBriefFingerprint` and never contain an
 * `outcome` field.
 *
 * This function rejects any object that owns `outcome`, then validates the
 * remaining shape with the same schema used for generated output so successful
 * output is not confused with a malformed legacy row.
 */
export function isSuccessfulStrategyOutput(
  output: unknown
): output is StrategyOutput & { creativeBriefFingerprint: string } {
  if (!output || Array.isArray(output) || typeof output !== "object") return false;

  // Any object that owns an outcome property is an evidence envelope, not a
  // successful strategy, regardless of the outcome value or type.
  if (Object.prototype.hasOwnProperty.call(output, "outcome")) return false;

  const o = output as Record<string, unknown>;

  // A successful flat output must carry the fingerprint of the brief that
  // produced it.
  if (typeof o.creativeBriefFingerprint !== "string" || o.creativeBriefFingerprint.length === 0) {
    return false;
  }

  // Validate the remaining shape with the authoritative schema so malformed
  // legacy rows cannot be mistaken for successful output.
  return StrategyOutputSchema.safeParse(o).success;
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

// ─────────────────────────────────────────────────────────────────────────────
// Field ownership helpers — strict scoping per Phase 2A
// ─────────────────────────────────────────────────────────────────────────────

function gatherProductDefiningText(output: StrategyOutput): string {
  return [output.coreMessage, output.positioning, output.valueProposition]
    .filter(Boolean)
    .join(" ");
}

function gatherBuyerText(output: StrategyOutput): string {
  return output.personas
    .map((p) => [p.name, p.demographics].filter(Boolean).join(" "))
    .join(" ");
}

function gatherPainPointText(output: StrategyOutput): string {
  return output.personas.flatMap((p) => p.painPoints).filter(Boolean).join(" ");
}

function gatherCtaText(output: StrategyOutput): string {
  return output.ctas.map((c) => c.cta).join(" ");
}

function gatherAffirmativeProductClaimText(output: StrategyOutput): string {
  const parts: string[] = [output.coreMessage, output.positioning, output.valueProposition];
  for (const fs of output.funnelStages) {
    for (const tactic of fs.tactics) {
      if (!isEducationalContext(tactic)) {
        parts.push(tactic);
      }
    }
  }
  return parts.filter(Boolean).join(" ");
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic materialisation
// ─────────────────────────────────────────────────────────────────────────────

function buildCanonicalProductStatement(input: {
  productOrService?: string | null;
  coreMessage?: string | null;
}): string {
  const product = (input.productOrService || "").trim();
  const coreMessage = (input.coreMessage || "").trim();

  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  const productStatement = product.endsWith(".") ? product.slice(0, -1) : product;
  const coreStatement = coreMessage.endsWith(".") ? coreMessage.slice(0, -1) : coreMessage;

  if (productStatement && coreStatement) {
    const productNorm = normalize(productStatement);
    const coreNorm = normalize(coreStatement);
    // Avoid duplicating a core message whose substance is already covered by
    // the product statement.
    if (coreNorm && (productNorm.includes(coreNorm) || coreNorm.includes(productNorm))) {
      return productStatement.endsWith(".") ? productStatement : `${productStatement}.`;
    }
    return `${productStatement}. ${coreStatement}.`;
  }

  const statement = productStatement || coreStatement || "";
  return statement.endsWith(".") ? statement : `${statement}.`;
}

/**
 * Deterministic, neutral positioning statement constructed only from brief
 * phrases.  It never adds superlatives, outcomes or capabilities.
 */
function buildCanonicalPositioningStatement(brief: Pick<GroundedCreativeBrief, "productOrService" | "targetBuyer">): string {
  const product = (brief.productOrService || "").trim();
  const buyer = (brief.targetBuyer || "").trim();
  if (!product && !buyer) return "";
  if (!buyer) return product.endsWith(".") ? product : `${product}.`;
  if (!product) return buyer.endsWith(".") ? buyer : `${buyer}.`;
  const statement = `${product} for ${buyer}`;
  return statement.endsWith(".") ? statement : `${statement}.`;
}

/**
 * Deterministic value proposition constructed only from brief phrases.  It
 * avoids inventing outcomes such as "improve cash flow" or "automate".
 */
function buildCanonicalValueProposition(
  brief: Pick<GroundedCreativeBrief, "productOrService" | "targetBuyer" | "mainPainPoint" | "primaryOutcome">
): string {
  const product = (brief.productOrService || "").trim();
  const buyer = (brief.targetBuyer || "").trim();
  const outcome = (brief.primaryOutcome || "").trim();

  if (product && buyer) {
    const statement = `${product} for ${buyer}`;
    const productStatement = statement.endsWith(".") ? statement.slice(0, -1) : statement;
    if (outcome) {
      return `${productStatement}. Intended outcome: ${outcome}.`;
    }
    return `${productStatement}.`;
  }
  if (product && outcome) {
    return `${product.endsWith(".") ? product.slice(0, -1) : product}. Intended outcome: ${outcome}.`;
  }
  return product ? (product.endsWith(".") ? product : `${product}.`) : "";
}

function parseAuthorisedOffers(offerDetails: string | undefined): StrategyOutput["offers"] {
  if (!offerDetails || !offerDetails.trim()) return [];
  const clauses = offerDetails
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return clauses.map((clause) => ({
    name: clause,
    description: clause,
    targetStage: "conversion",
    value: clause,
  }));
}

/**
 * Build deterministic, neutral factual statements from the brief.
 */
function buildCanonicalFactualFields(contract: GroundingContract) {
  return {
    coreMessage: buildCanonicalProductStatement({
      productOrService: contract.productOrService,
      coreMessage: contract.coreMessage,
    }),
    positioning: buildCanonicalPositioningStatement({
      productOrService: contract.productOrService,
      targetBuyer: contract.targetBuyer,
    }),
    valueProposition: buildCanonicalValueProposition({
      productOrService: contract.productOrService,
      targetBuyer: contract.targetBuyer,
      mainPainPoint: contract.mainPainPoint,
      primaryOutcome: contract.primaryOutcome,
    }),
  };
}

function buildCanonicalCampaignTheme(contract: GroundingContract): string {
  return (
    contract.coreMessage?.trim() ||
    buildCanonicalProductStatement({
      productOrService: contract.productOrService,
      coreMessage: contract.coreMessage,
    }) ||
    `A focused campaign for ${contract.targetBuyer || "the target buyer"}`
  );
}

function buildCanonicalPersonaGoal(contract: GroundingContract): string {
  const outcome = contract.primaryOutcome?.trim();
  const pain = contract.mainPainPoint?.trim();
  const product = contract.productOrService?.trim() || "the product";
  if (outcome) return `Intended outcome: ${outcome}`;
  if (pain) return `Overcome: ${pain}`;
  return `Learn how ${product} applies to their situation`;
}

function capitaliseChannel(channel: string): string {
  const lower = channel.toLowerCase();
  const known: Record<string, string> = {
    linkedin: "LinkedIn",
    facebook: "Facebook",
    instagram: "Instagram",
    twitter: "Twitter",
    x: "X",
    tiktok: "TikTok",
    youtube: "YouTube",
    google: "Google",
    pinterest: "Pinterest",
    snapchat: "Snapchat",
    reddit: "Reddit",
    telegram: "Telegram",
    whatsapp: "WhatsApp",
    email: "Email",
    sms: "SMS",
    website: "Website",
    blog: "Blog",
    display: "Display",
    ppc: "PPC",
    retargeting: "Retargeting",
    search: "Search",
  };
  return known[lower] || channel.charAt(0).toUpperCase() + channel.slice(1);
}

function buildCanonicalPersona(contract: GroundingContract): StrategyOutput["personas"][number] {
  const buyer = contract.targetBuyer || "";
  const buyerName = buyer || "Target Buyer";
  const channels = contract.authorized.channels.map(capitaliseChannel);
  return {
    name: buyerName,
    demographics: buyer,
    painPoints: contract.mainPainPoint ? [contract.mainPainPoint] : [],
    goals: [buildCanonicalPersonaGoal(contract)],
    platforms: channels,
  };
}

function buildCanonicalCtas(
  contract: GroundingContract,
  rawCtas: StrategyOutput["ctas"]
): StrategyOutput["ctas"] {
  const ctaText = contract.preferredCta?.trim() || "Learn More";
  if (!rawCtas.length) {
    return [
      { stage: "awareness", cta: ctaText, placement: "ad headline" },
      { stage: "conversion", cta: ctaText, placement: "landing page" },
    ];
  }
  return rawCtas.map((cta) => ({ ...cta, cta: ctaText }));
}

function buildCanonicalPlatformStrategy(
  contract: GroundingContract
): StrategyOutput["platformStrategy"] {
  const channels = contract.authorized.channels.map(capitaliseChannel);
  return channels.map((channel) => ({
    platform: channel,
    purpose: `Reach ${contract.targetBuyer || "the authorised buyer"} with the authorised message on ${channel}`,
    contentTypes: ["Authorised message"],
    postingFrequency: "3x per week",
  }));
}

function buildCanonicalFunnelStages(contract: GroundingContract): StrategyOutput["funnelStages"] {
  const ctaText = contract.preferredCta?.trim() || "the authorised CTA";
  const buyer = contract.targetBuyer || "the authorised buyer";
  const awarenessTactic = `Publish the authorised message and direct ${buyer} toward the authorised CTA: ${ctaText}`;
  const considerationTactic = `Reinforce the authorised message and direct ${buyer} toward the authorised CTA: ${ctaText}`;
  const conversionTactic = `Use the authorised CTA: ${ctaText}`;
  return [
    {
      stage: "awareness",
      goal: `Reach ${buyer}`,
      tactics: [awarenessTactic],
      metrics: ["impressions"],
    },
    {
      stage: "consideration",
      goal: `Move ${buyer} toward the authorised CTA: ${ctaText}`,
      tactics: [considerationTactic],
      metrics: ["engagement"],
    },
    {
      stage: "conversion",
      goal: `Direct ${buyer} to the authorised CTA: ${ctaText}`,
      tactics: [conversionTactic],
      metrics: ["conversions"],
    },
  ];
}

function distributeBudget(
  total: number,
  channels: string[]
): Array<{ channel: string; amount: number; percentage: number }> {
  if (!channels.length || total <= 0) {
    return [];
  }
  const n = channels.length;
  const baseAmount = Math.floor(total / n);
  const amountRemainder = total % n;
  const basePercentage = Math.floor(100 / n);
  const percentageRemainder = 100 % n;

  return channels.map((channel, index) => ({
    channel,
    amount: baseAmount + (index < amountRemainder ? 1 : 0),
    percentage: basePercentage + (index < percentageRemainder ? 1 : 0),
  }));
}

function buildCanonicalBudgetRecommendation(
  contract: GroundingContract
): StrategyOutput["budgetRecommendation"] {
  const channels = contract.authorized.channels.map(capitaliseChannel);
  const total = channels.length > 0 ? 5000 : 0;
  return {
    total,
    allocation: distributeBudget(total, channels),
  };
}

/**
 * Fail-closed, deterministic materialisation. Every factual and execution field
 * is reconstructed from the grounding contract. Model-generated prose is not
 * preserved; the taxonomy is retained only as defence in depth.
 *
 * Ownership rules:
 * - Product/service (coreMessage, positioning, valueProposition): always
 *   constructed from productOrService/coreMessage/targetBuyer/mainPainPoint/
 *   primaryOutcome.
 * - Persona name/demographics/painPoints/goals/platforms: always constructed
 *   from the brief.
 * - CTAs: always preferredCta or a neutral non-offer fallback.
 * - Offers: always parsed from offerDetails.
 * - Campaign theme: always from authoritative core message.
 * - Platform strategy / funnel stages: always authorised channels plus neutral
 *   execution templates.
 */
export function materialiseGroundedFields(
  rawOutput: StrategyOutput,
  contract: GroundingContract
): StrategyOutput {
  const output: StrategyOutput = structuredClone(rawOutput);
  const canonical = buildCanonicalFactualFields(contract);

  // 1. Product/service — always canonical, never model-generated.
  output.coreMessage = canonical.coreMessage;
  output.positioning = canonical.positioning;
  output.valueProposition = canonical.valueProposition;

  // 2. Campaign theme — always canonical.
  output.campaignTheme = buildCanonicalCampaignTheme(contract);

  // 3. Personas — always grounded to the brief.
  output.personas = [buildCanonicalPersona(contract)];

  // 4. CTAs — always preferred CTA or neutral fallback.
  output.ctas = buildCanonicalCtas(contract, output.ctas);

  // 5. Offers — always from offerDetails.
  output.offers = parseAuthorisedOffers(contract.offerDetails);

  // 6. Platform strategy — always authorised channels + safe templates.
  output.platformStrategy = buildCanonicalPlatformStrategy(contract);

  // 7. Funnel stages — always safe templates.
  output.funnelStages = buildCanonicalFunnelStages(contract);

  // 8. Budget — safe default derived from authorised channels.
  output.budgetRecommendation = buildCanonicalBudgetRecommendation(contract);

  // 9. Defence-in-depth provenance validation. With fail-closed materialisation
  //    this should not trigger, but it remains as a safety net.
  const provenance = validateProvenance(output as Record<string, unknown>, contract);
  if (!provenance.valid) {
    // Re-apply canonical values to any product-defining field that somehow failed.
    output.coreMessage = canonical.coreMessage;
    output.positioning = canonical.positioning;
    output.valueProposition = canonical.valueProposition;
    output.campaignTheme = buildCanonicalCampaignTheme(contract);
  }

  return output;
}

/**
 * Legacy compatibility wrapper: repairs only the product-defining core message
 * when the model output does not materially represent the brief's product or
 * service. Preserved for existing callers/tests; new code should use
 * materialiseGroundedFields.
 */
export function groundProductDefiningFields(
  output: StrategyOutput,
  brief: { productOrService?: string | null; coreMessage?: string | null }
): StrategyOutput {
  const cloned: StrategyOutput = structuredClone(output);
  if (!brief.productOrService || !brief.productOrService.trim()) {
    return cloned;
  }
  const productText = gatherProductDefiningText(cloned);
  const contract = buildGroundingContract({
    fingerprint: "",
    productOrService: brief.productOrService,
    targetBuyer: "",
    mainPainPoint: "",
    preferredCta: "",
    primaryOutcome: "",
    targetAudience: "",
    coreMessage: brief.coreMessage || "",
    offerDetails: "",
    excludedOffers: "",
    referenceStyle: "",
    contentStyle: "",
    platforms: "",
    businessType: "not_specified",
    authorisedChannels: [],
  });
  const missingProductClauses = contract.productClauses.filter(
    (clause) => !clauseCoversText(clause, productText)
  );
  if (missingProductClauses.length > 0) {
    cloned.coreMessage = buildCanonicalProductStatement({
      productOrService: brief.productOrService,
      coreMessage: brief.coreMessage,
    });
  }
  return cloned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation diagnostics and gates
// ─────────────────────────────────────────────────────────────────────────────

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

const UNSUPPORTED_PRODUCT_CLAIM_PATTERNS: Array<{ pattern: RegExp; label: string; authorizeLabels: string[] }> = [
  { pattern: /\bfraud\s+(prevention|reduction)\b/i, label: "fraud prevention or reduction", authorizeLabels: ["fraud"] },
  { pattern: /\bmultiple\s+payment\s+methods?\b/i, label: "multiple payment methods", authorizeLabels: ["multiple payment methods"] },
  { pattern: /\bcredits?\b/i, label: "credit", authorizeLabels: ["credit"] },
  { pattern: /\b(loans?|lending)\b/i, label: "loan or lending", authorizeLabels: ["loan", "lending"] },
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function detectUnauthorizedOffers(outputText: string, offerDetails?: string | null): string[] {
  const found = new Set<string>();
  for (const { pattern, label } of UNAUTHORISED_OFFER_PATTERNS) {
    if (pattern.test(outputText) && !isPhraseExplicitlyAuthorised(offerDetails, label)) {
      found.add(label);
    }
  }
  return Array.from(found);
}

function detectUnsupportedProductClaims(
  output: StrategyOutput,
  brief: Pick<GroundedCreativeBrief, "productOrService" | "coreMessage">
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

function makeDiagnostic(
  gate: string,
  authoritativeField: string,
  expected: string[],
  missing: string[],
  inspected: string[],
  reason: string
): ValidationDiagnostic {
  return {
    gate,
    authoritativeField,
    expectedClauses: expected,
    missingClauses: missing,
    inspectedOutputFields: inspected,
    reason,
  };
}

function buildReason(diagnostics: ValidationDiagnostic[]): string {
  return diagnostics.map((d) => d.reason).join("; ");
}

/**
 * Field-scoped, clause-level validation using the grounding contract.
 * Returns structured diagnostics while preserving the legacy { valid, reason }
 * interface.
 */
export function validateGroundedStrategyOutput(
  output: StrategyOutput & { creativeBriefFingerprint?: string },
  currentFingerprint: string,
  contract: GroundingContract
): StrategyValidationResult {
  const diagnostics: ValidationDiagnostic[] = [];

  // 1. Fingerprint match
  if (output.creativeBriefFingerprint !== currentFingerprint) {
    const d = makeDiagnostic(
      "fingerprint",
      "creativeBriefFingerprint",
      [currentFingerprint],
      output.creativeBriefFingerprint ? [output.creativeBriefFingerprint] : ["missing"],
      ["creativeBriefFingerprint"],
      "Strategy output fingerprint does not match the current campaign brief."
    );
    return { valid: false, diagnostics: [d], reason: d.reason };
  }

  // 2. Authorised channels must be present; execution fields are not invented.
  if (contract.authorized.channels.length === 0) {
    const d = makeDiagnostic(
      "authorised_channels",
      "platforms",
      ["at least one authorised channel"],
      ["none"],
      ["platformStrategy", "personas[].platforms", "budgetRecommendation.allocation"],
      "No authorised campaign channel is available."
    );
    diagnostics.push(d);
  }

  // 3. Product/service — product-defining fields only
  const productText = gatherProductDefiningText(output);
  const missingProductClauses = contract.productClauses.filter(
    (clause) => !clauseCoversText(clause, productText)
  );
  if (missingProductClauses.length > 0) {
    diagnostics.push(
      makeDiagnostic(
        "product/service",
        "productOrService",
        contract.productClauses.map((c) => c.text),
        missingProductClauses.map((c) => c.text),
        ["coreMessage", "positioning", "valueProposition"],
        `Strategy output does not materially represent the product/service. Missing core capabilities: ${missingProductClauses
          .map((c) => c.text)
          .join(", ")}.`
      )
    );
  }

  // 3. Target buyer — persona name/demographics only
  const buyerText = gatherBuyerText(output);
  const missingBuyerTokens = contract.targetBuyer
    ? extractRequiredTokens(contract.targetBuyer).filter((token) => !outputContainsToken(buyerText, token))
    : [];
  if (missingBuyerTokens.length > 0) {
    diagnostics.push(
      makeDiagnostic(
        "target buyer",
        "targetBuyer",
        [contract.targetBuyer],
        [missingBuyerTokens.join(" ")],
        ["personas[].name", "personas[].demographics"],
        `Strategy output does not materially represent the target buyer: ${contract.targetBuyer}.`
      )
    );
  }

  // 4. Main pain point — persona painPoints only
  const painText = gatherPainPointText(output);
  const missingPainTokens = contract.mainPainPoint
    ? extractRequiredTokens(contract.mainPainPoint).filter((token) => !outputContainsToken(painText, token))
    : [];
  if (missingPainTokens.length > 0) {
    diagnostics.push(
      makeDiagnostic(
        "main pain point",
        "mainPainPoint",
        [contract.mainPainPoint],
        [missingPainTokens.join(" ")],
        ["personas[].painPoints"],
        `Strategy output does not materially represent the main pain point: ${contract.mainPainPoint}. Missing core capabilities: ${missingPainTokens
          .slice(0, 3)
          .join(", ")}.`
      )
    );
  }

  // 5. Preferred CTA
  if (contract.preferredCta) {
    const ctaText = gatherCtaText(output);
    if (!containsPhrase(ctaText, contract.preferredCta)) {
      diagnostics.push(
        makeDiagnostic(
          "preferred CTA",
          "preferredCta",
          [contract.preferredCta],
          [contract.preferredCta],
          ["ctas[].cta"],
          `Strategy output does not use the preferred CTA: ${contract.preferredCta}.`
        )
      );
    }
  }

  // 6. Excluded offers/claims
  const outputText = gatherOutputText(output);
  for (const term of contract.excludedOffers) {
    if (containsPhrase(outputText, term)) {
      diagnostics.push(
        makeDiagnostic(
          "excluded offer/claim",
          "excludedOffers",
          contract.excludedOffers,
          [term],
          ["all user-facing fields"],
          `Strategy output contains excluded offer or claim: ${term}.`
        )
      );
    }
  }

  // 7. Stale conflicting audience classifications
  const staleTerms = [
    "small businesses",
    "payroll",
    "employee payouts",
    "credit access",
    "mass disbursements",
  ];
  const briefText = [
    contract.productClauses.map((c) => c.text).join(" "),
    contract.targetBuyer,
    contract.mainPainPoint,
    contract.offerDetails,
  ]
    .filter(Boolean)
    .join(" ");
  for (const term of staleTerms) {
    if (!containsPhrase(briefText, term) && containsPhrase(outputText, term)) {
      diagnostics.push(
        makeDiagnostic(
          "stale audience",
          "briefText",
          [term],
          [term],
          ["all user-facing fields"],
          `Strategy output contains stale audience classification: ${term}.`
        )
      );
    }
  }

  // 8. Invented offers when none authorised
  const hasOfferDetails = !!(contract.offerDetails && contract.offerDetails.trim().length > 0);
  if (!hasOfferDetails && output.offers.length > 0) {
    diagnostics.push(
      makeDiagnostic(
        "invented offers",
        "offerDetails",
        ["none"],
        ["offers array is non-empty"],
        ["offers[]"],
        "Strategy output invented offers that were not authorised by the campaign brief."
      )
    );
  }

  // 9. Unauthorised offers or incentives hidden outside the offers array
  const unauthorisedOffers = detectUnauthorizedOffers(outputText, contract.offerDetails);
  if (unauthorisedOffers.length > 0) {
    diagnostics.push(
      makeDiagnostic(
        "unauthorised incentive",
        "offerDetails",
        contract.excludedOffers,
        unauthorisedOffers,
        ["all user-facing fields"],
        `Strategy output contains unauthorised offer or incentive: ${unauthorisedOffers.join(", ")}.`
      )
    );
  }

  // 10. Unsupported product claims
  const unsupportedClaims = detectUnsupportedProductClaims(output, {
    productOrService: contract.productClauses.map((c) => c.text).join(", "),
    coreMessage: contract.coreMessage,
  });
  if (unsupportedClaims.length > 0) {
    diagnostics.push(
      makeDiagnostic(
        "unsupported product claim",
        "productOrService",
        ["fraud", "multiple payment methods", "credit", "loan/lending"],
        unsupportedClaims,
        ["coreMessage", "positioning", "valueProposition", "non-educational funnel tactics"],
        `Strategy output contains unsupported product claim: ${unsupportedClaims.join(", ")}.`
      )
    );
  }

  // 11. Provenance validation — domain-independent guard against unsupported
  //     claims, programmes, channels and comparisons.
  const provenance = validateProvenance(output as Record<string, unknown>, contract);
  if (!provenance.valid) {
    for (const pd of provenance.diagnostics) {
      diagnostics.push({
        gate: `provenance/${pd.classification}`,
        authoritativeField: pd.authoritySource || getAuthoritySourceForField(pd.field, contract),
        expectedClauses: ["authorised brief content or safe execution taxonomy"],
        missingClauses: [pd.generatedText],
        inspectedOutputFields: [pd.field],
        reason: pd.reason,
      });
    }
  }

  if (diagnostics.length > 0) {
    return { valid: false, diagnostics, reason: buildReason(diagnostics) };
  }

  return { valid: true };
}

function getAuthoritySourceForField(field: string, _contract: GroundingContract): string {
  if (field.includes("coreMessage") || field.includes("positioning") || field.includes("valueProposition")) {
    return "productOrService";
  }
  if (field.includes("personas")) {
    if (field.includes("painPoints")) return "mainPainPoint";
    return "targetBuyer";
  }
  if (field.includes("ctas")) return "preferredCta";
  if (field.includes("offers")) return "offerDetails";
  if (field.includes("platformStrategy")) return "platforms";
  return "brief";
}

/**
 * Backwards-compatible validation interface.
 */
export function validateStrategyOutput({
  output,
  currentFingerprint,
  brief,
}: StrategyValidationInput): StrategyValidationResult {
  const contract = buildGroundingContract({
    ...brief,
    fingerprint: brief.fingerprint || currentFingerprint,
    businessType: brief.businessType || "not_specified",
  });
  return validateGroundedStrategyOutput(output, currentFingerprint, contract);
}

/**
 * Pure validation gate for an existing strategy run output against the current
 * persisted campaign brief.
 */
export function validateStrategyOutputAgainstCampaign(
  output: unknown,
  campaign: unknown
): StrategyValidationResult {
  const brief = buildGroundedCreativeBrief({ campaign });
  const raw = (output || {}) as Record<string, unknown>;

  if (typeof raw.outcome === "string") {
    return {
      valid: false,
      reason: `Strategy run output is an evidence envelope (${raw.outcome}), not a completed strategy.`,
    };
  }

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

function classifyGenerationError(error: unknown): {
  outcome: "failed_generation" | "failed_schema";
  gate: string;
  reason: string;
} {
  if (TypeValidationError.isInstance(error) || NoObjectGeneratedError.isInstance(error)) {
    return {
      outcome: "failed_schema",
      gate: "schema",
      reason: error.message || "Structured output did not match the required schema.",
    };
  }
  return {
    outcome: "failed_generation",
    gate: "generation",
    reason: error instanceof Error ? error.message : String(error),
  };
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
  onRunCreated?: (runId: number, tx: any) => void | Promise<void>;
}): Promise<StrategyAgentRunResult> {
  const db = getDb();

  const [currentCampaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.userId, userId), eq(campaigns.id, campaignId)))
    .limit(1);

  const previousCampaigns = currentCampaign?.businessId
    ? await db
        .select({ id: campaigns.id, workflowContext: campaigns.workflowContext })
        .from(campaigns)
        .where(and(eq(campaigns.userId, userId), eq(campaigns.businessId, currentCampaign.businessId)))
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

  const costControl = await enforceCostControl(userId, estimatedCost);
  if (!costControl.allowed) {
    throw new TRPCError({
      code: "PAYMENT_REQUIRED",
      message: costControl.reason || "Insufficient credits for strategy generation.",
    });
  }

  const systemPrompt =
    "You are a world-class marketing strategist. You create detailed, actionable marketing strategies for businesses. Always respond with valid structured data.";

  // Compute the grounding contract from the current brief before generation so
  // the fingerprint and contract are available for every persistence path.
  const fingerprintSource = campaignBrief
    ? ({ ...campaignBrief } as Record<string, unknown>)
    : currentCampaign ?? {};
  const brief = buildGroundedCreativeBrief({ campaign: fingerprintSource });
  const briefFingerprint = brief.fingerprint;
  const contract = buildGroundingContract(brief);

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
    const { outcome, gate, reason } = classifyGenerationError(error);

    // Best-effort evidence persistence; a failure here must not replace the
    // original provider error.
    try {
      await db
        .update(agentRuns)
        .set({
          status: "failed",
          error: reason,
          output: {
            evidenceVersion: 1,
            outcome,
            creativeBriefFingerprint: briefFingerprint,
            validationDiagnostics: {
              gate,
              reason,
            },
          } as any,
          completedAt: new Date(),
        })
        .where(eq(agentRuns.id, runId));
    } catch {
      // Ignore persistence failure; the original provider error is thrown below.
    }

    await emitAgentProviderAlert({
      agentType: "strategy",
      runId,
      userId,
      error,
    }).catch(() => {});

    throw error;
  }

  // 3. Persist the raw candidate while still running so a later failure does not
  // erase the model's output.
  await db.update(agentRuns).set({
    output: {
      evidenceVersion: 1,
      outcome: "generated_candidate",
      creativeBriefFingerprint: briefFingerprint,
      rawOutput: generatedOutput,
    } as any,
  }).where(eq(agentRuns.id, runId));

  // 4. Deterministic materialisation.
  const groundedOutput = materialiseGroundedFields(generatedOutput, contract);

  const outputWithFingerprint = {
    ...groundedOutput,
    creativeBriefFingerprint: briefFingerprint,
  };

  // 5. Field-scoped validation with diagnostics.
  const validation = validateGroundedStrategyOutput(
    outputWithFingerprint,
    briefFingerprint,
    contract
  );

  if (!validation.valid) {
    await db.update(agentRuns).set({
      status: "failed",
      error: validation.reason,
      output: {
        evidenceVersion: 1,
        outcome: "failed_validation",
        creativeBriefFingerprint: briefFingerprint,
        rawOutput: generatedOutput,
        groundedOutput,
        validationDiagnostics: validation.diagnostics,
      } as any,
      completedAt: new Date(),
    }).where(eq(agentRuns.id, runId));

    throw new TRPCError({
      code: "UNPROCESSABLE_CONTENT",
      message: validation.reason || "Strategy output failed validation. Please review the campaign brief and retry.",
    });
  }

  // 6. Success: flat, backward-compatible output.
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
