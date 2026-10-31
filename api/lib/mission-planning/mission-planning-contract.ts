// ─── R9-B Mission Planning & Decomposition — canonical contract ───
//
// PURE contract module: closed vocabularies, version identities, identity
// patterns, typed error taxonomy, zod router-input schemas and client-
// authority rejection for mission planning
// (docs/contracts/mission-planning-contract.md). No I/O of any kind;
// authorizes nothing; schedules nothing; executes nothing.
//
// Mission plans are bounded task-definition authority, never execution
// authorization. Clients supply a governed mission reference id + bounded
// planning inputs (assumptions, optional model assistance from the closed
// vocabulary) only — never identity, status, fingerprints, classifications,
// constraints, capabilities, schedules or execution material.
// z.strictObject everywhere.
//
// Frozen upstream (consumed read-only, never merged): R9-A mission
// authority (mission-authority/v1 + mission-authority-to-planning/v1 @
// frozen R9-A HEAD 273ce40). R9-F mission governance is reference-only
// vocabulary for pre-classification (mission-governance/v1 @ 1665d2f).

import { createHash } from "crypto";
import { z } from "zod";

// ─── Versions ───

export const MISSION_PLANNING_CONTRACT_VERSION = "mission-planning/v1" as const;
export const MISSION_PLANNING_ENGINE_VERSION = "mission-planning-engine/v1" as const;
export const MISSION_PLANNING_TO_SCHEDULING_VERSION = "mission-planning-to-scheduling/v1" as const;

/** Frozen upstream contract versions this stream binds (contract §1). */
export const MISSION_PLANNING_BOUND_VERSIONS = Object.freeze({
  missionAuthority: "mission-authority/v1",
  missionAuthorityToPlanning: "mission-authority-to-planning/v1",
  missionGovernance: "mission-governance/v1",
});

// ─── Identity patterns ───

export const PLAN_ID_PATTERN = /^pln1:[a-f0-9]{64}$/;
export const TASK_ID_PATTERN = /^tsk1:[a-f0-9]{64}$/;
export const PLAN_LIFECYCLE_EVENT_ID_PATTERN = /^mpl1:[a-f0-9]{64}$/;
export const MISSION_ID_PATTERN = /^mis1:[a-f0-9]{64}$/;
export const HEX_64_PATTERN = /^[a-f0-9]{64}$/;

// ─── Closed vocabularies (contract §4–§8) ───

