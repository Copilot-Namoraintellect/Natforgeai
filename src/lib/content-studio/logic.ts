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

// ─── Leaflet action buttons ───

export type LeafletPrimaryAction = "generate" | "improve";
export type LeafletAdvancedAction =
  | "basicDraft"
  | "internalTemplate"
  | "regenerateAi"
  | "applyLayoutChanges"
  | "viewHistory";
export type LeafletFailureAction = "tryAgain" | "safeTemplate" | "contactSupport";

export interface LeafletActions {
  primary: { action: LeafletPrimaryAction; disabled: boolean };
  secondary?: { action: "download"; disabled: boolean };
  advanced: LeafletAdvancedAction[];
  failure: LeafletFailureAction[];
}

export function getLeafletActions(opts: {
  imageUrl?: string | null;
  isFailed?: boolean;
  hasLogo?: boolean;
  allowNoLogo?: boolean;
  openAiConfigured?: boolean;
  hasRefinementInstruction?: boolean;
  isGenerating?: boolean;
}): LeafletActions {
  const {
    imageUrl,
    isFailed = false,
    hasLogo = true,
    allowNoLogo = false,
    openAiConfigured = false,
    hasRefinementInstruction = false,
    isGenerating = false,
  } = opts;

  const logoBlocked = !hasLogo && !allowNoLogo;
  const primaryDisabled = isGenerating || logoBlocked;

  // Failure state takes precedence.
  if (isFailed) {
    return {
      primary: { action: "improve", disabled: primaryDisabled },
      advanced: [],
      failure: ["tryAgain", "safeTemplate", "contactSupport"],
    };
  }

  const isReady = !!imageUrl;

  const advanced: LeafletAdvancedAction[] = [
    "basicDraft",
    "internalTemplate",
    ...(openAiConfigured ? (["regenerateAi"] as const) : []),
    ...(hasRefinementInstruction ? (["applyLayoutChanges"] as const) : []),
    "viewHistory",
  ];

  if (!isReady) {
    return {
      primary: { action: "generate", disabled: primaryDisabled },
      advanced,
      failure: [],
    };
  }

  return {
    primary: { action: "improve", disabled: primaryDisabled },
    secondary: { action: "download", disabled: false },
    advanced,
    failure: [],
  };
}

export type PlatformPublishStatus = "connected" | "not_connected" | "manual" | "not_supported";

export interface ConnectedIntegrationLike {
  platform: string;
  status: string;
  ready?: boolean;
  businessId?: number | null;
  instagramBusinessAccountId?: string | null;
  permissions?: unknown[];
  pageAccessTokenEncrypted?: string | null;
}

export interface PlatformConfigStatusLike {
  metaConfigured?: boolean;
  linkedinConfigured?: boolean;
}

function integrationMatchesBusiness(
  integration: ConnectedIntegrationLike,
  campaignBusinessId?: number | null
): boolean {
  if (campaignBusinessId == null) return true;
  if (integration.businessId == null) return true;
  return integration.businessId === campaignBusinessId;
}

export function isPlatformConnected(
  platform: string | null | undefined,
  integrations: ConnectedIntegrationLike[],
  campaignBusinessId?: number | null
): boolean {
  if (!platform) return false;
  const normalized = platform.toLowerCase().trim();
  const connectable = ["facebook", "instagram", "linkedin", "tiktok", "twitter", "whatsapp"];
  if (!connectable.includes(normalized)) return true;
  return integrations.some(
    (i) =>
      i.platform.toLowerCase() === normalized &&
      i.status === "connected" &&
      i.ready &&
      integrationMatchesBusiness(i, campaignBusinessId)
  );
}

export function getInstagramReadinessError(
  platform: string | null | undefined,
  integrations: ConnectedIntegrationLike[]
): string | null {
  if (platform?.toLowerCase().trim() !== "instagram") return null;
  const integration = integrations.find((i) => i.platform.toLowerCase() === "instagram");
  if (!integration || integration.status !== "connected") return null;
  if (!integration.instagramBusinessAccountId) {
    return "No Instagram professional account is linked to the connected Facebook Page.";
  }
  const perms = Array.isArray(integration.permissions) ? integration.permissions : [];
  const hasPublishingPermission =
    perms.includes("instagram_content_publishing") || perms.includes("instagram_content_publish");
  if (!hasPublishingPermission) {
    return "Instagram content publishing permission is missing. Reconnect Meta to grant it.";
  }
  if (!integration.pageAccessTokenEncrypted) {
    return "Instagram page token is missing. Reconnect Meta to refresh it.";
  }
  return null;
}

