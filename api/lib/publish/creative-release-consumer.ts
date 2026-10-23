/**
 * Creative release package consumption (WBS-R4 C1/C2).
 *
 * Read side of the CREATIVE_TO_DISTRIBUTION_CONTRACT (Stream B,
 * docs/CREATIVE_TO_DISTRIBUTION_CONTRACT.md). Distribution consumes the sealed
 * creative release package stored at
 * `campaigns.workflowContext.creativeReleasePackage` to SELECT and VALIDATE
 * content only — it never re-derives creative authority, never re-assembles
 * creative evidence, and never mutates the sealed record or the artefacts it
 * references (contract §6/§7).
 *
 * Placement note: Stream B owns the sealing module
 * (`api/lib/creative/release-package.ts`, write side). This module is the
 * Stream C read side and intentionally lives under `api/lib/publish/` to avoid
 * a same-path merge conflict; at R4 integration Stream B's authoritative
 * reader can replace this tolerant reader without changing distribution
 * semantics (both implement the same contract §1–§5 invariants).
 *
 * Fail-closed rule (contract §3): a malformed, tampered, cross-tenant or
 * lineage-inconsistent sealed package reads as NOT RELEASED. Distribution then
 * falls back to the existing per-item publication-readiness gates, which
 * remain authoritative for launch mechanics.
 */

import { createHash } from "crypto";

export const CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY = "creativeReleasePackage";
export const CREATIVE_RELEASE_PACKAGE_ID_PREFIX = "crp";

export type CreativeReleaseArtefactRecordType = "content_post" | "campaign_asset";

export interface CreativeReleaseArtefactRef {
  kind: string;
  recordType: CreativeReleaseArtefactRecordType;
  recordId: number;
  title?: string;
  creativeBriefFingerprint: string;
  lineageFingerprintSha256?: string;
}

export interface CreativeReleaseStrategyCoordinates {
  strategySnapshotId: string;
  strategyVersion: number;
  businessDnaSnapshotId: string;
  strategyHashSha256: string;
  strategyRunId: number;
  approvalRequestId: number;
  creativeBriefFingerprint: string;
}

export interface CreativeReleasePackage {
  packageId: string;
  packageFingerprintSha256: string;
  campaignId: number;
  userId: number;
  creativeBriefFingerprint: string;
  strategy: CreativeReleaseStrategyCoordinates;
  artefacts: CreativeReleaseArtefactRef[];
  quality: { renderedLeafletReady: boolean };
  sealedAtIso?: string;
  sealedBy?: string;
  supersedesPackageId?: string | null;
  legacyArtefactIds?: number[];
  supersededArtefactIds?: number[];
}

export type CreativeReleaseReadResult =
  | { status: "released"; package: CreativeReleasePackage }
  | { status: "not_released"; reason: string };

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function deriveReleasePackageId(campaignId: number, creativeBriefFingerprint: string): string {
  return `${CREATIVE_RELEASE_PACKAGE_ID_PREFIX}:${campaignId}:${creativeBriefFingerprint}`;
}

/**
 * Re-derives the deterministic release identity for a sealed package payload.
 * Independent of seal metadata (sealedAtIso / sealedBy / supersedesPackageId)
 * per contract §1: the identity binds the sealed content coordinates, not the
 * sealing event.
 */
export function deriveCreativeReleasePackageIdentity(input: {
  campaignId: number;
  creativeBriefFingerprint: string;
}): string {
  return deriveReleasePackageId(input.campaignId, input.creativeBriefFingerprint);
}

/**
 * Computes the canonical content fingerprint for an already-validated package.
 * The sealed record stores the authoritative fingerprint; this helper exists
 * so distribution can detect accidental post-seal content mutation by
 * comparing structure-bearing coordinates (contract §1 tamper semantics).
 */
