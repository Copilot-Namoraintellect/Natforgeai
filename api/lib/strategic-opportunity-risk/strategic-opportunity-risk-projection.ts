// ─── R8-E Strategic Opportunity & Risk — R9 mission-control handoff (E8) ───
//
// Frozen read-only projection for R9 mission control
// (docs/contracts/strategic-intelligence-to-mission-control-contract.md).
// 37-key exact allowlist — asserted exact in acceptance. Verbatim
// causation/attribution/execution disclaimers travel with every projection,
// plus the mission disclaimer: a candidate is ranked evidence, never a
// mission; a recommendation is never execution authorization. R9 may read
// and must never mutate R8-E authority.

import {
  STRATEGIC_OPPORTUNITY_RISK_PROJECTION_VERSION,
  fail,
} from "./strategic-opportunity-risk-contract";

export const STRATEGIC_MISSION_CONTROL_PROJECTION_VERSION =
  STRATEGIC_OPPORTUNITY_RISK_PROJECTION_VERSION;

export const STRATEGIC_CANDIDATE_CAUSATION_DISCLAIMER =
  "A strategic candidate is evidence-preserving synthesis, not causal proof. " +
  "This projection does not assert that any marketing activity, attribution credit, " +
  "optimisation, market event or source claim caused any business outcome.";

export const STRATEGIC_CANDIDATE_ATTRIBUTION_DISCLAIMER =
  "Attribution-derived evidence is association evidence, not causal proof. " +
  "Credit allocation and channel weights remain R7-B derivations on their own authority.";

export const STRATEGIC_CANDIDATE_EXECUTION_DISCLAIMER =
  "A strategic candidate is never an execution authorization: no strategy, campaign, " +
  "budget, Business DNA, experiment, provider, payment or billing state may be mutated " +
  "from this projection.";

export const STRATEGIC_CANDIDATE_MISSION_DISCLAIMER =
  "A strategic candidate is ranked evidence for mission-control consideration, not a " +
  "mission. Objective planning, dependency analysis, task planning and execution " +
  "coordination remain R9 authority under separate governance. candidate != mission; " +
  "recommendation != execution authorization.";

export const STRATEGIC_MISSION_CONTROL_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "candidateId",
  "candidateKind",
  "candidateType",
  "businessId",
  "reasoningIds",
  "memoryRefs",
  "changeRefs",
  "signalRefs",
  "impactClass",
  "urgencyClass",
  "timeHorizon",
  "confidenceClass",
  "evidenceQualityScore",
  "priorityScore",
  "priorityClass",
  "strategicRiskClass",
  "governanceDecisionId",
  "governanceDecision",
  "policyVersion",
  "approvalStatus",
  "status",
  "portfolioRelation",
  "relationCandidateIds",
  "limitations",
  "validUntil",
  "freshness",
  "supersedesCandidateId",
  "causationClaimed",
  "causationDisclaimer",
  "attributionClaimed",
  "attributionDisclaimer",
  "executionClaimed",
  "executionDisclaimer",
  "missionClaimed",
  "missionDisclaimer",
  "createdAt",
] as const;

export type StrategicMissionControlProjectionKey =
  (typeof STRATEGIC_MISSION_CONTROL_PROJECTION_FIELD_KEYS)[number];

export interface StrategicMissionControlProjection {
  readonly contractVersion: typeof STRATEGIC_MISSION_CONTROL_PROJECTION_VERSION;
  readonly candidateId: string;
  readonly candidateKind: string;
  readonly candidateType: string;
  readonly businessId: number;
  readonly reasoningIds: readonly string[];
  readonly memoryRefs: readonly string[];
  readonly changeRefs: readonly string[];
  readonly signalRefs: readonly string[];
  readonly impactClass: string;
  readonly urgencyClass: string;
  readonly timeHorizon: string;
  readonly confidenceClass: string;
  readonly evidenceQualityScore: number;
  readonly priorityScore: number;
  readonly priorityClass: string;
  readonly strategicRiskClass: string | null;
  readonly governanceDecisionId: string | null;
  readonly governanceDecision: string | null;
  readonly policyVersion: string | null;
  readonly approvalStatus: "none" | "pending" | "approved" | "rejected";
  readonly status: string;
  readonly portfolioRelation: string;
  readonly relationCandidateIds: readonly string[];
  readonly limitations: readonly string[];
  readonly validUntil: string | null;
  readonly freshness: "current" | "stale";
  readonly supersedesCandidateId: string | null;
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
  readonly attributionClaimed: false;
  readonly attributionDisclaimer: string;
  readonly executionClaimed: false;
  readonly executionDisclaimer: string;
  readonly missionClaimed: false;
  readonly missionDisclaimer: string;
  readonly createdAt: string;
}

function asStringArray(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(String);
}

