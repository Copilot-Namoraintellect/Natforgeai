export interface CreativeProgressInput {
  currentState: string;
  strategyApproved: boolean;
  creativeRunStatus: "pending" | "running" | "completed" | "failed";
  savedPosts: number;
}

export function resolveCreativeWorkflowState(input: CreativeProgressInput): string {
  if (!input.strategyApproved && input.currentState === "strategy_generated") {
    return "strategy_generated";
  }

  if (input.strategyApproved && input.currentState === "strategy_approved") {
    if (input.creativeRunStatus === "running" || input.creativeRunStatus === "pending") {
      return "creatives_generating";
    }
    if (input.creativeRunStatus === "completed" && input.savedPosts > 0) {
      return "creatives_ready";
    }
    return "creatives_generating";
  }

  if (input.currentState === "creatives_generating") {
    if (input.creativeRunStatus === "completed" && input.savedPosts > 0) {
      return "creatives_ready";
    }
    return "creatives_generating";
  }

  return input.currentState;
}
