// ─── R9-F Mission Governance & Approval — approval & consumption authority (F4/F6/F7) ───
//
// Bridges REVIEW_REQUIRED mission-governance decisions into the existing
// governed approval ledger (approval_requests, approvalType "mission_action"
// — provisional enum extension, unexecuted; see
// docs/recovery/r9-f-unexecuted-migrations.md; R9-X owns canonical 0037
// convergence). Human approval binds the EXACT tenant, business, mission,
// plan, task, subject, action, action parameters (fingerprint), risk class,
// policy version and expiry.
//
// Rejected: generic approvals, stale approvals, cross-tenant approvals,
// cross-business replay, cross-mission / cross-plan / cross-task replay,
// modified action after approval, agent self-approval and client-supplied
// fake approval. The approval row alone is never authority: downstream R9-D/E
// MUST call assertMissionActionConsumable before executing anything — it is
// the single fail-closed gate converting decision (+ human approval where
// required) into consumption eligibility for the EXACT bound action only.
// Even then the verdict is bounded authority — `authorityScope:
// "MISSION_ACTION"` — never a blanket mission authorization and never
// provider/spend authority by itself (charter; AC4–AC13, AC21, AC22).
//
// Pure module: no database access, no clock, no I/O.

import { createHash } from "crypto";
import {
  deriveActionParamsFingerprint,
  deriveMissionApprovalBindingHash,
  MissionGovernanceValidationError,
  type MissionGovernanceErrorCode,
  type MissionGovernanceReasonCode,
} from "./mission-governance-contract";
import type { MissionGovernanceDecision } from "./mission-decision-engine";

export const MISSION_ACTION_APPROVAL_TYPE = "mission_action" as const;

/**
 * Contract version bound into the idempotency key; bumping invalidates
 * previously derived keys for the same decision.
 */
export const MISSION_GOVERNANCE_APPROVAL_CONTRACT_VERSION =
  "mission-governance/approval@v1" as const;

const IDEMPOTENCY_KEY_PREFIX = "mgov1";

/** Durable binding persisted in approval_requests.context. */
export interface MissionGovernanceApprovalBindingRecord {
  readonly contractVersion: string;
  readonly governanceDecisionId: string;
  readonly businessId: number;
  readonly missionRef: string;
  readonly planRef: string | null;
  readonly taskRef: string | null;
  readonly subjectClass: string;
  readonly actionType: string;
  /** Exact action parameters fingerprint (modified action invalidates). */
  readonly actionParamsFingerprint: string;
  /** Mission risk bound at evaluation time. */
  readonly missionRiskClass: string;
  readonly policyVersion: string;
  readonly approvalBindingHash: string;
  readonly expiresAt: string;
}

export interface MissionGovernanceApprovalCommand {
  readonly userId: number;
  readonly campaignId: null;
  readonly approvalType: typeof MISSION_ACTION_APPROVAL_TYPE;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly description: string;
  readonly aiRecommendation: string;
  readonly riskLevel: "low" | "medium" | "high";
  readonly context: {
    readonly missionGovernanceBinding: MissionGovernanceApprovalBindingRecord;
  };
}

function fail(code: MissionGovernanceErrorCode, message: string): never {
  throw new MissionGovernanceValidationError(code, message);
}

