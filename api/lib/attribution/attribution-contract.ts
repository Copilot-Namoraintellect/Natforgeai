// ─── R7-B Attribution Intelligence — canonical attribution contract ───
//
// PURE contract module: closed vocabularies, canonical record types, zod
// schemas and the typed error taxonomy for the attribution authority
// (WBS-R7-B). It performs no I/O of any kind, has no clock and authorizes
// nothing. Attribution derives ASSOCIATION and allocated credit only:
// association is not causation, and this module never asserts that any
// touchpoint caused a business outcome. It never mutates upstream authority
// (R4/R5/R6/R7-A tables are read-only for this stream).

import { z } from "zod";

export const ATTRIBUTION_CONTRACT_VERSION = "attribution/v1" as const;
export const ATTRIBUTION_LEARNING_CONTRACT_VERSION = "attribution-to-learning/v1" as const;

// ─── R7-B controlled vocabularies (closed) ───

export const ATTRIBUTION_MODEL_TYPES = [
  "FIRST_TOUCH",
  "LAST_TOUCH",
  "LINEAR",
  "POSITION_BASED",
  "TIME_DECAY",
] as const;

export const ATTRIBUTION_EVIDENCE_CLASSES = [
  "DIRECT_LINKAGE",
  "STRONG_ASSOCIATION",
  "WEAK_ASSOCIATION",
  "INSUFFICIENT_EVIDENCE",
] as const;

export const ATTRIBUTION_CONFIDENCE_CLASSES = ["HIGH", "MEDIUM", "LOW", "NONE"] as const;

export const ATTRIBUTION_TOUCHPOINT_TYPES = [
  "CAMPAIGN",
  "PUBLICATION",
  "ENGAGEMENT",
  "OPPORTUNITY",
  "NURTURE_TOUCH",
  "SALES_HANDOFF",
] as const;

export const ATTRIBUTION_EXCLUSION_REASONS = [
  "TOUCHPOINT_AFTER_OUTCOME",
  "TOUCHPOINT_OUTSIDE_WINDOW",
  "TOUCHPOINT_FUTURE_DATED",
  "TOUCHPOINT_TIMESTAMP_INVALID",
  "TOUCHPOINT_LEAD_MISMATCH",
  "TOUCHPOINT_BUSINESS_MISMATCH",
  "TOUCHPOINT_DUPLICATE",
  "TOUCHPOINT_UNRESOLVED_LINEAGE",
  "TOUCHPOINT_UNSUPPORTED_TYPE",
] as const;

export const ATTRIBUTION_LIFECYCLE_TYPES = ["supersession"] as const;

/** R7-A outcome statuses that must never carry active positive attribution. */
export const ATTRIBUTION_TERMINAL_OUTCOME_STATUSES = ["REVERSED", "CANCELLED", "SUPERSEDED"] as const;

/** R7-A outcome statuses attributable only under provisional policy. */
export const ATTRIBUTION_PROVISIONAL_OUTCOME_STATUSES = ["PROVISIONAL", "OBSERVED"] as const;

/** R6-F privacy states that hard-stop any optimisation touching a lead. */
export const ATTRIBUTION_PRIVACY_STOP_STATES = [
  "SUPPRESSED",
  "RESTRICTED",
  "RETENTION_EXPIRED",
] as const;

/** Total credit unit: integer basis points, exactly 100000 = 100.000%. */
export const TOTAL_CREDIT_BPS = 100000 as const;

/** Deterministic model-version constants (closed model identities). */
export const ATTRIBUTION_MODEL_VERSIONS: Record<AttributionModelType, string> = {
  FIRST_TOUCH: "attribution-first-touch/v1",
  LAST_TOUCH: "attribution-last-touch/v1",
  LINEAR: "attribution-linear/v1",
  POSITION_BASED: "attribution-position-based/v1",
  TIME_DECAY: "attribution-time-decay/v1",
};

// ─── zod enums over the closed vocabularies ───