/** Build the frozen R9 handoff projection from a candidate row. */
export function buildMissionControlProjection(input: {
  row: Record<string, unknown>;
  approvalStatus: "none" | "pending" | "approved" | "rejected";
  nowMs: number;
}): StrategicMissionControlProjection {
  const { row, approvalStatus, nowMs } = input;
  const validUntil = typeof row.validUntil === "string" ? row.validUntil : null;
  const expired = validUntil !== null && Date.parse(validUntil) < nowMs;
  const createdAt =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : typeof row.createdAt === "string"
        ? row.createdAt
        : "";
  const status =
    row.status === "REVIEW_REQUIRED" && approvalStatus === "approved" ? "GOVERNED_RECOMMENDATION" : String(row.status);
  return {
    contractVersion: STRATEGIC_MISSION_CONTROL_PROJECTION_VERSION,
    candidateId: String(row.candidateId),
    candidateKind: String(row.candidateKind),
    candidateType: String(row.candidateType),
    businessId: Number(row.businessId),
    reasoningIds: asStringArray(row.reasoningIds),
    memoryRefs: asStringArray(row.memoryRefs),
    changeRefs: asStringArray(row.changeRefs),
    signalRefs: asStringArray(row.signalRefs),
    impactClass: String(row.impactClass),
    urgencyClass: String(row.urgencyClass),
    timeHorizon: String(row.timeHorizon),
    confidenceClass: String(row.confidenceClass),
    evidenceQualityScore: Number(row.evidenceQualityScore),
    priorityScore: Number(row.priorityScore),
    priorityClass: String(row.priorityClass),
    strategicRiskClass: typeof row.strategicRiskClass === "string" ? row.strategicRiskClass : null,
    governanceDecisionId: typeof row.governanceDecisionId === "string" ? row.governanceDecisionId : null,
    governanceDecision: typeof row.governanceDecision === "string" ? row.governanceDecision : null,
    policyVersion: typeof row.policyVersion === "string" ? row.policyVersion : null,
    approvalStatus,
    status,
    portfolioRelation: String(row.portfolioRelation),
    relationCandidateIds: asStringArray(row.relationCandidateIds),
    limitations: asStringArray(row.limitations),
    validUntil,
    freshness: expired ? "stale" : "current",
    supersedesCandidateId:
      typeof row.supersedesCandidateId === "string" ? row.supersedesCandidateId : null,
    causationClaimed: false,
    causationDisclaimer: STRATEGIC_CANDIDATE_CAUSATION_DISCLAIMER,
    attributionClaimed: false,
    attributionDisclaimer: STRATEGIC_CANDIDATE_ATTRIBUTION_DISCLAIMER,
    executionClaimed: false,
    executionDisclaimer: STRATEGIC_CANDIDATE_EXECUTION_DISCLAIMER,
    missionClaimed: false,
    missionDisclaimer: STRATEGIC_CANDIDATE_MISSION_DISCLAIMER,
    createdAt,
  };
}

/** Seam validator: exact key allowlist + frozen version + disclaimers verbatim. */
export function validateMissionControlProjection(raw: unknown): StrategicMissionControlProjection {
  if (typeof raw !== "object" || raw === null) {
    fail("REASONING_PROJECTION_MALFORMED", "mission-control projection must be an object");
  }
  const keys = Object.keys(raw).sort();
  const expected = [...STRATEGIC_MISSION_CONTROL_PROJECTION_FIELD_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    fail("REASONING_PROJECTION_MALFORMED", "mission-control projection key allowlist mismatch");
  }
  const p = raw as Record<string, unknown>;
  if (p.contractVersion !== STRATEGIC_MISSION_CONTROL_PROJECTION_VERSION) {
    fail("REASONING_PROJECTION_MALFORMED", "mission-control projection version mismatch");
  }
  if (
    p.causationClaimed !== false ||
    p.attributionClaimed !== false ||
    p.executionClaimed !== false ||
    p.missionClaimed !== false
  ) {
    fail(
      "REASONING_PROJECTION_MALFORMED",
      "mission-control projection must never claim causation/attribution/execution/mission authority"
    );
  }
  if (
    p.causationDisclaimer !== STRATEGIC_CANDIDATE_CAUSATION_DISCLAIMER ||
    p.attributionDisclaimer !== STRATEGIC_CANDIDATE_ATTRIBUTION_DISCLAIMER ||
    p.executionDisclaimer !== STRATEGIC_CANDIDATE_EXECUTION_DISCLAIMER ||
    p.missionDisclaimer !== STRATEGIC_CANDIDATE_MISSION_DISCLAIMER
  ) {
    fail("REASONING_PROJECTION_MALFORMED", "mission-control projection disclaimers must be verbatim");
  }
  return raw as unknown as StrategicMissionControlProjection;
}
