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
} from "lucide-react";
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
    type: "social_post" as "social_post" | "ad_copy" | "email",
    goal: "",
  });
  const [aiResult, setAiResult] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState<{ open: boolean; contentId: number | null }>({
    open: false,
    contentId: null,
  });
  const [scheduleDate, setScheduleDate] = useState("");

  const utils = trpc.useUtils();
  const listInput = (() => {
    const base: any = {};
    if (urlCampaignId) base.campaignId = Number(urlCampaignId);
    if (activeTab === "ai_generated") base.aiGenerated = true;
    else if (activeTab !== "all") base.type = activeTab;
    return Object.keys(base).length > 0 ? base : undefined;
  })();
  const { data: contents, isLoading } = trpc.content.list.useQuery(listInput);

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
    onSuccess: () => {
      utils.content.list.invalidate();
      toast.success("Content approved and ready to publish!");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to approve content");
    },
  });

  const markManuallyPostedMutation = trpc.content.markAsManuallyPosted.useMutation({
    onSuccess: () => {
      utils.content.list.invalidate();
      toast.success("Marked as manually posted!");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to update content");
    },
  });

  const updateMutation = trpc.content.update.useMutation({
    onSuccess: () => {
      utils.content.list.invalidate();
      toast.success("Content updated!");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to update content");
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
  };

  const statusColors: Record<string, string> = {
    draft: "bg-slate-500/10 text-slate-600 border-slate-200",
    scheduled: "bg-blue-500/10 text-blue-600 border-blue-200",
    published: "bg-emerald-500/10 text-emerald-600 border-emerald-200",
    archived: "bg-gray-500/10 text-gray-600 border-gray-200",
  };

  function isPlatformConnected(platform?: string | null) {
    if (!platform) return false;
    // Social platforms that require connection
    const connectable = ["facebook", "instagram", "linkedin", "tiktok", "twitter", "whatsapp"];
    if (!connectable.includes(platform)) return true; // email/blog don't need OAuth
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
          <Dialog open={aiOpen} onOpenChange={setAiOpen}>
            <DialogTrigger asChild>
              <Button
                variant="outline"
                className="border-[#00D4FF]/50 text-[#00D4FF] hover:bg-[#00D4FF]/10"
              >
                <Sparkles className="w-4 h-4 mr-2" />
                AI Generate
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
                      placeholder="3@1 Newmarket"
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
              <Button className="flex-1" onClick={handleScheduleSave} disabled={!scheduleDate || updateMutation.isPending}>
                {updateMutation.isPending ? "Saving..." : "Schedule"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Content Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6 h-32" />
            </Card>
          ))}
        </div>
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
                  <Button variant="outline" onClick={() => setAiOpen(true)}>
                    <Sparkles className="w-4 h-4 mr-2" />
                    AI Generate
                  </Button>
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(filtered ?? []).map((content) => {
            const approved = getApprovalState(content);
            const connected = isPlatformConnected(content.platform);
            const configurable = isPlatformConfigurable(content.platform);
            const showConnectGuard = content.platform && ["facebook", "instagram", "linkedin", "tiktok", "twitter", "whatsapp"].includes(content.platform) && !connected;
            const captionText = getCaptionText(content);

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
                          copyToClipboard(captionText, content.id)
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

                  {showConnectGuard && (
                    <div className="mt-3 p-2.5 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <p className="font-medium">Publishing setup required</p>
                        <p className="text-amber-700/80">
                          Connect {content.platform} in Integrations to publish automatically, or mark as manually posted.
                        </p>
                        <div className="mt-2 flex gap-2">
                          {configurable ? (
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

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {!approved && content.status !== "published" && (
                      <Button
                        size="sm"
                        className="h-8 bg-emerald-600 hover:bg-emerald-700 text-white"
                        onClick={() => approveMutation.mutate({ id: content.id })}
                        disabled={approveMutation.isPending}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                        Approve
                      </Button>
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
                        >
                          <CalendarClock className="w-3.5 h-3.5 mr-1.5" />
                          {content.status === "scheduled" ? "Reschedule" : "Schedule"}
                        </Button>

                        {showConnectGuard ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8"
                            onClick={() => markManuallyPostedMutation.mutate({ id: content.id })}
                            disabled={markManuallyPostedMutation.isPending}
                          >
                            <Upload className="w-3.5 h-3.5 mr-1.5" />
                            Mark as posted
                          </Button>
                        ) : connected ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8"
                            onClick={() => {
                              toast.info("Auto-publishing is coming soon. Use 'Mark as posted' if you published manually.");
                            }}
                          >
                            <Upload className="w-3.5 h-3.5 mr-1.5" />
                            Publish now
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8"
                            onClick={() => markManuallyPostedMutation.mutate({ id: content.id })}
                            disabled={markManuallyPostedMutation.isPending}
                          >
                            <Upload className="w-3.5 h-3.5 mr-1.5" />
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
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
