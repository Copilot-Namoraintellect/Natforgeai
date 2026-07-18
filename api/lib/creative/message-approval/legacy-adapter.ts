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
  readonly evidenceHashSha256?: string;
  readonly campaignStrategySnapshotId: string;
  readonly strategyHashSha256?: string;
  readonly qualityPolicyId: string;
  readonly qualityPolicyVersion: number;
  readonly policyHashSha256?: string;
  readonly legacyPack: CampaignMessagePack;
  readonly preferredSource?: CandidateSource;
}

function mapSource(source: MessagePackSource | undefined): CandidateSource {
  switch (source) {
    case "latest_message_pack":
      return "existing_approved";
    case "ai_refined_pack":
      return "ai_refined";
    case "fallback_deterministic":
      return "deterministic_fallback";
    case "user_structured_copy":
    case "fallback_user_pack":
      return "user_structured";
    default:
      return "existing_approved";
  }
}

const CANONICAL_PLATFORM_ORDER = [
  "instagram",
  "facebook",
  "tiktok",
  "linkedin",
  "x",
  "twitter",
  "youtube",
  "whatsapp",
] as const;

function normalizeId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function toOrderedPlatformCaptions(value: unknown): Array<{
  platform: string;
  caption: string;
  cta: string;
  hashtagsOrdered: string[];
}> {
  if (Array.isArray(value)) {
    return value.map((item: any) => ({
      platform: String(item?.platform ?? ""),
      caption: String(item?.caption ?? ""),
      cta: String(item?.cta ?? ""),
      hashtagsOrdered: Array.isArray(item?.hashtags) ? item.hashtags.map((tag: any) => String(tag)) : [],
    }));
  }

  if (!value || typeof value !== "object") return [];

  const entries = Object.entries(value as Record<string, any>).map(([platform, payload]) => ({
    platform,
    caption: String(payload?.caption ?? ""),
    cta: String(payload?.cta ?? ""),
    hashtagsOrdered: Array.isArray(payload?.hashtags) ? payload.hashtags.map((tag: any) => String(tag)) : [],
  }));

  entries.sort((a, b) => {
    const aNorm = normalizeId(a.platform);
    const bNorm = normalizeId(b.platform);
    const aKnown = CANONICAL_PLATFORM_ORDER.indexOf(aNorm as (typeof CANONICAL_PLATFORM_ORDER)[number]);
    const bKnown = CANONICAL_PLATFORM_ORDER.indexOf(bNorm as (typeof CANONICAL_PLATFORM_ORDER)[number]);
    if (aKnown !== -1 || bKnown !== -1) {
      if (aKnown === -1) return 1;
      if (bKnown === -1) return -1;
      if (aKnown !== bKnown) return aKnown - bKnown;
    }
    return aNorm.localeCompare(bNorm);
  });

  return entries;
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
  const source = input.preferredSource || mapSource(input.legacyPack.messagePackSource);
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
      proofPointsOrdered: Array.isArray(input.legacyPack.proofPoints)
        ? input.legacyPack.proofPoints.map((item) => String(item))
        : [],
      platformCaptionsOrdered: toOrderedPlatformCaptions(input.legacyPack.platformCaptions),
      footer: {
        phone: input.legacyPack.footerContact?.phone ?? null,
        whatsapp: input.legacyPack.footerContact?.whatsapp ?? null,
        email: input.legacyPack.footerContact?.email ?? null,
        website: input.legacyPack.footerContact?.website ?? null,
        location: input.legacyPack.footerContact?.location ?? null,
      },
    },
    businessDnaSnapshotId: input.businessDnaSnapshotId,
    evidenceHashSha256: input.evidenceHashSha256 || "",
    campaignStrategySnapshotId: input.campaignStrategySnapshotId,
    strategyHashSha256: input.strategyHashSha256 || "",
    qualityPolicyId: input.qualityPolicyId,
    qualityPolicyVersion: input.qualityPolicyVersion,
    policyHashSha256: input.policyHashSha256 || "",
    provenance,
  });
}
