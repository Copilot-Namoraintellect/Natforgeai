import type { CampaignMessagePack, MessagePackSource } from "../campaign-message-architect";
import type {
  CandidateSource,
  MessagePackCandidate,
  MessagePackCandidateProvenance,
} from "./contracts";
import { createMessagePackCandidate } from "./candidate";

export interface AdaptLegacyPackInput {
  readonly campaignId: number;
  readonly candidateId: string;
  readonly createdAtIso: string;
  readonly businessDnaSnapshotId: string;
  readonly campaignStrategySnapshotId: string;
  readonly qualityPolicyId: string;
  readonly qualityPolicyVersion: number;
  readonly legacyPack: CampaignMessagePack;
}

function mapSource(source: MessagePackSource | undefined): CandidateSource {
  switch (source) {
    case "ai_refined_pack":
      return "ai_refined";
    case "fallback_deterministic":
      return "deterministic_fallback";
    case "user_structured_copy":
    case "fallback_user_pack":
      return "user_structured";
    case "manual_restore":
      return "manual_restore";
    case "latest_message_pack":
      return "existing_approved";
    default:
      return "existing_approved";
  }
}

function diagnostics(pack: CampaignMessagePack): MessagePackCandidateProvenance["diagnostics"] {
  return {
    legacyIsGeneric: typeof pack.isGeneric === "boolean" ? pack.isGeneric : null,
    legacyValidationPassed: typeof pack.validation?.passed === "boolean" ? pack.validation.passed : null,
    legacyValidationScore:
      typeof pack.validation?.score === "number" ? pack.validation.score : null,
    legacyValidationRejections: Array.isArray(pack.validation?.rejections)
      ? [...pack.validation.rejections]
      : [],
  };
}

export function adaptLegacyMessagePack(input: AdaptLegacyPackInput): MessagePackCandidate {
  const source = mapSource(input.legacyPack.messagePackSource);
  const provenance: MessagePackCandidateProvenance = {
    adaptedFromLegacy: true,
    originSource: input.legacyPack.messagePackSource ?? "unknown",
    modelName: null,
    diagnostics: diagnostics(input.legacyPack),
  };

  return createMessagePackCandidate({
    candidateId: input.candidateId,
    campaignId: input.campaignId,
    createdAtIso: input.createdAtIso,
    source,
    copy: {
      copySchemaVersion: "v2.1",
      headline: input.legacyPack.headline,
      subheadline: input.legacyPack.subheadline,
      benefitBulletsOrdered: input.legacyPack.benefitBullets,
      cta: input.legacyPack.cta,
      footer: {
        phone: input.legacyPack.footerContact?.phone ?? null,
        whatsapp: input.legacyPack.footerContact?.whatsapp ?? null,
        email: input.legacyPack.footerContact?.email ?? null,
        website: input.legacyPack.footerContact?.website ?? null,
        location: input.legacyPack.footerContact?.location ?? null,
      },
    },
    businessDnaSnapshotId: input.businessDnaSnapshotId,
    campaignStrategySnapshotId: input.campaignStrategySnapshotId,
    qualityPolicyId: input.qualityPolicyId,
    qualityPolicyVersion: input.qualityPolicyVersion,
    provenance,
  });
}
