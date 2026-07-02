/**
 * Pure, testable decision logic for Content Studio.
 * Kept separate from the React component so it can be unit-tested without
 * loading JSX or tRPC hooks.
 */

export interface ApprovedMessagePackLike {
  headline?: string;
  subheadline?: string;
  cta?: string;
  benefitBullets?: string[];
  footerContact?: { location?: string };
  messagePackSource?: string;
  isGeneric?: boolean;
  specificityScore?: number;
  validation?: { passed?: boolean; score?: number };
  supersededBy?: number;
}

const MESSAGE_PACK_SOURCE_RANK: Record<string, number> = {
  user_structured_copy: 1,
  fallback_user_pack: 2,
  manual_restore: 3,
  ai_refined_pack: 4,
  fallback_deterministic: 5,
  latest_message_pack: 6,
  stale_metadata: 7,
};

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function getContentMeta(c: unknown): Record<string, unknown> {
  return ((c as Record<string, unknown>)?.metadata as Record<string, unknown>) || {};
}

export function getLatestReadyImageAsset(
  assets: unknown[] | undefined,
  opts?: { contentPostId?: number }
): Record<string, unknown> | undefined {
  if (!assets?.length) return undefined;
  const candidates = (assets || []).filter((a) => {
    const asset = a as Record<string, unknown>;
    const meta = getContentMeta(asset);
    const url =
      (typeof asset?.url === "string" && asset.url) ||
      (typeof meta?.url === "string" && meta.url) ||
      (typeof meta?.imageUrl === "string" && meta.imageUrl);
    if (!url) return false;

    const isImageLike =
      asset?.assetType === "image" ||
      meta?.assetType === "image" ||
      meta?.assetType === "leaflet" ||
      meta?.assetKind === "master_campaign_post" ||
      typeof asset?.provider === "string";

    const isReady = asset?.status === "ready" || asset?.status === "completed";
    if (!isImageLike || !isReady) return false;

    if (opts?.contentPostId == null) return true;
    return (
      asNumber(asset.contentPostId) === opts.contentPostId ||
      asNumber(meta.contentPostId) === opts.contentPostId
    );
  });
  if (!candidates.length) return undefined;
  candidates.sort(
    (a, b) =>
      new Date(((b as Record<string, unknown>).createdAt as string) || 0).getTime() -
      new Date(((a as Record<string, unknown>).createdAt as string) || 0).getTime()
  );
  return candidates[0] as Record<string, unknown>;
}

export function getCampaignImageAssetUrl(
  assets: unknown[] | undefined,
  opts?: { contentPostId?: number }
): string | undefined {
  const asset = getLatestReadyImageAsset(assets, opts);
  if (!asset) return undefined;
  const meta = getContentMeta(asset);
  return (
    (typeof asset.url === "string" && asset.url) ||
    (typeof meta.url === "string" && meta.url) ||
    (typeof meta.imageUrl === "string" && meta.imageUrl) ||
    undefined
  );
}

export function getImageUrl(c: unknown, assets?: unknown[]): string | undefined {
  if (!c) return undefined;
  const item = c as Record<string, unknown>;
  const meta = getContentMeta(item);
  return (
    (typeof meta.imageUrl === "string" && meta.imageUrl) ||
    (typeof item.imageUrl === "string" && item.imageUrl) ||
    (typeof meta.url === "string" && meta.url) ||
    (typeof item.url === "string" && item.url) ||
    getCampaignImageAssetUrl(assets)
  );
}

export function isCaptionPackAsset(a: unknown): boolean {
  const asset = a as Record<string, unknown>;
  return asset?.assetType === "caption_pack" || getContentMeta(asset).assetType === "caption_pack";
}

export function isLeafletCandidate(c: unknown): boolean {
  if (!c) return false;
  const item = c as Record<string, unknown>;
  const meta = getContentMeta(item);
  if (isCaptionPackAsset(c)) return false;
  if (meta?.assetType === "leaflet" || meta?.assetKind === "master_campaign_post") return true;
  if (meta?.imageProvider === "openai-leaflet" || meta?.imageSource === "openai") return true;
  // A generated social post is a valid leaflet candidate even before its hero image is rendered.
  if (item?.type === "social_post" && item?.aiGenerated) return true;
  if (typeof meta?.imageUrl === "string" || typeof item?.imageUrl === "string") return true;
  return false;
}