export const AttributionModelTypeEnum = z.enum(ATTRIBUTION_MODEL_TYPES);
export const AttributionEvidenceClassEnum = z.enum(ATTRIBUTION_EVIDENCE_CLASSES);
export const AttributionConfidenceClassEnum = z.enum(ATTRIBUTION_CONFIDENCE_CLASSES);
export const AttributionTouchpointTypeEnum = z.enum(ATTRIBUTION_TOUCHPOINT_TYPES);
export const AttributionExclusionReasonEnum = z.enum(ATTRIBUTION_EXCLUSION_REASONS);

export type AttributionModelType = z.infer<typeof AttributionModelTypeEnum>;
export type AttributionEvidenceClass = z.infer<typeof AttributionEvidenceClassEnum>;
export type AttributionConfidenceClass = z.infer<typeof AttributionConfidenceClassEnum>;
export type AttributionTouchpointType = z.infer<typeof AttributionTouchpointTypeEnum>;
export type AttributionExclusionReason = z.infer<typeof AttributionExclusionReasonEnum>;

export const ATTRIBUTION_MODEL_TYPE_SET: ReadonlySet<string> = new Set(ATTRIBUTION_MODEL_TYPES);
export const ATTRIBUTION_TERMINAL_OUTCOME_STATUS_SET: ReadonlySet<string> = new Set(
  ATTRIBUTION_TERMINAL_OUTCOME_STATUSES
);
export const ATTRIBUTION_PROVISIONAL_OUTCOME_STATUS_SET: ReadonlySet<string> = new Set(
  ATTRIBUTION_PROVISIONAL_OUTCOME_STATUSES
);
export const ATTRIBUTION_PRIVACY_STOP_STATE_SET: ReadonlySet<string> = new Set(
  ATTRIBUTION_PRIVACY_STOP_STATES
);

// ─── Typed error taxonomy (stable codes, fail-closed) ───

export class AttributionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AttributionError";
    this.code = code;
  }
}

/** Evaluate input failed safety/bounding/authority validation. */
export class AttributionInputError extends AttributionError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "AttributionInputError";
  }
}

/** Tenant/business/outcome ownership could not be proven server-side. */
export class AttributionOwnershipError extends AttributionError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "AttributionOwnershipError";
  }
}

/** Guarded state rejected (terminal outcome, privacy stop, ...). */
export class AttributionStateError extends AttributionError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "AttributionStateError";
  }
}

/** Durable identity reused with conflicting material. */
export class AttributionIdentityConflictError extends AttributionError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "AttributionIdentityConflictError";
  }
}

/** Record hash drift — retained material no longer matches its hash. */
export class AttributionTamperError extends AttributionError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "AttributionTamperError";
  }
}

export type AttributionDuplicateClassification = "none" | "idempotent_replay";

// ─── Canonical local helpers (exported for module reuse) ───

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

const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-./]{0,190}$/;
const OUTCOME_ID_PATTERN = /^out1:[a-f0-9]{64}$/;

// ─── Evaluate input (strict boundary; clients never supply authority fields) ───

export const attributionEvaluateInputSchema = z.strictObject({
  outcomeId: z.string().min(1).max(69).regex(OUTCOME_ID_PATTERN, "outcomeId must be an out1: id"),
  modelType: AttributionModelTypeEnum,
});

export type AttributionEvaluateInput = z.infer<typeof attributionEvaluateInputSchema>;

/** Server-side authority fields a client must never supply (fail closed). */
const CLIENT_AUTHORITY_FIELDS = [
  "attributionId",
  "attributionKey",
  "recordHash",
  "userId",
  "id",
  "createdAt",
  "businessId",
  "leadId",
  "leadIdentityVersion",
  "conversionId",
  "modelVersion",
  "windowStart",
  "windowEnd",
  "touchpoints",
  "excludedTouchpoints",
  "totalCreditBps",
  "confidenceClass",
  "evidenceClass",
  "policyVersion",
  "sourceVersions",
  "supersedesAttributionId",
  "calculatedAt",
  // causal/weight smuggling attempts are rejected as unknown keys by the
  // strict schema; these explicit guards make the probe loud either way.
  "causationProven",
  "causalScore",
  "weights",
  "credit",
  "creditBps",
] as const;

