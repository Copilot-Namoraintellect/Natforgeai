// ─── R8-A Strategic Memory — canonical memory contract ───
//
// PURE contract module: closed vocabularies, canonical record types, zod
// schemas and the typed error taxonomy for the strategic-memory authority
// (WBS-R8-A). It performs no I/O of any kind, has no clock and authorizes
// nothing. A strategic-memory record is durable, versioned context derived
// from authoritative upstream evidence (R7 authorities, Business DNA,
// strategy snapshots) or governed human attestation — never autonomous
// strategy. Facts and assumptions stay distinct; history is immutable;
// contradictions stay visible; no record may authorize spend, experiments,
// campaigns or strategy changes.

import { z } from "zod";
import { canonicalJson, sha256Hex } from "../conversion/conversion-contract";

export const STRATEGIC_MEMORY_CONTRACT_VERSION = "strategic-memory/v1" as const;

// ─── R8-A controlled vocabularies (closed) ───

/** Adapted to the repository — RISK_POSTURE / CAPABILITY_STATE not adopted (contract §3.1). */
export const STRATEGIC_MEMORY_TYPES = [
  "BUSINESS_FACT",
  "BUSINESS_ASSUMPTION",
  "STRATEGIC_OBJECTIVE",
  "STRATEGIC_DECISION",
  "OUTCOME_PATTERN",
  "LEARNING_PATTERN",
  "EXPERIMENT_RESULT",
  "OPTIMISATION_DECISION",
  "CONSTRAINT",
] as const;

export const STRATEGIC_MEMORY_SUBJECT_TYPES = [
  "BUSINESS",
  "CAMPAIGN",
  "OBJECTIVE",
  "DECISION",
  "OUTCOME",
  "ATTRIBUTION",
  "LEARNING",
  "EXPERIMENT",
  "OPTIMISATION",
  "GOVERNANCE",
  "PORTFOLIO",
  "POLICY",
] as const;

export const STRATEGIC_MEMORY_STATUSES = [
  "CURRENT",
  "STALE",
  "SUPERSEDED",
  "CONTRADICTED",
  "EXPIRED",
  "INVALIDATED",
] as const;

export const STRATEGIC_MEMORY_STATEMENT_TYPES = ["FACT", "ASSUMPTION"] as const;

export const STRATEGIC_MEMORY_CONFIDENCE_CLASSES = [
  "AUTHORITATIVE",
  "VERIFIED",
  "PROVISIONAL",
  "OBSERVED",
  "UNVERIFIED",
] as const;

export const STRATEGIC_MEMORY_SOURCE_AUTHORITIES = [
  "r7_outcome",
  "r7_attribution",
  "r7_learning",
  "r7_experimentation",
  "r7_budget_portfolio",
  "r7_governance",
  "business_dna",
  "strategy_snapshot",
  "operator_attestation",
] as const;

/** R7 / governed sources that may mint FACT (operator_attestation may not). */
export const STRATEGIC_MEMORY_FACT_SOURCES = [
  "r7_outcome",
  "r7_attribution",
  "r7_learning",
  "r7_experimentation",
  "r7_budget_portfolio",
  "r7_governance",
  "business_dna",
  "strategy_snapshot",
] as const;

/** Memory types the operator attestation path may mint. */
export const OPERATOR_MEMORY_TYPES = [
  "BUSINESS_ASSUMPTION",
  "STRATEGIC_OBJECTIVE",
  "STRATEGIC_DECISION",
  "CONSTRAINT",
] as const;

export const STRATEGIC_MEMORY_BASIS_TYPES = [
  "OPERATOR_JUDGMENT",
  "MARKET_SIGNAL",
  "PENDING_VERIFICATION",
  "PRIOR_EXPERIENCE",
] as const;

export const STRATEGIC_MEMORY_CONTEXT_SCOPE_TYPES = [
  "BUSINESS",
  "CAMPAIGN",
  "OBJECTIVE",
  "PORTFOLIO",
] as const;

/** Append-only memory lifecycle fact types (smf1: identities). */
export const STRATEGIC_MEMORY_LIFECYCLE_TYPES = [
  "supersession",
  "contradiction",
  "invalidation",
  "staleness",
  "expiry",
  "reaffirmation",
] as const;

/** Closed protected-trait rejection set (contract §3.8). */
export const STRATEGIC_MEMORY_PROTECTED_TRAITS = [
  "race",
  "ethnicity",
  "religion",
  "belief",
  "health",
  "genetic",
  "biometric",
  "political opinion",
  "trade union membership",
  "sexual orientation",
  "precise geolocation",
] as const;

