// ─── R7-D Experimentation Engine — canonical experimentation contract ───
//
// PURE contract module: closed vocabularies, canonical record types, zod
// schemas and the typed error taxonomy for the experimentation authority
// (WBS-R7-D). It performs no I/O of any kind, has no clock and authorizes
// nothing. Learning suggests what to test; experimentation produces scoped
// causal evidence only within explicit design limits under R7-F governance.
// This module never asserts causation beyond the governed experiment design,
// never mints a result from model opinion, and never mutates upstream
// (R6/R7-A/R7-B/R7-C/R7-F) or downstream (R7-C learning / R7-E budget)
// authority.
//
// Upstream frozen projections are consumed by branch reference only:
//   R7-C  feature/r7-c-business-learning @ 53b2ff4
//         business-learning-to-experiment-optimisation/v1 (23-key allowlist)
//   R7-A  feature/r7-a-conversion-outcome-intelligence @ 3e8aea8
//         conversion-outcome/v1 (27-key allowlist)
//   R7-B  feature/r7-b-attribution-intelligence @ 6ff9eca
//         attribution-to-learning/v1 (25-key allowlist)
//   R7-F  feature/r7-f-optimisation-governance @ 5e4ab95
//         optimisation-governance/v1 (decision + approval binding)

import { z } from "zod";

export const EXPERIMENTATION_CONTRACT_VERSION = "experimentation/v1" as const;
export const EXPERIMENT_RESULT_PROJECTION_VERSION =
  "experiment-result-to-learning-optimisation/v1" as const;
export const EXPERIMENT_RESULT_CALCULATION_VERSION = "experiment-result/v1" as const;
export const EXPERIMENT_CONCLUSION_TEMPLATE_VERSION = "experiment-conclusion/v1" as const;

// ─── R7-D controlled vocabularies (closed) ───

export const EXPERIMENT_DESIGN_TYPES = ["A_B", "MULTI_ARM"] as const;
export const EXPERIMENT_STATUSES = [
  "DRAFT",
  "GOVERNANCE_REQUIRED",
  "APPROVAL_REQUIRED",
  "READY",
  "ACTIVE",
  "PAUSED",
  "STOPPED",
  "COMPLETED",
  "INVALIDATED",
  "CANCELLED",
] as const;
export const EXPERIMENT_ARMS = ["CONTROL", "TREATMENT"] as const;

/** Mirrors R7-F EXPERIMENT_DIMENSIONS (optimisation-action-taxonomy). */
export const EXPERIMENT_DIMENSIONS = [
  "channel",
  "audience",
  "creative",
  "budget",
  "schedule",
  "placement",
  "bidding",
  "pricing",
  "messaging",
] as const;

/** Mirrors R7-F PROTECTED_TRAITS. Never design dimensions; default reject. */
export const EXPERIMENT_PROTECTED_TRAIT_DIMENSIONS = [
  "race",
  "ethnicity",
  "national_origin",
  "religion",
  "political_belief",
  "health_condition",
  "sexual_orientation",
  "gender_identity",
  "disability",
  "financial_hardship",
] as const;

/** Closed experiment metric vocabulary. */
export const EXPERIMENT_METRICS = [
  "CONVERSION_COUNT_PER_SUBJECT",
  "OUTCOME_COUNT_PER_SUBJECT",
  "REVENUE_MINOR_PER_SUBJECT",
  "POSITIVE_OUTCOME_RATE",
] as const;

export const EXPERIMENT_METRIC_DIRECTIONS = ["HIGHER_IS_BETTER", "LOWER_IS_BETTER"] as const;

export const GUARDRAIL_TYPES = [
  "MINIMUM_SAMPLE_PER_ARM",
  "BUDGET_CAP_MINOR",
  "MAX_OBSERVATION_DURATION",
  "STOP_ON_OUTCOME_REVERSAL",
] as const;

export const RESULT_VERDICTS = [
  "INSUFFICIENT_EVIDENCE",
  "DIRECTIONAL_SIGNAL",
  "SUPPORTED_DIFFERENCE",
  "NO_MEANINGFUL_DIFFERENCE",
  "INVALID_EXPERIMENT",
] as const;

export const RESULT_CONFIDENCE_CLASSES = [
  "INSUFFICIENT_EVIDENCE",
  "WEAK",
  "MODERATE",
  "STRONG",
] as const;

export const EXPERIMENT_LIFECYCLE_TYPES = [
  "creation",
  "governance",
  "approval",
  "activation",
  "pause",
  "resume",
  "stop",
  "completion",
  "invalidation",
  "cancellation",
] as const;

/** R7-A outcome statuses terminal for positive-success purposes. */
export const EXPERIMENT_TERMINAL_OUTCOME_STATUSES = ["REVERSED", "CANCELLED", "SUPERSEDED"] as const;
/** R7-A reversal outcome types — never positive success. */
export const EXPERIMENT_REVERSAL_OUTCOME_TYPES = ["REFUND", "REVERSAL", "CANCELLATION"] as const;

