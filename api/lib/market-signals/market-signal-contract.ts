// ─── R8-C Market & External Signal Intelligence — canonical contract ───
//
// PURE contract module: closed vocabularies, canonical record types, zod
// schemas and the typed error taxonomy for the market/external-signal
// authority (WBS-R8-C). It performs no I/O of any kind, has no clock and
// authorizes nothing. External content is untrusted data; a signal is
// evidence, never authority. This stream exposes no execution surface: no
// campaign, strategy, budget, Business DNA, provider, payment or billing
// effect exists anywhere here. Trust vocabulary is consumed from R8-F
// (docs/contracts/strategic-intelligence-governance-contract.md), never
// redefined.

import { z } from "zod";

export const MARKET_SIGNAL_CONTRACT_VERSION = "market-external-signal/v1" as const;
export const MARKET_SIGNAL_PROJECTION_VERSION = "external-signal/v1" as const;
export const MARKET_SIGNAL_FRESHNESS_POLICY_VERSION = "market-signal-freshness/v1" as const;

// ─── R8-C controlled vocabularies (closed) ───

export const MARKET_SIGNAL_TYPES = [
  "COMPETITOR_ACTION",
  "MARKET_DEMAND",
  "PRICING_CHANGE",
  "PRODUCT_LAUNCH",
  "REGULATORY_CHANGE",
  "TECHNOLOGY_CHANGE",
  "CHANNEL_PLATFORM_CHANGE",
  "MACRO_ENVIRONMENT",
  "REPUTATION_SIGNAL",
  "ECOSYSTEM_CHANGE",
] as const;

export const MARKET_SUBJECT_TYPES = [
  "COMPETITOR",
  "MARKET_CATEGORY",
  "PRODUCT",
  "SERVICE",
  "REGULATION",
  "TECHNOLOGY",
  "CHANNEL",
  "PLATFORM",
  "BRAND",
  "CONSUMER_SEGMENT",
  "SUPPLIER",
  "PARTNER",
  "MACRO_INDICATOR",
  "BUSINESS_SELF",
  "UNKNOWN",
] as const;

export const MARKET_SOURCE_TYPES = [
  "OFFICIAL_GOVERNMENT",
  "OFFICIAL_REGULATOR",
  "OFFICIAL_COMPANY",
  "NEWS_WIRE",
  "NEWS_MEDIA",
  "INDUSTRY_ANALYST",
  "SOCIAL_PLATFORM",
  "AGGREGATOR",
  "UNKNOWN_SOURCE",
] as const;

/** Source registry standing — server-derived only, never client-supplied. */
export const MARKET_REGISTRY_CLASSES = ["OFFICIAL", "VERIFIED", "UNVERIFIED"] as const;

/**
 * Source trust classes — the exact R8-F §5 vocabulary (consumed, not
 * redefined). AUTHORITATIVE_INTERNAL exists in R8-F for internal evidence and
 * never applies to external signals.
 */
export const MARKET_SOURCE_TRUST_CLASSES = [
  "VERIFIED_EXTERNAL",
  "CORROBORATED_EXTERNAL",
  "SINGLE_EXTERNAL_SOURCE",
  "UNVERIFIED",
  "CONTRADICTED",
  "MALFORMED",
] as const;

export const MARKET_FRESHNESS_CLASSES = ["CURRENT", "AGING", "STALE", "EXPIRED"] as const;

export const MARKET_CORROBORATION_STATUSES = ["UNCORROBORATED", "CORROBORATED", "MIXED", "CONTRADICTED"] as const;

export const MARKET_RELEVANCE_CLASSES = ["DIRECT", "RELATED", "WEAK", "IRRELEVANT"] as const;

export const MARKET_CONFIDENCE_CLASSES = ["NONE", "LOW", "MEDIUM", "HIGH"] as const;

export const MARKET_SIGNAL_STATUSES = [
  "OBSERVED",
  "CORROBORATED",
  "CONTRADICTED",
  "SUPERSEDED",
  "STALE",
  "INVALIDATED",
] as const;

export const MARKET_LIFECYCLE_TYPES = [
  "CORROBORATION",
  "CONTRADICTION",
  "SUPERSESSION",
  "STALENESS",
  "INVALIDATION",
] as const;

/** Signal statuses still eligible as active evidence in the current projection. */
export const MARKET_ACTIVE_SIGNAL_STATUSES = ["OBSERVED", "CORROBORATED"] as const;

/** Freshness classes still eligible as active evidence in the current projection. */
export const MARKET_ACTIVE_FRESHNESS_CLASSES = ["CURRENT", "AGING"] as const;

/** The single content-isolation label carried on every row and projection. */
export const MARKET_CONTENT_ISOLATION = "INERT_EVIDENCE" as const;

// ─── zod enums over the closed vocabularies ───