/** Frozen upstream contract versions consumable per source (contract §6.1). */
export const STRATEGIC_MEMORY_SOURCE_VERSIONS: Record<string, string> = {
  r7_outcome: "conversion-outcome/v1",
  r7_attribution: "attribution-to-learning/v1",
  r7_learning: "business-learning-to-experiment-optimisation/v1",
  r7_experimentation: "experimentation-result-handoff/v1",
  r7_budget_portfolio: "business-optimisation-to-strategy/v1",
  r7_governance: "optimisation-governance/v1",
  business_dna: "business-dna/v1",
  strategy_snapshot: "strategy-snapshot/v1",
  operator_attestation: "operator/v1",
};

// ─── zod enums over the closed vocabularies ───

export const StrategicMemoryTypeEnum = z.enum(STRATEGIC_MEMORY_TYPES);
export const StrategicMemorySubjectTypeEnum = z.enum(STRATEGIC_MEMORY_SUBJECT_TYPES);
export const StrategicMemoryStatusEnum = z.enum(STRATEGIC_MEMORY_STATUSES);
export const StrategicMemoryStatementTypeEnum = z.enum(STRATEGIC_MEMORY_STATEMENT_TYPES);
export const StrategicMemoryConfidenceClassEnum = z.enum(STRATEGIC_MEMORY_CONFIDENCE_CLASSES);
export const StrategicMemorySourceAuthorityEnum = z.enum(STRATEGIC_MEMORY_SOURCE_AUTHORITIES);
export const StrategicMemoryBasisTypeEnum = z.enum(STRATEGIC_MEMORY_BASIS_TYPES);
export const StrategicMemoryContextScopeTypeEnum = z.enum(STRATEGIC_MEMORY_CONTEXT_SCOPE_TYPES);
export const StrategicMemoryLifecycleTypeEnum = z.enum(STRATEGIC_MEMORY_LIFECYCLE_TYPES);

export type StrategicMemoryType = z.infer<typeof StrategicMemoryTypeEnum>;
export type StrategicMemorySubjectType = z.infer<typeof StrategicMemorySubjectTypeEnum>;
export type StrategicMemoryStatus = z.infer<typeof StrategicMemoryStatusEnum>;
export type StrategicMemoryStatementType = z.infer<typeof StrategicMemoryStatementTypeEnum>;
export type StrategicMemoryConfidenceClass = z.infer<typeof StrategicMemoryConfidenceClassEnum>;
export type StrategicMemorySourceAuthority = z.infer<typeof StrategicMemorySourceAuthorityEnum>;
export type StrategicMemoryBasisType = z.infer<typeof StrategicMemoryBasisTypeEnum>;
export type StrategicMemoryContextScopeType = z.infer<typeof StrategicMemoryContextScopeTypeEnum>;
export type StrategicMemoryLifecycleType = z.infer<typeof StrategicMemoryLifecycleTypeEnum>;

export const STRATEGIC_MEMORY_FACT_SOURCE_SET: ReadonlySet<string> = new Set(STRATEGIC_MEMORY_FACT_SOURCES);
export const STRATEGIC_MEMORY_R7_SOURCE_SET: ReadonlySet<string> = new Set([
  "r7_outcome",
  "r7_attribution",
  "r7_learning",
  "r7_experimentation",
  "r7_budget_portfolio",
  "r7_governance",
]);

// ─── Typed error taxonomy (stable codes, fail-closed) ───

export class StrategicMemoryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StrategicMemoryError";
    this.code = code;
  }
}

/** Record input failed safety/bounding/authority validation. */
export class StrategicMemoryInputError extends StrategicMemoryError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "StrategicMemoryInputError";
  }
}

/** A record failed schema validation. */
export class StrategicMemoryValidationError extends StrategicMemoryError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "StrategicMemoryValidationError";
  }
}

/** Evidence hash / source fingerprint drift — retained material no longer matches. */
export class StrategicMemoryTamperError extends StrategicMemoryError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "StrategicMemoryTamperError";
  }
}

/** Tenant/business/ownership could not be proven server-side. */
export class StrategicMemoryOwnershipError extends StrategicMemoryError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "StrategicMemoryOwnershipError";
  }
}

/** Guarded state transition rejected (stale version or illegal transition). */
export class StrategicMemoryStateConflictError extends StrategicMemoryError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "StrategicMemoryStateConflictError";
  }
}

/** Durable identity reused with conflicting material. */
export class StrategicMemoryIdentityConflictError extends StrategicMemoryError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "StrategicMemoryIdentityConflictError";
  }
}