export const EXPERIMENT_SOURCE_VERSION_KEYS = [
  "business-learning-to-experiment-optimisation/v1",
  "conversion-outcome/v1",
  "attribution-to-learning/v1",
  "optimisation-governance/v1",
  "experimentation/v1",
  "experiment-result/v1",
] as const;

// ─── zod enums ───

export const ExperimentDesignTypeEnum = z.enum(EXPERIMENT_DESIGN_TYPES);
export const ExperimentStatusEnum = z.enum(EXPERIMENT_STATUSES);
export const ExperimentArmEnum = z.enum(EXPERIMENT_ARMS);
export const ExperimentDimensionEnum = z.enum(EXPERIMENT_DIMENSIONS);
export const ExperimentMetricEnum = z.enum(EXPERIMENT_METRICS);
export const ExperimentMetricDirectionEnum = z.enum(EXPERIMENT_METRIC_DIRECTIONS);
export const GuardrailTypeEnum = z.enum(GUARDRAIL_TYPES);
export const ResultVerdictEnum = z.enum(RESULT_VERDICTS);
export const ResultConfidenceClassEnum = z.enum(RESULT_CONFIDENCE_CLASSES);
export const ExperimentLifecycleTypeEnum = z.enum(EXPERIMENT_LIFECYCLE_TYPES);

export type ExperimentDesignType = z.infer<typeof ExperimentDesignTypeEnum>;
export type ExperimentStatus = z.infer<typeof ExperimentStatusEnum>;
export type ExperimentArm = z.infer<typeof ExperimentArmEnum>;
export type ExperimentDimension = z.infer<typeof ExperimentDimensionEnum>;
export type ExperimentMetric = z.infer<typeof ExperimentMetricEnum>;
export type ExperimentMetricSpec = z.infer<typeof metricSchema>;
export type GuardrailType = z.infer<typeof GuardrailTypeEnum>;
export type ResultVerdict = z.infer<typeof ResultVerdictEnum>;
export type ResultConfidenceClass = z.infer<typeof ResultConfidenceClassEnum>;
export type ExperimentLifecycleType = z.infer<typeof ExperimentLifecycleTypeEnum>;

export const EXPERIMENT_DESIGN_TYPE_SET: ReadonlySet<string> = new Set(EXPERIMENT_DESIGN_TYPES);
export const EXPERIMENT_STATUS_SET: ReadonlySet<string> = new Set(EXPERIMENT_STATUSES);
export const EXPERIMENT_DIMENSION_SET: ReadonlySet<string> = new Set(EXPERIMENT_DIMENSIONS);
export const EXPERIMENT_PROTECTED_TRAIT_SET: ReadonlySet<string> = new Set(
  EXPERIMENT_PROTECTED_TRAIT_DIMENSIONS
);
export const EXPERIMENT_TERMINAL_OUTCOME_STATUS_SET: ReadonlySet<string> = new Set(
  EXPERIMENT_TERMINAL_OUTCOME_STATUSES
);
export const EXPERIMENT_REVERSAL_OUTCOME_TYPE_SET: ReadonlySet<string> = new Set(
  EXPERIMENT_REVERSAL_OUTCOME_TYPES
);
export const GUARDRAIL_TYPE_SET: ReadonlySet<string> = new Set(GUARDRAIL_TYPES);

export type ExperimentDuplicateClassification = "none" | "idempotent_replay";

// ─── Typed error taxonomy (stable codes, fail closed) ───

export class ExperimentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ExperimentError";
    this.code = code;
  }
}

/** Input failed safety/bounding/authority validation. */
export class ExperimentInputError extends ExperimentError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ExperimentInputError";
  }
}

/** Tenant/business/learning/outcome ownership could not be proven. */
export class ExperimentOwnershipError extends ExperimentError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ExperimentOwnershipError";
  }
}

/** Guarded state rejected (governance, lifecycle, evidence window, ...). */
export class ExperimentStateError extends ExperimentError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ExperimentStateError";
  }
}

/** Durable identity reused with conflicting material. */
export class ExperimentIdentityConflictError extends ExperimentError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ExperimentIdentityConflictError";
  }
}

/** Record hash drift — retained material no longer matches its hash. */
export class ExperimentTamperError extends ExperimentError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ExperimentTamperError";
  }
}

// ─── Canonical local helpers ───

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
export const EXPERIMENT_ID_PATTERN = /^exp1:[a-f0-9]{64}$/;
export const HYPOTHESIS_ID_PATTERN = /^hyp1:[a-f0-9]{64}$/;
export const LEARNING_ID_PATTERN = /^lrn1:[a-f0-9]{64}$/;
export const OUTCOME_ID_PATTERN = /^out1:[a-f0-9]{64}$/;
export const ATTRIBUTION_ID_PATTERN = /^atr1:[a-f0-9]{64}$/;
export const RESULT_ID_PATTERN = /^exr1:[a-f0-9]{64}$/;
export const GOVERNANCE_DECISION_ID_PATTERN = /^ogd1:[a-f0-9]{64}$/;

