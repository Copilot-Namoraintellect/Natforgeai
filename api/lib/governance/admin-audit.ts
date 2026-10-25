/**
 * Admin Mutation Audit Authority (WBS-R4-F1).
 *
 * Closes the R1/R3 governance finding that privileged/admin mutations lack
 * canonical audit events. Every privileged mutation across the admin
 * surface (admin router, banking, billing adjustment, alert management,
 * operator recovery actions) records one canonical `admin_mutation` audit
 * event through this module.
 *
 * Invariants:
 * - actor identity is ALWAYS the authenticated session user id supplied by
 *   the caller; an absent/invalid actor fails closed — an actor is never
 *   invented (e.g. no synthetic "system" actor for admin actions);
 * - the specific action is drawn from a closed vocabulary; unknown actions
 *   fail closed;
 * - metadata is assembled from an explicit allow-list built by each call
 *   site and then run through the canonical WBS7A sanitizer, so secrets
 *   (passwords, tokens, credentials, account numbers) can never reach the
 *   ledger — call sites must never place raw secrets in `metadata`;
 * - the caller supplies `occurredAt` (the mutation time); the module never
 *   re-stamps it; persistence goes through the canonical fingerprint-
 *   deduplicated audit store, optionally inside the caller's transaction so
 *   the mutation and its audit evidence commit or roll back as one unit;
 * - request correlation (`x-request-id`) is recorded only when present and
 *   well-formed.
 */

import {
  AuditEventError,
  createAuditEvent,
  type AuditEvent,
} from "../audit/audit-event";
import {
  persistAuditEvent,
  type AuditDbExecutor,
  type AuditDuplicateClassification,
} from "../audit/audit-store";

/** Canonical event type for every privileged/admin mutation. */
export const ADMIN_MUTATION_AUDIT_EVENT_TYPE = "admin_mutation" as const;

/**
 * Closed vocabulary of privileged actions. Callers must not construct
 * free-form action strings; a typo fails closed instead of silently landing
 * in the ledger under a nonsense action.
 */
export const ADMIN_AUDIT_ACTIONS = [
  "admin.user_role_updated",
  "admin.payment_status_updated",
  "admin.payment_recorded",
  "admin.user_deleted",
  "admin.user_created",
  "admin.banking_detail_created",
  "admin.banking_detail_updated",
  "admin.banking_detail_deleted",
  "admin.credit_adjustment",
  "admin.alert_acknowledged",
  "admin.alert_category_resolved",
  "admin.integration_business_assigned",
  "admin.terminal_replay_requested",
  "admin.terminal_replay_executed",
  "admin.terminal_replay_reconciled",
  "admin.diagnostic_authority_executed",
  "admin.campaign_budget_resume",
  "admin.stale_creative_claim_sweep",
  "admin.publish_due_posts_executed",
  // R5-F6: governed operator recovery actions on the R5 operations surface.
  // Failed attempts are recorded via outcome: "failed" (no new action entry).
  "admin.r5_operation_retry",
  // R6-F: governed lead privacy transitions and retention reconciliation on
  // the lead governance surface. Failed attempts use outcome: "failed".
  "admin.lead_privacy_state_changed",
  "admin.lead_retention_sweep",
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

const ADMIN_AUDIT_ACTION_SET: ReadonlySet<string> = new Set(ADMIN_AUDIT_ACTIONS);

/** Target authorities a privileged mutation can act on. */
export const ADMIN_AUDIT_TARGET_TYPES = [
  "user",
  "payment",
  "banking_detail",
  "credit_wallet",
  "system_alert",
  "social_integration",
  "terminal_replay",
  "terminal_replay_batch",
  "creative_claim_sweep",
  "campaign",
  "diagnostic_harness",
  "publishing_queue",
  // R5-F6: target authority for operations.retryOperation recovery actions.
  "r5_operation",
  // R6-F: target authorities for lead governance mutations.
  "lead",
  "lead_privacy_state",
  "lead_operation",
] as const;

export type AdminAuditTargetType = (typeof ADMIN_AUDIT_TARGET_TYPES)[number];

const ADMIN_AUDIT_TARGET_TYPE_SET: ReadonlySet<string> = new Set(ADMIN_AUDIT_TARGET_TYPES);

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_REASON_LENGTH = 500;

export interface RecordAdminMutationAuditInput {
  /** Authenticated session user id of the operator. Required, positive int. */
  actorUserId: number;
  /** Closed-vocabulary privileged action. */
  action: AdminAuditAction;
  /** Authority the action targets. */
  targetType: AdminAuditTargetType;
  /** Target identifier where one exists (e.g. user id, payment id). */
  targetId?: number | string | null;
  campaignId?: number | null;
  businessId?: number | null;
  /** Operator-supplied reason, bounded. Secrets must never be passed here. */
  reason?: string | null;
  /**
   * Optional request correlation id (e.g. x-request-id header). Recorded
   * only when well-formed; otherwise ignored.
   */
  requestId?: string | null;
  /**
   * Explicit allow-listed structured detail. Call sites build this from
   * whitelisted fields only; the canonical sanitizer strips any sensitive
   * key as defence in depth.
   */
  metadata?: Record<string, unknown> | null;
  outcome?: "succeeded" | "failed";
  /** Mutation time. Callers pass explicitly; defaults to now. */
  occurredAt?: Date;
  /** Caller-owned executor (e.g. the mutation's transaction client). */
  executor?: AuditDbExecutor;
}

export interface AdminMutationAuditRecord {
  readonly event: AuditEvent;
  readonly inserted: boolean;
  readonly duplicateClassification: AuditDuplicateClassification;
}

function requireActorUserId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new AuditEventError(
      "INVALID_AUDIT_USER_ID",
      "Admin mutation audit requires an authenticated actor user id; refusing to invent one."
    );
  }
  return value;
}

