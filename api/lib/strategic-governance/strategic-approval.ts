// ─── R8-F Strategic Intelligence Governance — approval & consumption authority (F5) ───
//
// Bridges REVIEW_REQUIRED governance decisions into the existing governed
// approval ledger (approval_requests, approvalType "strategic_recommendation"
// — provisional enum extension, unexecuted; see
// docs/recovery/r8-f-unexecuted-migrations.md). Human approval binds the EXACT
// business, recommendation, evidence snapshot, confidence, risk, policy
// version and expiry.
//
// Rejected: generic approvals, stale approvals, cross-business replay,
// cross-proposal replay, modified recommendation after approval, agent
// self-approval and client-supplied fake approval. The approval row alone is
// never authority: downstream R8 streams and R9 MUST call
// assertStrategicRecommendationConsumable before acting on a recommendation —
// it is the single fail-closed gate converting decision (+ human approval
// where required) into CONSUMPTION eligibility. Even then, the verdict is
// advisory authority only: `authorityScope: "RECOMMENDATION_ONLY"`. There is
// no execution outcome anywhere (charter F7; AC24–AC28).
//
// Pure module: no database access, no clock, no I/O.

import { createHash } from "crypto";
import {
  deriveApprovalBindingHash,
  StrategicGovernanceValidationError,
  type StrategicGovernanceErrorCode,
  type StrategicGovernanceReasonCode,
} from "./strategic-governance-contract";
import type { StrategicGovernanceDecision } from "./strategic-decision-engine";

export const STRATEGIC_RECOMMENDATION_APPROVAL_TYPE = "strategic_recommendation" as const;

/**
 * Contract version bound into the idempotency key; bumping invalidates
 * previously derived keys for the same decision.
 */
export const STRATEGIC_GOVERNANCE_APPROVAL_CONTRACT_VERSION =
  "strategic-governance/approval@v1" as const;

const IDEMPOTENCY_KEY_PREFIX = "sgov1";

/** Durable binding persisted in approval_requests.context. */
export interface StrategicGovernanceApprovalBindingRecord {
  readonly contractVersion: string;
  readonly governanceDecisionId: string;
  readonly proposalId: string;
  readonly businessId: number;
  readonly policyVersion: string;
  readonly proposalFingerprint: string;
  readonly evidenceFingerprint: string;
  readonly approvalBindingHash: string;
  /** Confidence bound at evaluation time. */
  readonly confidenceClass: string;
  /** Strategic risk bound at evaluation time. */
  readonly strategicRiskClass: string;
  /** Source trust bound at evaluation time. */
  readonly sourceTrustClass: string;
  readonly expiresAt: string;
}

export interface StrategicGovernanceApprovalCommand {
  readonly userId: number;
  readonly campaignId: null;
  readonly approvalType: typeof STRATEGIC_RECOMMENDATION_APPROVAL_TYPE;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly description: string;
  readonly aiRecommendation: string;
  readonly riskLevel: "low" | "medium" | "high";
  readonly context: {
    readonly strategicGovernanceBinding: StrategicGovernanceApprovalBindingRecord;
  };
}

function fail(code: StrategicGovernanceErrorCode, message: string): never {
  throw new StrategicGovernanceValidationError(code, message);
}

/** Deterministic idempotency key: one decision -> at most one durable approval row. */
export function buildStrategicApprovalIdempotencyKey(governanceDecisionId: string): string {
  if (typeof governanceDecisionId !== "string" || governanceDecisionId.trim().length === 0) {
    fail("INVALID_DECISION_IDENTITY", "governanceDecisionId must be a non-blank string");
  }
  return `${IDEMPOTENCY_KEY_PREFIX}:${createHash("sha256")
    .update(`${STRATEGIC_GOVERNANCE_APPROVAL_CONTRACT_VERSION}:${governanceDecisionId.trim()}`, "utf8")
    .digest("hex")}`;
}

function toApprovalRiskLevel(riskClass: string): "low" | "medium" | "high" {
  if (riskClass === "LOW") return "low";
  if (riskClass === "MEDIUM") return "medium";
  return "high";
}

/**
 * Build the deterministic approval command for a REVIEW_REQUIRED decision.
 * Anything else fails closed: approvals exist only where governance decided
 * a human must authorize. Strategic recommendations never carry a campaign
 * (campaignId is null — this stream never touches campaign execution).
 */
