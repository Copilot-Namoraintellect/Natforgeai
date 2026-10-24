// ─── R5-B Intent & Sentiment Intelligence — interpretation identity (§5) ───
//
// PURE identity module: canonical-JSON sha256 derivations for signal content
// hash, interpretation id, billing identity and record fingerprint
// (docs/contracts/social-intelligence-contract.md §5). Same discipline as
// credit-reservation.ts / workflow-operation.ts: sorted keys, trimmed strings,
// no wall-clock, no randomness — identical input always yields identical
// identity. No I/O, no logging.

import { createHash } from "crypto";
import { InterpretationInputError } from "./interpretation-contract";
import type { SanitizedSocialSignal } from "./canonical-signal";
import type { SocialInterpretation } from "./interpretation-contract";

/** Stable JSON: object keys sorted recursively, strings trimmed, undefined omitted. */
function canonicalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return value.trim();
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "object": {
      if (Array.isArray(value)) {
        return value.map((item) => {
          const canonical = canonicalize(item);
          return canonical === undefined ? null : canonical;
        });
      }
      const sorted: Record<string, unknown> = {};
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record).sort()) {
        const canonical = canonicalize(record[key]);
        if (canonical !== undefined) sorted[key] = canonical;
      }
      return sorted;
    }
    default:
      // bigint / symbol / function never participate in canonical identity.
      return null;
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function requireIdentityField(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InterpretationInputError(
      "INVALID_IDENTITY_INPUT",
      `${field} must be a non-empty string to derive an interpretation identity.`
    );
  }
  return value.trim();
}

function requirePositiveInt(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new InterpretationInputError(
      "INVALID_IDENTITY_INPUT",
      `${field} must be a positive integer to derive an interpretation identity.`
    );
  }
  return value;
}

/**
 * sha256 of the sanitized canonical signal content (§5). signalId is
 * deliberately excluded: the hash detects content drift for one logical
 * signal identity. Metadata is hashed as supplied (already normalized by
 * toCanonicalSignal).
 */
export function computeSignalContentHash(signal: SanitizedSocialSignal): string {
  return hashCanonical({
    signalVersion: signal.signalVersion,
    signalType: signal.signalType,
    platform: signal.platform,
    actorHandle: signal.actorHandle,
    text: signal.text,
    occurredAt: signal.occurredAt,
    metadata: signal.metadata,
  });
}

export interface InterpretationIdInput {
  readonly schemaVersion: string;
  readonly businessId: number;
  readonly signalId: string;
  readonly signalVersion: number;
  readonly signalContentHash: string;
  readonly classifierVersion: string;
}

/** Deterministic interpretation identity (§5): one per signal version + classifier. */
export function computeInterpretationId(args: InterpretationIdInput): string {
  return hashCanonical({
    schemaVersion: requireIdentityField(args.schemaVersion, "schemaVersion"),
    businessId: requirePositiveInt(args.businessId, "businessId"),
    signalId: requireIdentityField(args.signalId, "signalId"),
    signalVersion: requirePositiveInt(args.signalVersion, "signalVersion"),
    signalContentHash: requireIdentityField(args.signalContentHash, "signalContentHash"),
    classifierVersion: requireIdentityField(args.classifierVersion, "classifierVersion"),
  });
}

export interface InterpretationBillingIdentityInput {
  readonly businessId: number;
  readonly signalId: string;
  readonly signalVersion: number;
  readonly signalContentHash: string;
  readonly classifierVersion: string;
}

/**
 * Forward billing identity for the governed model path (§5, §13). Retries of
 * the same logical interpretation version re-enter the runner under this key,
 * so at most one durable charge survives per version.
 */
export function buildInterpretationBillingIdentity(
  args: InterpretationBillingIdentityInput
): string {
  const businessId = requirePositiveInt(args.businessId, "businessId");
  const signalId = requireIdentityField(args.signalId, "signalId");
  const signalVersion = requirePositiveInt(args.signalVersion, "signalVersion");
  const signalContentHash = requireIdentityField(args.signalContentHash, "signalContentHash");
  const classifierVersion = requireIdentityField(args.classifierVersion, "classifierVersion");
  return (
    "interpretation:" +
    sha256Hex(
      `intelligence/interpretation-billing@v1:${businessId}:${signalId}:${signalVersion}:${signalContentHash}:${classifierVersion}`
    )
  );
}

/**
 * sha256 of the canonical JSON of every record field except the fingerprint
 * itself. Pure and deterministic; unit-test replay stability lives in the
 * co-located test.
 */
export function computeInterpretationFingerprint(record: SocialInterpretation): string {
  const rest: Record<string, unknown> = {};
  const source = record as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (key === "interpretationFingerprint") continue;
    rest[key] = source[key];
  }
  return hashCanonical(rest);
}
