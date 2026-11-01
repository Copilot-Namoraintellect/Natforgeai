// ─── R9-C Dependency & Scheduling Intelligence — R9-F governance seam ───
//
// Consumes R9-F mission-governance evidence READ-ONLY for scheduling
// readiness and the governance surface, behind a guarded information-schema
// check (house seam pattern). The upstream `mission_governance_decisions`
// table is canonical at R9-X (0037_r9_mission_control_foundation). Scheduling
// never mints decisions, never creates ALLOW, never calls the execution
// consumption gate on a consumer's behalf and never re-interprets governance
// semantics.
//
// R9-X convergence (BIND #3): F's receipts are immutable — a human-approved
// task action stays REVIEW_REQUIRED with the authorization on the shared
// approval ledger (approval_requests, approvalType "mission_action"). The
// pre-integration seam only honored raw ALLOW rows and could therefore never
// observe a real approval. The seam now implements the frozen gate semantics
// read-only: evidence is satisfied by (a) a current ALLOW decision, or (b) a
// current REVIEW_REQUIRED decision bound to a current approved ledger row
// whose binding re-validates exactly (binding hash, refs, policy version,
// expiry, tenant) — a faithful port of assertMissionActionConsumable's
// approval branch. Approval can never be fabricated: absence of authority
// narrows, never widens.
//
// Fail-closed posture: when the governance table is absent, approval evidence
// degrades to "not satisfied" (tasks stay BLOCKED_APPROVAL) and the schedule
// carries an explicit authority-unavailable limitation.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { MissionSchedulingError, isIsoUtc } from "./mission-scheduling-contract";
import {
  DEFAULT_MISSION_GOVERNANCE_POLICY,
} from "../mission-governance/mission-policy";
import { deriveMissionApprovalBindingHash } from "../mission-governance/mission-governance-contract";

/** Frozen R9-F closed decisions (mission-governance/v1 @ R9-F 1665d2f). */
const MISSION_GOVERNANCE_DECISIONS = new Set(["ALLOW", "REVIEW_REQUIRED", "BLOCK"]);

export interface TaskApprovalEvidence {
  readonly governanceDecisionId: string;
  readonly taskRef: string;
  readonly decision: string;
  readonly validUntil: string | null;
  readonly evaluatedAt: string;
  readonly policyVersion: string | null;
  readonly actionParamsFingerprint: string;
  readonly missionRiskClass: string;
  readonly missionRef: string;
  readonly planRef: string | null;
  readonly subjectClass: string;
  readonly actionType: string;
  readonly businessId: number;
}

export interface MissionSchedulingGovernanceAuthority {
  /**
   * True iff current R9-F authority binds (tenant, business, missionRef,
   * taskRef, subjectClass=TASK): either a current ALLOW receipt, or a
   * REVIEW_REQUIRED receipt whose exact approval binding is current and
   * approved on the shared ledger. Read-only. Absent table ⇒ false.
   */
  resolveTaskApproval(
    userId: number,
    businessId: number,
    missionId: string,
    taskId: string,
    nowIso: string
  ): Promise<boolean>;
  /** Whether the upstream governance authority is reachable at all. */
  isAvailable(): Promise<boolean>;
}

function toIso(value: unknown): string {
  const text = String(value ?? "");
  return isIsoUtc(text) ? text : "";
}

export function shapeGovernanceRow(row: Record<string, unknown>): TaskApprovalEvidence {
  const governanceDecisionId = String(row.governanceDecisionId ?? "");
  if (!/^mgd1:[a-f0-9]{64}$/.test(governanceDecisionId)) {
    throw new MissionSchedulingError("SCHEDULING_INPUT_MALFORMED", "governance row has malformed governanceDecisionId.");
  }
  const decision = String(row.decision ?? "");
  if (!MISSION_GOVERNANCE_DECISIONS.has(decision)) {
    throw new MissionSchedulingError("SCHEDULING_INPUT_MALFORMED", `governance row has unknown decision ${decision}.`);
  }
  const evaluatedAt = toIso(row.evaluatedAt);
  if (!evaluatedAt) {
    throw new MissionSchedulingError("SCHEDULING_INPUT_MALFORMED", `governance ${governanceDecisionId} has malformed evaluatedAt.`);
  }
  const rawValidUntil = row.validUntil;
  return {
    governanceDecisionId,
    taskRef: String(row.taskRef ?? ""),
    decision,
    validUntil: typeof rawValidUntil === "string" && rawValidUntil.length > 0 ? toIso(rawValidUntil) || null : null,
    evaluatedAt,
    policyVersion: typeof row.policyVersion === "string" ? row.policyVersion : null,
    actionParamsFingerprint: String(row.actionParamsFingerprint ?? ""),
    missionRiskClass: String(row.missionRiskClass ?? ""),
    missionRef: String(row.missionRef ?? ""),
    planRef: typeof row.planRef === "string" ? row.planRef : null,
    subjectClass: String(row.subjectClass ?? ""),
    actionType: String(row.actionType ?? ""),
    businessId: Number(row.businessId ?? 0),
  };
}

