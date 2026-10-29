// ─── R7-C Business Learning Engine — canonical learning contract ───
//
// PURE contract module: closed vocabularies, canonical record types, zod
// schemas and the typed error taxonomy for the business-learning authority
// (WBS-R7-C). It performs no I/O of any kind, has no clock and authorizes
// nothing. Learning is evidence, not authority: this module never asserts
// that any subject caused a business outcome, never invents support, and
// never mutates upstream (R4/R5/R6/R7-A/R7-B) or downstream (R7-D/R7-E)
// authority.

import { z } from "zod";

export const BUSINESS_LEARNING_CONTRACT_VERSION = "business-learning/v1" as const;
export const BUSINESS_LEARNING_TO_EXPERIMENT_CONTRACT_VERSION =
  "business-learning-to-experiment-optimisation/v1" as const;
export const LEARNING_STATEMENT_TEMPLATE_VERSION = "learning-statement/v1" as const;

/** Deterministic derivation engine version bound into every identity. */
export const LEARNING_DERIVATION_VERSION = "business-learning-derivation/v1" as const;

// ─── R7-C controlled vocabularies (closed) ───

export const LEARNING_TYPES = [
  "PERFORMANCE_PATTERN",
  "AUDIENCE_PATTERN",
  "CHANNEL_PATTERN",
  "CREATIVE_PATTERN",
  "JOURNEY_PATTERN",
  "TIMING_PATTERN",
  "VALUE_PATTERN",
  "NEGATIVE_PATTERN",
  "INSUFFICIENT_EVIDENCE",
] as const;

export const LEARNING_SUBJECT_TYPES = [
  "CAMPAIGN",
  "PUBLICATION",
  "ENGAGEMENT",
  "OPPORTUNITY",
  "NURTURE_TOUCH",
  "SALES_HANDOFF",
  "OUTCOME",
  "INSUFFICIENT",
] as const;

export const LEARNING_CONFIDENCE_CLASSES = [
  "INSUFFICIENT_EVIDENCE",
  "WEAK",
  "MODERATE",
  "STRONG",
] as const;

export const LEARNING_EVIDENCE_CLASSES = [
  "VERIFIED",
  "PROVISIONAL",
  "MIXED",
  "INSUFFICIENT",
] as const;

export const LEARNING_NOVELTY_CLASSES = [
  "NEW",
  "REINFORCING",
  "CONTRADICTING",
  "DUPLICATE",
  "SUPERSEDING",
] as const;

export const LEARNING_STATUSES = [
  "CANDIDATE",
  "SUPPORTED",
  "CONTRADICTED",
  "SUPERSEDED",
  "DEPRECATED",
  "INVALIDATED",
] as const;

export const LEARNING_LIFECYCLE_TYPES = [
  "derivation",
  "contradiction",
  "supersession",
  "invalidation",
  "deprecation",
  "reevaluation",
] as const;

export const LEARNING_DIRECTIONS = ["positive", "negative", "neutral"] as const;

/** R7-A outcome statuses that destroy positive support when current. */
export const LEARNING_TERMINAL_OUTCOME_STATUSES = [
  "REVERSED",
  "CANCELLED",
  "SUPERSEDED",
] as const;

/** R7-A outcome statuses that cap derived authority as provisional. */
export const LEARNING_PROVISIONAL_OUTCOME_STATUSES = ["PROVISIONAL", "OBSERVED"] as const;

/** R7-B attribution confidence ranks (floor derivation). */
export const LEARNING_ATTRIBUTION_CONFIDENCE_RANKS: Record<string, number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  NONE: 0,
};

/** Consumed upstream source contract versions (closed). */
export const LEARNING_SOURCE_VERSION_KEYS = [
  "conversion-outcome/v1",
  "attribution-to-learning/v1",
  "attribution/v1",
  "conversion-outcome-to-attribution-learning/v1",
  "business-learning/v1",
] as const;

/**
 * Closed protected/sensitive trait dimensions. Never optimisation-learning
 * dimensions: any context key in this list, from any source, fails closed.
 */
