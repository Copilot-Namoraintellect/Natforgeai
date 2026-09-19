import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  loadPostLiveLifecycleSnapshot,
  reconcilePostLiveCampaignFromDb,
  type PostLiveLifecycleEvidenceStore,
} from "./post-live-lifecycle-db";

function createStore(
  overrides:
    Partial<
      PostLiveLifecycleEvidenceStore
    > = {}
): PostLiveLifecycleEvidenceStore {
  return {
    getCampaign:
      vi.fn().mockResolvedValue({
        id: 42,
        userId: 18,
        workflowState:
          "engagement_active",
        endDate:
          "2026-09-30",
        workflowContext: {
          campaignLiveAt:
            "2026-09-10T12:00:00Z",
          lastTransition: {
            from:
              "campaign_live",
            to:
              "engagement_active",
            action:
              "start_engagement",
            at:
              "2026-09-10T12:05:00Z",
          },
        },
      }),

    hasLeadCreatedSince:
      vi.fn()
        .mockResolvedValue(
          false
        ),

    hasLeadScoreSince:
      vi.fn()
        .mockResolvedValue(
          false
        ),

    hasLearningSince:
      vi.fn()
        .mockResolvedValue(
          false
        ),

    ...overrides,
  };
}

describe(
  "loadPostLiveLifecycleSnapshot",
  () => {
    it("returns null when the campaign does not exist", async () => {
      const store =
        createStore({
          getCampaign:
            vi.fn()
              .mockResolvedValue(
                null
              ),
        });

      await expect(
        loadPostLiveLifecycleSnapshot({
          campaignId: 42,
          store,
        })
      ).resolves.toBeNull();

      expect(
        store.hasLeadCreatedSince
      ).not.toHaveBeenCalled();
    });

    it("returns null outside the post-live lifecycle", async () => {
      const store =
        createStore({
          getCampaign:
            vi.fn()
              .mockResolvedValue({
                id: 42,
                userId: 18,
                workflowState:
                  "publication_pending",
                endDate:
                  "2026-09-30",
                workflowContext:
                  {},
              }),
        });

      await expect(
        loadPostLiveLifecycleSnapshot({
          campaignId: 42,
          store,
        })
      ).resolves.toBeNull();

      expect(
        store.hasLearningSince
      ).not.toHaveBeenCalled();
    });

    it("uses immutable campaignLiveAt as the lifecycle anchor", async () => {
      const result =
        await loadPostLiveLifecycleSnapshot({
          campaignId: 42,
          store:
            createStore(),
        });

      expect(
        result?.liveAnchorAt
          ?.toISOString()
      ).toBe(
        "2026-09-10T12:00:00.000Z"
      );
    });

    it("recovers the anchor for an already-live P1.1 campaign from go_live lastTransition", async () => {
      const store =
        createStore({
          getCampaign:
            vi.fn()
              .mockResolvedValue({
                id: 42,
                userId: 18,
                workflowState:
                  "campaign_live",
                endDate:
                  "2026-09-30",
                workflowContext: {
                  lastTransition: {
                    from:
                      "publication_pending",
                    to:
                      "campaign_live",
                    action:
                      "go_live",
                    at:
                      "2026-09-10T12:00:00Z",
                  },
                },
              }),
        });

      const result =
        await loadPostLiveLifecycleSnapshot({
          campaignId: 42,
          store,
        });

      expect(
        result?.liveAnchorAt
          ?.toISOString()
      ).toBe(
        "2026-09-10T12:00:00.000Z"
      );
    });

    it("fails evidence reads closed when no governed live anchor exists", async () => {
      const store =
        createStore({
          getCampaign:
            vi.fn()
              .mockResolvedValue({
                id: 42,
                userId: 18,
                workflowState:
                  "engagement_active",
                endDate:
                  "2026-09-30",
                workflowContext: {
                  lastTransition: {
                    from:
                      "campaign_live",
                    to:
                      "engagement_active",
                    action:
                      "start_engagement",
                    at:
                      "2026-09-10T12:05:00Z",
                  },
                },
              }),

          hasLeadCreatedSince:
            vi.fn(),

          hasLeadScoreSince:
            vi.fn(),

          hasLearningSince:
            vi.fn(),
        });

      const result =
        await loadPostLiveLifecycleSnapshot({
          campaignId: 42,
          store,
        });

      expect(
        store.hasLeadCreatedSince
      ).not.toHaveBeenCalled();

      expect(
        store.hasLeadScoreSince
      ).not.toHaveBeenCalled();

      expect(
        store.hasLearningSince
      ).not.toHaveBeenCalled();

      expect(result).toMatchObject({
        liveAnchorAt: null,
        hasLeadEvidenceSinceLive:
          false,
        hasLearningEvidenceSinceLive:
          false,
      });
    });

    it("treats a lead created after campaignLiveAt as current-lifecycle evidence", async () => {
      const store =
        createStore({
          hasLeadCreatedSince:
            vi.fn()
              .mockResolvedValue(
                true
              ),
        });

      const result =
        await loadPostLiveLifecycleSnapshot({
          campaignId: 42,
          store,
        });

      expect(
        store.hasLeadCreatedSince
      ).toHaveBeenCalledWith(
        42,
        18,
        new Date(
          "2026-09-10T12:00:00.000Z"
        )
      );

      expect(
        result
          ?.hasLeadEvidenceSinceLive
      ).toBe(true);
    });

    it("also treats a current-lifecycle lead score as lead evidence", async () => {
      const store =
        createStore({
          hasLeadScoreSince:
            vi.fn()
              .mockResolvedValue(
                true
              ),
        });

      const result =
        await loadPostLiveLifecycleSnapshot({
          campaignId: 42,
          store,
        });

      expect(
        result
          ?.hasLeadEvidenceSinceLive
      ).toBe(true);
    });

    it("loads Learning evidence against the same immutable live anchor", async () => {
      const store =
        createStore({
          hasLearningSince:
            vi.fn()
              .mockResolvedValue(
                true
              ),
        });

      const result =
        await loadPostLiveLifecycleSnapshot({
          campaignId: 42,
          store,
        });

      expect(
        store.hasLearningSince
      ).toHaveBeenCalledWith(
        42,
        18,
        new Date(
          "2026-09-10T12:00:00.000Z"
        )
      );

      expect(
        result
          ?.hasLearningEvidenceSinceLive
      ).toBe(true);
    });
  }
);

