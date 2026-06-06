import { useMemo } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
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
} from "lucide-react";

const workflowStateLabels: Record<string, { label: string; color: string; step: number }> = {
  business_onboarding: { label: "Onboarding", color: "bg-amber-500/10 text-amber-600", step: 1 },
  strategy_pending: { label: "Strategy Pending", color: "bg-blue-500/10 text-blue-600", step: 2 },
  strategy_generated: { label: "Strategy Ready", color: "bg-purple-500/10 text-purple-600", step: 3 },
  strategy_approved: { label: "Strategy Approved", color: "bg-emerald-500/10 text-emerald-600", step: 4 },
  creatives_generating: { label: "Generating Creatives", color: "bg-blue-500/10 text-blue-600", step: 5 },
  creatives_ready: { label: "Creatives Ready", color: "bg-purple-500/10 text-purple-600", step: 6 },
  audience_generating: { label: "Finding Audience", color: "bg-blue-500/10 text-blue-600", step: 7 },
  audience_ready: { label: "Audience Ready", color: "bg-purple-500/10 text-purple-600", step: 8 },
  schedule_generated: { label: "Schedule Ready", color: "bg-cyan-500/10 text-cyan-600", step: 9 },
  launch_approval_required: { label: "Awaiting Launch Approval", color: "bg-amber-500/10 text-amber-600", step: 10 },
  campaign_live: { label: "Campaign Live", color: "bg-emerald-500/10 text-emerald-600", step: 11 },
  engagement_active: { label: "Engagement Active", color: "bg-pink-500/10 text-pink-600", step: 12 },
  leads_converting: { label: "Leads Converting", color: "bg-orange-500/10 text-orange-600", step: 13 },
  optimisation_active: { label: "Optimising", color: "bg-indigo-500/10 text-indigo-600", step: 14 },
  completed: { label: "Completed", color: "bg-gray-500/10 text-gray-600", step: 15 },
};

const workflowNextAction: Record<string, { text: string; actionLabel?: string; actionHref?: string }> = {
  business_onboarding: { text: "Finish onboarding to begin." },
  strategy_pending: { text: "NatForgeAI is preparing your strategy." },
  strategy_generated: { text: "Review your strategy before continuing.", actionLabel: "Review Strategy", actionHref: "/approvals" },
  strategy_approved: { text: "Creative assets are being generated." },
  creatives_generating: { text: "NatForgeAI is generating creative content." },
  creatives_ready: { text: "Creative content is ready for review." },
  audience_generating: { text: "Audience segments are being identified." },
  audience_ready: { text: "Audience profiles are ready." },
  schedule_generated: { text: "Publishing schedule is ready for approval.", actionLabel: "Review Schedule", actionHref: "/approvals" },
  launch_approval_required: { text: "Approve launch to go live.", actionLabel: "Approve Launch", actionHref: "/approvals" },
  campaign_live: { text: "Campaign is live and running." },
  engagement_active: { text: "Engaging with your audience." },
  leads_converting: { text: "Nurturing leads through the funnel." },
  optimisation_active: { text: "Optimising campaign performance." },
  completed: { text: "Campaign cycle completed." },
};

export default function MissionControl() {
  const { data: campaigns, isLoading: campaignsLoading } = trpc.campaign.list.useQuery();
  const { data: agentRuns } = trpc.agent.getAgentRuns.useQuery({ status: "completed" });
  const { data: pendingApprovals } = trpc.approval.listApprovals.useQuery({ status: "pending" });
  const { data: leads } = trpc.lead.list.useQuery();

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

  const pendingReviews = useMemo(
    () => aiCampaigns.filter((c) => c.workflowState === "strategy_generated" || c.workflowState === "launch_approval_required"),
    [aiCampaigns]
  );

  const approvalCount = pendingApprovals?.length ?? 0;
  const completedAgentRuns = agentRuns?.length ?? 0;

  const dailySummary = useMemo(() => {
    const postsGenerated = agentRuns?.filter((r) => r.agentType === "creative").length ?? 0;
    const prospectsIdentified = agentRuns?.filter((r) => r.agentType === "audience").length ?? 0;
    const hotLeads = leads?.filter((l) => l.score && l.score > 80).length ?? 0;

    let message = "NatForge is ready to launch your first campaign.";
    if (completedAgentRuns > 0) {
      message = `NatForge has generated ${postsGenerated * 5} posts, identified ${prospectsIdentified * 10} prospects`;
      if (hotLeads > 0) message += ` and found ${hotLeads} hot lead${hotLeads !== 1 ? "s" : ""}`;
      message += ".";
    }
    if (approvalCount > 0) {
      message += ` ${approvalCount} approval${approvalCount !== 1 ? "s" : ""} needed.`;
    }
    return message;
  }, [agentRuns, leads, approvalCount, completedAgentRuns]);

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
      value: pendingReviews.length + approvalCount,
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
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Rocket className="w-6 h-6 text-[#00D4FF]" />
            Mission Control
          </h1>
          <p className="text-gray-400 mt-1">{dailySummary}</p>
        </div>
        <div className="flex items-center gap-3">
          {approvalCount > 0 && (
            <Link to="/approvals">
              <Button variant="outline" className="border-amber-500/30 text-amber-500 hover:bg-amber-500/10">
                <AlertCircle className="w-4 h-4 mr-2" />
                {approvalCount} Approval{approvalCount !== 1 ? "s" : ""} Needed
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
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
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
              const nextAction = workflowNextAction[campaign.workflowState];

              return (
                <Card key={campaign.id} className="bg-[#1E293B] border-[#334155]">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="font-semibold text-white">{campaign.name}</h3>
                        <p className="text-sm text-gray-400">{campaign.goal}</p>
                      </div>
                      <Badge className={stateInfo.color}>{stateInfo.label}</Badge>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-xs text-gray-400">
                        <span>Workflow Progress</span>
                        <span>{Math.round(progressPercent)}%</span>
                      </div>
                      <Progress value={progressPercent} className="h-1.5" />
                    </div>

                    {nextAction && (
                      <p className="text-xs text-gray-400 mt-3">
                        {nextAction.text}
                      </p>
                    )}

                    <div className="flex items-center gap-3 mt-3">
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
                      {campaign.workflowState === "strategy_pending" && (
                        <Button size="sm" variant="outline" disabled className="border-[#334155] text-gray-400">
                          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                          Preparing Strategy
                        </Button>
                      )}
                      {nextAction?.actionLabel && nextAction?.actionHref && (
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
          {/* Agent Activity */}
          <Card className="bg-[#1E293B] border-[#334155]">
            <CardHeader className="pb-3">
              <CardTitle className="text-white text-base flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-purple-400" />
                Recent Agent Activity
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {agentRuns && agentRuns.length > 0 ? (
                agentRuns.slice(0, 5).map((run) => (
                  <div key={run.id} className="flex items-start gap-3">
                    <div className="w-2 h-2 rounded-full bg-purple-400 mt-1.5 shrink-0" />
                    <div>
                      <p className="text-sm text-gray-300 capitalize">
                        {run.agentType} Agent {run.status}
                      </p>
                      <p className="text-xs text-gray-500">
                        {run.createdAt ? new Date(run.createdAt).toLocaleDateString() : "Recently"}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-gray-500">No agent activity yet</p>
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
