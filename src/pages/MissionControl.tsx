import { useMemo } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  workflowStateLabels,
  workflowGuidance,
  journeyStage,
  getContinueAction,
} from "@/lib/workflow";
import {
  Rocket,
  Megaphone,
  Users,
  PenTool,
  CheckCircle,
  AlertCircle,
  Sparkles,
  Zap,
  ArrowRight,
  BarChart3,
  Loader2,
  Target,
} from "lucide-react";

function itemText(count: number) {
  return count !== 1 ? "s" : "";
}

export default function MissionControl() {
  // Poll every 5 seconds when there are running agents or in-progress campaigns
  const { data: campaigns, isLoading: campaignsLoading } = trpc.campaign.list.useQuery(undefined, {
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const hasRunning = data.some((c) =>
        c.workflowState && ["strategy_pending", "creatives_generating", "audience_generating"].includes(c.workflowState)
      );
      return hasRunning ? 5000 : false;
    },
  });
  const { data: agentRuns } = trpc.agent.getAgentRuns.useQuery(
    { status: "completed" },
    { refetchInterval: 10000 }
  );
  const { data: runningAgents } = trpc.agent.getAgentRuns.useQuery(
    { status: "running" },
    { refetchInterval: 5000 }
  );
  const { data: pendingApprovals } = trpc.approval.listApprovals.useQuery(
    { status: "pending" },
    { refetchInterval: 5000 }
  );
  const { data: leads } = trpc.lead.list.useQuery();
  const { data: wallet } = trpc.billing.myWallet.useQuery();

  const aiCampaigns = useMemo(
    () => campaigns?.filter((c) => c.aiGenerated) || [],
    [campaigns]
  );

  const campaignsInProgress = useMemo(
    () => aiCampaigns.filter((c) =>
      c.workflowState &&
      c.workflowState !== "completed" &&
      c.workflowState !== "campaign_live" &&
      c.workflowState !== "engagement_active" &&
      c.workflowState !== "leads_converting" &&
      c.workflowState !== "optimisation_active"
    ),
    [aiCampaigns]
  );

  const liveCampaigns = useMemo(
    () => aiCampaigns.filter((c) => c.workflowState === "campaign_live" || c.workflowState === "engagement_active" || c.workflowState === "leads_converting" || c.workflowState === "optimisation_active"),
    [aiCampaigns]
  );

  const approvalCount = pendingApprovals?.length ?? 0;
  const completedAgentRuns = agentRuns?.length ?? 0;

  const dailySummary = useMemo(() => {
    const runningCount = runningAgents?.length ?? 0;
    const pendingReviewCount = approvalCount;
    const hotLeads = leads?.filter((l) => l.score && l.score > 80).length ?? 0;

    let message = "NatForge is ready to launch your first campaign.";
    if (aiCampaigns.length > 0) {
      if (runningCount > 0) {
        message = `NatForgeAI is working on ${runningCount} active task${itemText(runningCount)}.`;
      } else if (pendingReviewCount > 0) {
        message = `You have ${pendingReviewCount} campaign${itemText(pendingReviewCount)} waiting for your review.`;
      } else {
        message = "Your campaigns are running smoothly.";
      }
      if (hotLeads > 0) message += ` ${hotLeads} hot lead${itemText(hotLeads)} captured.`;
    }
    return message;
  }, [aiCampaigns.length, runningAgents, approvalCount, leads]);

  const stats = [
    {
      title: "Campaigns in Progress",
      value: campaignsInProgress.length,
      icon: Megaphone,
      color: "text-[#00D4FF]",
      bg: "bg-[#00D4FF]/10",
      link: "/campaigns",
    },
    {
      title: "Live Campaigns",
      value: liveCampaigns.length,
      icon: CheckCircle,
      color: "text-emerald-500",
      bg: "bg-emerald-500/10",
      link: "/campaigns",
    },
    {
      title: "Pending Reviews",
      value: approvalCount,
      icon: AlertCircle,
      color: "text-amber-500",
      bg: "bg-amber-500/10",
      link: "/approvals",
    },
    {
      title: "AI Tasks Completed",
      value: completedAgentRuns,
      icon: Sparkles,
      color: "text-purple-500",
      bg: "bg-purple-500/10",
      link: "/agent-activity",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Rocket className="w-6 h-6 text-[#00D4FF]" />
            Mission Control
          </h1>
          <p className="text-slate-600 mt-1">{dailySummary}</p>
        </div>
        <div className="flex items-center gap-3">
          {approvalCount > 0 && (
            <Link to="/approvals">
              <Button variant="outline" className="border-amber-500/30 text-amber-500 hover:bg-amber-500/10">
                <AlertCircle className="w-4 h-4 mr-2" />
                {approvalCount} Approval{itemText(approvalCount)} Needed
              </Button>
            </Link>
          )}
          <Link to="/campaigns">
            <Button className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white hover:opacity-90">
              <Zap className="w-4 h-4 mr-2" />
              New Campaign
            </Button>
          </Link>
        </div>
      </div>

      {/* Next Best Action Banner */}
      {!campaignsLoading && aiCampaigns.length > 0 && (
        <Card className="bg-gradient-to-r from-[#00D4FF]/10 to-[#7C3AED]/10 border-[#00D4FF]/20">
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-slate-900">Recommended next step</p>
                {approvalCount > 0 ? (
                  <>
                    <p className="text-sm text-slate-600 mt-1">
                      You have {approvalCount} approval{itemText(approvalCount)} waiting for review. Approve them to keep your workflow moving.
                    </p>
                    <Link to="/approvals" className="inline-block mt-3">
                      <Button size="sm" className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white">
                        <AlertCircle className="w-3.5 h-3.5 mr-1.5" />
                        Review Now
                      </Button>
                    </Link>
                  </>
                ) : campaignsInProgress.length > 0 ? (
                  <>
                    <p className="text-sm text-slate-600 mt-1">
                      {campaignsInProgress.length} campaign{itemText(campaignsInProgress.length)} in progress. Check Agent Activity for live updates.
                    </p>
                    <Link to="/agent-activity" className="inline-block mt-3">
                      <Button size="sm" variant="outline" className="border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/10">
                        <Loader2 className="w-3.5 h-3.5 mr-1.5" />
                        View Live Activity
                      </Button>
                    </Link>
                  </>
                ) : liveCampaigns.length > 0 ? (
                  <>
                    <p className="text-sm text-slate-600 mt-1">
                      {liveCampaigns.length} campaign{itemText(liveCampaigns.length)} live. Head to Analytics to see performance.
                    </p>
                    <Link to="/analytics" className="inline-block mt-3">
                      <Button size="sm" variant="outline" className="border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10">
                        <BarChart3 className="w-3.5 h-3.5 mr-1.5" />
                        View Analytics
                      </Button>
                    </Link>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-slate-600 mt-1">
                      Your campaigns are up to date. Ready to launch a new one?
                    </p>
                    <Link to="/campaigns" className="inline-block mt-3">
                      <Button size="sm" className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white">
                        <Rocket className="w-3.5 h-3.5 mr-1.5" />
                        New Campaign
                      </Button>
                    </Link>
                  </>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <Link key={stat.title} to={stat.link}>
              <Card className="bg-[#1E293B] border-[#334155] hover:border-[#00D4FF]/30 transition-colors cursor-pointer">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-400">{stat.title}</p>
                      <p className={`text-2xl font-bold ${stat.color} mt-1`}>{stat.value}</p>
                    </div>
                    <div className={`p-2.5 rounded-xl ${stat.bg}`}>
                      <Icon className={`w-5 h-5 ${stat.color}`} />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      {/* Active Campaigns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Megaphone className="w-5 h-5 text-[#00D4FF]" />
            Campaign Workflow
          </h2>

          {campaignsLoading ? (
            <div className="p-8 text-center text-gray-400">Loading campaigns...</div>
          ) : aiCampaigns.length === 0 ? (
            <Card className="bg-[#1E293B] border-[#334155]">
              <CardContent className="p-8 text-center">
                <Rocket className="w-12 h-12 text-[#00D4FF]/50 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-white mb-2">No campaigns yet</h3>
                <p className="text-gray-400 mb-4">
                  Complete onboarding to launch your first AI-powered marketing campaign.
                </p>
                <Link to="/onboarding">
                  <Button className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white">
                    Start Onboarding
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            aiCampaigns.map((campaign) => {
              const stateInfo = workflowStateLabels[campaign.workflowState] || {
                label: campaign.workflowState,
                color: "bg-gray-500/10 text-gray-600",
                step: 1,
              };
              const progressPercent = (stateInfo.step / 15) * 100;
              const nextAction = workflowGuidance[campaign.workflowState];
              const continueAction = getContinueAction(campaign);
              const stage = journeyStage[campaign.workflowState] || "Draft";

              return (
                <Card key={campaign.id} className="bg-[#1E293B] border-[#334155]">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="font-semibold text-white">{campaign.name}</h3>
                        <p className="text-sm text-gray-400">{campaign.goal}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <Badge className={stateInfo.color}>{stateInfo.label}</Badge>
                        <span className="text-[10px] text-gray-500">{stage}</span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-xs text-gray-400">
                        <span>Journey Progress</span>
                        <span>{Math.round(progressPercent)}%</span>
                      </div>
                      <Progress value={progressPercent} className="h-1.5" />
                    </div>

                    {nextAction && (
                      <p className="text-xs text-gray-400 mt-3">
                        {nextAction.explanation}
                      </p>
                    )}

                    <div className="flex items-center gap-3 mt-3">
                      {continueAction ? (
                        <Link to={continueAction.href}>
                          <Button
                            size="sm"
                            className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white"
                          >
                            <Rocket className="w-3 h-3 mr-1" />
                            {continueAction.label}
                          </Button>
                        </Link>
                      ) : (
                        <Link to={`/campaigns`}>
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-[#334155] text-gray-300 hover:text-white hover:bg-[#334155]"
                          >
                            View Details
                            <ArrowRight className="w-3 h-3 ml-1" />
                          </Button>
                        </Link>
                      )}
                      {campaign.workflowState === "strategy_pending" && (
                        <Button size="sm" variant="outline" disabled className="border-[#334155] text-gray-400">
                          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                          Preparing Strategy
                        </Button>
                      )}
                      {nextAction?.actionLabel && nextAction?.actionHref && !continueAction && (
                        <Link to={nextAction.actionHref}>
                          <Button
                            size="sm"
                            className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white"
                          >
                            {nextAction.actionLabel}
                          </Button>
                        </Link>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>

        {/* Side Panel */}
        <div className="space-y-4">
          {/* Status Overview */}
          <Card className="bg-[#1E293B] border-[#334155]">
            <CardHeader className="pb-3">
              <CardTitle className="text-white text-base flex items-center gap-2">
                <Target className="w-4 h-4 text-[#00D4FF]" />
                Status Overview
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {runningAgents && runningAgents.length > 0 ? (
                <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                  <div className="flex items-center gap-2 mb-1">
                    <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
                    <span className="text-xs font-medium text-blue-400">AI Working</span>
                  </div>
                  <p className="text-xs text-gray-300">
                    {runningAgents.length} task{runningAgents.length !== 1 ? "s" : ""} running
                  </p>
                </div>
              ) : null}
              {approvalCount > 0 && (
                <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
                    <span className="text-xs font-medium text-amber-400">Action Needed</span>
                  </div>
                  <p className="text-xs text-gray-300">
                    {approvalCount} item{itemText(approvalCount)} need your attention
                  </p>
                </div>
              )}
              {wallet && wallet.balance < 10 && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                    <span className="text-xs font-medium text-red-400">Low Credits</span>
                  </div>
                  <p className="text-xs text-gray-300">
                    {wallet.balance} credits remaining
                  </p>
                  <Link to="/pricing">
                    <Button size="sm" variant="outline" className="mt-2 w-full text-xs border-red-500/30 text-red-400 hover:bg-red-500/10">
                      Get Credits
                    </Button>
                  </Link>
                </div>
              )}
              {runningAgents?.length === 0 && approvalCount === 0 && (!wallet || wallet.balance >= 10) && (
                <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <div className="flex items-center gap-2 mb-1">
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-xs font-medium text-emerald-400">All Good</span>
                  </div>
                  <p className="text-xs text-gray-300">
                    No blockers. NatForgeAI is running smoothly.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Agent Activity */}
          <Card className="bg-[#1E293B] border-[#334155]">
            <CardHeader className="pb-3">
              <CardTitle className="text-white text-base flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-purple-400" />
                Recent Completed Work
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {agentRuns && agentRuns.length > 0 ? (
                agentRuns.slice(0, 5).map((run) => (
                  <div key={run.id} className="flex items-start gap-3">
                    <div className="w-2 h-2 rounded-full bg-purple-400 mt-1.5 shrink-0" />
                    <div>
                      <p className="text-sm text-gray-300 capitalize">
                        {run.agentType} Agent completed
                      </p>
                      <p className="text-xs text-gray-500">
                        {run.campaignId ? `Campaign #${run.campaignId}` : ""}
                        {run.createdAt ? ` · ${new Date(run.createdAt).toLocaleDateString()}` : ""}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-gray-500">No completed work yet</p>
              )}
              <Link to="/agent-activity">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[#00D4FF] hover:text-[#00D4FF] hover:bg-[#00D4FF]/10 w-full mt-2"
                >
                  View All Activity
                </Button>
              </Link>
            </CardContent>
          </Card>

          {/* Quick Actions */}
          <Card className="bg-[#1E293B] border-[#334155]">
            <CardHeader className="pb-3">
              <CardTitle className="text-white text-base flex items-center gap-2">
                <Zap className="w-4 h-4 text-amber-400" />
                Quick Actions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Link to="/campaigns">
                <Button
                  variant="outline"
                  className="w-full justify-start border-[#334155] text-gray-300 hover:text-white hover:bg-[#334155]"
                >
                  <Megaphone className="w-4 h-4 mr-2" />
                  View Campaigns
                </Button>
              </Link>
              <Link to="/content">
                <Button
                  variant="outline"
                  className="w-full justify-start border-[#334155] text-gray-300 hover:text-white hover:bg-[#334155]"
                >
                  <PenTool className="w-4 h-4 mr-2" />
                  Content Studio
                </Button>
              </Link>
              <Link to="/leads">
                <Button
                  variant="outline"
                  className="w-full justify-start border-[#334155] text-gray-300 hover:text-white hover:bg-[#334155]"
                >
                  <Users className="w-4 h-4 mr-2" />
                  Manage Leads
                </Button>
              </Link>
              <Link to="/analytics">
                <Button
                  variant="outline"
                  className="w-full justify-start border-[#334155] text-gray-300 hover:text-white hover:bg-[#334155]"
                >
                  <BarChart3 className="w-4 h-4 mr-2" />
                  Analytics
                </Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