describe(
  "reconcilePostLiveCampaignFromDb",
  () => {
    it("delegates to the governed reconciler and executes at most one transition", async () => {
      const loadSnapshot =
        vi.fn()
          .mockResolvedValue({
            campaignId: 42,
            userId: 18,
            workflowState:
              "campaign_live",
            endDate:
              "2026-09-30",
            liveAnchorAt:
              new Date(
                "2026-09-10T12:00:00Z"
              ),
            hasLeadEvidenceSinceLive:
              true,
            hasLearningEvidenceSinceLive:
              true,
          });

      const transition =
        vi.fn()
          .mockResolvedValue(
            "engagement_active"
          );

      const result =
        await reconcilePostLiveCampaignFromDb({
          campaignId: 42,
          asOfDate:
            "2026-09-19",
          deps: {
            loadSnapshot,
            transition,
          },
        });

      expect(loadSnapshot)
        .toHaveBeenCalledTimes(1);

      expect(transition)
        .toHaveBeenCalledTimes(1);

      expect(transition)
        .toHaveBeenCalledWith(
          42,
          18,
          "start_engagement"
        );

      expect(result).toMatchObject({
        status: "transitioned",
        previousState:
          "campaign_live",
        nextState:
          "engagement_active",
      });
    });

    it("does not retry a failed governed transition", async () => {
      const loadSnapshot =
        vi.fn()
          .mockResolvedValue({
            campaignId: 42,
            userId: 18,
            workflowState:
              "campaign_live",
            endDate:
              "2026-09-30",
            liveAnchorAt:
              null,
            hasLeadEvidenceSinceLive:
              false,
            hasLearningEvidenceSinceLive:
              false,
          });

      const transition =
        vi.fn()
          .mockRejectedValue(
            new Error(
              "transition collision"
            )
          );

      await expect(
        reconcilePostLiveCampaignFromDb({
          campaignId: 42,
          asOfDate:
            "2026-09-19",
          deps: {
            loadSnapshot,
            transition,
          },
        })
      ).rejects.toThrow(
        "transition collision"
      );

      expect(transition)
        .toHaveBeenCalledTimes(1);
    });
  }
);