import { useMemo, useState } from "react";
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
  RotateCcw,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  ArrowRight,
} from "lucide-react";
import { Link } from "react-router";
import { buildFailedCreativeMessage, groupCampaignActivity } from "@/lib/agent-activity";

const agentTypeConfig: Record<string, { label: string }> = {
  strategy: { label: "Strategy Agent" },
  creative: { label: "Creative Agent" },
  audience: { label: "Audience Agent" },
  distribution: { label: "Distribution Agent" },
  engagement: { label: "Engagement Agent" },
  sales: { label: "Sales Agent" },
  optimisation: { label: "Optimisation Agent" },
};

const statusConfig: Record<string, { color: string; icon: any }> = {
  pending: { color: "bg-amber-500/10 text-amber-600", icon: Clock },
  running: { color: "bg-blue-500/10 text-blue-600", icon: Loader2 },
  waiting: { color: "bg-amber-500/10 text-amber-600", icon: Clock },
  completed: { color: "bg-emerald-500/10 text-emerald-600", icon: CheckCircle },
  failed: { color: "bg-red-500/10 text-red-600", icon: XCircle },
};

export default function AgentActivity() {
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [expandedHistory, setExpandedHistory] = useState<Record<number, boolean>>({});
  const [advancedOpen, setAdvancedOpen] = useState<Record<number, boolean>>({});
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

  const campaignTimelines = useMemo(() => groupCampaignActivity(agentRuns || []), [agentRuns]);

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
        ) : campaignTimelines.length > 0 ? (
          campaignTimelines.map((timeline) => {
            const campaign = campaignMap.get(timeline.campaignId);
            const latestCreative = timeline.creativeRun;
            const statusItem = statusConfig[timeline.currentStatus] || statusConfig.waiting;
            const StatusIcon = statusItem.icon;
            const errorDetails = buildFailedCreativeMessage(timeline.errorMessage);

            const nextActionHref =
              timeline.currentStatus === "completed"
                ? `/content?campaignId=${timeline.campaignId}`
                : timeline.currentStatus === "failed"
                  ? `/agent-activity?campaignId=${timeline.campaignId}`
                  : "/approvals";

            return (
              <Card
                key={`campaign-${timeline.campaignId}`}
                className="bg-[#1E293B] border-[#334155] hover:border-[#00D4FF]/20 transition-colors"
              >
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-white font-semibold">Campaign #{timeline.campaignId}</p>
                      <p className="text-xs text-gray-400 mt-1">
                        {campaign ? `Workflow: ${campaign.workflowState}` : "Workflow status loading"}
                      </p>
                    </div>
                    <Badge className={statusItem.color}>
                      <StatusIcon className="w-3 h-3 mr-1" />
                      {timeline.currentStatus}
                    </Badge>
                  </div>

                  <div className="rounded-lg border border-[#334155] bg-[#0F172A] p-3 space-y-2">
                    <p className="text-xs uppercase tracking-wide text-[#00D4FF] font-semibold">Campaign Timeline</p>
                    <p className="text-sm text-gray-200">What is happening now: {timeline.currentStatus === "running" ? "Agents are processing this campaign." : timeline.currentStatus === "completed" ? "Content is ready for review." : timeline.currentStatus === "failed" ? "Creative generation failed and needs attention." : "Waiting for workflow progression."}</p>
                    <p className="text-sm text-gray-300">What has been completed: {timeline.completedSteps.length > 0 ? timeline.completedSteps.join(" -> ") : "No completed agent steps yet."}</p>
                    <p className="text-sm text-gray-300">What you need to do next: {timeline.nextAction}</p>
                    <p className="text-sm text-gray-300">What happens after the next action: {timeline.currentStatus === "completed" ? "Content Studio opens with generated drafts and assets." : "Workflow advances to the next campaign stage."}</p>
                  </div>

                  {timeline.currentStatus === "failed" && (
                    <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3">
                      <p className="text-sm text-red-300">{errorDetails.message}</p>
                      <p className="text-xs text-red-200/80 mt-1">{errorDetails.creditsImpact}</p>
                    </div>
                  )}

                  <div className="flex items-center gap-2 flex-wrap">
                    <Link to={nextActionHref}>
                      <Button size="sm" className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white h-7 text-xs">
                        Next Action
                        <ArrowRight className="w-3 h-3 ml-1" />
                      </Button>
                    </Link>

                    {latestCreative && timeline.currentStatus === "failed" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-[#334155] text-gray-300 hover:text-white h-7 text-xs"
                        onClick={() => handleRetry(latestCreative)}
                        disabled={runStrategyAgent.isPending || runCreativeAgent.isPending || runAudienceAgent.isPending || runDistributionAgent.isPending}
                      >
                        <RotateCcw className="w-3.5 h-3.5 mr-1" />
                        Retry Creative
                      </Button>
                    )}

                    {timeline.creativeRunHistory.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-[#334155] text-gray-300 hover:text-white h-7 text-xs"
                        onClick={() =>
                          setExpandedHistory((prev) => ({
                            ...prev,
                            [timeline.campaignId]: !prev[timeline.campaignId],
                          }))
                        }
                      >
                        {expandedHistory[timeline.campaignId] ? "Hide Run History" : `Run History (${timeline.creativeRunHistory.length})`}
                      </Button>
                    )}

                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-gray-400 hover:text-white h-7 text-xs"
                      onClick={() =>
                        setAdvancedOpen((prev) => ({
                          ...prev,
                          [timeline.campaignId]: !prev[timeline.campaignId],
                        }))
                      }
                    >
                      {advancedOpen[timeline.campaignId] ? "Hide Advanced details" : "Advanced details"}
                    </Button>
                  </div>

                  {expandedHistory[timeline.campaignId] && (
                    <div className="rounded-lg border border-[#334155] bg-[#0F172A] p-3 space-y-2">
                      {timeline.creativeRunHistory.map((run) => (
                        <div key={run.id} className="flex items-center justify-between text-xs text-gray-300">
                          <span>Run #{run.id}</span>
                          <Badge className={statusConfig[run.status]?.color || "bg-gray-500/10 text-gray-300"}>{run.status}</Badge>
                        </div>
                      ))}
                    </div>
                  )}

                  {advancedOpen[timeline.campaignId] && (
                    <div className="rounded-lg border border-[#334155] bg-[#0F172A] p-3">
                      <p className="text-xs text-gray-500 mb-2">Technical logs</p>
                      <pre className="text-[11px] text-gray-400 whitespace-pre-wrap break-words">
{JSON.stringify(
  {
    strategyRunId: timeline.strategyRun?.id || null,
    creativeRunId: timeline.creativeRun?.id || null,
    creativeStatus: timeline.creativeRun?.status || null,
    creativeError: timeline.creativeRun?.error || null,
  },
  null,
  2
)}
                      </pre>
                    </div>
                  )}
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
