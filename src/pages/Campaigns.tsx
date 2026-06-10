import { useState, useEffect, useMemo } from "react";
import { useSearchParams, useNavigate, Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useUsage } from "@/hooks/useUsage";
import {
  workflowStateLabels,
  workflowGuidance,
  journeyStage,
  getContinueAction,
} from "@/lib/workflow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Megaphone,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Eye,
  Target,
  DollarSign,
  Crown,
  AlertCircle,
  Loader2,
  Rocket,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

export default function Campaigns() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlCampaignId = searchParams.get("campaignId");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [viewCampaign, setViewCampaign] = useState<any>(null);
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const { campaigns: campaignUsage, results: resultUsage, isLoading: usageLoading, tierName } = useUsage();

  const { data: campaigns, isLoading } = trpc.campaign.list.useQuery(undefined, {
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const hasRunning = data.some((c) =>
        c.workflowState && ["strategy_pending", "creatives_generating", "audience_generating"].includes(c.workflowState)
      );
      return hasRunning ? 5000 : false;
    },
  });
  const { data: businessList } = trpc.business.list.useQuery();
  const primaryBusiness = useMemo(() => businessList?.[0] ?? null, [businessList]);

  // Form state for campaign creation (controlled so we can prefill and improve with AI)
  const [formName, setFormName] = useState("");
  const [formGoal, setFormGoal] = useState("");
  const [formTargetAudience, setFormTargetAudience] = useState("");
  const [formPlatforms, setFormPlatforms] = useState<string[]>([]);
  const [formBudget, setFormBudget] = useState<string>("");
  const [formCoreMessage, setFormCoreMessage] = useState("");

  const PLATFORM_OPTIONS = [
    { value: "Instagram", label: "Instagram" },
    { value: "Facebook", label: "Facebook" },
    { value: "TikTok", label: "TikTok" },
    { value: "LinkedIn", label: "LinkedIn" },
    { value: "X/Twitter", label: "X/Twitter" },
    { value: "WhatsApp", label: "WhatsApp" },
    { value: "Email", label: "Email" },
    { value: "Google Ads", label: "Google Ads", comingSoon: true },
  ];

  // Prefill from business profile when modal opens
  useEffect(() => {
    if (createOpen && primaryBusiness) {
      setFormTargetAudience(primaryBusiness.targetAudience || primaryBusiness.targetCustomer || "");
      setFormBudget(primaryBusiness.monthlyBudget ? String(primaryBusiness.monthlyBudget) : "");
      if (primaryBusiness.preferredPlatforms) {
        const prefs = primaryBusiness.preferredPlatforms.split(",").map((p: string) => p.trim());
        const matched = prefs.filter((p: string) => PLATFORM_OPTIONS.some((o) => o.value === p));
        setFormPlatforms(matched);
      }
    }
  }, [createOpen, primaryBusiness]);

  // Fetch pending approvals for the viewed campaign to wire strategy approval into workflow
  const { data: campaignPendingApprovals } = trpc.approval.listApprovals.useQuery(
    { campaignId: viewCampaign?.id ?? 0, status: "pending" },
    { enabled: !!viewCampaign }
  );
  const strategyApproval = campaignPendingApprovals?.find(
    (a) => a.approvalType === "strategy_review"
  );

  const approveStrategyMutation = trpc.approval.approveAction.useMutation({
    onSuccess: () => {
      toast.success("Strategy approved. NatForgeAI is generating your content plan.");
      utils.campaign.list.invalidate();
      utils.agent.getAgentRuns.invalidate();
      utils.content.list.invalidate();
      utils.approval.listApprovals.invalidate();
      utils.approval.listApprovals.invalidate({ status: "pending" });
      setViewCampaign(null);
    },
    onError: (err) => {
      toast.error(err.message || "Failed to approve strategy");
    },
  });

  // Auto-open campaign detail when navigated with ?campaignId=xxx
  useEffect(() => {
    if (urlCampaignId && campaigns) {
      const id = Number(urlCampaignId);
      const camp = campaigns.find((c) => c.id === id);
      if (camp) {
        setViewCampaign(camp);
        setHighlightedId(id);
        setTimeout(() => setHighlightedId(null), 4000);
        // Clean up URL
        searchParams.delete("campaignId");
        setSearchParams(searchParams, { replace: true });
      }
    }
  }, [urlCampaignId, campaigns]);

  const createMutation = trpc.campaign.create.useMutation({
    onSuccess: async (data) => {
      utils.campaign.list.invalidate();
      utils.subscription.myUsage.invalidate();
      setCreateOpen(false);
      toast.success("Campaign created. NatForgeAI is preparing your strategy.");
      // Reset form
      setFormName("");
      setFormGoal("");
      setFormTargetAudience("");
      setFormPlatforms([]);
      setFormBudget("");
      setFormCoreMessage("");
      if (data.id) {
        setHighlightedId(data.id);
        setTimeout(() => setHighlightedId(null), 4000);
        // Route immediately using the workflowState returned by the server
        if (data.workflowState === "business_onboarding") {
          navigate("/onboarding");
        } else if (data.workflowState === "strategy_pending") {
          navigate(`/agent-activity?campaignId=${data.id}`);
          // Fallback frontend trigger in case backend async start missed
          setTimeout(() => {
            runStrategyAgentMutation.mutate({ campaignId: data.id, generate: true });
          }, 1500);
        } else if (data.workflowState === "strategy_generated") {
          navigate("/approvals");
        }
      }
    },
    onError: (err) => {
      toast.error(err.message || "Failed to create campaign");
    },
  });

  const improveBriefMutation = trpc.campaign.improveBrief.useMutation({
    onSuccess: (data) => {
      if (data.suggestions) {
        setFormName((prev) => prev || data.suggestions.name || prev);
        setFormGoal((prev) => prev || data.suggestions.goal || prev);
        setFormTargetAudience((prev) => prev || data.suggestions.targetAudience || prev);
        if (data.suggestions.platforms) {
          const prefs = data.suggestions.platforms.split(",").map((p: string) => p.trim());
          const matched = prefs.filter((p: string) => PLATFORM_OPTIONS.some((o) => o.value === p));
          if (matched.length > 0) setFormPlatforms(matched);
        }
        setFormBudget((prev) => prev || String(data.suggestions.budget ?? prev));
        setFormCoreMessage((prev) => prev || data.suggestions.coreMessage || prev);
        toast.success("Brief improved with AI suggestions.");
      }
    },
    onError: (err) => {
      toast.error(err.message || "Failed to improve brief");
    },
  });
  const deleteMutation = trpc.campaign.delete.useMutation({
    onSuccess: () => {
      utils.campaign.list.invalidate();
      toast.success("Campaign deleted!");
    },
  });
  const updateMutation = trpc.campaign.update.useMutation({
    onSuccess: () => {
      utils.campaign.list.invalidate();
      toast.success("Campaign updated!");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to update campaign");
    },
  });
  const runCreativeAgent = trpc.agent.runCreativeAgent.useMutation({
    onSuccess: () => {
      toast.success("Strategy approved. NatForgeAI is generating your content plan.");
      utils.campaign.list.invalidate();
      utils.agent.getAgentRuns.invalidate();
      utils.content.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Failed to generate creative content. The campaign is blocked. Please retry from Mission Control.");
    },
  });
  const runStrategyAgentMutation = trpc.agent.runStrategyAgent.useMutation({
    onSuccess: (data) => {
      if (data.skipped) {
        toast.info(data.reason || "Strategy generation is already in progress.");
      } else {
        toast.success("Strategy generation started.");
      }
      utils.campaign.list.invalidate();
      utils.agent.getAgentRuns.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Failed to start strategy generation");
    },
  });

  const filtered = campaigns?.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase());
    if (!matchesSearch) return false;
    if (filter === "all") return true;
    if (filter === "draft") return c.status === "draft" || c.workflowState === "business_onboarding";
    if (filter === "strategy_pending") return c.workflowState === "strategy_pending";
    if (filter === "strategy_ready") return c.workflowState === "strategy_generated";
    if (filter === "active") return c.status === "active" || ["strategy_approved","creatives_generating","creatives_ready","audience_generating","audience_ready","schedule_generated","launch_approval_required","campaign_live","engagement_active","leads_converting","optimisation_active"].includes(c.workflowState);
    if (filter === "completed") return c.workflowState === "completed" || c.status === "completed";
    return true;
  });

  const statusColors: Record<string, string> = {
    draft: "bg-amber-500/10 text-amber-600",
    active: "bg-emerald-500/10 text-emerald-600",
    paused: "bg-orange-500/10 text-orange-600",
    completed: "bg-blue-500/10 text-blue-600",
  };

  const filterTabs = [
    { key: "all", label: "All" },
    { key: "draft", label: "Draft" },
    { key: "strategy_pending", label: "Strategy Pending" },
    { key: "strategy_ready", label: "Strategy Ready" },
    { key: "active", label: "Active" },
    { key: "completed", label: "Completed" },
  ];

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (createMutation.isPending) return;
    createMutation.mutate({
      name: formName,
      goal: formGoal,
      targetAudience: formTargetAudience,
      platforms: formPlatforms.join(", "),
      budget: formBudget ? Number(formBudget) : undefined,
      coreMessage: formCoreMessage,
    });
  }

  function togglePlatform(value: string) {
    setFormPlatforms((prev) =>
      prev.includes(value) ? prev.filter((p) => p !== value) : [...prev, value]
    );
  }

  function handleImproveBrief() {
    if (improveBriefMutation.isPending) return;
    improveBriefMutation.mutate({
      name: formName,
      goal: formGoal,
      targetAudience: formTargetAudience,
      platforms: formPlatforms.join(", "),
      budget: formBudget ? Number(formBudget) : undefined,
      coreMessage: formCoreMessage,
    });
  }

  const isCampaignLimitReached = campaignUsage.atLimit;

  return (
    <div className="space-y-6">
      {/* Usage / Limit Banner */}
      {!usageLoading && (
        <>
          {isCampaignLimitReached ? (
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardContent className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
                      <AlertCircle className="w-5 h-5 text-amber-600" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-amber-700">
                        Plan Limit Reached
                      </p>
                      <p className="text-xs text-amber-600/80">
                        You have used the campaign allowance included in your current plan. Upgrade your plan to create additional campaigns.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button asChild size="sm" variant="outline" className="border-amber-500/30 text-amber-600 hover:bg-amber-500/10">
                      <Link to="/pricing">View Plans</Link>
                    </Button>
                    <Button asChild size="sm" className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90 text-white">
                      <Link to="/pricing">Contact Support</Link>
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="border-[#00D4FF]/20 bg-gradient-to-r from-[#00D4FF]/5 to-[#7C3AED]/5">
              <CardContent className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#00D4FF] to-[#7C3AED] flex items-center justify-center">
                      <Crown className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-[#0F172A]">
                        {tierName} Plan Usage
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {campaignUsage.used}/{campaignUsage.limit} campaigns · {resultUsage.used}/{resultUsage.limit} results
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 flex-1 max-w-md">
                    <div className="flex-1">
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-muted-foreground">Campaigns</span>
                        <span className="font-medium">{campaignUsage.remaining} left</span>
                      </div>
                      <Progress value={campaignUsage.percent} className="h-2" />
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-muted-foreground">Results</span>
                        <span className="font-medium">{resultUsage.remaining} left</span>
                      </div>
                      <Progress value={resultUsage.percent} className="h-2" />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Campaigns</h1>
          <p className="text-muted-foreground mt-1">
            Plan, launch, and track your marketing campaigns.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button
              className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90"
              disabled={isCampaignLimitReached}
            >
              <Plus className="w-4 h-4 mr-2" />
              New Campaign
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Campaign</DialogTitle>
              <DialogDescription>
                Fill in the details below to create a new marketing campaign.
              </DialogDescription>
            </DialogHeader>
            {isCampaignLimitReached ? (
              <div className="py-8 text-center space-y-4">
                <AlertCircle className="w-12 h-12 text-[#7C3AED] mx-auto" />
                <div>
                  <p className="text-lg font-semibold text-[#0F172A]">Campaign Limit Reached</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    You've used all {campaignUsage.limit} campaigns on your {tierName} plan.
                  </p>
                </div>
                <Button asChild className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90 text-white">
                  <Link to="/pricing" onClick={() => setCreateOpen(false)}>
                    Upgrade to Create More
                  </Link>
                </Button>
              </div>
            ) : (
              <form onSubmit={handleCreate} className="space-y-5 mt-4">
                {/* Section: Overview */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Overview</p>
                  <div>
                    <Label>Campaign Name</Label>
                    <Input
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="Summer Sale 2025"
                      required
                    />
                  </div>
                  <div>
                    <Label>Campaign Objective</Label>
                    <Input
                      value={formGoal}
                      onChange={(e) => setFormGoal(e.target.value)}
                      placeholder="Increase walk-ins by 30%"
                      required
                    />
                  </div>
                </div>

                {/* Section: Audience & Channels */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Audience & Channels</p>
                  <div>
                    <Label>Target Audience</Label>
                    <Textarea
                      value={formTargetAudience}
                      onChange={(e) => setFormTargetAudience(e.target.value)}
                      placeholder="Young professionals aged 25-40..."
                    />
                  </div>
                  <div>
                    <Label>Channels / Platforms</Label>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {PLATFORM_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={opt.comingSoon}
                          onClick={() => !opt.comingSoon && togglePlatform(opt.value)}
                          className={[
                            "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                            opt.comingSoon
                              ? "border-dashed border-slate-300 text-slate-400 cursor-not-allowed"
                              : formPlatforms.includes(opt.value)
                              ? "bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white border-transparent"
                              : "border-slate-300 text-slate-600 hover:border-[#00D4FF] hover:text-[#00D4FF]",
                          ].join(" ")}
                        >
                          {opt.label}
                          {opt.comingSoon && " (Soon)"}
                        </button>
                      ))}
                    </div>
                    {formPlatforms.length === 0 && (
                      <p className="text-xs text-muted-foreground mt-1">Select at least one channel.</p>
                    )}
                  </div>
                </div>

                {/* Section: Budget & Message */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Budget & Message</p>
                  <div>
                    <Label>Estimated Marketing Spend Guidance ($)</Label>
                    <Input
                      type="number"
                      value={formBudget}
                      onChange={(e) => setFormBudget(e.target.value)}
                      placeholder="5000"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      This helps NatForgeAI calibrate recommendations. It is not a fee charged by NatForgeAI.
                    </p>
                  </div>
                  <div>
                    <Label>Core Message / Offer</Label>
                    <Textarea
                      value={formCoreMessage}
                      onChange={(e) => setFormCoreMessage(e.target.value)}
                      placeholder="Your main value proposition..."
                    />
                  </div>
                </div>

                {/* Optional AI action */}
                <Button
                  type="button"
                  variant="outline"
                  className="w-full border-[#7C3AED]/30 text-[#7C3AED] hover:bg-[#7C3AED]/10"
                  onClick={handleImproveBrief}
                  disabled={improveBriefMutation.isPending}
                >
                  {improveBriefMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Wand2 className="w-4 h-4 mr-2" />
                  )}
                  Improve Brief with AI
                </Button>

                <Button
                  type="submit"
                  className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
                  disabled={createMutation.isPending}
                >
                  {createMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Rocket className="w-4 h-4 mr-2" />
                  )}
                  Create Campaign
                </Button>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters & Search */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex flex-wrap gap-2">
          {filterTabs.map((tab) => (
            <Button
              key={tab.key}
              size="sm"
              variant={filter === tab.key ? "default" : "outline"}
              className={filter === tab.key ? "bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white" : ""}
              onClick={() => setFilter(tab.key)}
            >
              {tab.label}
            </Button>
          ))}
        </div>
        <div className="relative flex-1 max-w-sm ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search campaigns..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Campaigns Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6 h-40" />
            </Card>
          ))}
        </div>
      ) : (filtered ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Megaphone className="w-12 h-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium">
              {filter === "all" ? "No campaigns yet" : `No ${filterTabs.find(t => t.key === filter)?.label?.toLowerCase()} campaigns`}
            </p>
            <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-md text-center">
              {filter === "all"
                ? "Create your first marketing campaign to get started."
                : filter === "draft"
                ? "Draft campaigns will appear here once you start creating a campaign."
                : filter === "strategy_pending"
                ? "Campaigns with strategy generation in progress will appear here."
                : filter === "strategy_ready"
                ? "Campaigns ready for strategy review will appear here."
                : filter === "active"
                ? "Active campaigns that are live or in progress will appear here."
                : "Completed campaigns will appear here."}
            </p>
            {filter === "all" && (
              <Button onClick={() => setCreateOpen(true)} disabled={isCampaignLimitReached}>
                <Plus className="w-4 h-4 mr-2" />
                Create Campaign
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {(filtered ?? []).map((camp) => {
            const guidance = camp.workflowState ? workflowGuidance[camp.workflowState] : null;
            const stage = camp.workflowState ? journeyStage[camp.workflowState] : "Draft";
            const continueAction = getContinueAction(camp);
            return (
              <Card key={camp.id} className={`group hover:shadow-lg transition-all ${highlightedId === camp.id ? "ring-2 ring-[#00D4FF] shadow-[#00D4FF]/20" : ""}`}>
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex gap-1.5 flex-wrap">
                      <Badge
                        variant="secondary"
                        className={statusColors[camp.status] || "bg-muted"}
                      >
                        {camp.status}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {stage}
                      </Badge>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setViewCampaign(camp)}
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-red-500 hover:text-red-600"
                        onClick={() => deleteMutation.mutate({ id: camp.id })}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                  <h3 className="font-semibold text-base mb-1">{camp.name}</h3>
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                    {camp.goal}
                  </p>
                  {guidance && (
                    <p className="text-xs text-muted-foreground mb-3">
                      {guidance.explanation}
                    </p>
                  )}
                  {camp.aiGenerated && camp.workflowState && (
                    <div className="mt-2">
                      <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                        <span>Autonomous Journey</span>
                        <span>{Math.round((workflowStateLabels[camp.workflowState]?.step || 1) / 15 * 100)}%</span>
                      </div>
                      <Progress
                        value={(workflowStateLabels[camp.workflowState]?.step || 1) / 15 * 100}
                        className="h-1"
                      />
                    </div>
                  )}
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    {continueAction && (
                      <Link to={continueAction.href}>
                        <Button size="sm" className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white h-7 text-xs">
                          <Rocket className="w-3 h-3 mr-1" />
                          {continueAction.label}
                        </Button>
                      </Link>
                    )}
                    {camp.workflowState === "strategy_pending" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => runStrategyAgentMutation.mutate({ campaignId: camp.id, generate: true })}
                        disabled={runStrategyAgentMutation.isPending && runStrategyAgentMutation.variables?.campaignId === camp.id}
                      >
                        {runStrategyAgentMutation.isPending && runStrategyAgentMutation.variables?.campaignId === camp.id ? (
                          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                        ) : (
                          <Rocket className="w-3 h-3 mr-1" />
                        )}
                        {runStrategyAgentMutation.isPending && runStrategyAgentMutation.variables?.campaignId === camp.id ? "Starting..." : "Start Strategy"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => setViewCampaign(camp)}
                    >
                      View Details
                    </Button>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground mt-3">
                    {camp.platforms && (
                      <span className="flex items-center gap-1">
                        <Target className="w-3 h-3" />
                        {camp.platforms}
                      </span>
                    )}
                    {camp.budget && (
                      <span className="flex items-center gap-1">
                        <DollarSign className="w-3 h-3" />
                        {camp.budget.toLocaleString()}
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* View Campaign Dialog */}
      {viewCampaign && (
        <Dialog open={!!viewCampaign} onOpenChange={() => setViewCampaign(null)}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{viewCampaign.name}</DialogTitle>
              <DialogDescription>
                {viewCampaign.workflowState ? journeyStage[viewCampaign.workflowState] : "Campaign details and strategy document."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 mt-4">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge className={statusColors[viewCampaign.status] || "bg-muted"}>
                  {viewCampaign.status}
                </Badge>
                {viewCampaign.aiGenerated && (
                  <Badge variant="outline" className="flex items-center gap-1">
                    <Sparkles className="w-3 h-3" />
                    AI Generated
                  </Badge>
                )}
                {viewCampaign.workflowState && (
                  <Badge className={workflowStateLabels[viewCampaign.workflowState]?.color || "bg-muted"}>
                    {journeyStage[viewCampaign.workflowState] || workflowStateLabels[viewCampaign.workflowState]?.label || viewCampaign.workflowState}
                  </Badge>
                )}
              </div>
              {viewCampaign.aiGenerated && viewCampaign.workflowState && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Workflow Progress</span>
                    <span>{Math.round((workflowStateLabels[viewCampaign.workflowState]?.step || 1) / 15 * 100)}%</span>
                  </div>
                  <Progress value={(workflowStateLabels[viewCampaign.workflowState]?.step || 1) / 15 * 100} className="h-2" />
                </div>
              )}
              <div>
                <h4 className="text-sm font-semibold mb-1">Goal</h4>
                <p className="text-sm text-muted-foreground">{viewCampaign.goal}</p>
              </div>
              {viewCampaign.targetAudience && (
                <div>
                  <h4 className="text-sm font-semibold mb-1">Target Audience</h4>
                  <p className="text-sm text-muted-foreground">{viewCampaign.targetAudience}</p>
                </div>
              )}
              {viewCampaign.coreMessage && (
                <div>
                  <h4 className="text-sm font-semibold mb-1">Core Message</h4>
                  <p className="text-sm text-muted-foreground">{viewCampaign.coreMessage}</p>
                </div>
              )}
              {viewCampaign.strategyDocument && (
                <div>
                  <h4 className="text-sm font-semibold mb-1">Strategy Document</h4>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{viewCampaign.strategyDocument}</p>
                </div>
              )}
              {viewCampaign.personas && Array.isArray(viewCampaign.personas) && viewCampaign.personas.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Target Personas</h4>
                  <div className="space-y-2">
                    {viewCampaign.personas.map((p: any, i: number) => (
                      <div key={i} className="p-3 rounded-lg bg-muted/50 border border-border">
                        <p className="text-sm font-medium text-foreground">{p.name}</p>
                        {p.demographics && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {typeof p.demographics === "string"
                              ? p.demographics
                              : [
                                  p.demographics.ageRange,
                                  p.demographics.gender,
                                  p.demographics.location,
                                  Array.isArray(p.demographics.locations) && p.demographics.locations.length > 0
                                    ? p.demographics.locations.join(", ")
                                    : null,
                                  Array.isArray(p.demographics.languages) && p.demographics.languages.length > 0
                                    ? p.demographics.languages.join(", ")
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                          </p>
                        )}
                        {p.goals && (
                          <div className="mt-1.5">
                            <span className="text-[10px] font-medium text-emerald-600 uppercase tracking-wide">Goals</span>
                            <p className="text-xs text-muted-foreground">
                              {Array.isArray(p.goals) ? p.goals.join(", ") : p.goals}
                            </p>
                          </div>
                        )}
                        {p.painPoints && (
                          <div className="mt-1.5">
                            <span className="text-[10px] font-medium text-red-500 uppercase tracking-wide">Pain Points</span>
                            <p className="text-xs text-muted-foreground">
                              {Array.isArray(p.painPoints) ? p.painPoints.join(", ") : p.painPoints}
                            </p>
                          </div>
                        )}
                        {p.platforms && (
                          <div className="mt-1.5">
                            <span className="text-[10px] font-medium text-blue-500 uppercase tracking-wide">Platforms</span>
                            <p className="text-xs text-muted-foreground">
                              {Array.isArray(p.platforms) ? p.platforms.join(", ") : p.platforms}
                            </p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {viewCampaign.funnelStages && Array.isArray(viewCampaign.funnelStages) && viewCampaign.funnelStages.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Funnel Stages</h4>
                  <div className="flex flex-wrap gap-2">
                    {viewCampaign.funnelStages.map((f: any, i: number) => (
                      <Badge key={i} variant="outline" className="text-xs">
                        {typeof f === "string" ? f : f.stage || JSON.stringify(f)}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {viewCampaign.offers && Array.isArray(viewCampaign.offers) && viewCampaign.offers.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Offers</h4>
                  <div className="space-y-2">
                    {viewCampaign.offers.map((o: any, i: number) => (
                      <div key={i} className="p-3 rounded-lg bg-muted/50 border border-border">
                        <p className="text-sm font-medium text-foreground">{o.name || o.title || `Offer ${i + 1}`}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{o.description || o.valueProposition || ""}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {viewCampaign.ctaStrategy && (
                <div>
                  <h4 className="text-sm font-semibold mb-1">CTA Strategy</h4>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{viewCampaign.ctaStrategy}</p>
                </div>
              )}
              {viewCampaign.workflowState && workflowGuidance[viewCampaign.workflowState] && (
                <div className="p-3 rounded-lg bg-muted/50 border border-border">
                  <p className="text-sm font-medium text-foreground">
                    {workflowGuidance[viewCampaign.workflowState].explanation}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Next: {workflowGuidance[viewCampaign.workflowState].nextAction}
                  </p>
                </div>
              )}
              <div className="flex gap-3 pt-2 flex-wrap">
                {(() => {
                  const continueAction = getContinueAction(viewCampaign);
                  if (continueAction) {
                    return (
                      <Link to={continueAction.href}>
                        <Button className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white">
                          <Rocket className="w-4 h-4 mr-2" />
                          {continueAction.label}
                        </Button>
                      </Link>
                    );
                  }
                  return null;
                })()}
                {!viewCampaign.aiGenerated && (viewCampaign.status === "active" || viewCampaign.status === "paused") && (
                  <Button
                    variant="outline"
                    disabled={updateMutation.isPending}
                    onClick={() => {
                      const newStatus =
                        viewCampaign.status === "active" ? "paused" : "active";
                      updateMutation.mutate({
                        id: viewCampaign.id,
                        status: newStatus as any,
                      });
                      setViewCampaign({ ...viewCampaign, status: newStatus });
                    }}
                  >
                    {viewCampaign.status === "active" ? "Pause" : "Activate"}
                  </Button>
                )}
                {viewCampaign.workflowState === "strategy_generated" && (
                  <Button
                    className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white"
                    disabled={approveStrategyMutation.isPending}
                    onClick={() => {
                      if (strategyApproval) {
                        approveStrategyMutation.mutate({ approvalId: strategyApproval.id });
                      } else {
                        // Fallback for legacy campaigns without approval request
                        updateMutation.mutate(
                          {
                            id: viewCampaign.id,
                            status: "active",
                            workflowState: "strategy_approved",
                          },
                          {
                            onSuccess: () => {
                              runCreativeAgent.mutate({ campaignId: viewCampaign.id });
                            },
                          }
                        );
                        setViewCampaign({ ...viewCampaign, status: "active", workflowState: "strategy_approved" });
                        toast.info("Approving strategy and starting content generation...");
                      }
                    }}
                  >
                    {approveStrategyMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Approving...
                      </>
                    ) : (
                      "Approve Strategy"
                    )}
                  </Button>
                )}
                {viewCampaign.workflowState === "launch_approval_required" && (
                  <Button
                    className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white"
                    onClick={() => {
                      updateMutation.mutate({
                        id: viewCampaign.id,
                        status: "active",
                        workflowState: "campaign_live",
                      } as any);
                      setViewCampaign({ ...viewCampaign, status: "active", workflowState: "campaign_live" });
                      toast.success("Campaign launched!");
                    }}
                  >
                    Approve Launch
                  </Button>
                )}
                {viewCampaign.workflowState === "strategy_pending" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      runStrategyAgentMutation.mutate({ campaignId: viewCampaign.id, generate: true });
                      setViewCampaign(null);
                    }}
                    disabled={runStrategyAgentMutation.isPending && runStrategyAgentMutation.variables?.campaignId === viewCampaign.id}
                  >
                    {runStrategyAgentMutation.isPending && runStrategyAgentMutation.variables?.campaignId === viewCampaign.id ? (
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    ) : (
                      <Rocket className="w-3 h-3 mr-1" />
                    )}
                    {runStrategyAgentMutation.isPending && runStrategyAgentMutation.variables?.campaignId === viewCampaign.id ? "Starting..." : "Start Strategy"}
                  </Button>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
