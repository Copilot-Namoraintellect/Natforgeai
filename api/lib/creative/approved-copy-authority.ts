import { TRPCError } from "@trpc/server";

import type { CampaignMessagePack } from "./campaign-message-architect";
import type {
  CandidateSource,
  V2ApprovalEnvelope,
} from "./message-approval/contracts";
import {
  computeSha256FromPayload,
  serializeCanonicalCopy,
} from "./message-approval/hash";
import type { CreativeStrategyAuthority } from "./strategy-authority";

/**
 * Exact immutable approved-copy authority captured from a canary-approved
 * Campaign Message Pack via its V2 approval envelope.
 *
 * WBS12C: once a message pack is approved under the V2 message-approval
 * contract, its semantic copy (headline, subheadline, benefit bullets,
 * CTA, proof points, footer, platform captions) is immutable authority.
 * Downstream render/adaptation paths must not silently rewrite it; any
 * mismatch fails closed here instead of rendering divergent copy.
 *
 * This module is deliberately pure: it only re-derives deterministic hashes
 * from data it is handed and never touches the database.
 */
export interface ApprovedCopyAuthority {
  readonly approvedRevisionId: string;
  readonly copyHashSha256: string;
  readonly copySchemaVersion: string;
  readonly businessDnaSnapshotId: string;
  readonly evidenceHashSha256: string;
  readonly campaignStrategySnapshotId: string;
  readonly strategyHashSha256: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly policyHashSha256: string;
  readonly assessmentHashSha256: string;
  readonly approvedAtIso: string;
  readonly candidateSource: CandidateSource;
}

function failClosed(reason: string): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      `Approved Creative copy authority failed (${reason}). ` +
      "Regenerate and re-approve the Campaign Message Pack before rendering.",
  });
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    failClosed(field);
  }

  return value;
}

function requireSha256(value: unknown, field: string): string {
  const normalised = requireNonEmpty(value, field).toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(normalised)) {
    failClosed(field);
  }

  return normalised;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    failClosed(field);
  }

  return value;
}

/**
 * Deterministic approved-copy hash for a stored Campaign Message Pack.
 *
 * The projection intentionally mirrors the compatibility projection used by
 * verifyCanaryApprovalProof so the result equals the envelope's
 * copyHashSha256 for any pack whose copy is still exactly the approved copy.
 */
export function computeCampaignMessagePackCopyHash(
  pack: CampaignMessagePack
): string {
  const copySchemaVersion =
    pack.v2ApprovalEnvelope?.copySchemaVersion ?? "";

  return computeSha256FromPayload(
    serializeCanonicalCopy({
      copySchemaVersion,
      headline: pack.headline ?? "",
      subheadline: pack.subheadline ?? "",
      benefitBulletsOrdered: [...(pack.benefitBullets ?? [])],
      cta: pack.cta ?? "",
      footer: {
        phone: pack.footerContact?.phone ?? null,
        whatsapp: pack.footerContact?.whatsapp ?? null,
        email: pack.footerContact?.email ?? null,
        website: pack.footerContact?.website ?? null,
        location: pack.footerContact?.location ?? null,
      },
      proofPointsOrdered: Array.isArray(pack.proofPoints)
        ? [...pack.proofPoints]
        : [],
      platformCaptionsOrdered: Array.isArray(pack.platformCaptions)
        ? pack.platformCaptions.map((caption) => ({
            platform: caption.platform,
            caption: caption.caption,
            cta: caption.cta,
            hashtagsOrdered: Array.isArray(caption.hashtags)
              ? [...caption.hashtags]
              : [],
          }))
        : [],
    })
  );
}

/**
 * Capture immutable approved-copy authority from a pack that carries a
 * complete V2 approval envelope. Fails closed when the envelope is missing
 * or malformed.
 */
export function captureApprovedCopyAuthority(
  pack: CampaignMessagePack
): ApprovedCopyAuthority {
  const envelope: V2ApprovalEnvelope | undefined =
    pack?.v2ApprovalEnvelope;

  if (!envelope) {
    failClosed("v2ApprovalEnvelope");
  }

  return Object.freeze({
    approvedRevisionId: requireNonEmpty(
      envelope.approvedRevisionId,
      "approvedRevisionId"
    ),
    copyHashSha256: requireSha256(
      envelope.copyHashSha256,
      "copyHashSha256"
    ),
    copySchemaVersion: requireNonEmpty(
      envelope.copySchemaVersion,
      "copySchemaVersion"
    ),
    businessDnaSnapshotId: requireNonEmpty(
      envelope.businessDnaSnapshotId,
      "businessDnaSnapshotId"
    ),
    evidenceHashSha256: requireSha256(
      envelope.evidenceHashSha256,
      "evidenceHashSha256"
    ),
    campaignStrategySnapshotId: requireNonEmpty(
      envelope.campaignStrategySnapshotId,
      "campaignStrategySnapshotId"
    ),
    strategyHashSha256: requireSha256(
      envelope.strategyHashSha256,
      "strategyHashSha256"
    ),
    policyId: requireNonEmpty(envelope.policyId, "policyId"),
    policyVersion: requirePositiveInteger(
      envelope.policyVersion,
      "policyVersion"
    ),
    policyHashSha256: requireSha256(
      envelope.policyHashSha256,
      "policyHashSha256"
    ),
    assessmentHashSha256: requireSha256(
      envelope.assessmentHashSha256,
      "assessmentHashSha256"
    ),
    approvedAtIso: requireNonEmpty(
      envelope.approvedAtIso,
      "approvedAtIso"
    ),
    candidateSource: requireNonEmpty(
      envelope.candidateSource,
      "candidateSource"
    ) as CandidateSource,
  });
}