export function buildStrategicApprovalCommand(input: {
  decision: StrategicGovernanceDecision;
  userId: number;
}): StrategicGovernanceApprovalCommand {
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

  const binding: StrategicGovernanceApprovalBindingRecord = Object.freeze({
    contractVersion: STRATEGIC_GOVERNANCE_APPROVAL_CONTRACT_VERSION,
    governanceDecisionId: decision.governanceDecisionId,
    proposalId: decision.proposalId,
    businessId: decision.businessId,
    policyVersion: decision.policyVersion,
    proposalFingerprint: decision.proposalFingerprint,
    evidenceFingerprint: decision.evidenceFingerprint,
    approvalBindingHash: decision.approvalBinding.approvalBindingHash,
    confidenceClass: decision.confidenceClass,
    strategicRiskClass: decision.strategicRiskClass,
    sourceTrustClass: decision.sourceTrustClass,
    expiresAt: decision.approvalBinding.expiresAt,
  });

  return Object.freeze({
    userId: input.userId,
    campaignId: null,
    approvalType: STRATEGIC_RECOMMENDATION_APPROVAL_TYPE,
    idempotencyKey: buildStrategicApprovalIdempotencyKey(decision.governanceDecisionId),
    title: `Strategic Governance Approval: ${decision.recommendationType} (${decision.businessId})`,
    description: [
      "Governance evaluation determined this strategic recommendation requires explicit human approval before it may be voiced as an approved recommendation.",
      "Approving authorizes exactly this recommendation under the bound policy version and evidence snapshot.",
      "",
      `Recommendation type: ${decision.recommendationType}`,
      `Business: ${decision.businessId}`,
      `Strategic risk: ${decision.strategicRiskClass}`,
      `Confidence: ${decision.confidenceClass}`,
      `Source trust: ${decision.sourceTrustClass}`,
      `Policy: ${decision.policyVersion}`,
      "",
      "Nothing has been executed. This approval is recommendation-consumption authority only — it can never launch campaigns, mutate strategy, move budget, alter Business DNA, or invoke providers/billing. Rejection permanently blocks this recommendation identity.",
    ].join("\n"),
    aiRecommendation: `Governance-bound recommendation awaiting human approval. Reasons: ${decision.reasonCodes.join(", ")}`,
    riskLevel: toApprovalRiskLevel(decision.strategicRiskClass),
    context: Object.freeze({ strategicGovernanceBinding: binding }),
  });
}

/** Minimal approval row view needed for the consumable assertion. */
export interface StrategicApprovalView {
  readonly id: number;
  readonly userId: number;
  readonly status: "pending" | "approved" | "rejected" | "edited";
  readonly context: unknown;
}

function parseBinding(context: unknown): StrategicGovernanceApprovalBindingRecord | null {
  if (typeof context !== "object" || context === null) return null;
  const binding = (context as Record<string, unknown>).strategicGovernanceBinding;
  if (typeof binding !== "object" || binding === null) return null;
  const b = binding as Record<string, unknown>;
  if (typeof b.governanceDecisionId !== "string" || typeof b.policyVersion !== "string") {
    return null;
  }
  return b as unknown as StrategicGovernanceApprovalBindingRecord;
}

/** Read the durable binding from an approval row context (null when absent). */
export function readStrategicApprovalBinding(
  context: unknown
): StrategicGovernanceApprovalBindingRecord | null {
  return parseBinding(context);
}

export type StrategicRecommendationConsumptionVerdict =
  | {
      readonly consumable: true;
      readonly authorization: {
        readonly authorityScope: "RECOMMENDATION_ONLY";
        readonly governanceDecisionId: string;
        readonly proposalId: string;
        readonly decision: "ALLOW_RECOMMENDATION" | "REVIEW_REQUIRED";
        readonly approvalRequestId: number | null;
        readonly policyVersion: string;
        readonly authorizedAt: string;
        readonly expiresAt: string;
      };
    }
  | {
      readonly consumable: false;
      readonly reason: StrategicGovernanceReasonCode;
      readonly permanent: boolean;
    };

function deny(
  reason: StrategicGovernanceReasonCode,
  permanent = false
): StrategicRecommendationConsumptionVerdict {
  return { consumable: false, reason, permanent };
}

/**
 * The single downstream consumption gate (F5/downstream contract). R8-D/E and
 * R9 MUST call this before acting on a recommendation and must revalidate
 * governance immediately before acting.
 *
 * - ALLOW_RECOMMENDATION: consumable until validUntil, while the policy
 *   version is unchanged;
 * - REVIEW_REQUIRED: consumable only with an approved binding matching the
 *   exact decision + policy version + proposal fingerprint + evidence
 *   fingerprint, unexpired, under an unchanged policy;
 * - human rejection permanently blocks the recommendation identity: the only
 *   path forward is a NEW governed proposal;
 * - BLOCK is never consumable.
 *
 * The verdict is advisory authority only — `authorityScope:
 * "RECOMMENDATION_ONLY"` — and deliberately carries no campaign, strategy,
 * budget, Business DNA, provider or billing fields: consumption of a
 * recommendation can never become execution authority (F7; AC24–AC28).
 */
