// ─── R8-B Business Change Intelligence — canonical change contract ───
//
// PURE contract module: closed vocabularies, canonical record types, zod
// schemas and the typed error taxonomy for the business-change authority
// (WBS-R8-B). It performs no I/O of any kind, has no clock and authorizes
// nothing. A business-change record is durable, immutable evidence that a
// deterministic comparison of two authoritative states (previous = R8-A
// current strategic memory; current = newly observed governed internal
// evidence) detected a meaningful internal change. Change detection compares
// authoritative states; it does not invent change; no model output field
// exists anywhere at this boundary.

import { z } from "zod";
import { canonicalJson, sha256Hex } from "../conversion/conversion-contract";

export const BUSINESS_CHANGE_CONTRACT_VERSION = "business-change/v1" as const;

// ─── R8-B controlled vocabularies (closed) ───

/** v1 wired domains — see docs/recovery/r8-b-business-change-inventory.md §4. */
export const BUSINESS_CHANGE_DOMAINS = [
  "BUSINESS_OBJECTIVE",
  "PRODUCT_SERVICE",
  "AUDIENCE",
  "BUDGET",
  "CAPABILITY",
  "PORTFOLIO_PERFORMANCE",
  "STRATEGIC_CONSTRAINT",
  "RISK_POSTURE",
] as const;

export const BUSINESS_CHANGE_TYPES = [
  "OBJECTIVE_ADDED",
  "OBJECTIVE_MODIFIED",
  "OBJECTIVE_REMOVED",
  "BUDGET_ENVELOPE_INCREASED",
  "BUDGET_ENVELOPE_DECREASED",
  "PROVIDER_SUPPORT_ADDED",
  "PROVIDER_SUPPORT_REMOVED",
  "PRODUCT_ADDED",
  "PRODUCT_REMOVED",
  "PRODUCT_REPOSITIONED",
  "AUDIENCE_SEGMENT_ADDED",
  "AUDIENCE_SEGMENT_REMOVED",
  "AUDIENCE_REPOSITIONED",
  "LEARNING_PATTERN_CONTRADICTED",
  "LEARNING_PATTERN_SUPERSEDED",
  "STRATEGY_REGIME_CHANGED",
  "CONSTRAINT_TIGHTENED",
  "CONSTRAINT_RELAXED",
  "RISK_POSTURE_ELEVATED",
  "RISK_POSTURE_REDUCED",
] as const;

export const BUSINESS_CHANGE_SUBJECT_TYPES = [
  "OBJECTIVE",
  "PRODUCT_SET",
  "AUDIENCE_SET",
  "BUDGET_ENVELOPE",
  "PROVIDER_CAPABILITY",
  "LEARNING",
  "STRATEGY",
  "CONSTRAINT",
  "RISK_POSTURE",
] as const;

/** New-state sources (closed). r7_outcome / r7_attribution are evidence refs only. */
export const BUSINESS_CHANGE_SOURCE_AUTHORITIES = [
  "business_dna",
  "strategy_snapshot",
  "r7_budget_portfolio",
  "r7_learning",
  "r7_governance",
  "operator_attestation",
] as const;

/** Governed (server-loaded) sources — operator_attestation excluded. */
export const BUSINESS_CHANGE_GOVERNED_SOURCES = [
  "business_dna",
  "strategy_snapshot",
  "r7_budget_portfolio",
  "r7_learning",
  "r7_governance",
] as const;

export const BUSINESS_CHANGE_SIGNIFICANCE_CLASSES = ["LOW", "MODERATE", "HIGH", "CRITICAL"] as const;

export const BUSINESS_CHANGE_CONFIDENCE_CLASSES = [
  "AUTHORITATIVE",
  "VERIFIED",
  "PROVISIONAL",
  "OBSERVED",
  "UNVERIFIED",
] as const;

export const BUSINESS_CHANGE_STATUSES = [
  "DETECTED",
  "CONFIRMED",
  "PROVISIONAL",
  "CONTRADICTED",
  "SUPERSEDED",
  "INVALIDATED",
  "EXPIRED",
] as const;

