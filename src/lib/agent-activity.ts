export type ActivityStatus = "pending" | "running" | "waiting" | "completed" | "failed";

export interface AgentRunLike {
  id: number;
  campaignId: number | null;
  agentType: string;
  status: ActivityStatus;
  createdAt?: string | Date | null;
  error?: string | null;
}

export interface CampaignActivityTimeline {
  campaignId: number;
  strategyRun: AgentRunLike | null;
  creativeRun: AgentRunLike | null;
  audienceRun: AgentRunLike | null;
  distributionRun: AgentRunLike | null;
  creativeRunHistory: AgentRunLike[];
  currentCampaignStage: string;
  currentStatus: ActivityStatus;
  completedSteps: string[];
  pendingWork: string;
  nextAction: string;
  errorMessage: string | null;
}

export function getLatestRun(runs: AgentRunLike[], agentType: string): AgentRunLike | null {
  const matching = runs.filter((run) => run.agentType === agentType);
  if (matching.length === 0) return null;
  return [...matching].sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
}

export function groupCampaignActivity(runs: AgentRunLike[]): CampaignActivityTimeline[] {
  const grouped = new Map<number, AgentRunLike[]>();
  for (const run of runs) {
    if (!run.campaignId) continue;
    const list = grouped.get(run.campaignId) || [];
    list.push(run);
    grouped.set(run.campaignId, list);
  }

  return [...grouped.entries()]
    .map(([campaignId, campaignRuns]) => {
      const strategyRun = getLatestRun(campaignRuns, "strategy");
      const creativeRuns = campaignRuns
        .filter((run) => run.agentType === "creative")
        .sort((a, b) => Number(b.id) - Number(a.id));
      const creativeRun = creativeRuns[0] ?? null;
      const audienceRun = getLatestRun(campaignRuns, "audience");
      const distributionRun = getLatestRun(campaignRuns, "distribution");
      const creativeRunHistory = creativeRuns.slice(1);

      const completedSteps: string[] = [];
      if (strategyRun?.status === "completed") completedSteps.push("Strategy Agent completed");
      if (creativeRun?.status === "completed") completedSteps.push("Creative Agent completed");
      if (audienceRun?.status === "completed") completedSteps.push("Audience Agent completed");
      if (distributionRun?.status === "completed") completedSteps.push("Distribution Agent completed");

      let currentStatus: ActivityStatus = "waiting";
      let currentCampaignStage = "Strategy setup";
      let pendingWork = "Waiting for campaign workflow signals.";
      let nextAction = "Awaiting next workflow action";
      let errorMessage: string | null = null;

      if (distributionRun?.status === "completed") {
        currentCampaignStage = "Distribution ready";
        currentStatus = "completed";
        pendingWork = "Publishing and engagement follow-up.";
        nextAction = "Open Content Studio";
      } else if (distributionRun?.status === "running") {
        currentCampaignStage = "Distribution scheduling";
        currentStatus = "running";
        pendingWork = "Finalizing channel schedule and publishing instructions.";
        nextAction = "Wait for distribution generation to finish";
      } else if (audienceRun?.status === "completed") {
        currentCampaignStage = "Audience complete";
        currentStatus = "waiting";
        pendingWork = "Distribution scheduling is next.";
        nextAction = "Approve and continue to distribution";
      } else if (audienceRun?.status === "running") {
        currentCampaignStage = "Audience intelligence";
        currentStatus = "running";
        pendingWork = "AI is identifying and scoring audience segments.";
        nextAction = "Wait for audience generation to finish";
      } else if (creativeRun?.status === "failed") {
        currentCampaignStage = "Creative generation";
        currentStatus = "failed";
        pendingWork = "Creative output failed validation and needs a retry.";
        nextAction = "Retry creative generation";
        errorMessage = creativeRun.error || "Creative generation failed.";
      } else if (creativeRun?.status === "running") {
        currentCampaignStage = "Creative generation";
        currentStatus = "running";
        pendingWork = "AI is generating posts and campaign assets.";
        nextAction = "Wait for creative generation to finish";
      } else if (creativeRun?.status === "completed") {
        currentCampaignStage = "Creative review";
        currentStatus = "completed";
        pendingWork = "Creative content is ready for approval and channel preparation.";
        nextAction = "Open Content Studio";
      } else if (strategyRun?.status === "completed") {
        currentCampaignStage = "Strategy approved";
        currentStatus = "waiting";
        pendingWork = "Creative generation has not started yet.";
        nextAction = "Approve strategy to start creative generation";
      } else if (strategyRun?.status === "running") {
        currentCampaignStage = "Strategy generation";
        currentStatus = "running";
        pendingWork = "AI is building campaign strategy.";
        nextAction = "Wait for strategy generation to finish";
      }

      return {
        campaignId,
        strategyRun,
        creativeRun,
        audienceRun,
        distributionRun,
        creativeRunHistory,
        currentCampaignStage,
        currentStatus,
        completedSteps,
        pendingWork,
        nextAction,
        errorMessage,
      };
    })
    .sort((a, b) => b.campaignId - a.campaignId);
}

export function buildFailedCreativeMessage(error: string | null | undefined): {
  message: string;
  creditsImpact: string;
} {
  const text = (error || "").toLowerCase();

  if (text.includes("insufficient credits") || text.includes("payment_required")) {
    return {
      message: "Creative generation could not start because available credits were insufficient.",
      creditsImpact: "No credits were deducted.",
    };
  }

  if (text.includes("timeout") || text.includes("network") || text.includes("openai") || text.includes("provider")) {
    return {
      message: "Creative generation failed due to a temporary platform issue. Please retry.",
      creditsImpact: "Credits may have been deducted; provider failures are automatically refunded.",
    };
  }

  return {
    message: "Creative generation failed before content became available. Please retry from this campaign.",
    creditsImpact: "This attempt deducted credits when generation started.",
  };
}
