import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  runPostLiveLifecycleReconciliationPass,
} from "./post-live-lifecycle-pass";

import type {
  PostLiveLifecycleBatchDeps,
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

describe("runPostLiveLifecycleReconciliationPass", () => {
  const asOfDate = "2026-09-19";

  it("runs one controlled pass over the supplied candidates", async () => {
    const deps = createDeps([42, 43]);

    const result =
      await runPostLiveLifecycleReconciliationPass({
        asOfDate,
        deps,
      });

    expect(
      deps.listCandidateCampaignIds
    ).toHaveBeenCalledTimes(1);

    expect(
      deps.reconcileCampaign
    ).toHaveBeenCalledTimes(2);

    expect(result).toMatchObject({
      asOfDate,
      candidateCount: 2,
      attempted: 2,
      transitioned: 0,
      noTransition: 2,
      notFound: 0,
      failed: 0,
    });
  });

  it("passes the explicit authority date through unchanged", async () => {
    const deps = createDeps([42]);

    await runPostLiveLifecycleReconciliationPass({
      asOfDate,
      deps,
    });

    expect(
      deps.reconcileCampaign
    ).toHaveBeenCalledWith({
      campaignId: 42,
      asOfDate,
    });
  });

  it("preserves batch deduplication semantics", async () => {
    const deps = createDeps([
      42,
      42,
      43,
    ]);

    const result =
      await runPostLiveLifecycleReconciliationPass({
        asOfDate,
        deps,
      });

    expect(result.candidateCount).toBe(2);

    expect(
      deps.reconcileCampaign
    ).toHaveBeenCalledTimes(2);
  });

  it("returns an empty successful pass when there are no candidates", async () => {
    const deps = createDeps([]);

    await expect(
      runPostLiveLifecycleReconciliationPass({
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
  });

  it("isolates an individual campaign failure through the batch reconciler", async () => {
    const deps = createDeps([
      42,
      43,
    ]);

    deps.reconcileCampaign
      .mockRejectedValueOnce(
        new Error("state collision")
      )
      .mockResolvedValueOnce({
        status: "no_transition",
        campaignId: 43,
        previousState:
          "optimisation_active",
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
      await runPostLiveLifecycleReconciliationPass({
        asOfDate,
        deps,
      });

    expect(
      deps.reconcileCampaign
    ).toHaveBeenCalledTimes(2);

    expect(result).toMatchObject({
      attempted: 2,
      failed: 1,
      noTransition: 1,
    });

    expect(result.results[0]).toEqual({
      campaignId: 42,
      status: "failed",
      error: "state collision",
    });
  });

  it("rejects an invalid authority date before candidate execution", async () => {
    const deps = createDeps([42]);

    await expect(
      runPostLiveLifecycleReconciliationPass({
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