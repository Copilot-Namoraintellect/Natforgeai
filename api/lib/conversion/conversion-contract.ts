// ─── R6-E Conversion Tracking — canonical conversion contract ───
//
// PURE contract module: closed vocabularies, canonical record types, zod
// schemas and the typed error taxonomy for the conversion/outcome authority
// (WBS-R6-E). It performs no I/O of any kind, has no clock and authorizes
// nothing. A conversion is durable evidence of a business outcome bound to a
// tenant + business; provenance lineage (opportunity/engagement/signal/
// campaign/publication references) is recorded but this module NEVER asserts
// causation and NEVER creates leads, scores, or outreach.

import { z } from "zod";

export const CONVERSION_CONTRACT_VERSION = "conversion/v1" as const;
export const CONVERSION_PROJECTION_CONTRACT_VERSION = "conversion-to-attribution/v1" as const;

// ─── R6-E controlled vocabularies (closed) ───

export const CONVERSION_TYPES = [
  "purchase",
  "subscription",
  "booking",
  "consultation",
  "demo_completed",
  "contract_signed",
  "application_submitted",
  "renewal",
  "retained_customer",
  "qualified_offline_outcome",
  "refund",
  "cancellation",
  "reversal",
  "unknown",
] as const;

/** Types that may carry negative amounts and require reversesConversionId. */
export const REVERSAL_TYPES = ["refund", "cancellation", "reversal"] as const;

export const CONVERSION_SOURCE_SYSTEMS = [
  "internal",
  "stripe",
  "paypal",
  "shopify",
  "woocommerce",
  "salesforce",
  "hubspot",
  "calendly",
  "meta",
  "linkedin",
  "google_analytics",
  "user_report",
  "unverified_webhook",
] as const;

export const CONVERSION_TRUST_CLASSES = [
  "VERIFIED_INTERNAL",
  "VERIFIED_PROVIDER",
  "VERIFIED_CRM",
  "VERIFIED_PAYMENT",
  "USER_REPORTED",
  "UNVERIFIED_EXTERNAL",
] as const;

export const CONVERSION_OUTCOME_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "REVERSED",
  "REFUNDED",
  "CANCELLED",
  "DISPUTED",
  "UNKNOWN",
] as const;

export const CONVERSION_LIFECYCLE_TYPES = [
  "confirmation",
  "reversal",
  "refund",
  "cancellation",
  "dispute",
  "correction",
] as const;

export const CURRENCY_CODES = [
  "USD",
  "EUR",
  "GBP",
  "ZAR",
  "CAD",
  "AUD",
  "NZD",
  "JPY",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "INR",
  "BRL",
  "MXN",
  "SGD",
  "HKD",
  "AED",
  "PLN",
  "KES",
] as const;

// ─── zod enums over the closed vocabularies ───

export const ConversionTypeEnum = z.enum(CONVERSION_TYPES);
export const ConversionSourceSystemEnum = z.enum(CONVERSION_SOURCE_SYSTEMS);
export const ConversionTrustClassEnum = z.enum(CONVERSION_TRUST_CLASSES);
export const ConversionOutcomeStatusEnum = z.enum(CONVERSION_OUTCOME_STATUSES);
export const ConversionLifecycleTypeEnum = z.enum(CONVERSION_LIFECYCLE_TYPES);
export const CurrencyCodeEnum = z.enum(CURRENCY_CODES);

export type ConversionType = z.infer<typeof ConversionTypeEnum>;
export type ConversionSourceSystem = z.infer<typeof ConversionSourceSystemEnum>;
export type ConversionTrustClass = z.infer<typeof ConversionTrustClassEnum>;
export type ConversionOutcomeStatus = z.infer<typeof ConversionOutcomeStatusEnum>;
export type ConversionLifecycleType = z.infer<typeof ConversionLifecycleTypeEnum>;
export type CurrencyCode = z.infer<typeof CurrencyCodeEnum>;

export const REVERSAL_TYPE_SET: ReadonlySet<string> = new Set(REVERSAL_TYPES);

// ─── Typed error taxonomy (stable codes, fail-closed) ───

export class ConversionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConversionError";
    this.code = code;
  }
}

/** Ingest input failed safety/bounding/authority validation. */
export class ConversionInputError extends ConversionError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ConversionInputError";
  }
}

/** A record failed schema validation. */
export class ConversionValidationError extends ConversionError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ConversionValidationError";
  }
}

/** Evidence hash drift — retained material no longer matches its hash. */
export class ConversionTamperError extends ConversionError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ConversionTamperError";
  }
}

/** Tenant/business ownership could not be proven server-side. */
export class ConversionOwnershipError extends ConversionError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ConversionOwnershipError";
  }
}

/** Guarded state transition rejected (stale version). */
export class ConversionStateConflictError extends ConversionError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ConversionStateConflictError";
  }
}

/** Durable identity reused with conflicting material. */
export class ConversionIdentityConflictError extends ConversionError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ConversionIdentityConflictError";
  }
}

