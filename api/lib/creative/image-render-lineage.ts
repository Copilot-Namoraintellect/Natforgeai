import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import type { CreativeStrategyAuthority } from "./strategy-authority";

// ─── Image-render production lineage authority (WBS12D) ───
//
// Every image render / finalized generated image must retain exact lineage to
// the approved Creative/Strategy authority that authorized the copy and brief
// it renders. This module is the narrowest lineage contract needed by the
// image-render claim subsystem:
//
//   strategy authority  — the immutable WBS11 Strategy coordinates captured
//     by Creative (snapshot id, version, Business-DNA snapshot id, payload
//     hash, strategy run, creative-brief fingerprint, approval request).
//   source identity     — the content post the render is produced for.
//   approved copy       — the approved message-pack copy authority, when the
//     render is bound to one (copy hash, schema version, revision id).
//
// The output identity (generatedImages row id + stored URL) is bound by the
// claim's durable result snapshot at completion time; the persisted lineage
// record below is written onto the generated_images row itself, so the row
// stays self-describing. Only normalized digests/ids are ever persisted —
// no raw copy text, no raw brief material.
//
// Persistence note: the image_render_claims table stores lineage only
// indirectly — deriveImageRenderAttemptIdentity binds the lineage fingerprint
// into intentFingerprint, so claim acquisition, completion CAS, rearm and
// idempotent replay all compare lineage and fail closed on any mismatch
// without a schema migration. The full lineage record is persisted onto
// generated_images.metadata by image-render-finalization.

export const IMAGE_RENDER_LINEAGE_SCHEMA_VERSION = 1 as const;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// ─── Input contract ───

export interface ImageRenderStrategyLineageInput {
  readonly strategySnapshotId: string;
  readonly strategyVersion: number;
  readonly businessDnaSnapshotId: string;
  readonly strategyHashSha256: string;
  readonly strategyRunId: number;
  readonly creativeBriefFingerprint: string;
  readonly approvalRequestId: number;
}

export interface ImageRenderApprovedCopyLineageInput {
  readonly copyHashSha256: string;
  readonly copySchemaVersion: string;
  readonly approvedRevisionId: string;
}

export interface ImageRenderLineageInput {
  /** Source content identity: the post this render is produced for. */
  readonly contentPostId: number;
  readonly strategy: ImageRenderStrategyLineageInput;
  /** Approved-copy authority; null/absent when the render is copy-agnostic. */
  readonly approvedCopy?: ImageRenderApprovedCopyLineageInput | null;
}

// ─── Persisted record (generated_images.metadata.renderLineage) ───

export interface ImageRenderPersistedLineage {
  readonly lineageSchemaVersion: typeof IMAGE_RENDER_LINEAGE_SCHEMA_VERSION;
  readonly contentPostId: number;
  readonly lineageFingerprintSha256: string;
  readonly strategy: ImageRenderStrategyLineageInput;
  readonly approvedCopy: ImageRenderApprovedCopyLineageInput | null;
}

// ─── Validation (fail closed) ───

function failClosed(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

function normalizePositiveId(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    failClosed(`Invalid lineage ${name}: expected positive safe integer`);
  }
  return value;
}

