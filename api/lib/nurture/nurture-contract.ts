// ─── R6-D Nurture / Sales Handoff — closed contract vocabularies (contract §5) ───
//
// PURE module: the closed words the nurture/handoff authority speaks, plus
// the bounded input schemas and the error taxonomy. Everything fails closed
// outside these vocabularies. No I/O, no clock, no database access.

import { z } from "zod";

export const NURTURE_HANDOFF_CONTRACT_VERSION = "lead-nurture-sales-handoff/v1" as const;

// ─── Decision vocabulary (contract §5) ───

export const NURTURE_DECISIONS = [
  "NURTURE",
  "SALES_HANDOFF",
  "WAIT",
  "REVIEW_REQUIRED",
  "BLOCKED",
  "NO_ACTION",
] as const;

export type NurtureDecision = (typeof NURTURE_DECISIONS)[number];

const NURTURE_DECISION_SET: ReadonlySet<string> = new Set(NURTURE_DECISIONS);

export function isNurtureDecision(value: unknown): value is NurtureDecision {
  return typeof value === "string" && NURTURE_DECISION_SET.has(value);
}

// ─── Reason-code vocabulary (closed; codes explain, they never authorize) ───

export const NURTURE_REASON_CODES = [
  "ACTION_ALLOWED_BY_POLICY",
  "DECISION_NOT_QUALIFIED",
  "DECISION_BLOCKED",
  "INSUFFICIENT_EVIDENCE",
  "REVIEW_REQUIRED_PENDING",
  "REVIEW_REJECTED",
  "STALE_DECISION",
  "PRIVACY_SUPPRESSED",
  "PRIVACY_RESTRICTED",
  "RETENTION_EXPIRED",
  "PRIVACY_ARCHIVED",
  "PRIVACY_STATE_UNAVAILABLE",
  "CONVERSION_STOP",
  "NURTURE_CADENCE_LIMITED",
  "CAPABILITY_UNSUPPORTED",
  "CAPABILITY_REQUIRES_CONFIGURATION",
  "CAPABILITY_BLOCKED",
  "APPROVAL_REQUIRED_BY_POLICY",
  "APPROVAL_PENDING",
  "ACTION_REJECTED_BY_HUMAN",
  "APPROVAL_BINDING_MISMATCH",
  "EXPIRED_DECISION",
  "STALE_POLICY_VERSION",
  "POLICY_MISSING",
  "UPSTREAM_CONTRACT_MISMATCH",
  "OWNERSHIP_MISMATCH",
  "HANDOFF_CANCELLED",
  "NURTURE_REPLAY_CONFLICT",
  "HANDOFF_REPLAY_CONFLICT",
  "NURTURE_UPSTREAM_UNAVAILABLE",
  "NURTURE_DEFAULTED_TO_BLOCKED",
] as const;

export type NurtureReasonCode = (typeof NURTURE_REASON_CODES)[number];

const NURTURE_REASON_CODE_SET: ReadonlySet<string> = new Set(NURTURE_REASON_CODES);

export function isNurtureReasonCode(value: unknown): value is NurtureReasonCode {
  return typeof value === "string" && NURTURE_REASON_CODE_SET.has(value);
}

// ─── Channels (closed) ───

export const NURTURE_CHANNELS = ["email", "whatsapp", "sms", "crm"] as const;

export type NurtureChannel = (typeof NURTURE_CHANNELS)[number];

const NURTURE_CHANNEL_SET: ReadonlySet<string> = new Set(NURTURE_CHANNELS);

export function isNurtureChannel(value: unknown): value is NurtureChannel {
  return typeof value === "string" && NURTURE_CHANNEL_SET.has(value);
}

// ─── Provider capability states (closed — contract §10) ───

export const PROVIDER_CAPABILITY_STATES = [
  "SUPPORTED",
  "UNSUPPORTED",
  "REQUIRES_CONFIGURATION",
  "REQUIRES_APPROVAL",
  "BLOCKED",
] as const;

export type ProviderCapabilityState = (typeof PROVIDER_CAPABILITY_STATES)[number];

// ─── Handoff lifecycle (closed — contract §8) ───

export const HANDOFF_LIFECYCLE_STATES = [
  "PREPARED",
  "APPROVAL_REQUIRED",
  "APPROVED",
  "DISPATCH_PENDING",
  "DISPATCHED",
  "ACKNOWLEDGED",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
] as const;

export type HandoffLifecycleState = (typeof HANDOFF_LIFECYCLE_STATES)[number];