/** Append-only change lifecycle fact types (bcl1: identities). */
export const BUSINESS_CHANGE_LIFECYCLE_TYPES = [
  "confirmation",
  "contradiction",
  "supersession",
  "invalidation",
  "expiry",
  "reaffirmation",
] as const;

/** Closed protected-trait rejection set (contract §3.10). */
export const BUSINESS_CHANGE_PROTECTED_TRAITS = [
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
export const BUSINESS_CHANGE_SOURCE_VERSIONS: Record<string, string> = {
  business_dna: "business-dna/v1",
  strategy_snapshot: "strategy-snapshot/v1",
  r7_budget_portfolio: "business-optimisation-to-strategy/v1",
  r7_learning: "business-learning-to-experiment-optimisation/v1",
  r7_governance: "optimisation-governance/v1",
  operator_attestation: "operator/v1",
};

// ─── zod enums over the closed vocabularies ───

export const BusinessChangeDomainEnum = z.enum(BUSINESS_CHANGE_DOMAINS);
export const BusinessChangeTypeEnum = z.enum(BUSINESS_CHANGE_TYPES);
export const BusinessChangeSubjectTypeEnum = z.enum(BUSINESS_CHANGE_SUBJECT_TYPES);
export const BusinessChangeSourceAuthorityEnum = z.enum(BUSINESS_CHANGE_SOURCE_AUTHORITIES);
export const BusinessChangeGovernedSourceEnum = z.enum(BUSINESS_CHANGE_GOVERNED_SOURCES);
export const BusinessChangeSignificanceClassEnum = z.enum(BUSINESS_CHANGE_SIGNIFICANCE_CLASSES);
export const BusinessChangeConfidenceClassEnum = z.enum(BUSINESS_CHANGE_CONFIDENCE_CLASSES);
export const BusinessChangeStatusEnum = z.enum(BUSINESS_CHANGE_STATUSES);
export const BusinessChangeLifecycleTypeEnum = z.enum(BUSINESS_CHANGE_LIFECYCLE_TYPES);

export type BusinessChangeDomain = z.infer<typeof BusinessChangeDomainEnum>;
export type BusinessChangeType = z.infer<typeof BusinessChangeTypeEnum>;
export type BusinessChangeSubjectType = z.infer<typeof BusinessChangeSubjectTypeEnum>;
export type BusinessChangeSourceAuthority = z.infer<typeof BusinessChangeSourceAuthorityEnum>;
export type BusinessChangeSignificanceClass = z.infer<typeof BusinessChangeSignificanceClassEnum>;
export type BusinessChangeConfidenceClass = z.infer<typeof BusinessChangeConfidenceClassEnum>;
export type BusinessChangeStatus = z.infer<typeof BusinessChangeStatusEnum>;
export type BusinessChangeLifecycleType = z.infer<typeof BusinessChangeLifecycleTypeEnum>;

// ─── Typed error taxonomy (stable codes, fail-closed) ───

export class BusinessChangeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BusinessChangeError";
    this.code = code;
  }
}

/** Change input failed safety/bounding/authority validation. */
export class BusinessChangeInputError extends BusinessChangeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "BusinessChangeInputError";
  }
}

/** A record failed schema validation. */
export class BusinessChangeValidationError extends BusinessChangeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "BusinessChangeValidationError";
  }
}

/** Evidence hash / state fingerprint drift — retained material no longer matches. */
export class BusinessChangeTamperError extends BusinessChangeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "BusinessChangeTamperError";
  }
}

/** Tenant/business/ownership could not be proven server-side. */
export class BusinessChangeOwnershipError extends BusinessChangeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "BusinessChangeOwnershipError";
  }
}

/** Guarded state transition rejected (stale version or illegal transition). */
export class BusinessChangeStateConflictError extends BusinessChangeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "BusinessChangeStateConflictError";
  }
}

/** Durable identity reused with conflicting material. */
export class BusinessChangeIdentityConflictError extends BusinessChangeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "BusinessChangeIdentityConflictError";
  }
}

export type BusinessChangeDuplicateClassification = "none" | "idempotent_replay" | "corroborating_replay";

