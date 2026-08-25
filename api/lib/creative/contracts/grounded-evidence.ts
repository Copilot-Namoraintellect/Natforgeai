/**
 * Grounded Evidence Model.
 *
 * Slice 2 scope:
 * - deterministic evidence items derived only from approved business input;
 * - deterministic evidence IDs that do not expose raw sensitive text;
 * - grounded claims and benefits with traceable evidence;
 * - benefit distinctness assessment;
 * - no runtime timestamps or random IDs in identity.
 */

import { createHash } from "crypto";
import type { ApprovedCreativeContract, CreativeContract } from "./creative-contract";

export type EvidenceType =
  | "business_capability"
  | "product_or_service"
  | "approved_core_message"
  | "approved_value_proposition"
  | "approved_offer"
  | "approved_target_audience"
  | "verified_business_fact";

export type EvidenceValidationStatus =
  | "grounded"
  | "partially_grounded"
  | "ungrounded"
  | "ambiguous";

export interface GroundedEvidenceItem {
  evidenceId: string;
  evidenceType: EvidenceType;
  sourceField: string;
  sourceFingerprint: string;
  canonicalText: string;
  displayText: string;
  locked: boolean;
}

export interface GroundedClaim {
  claimId: string;
  text: string;
  evidenceIds: string[];
  validationStatus: EvidenceValidationStatus;
}

export interface GroundedBenefit {
  benefitId: string;
  text: string;
  evidenceIds: string[];
  originatingCapabilities: string[];
  validationStatus: EvidenceValidationStatus;
}

export interface EvidenceSet {
  evidenceSetFingerprint: string;
  items: GroundedEvidenceItem[];
  evidenceById: ReadonlyMap<string, GroundedEvidenceItem>;
}

export interface CompiledGroundedEvidence {
  evidenceSet: EvidenceSet;
  claims: GroundedClaim[];
  benefits: GroundedBenefit[];
  distinctBenefitCount: number;
}

interface EvidenceIdentityInput {
  evidenceType: EvidenceType;
  sourceField: string;
  sourceFingerprint: string;
  canonicalText: string;
}

function normalizeEvidenceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeWord(word: string): string {
  // Deterministic, provider-free stemmer for semantic overlap. It is
  // intentionally conservative: it only collapses common inflectional and
  // derivational suffixes so that e.g. "verification"/"verifying"/"verify"
  // and "balances"/"balance" match, without importing an NLP library.
  let w = word.toLowerCase().trim();
  w = w.replace(/^(?:to|for|of|in|on|with|and|or|the|a|an)\b/, "").trim();
  if (!w) return word.toLowerCase().trim();

  const rules: Array<[RegExp, string]> = [
    [/ically$/, "ic"],
    [/ication$/, "y"], // verification -> verify
    [/ation$/, "te"], // reservation -> reserve, orchestration -> orchestrate
    [/sion$/, "de"], // decision -> decide
    [/ment$/, ""],
    [/ness$/, ""],
    [/ing$/, ""], // verifying -> verify
    [/ed$/, ""], // verified -> verify
    [/ies$/, "y"],
    [/([^aeiou])es$/, "$1e"], // balances -> balance
    [/s$/, ""],
  ];

  let previous = "";
  while (previous !== w) {
    previous = w;
    for (const [pattern, replacement] of rules) {
      const next = w.replace(pattern, replacement);
      if (next !== w && next.length >= 2) {
        w = next;
        break;
      }
    }
  }

  return w || word.toLowerCase().trim();
}

function wordSet(value: string): Set<string> {
  return new Set(
    normalizeEvidenceText(value)
      .split(" ")
      .filter(Boolean)
      .map(normalizeWord)
  );
}

/**
 * Check whether a phrase appears as whole words in a text.
 * Uses normalised text and word-boundary checks to avoid false positives
 * such as "credit" matching inside "accredited".
 */
