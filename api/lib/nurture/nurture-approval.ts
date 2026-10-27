// ─── R6-D Nurture / Sales Handoff — approval binding authority (contract §9) ───
//
// PURE module: bridges governed sales-handoff approvals into the existing
// governed approval ledger (approval_requests, approval router human surface)
// with one additive approvalType "sales_handoff". Mirrors the R5-E
// marketing-action-approval discipline exactly:
//
//   - one deterministic approval row per handoff identity;
//   - the durable binding pins handoffId + decision + qualification
//     fingerprint + policy version + content snapshot + expiry;
//   - assertHandoffApprovalExecutable is the single fail-closed gate turning
//     (handoff + approval) into an execution authorization;
//   - human rejection permanently blocks the handoff identity;
//   - no self-approval: this module never resolves approvals — resolution
//     flows only through the human approval surface.
//
// No database access, no clock, no I/O, no outbound calls.

import { createHash } from "crypto";
import { failNurture } from "./nurture-contract";

export const SALES_HANDOFF_APPROVAL_TYPE = "sales_handoff" as const;

/** Contract version bound into the idempotency hash. */
export const SALES_HANDOFF_APPROVAL_CONTRACT_VERSION = "nurture/sales-handoff-approval@v1" as const;

const IDEMPOTENCY_KEY_PREFIX = "shf1";

/** Durable binding persisted in approval_requests.context.salesHandoffBinding. */
export interface SalesHandoffApprovalBinding {
  contractVersion: typeof SALES_HANDOFF_APPROVAL_CONTRACT_VERSION;
  handoffId: string;
  nurtureDecisionId: string;
  businessId: number | null;
  leadId: string;
  qualificationId: string;
  qualificationFingerprint: string;
  handoffPolicyVersion: string;
  contentSnapshotHash: string;
  expiresAt: string;
}

export interface SalesHandoffApprovalCommand {
  userId: number;
  campaignId: null;
  approvalType: typeof SALES_HANDOFF_APPROVAL_TYPE;
  idempotencyKey: string;
  title: string;
  description: string;
  aiRecommendation: string;
  riskLevel: "high";
  context: {
    salesHandoffBinding: SalesHandoffApprovalBinding;
  };
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Deterministic idempotency key: one handoff identity ⇒ at most one durable
 * approval row, so duplicate/concurrent preparation never duplicates operator
 * state.
 */
export function buildHandoffApprovalIdempotencyKey(handoffId: string): string {
  if (typeof handoffId !== "string" || handoffId.trim().length === 0) {
    failNurture("INVALID_NURTURE_INPUT", "handoffId must be a non-blank string.");
  }
  return `${IDEMPOTENCY_KEY_PREFIX}:${sha256Hex(
    `${SALES_HANDOFF_APPROVAL_CONTRACT_VERSION}:${handoffId.trim()}`
  )}`;
}

/** Build the deterministic approval command for one governed handoff. */
export function buildHandoffApprovalCommand(input: {
  handoffId: string;
  nurtureDecisionId: string;
  userId: number;
  businessId: number | null;
  leadId: string;
  qualificationId: string;
  qualificationFingerprint: string;
  handoffPolicyVersion: string;
  contentSnapshotHash: string;
  expiresAt: string;
  reasonCodes: readonly string[];
}): SalesHandoffApprovalCommand {
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    failNurture("INVALID_NURTURE_INPUT", `userId must be a positive integer, got ${String(input.userId)}.`);
  }
  const binding: SalesHandoffApprovalBinding = {
    contractVersion: SALES_HANDOFF_APPROVAL_CONTRACT_VERSION,
    handoffId: input.handoffId,
    nurtureDecisionId: input.nurtureDecisionId,
    businessId: input.businessId,
    leadId: input.leadId,
    qualificationId: input.qualificationId,
    qualificationFingerprint: input.qualificationFingerprint,
    handoffPolicyVersion: input.handoffPolicyVersion,
    contentSnapshotHash: input.contentSnapshotHash,
    expiresAt: input.expiresAt,
  };
  return {
    userId: input.userId,
    campaignId: null,
    approvalType: SALES_HANDOFF_APPROVAL_TYPE,
    idempotencyKey: buildHandoffApprovalIdempotencyKey(input.handoffId),
    title: `Sales Handoff Approval: ${input.leadId.slice(0, 18)}…`,
    description: [
      "A governed sales handoff was prepared for a QUALIFIED lead and requires explicit human approval before dispatch.",
      "Approving authorizes exactly this handoff identity under the bound policy version and content snapshot.",
      "",
      `Handoff: ${input.handoffId}`,
      `Qualification: ${input.qualificationId}`,
      `Policy: ${input.handoffPolicyVersion}`,
      `Reasons: ${input.reasonCodes.join(", ")}`,
      "",
      "Nothing has been executed. Rejection permanently blocks this handoff identity.",
    ].join("\n"),
    aiRecommendation: `Governed handoff awaiting human approval. Reasons: ${input.reasonCodes.join(", ")}`,
    riskLevel: "high",
    context: { salesHandoffBinding: binding },
  };
}

/** Minimal approval row view needed for the executable assertion. */
export interface SalesHandoffApprovalView {
  id: number;
  status: "pending" | "approved" | "rejected" | "edited";
  context: unknown;
}

