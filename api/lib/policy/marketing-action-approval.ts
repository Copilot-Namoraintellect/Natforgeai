/**
 * Marketing-Action Approval / Escalation Authority (WBS-R5-E6).
 *
 * Bridges policy decisions into the existing governed approval patterns:
 * - REQUIRE_APPROVAL decisions produce one deterministic
 *   `marketing_action` approval request bound to the exact decision,
 *   policy version and content context;
 * - ESCALATE decisions produce the same durable row in escalation mode as
 *   the operator work queue (visible operator state), while execution
 *   authority is never granted by an escalation;
 * - downstream executors MUST call assertMarketingActionExecutable before
 *   acting: it is the single fail-closed gate converting a decision (+ human
 *   approval where required) into an execution authorization.
 *
 * Pure module: no database access, no clock, no I/O, no outbound calls.
 * Durable persistence reuses approval_requests with approvalType
 * "marketing_action" and the binding stored in the JSON context column.
 */

import { createHash } from "crypto";
import type { PolicyDecision } from "./decision-engine";
import type { PolicyReasonCode } from "./policy-types";

export const MARKETING_ACTION_APPROVAL_TYPE = "marketing_action" as const;

/**
 * Contract version bound into the idempotency hash; bumping invalidates
 * previously derived keys for the same decision.
 */
export const MARKETING_ACTION_APPROVAL_CONTRACT_VERSION = "policy/marketing-action@v1";

const IDEMPOTENCY_KEY_PREFIX = "ma1";

const APPROVAL_RISK_ORDER = ["low", "medium", "high"] as const;
type ApprovalRiskLevel = (typeof APPROVAL_RISK_ORDER)[number];

/** Durable binding persisted in approval_requests.context. */
export interface MarketingActionApprovalBinding {
  contractVersion: string;
  mode: "approval" | "escalation";
  policyDecisionId: string;
  actionRequestId: string;
  businessId: number;
  policyVersion: string;
  contextVersion: string;
  riskClass: string;
  estimatedCostClass: string;
  billingIdentity: string | null;
  expiresAt: string;
}

export interface MarketingActionApprovalCommand {
  userId: number;
  campaignId: number | null;
  approvalType: typeof MARKETING_ACTION_APPROVAL_TYPE;
  idempotencyKey: string;
  title: string;
  description: string;
  aiRecommendation: string;
  riskLevel: ApprovalRiskLevel;
  context: {
    marketingActionBinding: MarketingActionApprovalBinding;
  };
}

export class MarketingActionApprovalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MarketingActionApprovalError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new MarketingActionApprovalError(code, message);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Deterministic idempotency key for one decision: one decision -> at most one
 * durable approval row, so duplicate escalation/evaluation passes never
 * duplicate operator state.
 */
export function buildMarketingActionApprovalIdempotencyKey(policyDecisionId: string): string {
  if (typeof policyDecisionId !== "string" || policyDecisionId.trim().length === 0) {
    fail("INVALID_DECISION_IDENTITY", "policyDecisionId must be a non-blank string.");
  }
  return `${IDEMPOTENCY_KEY_PREFIX}:${sha256Hex(
    `${MARKETING_ACTION_APPROVAL_CONTRACT_VERSION}:${policyDecisionId.trim()}`
  )}`;
}

function toApprovalRiskLevel(riskClass: PolicyDecision["riskClass"]): ApprovalRiskLevel {
  // approval_requests.riskLevel is a 3-value enum; critical cannot reach
  // REQUIRE_APPROVAL (policy monotonicity), map defensively for escalations.
  if (riskClass === "low") return "low";
  if (riskClass === "medium") return "medium";
  return "high";
}

function bindingExpiry(decision: PolicyDecision): string {
  if (decision.approvalBinding?.expiresAt) return decision.approvalBinding.expiresAt;
  if (decision.expiresAt) return decision.expiresAt;
  // ESCALATE decisions carry no execution expiry; the operator queue binding
  // still expires on the policy execution TTL measured from evaluation time.
  const ttl = decision.thresholds.executionTtlMinutes;
  if (!ttl || !Number.isFinite(ttl)) {
    fail("INVALID_APPROVAL_INPUT", "Decision has no usable expiry for its binding.");
  }
  return new Date(Date.parse(decision.evaluatedAt) + ttl * 60_000).toISOString();
}

function buildDescription(decision: PolicyDecision, mode: "approval" | "escalation"): string {
  const lines =
    mode === "approval"
      ? [
          "Policy evaluation determined this marketing action requires explicit human approval before execution.",
          "Approving authorizes exactly this action under the bound policy version and context.",
          "",
          `Action: ${decision.actionType} on ${decision.platform}`,
          `Campaign: ${decision.campaignId ?? "Unassigned"}`,
          `Risk: ${decision.riskClass}`,
          `Policy: ${decision.policyVersion ?? "n/a"}`,
          "",
          "Nothing has been executed. Rejection permanently blocks this action identity.",
        ]
      : [
          "Policy evaluation escalated this marketing action for immediate human handling.",
          "Resolving this item records the operator outcome; it does not authorize machine execution.",
          "",
          `Action: ${decision.actionType} on ${decision.platform}`,
          `Campaign: ${decision.campaignId ?? "Unassigned"}`,
          `Risk: ${decision.riskClass}`,
          `Reasons: ${decision.reasonCodes.join(", ")}`,
          "",
          "A new governed action request is required after handling.",
        ];
  return lines.join("\n");
}

