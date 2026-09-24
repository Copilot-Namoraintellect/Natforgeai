// ─── Immutable Publish Package contract (WBS13.1) ───
//
// The canonical immutable handoff from Creative to Distribution. A publish
// package identifies the exact Creative artifacts approved for publication so
// Distribution never has to reconstruct campaign meaning from mutable
// campaign/business fields at execution time.
//
// Canonical chain carried by identity coordinates (never raw authority data):
//
//   Business DNA snapshot
//     → Strategy snapshot (immutable Strategy authority)
//     → approved semantic copy (V2 approval envelope coordinates)
//     → governed derivative artifacts (caption pack / message pack / renders)
//     → immutable publish package  ← this contract
//     → platform adapter
//     → publication receipt
//
// Determinism: the package fingerprint is a SHA-256 over a key-sorted
// canonical JSON of the deterministic identity core. The same authority
// coordinates and artifact identities always produce the same fingerprint;
// wall-clock timestamps and other nondeterministic provenance never feed the
// identity. The frozen adapter payload is carried verbatim for the platform
// adapter but is deliberately excluded from the identity fingerprint.
//
// Classification: artifacts that carry durable governed lineage classify as
// "governed"; artifacts that lack governed lineage classify as "legacy" with
// explicit reasons. Legacy artifacts are never silently treated as governed.
//
// Persistence note: the module is pure (no database, no provider/network
// calls). Packages are designed to be persisted into existing metadata JSON
// columns and correlated through the existing audit_events.packageId slot,
// so no schema migration is required.

import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";

export const PUBLISH_PACKAGE_SCHEMA_VERSION = 1 as const;

/** Human-greppable, versioned package id prefix. */
export const PUBLISH_PACKAGE_ID_PREFIX = "ppv1" as const;

export type PublishPackageClassification = "governed" | "legacy";

/**
 * Deliberate legacy classifications. A package is "legacy" when any link of
 * the governed chain is missing durable lineage; the reasons say which links.
 */
export type PublishPackageLegacyReason =
  | "strategy_authority_missing"
  | "approved_copy_identity_missing"
  | "selected_content_lineage_missing"
  | "caption_artifact_missing"
  | "caption_artifact_lineage_missing"
  | "visual_artifact_lineage_missing";

export type PublishPackageIntentMode = "immediate" | "scheduled";

/**
 * Immutable Strategy authority coordinates. Identical shape to the creative
 * artifact lineage strategy coordinates, so cross-checks are field-for-field.
 */
export interface PublishPackageStrategyAuthority {
  readonly strategySnapshotId: string;
  readonly strategyVersion: number | null;
  readonly businessDnaSnapshotId: string;
  readonly strategyHashSha256: string;
  readonly strategyRunId: number | null;
  readonly approvalRequestId: number | null;
  readonly creativeBriefFingerprint: string | null;
}

/** Approved semantic-copy identity (V2 approval envelope coordinates). */
export interface PublishPackageApprovedCopyIdentity {
  readonly copyHashSha256: string;
  readonly copySchemaVersion: string;
  readonly approvedRevisionId: string;
  readonly assessmentHashSha256: string;
  readonly contextLockId: string;
}

/**
 * Binding of one governed artifact into the package. Carries the artifact's
 * durable lineage fingerprint plus the parent authority coordinates the
 * lineage was bound to, so mismatched parent authorities fail closed at the
 * contract boundary.
 */
export interface PublishPackageArtifactBinding {
  readonly artifactKind: string;
  readonly artifactId: number | null;
  readonly lineageFingerprintSha256: string | null;
  readonly strategy: PublishPackageStrategyAuthority | null;
  readonly approvedCopy: PublishPackageApprovedCopyIdentity | null;
}

/** Visual artifact identity (generated image or rendered video). */
export interface PublishPackageVisualIdentity {
  readonly mediaKind: "image" | "video";
  readonly generatedAssetId: number | null;
  readonly mediaUrl: string | null;
  readonly renderLineageFingerprintSha256: string | null;
  readonly strategy: PublishPackageStrategyAuthority | null;
  readonly approvedCopy: PublishPackageApprovedCopyIdentity | null;
}

/** Publish intent metadata (scheduled vs immediate). */
export interface PublishPackageIntent {
  readonly mode: PublishPackageIntentMode;
  /** ISO 8601 timestamp; required when mode === "scheduled". */
  readonly scheduledAtIso: string | null;
}

/** Readiness/approval evidence references for later receipt/audit. */
export interface PublishPackageEvidence {
  /** campaign_launch approval request corroborated by durable launch lineage. */
  readonly launchApprovalRequestId: number | null;
}

/**
 * Deterministic identity core. Every field here feeds the package fingerprint;
 * nothing nondeterministic may be added to this structure.
 */
