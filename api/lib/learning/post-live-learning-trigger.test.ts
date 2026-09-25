import { describe, it, expect, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  POST_LIVE_LEARNING_ELIGIBLE_STATES,
  runGovernedPostLiveLearningTrigger,
  type PostLiveLearningTriggerDeps,
} from "./post-live-learning-trigger";
import type { GovernedLearningCycleResult } from "./learning-cycle-service";
import { reconcilePostLiveCampaign } from "../workflow/post-live-lifecycle-driver";

describe("runGovernedPostLiveLearningTrigger", () => {
  it("runs the governed cycle for engagement_active campaigns", async () => {
    const runCycle = vi.fn(async (): Promise<GovernedLearningCycleResult> => ({
      status: "recorded",
      idempotentReplay: false,
      record: { id: 501 } as any,
    }));
    const deps: PostLiveLearningTriggerDeps = {
      loadCampaignState: async () => ({ id: 7, userId: 22, workflowState: "engagement_active" }),
      runCycle,
    };

    const outcome = await runGovernedPostLiveLearningTrigger({ campaignId: 7, deps });
    expect(outcome).toEqual({
      outcome: "recorded",
      campaignId: 7,
      learningRecordId: 501,
      idempotentReplay: false,
    });
    expect(runCycle).toHaveBeenCalledWith({
      userId: 22,
      campaignId: 7,
      trigger: "api",
    });
  });

  it("runs the governed cycle for leads_converting campaigns and surfaces replays", async () => {
    const deps: PostLiveLearningTriggerDeps = {
      loadCampaignState: async () => ({ id: 7, userId: 22, workflowState: "leads_converting" }),
      runCycle: async () => ({
        status: "recorded",
        idempotentReplay: true,
        record: { id: 501 } as any,
      }),
    };
    const outcome = await runGovernedPostLiveLearningTrigger({ campaignId: 7, deps });
    expect(outcome).toMatchObject({
      outcome: "recorded",
      learningRecordId: 501,
      idempotentReplay: true,
    });
  });

  it("never fabricates Learning when no factual observations exist", async () => {
    const deps: PostLiveLearningTriggerDeps = {
      loadCampaignState: async () => ({ id: 7, userId: 22, workflowState: "engagement_active" }),
      runCycle: async () => ({
        status: "insufficient_data",
        reason: "No factual observations exist for campaign 7 in window 2026-05-01..2026-05-31.",
        observationCount: 0,
        campaignId: 7,
        windowStart: "2026-05-01",
        windowEnd: "2026-05-31",
      }),
    };
    const outcome = await runGovernedPostLiveLearningTrigger({ campaignId: 7, deps });
    expect(outcome.outcome).toBe("insufficient_data");
  });

  it("fails closed when Strategy authority is missing", async () => {
    const deps: PostLiveLearningTriggerDeps = {
      loadCampaignState: async () => ({ id: 7, userId: 22, workflowState: "leads_converting" }),
      runCycle: async () => ({
        status: "authority_missing",
        reason: "Required Strategy authority is missing for campaign 7: strategy_authority_missing",
        campaignId: 7,
        readinessStatus: "authority_missing",
        requiredIssues: [],
      }),
    };
    const outcome = await runGovernedPostLiveLearningTrigger({ campaignId: 7, deps });
    expect(outcome.outcome).toBe("authority_missing");
  });

  it("maps an unresolvable evaluation window to insufficient_data, not failure", async () => {
    const deps: PostLiveLearningTriggerDeps = {
      loadCampaignState: async () => ({ id: 7, userId: 22, workflowState: "engagement_active" }),
      runCycle: async () => {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "No evaluation window could be resolved: the campaign has no dates and no analytics observations exist.",
        });
      },
    };
    const outcome = await runGovernedPostLiveLearningTrigger({ campaignId: 7, deps });
    expect(outcome.outcome).toBe("insufficient_data");
  });

  it("contains unexpected cycle failures without throwing into the pass", async () => {
    const deps: PostLiveLearningTriggerDeps = {
      loadCampaignState: async () => ({ id: 7, userId: 22, workflowState: "engagement_active" }),
      runCycle: async () => {
        throw new Error("database unreachable");
      },
    };
    const outcome = await runGovernedPostLiveLearningTrigger({ campaignId: 7, deps });
    expect(outcome).toMatchObject({ outcome: "failed", campaignId: 7 });
  });

  it.each(["campaign_live", "optimisation_active", "completed", "strategy_pending"] as const)(
    "skips campaigns in ineligible state %s",
    async (workflowState) => {
      const runCycle = vi.fn();
      const deps: PostLiveLearningTriggerDeps = {
        loadCampaignState: async () => ({ id: 7, userId: 22, workflowState }),
        runCycle,
      };
      const outcome = await runGovernedPostLiveLearningTrigger({ campaignId: 7, deps });
      expect(outcome).toEqual({
        outcome: "skipped_ineligible_state",
        campaignId: 7,
        workflowState,
      });
      expect(runCycle).not.toHaveBeenCalled();
    }
  );

  it("reports campaign_not_found without evaluating", async () => {
    const runCycle = vi.fn();
    const outcome = await runGovernedPostLiveLearningTrigger({
      campaignId: 404,
      deps: { loadCampaignState: async () => null, runCycle },
    });
    expect(outcome).toEqual({ outcome: "campaign_not_found", campaignId: 404 });
    expect(runCycle).not.toHaveBeenCalled();
  });

  it("rejects a non-positive campaign id", async () => {
    await expect(runGovernedPostLiveLearningTrigger({ campaignId: 0 })).rejects.toThrow(
      "campaignId must be a positive integer"
    );
  });

  it("eligibility is exactly the two evidence-awaiting post-live states", () => {
    expect(POST_LIVE_LEARNING_ELIGIBLE_STATES).toEqual([
      "engagement_active",
      "leads_converting",
    ]);
  });
});

