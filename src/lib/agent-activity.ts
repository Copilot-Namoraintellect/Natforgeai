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
  creativeRunHistory: AgentRunLike[];
  currentStatus: ActivityStatus;
  completedSteps: string[];
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
      const creativeRunHistory = creativeRuns.slice(1);

      const completedSteps: string[] = [];
      if (strategyRun?.status === "completed") completedSteps.push("Strategy Agent completed");
      if (creativeRun?.status === "completed") completedSteps.push("Creative Agent completed");

      let currentStatus: ActivityStatus = "waiting";
      let nextAction = "Awaiting next workflow action";
      let errorMessage: string | null = null;

      if (creativeRun?.status === "failed") {
        currentStatus = "failed";
        nextAction = "Retry creative generation";
        errorMessage = creativeRun.error || "Creative generation failed.";
      } else if (creativeRun?.status === "running") {
        currentStatus = "running";
        nextAction = "Wait for creative generation to finish";
      } else if (creativeRun?.status === "completed") {
        currentStatus = "completed";
        nextAction = "Open Content Studio";
      } else if (strategyRun?.status === "completed") {
        currentStatus = "waiting";
        nextAction = "Approve strategy to start creative generation";
      } else if (strategyRun?.status === "running") {
        currentStatus = "running";
        nextAction = "Wait for strategy generation to finish";
      }

      return {
        campaignId,
        strategyRun,
        creativeRun,
        creativeRunHistory,
        currentStatus,
        completedSteps,
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
