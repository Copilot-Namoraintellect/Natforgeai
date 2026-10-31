// ─── R9-A Mission Authority — R8 handoff binding seam (A6) ───
//
// Consumes the frozen R8-E read-only surface and revalidates it end to end
// before ANY mission formation. The seam is the ONLY eligibility path
// (contract §9):
//
//   1. Load the durable candidate row for this tenant + business (raw SQL,
//      guarded information-schema check; house seam pattern).
//   2. Rebuild the verbatim 37-key strategic-intelligence-to-mission-control/v1
//      projection with R8-E's frozen builder and validate it exactly —
//      any extra/missing key, wrong version or non-verbatim disclaimer is a
//      tampered projection and fails closed.
//   3. Re-derive the approval view from the shared ledger (read-only).
//   4. Run R8-E's frozen R8-F consumption gate (assertCandidateConsumable) —
//      BLOCK terminal, forged/expired/edited approvals fail closed, verdict
//      scope RECOMMENDATION_ONLY.
//   5. Enforce freshness/status eligibility with the closed rejection set.
//
// No R8 projection is mutated; no R8 recommendation is ever strengthened.
// There is deliberately NO second governance engine and NO EXECUTE outcome.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  MISSION_AUTHORITY_BOUND_VERSIONS,
  fail,
} from "./mission-authority-contract";
import {
  buildMissionControlProjection,
  validateMissionControlProjection,
  type StrategicMissionControlProjection,
} from "../strategic-opportunity-risk/strategic-opportunity-risk-projection";
import {
  assertCandidateConsumable,
  type StrategicGovernanceEnginePort,
  type StrategicOpportunityRiskApprovalReadPort,
} from "../strategic-opportunity-risk/strategic-opportunity-risk-governance-seam";
import { deriveApprovalStatus } from "../strategic-opportunity-risk/strategic-opportunity-risk-reasoning-seam";
import { StrategicOpportunityRiskError } from "../strategic-opportunity-risk/strategic-opportunity-risk-contract";

// ─── Validated governed source view ───

export interface GovernedCandidateView {
  readonly candidateId: string;
  readonly businessId: number;
  readonly candidateKind: string;
  readonly candidateType: string;
  readonly reasoningIds: readonly string[];
  readonly priorityClass: string;
  readonly priorityScore: number;
  readonly strategicRiskClass: string;
  readonly confidenceClass: string;
  readonly status: string;
  readonly validUntil: string | null;
  readonly limitations: readonly string[];
  readonly governanceDecisionId: string | null;
  readonly governanceDecision: string | null;
  readonly policyVersion: string | null;
  readonly approvalStatus: "none" | "pending" | "approved" | "rejected";
  readonly candidateFingerprint: string;
  readonly supersedesCandidateId: string | null;
  /** Verbatim validated 37-key projection bound into the mission record. */
  readonly projection: StrategicMissionControlProjection;
}

// ─── Port: durable candidate row read (raw SQL; read-only) ───

export interface MissionCandidateRowPort {
  /** Load the durable candidate row; null when absent/unavailable. */
  getCandidateRow(input: {
    userId: number;
    businessId: number;
    candidateId: string;
  }): Promise<Record<string, unknown> | null>;
}

type Db = ReturnType<typeof getDb>;

async function candidatesTableAvailable(db: Db): Promise<boolean> {
  try {
    const result = (await db.execute(sql`
      SELECT COUNT(*) AS c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'strategic_opportunity_risk_candidates'
    `)) as unknown;
    const rows = Array.isArray(result)
      ? (result as unknown[])
      : Array.isArray((result as { rows?: unknown[] }).rows)
        ? (result as { rows: unknown[] }).rows
        : [];
    const first = rows[0] as unknown;
    const count =
      first && typeof first === "object"
        ? Number((first as Record<string, unknown>).c ?? (first as unknown[])[0])
        : 0;
    return Number.isInteger(count) && count > 0;
  } catch {
    return false;
  }
}

function normalizeRawRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

/** Production binding over the canonical R8-E durable rows (read-only). */
export function createRawSqlMissionCandidateRowPort(db: Db): MissionCandidateRowPort {
  return {
    async getCandidateRow(input) {
      if (!(await candidatesTableAvailable(db))) return null;
      const result: unknown = await db.execute(sql`
        SELECT * FROM strategic_opportunity_risk_candidates
        WHERE userId = ${input.userId} AND candidateId = ${input.candidateId}
        LIMIT 1
      `);
      const rows = normalizeRawRows(result);
      const row = rows[0];
      if (!row) return null;
      if (row.userId !== input.userId || row.businessId !== input.businessId) return null;
      return row as Record<string, unknown>;
    },
  };
}