function requireAction(value: unknown): AdminAuditAction {
  if (typeof value !== "string" || !ADMIN_AUDIT_ACTION_SET.has(value)) {
    throw new AuditEventError(
      "INVALID_AUDIT_ACTION",
      `Unknown admin audit action: ${String(value)}. Allowed: ${ADMIN_AUDIT_ACTIONS.join(", ")}.`
    );
  }
  return value as AdminAuditAction;
}

function requireTargetType(value: unknown): AdminAuditTargetType {
  if (typeof value !== "string" || !ADMIN_AUDIT_TARGET_TYPE_SET.has(value)) {
    throw new AuditEventError(
      "INVALID_AUDIT_TARGET_TYPE",
      `Unknown admin audit target type: ${String(value)}. Allowed: ${ADMIN_AUDIT_TARGET_TYPES.join(", ")}.`
    );
  }
  return value as AdminAuditTargetType;
}

function normalizeReason(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_REASON_LENGTH);
}

function normalizeRequestId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return null;
  // Advisory correlation only: a malformed id is dropped, never fails the
  // audit and never trusted.
  if (!REQUEST_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function normalizeTargetId(value: number | string | null | undefined): number | string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      throw new AuditEventError(
        "INVALID_AUDIT_TARGET_ID",
        `Admin audit targetId must be a positive integer or string, got ${String(value)}.`
      );
    }
    return value;
  }
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 128);
}

/**
 * Extract a safe request correlation id from a Fetch Request, when present.
 */
export function extractAdminRequestId(req: unknown): string | null {
  if (typeof req !== "object" || req === null) return null;
  const headers = (req as { headers?: { get?: (name: string) => string | null } }).headers;
  if (typeof headers?.get !== "function") return null;
  try {
    return normalizeRequestId(headers.get("x-request-id"));
  } catch {
    return null;
  }
}

/**
 * Record one canonical audit event for a privileged/admin mutation.
 *
 * Fail closed: invalid actor, unknown action, or unknown target type throw
 * before anything is persisted. On persistence failure the error propagates
 * so call sites either roll back (executor = mutation transaction) or fail
 * loudly — a privileged mutation can never silently skip the ledger.
 */
export async function recordAdminMutationAudit(
  input: RecordAdminMutationAuditInput
): Promise<AdminMutationAuditRecord> {
  const actorUserId = requireActorUserId(input.actorUserId);
  const action = requireAction(input.action);
  const targetType = requireTargetType(input.targetType);
  const targetId = normalizeTargetId(input.targetId);
  const reason = normalizeReason(input.reason);
  const requestId = normalizeRequestId(input.requestId);
  const occurredAt = input.occurredAt ?? new Date();

  const metadata: Record<string, unknown> = {
    action,
    targetType,
    ...(targetId !== null ? { targetId } : {}),
    ...(reason !== null ? { reason } : {}),
    ...(requestId !== null ? { requestId } : {}),
    ...(input.metadata ?? {}),
  };

  const event = createAuditEvent({
    eventType: ADMIN_MUTATION_AUDIT_EVENT_TYPE,
    occurredAt: occurredAt.toISOString(),
    userId: actorUserId,
    source: "admin",
    outcome: input.outcome ?? "succeeded",
    campaignId: input.campaignId ?? null,
    businessId: input.businessId ?? null,
    metadata,
  });

  const result = await persistAuditEvent(event, input.executor);
  return {
    event,
    inserted: result.inserted,
    duplicateClassification: result.duplicateClassification,
  };
}
