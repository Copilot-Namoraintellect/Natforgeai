// ─── R7-F Optimisation Governance — approval & execution authority (F4) ───
//
// Bridges REVIEW_REQUIRED governance decisions into the existing governed
// approval ledger (approval_requests, approvalType "optimisation_action" —
// provisional enum extension, unexecuted; see docs/recovery/r7-f-unexecuted-
// migrations.md). Human approval binds the EXACT business, proposal, action,
// financial impact, policy version, evidence snapshot and expiry.
//
// Rejected: generic approvals, stale approvals, cross-business replay,
// cross-proposal replay, modified proposal after approval, agent
// self-approval and client-supplied fake approval. The approval row alone is
// never authority: downstream R7 streams MUST call
// assertOptimisationActionExecutable before any material state change — it is
// the single fail-closed gate converting decision (+ human approval where
// required) into execution eligibility.
//
// Pure module: no database access, no clock, no I/O.

import { createHash } from "crypto";
import {
  deriveApprovalBindingHash,
  OptimisationGovernanceValidationError,
  type OptimisationGovernanceErrorCode,
  type OptimisationGovernanceReasonCode,
} from "./optimisation-governance-contract";
import type { OptimisationGovernanceDecision } from "./optimisation-decision-engine";

export const OPTIMISATION_ACTION_APPROVAL_TYPE = "optimisation_action" as const;

/**
 * Contract version bound into the idempotency key; bumping invalidates
 * previously derived keys for the same decision.
 */
export const OPTIMISATION_GOVERNANCE_APPROVAL_CONTRACT_VERSION =
  "optimisation-governance/approval@v1" as const;

const IDEMPOTENCY_KEY_PREFIX = "ogov1";

/** Durable binding persisted in approval_requests.context. */
export interface OptimisationGovernanceApprovalBindingRecord {
  readonly contractVersion: string;
  readonly governanceDecisionId: string;
  readonly proposalId: string;
  readonly businessId: number;
  readonly policyVersion: string;
  readonly proposalFingerprint: string;
  readonly approvalBindingHash: string;
  /** Financial impact bound at evaluation time (minor units). */
  readonly financialDeltaMinor: number;
  readonly financialImpactClass: string;
  readonly expiresAt: string;
}

export interface OptimisationGovernanceApprovalCommand {
  readonly userId: number;
  readonly campaignId: number | null;
  readonly approvalType: typeof OPTIMISATION_ACTION_APPROVAL_TYPE;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly description: string;
  readonly aiRecommendation: string;
  readonly riskLevel: "low" | "medium" | "high";
  readonly context: {
    readonly optimisationGovernanceBinding: OptimisationGovernanceApprovalBindingRecord;
  };
}

function fail(code: OptimisationGovernanceErrorCode, message: string): never {
  throw new OptimisationGovernanceValidationError(code, message);
}

/** Deterministic idempotency key: one decision -> at most one durable approval row. */
export function buildOptimisationApprovalIdempotencyKey(governanceDecisionId: string): string {
  if (typeof governanceDecisionId !== "string" || governanceDecisionId.trim().length === 0) {
    fail("INVALID_DECISION_IDENTITY", "governanceDecisionId must be a non-blank string");
  }
  return `${IDEMPOTENCY_KEY_PREFIX}:${createHash("sha256")
    .update(`${OPTIMISATION_GOVERNANCE_APPROVAL_CONTRACT_VERSION}:${governanceDecisionId.trim()}`, "utf8")
    .digest("hex")}`;
}

function toApprovalRiskLevel(riskClass: string): "low" | "medium" | "high" {
  if (riskClass === "low") return "low";
  if (riskClass === "medium") return "medium";
  return "high";
}

/**
 * Build the deterministic approval command for a REVIEW_REQUIRED decision.
 * Anything else fails closed: approvals exist only where governance decided
 * a human must authorize.
 */