/**
 * Build the deterministic approval/escalation command for a decision.
 * Only REQUIRE_APPROVAL (mode approval) and ESCALATE (mode escalation)
 * decisions carry operator state; anything else fails closed.
 */
export function buildMarketingActionApprovalCommand(input: {
  decision: PolicyDecision;
  userId: number;
  mode: "approval" | "escalation";
}): MarketingActionApprovalCommand {
  const { decision, mode } = input;
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    fail("INVALID_APPROVAL_INPUT", `userId must be a positive integer, got ${String(input.userId)}.`);
  }
  if (mode === "approval" && decision.decision !== "REQUIRE_APPROVAL") {
    fail(
      "INVALID_APPROVAL_MODE",
      `Only REQUIRE_APPROVAL decisions produce approval commands; got ${decision.decision}.`
    );
  }
  if (mode === "escalation" && decision.decision !== "ESCALATE") {
    fail("INVALID_APPROVAL_MODE", `Only ESCALATE decisions produce escalation commands; got ${decision.decision}.`);
  }
  if (mode === "approval" && decision.approvalBinding === null) {
    fail("INVALID_APPROVAL_INPUT", "REQUIRE_APPROVAL decision is missing its approval binding.");
  }

  const binding: MarketingActionApprovalBinding = {
    contractVersion: MARKETING_ACTION_APPROVAL_CONTRACT_VERSION,
    mode,
    policyDecisionId: decision.policyDecisionId,
    actionRequestId: decision.actionRequestId,
    businessId: decision.businessId,
    policyVersion: decision.policyVersion ?? fail("INVALID_APPROVAL_INPUT", "Decision has no policyVersion."),
    contextVersion: decision.approvalBinding?.contextVersion ?? decision.evaluationFingerprint.slice(0, 16),
    riskClass: decision.riskClass,
    estimatedCostClass: decision.estimatedCostClass,
    billingIdentity: decision.billingIdentity,
    expiresAt: bindingExpiry(decision),
  };

  return {
    userId: input.userId,
    campaignId: decision.campaignId,
    approvalType: MARKETING_ACTION_APPROVAL_TYPE,
    idempotencyKey: buildMarketingActionApprovalIdempotencyKey(decision.policyDecisionId),
    title:
      mode === "approval"
        ? `Marketing Action Approval: ${decision.actionType} (${decision.platform})`
        : `Escalated Marketing Action: ${decision.actionType} (${decision.platform})`,
    description: buildDescription(decision, mode),
    aiRecommendation:
      mode === "approval"
        ? `Policy-bound action awaiting human approval. Reasons: ${decision.reasonCodes.join(", ")}`
        : `Escalated by policy. Reasons: ${decision.reasonCodes.join(", ")}`,
    riskLevel: toApprovalRiskLevel(decision.riskClass),
    context: { marketingActionBinding: binding },
  };
}

/** Minimal approval row view needed for executable assertion. */
export interface MarketingActionApprovalView {
  id: number;
  status: "pending" | "approved" | "rejected" | "edited";
  context: unknown;
}

function parseBinding(context: unknown): MarketingActionApprovalBinding | null {
  if (typeof context !== "object" || context === null) return null;
  const binding = (context as Record<string, unknown>).marketingActionBinding;
  if (typeof binding !== "object" || binding === null) return null;
  const b = binding as Record<string, unknown>;
  if (typeof b.policyDecisionId !== "string" || typeof b.policyVersion !== "string") return null;
  return b as unknown as MarketingActionApprovalBinding;
}

/** Read the durable binding from an approval row context (null when absent). */
export function readMarketingActionApprovalBinding(context: unknown): MarketingActionApprovalBinding | null {
  return parseBinding(context);
}

export type MarketingActionExecutionVerdict =
  | {
      executable: true;
      authorization: {
        policyDecisionId: string;
        actionRequestId: string;
        decision: "ALLOW_AUTONOMOUS" | "REQUIRE_APPROVAL";
        approvalRequestId: number | null;
        billingIdentity: string | null;
        riskClass: PolicyDecision["riskClass"];
        authorizedAt: string;
        expiresAt: string | null;
      };
    }
  | { executable: false; reason: PolicyReasonCode; permanent: boolean };

function deny(reason: PolicyReasonCode, permanent = false): MarketingActionExecutionVerdict {
  return { executable: false, reason, permanent };
}

/**
 * The single downstream execution gate (R5-C must call this before acting).
 *
 * - ALLOW_AUTONOMOUS: executable until expiry.
 * - REQUIRE_APPROVAL: executable only with an approved binding that matches
 *   the exact decision/policy version/context and has not expired, while the
 *   business policy is unchanged.
 * - Rejection permanently blocks the action identity: the only path forward
 *   is a NEW governed action request.
 * - ESCALATE is never machine-executable; DENY/NO_ACTION never execute.
 */