/**
 * Recompute the pack's approved-copy hash and every authority coordinate.
 * Fails closed on any mismatch — a pack that no longer hashes to its
 * approved copy, or whose envelope coordinates disagree, must never render.
 */
export function verifyApprovedCopyIntegrity(
  pack: CampaignMessagePack,
  authority: ApprovedCopyAuthority
): void {
  if (!pack) {
    failClosed("pack");
  }

  const envelope = pack.v2ApprovalEnvelope;

  if (!envelope) {
    failClosed("v2ApprovalEnvelope");
  }

  const recomputedHash = computeCampaignMessagePackCopyHash(pack);
  if (recomputedHash !== authority.copyHashSha256) {
    failClosed("copyHashSha256");
  }

  if (
    envelope.approvedRevisionId !== authority.approvedRevisionId ||
    envelope.copyHashSha256 !== authority.copyHashSha256 ||
    envelope.copySchemaVersion !== authority.copySchemaVersion ||
    envelope.businessDnaSnapshotId !== authority.businessDnaSnapshotId ||
    envelope.evidenceHashSha256 !== authority.evidenceHashSha256 ||
    envelope.campaignStrategySnapshotId !==
      authority.campaignStrategySnapshotId ||
    envelope.strategyHashSha256 !== authority.strategyHashSha256 ||
    envelope.policyId !== authority.policyId ||
    envelope.policyVersion !== authority.policyVersion ||
    envelope.policyHashSha256 !== authority.policyHashSha256 ||
    envelope.assessmentHashSha256 !== authority.assessmentHashSha256 ||
    envelope.approvedAtIso !== authority.approvedAtIso ||
    envelope.candidateSource !== authority.candidateSource
  ) {
    failClosed("envelope coordinates");
  }
}

/**
 * Capture the pack's approved-copy authority and immediately verify the pack
 * still hashes to it. Convenience for guard points (persistence and render)
 * that need a single fail-closed call. Returns the verified authority so
 * callers can bind it to Strategy authority.
 */
export function assertApprovedCopyMatchesEnvelope(
  pack: CampaignMessagePack
): ApprovedCopyAuthority {
  const authority = captureApprovedCopyAuthority(pack);
  verifyApprovedCopyIntegrity(pack, authority);
  return authority;
}

/**
 * Bind approved-copy authority to the immutable Strategy authority captured
 * for the same job. The approved copy is only legitimate when it was
 * evaluated against the exact approved Strategy snapshot.
 */
export function assertApprovedCopyMatchesStrategyAuthority(
  copyAuthority: ApprovedCopyAuthority,
  strategyAuthority: CreativeStrategyAuthority
): void {
  if (!copyAuthority || !strategyAuthority) {
    failClosed("authority pair");
  }

  if (
    copyAuthority.campaignStrategySnapshotId !==
      strategyAuthority.strategySnapshotId ||
    copyAuthority.strategyHashSha256 !==
      strategyAuthority.strategyHashSha256 ||
    copyAuthority.businessDnaSnapshotId !==
      strategyAuthority.businessDnaSnapshotId
  ) {
    failClosed("strategy binding");
  }
}

/**
 * Semantic render copy taken from the render path after the approved pack
 * has been locked in. Only fields the approved pack actually supplies are
 * enforced; fallbacks for empty approved fields remain legitimate.
 */
export interface ApprovedRenderCopy {
  readonly headline: string;
  readonly subheadline: string;
  readonly cta: string;
  readonly services: readonly string[];
}

/**
 * Fail-closed guard for downstream render/adaptation: once approved-copy
 * authority exists, the semantic copy about to be rendered must be exactly
 * the approved copy. Per-platform captions/hashtags and other derived
 * formatting remain free to adapt, but headline/subheadline/body/CTA may
 * not be rewritten after approval.
 */
export function assertApprovedRenderCopyUnchanged(input: {
  readonly renderCopy: ApprovedRenderCopy;
  readonly pack: CampaignMessagePack;
  readonly authority: ApprovedCopyAuthority;
}): void {
  verifyApprovedCopyIntegrity(input.pack, input.authority);

  const { renderCopy, pack } = input;

  if (pack.headline && renderCopy.headline !== pack.headline) {
    failClosed("headline changed after approval");
  }

  if (pack.subheadline && renderCopy.subheadline !== pack.subheadline) {
    failClosed("subheadline changed after approval");
  }

  if (pack.cta && renderCopy.cta !== pack.cta) {
    failClosed("cta changed after approval");
  }

  if (
    Array.isArray(pack.benefitBullets) &&
    pack.benefitBullets.length > 0
  ) {
    const approved = pack.benefitBullets;
    const rendered = renderCopy.services ?? [];
    const unchanged =
      rendered.length === approved.length &&
      approved.every((bullet, index) => rendered[index] === bullet);

    if (!unchanged) {
      failClosed("benefit bullets changed after approval");
    }
  }
}
