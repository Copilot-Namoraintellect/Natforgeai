// ─── R6-B Lead Scoring — canonical scoring contract ───
//
// PURE contract module: closed vocabularies, version identities, server-owned
// scoring weights, typed error taxonomy and canonical hashing helpers for the
// lead-scoring authority (docs/contracts/lead-scoring-contract.md). It
// performs no I/O of any kind and authorizes nothing.
//
// A lead score is EVIDENCE, not a qualification decision: this stream never
// qualifies leads, never performs outreach, never writes CRM rows, and never
// initiates governed marketing actions. Weights and identities are
// server-owned; clients can never supply or influence them.
//
// Reuse boundary: opportunity closed vocabularies and canonical/hash helpers
// are imported from the R5-D pure contract module (consumed, not redefined).

import {
  OPPORTUNITY_TYPE_VALUES,
  type OpportunityType,
} from "../opportunity/opportunity-contract";

export const LEAD_SCORING_CONTRACT_VERSION = "lead-scoring/v1" as const;
export const SCORING_VERSION = "lead-scoring-engine/v1" as const;
export const FEATURE_VERSION = "lead-scoring-features/v1" as const;
export const IDENTITY_SEAM_VERSION = "lead-identity-seam/v1" as const;

export const SCORE_ID_PREFIX = "lsc1:" as const;
export const SNAPSHOT_ID_PREFIX = "lss1:" as const;

// ─── Closed vocabularies (scoring contract §3, §6, §7 — closed) ───

export const SCORE_BAND_VALUES = ["VERY_LOW", "LOW", "MEDIUM", "HIGH", "VERY_HIGH"] as const;
export type ScoreBand = (typeof SCORE_BAND_VALUES)[number];
export const SCORE_CONFIDENCE_VALUES = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] as const;

export const COMPONENT_KEYS = ["fit", "intent", "engagement", "recency", "opportunity"] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

export const SCORE_REASON_CODE_VALUES = [
  "STRONG_PURCHASE_INTENT",
  "REPEATED_INTENT_SIGNALS",
  "EXPLICIT_SERVICE_ENQUIRY",
  "PARTNERSHIP_INTEREST",
  "VALIDATED_ENGAGEMENT_RESPONSE",
  "RECENT_EVIDENCE",
  "HIGH_EVIDENCE_STRENGTH",
  "CAMPAIGN_ALIGNED",
  "NEUTRAL_CAMPAIGN_ALIGNMENT",
  "STALE_EVIDENCE",
  "LOW_EVIDENCE_STRENGTH",
  "CONTRADICTING_EVIDENCE",
  "SINGLE_EVIDENCE_SOURCE",
  "MISSING_ENGAGEMENT_EVIDENCE",
  "MISSING_RECENCY_EVIDENCE",
  "INSUFFICIENT_EVIDENCE",
  "PRAISE_ONLY_EVIDENCE",
  "COMPLAINT_ONLY_EVIDENCE",
  "UNRESOLVED_COMPLAINT_SIGNAL",
] as const;
export type ScoreReasonCode = (typeof SCORE_REASON_CODE_VALUES)[number];

/**
 * Forbidden feature names (scoring contract §10). Scoring inputs are built
 * server-side from R5 evidence only; any attempt to introduce a forbidden
 * feature (now or via a future extraction seam) fails closed here.
 */
export const FORBIDDEN_FEATURE_VALUES = [
  "race",
  "ethnicity",
  "religion",
  "sex",
  "gender",
  "sexual_orientation",
  "health_status",
  "political_affiliation",
  "disability",
  "socioeconomic_class",
  "income",
  "age",
  "zip_code",
  "nationality",
] as const;

// ─── Server-owned scoring weights (scoring contract §4) ───

/**
 * Weights are server-owned configuration. `SCORING_VERSION` must be bumped on
 * any change; the engine validates bounds on every computation.
 */
export const SCORING_WEIGHTS: Readonly<Record<ComponentKey, number>> = Object.freeze({
  fit: 0.25,
  intent: 0.3,
  engagement: 0.15,
  recency: 0.15,
  opportunity: 0.15,
});

// ─── Opportunity-type relevance tables (contract §4a, §4b — deterministic) ───

const INTENT_TYPE_BASE: Readonly<Record<OpportunityType, number>> = Object.freeze({
  purchase_interest: 50,
  repeat_interest: 55,
  demo_or_consultation_interest: 45,
  service_enquiry: 40,
  support_to_sales_transition: 35,
  partnership_interest: 35,
  referral_or_advocacy: 15,
  unresolved_complaint_opportunity: 10,
  unknown: 10,
  retention_risk: 5,
  churn_risk: 5,
});

const FIT_TYPE_RELEVANCE: Readonly<Record<OpportunityType, number>> = Object.freeze({
  purchase_interest: 1.0,
  repeat_interest: 1.0,
  demo_or_consultation_interest: 0.9,
  service_enquiry: 0.9,
  support_to_sales_transition: 0.8,
  partnership_interest: 0.7,
  referral_or_advocacy: 0.4,
  unresolved_complaint_opportunity: 0.2,
  unknown: 0.2,
  retention_risk: 0.1,
  churn_risk: 0.1,
});

export function intentTypeBase(opportunityType: OpportunityType): number {
  return INTENT_TYPE_BASE[opportunityType];
}

export function fitTypeRelevance(opportunityType: OpportunityType): number {
  return FIT_TYPE_RELEVANCE[opportunityType];
}

/**
 * R5 §6 explicit opportunity-type set — the only types that can evidence
 * explicit sales intent. Praise/complaint-only evidence never matches.
 */
export const EXPLICIT_INTENT_TYPE_SET: ReadonlySet<OpportunityType> = new Set([
  "purchase_interest",
  "service_enquiry",
  "partnership_interest",
  "support_to_sales_transition",
  "unresolved_complaint_opportunity",
  "referral_or_advocacy",
]);

export const OPPORTUNITY_TYPE_SET: ReadonlySet<string> = new Set(OPPORTUNITY_TYPE_VALUES);

// ─── Typed error taxonomy (stable codes, fail-closed) ───

export class ScoringError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ScoringError";
    this.code = code;
  }
}

/** Scoring input failed validation/bounding/ownership checks. */
export class ScoringInputError extends ScoringError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ScoringInputError";
  }
}

/** A feature value was malformed, non-finite, out of range, or forbidden. */
export class ScoringValidationError extends ScoringError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ScoringValidationError";
  }
}

/** Tenant/business ownership could not be proven server-side. */
export class ScoringOwnershipError extends ScoringError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ScoringOwnershipError";
  }
}

/** Stored evidence snapshot hash drift — tampering. */
export class ScoringTamperError extends ScoringError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ScoringTamperError";
  }
}

export type ScoringDuplicateClassification = "none" | "idempotent_replay";

// ─── Canonical local helpers (repo convention: each module owns a copy) ───

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

import { createHash } from "crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export const HEX_64 = /^[a-f0-9]{64}$/;
