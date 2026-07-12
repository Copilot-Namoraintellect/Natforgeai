import { getWorkflowNextActionMessage } from "@/lib/workflow";

interface CampaignLike {
  id: number;
  name: string;
  workflowState: string;
  workflowContext?: unknown;
}

interface ApprovalLike {
  id: number;
  campaignId: number | null;
}

interface RunLike {
  id: number;
  campaignId: number | null;
  agentType: string;
  status: string;
}

interface LeadLike {
  id: number;
  campaignId: number | null;
  score?: number | null;
}

interface QueueLike {
  id: number;
  campaignId: number | null;
  status: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export interface MissionCommandSummary {
  activeCampaignId: number | null;
  activeCampaignName: string;
  currentState: string;
  completedByAi: string[];
  currentlyDoing: string;
  approvalsNeeded: number;
  nextRecommendedAction: string;
  contentReadiness: string;
  publishingReadiness: string;
  leadsAudienceStatus: string;
}

function getCurrentWorkMessage(state: string): string {
  if (["strategy_pending", "strategy_generated"].includes(state)) {
    return "AI is preparing and refining campaign strategy.";
  }
  if (["creatives_generating", "creatives_ready"].includes(state)) {
    return "AI is building creative content and message packs.";
  }
  if (["audience_generating", "audience_ready"].includes(state)) {
    return "AI is building and validating audience segments.";
  }
  if (state === "schedule_generated") {
    return "AI has generated the publishing schedule and is waiting for launch decisions.";
  }
  if (["campaign_live", "engagement_active", "leads_converting", "optimisation_active"].includes(state)) {
    return "AI is operating and optimising live campaign execution.";
  }
  return "AI is waiting for the next supervised workflow step.";
}

function getCompletedByAi(state: string): string[] {
  const completionMap: Array<{ states: string[]; label: string }> = [
    { states: ["strategy_generated", "strategy_approved", "creatives_generating", "creatives_ready", "audience_generating", "audience_ready", "schedule_generated", "launch_approval_required", "campaign_live", "engagement_active", "leads_converting", "optimisation_active", "completed"], label: "Strategy generated" },
    { states: ["creatives_ready", "audience_generating", "audience_ready", "schedule_generated", "launch_approval_required", "campaign_live", "engagement_active", "leads_converting", "optimisation_active", "completed"], label: "Creative assets generated" },
    { states: ["audience_ready", "schedule_generated", "launch_approval_required", "campaign_live", "engagement_active", "leads_converting", "optimisation_active", "completed"], label: "Audience targeting generated" },
    { states: ["schedule_generated", "launch_approval_required", "campaign_live", "engagement_active", "leads_converting", "optimisation_active", "completed"], label: "Publishing schedule generated" },
    { states: ["campaign_live", "engagement_active", "leads_converting", "optimisation_active", "completed"], label: "Campaign launched" },
  ];

  return completionMap.filter((item) => item.states.includes(state)).map((item) => item.label);
}

export function buildMissionCommandSummary(input: {
  campaigns: CampaignLike[];
  approvals: ApprovalLike[];
  runningRuns: RunLike[];
  completedRuns: RunLike[];
  leads: LeadLike[];
  queue: QueueLike[];
}): MissionCommandSummary {
  const campaigns = input.campaigns || [];
  const activeCampaign =
    campaigns.find((campaign) => !["completed"].includes(campaign.workflowState)) ||
    campaigns[0] ||
    null;

  if (!activeCampaign) {
    return {
      activeCampaignId: null,
      activeCampaignName: "No active mission",
      currentState: "No workflow yet",
      completedByAi: [],
      currentlyDoing: "AI is waiting for your first campaign setup.",
      approvalsNeeded: input.approvals.length,
      nextRecommendedAction: "Complete onboarding and launch your first mission.",
      contentReadiness: "No generated content yet.",
      publishingReadiness: "No publishing queue yet.",
      leadsAudienceStatus: "No leads or audience activity yet.",
    };
  }

  const campaignApprovals = input.approvals.filter((approval) => approval.campaignId === activeCampaign.id).length;
  const campaignQueue = input.queue.filter((item) => item.campaignId === activeCampaign.id);
  const campaignLeads = input.leads.filter((lead) => lead.campaignId === activeCampaign.id);
  const audienceCompleted = input.completedRuns.some(
    (run) => run.campaignId === activeCampaign.id && run.agentType === "audience"
  );

  const workflowContext = asRecord(activeCampaign.workflowContext);
  const savedPostsValue = workflowContext?.savedPosts;
  const savedPosts = typeof savedPostsValue === "number" ? savedPostsValue : 0;

  const publishedCount = campaignQueue.filter((item) => item.status === "published").length;
  const approvedCount = campaignQueue.filter((item) => item.status === "approved").length;

  const hotLeads = campaignLeads.filter((lead) => (lead.score || 0) >= 80).length;

  return {
    activeCampaignId: activeCampaign.id,
    activeCampaignName: activeCampaign.name,
    currentState: activeCampaign.workflowState,
    completedByAi: getCompletedByAi(activeCampaign.workflowState),
    currentlyDoing: getCurrentWorkMessage(activeCampaign.workflowState),
    approvalsNeeded: campaignApprovals,
    nextRecommendedAction: getWorkflowNextActionMessage(activeCampaign.workflowState),
    contentReadiness:
      savedPosts > 0
        ? `${savedPosts} generated content item${savedPosts === 1 ? "" : "s"} ready.`
        : "Content is not ready yet.",
    publishingReadiness:
      campaignQueue.length === 0
        ? "Publishing queue not created yet."
        : `${publishedCount} published, ${approvedCount} approved and queued.`,
    leadsAudienceStatus: audienceCompleted
      ? `${campaignLeads.length} lead${campaignLeads.length === 1 ? "" : "s"} detected (${hotLeads} hot).`
      : "Audience intelligence has not completed yet.",
  };
}
