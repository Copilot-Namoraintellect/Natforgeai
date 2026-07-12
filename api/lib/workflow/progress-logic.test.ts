import { describe, it, expect } from "vitest";
import { resolveCreativeWorkflowState } from "./progress-logic";

describe("workflow transition strategy_approved to creatives_ready", () => {
  it("moves to creatives_generating when creative is running", () => {
    expect(
      resolveCreativeWorkflowState({
        currentState: "strategy_approved",
        strategyApproved: true,
        creativeRunStatus: "running",
        savedPosts: 0,
      })
    ).toBe("creatives_generating");
  });

  it("moves to creatives_ready when creative completes with saved posts", () => {
    expect(
      resolveCreativeWorkflowState({
        currentState: "strategy_approved",
        strategyApproved: true,
        creativeRunStatus: "completed",
        savedPosts: 3,
      })
    ).toBe("creatives_ready");
  });
});