export type StrategicMemoryDuplicateClassification = "none" | "idempotent_replay";

// ─── Boundary patterns ───

const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-./]{0,190}$/;
const MEMORY_ID_PATTERN = /^mem1:[a-f0-9]{64}$/;
const EVIDENCE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-./]{0,190}$/;

export function isStrategicMemoryId(value: string): boolean {
  return MEMORY_ID_PATTERN.test(value);
}

// ─── Client-authority guard ───

/** Server-side authority fields a client must never supply (fail closed). */
const CLIENT_AUTHORITY_FIELDS = [
  "memoryId",
  "factStatus",
  "confidenceClass",
  "evidenceHash",
  "sourceFingerprint",
  "userId",
  "id",
  "version",
  "createdAt",
  "causationClaimed",
  "causationDisclaimer",
  "attributionClaimed",
  "attributionDisclaimer",
  "verified",
] as const;

export function assertNoStrategicMemoryClientAuthorityFields(input: Record<string, unknown>): void {
  // Fail closed: any attempt to smuggle memory/status/confidence authority is
  // rejected, never silently ignored — silent ignoring would hide a probe.
  for (const key of CLIENT_AUTHORITY_FIELDS) {
    if (key in input) {
      throw new StrategicMemoryInputError(
        "STRATEGIC_MEMORY_CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        `Field "${key}" is server-side authority and must never be client-supplied.`
      );
    }
  }
}

// ─── Statement / basis / limitations shapes ───

export const operatorStatementSchema = z.strictObject({
  text: z.string().min(1).max(1024),
});

export const assumptionBasisSchema = z.strictObject({
  basisType: StrategicMemoryBasisTypeEnum,
  summary: z.string().min(1).max(280),
});

const limitationSchema = z.string().min(1).max(191);

// ─── Record input (strict boundary; operator attestation path) ───

export const strategicMemoryRecordInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  memoryType: z.enum(OPERATOR_MEMORY_TYPES),
  subjectType: StrategicMemorySubjectTypeEnum,
  subjectId: z.string().min(1).max(191).regex(SAFE_REFERENCE_PATTERN),
  statementType: StrategicMemoryStatementTypeEnum,
  statement: operatorStatementSchema,
  basis: assumptionBasisSchema.nullish(),
  limitations: z.array(limitationSchema).max(8).nullish(),
  evidenceRefs: z.array(z.string().min(1).max(191).regex(EVIDENCE_REF_PATTERN)).max(16).nullish(),
  validFrom: z.string().max(32),
  validUntil: z.string().max(32).nullish(),
  observedAt: z.string().max(32).nullish(),
  recordedAt: z.string().max(32).nullish(),
  supersedesMemoryId: z.string().min(1).max(69).regex(SAFE_REFERENCE_PATTERN).nullish(),
  contradictsMemoryIds: z.array(z.string().min(1).max(69).regex(SAFE_REFERENCE_PATTERN)).max(8).nullish(),
});

export type StrategicMemoryRecordInput = z.infer<typeof strategicMemoryRecordInputSchema>;

// ─── R7 ingest input (strict boundary; server loads all authority material) ───

export const strategicMemoryIngestInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  sourceAuthority: z.enum([
    "r7_outcome",
    "r7_attribution",
    "r7_learning",
    "r7_experimentation",
    "r7_budget_portfolio",
    "r7_governance",
    "business_dna",
    "strategy_snapshot",
  ]),
  sourceIdentity: z.string().min(1).max(191).regex(SAFE_REFERENCE_PATTERN),
  observedAt: z.string().max(32).nullish(),
  recordedAt: z.string().max(32).nullish(),
});

export type StrategicMemoryIngestInput = z.infer<typeof strategicMemoryIngestInputSchema>;

// ─── Timestamp validation (no clock in this module) ───

const ISO_8601_PARSEABLE = (value: string) => !Number.isNaN(Date.parse(value));

function assertTimestamp(value: string, field: string, now: string): string {
  if (!ISO_8601_PARSEABLE(value)) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_TIMESTAMP_INVALID",
      `${field} must be a parseable ISO 8601 timestamp; got ${JSON.stringify(value)}.`
    );
  }
  const year = Number(value.slice(0, 4));
  if (!Number.isInteger(year) || year < 2000) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_TIMESTAMP_INVALID",
      `${field} year must be >= 2000; got ${JSON.stringify(value)}.`
    );
  }
  const nowMs = Date.parse(now);
  const valueMs = Date.parse(value);
  if (nowMs - valueMs < -5 * 60 * 1000) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_TIMESTAMP_INVALID",
      `${field} must not be more than 5 minutes in the future; got ${JSON.stringify(value)}.`
    );
  }
  return value;
}

