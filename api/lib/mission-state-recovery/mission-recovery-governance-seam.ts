// ─── R9-E Mission State & Recovery — R9-F recovery governance seam ───
//
// Consumes R9-F mission-governance authority READ-ONLY for the exact recovery
// consumption gate (mission-governance-to-execution/v1 @ R9-F 1665d2f), behind
// a guarded information-schema check (house seam pattern). The gate logic
// below is a FAITHFUL PORT of the frozen R9-F assertMissionActionConsumable
// semantics (contract §10): exactness first, ALLOW validity window + policy
// version, BLOCK never consumable, REVIEW_REQUIRED approval binding
// re-validation (decision id, policy version, approvalBindingHash = sha256({
// v:1, governanceDecisionId, policyVersion, actionParamsFingerprint,
// missionRiskClass}), params fingerprint, refs, risk class, business, tenant,
// expiry). R9-X binds this port to the real R9-F engine at integration; R9-E
// never mints decisions, approvals or ALLOW, never re-interprets governance
// semantics, never writes R9-F tables.
//
// RECOVERY_REQUIRES_FRESH_REVIEW: under the default policy every
// RECOVERY_ACTION / ESCALATION subject floors at REVIEW_REQUIRED — no
// autonomous recovery exists anywhere in this stream.
//
// Absent authority (table missing) fails closed: GOVERNANCE_DECISION_NOT_FOUND
// is never fabricated; the service surfaces MISSION_STATE_AUTHORITY_UNAVAILABLE.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { canonicalJson, sha256Hex } from "../conversion/conversion-contract";
import {
  BOUND_MISSION_RECOVERY_POLICY_VERSION,
  GOVERNANCE_DECISION_ID_PATTERN,
  MISSION_STATE_AUTHORITY_UNAVAILABLE,
  MISSION_STATE_INPUT_MALFORMED,
  MissionStateUpstreamError,
  isIsoUtc,
} from "./mission-state-recovery-contract";

// ─── Row views ───

export interface RecoveryGovernanceDecisionView {
  readonly governanceDecisionId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly missionRef: string;
  readonly planRef: string | null;
  readonly taskRef: string | null;
  readonly subjectClass: string;
  readonly actionType: string;
  readonly actionParamsFingerprint: string;
  readonly missionRiskClass: string;
  readonly policyVersion: string | null;
  readonly decision: string;
  readonly reasonCodes: readonly string[];
  readonly approvalBinding: { readonly approvalBindingHash: string; readonly expiresAt: string } | null;
  readonly validUntil: string | null;
  readonly evaluatedAt: string;
}

export interface RecoveryApprovalLedgerView {
  readonly id: number;
  readonly userId: number;
  readonly status: "pending" | "approved" | "rejected" | "edited";
  readonly context: unknown;
}

export interface RecoveryGovernanceAuthority {
  resolveDecision(userId: number, governanceDecisionId: string): Promise<RecoveryGovernanceDecisionView | null>;
  resolveDecisionGlobal(governanceDecisionId: string): Promise<{ userId: number; businessId: number } | null>;
  resolveApprovalForDecision(userId: number, governanceDecisionId: string): Promise<RecoveryApprovalLedgerView | null>;
  /** Bound policy version (code-level registry artefact; R9-F owns policy). */
  currentPolicyVersion(): Promise<string>;
}

// ─── Shared row shaper (identical semantics in production + in-memory) ───

const DECISIONS = new Set(["ALLOW", "REVIEW_REQUIRED", "BLOCK"]);

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function shapeGovernanceDecisionRow(row: Record<string, unknown>): RecoveryGovernanceDecisionView {
  const governanceDecisionId = String(row.governanceDecisionId ?? "");
  if (!GOVERNANCE_DECISION_ID_PATTERN.test(governanceDecisionId)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, "governance row has malformed governanceDecisionId.");
  }
  const decision = String(row.decision ?? "");
  if (!DECISIONS.has(decision)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, `governance row has unknown decision ${decision}.`);
  }
  const evaluatedAt = String(row.evaluatedAt ?? "");
  if (!isIsoUtc(evaluatedAt)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, `governance ${governanceDecisionId} has malformed evaluatedAt.`);
  }
  const rawBinding = row.approvalBinding;
  let approvalBinding: RecoveryGovernanceDecisionView["approvalBinding"] = null;
  if (rawBinding !== null && rawBinding !== undefined) {
    const b = (typeof rawBinding === "string" ? JSON.parse(rawBinding) : rawBinding) as Record<string, unknown>;
    approvalBinding = {
      approvalBindingHash: String(b.approvalBindingHash ?? ""),
      expiresAt: String(b.expiresAt ?? ""),
    };
  }
  const rawValidUntil = row.validUntil;
  return {
    governanceDecisionId,
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    missionRef: String(row.missionRef ?? ""),
    planRef: typeof row.planRef === "string" && row.planRef.length > 0 ? row.planRef : null,
    taskRef: typeof row.taskRef === "string" && row.taskRef.length > 0 ? row.taskRef : null,
    subjectClass: String(row.subjectClass ?? ""),
    actionType: String(row.actionType ?? ""),
    actionParamsFingerprint: String(row.actionParamsFingerprint ?? ""),
    missionRiskClass: String(row.missionRiskClass ?? ""),
    policyVersion: typeof row.policyVersion === "string" && row.policyVersion.length > 0 ? row.policyVersion : null,
    decision,
    reasonCodes: parseJsonArray(row.reasonCodes),
    approvalBinding,
    validUntil: typeof rawValidUntil === "string" && rawValidUntil.length > 0 ? rawValidUntil : null,
    evaluatedAt,
  };
}

