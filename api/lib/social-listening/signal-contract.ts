/**
 * Canonical Social Signal contract (WBS-R5-A A1).
 *
 * One provider-neutral, provider-evidence-preserving normalized signal model.
 * This module is the type + identity authority for the governed evidence
 * layer consumed by R5-B/R5-C/R5-D (see
 * docs/contracts/social-signal-contract.md and
 * docs/contracts/social-listening-to-intelligence-contract.md).
 *
 * Scope guard: this stream owns signal acquisition and normalization ONLY.
 * No sentiment interpretation, engagement, qualification, scoring, or any
 * business-action decision happens at this layer.
 *
 * Identity principle (deterministic, server-derived):
 *
 *   one logical provider event
 *     (provider, providerAccountId, externalEventId)
 *   → one canonical social signal identity
 *     signalKey = "sigv1:" + sha256(provider | providerAccountId | externalEventId)
 *
 * The triple is the natural identity; the database enforces it uniquely
 * (social_signals.ss_natural_key_uidx) so duplicates and concurrent deliveries
 * of the same provider event collapse to exactly one durable row. signalKey is
 * never client-supplied and never derived from client-controlled fields.
 */

import { createHash } from "crypto";

export const SOCIAL_SIGNAL_PROVIDERS = ["meta", "linkedin", "twitter", "tiktok"] as const;
export type SocialSignalProvider = (typeof SOCIAL_SIGNAL_PROVIDERS)[number];

export const SOCIAL_SIGNAL_PLATFORMS = [
  "facebook",
  "instagram",
  "whatsapp",
  "linkedin",
  "twitter",
  "tiktok",
] as const;
export type SocialSignalPlatform = (typeof SOCIAL_SIGNAL_PLATFORMS)[number];

export const SOCIAL_SIGNAL_TYPES = [
  "comment",
  "reply",
  "mention",
  "reaction",
  "direct_message",
  "repost",
  "follow",
  "unfollow",
  "campaign_response",
  "inbound_message",
  "unknown",
] as const;
export type SocialSignalType = (typeof SOCIAL_SIGNAL_TYPES)[number];

export const SOCIAL_SIGNAL_ATTRIBUTION_TYPES = [
  "direct",
  "business",
  "unattributed",
] as const;
export type SocialSignalAttributionType = (typeof SOCIAL_SIGNAL_ATTRIBUTION_TYPES)[number];

export const SOCIAL_SIGNAL_INGESTION_VERSION = 1;

export const SIGNAL_KEY_PREFIX = "sigv1:";
export const SIGNAL_KEY_LENGTH = 64; // "sigv1:" (6) + sha256 hex (64→) — bounded by column

/** The single source of truth for the identity formula (documented in the
 *  contract). Canonical JSON array encoding keeps the triple unambiguous —
 *  component values may contain delimiters like "|" without colliding across
 *  different triples. */
export function deriveSignalKeyParts(input: {
  provider: string;
  providerAccountId: string;
  externalEventId: string;
}): string {
  return canonicalizeForHash([
    input.provider,
    input.providerAccountId,
    input.externalEventId,
  ]);
}

/**
 * Deterministic server-derived canonical identity. Same logical provider event
 * always yields the same signalKey; a different provider, account, or event id
 * never collides with another event's identity.
 */
export function deriveSignalKey(input: {
  provider: string;
  providerAccountId: string;
  externalEventId: string;
}): string {
  return (
    SIGNAL_KEY_PREFIX +
    createHash("sha256").update(deriveSignalKeyParts(input), "utf8").digest("hex")
  );
}

/** Canonical JSON (key-sorted) so evidence hashes are stable regardless of
 *  key order or whitespace in the source payload. */
