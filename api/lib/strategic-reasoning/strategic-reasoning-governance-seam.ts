// ─── R8-D Strategic Reasoning — R8-F governance seam ───
//
// R8-F (strategic-governance/v1) is mandatory for governed strategic
// conclusions (contract §7). This seam binds the R8-F engine through a
// registration port — there is deliberately NO second governance engine
// here. Absence of the registered authority fails closed
// (STRATEGIC_GOVERNANCE_AUTHORITY_UNAVAILABLE). At R8-X integration the
// canonical R8-F engine (evaluateStrategicGovernanceForProposal) is
// registered; pre-integration tests bind a fake implementing the frozen
// contract semantics.
//
// The approval ledger (approval_requests, approvalType
// "strategic_recommendation") is read-only here: R8-D derives approval
// status by validating the stored binding against the persisted decision
// fingerprints + the deterministic F5 binding-hash formula. Forged, stale,
// cross-proposal or cross-decision approvals fail closed
// (APPROVAL_BINDING_MISMATCH). R8-D never writes approvals and can never
// self-approve.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  canonicalJson,
  fail,
  GOVERNANCE_DECISION_ID_PATTERN,
  HEX_64_PATTERN,
  sha256Hex,
  STRATEGIC_GOVERNANCE_DECISIONS,
  STRATEGIC_RISK_CLASSES,
  type StrategicGovernanceDecisionLabel,
  type StrategicRiskClass,
} from "./strategic-reasoning-contract";

// ─── Frozen R8-F decision view (strategic-governance/v1) ───

export interface StrategicGovernanceDecisionView {
  readonly governanceDecisionId: string;
  readonly proposalId: string;
  readonly businessId: number;
  readonly recommendationType: string;
  readonly decision: StrategicGovernanceDecisionLabel;
  readonly policyVersion: string;
  readonly evidenceFingerprint: string;
  readonly proposalFingerprint: string;
  readonly strategicRiskClass: StrategicRiskClass;
  readonly confidenceClass: string;
  readonly sourceTrustClass: string;
  readonly approvalRequired: boolean;
  readonly reasonCodes: readonly string[];
  readonly validUntil: string | null;
}

/** Validate an untrusted engine payload; fail closed on any deviation. */
export function validateStrategicGovernanceDecisionView(raw: unknown): StrategicGovernanceDecisionView {
  if (typeof raw !== "object" || raw === null) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance engine returned a non-object decision");
  }
  const r = raw as Record<string, unknown>;
  const id = r.governanceDecisionId;
  if (typeof id !== "string" || !GOVERNANCE_DECISION_ID_PATTERN.test(id)) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed governanceDecisionId");
  }
  if (typeof r.proposalId !== "string" || r.proposalId.length === 0 || r.proposalId.length > 128) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed proposalId");
  }
  if (typeof r.businessId !== "number" || !Number.isInteger(r.businessId) || r.businessId <= 0) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed businessId");
  }
  if (typeof r.recommendationType !== "string") {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed recommendationType");
  }
  const decision = r.decision;
  if (typeof decision !== "string" || !(STRATEGIC_GOVERNANCE_DECISIONS as readonly string[]).includes(decision)) {
    fail("GOVERNANCE_DECISION_MALFORMED", `governance decision has unknown decision ${String(decision)}`);
  }
  if (typeof r.policyVersion !== "string" || r.policyVersion.length === 0) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed policyVersion");
  }
  if (typeof r.evidenceFingerprint !== "string" || !HEX_64_PATTERN.test(r.evidenceFingerprint)) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed evidenceFingerprint");
  }
  if (typeof r.proposalFingerprint !== "string" || !HEX_64_PATTERN.test(r.proposalFingerprint)) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed proposalFingerprint");
  }
  if (typeof r.strategicRiskClass !== "string" || !(STRATEGIC_RISK_CLASSES as readonly string[]).includes(r.strategicRiskClass)) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed strategicRiskClass");
  }
  if (typeof r.confidenceClass !== "string") {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed confidenceClass");
  }
  if (typeof r.sourceTrustClass !== "string") {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed sourceTrustClass");
  }
  if (typeof r.approvalRequired !== "boolean") {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed approvalRequired");
  }
  if (!Array.isArray(r.reasonCodes) || r.reasonCodes.length > 8 || !r.reasonCodes.every((c) => typeof c === "string")) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed reasonCodes");
  }
  const validUntil = r.validUntil;
  return {
    governanceDecisionId: id,
    proposalId: r.proposalId as string,
    businessId: r.businessId as number,
    recommendationType: r.recommendationType as string,
    decision: decision as StrategicGovernanceDecisionLabel,
    policyVersion: r.policyVersion as string,
    evidenceFingerprint: r.evidenceFingerprint as string,
    proposalFingerprint: r.proposalFingerprint as string,
    strategicRiskClass: r.strategicRiskClass as StrategicRiskClass,
    confidenceClass: r.confidenceClass as string,
    sourceTrustClass: r.sourceTrustClass as string,
    approvalRequired: r.approvalRequired as boolean,
    reasonCodes: (r.reasonCodes as unknown[]).map(String),
    validUntil: typeof validUntil === "string" && validUntil.length > 0 ? validUntil : null,
  };
}

