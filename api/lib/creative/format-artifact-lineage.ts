import { TRPCError } from "@trpc/server";

import type { CampaignMessagePack } from "./campaign-message-architect";
import { assertApprovedCopyMatchesEnvelope } from "./approved-copy-authority";
import {
  buildPersistedCreativeArtifactLineage,
  creativeArtifactApprovedCopyLineageFromEnvelope,
  creativeArtifactStrategyLineageFromAuthority,
  type CreativeArtifactApprovedCopyLineageInput,
  type CreativeArtifactKind,
  type CreativeArtifactPersistedLineage,
  type CreativeArtifactStrategyLineageInput,
} from "./artifact-lineage";
import { normalizeCtaText } from "./cta-utils";
import type { CreativeStrategyAuthority } from "./strategy-authority";

// ─── WBS12.5/WBS12.6 semantic format governance ───
//
// One reusable governance contract for the video/script and non-social
// semantic Creative formats produced from an envelope-governed approved
// Campaign Message Pack:
//
//   Business DNA snapshot
//     → Strategy snapshot
//     → approved semantic copy (V2 approval envelope)
//     → governed derivative format (video script, email copy, WhatsApp/direct
//       message copy, advertising copy/ad variant, carousel ad, launch pack)
//
// This module does not create a second authority model. It reuses the
// accepted artifact-lineage contract (WBS12.3) and approved-copy authority
// (WBS12C): the approved message pack remains the sole semantic authority,
// channel formatting and tone adaptation stay free, and CTA divergence fails
// closed before persistence. Envelope-less legacy packs return null so
// callers keep legacy behaviour and never fabricate lineage.

/**
 * The WBS12.5/WBS12.6 semantic format artifact kinds governed through this
 * helper. Each corresponds to an already-persisted product format produced by
 * the Creative Agent.
 */
export type GovernedSemanticFormatKind = Extract<
  CreativeArtifactKind,
  | "video_script"
  | "email_copy"
  | "whatsapp_copy"
  | "ad_copy"
  | "carousel_ad"
  | "launch_pack"
>;

/** Lineage authority coordinates shared by every governed format artifact. */
export interface GovernedFormatLineageCoordinates {
  readonly strategy: CreativeArtifactStrategyLineageInput;
  readonly approvedCopy: CreativeArtifactApprovedCopyLineageInput;
}

/**
 * Resolve the shared lineage coordinates for formats derived from an
 * envelope-governed approved message pack. Proves the pack still hashes to
 * its V2 approval envelope (fail closed on tampering) and returns null for
 * envelope-less legacy packs so callers keep legacy behaviour.
 */
export function resolveGovernedFormatLineageCoordinates(
  pack: CampaignMessagePack | null | undefined,
  strategyAuthority: CreativeStrategyAuthority
): GovernedFormatLineageCoordinates | null {
  const envelope = pack?.v2ApprovalEnvelope ?? null;
  if (!pack || !envelope) return null;

  assertApprovedCopyMatchesEnvelope(pack);

  return {
    strategy: creativeArtifactStrategyLineageFromAuthority(strategyAuthority),
    approvedCopy: creativeArtifactApprovedCopyLineageFromEnvelope(envelope),
  };
}

/**
 * Build the persisted lineage record for one governed WBS12.5/WBS12.6
 * artifact. The parent is always the approved message pack; only normalized
 * digests/ids are persisted, never raw copy text.
 */
export function buildGovernedFormatArtifactLineage(
  artifactKind: GovernedSemanticFormatKind,
  platform: string | null,
  coordinates: GovernedFormatLineageCoordinates
): CreativeArtifactPersistedLineage {
  return buildPersistedCreativeArtifactLineage({
    artifactKind,
    platform,
    parent: { artifactKind: "message_pack" },
    strategy: coordinates.strategy,
    approvedCopy: coordinates.approvedCopy,
  });
}

/**
 * Fail-closed CTA binding for one governed WBS12.5/WBS12.6 artifact. The
 * approved message pack CTA is the single CTA authority: channel scripts may
 * adapt formatting and tone, but a CTA rewrite, replacement, or empty-CTA
 * drop fails closed before persistence instead of minting new authority.
 */
export function assertFormatCtaBoundToApprovedCopy(input: {
  readonly artifactKind: GovernedSemanticFormatKind;
  readonly label: string;
  readonly artifactCta: string | null | undefined;
  readonly approvedCta: string;
}): void {
  if (
    normalizeCtaText(input.artifactCta) !== normalizeCtaText(input.approvedCta)
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        `${input.label} rewrites the approved CTA ` +
        `("${input.artifactCta ?? ""}" vs approved "${input.approvedCta}"). ` +
        "Regenerate the pack or re-approve the Campaign Message Pack before distribution.",
    });
  }
}