function normalizeNonEmptyText(
  value: unknown,
  name: string,
  max: number
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    failClosed(`Invalid lineage ${name}: expected a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    failClosed(
      `Invalid lineage ${name}: expected at most ${max} characters`
    );
  }
  return trimmed;
}

function normalizeSha256Hex(value: unknown, name: string): string {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    failClosed(
      `Invalid lineage ${name}: expected 64-character lowercase SHA-256 hex`
    );
  }
  return normalized;
}

function normalizeStrategyLineage(
  strategy: ImageRenderStrategyLineageInput
): ImageRenderStrategyLineageInput {
  if (!strategy || typeof strategy !== "object") {
    failClosed("Invalid lineage strategy: expected an object");
  }
  return Object.freeze({
    strategySnapshotId: normalizeNonEmptyText(
      strategy.strategySnapshotId,
      "strategySnapshotId",
      128
    ),
    strategyVersion: normalizePositiveId(
      strategy.strategyVersion,
      "strategyVersion"
    ),
    businessDnaSnapshotId: normalizeNonEmptyText(
      strategy.businessDnaSnapshotId,
      "businessDnaSnapshotId",
      128
    ),
    strategyHashSha256: normalizeSha256Hex(
      strategy.strategyHashSha256,
      "strategyHashSha256"
    ),
    strategyRunId: normalizePositiveId(strategy.strategyRunId, "strategyRunId"),
    creativeBriefFingerprint: normalizeNonEmptyText(
      strategy.creativeBriefFingerprint,
      "creativeBriefFingerprint",
      191
    ),
    approvalRequestId: normalizePositiveId(
      strategy.approvalRequestId,
      "approvalRequestId"
    ),
  });
}

function normalizeApprovedCopyLineage(
  approvedCopy: ImageRenderApprovedCopyLineageInput | null | undefined
): ImageRenderApprovedCopyLineageInput | null {
  if (approvedCopy === null || approvedCopy === undefined) {
    return null;
  }
  if (typeof approvedCopy !== "object") {
    failClosed("Invalid lineage approvedCopy: expected an object or null");
  }
  return Object.freeze({
    copyHashSha256: normalizeSha256Hex(
      approvedCopy.copyHashSha256,
      "copyHashSha256"
    ),
    copySchemaVersion: normalizeNonEmptyText(
      approvedCopy.copySchemaVersion,
      "copySchemaVersion",
      32
    ),
    approvedRevisionId: normalizeNonEmptyText(
      approvedCopy.approvedRevisionId,
      "approvedRevisionId",
      64
    ),
  });
}

export interface NormalizedImageRenderLineage {
  readonly contentPostId: number;
  readonly strategy: ImageRenderStrategyLineageInput;
  readonly approvedCopy: ImageRenderApprovedCopyLineageInput | null;
}

/**
 * Fail-closed validation of one lineage input. Throws BAD_REQUEST on any
 * malformed field; returns nothing — callers that need the normalized form
 * use normalizeImageRenderLineage.
 */
export function assertValidImageRenderLineage(
  lineage: ImageRenderLineageInput
): void {
  normalizeImageRenderLineage(lineage);
}

/**
 * Validates and normalizes one lineage input. Throws BAD_REQUEST (fail
 * closed) on any malformed field; never returns partial lineage.
 */
export function normalizeImageRenderLineage(
  lineage: ImageRenderLineageInput
): NormalizedImageRenderLineage {
  if (!lineage || typeof lineage !== "object") {
    failClosed("Invalid lineage: expected an object");
  }
  return Object.freeze({
    contentPostId: normalizePositiveId(lineage.contentPostId, "contentPostId"),
    strategy: normalizeStrategyLineage(lineage.strategy),
    approvedCopy: normalizeApprovedCopyLineage(lineage.approvedCopy),
  });
}

// ─── Canonical fingerprint ───

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
 * Deterministic SHA-256 fingerprint of the normalized lineage authority.
 * Two lineage inputs fingerprint identically iff every authority coordinate
 * matches, regardless of object key order or hash-letter casing.
 */
export function deriveImageRenderLineageFingerprint(
  lineage: ImageRenderLineageInput
): string {
  const normalized = normalizeImageRenderLineage(lineage);
  return createHash("sha256")
    .update(
      canonicalize({
        lineageSchemaVersion: IMAGE_RENDER_LINEAGE_SCHEMA_VERSION,
        contentPostId: normalized.contentPostId,
        strategy: normalized.strategy,
        approvedCopy: normalized.approvedCopy,
      }),
      "utf8"
    )
    .digest("hex");
}

/**
 * Canonical lineage record persisted onto generated_images.metadata under
 * the coordinator-owned `renderLineage` key. Deep-frozen; the embedded
 * fingerprint always equals deriveImageRenderLineageFingerprint(lineage).
 */
export function buildPersistedImageRenderLineage(
  lineage: ImageRenderLineageInput
): ImageRenderPersistedLineage {
  const normalized = normalizeImageRenderLineage(lineage);
  return Object.freeze({
    lineageSchemaVersion: IMAGE_RENDER_LINEAGE_SCHEMA_VERSION,
    contentPostId: normalized.contentPostId,
    lineageFingerprintSha256:
      deriveImageRenderLineageFingerprint(lineage),
    strategy: normalized.strategy,
    approvedCopy: normalized.approvedCopy,
  });
}

// ─── Authority adapters (WBS12C dependency) ───

/**
 * Maps an approved Creative Strategy authority (WBS12C) onto the
 * strategy-side lineage coordinates. Pure identity projection; validation
 * happens when the lineage is fingerprinted/persisted.
 */
export function imageRenderStrategyLineageFromAuthority(
  authority: CreativeStrategyAuthority
): ImageRenderStrategyLineageInput {
  return {
    strategySnapshotId: authority.strategySnapshotId,
    strategyVersion: authority.strategyVersion,
    businessDnaSnapshotId: authority.businessDnaSnapshotId,
    strategyHashSha256: authority.strategyHashSha256,
    strategyRunId: authority.strategyRunId,
    creativeBriefFingerprint: authority.creativeBriefFingerprint,
    approvalRequestId: authority.approvalRequestId,
  };
}

/**
 * Maps the approved message-pack copy authority onto the copy-side lineage
 * coordinates. Structurally accepts the approved message pack itself or any
 * persisted JSON projection of it (both carry `copy.copySchemaVersion`);
 * validation happens when the lineage is fingerprinted/persisted.
 */
export interface ImageRenderApprovedCopyPackLike {
  readonly copyHashSha256: string;
  readonly approvedRevisionId: string;
  readonly copy: { readonly copySchemaVersion: string };
}

export function imageRenderApprovedCopyLineageFromPack(
  pack: ImageRenderApprovedCopyPackLike
): ImageRenderApprovedCopyLineageInput {
  return {
    copyHashSha256: pack.copyHashSha256,
    copySchemaVersion: pack.copy.copySchemaVersion,
    approvedRevisionId: pack.approvedRevisionId,
  };
}