// ─── Design schema (strict boundary; clients propose designs, never authority) ───

const descriptorSchema = z
  .record(z.string(), z.unknown())
  .refine((d) => Object.keys(d).length > 0, { message: "descriptor must not be empty" });

const metricSchema = z.strictObject({
  metric: ExperimentMetricEnum,
  direction: ExperimentMetricDirectionEnum,
});

const guardrailSchema = z.strictObject({
  guardrail: GuardrailTypeEnum,
  params: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
});

export const experimentDesignSchema = z.strictObject({
  designType: ExperimentDesignTypeEnum,
  dimension: ExperimentDimensionEnum,
  controlDefinition: z.strictObject({
    label: z.string().min(1).max(191),
    descriptor: descriptorSchema,
  }),
  treatmentDefinitions: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(191),
        descriptor: descriptorSchema,
      })
    )
    .min(1)
    .max(4),
  allocationPolicy: z.strictObject({
    fractionsBps: z.array(z.number().int().positive()).min(2).max(5),
  }),
  primaryMetric: metricSchema,
  secondaryMetrics: z.array(metricSchema).max(4).default([]),
  guardrails: z.array(guardrailSchema).max(8).default([]),
  minimumSamplePerArm: z.number().int().min(1).max(1_000_000),
  durationDays: z.number().int().min(1).max(90),
});

export type ExperimentDesignInput = z.input<typeof experimentDesignSchema>;
export type ExperimentDesign = z.output<typeof experimentDesignSchema>;

export const experimentCreateInputSchema = z.strictObject({
  learningId: z.string().regex(LEARNING_ID_PATTERN, "learningId must be an lrn1: id"),
  statement: z.string().min(1).max(1024),
  design: experimentDesignSchema,
  narrativeDraft: z.string().min(1).max(4096).optional(),
});

export type ExperimentCreateInput = z.infer<typeof experimentCreateInputSchema>;

/** Server-side authority fields a client must never supply (fail closed).
 *  Note: `experimentId`/`learningId`/`outcomeId` are opaque client REFERENCES
 *  and are deliberately absent — clients reference ids; they may never supply
 *  derived identity material, status, arms, results, governance or approval
 *  content. */
const CLIENT_AUTHORITY_FIELDS = [
  "experimentKey",
  "hypothesisId",
  "hypothesisKey",
  "designHash",
  "recordHash",
  "businessId",
  "status",
  "arm",
  "armIndex",
  "assignment",
  "verdict",
  "confidenceClass",
  "resultId",
  "result",
  "subjects",
  "evidenceCount",
  "metricValue",
  "governanceDecision",
  "decision",
  "approval",
  "approved",
  "startAt",
  "endAt",
  "assignmentVersion",
] as const;

export const EXPERIMENT_CLIENT_AUTHORITY_FIELD_SET: ReadonlySet<string> = new Set(
  CLIENT_AUTHORITY_FIELDS
);

/** Rejects any client payload carrying a server-authority field. */
export function assertNoClientAuthorityFields(input: Record<string, unknown>): void {
  for (const field of Object.keys(input)) {
    if (EXPERIMENT_CLIENT_AUTHORITY_FIELD_SET.has(field)) {
      throw new ExperimentInputError(
        "EXPERIMENT_CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        `Client-supplied authority field "${field}" is rejected; experiment authority is server-derived only.`
      );
    }
  }
}

/** Hypothesis statement / narrative must never carry causal or authority claims. */
export const EXPERIMENT_NARRATIVE_BANNED_PATTERNS = [
  /\bcaus(e[sd]?|ing|ation)\b/i,
  /\bproven?\b/i,
  /\bproves\b/i,
  /\bguarantee[sd]?\b/i,
  /\bwill (increase|double|triple|grow)\b/i,
  /\bcertain\b/i,
  /\bauthoritative\b/i,
  /\bignore (previous|all|the above)\b/i,
  /\bsystem prompt\b/i,
  /\bgovernance (allows|approved)\b/i,
] as const;

/** Guards hypothesis statement text (causal claims are for results, bounded). */
export function guardHypothesisStatement(statement: string): void {
  for (const pattern of EXPERIMENT_NARRATIVE_BANNED_PATTERNS) {
    if (pattern.test(statement)) {
      throw new ExperimentInputError(
        "EXPERIMENT_NARRATIVE_AUTHORITY_CLAIM",
        "Hypothesis statement contains a causal/authority claim; statements must be testable propositions only."
      );
    }
  }
}

/** Guards an optional model-assisted narrative draft (non-authoritative only). */
export function guardNarrativeDraft(draft: string): void {
  for (const pattern of EXPERIMENT_NARRATIVE_BANNED_PATTERNS) {
    if (pattern.test(draft)) {
      throw new ExperimentInputError(
        "EXPERIMENT_NARRATIVE_AUTHORITY_CLAIM",
        "narrativeDraft contains a causal/authority claim and is rejected."
      );
    }
  }
}
