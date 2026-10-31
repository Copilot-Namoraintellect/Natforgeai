// ─── R9-A Mission Authority — planning handoff projection (A8) ───
//
// Frozen read-only projection for R9-B/C planning
// (docs/contracts/mission-authority-to-planning-contract.md).
// 27-key exact allowlist — asserted exact in acceptance. Verbatim
// disclaimers travel with every projection: a mission proposal is bounded
// mission authority, not a plan and never execution authorization. Planning
// may decompose; planning may never rewrite mission authority. This stream
// never claims planning or execution.

import {
  MISSION_AUTHORITY_PROJECTION_VERSION,
  fail,
} from "./mission-authority-contract";

export const MISSION_PLANNING_PROJECTION_VERSION = MISSION_AUTHORITY_PROJECTION_VERSION;

export const MISSION_PLANNING_DISCLAIMER =
  "A mission proposal is bounded mission authority, not a plan. Task decomposition, " +
  "dependency analysis, scheduling and sequencing remain downstream planning authority " +
  "under separate governance.";

export const MISSION_EXECUTION_DISCLAIMER =
  "A mission proposal is never an execution authorization: no task, campaign, budget, " +
  "Business DNA, experiment, provider, payment or billing state may be mutated from this " +
  "projection. mission != task; recommendation != execution authorization.";

export const MISSION_PLANNING_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "missionId",
  "objectiveId",
  "businessId",
  "missionType",
  "objectiveType",
  "objectiveStatement",
  "expectedOutcome",
  "successCriteria",
  "constraints",
  "assumptions",
  "scope",
  "priorityContext",
  "strategicRisk",
  "validity",
  "status",
  "freshness",
  "r8Lineage",
  "governanceAuthorityScope",
  "governanceRequirements",
  "supersedesMissionId",
  "planningClaimed",
  "planningDisclaimer",
  "executionClaimed",
  "executionDisclaimer",
] as const;

export type MissionPlanningProjectionKey = (typeof MISSION_PLANNING_PROJECTION_FIELD_KEYS)[number];

export interface MissionPlanningProjection {
  readonly contractVersion: typeof MISSION_PLANNING_PROJECTION_VERSION;
  readonly missionId: string;
  readonly objectiveId: string;
  readonly businessId: number;
  readonly missionType: string;
  readonly objectiveType: string;
  readonly objectiveStatement: string;
  readonly expectedOutcome: string;
  readonly successCriteria: readonly unknown[];
  readonly constraints: readonly unknown[];
  readonly assumptions: readonly unknown[];
  readonly scope: {
    readonly subjectType: string;
    readonly businessScope: number;
    readonly channelScope: null;
    readonly campaignScope: null;
    readonly geography: null;
  };
  readonly priorityContext: string;
  readonly strategicRisk: string;
  readonly validity: { readonly validFrom: string; readonly validUntil: string };
  readonly status: string;
  readonly freshness: "current" | "stale";
  readonly r8Lineage: {
    readonly sourceCandidateId: string;
    readonly sourceReasoningIds: readonly string[];
    readonly governanceDecisionId: string | null;
    readonly governanceDecision: string | null;
    readonly policyVersion: string | null;
    readonly limitations: readonly string[];
  };
  readonly governanceAuthorityScope: "RECOMMENDATION_ONLY";
  readonly governanceRequirements: readonly string[];
  readonly supersedesMissionId: string | null;
  readonly planningClaimed: false;
  readonly planningDisclaimer: string;
  readonly executionClaimed: false;
  readonly executionDisclaimer: string;
}

function asStringArray(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(String);
}

function asArray(raw: unknown): readonly unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function parseScope(raw: unknown): MissionPlanningProjection["scope"] {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    subjectType: String(s.subjectType ?? ""),
    businessScope: Number(s.businessScope ?? 0),
    channelScope: null,
    campaignScope: null,
    geography: null,
  };
}