export const TASK_TYPES = [
  "RESEARCH",
  "ANALYSE",
  "VALIDATE",
  "PREPARE_CONTENT",
  "REVIEW_CONTENT",
  "CONFIGURE_CAMPAIGN",
  "REQUEST_APPROVAL",
  "SCHEDULE_ACTION",
  "MONITOR",
  "RECONCILE",
  "REPORT",
  "ESCALATE",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const ARTIFACT_TYPES = [
  "MISSION_AUTHORITY",
  "RESEARCH_FINDINGS",
  "ANALYSIS_REPORT",
  "CONTENT_DRAFT",
  "REVIEWED_CONTENT",
  "CAMPAIGN_CONFIGURATION",
  "APPROVAL_DECISION",
  "OBSERVATION_METRICS",
  "RECONCILIATION_REPORT",
  "FINAL_REPORT",
  "ESCALATION_NOTICE",
  "PLAN_RECORD",
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const CONDITION_TYPES = [
  "MISSION_CURRENT",
  "INPUT_ARTIFACT_READY",
  "PRIOR_TASKS_COMPLETED",
  "GOVERNANCE_VERDICT_REQUIRED",
  "HUMAN_REVIEW_COMPLETED",
  "PROVIDER_AVAILABLE",
  "ARTIFACT_PRODUCED",
  "EVIDENCE_RECORDED",
  "READY_FOR_SCHEDULING",
  "GOVERNANCE_CLASSIFICATION_RECORDED",
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export const CAPABILITY_STATUSES = [
  "SUPPORTED",
  "CONDITIONALLY_SUPPORTED",
  "UNRESOLVED",
  "UNSUPPORTED",
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const GOVERNANCE_CLASSES = [
  "AUTONOMY_CANDIDATE",
  "STANDARD_REVIEW",
  "HUMAN_REVIEW_REQUIRED",
] as const;
export type GovernanceClass = (typeof GOVERNANCE_CLASSES)[number];

export const SIDE_EFFECT_CLASSES = [
  "NONE",
  "INTERNAL_DATA",
  "EXTERNAL_COMMUNICATION",
  "PROVIDER_MUTATION",
  "FINANCIAL",
  "CAMPAIGN_ACTIVATION",
] as const;
export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number];

export const EXECUTION_CLASSES = [
  "INTERNAL_ONLY",
  "GOVERNANCE_GATED",
  "REQUIRES_PROVIDER_AVAILABILITY",
  "SCHEDULING_BOUNDARY",
] as const;
export type ExecutionClass = (typeof EXECUTION_CLASSES)[number];

export const PLAN_STATUSES = [
  "DRAFT",
  "VALIDATED",
  "READY_FOR_SCHEDULING",
  "REVIEW_REQUIRED",
  "BLOCKED",
  "SUPERSEDED",
  "STALE",
  "CANCELLED",
  "INVALIDATED",
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_COMPLETENESS_STATUSES = [
  "COMPLETE",
  "COMPLETE_WITH_UNRESOLVED",
  "INCOMPLETE",
] as const;
export type PlanCompletenessStatus = (typeof PLAN_COMPLETENESS_STATUSES)[number];

export const PLAN_LIFECYCLE_TYPES = [
  "formation",
  "validation",
  "readiness",
  "review_required",
  "blockage",
  "staleness",
  "supersession",
  "cancellation",
  "invalidation",
] as const;
export type PlanLifecycleType = (typeof PLAN_LIFECYCLE_TYPES)[number];

export const TASK_STATUSES = [
  "DEFINED",
  "VALIDATED",
  "READY_FOR_SCHEDULING",
  "GOVERNANCE_REVIEW_REQUIRED",
  "BLOCKED",
  "SUPERSEDED",
  "UNRESOLVED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const UNRESOLVED_REASON_CODES = [
  "UNSUPPORTED_CAPABILITY",
  "UNKNOWN_TASK_TYPE",
  "PROHIBITED_BY_MISSION_CONSTRAINT",
  "INSUFFICIENT_AUTHORITY",
  "MISSION_CONSTRAINT_CONFLICT",
  "MODEL_PROPOSAL_REJECTED",
] as const;
export type UnresolvedReasonCode = (typeof UNRESOLVED_REASON_CODES)[number];

export const PLAN_REASON_CODES = [
  "MISSION_GOVERNED_AND_CURRENT",
  "PLAN_VALIDATED",
  "PLAN_READY_FOR_SCHEDULING",
  "GOVERNANCE_REVIEW_HINTED",
  "MISSION_BLOCKED",
  "MISSION_STALE",
  "MISSION_INVALIDATED",
  "MISSION_AUTHORITY_DRIFT",
  "OPERATOR_CANCELLED",
  "SUPERSEDED_BY_SUCCESSOR",
  "UNRESOLVED_WORK_PRESENT",
  "DERIVED_SET_INVARIANT",
] as const;
export type PlanReasonCode = (typeof PLAN_REASON_CODES)[number];

export const FINANCIAL_EFFECTS = ["NONE", "INDIRECT", "DIRECT_SPEND"] as const;
export type FinancialEffect = (typeof FINANCIAL_EFFECTS)[number];

/** Closed mission vocabulary mirrored from R9-A (formation input binding). */
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

export const STRATEGIC_RISK_CLASSES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type StrategicRiskClass = (typeof STRATEGIC_RISK_CLASSES)[number];

/** Mission constraint types mirrored verbatim from R9-A (never extended). */
export const MISSION_CONSTRAINT_TYPES = [
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
export type MissionConstraintType = (typeof MISSION_CONSTRAINT_TYPES)[number];

// ─── Bounds ───

export const MAX_PLANNING_ASSUMPTIONS = 8;
export const MAX_UNRESOLVED_ITEMS = 16;
export const MAX_TASKS_PER_PLAN = 16;
export const MAX_MODEL_PROPOSED_TASK_TYPES = 12;
export const MAX_REVIEW_HINTS = 8;
export const MAX_TASK_OBJECTIVE_LENGTH = 500;

// ─── Error taxonomy (fail closed; contract §12) ───

export const MISSION_PLANNING_ERROR_CODES = [
  "MISSION_NOT_FOUND",
  "MISSION_AUTHORITY_UNAVAILABLE",
  "MISSION_NOT_ELIGIBLE",
  "MISSION_NOT_PLANNABLE",
  "MISSION_SCOPE_VIOLATION",
  "MISSION_CONSTRAINT_VIOLATION",
  "PLAN_MISSION_AUTHORITY_DRIFT",
  "PLAN_REPLAY_CONFLICT",
  "PLAN_NOT_FOUND",
  "PLAN_STATE_CONFLICT",
  "PLAN_NOT_SCHEDULABLE",
  "UNKNOWN_TASK_TYPE",
  "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  "INVALID_PLAN_INPUT",
] as const;
export type MissionPlanningErrorCode = (typeof MISSION_PLANNING_ERROR_CODES)[number];

export class MissionPlanningError extends Error {
  readonly code: MissionPlanningErrorCode;
  constructor(code: MissionPlanningErrorCode, message: string) {
    super(message);
    this.name = "MissionPlanningError";
    this.code = code;
  }
}

export function fail(code: MissionPlanningErrorCode, message: string): never {
  throw new MissionPlanningError(code, message);
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

// ─── Client-authority field rejection (contract §10/§13) ───

const CLIENT_AUTHORITY_FIELDS = new Set([
  "planId",
  "taskId",
  "planVersion",
  "taskIds",
  "planFingerprint",
  "taskFingerprint",
  "constraintSetFingerprint",
  "taskSetFingerprint",
  "missionAuthorityVersion",
  "boundMissionVersion",
  "status",
  "taskStatus",
  "completenessStatus",
  "capabilityStatus",
  "governanceClass",
  "sideEffectClass",
  "executionClass",
  "governanceCharacteristics",
  "requiredCapabilities",
  "requiredInputs",
  "expectedOutputs",
  "constraints",
  "preconditions",
  "postconditions",
  "unresolvedItems",
  "validFrom",
  "validUntil",
  "supersedesPlanId",
  "decision",
  "governanceDecision",
  "governanceDecisionId",
  "riskClass",
  "risk",
  "strategicRiskClass",
  "approved",
  "executable",
  "authorization",
  "policyVersion",
  "allow",
  "forceAllow",
  "forceApprove",
  "lowerRisk",
  "override",
  "selfApprove",
  "schedule",
  "scheduledAt",
  "execute",
  "execution",
  "shell",
  "command",
  "sql",
  "provider",
  "providerCredential",
  "budget",
  "amount",
  "amountMinorUnits",
  "currency",
  "spend",
  "taskObjective",
  "objective",
  "missionObjective",
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

// ─── zod router-input schemas (strict; clients reference ids + bounded inputs only) ───

export const CreatePlanInputSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  planningAssumptions: z
    .array(
      z.strictObject({
        statement: z.string().min(1).max(280),
      })
    )
    .max(MAX_PLANNING_ASSUMPTIONS)
    .optional(),
  modelAssistance: z
    .strictObject({
      proposedTaskTypes: z.array(z.enum(TASK_TYPES)).max(MAX_MODEL_PROPOSED_TASK_TYPES).optional(),
      proposedOrder: z.array(z.enum(TASK_TYPES)).max(MAX_MODEL_PROPOSED_TASK_TYPES).optional(),
      draftWording: z.string().max(MAX_TASK_OBJECTIVE_LENGTH).optional(),
    })
    .optional(),
});
export type CreatePlanInput = z.infer<typeof CreatePlanInputSchema>;

export const GetPlanInputSchema = z.strictObject({
  planId: z.string().regex(PLAN_ID_PATTERN),
});
export type GetPlanInput = z.infer<typeof GetPlanInputSchema>;

export const GetSchedulingHandoffInputSchema = z.strictObject({
  planId: z.string().regex(PLAN_ID_PATTERN),
});
export type GetSchedulingHandoffInput = z.infer<typeof GetSchedulingHandoffInputSchema>;

export const PlanLifecycleInputSchema = z.strictObject({
  planId: z.string().regex(PLAN_ID_PATTERN),
  expectedVersion: z.number().int().positive(),
  reasonCode: z.enum(PLAN_REASON_CODES).optional(),
});
export type PlanLifecycleInput = z.infer<typeof PlanLifecycleInputSchema>;

export const ListPlansInputSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN).optional(),
  status: z.enum(PLAN_STATUSES).optional(),
});
export type ListPlansInput = z.infer<typeof ListPlansInputSchema>;
