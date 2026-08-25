/**
 * CreativeContract — immutable source of truth for creative generation.
 *
 * Slice 1 scope:
 * - defines CreativeContractDraft and ApprovedCreativeContract types;
 * - compiles an approved contract deterministically from strategy lineage + business evidence;
 * - resolves CTA authority with strict precedence;
 * - computes a deterministic contract fingerprint;
 * - reads QUALITY_AUTHORITY_MODE and guards against enforce mode.
 *
 * This module does not call providers, write to the database, or change legacy behaviour.
 */

import { createHash } from "crypto";
import {
  resolveCtaAuthority,
  detectCtaAmbiguity,
  isGenericFallbackCta,
  type CtaAuthoritySource,
} from "./cta-authority";
import { normalizeCtaText, type FunnelStage } from "../cta-utils";

export type QualityAuthorityMode = "off" | "observe" | "enforce";

const VALID_MODES = new Set(["off", "observe", "enforce"]);

export interface ModeResult {
  requestedMode: QualityAuthorityMode | null;
  effectiveMode: QualityAuthorityMode;
  blocked: boolean;
  reason: string | null;
  warning: string | null;
}

/**
 * Read QUALITY_AUTHORITY_MODE.
 * - undefined / empty → off with no warning.
 * - invalid value → off with one structured warning.
 * - "observe" → observe enabled.
 * - "enforce" → recognised but explicitly blocked in Slice 1; effective mode is off.
 */
export function getQualityAuthorityMode(): ModeResult {
  const raw = process.env.QUALITY_AUTHORITY_MODE;
  const empty = !raw || raw.trim().length === 0;
  const requested = empty
    ? null
    : (raw.trim().toLowerCase() as QualityAuthorityMode);

  if (empty) {
    return {
      requestedMode: null,
      effectiveMode: "off",
      blocked: false,
      reason: null,
      warning: null,
    };
  }

  if (!VALID_MODES.has(requested!)) {
    return {
      requestedMode: requested,
      effectiveMode: "off",
      blocked: false,
      reason: null,
      warning: `Unknown QUALITY_AUTHORITY_MODE="${raw}". Defaulting to off.`,
    };
  }

  if (requested === "enforce") {
    return {
      requestedMode: "enforce",
      effectiveMode: "off",
      blocked: true,
      reason: "QUALITY_AUTHORITY_ENFORCEMENT_NOT_AVAILABLE",
      warning: `QUALITY_AUTHORITY_MODE=enforce is blocked until all Phase 5 slices and regression tests are complete. Defaulting to off.`,
    };
  }

  return {
    requestedMode: requested,
    effectiveMode: requested as QualityAuthorityMode,
    blocked: false,
    reason: null,
    warning: null,
  };
}

export interface ApprovedStrategyLineage {
  campaignId: number;
  userId: number;
  strategyRunId: number;
  approvalRequestId: number;
  approvedStrategyFingerprint: string;
  approvedAt: string; // ISO 8601
  status: "approved";
  strategyRunStatus: "completed";
}

export interface CtaAuthority {
  text: string;
  source: CtaAuthoritySource;
  locked: boolean;
}

export interface OfferAuthority {
  text: string | null;
  source: string;
  locked: boolean;
}

export interface GroundedBenefitEvidence {
  text: string;
  evidenceIds: string[];
  origin: string;
}

export interface CreativeContractBase {
  contractVersion: number;
  contractFingerprint: string;
  campaignId: number;
  userId: number;
  businessId: number;
  funnelStage: FunnelStage;
  approvedStrategyFingerprint: string;
  cta: CtaAuthority;
  offer: OfferAuthority;
  targetAudience: string;
  groundedClaims: string[];
  groundedBenefitEvidence: GroundedBenefitEvidence[];
  minimumBenefitCount: number;
  brandConstraints: string[];
  requiredContactDetails: string[];
  prohibitedClaims: string[];
}

export interface CreativeContractDraft extends CreativeContractBase {
  kind: "draft";
  strategyRunId: number | null;
  approvalRequestId: number | null;
  approvedAt: string | null;
  approvedStrategyFingerprint: string;
}