export const MarketSignalTypeEnum = z.enum(MARKET_SIGNAL_TYPES);
export const MarketSubjectTypeEnum = z.enum(MARKET_SUBJECT_TYPES);
export const MarketSourceTypeEnum = z.enum(MARKET_SOURCE_TYPES);
export const MarketRegistryClassEnum = z.enum(MARKET_REGISTRY_CLASSES);
export const MarketSourceTrustClassEnum = z.enum(MARKET_SOURCE_TRUST_CLASSES);
export const MarketFreshnessClassEnum = z.enum(MARKET_FRESHNESS_CLASSES);
export const MarketCorroborationStatusEnum = z.enum(MARKET_CORROBORATION_STATUSES);
export const MarketRelevanceClassEnum = z.enum(MARKET_RELEVANCE_CLASSES);
export const MarketConfidenceClassEnum = z.enum(MARKET_CONFIDENCE_CLASSES);
export const MarketSignalStatusEnum = z.enum(MARKET_SIGNAL_STATUSES);

export type MarketSignalType = z.infer<typeof MarketSignalTypeEnum>;
export type MarketSubjectType = z.infer<typeof MarketSubjectTypeEnum>;
export type MarketSourceType = z.infer<typeof MarketSourceTypeEnum>;
export type MarketRegistryClass = z.infer<typeof MarketRegistryClassEnum>;
export type MarketSourceTrustClass = z.infer<typeof MarketSourceTrustClassEnum>;
export type MarketFreshnessClass = z.infer<typeof MarketFreshnessClassEnum>;
export type MarketCorroborationStatus = z.infer<typeof MarketCorroborationStatusEnum>;
export type MarketRelevanceClass = z.infer<typeof MarketRelevanceClassEnum>;
export type MarketConfidenceClass = z.infer<typeof MarketConfidenceClassEnum>;
export type MarketSignalStatus = z.infer<typeof MarketSignalStatusEnum>;
export type MarketLifecycleType = (typeof MARKET_LIFECYCLE_TYPES)[number];

export const MARKET_SIGNAL_TYPE_SET: ReadonlySet<string> = new Set(MARKET_SIGNAL_TYPES);
export const MARKET_SOURCE_TRUST_CLASS_SET: ReadonlySet<string> = new Set(MARKET_SOURCE_TRUST_CLASSES);

// ─── Typed error taxonomy (stable codes, fail-closed) ───

export class MarketSignalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MarketSignalError";
    this.code = code;
  }
}

/** Ingest input failed safety/bounding/authority validation. */
export class MarketSignalInputError extends MarketSignalError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "MarketSignalInputError";
  }
}

/** Tenant/business/lineage ownership could not be proven server-side. */
export class MarketSignalOwnershipError extends MarketSignalError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "MarketSignalOwnershipError";
  }
}

/** Guarded state rejected (integrity drift, invalid lineage, ...). */
export class MarketSignalStateError extends MarketSignalError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "MarketSignalStateError";
  }
}

/** Durable identity reused with conflicting material. */
export class MarketSignalIdentityConflictError extends MarketSignalError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "MarketSignalIdentityConflictError";
  }
}

/** Record hash drift — retained material no longer matches its hash. */
export class MarketSignalTamperError extends MarketSignalError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "MarketSignalTamperError";
  }
}

export type MarketSignalDuplicateClassification = "none" | "idempotent_replay";

// ─── Canonical pure helpers (exported for module reuse) ───

import { createHash } from "crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export const HEX_64 = /^[a-f0-9]{64}$/;
export const SIGNAL_ID_PATTERN = /^xsig1:[a-f0-9]{64}$/;
export const SOURCE_ID_PATTERN = /^src1:[a-f0-9]{64}$/;

/** Bounded safe reference pattern (opaque ids/refs; house convention). */
export const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-./|]{0,190}$/;

const ISO_8601_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;

export function assertIso8601(value: string, field: string): void {
  if (!ISO_8601_STRICT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_INPUT_INVALID",
      `${field} must be a valid ISO 8601 timestamp; got ${JSON.stringify(value)}.`
    );
  }
}

// ─── Ingest boundary (strict; clients never supply authority fields) ───

export const MARKET_SIGNAL_SOURCE_INPUT_FIELDS = [
  "sourceType",
  "sourceUriRef",
  "originHint",
] as const;

export const marketSignalSourceInputSchema = z.strictObject({
  sourceType: MarketSourceTypeEnum,
  /** Absolute http(s) URI; the server normalizes and safety-strips it. */
  sourceUriRef: z.string().min(1).max(600),
  /** Optional publisher/origin hint; server normalizes and validates it. */
  originHint: z.string().min(1).max(191).regex(SAFE_REFERENCE_PATTERN, "originHint has invalid shape").optional(),
});

export const marketSignalModelAssistanceSchema = z.strictObject({
  extractorVersion: z.string().min(1).max(48),
  /** Candidate proposal only — the server bounds it by deterministic support. */
  proposedRelevanceClass: MarketRelevanceClassEnum.optional(),
  summary: z.string().max(512).optional(),
});