export function buildOptimisationApprovalCommand(input: {
  decision: OptimisationGovernanceDecision;
  userId: number;
}): OptimisationGovernanceApprovalCommand {
  const { decision } = input;
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    fail("INVALID_APPROVAL_INPUT", `userId must be a positive integer, got ${String(input.userId)}`);
  }
  if (decision.decision !== "REVIEW_REQUIRED") {
    fail(
      "INVALID_APPROVAL_MODE",
      `Only REVIEW_REQUIRED decisions produce approval commands; got ${decision.decision}`
    );
  }
  if (decision.approvalBinding === null || decision.policyVersion === null) {
    fail("INVALID_APPROVAL_INPUT", "REVIEW_REQUIRED decision is missing its approval binding");
  }

  const binding: OptimisationGovernanceApprovalBindingRecord = Object.freeze({
    contractVersion: OPTIMISATION_GOVERNANCE_APPROVAL_CONTRACT_VERSION,
    governanceDecisionId: decision.governanceDecisionId,
    proposalId: decision.proposalId,
    businessId: decision.businessId,
    policyVersion: decision.policyVersion,
    proposalFingerprint: decision.proposalFingerprint,
    approvalBindingHash: decision.approvalBinding.approvalBindingHash,
    financialDeltaMinor: decision.financialDeltaMinor,
    financialImpactClass: decision.financialImpactClass,
    expiresAt: decision.approvalBinding.expiresAt,
  });

  return Object.freeze({
    userId: input.userId,
    campaignId: decision.campaignId,
    approvalType: OPTIMISATION_ACTION_APPROVAL_TYPE,
    idempotencyKey: buildOptimisationApprovalIdempotencyKey(decision.governanceDecisionId),
    title: `Optimisation Governance Approval: ${decision.proposalType} (${decision.businessId})`,
    description: [
      "Governance evaluation determined this optimisation action requires explicit human approval before execution.",
      "Approving authorizes exactly this proposal under the bound policy version and evidence snapshot.",
      "",
      `Action: ${decision.proposalType}`,
      `Business: ${decision.businessId}`,
      `Financial impact: ${decision.financialImpactClass} (delta ${decision.financialDeltaMinor} minor units)`,
      `Risk: ${decision.riskClass}`,
      `Policy: ${decision.policyVersion}`,
      "",
      "Nothing has been executed. Rejection permanently blocks this proposal identity.",
    ].join("\n"),
    aiRecommendation: `Governance-bound action awaiting human approval. Reasons: ${decision.reasonCodes.join(", ")}`,
    riskLevel: toApprovalRiskLevel(decision.riskClass),
    context: Object.freeze({ optimisationGovernanceBinding: binding }),
  });
}

/** Minimal approval row view needed for the executable assertion. */
export interface OptimisationApprovalView {
  readonly id: number;
  readonly userId: number;
  readonly status: "pending" | "approved" | "rejected" | "edited";
  readonly context: unknown;
}

function parseBinding(context: unknown): OptimisationGovernanceApprovalBindingRecord | null {
  if (typeof context !== "object" || context === null) return null;
  const binding = (context as Record<string, unknown>).optimisationGovernanceBinding;
  if (typeof binding !== "object" || binding === null) return null;
  const b = binding as Record<string, unknown>;
  if (typeof b.governanceDecisionId !== "string" || typeof b.policyVersion !== "string") {
    return null;
  }
  return b as unknown as OptimisationGovernanceApprovalBindingRecord;
}

/** Read the durable binding from an approval row context (null when absent). */
export function readOptimisationApprovalBinding(
  context: unknown
): OptimisationGovernanceApprovalBindingRecord | null {
  return parseBinding(context);
}

export type OptimisationActionExecutionVerdict =
  | {
      readonly executable: true;
      readonly authorization: {
        readonly governanceDecisionId: string;
        readonly proposalId: string;
        readonly decision: "ALLOW" | "REVIEW_REQUIRED";
        readonly approvalRequestId: number | null;
        readonly policyVersion: string;
        readonly authorizedAt: string;
        readonly expiresAt: string;
      };
    }
  | { readonly executable: false; readonly reason: OptimisationGovernanceReasonCode; readonly permanent: boolean };

function deny(reason: OptimisationGovernanceReasonCode, permanent = false): OptimisationActionExecutionVerdict {
  return { executable: false, reason, permanent };
}

/**
 * The single downstream execution gate. R7-B/C/D/E MUST call this before any
 * material state change and must revalidate governance immediately before
 * acting on the authorization.
 *
 * - ALLOW: executable until validUntil, while the business policy version is
 *   unchanged;
 * - REVIEW_REQUIRED: executable only with an approved binding matching the
 *   exact decision + policy version + proposal fingerprint, unexpired, under
 *   an unchanged policy;
 * - human rejection permanently blocks the proposal identity: the only path
 *   forward is a NEW governed proposal;
 * - BLOCK is never executable.
 */