export interface ApprovedCreativeContract extends CreativeContractBase {
  kind: "approved";
  strategyRunId: number;
  approvalRequestId: number;
  approvedAt: string;
  approvedStrategyFingerprint: string;
}

export type CreativeContract = CreativeContractDraft | ApprovedCreativeContract;

export interface ApprovedStrategyInput {
  campaignId: number;
  userId: number;
  businessId: number;
  strategyRunId: number;
  approvalRequestId: number;
  approvedAt: string;
  approvedStrategyFingerprint: string;
  funnelStage: FunnelStage;
  stageCtas?: Partial<Record<FunnelStage, string | null | undefined>>;
  campaignWideCta?: string | null;
  campaignInputCta?: string | null;
  offerActionCta?: string | null;
  aiDelegated?: boolean;
  targetAudience: string;
  offer: string | null;
  businessCapabilities: readonly string[];
  requiredBenefitCount?: number;
  brandConstraints?: readonly string[];
  requiredContactDetails?: readonly string[];
  prohibitedClaims?: readonly string[];
}

export interface StrategyLineageInput {
  lineage: ApprovedStrategyLineage | null;
  campaignId: number;
  userId: number;
  businessId: number;
  funnelStage: FunnelStage;
  approvedStrategyFingerprint?: string | null;
  stageCtas?: Partial<Record<FunnelStage, string | null | undefined>>;
  campaignWideCta?: string | null;
  campaignInputCta?: string | null;
  offerActionCta?: string | null;
  aiDelegated?: boolean;
  targetAudience: string;
  offer: string | null;
  businessCapabilities: readonly string[];
  requiredBenefitCount?: number;
  brandConstraints?: readonly string[];
  requiredContactDetails?: readonly string[];
  prohibitedClaims?: readonly string[];
}

export type MismatchClassification =
  | "none"
  | "approved_cta_overridden"
  | "fallback_used_while_approved_exists"
  | "ambiguous_source"
  | "stale_strategy"
  | "unapproved_strategy"
  | "missing_strategy_lineage"
  | "invalid_approved_cta";

export interface ObservationDiagnostics {
  campaignId: number;
  userId: number;
  strategyRunId: number | null;
  approvalRequestId: number | null;
  contractVersion: number;
  contractFingerprint: string;
  legacySelectedCta: string;
  contractAuthoritativeCta: string;
  ctaAuthoritySource: CtaAuthoritySource;
  ctaLocked: boolean;
  mismatchClassification: MismatchClassification;
  enforceWouldAccept: boolean;
  enforceWouldRejectReason: string | null;
  diagnostics: string[];
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => safeText(item)).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function inferOfferActionCta(offer: string | null): string | null {
  if (!offer) return null;
  const lower = offer.toLowerCase();
  if (lower.includes("consultation")) return "Request a Consultation";
  if (lower.includes("demo")) return "Book a Demo";
  if (lower.includes("quote")) return "Request a Quote";
  if (lower.includes("trial")) return "Start Your Trial";
  return null;
}

function buildGroundedBenefitEvidence(
  capabilities: string[],
  requiredCount: number
): GroundedBenefitEvidence[] {
  const evidence = capabilities
    .filter((cap) => cap.length > 0)
    .map((cap, index) => ({
      text: `Use ${cap.toLowerCase()} to reduce manual work and improve reliability.`,
      evidenceIds: [`evidence-${index}`],
      origin: cap,
    }));
  while (evidence.length < requiredCount) {
    const index = evidence.length;
    evidence.push({
      text: `Benefit placeholder ${index + 1} — must be replaced with approved evidence in Slice 2.`,
      evidenceIds: [],
      origin: "slice1-placeholder",
    });
  }
  return evidence.slice(0, Math.max(requiredCount, 3));
}

/**
 * Canonicalise an object for fingerprinting.
 * - recursively sorts object keys;
 * - preserves array order;
 * - normalises whitespace in strings where appropriate;
 * - excludes transient diagnostic fields.
 */