const HANDOFF_LIFECYCLE_SET: ReadonlySet<string> = new Set(HANDOFF_LIFECYCLE_STATES);

export function isHandoffLifecycleState(value: unknown): value is HandoffLifecycleState {
  return typeof value === "string" && HANDOFF_LIFECYCLE_SET.has(value);
}

/** Allowed lifecycle transitions (CAS-guarded). One-way where terminal. */
export const HANDOFF_LIFECYCLE_TRANSITIONS: Record<
  HandoffLifecycleState,
  readonly HandoffLifecycleState[]
> = {
  PREPARED: ["APPROVAL_REQUIRED", "APPROVED", "DISPATCH_PENDING", "BLOCKED", "CANCELLED"],
  APPROVAL_REQUIRED: ["APPROVED", "BLOCKED", "CANCELLED"],
  APPROVED: ["DISPATCH_PENDING", "BLOCKED", "CANCELLED"],
  DISPATCH_PENDING: ["DISPATCHED", "FAILED", "BLOCKED"],
  DISPATCHED: ["ACKNOWLEDGED", "FAILED"],
  ACKNOWLEDGED: [],
  FAILED: ["DISPATCH_PENDING", "BLOCKED", "CANCELLED"],
  BLOCKED: [],
  CANCELLED: [],
};

export function isHandoffTransitionAllowed(
  from: HandoffLifecycleState,
  to: HandoffLifecycleState
): boolean {
  return HANDOFF_LIFECYCLE_TRANSITIONS[from].includes(to);
}

// ─── Bounded router inputs (ids and bounded options only — never authority) ───

export const EvaluateNurtureInputSchema = z.strictObject({
  qualificationId: z.string().min(1).max(96),
  channel: z.enum(NURTURE_CHANNELS).optional(),
});

export const GetNurtureDecisionInputSchema = z.strictObject({
  nurtureDecisionId: z.string().min(1).max(96),
});

export const GetHandoffInputSchema = z.strictObject({
  handoffId: z.string().min(1).max(96),
});

export const DispatchHandoffInputSchema = z.strictObject({
  handoffId: z.string().min(1).max(96),
});

export const DispatchNurtureTouchInputSchema = z.strictObject({
  nurtureDecisionId: z.string().min(1).max(96),
});

// ─── Error taxonomy ───

export const NURTURE_ERROR_CODES = [
  "QUALIFICATION_NOT_FOUND",
  "NURTURE_UPSTREAM_CONTRACT_MISMATCH",
  "OWNERSHIP_MISMATCH",
  "FORBIDDEN",
  "POLICY_MISSING",
  "STALE_POLICY_VERSION",
  "APPROVAL_BINDING_MISMATCH",
  "APPROVAL_NOT_FOUND",
  "APPROVAL_PENDING",
  "ACTION_REJECTED_BY_HUMAN",
  "EXPIRED_DECISION",
  "CAPABILITY_UNSUPPORTED",
  "CAPABILITY_BLOCKED",
  "NURTURE_REPLAY_CONFLICT",
  "HANDOFF_REPLAY_CONFLICT",
  "HANDOFF_NOT_FOUND",
  "HANDOFF_STATE_CONFLICT",
  "DECISION_NOT_FOUND",
  "DECISION_NOT_EXECUTABLE",
  "NURTURE_SCHEMA_UNAVAILABLE",
  "PRIVACY_STATE_UNAVAILABLE",
  "INVALID_NURTURE_INPUT",
  "NURTURE_UPSTREAM_UNAVAILABLE",
  "NURTURE_DEFAULTED_TO_BLOCKED",
] as const;

export type NurtureErrorCode = (typeof NURTURE_ERROR_CODES)[number];

export class NurtureError extends Error {
  readonly code: NurtureErrorCode;

  constructor(code: NurtureErrorCode, message: string) {
    super(message);
    this.name = "NurtureError";
    this.code = code;
  }
}

export function failNurture(code: NurtureErrorCode, message: string): never {
  throw new NurtureError(code, message);
}

/** Duplicate-key detection shared by the store (same pattern as R5-D/R5-E). */
export function isDuplicateKeyError(err: unknown): boolean {
  const seen = new WeakSet<object>();
  let current: unknown = err;
  let depth = 0;
  while (current && typeof current === "object" && depth < 5) {
    if (seen.has(current)) break;
    seen.add(current);
    const e = current as Record<string, unknown>;
    if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true;
    current = e.cause;
    depth += 1;
  }
  return false;
}