// ─── Protected-trait guard (A7 / contract §3.8) ───

const PROTECTED_TRAIT_PATTERN = new RegExp(
  `\\b(${STRATEGIC_MEMORY_PROTECTED_TRAITS.map((t) => t.replace(/ /g, "[_ -]")).join("|")})\\b`,
  "i"
);

function scanProtectedTraits(value: unknown, hits: Set<string>): void {
  if (typeof value === "string") {
    const match = value.match(PROTECTED_TRAIT_PATTERN);
    if (match) hits.add(match[0].toLowerCase());
  } else if (Array.isArray(value)) {
    for (const entry of value) scanProtectedTraits(entry, hits);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) scanProtectedTraits(entry, hits);
  }
}

/**
 * Deterministic protected-trait scan over all client-visible textual material.
 * Under the default policy there is no lawful-authority exception path; any
 * hit fails closed.
 */
export function assertNoProtectedTraits(material: Record<string, unknown>): void {
  const hits = new Set<string>();
  scanProtectedTraits(material, hits);
  if (hits.size > 0) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_PROTECTED_TRAIT_REJECTED",
      `Memory material references protected trait(s): ${[...hits].join(", ")}. Rejected under the default policy.`
    );
  }
}

// ─── Pure input builders ───

/**
 * Pure validation/normalization of one operator-path record request. `now` is
 * an explicit ISO 8601 string — this module has no clock. Enforces the
 * fact/assumption distinction invariants (§5), the protected-trait guard, and
 * lineage shape. Throws StrategicMemoryInputError on any malformed input.
 */
export function buildStrategicMemoryRecordInput(raw: unknown, now: string): StrategicMemoryRecordInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_INPUT_INVALID",
      "Strategic memory record input must be a structured object."
    );
  }
  assertNoStrategicMemoryClientAuthorityFields(raw as Record<string, unknown>);
  let parsed: StrategicMemoryRecordInput;
  try {
    parsed = strategicMemoryRecordInputSchema.parse(raw);
  } catch (err) {
    const first = (err as { issues?: { path: (string | number)[]; message: string }[] })?.issues?.[0];
    const where = first?.path?.join(".") ?? "input";
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_INPUT_INVALID",
      `Strategic memory record input failed validation at ${where}: ${first?.message ?? String(err)}`
    );
  }

  assertTimestamp(parsed.validFrom, "validFrom", now);
  if (parsed.validUntil != null) {
    // validUntil is an expiry/review window: it is inherently in the future,
    // so only parseability + the minimum-year bound apply (no future skew).
    if (!ISO_8601_PARSEABLE(parsed.validUntil)) {
      throw new StrategicMemoryInputError(
        "STRATEGIC_MEMORY_TIMESTAMP_INVALID",
        `validUntil must be a parseable ISO 8601 timestamp; got ${JSON.stringify(parsed.validUntil)}.`
      );
    }
    const untilYear = Number(parsed.validUntil.slice(0, 4));
    if (!Number.isInteger(untilYear) || untilYear < 2000) {
      throw new StrategicMemoryInputError(
        "STRATEGIC_MEMORY_TIMESTAMP_INVALID",
        `validUntil year must be >= 2000; got ${JSON.stringify(parsed.validUntil)}.`
      );
    }
    if (Date.parse(parsed.validUntil) <= Date.parse(parsed.validFrom)) {
      throw new StrategicMemoryInputError(
        "STRATEGIC_MEMORY_TEMPORAL_INVALID",
        "validUntil must be strictly after validFrom."
      );
    }
  }
  if (parsed.observedAt != null) assertTimestamp(parsed.observedAt, "observedAt", now);
  if (parsed.recordedAt != null) assertTimestamp(parsed.recordedAt, "recordedAt", now);

  // Fact/assumption distinction invariants (contract §5).
  if (parsed.statementType === "FACT") {
    // The operator path can never mint FACT (contract §5.1); FACT derives only
    // through governed upstream ingestion.
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_FACT_REQUIRES_AUTHORITY",
      "statementType FACT requires authoritative upstream evidence; client-supplied text can never create a FACT. Record an ASSUMPTION or ingest the governing authority."
    );
  }
  // ASSUMPTION requires basis, limitations and expiry/review semantics.
  if (!parsed.basis || parsed.basis.summary.trim().length === 0) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_ASSUMPTION_REQUIRES_BASIS",
      "ASSUMPTION records require a non-empty basis (basisType + summary)."
    );
  }
  if (!parsed.limitations || parsed.limitations.length === 0) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_ASSUMPTION_REQUIRES_LIMITATIONS",
      "ASSUMPTION records require at least one limitation."
    );
  }
  if (parsed.validUntil == null) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_ASSUMPTION_REQUIRES_EXPIRY",
      "ASSUMPTION records require validUntil (expiry/review semantics)."
    );
  }

  if (parsed.supersedesMemoryId !== null && parsed.supersedesMemoryId !== undefined) {
    if (!isStrategicMemoryId(parsed.supersedesMemoryId)) {
      throw new StrategicMemoryInputError(
        "STRATEGIC_MEMORY_LINEAGE_INVALID",
        `supersedesMemoryId must be a mem1: identity; got ${JSON.stringify(parsed.supersedesMemoryId)}.`
      );
    }
  }
  for (const id of parsed.contradictsMemoryIds ?? []) {
    if (!isStrategicMemoryId(id)) {
      throw new StrategicMemoryInputError(
        "STRATEGIC_MEMORY_LINEAGE_INVALID",
        `contradictsMemoryIds entries must be mem1: identities; got ${JSON.stringify(id)}.`
      );
    }
  }

  assertNoProtectedTraits({
    statement: parsed.statement,
    basis: parsed.basis,
    limitations: parsed.limitations ?? [],
  });

  return parsed;
}