export function canonicalizeForFingerprint(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function computeContractFingerprint(contract: CreativeContractBase): string {
  const canonical = canonicalizeForFingerprint({
    contractVersion: contract.contractVersion,
    campaignId: contract.campaignId,
    userId: contract.userId,
    businessId: contract.businessId,
    funnelStage: contract.funnelStage,
    approvedStrategyFingerprint: contract.approvedStrategyFingerprint,
    approvedAt: (contract as any).approvedAt ?? null,
    cta: {
      text: normalizeCtaText(contract.cta.text),
      source: contract.cta.source,
      locked: contract.cta.locked,
    },
    offer: {
      text: contract.offer.text ? normalizeCtaText(contract.offer.text) : null,
      source: contract.offer.source,
      locked: contract.offer.locked,
    },
    targetAudience: contract.targetAudience,
    groundedClaims: contract.groundedClaims,
    groundedBenefitEvidence: contract.groundedBenefitEvidence.map((b) => ({
      text: normalizeCtaText(b.text),
      evidenceIds: b.evidenceIds.slice().sort(),
      origin: b.origin,
    })),
    minimumBenefitCount: contract.minimumBenefitCount,
    brandConstraints: contract.brandConstraints.slice().sort(),
    requiredContactDetails: contract.requiredContactDetails.slice().sort(),
    prohibitedClaims: contract.prohibitedClaims.slice().sort(),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function isApprovedLineageAuthoritative(
  lineage: ApprovedStrategyLineage | null,
  campaignId: number,
  userId: number,
  approvedStrategyFingerprint: string | null
): { authoritative: boolean; reason: string | null } {
  if (!lineage) {
    return { authoritative: false, reason: "missing_strategy_lineage" };
  }
  if (lineage.status !== "approved" || lineage.strategyRunStatus !== "completed") {
    return { authoritative: false, reason: "unapproved_strategy" };
  }
  if (
    lineage.campaignId !== campaignId ||
    lineage.userId !== userId
  ) {
    return { authoritative: false, reason: "unapproved_strategy" };
  }
  if (
    approvedStrategyFingerprint &&
    lineage.approvedStrategyFingerprint !== approvedStrategyFingerprint
  ) {
    return { authoritative: false, reason: "stale_strategy" };
  }
  return { authoritative: true, reason: null };
}

function compileContractBase(
  input: StrategyLineageInput,
  version: number
): CreativeContractBase {
  const offer = safeText(input.offer) || null;
  const offerActionCta = input.offerActionCta || inferOfferActionCta(offer);
  const cta = resolveCtaAuthority({
    funnelStage: input.funnelStage,
    stageCtas: input.stageCtas,
    campaignWideCta: input.campaignWideCta,
    campaignInputCta: input.campaignInputCta,
    offerActionCta,
    aiDelegated: input.aiDelegated,
  });

  const capabilities = unique(toStringArray(input.businessCapabilities));
  const requiredBenefitCount = input.requiredBenefitCount ?? 3;
  const groundedBenefitEvidence = buildGroundedBenefitEvidence(
    capabilities,
    requiredBenefitCount
  );

  const approvedStrategyFingerprint =
    safeText(input.approvedStrategyFingerprint ?? input.lineage?.approvedStrategyFingerprint) || "";

  const base: CreativeContractBase = {
    contractVersion: version,
    contractFingerprint: "", // filled below
    campaignId: input.campaignId,
    userId: input.userId,
    businessId: input.businessId,
    funnelStage: input.funnelStage,
    approvedStrategyFingerprint,
    cta,
    offer: {
      text: offer,
      source: offer ? "approved_strategy" : "none",
      locked: true,
    },
    targetAudience: safeText(input.targetAudience),
    groundedClaims: capabilities,
    groundedBenefitEvidence,
    minimumBenefitCount: requiredBenefitCount,
    brandConstraints: unique(toStringArray(input.brandConstraints)),
    requiredContactDetails: unique(toStringArray(input.requiredContactDetails)),
    prohibitedClaims: unique(toStringArray(input.prohibitedClaims)),
  };
  base.contractFingerprint = computeContractFingerprint(base);
  return base;
}

export function compileApprovedCreativeContract(
  input: ApprovedStrategyInput
): ApprovedCreativeContract {
  const base = compileContractBase(
    {
      lineage: {
        campaignId: input.campaignId,
        userId: input.userId,
        strategyRunId: input.strategyRunId,
        approvalRequestId: input.approvalRequestId,
        approvedStrategyFingerprint: input.approvedStrategyFingerprint,
        approvedAt: input.approvedAt,
        status: "approved",
        strategyRunStatus: "completed",
      },
      ...input,
    },
    1
  );
  const approved: ApprovedCreativeContract = {
    ...base,
    kind: "approved",
    strategyRunId: input.strategyRunId,
    approvalRequestId: input.approvalRequestId,
    approvedAt: input.approvedAt,
    approvedStrategyFingerprint: input.approvedStrategyFingerprint,
  };
  approved.contractFingerprint = computeContractFingerprint(approved);
  return approved;
}

export function compileDraftCreativeContract(
  input: Omit<StrategyLineageInput, "lineage"> & { lineage?: ApprovedStrategyLineage | null }
): CreativeContractDraft {
  const lineage = input.lineage ?? null;
  const base = compileContractBase({ ...input, lineage }, 1);
  const draft: CreativeContractDraft = {
    ...base,
    kind: "draft",
    strategyRunId: lineage?.strategyRunId ?? null,
    approvalRequestId: lineage?.approvalRequestId ?? null,
    approvedAt: lineage?.approvedAt ?? null,
    approvedStrategyFingerprint: lineage?.approvedStrategyFingerprint ?? "",
  };
  draft.contractFingerprint = computeContractFingerprint(draft);
  return draft;
}

function classifyCtaMismatch(
  contract: CreativeContract,
  legacySelectedCta: string
): { classification: MismatchClassification; reason: string | null } {
  const legacy = normalizeCtaText(legacySelectedCta);
  const authoritative = normalizeCtaText(contract.cta.text);

  if (legacy === authoritative) {
    return { classification: "none", reason: null };
  }

  if (contract.kind !== "approved") {
    return {
      classification: "unapproved_strategy",
      reason: `Legacy CTA "${legacySelectedCta}" differs from draft CTA "${contract.cta.text}" but no approved strategy is authoritative.`,
    };
  }

  if (contract.cta.locked) {
    if (isGenericFallbackCta(legacySelectedCta)) {
      return {
        classification: "fallback_used_while_approved_exists",
        reason: `Legacy fallback CTA "${legacySelectedCta}" was used while an approved CTA "${contract.cta.text}" exists (source: ${contract.cta.source}).`,
      };
    }
    return {
      classification: "approved_cta_overridden",
      reason: `Legacy CTA "${legacySelectedCta}" overrides the locked approved CTA "${contract.cta.text}" (source: ${contract.cta.source}).`,
    };
  }

  return {
    classification: "approved_cta_overridden",
    reason: `Legacy CTA "${legacySelectedCta}" differs from contract CTA "${contract.cta.text}".`,
  };
}

export function observeCreativeContract(input: {
  mode: QualityAuthorityMode;
  campaignId: number;
  userId: number;
  businessId: number;
  lineage: ApprovedStrategyLineage | null;
  expectedApprovedStrategyFingerprint?: string | null;
  funnelStage: FunnelStage;
  stageCtas?: Partial<Record<FunnelStage, string | null | undefined>>;
  campaignWideCta?: string | null;
  campaignInputCta?: string | null;
  offerActionCta?: string | null;
  aiDelegated?: boolean;
  targetAudience: string;
  offer: string | null;
  businessCapabilities: readonly string[];
  legacySelectedCta: string;
  requiredBenefitCount?: number;
  brandConstraints?: readonly string[];
  requiredContactDetails?: readonly string[];
  prohibitedClaims?: readonly string[];
}): ObservationDiagnostics | null {
  if (input.mode === "off") return null;

  const diagnostics: string[] = [];

  try {
    const expectedFingerprint =
      input.expectedApprovedStrategyFingerprint ??
      input.lineage?.approvedStrategyFingerprint ??
      null;
    const fingerprintCheck = isApprovedLineageAuthoritative(
      input.lineage,
      input.campaignId,
      input.userId,
      expectedFingerprint
    );

    if (!fingerprintCheck.authoritative) {
      diagnostics.push(`Contract not authoritative: ${fingerprintCheck.reason}`);
    }

    const ambiguity = detectCtaAmbiguity({
      funnelStage: input.funnelStage,
      stageCtas: input.stageCtas,
      campaignWideCta: input.campaignWideCta,
      campaignInputCta: input.campaignInputCta,
      offerActionCta: input.offerActionCta,
      aiDelegated: input.aiDelegated,
    });
    if (ambiguity) {
      diagnostics.push(ambiguity);
    }

    const contract = input.lineage
      ? compileApprovedCreativeContract({
          campaignId: input.lineage.campaignId,
          userId: input.lineage.userId,
          businessId: input.businessId,
          strategyRunId: input.lineage.strategyRunId,
          approvalRequestId: input.lineage.approvalRequestId,
          approvedAt: input.lineage.approvedAt,
          approvedStrategyFingerprint: input.lineage.approvedStrategyFingerprint,
          funnelStage: input.funnelStage,
          stageCtas: input.stageCtas,
          campaignWideCta: input.campaignWideCta,
          campaignInputCta: input.campaignInputCta,
          offerActionCta: input.offerActionCta,
          aiDelegated: input.aiDelegated,
          targetAudience: input.targetAudience,
          offer: input.offer,
          businessCapabilities: input.businessCapabilities,
          requiredBenefitCount: input.requiredBenefitCount,
          brandConstraints: input.brandConstraints,
          requiredContactDetails: input.requiredContactDetails,
          prohibitedClaims: input.prohibitedClaims,
        })
      : compileDraftCreativeContract({
          lineage: null,
          campaignId: input.campaignId,
          userId: input.userId,
          businessId: input.businessId,
          funnelStage: input.funnelStage,
          stageCtas: input.stageCtas,
          campaignWideCta: input.campaignWideCta,
          campaignInputCta: input.campaignInputCta,
          offerActionCta: input.offerActionCta,
          aiDelegated: input.aiDelegated,
          targetAudience: input.targetAudience,
          offer: input.offer,
          businessCapabilities: input.businessCapabilities,
          requiredBenefitCount: input.requiredBenefitCount,
          brandConstraints: input.brandConstraints,
          requiredContactDetails: input.requiredContactDetails,
          prohibitedClaims: input.prohibitedClaims,
        });

    const mismatch = classifyCtaMismatch(contract, input.legacySelectedCta);

    if (mismatch.classification !== "none") {
      diagnostics.push(mismatch.reason ?? `CTA mismatch classified as ${mismatch.classification}`);
    }

    const enforceWouldAccept =
      fingerprintCheck.authoritative && mismatch.classification === "none";

    return {
      campaignId: input.campaignId,
      userId: input.userId,
      strategyRunId: contract.strategyRunId,
      approvalRequestId: contract.approvalRequestId,
      contractVersion: contract.contractVersion,
      contractFingerprint: contract.contractFingerprint,
      legacySelectedCta: input.legacySelectedCta,
      contractAuthoritativeCta: contract.cta.text,
      ctaAuthoritySource: contract.cta.source,
      ctaLocked: contract.cta.locked,
      mismatchClassification: fingerprintCheck.authoritative
        ? mismatch.classification
        : (fingerprintCheck.reason as MismatchClassification),
      enforceWouldAccept,
      enforceWouldRejectReason: enforceWouldAccept
        ? null
        : mismatch.reason ?? `Contract not authoritative: ${fingerprintCheck.reason}`,
      diagnostics,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      campaignId: input.campaignId,
      userId: input.userId,
      strategyRunId: input.lineage?.strategyRunId ?? null,
      approvalRequestId: input.lineage?.approvalRequestId ?? null,
      contractVersion: 0,
      contractFingerprint: "",
      legacySelectedCta: input.legacySelectedCta,
      contractAuthoritativeCta: "",
      ctaAuthoritySource: "none",
      ctaLocked: false,
      mismatchClassification: "invalid_approved_cta",
      enforceWouldAccept: false,
      enforceWouldRejectReason: `Observation failed: ${reason}`,
      diagnostics: [`Observation error: ${reason}`],
    };
  }
}
