// ─── R7-A Conversion Outcome Intelligence — canonical outcome contract ───
//
// PURE contract module: closed vocabularies, canonical record types, zod
// schemas and the typed error taxonomy for the business-outcome authority
// (WBS-R7-A). It performs no I/O of any kind, has no clock and authorizes
// nothing. A business outcome is the authoritative interpretation of the
// business value produced by a governed R6-E conversion, bound to a tenant +
// business. Conversion evidence and business-value evidence are distinct;
// this module never asserts causation or attribution, never invents value,
// and never creates leads, conversions, or billing effects.

import { z } from "zod";
import {
  canonicalJson,
  sha256Hex,
  CURRENCY_CODES,
  type ConversionType,
} from "../conversion/conversion-contract";

export const OUTCOME_CONTRACT_VERSION = "conversion-outcome/v1" as const;
export const OUTCOME_PROJECTION_CONTRACT_VERSION = "conversion-outcome/v1" as const;

// ─── R7-A controlled vocabularies (closed) ───

export const OUTCOME_TYPES = [
  "PURCHASE",
  "SUBSCRIPTION",
  "CONTRACT",
  "BOOKING",
  "RENEWAL",
  "UPGRADE",
  "DOWNGRADE",
  "REFUND",
  "REVERSAL",
  "CANCELLATION",
  "NON_MONETARY_SUCCESS",
  "OTHER_VERIFIED_OUTCOME",
] as const;

/** Types that reverse/cancel a prior outcome and require reversesOutcomeId. */
export const OUTCOME_REVERSAL_TYPES = ["REFUND", "REVERSAL", "CANCELLATION"] as const;

export const OUTCOME_STATUSES = [
  "OBSERVED",
  "PROVISIONAL",
  "VERIFIED",
  "REVERSED",
  "CANCELLED",
  "SUPERSEDED",
] as const;

export const OUTCOME_VALUE_TYPES = ["MONETARY", "NON_MONETARY"] as const;

export const NON_MONETARY_METRIC_UNITS = [
  "UNIT",
  "SEAT",
  "CONTRACT",
  "BOOKING",
  "APPOINTMENT",
  "SIGNUP",
  "LICENSE",
  "OTHER",
] as const;

export const OUTCOME_EVIDENCE_SOURCES = [
  "payment_processor",
  "accounting_system",
  "contract_repository",
  "crm_record",
  "platform_report",
  "internal_system",
  "user_attestation",
  "unverified_external",
] as const;

export const OUTCOME_EVIDENCE_AUTHORITY_CLASSES = [
  "VERIFIED_PAYMENT",
  "VERIFIED_CONTRACT",
  "VERIFIED_CRM",
  "VERIFIED_PLATFORM",
  "VERIFIED_INTERNAL",
  "USER_ATTESTED",
  "UNVERIFIED_EXTERNAL",
] as const;

export const OUTCOME_LIFECYCLE_TYPES = [
  "verification",
  "reversal",
  "refund",
  "cancellation",
  "renewal",
  "supersession",
] as const;

// ─── zod enums over the closed vocabularies ───

export const OutcomeTypeEnum = z.enum(OUTCOME_TYPES);
export const OutcomeStatusEnum = z.enum(OUTCOME_STATUSES);
export const OutcomeValueTypeEnum = z.enum(OUTCOME_VALUE_TYPES);
export const NonMonetaryMetricUnitEnum = z.enum(NON_MONETARY_METRIC_UNITS);
export const OutcomeEvidenceSourceEnum = z.enum(OUTCOME_EVIDENCE_SOURCES);
export const OutcomeEvidenceAuthorityEnum = z.enum(OUTCOME_EVIDENCE_AUTHORITY_CLASSES);
export const OutcomeLifecycleTypeEnum = z.enum(OUTCOME_LIFECYCLE_TYPES);
export const OutcomeCurrencyEnum = z.enum(CURRENCY_CODES);

export type OutcomeType = z.infer<typeof OutcomeTypeEnum>;
export type OutcomeStatus = z.infer<typeof OutcomeStatusEnum>;
export type OutcomeValueType = z.infer<typeof OutcomeValueTypeEnum>;
export type NonMonetaryMetricUnit = z.infer<typeof NonMonetaryMetricUnitEnum>;
export type OutcomeEvidenceSource = z.infer<typeof OutcomeEvidenceSourceEnum>;
export type OutcomeEvidenceAuthority = z.infer<typeof OutcomeEvidenceAuthorityEnum>;
export type OutcomeLifecycleType = z.infer<typeof OutcomeLifecycleTypeEnum>;

export const OUTCOME_REVERSAL_TYPE_SET: ReadonlySet<string> = new Set(OUTCOME_REVERSAL_TYPES);

/** Outcome types that may carry a positive monetary amount. */
export const OUTCOME_POSITIVE_TYPE_SET: ReadonlySet<string> = new Set(
  OUTCOME_TYPES.filter((t) => !OUTCOME_REVERSAL_TYPE_SET.has(t))
);