/**
 * TEST-ONLY double over planted durable candidate rows (same frozen
 * validators; absence of a table guard mirrors the production null path).
 */
export function createInMemoryMissionCandidateRowPort(
  rows: readonly Record<string, unknown>[]
): MissionCandidateRowPort {
  return {
    async getCandidateRow(input) {
      const found = rows.find(
        (r) =>
          r.userId === input.userId &&
          r.businessId === input.businessId &&
          r.candidateId === input.candidateId
      );
      return found ?? null;
    },
  };
}

// ─── Eligibility resolution (the ONLY path; fail closed) ───

export interface MissionCandidateAuthorityDeps {
  /** Read-only approval ledger view (production raw-SQL / in-memory). */
  readonly approvals: StrategicOpportunityRiskApprovalReadPort;
  /** R8-F governance engine port (canonical registered engine / test double). */
  readonly governance: Pick<StrategicGovernanceEnginePort, "getCurrentPolicyVersion">;
  /** Injected clock for determinism; defaults to wall time. */
  readonly now?: () => Date;
}

function asStringArray(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(String);
}

function mapGateFailure(reason: string, permanent: boolean): never {
  switch (reason) {
    case "RECOMMENDATION_BLOCKED_BY_POLICY":
      fail("SOURCE_CANDIDATE_BLOCKED", "source recommendation is blocked by R8-F policy (terminal)");
    case "APPROVAL_REJECTED_BY_HUMAN":
      fail("SOURCE_CANDIDATE_NOT_GOVERNED", "source recommendation approval was rejected by a human (terminal)");
    case "EXPIRED_DECISION":
      fail("SOURCE_CANDIDATE_EXPIRED", "the bound R8-F governance decision has expired");
    case "STALE_POLICY_VERSION":
      fail("SOURCE_CANDIDATE_NOT_GOVERNED", "the bound governance policy version is stale; the source requires R8 revalidation");
    case "APPROVAL_NOT_FOUND":
    case "APPROVAL_PENDING":
      fail("SOURCE_CANDIDATE_NOT_GOVERNED", "source recommendation requires a bound human approval that is not currently valid");
    case "APPROVAL_BINDING_MISMATCH":
      fail("SOURCE_CANDIDATE_NOT_GOVERNED", "source recommendation approval binding fails F5 verification (forged/edited/expired)");
    case "MALFORMED_CLOCK":
      fail("SOURCE_PROJECTION_MALFORMED", "eligibility clock is malformed");
    default:
      fail(
        "SOURCE_CANDIDATE_NOT_GOVERNED",
        `source recommendation is not currently governed (${reason}, permanent=${permanent})`
      );
  }
}

/**
 * Resolve + revalidate the governed source candidate for mission formation.
 * Rejects: unknown R8 candidate, ungoverned candidate, wrong tenant,
 * wrong business, stale candidate, invalid approval state, expired
 * recommendation, tampered evidence/projection (contract §3 rejection set).
 */
