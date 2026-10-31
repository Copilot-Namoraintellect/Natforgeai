// ─── R9-A Mission Authority & Objectives — canonical contract ───
//
// PURE contract module: closed vocabularies, version identities, identity
// patterns, typed error taxonomy, zod router-input schemas and client-
// authority rejection for the mission authority (docs/contracts/
// mission-authority-contract.md). No I/O of any kind; authorizes nothing;
// plans nothing; executes nothing.
//
// Mission proposals are bounded mission authority, never execution
// authorization. Clients supply business scope + R8 candidate reference id +
// bounded formation inputs (objective wording, expected outcome, success
// criteria, assumptions, optional constraint additions, optional model
// wording draft) only — never identity, status, fingerprints, risk,
// governance, approval, validity, scope or projection material.
// z.strictObject everywhere.
//
// Frozen upstream (consumed read-only, never merged): R8-E strategic
// opportunity/risk (strategic-intelligence-to-mission-control/v1 @ frozen
// R8 HEAD 4fc43c3b) with R8-F governance through R8-E's consumption gate.

import { createHash } from "crypto";
import { z } from "zod";

// ─── Versions ───

export const MISSION_AUTHORITY_CONTRACT_VERSION = "mission-authority/v1" as const;
export const MISSION_AUTHORITY_ENGINE_VERSION = "mission-authority-engine/v1" as const;
export const MISSION_AUTHORITY_PROJECTION_VERSION = "mission-authority-to-planning/v1" as const;

/** Frozen upstream contract versions this stream binds (contract §9). */
export const MISSION_AUTHORITY_BOUND_VERSIONS = Object.freeze({
  strategicIntelligenceToMissionControl: "strategic-intelligence-to-mission-control/v1",
  strategicGovernance: "strategic-governance/v1",
});

// ─── Identity patterns ───

export const MISSION_ID_PATTERN = /^mis1:[a-f0-9]{64}$/;
export const OBJECTIVE_ID_PATTERN = /^obj1:[a-f0-9]{64}$/;
export const LIFECYCLE_EVENT_ID_PATTERN = /^misl1:[a-f0-9]{64}$/;
export const CANDIDATE_ID_PATTERN = /^sor1:[a-f0-9]{64}$/;
export const REASONING_ID_PATTERN = /^rsn1:[a-f0-9]{64}$/;
export const GOVERNANCE_DECISION_ID_PATTERN = /^sgd1:[a-f0-9]{64}$/;
export const HEX_64_PATTERN = /^[a-f0-9]{64}$/;

// ─── Closed vocabularies (contract §5) ───

export const MISSION_TYPES = [
  "OPPORTUNITY_PURSUIT",
  "RISK_RESPONSE",
  "MARKET_EXPANSION",
  "POSITIONING_ACTION",
  "CAPABILITY_ACTION",
  "CHANNEL_SHIFT",
  "PORTFOLIO_REBALANCE",
  "DEFENSIVE_RESPONSE",
] as const;
export type MissionType = (typeof MISSION_TYPES)[number];

export const OBJECTIVE_TYPES = [
  "GROWTH",
  "RISK_REDUCTION",
  "MARKET_EXPANSION",
  "POSITIONING",
  "CAPABILITY_BUILD",
  "CHANNEL_OPTIMISATION",
  "PORTFOLIO_HEALTH",
  "RESILIENCE",
] as const;
export type ObjectiveType = (typeof OBJECTIVE_TYPES)[number];

export const SCOPE_SUBJECT_TYPES = [
  "BUSINESS",
  "MARKET",
  "PRODUCT_SET",
  "CHANNEL",
  "PORTFOLIO",
  "CAPABILITY",
] as const;
export type ScopeSubjectType = (typeof SCOPE_SUBJECT_TYPES)[number];

export const SUCCESS_CRITERION_TYPES = [
  "MEASURABLE_THRESHOLD",
  "QUALITATIVE_REVIEW",
  "GOVERNANCE_GATE",
  "TIME_BOUND_DELIVERABLE",
] as const;
export type SuccessCriterionType = (typeof SUCCESS_CRITERION_TYPES)[number];

export const CONSTRAINT_TYPES = [
  "MEASURABLE_OUTCOME_REQUIRED",
  "ALLOWED_CHANNELS",
  "ALLOWED_BUSINESS_UNIT",
  "TIME_HORIZON_LIMIT",
  "BUDGET_CEILING",
  "PROHIBITED_ACTION",
  "DEPENDENCY_REQUIRED",
  "HUMAN_REVIEW_REQUIRED",
  "RECOMMENDATION_ONLY",
  "RISK_CEILING",
  "CONFIDENCE_CEILING",
  "SCOPE_BOUND",
  "VALIDITY_WINDOW",
] as const;
export type ConstraintType = (typeof CONSTRAINT_TYPES)[number];