export const LEARNING_PROTECTED_TRAIT_DIMENSIONS = [
  "race",
  "ethnicity",
  "religion",
  "political",
  "political_opinion",
  "health",
  "health_status",
  "sexual_orientation",
  "biometric",
  "genetic",
  "age",
  "gender",
  "gender_identity",
  "disability",
  "citizenship",
  "immigration_status",
] as const;

/** Deterministic narrative-draft guard: causal/authority claims are rejected. */
export const LEARNING_NARRATIVE_BANNED_PATTERNS = [
  /\bcaus(e[sd]?|ing|ation)\b/i,
  /\bproven?\b/i,
  /\bproves\b/i,
  /\bguarantee[sd]?\b/i,
  /\bwill (increase|double|triple|grow)\b/i,
  /\bincremental(ity)?\b/i,
  /\bcertain\b/i,
  /\bauthoritative\b/i,
  /\bverified learning\b/i,
  /\bignore (previous|all|the above)\b/i,
  /\bsystem prompt\b/i,
] as const;

// ─── zod enums over the closed vocabularies ───

export const LearningTypeEnum = z.enum(LEARNING_TYPES);
export const LearningSubjectTypeEnum = z.enum(LEARNING_SUBJECT_TYPES);
export const LearningConfidenceClassEnum = z.enum(LEARNING_CONFIDENCE_CLASSES);
export const LearningEvidenceClassEnum = z.enum(LEARNING_EVIDENCE_CLASSES);
export const LearningNoveltyClassEnum = z.enum(LEARNING_NOVELTY_CLASSES);
export const LearningStatusEnum = z.enum(LEARNING_STATUSES);
export const LearningLifecycleTypeEnum = z.enum(LEARNING_LIFECYCLE_TYPES);
export const LearningDirectionEnum = z.enum(LEARNING_DIRECTIONS);

export type LearningType = z.infer<typeof LearningTypeEnum>;
export type LearningSubjectType = z.infer<typeof LearningSubjectTypeEnum>;
export type LearningConfidenceClass = z.infer<typeof LearningConfidenceClassEnum>;
export type LearningEvidenceClass = z.infer<typeof LearningEvidenceClassEnum>;
export type LearningNoveltyClass = z.infer<typeof LearningNoveltyClassEnum>;
export type LearningStatus = z.infer<typeof LearningStatusEnum>;
export type LearningLifecycleType = z.infer<typeof LearningLifecycleTypeEnum>;
export type LearningDirection = z.infer<typeof LearningDirectionEnum>;

export const LEARNING_TYPE_SET: ReadonlySet<string> = new Set(LEARNING_TYPES);
export const LEARNING_SUBJECT_TYPE_SET: ReadonlySet<string> = new Set(LEARNING_SUBJECT_TYPES);
export const LEARNING_TERMINAL_OUTCOME_STATUS_SET: ReadonlySet<string> = new Set(
  LEARNING_TERMINAL_OUTCOME_STATUSES
);
export const LEARNING_PROVISIONAL_OUTCOME_STATUS_SET: ReadonlySet<string> = new Set(
  LEARNING_PROVISIONAL_OUTCOME_STATUSES
);
export const LEARNING_PROTECTED_TRAIT_SET: ReadonlySet<string> = new Set(
  LEARNING_PROTECTED_TRAIT_DIMENSIONS
);

export type LearningDuplicateClassification = "none" | "idempotent_replay";

// ─── Typed error taxonomy (stable codes, fail-closed) ───

export class LearningError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LearningError";
    this.code = code;
  }
}

/** Derivation input failed safety/bounding/authority validation. */
export class LearningInputError extends LearningError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "LearningInputError";
  }
}

/** Tenant/business/outcome/attribution ownership could not be proven. */
export class LearningOwnershipError extends LearningError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "LearningOwnershipError";
  }
}

/** Guarded state rejected (stale attribution, terminal outcome, ...). */
export class LearningStateError extends LearningError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "LearningStateError";
  }
}

/** Durable identity reused with conflicting material. */
export class LearningIdentityConflictError extends LearningError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "LearningIdentityConflictError";
  }
}

