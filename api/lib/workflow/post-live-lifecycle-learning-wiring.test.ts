import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../learning/post-live-learning-trigger", () => ({
  runGovernedPostLiveLearningTrigger: vi.fn(async () => ({ outcome: "recorded" })),
}));

vi.mock("./post-live-lifecycle-db", () => ({
  reconcilePostLiveCampaignFromDb: vi.fn(async () => ({
    status: "no_transition",
    campaignId: 7,
    previousState: "engagement_active",
    transitioned: false,
    decision: { action: null, reason: "awaiting_lead_or_learning_evidence" },
    evidenceAuthority: "current_lifecycle_anchor_present",
  })),
}));

import { getDb } from "../../queries/connection";
import { runGovernedPostLiveLearningTrigger } from "../learning/post-live-learning-trigger";
import { reconcilePostLiveCampaignFromDb } from "./post-live-lifecycle-db";
import { runPostLiveLifecycleReconciliationPass } from "./post-live-lifecycle-pass";

describe("post-live pass default deps run the governed Learning trigger before reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes the Learning trigger, then the reconciliation, for each candidate", async () => {
    const order: string[] = [];
    vi.mocked(runGovernedPostLiveLearningTrigger).mockImplementation(async () => {
      order.push("learning-trigger");
      return { outcome: "insufficient_data", campaignId: 7, reason: "none" };
    });
    vi.mocked(reconcilePostLiveCampaignFromDb).mockImplementation(async () => {
      order.push("reconcile");
      return {
        status: "no_transition",
        campaignId: 7,
        previousState: "engagement_active",
        transitioned: false,
        decision: { action: null, reason: "awaiting_lead_or_learning_evidence" },
        evidenceAuthority: "current_lifecycle_anchor_present",
      } as any;
    });
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(async () => [{ id: 7 }]),
          })),
        })),
      })),
    } as any);

    const result = await runPostLiveLifecycleReconciliationPass({ asOfDate: "2026-06-15" });

    expect(runGovernedPostLiveLearningTrigger).toHaveBeenCalledWith({ campaignId: 7 });
    expect(reconcilePostLiveCampaignFromDb).toHaveBeenCalledWith({
      campaignId: 7,
      asOfDate: "2026-06-15",
    });
    expect(order).toEqual(["learning-trigger", "reconcile"]);
    expect(result.attempted).toBe(1);
  });

  it("contains a crashing trigger through the batch isolator without running reconciliation for that campaign", async () => {
    vi.mocked(runGovernedPostLiveLearningTrigger).mockRejectedValue(
      new Error("unexpected trigger crash")
    );
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(async () => [{ id: 7 }]),
          })),
        })),
      })),
    } as any);

    const result = await runPostLiveLifecycleReconciliationPass({ asOfDate: "2026-06-15" });

    // The pass completes; the single campaign failure is isolated and its
    // reconciliation never ran.
    expect(result.failed).toBe(1);
    expect(result.results[0]).toMatchObject({ campaignId: 7, status: "failed" });
    expect(reconcilePostLiveCampaignFromDb).not.toHaveBeenCalled();
  });
});
