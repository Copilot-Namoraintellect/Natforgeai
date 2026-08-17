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