describe("post-live reconciliation consumes durable Learning evidence", () => {
  it("permits the optimisation transition once durable Learning evidence exists", async () => {
    // The trigger produced a record; the REAL lifecycle driver then sees the
    // durable learning evidence and advances the campaign exactly once.
    const outcome = await reconcilePostLiveCampaign({
      campaignId: 7,
      asOfDate: "2026-06-15",
      deps: {
        loadSnapshot: async () => ({
          campaignId: 7,
          userId: 22,
          workflowState: "engagement_active",
          endDate: "2026-07-31",
          liveAnchorAt: new Date("2026-05-01T00:00:00.000Z"),
          hasLeadEvidenceSinceLive: false,
          hasLearningEvidenceSinceLive: true,
        }),
        transition: async () => "optimisation_active",
      },
    });

    expect(outcome.status).toBe("transitioned");
    if (outcome.status !== "transitioned") return;
    expect(outcome.nextState).toBe("optimisation_active");
    expect(outcome.decision).toEqual({
      action: "start_optimisation",
      reason: "learning_evidence_present",
    });
  });

  it("still refuses the transition when no durable Learning evidence exists", async () => {
    const outcome = await reconcilePostLiveCampaign({
      campaignId: 7,
      asOfDate: "2026-06-15",
      deps: {
        loadSnapshot: async () => ({
          campaignId: 7,
          userId: 22,
          workflowState: "engagement_active",
          endDate: "2026-07-31",
          liveAnchorAt: new Date("2026-05-01T00:00:00.000Z"),
          hasLeadEvidenceSinceLive: false,
          hasLearningEvidenceSinceLive: false,
        }),
        transition: async () => {
          throw new Error("must not transition");
        },
      },
    });

    expect(outcome.status).toBe("no_transition");
    if (outcome.status !== "no_transition") return;
    expect(outcome.decision.reason).toBe("awaiting_lead_or_learning_evidence");
  });
});
