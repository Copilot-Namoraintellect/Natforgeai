// ─── R10-E Observability — deterministic identity derivation ───
//
// PURE module: deterministic server-minted identities for the observability
// planes. Same normalized coordinates always derive the same identity;
// identity is never client-supplied and wording/labels are never identity
// inputs. No I/O, no clock, no randomness.

import { createHash } from "crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** Deterministic identity for a coordinate set, under the given prefix. */
export function deriveIdentity(prefix: "evt1" | "inc1" | "icl1" | "alt1" | "hlt1", coordinates: Record<string, unknown>): string {
  return `${prefix}:${sha256Hex(canonical(coordinates))}`;
}

/**
 * evt1: identity coordinates — the material facts of the emission, not its
 * presentation. tenantId/businessId stay null for platform-scope events.
 */
export interface OperationalEventIdentityCoordinates {
  readonly environment: string;
  readonly eventType: string;
  readonly service: string;
  readonly component: string;
  readonly operation: string;
  readonly tenantId: number | null;
  readonly businessId: number | null;
  readonly provider: string | null;
  readonly diagnosticCode: string;
  readonly occurredAt: string;
  /** Canonical safeMetadata — the metadata itself binds identity. */
  readonly safeMetadata: Record<string, unknown>;
}

export function deriveOperationalEventId(coords: OperationalEventIdentityCoordinates): string {
  return deriveIdentity("evt1", { ...coords });
}

/**
 * inc1: incident identity — environment, service/component, failure class and
 * scope bound. The same failing coordinates re-detecting converge to the one
 * open incident instead of minting a duplicate.
 */
export interface IncidentIdentityCoordinates {
  readonly environment: string;
  readonly service: string;
  readonly component: string;
  readonly failureClass: string;
  readonly scope: "PLATFORM" | "TENANT" | "BUSINESS";
  readonly tenantId: number | null;
  readonly businessId: number | null;
}

export function deriveIncidentId(coords: IncidentIdentityCoordinates): string {
  return deriveIdentity("inc1", { ...coords });
}

export function deriveIncidentLifecycleEventId(coords: {
  readonly incidentId: string;
  readonly toStatus: string;
  readonly actorType: string;
  readonly actorUserId: number | null;
  readonly occurredAt: string;
}): string {
  return deriveIdentity("icl1", { ...coords });
}

/**
 * alt1: alert identity — environment + deterministic dedup key. An open alert
 * with the same identity folds new occurrences; resolution re-arms it.
 */
export function deriveAlertId(coords: {
  readonly environment: string;
  readonly dedupKey: string;
}): string {
  return deriveIdentity("alt1", { ...coords });
}

export function deriveHealthObservationId(coords: {
  readonly environment: string;
  readonly dimension: string;
  readonly service: string;
  readonly evidenceHash: string;
  readonly observedAt: string;
}): string {
  return deriveIdentity("hlt1", { ...coords });
}

/** Deterministic dedup key for an alert fold target (contract §7). */
export function deriveAlertDedupKey(coords: {
  readonly failureClass: string;
  readonly target: string;
}): string {
  return `${coords.failureClass}:${coords.target}`;
}
