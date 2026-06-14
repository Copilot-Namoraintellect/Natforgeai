import { useState } from "react";
import { useSearchParams, Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { Card, CardContent } from "@/components/ui/card";
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
} from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { toast } from "sonner";

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

  // Fetch campaigns and approvals to show contextual empty-state guidance
  const { data: campaigns } = trpc.campaign.list.useQuery();
  const { data: approvals } = trpc.approval.listApprovals.useQuery(
    { status: "pending" },
    { enabled: (contents?.length ?? 0) === 0 }
  );

  const { data: connectedIntegrations } = trpc.integration.getConnectedPlatforms.useQuery();
  const { data: platformConfigStatus } = trpc.integration.getPlatformConfigStatus.useQuery();

  const strategyPendingApproval = approvals?.find((a) => a.approvalType === "strategy_review");
  const strategyGeneratedCampaign = campaigns?.find((c) => c.workflowState === "strategy_generated");
  const strategyPendingCampaign = campaigns?.find((c) => c.workflowState === "strategy_pending");

  const campaignNeedsRecovery = !!urlCampaignId && campaignForContext &&
    (campaignForContext.workflowState === "creatives_generating" || campaignForContext.workflowState === "creatives_ready") &&
    (postCountForCampaign === 0 || (contents?.length ?? 0) === 0);

  const generateForCampaignMutation = trpc.content.generateForCampaign.useMutation({
    onSuccess: (data) => {
      utils.content.list.invalidate();
      utils.content.countForCampaign.invalidate({ campaignId: Number(urlCampaignId) });
      toast.success(`Content generated successfully. ${data.postCount} posts created.`);
    },
    onError: (err) => {
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
    return platformConfigStatus?.find((p) => p.platform === platform)?.configured !== false;
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
    const connected = isPlatformConnected(content.platform);
    if (!connected && content.platform && ["facebook", "instagram", "linkedin", "tiktok", "twitter", "whatsapp"].includes(content.platform)) {
      toast.error("Automatic publishing is not configured for this platform. You can copy or mark this content as manually posted.");
      return;
    }
    toast.info("Auto-publishing is coming soon. Use 'Mark as posted' if you published manually.");
  }

  const renderVideoMutation = trpc.video.renderVideo.useMutation({
    onSuccess: (data) => {
      toast.success("Video rendered successfully!");
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
    const configured = videoConfig?.configured ?? true; // local renderer is always configured
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
            <Badge variant="outline" className="text-emerald-600 border-emerald-200 bg-emerald-50 text-[10px] h-6">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Ready to Preview
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
            <Button
              size="sm"
              className="h-7 text-[11px] bg-rose-600 hover:bg-rose-700 text-white"
              onClick={() => renderVideoMutation.mutate({ contentPostId: content.id })}
              disabled={renderVideoMutation.isPending}
            >
              {renderVideoMutation.isPending ? (
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              ) : (
                <Video className="w-3 h-3 mr-1" />
              )}
              Render Video
            </Button>
          )}

          {videoUrl && (
            <>
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
                <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50 text-[10px] h-6">
                  <AlertCircle className="w-3 h-3 mr-1" />
                  Failed
                </Badge>
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

        {!configured && !videoUrl && (
          <p className="text-[10px] text-slate-400">
            Video rendering is not configured. This is a storyboard only.
          </p>
        )}
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
        {metadata.assetKind === "video_blueprint" && metadata.videoStatus === "concept" && (
          <Badge variant="outline" className="text-[10px] h-5 border-amber-200 text-amber-600 bg-amber-50">
            Storyboard
          </Badge>
        )}
        {metadata.assetKind === "video_blueprint" && metadata.videoStatus === "rendering" && (
          <Badge variant="outline" className="text-[10px] h-5 border-purple-200 text-purple-600 bg-purple-50">
            Rendering
          </Badge>
        )}
        {metadata.assetKind === "video_blueprint" && metadata.videoStatus === "ready" && metadata.videoUrl && (
          <Badge variant="outline" className="text-[10px] h-5 border-emerald-200 text-emerald-600 bg-emerald-50">
            Ready to Preview
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
    const isVideo = content.type === "video_concept" || content.type === "reel_script";
    const videoReady = isVideo && meta.videoStatus === "ready" && meta.videoUrl;
    const videoBlocked = isVideo && !videoReady;

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

    return (
      <Card key={content.id} className="group hover:shadow-md transition-all">
        <CardContent className="p-5">
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
          onClick={() => toggleSection(sectionKey)}
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

  function getPlatformConnectionStatus() {
    const platformsUsed = new Set<string>();
    filtered?.forEach((c) => {
      if (c.platform) platformsUsed.add(c.platform);
    });
    const result: { platform: string; connected: boolean; configurable: boolean }[] = [];
    platformsUsed.forEach((p) => {
      result.push({
        platform: p,
        connected: !!isPlatformConnected(p),
        configurable: isPlatformConfigurable(p),
      });
    });
    return result;
  }

  function handlePublishPack() {
    const unapproved = filtered?.filter((c) => !getApprovalState(c) && c.status !== "published") || [];
    if (unapproved.length === 0) {
      toast.info("All items are already approved or published.");
      return;
    }

    // Frontend guard: check video readiness
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

    setPublishDialogOpen(true);
  }

  function executePublishPack() {
    if (!urlCampaignId) return;
    publishCampaignPackMutation.mutate({ campaignId: Number(urlCampaignId) });
  }

  function renderCampaignPack() {
    if (!urlCampaignId || !filtered) return null;

    // Primary assets: exactly one master campaign post and one master video ad
    const masterVisual =
      filtered.find((c) => ((c.metadata as any)?.assetKind === "master_campaign_post")) ||
      filtered.find((c) => c.type === "social_post");
    const video =
      filtered.find((c) => ((c.metadata as any)?.assetKind === "master_video_ad")) ||
      filtered.find((c) => c.type === "video_concept" || c.type === "reel_script");

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
                  {campaignForContext?.name} — 2 primary assets
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

        {/* Master Campaign Post — always expanded, adaptations nested inside */}
        {masterVisual && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <Image className="w-4 h-4 text-[#00D4FF]" />
              Master Campaign Post
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

        {/* Master Video Ad — always expanded */}
        {video && (
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
                const status = getPlatformConnectionStatus();
                const connected = status.filter((s) => s.connected);
                const disconnected = status.filter((s) => !s.connected);
                return (
                  <div className="space-y-3">
                    {connected.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-emerald-700 uppercase tracking-wide mb-1">Connected Platforms</p>
                        <div className="flex flex-wrap gap-2">
                          {connected.map((s) => (
                            <Badge key={s.platform} className="bg-emerald-50 text-emerald-700 border-emerald-200 capitalize">
                              <CheckCircle2 className="w-3 h-3 mr-1" />
                              {s.platform}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">These will attempt automatic publishing.</p>
                      </div>
                    )}
                    {disconnected.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-amber-700 uppercase tracking-wide mb-1">Manual Posting Required</p>
                        <div className="flex flex-wrap gap-2">
                          {disconnected.map((s) => (
                            <Badge key={s.platform} variant="outline" className="text-amber-700 border-amber-200 bg-amber-50 capitalize">
                              <AlertCircle className="w-3 h-3 mr-1" />
                              {s.platform}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          These will be approved and marked as "manually posted". Copy the content and post on each platform.
                        </p>
                      </div>
                    )}
                    {status.length === 0 && (
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
            <p className="text-lg font-medium text-slate-900">Content generation did not complete successfully</p>
            <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-md text-center">
              The Creative Agent ran but no posts were saved. You can retry content generation for this campaign.
            </p>
            <div className="flex gap-2 flex-wrap justify-center">
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
                  No content has been generated yet. Review your campaign strategy first, then NatForgeAI can generate sales-focused content.
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