/**
 * Pure validation/normalization of one R7/governed ingest request. The server
 * loads every authoritative field from durable upstream rows; the client only
 * names the source authority + identity.
 */
export function buildStrategicMemoryIngestInput(raw: unknown, now: string): StrategicMemoryIngestInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_INPUT_INVALID",
      "Strategic memory ingest input must be a structured object."
    );
  }
  assertNoStrategicMemoryClientAuthorityFields(raw as Record<string, unknown>);
  let parsed: StrategicMemoryIngestInput;
  try {
    parsed = strategicMemoryIngestInputSchema.parse(raw);
  } catch (err) {
    const first = (err as { issues?: { path: (string | number)[]; message: string }[] })?.issues?.[0];
    const where = first?.path?.join(".") ?? "input";
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_INPUT_INVALID",
      `Strategic memory ingest input failed validation at ${where}: ${first?.message ?? String(err)}`
    );
  }
  if (parsed.observedAt != null) assertTimestamp(parsed.observedAt, "observedAt", now);
  if (parsed.recordedAt != null) assertTimestamp(parsed.recordedAt, "recordedAt", now);
  return parsed;
}

// ─── Deterministic confidence mapping (contract §5.3) ───

/**
 * R7-A evidence authority → memory confidence. Server-derived only.
 */
export function deriveConfidenceFromOutcomeAuthority(evidenceAuthority: string): StrategicMemoryConfidenceClass {
  if (evidenceAuthority.startsWith("VERIFIED_")) return "VERIFIED";
  if (evidenceAuthority === "USER_ATTESTED") return "PROVISIONAL";
  return "OBSERVED";
}

/** R7-B evidence class → memory confidence (association strength, never causation). */
export function deriveConfidenceFromAttributionEvidence(evidenceClass: string): StrategicMemoryConfidenceClass {
  switch (evidenceClass) {
    case "DIRECT_LINKAGE":
      return "VERIFIED";
    case "STRONG_ASSOCIATION":
      return "PROVISIONAL";
    case "WEAK_ASSOCIATION":
      return "OBSERVED";
    default:
      return "UNVERIFIED";
  }
}

/** R7-C learning confidence → memory confidence. */
export function deriveConfidenceFromLearningConfidence(confidenceClass: string): StrategicMemoryConfidenceClass {
  switch (confidenceClass) {
    case "STRONG":
      return "VERIFIED";
    case "MODERATE":
      return "PROVISIONAL";
    case "WEAK":
      return "OBSERVED";
    default:
      return "UNVERIFIED";
  }
}

/** R7-D / R7-E confidence vocabulary → memory confidence. */
export function deriveConfidenceFromEngineConfidence(confidenceClass: string): StrategicMemoryConfidenceClass {
  switch (confidenceClass) {
    case "STRONG":
      return "VERIFIED";
    case "MODERATE":
      return "PROVISIONAL";
    case "WEAK":
      return "OBSERVED";
    default:
      return "UNVERIFIED";
  }
}

// Re-exports so downstream consumers have one import surface.
export { canonicalJson, sha256Hex };
