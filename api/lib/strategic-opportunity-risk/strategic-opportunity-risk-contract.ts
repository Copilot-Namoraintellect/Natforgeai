// ─── R8-E Strategic Opportunity & Risk — canonical contract ───
//
// PURE contract module: closed vocabularies, version identities, identity
// patterns, typed error taxonomy, zod router-input schemas and client-
// authority rejection for the strategic opportunity/risk authority
// (docs/contracts/strategic-opportunity-risk-contract.md). No I/O of any
// kind; authorizes nothing.
//
// Candidates are strategic evidence, never execution instructions. Clients
// supply business scope + reasoning reference ids (+ bounded advisory model
// candidate types) only — never kind/type verdicts, classifications,
// priority, confidence, risk, governance, approval, fingerprint or status
// material. z.strictObject everywhere.
//
// Frozen upstream authorities (consumed by branch ref only): R8-D strategic
// reasoning (00f9adf, strategic-reasoning-to-opportunity-risk/v1), R8-F
// strategic governance (44118e3, strategic-governance/v1). R8-A/B/C evidence
// arrives as lineage through R8-D projections only.

import { createHash } from "crypto";
import { z } from "zod";

// ─── Versions ───

export const STRATEGIC_OPPORTUNITY_RISK_CONTRACT_VERSION =
  "strategic-opportunity-risk/v1" as const;
export const STRATEGIC_OPPORTUNITY_RISK_ENGINE_VERSION =
  "strategic-opportunity-risk-engine/v1" as const;
export const STRATEGIC_OPPORTUNITY_RISK_PROJECTION_VERSION =
  "strategic-intelligence-to-mission-control/v1" as const;

/** Frozen upstream contract versions this stream binds (contract §3/§4). */
export const STRATEGIC_OPPORTUNITY_RISK_BOUND_VERSIONS = Object.freeze({
  strategicReasoning: "strategic-reasoning-to-opportunity-risk/v1",
  strategicGovernance: "strategic-governance/v1",
});

// ─── Identity patterns ───

export const CANDIDATE_ID_PATTERN = /^sor1:[a-f0-9]{64}$/;
export const LIFECYCLE_EVENT_ID_PATTERN = /^sorl1:[a-f0-9]{64}$/;
export const REASONING_ID_PATTERN = /^rsn1:[a-f0-9]{64}$/;
export const EVIDENCE_BUNDLE_ID_PATTERN = /^evb1:[a-f0-9]{64}$/;
export const GOVERNANCE_DECISION_ID_PATTERN = /^sgd1:[a-f0-9]{64}$/;
export const MEMORY_REF_PATTERN = /^mem1:[a-f0-9]{64}$/;
export const CHANGE_REF_PATTERN = /^chg1:[a-f0-9]{64}$/;
export const SIGNAL_REF_PATTERN = /^xsig1:[a-f0-9]{64}$/;
export const HEX_64_PATTERN = /^[a-f0-9]{64}$/;

// ─── Closed vocabularies (contract §5) ───

export const CANDIDATE_KINDS = ["OPPORTUNITY", "RISK"] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export const CANDIDATE_TYPES = [
  "MARKET_EXPANSION",
  "DEMAND_GROWTH",
  "POSITIONING_CHANGE",
  "COMPETITIVE_RESPONSE",
  "PRODUCT_MARKETING",
  "CHANNEL_SHIFT",
  "CAPABILITY_INVESTMENT",
  "RESOURCE_REALLOCATION",
  "REGULATORY_RESPONSE",
  "TECHNOLOGY_ADOPTION",
  "REPUTATION_RESPONSE",
  "MARKET_DECLINE",
  "CAPABILITY_RISK",
  "PORTFOLIO_RISK",
  "STRATEGIC_MISALIGNMENT",
] as const;
export type CandidateType = (typeof CANDIDATE_TYPES)[number];

export const IMPACT_CLASSES = ["MINOR", "MODERATE", "MAJOR", "SEVERE"] as const;
export type ImpactClass = (typeof IMPACT_CLASSES)[number];

export const URGENCY_CLASSES = ["LOW", "MODERATE", "HIGH", "IMMEDIATE"] as const;
export type UrgencyClass = (typeof URGENCY_CLASSES)[number];

export const TIME_HORIZONS = ["IMMEDIATE", "NEAR_TERM", "MEDIUM_TERM", "LONG_TERM"] as const;
export type TimeHorizon = (typeof TIME_HORIZONS)[number];

export const CONFIDENCE_CLASSES = ["INSUFFICIENT", "LOW", "MODERATE", "HIGH"] as const;
export type ConfidenceClass = (typeof CONFIDENCE_CLASSES)[number];

export const PRIORITY_CLASSES = ["MONITOR", "LOW", "MEDIUM", "HIGH", "CRITICAL_REVIEW"] as const;
export type PriorityClass = (typeof PRIORITY_CLASSES)[number];