function containsWholeWordPhrase(haystack: string, needle: string): boolean {
  const h = normalizeEvidenceText(haystack);
  const n = normalizeEvidenceText(needle);
  if (!n || !h) return false;
  if (h === n) return true;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?=[^a-z0-9]|$)`, "i");
  return pattern.test(h);
}

/**
 * Detect whether an evidence phrase is present in a negated context within
 * the claim (e.g. "does not provide credit"). Clause-aware: only the sentence
 * containing the phrase is inspected.
 */
function isNegatedContext(claimText: string, evidencePhrase: string): boolean {
  const negationWords = new Set([
    "no",
    "not",
    "never",
    "without",
    "none",
    "doesn't",
    "does not",
    "isn't",
    "is not",
    "can't",
    "cannot",
    "won't",
    "don't",
  ]);
  const normalisedPhrase = normalizeEvidenceText(evidencePhrase);
  if (!normalisedPhrase) return false;
  const phraseWords = normalisedPhrase.split(" ");

  const sentences = claimText.split(/[.!?;]+/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (!containsWholeWordPhrase(sentence, evidencePhrase)) continue;
    const words = normalizeEvidenceText(sentence).split(" ");
    for (let i = 0; i <= words.length - phraseWords.length; i++) {
      if (words.slice(i, i + phraseWords.length).join(" ") !== normalisedPhrase) {
        continue;
      }
      const before = words.slice(Math.max(0, i - 5), i);
      const after = words.slice(i + phraseWords.length, i + phraseWords.length + 2);
      if (before.some((w) => negationWords.has(w)) || after.some((w) => negationWords.has(w))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build the canonical identity payload used for hashing.
 * Keys are sorted so object field order never affects identity.
 */
export function buildEvidenceIdentityCanonical(
  input: EvidenceIdentityInput
): string {
  const payload = {
    evidenceType: input.evidenceType,
    sourceField: input.sourceField,
    sourceFingerprint: input.sourceFingerprint,
    canonicalText: normalizeEvidenceText(input.canonicalText),
  };
  return JSON.stringify(payload, Object.keys(payload).sort());
}

/**
 * Deterministic evidence ID from canonical identity fields.
 * The ID is a SHA-256 hash; it does not contain raw business text.
 */
export function computeEvidenceIdentity(
  input: EvidenceIdentityInput
): string {
  const canonical = buildEvidenceIdentityCanonical(input);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function createEvidence(
  input: Omit<GroundedEvidenceItem, "evidenceId">
): GroundedEvidenceItem {
  return {
    ...input,
    evidenceId: computeEvidenceIdentity({
      evidenceType: input.evidenceType,
      sourceField: input.sourceField,
      sourceFingerprint: input.sourceFingerprint,
      canonicalText: input.canonicalText,
    }),
  };
}

function stableHash(payload: unknown): string {
  const canonical = JSON.stringify(payload, Object.keys(payload as object).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function evidenceSetFingerprint(items: readonly GroundedEvidenceItem[]): string {
  const sorted = [...items]
    .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))
    .map((item) => ({
      evidenceId: item.evidenceId,
      evidenceType: item.evidenceType,
      sourceField: item.sourceField,
      sourceFingerprint: item.sourceFingerprint,
    }));
  return stableHash({ items: sorted });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/**
 * Compile an evidence set from a CreativeContract.
 * Rejected, pending, stale or superseded contracts produce an empty evidence set.
 */
export function compileEvidenceSet(
  contract: CreativeContract,
  sourceFingerprint: string
): EvidenceSet {
  if (contract.kind !== "approved") {
    return {
      evidenceSetFingerprint: "",
      items: [],
      evidenceById: new Map(),
    };
  }

  const items: GroundedEvidenceItem[] = [];
  const strategyFingerprint = contract.approvedStrategyFingerprint || sourceFingerprint;
  const effectiveSourceFingerprint = strategyFingerprint || contract.contractFingerprint;

  // Business capabilities become capability evidence.
  for (const capability of contract.groundedClaims) {
    if (!capability) continue;
    items.push(
      createEvidence({
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint: effectiveSourceFingerprint,
        canonicalText: capability,
        displayText: capability,
        locked: false,
      })
    );
  }

  // Primary offering / product or service.
  if (contract.offer.text) {
    items.push(
      createEvidence({
        evidenceType: "approved_offer",
        sourceField: "approvedStrategy.offer",
        sourceFingerprint: effectiveSourceFingerprint,
        canonicalText: contract.offer.text,
        displayText: contract.offer.text,
        locked: true,
      })
    );
  }

  // Target audience.
  if (contract.targetAudience) {
    items.push(
      createEvidence({
        evidenceType: "approved_target_audience",
        sourceField: "approvedStrategy.targetAudience",
        sourceFingerprint: effectiveSourceFingerprint,
        canonicalText: contract.targetAudience,
        displayText: contract.targetAudience,
        locked: true,
      })
    );
  }

  // CTA as approved messaging fact.
  if (contract.cta.text) {
    items.push(
      createEvidence({
        evidenceType: "approved_core_message",
        sourceField: "approvedStrategy.cta",
        sourceFingerprint: effectiveSourceFingerprint,
        canonicalText: contract.cta.text,
        displayText: contract.cta.text,
        locked: contract.cta.locked,
      })
    );
  }

  const seen = new Map<string, GroundedEvidenceItem>();
  for (const item of items) {
    if (!seen.has(item.evidenceId)) {
      seen.set(item.evidenceId, item);
    }
  }
  const deduped = [...seen.values()];

  return {
    evidenceSetFingerprint: evidenceSetFingerprint(deduped),
    items: deduped,
    evidenceById: seen,
  };
}

function wordOverlap(a: string, b: string): number {
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  return intersection / Math.min(setA.size, setB.size);
}

export const BENEFIT_DISTINCTNESS_OVERLAP_THRESHOLD = 0.7;

function benefitEvidenceSignature(benefit: GroundedBenefit): string {
  return [...benefit.evidenceIds].sort().join("|");
}

/**
 * Determine whether a benefit is semantically distinct from an existing set.
 * Uses a deterministic signature that is independent of evidence-ID order:
 * - same sorted evidence-ID set means the same grounded source;
 * - token overlap above the threshold means the wording is too similar.
 */
export function isDistinctBenefit(
  candidate: GroundedBenefit,
  existing: readonly GroundedBenefit[]
): boolean {
  const candidateSignature = benefitEvidenceSignature(candidate);
  for (const other of existing) {
    if (benefitEvidenceSignature(other) === candidateSignature) {
      return false;
    }
    const overlap = wordOverlap(candidate.text, other.text);
    if (overlap >= BENEFIT_DISTINCTNESS_OVERLAP_THRESHOLD) {
      return false;
    }
  }
  return true;
}

/**
 * Build grounded benefit candidates from capability evidence.
 * Each capability can support one distinct benefit. Paraphrasing the same
 * capability does not create additional distinct benefits.
 */
export function buildGroundedBenefits(
  evidenceSet: EvidenceSet,
  requiredCount: number
): { benefits: GroundedBenefit[]; distinctCount: number } {
  const capabilityItems = evidenceSet.items.filter(
    (item) => item.evidenceType === "business_capability"
  );

  const benefits: GroundedBenefit[] = [];
  for (const item of capabilityItems) {
    const benefit: GroundedBenefit = {
      benefitId: `benefit-${item.evidenceId.slice(0, 16)}`,
      text: item.displayText,
      evidenceIds: [item.evidenceId],
      originatingCapabilities: [item.displayText],
      validationStatus: "grounded",
    };
    if (isDistinctBenefit(benefit, benefits)) {
      benefits.push(benefit);
    }
  }

  // If still below required count, emit explicitly ungrounded placeholders so
  // compliance can fail closed. These are not counted as distinct grounded benefits.
  while (benefits.length < requiredCount) {
    const index = benefits.length;
    benefits.push({
      benefitId: `benefit-ungrounded-${index}`,
      text: `Unmet required benefit ${index + 1}: no approved evidence available.`,
      evidenceIds: [],
      originatingCapabilities: [],
      validationStatus: "ungrounded",
    });
  }

  const distinctCount = benefits.filter((b) => b.validationStatus === "grounded" &&
    isDistinctBenefit(b, benefits.filter((x) => x.benefitId !== b.benefitId))
  ).length;

  return { benefits, distinctCount };
}

/**
 * Build grounded benefits directly from a capability list and source fingerprint.
 * Used by the CreativeContract compiler when a full evidence set is not yet available.
 */
export function buildGroundedBenefitsFromCapabilities(
  capabilities: readonly string[],
  requiredCount: number,
  sourceFingerprint: string
): { benefits: GroundedBenefit[]; distinctCount: number } {
  const items: GroundedEvidenceItem[] = [];
  for (const capability of capabilities) {
    if (!capability) continue;
    items.push(
      createEvidence({
        evidenceType: "business_capability",
        sourceField: "approvedStrategy.businessCapabilities",
        sourceFingerprint,
        canonicalText: capability,
        displayText: capability,
        locked: false,
      })
    );
  }

  const evidenceSet: EvidenceSet = {
    evidenceSetFingerprint: evidenceSetFingerprint(items),
    items,
    evidenceById: new Map(items.map((item) => [item.evidenceId, item])),
  };

  return buildGroundedBenefits(evidenceSet, requiredCount);
}

/**
 * Validate a claim against the evidence set.
 * A claim is grounded when at least one evidence item's canonical text is
 * substantially reflected in the claim text.
 *
 * Safe matching rules:
 * - evidence must match whole words in the claim (no "credit" in "accredited");
 * - at least 50% token overlap after conservative stemming, with a shared root;
 * - negated contexts ("does not provide credit") do not count as grounded;
 * - unsupported clauses downgrade the claim to partially_grounded or ungrounded.
 */
export function validateClaim(
  claimText: string,
  evidenceSet: EvidenceSet
): GroundedClaim {
  const claimId = computeEvidenceIdentity({
    evidenceType: "approved_core_message",
    sourceField: "proposedClaim",
    sourceFingerprint: evidenceSet.evidenceSetFingerprint,
    canonicalText: claimText,
  });

  const evidenceIds: string[] = [];

  for (const item of evidenceSet.items) {
    const wholeWordMatch =
      containsWholeWordPhrase(claimText, item.canonicalText) ||
      containsWholeWordPhrase(item.canonicalText, claimText);
    const overlap = wordOverlap(claimText, item.canonicalText);
    const hasSharedRoot = wholeWordMatch || overlap >= 0.5;

    if (hasSharedRoot && !isNegatedContext(claimText, item.canonicalText)) {
      evidenceIds.push(item.evidenceId);
    }
  }

  let validationStatus: EvidenceValidationStatus;
  if (evidenceIds.length === 0) {
    validationStatus = "ungrounded";
  } else if (isUnsupportedClaim(claimText, evidenceSet)) {
    validationStatus = "partially_grounded";
  } else {
    validationStatus = "grounded";
  }

  return {
    claimId,
    text: claimText,
    evidenceIds: uniqueStrings(evidenceIds),
    validationStatus,
  };
}

/**
 * Detect unsupported claims that extend beyond approved evidence.
 * These are deterministic heuristics; they do not call a provider.
 */
export function isUnsupportedClaim(
  claimText: string,
  evidenceSet: EvidenceSet
): boolean {
  const lower = claimText.toLowerCase();
  const evidenceText = evidenceSet.items
    .map((item) => item.canonicalText.toLowerCase())
    .join(" ");

  const unsupportedPatterns = [
    { pattern: /guaranteed\s+(fraud\s+prevention|security|safety|returns|profits)/i, code: "GUARANTEED_CLAIM" },
    { pattern: /risk[-\s]?free/i, code: "RISK_FREE_CLAIM" },
    { pattern: /fraud[-\s]?prevention|prevent\s+fraud/i, code: "FRAUD_PREVENTION_CLAIM" },
    { pattern: /regulatory\s+compliance|compliant\s+with\s+regulations/i, code: "REGULATORY_COMPLIANCE_CLAIM" },
    { pattern: /faster\s+settlement|same[-\s]?day\s+settlement|instant\s+settlement/i, code: "SETTLEMENT_SPEED_CLAIM" },
    { pattern: /cost\s+sav(?:ings|e)|save\s+money|reduce\s+costs/i, code: "COST_SAVINGS_CLAIM" },
    { pattern: /revenue\s+growth|grow\s+revenue|increase\s+revenue/i, code: "REVENUE_GROWTH_CLAIM" },
    { pattern: /loan|credit\s+access|lending|borrow/i, code: "LENDING_CLAIM" },
    { pattern: /multiple\s+payment\s+methods|accept\s+every\s+payment/i, code: "PAYMENT_METHODS_CLAIM" },
  ];

  for (const { pattern } of unsupportedPatterns) {
    if (pattern.test(lower)) {
      // Allow if the exact idea is present in approved evidence text.
      const match = lower.match(pattern);
      if (match && evidenceText.includes(match[0].toLowerCase())) {
        continue;
      }
      return true;
    }
  }

  return false;
}

/**
 * Detect invented offer claims that extend beyond the approved offer.
 */
export function isInventedOffer(
  proposedOfferText: string,
  approvedOfferText: string | null
): { invented: boolean; code: string | null } {
  const lower = proposedOfferText.toLowerCase();

  const offerInventions = [
    { pattern: /\b\d+%\s*off\b|\bdiscount\b/i, code: "INVENTED_DISCOUNT" },
    { pattern: /free\s+trial|try\s+free|free\s*-\s*to\s*-\s*try/i, code: "INVENTED_FREE_TRIAL" },
    { pattern: /coupon|promo\s+code|voucher/i, code: "INVENTED_COUPON" },
    { pattern: /money[-\s]?back\s+guarantee|guaranteed\s+refund/i, code: "INVENTED_GUARANTEE" },
    { pattern: /free\s+(consultation|demo|quote|assessment)/i, code: "INVENTED_FREE_OFFER" },
    { pattern: /loan|credit\s+line|financing/i, code: "INVENTED_LENDING" },
    { pattern: /\$\d+|\£\d+|price[:\s]+\d+/i, code: "INVENTED_PRICE" },
  ];

  for (const { pattern, code } of offerInventions) {
    if (pattern.test(lower)) {
      // If the approved offer explicitly contains the same phrase, allow it.
      if (approvedOfferText && pattern.test(approvedOfferText.toLowerCase())) {
        continue;
      }
      return { invented: true, code };
    }
  }

  return { invented: false, code: null };
}

/**
 * Validate that the proposed offer text is compatible with the approved offer.
 */
export function validateOffer(
  proposedOfferText: string,
  contract: ApprovedCreativeContract
): { valid: boolean; code: string | null } {
  const approvedOffer = contract.offer.text;

  // If there is no approved offer, reject any invented commercial offer.
  if (!approvedOffer) {
    const invented = isInventedOffer(proposedOfferText, null);
    if (invented.invented) return { valid: false, code: invented.code };
    return { valid: true, code: null };
  }

  const invented = isInventedOffer(proposedOfferText, approvedOffer);
  if (invented.invented) return { valid: false, code: invented.code };

  // If the proposed offer differs materially from the approved offer, treat as override.
  const normalizedApproved = normalizeEvidenceText(approvedOffer);
  const normalizedProposed = normalizeEvidenceText(proposedOfferText);
  if (
    normalizedProposed !== normalizedApproved &&
    !normalizedProposed.includes(normalizedApproved) &&
    !normalizedApproved.includes(normalizedProposed) &&
    wordOverlap(proposedOfferText, approvedOffer) < 0.5
  ) {
    return { valid: false, code: "OFFER_OVERRIDDEN" };
  }

  return { valid: true, code: null };
}

/**
 * Validate audience consistency without requiring the literal audience phrase.
 * Allows compatible general wording; fails explicit B2C/B2B conflicts.
 */
export function validateAudience(
  proposedAudienceText: string,
  contract: ApprovedCreativeContract
): { consistent: boolean; code: string | null } {
  const lower = proposedAudienceText.toLowerCase();
  const target = contract.targetAudience.toLowerCase();

  // Explicitly conflicting audience assumptions.
  const b2cSignals = ["individual consumers", "personal users", "shoppers", "families", "consumers"];
  const b2bSignals = ["businesses", "operations managers", "finance teams", "merchants", "b2b"];

  const isB2BTarget = b2bSignals.some((s) => target.includes(s));
  const isB2CProposed = b2cSignals.some((s) => lower.includes(s));

  if (isB2BTarget && isB2CProposed) {
    return { consistent: false, code: "AUDIENCE_B2C_CONFLICT_WITH_B2B_CONTRACT" };
  }

  return { consistent: true, code: null };
}

/**
 * Compile all grounded evidence, claims, and benefits for a contract.
 */
export function compileGroundedEvidence(
  contract: CreativeContract
): CompiledGroundedEvidence {
  const evidenceSet = compileEvidenceSet(contract, contract.contractFingerprint);
  const requiredCount = contract.minimumBenefitCount;

  const benefitsResult = buildGroundedBenefits(evidenceSet, requiredCount);

  const claims: GroundedClaim[] = [];
  for (const capability of contract.groundedClaims) {
    if (!capability) continue;
    claims.push(validateClaim(capability, evidenceSet));
  }

  return {
    evidenceSet,
    claims,
    benefits: benefitsResult.benefits,
    distinctBenefitCount: benefitsResult.distinctCount,
  };
}