/** Build the frozen planning projection from a durable mission row. */
export function buildMissionPlanningProjection(input: {
  row: Record<string, unknown>;
  nowMs: number;
}): MissionPlanningProjection {
  const { row, nowMs } = input;
  const validUntil = typeof row.validUntil === "string" ? row.validUntil : "";
  const expired = validUntil.length > 0 && Date.parse(validUntil) < nowMs;
  const scope = parseScope(row.scope);
  return {
    contractVersion: MISSION_PLANNING_PROJECTION_VERSION,
    missionId: String(row.missionId),
    objectiveId: String(row.objectiveId),
    businessId: Number(row.businessId),
    missionType: String(row.missionType),
    objectiveType: String(row.objectiveType),
    objectiveStatement: String(row.objectiveStatement ?? ""),
    expectedOutcome: String(row.expectedOutcome ?? ""),
    successCriteria: asArray(row.successCriteria),
    constraints: asArray(row.constraints),
    assumptions: asArray(row.assumptions),
    scope,
    priorityContext: String(row.priorityContext),
    strategicRisk: String(row.strategicRiskClass),
    validity: {
      validFrom: String(row.validFrom ?? ""),
      validUntil,
    },
    status: String(row.status),
    freshness: expired ? "stale" : "current",
    r8Lineage: {
      sourceCandidateId: String(row.sourceCandidateId),
      sourceReasoningIds: asStringArray(row.sourceReasoningIds),
      governanceDecisionId: typeof row.governanceDecisionId === "string" ? row.governanceDecisionId : null,
      governanceDecision: typeof row.governanceDecision === "string" ? row.governanceDecision : null,
      policyVersion: typeof row.policyVersion === "string" ? row.policyVersion : null,
      limitations: asStringArray(row.limitations),
    },
    governanceAuthorityScope: "RECOMMENDATION_ONLY",
    governanceRequirements: asStringArray(row.governanceRequirements),
    supersedesMissionId: typeof row.supersedesMissionId === "string" ? row.supersedesMissionId : null,
    planningClaimed: false,
    planningDisclaimer: MISSION_PLANNING_DISCLAIMER,
    executionClaimed: false,
    executionDisclaimer: MISSION_EXECUTION_DISCLAIMER,
  };
}

/**
 * Planning-eligibility gate (contract §3): consumable only when ELIGIBLE,
 * freshness-current and RECOMMENDATION_ONLY. Consumers must not infer
 * eligibility from any other field.
 */
export function isPlanningConsumable(projection: MissionPlanningProjection): boolean {
  return (
    projection.status === "ELIGIBLE_FOR_PLANNING" &&
    projection.freshness === "current" &&
    projection.governanceAuthorityScope === "RECOMMENDATION_ONLY"
  );
}

/** Seam validator: exact key allowlist + frozen version + disclaimers verbatim. */
export function validateMissionPlanningProjection(raw: unknown): MissionPlanningProjection {
  if (typeof raw !== "object" || raw === null) {
    fail("MISSION_NOT_FOUND", "planning projection must be an object");
  }
  const keys = Object.keys(raw).sort();
  const expected = [...MISSION_PLANNING_PROJECTION_FIELD_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    fail("MISSION_NOT_FOUND", "planning projection key allowlist mismatch");
  }
  const p = raw as Record<string, unknown>;
  if (p.contractVersion !== MISSION_PLANNING_PROJECTION_VERSION) {
    fail("MISSION_NOT_FOUND", "planning projection version mismatch");
  }
  if (p.planningClaimed !== false || p.executionClaimed !== false) {
    fail("MISSION_NOT_FOUND", "planning projection must never claim planning or execution authority");
  }
  if (p.planningDisclaimer !== MISSION_PLANNING_DISCLAIMER || p.executionDisclaimer !== MISSION_EXECUTION_DISCLAIMER) {
    fail("MISSION_NOT_FOUND", "planning projection disclaimers must be verbatim");
  }
  if (p.governanceAuthorityScope !== "RECOMMENDATION_ONLY") {
    fail("MISSION_NOT_FOUND", "planning projection governance scope must be RECOMMENDATION_ONLY");
  }
  return raw as unknown as MissionPlanningProjection;
}