// ─── The frozen gate (faithful port of R9-F assertMissionActionConsumable) ───

export type RecoveryConsumptionVerdict =
  | {
      readonly consumable: true;
      readonly authorization: {
        readonly authorityScope: "MISSION_ACTION";
        readonly governanceDecisionId: string;
        readonly businessId: number;
        readonly missionRef: string;
        readonly planRef: string | null;
        readonly taskRef: string | null;
        readonly subjectClass: string;
        readonly actionType: string;
        readonly approvalRequestId: number | null;
        readonly policyVersion: string;
        readonly missionRiskClass: string;
        readonly authorizedAt: string;
        readonly expiresAt: string;
      };
    }
  | { readonly consumable: false; readonly reason: string; readonly permanent: boolean };

function deny(reason: string, permanent = false): RecoveryConsumptionVerdict {
  return { consumable: false, reason, permanent };
}

/** R9-F's exact approval-binding hash derivation (frozen F4). */
export function deriveGovernanceApprovalBindingHash(input: {
  governanceDecisionId: string;
  policyVersion: string;
  actionParamsFingerprint: string;
  missionRiskClass: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      governanceDecisionId: input.governanceDecisionId,
      policyVersion: input.policyVersion,
      actionParamsFingerprint: input.actionParamsFingerprint,
      missionRiskClass: input.missionRiskClass,
    })
  );
}

export interface ExpectedRecoveryAction {
  readonly subjectClass: string;
  readonly actionType: string;
  readonly missionRef: string;
  readonly planRef: string | null;
  readonly taskRef: string | null;
}

/**
 * The single recovery-consumption gate (frozen semantics). The expected action
 * comes from R9-E's own server-side recovery context — never from client
 * authorization material. No client-provided ALLOW exists anywhere: the
 * verdict derives only from durable rows + the bound policy version.
 */
