/**
 * Canonical Audit Event Contract.
 *
 * WBS7A scope:
 * - one domain-neutral material-event taxonomy (AUDIT_EVENT_TYPES);
 * - one immutable, structured audit-event envelope (AuditEvent);
 * - pure constructor/validator (createAuditEvent): no database access, no
 *   logging, no clock, no side effects; timestamps are never invented;
 * - deterministic normalization + fingerprinting for the same material input;
 * - metadata hygiene: structured JSON-like values only, Error objects and
 *   request-like/class instances rejected, sensitive keys removed
 *   deterministically;
 * - no runtime call-site changes and no persistence in this slice.
 *
 * Reuse boundary: correlation identifiers intentionally align with
 * WorkflowCorrelationContext / WorkflowAttempt in
 * ../workflow/workflow-operation, and workflow-related metadata is typed via
 * type-only imports. workflow-operation never imports this module, so there is
 * no circular dependency. WorkflowOperationType is NOT replaced or mutated.
 */

import { createHash } from "crypto";
import type {
  WorkflowOperationStatus,
  WorkflowOperationType,
} from "../workflow/workflow-operation";

export const AUDIT_EVENT_SCHEMA_VERSION = 1 as const;

/**
 * Canonical material-event taxonomy. Domain-neutral: these describe material
 * business facts, not operation kinds (WorkflowOperationType stays separate).
 */
