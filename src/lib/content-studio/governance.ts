/**
 * Pure view-model adapter that maps persisted Creative governance metadata
 * (WBS12) onto the small, non-sensitive summary Content Studio displays for
 * content posts, campaign assets, and generated image records.
 *
 * Governed rows are recognised by the presence of the durable lineage /
 * envelope metadata the governed Creative pipeline already persists:
 *
 *   - campaign_assets: metadata.creativeArtifactLineage (artifact lineage,
 *     WBS12.3) and, for approved message packs, metadata.v2ApprovalEnvelope
 *     (V2 message-approval contract). Invalidation state lives in
 *     metadata.supersededBy / metadata.invalidatedAt.
 *   - generated_images: metadata.renderLineage (render lineage), whose parent
 *     is the content post the render belongs to.
 *   - content_posts: legacy approval flag metadata.approved, plus the
 *     reapproval-required marker written when a semantic edit voids approval.
 *
 * Only normalized ids/timestamps are surfaced here. Raw internal hashes
 * (copyHashSha256, lineageFingerprintSha256, strategyHashSha256, ...) are
 * deliberately never exposed: they are authority coordinates for fail-closed
 * verification, not user-facing metadata.
 */

export const CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY =
  "creativeArtifactLineage";
export const IMAGE_RENDER_LINEAGE_METADATA_KEY = "renderLineage";

export type CreativeGovernanceApprovalState =
  | "approved"
  | "pending"
  | "superseded"
  | "invalidated"
  | "reapproval_required"
  | "legacy_approved"
  | "legacy";

export interface CreativeGovernanceParentRef {
  artifactKind: string;
  artifactId: number | null;
}

export interface CreativeGovernanceView {
  /** True when the record carries durable Creative governance metadata. */
  readonly governed: boolean;
  /** Lineage artifact kind, render kind, or the row's assetType fallback. */
  readonly artifactKind: string | null;
  /** Platform/channel for platform-variant artifacts. */
  readonly platform: string | null;
  /** Approved parent artifact this record derives from, when known. */
  readonly parent: CreativeGovernanceParentRef | null;
  readonly approvalState: CreativeGovernanceApprovalState;
  readonly approvedAtIso: string | null;
  /** Non-hash version identity of the approved copy, when available. */
  readonly approvedRevisionId: string | null;
  /** Non-hash Strategy snapshot identity, when available. */
  readonly strategySnapshotId: string | null;
  /** True when lineage coordinates bind this record to approved copy. */
  readonly boundToApprovedCopy: boolean;
  /** For rendered images: the parent content post id from render lineage. */
  readonly renderParentContentPostId: number | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readRecordMetadata(record: unknown): Record<string, unknown> {
  return (
    (record as Record<string, unknown> | null | undefined)?.metadata as
      | Record<string, unknown>
      | undefined
  ) || {};
}

function normalizeParentRef(
  parent: Record<string, unknown> | null
): CreativeGovernanceParentRef | null {
  if (!parent) return null;
  const artifactKind = asNullableString(parent.artifactKind);
  if (!artifactKind) return null;
  return { artifactKind, artifactId: asNullableNumber(parent.artifactId) };
}

/**
 * Build the display view for one record. Never throws: malformed or partial
 * governance metadata degrades to the legacy view so old rows stay usable.
 */
export function buildCreativeGovernanceView(
  record: unknown
): CreativeGovernanceView {
  const row = (record ?? {}) as Record<string, unknown>;
  const meta = readRecordMetadata(record);

  const lineage = asObject(meta[CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY]);
  const renderLineage = asObject(meta[IMAGE_RENDER_LINEAGE_METADATA_KEY]);
  const approvedMessagePack = asObject(meta.approvedMessagePack);
  const envelope =
    asObject(meta.v2ApprovalEnvelope) ??
    asObject(approvedMessagePack?.v2ApprovalEnvelope);

  const renderParentContentPostId = asNullableNumber(
    renderLineage?.contentPostId
  );
  const parent =
    normalizeParentRef(asObject(lineage?.parent)) ??
    (renderLineage
      ? { artifactKind: "content_post", artifactId: renderParentContentPostId }
      : null);

  const approvedCopyCoords =
    asObject(lineage?.approvedCopy) ?? asObject(renderLineage?.approvedCopy);
  const boundToApprovedCopy = !!approvedCopyCoords;

  const strategyCoords =
    asObject(lineage?.strategy) ?? asObject(renderLineage?.strategy);
  const strategySnapshotId =
    asNullableString(strategyCoords?.strategySnapshotId) ??
    asNullableString(envelope?.campaignStrategySnapshotId);

  const approvedRevisionId =
    asNullableString(envelope?.approvedRevisionId) ??
    asNullableString(approvedCopyCoords?.approvedRevisionId);

  const approvedAtIso =
    asNullableString(envelope?.approvedAtIso) ??
    asNullableString(meta.approvedAt);

  const supersededBy =
    meta.supersededBy ?? approvedMessagePack?.supersededBy ?? null;
  const invalidatedAt =
    meta.invalidatedAt ?? approvedMessagePack?.invalidatedAt ?? null;
  const approvedFlag = meta.approved === true;
  const reapprovalRequired =
    !approvedFlag && asNullableString(meta.approvalVoidedReason) !== null;

  const governed = !!lineage || !!renderLineage || !!envelope;

  let approvalState: CreativeGovernanceApprovalState;
  if (invalidatedAt) {
    approvalState = "invalidated";
  } else if (supersededBy !== null && supersededBy !== undefined) {
    approvalState = "superseded";
  } else if (reapprovalRequired) {
    approvalState = "reapproval_required";
  } else if (governed) {
    approvalState =
      envelope?.decision === "approved" || boundToApprovedCopy
        ? "approved"
        : "pending";
  } else {
    approvalState = approvedFlag ? "legacy_approved" : "legacy";
  }

  const artifactKind =
    asNullableString(lineage?.artifactKind) ??
    (renderLineage ? "rendered_image" : null) ??
    asNullableString(row.assetType);

  const platform =
    asNullableString(lineage?.platform) ?? asNullableString(meta.platform);

  return {
    governed,
    artifactKind,
    platform,
    parent,
    approvalState,
    approvedAtIso,
    approvedRevisionId,
    strategySnapshotId,
    boundToApprovedCopy,
    renderParentContentPostId,
  };
}

/** Human-readable parent descriptor, e.g. "message pack" or null. */
export function formatGovernanceParent(
  parent: CreativeGovernanceParentRef | null
): string | null {
  if (!parent) return null;
  const kind = parent.artifactKind.replace(/_/g, " ");
  return parent.artifactId != null ? `${kind} #${parent.artifactId}` : kind;
}