export function assertStrategicRecommendationConsumable(input: {
  decision: StrategicGovernanceDecision;
  approval: StrategicApprovalView | null;
  currentPolicyVersion: string | null;
  now: string;
}): StrategicRecommendationConsumptionVerdict {
  const { decision, approval, currentPolicyVersion, now } = input;
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    fail("INVALID_EVALUATION_CLOCK", `now must be a valid ISO timestamp, got ${String(now)}`);
  }

  if (decision.decision === "ALLOW_RECOMMENDATION") {
    if (currentPolicyVersion !== decision.policyVersion) {
      return deny("STALE_POLICY_VERSION");
    }
    if (decision.validUntil !== null && Date.parse(decision.validUntil) <= nowMs) {
      return deny("EXPIRED_DECISION");
    }
    return {
      consumable: true,
      authorization: {
        authorityScope: "RECOMMENDATION_ONLY",
        governanceDecisionId: decision.governanceDecisionId,
        proposalId: decision.proposalId,
        decision: "ALLOW_RECOMMENDATION",
        approvalRequestId: null,
        policyVersion: decision.policyVersion ?? "",
        authorizedAt: now,
        expiresAt: decision.validUntil ?? "",
      },
    };
  }

  if (decision.decision === "BLOCK") {
    return deny(decision.reasonCodes[0] ?? "RECOMMENDATION_BLOCKED_BY_POLICY");
  }

  // REVIEW_REQUIRED
  if (approval === null) return deny("APPROVAL_NOT_FOUND");
  if (approval.status === "pending") return deny("APPROVAL_PENDING");
  if (approval.status === "rejected") return deny("APPROVAL_REJECTED_BY_HUMAN", true);
  if (approval.status === "edited") return deny("APPROVAL_BINDING_MISMATCH");

  // Agent self-approval guard: the approval row must belong to the same
  // tenant; a row minted by the proposing agent identity is never authority.
  // (Independent human presence for the approve act itself is enforced by the
  // OTP review challenge — see strategic-review-authority.ts; an autonomous
  // agent cannot observe the emailed code.)
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
    evidenceFingerprint: decision.evidenceFingerprint,
  });
  if (binding.approvalBindingHash !== expectedHash) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  if (binding.proposalFingerprint !== decision.proposalFingerprint) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  if (binding.evidenceFingerprint !== decision.evidenceFingerprint) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  if (currentPolicyVersion !== decision.policyVersion) {
    return deny("STALE_POLICY_VERSION");
  }
  if (Date.parse(binding.expiresAt) <= nowMs) {
    return deny("EXPIRED_APPROVAL");
  }

  return {
    consumable: true,
    authorization: {
      authorityScope: "RECOMMENDATION_ONLY",
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
 * authorizing a pending strategic_recommendation request is only valid while
 * the bound decision, policy version, proposal fingerprint and evidence
 * fingerprint are unchanged and the binding has not expired. Rejection is
 * always permitted. Throws (fail closed).
 */
export function validateStrategicApprovalAuthorizable(input: {
  approval: StrategicApprovalView;
  decision: StrategicGovernanceDecision | null;
  currentPolicyVersion: string | null;
  now: string;
}): void {
  const { approval, decision, currentPolicyVersion, now } = input;
  if (approval.status !== "pending") {
    fail("APPROVAL_NOT_FOUND", `Approval request is already ${approval.status}.`);
  }
  const binding = parseBinding(approval.context);
  if (binding === null) {
    fail("APPROVAL_BINDING_MISMATCH", "Approval request carries no strategic governance binding");
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
      "STALE_POLICY_VERSION: the business policy has changed since this recommendation was evaluated; a new governed proposal is required."
    );
  }
  const expectedHash = deriveApprovalBindingHash({
    governanceDecisionId: decision.governanceDecisionId,
    policyVersion: decision.policyVersion ?? "",
    proposalFingerprint: decision.proposalFingerprint,
    evidenceFingerprint: decision.evidenceFingerprint,
  });
  if (
    binding.approvalBindingHash !== expectedHash ||
    binding.proposalFingerprint !== decision.proposalFingerprint ||
    binding.evidenceFingerprint !== decision.evidenceFingerprint
  ) {
    fail(
      "APPROVAL_BINDING_MISMATCH",
      "APPROVAL_BINDING_MISMATCH: the recommendation material changed since evaluation; the authorization is stale."
    );
  }
  if (Date.parse(binding.expiresAt) <= Date.parse(now)) {
    fail("EXPIRED_APPROVAL", "The approval binding has expired; a new governed proposal is required");
  }
}