export type ConversionDuplicateClassification = "none" | "idempotent_replay";

// ─── Canonical local helpers (exported for module reuse) ───

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

import { createHash } from "crypto";

export const HEX_64 = /^[a-f0-9]{64}$/;

// ─── Field patterns ───

const EXTERNAL_CONVERSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-./]{0,190}$/;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-./]{0,190}$/;

// ─── Ingest input (strict boundary; clients never supply authority fields) ───

export const conversionIngestInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  sourceSystem: ConversionSourceSystemEnum,
  externalConversionId: z
    .string()
    .min(1)
    .max(191)
    .regex(EXTERNAL_CONVERSION_ID_PATTERN),
  conversionType: ConversionTypeEnum,
  occurredAt: z.string().max(32),
  observedAt: z.string().max(32).optional(),
  amount: z.number().int().optional(),
  currency: CurrencyCodeEnum.optional(),
  leadId: z.number().int().positive().optional(),
  leadIdentityVersion: z.string().max(64).regex(SAFE_REFERENCE_PATTERN).optional(),
  sourceOpportunityId: z.string().max(69).optional(),
  sourceEngagementReceiptId: z.string().max(64).optional(),
  sourceSignalId: z.string().max(64).optional(),
  sourceCampaignId: z.number().int().positive().optional(),
  sourcePublicationId: z.number().int().positive().optional(),
  evidenceReference: z.string().max(255).optional(),
  reversesConversionId: z.string().max(69).optional(),
});

export type ConversionIngestInput = z.infer<typeof conversionIngestInputSchema>;

/** Server-side authority fields a client must never supply (fail closed). */
const CLIENT_AUTHORITY_FIELDS = [
  "trustClass",
  "sourceTrustClass",
  "outcomeStatus",
  "conversionId",
  "conversionKey",
  "evidenceHash",
  "userId",
  "id",
  "createdAt",
  "verified",
  "verifiedAmount",
  "verifiedCurrency",
  "reportedAmount",
  "reportedCurrency",
] as const;

export function assertNoClientAuthorityFields(input: Record<string, unknown>): void {
  // Fail closed: any attempt to smuggle outcome/trust/identity authority is
  // rejected, never silently ignored — silent ignoring would hide a probe.
  for (const key of CLIENT_AUTHORITY_FIELDS) {
    if (key in input) {
      throw new ConversionInputError(
        "CONVERSION_CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        `Field "${key}" is server-side authority and must never be client-supplied.`
      );
    }
  }
}

const ISO_8601_PARSEABLE = (value: string) => !Number.isNaN(Date.parse(value));

function assertTimestamp(value: string, field: string, now: string): string {
  if (!ISO_8601_PARSEABLE(value)) {
    throw new ConversionInputError(
      "CONVERSION_TIMESTAMP_INVALID",
      `${field} must be a parseable ISO 8601 timestamp; got ${JSON.stringify(value)}.`
    );
  }
  const year = Number(value.slice(0, 4));
  if (!Number.isInteger(year) || year < 2000) {
    throw new ConversionInputError(
      "CONVERSION_TIMESTAMP_INVALID",
      `${field} year must be >= 2000; got ${JSON.stringify(value)}.`
    );
  }
  const nowMs = Date.parse(now);
  const valueMs = Date.parse(value);
  if (nowMs - valueMs < -5 * 60 * 1000) {
    throw new ConversionInputError(
      "CONVERSION_TIMESTAMP_INVALID",
      `${field} must not be more than 5 minutes in the future; got ${JSON.stringify(value)}.`
    );
  }
  return value;
}

/**
 * Pure validation/normalization of one ingest request. Runs the strict zod
 * boundary, rejects client-authority smuggling, and applies the now-dependent
 * occurredAt/observedAt semantic checks. Throws ConversionInputError on any
 * malformed input (fail closed). `now` is an explicit ISO 8601 string — this
 * module has no clock.
 */
export function buildConversionInput(raw: unknown, now: string): ConversionIngestInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConversionInputError("CONVERSION_INPUT_INVALID", "Conversion ingest input must be a structured object.");
  }
  assertNoClientAuthorityFields(raw as Record<string, unknown>);
  let parsed: ConversionIngestInput;
  try {
    parsed = conversionIngestInputSchema.parse(raw);
  } catch (err) {
    const first = (err as { issues?: { path: (string | number)[]; message: string }[] })?.issues?.[0];
    const where = first?.path?.join(".") ?? "input";
    throw new ConversionInputError(
      "CONVERSION_INPUT_INVALID",
      `Conversion ingest input failed validation at ${where}: ${first?.message ?? String(err)}`
    );
  }
  assertTimestamp(parsed.occurredAt, "occurredAt", now);
  if (parsed.observedAt !== undefined) {
    assertTimestamp(parsed.observedAt, "observedAt", now);
  }
  return parsed;
}