export function assertNoClientAuthorityFields(input: Record<string, unknown>): void {
  // Fail closed: any attempt to smuggle attribution authority is rejected,
  // never silently ignored — silent ignoring would hide a probe.
  for (const key of CLIENT_AUTHORITY_FIELDS) {
    if (key in input) {
      throw new AttributionInputError(
        "ATTRIBUTION_CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        `Field "${key}" is server-side authority and must never be client-supplied.`
      );
    }
  }
}

/**
 * Pure validation/normalization of one evaluate request. Runs the strict zod
 * boundary and rejects client-authority smuggling. Throws
 * AttributionInputError on any malformed input (fail closed).
 */
export function buildAttributionInput(raw: unknown): AttributionEvaluateInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AttributionInputError(
      "ATTRIBUTION_INPUT_INVALID",
      "Attribution evaluate input must be a structured object."
    );
  }
  assertNoClientAuthorityFields(raw as Record<string, unknown>);
  let parsed: AttributionEvaluateInput;
  try {
    parsed = attributionEvaluateInputSchema.parse(raw);
  } catch (err) {
    const first = (err as { issues?: { path: (string | number)[]; message: string }[] })?.issues?.[0];
    const where = first?.path?.join(".") ?? "input";
    throw new AttributionInputError(
      "ATTRIBUTION_INPUT_INVALID",
      `Attribution evaluate input failed validation at ${where}: ${first?.message ?? String(err)}`
    );
  }
  if (!SAFE_REFERENCE_PATTERN.test(parsed.outcomeId)) {
    // Defense in depth: the regex above already constrains shape.
    throw new AttributionInputError("ATTRIBUTION_INPUT_INVALID", "outcomeId has invalid shape.");
  }
  return parsed;
}

// ─── Canonical touchpoint + provenance types ───

export interface AttributionTouchpointProvenance {
  /** Closed lineage path label (how this touchpoint was legitimately reached). */
  readonly path: string;
  /** Referencing upstream ids only — never text, never PII. */
  readonly references: Readonly<Record<string, string | number | null>>;
  /** sha256 over the canonical source-row material used for this touchpoint. */
  readonly sourceRowHash: string;
}

export interface AttributionTouchpoint {
  readonly touchpointId: string;
  readonly type: AttributionTouchpointType;
  /** Upstream durable identity, verbatim. */
  readonly sourceIdentity: string;
  /** Null-or-equal business scope of the source row. */
  readonly businessId: number | null;
  /** ISO 8601 authoritative event time. */
  readonly occurredAt: string;
  readonly provenance: AttributionTouchpointProvenance;
  readonly eligibility: "eligible";
  /** Integer basis points allocated by the model (§8 of the contract). */
  readonly creditBps: number;
}

export interface AttributionExcludedTouchpoint {
  readonly touchpointId: string;
  readonly type: AttributionTouchpointType;
  readonly sourceIdentity: string;
  readonly businessId: number | null;
  readonly occurredAt: string | null;
  readonly provenance: AttributionTouchpointProvenance;
  readonly eligibility: "excluded";
  readonly reason: AttributionExclusionReason;
}

export interface AttributionSourceVersions {
  readonly outcomeProjectionVersion: string;
  readonly conversionProjectionVersion: string;
  readonly attributionContractVersion: string;
  readonly policyVersion: string;
}

/** Verbatim disclaimers carried on every projection and read surface. */
export const ATTRIBUTION_CAUSATION_DISCLAIMER =
  "Allocated credit is association evidence, not causal proof. This projection does not assert that any touchpoint caused the business outcome." as const;