export function assertRecoveryActionConsumable(input: {
  decision: RecoveryGovernanceDecisionView;
  approval: RecoveryApprovalLedgerView | null;
  expectedAction: ExpectedRecoveryAction;
  /** Fingerprint already bound into the durable recovery candidate. */
  expectedActionParamsFingerprint: string;
  currentPolicyVersion: string | null;
  now: string;
}): RecoveryConsumptionVerdict {
  const { decision, approval, expectedAction, expectedActionParamsFingerprint, currentPolicyVersion, now } = input;
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, `now must be a valid ISO timestamp, got ${String(now)}`);
  }

  // Exactness first: cross-subject / cross-mission / cross-task / modified
  // parameters all fail closed (frozen contract §10).
  if (
    expectedAction.subjectClass !== decision.subjectClass ||
    expectedAction.actionType !== decision.actionType ||
    expectedAction.missionRef !== decision.missionRef ||
    expectedAction.planRef !== decision.planRef ||
    expectedAction.taskRef !== decision.taskRef ||
    expectedActionParamsFingerprint !== decision.actionParamsFingerprint
  ) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }

  if (decision.decision === "ALLOW") {
    if (currentPolicyVersion === null || decision.policyVersion === null || currentPolicyVersion !== decision.policyVersion) {
      return deny("STALE_POLICY_VERSION");
    }
    if (decision.validUntil !== null && Date.parse(decision.validUntil) <= nowMs) {
      return deny("EXPIRED_DECISION");
    }
    return {
      consumable: true,
      authorization: {
        authorityScope: "MISSION_ACTION",
        governanceDecisionId: decision.governanceDecisionId,
        businessId: decision.businessId,
        missionRef: decision.missionRef,
        planRef: decision.planRef,
        taskRef: decision.taskRef,
        subjectClass: decision.subjectClass,
        actionType: decision.actionType,
        approvalRequestId: null,
        policyVersion: decision.policyVersion,
        missionRiskClass: decision.missionRiskClass,
        authorizedAt: now,
        expiresAt: decision.validUntil ?? "",
      },
    };
  }

  if (decision.decision === "BLOCK") {
    return deny(decision.reasonCodes[0] ?? "MISSION_BLOCKED_BY_POLICY", true);
  }

  // REVIEW_REQUIRED
  if (approval === null) return deny("APPROVAL_NOT_FOUND");
  if (approval.status === "pending") return deny("APPROVAL_PENDING");
  if (approval.status === "rejected") return deny("APPROVAL_REJECTED_BY_HUMAN", true);
  if (approval.status === "edited") return deny("APPROVAL_BINDING_MISMATCH");

  // Agent self-approval guard: the approval row must belong to the same
  // tenant as the decision (independent human presence for the approve act
  // itself is R9-F's OTP review challenge).
  if (approval.userId !== decision.userId) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }

  const binding = readMissionApprovalBinding(approval.context);
  if (
    binding === null ||
    binding.governanceDecisionId !== decision.governanceDecisionId ||
    binding.policyVersion !== decision.policyVersion
  ) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  const expectedHash = deriveGovernanceApprovalBindingHash({
    governanceDecisionId: decision.governanceDecisionId,
    policyVersion: decision.policyVersion ?? "",
    actionParamsFingerprint: decision.actionParamsFingerprint,
    missionRiskClass: decision.missionRiskClass,
  });
  if (binding.approvalBindingHash !== expectedHash) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  if (binding.actionParamsFingerprint !== decision.actionParamsFingerprint) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  if (
    binding.missionRef !== decision.missionRef ||
    binding.planRef !== decision.planRef ||
    binding.taskRef !== decision.taskRef ||
    binding.subjectClass !== decision.subjectClass ||
    binding.actionType !== decision.actionType ||
    binding.businessId !== decision.businessId ||
    binding.missionRiskClass !== decision.missionRiskClass
  ) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  if (currentPolicyVersion === null || decision.policyVersion === null || currentPolicyVersion !== decision.policyVersion) {
    return deny("STALE_POLICY_VERSION");
  }
  if (!isIsoUtc(binding.expiresAt) || Date.parse(binding.expiresAt) <= nowMs) {
    return deny("EXPIRED_APPROVAL");
  }

  return {
    consumable: true,
    authorization: {
      authorityScope: "MISSION_ACTION",
      governanceDecisionId: decision.governanceDecisionId,
      businessId: decision.businessId,
      missionRef: decision.missionRef,
      planRef: decision.planRef,
      taskRef: decision.taskRef,
      subjectClass: decision.subjectClass,
      actionType: decision.actionType,
      approvalRequestId: approval.id,
      policyVersion: decision.policyVersion,
      missionRiskClass: decision.missionRiskClass,
      authorizedAt: now,
      expiresAt: binding.expiresAt,
    },
  };
}

/** Minimal durable binding persisted in approval_requests.context (frozen F4). */
export interface MissionGovernanceApprovalBindingRecord {
  readonly contractVersion: string;
  readonly governanceDecisionId: string;
  readonly businessId: number;
  readonly missionRef: string;
  readonly planRef: string | null;
  readonly taskRef: string | null;
  readonly subjectClass: string;
  readonly actionType: string;
  readonly actionParamsFingerprint: string;
  readonly missionRiskClass: string;
  readonly policyVersion: string;
  readonly approvalBindingHash: string;
  readonly expiresAt: string;
}

export function readMissionApprovalBinding(context: unknown): MissionGovernanceApprovalBindingRecord | null {
  if (typeof context !== "object" || context === null) return null;
  const binding = (context as Record<string, unknown>).missionGovernanceBinding;
  if (typeof binding !== "object" || binding === null) return null;
  const b = binding as Record<string, unknown>;
  if (typeof b.governanceDecisionId !== "string" || typeof b.policyVersion !== "string") return null;
  return b as unknown as MissionGovernanceApprovalBindingRecord;
}

// ─── Production port: raw SQL behind guarded information-schema checks ───

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

export class RecoveryGovernanceUnavailable extends MissionStateUpstreamError {
  constructor(detail: string) {
    super(
      MISSION_STATE_AUTHORITY_UNAVAILABLE,
      `recovery governance authority unavailable (${detail}); mission state recovery fails closed.`
    );
    this.name = "RecoveryGovernanceUnavailable";
  }
}

