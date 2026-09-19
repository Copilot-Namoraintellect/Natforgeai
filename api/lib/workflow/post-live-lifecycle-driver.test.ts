import { describe, expect, it, vi } from "vitest";
import {
  reconcilePostLiveCampaign,
  type PostLiveLifecycleReconcileDeps,
  type PostLiveLifecycleSnapshot,
} from "./post-live-lifecycle-driver";

function snapshot(
  overrides: Partial<PostLiveLifecycleSnapshot> = {}
): PostLiveLifecycleSnapshot {
  return {
    campaignId: 42,
    userId: 18,
    workflowState: "campaign_live",
    endDate: "2026-09-30",
    liveAnchorAt: new Date("2026-09-10T12:00:00Z"),
    hasLeadEvidenceSinceLive: false,
    hasLearningEvidenceSinceLive: false,
    ...overrides,
  };
}

function depsFor(
  value: PostLiveLifecycleSnapshot | null,
  nextState: PostLiveLifecycleSnapshot["workflowState"] = "engagement_active"
): PostLiveLifecycleReconcileDeps & {
  loadSnapshot: ReturnType<typeof vi.fn>;
  transition: ReturnType<typeof vi.fn>;
} {
  return {
    loadSnapshot: vi.fn().mockResolvedValue(value),
    transition: vi.fn().mockResolvedValue(nextState),
  };
}