/** Constraint types the client may add on top of the derived set. */
export const CLIENT_ADDABLE_CONSTRAINT_TYPES = [
  "MEASURABLE_OUTCOME_REQUIRED",
  "ALLOWED_CHANNELS",
  "ALLOWED_BUSINESS_UNIT",
  "TIME_HORIZON_LIMIT",
  "BUDGET_CEILING",
  "PROHIBITED_ACTION",
  "DEPENDENCY_REQUIRED",
  "HUMAN_REVIEW_REQUIRED",
] as const;
export type ClientAddableConstraintType = (typeof CLIENT_ADDABLE_CONSTRAINT_TYPES)[number];

/** Constraint types derived by the server — never client-supplied. */
export const DERIVED_CONSTRAINT_TYPES = [
  "RECOMMENDATION_ONLY",
  "RISK_CEILING",
  "CONFIDENCE_CEILING",
  "SCOPE_BOUND",
  "VALIDITY_WINDOW",
] as const;

export const PRIORITY_CONTEXTS = [
  "MONITOR",
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL_REVIEW",
] as const;
export type PriorityContext = (typeof PRIORITY_CONTEXTS)[number];

export const STRATEGIC_RISK_CLASSES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type StrategicRiskClass = (typeof STRATEGIC_RISK_CLASSES)[number];

export const CONFIDENCE_CLASSES = ["INSUFFICIENT", "LOW", "MODERATE", "HIGH"] as const;
export type ConfidenceClass = (typeof CONFIDENCE_CLASSES)[number];

