import { isCreativeBriefComplete } from "./creative-brief";

export type ActivityStatus = "pending" | "running" | "waiting" | "completed" | "failed";

export interface AgentRunLike {
  id: number;
  campaignId: number | null;
  agentType: string;
  status: ActivityStatus;
  createdAt?: string | Date | null;
  error?: string | null;
  input?: unknown;
  output?: unknown;
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

export function isAuthoritativeCreativeRun(run: AgentRunLike): boolean {
  const input = (run as any).input as Record<string, unknown> | undefined;
  return run.agentType === "creative" && input?.jobType === "content_generation_job";
}

/**
 * Return the authoritative creative run that should be retried for a failed
 * campaign timeline, using the timeline's campaignId as the authoritative
 * campaign identifier. Returns null when the timeline is not failed, when there
 * is no creative run, or when the run is not an authoritative controlling
 * creative operation (e.g., a nested model-execution inner run).
 */
export function getCreativeRetryTarget(
  timeline: CampaignActivityTimeline
): { campaignId: number; run: AgentRunLike } | null {
  if (timeline.currentStatus !== "failed") return null;
  const run = timeline.creativeRun;
  if (!run) return null;
  if (!isAuthoritativeCreativeRun(run)) return null;
  return { campaignId: timeline.campaignId, run };
}

export interface CreativeRetryMutation {
  mutate: (input: { campaignId: number }) => void;
  isPending: boolean;
}

export type CreativeRetryResult =
  | { kind: "started"; campaignId: number }
  | { kind: "blocked"; reason: "pending" | "not_authoritative" | "missing_campaign_id" | "unsupported_agent_type" };

/**
 * Execute a creative retry against the authoritative controlling run. This is a
 * pure decision helper: the caller provides the mutation and decides how to
 * surface the result to the user.
 */
export function executeCreativeRetry(
  target: { campaignId: number; run: AgentRunLike },
  mutation: CreativeRetryMutation
): CreativeRetryResult {
  if (mutation.isPending) return { kind: "blocked", reason: "pending" };
  if (!target.campaignId) return { kind: "blocked", reason: "missing_campaign_id" };
  if (target.run.agentType !== "creative") return { kind: "blocked", reason: "unsupported_agent_type" };
  if (!isAuthoritativeCreativeRun(target.run)) return { kind: "blocked", reason: "not_authoritative" };
  mutation.mutate({ campaignId: target.campaignId });
  return { kind: "started", campaignId: target.campaignId };
}

function isControllingCreativeRun(run: AgentRunLike): boolean {
  return isAuthoritativeCreativeRun(run);
}

function getSavedPostCountFromRun(run: AgentRunLike): number | null {
  const output = (run as any).output as Record<string, unknown> | undefined;
  if (!output) return null;
  if (typeof output.savedPosts === "number") return output.savedPosts;
  if (typeof output.postCount === "number") return output.postCount;
  return null;
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
      const allCreativeRuns = campaignRuns
        .filter((run) => run.agentType === "creative")
        .sort((a, b) => Number(b.id) - Number(a.id));
      const controllingCreativeRuns = allCreativeRuns.filter(isControllingCreativeRun);
      const creativeRun = controllingCreativeRuns[0] ?? allCreativeRuns[0] ?? null;
      const audienceRun = getLatestRun(campaignRuns, "audience");
      const distributionRun = getLatestRun(campaignRuns, "distribution");
      const creativeRunHistory = allCreativeRuns.filter((run) => run.id !== creativeRun?.id);

      const completedSteps: string[] = [];
      if (strategyRun?.status === "completed") completedSteps.push("Strategy Agent completed");
      if (
        creativeRun?.status === "completed" &&
        getSavedPostCountFromRun(creativeRun) !== 0
      ) {
        completedSteps.push("Creative Agent completed");
      }
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
        const savedPosts = getSavedPostCountFromRun(creativeRun);
        if (savedPosts === 0) {
          currentCampaignStage = "Creative generation";
          currentStatus = "failed";
          pendingWork = "Creative generation completed but no posts were persisted. Please retry.";
          nextAction = "Retry creative generation";
          errorMessage = "Creative generation completed but no posts were persisted.";
        } else {
          currentCampaignStage = "Creative review";
          currentStatus = "completed";
          pendingWork = "Creative content is ready for approval and channel preparation.";
          nextAction = "Open Content Studio";
        }
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
  creditsImpact?: string;
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

  // Default/unknown failures (including quality validation failures) do not
  // make a billing claim because credits are only deducted after a successful
  // save. The UI must not state that credits were deducted without evidence.
  return {
    message: "Creative generation failed before content became available. Please retry from this campaign.",
  };
}

export interface RetryPendingState {
  strategy: boolean;
  creative: boolean;
  audience: boolean;
  distribution: boolean;
}

/**
 * Determine whether the Retry Creative action is enabled for a failed campaign.
 * Keeps the disabled-reason decision in one place so AgentActivity and its tests
 * share the same logic.
 */
export function getCreativeRetryState(
  campaign: unknown,
  pending: RetryPendingState
): { enabled: boolean; reason: "incomplete" | "pending" | null } {
  if (pending.strategy || pending.creative || pending.audience || pending.distribution) {
    return { enabled: false, reason: "pending" };
  }
  if (!isCreativeBriefComplete(campaign)) {
    return { enabled: false, reason: "incomplete" };
  }
  return { enabled: true, reason: null };
}
