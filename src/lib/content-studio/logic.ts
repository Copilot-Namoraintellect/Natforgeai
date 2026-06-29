/**
 * Pure, testable decision logic for Content Studio.
 * Kept separate from the React component so it can be unit-tested without
 * loading JSX or tRPC hooks.
 */

export function getContentMeta(c: unknown): Record<string, unknown> {
  return ((c as Record<string, unknown>)?.metadata as Record<string, unknown>) || {};
}

export function getCampaignImageAssetUrl(assets: unknown[] | undefined): string | undefined {
  if (!assets?.length) return undefined;
  const image = assets.find((a) => {
    const asset = a as Record<string, unknown>;
    const meta = getContentMeta(asset);
    const url =
      (typeof asset?.url === "string" && asset.url) ||
      (typeof meta?.url === "string" && meta.url) ||
      (typeof meta?.imageUrl === "string" && meta.imageUrl);
    return asset?.assetType === "image" && asset?.status === "ready" && url;
  });
  if (!image) return undefined;
  const asset = image as Record<string, unknown>;
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
