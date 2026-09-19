import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  reconcilePostLiveCampaignBatch,
  type PostLiveLifecycleBatchDeps,
} from "./post-live-lifecycle-batch";

function createDeps(
  ids: number[]
): PostLiveLifecycleBatchDeps & {
  listCandidateCampaignIds: ReturnType<typeof vi.fn>;
  reconcileCampaign: ReturnType<typeof vi.fn>;
} {
  return {
    listCandidateCampaignIds:
      vi.fn().mockResolvedValue(ids),

    reconcileCampaign:
      vi.fn().mockImplementation(
        async ({
          campaignId,
        }: {
          campaignId: number;
          asOfDate: string;
        }) => ({
          status: "no_transition" as const,
          campaignId,
          previousState:
            "engagement_active" as const,
          transitioned: false as const,
          decision: {
            action: null,
            reason:
              "awaiting_lead_or_learning_evidence" as const,
          },
          evidenceAuthority:
            "current_lifecycle_anchor_present" as const,
        })
      ),
  };
}

describe("reconcilePostLiveCampaignBatch", () => {
  const asOfDate = "2026-09-19";

  it("returns an empty report when there are no candidates", async () => {
    const deps = createDeps([]);

    await expect(
      reconcilePostLiveCampaignBatch({
        asOfDate,
        deps,
      })
    ).resolves.toEqual({
      asOfDate,
      candidateCount: 0,
      attempted: 0,
      transitioned: 0,
      noTransition: 0,
      notFound: 0,
      failed: 0,
      results: [],
    });

    expect(
      deps.reconcileCampaign
    ).not.toHaveBeenCalled();
  });

  it("deduplicates campaign IDs and reconciles each unique campaign once", async () => {
    const deps = createDeps([
      42,
      42,
      43,
      43,
      44,
    ]);

    const result =
      await reconcilePostLiveCampaignBatch({
        asOfDate,
        deps,
      });

    expect(result.candidateCount).toBe(3);
    expect(result.attempted).toBe(3);

    expect(
      deps.reconcileCampaign
    ).toHaveBeenCalledTimes(3);

    expect(
      deps.reconcileCampaign.mock.calls.map(
        (call) => call[0].campaignId
      )
    ).toEqual([42, 43, 44]);
  });

  it("passes the same explicit authority date to every campaign", async () => {
    const deps = createDeps([42, 43]);

    await reconcilePostLiveCampaignBatch({
      asOfDate,
      deps,
    });

    expect(
      deps.reconcileCampaign
    ).toHaveBeenNthCalledWith(
      1,
      {
        campaignId: 42,
        asOfDate,
      }
    );

    expect(
      deps.reconcileCampaign
    ).toHaveBeenNthCalledWith(
      2,
      {
        campaignId: 43,
        asOfDate,
      }
    );
  });

  it("records transitioned, no-transition and not-found outcomes separately", async () => {
    const deps = createDeps([42, 43, 44]);

    deps.reconcileCampaign
      .mockResolvedValueOnce({
        status: "transitioned",
        campaignId: 42,
        previousState: "campaign_live",
        nextState: "engagement_active",
        transitioned: true,
        decision: {
          action: "start_engagement",
          reason:
            "engagement_phase_start",
        },
        evidenceAuthority: "not_required",
      })
      .mockResolvedValueOnce({
        status: "no_transition",
        campaignId: 43,
        previousState: "engagement_active",
        transitioned: false,
        decision: {
          action: null,
          reason:
            "awaiting_lead_or_learning_evidence",
        },
        evidenceAuthority:
          "current_lifecycle_anchor_present",
      })
      .mockResolvedValueOnce({
        status: "not_found",
        campaignId: 44,
        transitioned: false,
      });

    const result =
      await reconcilePostLiveCampaignBatch({
        asOfDate,
        deps,
      });

    expect(result).toMatchObject({
      candidateCount: 3,
      attempted: 3,
      transitioned: 1,
      noTransition: 1,
      notFound: 1,
      failed: 0,
    });
  });

  it("isolates one campaign failure and continues with later candidates without retrying", async () => {
    const deps = createDeps([42, 43, 44]);

    deps.reconcileCampaign
      .mockResolvedValueOnce({
        status: "no_transition",
        campaignId: 42,
        previousState: "engagement_active",
        transitioned: false,
        decision: {
          action: null,
          reason:
            "awaiting_lead_or_learning_evidence",
        },
        evidenceAuthority:
          "current_lifecycle_anchor_present",
      })
      .mockRejectedValueOnce(
        new Error("transition collision")
      )
      .mockResolvedValueOnce({
        status: "no_transition",
        campaignId: 44,
        previousState: "optimisation_active",
        transitioned: false,
        decision: {
          action: null,
          reason:
            "awaiting_campaign_end",
        },
        evidenceAuthority:
          "not_required",
      });

    const result =
      await reconcilePostLiveCampaignBatch({
        asOfDate,
        deps,
      });

    expect(
      deps.reconcileCampaign
    ).toHaveBeenCalledTimes(3);

    expect(result).toMatchObject({
      attempted: 3,
      transitioned: 0,
      noTransition: 2,
      notFound: 0,
      failed: 1,
    });

    expect(result.results[1]).toEqual({
      campaignId: 43,
      status: "failed",
      error: "transition collision",
    });
  });

  it("rejects an ambiguous authority date before listing candidates", async () => {
    const deps = createDeps([42]);

    await expect(
      reconcilePostLiveCampaignBatch({
        asOfDate: "19/09/2026",
        deps,
      })
    ).rejects.toThrow(
      "asOfDate must be YYYY-MM-DD"
    );

    expect(
      deps.listCandidateCampaignIds
    ).not.toHaveBeenCalled();

    expect(
      deps.reconcileCampaign
    ).not.toHaveBeenCalled();
  });
});