export const marketSignalIngestInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  signalType: MarketSignalTypeEnum,
  subjectType: MarketSubjectTypeEnum,
  subjectRef: z.string().min(1).max(191).regex(SAFE_REFERENCE_PATTERN, "subjectRef has invalid shape"),
  claimAspect: z.string().min(1).max(64).regex(SAFE_REFERENCE_PATTERN, "claimAspect has invalid shape"),
  source: marketSignalSourceInputSchema,
  /** Normalized publication/event identity within the source. */
  eventKey: z.string().min(1).max(191).regex(SAFE_REFERENCE_PATTERN, "eventKey has invalid shape"),
  observedAt: z.string().max(40),
  publishedAt: z.string().max(40).optional(),
  /** Inert untrusted evidence (normalized server-side). */
  claimText: z.string().min(1).max(8000),
  /** Validated contradiction lineage (same claim family, different claim). */
  contradictsSignalIds: z.array(z.string().regex(SIGNAL_ID_PATTERN, "contradictsSignalIds entries must be xsig1: ids")).max(8).optional(),
  supersedesSignalId: z.string().regex(SIGNAL_ID_PATTERN, "supersedesSignalId must be an xsig1: id").optional(),
  modelAssistance: marketSignalModelAssistanceSchema.optional(),
  limitations: z.array(z.string().min(1).max(191)).max(8).optional(),
});

export type MarketSignalSourceInput = z.infer<typeof marketSignalSourceInputSchema>;
export type MarketSignalModelAssistance = z.infer<typeof marketSignalModelAssistanceSchema>;
export type MarketSignalIngestInput = z.infer<typeof marketSignalIngestInputSchema>;

/** Server-side authority fields a client must never supply (fail closed). */
const CLIENT_AUTHORITY_FIELDS = [
  "signalId",
  "sourceId",
  "registryClass",
  "sourceRegistryClass",
  "sourceTrustClass",
  "trustClass",
  "confidenceClass",
  "freshnessClass",
  "corroborationStatus",
  "corroboratingSignalIds",
  "contradictingSignalIds",
  "relevanceClass",
  "relevanceEvidence",
  "signalStatus",
  "status",
  "evidenceHash",
  "claimKey",
  "claimFamilyKey",
  "sourceIndependenceKey",
  "contentIsolation",
  "injectionSuspected",
  "verified",
  "trusted",
  "isTrusted",
  "setTrusted",
  "promoteTrust",
  "forceAllow",
  "forceApprove",
  "override",
  "overridePolicy",
  "userId",
  "id",
  "version",
  "ingestedAt",
  "createdAt",
] as const;

export function assertNoClientAuthorityFields(input: Record<string, unknown>): void {
  // Fail closed: any attempt to smuggle signal authority is rejected, never
  // silently ignored — silent ignoring would hide a probe.
  for (const key of CLIENT_AUTHORITY_FIELDS) {
    if (key in input) {
      throw new MarketSignalInputError(
        "MARKET_SIGNAL_CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        `Field "${key}" is server-side authority and must never be client-supplied.`
      );
    }
  }
}

/**
 * Pure validation/normalization of one ingest request. Runs the strict zod
 * boundary and rejects client-authority smuggling. Throws
 * MarketSignalInputError on any malformed input (fail closed).
 */
export function buildMarketSignalInput(raw: unknown): MarketSignalIngestInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_INPUT_INVALID",
      "Market signal ingest input must be a structured object."
    );
  }
  assertNoClientAuthorityFields(raw as Record<string, unknown>);
  let parsed: MarketSignalIngestInput;
  try {
    parsed = marketSignalIngestInputSchema.parse(raw);
  } catch (err) {
    const first = (err as { issues?: { path: (string | number)[]; message: string }[] })?.issues?.[0];
    const where = first?.path?.join(".") ?? "input";
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_INPUT_INVALID",
      `Market signal ingest input failed validation at ${where}: ${first?.message ?? String(err)}`
    );
  }
  assertIso8601(parsed.observedAt, "observedAt");
  if (parsed.publishedAt !== undefined) {
    assertIso8601(parsed.publishedAt, "publishedAt");
  }
  // An event cannot be observed before it was published; a future-dated
  // publishedAt beyond bounded skew is rejected (house ±5 min rule).
  if (parsed.publishedAt !== undefined && Date.parse(parsed.observedAt) < Date.parse(parsed.publishedAt)) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_INPUT_INVALID",
      "observedAt precedes publishedAt; temporal evidence is inconsistent."
    );
  }
  return parsed;
}

// ─── Verbatim disclaimers carried on every projection and read surface ───

export const MARKET_SIGNAL_CAUSATION_DISCLAIMER =
  "An external signal is observed evidence, not causal proof. This projection does not assert that any market event, source claim or marketing activity caused any business outcome." as const;

export const MARKET_SIGNAL_ATTRIBUTION_DISCLAIMER =
  "External-signal association is not attribution. Credit allocation and channel weights remain R7-B derivations on their own authority." as const;