export const AUDIT_EVENT_TYPES = [
  "workflow_transition",
  "approval_requested",
  "approval_resolved",
  "billing_deduction",
  "billing_refund_release",
  "publication_attempt",
  "publication_success",
  "publication_failure",
  "engagement_escalation",
  "learning_record_creation",
  "strategy_snapshot_materialized",
  "learning_promotion_resolved",
  // R4-F: privileged/admin mutations recorded by the operator control plane.
  // One material type; the specific action lives in sanitized metadata.
  "admin_mutation",
  // R5-B: one accepted intent & sentiment interpretation record; idempotent
  // replays return the existing row and do not re-emit the event.
  "interpretation_recorded",
  // R5-E: a governed marketing-action policy decision was durably recorded.
  // The decision, policy version, reason codes and gate outcomes live in
  // sanitized metadata — never raw social content.
  "policy_decision",
  // R5-C: a governed engagement action reached a terminal non-receipt state
  // (blocked / never-executed / failed). Identity references + bounded reason
  // only — never raw social content or reply text.
  "engagement_execution",
  // R5-C: an immutable engagement receipt was accepted. Carries opaque
  // identity references (ids, hashes, bounded provider acknowledgement).
  "engagement_receipt",
  // R5-D: opportunity detection durable effects (pre-lead candidates only).
  // One canonical event per durable effect; ids/labels/hashes in metadata only.
  "opportunity_detected",
  "opportunity_suppressed",
  "opportunity_state_changed",
  "opportunity_handed_off",
  // R6-A: lead identity durable effects (identity authority only — never
  // scores, qualification, outreach, or conversion). One canonical event per
  // durable effect; ids/closed labels/hashes in metadata only, never PII.
  "lead_identity_created",
  "lead_identity_observed",
  "lead_identity_evidence_attached",
  "lead_identity_merged",
  "lead_identity_conflict",
  "lead_identity_suppressed",
  "lead_identity_archived",
  // R6-B: one immutable lead score record was durably created. Carries opaque
  // identity references + bounded score labels only; idempotent replays do not
  // re-emit. A score is evidence, never a qualification decision.
  "lead_score_recorded",
  // R6-E: a durable conversion/outcome record was accepted (or an idempotent
  // replay converged to it). Metadata carries ids/classes/hashes only — never
  // raw social content or PII.
  "conversion_recorded",
  // R6-C: lead qualification durable effects. Exactly one evaluated event per
  // inserted decision and one resolved event per review resolution;
  // convergence/replay paths emit zero events. References + bounded labels only.
  "lead_qualification_evaluated",
  "lead_qualification_review_resolved",
  // R6-D: a governed nurture/handoff decision was durably recorded. Identity
  // references + decision + closed reason codes in metadata only — no PII,
  // no message text, no model reasoning.
  "lead_nurture_decision",
  // R6-D: a sales-handoff lifecycle transition (PREPARED…CANCELLED). One
  // event per real transition; convergence paths write zero events.
  "sales_handoff_state_changed",
  // R6-D: one handoff dispatch attempt (receipt-backed). Bounded outcome
  // labels only; the fake transport labels itself in the acknowledgement.
  "sales_handoff_dispatch",
  // R6-D: one governed nurture touch (exact-once, cadence-bounded).
  "lead_nurture_touch",
  // R7-A: a durable business outcome record was accepted (exactly one per
  // inserted outcome; convergence/replay paths emit zero). Metadata carries
  // ids/closed labels/authority classes only — never evidence text or PII.
  "business_outcome_recorded",
  // R7-A: one immutable outcome lifecycle fact was durably recorded
  // (verification / reversal / refund / cancellation / renewal / supersession).
  // One canonical event per inserted fact; convergence paths write zero events.
  "business_outcome_lifecycle",
  // R7-B: one immutable attribution result was durably calculated (or an
  // idempotent replay converged to it). Metadata carries ids/closed
  // labels/classes/hashes only — never social content, PII, or outcome
  // evidence text. Exactly one event per durable result; convergence emits zero.
  "attribution_calculated",
  // R7-B: one attribution result superseded a prior result (new evidence,
  // model/policy change, or outcome lifecycle change). References + bounded
  // labels only.
  "attribution_superseded",
  // R7-C: one durable business-learning record (or lifecycle transition)
  // was accepted. Metadata carries ids/closed labels/classes/counts only —
  // never evidence text, narrative drafts or PII; replay/convergence paths
  // emit zero events.
  "business_learning_recorded",
  // R7-F: a governed optimisation governance decision was durably recorded.
  // Identity references + decision + closed reason codes + bounded financial
  // labels in metadata only — no model reasoning, no proposal text.
  "optimisation_governance_decision",
  // R7-F: a narrow, closed-vocabulary operator recovery action was recorded
  // against an existing governance decision. Audit-only: the immutable
  // decision is never mutated by recovery.
  "optimisation_governance_recovery",
  // R7-D: experimentation durable effects. One canonical event per durable
  // effect; convergence/replay paths emit zero. Metadata carries ids, closed
  // labels, classes and hashes only — never subject references, evidence text
  // or PII. An experiment result is scoped causal evidence, never a general
  // causal claim.
  "experiment_created",
  "experiment_state_changed",
  "experiment_assignment_recorded",
  "experiment_evidence_bound",
  "experiment_result_recorded",
  // R7-E: budget/portfolio durable effects (snapshots, proposals, authorised
  // instructions). One canonical event per durable effect; convergence/replay
  // paths emit zero. Metadata carries ids/classes/hashes/allocations-counts
  // only — never free-form model output.
  "portfolio_snapshot_created",
  "optimisation_proposal_created",
  "optimisation_instruction_authorized",
  // R8-C: market/external signal durable effects. One canonical event per
  // inserted signal and one per inserted lifecycle fact; convergence/replay
  // paths emit zero. Metadata carries ids/closed labels/classes/hashes only —
  // never claim text, source content, or model reasoning.
  "external_signal_recorded",
  "external_signal_lifecycle",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** Who/what recorded the event. */
export const AUDIT_EVENT_SOURCES = [
  "user",
  "admin",
  "system",
  "workflow",
  "scheduler",
  "external",
  "strategy",
] as const;

export type AuditEventSource = (typeof AUDIT_EVENT_SOURCES)[number];

/** Result of the material fact the event records. */
export const AUDIT_EVENT_OUTCOMES = ["succeeded", "failed", "skipped"] as const;

export type AuditEventOutcome = (typeof AUDIT_EVENT_OUTCOMES)[number];

/**
 * Immutable audit-event envelope. Null correlation values stay null; no
 * identifier is ever invented. Field names intentionally match
 * WorkflowCorrelationContext where they overlap.
 */
export interface AuditEvent {
  readonly schemaVersion: typeof AUDIT_EVENT_SCHEMA_VERSION;
  readonly eventType: AuditEventType;
  /** Explicit caller-supplied ISO 8601 timestamp; never generated here. */
  readonly occurredAt: string;
  readonly userId: number;
  readonly source: AuditEventSource;
  readonly outcome: AuditEventOutcome;
  readonly campaignId: number | null;
  readonly businessId: number | null;
  readonly workflowOperationId: string | null;
  readonly workflowAttemptId: string | null;
  readonly approvalRequestId: number | null;
  /** Subject identifiers, where applicable. */
  readonly artifactId: string | number | null;
  readonly packageId: string | number | null;
  readonly contentId: string | number | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface CreateAuditEventInput {
  eventType: AuditEventType;
  occurredAt: string;
  userId: number;
  source: AuditEventSource;
  outcome: AuditEventOutcome;
  campaignId?: number | null;
  businessId?: number | null;
  workflowOperationId?: string | null;
  workflowAttemptId?: string | null;
  approvalRequestId?: number | null;
  artifactId?: string | number | null;
  packageId?: string | number | null;
  contentId?: string | number | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Advisory typed shape for workflow_transition event metadata. Reuses
 * workflow-operation types (type-only); the envelope still stores metadata as
 * a structured record.
 */
export interface WorkflowTransitionAuditMetadata {
  operationType: WorkflowOperationType;
  fromStatus: WorkflowOperationStatus;
  toStatus: WorkflowOperationStatus;
}

export class AuditEventError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AuditEventError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new AuditEventError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze<T extends object>(value: T): T {
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      if (nested !== null && typeof nested === "object") {
        deepFreeze(nested);
      }
    }
  }
  return value;
}

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(AUDIT_EVENT_TYPES);
const EVENT_SOURCE_SET: ReadonlySet<string> = new Set(AUDIT_EVENT_SOURCES);
const EVENT_OUTCOME_SET: ReadonlySet<string> = new Set(AUDIT_EVENT_OUTCOMES);

const ISO_8601_STRICT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Sensitive metadata keys (matched case-insensitively, at every nesting
 * level) are removed deterministically rather than persisted.
 */
const SENSITIVE_METADATA_KEY =
  /token|password|passwd|authorization|secret|credential|api[-_]?key|session|cookie/i;

const MAX_METADATA_DEPTH = 8;

function requireMemberOf(
  value: unknown,
  allowed: ReadonlySet<string>,
  code: string,
  field: string
): string {
  if (typeof value !== "string") {
    fail(code, `${field} must be a string, got ${String(value)}.`);
  }
  const trimmed = value.trim();
  if (!allowed.has(trimmed)) {
    fail(
      code,
      `${field} "${trimmed}" is not a canonical value. Allowed: ${Array.from(allowed).join(", ")}.`
    );
  }
  return trimmed;
}

function requireOccurredAt(value: unknown): string {
  if (typeof value !== "string") {
    fail("INVALID_AUDIT_OCCURRED_AT", `occurredAt must be an explicit ISO 8601 timestamp.`);
  }
  const trimmed = value.trim();
  if (!ISO_8601_STRICT.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    fail(
      "INVALID_AUDIT_OCCURRED_AT",
      `occurredAt must be an explicit, valid ISO 8601 timestamp; got ${JSON.stringify(value)}. Timestamps are never invented.`
    );
  }
  return trimmed;
}

function requireUserId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail("INVALID_AUDIT_USER_ID", `userId must be a positive integer, got ${String(value)}.`);
  }
  return value;
}

function normalizeNullablePositiveInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(
      "INVALID_AUDIT_CORRELATION_ID",
      `${field} must be a positive integer or null; got ${String(value)}.`
    );
  }
  return value;
}

function normalizeNullableIdString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(
      "INVALID_AUDIT_CORRELATION_ID",
      `${field} must be a non-blank string or null; got ${JSON.stringify(value)}.`
    );
  }
  return value.trim();
}

function normalizeNullableSubjectId(value: unknown, field: string): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      fail("INVALID_AUDIT_CORRELATION_ID", `${field} must not be a blank string.`);
    }
    return trimmed;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      fail(
        "INVALID_AUDIT_CORRELATION_ID",
        `${field} must be a positive integer, got ${String(value)}.`
      );
    }
    return value;
  }
  fail(
    "INVALID_AUDIT_CORRELATION_ID",
    `${field} must be a non-blank string, a positive integer, or null; got ${String(value)}.`
  );
}

function normalizeMetadataValue(value: unknown, depth: number, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        fail("INVALID_AUDIT_METADATA", `metadata number at ${path} must be finite.`);
      }
      return value;
    case "undefined":
      fail(
        "INVALID_AUDIT_METADATA",
        `metadata value at ${path} is undefined; structured metadata must be JSON-like.`
      );
      break;
    case "bigint":
    case "symbol":
    case "function":
      fail(
        "INVALID_AUDIT_METADATA",
        `metadata value at ${path} has non-structured type "${typeof value}".`
      );
      break;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeMetadataValue(item, depth + 1, `${path}[${index}]`));
  }
  if (value instanceof Error) {
    fail(
      "AUDIT_METADATA_ERROR_VALUE",
      `Error objects are not permitted in audit metadata at ${path}; pass a structured failureCode/message instead.`
    );
  }
  if (!isPlainObject(value)) {
    fail(
      "INVALID_AUDIT_METADATA",
      `metadata value at ${path} must be a plain structured object, not a class instance or request-like value.`
    );
  }
  return normalizeMetadataLevel(value, depth + 1);
}

