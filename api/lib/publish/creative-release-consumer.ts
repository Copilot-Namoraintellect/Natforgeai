/**
 * Creative release package consumption (WBS-R4 C1/C2) — converged at X3.1.
 *
 * Read side of the CREATIVE_TO_DISTRIBUTION_CONTRACT (Stream B,
 * docs/CREATIVE_TO_DISTRIBUTION_CONTRACT.md). Distribution consumes the sealed
 * creative release package stored at
 * `campaigns.workflowContext.creativeReleasePackage` to SELECT and VALIDATE
 * content only — it never re-derives creative authority, never re-assembles
 * creative evidence, and never mutates the sealed record or the artefacts it
 * references (contract §6/§7).
 *
 * X3.1 (R4 integration): this module previously carried a tolerant parallel
 * implementation of the release identity, content fingerprint and package
 * validation. That temporary authority is retired — every identity, tamper
 * check and type now delegates to Stream B's sole sealing authority
 * (`api/lib/creative/release-package.ts`). This file keeps only the
 * distribution-shaped read adapter (result vocabulary + tenant/identity
 * pre-checks) and the content-post selection helper.
 *
 * Fail-closed rule (contract §3): a malformed, tampered, cross-tenant or
 * lineage-inconsistent sealed package reads as NOT RELEASED. Distribution then
 * falls back to the existing per-item publication-readiness gates, which
 * remain authoritative for launch mechanics.
 */

import {
  CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY as AUTHORITATIVE_CONTEXT_KEY,
  readSealedCreativeReleasePackage,
  assertCreativeReleasePackageIntact,
  deriveCreativeReleasePackageIdentity,
  type CreativeReleasePackage,
} from "../creative/release-package";

export const CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY = AUTHORITATIVE_CONTEXT_KEY;
export const CREATIVE_RELEASE_PACKAGE_ID_PREFIX = "crp";

export type CreativeReleaseReadResult =
  | { status: "released"; package: CreativeReleasePackage }
  | { status: "not_released"; reason: string };

/**
 * Reads and validates the sealed creative release package for a campaign.
 * Pure and side-effect free; never throws on malformed input — a sealed record
 * that fails any invariant reads as `not_released` (contract §3 fail-closed).
 *
 * Validation order: presence → tenant binding → deterministic identity
 * re-derivation → Stream B content-fingerprint tamper check
 * (`assertCreativeReleasePackageIntact`, which re-derives the fingerprint over
 * the full sealed content including strategy coordinates and artefact refs).
 */
export function readCreativeReleasePackageForDistribution(input: {
  campaignId: number;
  userId: number;
  workflowContext: unknown;
}): CreativeReleaseReadResult {
  const sealed = readSealedCreativeReleasePackage({
    workflowContext: input.workflowContext,
  });
  if (!sealed) {
    return { status: "not_released", reason: "no_sealed_package" };
  }

  // Tenant binding: the sealed package must belong to the consuming campaign
  // and user (contract §10). A cross-tenant package is tampering evidence.
  if (sealed.campaignId !== input.campaignId || sealed.userId !== input.userId) {
    return { status: "not_released", reason: "package_tenant_mismatch" };
  }

  let expectedPackageId: string;
  try {
    expectedPackageId = deriveCreativeReleasePackageIdentity(
      input.campaignId,
      sealed.creativeBriefFingerprint
    );
  } catch {
    return { status: "not_released", reason: "malformed_package" };
  }
  if (sealed.packageId !== expectedPackageId) {
    return { status: "not_released", reason: "package_identity_mismatch" };
  }

  // Sole tamper authority (Stream B): re-derives the content fingerprint over
  // schema version, identity, strategy coordinates, artefact refs, legacy /
  // superseded id sets and quality evidence. Any post-seal mutation throws.
  try {
    assertCreativeReleasePackageIntact(sealed);
  } catch {
    return { status: "not_released", reason: "package_tampered" };
  }

  return { status: "released", package: sealed };
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
