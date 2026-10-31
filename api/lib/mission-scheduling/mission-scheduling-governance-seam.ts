// ─── R9-C Dependency & Scheduling Intelligence — R9-F governance seam ───
//
// Consumes R9-F mission-governance evidence READ-ONLY for scheduling
// readiness and the governance surface, behind a guarded information-schema
// check (house seam pattern). The upstream `mission_governance_decisions`
// table is provisional on the frozen R9-F branch (1665d2f); R9-X owns
// canonical binding. Scheduling reads ALLOW evidence for task-bound
// approvals; it never mints decisions, never creates ALLOW, never calls the
// execution consumption gate on a consumer's behalf and never re-interprets
// governance semantics.
//
// Fail-closed posture: when the governance table is absent, approval evidence
// degrades to "not satisfied" (tasks stay BLOCKED_APPROVAL) and the schedule
// carries an explicit authority-unavailable limitation. Approval can never be
// fabricated — absence of authority narrows, never widens.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { MissionSchedulingError, isIsoUtc } from "./mission-scheduling-contract";

/** Frozen R9-F closed decisions (mission-governance/v1 @ 1665d2f). */
const MISSION_GOVERNANCE_DECISIONS = new Set(["ALLOW", "REVIEW_REQUIRED", "BLOCK"]);

export interface TaskApprovalEvidence {
  readonly governanceDecisionId: string;
  readonly taskRef: string;
  readonly decision: string;
  readonly validUntil: string | null;
  readonly evaluatedAt: string;
}

export interface MissionSchedulingGovernanceAuthority {
  /**
   * True iff a current, unexpired R9-F ALLOW binds (tenant, missionRef,
   * taskRef, subjectClass=TASK). Read-only. Absent table ⇒ false.
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
  };
}

/** Evidence is satisfied only by a current ALLOW for the exact bound task. */
export function isApprovalSatisfied(evidence: TaskApprovalEvidence, nowIso: string, userId: number, businessId: number, rowUserId: unknown, rowBusinessId: unknown): boolean {
  if (Number(rowUserId) !== userId || Number(rowBusinessId) !== businessId) return false;
  if (evidence.decision !== "ALLOW") return false;
  if (evidence.validUntil !== null && Date.parse(evidence.validUntil) <= Date.parse(nowIso)) return false;
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
  return {
    async resolveTaskApproval(userId, businessId, missionId, taskId, nowIso) {
      if (!(await available())) return false;
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT governanceDecisionId, taskRef, decision, validUntil, evaluatedAt, userId, businessId
          FROM mission_governance_decisions
          WHERE userId = ${userId}
            AND businessId = ${businessId}
            AND missionRef = ${missionId}
            AND taskRef = ${taskId}
            AND subjectClass = 'TASK'
            AND decision = 'ALLOW'
          ORDER BY evaluatedAt DESC
          LIMIT 20
        `)
      );
      for (const row of rows) {
        const evidence = shapeGovernanceRow(row);
        if (isApprovalSatisfied(evidence, nowIso, userId, businessId, row.userId, row.businessId)) {
          return true;
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
  return {
    async resolveTaskApproval(userId, businessId, missionId, taskId, nowIso) {
      const hits = rows.filter(
        (r) =>
          r.row.userId === userId &&
          r.row.businessId === businessId &&
          r.row.missionRef === missionId &&
          r.row.taskRef === taskId &&
          r.row.subjectClass === "TASK" &&
          r.row.decision === "ALLOW"
      );
      for (const hit of hits) {
        const evidence = shapeGovernanceRow(hit.row);
        if (isApprovalSatisfied(evidence, nowIso, userId, businessId, hit.row.userId, hit.row.businessId)) {
          return true;
        }
      }
      return false;
    },
    async isAvailable() {
      return true;
    },
  };
}
