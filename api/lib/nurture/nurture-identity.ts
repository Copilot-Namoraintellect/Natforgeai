// ─── R6-D Nurture / Sales Handoff — deterministic identities (contract §1) ───
//
// PURE module: decisionKey → nurtureDecisionId, handoffKey → handoffId,
// executionIdentity, touchIdentity, plus the shared canonicalJson/sha256Hex
// primitives. Identity binds the tenant anchor inside every hash, so
// cross-tenant collision/correlation is impossible. No wall-clock, no
// randomness: replaying the same authoritative inputs reproduces the same
// identity. No I/O.

import { createHash } from "crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export const NURTURE_DECISION_ID_PREFIX = "nd1:" as const;
export const HANDOFF_ID_PREFIX = "sh1:" as const;
export const EXECUTION_ID_PREFIX = "hd1:" as const;
export const TOUCH_ID_PREFIX = "nt1:" as const;

export const IDENTITY_ID_PATTERN = /^(nd1|sh1|hd1|nt1):[a-f0-9]{64}$/;

/**
 * Deterministic decision identity (contract §1). The input set is the exact
 * world-state D consumed: qualification content fingerprint, current privacy
 * state (+ its freshness marker), conversion stop, existing handoff,
 * policy version, channel. Same world-state ⇒ same decision; a changed
 * world-state ⇒ a new decision row (history is immutable, latest wins).
 */
export function deriveDecisionKey(input: {
  userId: number;
  businessId: number | null;
  leadId: string;
  qualificationId: string;
  qualificationFingerprint: string;
  privacyState: string;
  privacyStateUpdatedAt: string | null;
  conversionStopped: boolean;
  handoffExists: boolean;
  policyVersion: string;
  channel: string | null;
  /** Nurture path only: cadence gate outcome at evaluation time. */
  cadenceBlocked: boolean | null;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      userId: input.userId,
      businessId: input.businessId,
      leadId: input.leadId,
      qualificationId: input.qualificationId,
      qualificationFingerprint: input.qualificationFingerprint,
      privacyState: input.privacyState,
      privacyStateUpdatedAt: input.privacyStateUpdatedAt,
      conversionStopped: input.conversionStopped,
      handoffExists: input.handoffExists,
      policyVersion: input.policyVersion,
      channel: input.channel ?? null,
      cadenceBlocked: input.cadenceBlocked ?? null,
    })
  );
}

export function deriveNurtureDecisionId(decisionKey: string): string {
  return `${NURTURE_DECISION_ID_PREFIX}${decisionKey}`;
}

/**
 * Exact-once sales-handoff identity (contract §8): same business + lead +
 * qualification + handoff policy version ⇒ same handoffId, forever.
 */
export function deriveHandoffKey(input: {
  userId: number;
  businessId: number | null;
  leadId: string;
  qualificationId: string;
  handoffPolicyVersion: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      userId: input.userId,
      businessId: input.businessId,
      leadId: input.leadId,
      qualificationId: input.qualificationId,
      handoffPolicyVersion: input.handoffPolicyVersion,
    })
  );
}

export function deriveHandoffId(handoffKey: string): string {
  return `${HANDOFF_ID_PREFIX}${handoffKey}`;
}

/**
 * Execution identity (contract §11): one dispatch attempt, stable and
 * replay-safe. The transport receives this value as its idempotency key;
  * replaying an attempt converges to the same durable receipt.
 */
export function deriveExecutionIdentity(handoffId: string, attemptSeq: number): string {
  return `${EXECUTION_ID_PREFIX}${sha256Hex(canonicalJson({ v: 1, handoffId, attemptSeq }))}`;
}

/**
 * Nurture touch identity (contract §7): one touch, exact-once. Sequence
 * numbers derive from durable touch records only — no model-controlled loop.
 */
export function deriveTouchIdentity(input: {
  userId: number;
  leadId: string;
  nurtureDecisionId: string;
  touchSeq: number;
}): string {
  return `${TOUCH_ID_PREFIX}${sha256Hex(canonicalJson({ v: 1, ...input }))}`;
}

/** Fingerprint of an upstream qualification projection — binds D to the
 *  exact projection content it consumed (contract §2). */
export function fingerprintQualificationProjection(projection: unknown): string {
  return sha256Hex(canonicalJson(projection));
}

/** Content snapshot hash for approval binding (contract §9) — draft text is
 *  hashed, never stored on the approval row. */
export function hashContentSnapshot(content: unknown): string {
  return sha256Hex(canonicalJson({ v: 1, content }));
}