/** A current ALLOW for the exact bound task satisfies evidence directly. */
export function isApprovalSatisfied(evidence: TaskApprovalEvidence, nowIso: string, userId: number, businessId: number, rowUserId: unknown, rowBusinessId: unknown): boolean {
  if (Number(rowUserId) !== userId || Number(rowBusinessId) !== businessId) return false;
  if (evidence.decision !== "ALLOW") return false;
  if (evidence.validUntil !== null && Date.parse(evidence.validUntil) <= Date.parse(nowIso)) return false;
  return true;
}

interface MissionGovernanceBinding {
  readonly governanceDecisionId: string;
  readonly policyVersion: string;
  readonly actionParamsFingerprint: string;
  readonly missionRiskClass: string;
  readonly missionRef: string;
  readonly planRef: string | null;
  readonly taskRef: string | null;
  readonly subjectClass: string;
  readonly actionType: string;
  readonly businessId: number;
  readonly approvalBindingHash: string;
  readonly expiresAt: string;
}

function parseBinding(context: unknown): MissionGovernanceBinding | null {
  if (typeof context === "string") {
    try {
      context = JSON.parse(context);
    } catch {
      return null;
    }
  }
  if (typeof context !== "object" || context === null) return null;
  const binding = (context as Record<string, unknown>).missionGovernanceBinding;
  if (typeof binding !== "object" || binding === null) return null;
  const b = binding as Record<string, unknown>;
  return {
    governanceDecisionId: String(b.governanceDecisionId ?? ""),
    policyVersion: String(b.policyVersion ?? ""),
    actionParamsFingerprint: String(b.actionParamsFingerprint ?? ""),
    missionRiskClass: String(b.missionRiskClass ?? ""),
    missionRef: String(b.missionRef ?? ""),
    planRef: typeof b.planRef === "string" ? b.planRef : null,
    taskRef: typeof b.taskRef === "string" ? b.taskRef : null,
    subjectClass: String(b.subjectClass ?? ""),
    actionType: String(b.actionType ?? ""),
    businessId: Number(b.businessId ?? 0),
    approvalBindingHash: String(b.approvalBindingHash ?? ""),
    expiresAt: String(b.expiresAt ?? ""),
  };
}

/**
 * Frozen-gate approval branch, read-only (port of assertMissionActionConsumable
 * lines: approved status, tenant equality, exact decision/policy binding,
 * binding-hash re-derivation, ref equality, current policy version, expiry).
 */
export function isApprovedBindingSatisfied(input: {
  evidence: TaskApprovalEvidence;
  approvalRow: Record<string, unknown>;
  nowIso: string;
  userId: number;
  businessId: number;
}): boolean {
  const { evidence, approvalRow, nowIso, userId, businessId } = input;
  if (approvalRow.userId !== undefined && Number(approvalRow.userId) !== userId) return false;
  if (String(approvalRow.status ?? "") !== "approved") return false;
  if (String(approvalRow.approvalType ?? "") !== "mission_action") return false;
  const binding = parseBinding(approvalRow.context);
  if (binding === null) return false;
  if (binding.governanceDecisionId !== evidence.governanceDecisionId) return false;
  if (binding.policyVersion !== evidence.policyVersion) return false;
  if (binding.actionParamsFingerprint !== evidence.actionParamsFingerprint) return false;
  if (
    binding.missionRef !== evidence.missionRef ||
    binding.planRef !== evidence.planRef ||
    binding.taskRef !== evidence.taskRef ||
    binding.subjectClass !== evidence.subjectClass ||
    binding.actionType !== evidence.actionType ||
    binding.businessId !== evidence.businessId ||
    binding.missionRiskClass !== evidence.missionRiskClass
  ) {
    return false;
  }
  const expectedHash = deriveMissionApprovalBindingHash({
    governanceDecisionId: evidence.governanceDecisionId,
    policyVersion: evidence.policyVersion ?? "",
    actionParamsFingerprint: evidence.actionParamsFingerprint,
    missionRiskClass: evidence.missionRiskClass,
  });
  if (binding.approvalBindingHash !== expectedHash) return false;
  if (DEFAULT_MISSION_GOVERNANCE_POLICY.policyVersion !== evidence.policyVersion) return false;
  if (!isIsoUtc(binding.expiresAt) || Date.parse(binding.expiresAt) <= Date.parse(nowIso)) return false;
  void businessId; // tenant equality enforced on the decision row by the caller
  return true;
}

// ─── Production port: raw SQL behind a guarded information-schema check ───

type SqlExecutor = { execute: ReturnType<typeof getDb>["execute"] };

function normalizeSqlRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    const first = result[0];
    if (Array.isArray(first)) return first as Array<Record<string, unknown>>;
    if (first && typeof first === "object") return [first as Record<string, unknown>];
    return [];
  }
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

async function governanceTableExists(db: SqlExecutor): Promise<boolean> {
  try {
    const rows = normalizeSqlRows(
      await db.execute(sql`
        SELECT COUNT(*) AS c FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mission_governance_decisions'
      `)
    );
    const first = rows[0];
    const count = first ? Number(first.c ?? 0) : 0;
    return Number.isInteger(count) && count > 0;
  } catch {
    return false;
  }
}

/** Injected production port. Never writes. */
export function createMissionGovernanceAuthority(
  executor?: SqlExecutor
): MissionSchedulingGovernanceAuthority {
  const db = executor ?? getDb();
  let availability: Promise<boolean> | null = null;
  const available = () => {
    availability ??= governanceTableExists(db).catch(() => false);
    return availability;
  };
  const resolveApprovedLedgerRow = async (
    userId: number,
    governanceDecisionId: string
  ): Promise<Record<string, unknown> | null> => {
    const rows = normalizeSqlRows(
      await db.execute(sql`
        SELECT id, userId, status, approvalType, context FROM approval_requests
        WHERE userId = ${userId} AND approvalType = 'mission_action'
        ORDER BY id DESC
        LIMIT 20
      `)
    );
    for (const row of rows) {
      const binding = parseBinding(row.context);
      if (binding && binding.governanceDecisionId === governanceDecisionId) return row;
    }
    return null;
  };
  return {
    async resolveTaskApproval(userId, businessId, missionId, taskId, nowIso) {
      if (!(await available())) return false;
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT governanceDecisionId, taskRef, decision, validUntil, evaluatedAt, userId, businessId,
                 policyVersion, actionParamsFingerprint, missionRiskClass, missionRef, planRef,
                 subjectClass, actionType
          FROM mission_governance_decisions
          WHERE userId = ${userId}
            AND businessId = ${businessId}
            AND missionRef = ${missionId}
            AND taskRef = ${taskId}
            AND subjectClass IN ('TASK', 'EXECUTION_STEP')
            AND decision IN ('ALLOW', 'REVIEW_REQUIRED')
          ORDER BY evaluatedAt DESC
          LIMIT 50
        `)
      );
      for (const row of rows) {
        const evidence = shapeGovernanceRow(row);
        if (Number(row.userId) !== userId || Number(row.businessId) !== businessId) continue;
        if (isApprovalSatisfied(evidence, nowIso, userId, businessId, row.userId, row.businessId)) {
          return true;
        }
        if (evidence.decision === "REVIEW_REQUIRED") {
          const approvalRow = await resolveApprovedLedgerRow(userId, evidence.governanceDecisionId);
          if (
            approvalRow &&
            isApprovedBindingSatisfied({ evidence, approvalRow, nowIso, userId, businessId })
          ) {
            return true;
          }
        }
      }
      return false;
    },
    async isAvailable() {
      return available();
    },
  };
}

// ─── In-memory port over planted raw rows (identical validation) ───

export interface FakeGovernanceRow {
  readonly row: Record<string, unknown>;
}

export function createInMemoryMissionGovernanceAuthority(
  rows: readonly FakeGovernanceRow[]
): MissionSchedulingGovernanceAuthority {
  const isApprovalRow = (row: Record<string, unknown>) =>
    typeof row.approvalType === "string" || row.context !== undefined;
  return {
    async resolveTaskApproval(userId, businessId, missionId, taskId, nowIso) {
      const decisionHits = rows.filter(
        (r) =>
          !isApprovalRow(r.row) &&
          r.row.userId === userId &&
          r.row.businessId === businessId &&
          r.row.missionRef === missionId &&
          r.row.taskRef === taskId &&
          (r.row.subjectClass === "TASK" || r.row.subjectClass === "EXECUTION_STEP") &&
          (r.row.decision === "ALLOW" || r.row.decision === "REVIEW_REQUIRED")
      );
      for (const hit of decisionHits) {
        const evidence = shapeGovernanceRow(hit.row);
        if (isApprovalSatisfied(evidence, nowIso, userId, businessId, hit.row.userId, hit.row.businessId)) {
          return true;
        }
        if (evidence.decision === "REVIEW_REQUIRED") {
          const approvalHit = rows.find(
            (r) =>
              isApprovalRow(r.row) &&
              r.row.userId === userId &&
              r.row.approvalType === "mission_action" &&
              parseBinding(r.row.context)?.governanceDecisionId === evidence.governanceDecisionId
          );
          if (
            approvalHit &&
            isApprovedBindingSatisfied({ evidence, approvalRow: approvalHit.row, nowIso, userId, businessId })
          ) {
            return true;
          }
        }
      }
      return false;
    },
    async isAvailable() {
      return true;
    },
  };
}
