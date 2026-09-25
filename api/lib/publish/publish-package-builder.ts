// ─── Publish Package builder & validator (WBS13.1) ───
//
// Fail-closed construction and validation of immutable publish packages.
// Pure module: re-derives deterministic hashes from data it is handed and
// never touches the database, the network, or platform providers.
//
// Build pipeline:
//   1. normalize + validate every input coordinate (fail closed on malformed)
//   2. classify: governed vs legacy (explicit, never pretends lineage exists)
//   3. for governed packages, assert every bound artifact shares compatible
//      parent authority coordinates (mismatched parents fail closed)
//   4. assemble + deep-freeze the self-authenticating package

import { TRPCError } from "@trpc/server";
import {
  PUBLISH_PACKAGE_SCHEMA_VERSION,
  assemblePublishPackage,
  type PublishPackage,
  type PublishPackageArtifactBinding,
  type PublishPackageApprovedCopyIdentity,
  type PublishPackageClassification,
  type PublishPackageEvidence,
  type PublishPackageIdentity,
  type PublishPackageIntent,
  type PublishPackageLegacyReason,
  type PublishPackagePayload,
  type PublishPackageStrategyAuthority,
  type PublishPackageVisualIdentity,
} from "./publish-package-contract";
import { deriveCreativeArtifactLineageFingerprint } from "../creative/artifact-lineage";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const KNOWN_CREATIVE_ARTIFACT_KINDS = new Set([
  "message_pack",
  "platform_caption",
  "hashtag_set",
  "caption_pack",
]);

// ─── Raw build input (callers hand over mutable record projections) ───

export interface PublishPackageStrategyAuthorityInput {
  strategySnapshotId?: unknown;
  strategyVersion?: unknown;
  businessDnaSnapshotId?: unknown;
  strategyHashSha256?: unknown;
  strategyRunId?: unknown;
  approvalRequestId?: unknown;
  creativeBriefFingerprint?: unknown;
}

export interface PublishPackageApprovedCopyInput {
  copyHashSha256?: unknown;
  copySchemaVersion?: unknown;
  approvedRevisionId?: unknown;
  assessmentHashSha256?: unknown;
  contextLockId?: unknown;
}

export interface PublishPackageArtifactLineageInput {
  lineageSchemaVersion?: unknown;
  artifactKind?: unknown;
  artifactId?: unknown;
  lineageFingerprintSha256?: unknown;
  strategy?: PublishPackageStrategyAuthorityInput | null;
  approvedCopy?: PublishPackageApprovedCopyInput | null;
}

export interface PublishPackageSelectedContentInput {
  contentPostId: unknown;
  artifactKind?: unknown;
  lineage?: PublishPackageArtifactLineageInput | null;
}

export interface PublishPackageCaptionArtifactInput {
  artifactId?: unknown;
  artifactKind?: unknown;
  lineage?: PublishPackageArtifactLineageInput | null;
}

export interface PublishPackageVisualArtifactInput {
  mediaKind?: unknown;
  generatedAssetId?: unknown;
  mediaUrl?: unknown;
  renderLineage?: PublishPackageArtifactLineageInput | null;
}

export interface PublishPackageBuildInput {
  campaignId: unknown;
  userId: unknown;
  businessId?: unknown;
  destination: { platform: unknown; integrationId?: unknown };
  intent?: { mode?: unknown; scheduledAtIso?: unknown };
  strategyAuthority?: PublishPackageStrategyAuthorityInput | null;
  approvedCopy?: PublishPackageApprovedCopyInput | null;
  selectedContent: PublishPackageSelectedContentInput;
  captionArtifact?: PublishPackageCaptionArtifactInput | null;
  visualArtifact?: PublishPackageVisualArtifactInput | null;
  evidence?: { launchApprovalRequestId?: unknown };
  payload: { text: unknown; mediaUrls?: unknown; mediaType?: unknown };
  createdAtIso?: unknown;
}