// ─── Boundary patterns ───

const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-./]{0,190}$/;
const CHANGE_ID_PATTERN = /^chg1:[a-f0-9]{64}$/;

export function isBusinessChangeId(value: string): boolean {
  return CHANGE_ID_PATTERN.test(value);
}

// ─── Client-authority guard ───

/** Server-side authority fields a client must never supply (fail closed). */
const CLIENT_AUTHORITY_FIELDS = [
  "changeId",
  "changeDomain",
  "changeType",
  "status",
  "significanceClass",
  "confidenceClass",
  "previousStateRef",
  "currentStateRef",
  "stateFingerprint",
  "evidenceHash",
  "userId",
  "id",
  "version",
  "createdAt",
  "confirmed",
  "verified",
  "causationClaimed",
  "causationDisclaimer",
] as const;

export function assertNoBusinessChangeClientAuthorityFields(
  input: Record<string, unknown>,
  options: { allowChangeIdReference?: boolean } = {}
): void {
  // Fail closed: any attempt to smuggle change/status/significance/confidence
  // authority is rejected, never silently ignored. `correct` legitimately
  // accepts a changeId REFERENCE (naming the change under correction) — a
  // reference names authority; it can never set it.
  for (const key of CLIENT_AUTHORITY_FIELDS) {
    if (options.allowChangeIdReference && key === "changeId") continue;
    if (key in input) {
      throw new BusinessChangeInputError(
        "CHANGE_CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        `Field "${key}" is server-side authority and must never be client-supplied.`
      );
    }
  }
}

// ─── Subject ↔ source binding (contract §3.4 / §5) ───

/** The only source authority each subject type may consume (server-enforced). */
export const BUSINESS_CHANGE_SUBJECT_SOURCE: Record<BusinessChangeSubjectType, BusinessChangeSourceAuthority> = {
  OBJECTIVE: "operator_attestation",
  PRODUCT_SET: "business_dna",
  AUDIENCE_SET: "business_dna",
  BUDGET_ENVELOPE: "r7_budget_portfolio",
  PROVIDER_CAPABILITY: "r7_budget_portfolio",
  LEARNING: "r7_learning",
  STRATEGY: "strategy_snapshot",
  CONSTRAINT: "r7_governance",
  RISK_POSTURE: "r7_governance",
};

/** Server-derived change domain per subject type (contract §3.1). */
export const BUSINESS_CHANGE_SUBJECT_DOMAIN: Record<BusinessChangeSubjectType, BusinessChangeDomain> = {
  OBJECTIVE: "BUSINESS_OBJECTIVE",
  PRODUCT_SET: "PRODUCT_SERVICE",
  AUDIENCE_SET: "AUDIENCE",
  BUDGET_ENVELOPE: "BUDGET",
  PROVIDER_CAPABILITY: "CAPABILITY",
  LEARNING: "PORTFOLIO_PERFORMANCE",
  STRATEGY: "PORTFOLIO_PERFORMANCE",
  CONSTRAINT: "STRATEGIC_CONSTRAINT",
  RISK_POSTURE: "RISK_POSTURE",
};

// ─── Input schemas (strict boundary) ───

const limitationSchema = z.string().min(1).max(191);

export const operatorObservedStateSchema = z.strictObject({
  objectiveText: z.string().max(280).nullish(),
});

export const businessChangeBasisSchema = z.strictObject({
  basisType: z.enum(["OPERATOR_JUDGMENT", "PENDING_VERIFICATION", "PRIOR_EXPERIENCE"]),
  summary: z.string().min(1).max(280),
});

/** Governed-source evaluation input: the client names source + subject only. */
export const businessChangeEvaluateInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  subjectType: BusinessChangeSubjectTypeEnum.exclude(["OBJECTIVE"] as never),
  subjectId: z.string().min(1).max(191).regex(SAFE_REFERENCE_PATTERN),
  sourceAuthority: BusinessChangeGovernedSourceEnum,
  sourceIdentity: z.string().min(1).max(191).regex(SAFE_REFERENCE_PATTERN),
  observedAt: z.string().max(32).nullish(),
  recordedAt: z.string().max(32).nullish(),
});