// ─── Engine registry (R8-F binds at R8-X; absence fails closed) ───

export interface StrategicGovernanceEnginePort {
  /**
   * Submit proposal material (client/tenant-scoped) to the R8-F authority.
   * Returns the raw immutable decision payload; the seam validates it.
   */
  evaluateProposal(input: {
    userId: number;
    businessId: number;
    proposal: unknown;
    policyVersion?: string;
  }): Promise<unknown>;
}

let registeredEngine: StrategicGovernanceEnginePort | null = null;

/** R8-X integration registers the canonical R8-F engine exactly once. */
export function registerStrategicGovernanceEnginePort(port: StrategicGovernanceEnginePort): void {
  registeredEngine = port;
}

export function clearStrategicGovernanceEnginePort(): void {
  registeredEngine = null;
}

export function getStrategicGovernanceEnginePort(): StrategicGovernanceEnginePort {
  if (!registeredEngine) {
    fail(
      "STRATEGIC_GOVERNANCE_AUTHORITY_UNAVAILABLE",
      "the R8-F strategic-governance authority is not bound; no strategic claim may be voiced on guessed governance"
    );
  }
  return registeredEngine;
}

// ─── Approval ledger read-view (read-only; binding-hash validated) ───

export const STRATEGIC_RECOMMENDATION_APPROVAL_TYPE = "strategic_recommendation" as const;

export interface StrategicApprovalBindingRecord {
  readonly governanceDecisionId: string;
  readonly policyVersion: string;
  readonly proposalFingerprint: string;
  readonly evidenceFingerprint: string;
  readonly approvalBindingHash: string;
}

export interface StrategicApprovalRowView {
  readonly id: number;
  readonly status: "pending" | "approved" | "rejected" | "edited";
  readonly binding: StrategicApprovalBindingRecord | null;
}

export interface StrategicApprovalReadPort {
  listApprovalsForDecision(userId: number, governanceDecisionId: string): Promise<StrategicApprovalRowView[]>;
}

/** Deterministic F5 binding hash (mirrors the frozen R8-F formula). */
export function deriveApprovalBindingHash(input: {
  governanceDecisionId: string;
  policyVersion: string;
  proposalFingerprint: string;
  evidenceFingerprint: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      governanceDecisionId: input.governanceDecisionId,
      policyVersion: input.policyVersion,
      proposalFingerprint: input.proposalFingerprint,
      evidenceFingerprint: input.evidenceFingerprint,
    })
  );
}

function parseBinding(context: unknown): StrategicApprovalBindingRecord | null {
  if (typeof context !== "object" || context === null) return null;
  const raw = (context as Record<string, unknown>).strategicGovernanceBinding;
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (
    typeof b.governanceDecisionId !== "string" ||
    typeof b.policyVersion !== "string" ||
    typeof b.proposalFingerprint !== "string" ||
    typeof b.evidenceFingerprint !== "string" ||
    typeof b.approvalBindingHash !== "string"
  ) {
    return null;
  }
  return {
    governanceDecisionId: b.governanceDecisionId,
    policyVersion: b.policyVersion,
    proposalFingerprint: b.proposalFingerprint,
    evidenceFingerprint: b.evidenceFingerprint,
    approvalBindingHash: b.approvalBindingHash,
  };
}