function normalizeMetadataLevel(
  value: Record<string, unknown>,
  depth: number
): Record<string, unknown> {
  if (depth > MAX_METADATA_DEPTH) {
    fail(
      "INVALID_AUDIT_METADATA",
      `metadata exceeds maximum depth of ${MAX_METADATA_DEPTH} levels.`
    );
  }
  const sanitized: Record<string, unknown> = {};
  for (const rawKey of Object.keys(value)) {
    const key = rawKey.trim();
    if (key.length === 0) {
      fail("INVALID_AUDIT_METADATA_KEY", "metadata keys must be non-blank strings.");
    }
    if (SENSITIVE_METADATA_KEY.test(key)) continue;
    sanitized[key] = normalizeMetadataValue(value[rawKey], depth, key);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(sanitized).sort()) {
    sorted[key] = sanitized[key];
  }
  return sorted;
}

/**
 * Deterministically sanitize structured audit metadata: blank keys rejected,
 * sensitive keys removed at every level, values constrained to JSON-like
 * structures, object keys sorted. Pure; returns a fresh object.
 */
export function sanitizeAuditMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata === null || metadata === undefined) return {};
  if (!isPlainObject(metadata)) {
    fail("INVALID_AUDIT_METADATA", "metadata must be a structured object.");
  }
  return normalizeMetadataLevel(metadata, 1);
}

/**
 * Pure constructor/validator for the canonical audit-event envelope.
 * No I/O, no logging, no clock: the caller supplies occurredAt explicitly and
 * null correlation values are preserved as null. The returned event is deeply
 * frozen (immutable).
 */
export function createAuditEvent(input: CreateAuditEventInput): AuditEvent {
  if (!isPlainObject(input)) {
    fail("INVALID_AUDIT_EVENT_INPUT", "createAuditEvent requires a structured input object.");
  }
  const event: AuditEvent = {
    schemaVersion: AUDIT_EVENT_SCHEMA_VERSION,
    eventType: requireMemberOf(
      input.eventType,
      EVENT_TYPE_SET,
      "INVALID_AUDIT_EVENT_TYPE",
      "eventType"
    ) as AuditEventType,
    occurredAt: requireOccurredAt(input.occurredAt),
    userId: requireUserId(input.userId),
    source: requireMemberOf(
      input.source,
      EVENT_SOURCE_SET,
      "INVALID_AUDIT_EVENT_SOURCE",
      "source"
    ) as AuditEventSource,
    outcome: requireMemberOf(
      input.outcome,
      EVENT_OUTCOME_SET,
      "INVALID_AUDIT_EVENT_OUTCOME",
      "outcome"
    ) as AuditEventOutcome,
    campaignId: normalizeNullablePositiveInt(input.campaignId, "campaignId"),
    businessId: normalizeNullablePositiveInt(input.businessId, "businessId"),
    workflowOperationId: normalizeNullableIdString(input.workflowOperationId, "workflowOperationId"),
    workflowAttemptId: normalizeNullableIdString(input.workflowAttemptId, "workflowAttemptId"),
    approvalRequestId: normalizeNullablePositiveInt(input.approvalRequestId, "approvalRequestId"),
    artifactId: normalizeNullableSubjectId(input.artifactId, "artifactId"),
    packageId: normalizeNullableSubjectId(input.packageId, "packageId"),
    contentId: normalizeNullableSubjectId(input.contentId, "contentId"),
    metadata: sanitizeAuditMetadata(input.metadata),
  };
  return deepFreeze(event);
}

/**
 * Deterministic SHA-256 fingerprint of a canonical (normalized) event.
 * Identical material input always yields the same fingerprint, which later
 * durable audit persistence can use for deduplication.
 */
export function buildAuditEventFingerprint(event: AuditEvent): string {
  const sorted = Object.fromEntries(
    Object.entries(event).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
  return createHash("sha256").update(JSON.stringify(sorted), "utf8").digest("hex");
}
