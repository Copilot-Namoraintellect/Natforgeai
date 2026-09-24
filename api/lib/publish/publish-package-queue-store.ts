// ─── Durable PublishPackage queue persistence (WBS13.4) ───
//
// Canonical persistence for the immutable publish package at the durable
// queue boundary. The governed PublishPackage produced by WBS13.1 must survive
// process boundaries: BullMQ workers and the cron runner execute in different
// processes (and at different times) than the request that built the package,
// so the exact package — never a reconstruction from mutable campaign or
// content rows — is persisted onto the publishing_queue row and reloaded
// through the single loader in this module.
//
// Persisted representation (stored in the publishing_queue.metadata JSON
// column, proposed by this stream and pending schema review):
//
//   {
//     "publishPackageRequired": true,          // governed marker (fail-closed)
//     "publishPackage": {                      // self-authenticating envelope
//       "kind": "publish_package",
//       "schemaVersion": 1,
//       "publishPackage": <PublishPackage>,    // verbatim, key order irrelevant
//       "payloadDigestSha256": "<sha256>"      // canonical-JSON digest of payload
//     }
//   }
//
// Load-time discrimination:
//   - no envelope, no governed marker  → legacy row (created before this
//     feature or by a non-governed creation path). Never fabricates a package.
//   - envelope present                 → governed; integrity-verified and
//     deep-frozen before handoff. Any tamper fails closed here, before any
//     publication side effect.
//   - governed marker without a valid  → fail-closed invalid state; a governed
//     envelope                        queue row must never execute without its
//                                       exact persisted package.
//
// Integrity: identity tamper is caught by reusing the existing
// assertPersistedPublishPackageIntact verification (fingerprint re-derivation);
// payload tamper is caught by the envelope payload digest, which closes the
// gap the package fingerprint intentionally leaves (the frozen adapter payload
// never feeds the identity fingerprint).
//
// Retry safety: a retry loads this row's persisted package again, so every
// attempt — first try, BullMQ re-drive, cron retry — executes the identical
// packageId/fingerprint. Nothing is ever rebuilt against current campaign
// state.
//
// Pure module: no database, queue, provider, or network access. Callers own
// the storage location; this module owns the exact serialized shape and its
// verification.

import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  PUBLISH_PACKAGE_SCHEMA_VERSION,
  assertPersistedPublishPackageIntact,
  deepFreeze,
  type PublishPackage,
} from "./publish-package-contract";

/** governed marker key in the publishing_queue.metadata JSON column. */
export const QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY = "publishPackageRequired" as const;

/** Envelope key holding the persisted publish package. */
export const QUEUE_PUBLISH_PACKAGE_METADATA_KEY = "publishPackage" as const;

/** Discriminator proving a metadata slot holds a publish package envelope. */
export const PERSISTED_PUBLISH_PACKAGE_ENVELOPE_KIND = "publish_package" as const;

/**
 * Self-authenticating persisted envelope. Wraps the verbatim package with the
 * payload digest so both identity and frozen adapter payload are covered by
 * load-time verification.
 */
export interface PersistedPublishPackageEnvelope {
  readonly kind: typeof PERSISTED_PUBLISH_PACKAGE_ENVELOPE_KIND;
  readonly schemaVersion: typeof PUBLISH_PACKAGE_SCHEMA_VERSION;
  readonly publishPackage: PublishPackage;
  /** SHA-256 over the canonical key-sorted JSON of publishPackage.payload. */
  readonly payloadDigestSha256: string;
}

/**
 * Metadata fragment written into publishing_queue.metadata for a governed
 * queue row. Merge into the row metadata in the SAME statement that creates
 * the queue row so the row and its package persist atomically.
 */
export interface QueuePublishPackageMetadata {
  readonly [QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY]: true;
  readonly [QUEUE_PUBLISH_PACKAGE_METADATA_KEY]: PersistedPublishPackageEnvelope;
}

/** Non-throwing load outcome for execution paths (BullMQ worker, cron). */
export type QueuePublishPackageResolution =
  | { kind: "governed"; publishPackage: PublishPackage }
  | { kind: "legacy" }
  | { kind: "invalid"; reason: string };