/** Carried verbatim from the bound R8-F decision — never derived here. */
export const STRATEGIC_RISK_CLASSES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type StrategicRiskClass = (typeof STRATEGIC_RISK_CLASSES)[number];

export const CANDIDATE_STATUSES = [
  "CANDIDATE",
  "MONITOR",
  "REVIEW_REQUIRED",
  "GOVERNED_RECOMMENDATION",
  "BLOCKED",
  "SUPERSEDED",
  "CONTRADICTED",
  "STALE",
  "RESOLVED",
  "INVALIDATED",
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** Active/voiceable candidates in the R9 handoff projection. */
export const CANDIDATE_ACTIVE_STATUSES = [
  "MONITOR",
  "REVIEW_REQUIRED",
  "GOVERNED_RECOMMENDATION",
] as const;

export const PORTFOLIO_RELATIONS = [
  "NEW",
  "REINFORCING",
  "OVERLAPPING",
  "CONFLICTING",
  "SUPERSEDING",
] as const;
export type PortfolioRelation = (typeof PORTFOLIO_RELATIONS)[number];

export const DERIVATION_OUTCOMES = [
  "CANDIDATE_CREATED",
  "MONITOR_ONLY",
  "NO_CANDIDATE",
] as const;
export type DerivationOutcome = (typeof DERIVATION_OUTCOMES)[number];

/** Closed R8-F decision labels (strategic-governance/v1). */
export const STRATEGIC_GOVERNANCE_DECISIONS = [
  "ALLOW_RECOMMENDATION",
  "REVIEW_REQUIRED",
  "BLOCK",
] as const;
export type StrategicGovernanceDecisionLabel = (typeof STRATEGIC_GOVERNANCE_DECISIONS)[number];

/** Frozen implication → R8-F recommendation taxonomy (mirrors R8-D mapping). */
export const IMPLICATION_TO_GOVERNANCE_RECOMMENDATION_TYPE: Record<
  string,
  | "STRATEGIC_OBSERVATION"
  | "STRATEGIC_HYPOTHESIS"
  | "MARKET_RESPONSE_RECOMMENDATION"
  | "RESOURCE_PRIORITY_RECOMMENDATION"
  | "CHANNEL_STRATEGY_RECOMMENDATION"
  | "PRODUCT_MARKETING_RECOMMENDATION"
  | null
> = Object.freeze({
  MONITOR: "STRATEGIC_OBSERVATION",
  INVESTIGATE: "STRATEGIC_HYPOTHESIS",
  VALIDATE_ASSUMPTION: "STRATEGIC_HYPOTHESIS",
  REVIEW_POSITIONING: "MARKET_RESPONSE_RECOMMENDATION",
  REVIEW_RESOURCE_PRIORITY: "RESOURCE_PRIORITY_RECOMMENDATION",
  REVIEW_CHANNEL_STRATEGY: "CHANNEL_STRATEGY_RECOMMENDATION",
  REVIEW_PRODUCT_MARKETING: "PRODUCT_MARKETING_RECOMMENDATION",
  REVIEW_MARKET_RESPONSE: "MARKET_RESPONSE_RECOMMENDATION",
  NO_ACTION: null,
});

/** Deterministic candidate confidence → R8-F claimed-confidence scale. */
export const CONFIDENCE_TO_GOVERNANCE_SCALE: Record<ConfidenceClass, "NONE" | "LOW" | "MEDIUM" | "HIGH"> =
  Object.freeze({
    INSUFFICIENT: "NONE",
    LOW: "LOW",
    MODERATE: "MEDIUM",
    HIGH: "HIGH",
  });

// ─── Ranks for deterministic integer scoring ───

export const IMPACT_CLASS_RANK: Readonly<Record<ImpactClass, number>> = {
  MINOR: 0,
  MODERATE: 1,
  MAJOR: 2,
  SEVERE: 3,
};

export const URGENCY_CLASS_RANK: Readonly<Record<UrgencyClass, number>> = {
  LOW: 0,
  MODERATE: 1,
  HIGH: 2,
  IMMEDIATE: 3,
};

export const CONFIDENCE_CLASS_RANK: Readonly<Record<ConfidenceClass, number>> = {
  INSUFFICIENT: 0,
  LOW: 1,
  MODERATE: 2,
  HIGH: 3,
};

export const STRATEGIC_RISK_CLASS_RANK: Readonly<Record<StrategicRiskClass, number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

// ─── Bounds ───

export const MAX_REASONING_PER_DERIVATION = 16;
export const MAX_REFS_PER_CLASS = 32;
export const MAX_REASON_CODES = 8;
export const MAX_LIMITATIONS = 8;
export const MAX_SUBJECT_REFS = 32;

// ─── Error taxonomy (fail closed) ───

export const STRATEGIC_OPPORTUNITY_RISK_ERROR_CODES = [
  "OWNERSHIP_MISMATCH",
  "UNKNOWN_REASONING_REFERENCE",
  "REASONING_SCOPE_MISMATCH",
  "STALE_REASONING",
  "REASONING_CONTRACT_VERSION_UNSUPPORTED",
  "REASONING_PROJECTION_MALFORMED",
  "ZERO_USABLE_REASONING",
  "GOVERNANCE_AUTHORITY_UNAVAILABLE",
  "GOVERNANCE_DECISION_MALFORMED",
  "APPROVAL_BINDING_MISMATCH",
  "CANDIDATE_NOT_FOUND",
  "CANDIDATE_REPLAY_CONFLICT",
  "EVIDENCE_FINGERPRINT_MISMATCH",
  "LIFECYCLE_CONFLICT",
  "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
] as const;
export type StrategicOpportunityRiskErrorCode =
  (typeof STRATEGIC_OPPORTUNITY_RISK_ERROR_CODES)[number];

export class StrategicOpportunityRiskError extends Error {
  readonly code: StrategicOpportunityRiskErrorCode;
  constructor(code: StrategicOpportunityRiskErrorCode, message: string) {
    super(message);
    this.name = "StrategicOpportunityRiskError";
    this.code = code;
  }
}

export function fail(code: StrategicOpportunityRiskErrorCode, message: string): never {
  throw new StrategicOpportunityRiskError(code, message);
}

/** Canonical JSON (key-sorted) for deterministic fingerprints. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
  return `{${parts.join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function isIsoUtc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

// ─── Client-authority field rejection (contract §9) ───

const CLIENT_AUTHORITY_FIELDS = new Set([
  "decision",
  "governanceDecision",
  "governanceDecisionId",
  "priorityClass",
  "priorityScore",
  "impactClass",
  "urgencyClass",
  "timeHorizon",
  "confidenceClass",
  "confidence",
  "evidenceQualityScore",
  "strategicRiskClass",
  "riskClass",
  "risk",
  "status",
  "approvalStatus",
  "approved",
  "executable",
  "candidateFingerprint",
  "evidenceBundleFingerprint",
  "policyVersion",
  "reasoningProjection",
  "candidate",
  "forceAllow",
  "forceApprove",
  "raiseConfidence",
  "raiseImpact",
  "raiseUrgency",
  "lowerRisk",
  "promotePriority",
  "suppressContradiction",
  "hideContradiction",
  "overrideDecision",
  "overridePolicy",
]);

/** Reject any client-supplied authority field at the boundary (fail closed). */
export function assertNoClientAuthorityFields(raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) {
    if (CLIENT_AUTHORITY_FIELDS.has(key)) {
      fail(
        "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        `client-supplied authority field "${key}" is forbidden`
      );
    }
  }
}