/** Operator attestation input: bounded observed state + basis (OBJECTIVE subject). */
export const businessChangeAttestInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  subjectType: z.enum(["OBJECTIVE"] as const),
  subjectId: z.string().min(1).max(191).regex(SAFE_REFERENCE_PATTERN),
  observedState: operatorObservedStateSchema,
  basis: businessChangeBasisSchema,
  limitations: z.array(limitationSchema).min(1).max(8),
  observedAt: z.string().max(32).nullish(),
  recordedAt: z.string().max(32).nullish(),
});

/** Correction input: name the change + the corrected source material. */
export const businessChangeCorrectInputSchema = z.strictObject({
  changeId: z.string().min(1).max(69).regex(SAFE_REFERENCE_PATTERN),
  sourceAuthority: BusinessChangeSourceAuthorityEnum,
  sourceIdentity: z.string().min(1).max(191).regex(SAFE_REFERENCE_PATTERN).nullish(),
  observedState: operatorObservedStateSchema.nullish(),
  observedAt: z.string().max(32).nullish(),
  recordedAt: z.string().max(32).nullish(),
});

export type BusinessChangeEvaluateInput = z.infer<typeof businessChangeEvaluateInputSchema>;
export type BusinessChangeAttestInput = z.infer<typeof businessChangeAttestInputSchema>;
export type BusinessChangeCorrectInput = z.infer<typeof businessChangeCorrectInputSchema>;

// ─── Timestamp validation (no clock in this module) ───

const ISO_8601_PARSEABLE = (value: string) => !Number.isNaN(Date.parse(value));

export function assertChangeTimestamp(value: string, field: string, now: string): string {
  if (!ISO_8601_PARSEABLE(value)) {
    throw new BusinessChangeInputError(
      "CHANGE_TIMESTAMP_INVALID",
      `${field} must be a parseable ISO 8601 timestamp; got ${JSON.stringify(value)}.`
    );
  }
  const year = Number(value.slice(0, 4));
  if (!Number.isInteger(year) || year < 2000) {
    throw new BusinessChangeInputError(
      "CHANGE_TIMESTAMP_INVALID",
      `${field} year must be >= 2000; got ${JSON.stringify(value)}.`
    );
  }
  const nowMs = Date.parse(now);
  const valueMs = Date.parse(value);
  if (nowMs - valueMs < -5 * 60 * 1000) {
    throw new BusinessChangeInputError(
      "CHANGE_TIMESTAMP_INVALID",
      `${field} must not be more than 5 minutes in the future; got ${JSON.stringify(value)}.`
    );
  }
  return value;
}

// ─── Protected-trait guard (contract §3.10) ───

const PROTECTED_TRAIT_PATTERN = new RegExp(
  `\\b(${BUSINESS_CHANGE_PROTECTED_TRAITS.map((t) => t.replace(/ /g, "[_ -]")).join("|")})\\b`,
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

/** Deterministic protected-trait scan over all client-visible textual material. */
export function assertNoChangeProtectedTraits(material: Record<string, unknown>): void {
  const hits = new Set<string>();
  scanProtectedTraits(material, hits);
  if (hits.size > 0) {
    throw new BusinessChangeInputError(
      "CHANGE_PROTECTED_TRAIT_REJECTED",
      `Change material references protected trait(s): ${[...hits].join(", ")}. Rejected under the default policy.`
    );
  }
}

// ─── Pure input builders ───

export function buildBusinessChangeEvaluateInput(raw: unknown, now: string): BusinessChangeEvaluateInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BusinessChangeInputError("CHANGE_INPUT_INVALID", "Business change evaluate input must be a structured object.");
  }
  assertNoBusinessChangeClientAuthorityFields(raw as Record<string, unknown>);
  let parsed: BusinessChangeEvaluateInput;
  try {
    parsed = businessChangeEvaluateInputSchema.parse(raw);
  } catch (err) {
    const first = (err as { issues?: { path: (string | number)[]; message: string }[] })?.issues?.[0];
    const where = first?.path?.join(".") ?? "input";
    throw new BusinessChangeInputError(
      "CHANGE_INPUT_INVALID",
      `Business change evaluate input failed validation at ${where}: ${first?.message ?? String(err)}`
    );
  }
  const expected = BUSINESS_CHANGE_SUBJECT_SOURCE[parsed.subjectType];
  if (parsed.sourceAuthority !== expected) {
    throw new BusinessChangeInputError(
      "CHANGE_SUBJECT_SOURCE_MISMATCH",
      `subjectType ${parsed.subjectType} consumes ${expected} only; got ${parsed.sourceAuthority}.`
    );
  }
  if (parsed.observedAt != null) assertChangeTimestamp(parsed.observedAt, "observedAt", now);
  if (parsed.recordedAt != null) assertChangeTimestamp(parsed.recordedAt, "recordedAt", now);
  return parsed;
}