function failClosed(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestPublishPackagePayload(pkg: PublishPackage): string {
  return sha256Hex(canonicalize(pkg.payload));
}

/**
 * Deterministic canonical JSON of the package itself. Key order of the input
 * object never affects the output, so the byte form is stable across
 * serializations of the same package. (MySQL's JSON column does not preserve
 * object key order either; the digest guarantees, not the stored byte layout.)
 */
export function persistedPublishPackageToCanonicalJson(pkg: PublishPackage): string {
  assertPersistedPublishPackageIntact(pkg);
  return canonicalize(pkg);
}

/**
 * Serialize one immutable publish package into its durable queue metadata
 * fragment. Refuses to persist a package that fails integrity verification,
 * so a tampered or malformed package can never reach durable storage through
 * this path. The package is stored verbatim (no field is dropped, renamed, or
 * re-derived), and the returned fragment is deep-frozen. Pure and idempotent:
 * serializing the same package twice yields deeply equal fragments and never
 * mutates the input.
 */
export function serializePublishPackageForQueue(pkg: PublishPackage): QueuePublishPackageMetadata {
  assertPersistedPublishPackageIntact(pkg);
  const envelope: PersistedPublishPackageEnvelope = deepFreeze({
    kind: PERSISTED_PUBLISH_PACKAGE_ENVELOPE_KIND,
    schemaVersion: PUBLISH_PACKAGE_SCHEMA_VERSION,
    publishPackage: pkg,
    payloadDigestSha256: digestPublishPackagePayload(pkg),
  });
  return deepFreeze({
    [QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY]: true,
    [QUEUE_PUBLISH_PACKAGE_METADATA_KEY]: envelope,
  } as QueuePublishPackageMetadata);
}

/**
 * Fail-closed integrity check for one persisted queue publish package
 * envelope. Reuses the existing package verification (schema version,
 * fingerprint re-derivation, packageId derivation) and additionally verifies
 * the envelope discriminator and the frozen payload digest. Returns the
 * deep-frozen package ready for execution; throws on any tamper or malformed
 * envelope.
 */
export function assertQueuePublishPackageIntegrity(envelope: unknown): PublishPackage {
  if (!isObject(envelope)) {
    failClosed("Persisted publish package envelope is missing or malformed");
  }
  if (envelope.kind !== PERSISTED_PUBLISH_PACKAGE_ENVELOPE_KIND) {
    failClosed("Persisted publish package envelope has an unexpected kind");
  }
  if (envelope.schemaVersion !== PUBLISH_PACKAGE_SCHEMA_VERSION) {
    failClosed("Persisted publish package envelope has an unsupported schema version");
  }
  const pkg = envelope.publishPackage as PublishPackage;
  // Existing WBS13.1 verification: identity fingerprint + packageId re-derivation.
  assertPersistedPublishPackageIntact(pkg);
  const declaredDigest = envelope.payloadDigestSha256;
  if (typeof declaredDigest !== "string" || !/^[0-9a-f]{64}$/.test(declaredDigest)) {
    failClosed("Persisted publish package envelope has an invalid payload digest");
  }
  if (declaredDigest !== digestPublishPackagePayload(pkg)) {
    failClosed("Persisted publish package payload digest mismatch (tampered payload)");
  }
  return deepFreeze(pkg);
}

/**
 * Non-throwing resolution of a queue row's metadata into its durable package
 * state. Shared by the BullMQ worker and the cron runner so package parsing
 * exists exactly once:
 *
 *   - governed: a valid envelope was found and integrity-verified; the package
 *     is the exact persisted one (same packageId/fingerprint as creation).
 *   - legacy: no envelope and no governed marker; the row predates this
 *     feature or was created by a non-governed path. No package is fabricated.
 *   - invalid: the row is governed-marked but the envelope is missing or
 *     fails integrity. The caller must fail closed durably before any
 *     publication side effect.
 */
export function resolveQueuePublishPackage(metadata: unknown): QueuePublishPackageResolution {
  if (!isObject(metadata)) {
    return { kind: "legacy" };
  }
  const envelope = metadata[QUEUE_PUBLISH_PACKAGE_METADATA_KEY];
  const governedMarker = metadata[QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY] === true;
  if (envelope === undefined || envelope === null) {
    if (governedMarker) {
      return {
        kind: "invalid",
        reason: "Publishing queue item is marked governed but has no persisted publish package",
      };
    }
    return { kind: "legacy" };
  }
  try {
    return { kind: "governed", publishPackage: assertQueuePublishPackageIntegrity(envelope) };
  } catch (err) {
    return {
      kind: "invalid",
      reason: err instanceof Error ? err.message : "Persisted publish package failed integrity verification",
    };
  }
}

/**
 * Reload the persisted publish package for one queue row's metadata.
 * Returns the exact, integrity-verified, deep-frozen package; returns null
 * for legacy rows (never fabricating a package); throws when the row is
 * governed-marked but the persisted package is missing or tampered.
 */
export function loadPersistedPublishPackage(metadata: unknown): PublishPackage | null {
  const resolution = resolveQueuePublishPackage(metadata);
  switch (resolution.kind) {
    case "governed":
      return resolution.publishPackage;
    case "legacy":
      return null;
    case "invalid":
      return failClosed(resolution.reason);
  }
}