/** Deterministic idempotency key: one decision -> at most one durable approval row. */
export function buildMissionApprovalIdempotencyKey(governanceDecisionId: string): string {
  if (typeof governanceDecisionId !== "string" || governanceDecisionId.trim().length === 0) {
    fail("INVALID_DECISION_IDENTITY", "governanceDecisionId must be a non-blank string");
  }
  return `${IDEMPOTENCY_KEY_PREFIX}:${createHash("sha256")
    .update(`${MISSION_GOVERNANCE_APPROVAL_CONTRACT_VERSION}:${governanceDecisionId.trim()}`, "utf8")
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
 * a human must authorize. Mission governance never carries a campaign
 * (campaignId is null — this stream never touches campaign execution).
 */
export function buildMissionApprovalCommand(input: {
  decision: MissionGovernanceDecision;
  userId: number;
}): MissionGovernanceApprovalCommand {
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

  const binding: MissionGovernanceApprovalBindingRecord = Object.freeze({
    contractVersion: MISSION_GOVERNANCE_APPROVAL_CONTRACT_VERSION,
    governanceDecisionId: decision.governanceDecisionId,
    businessId: decision.businessId,
    missionRef: decision.missionRef,
    planRef: decision.planRef,
    taskRef: decision.taskRef,
    subjectClass: decision.subjectClass,
    actionType: decision.actionType,
    actionParamsFingerprint: decision.actionParamsFingerprint,
    missionRiskClass: decision.missionRiskClass,
    policyVersion: decision.policyVersion,
    approvalBindingHash: decision.approvalBinding.approvalBindingHash,
    expiresAt: decision.approvalBinding.expiresAt,
  });

  return Object.freeze({
    userId: input.userId,
    campaignId: null,
    approvalType: MISSION_ACTION_APPROVAL_TYPE,
    idempotencyKey: buildMissionApprovalIdempotencyKey(decision.governanceDecisionId),
    title: `Mission Governance Approval: ${decision.subjectClass}/${decision.actionType} (${decision.missionRef})`,
    description: [
      "Governance evaluation determined this mission action requires explicit human approval before it may be consumed for execution.",
      "Approving authorizes exactly this subject/action under the bound policy version and action parameter fingerprint.",
      "",
      `Mission: ${decision.missionRef}`,
      `Plan: ${decision.planRef ?? "—"}  Task: ${decision.taskRef ?? "—"}`,
      `Subject: ${decision.subjectClass}  Action: ${decision.actionType}`,
      `Mission risk: ${decision.missionRiskClass}`,
      `Policy: ${decision.policyVersion}`,
      "",
      "Nothing has been executed. This approval is bounded to the exact bound mission action only — it can never authorize a different mission, plan, task, subject, action or parameter set, and it can never invoke providers, move budget, or mutate policy. Rejection permanently blocks this decision identity.",
    ].join("\n"),
    aiRecommendation: `Governance-bound mission action awaiting human approval. Reasons: ${decision.reasonCodes.join(", ")}`,
    riskLevel: toApprovalRiskLevel(decision.missionRiskClass),
    context: Object.freeze({ missionGovernanceBinding: binding }),
  });
}

/** Minimal approval row view needed for the consumable assertion. */
export interface MissionApprovalView {
  readonly id: number;
  readonly userId: number;
  readonly status: "pending" | "approved" | "rejected" | "edited";
  readonly context: unknown;
}

function parseBinding(context: unknown): MissionGovernanceApprovalBindingRecord | null {
  if (typeof context !== "object" || context === null) return null;
  const binding = (context as Record<string, unknown>).missionGovernanceBinding;
  if (typeof binding !== "object" || binding === null) return null;
  const b = binding as Record<string, unknown>;
  if (typeof b.governanceDecisionId !== "string" || typeof b.policyVersion !== "string") {
    return null;
  }
  return b as unknown as MissionGovernanceApprovalBindingRecord;
}

/** Read the durable binding from an approval row context (null when absent). */
export function readMissionApprovalBinding(
  context: unknown
): MissionGovernanceApprovalBindingRecord | null {
  return parseBinding(context);
}

export type MissionActionConsumptionVerdict =
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
        readonly authorizedAt: string;
        readonly expiresAt: string;
      };
    }
  | {
      readonly consumable: false;
      readonly reason: MissionGovernanceReasonCode;
      readonly permanent: boolean;
    };

function deny(
  reason: MissionGovernanceReasonCode,
  permanent = false
): MissionActionConsumptionVerdict {
  return { consumable: false, reason, permanent };
}

/** The exact action a downstream consumer intends to execute (server-side). */
export interface ExpectedMissionAction {
  readonly subjectClass: string;
  readonly actionType: string;
  readonly missionRef: string;
  readonly planRef: string | null;
  readonly taskRef: string | null;
  readonly actionParams: unknown;
}

/**
 * The single downstream execution consumption gate (F6). Downstream R9-D/E
 * MUST call this immediately before any material effect and must revalidate
 * governance when anything changed. Inputs are server-side authoritative:
 * the durable decision row, the ledger approval row, the current policy
 * version and the exact action the consumer intends to execute (from its own
 * execution context — never a client-supplied authorization).
 *
 * - ALLOW: consumable until validUnder, while the policy version is unchanged;
 * - REVIEW_REQUIRED: consumable only with an approved binding matching the
 *   exact decision + policy version + action params fingerprint + refs +
 *   risk class, unexpired, under an unchanged policy;
 * - human rejection permanently blocks the decision identity: the only path
 *   forward is a NEW governed proposal;
 * - BLOCK is never consumable;
 * - the expected action must match the bound decision EXACTLY — a modified
 *   action, a different mission/plan/task, a different subject or action
 *   class all fail closed (AC5/AC6/AC7).
 *
 * No client-provided ALLOW, no agent-provided ALLOW, no model-generated
 * authorization: the verdict is computed only from durable rows + the bound
 * policy.
 */
export function assertMissionActionConsumable(input: {
  decision: MissionGovernanceDecision;
  approval: MissionApprovalView | null;
  expectedAction: ExpectedMissionAction;
  currentPolicyVersion: string | null;
  now: string;
}): MissionActionConsumptionVerdict {
  const { decision, approval, expectedAction, currentPolicyVersion, now } = input;
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    fail("INVALID_EVALUATION_CLOCK", `now must be a valid ISO timestamp, got ${String(now)}`);
  }

  // The exact action must match the bound decision — cross-subject,
  // cross-mission, cross-task or modified-parameter consumption fails closed.
  const expectedFingerprint = deriveActionParamsFingerprint(expectedAction.actionParams);
  if (
    expectedAction.subjectClass !== decision.subjectClass ||
    expectedAction.actionType !== decision.actionType ||
    expectedAction.missionRef !== decision.missionRef ||
    expectedAction.planRef !== decision.planRef ||
    expectedAction.taskRef !== decision.taskRef ||
    expectedFingerprint !== decision.actionParamsFingerprint
  ) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }

  if (decision.decision === "ALLOW") {
    if (currentPolicyVersion !== decision.policyVersion) {
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
        policyVersion: decision.policyVersion ?? "",
        authorizedAt: now,
        expiresAt: decision.validUntil ?? "",
      },
    };
  }

  if (decision.decision === "BLOCK") {
    return deny(decision.reasonCodes[0] ?? "MISSION_BLOCKED_BY_POLICY");
  }

  // REVIEW_REQUIRED
  if (approval === null) return deny("APPROVAL_NOT_FOUND");
  if (approval.status === "pending") return deny("APPROVAL_PENDING");
  if (approval.status === "rejected") return deny("APPROVAL_REJECTED_BY_HUMAN", true);
  if (approval.status === "edited") return deny("APPROVAL_BINDING_MISMATCH");

  // Agent self-approval guard: the approval row must belong to the same
  // tenant; a row minted by the proposing agent identity is never authority.
  // (Independent human presence for the approve act itself is enforced by the
  // OTP review challenge — see mission-review-authority.ts; an autonomous
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
  const expectedHash = deriveMissionApprovalBindingHash({
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
    binding.businessId !== decision.businessId
  ) {
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
      authorityScope: "MISSION_ACTION",
      governanceDecisionId: decision.governanceDecisionId,
      businessId: decision.businessId,
      missionRef: decision.missionRef,
      planRef: decision.planRef,
      taskRef: decision.taskRef,
      subjectClass: decision.subjectClass,
      actionType: decision.actionType,
      approvalRequestId: approval.id,
      policyVersion: decision.policyVersion ?? "",
      authorizedAt: now,
      expiresAt: binding.expiresAt,
    },
  };
}

/**
 * Pre-approval validation (runs inside the approval decision transaction):
 * authorizing a pending mission_action request is only valid while the bound
 * decision, policy version, action params fingerprint, refs and risk class
 * are unchanged and the binding has not expired. Rejection is always
 * permitted. Throws (fail closed).
 */
export function validateMissionApprovalAuthorizable(input: {
  approval: MissionApprovalView;
  decision: MissionGovernanceDecision | null;
  currentPolicyVersion: string | null;
  now: string;
}): void {
  const { approval, decision, currentPolicyVersion, now } = input;
  if (approval.status !== "pending") {
    fail("APPROVAL_NOT_FOUND", `Approval request is already ${approval.status}.`);
  }
  const binding = parseBinding(approval.context);
  if (binding === null) {
    fail("APPROVAL_BINDING_MISMATCH", "Approval request carries no mission governance binding");
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
      "STALE_POLICY_VERSION: the mission governance policy has changed since this action was evaluated; a new governed proposal is required."
    );
  }
  const expectedHash = deriveMissionApprovalBindingHash({
    governanceDecisionId: decision.governanceDecisionId,
    policyVersion: decision.policyVersion ?? "",
    actionParamsFingerprint: decision.actionParamsFingerprint,
    missionRiskClass: decision.missionRiskClass,
  });
  if (
    binding.approvalBindingHash !== expectedHash ||
    binding.actionParamsFingerprint !== decision.actionParamsFingerprint
  ) {
    fail(
      "APPROVAL_BINDING_MISMATCH",
      "APPROVAL_BINDING_MISMATCH: the action parameters changed since evaluation; the authorization is stale."
    );
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
    fail(
      "APPROVAL_BINDING_MISMATCH",
      "APPROVAL_BINDING_MISMATCH: the bound mission coordinates changed since evaluation; the authorization is stale."
    );
  }
  if (Date.parse(binding.expiresAt) <= Date.parse(now)) {
    fail("EXPIRED_APPROVAL", "The approval binding has expired; a new governed proposal is required");
  }
}
