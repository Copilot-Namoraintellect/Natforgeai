import { useState, useMemo } from "react";
import { useSearchParams, Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  DialogTrigger,
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
  Loader2,
  Megaphone,
  Hash,
  MessageCircle,
  Image,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
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

type PendingActionKey = string;

function actionKey(contentId: number, action: string): PendingActionKey {
  return `${contentId}:${action}`;
}

export default function ContentStudio() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlCampaignId = searchParams.get("campaignId");
  const [activeTab, setActiveTab] = useState("all");
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
  const [scheduleOpen, setScheduleOpen] = useState<{ open: boolean; contentId: number | null }>({
    open: false,
    contentId: null,
  });
  const [scheduleDate, setScheduleDate] = useState("");
  const [pendingActions, setPendingActions] = useState<Set<PendingActionKey>>(new Set());
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["masterVisual", "masterVideo"]));
  const [imageCreativeType, setImageCreativeType] = useState<"leaflet" | "poster" | "service_menu" | "offer_advert" | "event_announcement">("leaflet");
  const [loadingImageIds, setLoadingImageIds] = useState<Set<number>>(new Set());
  const [brokenImageIds, setBrokenImageIds] = useState<Set<number>>(new Set());

  const IMAGE_CREATIVE_TYPE_OPTIONS = [
    { value: "leaflet", label: "Leaflet / Pamphlet" },
    { value: "poster", label: "Social media poster" },
    { value: "service_menu", label: "Service menu" },
    { value: "offer_advert", label: "Offer advert" },
    { value: "event_announcement", label: "Event announcement" },
  ];

  const utils = trpc.useUtils();
  const listInput = (() => {
    const base: any = {};
    if (urlCampaignId) base.campaignId = Number(urlCampaignId);
    if (activeTab === "ai_generated") base.aiGenerated = true;
    else if (activeTab !== "all") base.type = activeTab;
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
    { id: Number(urlCampaignId) },
    { enabled: !!urlCampaignId }
  );
  const { data: businessForContext } = trpc.business.get.useQuery(
    { id: campaignForContext?.businessId ?? 0 },
    { enabled: !!campaignForContext?.businessId }
  );
  const { data: postCountForCampaign } = trpc.content.countForCampaign.useQuery(
    { campaignId: Number(urlCampaignId) },
    { enabled: !!urlCampaignId }
  );
  const { data: campaignAssets } = trpc.content.campaignAssets.useQuery(
    { campaignId: Number(urlCampaignId) },
    { enabled: !!urlCampaignId }
  );
  const { data: videoJobs } = trpc.video.listForCampaign.useQuery(
    { campaignId: Number(urlCampaignId) },
    { enabled: !!urlCampaignId }
  );
  const { data: videoConfig } = trpc.video.getConfigStatus.useQuery();
  const { data: premiumImageCostData } = trpc.image.premiumImageCost.useQuery();
  const premiumImageCost = premiumImageCostData?.cost ?? 10;

  // Fetch campaigns and approvals to show contextual empty-state guidance
  const { data: campaigns } = trpc.campaign.list.useQuery();
  const { data: approvals } = trpc.approval.listApprovals.useQuery(
    { status: "pending" },
    { enabled: (contents?.length ?? 0) === 0 }
  );

  const { data: connectedPlatforms } = trpc.integration.getConnectedPlatforms.useQuery();
  const { data: platformConfigStatus } = trpc.integration.getPlatformConfigStatus.useQuery();

  // Fetch agent runs so we can detect failed regenerations and avoid showing "completed" creative rows with no content
  const { data: creativeAgentRuns } = trpc.agent.getAgentRuns.useQuery(
    { campaignId: Number(urlCampaignId), agentType: "creative" },
    { enabled: !!urlCampaignId, refetchInterval: 10000 }
  );
  const { data: strategyAgentRuns } = trpc.agent.getAgentRuns.useQuery(
    { campaignId: Number(urlCampaignId), agentType: "strategy" },
    { enabled: !!urlCampaignId, refetchInterval: 10000 }
  );

  const connectedIntegrations = useMemo(
    () =>
      connectedPlatforms?.map((i) => ({
        platform: i.provider,
        accountName: i.providerAccountName,
        status: i.status,
      })) ?? [],
    [connectedPlatforms]
  );

  const strategyPendingApproval = approvals?.find((a) => a.approvalType === "strategy_review");
  const strategyGeneratedCampaign = campaigns?.find((c) => c.workflowState === "strategy_generated");
  const strategyPendingCampaign = campaigns?.find((c) => c.workflowState === "strategy_pending");

  const hasFailedCreativeRun = creativeAgentRuns?.some((r) => r.status === "failed");
  const hasFailedStrategyRun = strategyAgentRuns?.some((r) => r.status === "failed");

  const campaignNeedsRecovery = !!urlCampaignId && campaignForContext &&
    ((["creatives_generating", "creatives_ready"].includes(campaignForContext.workflowState) &&
      (postCountForCampaign === 0 || (contents?.length ?? 0) === 0)) ||
      hasFailedCreativeRun ||
      hasFailedStrategyRun);

  const generateForCampaignMutation = trpc.content.generateForCampaign.useMutation({
    onSuccess: (data) => {
      utils.content.list.invalidate();
      utils.content.countForCampaign.invalidate({ campaignId: Number(urlCampaignId) });
      utils.campaign.get.invalidate({ id: Number(urlCampaignId) });
      utils.agent.getAgentRuns.invalidate({ campaignId: Number(urlCampaignId) });
      toast.success(`Content generated successfully. ${data.postCount} posts created.`);
    },
    onError: (err) => {
      utils.content.list.invalidate();
      utils.content.countForCampaign.invalidate({ campaignId: Number(urlCampaignId) });
      utils.campaign.get.invalidate({ id: Number(urlCampaignId) });
      utils.agent.getAgentRuns.invalidate({ campaignId: Number(urlCampaignId) });
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
      (i) => i.platform === platform && i.status === "connected"
    );
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
    const parts = [
      content.hook,
      content.caption,
      content.cta,
      content.body,
      content.hashtags,
    ].filter(Boolean);
    return parts.join("\n\n");
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

  function isPending(contentId: number, action: string) {
    return pendingActions.has(actionKey(contentId, action));
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
      utils.video.listForCampaign.invalidate({ campaignId: Number(urlCampaignId) });
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
      setBrokenImageIds((prev) => {
        const next = new Set(prev);
        next.delete(variables.contentPostId);
        return next;
      });
      setLoadingImageIds((prev) => new Set(prev).add(variables.contentPostId));
    },
    onSuccess: (data) => {
      toast.success(`Premium leaflet generated (${data.creditsCharged ?? premiumImageCost} credits). Review the leaflet and caption pack, then approve or regenerate.`);
      utils.content.list.invalidate();
      utils.image.list.invalidate({ campaignId: Number(urlCampaignId) });
      utils.content.campaignAssets.invalidate({ campaignId: Number(urlCampaignId) });
    },
    onError: (err) => {
      const message = err.message || "";
      const code = (err as { data?: { code?: string } } | undefined)?.data?.code;
      if (code === "PAYMENT_REQUIRED" || message.includes("Insufficient credits") || message.includes("credits.")) {
        toast.error(message || "You don't have enough credits to generate a premium leaflet.");
      } else if (code === "NOT_IMPLEMENTED" || message.includes("not configured")) {
        toast.error("Premium leaflet generation is not configured. Please contact admin.");
      } else if (message.includes("System AI generation limit")) {
        toast.error("System AI generation limit reached. Please contact admin or try again later.");
      } else if (code === "BAD_REQUEST" || message.includes("400") || message.includes("content policy") || message.includes("safety")) {
        toast.error("We could not generate the premium leaflet. No credits were deducted. Please try again or contact support if the issue continues.");
      } else {
        toast.error(message || "We could not generate the premium leaflet. No credits were deducted. Please try again.");
      }
    },
  });

  const generateCaptionPackMutation = trpc.image.generateCaptionPack.useMutation({
    onSuccess: () => {
      toast.success("Caption pack generated. You can now copy platform-ready captions.");
      utils.content.campaignAssets.invalidate({ campaignId: Number(urlCampaignId) });
    },
    onError: (err) => {
      toast.error(err.message || "Failed to generate caption pack");
    },
  });

  const publishCampaignPackMutation = trpc.content.publishCampaignPack.useMutation({
    onSuccess: (data) => {
      utils.content.list.invalidate();
      toast.success(`Campaign pack published. ${data.approvedCount} items approved.`);
      setPublishDialogOpen(false);
    },
    onError: (err) => {
      toast.error(err.message || "Failed to publish campaign pack");
    },
  });

  const regenerateFromProfileMutation = trpc.campaign.regenerateFromProfile.useMutation({
    onSuccess: () => {
      utils.content.list.invalidate();
      utils.content.campaignAssets.invalidate({ campaignId: Number(urlCampaignId) });
      utils.content.countForCampaign.invalidate({ campaignId: Number(urlCampaignId) });
      utils.campaign.get.invalidate({ id: Number(urlCampaignId) });
      utils.agent.getAgentRuns.invalidate({ campaignId: Number(urlCampaignId) });
      toast.success("Campaign pack regenerated from the updated business profile.");
    },
    onError: (err) => {
      utils.content.list.invalidate();
      utils.content.countForCampaign.invalidate({ campaignId: Number(urlCampaignId) });
      utils.campaign.get.invalidate({ id: Number(urlCampaignId) });
      utils.agent.getAgentRuns.invalidate({ campaignId: Number(urlCampaignId) });
      toast.error(err.message || "Failed to regenerate campaign pack");
    },
  });

  const refreshVideoStatusMutation = trpc.video.refreshStatus.useMutation({
    onSuccess: (data) => {
      toast.success(`Video status: ${data.status}`);
      utils.video.listForCampaign.invalidate({ campaignId: Number(urlCampaignId) });
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

  function renderMasterImageSection(content: any) {
    const metadata = (content.metadata || {}) as any;
    const imageUrl = metadata?.imageUrl;
    const imageStatus = metadata?.imageStatus;
    const isGenerating = imageStatus === "generating" || generateImageMutation.isPending;
    const isFailed = imageStatus === "failed";
    const isReady = imageStatus === "ready" && !!imageUrl;
    const imageLoading = loadingImageIds.has(content.id);
    const imageBroken = brokenImageIds.has(content.id);
    const captionPack = campaignAssets?.find(
      (a) => a.assetType === "caption_pack" && (a.metadata as any)?.contentPostId === content.id
    );
    const generate = (strongerBrandFit = false) =>
      generateImageMutation.mutate({
        contentPostId: content.id,
        creativeType: imageCreativeType,
        strongerBrandFit,
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

    const formatSelect = (
      <Select value={imageCreativeType} onValueChange={(v) => setImageCreativeType(v as any)}>
        <SelectTrigger className="w-[180px] h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {IMAGE_CREATIVE_TYPE_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} className="text-xs">
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );

    return (
      <div className="mt-4 rounded-xl border border-slate-200 bg-white overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-slate-50/50">
          <div className="flex items-center gap-2">
            <Image className="w-5 h-5 text-[#00D4FF]" />
            <h3 className="text-sm font-semibold text-slate-900">Premium Marketing Leaflet</h3>
            {statusBadge()}
          </div>
          <div className="flex items-center gap-2">
            {isReady && (
              <Badge
                variant="outline"
                className={`text-[10px] h-6 ${metadata?.imageFallbackUsed ? "border-amber-300 text-amber-700 bg-amber-50" : "border-emerald-200 text-emerald-700 bg-emerald-50"}`}
              >
                {metadata?.imageFallbackUsed ? "Fallback template used" : metadata?.imageSource === "openai" ? "Generated using OpenAI" : "Generated"}
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px] h-6">
              {premiumImageCost} credits
            </Badge>
            {!isReady && !isGenerating && formatSelect}
          </div>
        </div>

        <div className="p-4 grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Preview */}
          <div className="lg:col-span-2">
            {isGenerating ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 flex flex-col items-center justify-center min-h-[320px] text-center px-6">
                <Loader2 className="w-10 h-10 text-[#00D4FF] animate-spin mb-3" />
                <p className="text-sm font-medium text-slate-800">Generating your premium marketing leaflet</p>
                <p className="text-xs text-slate-500 mt-1 max-w-sm">No credits are deducted until the leaflet is ready. This usually takes 20–45 seconds.</p>
              </div>
            ) : isFailed || imageBroken ? (
              <div className="rounded-xl border border-red-200 bg-red-50 flex flex-col items-center justify-center min-h-[320px] text-center px-6">
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
                <Button size="sm" className="mt-4 bg-red-600 hover:bg-red-700 text-white" onClick={() => generate(false)}>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Retry Generation
                </Button>
              </div>
            ) : isReady ? (
              <div className="relative group overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                {imageLoading && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-50">
                    <Loader2 className="w-8 h-8 text-[#00D4FF] animate-spin mb-2" />
                    <p className="text-xs text-slate-500">Loading preview…</p>
                  </div>
                )}
                <img
                  src={imageUrl}
                  alt="Premium marketing leaflet"
                  className={`w-full object-contain max-h-[520px] ${imageLoading ? "opacity-0" : "opacity-100"}`}
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
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 flex flex-col items-center justify-center min-h-[320px] text-center px-6">
                <Image className="w-12 h-12 text-slate-300 mb-3" />
                <p className="text-base font-medium text-slate-800">Premium marketing leaflet not created yet</p>
                <p className="text-sm text-slate-500 mt-1 max-w-md">
                  Generate a ready-to-post marketing leaflet using your approved campaign strategy, brand style and caption pack.
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                  <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => generate(false)}>
                    <Image className="w-4 h-4 mr-2" />
                    Generate Leaflet — {premiumImageCost} credits
                  </Button>
                  <Button size="sm" variant="outline" className="border-purple-300 text-purple-700 hover:bg-purple-50" onClick={() => generate(true)}>
                    <Sparkles className="w-4 h-4 mr-2" />
                    Stronger Brand Fit
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Details / actions */}
          <div className="space-y-4">
            <Card className="border-slate-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Leaflet Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5 text-xs">
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Headline</span>
                  <span className="font-medium text-right line-clamp-2">{content.title || campaignForContext?.goal || "—"}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">CTA</span>
                  <span className="font-medium text-right line-clamp-2">{content.cta || campaignForContext?.preferredCta || "—"}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Business</span>
                  <span className="font-medium text-right line-clamp-1">{businessForContext?.name || "—"}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Format</span>
                  <span className="font-medium text-right capitalize">{imageCreativeType.replace("_", " ")}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Credits charged</span>
                  <span className="font-medium text-right">{metadata?.imageCreditsCharged ?? "—"}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Source</span>
                  <span className={`font-medium text-right ${metadata?.imageFallbackUsed ? "text-amber-700" : "text-emerald-700"}`}>
                    {metadata?.imageFallbackUsed ? "Fallback template used" : metadata?.imageSource === "openai" ? "Generated using OpenAI" : "Generated"}
                  </span>
                </div>
                {typeof metadata?.imageQualityScore === "number" && (
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Quality score</span>
                    <span className={`font-medium text-right ${metadata.imageQualityScore >= 80 ? "text-emerald-700" : metadata.imageQualityScore >= 60 ? "text-amber-700" : "text-red-700"}`}>
                      {metadata.imageQualityScore}/100
                    </span>
                  </div>
                )}
                {metadata?.imageGeneratedAt && (
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Generated</span>
                    <span className="font-medium text-right">
                      {new Date(metadata.imageGeneratedAt).toLocaleString()}
                    </span>
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
              {(isReady || isFailed) && !isGenerating && (
                <>
                  <Button size="sm" variant="outline" className="w-full h-8 text-[12px]" onClick={() => generate(false)} disabled={isGenerating}>
                    <Image className="w-3.5 h-3.5 mr-1.5" />
                    Regenerate Leaflet
                  </Button>
                  <Button size="sm" variant="outline" className="w-full h-8 text-[12px] border-purple-300 text-purple-700 hover:bg-purple-50" onClick={() => generate(true)} disabled={isGenerating}>
                    <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                    Regenerate with Stronger Brand Fit
                  </Button>
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

            {!businessForContext?.logo && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
                <p className="text-[11px] text-amber-700">
                  Tip: Add your logo in Settings to improve brand accuracy.
                </p>
              </div>
            )}
            {businessForContext?.logo && (
              <p className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded-md p-2.5">
                Logo placement may need manual review. OpenAI cannot always place logos precisely.
              </p>
            )}
          </div>
        </div>

        {/* Caption pack */}
        {captionPack && (
          <div className="border-t border-slate-100 p-4 bg-slate-50/40">
            {renderCaptionPack(captionPack, content.id)}
          </div>
        )}
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
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
            <MessageCircle className="w-4 h-4 text-emerald-600" />
            Caption Pack
          </h4>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={() => {
                navigator.clipboard.writeText(copyText);
                toast.success("Caption pack copied.");
              }}
            >
              <Copy className="w-3 h-3 mr-1" />
              Copy All
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={() => generateCaptionPackMutation.mutate({ contentPostId })}
              disabled={generateCaptionPackMutation.isPending}
            >
              <Sparkles className="w-3 h-3 mr-1" />
              Regenerate
            </Button>
          </div>
        </div>
        <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
          {sections.map((s) => (
            <div key={s.key} className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">{s.label}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[10px] px-1.5 text-slate-500 hover:text-slate-800"
                  onClick={() => {
                    navigator.clipboard.writeText(s.text);
                    toast.success(`${s.label} copied.`);
                  }}
                >
                  <Copy className="w-3 h-3 mr-1" />
                  Copy
                </Button>
              </div>
              <p className="text-xs text-slate-700 whitespace-pre-wrap">{s.text}</p>
            </div>
          ))}
        </div>
      </div>
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
          <Badge variant="outline" className="text-[10px] h-5 border-emerald-200 text-emerald-600 bg-emerald-50">
            Premium Marketing Leaflet
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
      <Card key={content.id} className="group hover:shadow-md transition-all">
        <CardContent className="p-5">
          {isMasterCampaignPost && renderMasterImageSection(content)}

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
          {content.caption && (
            <p className="text-sm text-muted-foreground line-clamp-2 mb-1">
              {content.caption}
            </p>
          )}
          {content.cta && (
            <p className="text-xs font-medium text-[#00D4FF] mt-1">
              CTA: {content.cta}
            </p>
          )}

          {renderPremiumBadges(content)}

          {content.type === "social_post" && !isMasterCampaignPost && renderMasterImageSection(content)}

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
    const unapproved = filtered?.filter((c) => !getApprovalState(c) && c.status !== "published") || [];
    if (unapproved.length === 0) {
      toast.info("All items are already approved or published.");
      return;
    }

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
    publishCampaignPackMutation.mutate({ campaignId: Number(urlCampaignId) });
  }

  function renderWorkflowGuidance() {
    if (!campaignForContext) return null;

    const state = campaignForContext.workflowState || "strategy_pending";
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
        description: "Review the audience recommendations, then generate your premium marketing leaflet.",
        tone: "success",
      },
      schedule_generated: {
        title: "Your campaign pack is ready. Next step: generate your premium marketing leaflet.",
        description: "Click Generate Premium Leaflet below to create a ready-to-post marketing leaflet.",
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

    const items = [
      { label: "Campaign strategy approved", done: !["business_onboarding", "strategy_pending", "strategy_generated"].includes(state) },
      { label: "Caption pack created", done: hasCaptionPack },
      { label: "Premium leaflet ready", done: hasImage, loading: isImageGenerating, failed: isImageFailed },
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

    // Primary assets: one premium marketing leaflet; video is gated by feature flags
    const masterVisual =
      filtered.find((c) => ((c.metadata as any)?.assetKind === "master_campaign_post")) ||
      filtered.find((c) => c.type === "social_post");
    const video =
      filtered.find((c) => ((c.metadata as any)?.assetKind === "master_video_ad")) ||
      filtered.find((c) => c.type === "video_concept" || c.type === "reel_script");
    const basicConfigured = videoConfig?.basicConfigured ?? true;
    const premiumConfigured = videoConfig?.premiumConfigured ?? false;
    const videoEnabled = (ENABLE_PREMIUM_VIDEO && premiumConfigured) || (ENABLE_BASIC_DRAFT_VIDEO && basicConfigured);

    // Supporting assets live in campaignAssets, not as primary content cards
    const adaptations = campaignAssets?.filter((a) => a.assetType === "caption_adaptation") || [];
    const hashtagSet = campaignAssets?.find((a) => a.assetType === "hashtag_set");
    const carousel = campaignAssets?.find((a) => a.assetType === "carousel_ad" || a.assetType === "carousel");
    const ads = campaignAssets?.filter((a) => a.assetType === "ad_copy" || a.assetType === "lead_gen_ad") || [];
    const whatsapp = campaignAssets?.find((a) => a.assetType === "whatsapp_promo" || a.assetType === "whatsapp_copy");
    const emailItem = campaignAssets?.find((a) => a.assetType === "email_copy");
    const launch = campaignAssets?.find((a) => a.assetType === "launch_pack");
    const hookBank = campaignAssets?.find((a) => a.assetType === "cta_variant" && a.title === "Hook Bank");
    const ctaBank = campaignAssets?.find((a) => a.assetType === "cta_variant" && a.title === "CTA Variation Bank");
    const otherAssets =
      campaignAssets?.filter(
        (a) =>
          ![
            "caption_adaptation",
            "hashtag_set",
            "carousel_ad",
            "carousel",
            "ad_copy",
            "lead_gen_ad",
            "whatsapp_promo",
            "whatsapp_copy",
            "email_copy",
            "launch_pack",
            "cta_variant",
          ].includes(a.assetType)
      ) || [];
    const allApproved = filtered.every((c) => getApprovalState(c));
    const anyDraft = filtered.some((c) => c.status === "draft");

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
                  {campaignForContext?.name} — {videoEnabled && video ? 2 : 1} primary asset{videoEnabled && video ? "s" : ""}
                  {campaignAssets && campaignAssets.length > 0 && (
                    <span> · {campaignAssets.length} supporting asset{campaignAssets.length === 1 ? "" : "s"}</span>
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
                <Button
                  size="sm"
                  variant="outline"
                  disabled={regenerateFromProfileMutation.isPending}
                  onClick={() => {
                    if (confirm("This will regenerate strategy, leaflet, captions and platform adaptations from the latest business profile. Existing AI-generated assets will be replaced. Continue?")) {
                      regenerateFromProfileMutation.mutate({ campaignId: Number(urlCampaignId) });
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
                <Button
                  size="sm"
                  className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white"
                  disabled={!anyDraft}
                  onClick={handlePublishPack}
                >
                  <Upload className="w-3.5 h-3.5 mr-1.5" />
                  Publish Campaign Pack
                </Button>
              </div>
            </div>
            {campaignForContext?.workflowState && (
              <p className="text-xs text-muted-foreground mt-2">
                Campaign status: <span className="font-medium">{campaignForContext.workflowState.replace(/_/g, " ")}</span>
              </p>
            )}
          </CardContent>
        </Card>

        {renderWorkflowGuidance()}

        {/* Premium Marketing Leaflet — always expanded, adaptations nested inside */}
        {masterVisual && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <Image className="w-4 h-4 text-[#00D4FF]" />
              Premium Marketing Leaflet
            </h3>
            {renderContentCard(masterVisual)}

            {adaptations.length > 0 && (
              <Collapsible
                open={expandedSections.has("adaptations")}
                onOpenChange={() => toggleSection("adaptations")}
              >
                <div className="mt-2 space-y-2">
                  <SectionHeader
                    title="Platform Adaptations"
                    icon={MessageCircle}
                    color="text-purple-600"
                    sectionKey="adaptations"
                    count={adaptations.length}
                  />
                  <CollapsibleContent>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {adaptations.map((adaptation) => {
                        const meta = (adaptation.metadata || {}) as any;
                        return (
                          <Card key={adaptation.id} className="hover:shadow-md transition-all">
                            <CardContent className="p-4">
                              <Badge variant="secondary" className="mb-2 capitalize">
                                {meta.platform || adaptation.assetType}
                              </Badge>
                              <p className="text-sm text-slate-900 font-medium">{adaptation.title}</p>
                              {meta.adaptedCaption && (
                                <p className="text-xs text-muted-foreground mt-1 line-clamp-3">{meta.adaptedCaption}</p>
                              )}
                              {meta.adaptedCta && (
                                <p className="text-xs font-medium text-[#00D4FF] mt-1">CTA: {meta.adaptedCta}</p>
                              )}
                              {meta.adaptedHashtags && Array.isArray(meta.adaptedHashtags) && (
                                <p className="text-[10px] text-muted-foreground mt-1">{meta.adaptedHashtags.join(" ")}</p>
                              )}
                              {meta.formatNotes && (
                                <p className="text-[10px] text-slate-500 mt-1">{meta.formatNotes}</p>
                              )}
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            )}
          </div>
        )}

        {/* Master Video Ad — only when video features are enabled */}
        {videoEnabled && video && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <Video className="w-4 h-4 text-rose-500" />
              Master Video Ad
            </h3>
            {renderContentCard(video)}
          </div>
        )}

        {/* Supporting Assets — collapsed by default */}
        <Collapsible
          open={expandedSections.has("supporting")}
          onOpenChange={() => toggleSection("supporting")}
        >
          <div className="space-y-4 pt-2 border-t border-slate-200">
            <SectionHeader
              title="Supporting Assets"
              icon={FileText}
              color="text-slate-700"
              sectionKey="supporting"
              count={campaignAssets?.length || 0}
            />

            <CollapsibleContent>
              <div className="space-y-4">
                {/* Carousel */}
                {carousel && (
                  <Collapsible open={expandedSections.has("carousel")} onOpenChange={() => toggleSection("carousel")}>
                    <div className="space-y-2">
                      <SectionHeader title="Carousel" icon={FileText} color="text-orange-600" sectionKey="carousel" />
                      <CollapsibleContent>{renderCampaignAssetCard(carousel)}</CollapsibleContent>
                    </div>
                  </Collapsible>
                )}

                {/* Ad Variations */}
                {ads.length > 0 && (
                  <Collapsible open={expandedSections.has("ads")} onOpenChange={() => toggleSection("ads")}>
                    <div className="space-y-2">
                      <SectionHeader title="Ad Variations" icon={Megaphone} color="text-cyan-600" sectionKey="ads" count={ads.length} />
                      <CollapsibleContent>
                        <div className="grid grid-cols-1 gap-4">
                          {ads.map((asset) => renderCampaignAssetCard(asset))}
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                )}

                {/* Hashtag Pack */}
                {hashtagSet && (
                  <Collapsible open={expandedSections.has("hashtags")} onOpenChange={() => toggleSection("hashtags")}>
                    <div className="space-y-2">
                      <SectionHeader title="Hashtag Pack" icon={Hash} color="text-pink-600" sectionKey="hashtags" />
                      <CollapsibleContent>
                        <Card className="hover:shadow-md transition-all">
                          <CardContent className="p-4">
                            {(() => {
                              const meta = (hashtagSet.metadata || {}) as any;
                              return (
                                <div className="space-y-2">
                                  {meta.core && Array.isArray(meta.core) && meta.core.length > 0 && (
                                    <div>
                                      <span className="text-[10px] font-medium text-slate-500 uppercase">Core</span>
                                      <p className="text-xs text-slate-700">{meta.core.join(" ")}</p>
                                    </div>
                                  )}
                                  {meta.trending && Array.isArray(meta.trending) && meta.trending.length > 0 && (
                                    <div>
                                      <span className="text-[10px] font-medium text-slate-500 uppercase">Trending</span>
                                      <p className="text-xs text-slate-700">{meta.trending.join(" ")}</p>
                                    </div>
                                  )}
                                  {meta.niche && Array.isArray(meta.niche) && meta.niche.length > 0 && (
                                    <div>
                                      <span className="text-[10px] font-medium text-slate-500 uppercase">Niche</span>
                                      <p className="text-xs text-slate-700">{meta.niche.join(" ")}</p>
                                    </div>
                                  )}
                                  {meta.platformSpecific && Array.isArray(meta.platformSpecific) && (
                                    <div className="space-y-1">
                                      {meta.platformSpecific.map((ps: any, i: number) => (
                                        <div key={i}>
                                          <span className="text-[10px] font-medium text-slate-500 uppercase">{ps.platform}</span>
                                          <p className="text-xs text-slate-700">{ps.hashtags?.join(" ")}</p>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </CardContent>
                        </Card>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                )}

                {/* WhatsApp */}
                {whatsapp && (
                  <Collapsible open={expandedSections.has("whatsapp")} onOpenChange={() => toggleSection("whatsapp")}>
                    <div className="space-y-2">
                      <SectionHeader title="WhatsApp Version" icon={MessageCircle} color="text-green-600" sectionKey="whatsapp" />
                      <CollapsibleContent>{renderCampaignAssetCard(whatsapp)}</CollapsibleContent>
                    </div>
                  </Collapsible>
                )}

                {/* Email */}
                {emailItem && (
                  <Collapsible open={expandedSections.has("email")} onOpenChange={() => toggleSection("email")}>
                    <div className="space-y-2">
                      <SectionHeader title="Email Version" icon={Mail} color="text-emerald-600" sectionKey="email" />
                      <CollapsibleContent>{renderCampaignAssetCard(emailItem)}</CollapsibleContent>
                    </div>
                  </Collapsible>
                )}

                {/* Launch Sequence */}
                {launch && (
                  <Collapsible open={expandedSections.has("launch")} onOpenChange={() => toggleSection("launch")}>
                    <div className="space-y-2">
                      <SectionHeader title="Launch Sequence" icon={Sparkles} color="text-violet-600" sectionKey="launch" />
                      <CollapsibleContent>{renderCampaignAssetCard(launch)}</CollapsibleContent>
                    </div>
                  </Collapsible>
                )}

                {/* Hook Bank */}
                {hookBank && (
                  <Collapsible open={expandedSections.has("hooks")} onOpenChange={() => toggleSection("hooks")}>
                    <div className="space-y-2">
                      <SectionHeader title="Hook Bank" icon={Hash} color="text-amber-600" sectionKey="hooks" />
                      <CollapsibleContent>{renderCampaignAssetCard(hookBank)}</CollapsibleContent>
                    </div>
                  </Collapsible>
                )}

                {/* CTA Variation Bank */}
                {ctaBank && (
                  <Collapsible open={expandedSections.has("ctas")} onOpenChange={() => toggleSection("ctas")}>
                    <div className="space-y-2">
                      <SectionHeader title="CTA Variation Bank" icon={Megaphone} color="text-blue-600" sectionKey="ctas" />
                      <CollapsibleContent>{renderCampaignAssetCard(ctaBank)}</CollapsibleContent>
                    </div>
                  </Collapsible>
                )}

                {/* Other supporting assets */}
                {otherAssets.length > 0 && (
                  <Collapsible open={expandedSections.has("others")} onOpenChange={() => toggleSection("others")}>
                    <div className="space-y-2">
                      <SectionHeader title="Other Assets" icon={FileText} color="text-slate-600" sectionKey="others" count={otherAssets.length} />
                      <CollapsibleContent>
                        <div className="grid grid-cols-1 gap-4">
                          {otherAssets.map((asset) => renderCampaignAssetCard(asset))}
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                )}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        {/* Publish Dialog */}
        <Dialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Publish Campaign Pack</DialogTitle>
              <DialogDescription>
                Review platform connections before publishing.
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
                        <p className="text-xs text-muted-foreground mt-1">These will be approved and marked as "manually posted". Copy the content and post on each platform.</p>
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
                <Button variant="outline" className="flex-1" onClick={() => setPublishDialogOpen(false)}>
                  Cancel
                </Button>
                <Button className="flex-1 bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white" onClick={executePublishPack}>
                  Approve All & Publish
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="space-y-6">
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
          {urlCampaignId && campaignForContext ? (
            <Button
              variant="outline"
              className="border-[#00D4FF]/50 text-[#00D4FF] hover:bg-[#00D4FF]/10"
              onClick={() => {
                if (campaignForContext.workflowState === "strategy_approved" || campaignForContext.workflowState === "creatives_generating" || campaignForContext.workflowState === "creatives_ready") {
                  generateForCampaignMutation.mutate({ campaignId: Number(urlCampaignId) });
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
          ) : (
            <Dialog open={aiOpen} onOpenChange={setAiOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  className="border-[#00D4FF]/50 text-[#00D4FF] hover:bg-[#00D4FF]/10"
                >
                  <Sparkles className="w-4 h-4 mr-2" />
                  Create One-Off Content
                </Button>
              </DialogTrigger>
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
                      onChange={(e) =>
                        setAiForm({ ...aiForm, business: e.target.value })
                      }
                      placeholder="Your business name"
                    />
                  </div>
                  <div>
                    <Label>Content Type</Label>
                    <Select
                      value={aiForm.type}
                      onValueChange={(v: any) =>
                        setAiForm({ ...aiForm, type: v })
                      }
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
                      onValueChange={(v) =>
                        setAiForm({ ...aiForm, platform: v })
                      }
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
                      onValueChange={(v) =>
                        setAiForm({ ...aiForm, tone: v })
                      }
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
                    onChange={(e) =>
                      setAiForm({ ...aiForm, audience: e.target.value })
                    }
                    placeholder="Young professionals aged 25-40 in Johannesburg"
                  />
                </div>
                <div>
                  <Label>Goal (optional)</Label>
                  <Input
                    value={aiForm.goal}
                    onChange={(e) =>
                      setAiForm({ ...aiForm, goal: e.target.value })
                    }
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
                        onClick={() =>
                          copyToClipboard(aiResult, -1)
                        }
                      >
                        {copiedId === -1 ? (
                          <Check className="w-4 h-4" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
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
        )}

          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90">
                <Plus className="w-4 h-4 mr-2" />
                Add Content
              </Button>
            </DialogTrigger>
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
        </div>
      </div>

      {/* Tabs & Search */}
      {!urlCampaignId && (
        <div className="flex flex-col sm:flex-row gap-4">
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex-1"
          >
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="ai_generated" className="text-purple-400">AI Generated</TabsTrigger>
              <TabsTrigger value="social_post">Social</TabsTrigger>
              <TabsTrigger value="ad_copy">Ads</TabsTrigger>
              <TabsTrigger value="email">Email</TabsTrigger>
              <TabsTrigger value="video_concept">Video</TabsTrigger>
              <TabsTrigger value="carousel_ad">Carousel</TabsTrigger>
              <TabsTrigger value="script">Script</TabsTrigger>
              <TabsTrigger value="blog">Blog</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search content..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      )}

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
                  onClick={() => regenerateFromProfileMutation.mutate({ campaignId: Number(urlCampaignId) })}
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
                  onClick={() => generateForCampaignMutation.mutate({ campaignId: Number(urlCampaignId) })}
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
      ) : (filtered ?? []).length === 0 ? (
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
                  {!urlCampaignId && (
                    <Button variant="outline" onClick={() => setAiOpen(true)}>
                      <Sparkles className="w-4 h-4 mr-2" />
                      Create One-Off Content
                    </Button>
                  )}
                  <Button onClick={() => setCreateOpen(true)}>
                    <Plus className="w-4 h-4 mr-2" />
                    Add Manually
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      ) : urlCampaignId ? (
        renderCampaignPack()
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(filtered ?? []).map((content) => renderContentCard(content))}
        </div>
      )}
    </div>
  );
}
