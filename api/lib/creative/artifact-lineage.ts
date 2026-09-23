import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import type { CreativeStrategyAuthority } from "./strategy-authority";
import type { V2ApprovalEnvelope } from "./message-approval/contracts";

// ─── Durable Creative artifact lineage (WBS12.3) ───
//
// One canonical lineage contract for durable semantic Creative artifacts so
// downstream Distribution can prove, for every artifact it consumes:
//
//   Business DNA snapshot
//     → Strategy snapshot
//     → approved semantic copy
//     → platform/content variant
//
// Covered artifact kinds: message_pack (the approved semantic copy itself),
// platform captions (caption_adaptation rows), hashtag sets and caption packs
// (derived content variants). The module is deliberately pure: it re-derives
// deterministic hashes from data it is handed and never touches the database.
//
// Persistence note: lineage records are written into the existing metadata
// JSON of the durable row (campaign_assets.metadata under the
// CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY), so no schema migration is needed.
// Only normalized digests/ids are persisted — never raw copy text.
//
// Authority model: this module does not create or verify approvals. It only
// carries the coordinates that the existing governed authorities (WBS11
// Strategy authority + V2 message-approval envelope) already produced, and
// fails closed when those coordinates are malformed or tampered with.

export const CREATIVE_ARTIFACT_LINEAGE_SCHEMA_VERSION = 1 as const;

/** Metadata key under which the persisted lineage record is stored. */
export const CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY =
  "creativeArtifactLineage" as const;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type CreativeArtifactKind =
  | "message_pack"
  | "platform_caption"
  | "hashtag_set"
  | "caption_pack";

// ─── Input contract ───

/**
 * Cross-engine Strategy coordinates. The envelope-domain coordinates
 * (snapshot id, strategy hash, Business-DNA snapshot id) always identify the
 * Strategy snapshot the copy was evaluated against; the WBS11 run coordinates
 * (version, run, approval request, brief fingerprint) are present when an
 * approved WBS11 Strategy authority was bound at production time.
 */
export interface CreativeArtifactStrategyLineageInput {
  readonly strategySnapshotId: string;
  readonly strategyVersion: number | null;
  readonly businessDnaSnapshotId: string;
  readonly strategyHashSha256: string;
  readonly strategyRunId: number | null;
  readonly approvalRequestId: number | null;
  readonly creativeBriefFingerprint: string | null;
}

/**
 * Approved-copy coordinates taken from the V2 approval envelope that governs
 * the semantic copy this artifact derives from.
 */
export interface CreativeArtifactApprovedCopyLineageInput {
  readonly copyHashSha256: string;
  readonly copySchemaVersion: string;
  readonly approvedRevisionId: string;
  readonly assessmentHashSha256: string;
  readonly contextLockId: string;
}

/** Identity of the parent artifact this derived artifact was produced from. */
export interface CreativeArtifactParentIdentityInput {
  readonly artifactKind: CreativeArtifactKind | (string & {});
  readonly artifactId?: number | null;
}

export interface CreativeArtifactLineageInput {
  readonly artifactKind: CreativeArtifactKind;
  /** Platform/channel when the artifact is a platform variant. */
  readonly platform?: string | null;
  /** Parent artifact identity (e.g. the message_pack a caption derives from). */
  readonly parent?: CreativeArtifactParentIdentityInput | null;
  /** Strategy authority coordinates; null for envelope-less legacy artifacts. */
  readonly strategy?: CreativeArtifactStrategyLineageInput | null;
  /** Approved-copy authority coordinates; null for envelope-less artifacts. */
  readonly approvedCopy?: CreativeArtifactApprovedCopyLineageInput | null;
}

// ─── Persisted record (metadata.creativeArtifactLineage) ───

export interface CreativeArtifactPersistedLineage {
  readonly lineageSchemaVersion: typeof CREATIVE_ARTIFACT_LINEAGE_SCHEMA_VERSION;
  readonly artifactKind: CreativeArtifactKind;
  readonly platform: string | null;
  readonly parent: CreativeArtifactParentIdentityInput | null;
  readonly lineageFingerprintSha256: string;
  readonly strategy: CreativeArtifactStrategyLineageInput | null;
  readonly approvedCopy: CreativeArtifactApprovedCopyLineageInput | null;
}

// ─── Validation (fail closed) ───