function parseBinding(context: unknown): SalesHandoffApprovalBinding | null {
  if (typeof context !== "object" || context === null) return null;
  const binding = (context as Record<string, unknown>).salesHandoffBinding;
  if (typeof binding !== "object" || binding === null) return null;
  const b = binding as Record<string, unknown>;
  if (typeof b.handoffId !== "string" || typeof b.handoffPolicyVersion !== "string") return null;
  if (typeof b.contentSnapshotHash !== "string" || typeof b.expiresAt !== "string") return null;
  return b as unknown as SalesHandoffApprovalBinding;
}

/** Read the durable binding from an approval row context (null when absent). */
export function readSalesHandoffApprovalBinding(context: unknown): SalesHandoffApprovalBinding | null {
  return parseBinding(context);
}

export type HandoffApprovalVerdict =
  | {
      executable: true;
      authorization: {
        approvalRequestId: number;
        handoffId: string;
        handoffPolicyVersion: string;
        contentSnapshotHash: string;
        authorizedAt: string;
        expiresAt: string;
      };
    }
  | {
      executable: false;
      reason:
        | "APPROVAL_NOT_FOUND"
        | "APPROVAL_PENDING"
        | "ACTION_REJECTED_BY_HUMAN"
        | "APPROVAL_BINDING_MISMATCH"
        | "STALE_POLICY_VERSION"
        | "EXPIRED_DECISION";
      permanent: boolean;
    };

function deny(
  reason: Extract<HandoffApprovalVerdict, { executable: false }>["reason"],
  permanent = false
): HandoffApprovalVerdict {
  return { executable: false, reason, permanent };
}

/**
 * The single fail-closed execution gate for approved handoffs (contract §9):
 * converts (handoff identity + human approval + current policy) into an
 * execution authorization. Cross-lead / cross-business / cross-handoff replay,
 * forged bindings, stale policy versions, and expired bindings are rejected;
 * human rejection permanently blocks the identity.
 */
export function assertHandoffApprovalExecutable(input: {
  handoffId: string;
  handoffPolicyVersion: string;
  contentSnapshotHash: string;
  approval: SalesHandoffApprovalView | null;
  currentPolicyVersion: string;
  now: string;
}): HandoffApprovalVerdict {
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    failNurture("INVALID_NURTURE_INPUT", `now must be a valid ISO timestamp, got ${String(input.now)}.`);
  }
  if (input.approval === null) return deny("APPROVAL_NOT_FOUND");
  if (input.approval.status === "pending") return deny("APPROVAL_PENDING");
  if (input.approval.status === "rejected") return deny("ACTION_REJECTED_BY_HUMAN", true);
  if (input.approval.status === "edited") return deny("APPROVAL_BINDING_MISMATCH");

  const binding = parseBinding(input.approval.context);
  if (
    binding === null ||
    binding.handoffId !== input.handoffId ||
    binding.handoffPolicyVersion !== input.handoffPolicyVersion ||
    binding.contentSnapshotHash !== input.contentSnapshotHash
  ) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  if (input.currentPolicyVersion !== input.handoffPolicyVersion) {
    return deny("STALE_POLICY_VERSION");
  }
  if (Date.parse(binding.expiresAt) <= nowMs) {
    return deny("EXPIRED_DECISION");
  }

  return {
    executable: true,
    authorization: {
      approvalRequestId: input.approval.id,
      handoffId: binding.handoffId,
      handoffPolicyVersion: binding.handoffPolicyVersion,
      contentSnapshotHash: binding.contentSnapshotHash,
      authorizedAt: input.now,
      expiresAt: binding.expiresAt,
    },
  };
}

/**
 * Pre-approval validation (runs inside the approval decision transaction,
 * same injection point as R5-E): authorizing a pending sales_handoff request
 * is valid only while the bound handoff identity, policy version and content
 * snapshot are unchanged and the binding has not expired. Throws (fail
 * closed). Rejection is always permitted — a human may reject anything.
 */
export function validateHandoffApprovalAuthorizable(input: {
  approval: SalesHandoffApprovalView;
  handoff: { handoffId: string; handoffPolicyVersion: string; contentSnapshotHash: string } | null;
  currentPolicyVersion: string;
  now: string;
}): void {
  const { approval, handoff, currentPolicyVersion, now } = input;
  if (approval.status !== "pending") {
    failNurture("HANDOFF_STATE_CONFLICT", `Approval request is already ${approval.status}.`);
  }
  const binding = parseBinding(approval.context);
  if (binding === null) {
    failNurture("APPROVAL_BINDING_MISMATCH", "Approval request carries no sales-handoff binding.");
  }
  if (handoff === null) {
    failNurture("APPROVAL_BINDING_MISMATCH", `Bound handoff ${binding.handoffId} no longer exists.`);
  }
  if (
    binding.handoffId !== handoff.handoffId ||
    binding.handoffPolicyVersion !== handoff.handoffPolicyVersion ||
    binding.contentSnapshotHash !== handoff.contentSnapshotHash
  ) {
    failNurture(
      "APPROVAL_BINDING_MISMATCH",
      "APPROVAL_BINDING_MISMATCH: approval binding does not match the handoff identity."
    );
  }
  if (binding.handoffPolicyVersion !== currentPolicyVersion) {
    failNurture(
      "STALE_POLICY_VERSION",
      "STALE_POLICY_VERSION: the nurture/handoff policy has changed since this handoff was prepared; a new governed decision is required."
    );
  }
  if (Date.parse(binding.expiresAt) <= Date.parse(now)) {
    failNurture(
      "EXPIRED_DECISION",
      "EXPIRED_DECISION: the approval binding has expired; a new governed decision is required."
    );
  }
}