export interface PublishPackageIdentity {
  readonly campaignId: number;
  readonly userId: number;
  readonly businessId: number | null;
  readonly destination: {
    readonly platform: string;
    readonly integrationId: number | null;
  };
  readonly intent: PublishPackageIntent;
  readonly strategyAuthority: PublishPackageStrategyAuthority | null;
  readonly approvedCopy: PublishPackageApprovedCopyIdentity | null;
  /** Selected content artifact (the content post being published). */
  readonly selectedContent: PublishPackageArtifactBinding;
  /** Governing caption/copy artifact (caption pack or message pack). */
  readonly captionArtifact: PublishPackageArtifactBinding | null;
  /** Frozen visual artifact when the package carries media. */
  readonly visualArtifact: PublishPackageVisualIdentity | null;
  readonly evidence: PublishPackageEvidence;
}

/**
 * Frozen adapter-facing payload. Carried verbatim so a platform adapter can
 * publish without rereading mutable Strategy/copy rows. Intentionally excluded
 * from the deterministic identity fingerprint — identity is digest-based.
 */
export interface PublishPackagePayload {
  readonly text: string;
  readonly mediaUrls: readonly string[];
  readonly mediaType: "image" | "video" | null;
}

/**
 * Immutable publish package. Deep-frozen at the contract boundary; the
 * embedded fingerprint always equals
 * derivePublishPackageFingerprint(identity).
 */
export interface PublishPackage {
  readonly schemaVersion: typeof PUBLISH_PACKAGE_SCHEMA_VERSION;
  /** Deterministic, versioned package identity: ppv1-<fingerprint prefix>. */
  readonly packageId: string;
  readonly packageFingerprintSha256: string;
  readonly classification: PublishPackageClassification;
  /** Empty for governed packages; explicit reasons otherwise. */
  readonly legacyReasons: readonly PublishPackageLegacyReason[];
  readonly identity: PublishPackageIdentity;
  readonly payload: PublishPackagePayload;
  /**
   * Caller-supplied provenance timestamp. Never part of the deterministic
   * identity; two packages with identical identity coordinates but different
   * createdAtIso share one fingerprint.
   */
  readonly createdAtIso: string | null;
}

// ─── Canonical fingerprint ───

function failClosed(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
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

/**
 * Deterministic SHA-256 fingerprint of the package identity core. Two
 * packages fingerprint identically iff every identity coordinate matches,
 * regardless of object key order or hash-letter casing. Nondeterministic
 * provenance (createdAtIso) and the raw frozen payload never participate.
 */
export function derivePublishPackageFingerprint(
  identity: PublishPackageIdentity
): string {
  return createHash("sha256").update(canonicalize(identity), "utf8").digest("hex");
}

/** Deterministic, versioned package id derived from the fingerprint. */
export function buildPublishPackageId(packageFingerprintSha256: string): string {
  const fingerprint = normalizeSha256Hex(
    packageFingerprintSha256,
    "packageFingerprintSha256"
  );
  return `${PUBLISH_PACKAGE_ID_PREFIX}-${fingerprint.slice(0, 40)}`;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Assemble and deep-freeze a publish package. The caller must have already
 * normalized/classified the identity (see publish-package-builder). The
 * fingerprint is re-derived here so the package is self-authenticating.
 */
export function assemblePublishPackage(input: {
  identity: PublishPackageIdentity;
  classification: PublishPackageClassification;
  legacyReasons: readonly PublishPackageLegacyReason[];
  payload: PublishPackagePayload;
  createdAtIso?: string | null;
}): PublishPackage {
  if (!input || typeof input !== "object" || !input.identity) {
    failClosed("Publish package assembly requires a package identity");
  }
  const packageFingerprintSha256 = derivePublishPackageFingerprint(input.identity);
  return deepFreeze({
    schemaVersion: PUBLISH_PACKAGE_SCHEMA_VERSION,
    packageId: buildPublishPackageId(packageFingerprintSha256),
    packageFingerprintSha256,
    classification: input.classification,
    legacyReasons: Object.freeze([...input.legacyReasons]),
    identity: input.identity,
    payload: input.payload,
    createdAtIso: input.createdAtIso ?? null,
  });
}

/**
 * Fail-closed tamper check. Re-derives the fingerprint from the package's own
 * identity and throws when any coordinate was altered after assembly, or when
 * the record shape is not a publish package produced by assemblePublishPackage.
 */
export function assertPersistedPublishPackageIntact(
  pkg: PublishPackage
): void {
  if (!pkg || typeof pkg !== "object") {
    failClosed("Publish package is missing or malformed");
  }
  if (pkg.schemaVersion !== PUBLISH_PACKAGE_SCHEMA_VERSION) {
    failClosed("Publish package has an unsupported schema version");
  }
  const recomputed = derivePublishPackageFingerprint(pkg.identity);
  if (recomputed !== pkg.packageFingerprintSha256) {
    failClosed("Publish package fingerprint mismatch");
  }
  if (buildPublishPackageId(pkg.packageFingerprintSha256) !== pkg.packageId) {
    failClosed("Publish package id does not match its fingerprint");
  }
}

function normalizeSha256Hex(value: unknown, name: string): string {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    failClosed(
      `Invalid publish package ${name}: expected 64-character lowercase SHA-256 hex`
    );
  }
  return normalized;
}
