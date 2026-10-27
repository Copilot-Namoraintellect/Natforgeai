// ─── R6-C Lead Qualification — governance/privacy seam (C boundary) ───
//
// Re-validates the untrusted R6-F privacy evidence before the qualification
// engine consumes it. Mirrors the R6-F gate exactly (inventory §5):
// ACTIVE/RETENTION_PENDING ⇒ actionable; SUPPRESSED/RESTRICTED ⇒ blocked
// (PRIVACY_SUPPRESSED); RETENTION_EXPIRED/ARCHIVED ⇒ blocked
// (RETENTION_EXPIRED). An absent privacy row degrades honestly to ACTIVE —
// suppression can only ever come from a validated governed state, never from
// a missing/unknown payload failing open in the dangerous direction.

import {
  QualificationValidationError,
  type NormalizedPrivacyState,
} from "./qualification-contract";

export const LEAD_PRIVACY_STATE_VALUES = [
  "ACTIVE",
  "SUPPRESSED",
  "RESTRICTED",
  "RETENTION_PENDING",
  "RETENTION_EXPIRED",
  "ARCHIVED",
] as const;
export type LeadPrivacyState = (typeof LEAD_PRIVACY_STATE_VALUES)[number];

const LEAD_PRIVACY_STATE_SET: ReadonlySet<string> = new Set(LEAD_PRIVACY_STATE_VALUES);

const PRIVACY_GATE_INPUT_KEYS = [
  "available",
  "state",
  "retentionDeadlineAt",
  "previousState",
  "source",
  "actorUserId",
  "updatedAt",
] as const;

const MAX_SOURCE_LENGTH = 64;

function fail(message: string): never {
  throw new QualificationValidationError("PRIVACY_STATE_INVALID", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireSubsetKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set<string>(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`privacy gate input carries unknown field: ${key}`);
  }
}

function requireNullableTimestamp(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || Number.isNaN(Date.parse(value))) {
    fail(`${field} must be an ISO-8601 timestamp or null, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNullableBoundedString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SOURCE_LENGTH) {
    fail(`${field} must be a non-empty string of at most ${MAX_SOURCE_LENGTH} chars or null`);
  }
  return value;
}

function requireNullablePositiveInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`${field} must be a positive integer or null, got ${String(value)}`);
  }
  return value;
}

/** The R6-F gate, applied to a validated privacy state. */
export function leadPrivacyGateFor(state: string): NormalizedPrivacyState {
  switch (state) {
    case "ACTIVE":
    case "RETENTION_PENDING":
      return Object.freeze({ state, actionable: true, blockedReason: null });
    case "SUPPRESSED":
    case "RESTRICTED":
      return Object.freeze({ state, actionable: false, blockedReason: "PRIVACY_SUPPRESSED" });
    case "RETENTION_EXPIRED":
    case "ARCHIVED":
      return Object.freeze({ state, actionable: false, blockedReason: "RETENTION_EXPIRED" });
    default:
      // Closed vocabulary is enforced by the seam; this is defense in depth.
      throw new QualificationValidationError(
        "PRIVACY_STATE_INVALID",
        `unknown lead privacy state: ${String(state)}`
      );
  }
}

/**
 * Resolves the untrusted privacy payload to a governed gate outcome.
 *
 * - null/undefined (row absent) ⇒ ACTIVE/actionable — the honest degrade,
 *   only legitimate once the bridge has established the authoritative
 *   identity→score→numeric-key chain for this lead.
 * - A present-but-unknown state string ⇒ PRIVACY_STATE_INVALID (fail closed).
 * - An absent state is honored as ACTIVE only when the bridge explicitly
 *   reports the privacy row unavailable (available === false); otherwise the
 *   payload is structurally meaningless and fails closed.
 * - RETENTION_PENDING whose retentionDeadlineAt has passed (clock supplied)
 *   resolves to the RETENTION_EXPIRED gate: the lead must not silently
 *   remain actionable past its deadline even before F's sweep transitions
 *   the durable row (R6-F §5/§7).
 */
export function resolvePrivacyGate(input: unknown, now?: Date): NormalizedPrivacyState {
  if (input === null || input === undefined) {
    return Object.freeze({ state: "ACTIVE", actionable: true, blockedReason: null });
  }
  if (!isPlainObject(input)) {
    fail("privacy gate input must be a plain object, null or undefined");
  }
  requireSubsetKeys(input, PRIVACY_GATE_INPUT_KEYS);

  if (input.available !== undefined && typeof input.available !== "boolean") {
    fail(`available must be a boolean when present, got ${String(input.available)}`);
  }
  // Bounded re-validation of the remaining governed fields.
  const retentionDeadlineAt = requireNullableTimestamp(input.retentionDeadlineAt, "retentionDeadlineAt");
  if (input.previousState !== undefined && input.previousState !== null) {
    if (typeof input.previousState !== "string" || !LEAD_PRIVACY_STATE_SET.has(input.previousState)) {
      fail(`previousState must be a known privacy state or null, got ${JSON.stringify(input.previousState)}`);
    }
  }
  requireNullableBoundedString(input.source, "source");
  requireNullablePositiveInt(input.actorUserId, "actorUserId");
  requireNullableTimestamp(input.updatedAt, "updatedAt");

  const state = input.state;
  if (state === undefined || state === null) {
    if (input.available === false) {
      return Object.freeze({ state: "ACTIVE", actionable: true, blockedReason: null });
    }
    fail("privacy state is required unless the bridge reports the row unavailable");
  }
  if (typeof state !== "string" || !LEAD_PRIVACY_STATE_SET.has(state)) {
    fail(`state must be one of ${LEAD_PRIVACY_STATE_VALUES.join(", ")}, got ${JSON.stringify(state)}`);
  }
  if (
    state === "RETENTION_PENDING" &&
    retentionDeadlineAt !== null &&
    now !== undefined &&
    now.getTime() > Date.parse(retentionDeadlineAt)
  ) {
    return Object.freeze({ state: "RETENTION_EXPIRED", actionable: false, blockedReason: "RETENTION_EXPIRED" });
  }
  return leadPrivacyGateFor(state);
}

export interface LeadPrivacyEvidenceRow {
  readonly leadId: string;
  readonly userId: number;
  readonly businessId: number | null;
  readonly privacyState: string;
  readonly previousState: string | null;
  readonly reason: string | null;
  readonly retentionDeadlineAt: string | null;
  readonly source: string | null;
  readonly actorUserId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Pure adapter from a lead_privacy_states-shaped row to the gate input
 * ({state, retentionDeadlineAt, updatedAt}). null (row absent) ⇒ null —
 * the caller then resolves the null gate, which degrades to ACTIVE once the
 * authoritative chain is established. State validity itself is enforced by
 * resolvePrivacyGate, never here.
 */
export function leadPrivacyEvidenceFromRow(row: unknown): Record<string, unknown> | null {
  if (row === null || row === undefined) return null;
  if (!isPlainObject(row)) {
    fail("privacy evidence row must be a plain object or null");
  }
  const evidence: Record<string, unknown> = { state: row.privacyState };
  if (row.retentionDeadlineAt !== undefined) {
    evidence.retentionDeadlineAt = toIsoOrNull(row.retentionDeadlineAt);
  }
  if (row.updatedAt !== undefined) {
    evidence.updatedAt = toIsoOrNull(row.updatedAt);
  }
  return evidence;
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
