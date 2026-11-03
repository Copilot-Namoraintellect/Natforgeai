import { describe, it, expect, vi } from "vitest";
import { getCreateReadinessToast } from "./Campaigns";

// These pure helper tests never use auth. Isolate the transitive useAuth import
// from Firebase client initialization without supplying credentials or a user.
vi.mock("@/lib/firebase", () => ({ auth: null }));

describe("getCreateReadinessToast", () => {
  it("returns null when no readiness block is present", () => {
    expect(getCreateReadinessToast({ id: 42, workflowState: "strategy_pending" })).toBeNull();
  });

  it("returns null when readiness is true", () => {
    expect(
      getCreateReadinessToast({
        id: 42,
        workflowState: "strategy_pending",
        readiness: { ready: true },
      })
    ).toBeNull();
  });

  it("returns an actionable readiness toast when strategy generation is blocked", () => {
    const result = getCreateReadinessToast({
      id: 42,
      workflowState: "strategy_pending",
      readiness: {
        ready: false,
        userMessage:
          "No campaign channel has been selected. Add at least one channel to the campaign brief before regenerating the strategy.",
      },
    });

    expect(result).not.toBeNull();
    expect(result!.message).toContain("campaign channel");
    expect(result!.actionLabel).toBe("Edit brief");
    expect(result!.actionPath).toBe("/campaigns?campaignId=42&editBrief=true");
  });
});