function failClosed(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

function normalizeNonEmptyText(
  value: unknown,
  name: string,
  max: number
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    failClosed(`Invalid artifact lineage ${name}: expected a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    failClosed(
      `Invalid artifact lineage ${name}: expected at most ${max} characters`
    );
  }
  return trimmed;
}

function normalizeNullableNonEmptyText(
  value: unknown,
  name: string,
  max: number
): string | null {
  if (value === null || value === undefined) return null;
  return normalizeNonEmptyText(value, name, max);
}

function normalizePositiveId(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    failClosed(
      `Invalid artifact lineage ${name}: expected positive safe integer`
    );
  }
  return value;
}

function normalizeNullablePositiveId(
  value: unknown,
  name: string
): number | null {
  if (value === null || value === undefined) return null;
  return normalizePositiveId(value, name);
}

function normalizeSha256Hex(value: unknown, name: string): string {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    failClosed(
      `Invalid artifact lineage ${name}: expected 64-character lowercase SHA-256 hex`
    );
  }
  return normalized;
}

function normalizeArtifactKind(value: unknown): CreativeArtifactKind {
  const kinds: readonly CreativeArtifactKind[] = [
    "message_pack",
    "platform_caption",
    "hashtag_set",
    "caption_pack",
  ];
  if (typeof value !== "string" || !kinds.includes(value as CreativeArtifactKind)) {
    failClosed(
      `Invalid artifact lineage artifactKind: expected one of ${kinds.join(", ")}`
    );
  }
  return value as CreativeArtifactKind;
}

function normalizeParentIdentity(
  parent: CreativeArtifactParentIdentityInput | null | undefined
): CreativeArtifactParentIdentityInput | null {
  if (parent === null || parent === undefined) return null;
  if (typeof parent !== "object") {
    failClosed("Invalid artifact lineage parent: expected an object or null");
  }
  return Object.freeze({
    artifactKind: normalizeNonEmptyText(
      parent.artifactKind,
      "parent.artifactKind",
      64
    ),
    artifactId: normalizeNullablePositiveId(
      parent.artifactId ?? null,
      "parent.artifactId"
    ),
  });
}

function normalizeStrategyLineage(
  strategy: CreativeArtifactStrategyLineageInput | null | undefined
): CreativeArtifactStrategyLineageInput | null {
  if (strategy === null || strategy === undefined) return null;
  if (typeof strategy !== "object") {
    failClosed("Invalid artifact lineage strategy: expected an object or null");
  }
  return Object.freeze({
    strategySnapshotId: normalizeNonEmptyText(
      strategy.strategySnapshotId,
      "strategy.strategySnapshotId",
      128
    ),
    strategyVersion: normalizeNullablePositiveId(
      strategy.strategyVersion ?? null,
      "strategy.strategyVersion"
    ),
    businessDnaSnapshotId: normalizeNonEmptyText(
      strategy.businessDnaSnapshotId,
      "strategy.businessDnaSnapshotId",
      128
    ),
    strategyHashSha256: normalizeSha256Hex(
      strategy.strategyHashSha256,
      "strategy.strategyHashSha256"
    ),
    strategyRunId: normalizeNullablePositiveId(
      strategy.strategyRunId ?? null,
      "strategy.strategyRunId"
    ),
    approvalRequestId: normalizeNullablePositiveId(
      strategy.approvalRequestId ?? null,
      "strategy.approvalRequestId"
    ),
    creativeBriefFingerprint: normalizeNullableNonEmptyText(
      strategy.creativeBriefFingerprint ?? null,
      "strategy.creativeBriefFingerprint",
      191
    ),
  });
}

function normalizeApprovedCopyLineage(
  approvedCopy: CreativeArtifactApprovedCopyLineageInput | null | undefined
): CreativeArtifactApprovedCopyLineageInput | null {
  if (approvedCopy === null || approvedCopy === undefined) return null;
  if (typeof approvedCopy !== "object") {
    failClosed(
      "Invalid artifact lineage approvedCopy: expected an object or null"
    );
  }
  return Object.freeze({
    copyHashSha256: normalizeSha256Hex(
      approvedCopy.copyHashSha256,
      "approvedCopy.copyHashSha256"
    ),
    copySchemaVersion: normalizeNonEmptyText(
      approvedCopy.copySchemaVersion,
      "approvedCopy.copySchemaVersion",
      32
    ),
    approvedRevisionId: normalizeNonEmptyText(
      approvedCopy.approvedRevisionId,
      "approvedCopy.approvedRevisionId",
      64
    ),
    assessmentHashSha256: normalizeSha256Hex(
      approvedCopy.assessmentHashSha256,
      "approvedCopy.assessmentHashSha256"
    ),
    contextLockId: normalizeNonEmptyText(
      approvedCopy.contextLockId,
      "approvedCopy.contextLockId",
      128
    ),
  });
}

export interface NormalizedCreativeArtifactLineage {
  readonly artifactKind: CreativeArtifactKind;
  readonly platform: string | null;
  readonly parent: CreativeArtifactParentIdentityInput | null;
  readonly strategy: CreativeArtifactStrategyLineageInput | null;
  readonly approvedCopy: CreativeArtifactApprovedCopyLineageInput | null;
}

/**
 * Fail-closed validation of one lineage input. Throws BAD_REQUEST on any
 * malformed field; never returns partial lineage.
 */
export function normalizeCreativeArtifactLineage(
  lineage: CreativeArtifactLineageInput
): NormalizedCreativeArtifactLineage {
  if (!lineage || typeof lineage !== "object") {
    failClosed("Invalid artifact lineage: expected an object");
  }
  return Object.freeze({
    artifactKind: normalizeArtifactKind(lineage.artifactKind),
    platform: normalizeNullableNonEmptyText(
      lineage.platform ?? null,
      "platform",
      64
    ),
    parent: normalizeParentIdentity(lineage.parent ?? null),
    strategy: normalizeStrategyLineage(lineage.strategy ?? null),
    approvedCopy: normalizeApprovedCopyLineage(lineage.approvedCopy ?? null),
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
 * matches, regardless of object key order or hash-letter casing. Platform
 * formatting details intentionally do not participate: reformatting a
 * platform caption must not mint a new semantic authority.
 */
export function deriveCreativeArtifactLineageFingerprint(
  lineage: CreativeArtifactLineageInput
): string {
  const normalized = normalizeCreativeArtifactLineage(lineage);
  return createHash("sha256")
    .update(
      canonicalize({
        lineageSchemaVersion: CREATIVE_ARTIFACT_LINEAGE_SCHEMA_VERSION,
        artifactKind: normalized.artifactKind,
        platform: normalized.platform,
        parent: normalized.parent,
        strategy: normalized.strategy,
        approvedCopy: normalized.approvedCopy,
      }),
      "utf8"
    )
    .digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Canonical lineage record persisted onto the durable row's metadata under
 * CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY. Deep-frozen; the embedded
 * fingerprint always equals deriveCreativeArtifactLineageFingerprint(lineage).
 */
export function buildPersistedCreativeArtifactLineage(
  lineage: CreativeArtifactLineageInput
): CreativeArtifactPersistedLineage {
  const normalized = normalizeCreativeArtifactLineage(lineage);
  return deepFreeze({
    lineageSchemaVersion: CREATIVE_ARTIFACT_LINEAGE_SCHEMA_VERSION,
    artifactKind: normalized.artifactKind,
    platform: normalized.platform,
    parent: normalized.parent,
    lineageFingerprintSha256:
      deriveCreativeArtifactLineageFingerprint(lineage),
    strategy: normalized.strategy,
    approvedCopy: normalized.approvedCopy,
  });
}

/**
 * Fail-closed tamper check for a persisted lineage record. Re-derives the
 * fingerprint from the record's own coordinates and throws BAD_REQUEST when
 * any coordinate was altered after persistence, or when the record shape is
 * not a persisted lineage record produced by buildPersistedCreativeArtifactLineage.
 */
export function assertPersistedCreativeArtifactLineageIntact(
  persisted: CreativeArtifactPersistedLineage
): void {
  if (!persisted || typeof persisted !== "object") {
    failClosed("Artifact lineage record is missing or malformed");
  }
  if (
    persisted.lineageSchemaVersion !==
    CREATIVE_ARTIFACT_LINEAGE_SCHEMA_VERSION
  ) {
    failClosed("Artifact lineage record has an unsupported schema version");
  }
  const recomputed = deriveCreativeArtifactLineageFingerprint({
    artifactKind: persisted.artifactKind,
    platform: persisted.platform,
    parent: persisted.parent,
    strategy: persisted.strategy,
    approvedCopy: persisted.approvedCopy,
  });
  if (recomputed !== persisted.lineageFingerprintSha256) {
    failClosed("Artifact lineage fingerprint mismatch");
  }
}

/**
 * Fail-closed binding check between a persisted lineage record and the V2
 * approval envelope it claims to carry. Every approved-copy coordinate and
 * every envelope-domain Strategy coordinate must match exactly; a record
 * whose lineage was rebound to a different envelope (or whose envelope was
 * swapped underneath it) fails closed instead of silently diverging.
 */
export function assertCreativeArtifactLineageMatchesEnvelope(
  persisted: CreativeArtifactPersistedLineage,
  envelope: V2ApprovalEnvelope
): void {
  if (!persisted || typeof persisted !== "object") {
    failClosed("Artifact lineage record is missing or malformed");
  }
  if (!envelope || typeof envelope !== "object") {
    failClosed("Artifact lineage envelope is missing or malformed");
  }

  const copy = persisted.approvedCopy;
  if (!copy) {
    failClosed(
      "Artifact lineage record carries no approved-copy coordinates"
    );
  }
  if (
    copy.copyHashSha256 !== envelope.copyHashSha256 ||
    copy.copySchemaVersion !== envelope.copySchemaVersion ||
    copy.approvedRevisionId !== envelope.approvedRevisionId ||
    copy.assessmentHashSha256 !== envelope.assessmentHashSha256 ||
    copy.contextLockId !== envelope.contextLockId
  ) {
    failClosed(
      "Artifact lineage approved-copy coordinates diverge from the approval envelope"
    );
  }

  const strategy = persisted.strategy;
  if (!strategy) {
    failClosed("Artifact lineage record carries no Strategy coordinates");
  }
  if (
    strategy.strategySnapshotId !== envelope.campaignStrategySnapshotId ||
    strategy.strategyHashSha256 !== envelope.strategyHashSha256 ||
    strategy.businessDnaSnapshotId !== envelope.businessDnaSnapshotId
  ) {
    failClosed(
      "Artifact lineage Strategy coordinates diverge from the approval envelope"
    );
  }
}

// ─── Authority adapters ───

/**
 * Maps an approved Creative Strategy authority (WBS11/WBS12) onto the
 * strategy-side lineage coordinates with every WBS11 run coordinate present.
 */
export function creativeArtifactStrategyLineageFromAuthority(
  authority: CreativeStrategyAuthority
): CreativeArtifactStrategyLineageInput {
  return {
    strategySnapshotId: authority.strategySnapshotId,
    strategyVersion: authority.strategyVersion,
    businessDnaSnapshotId: authority.businessDnaSnapshotId,
    strategyHashSha256: authority.strategyHashSha256,
    strategyRunId: authority.strategyRunId,
    approvalRequestId: authority.approvalRequestId,
    creativeBriefFingerprint: authority.creativeBriefFingerprint,
  };
}

/**
 * Maps the envelope-domain Strategy coordinates (the snapshot the approved
 * copy was evaluated against) onto the strategy-side lineage input. WBS11 run
 * coordinates are attached by the caller when an approved WBS11 authority is
 * bound; validation happens when the lineage is fingerprinted/persisted.
 */
export function creativeArtifactStrategyLineageFromEnvelope(
  envelope: V2ApprovalEnvelope
): CreativeArtifactStrategyLineageInput {
  return {
    strategySnapshotId: envelope.campaignStrategySnapshotId,
    strategyVersion: null,
    businessDnaSnapshotId: envelope.businessDnaSnapshotId,
    strategyHashSha256: envelope.strategyHashSha256,
    strategyRunId: null,
    approvalRequestId: null,
    creativeBriefFingerprint: null,
  };
}

/**
 * Maps a V2 approval envelope onto the approved-copy lineage coordinates.
 * Pure identity projection; envelope integrity is proven by the caller via
 * the approved-copy authority module before lineage is persisted.
 */
export function creativeArtifactApprovedCopyLineageFromEnvelope(
  envelope: V2ApprovalEnvelope
): CreativeArtifactApprovedCopyLineageInput {
  return {
    copyHashSha256: envelope.copyHashSha256,
    copySchemaVersion: envelope.copySchemaVersion,
    approvedRevisionId: envelope.approvedRevisionId,
    assessmentHashSha256: envelope.assessmentHashSha256,
    contextLockId: envelope.contextLockId,
  };
}