// ─── Typed error taxonomy (stable codes, fail-closed) ───

export class OutcomeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OutcomeError";
    this.code = code;
  }
}

/** Record input failed safety/bounding/authority validation. */
export class OutcomeInputError extends OutcomeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "OutcomeInputError";
  }
}

/** A record failed schema validation. */
export class OutcomeValidationError extends OutcomeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "OutcomeValidationError";
  }
}

/** Evidence hash drift — retained material no longer matches its hash. */
export class OutcomeTamperError extends OutcomeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "OutcomeTamperError";
  }
}

/** Tenant/business/ownership could not be proven server-side. */
export class OutcomeOwnershipError extends OutcomeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "OutcomeOwnershipError";
  }
}

/** Guarded state transition rejected (stale version or illegal transition). */
export class OutcomeStateConflictError extends OutcomeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "OutcomeStateConflictError";
  }
}

/** Durable identity reused with conflicting material. */
export class OutcomeIdentityConflictError extends OutcomeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "OutcomeIdentityConflictError";
  }
}

export type OutcomeDuplicateClassification = "none" | "idempotent_replay";

// ─── Boundary patterns ───

const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-./]{0,190}$/;
const OUTCOME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-./]{0,190}$/;

// ─── Record input (strict boundary; clients never supply authority fields) ───

export const outcomeRecordInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  conversionId: z.string().min(1).max(69).regex(OUTCOME_ID_PATTERN),
  evidenceSource: OutcomeEvidenceSourceEnum,
  evidenceIdentity: z
    .string()
    .min(1)
    .max(191)
    .regex(SAFE_REFERENCE_PATTERN),
  outcomeTypeProposal: OutcomeTypeEnum.optional(),
  valueType: OutcomeValueTypeEnum,
  amountMinor: z.number().int().optional(),
  currency: OutcomeCurrencyEnum.optional(),
  quantity: z.number().int().min(1).max(1_000_000_000).optional(),
  metricUnit: NonMonetaryMetricUnitEnum.optional(),
  occurredAt: z.string().max(32),
  recordedAt: z.string().max(32).optional(),
  reversesOutcomeId: z.string().min(1).max(69).regex(OUTCOME_ID_PATTERN).optional(),
  renewsOutcomeId: z.string().min(1).max(69).regex(OUTCOME_ID_PATTERN).optional(),
  supersedesOutcomeId: z.string().min(1).max(69).regex(OUTCOME_ID_PATTERN).optional(),
});

export type OutcomeRecordInput = z.infer<typeof outcomeRecordInputSchema>;

export const outcomeVerifyInputSchema = z.strictObject({
  outcomeId: z.string().min(1).max(69).regex(OUTCOME_ID_PATTERN),
  evidenceSource: OutcomeEvidenceSourceEnum,
  evidenceIdentity: z
    .string()
    .min(1)
    .max(191)
    .regex(SAFE_REFERENCE_PATTERN),
  occurredAt: z.string().max(32).optional(),
  recordedAt: z.string().max(32).optional(),
  externalLifecycleId: z.string().min(1).max(191).regex(SAFE_REFERENCE_PATTERN).optional(),
});

export type OutcomeVerifyInput = z.infer<typeof outcomeVerifyInputSchema>;

/** Server-side authority fields a client must never supply (fail closed). */
const CLIENT_AUTHORITY_FIELDS = [
  "outcomeId",
  "outcomeKey",
  "evidenceHash",
  "outcomeStatus",
  "verificationState",
  "evidenceAuthority",
  "userId",
  "id",
  "createdAt",
  "verified",
  "verifiedAmount",
  "verifiedCurrency",
  "reportedAmount",
  "reportedCurrency",
  "netAmount",
  "netValue",
  "outcomeLifecycleEventId",
] as const;

export function assertNoOutcomeClientAuthorityFields(input: Record<string, unknown>): void {
  // Fail closed: any attempt to smuggle outcome/verification/identity authority
  // is rejected, never silently ignored — silent ignoring would hide a probe.
  for (const key of CLIENT_AUTHORITY_FIELDS) {
    if (key in input) {
      throw new OutcomeInputError(
        "OUTCOME_CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        `Field "${key}" is server-side authority and must never be client-supplied.`
      );
    }
  }
}

const ISO_8601_PARSEABLE = (value: string) => !Number.isNaN(Date.parse(value));

function assertTimestamp(value: string, field: string, now: string): string {
  if (!ISO_8601_PARSEABLE(value)) {
    throw new OutcomeInputError(
      "OUTCOME_TIMESTAMP_INVALID",
      `${field} must be a parseable ISO 8601 timestamp; got ${JSON.stringify(value)}.`
    );
  }
  const year = Number(value.slice(0, 4));
  if (!Number.isInteger(year) || year < 2000) {
    throw new OutcomeInputError(
      "OUTCOME_TIMESTAMP_INVALID",
      `${field} year must be >= 2000; got ${JSON.stringify(value)}.`
    );
  }
  const nowMs = Date.parse(now);
  const valueMs = Date.parse(value);
  if (nowMs - valueMs < -5 * 60 * 1000) {
    throw new OutcomeInputError(
      "OUTCOME_TIMESTAMP_INVALID",
      `${field} must not be more than 5 minutes in the future; got ${JSON.stringify(value)}.`
    );
  }
  return value;
}