export function computeCreativeReleaseContentFingerprint(input: {
  packageId: string;
  campaignId: number;
  userId: number;
  creativeBriefFingerprint: string;
  strategy: CreativeReleaseStrategyCoordinates;
  artefacts: CreativeReleaseArtefactRef[];
}): string {
  const canonical = JSON.stringify({
    packageId: input.packageId,
    campaignId: input.campaignId,
    userId: input.userId,
    creativeBriefFingerprint: input.creativeBriefFingerprint,
    strategy: input.strategy,
    artefacts: input.artefacts.map((a) => ({
      kind: a.kind,
      recordType: a.recordType,
      recordId: a.recordId,
      creativeBriefFingerprint: a.creativeBriefFingerprint,
      lineageFingerprintSha256: a.lineageFingerprintSha256 ?? null,
    })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Reads and validates the sealed creative release package for a campaign.
 * Pure and side-effect free; never throws on malformed input — a sealed record
 * that fails any invariant reads as `not_released` (contract §3 fail-closed).
 */
export function readCreativeReleasePackageForDistribution(input: {
  campaignId: number;
  userId: number;
  workflowContext: unknown;
}): CreativeReleaseReadResult {
  const context = isPlainObject(input.workflowContext) ? input.workflowContext : {};
  const raw = context[CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY];
  if (raw === undefined || raw === null) {
    return { status: "not_released", reason: "no_sealed_package" };
  }
  if (!isPlainObject(raw)) {
    return { status: "not_released", reason: "malformed_package" };
  }

  const campaignId = raw.campaignId;
  const userId = raw.userId;
  const creativeBriefFingerprint = raw.creativeBriefFingerprint;
  const packageId = raw.packageId;
  const packageFingerprintSha256 = raw.packageFingerprintSha256;

  // Tenant binding: the sealed package must belong to the consuming campaign
  // and user (contract §10). A cross-tenant package is tampering evidence.
  if (campaignId !== input.campaignId || userId !== input.userId) {
    return { status: "not_released", reason: "package_tenant_mismatch" };
  }
  if (!isNonEmptyString(creativeBriefFingerprint)) {
    return { status: "not_released", reason: "malformed_package" };
  }
  if (packageId !== deriveReleasePackageId(input.campaignId, creativeBriefFingerprint)) {
    return { status: "not_released", reason: "package_identity_mismatch" };
  }
  if (!isNonEmptyString(packageFingerprintSha256) || !SHA256_HEX_PATTERN.test(packageFingerprintSha256)) {
    return { status: "not_released", reason: "malformed_package" };
  }

  const strategy = raw.strategy;
  if (!isPlainObject(strategy)) {
    return { status: "not_released", reason: "malformed_package" };
  }
  const coordinates = {
    strategySnapshotId: strategy.strategySnapshotId,
    strategyVersion: strategy.strategyVersion,
    businessDnaSnapshotId: strategy.businessDnaSnapshotId,
    strategyHashSha256: strategy.strategyHashSha256,
    strategyRunId: strategy.strategyRunId,
    approvalRequestId: strategy.approvalRequestId,
    creativeBriefFingerprint: strategy.creativeBriefFingerprint,
  } as CreativeReleaseStrategyCoordinates;
  if (
    !isNonEmptyString(coordinates.strategySnapshotId) ||
    !isPositiveInteger(coordinates.strategyVersion) ||
    !isNonEmptyString(coordinates.businessDnaSnapshotId) ||
    !isNonEmptyString(coordinates.strategyHashSha256) ||
    !isPositiveInteger(coordinates.strategyRunId) ||
    !isPositiveInteger(coordinates.approvalRequestId) ||
    coordinates.creativeBriefFingerprint !== creativeBriefFingerprint
  ) {
    return { status: "not_released", reason: "strategy_coordinates_invalid" };
  }

  if (!Array.isArray(raw.artefacts)) {
    return { status: "not_released", reason: "malformed_package" };
  }
  const artefacts: CreativeReleaseArtefactRef[] = [];
  for (const ref of raw.artefacts) {
    if (!isPlainObject(ref)) {
      return { status: "not_released", reason: "malformed_package" };
    }
    if (
      !isNonEmptyString(ref.kind) ||
      (ref.recordType !== "content_post" && ref.recordType !== "campaign_asset") ||
      !isPositiveInteger(ref.recordId) ||
      ref.creativeBriefFingerprint !== creativeBriefFingerprint
    ) {
      return { status: "not_released", reason: "artefact_lineage_mismatch" };
    }
    artefacts.push({
      kind: ref.kind,
      recordType: ref.recordType,
      recordId: ref.recordId,
      title: typeof ref.title === "string" ? ref.title : undefined,
      creativeBriefFingerprint: ref.creativeBriefFingerprint,
      lineageFingerprintSha256:
        typeof ref.lineageFingerprintSha256 === "string" ? ref.lineageFingerprintSha256 : undefined,
    });
  }

  const quality = isPlainObject(raw.quality) ? raw.quality : {};
  return {
    status: "released",
    package: {
      packageId,
      packageFingerprintSha256,
      campaignId: input.campaignId,
      userId: input.userId,
      creativeBriefFingerprint,
      strategy: coordinates,
      artefacts,
      quality: { renderedLeafletReady: quality.renderedLeafletReady === true },
      sealedAtIso: typeof raw.sealedAtIso === "string" ? raw.sealedAtIso : undefined,
      sealedBy: typeof raw.sealedBy === "string" ? raw.sealedBy : undefined,
      supersedesPackageId:
        typeof raw.supersedesPackageId === "string" ? raw.supersedesPackageId : null,
      legacyArtefactIds: Array.isArray(raw.legacyArtefactIds)
        ? raw.legacyArtefactIds.filter(isPositiveInteger)
        : [],
      supersededArtefactIds: Array.isArray(raw.supersededArtefactIds)
        ? raw.supersededArtefactIds.filter(isPositiveInteger)
        : [],
    },
  };
}

/**
 * Selects the authoritative content_post ids from a released package. Legacy
 * and superseded artefact ids are never bundled (contract §4).
 */
export function selectReleasedContentPostIds(pkg: CreativeReleasePackage): number[] {
  const ids = new Set<number>();
  for (const ref of pkg.artefacts) {
    if (ref.recordType === "content_post") ids.add(ref.recordId);
  }
  return [...ids];
}