/** Injected production port. Never writes. Absent authority ⇒ throws. */
export function createRecoveryGovernanceAuthority(executor?: SqlExecutor): RecoveryGovernanceAuthority {
  const db = executor ?? getDb();

  async function decisionsTableExists(): Promise<boolean> {
    try {
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT COUNT(*) AS c FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mission_governance_decisions'
        `)
      );
      const first = rows[0];
      return Number(first ? Number(first.c ?? 0) : 0) > 0;
    } catch {
      return false;
    }
  }

  return {
    async resolveDecision(userId, governanceDecisionId) {
      if (!GOVERNANCE_DECISION_ID_PATTERN.test(governanceDecisionId)) return null;
      if (!(await decisionsTableExists())) throw new RecoveryGovernanceUnavailable("table mission_governance_decisions missing");
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT governanceDecisionId, userId, businessId, missionRef, planRef, taskRef,
                 subjectClass, actionType, actionParamsFingerprint, missionRiskClass,
                 policyVersion, decision, reasonCodes, approvalBinding, validUntil, evaluatedAt
          FROM mission_governance_decisions
          WHERE userId = ${userId} AND governanceDecisionId = ${governanceDecisionId} LIMIT 1
        `)
      );
      const row = rows[0];
      if (!row) return null;
      const view = shapeGovernanceDecisionRow(row);
      return view.userId === userId ? view : null;
    },
    async resolveDecisionGlobal(governanceDecisionId) {
      if (!GOVERNANCE_DECISION_ID_PATTERN.test(governanceDecisionId)) return null;
      if (!(await decisionsTableExists())) throw new RecoveryGovernanceUnavailable("table mission_governance_decisions missing");
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT userId, businessId FROM mission_governance_decisions
          WHERE governanceDecisionId = ${governanceDecisionId} LIMIT 1
        `)
      );
      const row = rows[0];
      return row ? { userId: Number(row.userId), businessId: Number(row.businessId) } : null;
    },
    async resolveApprovalForDecision(userId, governanceDecisionId) {
      // approval_requests is a canonical table on this branch; the ledger row
      // is read-only here. The mission binding lives in context JSON.
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT id, userId, status, context FROM approval_requests
          WHERE userId = ${userId} AND approvalType = 'mission_action'
            AND JSON_UNQUOTE(JSON_EXTRACT(context, '$.missionGovernanceBinding.governanceDecisionId')) = ${governanceDecisionId}
          ORDER BY id DESC LIMIT 1
        `)
      );
      const row = rows[0];
      if (!row) return null;
      const status = String(row.status ?? "");
      if (status !== "pending" && status !== "approved" && status !== "rejected" && status !== "edited") {
        return null;
      }
      let context: unknown = row.context;
      if (typeof context === "string") {
        try {
          context = JSON.parse(context);
        } catch {
          context = null;
        }
      }
      return { id: Number(row.id), userId: Number(row.userId), status, context };
    },
    async currentPolicyVersion() {
      return BOUND_MISSION_RECOVERY_POLICY_VERSION;
    },
  };
}

// ─── In-memory port over planted raw rows (identical validation) ───

export interface FakeGovernanceRow {
  readonly table: string;
  readonly row: Record<string, unknown>;
}

export function createInMemoryRecoveryGovernanceAuthority(
  rows: readonly FakeGovernanceRow[]
): RecoveryGovernanceAuthority {
  const ofTable = (table: string) => rows.filter((r) => r.table === table).map((r) => r.row);
  return {
    async resolveDecision(userId, governanceDecisionId) {
      if (!GOVERNANCE_DECISION_ID_PATTERN.test(governanceDecisionId)) return null;
      const hit = ofTable("mission_governance_decisions").find((r) => r.governanceDecisionId === governanceDecisionId);
      if (!hit) return null;
      const view = shapeGovernanceDecisionRow(hit);
      return view.userId === userId ? view : null;
    },
    async resolveDecisionGlobal(governanceDecisionId) {
      if (!GOVERNANCE_DECISION_ID_PATTERN.test(governanceDecisionId)) return null;
      const hit = ofTable("mission_governance_decisions").find((r) => r.governanceDecisionId === governanceDecisionId);
      return hit ? { userId: Number(hit.userId), businessId: Number(hit.businessId) } : null;
    },
    async resolveApprovalForDecision(userId, governanceDecisionId) {
      const hits = ofTable("approval_requests")
        .filter((r) => {
          if (Number(r.userId) !== userId || r.approvalType !== "mission_action") return false;
          const binding = readMissionApprovalBinding(r.context);
          return binding?.governanceDecisionId === governanceDecisionId;
        })
        .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0));
      const row = hits[0];
      if (!row) return null;
      const status = String(row.status ?? "");
      if (status !== "pending" && status !== "approved" && status !== "rejected" && status !== "edited") return null;
      return { id: Number(row.id), userId: Number(row.userId), status: status as never, context: row.context };
    },
    async currentPolicyVersion() {
      return BOUND_MISSION_RECOVERY_POLICY_VERSION;
    },
  };
}