export async function resolveGovernedCandidate(input: {
  userId: number;
  businessId: number;
  candidateId: string;
  row: Record<string, unknown> | null;
  deps: MissionCandidateAuthorityDeps;
}): Promise<GovernedCandidateView> {
  const { userId, businessId, candidateId, row, deps } = input;
  const nowMs = deps.now ? deps.now().getTime() : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (!row) {
    // Cross-tenant / cross-business / unknown are indistinguishable — fail closed.
    fail(
      "UNKNOWN_SOURCE_CANDIDATE",
      `source candidate ${candidateId} does not resolve for this tenant + business`
    );
  }
  if (row.userId !== userId) {
    fail("UNKNOWN_SOURCE_CANDIDATE", "source candidate does not resolve for this tenant");
  }
  if (row.businessId !== businessId) {
    fail("SOURCE_SCOPE_MISMATCH", "source candidate belongs to a different business scope");
  }
  if (typeof row.candidateType !== "string" || typeof row.candidateKind !== "string") {
    fail("SOURCE_PROJECTION_MALFORMED", "source candidate row is malformed (kind/type)");
  }

  // 2. Rebuild + validate the verbatim frozen projection (tamper-evident).
  const governanceRecord =
    typeof row.governanceRecord === "object" && row.governanceRecord !== null
      ? (row.governanceRecord as Record<string, unknown>)
      : null;
  const approvalRows = await deps.approvals.listApprovalsForDecision({
    userId,
    governanceDecisionId:
      typeof row.governanceDecisionId === "string" ? row.governanceDecisionId : "",
  });
  let approvalStatus: "none" | "pending" | "approved" | "rejected" = "none";
  if (
    governanceRecord &&
    typeof governanceRecord.policyVersion === "string" &&
    typeof governanceRecord.proposalFingerprint === "string" &&
    typeof governanceRecord.evidenceFingerprint === "string"
  ) {
    try {
      approvalStatus = deriveApprovalStatus({
        decision: {
          governanceDecisionId: String(row.governanceDecisionId ?? ""),
          policyVersion: governanceRecord.policyVersion,
          proposalFingerprint: governanceRecord.proposalFingerprint,
          evidenceFingerprint: governanceRecord.evidenceFingerprint,
        },
        bindings: approvalRows.map((a) => a.binding),
        approvalStatuses: approvalRows.map((a) => a.status),
      });
    } catch (err) {
      if (err instanceof StrategicOpportunityRiskError) {
        fail("SOURCE_CANDIDATE_NOT_GOVERNED", `source approval view failed verification: ${err.message}`);
      }
      throw err;
    }
  }

  let projection: StrategicMissionControlProjection;
  try {
    projection = validateMissionControlProjection(
      buildMissionControlProjection({ row, approvalStatus, nowMs })
    );
  } catch (err) {
    if (err instanceof StrategicOpportunityRiskError) {
      fail("SOURCE_PROJECTION_MALFORMED", `source projection failed frozen validation: ${err.message}`);
    }
    throw err;
  }

  // 3. Status eligibility (closed).
  if (projection.status === "BLOCKED") {
    fail("SOURCE_CANDIDATE_BLOCKED", "source candidate is blocked (terminal)");
  }
  if (["SUPERSEDED", "CONTRADICTED", "INVALIDATED", "RESOLVED"].includes(projection.status)) {
    fail("SOURCE_CANDIDATE_NOT_GOVERNED", `source candidate status ${projection.status} is not eligible`);
  }
  if (projection.status === "STALE") {
    fail("SOURCE_CANDIDATE_STALE", "source candidate is stale; R8-E re-evaluation is required first");
  }

  // 4. Freshness / expiry.
  if (projection.freshness !== "current") {
    fail("SOURCE_CANDIDATE_EXPIRED", "source recommendation validity window has lapsed");
  }

  // 5. Frozen R8-F consumption gate (the ONLY governance eligibility path).
  const verdict = assertCandidateConsumable({
    decision: {
      governanceDecisionId:
        typeof row.governanceDecisionId === "string" ? row.governanceDecisionId : "",
      decision: (row.governanceDecision ?? "BLOCK") as
        | "ALLOW_RECOMMENDATION"
        | "REVIEW_REQUIRED"
        | "BLOCK",
      policyVersion: typeof row.policyVersion === "string" ? row.policyVersion : "",
      validUntil: typeof row.validUntil === "string" ? row.validUntil : null,
      evidenceFingerprint:
        typeof governanceRecord?.evidenceFingerprint === "string"
          ? governanceRecord.evidenceFingerprint
          : "",
      proposalFingerprint:
        typeof governanceRecord?.proposalFingerprint === "string"
          ? governanceRecord.proposalFingerprint
          : "",
    },
    approvals: approvalRows,
    currentPolicyVersion: deps.governance.getCurrentPolicyVersion(),
    now: nowIso,
  });
  if (!verdict.consumable) {
    mapGateFailure(verdict.reason, verdict.permanent);
  }
  if (verdict.authorityScope !== "RECOMMENDATION_ONLY") {
    fail("SOURCE_PROJECTION_MALFORMED", "governance consumption scope must be RECOMMENDATION_ONLY");
  }

  return {
    candidateId: String(row.candidateId),
    businessId: Number(row.businessId),
    candidateKind: String(row.candidateKind),
    candidateType: String(row.candidateType),
    reasoningIds: asStringArray(row.reasoningIds),
    priorityClass: String(row.priorityClass),
    priorityScore: Number(row.priorityScore),
    strategicRiskClass: String(row.strategicRiskClass ?? projection.strategicRiskClass ?? ""),
    confidenceClass: String(row.confidenceClass),
    status: projection.status,
    validUntil: projection.validUntil,
    limitations: projection.limitations,
    governanceDecisionId: projection.governanceDecisionId,
    governanceDecision: projection.governanceDecision,
    policyVersion: projection.policyVersion,
    approvalStatus: projection.approvalStatus,
    candidateFingerprint: typeof row.candidateFingerprint === "string" ? row.candidateFingerprint : "",
    supersedesCandidateId:
      typeof row.supersedesCandidateId === "string" ? row.supersedesCandidateId : null,
    projection,
  };
}

void MISSION_AUTHORITY_BOUND_VERSIONS;