export const MISSION_STATUSES = [
  "PROPOSED",
  "ELIGIBLE_FOR_PLANNING",
  "REVIEW_REQUIRED",
  "BLOCKED",
  "SUPERSEDED",
  "STALE",
  "CANCELLED",
  "INVALIDATED",
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

/** Active statuses that may appear in the planning handoff read. */
export const MISSION_ACTIVE_STATUSES = [
  "PROPOSED",
  "ELIGIBLE_FOR_PLANNING",
  "REVIEW_REQUIRED",
] as const;

export const MISSION_LIFECYCLE_TYPES = [
  "eligibility",
  "review_required",
  "blockage",
  "staleness",
  "supersession",
  "cancellation",
  "invalidation",
] as const;
export type MissionLifecycleType = (typeof MISSION_LIFECYCLE_TYPES)[number];

export const MISSION_REASON_CODES = [
  "SOURCE_GOVERNED_AND_CURRENT",
  "GOVERNANCE_REVALIDATED",
  "APPROVAL_PENDING",
  "APPROVAL_REJECTED_BY_HUMAN",
  "RECOMMENDATION_BLOCKED_BY_POLICY",
  "STALE_POLICY_VERSION",
  "EXPIRED_DECISION",
  "SOURCE_CANDIDATE_STALE",
  "SOURCE_CANDIDATE_EXPIRED",
  "SOURCE_SUPERSEDED",
  "SOURCE_CONTRADICTED",
  "SOURCE_INVALIDATED",
  "VALIDITY_EXPIRED",
  "OPERATOR_CANCELLED",
  "SUPERSEDED_BY_SUCCESSOR",
  "DERIVED_SET_INVARIANT",
] as const;
export type MissionReasonCode = (typeof MISSION_REASON_CODES)[number];

export const MISSION_CANCEL_REASON_CODES = [
  "OPERATOR_WITHDRAWAL",
  "SOURCE_NO_LONGER_RELEVANT",
  "STRATEGY_CHANGED",
  "DUPLICATE_FORMULATION",
] as const;
export type MissionCancelReasonCode = (typeof MISSION_CANCEL_REASON_CODES)[number];

export const MISSION_CURRENCY_CODES = ["USD", "ZAR", "EUR", "GBP"] as const;
export type MissionCurrency = (typeof MISSION_CURRENCY_CODES)[number];

/** Governance requirement labels derived from the bound R8 material. */
export const GOVERNANCE_REQUIREMENT_LABELS = [
  "R8_RECOMMENDATION_CONSUMPTION_ONLY",
  "BOUND_GOVERNANCE_DECISION_VERIFIED",
  "HUMAN_REVIEW_BEFORE_MATERIAL_ACTION",
] as const;
export type GovernanceRequirementLabel = (typeof GOVERNANCE_REQUIREMENT_LABELS)[number];

// ─── Bounds ───

export const MAX_SUCCESS_CRITERIA = 8;
export const MAX_ASSUMPTIONS = 8;
export const MAX_CLIENT_CONSTRAINTS = 8;
export const MAX_STATEMENT_LENGTH = 500;
export const MAX_CRITERION_STATEMENT_LENGTH = 280;
export const MAX_CONSTRAINT_STATEMENT_LENGTH = 280;
export const MAX_REFERENCE_VALUE_LENGTH = 120;
export const MAX_REASON_CODES = 8;
export const MAX_LIMITATIONS = 8;
export const MISSION_DEFAULT_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Error taxonomy (fail closed) ───

export const MISSION_AUTHORITY_ERROR_CODES = [
  "OWNERSHIP_MISMATCH",
  "UNKNOWN_SOURCE_CANDIDATE",
  "SOURCE_SCOPE_MISMATCH",
  "SOURCE_CANDIDATE_NOT_GOVERNED",
  "SOURCE_CANDIDATE_BLOCKED",
  "SOURCE_CANDIDATE_STALE",
  "SOURCE_CANDIDATE_EXPIRED",
  "GOVERNANCE_AUTHORITY_UNAVAILABLE",
  "SOURCE_PROJECTION_MALFORMED",
  "MISSION_NOT_FOUND",
  "MISSION_REPLAY_CONFLICT",
  "MISSION_LIFECYCLE_CONFLICT",
  "MISSION_SCOPE_VIOLATION",
  "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  "EXECUTION_AUTHORITY_FORBIDDEN",
  "INVALID_OBJECTIVE_STATEMENT",
  "INVALID_EXPECTED_OUTCOME",
  "INVALID_SUCCESS_CRITERION",
  "INVALID_ASSUMPTION",
  "INVALID_CONSTRAINT",
  "INVALID_BUDGET_CEILING",
  "INVALID_CANCEL_REASON",
  "PREDECESSOR_INVALID",
] as const;
export type MissionAuthorityErrorCode = (typeof MISSION_AUTHORITY_ERROR_CODES)[number];

export class MissionAuthorityError extends Error {
  readonly code: MissionAuthorityErrorCode;
  constructor(code: MissionAuthorityErrorCode, message: string) {
    super(message);
    this.name = "MissionAuthorityError";
    this.code = code;
  }
}

export function fail(code: MissionAuthorityErrorCode, message: string): never {
  throw new MissionAuthorityError(code, message);
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

/** Bounded printable text: no control characters; trimmed; length-checked. */
export function assertBoundedText(
  value: unknown,
  maxLength: number,
  code: MissionAuthorityErrorCode,
  field: string
): string {
  if (typeof value !== "string") fail(code, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    fail(code, `${field} must be 1..${maxLength} characters`);
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed.charCodeAt(i);
    if (ch < 0x20 || ch === 0x7f) fail(code, `${field} contains control characters`);
  }
  return trimmed;
}

// ─── Client-authority field rejection (contract §10) ───

const CLIENT_AUTHORITY_FIELDS = new Set([
  // identity / fingerprints
  "missionId",
  "objectiveId",
  "missionFingerprint",
  "objectiveFingerprint",
  "lineageHash",
  "constraintSetFingerprint",
  "scopeKey",
  "tenantId",
  "userId",
  // classification / authority derivations
  "missionType",
  "objectiveType",
  "priorityContext",
  "priorityClass",
  "priorityScore",
  "strategicRisk",
  "strategicRiskClass",
  "riskClass",
  "risk",
  "confidenceClass",
  "confidence",
  "impactClass",
  "urgencyClass",
  "timeHorizon",
  "evidenceQualityScore",
  // lifecycle / freshness / validity
  "status",
  "freshness",
  "validFrom",
  "validUntil",
  "version",
  // governance / approval
  "decision",
  "governanceDecision",
  "governanceDecisionId",
  "policyVersion",
  "governanceReference",
  "approvalStatus",
  "approved",
  "approval",
  "executable",
  "executionAuthorized",
  "executing",
  "execute",
  // source material
  "sourceCandidate",
  "candidate",
  "sourceProjection",
  "projection",
  "sourceReasoningIds",
  "reasoningIds",
  "sourceVersions",
  "limitations",
  "scope",
  "sourceCandidateFingerprint",
  "candidateFingerprint",
  // rogue-agent verbs
  "forceAllow",
  "forceApprove",
  "override",
  "overrideDecision",
  "overridePolicy",
  "approve",
  "lowerRisk",
  "raiseBudget",
  "increaseBudget",
  "budgetIncrease",
  "removeConstraint",
  "widenScope",
  "broadenScope",
  "suppressLimitation",
  "promotePriority",
  "raiseConfidence",
  "makeExecutable",
  "authorizeExecution",
]);

/** Reject any client-supplied authority field at the boundary (fail closed). */
export function assertNoClientAuthorityFields(raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) {
    if (CLIENT_AUTHORITY_FIELDS.has(key)) {
      if (key === "executing" || key === "execute" || key === "executionAuthorized" ||
          key === "executable" || key === "makeExecutable" || key === "authorizeExecution") {
        fail("EXECUTION_AUTHORITY_FORBIDDEN", `client-supplied execution field "${key}" is forbidden`);
      }
      fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", `client-supplied authority field "${key}" is forbidden`);
    }
  }
}

// ─── zod router-input schemas ───

export const MissionSuccessCriterionInputSchema = z.strictObject({
  criterionType: z.enum(SUCCESS_CRITERION_TYPES),
  statement: z.string().min(1).max(MAX_CRITERION_STATEMENT_LENGTH),
  metricRef: z.string().min(1).max(MAX_REFERENCE_VALUE_LENGTH).optional(),
});
export type MissionSuccessCriterionInput = z.infer<typeof MissionSuccessCriterionInputSchema>;

export const MissionAssumptionInputSchema = z.strictObject({
  statement: z.string().min(1).max(MAX_CRITERION_STATEMENT_LENGTH),
});
export type MissionAssumptionInput = z.infer<typeof MissionAssumptionInputSchema>;

export const MissionConstraintInputSchema = z.strictObject({
  constraintType: z.enum(CLIENT_ADDABLE_CONSTRAINT_TYPES),
  statement: z.string().min(1).max(MAX_CONSTRAINT_STATEMENT_LENGTH),
  referenceValue: z.string().min(1).max(MAX_REFERENCE_VALUE_LENGTH).optional(),
  amountMinorUnits: z.number().int().nonnegative().optional(),
  currency: z.enum(MISSION_CURRENCY_CODES).optional(),
});
export type MissionConstraintInput = z.infer<typeof MissionConstraintInputSchema>;

export const ProposeMissionInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  sourceCandidateId: z.string().regex(CANDIDATE_ID_PATTERN),
  objectiveStatement: z.string().min(1).max(MAX_STATEMENT_LENGTH),
  expectedOutcome: z.string().min(1).max(MAX_STATEMENT_LENGTH),
  successCriteria: z.array(MissionSuccessCriterionInputSchema).min(1).max(MAX_SUCCESS_CRITERIA),
  assumptions: z.array(MissionAssumptionInputSchema).max(MAX_ASSUMPTIONS).default([]),
  constraints: z.array(MissionConstraintInputSchema).max(MAX_CLIENT_CONSTRAINTS).default([]),
  modelAssistance: z
    .strictObject({
      // Untrusted advisory wording draft — may reword the objective
      // statement only; never any authority dimension.
      draftWording: z.string().min(1).max(MAX_STATEMENT_LENGTH),
    })
    .optional(),
  /** Governed supersession: the exact predecessor mission this formulation replaces. */
  supersedesMissionId: z.string().regex(MISSION_ID_PATTERN).optional(),
});
export type ProposeMissionInput = z.infer<typeof ProposeMissionInputSchema>;

export const GetMissionInputSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
});
export type GetMissionInput = z.infer<typeof GetMissionInputSchema>;

export const ListMissionsInputSchema = z.strictObject({
  businessId: z.number().int().positive().optional(),
  status: z.enum(MISSION_STATUSES).optional(),
  missionType: z.enum(MISSION_TYPES).optional(),
});
export type ListMissionsInput = z.infer<typeof ListMissionsInputSchema>;

export const RevalidateMissionInputSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
});
export type RevalidateMissionInput = z.infer<typeof RevalidateMissionInputSchema>;

export const CancelMissionInputSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  reasonCode: z.enum(MISSION_CANCEL_REASON_CODES),
});
export type CancelMissionInput = z.infer<typeof CancelMissionInputSchema>;

export const ListMissionLifecycleInputSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
});
export type ListMissionLifecycleInput = z.infer<typeof ListMissionLifecycleInputSchema>;

export const GetPlanningHandoffInputSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
});
export type GetPlanningHandoffInput = z.infer<typeof GetPlanningHandoffInputSchema>;
