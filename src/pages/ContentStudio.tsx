import { useState, useMemo, useEffect } from "react";
import { useSearchParams, Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import {
  PenTool,
  Plus,
  Sparkles,
  Copy,
  Check,
  CheckCircle2,
  Instagram,
  Linkedin,
  Facebook,
  Video,
  FileText,
  Mail,
  Trash2,
  Search,
  ArrowRight,
  X,
  Upload,
  CalendarClock,
  ExternalLink,
  AlertCircle,
  Info,
  Loader2,
  Megaphone,
  MessageCircle,
  Image,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  History,
  LayoutTemplate,
  Briefcase,
  ShoppingBag,
  Tag,
  LayoutGrid,
  Eye,
  TrendingUp,
  Clock,
  type LucideIcon,
} from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { PremiumTemplateGallery } from "@/components/content/PremiumTemplateGallery";
import type { GalleryTemplate } from "@/components/content/PremiumTemplateGallery";
import { toast } from "sonner";

const ENABLE_PREMIUM_VIDEO = import.meta.env.VITE_ENABLE_PREMIUM_VIDEO === "true";
const ENABLE_BASIC_DRAFT_VIDEO = import.meta.env.VITE_ENABLE_BASIC_DRAFT_VIDEO === "true";

const platforms = [
  { value: "instagram", label: "Instagram", icon: Instagram },
  { value: "tiktok", label: "TikTok", icon: Video },
  { value: "linkedin", label: "LinkedIn", icon: Linkedin },
  { value: "facebook", label: "Facebook", icon: Facebook },
  { value: "email", label: "Email", icon: Mail },
  { value: "blog", label: "Blog", icon: FileText },
];

const tones = ["friendly", "premium", "bold", "professional", "casual", "urgent"];

const CAPTION_PACK_PLATFORM_KEYS: Record<string, keyof { linkedinCaption: string; facebookCaption: string; instagramCaption: string; whatsappCaption: string }> = {
  instagram: "instagramCaption",
  facebook: "facebookCaption",
  linkedin: "linkedinCaption",
  whatsapp: "whatsappCaption",
};

type PendingActionKey = string;

type ContentIteration = {
  id: string;
  runId: string;
  iterationNumber: number;
  createdAt: Date;
  tier: "premium" | "basic" | "standard";
  leaflet?: any;
  captionPack?: any;
  videoConcept?: any;
  supporting: any[];
  isLegacy?: boolean;
  items: any[];
};

function actionKey(contentId: number, action: string): PendingActionKey {
  return `${contentId}:${action}`;
}

import {
  getContentMeta,
  getImageUrl,
  getCampaignImageAssetUrl,
  isCaptionPackAsset,
  findLeafletCandidate,
  campaignNeedsRecoveryDecision,
  campaignHasGeneratedContent,
  asNumber,
  asString,
} from "../lib/content-studio/logic";

function getRunId(c: unknown): string {
  return asString(getContentMeta(c).generationRunId) || "legacy-group";
}

function getIterationNumber(c: unknown): number | null {
  return asNumber(getContentMeta(c).iterationNumber);
}

function getAssetTier(c: any): "premium" | "basic" | "standard" {
  const tier = getContentMeta(c).assetTier;
  if (tier === "premium" || tier === "basic" || tier === "standard") return tier;
  const source = getContentMeta(c).imageSource || getContentMeta(c).source;
  const credits = getContentMeta(c).imageCreditsCharged;
  if (source === "premium" || (typeof credits === "number" && credits > 0)) return "premium";
  if (source === "draft" || credits === 0 || getContentMeta(c).isDraft) return "basic";
  return "standard";
}

function getAssetType(c: any) {
  return getContentMeta(c).assetType || getContentMeta(c).assetKind || c?.type || c?.assetType || "unknown";
}

function isMasterLeaflet(c: any) {
  return getAssetType(c) === "leaflet" || getContentMeta(c).assetKind === "master_campaign_post";
}

function isVideoConcept(c: any) {
  return (
    getAssetType(c) === "video_concept" ||
    getContentMeta(c).assetKind === "master_video_ad" ||
    c?.type === "video_concept"
  );
}

type CampaignSummaryStatus = "ready" | "approved" | "draft" | "failed" | "generating" | "none";

interface CampaignSummary {
  campaign: any;
  businessName: string;
  latestLeaflet: any | null;
  thumbnailUrl: string | null;
  iterationNumber: number;
  tier: "premium" | "basic" | "none";
  status: CampaignSummaryStatus;
  lastGeneratedAt: Date | null;
  creditsCharged: number;
}

function getLeafletStatus(leaflet: any): CampaignSummaryStatus {
  if (!leaflet) return "none";
  const meta = getContentMeta(leaflet);
  if (meta.imageStatus === "failed" || meta.videoStatus === "failed") return "failed";
  if (meta.imageStatus === "generating" || meta.videoStatus === "generating" || meta.videoStatus === "rendering") return "generating";
  if (meta.approved === true || leaflet.status === "published") return "approved";
  if (meta.imageStatus === "ready" || meta.videoStatus === "ready") return "ready";
  return "draft";
}

function getLeafletTier(leaflet: any): "premium" | "basic" | "none" {
  if (!leaflet) return "none";
  const tier = getAssetTier(leaflet);
  if (tier === "premium") return "premium";
  if (tier === "basic") return "basic";
  return "none";
}

function computeCampaignSummaries(
  campaigns: any[] | undefined,
  businesses: any[] | undefined,
  contents: any[] | undefined,
  assets: any[] | undefined
): CampaignSummary[] {
  const leaflets = (contents || []).filter((c) => isMasterLeaflet(c));
  const leafletsByCampaign = new Map<number, any[]>();
  for (const leaflet of leaflets) {
    const campaignId = leaflet.campaignId ?? 0;
    if (!leafletsByCampaign.has(campaignId)) leafletsByCampaign.set(campaignId, []);
    leafletsByCampaign.get(campaignId)!.push(leaflet);
  }
  for (const [, list] of leafletsByCampaign) {
    list.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  }

  const businessMap = new Map((businesses || []).map((b) => [b.id, b]));

  return (campaigns || []).map((campaign) => {
    const campaignLeaflets = leafletsByCampaign.get(campaign.id) || [];
    const latestLeaflet = campaignLeaflets[0] || null;
    const meta = getContentMeta(latestLeaflet);
    const business = businessMap.get(campaign.businessId);
    const status = getLeafletStatus(latestLeaflet);
    const tier = getLeafletTier(latestLeaflet);

    return {
      campaign,
      businessName: business?.name || "Unknown business",
      latestLeaflet,
      thumbnailUrl: getImageUrl(latestLeaflet, assets) || null,
      iterationNumber: asNumber(meta.iterationNumber) ?? 1,
      tier,
      status,
      lastGeneratedAt: latestLeaflet ? new Date(latestLeaflet.createdAt || 0) : null,
      creditsCharged: typeof meta.imageCreditsCharged === "number" ? meta.imageCreditsCharged : tier === "basic" ? 0 : 0,
    };
  });
}

function formatIterationDate(date: Date | string | undefined) {
  if (!date) return "";
  return new Date(date).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function computeCampaignIterations(contents: any[], assets: any[]): ContentIteration[] {
  const records: any[] = [
    ...(contents || []).map((c) => ({ ...c, _recordKind: "content" })),
    ...(assets || []).map((a) => ({ ...a, _recordKind: "asset" })),
  ];

  // Records that have a real generationRunId are grouped by run.
  // Records without one are grouped together as a single legacy iteration.
  const byRun = new Map<string, any[]>();
  for (const record of records) {
    const runId = getRunId(record);
    if (!byRun.has(runId)) byRun.set(runId, []);
    byRun.get(runId)!.push(record);
  }

  const iterations: ContentIteration[] = [];
  for (const [runId, items] of byRun.entries()) {
    const createdAt = new Date(
      Math.max(...items.map((i) => new Date(i.createdAt || 0).getTime()))
    );
    const explicitNumber = Math.max(...items.map((i) => getIterationNumber(i) || 0));
    const isLegacy = runId === "legacy-group";
    const leaflet = findLeafletCandidate(items, assets) || items.find(isMasterLeaflet);
    const videoConcept = items.find(isVideoConcept);
    const captionPack = items.find(isCaptionPackAsset);
    const supporting = items.filter(
      (i) => !isMasterLeaflet(i) && !isVideoConcept(i) && !isCaptionPackAsset(i) && i !== leaflet
    );
    const tier: "premium" | "basic" | "standard" =
      (leaflet && getAssetTier(leaflet)) ||
      (captionPack && getAssetTier(captionPack)) ||
      (videoConcept && getAssetTier(videoConcept)) ||
      (isLegacy ? "standard" : "standard");

    iterations.push({
      id: runId,
      runId,
      iterationNumber: explicitNumber || 0,
      createdAt,
      tier,
      leaflet,
      captionPack,
      videoConcept,
      supporting,
      isLegacy,
      items,
    } as ContentIteration);
  }

  // Assign fallback iteration numbers for records that lack them, newest first gets highest number.
  const sorted = iterations.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  let fallbackNumber = sorted.filter((i) => i.iterationNumber > 0).length;
  for (const iteration of sorted) {
    if (iteration.iterationNumber === 0) {
      fallbackNumber = Math.max(fallbackNumber + 1, 1);
      iteration.iterationNumber = fallbackNumber;
    }
  }

  return sorted;
}

function LeafletVersionHistory({ contentPostId, metadata }: { contentPostId: number; metadata: any }) {
  const utils = trpc.useUtils();
  const [showVersions, setShowVersions] = useState(false);
  const { data: versionRows } = trpc.image.versionsForPost.useQuery(
    { contentPostId },
    { enabled: showVersions }
  );
  const approveVersionMutation = trpc.image.approveVersion.useMutation({
    onSuccess: () => {
      toast.success("Version approved and set as current leaflet.");
      utils.content.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Failed to approve version");
    },
  });

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <button
        type="button"
        className="w-full px-3 py-2.5 flex items-center justify-between bg-slate-50 hover:bg-slate-100 transition-colors"
        onClick={() => setShowVersions((prev) => !prev)}
      >
        <span className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
          <History className="w-3.5 h-3.5 text-slate-500" />
          Version history
        </span>
        <span className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] h-5">
            {(versionRows?.length ?? (metadata?.imageVersions?.length || 0))} versions
          </Badge>
          {showVersions ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
        </span>
      </button>
      {showVersions && (
        <div className="p-3 space-y-2 border-t border-slate-100 max-h-[360px] overflow-y-auto">
          {!versionRows?.length && !metadata?.imageVersions?.length && (
            <p className="text-xs text-slate-500 text-center py-4">No versions yet.</p>
          )}
          {(versionRows || metadata?.imageVersions || []).map((version: any, idx: number) => {
            const isApproved = (metadata?.currentVersionId ?? metadata?.imageCurrentVersionId) === version.id;
            return (
              <div
                key={version.id ?? idx}
                className={`rounded-md border p-2.5 ${isApproved ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200 bg-white"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-800 truncate">
                      Version {version.version ?? idx + 1}
                      {isApproved && (
                        <Badge variant="outline" className="ml-2 text-[10px] h-4 border-emerald-200 text-emerald-700 bg-emerald-50">
                          Current
                        </Badge>
                      )}
                    </p>
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      {new Date(version.createdAt || version.generatedAt).toLocaleString()}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-[10px] h-5 shrink-0">
                    {(version.source === "draft" || version.source === "fallback"
                      ? "Basic Draft"
                      : version.source === "premium"
                      ? "Premium"
                      : version.source === "openai"
                      ? "Premium"
                      : version.source) || "Generated"}{" "}
                    · {typeof version.score === "number" ? `${version.score}/100` : "—"}
                  </Badge>
                </div>
                {(version.creativeGuidance || version.refinementInstruction) && (
                  <p className="text-[10px] text-slate-600 mt-1.5 line-clamp-2">
                    {version.refinementInstruction || version.creativeGuidance}
                  </p>
                )}
                <div className="flex gap-2 mt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[10px] flex-1"
                    onClick={() => {
                      const a = document.createElement("a");
                      a.href = version.url;
                      a.target = "_blank";
                      a.click();
                    }}
                    disabled={!version.url}
                  >
                    <ExternalLink className="w-3 h-3 mr-1" />
                    View
                  </Button>
                  {!isApproved && (
                    <Button
                      size="sm"
                      className="h-7 text-[10px] flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                      onClick={() =>
                        approveVersionMutation.mutate({
                          contentPostId,
                          generatedImageId: version.id,
                        })
                      }
                      disabled={approveVersionMutation.isPending || !version.id}
                    >
                      {approveVersionMutation.isPending && approveVersionMutation.variables?.generatedImageId === version.id ? (
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                      )}
                      Approve
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function ContentStudio() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlCampaignId = searchParams.get("campaignId");
  const [createOpen, setCreateOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [aiForm, setAiForm] = useState({
    business: "",
    platform: "instagram",
    audience: "",
    tone: "friendly",
    type: "social_post" as "social_post" | "ad_copy" | "email" | "video_concept" | "carousel_ad" | "whatsapp_promo",
    goal: "",
  });
  const [listError] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [overviewFilter, setOverviewFilter] = useState<"all" | "ready" | "draft" | "failed" | "premium" | "basic">("all");
  const [scheduleOpen, setScheduleOpen] = useState<{ open: boolean; contentId: number | null }>({
    open: false,
    contentId: null,
  });
  const [scheduleDate, setScheduleDate] = useState("");
  const [pendingActions, setPendingActions] = useState<Set<PendingActionKey>>(new Set());
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [isRepublish, setIsRepublish] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["masterVisual", "masterVideo"]));
  const [selectedIterationId, setSelectedIterationId] = useState<string | null>(null);
  const [captionPackTab, setCaptionPackTab] = useState<string>("master");
  type LeafletTemplateId =
    | "auto"
    | "service_business_promo"
    | "retail_product_promo"
    | "offer_discount_campaign"
    | "corporate_professional"
    | "local_store_promo";
  const [imageTemplateId, setImageTemplateId] = useState<LeafletTemplateId>("auto");
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [loadingImageIds, setLoadingImageIds] = useState<Set<number>>(new Set());
  const [brokenImageIds, setBrokenImageIds] = useState<Set<number>>(new Set());
  const [brokenIterationIds, setBrokenIterationIds] = useState<Set<string>>(new Set());
  const [creativeGuidanceById, setCreativeGuidanceById] = useState<Record<number, string>>({});
  const [refinementById, setRefinementById] = useState<Record<number, string>>({});
  const [allowNoLogoById, setAllowNoLogoById] = useState<Record<number, boolean>>({});

  const LEAFLET_TEMPLATE_OPTIONS: { value: LeafletTemplateId; label: string; description: string; icon: LucideIcon }[] = [
    { value: "auto", label: "Auto-detect", description: "Pick the best layout from your business category", icon: LayoutTemplate },
    { value: "service_business_promo", label: "Service Business", description: "Header, service grid & anchored CTA", icon: Briefcase },
    { value: "retail_product_promo", label: "Retail / Product", description: "Hero visual, centred offer & product cues", icon: ShoppingBag },
    { value: "offer_discount_campaign", label: "Offer / Discount", description: "Bold centred offer sticker & simple CTA", icon: Tag },
    { value: "corporate_professional", label: "Corporate", description: "Clean B2B layout with formal typography", icon: LayoutGrid },
    { value: "local_store_promo", label: "Local Store", description: "Friendly neighbourhood shop promo", icon: LayoutGrid },
  ];

  const TEMPLATE_REFINEMENT_CHIPS: Record<LeafletTemplateId, string[]> = {
    auto: ["Cleaner layout", "Larger text", "More spacing", "Simpler background"],
    service_business_promo: ["Cleaner service grid", "Larger text", "More spacing", "Hide business name in header", "Darker background"],
    retail_product_promo: ["Brighter colours", "Center offer", "Simpler background", "More spacing", "Larger text"],
    offer_discount_campaign: ["Center offer", "More whitespace", "Darker background", "Remove sub-headline", "Larger text"],
    corporate_professional: ["Larger text", "More spacing", "Cleaner layout", "Darker background"],
    local_store_promo: ["Larger text", "More spacing", "Brighter colours", "Center offer"],
  };

  const utils = trpc.useUtils();
  const numericCampaignId = urlCampaignId && !Number.isNaN(Number(urlCampaignId)) ? Number(urlCampaignId) : 0;
  const hasCampaignId = numericCampaignId > 0;

  const listInput = (() => {
    const base: any = {};
    if (hasCampaignId) base.campaignId = numericCampaignId;
    return Object.keys(base).length > 0 ? base : undefined;
  })();
  const { data: contents, isLoading } = trpc.content.list.useQuery(listInput, {
    retry: 1,
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasDrafts = data?.some((c) => c.status === "draft");
      return hasDrafts ? 8000 : false;
    },
  });

  const { data: campaignForContext } = trpc.campaign.get.useQuery(
    { id: numericCampaignId },
    { enabled: hasCampaignId }
  );
  const { data: businessForContext } = trpc.business.get.useQuery(
    { id: campaignForContext?.businessId ?? 0 },
    { enabled: !!campaignForContext?.businessId }
  );
  const { data: businessesList } = trpc.business.list.useQuery();
  const businessForLeaflet =
    businessForContext ??
    businessesList?.find((b) => b.id === campaignForContext?.businessId) ??
    businessesList?.[businessesList.length - 1];
  const { data: postCountForCampaign } = trpc.content.countForCampaign.useQuery(
    { campaignId: numericCampaignId },
    { enabled: hasCampaignId }
  );
  const { data: campaignAssets } = trpc.content.campaignAssets.useQuery(
    { campaignId: numericCampaignId },
    { enabled: hasCampaignId }
  );
  const campaignIterations = useMemo(
    () => computeCampaignIterations(contents || [], campaignAssets || []),
    [contents, campaignAssets]
  );
  useEffect(() => {
    // Reset the explicit selection only when it no longer exists in the iteration set.
    if (selectedIterationId && campaignIterations.length > 0 && !campaignIterations.some((i) => i.id === selectedIterationId)) {
      setSelectedIterationId(null);
    }
  }, [campaignIterations, selectedIterationId]);

  const { data: videoJobs } = trpc.video.listForCampaign.useQuery(
    { campaignId: numericCampaignId },
    { enabled: hasCampaignId }
  );
  const { data: videoConfig } = trpc.video.getConfigStatus.useQuery();
  const { data: premiumImageCosts } = trpc.image.premiumImageCosts.useQuery();
  const internalCost = premiumImageCosts?.internal ?? 5;
  const externalCost = premiumImageCosts?.external ?? 10;
  const aiCost = premiumImageCosts?.ai ?? 10;
  const { data: premiumTemplateStatus } = trpc.image.premiumTemplateStatus.useQuery();
  const { data: openAiLeafletStatus } = trpc.image.openAiLeafletStatus.useQuery();
  const { data: internalTemplatesData } = trpc.image.listInternalTemplates.useQuery(
    hasCampaignId && campaignForContext?.businessId
      ? { businessId: campaignForContext.businessId, campaignId: numericCampaignId }
      : undefined,
    { enabled: hasCampaignId }
  );
  const internalTemplates: GalleryTemplate[] = (internalTemplatesData || []).map((t) => ({
    id: t.id,
    name: t.name,
    label: t.label,
    description: t.description,
    category: t.category,
    previewImageUrl: t.previewImageUrl,
    autoSelected: t.autoSelected,
    supportedBusinessTypes: t.supportedBusinessTypes,
    supportedCampaignIntents: t.supportedCampaignIntents,
  }));

  // Fetch campaigns and approvals to show contextual empty-state guidance
  const { data: campaigns } = trpc.campaign.list.useQuery();
  const { data: approvals } = trpc.approval.listApprovals.useQuery(
    { status: "pending" },
    { enabled: (contents?.length ?? 0) === 0 }
  );

  const { data: connectedPlatforms } = trpc.integration.getConnectedPlatforms.useQuery();
  const { data: platformConfigStatus } = trpc.integration.getPlatformConfigStatus.useQuery();
  const { data: publishingQueueItems, refetch: refetchPublishingQueue } =
    trpc.publishing.getPublishingQueue.useQuery(
      { campaignId: numericCampaignId },
      { enabled: hasCampaignId, refetchInterval: 5000 }
    );

  // Fetch agent runs so we can detect failed regenerations and avoid showing "completed" creative rows with no content
  const { data: creativeAgentRuns } = trpc.agent.getAgentRuns.useQuery(
    { campaignId: numericCampaignId, agentType: "creative" },
    { enabled: hasCampaignId, refetchInterval: 10000 }
  );
  const { data: strategyAgentRuns } = trpc.agent.getAgentRuns.useQuery(
    { campaignId: numericCampaignId, agentType: "strategy" },
    { enabled: hasCampaignId, refetchInterval: 10000 }
  );

  const connectedIntegrations = useMemo(
    () =>
      connectedPlatforms?.map((i) => ({
        platform: i.provider,
        accountName: i.providerAccountName,
        status: i.status,
        ready: i.ready,
        instagramBusinessAccountId: i.instagramBusinessAccountId,
        permissions: i.permissions,
        pageAccessTokenEncrypted: i.pageAccessTokenEncrypted,
      })) ?? [],
    [connectedPlatforms]
  );

  const strategyPendingApproval = approvals?.find((a) => a.approvalType === "strategy_review");
  const strategyGeneratedCampaign = campaigns?.find((c) => c.workflowState === "strategy_generated");
  const strategyPendingCampaign = campaigns?.find((c) => c.workflowState === "strategy_pending");

  // Keep the latest-run failure flag so the recovery UI can show the right message.
  const latestStrategyRun = strategyAgentRuns?.[0];
  const hasFailedStrategyRun = latestStrategyRun?.status === "failed";

  const campaignNeedsRecovery = campaignNeedsRecoveryDecision(
    campaignForContext,
    postCountForCampaign,
    contents,
    creativeAgentRuns,
    strategyAgentRuns
  );

  const generateForCampaignMutation = trpc.content.generateForCampaign.useMutation({
    onSuccess: (data) => {
      utils.content.list.invalidate();
      utils.content.countForCampaign.invalidate({ campaignId: numericCampaignId });
      utils.campaign.get.invalidate({ id: numericCampaignId });
      utils.agent.getAgentRuns.invalidate({ campaignId: numericCampaignId });
      toast.success(`Content generated successfully. ${data.postCount} posts created.`);
    },
    onError: (err) => {
      utils.content.list.invalidate();
      utils.content.countForCampaign.invalidate({ campaignId: numericCampaignId });
      utils.campaign.get.invalidate({ id: numericCampaignId });
      utils.agent.getAgentRuns.invalidate({ campaignId: numericCampaignId });
      toast.error(err.message || "Failed to generate content for campaign");
    },
  });

  const createMutation = trpc.content.create.useMutation({
    onSuccess: () => {
      utils.content.list.invalidate();
      setCreateOpen(false);
      toast.success("Content created!");
    },
  });

  const deleteMutation = trpc.content.delete.useMutation({
    onSuccess: () => {
      utils.content.list.invalidate();
      toast.success("Content deleted!");
    },
  });

  const approveMutation = trpc.content.approve.useMutation({
    onSuccess: (_, vars) => {
      utils.content.list.invalidate();
      toast.success("Content approved and ready to publish!");
      setPendingActions((prev) => {
        const next = new Set(prev);
        next.delete(actionKey(vars.id, "approve"));
        return next;
      });
    },
    onError: (err, vars) => {
      toast.error(err.message || "Failed to approve content");
      setPendingActions((prev) => {
        const next = new Set(prev);
        next.delete(actionKey(vars.id, "approve"));
        return next;
      });
    },
  });

  const markManuallyPostedMutation = trpc.content.markAsManuallyPosted.useMutation({
    onSuccess: (_, vars) => {
      utils.content.list.invalidate();
      toast.success("Marked as manually posted!");
      setPendingActions((prev) => {
        const next = new Set(prev);
        next.delete(actionKey(vars.id, "markPosted"));
        return next;
      });
    },
    onError: (err, vars) => {
      toast.error(err.message || "Failed to update content");
      setPendingActions((prev) => {
        const next = new Set(prev);
        next.delete(actionKey(vars.id, "markPosted"));
        return next;
      });
    },
  });

  const updateMutation = trpc.content.update.useMutation({
    onSuccess: (_, vars) => {
      utils.content.list.invalidate();
      toast.success("Content updated!");
      setPendingActions((prev) => {
        const next = new Set(prev);
        next.delete(actionKey(vars.id, "schedule"));
        return next;
      });
    },
    onError: (err, vars) => {
      toast.error(err.message || "Failed to update content");
      setPendingActions((prev) => {
        const next = new Set(prev);
        next.delete(actionKey(vars.id, "schedule"));
        return next;
      });
    },
  });

  const filtered = contents?.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase())
  );

  const typeColors: Record<string, string> = {
    social_post: "bg-[#00D4FF]/10 text-[#00D4FF]",
    ad_copy: "bg-amber-500/10 text-amber-600",
    email: "bg-emerald-500/10 text-emerald-600",
    script: "bg-purple-500/10 text-purple-600",
    blog: "bg-blue-500/10 text-blue-600",
    story: "bg-pink-500/10 text-pink-600",
    video_concept: "bg-rose-500/10 text-rose-600",
    reel_script: "bg-fuchsia-500/10 text-fuchsia-600",
    carousel_ad: "bg-orange-500/10 text-orange-600",
    whatsapp_promo: "bg-green-500/10 text-green-600",
    lead_gen_ad: "bg-cyan-500/10 text-cyan-600",
    launch_pack: "bg-violet-500/10 text-violet-600",
  };

  const statusColors: Record<string, string> = {
    draft: "bg-slate-500/10 text-slate-600 border-slate-200",
    scheduled: "bg-blue-500/10 text-blue-600 border-blue-200",
    published: "bg-emerald-500/10 text-emerald-600 border-emerald-200",
    archived: "bg-gray-500/10 text-gray-600 border-gray-200",
  };

  function isPlatformConnected(platform?: string | null) {
    if (!platform) return false;
    const connectable = ["facebook", "instagram", "linkedin", "tiktok", "twitter", "whatsapp"];
    if (!connectable.includes(platform)) return true;
    return connectedIntegrations?.some(
      (i) => i.platform === platform && i.status === "connected" && i.ready
    );
  }

  function getInstagramReadinessError(platform?: string | null) {
    if (platform !== "instagram") return null;
    const integration = connectedIntegrations?.find((i) => i.platform === "instagram");
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

  function isPlatformConfigurable(platform?: string | null) {
    if (!platform) return true;
    const connectable = ["facebook", "instagram", "linkedin", "tiktok", "twitter", "whatsapp"];
    if (!connectable.includes(platform)) return true;
    if (platform === "facebook" || platform === "instagram") {
      return platformConfigStatus?.metaConfigured === true;
    }
    if (platform === "linkedin") {
      return platformConfigStatus?.linkedinConfigured === true;
    }
    return true;
  }

  async function generateWithAI() {
    setAiLoading(true);
    try {
      let prompt = "";
      if (aiForm.type === "social_post") {
        prompt = `Create 3 high-converting social media posts for ${aiForm.business}.
Platform: ${aiForm.platform}
Audience: ${aiForm.audience}
Tone: ${aiForm.tone}

For each post provide:
- Hook (attention-grabbing first line, max 12 words, bold or emotional)
- Caption (2-4 short paragraphs, line breaks, address a pain point)
- CTA (specific action + urgency, e.g. "DM 'YES' now — only 10 spots")
- Relevant hashtags (5-10 targeted)

Make them sales-focused and conversion-oriented. Progress through: hook → agitate pain → present solution → urgency → strong CTA.`;
      } else if (aiForm.type === "ad_copy") {
        prompt = `Create 3 high-converting ad copies for ${aiForm.business}.
Goal: ${aiForm.goal || "Conversions"}
Audience: ${aiForm.audience}
Tone: ${aiForm.tone}

For each ad provide:
- Scroll-stopping headline (max 8 words)
- Pain point (1 sentence)
- Solution/benefit (1-2 sentences)
- Strong CTA with urgency

Use different psychological angles: FOMO, social proof, direct benefit. Keep them punchy.`;
      } else {
        prompt = `Create a high-converting email for ${aiForm.business}.
Goal: ${aiForm.goal || "Sales"}
Audience: ${aiForm.audience}
Tone: ${aiForm.tone}

Include:
- Subject line (under 40 chars, curiosity or urgency driven)
- Opening hook (first line must demand attention)
- Body content (under 150 words, clear value proposition)
- Call-to-action (single, specific action)
- Professional sign-off`;
      }

      const result = await generateText({
        model: openai("gpt-4o-mini"),
        prompt,
      });

      setAiResult(result.text);
    } catch (error) {
      toast.error("Failed to generate content. Try again.");
    } finally {
      setAiLoading(false);
    }
  }

  function copyToClipboard(text: string, id: number) {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
    toast.success("Copied to clipboard!");
  }

  function getCaptionText(content: any) {
    const captionPackCaption = getCaptionPackCaption(content);
    const caption = captionPackCaption || content.caption;
    const parts = [
      content.hook,
      caption,
      content.cta,
      content.body,
      content.hashtags,
    ].filter(Boolean);
    return parts.join("\n\n");
  }

  function getCaptionPackCaption(content: any): string | undefined {
    if (!content.platform || content.type !== "social_post") return undefined;
    const pack = campaignAssets?.find((a) => a.assetType === "caption_pack" && a.campaignId === content.campaignId);
    if (!pack) return undefined;
    const meta = (pack.metadata || {}) as any;
    const key = CAPTION_PACK_PLATFORM_KEYS[content.platform.toLowerCase()];
    if (!key) return undefined;
    const value = meta?.[key];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  }

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    createMutation.mutate({
      title: form.get("title") as string,
      type: (form.get("type") as any) || "social_post",
      platform: (form.get("platform") as string) || undefined,
      hook: (form.get("hook") as string) || undefined,
      caption: (form.get("caption") as string) || undefined,
      cta: (form.get("cta") as string) || undefined,
      body: (form.get("body") as string) || undefined,
    });
  }

  function openSchedule(contentId: number, currentDate?: Date | string | null) {
    setScheduleOpen({ open: true, contentId });
    if (currentDate) {
      const d = new Date(currentDate);
      const pad = (n: number) => String(n).padStart(2, "0");
      setScheduleDate(
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
      );
    } else {
      setScheduleDate("");
    }
  }

  function handleScheduleSave() {
    if (!scheduleOpen.contentId || !scheduleDate) return;
    setPendingActions((prev) => new Set(prev).add(actionKey(scheduleOpen.contentId!, "schedule")));
    updateMutation.mutate({
      id: scheduleOpen.contentId,
      status: "scheduled",
      scheduledFor: new Date(scheduleDate).toISOString(),
    });
    setScheduleOpen({ open: false, contentId: null });
  }

  function getApprovalState(content: any) {
    const metadata = (content.metadata || {}) as any;
    return !!metadata.approved;
  }

  function getContentPublishStatus(contentId: number): { status: string; platform?: string; error?: string } | null {
    const items = publishingQueueItems?.filter((item) => item.contentPostId === contentId);
    if (!items || items.length === 0) return null;
    // Return the most recent item
    const latest = items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    return {
      status: latest.status,
      platform: latest.platform,
      error: latest.lastError || undefined,
    };
  }

  function getCampaignPublishStatus(): "idle" | "pending" | "in_progress" | "published" | "failed" {
    const items = publishingQueueItems;
    if (!items || items.length === 0) return "idle";
    if (items.some((i) => i.status === "failed")) return "failed";
    if (items.some((i) => ["approved", "retrying"].includes(i.status))) return "in_progress";
    if (items.some((i) => i.status === "pending_approval")) return "pending";
    if (items.every((i) => i.status === "published")) return "published";
    return "idle";
  }

  function isPending(contentId: number, action: string) {
    return pendingActions.has(actionKey(contentId, action));
  }

  function startAction(contentId: number, action: string) {
    setPendingActions((prev) => new Set(prev).add(actionKey(contentId, action)));
  }

  function stopAction(contentId: number, action: string) {
    setPendingActions((prev) => {
      const next = new Set(prev);
      next.delete(actionKey(contentId, action));
      return next;
    });
  }

  function stopAllDraftActions(contentPostId: number) {
    ["generate-draft", "regenerate-draft", "refine-draft", "retry-draft"].forEach((action) =>
      stopAction(contentPostId, action)
    );
  }

  function handleApprove(contentId: number) {
    setPendingActions((prev) => new Set(prev).add(actionKey(contentId, "approve")));
    approveMutation.mutate({ id: contentId });
  }

  function handleMarkPosted(contentId: number) {
    setPendingActions((prev) => new Set(prev).add(actionKey(contentId, "markPosted")));
    markManuallyPostedMutation.mutate({ id: contentId });
  }

  function handlePublishNow(content: any) {
    if (!urlCampaignId) {
      toast.error("This content is not part of a campaign.");
      return;
    }

    // Open the campaign-level publish dialog; individual captions are published as part of the pack.
    const status = getPlatformPublishStatus(content.platform);
    if (status === "not_supported") {
      toast.error("Publishing is not supported for this platform yet.");
      return;
    }
    if (content.status !== "draft" && content.status !== "scheduled") {
      toast.info("This content is already published or approved.");
      return;
    }

    setPublishDialogOpen(true);
  }

  const renderVideoMutation = trpc.video.renderVideo.useMutation({
    onSuccess: (data) => {
      if (data.mode === "premium") {
        toast.success(data.status === "queued" ? "Premium video queued with Creatify." : "Premium video ready!");
      } else {
        toast.success("Basic draft video rendered.");
      }
      utils.content.list.invalidate();
      utils.video.listForCampaign.invalidate({ campaignId: numericCampaignId });
      if (data.videoUrl) {
        window.open(data.videoUrl, "_blank");
      }
    },
    onError: (err) => {
      toast.error(err.message || "Failed to render video");
    },
  });

  const generateImageMutation = trpc.image.generateForPost.useMutation({
    onMutate: (variables) => {
      startAction(variables.contentPostId, "basic");
      setBrokenImageIds((prev) => {
        const next = new Set(prev);
        next.delete(variables.contentPostId);
        return next;
      });
      setLoadingImageIds((prev) => new Set(prev).add(variables.contentPostId));
    },
    onSuccess: async (_data, variables) => {
      stopAction(variables.contentPostId, "basic");
      stopAllDraftActions(variables.contentPostId);
      toast.success("Basic draft leaflet generated (0 credits). Upgrade to Premium for a polished, customer-ready result.");
      await Promise.all([
        utils.content.list.invalidate(),
        utils.content.campaignAssets.invalidate({ campaignId: numericCampaignId }),
        utils.image.list.invalidate({ campaignId: numericCampaignId }),
      ]);
      // Switch the active view to the newest image-bearing iteration.
      setSelectedIterationId(null);
    },
    onError: (err, variables) => {
      stopAction(variables.contentPostId, "basic");
      stopAllDraftActions(variables.contentPostId);
      const message = err.message || "";
      const code = (err as { data?: { code?: string } } | undefined)?.data?.code;
      if (code === "PAYMENT_REQUIRED" || message.includes("Insufficient credits") || message.includes("credits.")) {
        toast.error(message || "Credit check failed for draft generation.");
      } else if (code === "NOT_IMPLEMENTED" || message.includes("not configured")) {
        toast.error("Draft leaflet generation is not configured. Please contact admin.");
      } else if (message.includes("System AI generation limit")) {
        toast.error("System AI generation limit reached. Please contact admin or try again later.");
      } else {
        toast.error(message || "We could not generate the basic draft. Please try again.");
      }
    },
  });

  const generatePremiumLeafletMutation = trpc.image.generatePremiumLeaflet.useMutation({
    onMutate: (variables) => {
      startAction(variables.contentPostId, "premium");
      setBrokenImageIds((prev) => {
        const next = new Set(prev);
        next.delete(variables.contentPostId);
        return next;
      });
      setLoadingImageIds((prev) => new Set(prev).add(variables.contentPostId));
    },
    onSuccess: async (data, variables) => {
      stopAction(variables.contentPostId, "premium");
      const costText = (data.creditsCharged ?? internalCost) === 0 ? "no charge" : `${data.creditsCharged ?? internalCost} credits`;
      toast.success(`Premium Marketing Leaflet generated (${costText}). Review the leaflet and caption pack, then approve or regenerate.`);
      // Await the critical queries so the Campaign Pack can pick up the new leaflet/imageUrl immediately.
      await Promise.all([
        utils.content.list.invalidate(),
        utils.content.campaignAssets.invalidate({ campaignId: numericCampaignId }),
        utils.image.list.invalidate({ campaignId: numericCampaignId }),
      ]);
      // Switch the active view to the newest image-bearing iteration (the one just generated).
      setSelectedIterationId(null);
    },
    onError: (err, variables) => {
      stopAction(variables.contentPostId, "premium");
      const message = err.message || "";
      const code = (err as { data?: { code?: string } } | undefined)?.data?.code;
      const prefix = message ? `${message} ` : "";
      if (code === "PAYMENT_REQUIRED" || message.includes("Insufficient credits") || message.includes("credits.")) {
        toast.error(message || "You don't have enough credits to generate a Premium Marketing Leaflet.");
      } else if (code === "NOT_IMPLEMENTED" || message.includes("not configured")) {
        toast.error(`${prefix}Premium leaflet generation is not configured. Generate a Basic Draft (0 credits) instead, or contact admin.`);
      } else if (message.includes("System AI generation limit")) {
        toast.error(message || "System AI generation limit reached. Please contact admin or try again later.");
      } else if (code === "BAD_REQUEST" || message.includes("400") || message.includes("content policy") || message.includes("safety")) {
        toast.error(`${prefix}We could not generate the Premium Marketing Leaflet. No credits were deducted. Please try again or contact support if the issue continues.`);
      } else {
        toast.error(message || "We could not generate the Premium Marketing Leaflet. No credits were deducted. Try a Basic Draft instead.");
      }
    },
  });

  const selectedIteration = useMemo(() => {
    const currentIterations = campaignIterations.filter(
      (i) => !i.isLegacy && (i.leaflet || i.captionPack || i.videoConcept)
    );
    const displayIterations = currentIterations.length > 0 ? currentIterations : campaignIterations;

    const hasLeafletImage = (iteration?: ContentIteration) =>
      !!iteration && !!getImageUrl(findLeafletCandidate(iteration.items, campaignAssets) || iteration.leaflet, campaignAssets);

    const selected = displayIterations.find((i) => i.id === selectedIterationId);
    // Respect an explicit user selection that already carries a leaflet image.
    if (selected && hasLeafletImage(selected)) return selected;

    // Default to the newest iteration that has a leaflet image.
    const newestWithImage = displayIterations.find((i) => hasLeafletImage(i));
    if (newestWithImage) return newestWithImage;

    // Final fallback: explicit selection, then the newest iteration.
    return selected || displayIterations[0];
  }, [campaignIterations, selectedIterationId]);

  const legacyIteration = useMemo(
    () => campaignIterations.find((i) => i.isLegacy),
    [campaignIterations]
  );

  const selectedIterationItems = selectedIteration?.items || [];
  const leafletCandidate = selectedIteration?.leaflet || findLeafletCandidate(selectedIterationItems, campaignAssets);
  const leafletImageUrl = getImageUrl(leafletCandidate, campaignAssets);
  const isLeafletGenerating =
    selectedIteration &&
    !leafletCandidate &&
    (getContentMeta(selectedIteration.leaflet).imageStatus === "generating" ||
      selectedIterationItems.some((i) => getContentMeta(i).imageStatus === "generating") ||
      generatePremiumLeafletMutation.isPending);
  const isLeafletMissingButReady =
    selectedIteration &&
    selectedIteration.tier === "premium" &&
    !leafletCandidate &&
    !isLeafletGenerating;

  // Poll/refetch briefly when a premium leaflet should exist but the candidate hasn't appeared yet.
  useEffect(() => {
    if (!isLeafletMissingButReady || !hasCampaignId) return;
    let count = 0;
    const interval = setInterval(() => {
      count += 1;
      if (count > 12) {
        clearInterval(interval);
        return;
      }
      utils.content.list.invalidate();
      utils.content.campaignAssets.invalidate({ campaignId: numericCampaignId });
    }, 2500);
    return () => clearInterval(interval);
  }, [isLeafletMissingButReady, hasCampaignId, numericCampaignId, utils.content.list, utils.content.campaignAssets]);

  // Scroll to the Marketing Leaflet section once the leaflet imageUrl becomes available.
  useEffect(() => {
    if (!leafletImageUrl) return;
    const el = document.getElementById("marketing-leaflet-section");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [leafletImageUrl]);

  const generateCaptionPackMutation = trpc.image.generateCaptionPack.useMutation({
    onMutate: (variables) => {
      startAction(variables.contentPostId, "caption-pack");
    },
    onSuccess: (_data, variables) => {
      stopAction(variables.contentPostId, "caption-pack");
      toast.success("Caption pack generated. You can now copy platform-ready captions.");
      utils.content.campaignAssets.invalidate({ campaignId: numericCampaignId });
      utils.content.list.invalidate();
    },
    onError: (err, variables) => {
      stopAction(variables.contentPostId, "caption-pack");
      toast.error(err.message || "Failed to generate caption pack");
    },
  });

  const publishCampaignPackMutation = trpc.content.publishCampaignPack.useMutation({
    onSuccess: (data) => {
      utils.content.list.invalidate();
      refetchPublishingQueue();
      const published = data.publishedCount || 0;
      const failed = data.failedCount || 0;
      const skipped = data.skippedCount || 0;
      if (failed === 0 && skipped === 0) {
        toast.success(`Campaign pack published. ${published} platform(s) published.`);
      } else if (published > 0) {
        toast.success(`${published} platform(s) published. ${failed} failed, ${skipped} skipped.`);
      } else if (skipped > 0) {
        toast.warning(`Publishing skipped: ${skipped} platform(s) not ready.`);
      } else {
        const firstError = (data.results || []).find((r) => r.error)?.error;
        toast.error(firstError || "Publishing failed. Check platform connections and try again.");
      }
      setPublishDialogOpen(false);
    },
    onError: (err) => {
      refetchPublishingQueue();
      toast.error(err.message || "Failed to publish campaign pack");
    },
  });

  const regenerateFromProfileMutation = trpc.campaign.regenerateFromProfile.useMutation({
    onSuccess: () => {
      utils.content.list.invalidate();
      utils.content.campaignAssets.invalidate({ campaignId: numericCampaignId });
      utils.content.countForCampaign.invalidate({ campaignId: numericCampaignId });
      utils.campaign.get.invalidate({ id: numericCampaignId });
      utils.agent.getAgentRuns.invalidate({ campaignId: numericCampaignId });
      toast.success("Campaign pack regenerated from the updated business profile.");
    },
    onError: (err) => {
      utils.content.list.invalidate();
      utils.content.countForCampaign.invalidate({ campaignId: numericCampaignId });
      utils.campaign.get.invalidate({ id: numericCampaignId });
      utils.agent.getAgentRuns.invalidate({ campaignId: numericCampaignId });
      toast.error(err.message || "Failed to regenerate campaign pack");
    },
  });

  const refreshVideoStatusMutation = trpc.video.refreshStatus.useMutation({
    onSuccess: (data) => {
      toast.success(`Video status: ${data.status}`);
      utils.video.listForCampaign.invalidate({ campaignId: numericCampaignId });
    },
    onError: (err) => {
      toast.error(err.message || "Failed to refresh status");
    },
  });

  function getVideoJobForContent(contentId: number) {
    return videoJobs?.find((j) => j.contentPostId === contentId);
  }

  function renderVideoBlueprint(content: any) {
    const metadata = (content.metadata || {}) as any;
    const job = getVideoJobForContent(content.id);
    const basicConfigured = videoConfig?.basicConfigured ?? true;
    const premiumConfigured = videoConfig?.premiumConfigured ?? false;
    const anyVideoEnabled = (ENABLE_PREMIUM_VIDEO && premiumConfigured) || (ENABLE_BASIC_DRAFT_VIDEO && basicConfigured);
    if (!anyVideoEnabled) return null;
    const isPremiumVideo = metadata?.isPremiumVideo === true;
    const videoStatus = metadata?.videoStatus || "concept";
    const videoUrl = metadata?.videoUrl || job?.videoUrl || null;
    const approved = getApprovalState(content);

    return (
      <div className="mt-3 p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
        {metadata?.scenes?.length > 0 && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Video Blueprint</span>
              <span className="text-[10px] text-slate-500">{metadata.duration || "30s"}</span>
            </div>
            <p className="text-xs text-slate-600 font-medium">{metadata.openingHook3Sec || content.hook}</p>
            <div className="space-y-1.5">
              {metadata.scenes.map((scene: any, i: number) => (
                <div key={i} className="flex gap-2 text-xs">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-[#00D4FF]/10 text-[#00D4FF] flex items-center justify-center font-bold text-[10px]">
                    {scene.sceneNumber || i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-slate-700 truncate">{scene.visualDescription}</p>
                    {scene.onScreenText && (
                      <p className="text-slate-500 text-[10px]">Overlay: "{scene.onScreenText}"</p>
                    )}
                    {scene.voiceoverScript && (
                      <p className="text-slate-500 text-[10px] italic truncate">VO: {scene.voiceoverScript}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {metadata.backgroundMusicMood && (
              <p className="text-[10px] text-slate-500">Music: {metadata.backgroundMusicMood}</p>
            )}
          </>
        )}

        {/* Video Status Badges */}
        <div className="flex flex-wrap gap-2 pt-1">
          {!videoUrl && videoStatus === "concept" && (
            <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50 text-[10px] h-6">
              <AlertCircle className="w-3 h-3 mr-1" />
              Storyboard
            </Badge>
          )}
          {videoStatus === "rendering" && (
            <Badge variant="outline" className="text-purple-600 border-purple-200 bg-purple-50 text-[10px] h-6">
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              Rendering
            </Badge>
          )}
          {videoStatus === "ready" && videoUrl && (
            <Badge variant="outline" className={`text-[10px] h-6 ${isPremiumVideo ? "text-purple-600 border-purple-200 bg-purple-50" : "text-amber-600 border-amber-200 bg-amber-50"}`}>
              <CheckCircle2 className="w-3 h-3 mr-1" />
              {isPremiumVideo ? "Premium Video" : "Basic Draft Video"}
            </Badge>
          )}
          {videoStatus === "failed" && (
            <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50 text-[10px] h-6">
              <AlertCircle className="w-3 h-3 mr-1" />
              Render Failed
            </Badge>
          )}
          {videoStatus === "failed" && metadata?.renderError && (
            <p className="text-[11px] text-red-600 mt-1">
              {metadata.renderError}
            </p>
          )}
          {approved && (
            <Badge variant="outline" className="text-blue-600 border-blue-200 bg-blue-50 text-[10px] h-6">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Approved
            </Badge>
          )}
        </div>

        {/* Video Render Status / Actions */}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            onClick={() => copyToClipboard(getCaptionText(content), content.id)}
          >
            <Copy className="w-3 h-3 mr-1" />
            Export Brief
          </Button>

          {!videoUrl && videoStatus === "concept" && (
            <>
              {premiumConfigured ? (
                <Button
                  size="sm"
                  className="h-7 text-[11px] bg-purple-600 hover:bg-purple-700 text-white"
                  onClick={() => renderVideoMutation.mutate({ contentPostId: content.id, mode: "premium" })}
                  disabled={renderVideoMutation.isPending}
                  title="Generate premium AI video (100 credits)"
                >
                  {renderVideoMutation.isPending ? (
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  ) : (
                    <Video className="w-3 h-3 mr-1" />
                  )}
                  Generate Premium Video
                </Button>
              ) : (
                <Badge variant="outline" className="text-[10px] h-7 px-2 border-slate-200 text-slate-500 bg-slate-50">
                  <Video className="w-3 h-3 mr-1" />
                  Premium Video · Coming soon
                </Badge>
              )}

              {basicConfigured && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px] border-amber-300 text-amber-700 hover:bg-amber-50"
                  onClick={() => renderVideoMutation.mutate({ contentPostId: content.id, mode: "basic" })}
                  disabled={renderVideoMutation.isPending}
                >
                  <Video className="w-3 h-3 mr-1" />
                  Generate Basic Draft Video
                </Button>
              )}

              {!premiumConfigured && (
                <span className="text-[10px] text-slate-400">Premium video requires provider configuration.</span>
              )}
            </>
          )}

          {videoUrl && (
            <>
              <video
                src={videoUrl}
                poster={metadata?.thumbnailUrl}
                controls
                className="w-full rounded-lg border border-slate-200 max-h-[360px] bg-black"
              />
              <div className="flex flex-wrap gap-2 w-full">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  onClick={() => window.open(videoUrl, "_blank")}
                >
                  <Video className="w-3 h-3 mr-1" />
                  Preview Video
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  onClick={() => {
                    const a = document.createElement("a");
                    a.href = videoUrl;
                    a.download = `${content.title}.mp4`;
                    a.click();
                  }}
                >
                  <ExternalLink className="w-3 h-3 mr-1" />
                  Download MP4
                </Button>
                {isPremiumVideo && (
                  <Badge variant="outline" className="text-[10px] h-6 border-purple-200 text-purple-700 bg-purple-50">
                    Premium • {metadata?.videoCreditsCharged ?? 100} credits
                  </Badge>
                )}
                {!isPremiumVideo && (
                  <Badge variant="outline" className="text-[10px] h-6 border-amber-200 text-amber-700 bg-amber-50">
                    Basic Draft
                  </Badge>
                )}
              </div>
            </>
          )}

          {job && !videoUrl && (
            <div className="flex items-center gap-2">
              {job.renderStatus === "queued" && (
                <Badge variant="outline" className="text-blue-600 border-blue-200 bg-blue-50 text-[10px] h-6">
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  Queued
                </Badge>
              )}
              {job.renderStatus === "rendering" && (
                <Badge variant="outline" className="text-purple-600 border-purple-200 bg-purple-50 text-[10px] h-6">
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  Rendering
                </Badge>
              )}
              {job.renderStatus === "failed" && (
                <>
                  <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50 text-[10px] h-6">
                    <AlertCircle className="w-3 h-3 mr-1" />
                    Failed
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    onClick={() => renderVideoMutation.mutate({ contentPostId: content.id, mode: "premium" })}
                    disabled={renderVideoMutation.isPending}
                  >
                    Retry Premium
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px] border-amber-300 text-amber-700 hover:bg-amber-50"
                    onClick={() => renderVideoMutation.mutate({ contentPostId: content.id, mode: "basic" })}
                    disabled={renderVideoMutation.isPending}
                  >
                    Basic Draft
                  </Button>
                </>
              )}
              {(job.renderStatus === "queued" || job.renderStatus === "rendering") && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px]"
                  onClick={() => refreshVideoStatusMutation.mutate({ jobId: job.id })}
                  disabled={refreshVideoStatusMutation.isPending}
                >
                  <Loader2 className={`w-3 h-3 mr-1 ${refreshVideoStatusMutation.isPending ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              )}
            </div>
          )}
        </div>

        {!basicConfigured && !premiumConfigured && !videoUrl && (
          <p className="text-[10px] text-slate-400">
            Video rendering is not configured. This is a storyboard only.
          </p>
        )}
      </div>
    );
  }

  function isFailedAttempt(content: any): boolean {
    const meta = (content.metadata || {}) as any;
    return meta?.imageStatus === "failed" || meta?.videoStatus === "failed";
  }

  function renderMasterImageSection(content: any, compact = false, showCaptionPack = true, hero = false) {
    const metadata = (content.metadata || {}) as any;
    const imageUrl =
      metadata?.imageUrl ||
      metadata?.url ||
      content?.url ||
      getCampaignImageAssetUrl(campaignAssets);
    const imageStatus = metadata?.imageStatus;
    const isGeneratingBasic = isPending(content.id, "basic");
    const isGeneratingPremium = isPending(content.id, "premium");
    const isGenerating = imageStatus === "generating" || isGeneratingBasic || isGeneratingPremium;
    const isPremiumReady = premiumTemplateStatus?.ready === true;
    const isBasicDraftAsset = metadata?.imageSource === "draft" || (metadata?.imageCreditsCharged ?? 0) === 0;
    const isFailed = imageStatus === "failed";
    const isReady = !!imageUrl;
    const imageLoading = loadingImageIds.has(content.id);
    const imageBroken = brokenImageIds.has(content.id);
    const captionPack = campaignAssets?.find(
      (a) => a.assetType === "caption_pack" && (a.metadata as any)?.contentPostId === content.id
    );
    const creativeGuidance = creativeGuidanceById[content.id] || "";
    const refinementInstruction = refinementById[content.id] || "";
    const allowNoLogo = !!allowNoLogoById[content.id];

    const generateBasicDraft = () =>
      generateImageMutation.mutate({
        contentPostId: content.id,
        templateId: imageTemplateId === "auto" ? undefined : imageTemplateId,
        creativeGuidance: creativeGuidance.trim() || undefined,
        refinementInstruction: refinementInstruction.trim() || undefined,
        allowNoLogo,
      });

    const generatePremiumAi = (strongerBrandFit = false) =>
      generatePremiumLeafletMutation.mutate({
        contentPostId: content.id,
        templateId: imageTemplateId === "auto" ? undefined : imageTemplateId,
        provider: "ai",
        strongerBrandFit,
        creativeGuidance: creativeGuidance.trim() || undefined,
        refinementInstruction: refinementInstruction.trim() || undefined,
        allowNoLogo,
      });

    const generatePremiumInternal = (strongerBrandFit = false) =>
      generatePremiumLeafletMutation.mutate({
        contentPostId: content.id,
        templateId: imageTemplateId === "auto" ? undefined : imageTemplateId,
        provider: "internal",
        strongerBrandFit,
        creativeGuidance: creativeGuidance.trim() || undefined,
        refinementInstruction: refinementInstruction.trim() || undefined,
        allowNoLogo,
      });

    const generatePremiumExternal = (strongerBrandFit = false) =>
      generatePremiumLeafletMutation.mutate({
        contentPostId: content.id,
        templateId: imageTemplateId === "auto" ? undefined : imageTemplateId,
        provider: "external",
        strongerBrandFit,
        creativeGuidance: creativeGuidance.trim() || undefined,
        refinementInstruction: refinementInstruction.trim() || undefined,
        allowNoLogo,
      });

    const statusBadge = () => {
      if (isGenerating || imageLoading) {
        return (
          <Badge variant="outline" className="text-[10px] h-6 border-blue-200 text-blue-700 bg-blue-50 flex items-center gap-1">
            <Loader2 className="w-3 h-3 animate-spin" />
            Generating
          </Badge>
        );
      }
      if (isFailed || imageBroken) {
        return (
          <Badge variant="outline" className="text-[10px] h-6 border-red-200 text-red-700 bg-red-50">
            Failed
          </Badge>
        );
      }
      if (isReady) {
        return (
          <Badge variant="outline" className="text-[10px] h-6 border-emerald-200 text-emerald-700 bg-emerald-50 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" />
            Ready
          </Badge>
        );
      }
      return (
        <Badge variant="outline" className="text-[10px] h-6 text-slate-500">
          Not generated
        </Badge>
      );
    };

    return (
      <div className="mt-4 rounded-xl border border-slate-200 bg-white overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-slate-50/50">
          <div className="flex items-center gap-2">
            <Image className="w-5 h-5 text-[#00D4FF]" />
            <h3 className="text-sm font-semibold text-slate-900">Marketing Leaflet</h3>
            {statusBadge()}
          </div>
          <div className="flex items-center gap-2">
            {isReady && (
              <Badge
                variant="outline"
                className={`text-[10px] h-6 ${
                  metadata?.imageQualityTier === "draft" || metadata?.imageQualityTier === "failed"
                    ? "border-amber-300 text-amber-700 bg-amber-50"
                    : metadata?.imageQualityTier === "premium"
                    ? "border-emerald-200 text-emerald-700 bg-emerald-50"
                    : "border-blue-200 text-blue-700 bg-blue-50"
                }`}
              >
                {metadata?.imageQualityLabel ||
                  (metadata?.imageSource === "draft" || metadata?.imageFallbackUsed
                    ? "Basic Draft"
                    : metadata?.imageSource === "openai" || metadata?.imageProvider === "openai-leaflet"
                    ? "Premium AI"
                    : metadata?.imageSource === "premium"
                    ? "Premium Marketing Leaflet"
                    : "Generated")}
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px] h-6">
              {isFailed || imageBroken
                ? "No credits deducted"
                : (metadata?.imageCreditsCharged ?? 0) === 0
                ? "Free draft"
                : `${metadata.imageCreditsCharged} credits`}
            </Badge>
          </div>
        </div>

        {compact ? (
          <>
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Compact left: preview/state */}
              <div>
                {isGenerating ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 flex flex-col items-center justify-center min-h-[220px] text-center px-4">
                    <Loader2 className="w-8 h-8 text-[#00D4FF] animate-spin mb-2" />
                    <p className="text-sm font-medium text-slate-800">Generating your premium marketing leaflet</p>
                    <p className="text-xs text-slate-500 mt-1">No credits are deducted until the leaflet is ready.</p>
                  </div>
                ) : isFailed || imageBroken ? (
                  <div className="rounded-xl border border-red-200 bg-red-50 flex flex-col items-center justify-center min-h-[220px] text-center px-4">
                    <AlertCircle className="w-10 h-10 text-red-400 mb-2" />
                    <p className="text-sm font-medium text-red-800">Generation failed</p>
                    <p className="text-xs text-red-600 mt-1">No credits were deducted.</p>
                  </div>
                ) : isReady ? (
                  <div className="relative group overflow-hidden rounded-xl border border-slate-200 bg-slate-50 p-1.5">
                    {imageLoading && (
                      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-50">
                        <Loader2 className="w-6 h-6 text-[#00D4FF] animate-spin mb-1" />
                        <p className="text-[10px] text-slate-500">Loading preview…</p>
                      </div>
                    )}
                    <img
                      src={imageUrl}
                      alt="Premium marketing leaflet"
                      className={`w-full object-contain rounded-lg max-h-[260px] ${imageLoading ? "opacity-0" : "opacity-100"}`}
                      onLoad={() => {
                        setLoadingImageIds((prev) => {
                          const next = new Set(prev);
                          next.delete(content.id);
                          return next;
                        });
                      }}
                      onError={() => {
                        setLoadingImageIds((prev) => {
                          const next = new Set(prev);
                          next.delete(content.id);
                          return next;
                        });
                        setBrokenImageIds((prev) => new Set(prev).add(content.id));
                        console.error(`[PremiumLeaflet] Failed to load image preview | contentPostId=${content.id} | url=${imageUrl}`);
                      }}
                    />
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 flex flex-col items-center justify-center min-h-[220px] px-4 py-6 text-center">
                    <Image className="w-10 h-10 text-slate-300 mb-2" />
                    <p className="text-sm font-medium text-slate-800">Marketing leaflet not created yet</p>
                    <p className="text-xs text-slate-500 mt-1">Generate a Basic Draft or Premium leaflet.</p>
                  </div>
                )}
              </div>

              {/* Compact right: summary */}
              <div className="space-y-3">
                <div className="space-y-1">
                  <span className="text-xs text-slate-500">Headline</span>
                  <p className="font-medium text-sm line-clamp-2">{content.title || campaignForContext?.goal || "—"}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-slate-500">CTA</span>
                  <p className="font-medium text-sm line-clamp-2">{content.cta || campaignForContext?.preferredCta || "—"}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-slate-500">Template</span>
                  <p className="font-medium text-sm">
                    {LEAFLET_TEMPLATE_OPTIONS.find((o) => o.value === (metadata?.imageTemplateId || "auto"))?.label || "Auto-detect"}
                  </p>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-slate-500">Credits charged</span>
                  <p className="font-medium text-sm">
                    {(metadata?.imageCreditsCharged ?? 0) === 0 ? "0 (Basic Draft)" : `${metadata?.imageCreditsCharged} credits`}
                  </p>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-slate-500">Source / Quality</span>
                  <p className={`font-medium text-sm ${
                    metadata?.imageQualityTier === "draft" || metadata?.imageQualityTier === "failed"
                      ? "text-amber-700"
                      : metadata?.imageSource === "premium"
                      ? "text-emerald-700"
                      : "text-slate-700"
                  }`}>
                    {metadata?.imageQualityLabel ||
                      (metadata?.imageSource === "draft" || metadata?.imageFallbackUsed
                        ? "Basic Draft"
                        : metadata?.imageSource === "openai" || metadata?.imageProvider === "openai-leaflet"
                        ? "Premium AI"
                        : metadata?.imageSource === "premium"
                        ? "Premium Marketing Leaflet"
                        : "Not generated")}
                    {typeof metadata?.imageQualityScore === "number" && ` · ${metadata.imageQualityScore}/100`}
                  </p>
                </div>

                {openAiLeafletStatus?.configured === false && (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-left">
                    <p className="text-[11px] text-red-800 font-medium flex items-start gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      OpenAI API key is missing — Premium AI disabled.
                    </p>
                  </div>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  {isReady && (
                    <Button
                      size="sm"
                      className="h-8 text-[11px]"
                      onClick={() => {
                        const a = document.createElement("a");
                        a.href = imageUrl;
                        a.download = `${content.title || "campaign"}-image.${metadata?.imageExtension || "png"}`;
                        a.click();
                      }}
                    >
                      <ExternalLink className="w-3 h-3 mr-1" />
                      Download
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-[11px]"
                    onClick={() => generateBasicDraft()}
                    disabled={isGenerating}
                  >
                    {isGeneratingBasic ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Image className="w-3 h-3 mr-1" />}
                    {isReady || isFailed ? "Regenerate Basic Draft" : "Generate Basic Draft"}
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => generatePremiumAi(false)}
                    disabled={isGenerating || !openAiLeafletStatus?.configured}
                  >
                    {isGeneratingPremium ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Sparkles className="w-3 h-3 mr-1" />}
                    Regenerate Premium AI
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-[11px]"
                    onClick={() => generatePremiumInternal(false)}
                    disabled={isGenerating}
                  >
                    <Sparkles className="w-3 h-3 mr-1" />
                    Internal Premium
                  </Button>
                  {isPremiumReady && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-[11px]"
                      onClick={() => generatePremiumExternal(false)}
                      disabled={isGenerating}
                    >
                      <Sparkles className="w-3 h-3 mr-1" />
                      External Premium
                    </Button>
                  )}
                  {!captionPack && !isGenerating && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-[11px]"
                      onClick={() => generateCaptionPackMutation.mutate({ contentPostId: content.id })}
                      disabled={generateCaptionPackMutation.isPending}
                    >
                      {generateCaptionPackMutation.isPending ? (
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      ) : (
                        <MessageCircle className="w-3 h-3 mr-1" />
                      )}
                      Generate Caption Pack
                    </Button>
                  )}
                </div>
              </div>
            </div>
            {showCaptionPack && captionPack && (
              <div className="px-4 pb-4">
                {renderCaptionPack(captionPack, content.id)}
              </div>
            )}
          </>
        ) : (
          <div className={`p-5 grid grid-cols-1 gap-6 ${hero ? "xl:grid-cols-4" : "xl:grid-cols-3"}`}>
          {/* Main column: visual asset + caption pack */}
          <div className={hero ? "xl:col-span-3 space-y-6" : "xl:col-span-2 space-y-6"}>
            {isGenerating ? (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 flex flex-col items-center justify-center min-h-[380px] text-center px-6">
                <Loader2 className="w-10 h-10 text-[#00D4FF] animate-spin mb-3" />
                <p className="text-sm font-medium text-slate-800">Generating your premium marketing leaflet</p>
                <p className="text-xs text-slate-500 mt-1 max-w-sm">No credits are deducted until the leaflet is ready. This usually takes 20–45 seconds.</p>
              </div>
            ) : isFailed || imageBroken ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 flex flex-col items-center justify-center min-h-[380px] text-center px-6">
                <AlertCircle className="w-12 h-12 text-red-400 mb-3" />
                <p className="text-base font-medium text-red-800">We could not generate the premium leaflet</p>
                <p className="text-sm text-red-600 mt-1 max-w-md">
                  No credits were deducted. Please try again, or contact support if the issue continues.
                </p>
                {metadata?.imageError && typeof metadata.imageError === "string" && (
                  <p className="text-[10px] text-red-600 mt-3 font-mono bg-red-100/60 px-3 py-1.5 rounded max-w-full truncate">
                    {metadata.imageError}
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
                  <Button size="sm" className="bg-red-600 hover:bg-red-700 text-white" onClick={() => generateBasicDraft()} disabled={isGenerating}>
                    {isGeneratingBasic ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                    Retry Basic Draft
                  </Button>
                  <Button size="sm" variant="outline" className="border-red-300 text-red-700 hover:bg-red-50" onClick={() => generatePremiumAi(false)} disabled={isGenerating || !openAiLeafletStatus?.configured}>
                    {isGeneratingPremium ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                    Retry Premium AI
                  </Button>
                  <Button size="sm" variant="outline" className="border-red-300 text-red-700 hover:bg-red-50" onClick={() => generatePremiumInternal(false)} disabled={isGenerating}>
                    <Sparkles className="w-4 h-4 mr-2" />
                    Retry Internal
                  </Button>
                  {isPremiumReady && (
                    <Button size="sm" variant="outline" className="border-red-300 text-red-700 hover:bg-red-50" onClick={() => generatePremiumExternal(false)} disabled={isGenerating}>
                      <Sparkles className="w-4 h-4 mr-2" />
                      Retry External
                    </Button>
                  )}
                </div>
              </div>
            ) : isReady ? (
              <div className="relative group overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 p-2">
                {metadata?.imageFallbackMessage && typeof metadata.imageFallbackMessage === "string" && (
                  <div className="mb-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 flex items-start gap-2">
                    <Info className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
                    <p className="text-xs text-blue-800">{metadata.imageFallbackMessage}</p>
                  </div>
                )}
                {imageLoading && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-50">
                    <Loader2 className="w-8 h-8 text-[#00D4FF] animate-spin mb-2" />
                    <p className="text-xs text-slate-500">Loading preview…</p>
                  </div>
                )}
                <img
                  src={imageUrl}
                  alt="Premium marketing leaflet"
                  className={`w-full object-contain rounded-xl ${hero ? "max-h-[800px] min-h-[420px]" : "max-h-[640px]"} ${imageLoading ? "opacity-0" : "opacity-100"}`}
                  onLoad={() => {
                    setLoadingImageIds((prev) => {
                      const next = new Set(prev);
                      next.delete(content.id);
                      return next;
                    });
                  }}
                  onError={() => {
                    setLoadingImageIds((prev) => {
                      const next = new Set(prev);
                      next.delete(content.id);
                      return next;
                    });
                    setBrokenImageIds((prev) => new Set(prev).add(content.id));
                    console.error(`[PremiumLeaflet] Failed to load image preview | contentPostId=${content.id} | url=${imageUrl}`);
                  }}
                />
                <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 text-[11px]"
                    onClick={() => {
                      const a = document.createElement("a");
                      a.href = imageUrl;
                      a.download = `${content.title || "campaign"}-image.${metadata?.imageExtension || "png"}`;
                      a.click();
                    }}
                  >
                    <ExternalLink className="w-3 h-3 mr-1" />
                    Download Leaflet
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 flex flex-col items-center min-h-[380px] px-6 py-8">
                <div className="text-center">
                  <Image className="w-12 h-12 text-slate-300 mb-3 mx-auto" />
                  <p className="text-base font-medium text-slate-800">Marketing leaflet not created yet</p>
                  <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
                    Generate a Premium AI Leaflet ({aiCost} credits) for a polished, customer-ready visual, or start with a Basic Draft (0 credits) for a quick preview.
                    {isPremiumReady && ` External provider premium is also available (${externalCost} credits).`}
                  </p>
                </div>

                <div className="w-full max-w-lg mt-5 space-y-4">
                  <div className="text-left">
                    <Label className="text-xs font-medium text-slate-700">Template</Label>
                    <div className="grid grid-cols-2 gap-2 mt-1.5">
                      {LEAFLET_TEMPLATE_OPTIONS.map((opt) => {
                        const selected = imageTemplateId === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => setImageTemplateId(opt.value)}
                            className={`text-left rounded-lg border p-2.5 transition-colors ${
                              selected
                                ? "border-[#00D4FF] bg-[#00D4FF]/5 ring-1 ring-[#00D4FF]"
                                : "border-slate-200 bg-white hover:border-slate-300"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <opt.icon className={`w-4 h-4 shrink-0 ${selected ? "text-[#00D4FF]" : "text-slate-400"}`} />
                              {selected && <Check className="w-3.5 h-3.5 text-[#00D4FF]" />}
                            </div>
                            <p className="mt-1.5 text-xs font-medium text-slate-800">{opt.label}</p>
                            <p className="text-[10px] text-slate-500 leading-tight">{opt.description}</p>
                          </button>
                        );
                      })}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mt-2 text-[#00D4FF] hover:text-[#00D4FF]/80 hover:bg-[#00D4FF]/5"
                      onClick={() => setGalleryOpen(true)}
                    >
                      <LayoutGrid className="w-3.5 h-3.5 mr-1.5" />
                      Browse Template Gallery
                    </Button>
                  </div>

                  {!businessForLeaflet?.logo && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-left">
                      <p className="text-xs text-amber-800 font-medium flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        A business logo is required for the best brand fidelity.
                      </p>
                      <p className="text-[11px] text-amber-700 mt-1 ml-6">
                        Upload your logo in Settings, or generate below without it.
                      </p>
                      <div className="mt-2 ml-6 flex flex-wrap items-center gap-2">
                        <Link to="/settings">
                          <Button size="sm" variant="outline" className="h-7 text-[11px] border-amber-300 text-amber-800 hover:bg-amber-100">
                            Upload Logo in Settings
                          </Button>
                        </Link>
                        <label className="flex items-center gap-2 text-[11px] text-amber-800">
                          <input
                            type="checkbox"
                            className="rounded border-amber-300 text-amber-600 focus:ring-amber-500"
                            checked={allowNoLogo}
                            onChange={(e) =>
                              setAllowNoLogoById((prev) => ({ ...prev, [content.id]: e.target.checked }))
                            }
                          />
                          Generate anyway (generic colours may be used)
                        </label>
                      </div>
                    </div>
                  )}

                  {openAiLeafletStatus?.configured === false && (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-left">
                      <p className="text-xs text-red-800 font-medium flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        OpenAI API key is missing.
                      </p>
                      <p className="text-[11px] text-red-700 mt-1 ml-6">
                        Premium AI leaflet generation is disabled. Add OPENAI_API_KEY to your environment variables, or use Internal Premium as a fallback.
                      </p>
                    </div>
                  )}

                  <div className="text-left">
                    <Label htmlFor={`guidance-${content.id}`} className="text-xs font-medium text-slate-700">
                      Creative direction <span className="text-slate-400 font-normal">(optional)</span>
                    </Label>
                    <Textarea
                      id={`guidance-${content.id}`}
                      placeholder="e.g. Use a dark modern look, focus on courier speed, show African prints in the background"
                      className="mt-1.5 min-h-[72px] text-xs"
                      value={creativeGuidance}
                      onChange={(e) =>
                        setCreativeGuidanceById((prev) => ({ ...prev, [content.id]: e.target.value }))
                      }
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-center gap-3">
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-slate-300 text-slate-700 hover:bg-slate-50"
                      onClick={() => generateBasicDraft()}
                      disabled={isGenerating || (!businessForLeaflet?.logo && !allowNoLogo)}
                    >
                      {isGeneratingBasic ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Image className="w-4 h-4 mr-2" />}
                      Generate Basic Draft — 0 credits
                    </Button>
                    <Button
                      size="sm"
                      className="bg-emerald-600 hover:bg-emerald-700 text-white"
                      onClick={() => generatePremiumAi(false)}
                      disabled={isGenerating || (!businessForLeaflet?.logo && !allowNoLogo) || !openAiLeafletStatus?.configured}
                    >
                      {isGeneratingPremium ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                      Generate Premium AI Leaflet — {aiCost} credits
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => generatePremiumInternal(false)}
                      disabled={isGenerating || (!businessForLeaflet?.logo && !allowNoLogo)}
                    >
                      <Sparkles className="w-4 h-4 mr-2" />
                      Internal Premium — {internalCost} credits
                    </Button>
                    {isPremiumReady && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => generatePremiumExternal(false)}
                        disabled={isGenerating || (!businessForLeaflet?.logo && !allowNoLogo)}
                      >
                        <Sparkles className="w-4 h-4 mr-2" />
                        External Provider — {externalCost} credits
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}
            {showCaptionPack && captionPack && renderCaptionPack(captionPack, content.id)}
          </div>

          {/* Sidebar: leaflet details, attempts, refinement, actions */}
          <div className="xl:col-span-1 space-y-5">
            <Card className="border-slate-200">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">Leaflet Details</CardTitle>
                  {isFailedAttempt(content) && (
                    <Badge variant="outline" className="text-[10px] h-6 border-amber-200 text-amber-700 bg-amber-50">
                      Previous successful version
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3.5 text-sm">
                <div className="space-y-1">
                  <span className="text-xs text-slate-500">Headline</span>
                  <p className="font-medium text-sm line-clamp-2">{content.title || campaignForContext?.goal || "—"}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-slate-500">CTA</span>
                  <p className="font-medium text-sm line-clamp-2">{content.cta || campaignForContext?.preferredCta || "—"}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-slate-500">Business</span>
                  <p className="font-medium text-sm line-clamp-1">{businessForLeaflet?.name || "—"}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-slate-500">Logo</span>
                  <div className="font-medium">
                    {businessForLeaflet?.logo ? (
                      <img
                        src={businessForLeaflet.logo}
                        alt="Business logo"
                        className="h-8 w-auto max-w-[120px] object-contain border rounded bg-white px-1 py-0.5"
                      />
                    ) : (
                      <Link to="/settings" className="text-amber-700 underline text-[10px]">
                        Upload logo
                      </Link>
                    )}
                  </div>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-slate-500">Template</span>
                  <p className="font-medium text-sm">
                    {LEAFLET_TEMPLATE_OPTIONS.find((o) => o.value === (metadata?.imageTemplateId || "auto"))?.label || "Auto-detect"}
                  </p>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-slate-500">Credits charged</span>
                  <p className="font-medium text-sm">
                    {(metadata?.imageCreditsCharged ?? 0) === 0 ? "0 (Basic Draft)" : `${metadata?.imageCreditsCharged} credits`}
                  </p>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-slate-500">Source</span>
                  <p className={`font-medium text-sm ${
                    metadata?.imageQualityTier === "draft" || metadata?.imageQualityTier === "failed"
                      ? "text-amber-700"
                      : metadata?.imageSource === "premium"
                      ? "text-emerald-700"
                      : "text-slate-700"
                  }`}>
                    {metadata?.imageQualityLabel ||
                      (metadata?.imageSource === "draft" || metadata?.imageFallbackUsed
                        ? "Basic Draft"
                        : metadata?.imageSource === "openai" || metadata?.imageProvider === "openai-leaflet"
                        ? "Premium AI"
                        : metadata?.imageSource === "premium"
                        ? "Premium Marketing Leaflet"
                        : "Generated")}
                  </p>
                </div>
                {typeof metadata?.imageQualityScore === "number" && (
                  <div className="space-y-1">
                    <span className="text-xs text-slate-500">Quality score</span>
                    <p className={`font-medium text-sm ${
                      metadata.imageQualityTier === "premium"
                        ? "text-emerald-700"
                        : metadata.imageQualityTier === "acceptable"
                        ? "text-blue-700"
                        : "text-amber-700"
                    }`}>
                      {metadata.imageQualityScore}/100 — {metadata.imageQualityLabel || "Draft"}
                    </p>
                  </div>
                )}
                {metadata?.imageGeneratedAt && (
                  <div className="space-y-1">
                    <span className="text-xs text-slate-500">Generated</span>
                    <p className="font-medium text-sm">
                      {new Date(metadata.imageGeneratedAt).toLocaleString()}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {Array.isArray(metadata?.imageAttempts) && metadata.imageAttempts.length > 0 && (
              <details className="rounded-lg border border-slate-200 bg-slate-50 text-xs group">
                <summary className="cursor-pointer list-none px-3 py-2.5 flex items-center justify-between select-none">
                  <span className="font-medium text-slate-700">Generation attempts</span>
                  <span className="transition-transform group-open:rotate-180">
                    <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                  </span>
                </summary>
                <div className="px-3 pb-3 space-y-2 border-t border-slate-100 pt-2">
                  {metadata.imageAttempts.map((attempt: any, idx: number) => (
                    <div key={idx} className="rounded-md bg-white border border-slate-200 p-2.5">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="font-medium text-slate-800">
                          {attempt.source === "fallback" ? "Fallback" : `OpenAI attempt ${attempt.number}`}
                        </span>
                        <Badge
                          variant="outline"
                          className={`text-[10px] h-5 ${attempt.passed ? "border-emerald-200 text-emerald-700 bg-emerald-50" : "border-red-200 text-red-700 bg-red-50"}`}
                        >
                          {attempt.score}/100
                        </Badge>
                      </div>
                      {attempt.criticalFailures?.length > 0 && (
                        <div className="mt-1.5">
                          <span className="text-[10px] font-medium text-red-700">Critical failures:</span>
                          <ul className="mt-0.5 list-disc list-inside text-[10px] text-red-700">
                            {attempt.criticalFailures.map((issue: string, i: number) => (
                              <li key={i}>{issue}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {attempt.warnings?.length > 0 && (
                        <div className="mt-1.5">
                          <span className="text-[10px] font-medium text-amber-700">Warnings:</span>
                          <ul className="mt-0.5 list-disc list-inside text-[10px] text-amber-700">
                            {attempt.warnings.map((issue: string, i: number) => (
                              <li key={i}>{issue}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {attempt.storedUrl && (
                        <a
                          href={attempt.storedUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-blue-600 hover:underline"
                        >
                          <ExternalLink className="w-3 h-3" />
                          View raw attempt
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {isReady && (
              <div className="rounded-lg border border-purple-200 bg-gradient-to-r from-purple-50 to-white p-3 space-y-3 shadow-sm">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-purple-900 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-purple-600" />
                    {isBasicDraftAsset ? "Draft Refinement" : "Premium Refinement"}
                  </h4>
                  <Badge variant="outline" className="text-[10px] h-5">
                    {internalCost} credits
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {TEMPLATE_REFINEMENT_CHIPS[imageTemplateId].map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      className="text-[10px] px-2 py-1 rounded-full border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-800 transition-colors"
                      onClick={() =>
                        setRefinementById((prev) => ({
                          ...prev,
                          [content.id]: prev[content.id] ? `${prev[content.id]}. ${chip}` : chip,
                        }))
                      }
                    >
                      {chip}
                    </button>
                  ))}
                </div>
                <Textarea
                  placeholder="Tell the AI what to change, e.g. 'Use a darker background and put more emphasis on the courier service'"
                  className="min-h-[72px] text-xs"
                  value={refinementInstruction}
                  onChange={(e) =>
                    setRefinementById((prev) => ({ ...prev, [content.id]: e.target.value }))
                  }
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 h-8 text-[11px] border-slate-300 text-slate-700 hover:bg-slate-50"
                    onClick={() => generateBasicDraft()}
                    disabled={isGenerating || !refinementInstruction.trim()}
                  >
                    {isGeneratingBasic ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
                    Refine Basic Draft
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1 h-8 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => generatePremiumAi(true)}
                    disabled={isGenerating || !refinementInstruction.trim() || !openAiLeafletStatus?.configured}
                  >
                    {isGeneratingPremium ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
                    Premium AI + Stronger Brand Fit
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {isReady && (
                <Button
                  size="sm"
                  className="w-full h-8 text-[12px]"
                  onClick={() => {
                    const a = document.createElement("a");
                    a.href = imageUrl;
                    a.download = `${content.title || "campaign"}-image.${metadata?.imageExtension || "png"}`;
                    a.click();
                  }}
                >
                  <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                  Download Leaflet
                </Button>
              )}
              {openAiLeafletStatus?.configured === false && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-left">
                  <p className="text-xs text-red-800 font-medium flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    OpenAI API key is missing.
                  </p>
                  <p className="text-[11px] text-red-700 mt-1 ml-6">
                    Premium AI leaflet generation is disabled. Add OPENAI_API_KEY to your environment variables, or use Internal Premium as a fallback.
                  </p>
                </div>
              )}
              {(isReady || isFailed) && !isGenerating && (
                <>
                  <Button size="sm" variant="outline" className="w-full h-8 text-[12px]" onClick={() => generateBasicDraft()} disabled={isGenerating}>
                    {isGeneratingBasic ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Image className="w-3.5 h-3.5 mr-1.5" />}
                    Regenerate Basic Draft
                  </Button>
                  <Button size="sm" className="w-full h-8 text-[12px] bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => generatePremiumAi(false)} disabled={isGenerating || !openAiLeafletStatus?.configured}>
                    {isGeneratingPremium ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
                    Regenerate Premium AI Leaflet
                  </Button>
                  <Button size="sm" variant="outline" className="w-full h-8 text-[12px]" onClick={() => generatePremiumInternal(false)} disabled={isGenerating}>
                    <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                    Regenerate Internal Premium
                  </Button>
                  {isPremiumReady && (
                    <Button size="sm" variant="outline" className="w-full h-8 text-[12px]" onClick={() => generatePremiumExternal(false)} disabled={isGenerating}>
                      <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                      Regenerate External Premium
                    </Button>
                  )}
                </>
              )}
              {!captionPack && !isGenerating && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full h-8 text-[12px]"
                  onClick={() => generateCaptionPackMutation.mutate({ contentPostId: content.id })}
                  disabled={generateCaptionPackMutation.isPending}
                >
                  {generateCaptionPackMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <MessageCircle className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  Generate Caption Pack
                </Button>
              )}
            </div>
            <LeafletVersionHistory contentPostId={content.id} metadata={metadata} />

            {!businessForLeaflet?.logo && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
                <p className="text-[11px] text-amber-700">
                  Tip: Add your logo in{" "}
                  <Link to="/settings" className="font-medium underline">
                    Settings
                  </Link>{" "}
                  to improve brand accuracy.
                </p>
              </div>
            )}
            {businessForLeaflet?.logo && (
              <p className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md p-2.5">
                Your uploaded logo and brand colours are used for the final layout. Premium uses NatForgeAI AI Leaflet generation with your real logo, brand colours, offer, CTA and contact details. Internal templates are available as fallback.
              </p>
            )}
          </div>
        </div>
      )}


      <PremiumTemplateGallery
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        templates={internalTemplates}
        selectedId={imageTemplateId === "auto" ? internalTemplates.find((t) => t.autoSelected)?.id || "service_business_promo" : imageTemplateId}
        onSelect={(id) => setImageTemplateId(id as LeafletTemplateId)}
        internalCost={internalCost}
        externalCost={externalCost}
        aiCost={aiCost}
        externalReady={isPremiumReady}
        aiReady={openAiLeafletStatus?.configured === true}
        onGenerateInternal={() => {
          setGalleryOpen(false);
          generatePremiumInternal(false);
        }}
        onGenerateExternal={
          isPremiumReady
            ? () => {
                setGalleryOpen(false);
                generatePremiumExternal(false);
              }
            : undefined
        }
        onGenerateAi={
          openAiLeafletStatus?.configured === true
            ? () => {
                setGalleryOpen(false);
                generatePremiumAi(false);
              }
            : undefined
        }
        isGenerating={isGenerating}
      />
      </div>
    );
  }

  function renderCaptionPack(asset: any, contentPostId: number) {
    const md = (asset.metadata || {}) as any;
    const pack = md.captionPack || md;

    const formatArray = (value: unknown): string | undefined => {
      if (Array.isArray(value)) {
        const text = value.map((v) => (typeof v === "string" ? v : v?.text)).filter(Boolean).join("\n");
        return text || undefined;
      }
      if (typeof value === "string" && value.trim().length > 0) return value;
      return undefined;
    };

    const emailParts = [
      pack?.emailSubject,
      pack?.emailPreheader,
      pack?.emailBody,
    ].filter((v) => typeof v === "string" && v.trim().length > 0);
    const emailText = emailParts.length > 0 ? emailParts.join("\n\n") : undefined;

    const sections = (
      [
        { key: "masterCaption", label: "Master Social Media Caption", text: pack?.masterCaption },
        { key: "linkedinCaption", label: "LinkedIn Caption", text: pack?.linkedinCaption },
        { key: "facebookCaption", label: "Facebook Caption", text: pack?.facebookCaption },
        { key: "instagramCaption", label: "Instagram Caption", text: pack?.instagramCaption },
        { key: "whatsappCaption", label: "WhatsApp Message", text: pack?.whatsappCaption },
        { key: "email", label: "Email Subject + Body", text: emailText },
        { key: "hashtags", label: "Hashtag Pack", text: formatArray(pack?.hashtags) },
        { key: "ctaVariations", label: "CTA Variations", text: formatArray(pack?.ctaVariations ?? pack?.ctaVariants) },
        { key: "outreachDm", label: "Outreach DM", text: pack?.outreachDm },
      ] as { key: string; label: string; text?: string }[]
    ).filter((s): s is { key: string; label: string; text: string } =>
      typeof s.text === "string" && s.text.trim().length > 0
    );

    if (!sections.length) return null;

    const copyText = sections.map((s) => `**${s.label}**\n${s.text}`).join("\n\n");

    return (
      <Card className="overflow-hidden">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-purple-600" />
              Caption Pack
            </CardTitle>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => {
                  navigator.clipboard.writeText(copyText);
                  toast.success("Caption pack copied.");
                }}
              >
                <Copy className="w-3.5 h-3.5 mr-1.5" />
                Copy All
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => generateCaptionPackMutation.mutate({ contentPostId })}
                disabled={generateCaptionPackMutation.isPending}
              >
                {generateCaptionPackMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
                Regenerate
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <Tabs value={captionPackTab} onValueChange={setCaptionPackTab} className="w-full">
            <TabsList className="w-full justify-start flex-wrap h-auto gap-1 bg-slate-50 p-1 rounded-lg mb-4">
              {sections.map((s) => (
                <TabsTrigger
                  key={s.key}
                  value={s.key}
                  className="text-xs px-3 py-1.5 data-[state=active]:bg-white data-[state=active]:shadow-sm"
                >
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {sections.map((s) => (
              <TabsContent key={s.key} value={s.key} className="mt-0">
                <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">{s.label}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs px-2 text-slate-500 hover:text-slate-800"
                      onClick={() => {
                        navigator.clipboard.writeText(s.text);
                        toast.success(`${s.label} copied.`);
                      }}
                    >
                      <Copy className="w-3.5 h-3.5 mr-1.5" />
                      Copy
                    </Button>
                  </div>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{s.text}</p>
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>
    );
  }

  function renderCarouselBlueprint(content: any) {
    const metadata = (content.metadata || {}) as any;
    if (!metadata?.slides?.length) return null;
    return (
      <div className="mt-3 p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Carousel Structure</span>
          <span className="text-[10px] text-slate-500">{metadata.slides.length} slides</span>
        </div>
        <div className="space-y-1.5">
          {metadata.slides.map((slide: any, i: number) => (
            <div key={i} className="flex gap-2 text-xs">
              <span className="shrink-0 w-5 h-5 rounded bg-orange-500/10 text-orange-600 flex items-center justify-center font-bold text-[10px]">
                {slide.slideNumber || i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-slate-700 font-medium truncate">{slide.headline}</p>
                <p className="text-slate-500 truncate">{slide.visualDirection}</p>
              </div>
            </div>
          ))}
        </div>
        {metadata.benefitSequence && (
          <p className="text-[10px] text-slate-500">Sequence: {metadata.benefitSequence}</p>
        )}
      </div>
    );
  }

  function renderPremiumBadges(content: any) {
    const metadata = (content.metadata || {}) as any;
    if (!metadata) return null;
    const basicConfigured = videoConfig?.basicConfigured ?? true;
    const premiumConfigured = videoConfig?.premiumConfigured ?? false;
    const videoEnabled = (ENABLE_PREMIUM_VIDEO && premiumConfigured) || (ENABLE_BASIC_DRAFT_VIDEO && basicConfigured);
    return (
      <div className="flex flex-wrap gap-1.5 mt-2">
        {metadata.funnelStage && (
          <Badge variant="outline" className="text-[10px] h-5 border-slate-200 text-slate-600">
            {metadata.funnelStage}
          </Badge>
        )}
        {metadata.targetPersona && (
          <Badge variant="outline" className="text-[10px] h-5 border-slate-200 text-slate-600">
            {metadata.targetPersona}
          </Badge>
        )}
        {metadata.salesAngle && (
          <Badge variant="outline" className="text-[10px] h-5 border-amber-200 text-amber-600">
            {metadata.salesAngle}
          </Badge>
        )}
        {videoEnabled && metadata.assetKind === "master_video_ad" && metadata.videoStatus === "concept" && (
          <Badge variant="outline" className="text-[10px] h-5 border-amber-200 text-amber-600 bg-amber-50">
            Storyboard
          </Badge>
        )}
        {videoEnabled && metadata.assetKind === "master_video_ad" && metadata.videoStatus === "rendering" && (
          <Badge variant="outline" className="text-[10px] h-5 border-purple-200 text-purple-600 bg-purple-50">
            Rendering
          </Badge>
        )}
        {videoEnabled && metadata.assetKind === "master_video_ad" && metadata.videoStatus === "ready" && metadata.videoUrl && (
          <Badge variant="outline" className={`text-[10px] h-5 ${metadata.isPremiumVideo ? "border-purple-200 text-purple-600 bg-purple-50" : "border-amber-200 text-amber-600 bg-amber-50"}`}>
            {metadata.isPremiumVideo ? "Premium Video" : "Basic Draft"}
          </Badge>
        )}
        {metadata.assetKind === "master_campaign_post" && metadata.imageStatus === "generating" && (
          <Badge variant="outline" className="text-[10px] h-5 border-purple-200 text-purple-600 bg-purple-50">
            Generating leaflet…
          </Badge>
        )}
        {metadata.assetKind === "master_campaign_post" && metadata.imageStatus === "ready" && metadata.imageUrl && (
          <Badge variant="outline" className={`text-[10px] h-5 ${metadata?.imageSource === "draft" || metadata?.isDraft ? "border-amber-200 text-amber-600 bg-amber-50" : "border-emerald-200 text-emerald-600 bg-emerald-50"}`}>
            {metadata?.imageSource === "draft" || metadata?.isDraft
              ? "Marketing Draft"
              : metadata?.imageProvider === "openai-leaflet"
              ? "Premium AI"
              : "Premium Marketing Leaflet"}
          </Badge>
        )}
      </div>
    );
  }

  function renderContentActions(content: any) {
    const approved = getApprovalState(content);
    const connected = isPlatformConnected(content.platform);
    const captionText = getCaptionText(content);
    const platformRequiresConnection = content.platform && ["facebook", "instagram", "linkedin", "tiktok", "twitter", "whatsapp"].includes(content.platform);
    const showConnectGuard = platformRequiresConnection && !connected;
    const meta = (content.metadata || {}) as any;
    const basicConfigured = videoConfig?.basicConfigured ?? true;
    const premiumConfigured = videoConfig?.premiumConfigured ?? false;
    const videoEnabled = (ENABLE_PREMIUM_VIDEO && premiumConfigured) || (ENABLE_BASIC_DRAFT_VIDEO && basicConfigured);
    const isVideo = content.type === "video_concept" || content.type === "reel_script";
    const videoReady = isVideo && meta.videoStatus === "ready" && meta.videoUrl;
    const videoBlocked = videoEnabled && isVideo && !videoReady;

    return (
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!approved && content.status !== "published" && !videoBlocked && (
          <Button
            size="sm"
            className="h-8 bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={() => handleApprove(content.id)}
            disabled={isPending(content.id, "approve")}
          >
            {isPending(content.id, "approve") ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />}
            Approve
          </Button>
        )}
        {videoBlocked && (
          <span className="text-[11px] text-slate-400">Approve disabled until video is rendered</span>
        )}

        <Button
          size="sm"
          variant="outline"
          className="h-8"
          onClick={() => copyToClipboard(captionText, content.id)}
        >
          {copiedId === content.id ? (
            <Check className="w-3.5 h-3.5 mr-1.5" />
          ) : (
            <Copy className="w-3.5 h-3.5 mr-1.5" />
          )}
          Copy caption
        </Button>

        {content.status !== "published" && content.status !== "archived" && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => openSchedule(content.id, content.scheduledFor)}
              disabled={isPending(content.id, "schedule")}
            >
              <CalendarClock className="w-3.5 h-3.5 mr-1.5" />
              {content.status === "scheduled" ? "Reschedule" : "Schedule"}
            </Button>

            {showConnectGuard ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() => handleMarkPosted(content.id)}
                disabled={isPending(content.id, "markPosted")}
              >
                {isPending(content.id, "markPosted") ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Upload className="w-3.5 h-3.5 mr-1.5" />}
                Mark as posted
              </Button>
            ) : connected ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() => handlePublishNow(content)}
              >
                <Upload className="w-3.5 h-3.5 mr-1.5" />
                Publish now
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() => handleMarkPosted(content.id)}
                disabled={isPending(content.id, "markPosted")}
              >
                {isPending(content.id, "markPosted") ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Upload className="w-3.5 h-3.5 mr-1.5" />}
                Mark as posted
              </Button>
            )}
          </>
        )}

        {content.platform && (
          <span className="ml-auto text-xs text-muted-foreground capitalize">
            {content.platform}
          </span>
        )}
      </div>
    );
  }

  function renderContentCard(content: any) {
    const approved = getApprovalState(content);
    const showConnectGuard = content.platform && ["facebook", "instagram", "linkedin", "tiktok", "twitter", "whatsapp"].includes(content.platform) && !isPlatformConnected(content.platform);
    const isMasterCampaignPost = (content.metadata as any)?.assetKind === "master_campaign_post";

    return (
      <Card key={content.id} className="group hover:shadow-lg transition-all">
        <CardContent className="p-5">
          {isMasterCampaignPost && renderMasterImageSection(content, true)}

          <div className="flex items-start justify-between mb-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="secondary"
                className={typeColors[content.type] || "bg-muted"}
              >
                {content.type.replace("_", " ")}
              </Badge>
              {content.aiGenerated && (
                <Badge variant="outline" className="flex items-center gap-1">
                  <Sparkles className="w-3 h-3" />
                  AI
                </Badge>
              )}
              <Badge
                variant="outline"
                className={statusColors[content.status] || statusColors.draft}
              >
                {content.status}
              </Badge>
              {approved && (
                <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" />
                  Approved
                </Badge>
              )}
              {(() => {
                const publishStatus = getContentPublishStatus(content.id);
                if (!publishStatus) return null;
                if (publishStatus.status === "published") {
                  return (
                    <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" />
                      Published
                    </Badge>
                  );
                }
                if (publishStatus.status === "failed") {
                  return (
                    <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 flex items-center gap-1" title={publishStatus.error}>
                      <AlertCircle className="w-3 h-3" />
                      Publishing failed
                    </Badge>
                  );
                }
                if (["approved", "retrying"].includes(publishStatus.status)) {
                  return (
                    <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Publishing in progress
                    </Badge>
                  );
                }
                if (publishStatus.status === "pending_approval") {
                  return (
                    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Publishing pending
                    </Badge>
                  );
                }
                return null;
              })()}
              {isFailedAttempt(content) && (
                <Badge variant="outline" className="text-[10px] h-6 border-red-200 text-red-700 bg-red-50">
                  <AlertCircle className="w-3 h-3 mr-1" />
                  Previous failed attempt
                </Badge>
              )}
            </div>
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() =>
                  copyToClipboard(getCaptionText(content), content.id)
                }
                title="Copy caption"
              >
                {copiedId === content.id ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-red-500 hover:text-red-600"
                onClick={() => deleteMutation.mutate({ id: content.id })}
                title="Delete"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

          <h3 className="font-semibold text-sm mb-2 text-slate-900">{content.title}</h3>
          {content.hook && (
            <p className="text-sm text-muted-foreground line-clamp-1 mb-1">
              <span className="font-medium text-foreground">Hook:</span>{" "}
              {content.hook}
            </p>
          )}
          {(() => {
            const captionPackCaption = getCaptionPackCaption(content);
            if (captionPackCaption) {
              return (
                <div className="mb-1">
                  <span className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wide">Caption Pack</span>
                  <p className="text-sm text-muted-foreground line-clamp-2">{captionPackCaption}</p>
                </div>
              );
            }
            return content.caption ? (
              <p className="text-sm text-muted-foreground line-clamp-2 mb-1">{content.caption}</p>
            ) : null;
          })()}
          {content.cta && (
            <p className="text-xs font-medium text-[#00D4FF] mt-1">
              CTA: {content.cta}
            </p>
          )}

          {renderPremiumBadges(content)}

          {content.type === "video_concept" && renderVideoBlueprint(content)}
          {content.type === "reel_script" && renderVideoBlueprint(content)}
          {content.type === "carousel_ad" && renderCarouselBlueprint(content)}

          {showConnectGuard && (
            <div className="mt-3 p-2.5 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-medium">Publishing setup required</p>
                <p className="text-amber-700/80">
                  Connect {content.platform} in Integrations to publish automatically, or mark as manually posted.
                </p>
                <div className="mt-2 flex gap-2">
                  {isPlatformConfigurable(content.platform) ? (
                    <Link to="/integrations">
                      <Button size="sm" variant="outline" className="h-7 text-xs">
                        <ExternalLink className="w-3 h-3 mr-1" />
                        Connect {content.platform}
                      </Button>
                    </Link>
                  ) : (
                    <span className="text-[11px] text-amber-700/70">Admin needs to configure this platform before it can be connected.</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {renderContentActions(content)}
        </CardContent>
      </Card>
    );
  }

  function renderCampaignAssetCard(asset: any) {
    const meta = (asset.metadata || {}) as any;
    return (
      <Card key={asset.id} className="hover:shadow-md transition-all">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="secondary" className="capitalize">
              {asset.assetType.replace(/_/g, " ")}
            </Badge>
            {asset.status && (
              <Badge variant="outline" className="text-[10px] h-5">
                {asset.status}
              </Badge>
            )}
          </div>
          <h4 className="text-sm font-semibold text-slate-900 mb-1">{asset.title}</h4>

          {meta.adaptedCaption && (
            <p className="text-xs text-muted-foreground line-clamp-3">{meta.adaptedCaption}</p>
          )}
          {meta.message && <p className="text-xs text-muted-foreground line-clamp-3">{meta.message}</p>}
          {meta.body && <p className="text-xs text-muted-foreground line-clamp-3">{meta.body}</p>}
          {meta.content && <p className="text-xs text-muted-foreground line-clamp-3">{meta.content}</p>}

          {meta.adaptedCta && <p className="text-xs font-medium text-[#00D4FF] mt-1">CTA: {meta.adaptedCta}</p>}
          {meta.cta && <p className="text-xs font-medium text-[#00D4FF] mt-1">CTA: {meta.cta}</p>}

          {meta.adaptedHashtags && Array.isArray(meta.adaptedHashtags) && (
            <p className="text-[10px] text-muted-foreground mt-1">{meta.adaptedHashtags.join(" ")}</p>
          )}

          {meta.variations && Array.isArray(meta.variations) && (
            <div className="mt-2 space-y-1.5">
              {meta.variations.slice(0, 4).map((v: any, i: number) => (
                <div key={i} className="text-xs text-slate-700 bg-slate-50 rounded p-2">
                  {typeof v === "string" ? v : v.headline ? `${v.headline}: ${v.primaryText || v.text || ""}` : JSON.stringify(v)}
                </div>
              ))}
              {meta.variations.length > 4 && (
                <p className="text-[10px] text-muted-foreground">+{meta.variations.length - 4} more</p>
              )}
            </div>
          )}

          {meta.slides && Array.isArray(meta.slides) && (
            <div className="mt-2 space-y-1">
              {meta.slides.map((slide: any, i: number) => (
                <div key={i} className="flex gap-2 text-xs">
                  <span className="shrink-0 w-5 h-5 rounded bg-orange-500/10 text-orange-600 flex items-center justify-center font-bold text-[10px]">
                    {slide.slideNumber || i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-slate-700 font-medium truncate">{slide.headline}</p>
                    <p className="text-slate-500 truncate">{slide.visualDirection}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {meta.sequenceSteps && Array.isArray(meta.sequenceSteps) && (
            <div className="mt-2 space-y-1">
              {meta.sequenceSteps.map((step: any, i: number) => (
                <div key={i} className="text-xs text-slate-700 bg-slate-50 rounded p-2">
                  <span className="font-medium">Step {step.stepNumber}</span> ({step.channel}, {step.timing}): {step.message}
                </div>
              ))}
            </div>
          )}

          {meta.hooks && Array.isArray(meta.hooks) && (
            <div className="mt-2 space-y-1">
              {meta.hooks.slice(0, 5).map((hook: any, i: number) => (
                <div key={i} className="text-xs text-slate-700 bg-slate-50 rounded p-2">
                  {hook.text || hook}
                </div>
              ))}
            </div>
          )}

          {meta.ctaVariations && Array.isArray(meta.ctaVariations) && (
            <div className="mt-2 space-y-1">
              {meta.ctaVariations.slice(0, 5).map((cta: any, i: number) => (
                <div key={i} className="text-xs text-slate-700 bg-slate-50 rounded p-2">
                  {cta.text || cta}
                </div>
              ))}
            </div>
          )}

          {meta.formatNotes && <p className="text-[10px] text-slate-500 mt-1">{meta.formatNotes}</p>}

          {asset.prompt && (
            <p className="text-[10px] text-slate-500 mt-1 line-clamp-2">Prompt: {asset.prompt}</p>
          )}
        </CardContent>
      </Card>
    );
  }

  // Campaign Pack grouping
  function toggleSection(key: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function SectionHeader({ title, icon: Icon, color, sectionKey, count }: { title: string; icon: any; color: string; sectionKey: string; count?: number }) {
    const isOpen = expandedSections.has(sectionKey);
    return (
      <CollapsibleTrigger asChild>
        <button
          className="flex items-center justify-between w-full text-left group"
        >
          <h3 className={`text-sm font-semibold flex items-center gap-2 ${color}`}>
            <Icon className="w-4 h-4" />
            {title}
            {count !== undefined && count > 1 && (
              <span className="text-xs font-normal text-muted-foreground">({count})</span>
            )}
          </h3>
          {isOpen ? (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          )}
        </button>
      </CollapsibleTrigger>
    );
  }

  type PlatformPublishStatus = "connected" | "not_connected" | "manual" | "not_supported";

  function getPlatformPublishStatus(platform: string): PlatformPublishStatus {
    const normalized = platform.toLowerCase().trim();

    if (normalized === "google ads" || normalized === "google_ads") {
      return "not_supported";
    }

    const autoPublishPlatforms = ["facebook", "instagram", "linkedin"];
    const isAutoPublishPlatform = autoPublishPlatforms.includes(normalized);
    const connected = isPlatformConnected(normalized);
    const configurable = isPlatformConfigurable(normalized);

    if (isAutoPublishPlatform) {
      if (connected && configurable) return "connected";
      if (connected && !configurable) return "manual";
      return "not_connected";
    }

    // TikTok, X/Twitter, WhatsApp, Email, Blog, etc.
    return "manual";
  }

  function getCampaignPlatformStatuses(): { platform: string; status: PlatformPublishStatus }[] {
    const raw = campaignForContext?.platforms || "";
    const selected = raw
      .split(/[,;]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    return selected.map((p) => ({ platform: p, status: getPlatformPublishStatus(p) }));
  }

  function handlePublishPack() {
    const publishable = filtered?.filter((c) => c.status !== "published" && c.status !== "archived") || [];
    if (publishable.length === 0) {
      toast.info("All items are already published or archived.");
      return;
    }

    setIsRepublish(campaignForContext?.workflowState === "campaign_live");

    // Frontend guard: check video readiness ONLY when video features are enabled
    const basicConfigured = videoConfig?.basicConfigured ?? true;
    const premiumConfigured = videoConfig?.premiumConfigured ?? false;
    const videoEnabled = (ENABLE_PREMIUM_VIDEO && premiumConfigured) || (ENABLE_BASIC_DRAFT_VIDEO && basicConfigured);
    if (videoEnabled) {
      const videos = filtered?.filter((c) => c.type === "video_concept" || c.type === "reel_script") || [];
      for (const v of videos) {
        const meta = (v.metadata || {}) as any;
        if (meta.videoStatus === "concept" || meta.videoStatus === "rendering") {
          toast.error("This campaign contains a video concept only. Render the video before publishing.");
          return;
        }
        if (meta.videoStatus === "ready" && !meta.videoUrl) {
          toast.error("This campaign contains a video concept only. Render the video before publishing.");
          return;
        }
        if (meta.videoStatus === "failed") {
          toast.error("Video rendering failed. Retry rendering or remove the video before publishing.");
          return;
        }
      }
    }

    setPublishDialogOpen(true);
  }

  function executePublishPack() {
    if (!urlCampaignId) return;
    publishCampaignPackMutation.mutate({ campaignId: numericCampaignId, allowRepublish: isRepublish });
  }

  function renderWorkflowGuidance() {
    if (!campaignForContext) return null;

    let state = campaignForContext.workflowState || "strategy_pending";
    const hasGeneratedContent = campaignHasGeneratedContent({
      postCount: postCountForCampaign,
      contents,
      assets: campaignAssets,
    });

    // If posts/assets already exist but the campaign is still marked as generating,
    // show the ready state guidance instead of the spinner so the user is not blocked.
    if (state === "creatives_generating" && hasGeneratedContent) {
      state = "creatives_ready";
    }

    const hasCaptionPack = campaignAssets?.some((a) => a.assetType === "caption_pack");
    const masterVisual =
      filtered?.find((c) => ((c.metadata as any)?.assetKind === "master_campaign_post")) ||
      filtered?.find((c) => c.type === "social_post");
    const hasImage = !!((masterVisual?.metadata as any)?.imageUrl);
    const isImageGenerating = ((masterVisual?.metadata as any)?.imageStatus) === "generating" || generateImageMutation.isPending;
    const isImageFailed = ((masterVisual?.metadata as any)?.imageStatus) === "failed";
    const approvalsPending = approvals?.filter((a) => a.status === "pending").length || 0;
    const allApproved = filtered?.every((c) => getApprovalState(c));

    const stateGuide: Record<string, { title: string; description: string; tone: "info" | "success" | "warning" }> = {
      strategy_pending: {
        title: "Strategy Agent is preparing your campaign direction.",
        description: "This usually takes a minute. You'll be notified when the strategy is ready for review.",
        tone: "info",
      },
      strategy_generated: {
        title: "Strategy generated.",
        description: "Review and approve the strategy so NatForgeAI can create your campaign content.",
        tone: "warning",
      },
      strategy_approved: {
        title: "Strategy approved. NatForgeAI will now prepare your campaign content.",
        description: "The Creative Agent is building your master caption and platform adaptations.",
        tone: "success",
      },
      creatives_generating: {
        title: "Creative Agent is creating your master caption and platform adaptations.",
        description: "This usually takes a minute. Refresh if it seems stuck.",
        tone: "info",
      },
      creatives_ready: {
        title: "Campaign content is ready. Review the caption, then generate your premium marketing leaflet.",
        description: "Your campaign pack is ready. Next step: generate your premium marketing leaflet.",
        tone: "warning",
      },
      audience_generating: {
        title: "Audience Agent is refining your target buyer and channels.",
        description: "This usually takes a minute.",
        tone: "info",
      },
      audience_ready: {
        title: "Audience refinements ready.",
        description: "Review the audience recommendations, then generate your marketing leaflet.",
        tone: "success",
      },
      schedule_generated: {
        title: "Your campaign pack is ready. Next step: generate your marketing leaflet.",
        description: "Click Generate below to create a ready-to-post marketing leaflet. Start with a free Basic Draft, or choose Premium AI for a polished result.",
        tone: "warning",
      },
      launch_approval_required: {
        title: "Approval required before launch.",
        description: "An admin needs to approve this campaign before it can go live.",
        tone: "warning",
      },
      campaign_live: {
        title: "Campaign is live.",
        description: "Your campaign is running. Monitor performance in Analytics.",
        tone: "success",
      },
      completed: {
        title: "Campaign completed.",
        description: "This campaign has finished.",
        tone: "success",
      },
    };

    const guide = stateGuide[state] || {
      title: "Continue building your campaign.",
      description: "Review the assets below and follow the next step.",
      tone: "info",
    };

    const toneClasses = {
      info: "border-blue-200 bg-blue-50 text-blue-800",
      success: "border-emerald-200 bg-emerald-50 text-emerald-800",
      warning: "border-amber-200 bg-amber-50 text-amber-800",
    };

    const isPremiumLeafletAsset =
      (masterVisual?.metadata as any)?.assetTier === "premium" ||
      (masterVisual?.metadata as any)?.imageSource === "premium";
    const leafletStatusLabel = isPremiumLeafletAsset ? "Premium Leaflet ready" : "Basic Draft ready";

    const items = [
      { label: "Campaign strategy approved", done: !["business_onboarding", "strategy_pending", "strategy_generated"].includes(state) },
      { label: "Caption pack created", done: hasCaptionPack },
      { label: leafletStatusLabel, done: hasImage, loading: isImageGenerating, failed: isImageFailed },
      { label: "Approval pending", done: approvalsPending === 0 && allApproved, attention: approvalsPending > 0 },
      { label: "Publishing pending", done: campaignForContext.status === "active" || campaignForContext.status === "completed", attention: !allApproved },
    ];

    return (
      <Card className={`border ${toneClasses[guide.tone]}`}>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start gap-3">
            {guide.tone === "info" ? <Loader2 className="w-5 h-5 mt-0.5 animate-spin" /> : <AlertCircle className="w-5 h-5 mt-0.5" />}
            <div>
              <p className="font-semibold text-sm">{guide.title}</p>
              <p className="text-xs opacity-90 mt-0.5">{guide.description}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-2 border-t border-current/10">
            {items.map((item) => (
              <div key={item.label} className="flex items-center gap-1.5 text-xs">
                {item.done ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                ) : item.loading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                ) : item.failed ? (
                  <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                ) : item.attention ? (
                  <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                ) : (
                  <span className="w-3.5 h-3.5 rounded-full border border-current/30 shrink-0" />
                )}
                <span className={item.done ? "opacity-80" : ""}>{item.label}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  function renderCampaignPack() {
    if (!urlCampaignId || !filtered) return null;

    const basicConfigured = videoConfig?.basicConfigured ?? true;
    const premiumConfigured = videoConfig?.premiumConfigured ?? false;
    const videoEnabled = (ENABLE_PREMIUM_VIDEO && premiumConfigured) || (ENABLE_BASIC_DRAFT_VIDEO && basicConfigured);
    const allApproved = filtered.every((c) => getApprovalState(c));
    const isCampaignLive = campaignForContext?.workflowState === "campaign_live";
    const hasPublishableContent = filtered.some((c) => c.status !== "published" && c.status !== "archived");
    const canPublish = hasPublishableContent && !isCampaignLive;
    const canPublishAgain = isCampaignLive && hasPublishableContent;

    const currentIterations = campaignIterations.filter(
      (i) => !i.isLegacy && (i.leaflet || i.captionPack || i.videoConcept)
    );
    const displayIterations = currentIterations.length > 0 ? currentIterations : campaignIterations;
    const previousIterations = displayIterations.filter((i) => i.id !== selectedIteration?.id);

    const supportingAssets = selectedIteration?.isLegacy
      ? []
      : (campaignAssets || []).filter(
          (a) => !isCaptionPackAsset(a) && getRunId(a) === selectedIteration?.runId && a !== leafletCandidate
        );

    const tierLabel: Record<string, string> = {
      premium: "Premium",
      basic: "Basic Draft",
      standard: "Standard Pack",
    };

    const tierBadgeClasses: Record<string, string> = {
      premium: "bg-purple-50 text-purple-700 border-purple-200",
      basic: "bg-slate-50 text-slate-700 border-slate-200",
      standard: "bg-blue-50 text-blue-700 border-blue-200",
    };

    const iterationLabel = (iteration: ContentIteration) =>
      iteration.isLegacy ? "Legacy" : tierLabel[iteration.tier];

    const iterationBadgeClasses = (iteration: ContentIteration) =>
      iteration.isLegacy ? "bg-slate-100 text-slate-600 border-slate-200" : tierBadgeClasses[iteration.tier];

    const statusBadgeFor = (content?: any) => {
      if (!content) return null;
      const meta = getContentMeta(content);
      if (meta.imageStatus === "failed" || meta.videoStatus === "failed") {
        return (
          <Badge variant="outline" className="border-red-200 text-red-700 bg-red-50">
            Failed
          </Badge>
        );
      }
      if (meta.imageStatus === "generating" || meta.videoStatus === "generating" || meta.videoStatus === "rendering") {
        return (
          <Badge variant="outline" className="border-blue-200 text-blue-700 bg-blue-50">
            Generating
          </Badge>
        );
      }
      return (
        <Badge variant="outline" className="border-emerald-200 text-emerald-700 bg-emerald-50">
          Ready
        </Badge>
      );
    };

    const compactAssetRow = (asset: any) => {
      const meta = (asset.metadata || {}) as any;
      return (
        <div
          key={asset.id}
          className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-[10px] h-5 capitalize">
                {asset.assetType.replace(/_/g, " ")}
              </Badge>
              {asset.status && (
                <Badge variant="outline" className="text-[10px] h-5">
                  {asset.status}
                </Badge>
              )}
            </div>
            <p className="text-sm font-medium text-slate-900 mt-1 truncate">{asset.title}</p>
            {(meta.adaptedCaption || meta.message || meta.body || meta.content) && (
              <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                {meta.adaptedCaption || meta.message || meta.body || meta.content}
              </p>
            )}
          </div>
        </div>
      );
    };

    return (
      <div className="space-y-6">
        {/* Campaign Pack Header */}
        <Card className="border-[#00D4FF]/20 bg-gradient-to-r from-[#00D4FF]/5 to-[#7C3AED]/5">
          <CardContent className="p-5">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                  <Megaphone className="w-5 h-5 text-[#00D4FF]" />
                  Campaign Pack
                </h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {campaignForContext?.name}
                  {selectedIteration && (
                    <span>
                      {" "}
                      · Iteration {selectedIteration.iterationNumber}
                      {selectedIteration.isLegacy ? " (Legacy)" : ""}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {allApproved ? (
                  <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200">
                    <CheckCircle2 className="w-3 h-3 mr-1" />
                    Pack Approved
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50">
                    {filtered.filter((c) => !getApprovalState(c)).length} pending approval
                  </Badge>
                )}
                {(() => {
                  const publishStatus = getCampaignPublishStatus();
                  if (publishStatus === "published") {
                    return (
                      <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        Published
                      </Badge>
                    );
                  }
                  if (publishStatus === "in_progress") {
                    return (
                      <Badge className="bg-blue-50 text-blue-700 border-blue-200">
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                        Publishing in progress
                      </Badge>
                    );
                  }
                  if (publishStatus === "pending") {
                    return (
                      <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50">
                        <Clock className="w-3 h-3 mr-1" />
                        Publishing pending
                      </Badge>
                    );
                  }
                  if (publishStatus === "failed") {
                    return (
                      <Badge variant="outline" className="text-red-700 border-red-200 bg-red-50">
                        <AlertCircle className="w-3 h-3 mr-1" />
                        Publishing failed
                      </Badge>
                    );
                  }
                  return null;
                })()}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={regenerateFromProfileMutation.isPending}
                  onClick={() => {
                    if (
                      confirm(
                        "This will regenerate strategy, leaflet, captions and platform adaptations from the latest business profile. Existing AI-generated assets will be replaced. Continue?"
                      )
                    ) {
                      regenerateFromProfileMutation.mutate({ campaignId: numericCampaignId });
                    }
                  }}
                >
                  {regenerateFromProfileMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  Regenerate from Profile
                </Button>
                {canPublishAgain ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-amber-700 border-amber-200 hover:bg-amber-50"
                    onClick={handlePublishPack}
                  >
                    <Upload className="w-3.5 h-3.5 mr-1.5" />
                    Publish again
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white"
                    disabled={!canPublish}
                    onClick={handlePublishPack}
                  >
                    <Upload className="w-3.5 h-3.5 mr-1.5" />
                    Publish Campaign Pack
                  </Button>
                )}
              </div>
            </div>
            {campaignForContext?.workflowState && (
              <p className="text-xs text-muted-foreground mt-2">
                Campaign status:{" "}
                <span className="font-medium">
                  {campaignForContext.workflowState.replace(/_/g, " ")}
                </span>
              </p>
            )}
          </CardContent>
        </Card>

        {renderWorkflowGuidance()}

        {/* Iteration selector */}
        {displayIterations.length > 1 && selectedIteration && (
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-slate-700">Generation iteration</span>
            <Select value={selectedIteration.id} onValueChange={setSelectedIterationId}>
              <SelectTrigger className="w-[280px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {displayIterations.map((iteration) => (
                  <SelectItem key={iteration.id} value={iteration.id}>
                    <div className="flex items-center gap-2">
                      <span>Iteration {iteration.iterationNumber}</span>
                      <span className="text-xs text-muted-foreground">· {iterationLabel(iteration)}</span>
                      <span className="text-xs text-muted-foreground">{formatIterationDate(iteration.createdAt)}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Main Output Area — current iteration only */}
        {selectedIteration && (
          <div className="space-y-8">
            {/* Marketing Leaflet */}
            <section id="marketing-leaflet-section" className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                  <Image className="w-5 h-5 text-[#00D4FF]" />
                  Marketing Leaflet
                </h3>
                {leafletCandidate && (
                  <div className="flex items-center gap-2">
                    {statusBadgeFor(leafletCandidate)}
                    <Badge variant="outline" className={iterationBadgeClasses(selectedIteration)}>
                      {iterationLabel(selectedIteration)}
                    </Badge>
                  </div>
                )}
              </div>
              {leafletCandidate && leafletImageUrl ? (
                renderMasterImageSection(leafletCandidate, false, false, true)
              ) : isLeafletGenerating || isLeafletMissingButReady || (leafletCandidate && !leafletImageUrl) ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 flex flex-col items-center justify-center min-h-[380px] text-center px-6">
                  <Loader2 className="w-10 h-10 text-[#00D4FF] animate-spin mb-3" />
                  <p className="text-sm font-medium text-slate-800">Loading leaflet preview…</p>
                  <p className="text-xs text-slate-500 mt-1 max-w-sm">
                    The leaflet was generated. Refreshing the workspace now.
                  </p>
                </div>
              ) : selectedIterationItems[0] ? (
                renderMasterImageSection(selectedIterationItems[0], false, false, true)
              ) : null}
            </section>

            {/* Caption Pack */}
            {selectedIteration.captionPack && (
              <section className="space-y-3">
                {renderCaptionPack(
                  selectedIteration.captionPack,
                  selectedIteration.captionPack?.metadata?.contentPostId ??
                    leafletCandidate?.id ??
                    0
                )}
              </section>
            )}

            {/* Master Video Ad */}
            {videoEnabled && selectedIteration.videoConcept && (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                    <Video className="w-5 h-5 text-rose-500" />
                    Video Concept
                  </h3>
                  {statusBadgeFor(selectedIteration.videoConcept)}
                </div>
                {renderContentCard(selectedIteration.videoConcept)}
              </section>
            )}
          </div>
        )}

        {/* Supporting Assets — scoped to selected iteration, collapsed, compact */}
        {supportingAssets.length > 0 && (
          <Collapsible open={expandedSections.has("supporting")} onOpenChange={() => toggleSection("supporting")}>
            <div className="space-y-3 pt-2 border-t border-slate-200">
              <SectionHeader
                title="Supporting Assets"
                icon={FileText}
                color="text-slate-700"
                sectionKey="supporting"
                count={supportingAssets.length}
              />
              <CollapsibleContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {supportingAssets.map((asset) => (
                    <div key={asset.id}>{renderCampaignAssetCard(asset)}</div>
                  ))}
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        )}

        {/* Previous Iterations — compact, collapsed by default */}
        {(previousIterations.length > 0 || legacyIteration) && (
          <Collapsible
            open={expandedSections.has("previous")}
            onOpenChange={() => toggleSection("previous")}
          >
            <div className="rounded-xl border border-slate-200 bg-slate-50 overflow-hidden">
              <CollapsibleTrigger asChild>
                <button className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-100 transition-colors">
                  <span className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                    <History className="w-4 h-4 text-slate-500" />
                    Previous Iterations
                  </span>
                  <Badge variant="outline">
                    {previousIterations.length + (legacyIteration ? 1 : 0)}
                  </Badge>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="p-4 space-y-4">
                  {/* Previous current iterations with a visual record only */}
                  {previousIterations.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {previousIterations
                        .filter((iteration) => findLeafletCandidate(iteration.items, campaignAssets) || iteration.videoConcept)
                        .map((iteration) => {
                          const prevLeaflet = findLeafletCandidate(iteration.items, campaignAssets) || iteration.leaflet;
                          const thumbnailUrl = getImageUrl(prevLeaflet, campaignAssets);
                          const thumbnailBroken = brokenIterationIds.has(iteration.id);
                          return (
                            <button
                              key={iteration.id}
                              type="button"
                              onClick={() => setSelectedIterationId(iteration.id)}
                              className="text-left rounded-lg border border-slate-200 bg-white p-3 hover:shadow-md transition-all"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <p className="text-sm font-semibold text-slate-900">
                                    Iteration {iteration.iterationNumber}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {formatIterationDate(iteration.createdAt)}
                                  </p>
                                </div>
                                <Badge variant="outline" className={iterationBadgeClasses(iteration)}>
                                  {iterationLabel(iteration)}
                                </Badge>
                              </div>
                              {thumbnailUrl && !thumbnailBroken ? (
                                <div className="mt-3 aspect-[4/3] rounded-md overflow-hidden bg-slate-100">
                                  <img
                                    src={thumbnailUrl}
                                    alt={`Iteration ${iteration.iterationNumber} leaflet`}
                                    className="w-full h-full object-cover"
                                    onError={() => setBrokenIterationIds((prev) => new Set(prev).add(iteration.id))}
                                  />
                                </div>
                              ) : (
                                <div className="mt-3 rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
                                  <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                                    <Image className="w-3.5 h-3.5" />
                                    Preview unavailable
                                  </p>
                                </div>
                              )}
                            </button>
                          );
                        })}
                    </div>
                  )}

                  {/* Legacy records */}
                  {legacyIteration && (
                    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
                      <div className="px-3 py-2 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                          <History className="w-3.5 h-3.5 text-slate-500" />
                          Legacy Records
                        </span>
                        <Badge variant="outline" className="text-[10px] h-5">
                          {legacyIteration.supporting.length +
                            (legacyIteration.leaflet ? 1 : 0) +
                            (legacyIteration.captionPack ? 1 : 0) +
                            (legacyIteration.videoConcept ? 1 : 0)}
                        </Badge>
                      </div>
                      <div className="p-3 space-y-2 max-h-[360px] overflow-y-auto">
                        {legacyIteration.leaflet && (
                          <button
                            type="button"
                            onClick={() => setSelectedIterationId(legacyIteration.id)}
                            className="w-full text-left rounded-md border border-slate-200 bg-slate-50 p-2.5 hover:bg-slate-100 transition-colors"
                          >
                            <p className="text-xs font-semibold text-slate-800">Legacy Marketing Leaflet</p>
                            <p className="text-[10px] text-muted-foreground">
                              {formatIterationDate(legacyIteration.leaflet.createdAt)}
                            </p>
                          </button>
                        )}
                        {legacyIteration.captionPack && compactAssetRow(legacyIteration.captionPack)}
                        {legacyIteration.videoConcept && (
                          <button
                            type="button"
                            onClick={() => setSelectedIterationId(legacyIteration.id)}
                            className="w-full text-left rounded-md border border-slate-200 bg-slate-50 p-2.5 hover:bg-slate-100 transition-colors"
                          >
                            <p className="text-xs font-semibold text-slate-800">Legacy Video Concept</p>
                            <p className="text-[10px] text-muted-foreground">
                              {formatIterationDate(legacyIteration.videoConcept.createdAt)}
                            </p>
                          </button>
                        )}
                        {legacyIteration.supporting.map((asset: any) => compactAssetRow(asset))}
                      </div>
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        )}

        {/* Publish Dialog */}
        <Dialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {isRepublish ? "Confirm Publish Again" : "Confirm Publish to Connected Channels"}
              </DialogTitle>
              <DialogDescription>
                {isRepublish
                  ? "This campaign is already live. Publishing again will create new posts on the connected platforms below. This action cannot be undone."
                  : "This will immediately post the approved campaign content to each connected platform below. This action cannot be undone."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              {(() => {
                const statuses = getCampaignPlatformStatuses();
                const groups: Record<PlatformPublishStatus, typeof statuses> = {
                  connected: [],
                  not_connected: [],
                  manual: [],
                  not_supported: [],
                };
                for (const s of statuses) groups[s.status].push(s);

                return (
                  <div className="space-y-3">
                    {groups.connected.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-emerald-700 uppercase tracking-wide mb-1">Connected</p>
                        <div className="flex flex-wrap gap-2">
                          {groups.connected.map((s) => (
                            <Badge key={s.platform} className="bg-emerald-50 text-emerald-700 border-emerald-200 capitalize">
                              <CheckCircle2 className="w-3 h-3 mr-1" />
                              {s.platform}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">These will attempt automatic publishing.</p>
                      </div>
                    )}
                    {groups.not_connected.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-red-700 uppercase tracking-wide mb-1">Not connected</p>
                        <div className="flex flex-wrap gap-2">
                          {groups.not_connected.map((s) => (
                            <Badge key={s.platform} variant="outline" className="text-red-700 border-red-200 bg-red-50 capitalize">
                              <AlertCircle className="w-3 h-3 mr-1" />
                              {s.platform}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">Connect this platform in Integrations to auto-publish, or post manually.</p>
                        {groups.not_connected.some((s) => getInstagramReadinessError(s.platform)) && (
                          <div className="mt-2 p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-700 space-y-1">
                            {groups.not_connected.map((s) => {
                              const err = getInstagramReadinessError(s.platform);
                              return err ? <p key={s.platform}>{err}</p> : null;
                            })}
                          </div>
                        )}
                      </div>
                    )}
                    {groups.manual.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-amber-700 uppercase tracking-wide mb-1">Manual publishing only</p>
                        <div className="flex flex-wrap gap-2">
                          {groups.manual.map((s) => (
                            <Badge key={s.platform} variant="outline" className="text-amber-700 border-amber-200 bg-amber-50 capitalize">
                              <AlertCircle className="w-3 h-3 mr-1" />
                              {s.platform}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">These will be approved and marked as &quot;manually posted&quot;. Copy the content and post on each platform.</p>
                      </div>
                    )}
                    {groups.not_supported.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-slate-700 uppercase tracking-wide mb-1">Not supported yet</p>
                        <div className="flex flex-wrap gap-2">
                          {groups.not_supported.map((s) => (
                            <Badge key={s.platform} variant="outline" className="text-slate-700 border-slate-200 bg-slate-50 capitalize">
                              <AlertCircle className="w-3 h-3 mr-1" />
                              {s.platform}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">Automatic publishing is not available for this platform yet.</p>
                      </div>
                    )}
                    {statuses.length === 0 && (
                      <div className="p-3 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-800">
                        <p className="font-medium">No platforms detected</p>
                        <p className="text-amber-700/80 mt-0.5">All content will be approved and marked for manual posting.</p>
                      </div>
                    )}
                  </div>
                );
              })()}
              <div className="flex gap-2 pt-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setPublishDialogOpen(false)}
                  disabled={publishCampaignPackMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1 bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white"
                  onClick={executePublishPack}
                  disabled={publishCampaignPackMutation.isPending}
                >
                  {publishCampaignPackMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4 mr-2" />
                  )}
                  {publishCampaignPackMutation.isPending
                    ? "Publishing..."
                    : isRepublish
                    ? "Publish again"
                    : "Confirm Publish"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  function renderAiContentDialog() {
    return (
      <Dialog open={aiOpen} onOpenChange={setAiOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>AI Content Generator</DialogTitle>
            <DialogDescription>
              Generate sales-driven marketing content designed to convert.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Business</Label>
                <Input
                  value={aiForm.business}
                  onChange={(e) => setAiForm({ ...aiForm, business: e.target.value })}
                  placeholder="Your business name"
                />
              </div>
              <div>
                <Label>Content Type</Label>
                <Select
                  value={aiForm.type}
                  onValueChange={(v: any) => setAiForm({ ...aiForm, type: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="social_post">Social Post</SelectItem>
                    <SelectItem value="ad_copy">Ad Copy</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="video_concept">Video Concept</SelectItem>
                    <SelectItem value="carousel_ad">Carousel Ad</SelectItem>
                    <SelectItem value="whatsapp_promo">WhatsApp Promo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Platform</Label>
                <Select
                  value={aiForm.platform}
                  onValueChange={(v) => setAiForm({ ...aiForm, platform: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {platforms.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Tone</Label>
                <Select
                  value={aiForm.tone}
                  onValueChange={(v) => setAiForm({ ...aiForm, tone: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {tones.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Target Audience</Label>
              <Input
                value={aiForm.audience}
                onChange={(e) => setAiForm({ ...aiForm, audience: e.target.value })}
                placeholder="Young professionals aged 25-40 in Johannesburg"
              />
            </div>
            <div>
              <Label>Goal (optional)</Label>
              <Input
                value={aiForm.goal}
                onChange={(e) => setAiForm({ ...aiForm, goal: e.target.value })}
                placeholder="Drive sales, increase awareness..."
              />
            </div>
            <Button
              onClick={generateWithAI}
              disabled={aiLoading || !aiForm.business}
              className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
            >
              {aiLoading ? (
                <>
                  <div className="w-4 h-4 mr-2 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Generate Sales Content
                </>
              )}
            </Button>

            {aiResult && (
              <div className="mt-4">
                <Label>Generated Content</Label>
                <div className="relative mt-1">
                  <Textarea
                    value={aiResult}
                    onChange={(e) => setAiResult(e.target.value)}
                    className="min-h-[300px] font-mono text-sm"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-2 right-2"
                    onClick={() => copyToClipboard(aiResult, -1)}
                  >
                    {copiedId === -1 ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
                <Button
                  className="w-full mt-3"
                  variant="outline"
                  onClick={() => {
                    createMutation.mutate({
                      title: `AI Generated - ${aiForm.type}`,
                      type: aiForm.type,
                      platform: aiForm.platform,
                      body: aiResult,
                      aiGenerated: true,
                    });
                    setAiOpen(false);
                    setAiResult("");
                  }}
                >
                  Save to Library
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  function renderCreateContentDialog() {
    return (
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Content</DialogTitle>
            <DialogDescription>
              Manually add marketing content to your library.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4 mt-4">
            <div>
              <Label>Title</Label>
              <Input name="title" placeholder="Summer sale announcement" required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Type</Label>
                <Select name="type" defaultValue="social_post">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="social_post">Social Post</SelectItem>
                    <SelectItem value="ad_copy">Ad Copy</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="script">Script</SelectItem>
                    <SelectItem value="blog">Blog</SelectItem>
                    <SelectItem value="story">Story</SelectItem>
                    <SelectItem value="video_concept">Video Concept</SelectItem>
                    <SelectItem value="carousel_ad">Carousel Ad</SelectItem>
                    <SelectItem value="whatsapp_promo">WhatsApp Promo</SelectItem>
                    <SelectItem value="lead_gen_ad">Lead Gen Ad</SelectItem>
                    <SelectItem value="launch_pack">Launch Pack</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Platform</Label>
                <Select name="platform">
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {platforms.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Hook</Label>
              <Input name="hook" placeholder="Attention-grabbing first line" />
            </div>
            <div>
              <Label>Caption / Body</Label>
              <Textarea name="caption" placeholder="Main content..." />
            </div>
            <div>
              <Label>CTA</Label>
              <Input name="cta" placeholder="Shop now!" />
            </div>
            <div>
              <Label>Body / Notes</Label>
              <Textarea name="body" placeholder="Additional content..." />
            </div>
            <Button
              type="submit"
              className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? "Saving..." : "Save Content"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  function renderCampaignLibrary() {
    const summaries = computeCampaignSummaries(campaigns, businessesList, contents, campaignAssets);
    const filteredSummaries = summaries.filter((summary) => {
      const matchesSearch =
        summary.campaign.name.toLowerCase().includes(search.toLowerCase()) ||
        summary.businessName.toLowerCase().includes(search.toLowerCase());
      if (!matchesSearch) return false;

      switch (overviewFilter) {
        case "ready":
          return summary.status === "ready";
        case "draft":
          return summary.status === "draft" || summary.status === "generating";
        case "failed":
          return summary.status === "failed";
        case "premium":
          return summary.tier === "premium";
        case "basic":
          return summary.tier === "basic";
        case "all":
        default:
          return true;
      }
    });

    const totalCampaigns = summaries.length;
    const readyCount = summaries.filter((s) => s.status === "ready" || s.status === "approved").length;
    const pendingCount = summaries.filter((s) => s.status === "draft" || s.status === "generating").length;
    const scheduledCount = (contents || []).filter((c) => c.status === "scheduled").length;

    const statusBadge = (status: CampaignSummaryStatus) => {
      switch (status) {
        case "ready":
          return (
            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
              Ready
            </Badge>
          );
        case "approved":
          return (
            <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
              Approved
            </Badge>
          );
        case "failed":
          return (
            <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
              Failed
            </Badge>
          );
        case "generating":
          return (
            <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              Generating
            </Badge>
          );
        case "draft":
        default:
          return (
            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
              Draft
            </Badge>
          );
      }
    };

    const tierBadge = (tier: "premium" | "basic" | "none") => {
      switch (tier) {
        case "premium":
          return (
            <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
              Premium Leaflet
            </Badge>
          );
        case "basic":
          return (
            <Badge variant="outline" className="bg-slate-50 text-slate-700 border-slate-200">
              Basic Draft
            </Badge>
          );
        default:
          return (
            <Badge variant="outline" className="bg-slate-50 text-slate-500 border-slate-200">
              No output
            </Badge>
          );
      }
    };

    const filterChips: { value: typeof overviewFilter; label: string }[] = [
      { value: "all", label: "All" },
      { value: "ready", label: "Ready" },
      { value: "draft", label: "Draft" },
      { value: "failed", label: "Failed" },
      { value: "premium", label: "Premium" },
      { value: "basic", label: "Basic Draft" },
    ];

    return (
      <div className="space-y-8">
        {/* Premium page header */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-6 sm:p-8 text-white shadow-lg">
          <div className="absolute top-0 right-0 w-64 h-64 bg-[#00D4FF]/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3" />
          <div className="absolute bottom-0 left-0 w-48 h-48 bg-purple-500/10 rounded-full blur-3xl translate-y-1/3 -translate-x-1/4" />
          <div className="relative z-10 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-[#00D4FF] text-sm font-medium mb-2">
                <LayoutGrid className="w-4 h-4" />
                Campaign Library
              </div>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Content Studio</h1>
              <p className="text-slate-300 mt-2 max-w-xl">
                Manage campaign outputs, drafts, approvals, and publishing.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                className="border-white/20 text-white hover:bg-white/10 bg-white/5"
                onClick={() => setAiOpen(true)}
              >
                <Sparkles className="w-4 h-4 mr-2" />
                Create One-Off Content
              </Button>
              <Button className="bg-[#00D4FF] text-slate-900 hover:bg-[#00D4FF]/90" onClick={() => setCreateOpen(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Add Content
              </Button>
            </div>
          </div>
        </div>

        {/* Summary metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="border-slate-200 bg-white/50 backdrop-blur-sm">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Campaigns</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{totalCampaigns}</p>
                </div>
                <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center">
                  <LayoutGrid className="w-5 h-5 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-slate-200 bg-white/50 backdrop-blur-sm">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Ready assets</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{readyCount}</p>
                </div>
                <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-slate-200 bg-white/50 backdrop-blur-sm">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Pending approval</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{pendingCount}</p>
                </div>
                <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
                  <Clock className="w-5 h-5 text-amber-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-slate-200 bg-white/50 backdrop-blur-sm">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Scheduled posts</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{scheduledCount}</p>
                </div>
                <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center">
                  <CalendarClock className="w-5 h-5 text-purple-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Search and filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search campaigns or businesses..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {filterChips.map((chip) => (
              <button
                key={chip.value}
                type="button"
                onClick={() => setOverviewFilter(chip.value)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  overviewFilter === chip.value
                    ? "bg-slate-900 text-white"
                    : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>
        </div>

        {/* Campaign outputs grid */}
        {filteredSummaries.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <PenTool className="w-12 h-12 text-slate-300 mb-4" />
              <p className="text-lg font-medium text-slate-900">No campaigns found</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-md">
                {summaries.length === 0
                  ? "Create a campaign strategy first, then generate marketing content."
                  : "Try adjusting your search or filters."}
              </p>
              {summaries.length === 0 && (
                <div className="flex gap-2 mt-4">
                  <Link to="/campaigns">
                    <Button variant="outline">
                      <ArrowRight className="w-4 h-4 mr-2" />
                      Go to Campaigns
                    </Button>
                  </Link>
                  <Button onClick={() => setAiOpen(true)}>
                    <Sparkles className="w-4 h-4 mr-2" />
                    Create One-Off Content
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {filteredSummaries.map((summary) => {
              const canRegenerate = !!summary.latestLeaflet && summary.status !== "generating";
              const isGenerating = summary.status === "generating";

              return (
                <Card
                  key={summary.campaign.id}
                  className="group border-slate-200 bg-white overflow-hidden hover:shadow-xl hover:border-[#00D4FF]/30 transition-all duration-300"
                >
                  {/* Thumbnail */}
                  <div className="relative aspect-[4/3] bg-slate-100 overflow-hidden">
                    {summary.thumbnailUrl ? (
                      <>
                        <img
                          src={summary.thumbnailUrl}
                          alt={`${summary.campaign.name} latest leaflet`}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = "none";
                          }}
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                      </>
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-slate-400">
                        <Image className="w-12 h-12 mb-2" />
                        <p className="text-xs">No leaflet generated yet</p>
                      </div>
                    )}
                    <div className="absolute top-3 left-3 flex items-center gap-2">
                      {statusBadge(summary.status)}
                      {tierBadge(summary.tier)}
                    </div>
                    {summary.iterationNumber > 0 && (
                      <div className="absolute bottom-3 right-3">
                        <Badge variant="secondary" className="bg-white/90 text-slate-800 text-[10px]">
                          Iteration {summary.iterationNumber}
                        </Badge>
                      </div>
                    )}
                  </div>

                  {/* Card body */}
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-semibold text-slate-900 truncate" title={summary.campaign.name}>
                          {summary.campaign.name}
                        </h3>
                        <p className="text-sm text-slate-500 truncate">{summary.businessName}</p>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        {summary.lastGeneratedAt
                          ? formatIterationDate(summary.lastGeneratedAt)
                          : "Not generated"}
                      </span>
                      <span className="flex items-center gap-1">
                        <TrendingUp className="w-3.5 h-3.5" />
                        {summary.creditsCharged === 0 ? "0 credits" : `${summary.creditsCharged} credits`}
                      </span>
                    </div>

                    {/* Actions */}
                    <div className="mt-5 flex flex-wrap items-center gap-2">
                      <Link to={`/content?campaignId=${summary.campaign.id}`} className="flex-1">
                        <Button size="sm" className="w-full bg-slate-900 hover:bg-slate-800 text-white">
                          <Eye className="w-3.5 h-3.5 mr-1.5" />
                          View Campaign Output
                        </Button>
                      </Link>
                      {canRegenerate && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-slate-600 border-slate-200 hover:bg-slate-50"
                          onClick={() =>
                            generateImageMutation.mutate({
                              contentPostId: summary.latestLeaflet!.id,
                            })
                          }
                          disabled={generateImageMutation.isPending}
                        >
                          {generateImageMutation.isPending ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                        </Button>
                      )}
                      {canRegenerate && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-slate-600 border-slate-200 hover:bg-slate-50"
                          onClick={() =>
                            generateCaptionPackMutation.mutate({
                              contentPostId: summary.latestLeaflet!.id,
                            })
                          }
                          disabled={generateCaptionPackMutation.isPending}
                        >
                          {generateCaptionPackMutation.isPending ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <MessageCircle className="w-3.5 h-3.5" />
                          )}
                        </Button>
                      )}
                      {summary.status === "ready" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className={
                            summary.campaign.workflowState === "campaign_live"
                              ? "text-amber-700 border-amber-200 hover:bg-amber-50"
                              : "text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                          }
                          onClick={() =>
                            publishCampaignPackMutation.mutate({
                              campaignId: summary.campaign.id,
                              allowRepublish: summary.campaign.workflowState === "campaign_live",
                            })
                          }
                          disabled={publishCampaignPackMutation.isPending}
                        >
                          {publishCampaignPackMutation.isPending ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Megaphone className="w-3.5 h-3.5" />
                          )}
                        </Button>
                      )}
                    </div>

                    {isGenerating && (
                      <p className="mt-3 text-xs text-purple-600 flex items-center gap-1.5">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Generating new output…
                      </p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

      </div>
    );
  }

  return (
    <div className="space-y-6">
      {urlCampaignId && (
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Content Studio</h1>
          <p className="text-muted-foreground mt-1">
            Approve, schedule, and publish content that converts.
          </p>
          {urlCampaignId && (
            <div className="mt-2 flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                Filtered by Campaign #{urlCampaignId}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => {
                  searchParams.delete("campaignId");
                  setSearchParams(searchParams);
                }}
              >
                <X className="w-3 h-3 mr-1" />
                Clear filter
              </Button>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {urlCampaignId && campaignForContext && (
            <Button
              variant="outline"
              className="border-[#00D4FF]/50 text-[#00D4FF] hover:bg-[#00D4FF]/10"
              onClick={() => {
                if (campaignForContext.workflowState === "strategy_approved" || campaignForContext.workflowState === "creatives_generating" || campaignForContext.workflowState === "creatives_ready") {
                  generateForCampaignMutation.mutate({ campaignId: numericCampaignId });
                } else {
                  toast.info("Please approve the strategy first before generating content.");
                }
              }}
              disabled={generateForCampaignMutation.isPending}
            >
              {generateForCampaignMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4 mr-2" />
              )}
              {campaignNeedsRecovery ? "Retry Content Generation" : "Generate from Approved Strategy"}
            </Button>
          )}
        </div>
      </div>
      )}

      {renderAiContentDialog()}
      {renderCreateContentDialog()}

      {/* Schedule Dialog */}
      <Dialog open={scheduleOpen.open} onOpenChange={(open) => !open && setScheduleOpen({ open: false, contentId: null })}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Schedule Post</DialogTitle>
            <DialogDescription>Choose a date and time to publish.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <Input
              type="datetime-local"
              value={scheduleDate}
              onChange={(e) => setScheduleDate(e.target.value)}
            />
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setScheduleOpen({ open: false, contentId: null })}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={handleScheduleSave} disabled={!scheduleDate || isPending(scheduleOpen.contentId ?? 0, "schedule")}>
                {isPending(scheduleOpen.contentId ?? 0, "schedule") ? "Saving..." : "Schedule"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Content Grid or Campaign Pack */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6 h-32" />
            </Card>
          ))}
        </div>
      ) : listError ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <AlertCircle className="w-12 h-12 text-red-400 mb-4" />
            <p className="text-lg font-medium text-slate-900">Could not load content</p>
            <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-md text-center">
              {listError}
            </p>
            <Button variant="outline" onClick={() => utils.content.list.invalidate()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : campaignNeedsRecovery ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <AlertCircle className="w-12 h-12 text-amber-400 mb-4" />
            <p className="text-lg font-medium text-slate-900">
              {hasFailedStrategyRun
                ? "Regeneration from profile did not complete"
                : "Content generation did not complete successfully"}
            </p>
            <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-md text-center">
              {hasFailedStrategyRun
                ? "The Strategy Agent failed while regenerating from your updated business profile. You can retry the full regeneration."
                : "The Creative Agent ran but no posts were saved. You can retry content generation for this campaign."}
            </p>
            <div className="flex gap-2 flex-wrap justify-center">
              {hasFailedStrategyRun ? (
                <Button
                  variant="outline"
                  onClick={() => regenerateFromProfileMutation.mutate({ campaignId: numericCampaignId })}
                  disabled={regenerateFromProfileMutation.isPending}
                >
                  {regenerateFromProfileMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Sparkles className="w-4 h-4 mr-2" />
                  )}
                  Retry Regenerate from Profile
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => generateForCampaignMutation.mutate({ campaignId: numericCampaignId })}
                  disabled={generateForCampaignMutation.isPending}
                >
                  {generateForCampaignMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Sparkles className="w-4 h-4 mr-2" />
                  )}
                  Retry Content Generation
                </Button>
              )}
              <Link to="/agent-activity">
                <Button variant="outline">
                  <ArrowRight className="w-4 h-4 mr-2" />
                  View Agent Activity
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : urlCampaignId ? (
        (contents ?? []).length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <PenTool className="w-12 h-12 text-muted-foreground mb-4" />
              <p className="text-lg font-medium text-slate-900">No content yet</p>
              {strategyPendingApproval ? (
                <>
                  <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-md text-center">
                    Your strategy is ready for review. Approve it to start content generation.
                  </p>
                  <div className="flex gap-2 flex-wrap justify-center">
                    <Link to="/approvals">
                      <Button variant="outline">
                        <ArrowRight className="w-4 h-4 mr-2" />
                        Review Strategy
                      </Button>
                    </Link>
                  </div>
                </>
              ) : strategyGeneratedCampaign ? (
                <>
                  <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-md text-center">
                    Your strategy is ready, but the review item needs to be prepared. Refresh or go to Campaigns.
                  </p>
                  <div className="flex gap-2 flex-wrap justify-center">
                    <Link to="/campaigns">
                      <Button variant="outline">
                        <ArrowRight className="w-4 h-4 mr-2" />
                        Go to Campaigns
                      </Button>
                    </Link>
                  </div>
                </>
              ) : strategyPendingCampaign ? (
                <>
                  <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-md text-center">
                    NatForgeAI is preparing your strategy. Content will appear here once strategy is approved.
                  </p>
                  <div className="flex gap-2 flex-wrap justify-center">
                    <Link to="/agent-activity">
                      <Button variant="outline">
                        <ArrowRight className="w-4 h-4 mr-2" />
                        View Progress
                      </Button>
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-md text-center">
                    Your campaign strategy is ready. Next, generate a premium marketing leaflet and social media caption pack.
                  </p>
                  <div className="flex gap-2 flex-wrap justify-center">
                    <Link to="/campaigns">
                      <Button variant="outline">
                        <ArrowRight className="w-4 h-4 mr-2" />
                        Go to Campaign Strategy
                      </Button>
                    </Link>
                    <Button onClick={() => setCreateOpen(true)}>
                      <Plus className="w-4 h-4 mr-2" />
                      Add Manually
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        ) : (
          renderCampaignPack()
        )
      ) : (
        renderCampaignLibrary()
      )}
    </div>
  );
}