describe("reconcilePostLiveCampaign", () => {
  const asOfDate = "2026-09-19";

  it("returns not_found without attempting a transition", async () => {
    const deps = depsFor(null);

    await expect(
      reconcilePostLiveCampaign({
        campaignId: 42,
        asOfDate,
        deps,
      })
    ).resolves.toEqual({
      status: "not_found",
      campaignId: 42,
      transitioned: false,
    });

    expect(deps.transition).not.toHaveBeenCalled();
  });

  it("moves campaign_live to engagement_active without requiring evidence", async () => {
    const deps = depsFor(
      snapshot({
        liveAnchorAt: null,
      }),
      "engagement_active"
    );

    const result = await reconcilePostLiveCampaign({
      campaignId: 42,
      asOfDate,
      deps,
    });

    expect(deps.transition).toHaveBeenCalledTimes(1);
    expect(deps.transition).toHaveBeenCalledWith(
      42,
      18,
      "start_engagement"
    );

    expect(result).toMatchObject({
      status: "transitioned",
      previousState: "campaign_live",
      nextState: "engagement_active",
      transitioned: true,
      evidenceAuthority: "not_required",
    });
  });

  it("uses current-lifecycle lead evidence to enter leads_converting", async () => {
    const deps = depsFor(
      snapshot({
        workflowState: "engagement_active",
        hasLeadEvidenceSinceLive: true,
      }),
      "leads_converting"
    );

    const result = await reconcilePostLiveCampaign({
      campaignId: 42,
      asOfDate,
      deps,
    });

    expect(deps.transition).toHaveBeenCalledWith(
      42,
      18,
      "start_lead_conversion"
    );

    expect(result).toMatchObject({
      status: "transitioned",
      nextState: "leads_converting",
      evidenceAuthority: "current_lifecycle_anchor_present",
    });
  });

  it("fails closed on historical lead evidence when the live anchor is missing", async () => {
    const deps = depsFor(
      snapshot({
        workflowState: "engagement_active",
        liveAnchorAt: null,
        hasLeadEvidenceSinceLive: true,
      })
    );

    const result = await reconcilePostLiveCampaign({
      campaignId: 42,
      asOfDate,
      deps,
    });

    expect(deps.transition).not.toHaveBeenCalled();

    expect(result).toMatchObject({
      status: "no_transition",
      previousState: "engagement_active",
      evidenceAuthority: "current_lifecycle_anchor_missing",
    });
  });

  it("uses current-lifecycle Learning evidence to enter optimisation without requiring leads", async () => {
    const deps = depsFor(
      snapshot({
        workflowState: "engagement_active",
        hasLeadEvidenceSinceLive: false,
        hasLearningEvidenceSinceLive: true,
      }),
      "optimisation_active"
    );

    const result = await reconcilePostLiveCampaign({
      campaignId: 42,
      asOfDate,
      deps,
    });

    expect(deps.transition).toHaveBeenCalledWith(
      42,
      18,
      "start_optimisation"
    );

    expect(result).toMatchObject({
      status: "transitioned",
      nextState: "optimisation_active",
      evidenceAuthority: "current_lifecycle_anchor_present",
    });
  });

  it("preserves leads_converting first when both lead and Learning evidence exist", async () => {
    const deps = depsFor(
      snapshot({
        workflowState: "engagement_active",
        hasLeadEvidenceSinceLive: true,
        hasLearningEvidenceSinceLive: true,
      }),
      "leads_converting"
    );

    await reconcilePostLiveCampaign({
      campaignId: 42,
      asOfDate,
      deps,
    });

    expect(deps.transition).toHaveBeenCalledWith(
      42,
      18,
      "start_lead_conversion"
    );
  });

  it("moves leads_converting to optimisation only with current-lifecycle Learning evidence", async () => {
    const deps = depsFor(
      snapshot({
        workflowState: "leads_converting",
        hasLeadEvidenceSinceLive: true,
        hasLearningEvidenceSinceLive: true,
      }),
      "optimisation_active"
    );

    await reconcilePostLiveCampaign({
      campaignId: 42,
      asOfDate,
      deps,
    });

    expect(deps.transition).toHaveBeenCalledWith(
      42,
      18,
      "start_optimisation"
    );
  });

  it("does not use Learning evidence when the current lifecycle anchor is missing", async () => {
    const deps = depsFor(
      snapshot({
        workflowState: "leads_converting",
        liveAnchorAt: null,
        hasLearningEvidenceSinceLive: true,
      })
    );

    const result = await reconcilePostLiveCampaign({
      campaignId: 42,
      asOfDate,
      deps,
    });

    expect(deps.transition).not.toHaveBeenCalled();

    expect(result).toMatchObject({
      status: "no_transition",
      evidenceAuthority: "current_lifecycle_anchor_missing",
    });
  });

  it("completes an ended campaign even when there is no current lifecycle evidence anchor", async () => {
    const deps = depsFor(
      snapshot({
        workflowState: "engagement_active",
        endDate: "2026-09-18",
        liveAnchorAt: null,
      }),
      "completed"
    );

    const result = await reconcilePostLiveCampaign({
      campaignId: 42,
      asOfDate,
      deps,
    });

    expect(deps.transition).toHaveBeenCalledWith(
      42,
      18,
      "complete_campaign"
    );

    expect(result).toMatchObject({
      status: "transitioned",
      nextState: "completed",
      evidenceAuthority: "not_required",
    });
  });

  it("does not complete on the inclusive end date", async () => {
    const deps = depsFor(
      snapshot({
        workflowState: "optimisation_active",
        endDate: "2026-09-19",
      })
    );

    const result = await reconcilePostLiveCampaign({
      campaignId: 42,
      asOfDate,
      deps,
    });

    expect(deps.transition).not.toHaveBeenCalled();

    expect(result).toMatchObject({
      status: "no_transition",
      previousState: "optimisation_active",
      decision: {
        action: null,
        reason: "awaiting_campaign_end",
      },
    });
  });

  it("executes at most one transition per reconciliation", async () => {
    const deps = depsFor(
      snapshot({
        workflowState: "campaign_live",
        hasLeadEvidenceSinceLive: true,
        hasLearningEvidenceSinceLive: true,
      }),
      "engagement_active"
    );

    await reconcilePostLiveCampaign({
      campaignId: 42,
      asOfDate,
      deps,
    });

    expect(deps.transition).toHaveBeenCalledTimes(1);
    expect(deps.transition).toHaveBeenCalledWith(
      42,
      18,
      "start_engagement"
    );
  });

  it("propagates transition failure and performs no retry", async () => {
    const deps = depsFor(snapshot());

    deps.transition.mockRejectedValueOnce(
      new Error("workflow transition failed")
    );

    await expect(
      reconcilePostLiveCampaign({
        campaignId: 42,
        asOfDate,
        deps,
      })
    ).rejects.toThrow("workflow transition failed");

    expect(deps.transition).toHaveBeenCalledTimes(1);
  });
});