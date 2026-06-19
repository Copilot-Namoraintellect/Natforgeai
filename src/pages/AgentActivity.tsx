import { useState } from "react";
import { useSearchParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Activity,
  Sparkles,
  Users,
  Megaphone,
  MessageSquare,
  TrendingUp,
  DollarSign,
  Target,
  RotateCcw,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  AlertTriangle,
  Palette,
  Hash,
  BarChart3,
  ArrowRight,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Link } from "react-router";

const agentTypeConfig: Record<string, { icon: any; color: string; label: string }> = {
  strategy: { icon: Target, color: "text-blue-400", label: "Strategy Agent" },
  creative: { icon: Sparkles, color: "text-purple-400", label: "Creative Agent" },
  audience: { icon: Users, color: "text-pink-400", label: "Audience Agent" },
  distribution: { icon: Megaphone, color: "text-cyan-400", label: "Distribution Agent" },
  engagement: { icon: MessageSquare, color: "text-amber-400", label: "Engagement Agent" },
  sales: { icon: DollarSign, color: "text-emerald-400", label: "Sales Agent" },
  optimisation: { icon: TrendingUp, color: "text-indigo-400", label: "Optimisation Agent" },
};

const statusConfig: Record<string, { color: string; icon: any }> = {
  pending: { color: "bg-amber-500/10 text-amber-600", icon: Clock },
  running: { color: "bg-blue-500/10 text-blue-600", icon: Loader2 },
  completed: { color: "bg-emerald-500/10 text-emerald-600", icon: CheckCircle },
  failed: { color: "bg-red-500/10 text-red-600", icon: XCircle },
};

function FormattedAgentOutput({ agentType, output }: { agentType: string; output: any }) {
  if (!output) return null;

  if (agentType === "strategy") {
    return (
      <div className="space-y-2">
        {output.personas && (
          <div>
            <p className="text-xs font-semibold text-[#00D4FF] flex items-center gap-1"><Users className="w-3 h-3" /> Personas</p>
            <div className="flex flex-wrap gap-1 mt-1">
              {output.personas.slice(0, 3).map((p: any, i: number) => (
                <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/20">{p.name}</span>
              ))}
            </div>
          </div>
        )}
        {output.coreMessage && <p className="text-xs text-gray-300"><span className="text-gray-500">Core Message:</span> {output.coreMessage}</p>}
        {output.valueProposition && <p className="text-xs text-gray-300"><span className="text-gray-500">Value Prop:</span> {output.valueProposition}</p>}
        {output.budgetRecommendation && (
          <p className="text-xs text-gray-300"><span className="text-gray-500">Budget:</span> ${output.budgetRecommendation.total?.toLocaleString?.() || output.budgetRecommendation.total}</p>
        )}
      </div>
    );
  }

  if (agentType === "creative") {
    const days = output.days || (output.calendar?.days);
    const assets = output.assets;
    return (
      <div className="space-y-2">
        {days && (
          <div>
            <p className="text-xs font-semibold text-purple-400 flex items-center gap-1"><Palette className="w-3 h-3" /> Content Calendar</p>
            <p className="text-xs text-gray-300">{days.length} days scheduled with {days.reduce((acc: number, d: any) => acc + (d.posts?.length || 0), 0)} posts</p>
          </div>
        )}
        {assets && (
          <div>
            <p className="text-xs font-semibold text-purple-400 flex items-center gap-1"><Sparkles className="w-3 h-3" /> Assets</p>
            <p className="text-xs text-gray-300">{assets.length} creative assets generated</p>
          </div>
        )}
      </div>
    );
  }

  if (agentType === "audience") {
    return <AudienceAgentDetail output={output} />;
  }

  if (agentType === "distribution") {
    const schedule = output.schedule;
    return (
      <div className="space-y-2">
        {schedule && (
          <div>
            <p className="text-xs font-semibold text-cyan-400 flex items-center gap-1"><BarChart3 className="w-3 h-3" /> Publishing Schedule</p>
            <p className="text-xs text-gray-300">{schedule.length} posts queued across platforms</p>
          </div>
        )}
      </div>
    );
  }

  if (agentType === "engagement") {
    return (
      <div className="space-y-2">
        {output.reply && <p className="text-xs text-gray-300"><span className="text-gray-500">Reply:</span> {output.reply.substring(0, 120)}...</p>}
        {output.sentiment && <p className="text-xs text-gray-300"><span className="text-gray-500">Sentiment:</span> {output.sentiment}</p>}
        {output.shouldEscalate && (
          <p className="text-xs text-amber-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Escalation required</p>
        )}
      </div>
    );
  }

  if (agentType === "sales") {
    const messages = output.messages;
    return (
      <div className="space-y-2">
        {messages && (
          <div>
            <p className="text-xs font-semibold text-emerald-400 flex items-center gap-1"><DollarSign className="w-3 h-3" /> Follow-up Sequence</p>
            <p className="text-xs text-gray-300">{messages.length} messages over {messages[messages.length - 1]?.day} days</p>
          </div>
        )}
        {output.title && <p className="text-xs text-gray-300"><span className="text-gray-500">Proposal:</span> {output.title}</p>}
      </div>
    );
  }

  // Fallback for unknown agent types
  return (
    <div className="space-y-1">
      {Object.entries(output).slice(0, 4).map(([key, value]) => (
        <p key={key} className="text-xs text-gray-300">
          <span className="text-gray-500">{key}:</span>{" "}
          {typeof value === "string" ? value.substring(0, 100) : JSON.stringify(value).substring(0, 100)}
        </p>
      ))}
    </div>
  );
}