/**
 * Pure validation/normalization of one record request. Runs the strict zod
 * boundary, rejects client-authority smuggling, applies the now-dependent
 * occurredAt/recordedAt semantic checks, and enforces the value-shape rules
 * (exactly one of the monetary / non-monetary shapes per valueType). Polarity
 * and cross-field monetary checks that require the classified outcome type or
 * the referenced rows run later in the service. Throws OutcomeInputError on
 * any malformed input (fail closed). `now` is an explicit ISO 8601 string —
 * this module has no clock.
 */
export function buildOutcomeRecordInput(raw: unknown, now: string): OutcomeRecordInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OutcomeInputError("OUTCOME_INPUT_INVALID", "Outcome record input must be a structured object.");
  }
  assertNoOutcomeClientAuthorityFields(raw as Record<string, unknown>);
  let parsed: OutcomeRecordInput;
  try {
    parsed = outcomeRecordInputSchema.parse(raw);
  } catch (err) {
    const first = (err as { issues?: { path: (string | number)[]; message: string }[] })?.issues?.[0];
    const where = first?.path?.join(".") ?? "input";
    throw new OutcomeInputError(
      "OUTCOME_INPUT_INVALID",
      `Outcome record input failed validation at ${where}: ${first?.message ?? String(err)}`
    );
  }
  assertTimestamp(parsed.occurredAt, "occurredAt", now);
  if (parsed.recordedAt !== undefined) {
    assertTimestamp(parsed.recordedAt, "recordedAt", now);
  }
  const lineageRefs = [parsed.reversesOutcomeId, parsed.renewsOutcomeId, parsed.supersedesOutcomeId].filter(
    (v) => v !== undefined
  );
  if (lineageRefs.length > 1) {
    throw new OutcomeInputError(
      "OUTCOME_LINEAGE_INVALID",
      "At most one of reversesOutcomeId, renewsOutcomeId, supersedesOutcomeId may be supplied."
    );
  }
  // Exactly one value shape per valueType.
  if (parsed.valueType === "MONETARY") {
    if (parsed.amountMinor === undefined || parsed.currency === undefined) {
      throw new OutcomeInputError(
        "OUTCOME_VALUE_INCOMPLETE",
        "valueType MONETARY requires amountMinor and currency together."
      );
    }
    if (parsed.quantity !== undefined || parsed.metricUnit !== undefined) {
      throw new OutcomeInputError(
        "OUTCOME_VALUE_INCOMPLETE",
        "valueType MONETARY must not carry quantity/metricUnit."
      );
    }
  } else {
    if (parsed.quantity === undefined || parsed.metricUnit === undefined) {
      throw new OutcomeInputError(
        "OUTCOME_VALUE_INCOMPLETE",
        "valueType NON_MONETARY requires quantity and metricUnit together."
      );
    }
    if (parsed.amountMinor !== undefined || parsed.currency !== undefined) {
      throw new OutcomeInputError(
        "OUTCOME_VALUE_INCOMPLETE",
        "valueType NON_MONETARY must not carry amountMinor/currency."
      );
    }
  }
  return parsed;
}

/**
 * Pure validation/normalization of one verification request. `now` is explicit
 * ISO 8601 (no clock here). Defaults occurredAt/recordedAt to `now`.
 */
export function buildOutcomeVerifyInput(raw: unknown, now: string): OutcomeVerifyInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OutcomeInputError("OUTCOME_INPUT_INVALID", "Outcome verify input must be a structured object.");
  }
  assertNoOutcomeClientAuthorityFields(raw as Record<string, unknown>);
  let parsed: OutcomeVerifyInput;
  try {
    parsed = outcomeVerifyInputSchema.parse(raw);
  } catch (err) {
    const first = (err as { issues?: { path: (string | number)[]; message: string }[] })?.issues?.[0];
    const where = first?.path?.join(".") ?? "input";
    throw new OutcomeInputError(
      "OUTCOME_INPUT_INVALID",
      `Outcome verify input failed validation at ${where}: ${first?.message ?? String(err)}`
    );
  }
  if (parsed.occurredAt !== undefined) {
    assertTimestamp(parsed.occurredAt, "occurredAt", now);
  }
  if (parsed.recordedAt !== undefined) {
    assertTimestamp(parsed.recordedAt, "recordedAt", now);
  }
  return parsed;
}

// Re-exports so downstream consumers have one import surface.
export { canonicalJson, sha256Hex };
export type { ConversionType };