export function findLeafletCandidate(items: unknown[], assets?: unknown[]): unknown | undefined {
  if (!items?.length) return undefined;
  // Prefer explicit leaflet markers, then OpenAI sources, then any generated social post / imageUrl-bearing non-caption record.
  const candidates = items.filter(isLeafletCandidate);
  return (
    candidates.find((c) => {
      const meta = getContentMeta(c);
      return meta?.assetType === "leaflet" || meta?.assetKind === "master_campaign_post";
    }) ||
    candidates.find((c) => {
      const meta = getContentMeta(c);
      return meta?.imageProvider === "openai-leaflet" || meta?.imageSource === "openai";
    }) ||
    candidates.find((c) => {
      const item = c as Record<string, unknown>;
      return item?.type === "social_post" && item?.aiGenerated;
    }) ||
    candidates.find((c) => getImageUrl(c, assets)) ||
    candidates[0]
  );
}

export function campaignHasGeneratedContent(params: {
  postCount: number | undefined;
  contents: unknown[] | undefined;
  assets: unknown[] | undefined;
}): boolean {
  const { postCount, contents, assets } = params;
  return (postCount ?? 0) > 0 || (contents?.length ?? 0) > 0 || (assets?.length ?? 0) > 0;
}

export function campaignNeedsRecoveryDecision(
  campaign: unknown,
  postCount: number | undefined,
  contents: unknown[] | undefined,
  creativeAgentRuns: unknown[] | undefined,
  strategyAgentRuns: unknown[] | undefined
): boolean {
  if (!campaign) return false;
  const campaignRecord = campaign as Record<string, unknown>;

  const postCountValue = postCount ?? 0;
  const contentsCount = contents?.length ?? 0;
  const hasPosts = postCountValue > 0 || contentsCount > 0;

  const latestCreativeRun = creativeAgentRuns?.[0] as Record<string, unknown> | undefined;
  const latestStrategyRun = strategyAgentRuns?.[0] as Record<string, unknown> | undefined;
  const latestCreativeFailed = latestCreativeRun?.status === "failed";
  const latestStrategyFailed = latestStrategyRun?.status === "failed";

  const workflowState = typeof campaignRecord.workflowState === "string" ? campaignRecord.workflowState : "";
  const inCreativeState = ["creatives_generating", "creatives_ready"].includes(workflowState);

  if (inCreativeState && !hasPosts) return true;
  if (!hasPosts && (latestCreativeFailed || latestStrategyFailed)) return true;
  if (latestStrategyFailed && workflowState === "strategy_generated") return true;

  return false;
}

export function isSupersededMessagePack(asset: unknown): boolean {
  const meta = getContentMeta(asset);
  const pack = (meta.approvedMessagePack || meta) as ApprovedMessagePackLike | undefined;
  return !!meta.supersededBy || !!pack?.supersededBy;
}

export function selectBestApprovedMessagePack(
  assets: unknown[] | undefined
): ApprovedMessagePackLike | undefined {
  if (!assets?.length) return undefined;

  const rows = (assets as unknown[])
    .map((a) => {
      const asset = a as Record<string, unknown>;
      if (asset.assetType !== "message_pack") return null;
      if (isSupersededMessagePack(asset)) return null;
      const meta = getContentMeta(asset);
      const pack = (meta.approvedMessagePack || meta) as ApprovedMessagePackLike | undefined;
      if (!pack) return null;
      return {
        pack,
        createdAt: new Date((asset.createdAt as string) || 0),
      };
    })
    .filter(Boolean) as { pack: ApprovedMessagePackLike; createdAt: Date }[];

  if (!rows.length) return undefined;

  const scored = rows.map((r) => {
    const pack = r.pack;
    const isGeneric = pack.isGeneric ?? false;
    const sourceRank = MESSAGE_PACK_SOURCE_RANK[pack.messagePackSource || "ai_refined_pack"] ?? 99;
    const passed = pack.validation?.passed ? 0 : 1;
    const specificity = pack.specificityScore ?? 0;
    const score = pack.validation?.score ?? 0;
    return { ...r, isGeneric, sourceRank, passed, specificity, score };
  });

  scored.sort((a, b) => {
    if (a.isGeneric !== b.isGeneric) return a.isGeneric ? 1 : -1;
    if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
    if (a.passed !== b.passed) return a.passed - b.passed;
    if (a.specificity !== b.specificity) return b.specificity - a.specificity;
    if (a.score !== b.score) return b.score - a.score;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  return scored[0]?.pack;
}

export function getApprovedMessagePackForDetails(
  assets: unknown[] | undefined,
  opts?: { contentPostId?: number }
): ApprovedMessagePackLike | undefined {
  const latestReady = getLatestReadyImageAsset(assets, opts);
  const latestMeta = getContentMeta(latestReady);
  const fromImage = latestMeta?.approvedMessagePack as ApprovedMessagePackLike | undefined;
  if (fromImage) return fromImage;
  return selectBestApprovedMessagePack(assets);
}

export function getActiveGenerationRunId(
  assets: unknown[] | undefined,
  opts?: { contentPostId?: number }
): string | null {
  const latestReady = getLatestReadyImageAsset(assets, opts);
  return asString(getContentMeta(latestReady).generationRunId) || null;
}