export function buildBusinessChangeAttestInput(raw: unknown, now: string): BusinessChangeAttestInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BusinessChangeInputError("CHANGE_INPUT_INVALID", "Business change attest input must be a structured object.");
  }
  assertNoBusinessChangeClientAuthorityFields(raw as Record<string, unknown>);
  let parsed: BusinessChangeAttestInput;
  try {
    parsed = businessChangeAttestInputSchema.parse(raw);
  } catch (err) {
    const first = (err as { issues?: { path: (string | number)[]; message: string }[] })?.issues?.[0];
    const where = first?.path?.join(".") ?? "input";
    throw new BusinessChangeInputError(
      "CHANGE_INPUT_INVALID",
      `Business change attest input failed validation at ${where}: ${first?.message ?? String(err)}`
    );
  }
  if (parsed.observedAt != null) assertChangeTimestamp(parsed.observedAt, "observedAt", now);
  if (parsed.recordedAt != null) assertChangeTimestamp(parsed.recordedAt, "recordedAt", now);
  assertNoChangeProtectedTraits({
    observedState: parsed.observedState,
    basis: parsed.basis,
    limitations: parsed.limitations,
  });
  return parsed;
}

export function buildBusinessChangeCorrectInput(raw: unknown, now: string): BusinessChangeCorrectInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BusinessChangeInputError("CHANGE_INPUT_INVALID", "Business change correct input must be a structured object.");
  }
  assertNoBusinessChangeClientAuthorityFields(raw as Record<string, unknown>, { allowChangeIdReference: true });
  let parsed: BusinessChangeCorrectInput;
  try {
    parsed = businessChangeCorrectInputSchema.parse(raw);
  } catch (err) {
    const first = (err as { issues?: { path: (string | number)[]; message: string }[] })?.issues?.[0];
    const where = first?.path?.join(".") ?? "input";
    throw new BusinessChangeInputError(
      "CHANGE_INPUT_INVALID",
      `Business change correct input failed validation at ${where}: ${first?.message ?? String(err)}`
    );
  }
  if (!isBusinessChangeId(parsed.changeId)) {
    throw new BusinessChangeInputError("CHANGE_INPUT_INVALID", `changeId must be a chg1: identity; got ${JSON.stringify(parsed.changeId)}.`);
  }
  if (parsed.sourceAuthority === "operator_attestation") {
    if (!parsed.observedState) {
      throw new BusinessChangeInputError(
        "CHANGE_INPUT_INVALID",
        "operator_attestation corrections require observedState."
      );
    }
  } else if (!parsed.sourceIdentity) {
    throw new BusinessChangeInputError(
      "CHANGE_INPUT_INVALID",
      `sourceAuthority ${parsed.sourceAuthority} corrections require sourceIdentity.`
    );
  }
  if (parsed.observedAt != null) assertChangeTimestamp(parsed.observedAt, "observedAt", now);
  if (parsed.recordedAt != null) assertChangeTimestamp(parsed.recordedAt, "recordedAt", now);
  assertNoChangeProtectedTraits({ observedState: parsed.observedState });
  return parsed;
}

// Re-exports so downstream consumers have one import surface.
export { canonicalJson, sha256Hex };