function AudienceAgentDetail({ output }: { output: any }) {
  const [showRaw, setShowRaw] = useState(false);
  const profiles = output.audienceProfiles || [];
  const hashtags = output.hashtagStrategy || {};
  const targeting = output.targetingCriteria || {};
  const outreach = output.outreachAngles || [];

  return (
    <div className="space-y-3">
      {profiles.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-pink-400 flex items-center gap-1"><Users className="w-3 h-3" /> Audience Profiles</p>
          {profiles.map((p: any, i: number) => (
            <div key={i} className="p-2.5 rounded-lg bg-[#0F172A] border border-[#334155] space-y-1.5">
              <p className="text-xs font-medium text-white">{p.name}</p>
              {p.demographics && (
                <div className="flex flex-wrap gap-1">
                  {p.demographics.ageRange && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-pink-500/10 text-pink-300 border border-pink-500/20">{p.demographics.ageRange}</span>
                  )}
                  {p.demographics.gender && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-pink-500/10 text-pink-300 border border-pink-500/20">{p.demographics.gender}</span>
                  )}
                  {Array.isArray(p.demographics.locations) && p.demographics.locations.slice(0, 2).map((loc: string, idx: number) => (
                    <span key={idx} className="text-[10px] px-1.5 py-0.5 rounded bg-pink-500/10 text-pink-300 border border-pink-500/20">{loc}</span>
                  ))}
                </div>
              )}
              {Array.isArray(p.goals) && p.goals.length > 0 && (
                <div>
                  <span className="text-[10px] font-medium text-emerald-400 uppercase tracking-wide">Goals</span>
                  <p className="text-[11px] text-gray-300">{p.goals.join(", ")}</p>
                </div>
              )}
              {Array.isArray(p.painPoints) && p.painPoints.length > 0 && (
                <div>
                  <span className="text-[10px] font-medium text-red-400 uppercase tracking-wide">Pain Points</span>
                  <p className="text-[11px] text-gray-300">{p.painPoints.join(", ")}</p>
                </div>
              )}
              {Array.isArray(p.platforms) && p.platforms.length > 0 && (
                <div>
                  <span className="text-[10px] font-medium text-blue-400 uppercase tracking-wide">Platforms</span>
                  <p className="text-[11px] text-gray-300">{p.platforms.join(", ")}</p>
                </div>
              )}
              {p.description && <p className="text-[11px] text-gray-400">{p.description}</p>}
            </div>
          ))}
        </div>
      )}

      {hashtags.primary && (
        <div>
          <p className="text-xs font-semibold text-pink-400 flex items-center gap-1"><Hash className="w-3 h-3" /> Hashtags</p>
          <p className="text-[11px] text-gray-300 mt-1">{hashtags.primary.slice(0, 8).join(" ")}</p>
        </div>
      )}

      {(targeting.interests?.length > 0 || targeting.behaviours?.length > 0) && (
        <div>
          <p className="text-xs font-semibold text-pink-400 flex items-center gap-1"><Target className="w-3 h-3" /> Targeting</p>
          {targeting.interests?.length > 0 && <p className="text-[11px] text-gray-300"><span className="text-gray-500">Interests:</span> {targeting.interests.slice(0, 5).join(", ")}</p>}
          {targeting.behaviours?.length > 0 && <p className="text-[11px] text-gray-300"><span className="text-gray-500">Behaviours:</span> {targeting.behaviours.slice(0, 5).join(", ")}</p>}
        </div>
      )}

      {outreach.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-pink-400 flex items-center gap-1"><MessageSquare className="w-3 h-3" /> Messaging Angles</p>
          <ul className="mt-1 space-y-0.5">
            {outreach.slice(0, 4).map((angle: string, i: number) => (
              <li key={i} className="text-[11px] text-gray-300">• {angle}</li>
            ))}
          </ul>
        </div>
      )}

      <button
        onClick={() => setShowRaw((s) => !s)}
        className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 mt-1"
      >
        {showRaw ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        {showRaw ? "Hide raw data" : "View raw data"}
      </button>
      {showRaw && (
        <pre className="text-[10px] text-gray-500 bg-[#0F172A] p-2 rounded border border-[#334155] overflow-auto max-h-40">
          {JSON.stringify(output, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function AgentActivity() {
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const utils = trpc.useUtils();
  const [searchParams] = useSearchParams();
  const urlCampaignId = searchParams.get("campaignId");

  const { data: agentRuns, isLoading } = trpc.agent.getAgentRuns.useQuery({
    campaignId: urlCampaignId ? Number(urlCampaignId) : undefined,
    agentType: filterType !== "all" ? (filterType as any) : undefined,
    status: filterStatus !== "all" ? (filterStatus as any) : undefined,
  }, {
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasRunning = data?.some((r) => r.status === "running");
      return hasRunning ? 5000 : 10000;
    },
  });

  // Fetch campaigns to determine correct CTA state per run
  const { data: allCampaigns } = trpc.campaign.list.useQuery(undefined, {
    refetchInterval: 10000,
  });
  const campaignMap = new Map(allCampaigns?.map((c) => [c.id, c]));

  // Fetch pending approvals to know if strategy_review is still open
  const { data: pendingApprovals } = trpc.approval.listApprovals.useQuery(
    { status: "pending" },
    { enabled: !!agentRuns && agentRuns.length > 0, refetchInterval: 10000 }
  );
  const pendingStrategyApprovals = new Set(
    pendingApprovals
      ?.filter((a) => a.approvalType === "strategy_review")
      .map((a) => a.campaignId) ?? []
  );

  const runStrategyAgent = trpc.agent.runStrategyAgent.useMutation({
    onSuccess: () => {
      toast.success("Strategy generation restarted");
      utils.agent.getAgentRuns.invalidate();
    },
    onError: (err) => toast.error(err.message || "Retry failed"),
  });
  const runCreativeAgent = trpc.agent.runCreativeAgent.useMutation({
    onSuccess: () => {
      toast.success("Creative generation restarted");
      utils.agent.getAgentRuns.invalidate();
    },
    onError: (err) => toast.error(err.message || "Retry failed"),
  });
  const runAudienceAgent = trpc.agent.runAudienceAgent.useMutation({
    onSuccess: () => {
      toast.success("Audience generation restarted");
      utils.agent.getAgentRuns.invalidate();
    },
    onError: (err) => toast.error(err.message || "Retry failed"),
  });
  const runDistributionAgent = trpc.agent.runDistributionAgent.useMutation({
    onSuccess: () => {
      toast.success("Distribution generation restarted");
      utils.agent.getAgentRuns.invalidate();
    },
    onError: (err) => toast.error(err.message || "Retry failed"),
  });

  function handleRetry(run: any) {
    if (!run.campaignId) return;
    switch (run.agentType) {
      case "strategy":
        runStrategyAgent.mutate({ campaignId: run.campaignId, generate: true });
        break;
      case "creative":
        runCreativeAgent.mutate({ campaignId: run.campaignId });
        break;
      case "audience":
        runAudienceAgent.mutate({ campaignId: run.campaignId });
        break;
      case "distribution":
        runDistributionAgent.mutate({ campaignId: run.campaignId });
        break;
      default:
        toast.info("Retry is not available for this agent type yet.");
    }
  }

  function friendlyErrorMessage(error: string | null): string {
    if (!error) return "Something went wrong. Please try again.";
    const lower = error.toLowerCase();
    if (lower.includes("insufficient credits") || lower.includes("payment_required")) {
      return "This task failed because you ran out of credits. Top up your balance and try again.";
    }
    if (lower.includes("timeout") || lower.includes("timed out")) {
      return "NatForgeAI took too long to respond. This can happen during high demand. Please retry.";
    }
    if (lower.includes("rate limit") || lower.includes("too many requests")) {
      return "Too many requests were sent in a short time. Please wait a moment and retry.";
    }
    if (lower.includes("network") || lower.includes("fetch") || lower.includes("connection")) {
      return "A network issue occurred. Please check your connection and retry.";
    }
    if (lower.includes("invalid") && lower.includes("api key")) {
      return "The AI service key is not configured correctly. Contact support.";
    }
    return "NatForgeAI encountered an issue while processing this task. You can retry or contact support if it keeps happening.";
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Activity className="w-6 h-6 text-[#00D4FF]" />
            Agent Activity
          </h1>
          <p className="text-slate-600 mt-1">
            Timeline of all AI agent executions and tasks
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-[180px] bg-[#1E293B] border-[#334155] text-white">
            <SelectValue placeholder="Agent Type" />
          </SelectTrigger>
          <SelectContent className="bg-[#1E293B] border-[#334155]">
            <SelectItem value="all" className="text-white">All Agents</SelectItem>
            {Object.entries(agentTypeConfig).map(([key, config]) => (
              <SelectItem key={key} value={key} className="text-white">
                {config.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-[180px] bg-[#1E293B] border-[#334155] text-white">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent className="bg-[#1E293B] border-[#334155]">
            <SelectItem value="all" className="text-white">All Statuses</SelectItem>
            <SelectItem value="pending" className="text-white">Pending</SelectItem>
            <SelectItem value="running" className="text-white">Running</SelectItem>
            <SelectItem value="completed" className="text-white">Completed</SelectItem>
            <SelectItem value="failed" className="text-white">Failed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Activity Timeline */}
      <div className="space-y-3">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">Loading activity...</div>
        ) : agentRuns && agentRuns.length > 0 ? (
          agentRuns.map((run) => {
            const campaign = run.campaignId ? campaignMap.get(run.campaignId) : null;
            const savedPosts = (campaign?.workflowContext as { savedPosts?: number } | undefined)?.savedPosts;
            // A "completed" creative run that produced no saved posts is effectively a failure.
            const effectiveStatus =
              run.agentType === "creative" && run.status === "completed" && savedPosts === 0
                ? "failed"
                : run.status;
            const effectiveError =
              effectiveStatus === "failed" && run.status === "completed" && savedPosts === 0
                ? "Creative Agent completed but no content was created."
                : run.error;

            const agentConfig = agentTypeConfig[run.agentType] || {
              icon: Activity,
              color: "text-gray-400",
              label: run.agentType,
            };
            const statusConfigItem = statusConfig[effectiveStatus] || {
              color: "bg-gray-500/10 text-gray-600",
              icon: Clock,
            };
            const AgentIcon = agentConfig.icon;
            const StatusIcon = statusConfigItem.icon;

            return (
              <Card
                key={run.id}
                className="bg-[#1E293B] border-[#334155] hover:border-[#00D4FF]/20 transition-colors"
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-4">
                    <div className={`p-2.5 rounded-xl bg-[#0F172A] ${agentConfig.color}`}>
                      <AgentIcon className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-white">{agentConfig.label}</span>
                        <Badge className={statusConfigItem.color}>
                          <StatusIcon className="w-3 h-3 mr-1" />
                          {effectiveStatus}
                        </Badge>
                      </div>
                      <p className="text-sm text-gray-400">
                        Campaign #{run.campaignId} •{" "}
                        {run.createdAt
                          ? new Date(run.createdAt).toLocaleString()
                          : "Unknown date"}
                      </p>

                      {effectiveStatus === "failed" && (
                        <div className="mt-2 p-2 rounded-lg bg-red-500/10 border border-red-500/20">
                          <p className="text-sm text-red-400">{friendlyErrorMessage(effectiveError)}</p>
                          <p className="text-xs text-red-400/70 mt-1">Credits were not refunded for this failed attempt.</p>
                        </div>
                      )}

                      {effectiveStatus === "completed" && (
                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                          {run.campaignId && (
                            (() => {
                              const campaign = campaignMap.get(run.campaignId);
                              const isTerminal = campaign && ["campaign_live", "engagement_active", "leads_converting", "optimisation_active", "completed"].includes(campaign.workflowState);
                              if (isTerminal) return null;
                              return (
                                <Link to={`/campaigns?campaignId=${run.campaignId}`}>
                                  <Button size="sm" variant="outline" className="border-[#334155] text-gray-300 hover:text-white h-7 text-xs">
                                    Open Campaign
                                    <ArrowRight className="w-3 h-3 ml-1" />
                                  </Button>
                                </Link>
                              );
                            })()
                          )}
                          {run.agentType === "strategy" && (
                            (() => {
                              const campaign = run.campaignId ? campaignMap.get(run.campaignId) : null;
                              const isBeyondApproval = campaign && [
                                "strategy_approved", "creatives_generating", "creatives_ready",
                                "audience_generating", "audience_ready", "schedule_generated",
                                "launch_approval_required", "campaign_live",
                              ].includes(campaign.workflowState);
                              const hasPendingApproval = run.campaignId ? pendingStrategyApprovals.has(run.campaignId) : false;
                              const isStrategyGenerated = campaign?.workflowState === "strategy_generated";

                              if (isBeyondApproval) {
                                return (
                                  <Link to="/approvals">
                                    <Button size="sm" className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white h-7 text-xs">
                                      <CheckCircle className="w-3 h-3 mr-1" />
                                      View Approved Strategy
                                    </Button>
                                  </Link>
                                );
                              }
                              if (isStrategyGenerated && hasPendingApproval) {
                                return (
                                  <Link to="/approvals">
                                    <Button size="sm" className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white h-7 text-xs">
                                      Review Strategy
                                    </Button>
                                  </Link>
                                );
                              }
                              return (
                                <Button size="sm" variant="outline" className="h-7 text-xs" disabled>
                                  <CheckCircle className="w-3 h-3 mr-1" />
                                  Strategy Reviewed
                                </Button>
                              );
                            })()
                          )}
                          {run.agentType === "creative" && run.campaignId && (
                            <Link to={`/content?campaignId=${run.campaignId}`}>
                              <Button size="sm" className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white h-7 text-xs">
                                View Content
                              </Button>
                            </Link>
                          )}
                          {run.agentType === "audience" && run.campaignId && (
                            <Link to={`/campaigns?campaignId=${run.campaignId}`}>
                              <Button size="sm" variant="outline" className="border-[#334155] text-gray-300 hover:text-white h-7 text-xs">
                                <Users className="w-3 h-3 mr-1" />
                                View Audience
                              </Button>
                            </Link>
                          )}
                        </div>
                      )}

                      {!!run.output && (
                        <div className="mt-2 p-3 rounded-lg bg-[#0F172A] border border-[#334155]">
                          <p className="text-xs text-gray-500 mb-2 flex items-center gap-1">
                            <Sparkles className="w-3 h-3" /> Output Preview
                          </p>
                          <FormattedAgentOutput agentType={run.agentType} output={run.output as any} />
                        </div>
                      )}
                    </div>

                    {effectiveStatus === "failed" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-[#334155] text-gray-300 hover:text-white shrink-0"
                        onClick={() => handleRetry(run)}
                        disabled={runStrategyAgent.isPending || runCreativeAgent.isPending || runAudienceAgent.isPending || runDistributionAgent.isPending}
                      >
                        <RotateCcw className="w-3.5 h-3.5 mr-1" />
                        Retry
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })
        ) : (
          <Card className="bg-[#1E293B] border-[#334155]">
            <CardContent className="p-8 text-center">
              <Activity className="w-12 h-12 text-gray-500/50 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-white mb-2">No activity yet</h3>
              <p className="text-gray-400">
                Agent activity will appear here once campaigns start running.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