/** Record/bundle hash drift — retained material no longer matches its hash. */
export class LearningTamperError extends LearningError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "LearningTamperError";
  }
}

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
export const LEARNING_ID_PATTERN = /^lrn1:[a-f0-9]{64}$/;
export const EVIDENCE_BUNDLE_ID_PATTERN = /^evb1:[a-f0-9]{64}$/;
export const OUTCOME_ID_PATTERN = /^out1:[a-f0-9]{64}$/;
export const ATTRIBUTION_ID_PATTERN = /^atr1:[a-f0-9]{64}$/;
const SAFE_SUBJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-./]{0,190}$/;

// ─── Derive input (strict boundary; clients never supply authority fields) ───

export const businessLearningDeriveInputSchema = z.strictObject({
  outcomeIds: z
    .array(z.string().regex(OUTCOME_ID_PATTERN, "outcomeId must be an out1: id"))
    .min(1)
    .max(200),
  attributionIds: z
    .array(z.string().regex(ATTRIBUTION_ID_PATTERN, "attributionId must be an atr1: id"))
    .min(1)
    .max(200),
  narrativeDraft: z.string().min(1).max(4096).optional(),
});

export type BusinessLearningDeriveInput = z.infer<typeof businessLearningDeriveInputSchema>;

/** Server-side authority fields a client must never supply (fail closed). */
const CLIENT_AUTHORITY_FIELDS = [
  "learningId",
  "learningKey",
  "evidenceBundleId",
  "recordHash",
  "learningType",
  "subjectType",
  "subjectId",
  "contextScope",
  "confidenceClass",
  "evidenceClass",
  "noveltyClass",
  "status",
  "supportCount",
  "contradictionCount",
  "direction",
  "outcomeTypeFamily",
  "validUntil",
  "supersedesLearningId",
] as const;

export const LEARNING_CLIENT_AUTHORITY_FIELD_SET: ReadonlySet<string> = new Set(
  CLIENT_AUTHORITY_FIELDS
);

/** Rejects any client payload carrying a server-authority field. */
export function assertNoClientAuthorityFields(input: Record<string, unknown>): void {
  for (const field of Object.keys(input)) {
    if (LEARNING_CLIENT_AUTHORITY_FIELD_SET.has(field)) {
      throw new LearningInputError(
        "LEARNING_CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        `Client-supplied authority field "${field}" is rejected; learning authority is server-derived only.`
      );
    }
  }
}

/** Bounded narrative draft guard: causal/authority claims fail closed. */
export function guardNarrativeDraft(draft: string): void {
  for (const pattern of LEARNING_NARRATIVE_BANNED_PATTERNS) {
    if (pattern.test(draft)) {
      throw new LearningInputError(
        "LEARNING_NARRATIVE_AUTHORITY_CLAIM",
        "Narrative draft contains a causal or authority claim; drafts may never assert causation, certainty or verified status."
      );
    }
  }
}

/** Bounded subject ids only (verbatim upstream identities are safe references). */
export function assertSafeSubjectId(subjectId: string): void {
  if (!SAFE_SUBJECT_ID_PATTERN.test(subjectId)) {
    throw new LearningInputError(
      "LEARNING_SUBJECT_ID_INVALID",
      "Derived subject id is not a bounded safe reference."
    );
  }
}

// ─── Synchronize input (strict; exactly one authority reference) ───

export const businessLearningSynchronizeInputSchema = z
  .strictObject({
    outcomeId: z.string().regex(OUTCOME_ID_PATTERN, "outcomeId must be an out1: id").optional(),
    attributionId: z
      .string()
      .regex(ATTRIBUTION_ID_PATTERN, "attributionId must be an atr1: id")
      .optional(),
  })
  .refine((value) => (value.outcomeId ? 1 : 0) + (value.attributionId ? 1 : 0) === 1, {
    message: "Exactly one of outcomeId or attributionId is required.",
  });

export type BusinessLearningSynchronizeInput = z.infer<
  typeof businessLearningSynchronizeInputSchema
>;
