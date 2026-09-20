import { createHash } from "crypto";

/**
 * Canonical Business DNA snapshot builder (BI-owned).
 *
 * Deterministically projects a governed {@link BusinessDNASnapshot} from the
 * live business profile and captured website evidence. The evidence hash is a
 * pure function of the normalized governed fields — never of wall-clock time —
 * so semantically identical input always yields the same evidence hash and the
 * same snapshot identity. Facts that are not present in the source input are
 * left empty rather than invented.
 */

export const BUSINESS_DNA_SNAPSHOT_VERSION = 1;

/**
 * Canonical governed projection of a business's commercial DNA.
 * Owned here by BI; Creative consumes this contract via re-export.
 */
export interface BusinessDNASnapshot {
  readonly snapshotId: string;
  readonly businessId: number;
  readonly version: number;
  readonly evidenceHashSha256: string;
  readonly capturedAtIso: string;
  readonly businessName: string;
  readonly industry: string;
  readonly primaryOffering: string;
  readonly productsAndServices: readonly string[];
  readonly verifiedUseCases: readonly string[];
  readonly targetCustomerSegments: readonly string[];
  readonly customerPainPoints: readonly string[];
  readonly supportedOutcomes: readonly string[];
  readonly capabilities: readonly string[];
  readonly approvedClaims: readonly string[];
  readonly prohibitedClaims: readonly string[];
  readonly brandLanguageConstraints: readonly string[];
  readonly evidenceReferences: readonly string[];
}

/** Website evidence captured for a business profile. */
export interface BusinessWebsiteEvidenceSource {
  readonly productsServices?: unknown;
  readonly targetCustomers?: unknown;
  readonly businessCategory?: unknown;
  readonly location?: unknown;
}

/** Live business profile row fields used by the projection. */
export interface BusinessProfileSnapshotSource {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly industry?: unknown;
  readonly productOrService?: unknown;
  readonly targetCustomer?: unknown;
  readonly targetAudience?: unknown;
  readonly avoidWords?: unknown;
  readonly websiteEvidence?: unknown;
}

/** Campaign-derived signals blended into the DNA by the legacy projection. */
export interface CampaignBusinessSignals {
  readonly productOrService?: unknown;
  readonly targetBuyer?: unknown;
  readonly mainPainPoint?: unknown;
  readonly keyOutcomes?: unknown;
  readonly goal?: unknown;
  readonly primaryOutcome?: unknown;
}

/** Validation-context signals blended into the DNA by the legacy projection. */
export interface ValidationBusinessSignals {
  readonly businessName?: unknown;
  readonly industry?: unknown;
  readonly productOrService?: unknown;
  readonly targetCustomer?: unknown;
  readonly mainPainPoint?: unknown;
}

export interface BuildBusinessDNASnapshotInput {
  /** Live business profile; carries the captured website evidence. */
  readonly business: BusinessProfileSnapshotSource;
  /** Optional campaign-derived signals. */
  readonly campaignSignals?: CampaignBusinessSignals;
  /** Optional validation-context signals. */
  readonly validationSignals?: ValidationBusinessSignals;
  /**
   * Capture timestamp authority. Must be supplied explicitly by the caller;
   * this module never reads wall-clock time and the value never feeds the
   * evidence hash.
   */
  readonly capturedAtIso: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item)).filter(Boolean);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function sha256Hex(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function resolveBusinessId(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function requireCapturedAtIso(capturedAtIso: string): string {
  if (
    typeof capturedAtIso !== "string" ||
    capturedAtIso.trim() === "" ||
    Number.isNaN(Date.parse(capturedAtIso))
  ) {
    throw new Error(
      "buildBusinessDNASnapshot requires an explicit valid capturedAtIso; the builder holds no time authority of its own"
    );
  }
  return capturedAtIso;
}

export function buildBusinessDNASnapshot(
  input: BuildBusinessDNASnapshotInput
): BusinessDNASnapshot {
  const capturedAtIso = requireCapturedAtIso(input.capturedAtIso);
  const business = input.business ?? {};
  const evidence = (business.websiteEvidence ?? {}) as BusinessWebsiteEvidenceSource;
  const campaign = input.campaignSignals ?? {};
  const ctx = input.validationSignals ?? {};

  const productsAndServices = unique([
    ...toStringArray(evidence.productsServices),
    text(business.productOrService),
    text(ctx.productOrService),
  ]);

  const verifiedUseCases = unique([
    ...toStringArray(evidence.productsServices),
    text(campaign.productOrService),
  ]);

  const targetCustomerSegments = unique([
    ...toStringArray(evidence.targetCustomers),
    text(business.targetCustomer),
    text(business.targetAudience),
    text(campaign.targetBuyer),
    text(ctx.targetCustomer),
  ]);

  const customerPainPoints = unique([
    text(campaign.mainPainPoint),
    text(ctx.mainPainPoint),
  ]);

  const supportedOutcomes = unique([
    ...toStringArray(campaign.keyOutcomes),
    text(campaign.goal),
    text(campaign.primaryOutcome),
  ]);

  const capabilities = unique([
    ...toStringArray(evidence.productsServices),
    text(ctx.productOrService),
  ]);

  const businessId = resolveBusinessId(business.id);
  const businessName = text(business.name) || text(ctx.businessName);
  const industry =
    text(business.industry) || text(evidence.businessCategory) || text(ctx.industry);
  const primaryOffering = text(business.productOrService) || text(ctx.productOrService);
  const approvedClaims: string[] = [];
  const prohibitedClaims = unique(toStringArray(business.avoidWords));
  const brandLanguageConstraints: string[] = [];
  const evidenceReferences = [text(evidence.location)].filter(Boolean);

  const evidenceHashSha256 = sha256Hex({
    businessName,
    industry,
    primaryOffering,
    productsAndServices,
    verifiedUseCases,
    targetCustomerSegments,
    customerPainPoints,
    supportedOutcomes,
    capabilities,
    prohibitedClaims,
    evidenceReferences,
  });

  return {
    snapshotId: `shadow-bdna-${businessId}-${evidenceHashSha256.slice(0, 16)}`,
    businessId,
    version: BUSINESS_DNA_SNAPSHOT_VERSION,
    evidenceHashSha256,
    capturedAtIso,
    businessName,
    industry,
    primaryOffering,
    productsAndServices,
    verifiedUseCases,
    targetCustomerSegments,
    customerPainPoints,
    supportedOutcomes,
    capabilities,
    approvedClaims,
    prohibitedClaims,
    brandLanguageConstraints,
    evidenceReferences,
  };
}