/** Production read-view over the canonical approval ledger (raw SQL; read-only). */
export function createStrategicApprovalReadPort(): StrategicApprovalReadPort {
  return {
    async listApprovalsForDecision(userId, governanceDecisionId) {
      const db = getDb();
      const result: unknown = await db.execute(sql`
        SELECT id, status, context FROM approval_requests
        WHERE userId = ${userId} AND approvalType = ${STRATEGIC_RECOMMENDATION_APPROVAL_TYPE}
      `);
      let rawRows: Array<Record<string, unknown>> = [];
      if (Array.isArray(result)) {
        const first: unknown = result[0];
        rawRows = Array.isArray(first)
          ? (first as Array<Record<string, unknown>>)
          : first && typeof first === "object"
            ? [first as Record<string, unknown>]
            : [];
      } else if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
        rawRows = (result as { rows: Array<Record<string, unknown>> }).rows;
      }
      const out: StrategicApprovalRowView[] = [];
      for (const row of rawRows) {
        const context = row.context;
        let parsedContext: unknown = context;
        if (typeof context === "string") {
          try {
            parsedContext = JSON.parse(context);
          } catch {
            parsedContext = null;
          }
        }
        const binding = parseBinding(parsedContext);
        if (binding && binding.governanceDecisionId !== governanceDecisionId) continue;
        const status = String(row.status ?? "");
        out.push({
          id: Number(row.id),
          status:
            status === "approved" || status === "rejected" || status === "edited" || status === "pending"
              ? status
              : "pending",
          binding,
        });
      }
      return out;
    },
  };
}

/** In-memory approval read-view for tests (same validation semantics). */
export function createInMemoryApprovalReadPort(rows: StrategicApprovalRowView[]): StrategicApprovalReadPort {
  return {
    async listApprovalsForDecision(_userId, governanceDecisionId) {
      return rows.filter((r) => !r.binding || r.binding.governanceDecisionId === governanceDecisionId);
    },
  };
}

/**
 * Derive the approval status for a stored decision. A binding that does not
 * match the persisted decision fingerprints is forged/tampered material —
 * fail closed (APPROVAL_BINDING_MISMATCH). A rejected binding permanently
 * blocks the identity.
 */
export function deriveApprovalStatus(input: {
  decision: Pick<
    StrategicGovernanceDecisionView,
    "governanceDecisionId" | "policyVersion" | "proposalFingerprint" | "evidenceFingerprint"
  >;
  approvals: readonly StrategicApprovalRowView[];
}): "none" | "pending" | "approved" | "rejected" {
  const { decision, approvals } = input;
  for (const approval of approvals) {
    const binding = approval.binding;
    if (!binding) continue;
    if (binding.governanceDecisionId !== decision.governanceDecisionId) continue;
    const expected = deriveApprovalBindingHash({
      governanceDecisionId: decision.governanceDecisionId,
      policyVersion: decision.policyVersion,
      proposalFingerprint: decision.proposalFingerprint,
      evidenceFingerprint: decision.evidenceFingerprint,
    });
    if (binding.approvalBindingHash !== expected) {
      fail(
        "APPROVAL_BINDING_MISMATCH",
        `approval ${approval.id} binding hash does not match the stored governance decision — forged or tampered approval material`
      );
    }
    if (binding.policyVersion !== decision.policyVersion) {
      fail("APPROVAL_BINDING_MISMATCH", `approval ${approval.id} binds a different policy version`);
    }
    if (binding.proposalFingerprint !== decision.proposalFingerprint) {
      fail("APPROVAL_BINDING_MISMATCH", `approval ${approval.id} binds different proposal material`);
    }
    if (binding.evidenceFingerprint !== decision.evidenceFingerprint) {
      fail("APPROVAL_BINDING_MISMATCH", `approval ${approval.id} binds a different evidence snapshot`);
    }
  }
  if (approvals.some((a) => a.status === "rejected")) return "rejected";
  if (approvals.some((a) => a.status === "approved")) return "approved";
  if (approvals.length > 0) return "pending";
  return "none";
}