export function assertMarketingActionExecutable(input: {
  decision: PolicyDecision;
  approval: MarketingActionApprovalView | null;
  currentPolicyVersion: string | null;
  now: string;
}): MarketingActionExecutionVerdict {
  const { decision, approval, currentPolicyVersion, now } = input;
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) fail("INVALID_EVALUATION_CLOCK", `now must be a valid ISO timestamp, got ${String(now)}.`);

  if (decision.decision === "ALLOW_AUTONOMOUS") {
    if (currentPolicyVersion !== decision.policyVersion) {
      return deny("STALE_POLICY_VERSION");
    }
    if (decision.expiresAt && Date.parse(decision.expiresAt) <= nowMs) {
      return deny("EXPIRED_DECISION");
    }
    return {
      executable: true,
      authorization: {
        policyDecisionId: decision.policyDecisionId,
        actionRequestId: decision.actionRequestId,
        decision: "ALLOW_AUTONOMOUS",
        approvalRequestId: null,
        billingIdentity: decision.billingIdentity,
        riskClass: decision.riskClass,
        authorizedAt: now,
        expiresAt: decision.expiresAt,
      },
    };
  }

  if (decision.decision === "ESCALATE") {
    return deny("ESCALATION_REQUIRES_OPERATOR");
  }
  if (decision.decision === "DENY" || decision.decision === "NO_ACTION") {
    return deny(decision.reasonCodes[0] ?? "ACTION_DEFAULTED_TO_DENY");
  }

  // REQUIRE_APPROVAL
  if (approval === null) return deny("APPROVAL_NOT_FOUND");
  if (approval.status === "pending") return deny("APPROVAL_PENDING");
  if (approval.status === "rejected") return deny("ACTION_REJECTED_BY_HUMAN", true);
  if (approval.status === "edited") return deny("APPROVAL_BINDING_MISMATCH");

  const binding = parseBinding(approval.context);
  if (
    binding === null ||
    binding.policyDecisionId !== decision.policyDecisionId ||
    binding.mode !== "approval"
  ) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  if (currentPolicyVersion !== decision.policyVersion) {
    return deny("STALE_POLICY_VERSION");
  }
  if (decision.approvalBinding && binding.contextVersion !== decision.approvalBinding.contextVersion) {
    return deny("CONTEXT_VERSION_MISMATCH");
  }
  if (Date.parse(binding.expiresAt) <= nowMs) {
    return deny("EXPIRED_DECISION");
  }

  return {
    executable: true,
    authorization: {
      policyDecisionId: decision.policyDecisionId,
      actionRequestId: decision.actionRequestId,
      decision: "REQUIRE_APPROVAL",
      approvalRequestId: approval.id,
      billingIdentity: binding.billingIdentity,
      riskClass: decision.riskClass,
      authorizedAt: now,
      expiresAt: binding.expiresAt,
    },
  };
}

/**
 * Pre-approval validation (runs inside the approval decision transaction):
 * authorizing a pending marketing_action request is only valid while the
 * bound decision, policy version and context are unchanged, and the binding
 * has not expired. Rejection is always permitted — a human may reject
 * anything pending. Throws MarketingActionApprovalError (fail closed).
 */
export function validateMarketingActionApprovalAuthorizable(input: {
  approval: MarketingActionApprovalView;
  decision: PolicyDecision | null;
  currentPolicyVersion: string | null;
  now: string;
}): void {
  const { approval, decision, currentPolicyVersion, now } = input;
  if (approval.status !== "pending") {
    fail("APPROVAL_NOT_PENDING", `Approval request is already ${approval.status}.`);
  }
  const binding = parseBinding(approval.context);
  if (binding === null) {
    fail("APPROVAL_BINDING_MISMATCH", "Approval request carries no marketing action binding.");
  }
  if (decision === null) {
    fail("APPROVAL_BINDING_MISMATCH", `Bound policy decision ${binding.policyDecisionId} no longer exists.`);
  }
  if (binding.policyDecisionId !== decision.policyDecisionId) {
    fail("APPROVAL_BINDING_MISMATCH", "Approval binding does not match the policy decision identity.");
  }
  if (binding.policyVersion !== decision.policyVersion || currentPolicyVersion !== decision.policyVersion) {
    fail(
      "STALE_POLICY_VERSION",
      `STALE_POLICY_VERSION: the business policy has changed since this action was evaluated; a new governed request is required.`
    );
  }
  if (decision.approvalBinding && binding.contextVersion !== decision.approvalBinding.contextVersion) {
    fail("CONTEXT_VERSION_MISMATCH", "The action context changed since evaluation; the authorization is stale.");
  }
  if (Date.parse(binding.expiresAt) <= Date.parse(now)) {
    fail("EXPIRED_DECISION", "The approval binding has expired; a new governed request is required.");
  }
}