export function isPlatformConfigurable(
  platform: string | null | undefined,
  config: PlatformConfigStatusLike | undefined
): boolean {
  if (!platform) return true;
  if (!config) return true;
  const normalized = platform.toLowerCase().trim();
  const connectable = ["facebook", "instagram", "linkedin", "tiktok", "twitter", "whatsapp"];
  if (!connectable.includes(normalized)) return true;
  if (normalized === "facebook" || normalized === "instagram") {
    return config?.metaConfigured === true;
  }
  if (normalized === "linkedin") {
    return config?.linkedinConfigured === true;
  }
  return true;
}

export function getPlatformPublishStatus(
  platform: string,
  integrations: ConnectedIntegrationLike[],
  config: PlatformConfigStatusLike | undefined,
  campaignBusinessId?: number | null
): PlatformPublishStatus {
  const normalized = platform.toLowerCase().trim();

  if (normalized === "google ads" || normalized === "google_ads") {
    return "not_supported";
  }

  const autoPublishPlatforms = ["facebook", "instagram", "linkedin"];
  const isAutoPublishPlatform = autoPublishPlatforms.includes(normalized);
  const connected = isPlatformConnected(normalized, integrations, campaignBusinessId);
  const configurable = isPlatformConfigurable(normalized, config);

  if (isAutoPublishPlatform) {
    if (connected && configurable) return "connected";
    if (connected && !configurable) return "manual";
    return "not_connected";
  }

  return "manual";
}

export function getCampaignPlatformStatuses(
  platformsCsv: string,
  integrations: ConnectedIntegrationLike[],
  config: PlatformConfigStatusLike | undefined,
  campaignBusinessId?: number | null
): { platform: string; status: PlatformPublishStatus }[] {
  const selected = platformsCsv
    .split(/[,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return selected.map((p) => ({
    platform: p,
    status: getPlatformPublishStatus(p, integrations, config, campaignBusinessId),
  }));
}

export interface PublishResultToastInput {
  manualPosting?: boolean;
  manualCount?: number;
  publishedCount?: number;
  failedCount?: number;
  skippedCount?: number;
  results?: Array<{ status: string; error?: string }>;
}

export function getPublishResultToast(
  data: PublishResultToastInput
): { type: "success" | "warning" | "error"; message: string } {
  if (data.manualPosting) {
    return {
      type: "success",
      message: `Marked for manual posting. ${data.manualCount || 0} item(s) ready.`,
    };
  }

  const published = data.publishedCount || 0;
  const failed = data.failedCount || 0;
  const skipped = data.skippedCount || 0;

  if (failed === 0 && skipped === 0 && published > 0) {
    return {
      type: "success",
      message: `Campaign pack published. ${published} platform(s) published.`,
    };
  }

  if (published > 0) {
    return {
      type: "success",
      message: `${published} platform(s) published. ${failed} failed, ${skipped} skipped.`,
    };
  }

  if (skipped > 0) {
    return {
      type: "warning",
      message: `Publishing skipped: ${skipped} platform(s) not ready.`,
    };
  }

  const firstError = (data.results || []).find((r) => r.error)?.error;
  return {
    type: "error",
    message: firstError || "Publishing failed. Check platform connections and try again.",
  };
}

export function hasConnectedPublishPlatform(
  statuses: { status: PlatformPublishStatus }[]
): boolean {
  return statuses.some((s) => s.status === "connected");
}

export function buildIntegrationsReturnUrl(campaignId: number | string | null | undefined): string {
  const base = "/integrations";
  if (campaignId == null || campaignId === "") return base;
  return `${base}?returnTo=${encodeURIComponent(`/content?campaignId=${campaignId}`)}`;
}


export type PublishEligibilityUnavailableReason =
  | "ready"
  | "no_publishable_content"
  | "no_connected_platforms"
  | "strategy_approval_required"
  | "launch_approval_required";

export function getPublishDialogButtonLabel({
  isPending,
  unavailableReason,
  isRepublish,
}: {
  isPending: boolean;
  unavailableReason: PublishEligibilityUnavailableReason;
  isRepublish: boolean;
}): string {
  if (isPending) return "Publishing...";

  // When the backend says ready, we always publish to connected channels.
  // "Confirm Manual Posting" is only allowed for the explicit no-platforms path.
  if (unavailableReason === "ready") {
    return isRepublish ? "Publish again" : "Confirm Publish";
  }

  if (unavailableReason === "no_connected_platforms") {
    return isRepublish ? "Post manually again" : "Confirm Manual Posting";
  }

  // Approval-required or contract-error states should not trigger a publish action.
  return "Confirm Publish";
}