export function assertOptimisationActionExecutable(input: {
  decision: OptimisationGovernanceDecision;
  approval: OptimisationApprovalView | null;
  currentPolicyVersion: string | null;
  now: string;
}): OptimisationActionExecutionVerdict {
  const { decision, approval, currentPolicyVersion, now } = input;
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    fail("INVALID_EVALUATION_CLOCK", `now must be a valid ISO timestamp, got ${String(now)}`);
  }

  if (decision.decision === "ALLOW") {
    if (currentPolicyVersion !== decision.policyVersion) {
      return deny("STALE_POLICY_VERSION");
    }
    if (decision.validUntil !== null && Date.parse(decision.validUntil) <= nowMs) {
      return deny("EXPIRED_DECISION");
    }
    return {
      executable: true,
      authorization: {
        governanceDecisionId: decision.governanceDecisionId,
        proposalId: decision.proposalId,
        decision: "ALLOW",
        approvalRequestId: null,
        policyVersion: decision.policyVersion ?? "",
        authorizedAt: now,
        expiresAt: decision.validUntil ?? "",
      },
    };
  }

  if (decision.decision === "BLOCK") {
    return deny(decision.reasonCodes[0] ?? "ACTION_PROHIBITED_BY_POLICY");
  }

  // REVIEW_REQUIRED
  if (approval === null) return deny("APPROVAL_NOT_FOUND");
  if (approval.status === "pending") return deny("APPROVAL_PENDING");
  if (approval.status === "rejected") return deny("APPROVAL_REJECTED_BY_HUMAN", true);
  if (approval.status === "edited") return deny("APPROVAL_BINDING_MISMATCH");

  // Agent self-approval guard: the approval row must belong to the same
  // tenant; a row minted by the proposing agent identity is never authority.
  if (approval.userId !== decision.userId) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }

  const binding = parseBinding(approval.context);
  if (
    binding === null ||
    binding.governanceDecisionId !== decision.governanceDecisionId ||
    binding.policyVersion !== decision.policyVersion
  ) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  const expectedHash = deriveApprovalBindingHash({
    governanceDecisionId: decision.governanceDecisionId,
    policyVersion: decision.policyVersion ?? "",
    proposalFingerprint: decision.proposalFingerprint,
  });
  if (binding.approvalBindingHash !== expectedHash) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  if (binding.proposalFingerprint !== decision.proposalFingerprint) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  if (currentPolicyVersion !== decision.policyVersion) {
    return deny("STALE_POLICY_VERSION");
  }
  if (Date.parse(binding.expiresAt) <= nowMs) {
    return deny("EXPIRED_APPROVAL");
  }

  return {
    executable: true,
    authorization: {
      governanceDecisionId: decision.governanceDecisionId,
      proposalId: decision.proposalId,
      decision: "REVIEW_REQUIRED",
      approvalRequestId: approval.id,
      policyVersion: decision.policyVersion ?? "",
      authorizedAt: now,
      expiresAt: binding.expiresAt,
    },
  };
}

/**
 * Pre-approval validation (runs inside the approval decision transaction):
 * authorizing a pending optimisation_action request is only valid while the
 * bound decision, policy version and proposal fingerprint are unchanged and
 * the binding has not expired. Rejection is always permitted. Throws (fail
 * closed).
 */
export function validateOptimisationApprovalAuthorizable(input: {
  approval: OptimisationApprovalView;
  decision: OptimisationGovernanceDecision | null;
  currentPolicyVersion: string | null;
  now: string;
}): void {
  const { approval, decision, currentPolicyVersion, now } = input;
  if (approval.status !== "pending") {
    fail("APPROVAL_NOT_FOUND", `Approval request is already ${approval.status}.`);
  }
  const binding = parseBinding(approval.context);
  if (binding === null) {
    fail("APPROVAL_BINDING_MISMATCH", "Approval request carries no optimisation governance binding");
  }
  if (decision === null) {
    fail("APPROVAL_BINDING_MISMATCH", `Bound governance decision ${binding.governanceDecisionId} no longer exists`);
  }
  if (binding.governanceDecisionId !== decision.governanceDecisionId) {
    fail("APPROVAL_BINDING_MISMATCH", "Approval binding does not match the governance decision identity");
  }
  if (binding.policyVersion !== decision.policyVersion || currentPolicyVersion !== decision.policyVersion) {
    fail(
      "STALE_POLICY_VERSION",
      "STALE_POLICY_VERSION: the business policy has changed since this action was evaluated; a new governed proposal is required."
    );
  }
  const expectedHash = deriveApprovalBindingHash({
    governanceDecisionId: decision.governanceDecisionId,
    policyVersion: decision.policyVersion ?? "",
    proposalFingerprint: decision.proposalFingerprint,
  });
  if (binding.approvalBindingHash !== expectedHash || binding.proposalFingerprint !== decision.proposalFingerprint) {
    fail(
      "APPROVAL_BINDING_MISMATCH",
      "APPROVAL_BINDING_MISMATCH: the proposal material changed since evaluation; the authorization is stale."
    );
  }
  if (Date.parse(binding.expiresAt) <= Date.parse(now)) {
    fail("EXPIRED_APPROVAL", "The approval binding has expired; a new governed proposal is required");
  }
}