// ─── zod router-input schemas ───

export const DeriveStrategicCandidateInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  reasoningIds: z
    .array(z.string().regex(REASONING_ID_PATTERN))
    .min(1)
    .max(MAX_REASONING_PER_DERIVATION),
  modelAssistance: z
    .strictObject({
      // Untrusted advisory candidate types from the bounded space only —
      // honoured solely when they agree with the deterministic derivation.
      candidateTypes: z.array(z.enum(CANDIDATE_TYPES)).max(4).optional(),
    })
    .optional(),
});
export type DeriveStrategicCandidateInput = z.infer<typeof DeriveStrategicCandidateInputSchema>;

export const GetStrategicCandidateInputSchema = z.strictObject({
  candidateId: z.string().regex(CANDIDATE_ID_PATTERN),
});
export type GetStrategicCandidateInput = z.infer<typeof GetStrategicCandidateInputSchema>;

export const ListStrategicCandidatesInputSchema = z.strictObject({
  businessId: z.number().int().positive().optional(),
  status: z.enum(CANDIDATE_STATUSES).optional(),
  candidateKind: z.enum(CANDIDATE_KINDS).optional(),
  priorityClass: z.enum(PRIORITY_CLASSES).optional(),
});
export type ListStrategicCandidatesInput = z.infer<typeof ListStrategicCandidatesInputSchema>;

export const ListStrategicCandidateRelationsInputSchema = z.strictObject({
  candidateId: z.string().regex(CANDIDATE_ID_PATTERN),
});
export type ListStrategicCandidateRelationsInput = z.infer<
  typeof ListStrategicCandidateRelationsInputSchema
>;

export const ListStrategicCandidateLifecycleInputSchema = z.strictObject({
  candidateId: z.string().regex(CANDIDATE_ID_PATTERN),
});
export type ListStrategicCandidateLifecycleInput = z.infer<
  typeof ListStrategicCandidateLifecycleInputSchema
>;

export const ReevaluateStrategicCandidateInputSchema = z.strictObject({
  candidateId: z.string().regex(CANDIDATE_ID_PATTERN),
});
export type ReevaluateStrategicCandidateInput = z.infer<
  typeof ReevaluateStrategicCandidateInputSchema
>;

export const GetMissionControlHandoffInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  includeNonGoverned: z.boolean().default(false),
});
export type GetMissionControlHandoffInput = z.infer<typeof GetMissionControlHandoffInputSchema>;