// ─── Normalization (fail closed) ───

function failMalformed(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

function failConflict(message: string): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `Publish package lineage conflict: ${message}`,
  });
}

function normalizeNonEmptyText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    failMalformed(`Invalid publish package ${name}: expected a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    failMalformed(`Invalid publish package ${name}: expected at most ${max} characters`);
  }
  return trimmed;
}

function normalizeNullableNonEmptyText(value: unknown, name: string, max: number): string | null {
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
    failMalformed(`Invalid publish package ${name}: expected positive safe integer`);
  }
  return value;
}

function normalizeNullablePositiveId(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  return normalizePositiveId(value, name);
}

function normalizeSha256Hex(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    failMalformed(`Invalid publish package ${name}: expected 64-character lowercase SHA-256 hex`);
  }
  return normalized;
}

function normalizeNullableSha256Hex(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  return normalizeSha256Hex(value, name);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalizes Strategy authority coordinates. The envelope-domain coordinates
 * (snapshot id, Business DNA snapshot id, strategy hash) are required; WBS11
 * run coordinates are attached when an approved WBS11 authority was bound.
 */
function normalizeStrategyAuthority(
  input: PublishPackageStrategyAuthorityInput | null | undefined
): PublishPackageStrategyAuthority | null {
  if (input === null || input === undefined) return null;
  if (!isObject(input)) {
    failMalformed("Invalid publish package strategyAuthority: expected an object or null");
  }
  return {
    strategySnapshotId: normalizeNonEmptyText(input.strategySnapshotId, "strategyAuthority.strategySnapshotId", 128),
    strategyVersion: normalizeNullablePositiveId(input.strategyVersion ?? null, "strategyAuthority.strategyVersion"),
    businessDnaSnapshotId: normalizeNonEmptyText(
      input.businessDnaSnapshotId,
      "strategyAuthority.businessDnaSnapshotId",
      128
    ),
    strategyHashSha256: normalizeSha256Hex(input.strategyHashSha256, "strategyAuthority.strategyHashSha256"),
    strategyRunId: normalizeNullablePositiveId(input.strategyRunId ?? null, "strategyAuthority.strategyRunId"),
    approvalRequestId: normalizeNullablePositiveId(
      input.approvalRequestId ?? null,
      "strategyAuthority.approvalRequestId"
    ),
    creativeBriefFingerprint: normalizeNullableNonEmptyText(
      input.creativeBriefFingerprint ?? null,
      "strategyAuthority.creativeBriefFingerprint",
      191
    ),
  };
}

function normalizeApprovedCopy(
  input: PublishPackageApprovedCopyInput | null | undefined
): PublishPackageApprovedCopyIdentity | null {
  if (input === null || input === undefined) return null;
  if (!isObject(input)) {
    failMalformed("Invalid publish package approvedCopy: expected an object or null");
  }
  return {
    copyHashSha256: normalizeSha256Hex(input.copyHashSha256, "approvedCopy.copyHashSha256"),
    copySchemaVersion: normalizeNonEmptyText(input.copySchemaVersion, "approvedCopy.copySchemaVersion", 32),
    approvedRevisionId: normalizeNonEmptyText(input.approvedRevisionId, "approvedCopy.approvedRevisionId", 64),
    assessmentHashSha256: normalizeSha256Hex(input.assessmentHashSha256, "approvedCopy.assessmentHashSha256"),
    contextLockId: normalizeNonEmptyText(input.contextLockId, "approvedCopy.contextLockId", 128),
  };
}

/**
 * Normalizes one persisted creative-artifact lineage record into an artifact
 * binding. When the artifact kind is a known governed kind, the fingerprint is
 * re-derived and compared so tampered lineage fails closed here instead of
 * flowing into a package identity.
 */
function normalizeArtifactLineageBinding(input: {
  artifactKind: unknown;
  artifactId: unknown;
  lineage: PublishPackageArtifactLineageInput | null | undefined;
}): PublishPackageArtifactBinding {
  const artifactKind = normalizeNonEmptyText(input.artifactKind, "artifactKind", 64);
  const artifactId = normalizeNullablePositiveId(input.artifactId ?? null, "artifactId");
  const lineage = input.lineage ?? null;
  if (lineage === null) {
    return { artifactKind, artifactId, lineageFingerprintSha256: null, strategy: null, approvedCopy: null };
  }
  if (!isObject(lineage)) {
    failMalformed("Invalid publish package artifact lineage: expected an object or null");
  }
  const lineageFingerprintSha256 = normalizeSha256Hex(
    lineage.lineageFingerprintSha256,
    "lineage.lineageFingerprintSha256"
  );
  const strategy = normalizeStrategyAuthority(lineage.strategy ?? null);
  const approvedCopy = normalizeApprovedCopy(lineage.approvedCopy ?? null);
  if (KNOWN_CREATIVE_ARTIFACT_KINDS.has(artifactKind)) {
    const recomputed = deriveCreativeArtifactLineageFingerprint({
      artifactKind: artifactKind as "message_pack" | "platform_caption" | "hashtag_set" | "caption_pack",
      platform: null,
      parent: null,
      strategy,
      approvedCopy,
    });
    if (recomputed !== lineageFingerprintSha256) {
      failMalformed("Publish package artifact lineage fingerprint mismatch (tampered lineage)");
    }
  }
  return {
    artifactKind,
    artifactId,
    lineageFingerprintSha256,
    strategy,
    approvedCopy,
  };
}

function normalizeVisualArtifact(
  input: PublishPackageVisualArtifactInput | null | undefined,
  fallbackMediaUrl: string | null
): PublishPackageVisualIdentity | null {
  if (input === null || input === undefined) return null;
  if (!isObject(input)) {
    failMalformed("Invalid publish package visualArtifact: expected an object or null");
  }
  const mediaKind = input.mediaKind ?? "image";
  if (mediaKind !== "image" && mediaKind !== "video") {
    failMalformed('Invalid publish package visualArtifact.mediaKind: expected "image" or "video"');
  }
  const mediaUrl = normalizeNullableNonEmptyText(input.mediaUrl ?? fallbackMediaUrl ?? null, "visualArtifact.mediaUrl", 2048);
  const renderLineage = input.renderLineage ?? null;
  if (renderLineage !== null && !isObject(renderLineage)) {
    failMalformed("Invalid publish package visualArtifact.renderLineage: expected an object or null");
  }
  return {
    mediaKind,
    generatedAssetId: normalizeNullablePositiveId(input.generatedAssetId ?? null, "visualArtifact.generatedAssetId"),
    mediaUrl,
    renderLineageFingerprintSha256: normalizeNullableSha256Hex(
      renderLineage?.lineageFingerprintSha256 ?? null,
      "renderLineage.lineageFingerprintSha256"
    ),
    strategy: normalizeStrategyAuthority(renderLineage?.strategy ?? null),
    approvedCopy: normalizeApprovedCopy(renderLineage?.approvedCopy ?? null),
  };
}

function normalizeIntent(input: PublishPackageBuildInput["intent"]): PublishPackageIntent {
  const mode = input?.mode ?? "immediate";
  if (mode !== "immediate" && mode !== "scheduled") {
    failMalformed('Invalid publish package intent.mode: expected "immediate" or "scheduled"');
  }
  const scheduledAtIso = normalizeNullableNonEmptyText(input?.scheduledAtIso ?? null, "intent.scheduledAtIso", 64);
  if (mode === "scheduled" && !scheduledAtIso) {
    failMalformed("Invalid publish package intent: scheduled mode requires scheduledAtIso");
  }
  if (mode === "immediate" && scheduledAtIso !== null) {
    failMalformed("Invalid publish package intent: immediate mode must not carry scheduledAtIso");
  }
  return { mode, scheduledAtIso };
}

function normalizePayload(input: PublishPackageBuildInput["payload"]): PublishPackagePayload {
  if (!isObject(input)) {
    failMalformed("Invalid publish package payload: expected an object");
  }
  const text = typeof input.text === "string" ? input.text : "";
  if (!text.trim()) {
    failMalformed("Invalid publish package payload.text: expected a non-empty string");
  }
  const rawMediaUrls = input.mediaUrls ?? [];
  if (!Array.isArray(rawMediaUrls)) {
    failMalformed("Invalid publish package payload.mediaUrls: expected an array");
  }
  const mediaUrls = rawMediaUrls
    .map((url) => normalizeNonEmptyText(url, "payload.mediaUrls[]", 2048))
    .filter((url, index, all) => all.indexOf(url) === index);
  const mediaType = input.mediaType ?? null;
  if (mediaType !== null && mediaType !== "image" && mediaType !== "video") {
    failMalformed('Invalid publish package payload.mediaType: expected "image", "video" or null');
  }
  if (mediaType !== null && mediaUrls.length === 0) {
    failMalformed("Invalid publish package payload: mediaType requires at least one media URL");
  }
  return { text, mediaUrls, mediaType };
}

// ─── Classification ───

export interface PublishPackageNormalizedInput {
  identity: PublishPackageIdentity;
  payload: PublishPackagePayload;
  createdAtIso: string | null;
}

/**
 * Fail-closed normalization of the full build input. Does not classify or
 * assemble; exposed for validators that need a normalized projection.
 */
export function normalizePublishPackageBuildInput(
  input: PublishPackageBuildInput
): PublishPackageNormalizedInput {
  if (!isObject(input)) {
    failMalformed("Invalid publish package input: expected an object");
  }
  const campaignId = normalizePositiveId(input.campaignId, "campaignId");
  const userId = normalizePositiveId(input.userId, "userId");
  const businessId = normalizeNullablePositiveId(input.businessId ?? null, "businessId");
  const platform = normalizeNonEmptyText(input.destination?.platform, "destination.platform", 64).toLowerCase();
  const integrationId = normalizeNullablePositiveId(input.destination?.integrationId ?? null, "destination.integrationId");

  const selectedContent = normalizeArtifactLineageBinding({
    artifactKind: input.selectedContent?.artifactKind ?? "content_post",
    artifactId: input.selectedContent?.contentPostId,
    lineage: input.selectedContent?.lineage ?? null,
  });

  const captionArtifact =
    input.captionArtifact === null || input.captionArtifact === undefined
      ? null
      : normalizeArtifactLineageBinding({
          artifactKind: input.captionArtifact.artifactKind ?? "caption_pack",
          artifactId: input.captionArtifact.artifactId ?? null,
          lineage: input.captionArtifact.lineage ?? null,
        });

  const visualArtifact = normalizeVisualArtifact(input.visualArtifact ?? null, null);

  const evidence: PublishPackageEvidence = {
    launchApprovalRequestId: normalizeNullablePositiveId(
      input.evidence?.launchApprovalRequestId ?? null,
      "evidence.launchApprovalRequestId"
    ),
  };

  const createdAtIso = normalizeNullableNonEmptyText(input.createdAtIso ?? null, "createdAtIso", 64);

  return {
    identity: {
      campaignId,
      userId,
      businessId,
      destination: { platform, integrationId },
      intent: normalizeIntent(input.intent),
      strategyAuthority: normalizeStrategyAuthority(input.strategyAuthority ?? null),
      approvedCopy: normalizeApprovedCopy(input.approvedCopy ?? null),
      selectedContent,
      captionArtifact,
      visualArtifact,
      evidence,
    },
    payload: normalizePayload(input.payload),
    createdAtIso,
  };
}

/**
 * Explicit governed/legacy classification. Any missing governed chain link
 * produces a legacy package naming the missing links; legacy artifacts are
 * never silently treated as governed.
 */
export function classifyPublishPackageInput(
  normalized: PublishPackageNormalizedInput
): { classification: PublishPackageClassification; legacyReasons: PublishPackageLegacyReason[] } {
  const reasons: PublishPackageLegacyReason[] = [];
  const identity = normalized.identity;

  if (!identity.strategyAuthority) reasons.push("strategy_authority_missing");
  if (!identity.approvedCopy) reasons.push("approved_copy_identity_missing");
  if (!identity.selectedContent.lineageFingerprintSha256) reasons.push("selected_content_lineage_missing");
  if (!identity.captionArtifact) {
    reasons.push("caption_artifact_missing");
  } else if (!identity.captionArtifact.lineageFingerprintSha256) {
    reasons.push("caption_artifact_lineage_missing");
  }
  if (identity.visualArtifact && !identity.visualArtifact.renderLineageFingerprintSha256) {
    reasons.push("visual_artifact_lineage_missing");
  }

  return {
    classification: reasons.length === 0 ? "governed" : "legacy",
    legacyReasons: reasons,
  };
}

// ─── Lineage compatibility (fail closed) ───

function sameStrategyEnvelopeDomain(
  a: PublishPackageStrategyAuthority,
  b: PublishPackageStrategyAuthority
): boolean {
  return (
    a.strategySnapshotId === b.strategySnapshotId &&
    a.businessDnaSnapshotId === b.businessDnaSnapshotId &&
    a.strategyHashSha256 === b.strategyHashSha256
  );
}

function sameApprovedCopy(a: PublishPackageApprovedCopyIdentity, b: PublishPackageApprovedCopyIdentity): boolean {
  return (
    a.copyHashSha256 === b.copyHashSha256 &&
    a.copySchemaVersion === b.copySchemaVersion &&
    a.approvedRevisionId === b.approvedRevisionId &&
    a.assessmentHashSha256 === b.assessmentHashSha256 &&
    a.contextLockId === b.contextLockId
  );
}

function assertBindingCompatibleWithAuthority(input: {
  label: string;
  binding: { strategy: PublishPackageStrategyAuthority | null; approvedCopy: PublishPackageApprovedCopyIdentity | null };
  strategyAuthority: PublishPackageStrategyAuthority;
  approvedCopy: PublishPackageApprovedCopyIdentity;
}): void {
  if (input.binding.strategy && !sameStrategyEnvelopeDomain(input.binding.strategy, input.strategyAuthority)) {
    failConflict(`${input.label} is bound to a different Strategy authority than the publish package`);
  }
  if (input.binding.approvedCopy && !sameApprovedCopy(input.binding.approvedCopy, input.approvedCopy)) {
    failConflict(`${input.label} is bound to a different approved copy than the publish package`);
  }
}

/**
 * Fail-closed parent-authority compatibility check for a governed package:
 * every bound artifact (selected content, caption artifact, visual artifact)
 * must share the package's Strategy authority and approved-copy identity.
 * A package assembled from stale or mismatched lineage never validates.
 */
export function assertPublishPackageLineageCompatible(pkg: PublishPackage): void {
  if (pkg.classification !== "governed") return;
  const strategyAuthority = pkg.identity.strategyAuthority;
  const approvedCopy = pkg.identity.approvedCopy;
  if (!strategyAuthority || !approvedCopy) {
    failConflict("governed package is missing Strategy authority or approved-copy identity");
  }
  assertBindingCompatibleWithAuthority({
    label: "Selected content artifact",
    binding: pkg.identity.selectedContent,
    strategyAuthority,
    approvedCopy,
  });
  if (pkg.identity.captionArtifact) {
    assertBindingCompatibleWithAuthority({
      label: "Caption artifact",
      binding: pkg.identity.captionArtifact,
      strategyAuthority,
      approvedCopy,
    });
  }
  if (pkg.identity.visualArtifact) {
    assertBindingCompatibleWithAuthority({
      label: "Visual artifact",
      binding: pkg.identity.visualArtifact,
      strategyAuthority,
      approvedCopy,
    });
  }
}

// ─── Build ───

/**
 * Build, classify, validate and deep-freeze one immutable publish package.
 * Pure and deterministic: same inputs → same package fingerprint; the
 * optional createdAtIso provenance timestamp never feeds the identity.
 */
export function buildPublishPackage(input: PublishPackageBuildInput): PublishPackage {
  const normalized = normalizePublishPackageBuildInput(input);
  const { classification, legacyReasons } = classifyPublishPackageInput(normalized);
  const pkg = assemblePublishPackage({
    identity: normalized.identity,
    classification,
    legacyReasons,
    payload: normalized.payload,
    createdAtIso: normalized.createdAtIso,
  });
  assertPublishPackageLineageCompatible(pkg);
  return pkg;
}

// ─── Consumption guards ───

/**
 * Fail-closed check that new artifact inputs describe the same publication
 * authority as an already-built package. Used to detect stale or conflicting
 * lineage before a package is (re)consumed: a changed Strategy, approved
 * copy, or render lineage makes the inputs incompatible with the package.
 */
export function assertPublishPackageCompatibleWithInput(
  pkg: PublishPackage,
  input: PublishPackageBuildInput
): void {
  const next = normalizePublishPackageBuildInput(input);
  const prev = pkg.identity;
  const diverged = (field: string): never => failConflict(`${field} diverges from the built publish package`);

  if (next.identity.campaignId !== prev.campaignId) diverged("campaignId");
  if (next.identity.userId !== prev.userId) diverged("userId");
  if (next.identity.businessId !== prev.businessId) diverged("businessId");
  if (next.identity.destination.platform !== prev.destination.platform) diverged("destination.platform");
  if (next.identity.destination.integrationId !== prev.destination.integrationId) diverged("destination.integrationId");
  if (next.identity.intent.mode !== prev.intent.mode) diverged("intent.mode");
  if (next.identity.intent.scheduledAtIso !== prev.intent.scheduledAtIso) diverged("intent.scheduledAtIso");

  const prevStrategy = prev.strategyAuthority;
  const nextStrategy = next.identity.strategyAuthority;
  if (!prevStrategy !== !nextStrategy) diverged("strategyAuthority");
  if (prevStrategy && nextStrategy && !sameStrategyEnvelopeDomain(prevStrategy, nextStrategy)) {
    diverged("strategyAuthority");
  }

  const prevCopy = prev.approvedCopy;
  const nextCopy = next.identity.approvedCopy;
  if (!prevCopy !== !nextCopy) diverged("approvedCopy");
  if (prevCopy && nextCopy && !sameApprovedCopy(prevCopy, nextCopy)) diverged("approvedCopy");

  const prevContent = prev.selectedContent;
  const nextContent = next.identity.selectedContent;
  if (nextContent.artifactId !== prevContent.artifactId) diverged("selectedContent.artifactId");
  if (nextContent.lineageFingerprintSha256 !== prevContent.lineageFingerprintSha256) {
    diverged("selectedContent lineage");
  }

  const prevCaption = prev.captionArtifact;
  const nextCaption = next.identity.captionArtifact;
  if (!prevCaption !== !nextCaption) diverged("captionArtifact");
  if (prevCaption && nextCaption) {
    if (nextCaption.artifactId !== prevCaption.artifactId) diverged("captionArtifact.artifactId");
    if (nextCaption.lineageFingerprintSha256 !== prevCaption.lineageFingerprintSha256) {
      diverged("captionArtifact lineage");
    }
  }

  const prevVisual = prev.visualArtifact;
  const nextVisual = next.identity.visualArtifact;
  if (!prevVisual !== !nextVisual) diverged("visualArtifact");
  if (prevVisual && nextVisual) {
    if (nextVisual.mediaKind !== prevVisual.mediaKind) diverged("visualArtifact.mediaKind");
    if (nextVisual.renderLineageFingerprintSha256 !== prevVisual.renderLineageFingerprintSha256) {
      diverged("visualArtifact render lineage");
    }
  }
}

/**
 * Fail-closed binding between a package and a publishing_queue row. The
 * package may only be consumed for the exact ownership/destination/content
 * coordinates it was built for.
 */
export function assertPublishPackageMatchesQueueItem(
  pkg: PublishPackage,
  item: {
    userId: number;
    campaignId: number | null;
    contentPostId: number | null;
    platform: string;
    integrationId?: number | null;
  }
): void {
  if (pkg.identity.userId !== item.userId) {
    failConflict("Publish package user does not match the publishing queue item");
  }
  if (item.campaignId !== null && pkg.identity.campaignId !== item.campaignId) {
    failConflict("Publish package campaign does not match the publishing queue item");
  }
  if (
    item.contentPostId !== null &&
    pkg.identity.selectedContent.artifactId !== null &&
    pkg.identity.selectedContent.artifactId !== item.contentPostId
  ) {
    failConflict("Publish package selected content does not match the publishing queue item");
  }
  if (pkg.identity.destination.platform !== String(item.platform || "").trim().toLowerCase()) {
    failConflict("Publish package destination platform does not match the publishing queue item");
  }
  if (
    pkg.identity.destination.integrationId !== null &&
    item.integrationId != null &&
    pkg.identity.destination.integrationId !== item.integrationId
  ) {
    failConflict("Publish package integration does not match the publishing queue item");
  }
}

/**
 * Fail-closed freshness check between the frozen package payload and the live
 * content row at execution time. If the mutable row no longer composes to the
 * frozen payload (caption edited, image swapped), the package must not be
 * consumed; republication requires a fresh package built from current rows.
 */
export function assertPublishPackagePayloadCurrent(
  pkg: PublishPackage,
  contentPost: { hook?: string | null; caption?: string | null; cta?: string | null; imageUrl?: string | null; metadata?: unknown }
): void {
  const meta = (contentPost?.metadata || {}) as Record<string, unknown>;
  const liveText = `${contentPost?.hook || ""}\n\n${contentPost?.caption || ""}\n\n${contentPost?.cta || ""}`.trim();
  if (liveText !== pkg.payload.text) {
    failConflict("Content post copy diverges from the frozen publish package payload");
  }
  const liveImageUrl =
    (typeof meta.imageUrl === "string" && meta.imageUrl) ||
    (typeof (contentPost as { imageUrl?: unknown })?.imageUrl === "string" &&
      (contentPost as { imageUrl: string }).imageUrl) ||
    null;
  const frozenMediaUrl = pkg.payload.mediaUrls[0] ?? null;
  if (frozenMediaUrl !== liveImageUrl) {
    failConflict("Content post media diverges from the frozen publish package payload");
  }
}

/**
 * Project a frozen package into the platform-adapter payload shape. Returns a
 * fresh mutable copy (adapters may normalize media URLs) — the package itself
 * stays deep-frozen. The adapter never needs to reread mutable Strategy or
 * copy rows: the package is sufficient.
 */
export function publishPackageToAdapterPayload(pkg: PublishPackage): {
  text: string;
  mediaUrls?: string[];
  mediaType?: "image" | "video";
} {
  const mediaUrls = [...pkg.payload.mediaUrls];
  return {
    text: pkg.payload.text,
    ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
    ...(pkg.payload.mediaType ? { mediaType: pkg.payload.mediaType } : {}),
  };
}

export { PUBLISH_PACKAGE_SCHEMA_VERSION };
export type { PublishPackage };