export function canonicalizeForHash(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeForHash(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeForHash(obj[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * sha256 over the canonical provider evidence fragment that was accepted at
 * ingestion. Persisted on the durable row; any later mutation of the retained
 * evidence changes this hash, which is how immutability is proven under replay
 * (a replayed identical event reproduces the identical hash).
 */
export function buildProviderEvidenceHash(canonicalEvidenceFragment: unknown): string {
  return createHash("sha256")
    .update(canonicalizeForHash(canonicalEvidenceFragment), "utf8")
    .digest("hex");
}

export function isSocialSignalProvider(value: string): value is SocialSignalProvider {
  return (SOCIAL_SIGNAL_PROVIDERS as readonly string[]).includes(value);
}

export function isSocialSignalPlatform(value: string): value is SocialSignalPlatform {
  return (SOCIAL_SIGNAL_PLATFORMS as readonly string[]).includes(value);
}

export function isSocialSignalType(value: string): value is SocialSignalType {
  return (SOCIAL_SIGNAL_TYPES as readonly string[]).includes(value);
}

export function isSocialSignalAttributionType(
  value: string
): value is SocialSignalAttributionType {
  return (SOCIAL_SIGNAL_ATTRIBUTION_TYPES as readonly string[]).includes(value);
}

export const SIGNAL_EXTERNAL_ID_MAX = 255;
export const SIGNAL_CONTENT_TEXT_MAX = 1024;
export const SIGNAL_ACTOR_DISPLAY_NAME_MAX = 255;
export const SIGNAL_CONTENT_REFERENCE_MAX = 255;

/**
 * Identity-bearing external identifiers must be printable, non-empty, and
 * bounded. Anything else is a malformed provider payload and fails closed
 * before attribution or persistence.
 */
export function normalizeExternalIdentity(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SignalContractError("MALFORMED_SIGNAL", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new SignalContractError("MALFORMED_SIGNAL", `${field} must be non-empty`);
  }
  if (trimmed.length > SIGNAL_EXTERNAL_ID_MAX) {
    throw new SignalContractError(
      "MALFORMED_SIGNAL",
      `${field} exceeds ${SIGNAL_EXTERNAL_ID_MAX} characters`
    );
  }
  // No control characters or NUL bytes in identity material.
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new SignalContractError("MALFORMED_SIGNAL", `${field} contains control characters`);
  }
  return trimmed;
}

/**
 * Bounded sanitized textual evidence. Provider text is retained only to the
 * documented bound (justification: audit/reconciliation of the accepted
 * evidence); no transformation beyond bounding happens here — interpretation
 * belongs to downstream streams.
 */
export function sanitizeContentText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
  if (normalized.length === 0) return null;
  return normalized.length <= SIGNAL_CONTENT_TEXT_MAX
    ? normalized
    : normalized.slice(0, SIGNAL_CONTENT_TEXT_MAX - 3) + "...";
}

export function sanitizeBoundedText(
  value: unknown,
  max: number,
  field: string
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new SignalContractError("MALFORMED_SIGNAL", `${field} must be a string when present`);
  }
  const normalized = value.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (normalized.length === 0) return null;
  if (normalized.length > max) {
    throw new SignalContractError("MALFORMED_SIGNAL", `${field} exceeds ${max} characters`);
  }
  return normalized;
}

/** Safe provider timestamp conversion. Invalid/missing provider times fail
 *  closed rather than silently becoming "now" (which would corrupt ordering
 *  and replay semantics); callers may opt into a fallback explicitly. */
export function timestampFromEpochSeconds(
  value: unknown,
  field: string,
  fallback: "fail" | "now" = "fail"
): Date {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    const ms = seconds * 1000;
    if (ms <= 8.64e15) return new Date(ms);
  }
  if (fallback === "now") return new Date();
  throw new SignalContractError(
    "MALFORMED_SIGNAL",
    `${field} is not a valid epoch timestamp`
  );
}

export function timestampFromIsoDateTime(
  value: unknown,
  field: string,
  fallback: "fail" | "now" = "fail"
): Date {
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (fallback === "now") return new Date();
  throw new SignalContractError(
    "MALFORMED_SIGNAL",
    `${field} is not a valid ISO-8601 timestamp`
  );
}

export class SignalContractError extends Error {
  readonly code:
    | "MALFORMED_SIGNAL"
    | "UNKNOWN_PROVIDER"
    | "UNKNOWN_PLATFORM"
    | "OWNERSHIP_MISMATCH";
  constructor(
    code: "MALFORMED_SIGNAL" | "UNKNOWN_PROVIDER" | "UNKNOWN_PLATFORM" | "OWNERSHIP_MISMATCH",
    message: string
  ) {
    super(message);
    this.name = "SignalContractError";
    this.code = code;
  }
}

/**
 * The canonical normalized signal. `signalKey`, `userId`, `businessId`,
 * attribution lineage, `observedAt`, `providerEvidenceHash`, `status` and
 * `ingestionVersion` are always server-derived; provider fields come from the
 * validated adapter output only.
 */
export interface CanonicalSocialSignal {
  signalKey: string;
  userId: number;
  businessId: number | null;
  provider: SocialSignalProvider;
  platform: SocialSignalPlatform;
  integrationId: number;
  providerAccountId: string;
  externalEventId: string;
  externalObjectId: string | null;
  parentExternalObjectId: string | null;
  signalType: SocialSignalType;
  occurredAt: Date;
  observedAt: Date;
  sourceCampaignId: number | null;
  sourcePublicationId: string | null;
  sourcePublicationReceiptId: string | null;
  actorReference: string | null;
  actorDisplayName: string | null;
  contentReference: string | null;
  contentText: string | null;
  providerEvidenceHash: string;
  attributionType: SocialSignalAttributionType;
  status: "accepted";
  ingestionVersion: number;
  createdAt: Date;
}
