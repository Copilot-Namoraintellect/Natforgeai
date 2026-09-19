import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  POST_LIVE_LIFECYCLE_HEARTBEAT_MS,
  POST_LIVE_LIFECYCLE_LEASE_KEY,
  POST_LIVE_LIFECYCLE_LEASE_LOST_ERROR,
  POST_LIVE_LIFECYCLE_LEASE_TTL_MS,
  runLeaseProtectedPostLiveLifecyclePass,
  type PostLiveLifecycleLeasedPassDeps,
} from "./post-live-lifecycle-leased-pass";

function createDeps(input?: {
  acquired?: boolean;
  renewResults?: boolean[];
  releaseResult?: boolean;
  candidateIds?: number[];
}): PostLiveLifecycleLeasedPassDeps & {
  leaseStore: {
    acquire: ReturnType<typeof vi.fn>;
    renew: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  batchDeps: {
    listCandidateCampaignIds:
      ReturnType<typeof vi.fn>;
    reconcileCampaign:
      ReturnType<typeof vi.fn>;
  };
  createOwnerToken:
    ReturnType<typeof vi.fn>;
  startInterval:
    ReturnType<typeof vi.fn>;
} {
  const renewResults = [
    ...(input?.renewResults ?? [true]),
  ];

  return {
    leaseStore: {
      acquire:
        vi.fn().mockResolvedValue(
          input?.acquired ?? true
        ),

      renew:
        vi.fn().mockImplementation(
          async () =>
            renewResults.length > 0
              ? renewResults.shift()
              : true
        ),

      release:
        vi.fn().mockResolvedValue(
          input?.releaseResult ?? true
        ),
    },

    batchDeps: {
      listCandidateCampaignIds:
        vi.fn().mockResolvedValue(
          input?.candidateIds ?? [42]
        ),

      reconcileCampaign:
        vi.fn().mockImplementation(
          async ({
            campaignId,
          }: {
            campaignId: number;
            asOfDate: string;
          }) => ({
            status:
              "no_transition" as const,
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
    },

    createOwnerToken:
      vi.fn().mockReturnValue(
        "owner-token-a"
      ),

    startInterval:
      vi.fn().mockReturnValue(
        123 as unknown as ReturnType<
          typeof setInterval
        >
      ),

    stopInterval:
      vi.fn(),
  };
}

describe(
  "runLeaseProtectedPostLiveLifecyclePass",
  () => {
    const asOfDate =
      "2026-09-19";

    it("does not run the pass when another owner holds the lease", async () => {
      const deps = createDeps({
        acquired: false,
      });

      await expect(
        runLeaseProtectedPostLiveLifecyclePass({
          asOfDate,
          deps,
        })
      ).resolves.toEqual({
        status: "lease_contended",
        ran: false,
        leaseKey:
          POST_LIVE_LIFECYCLE_LEASE_KEY,
      });

      expect(
        deps.batchDeps
          .listCandidateCampaignIds
      ).not.toHaveBeenCalled();

      expect(
        deps.batchDeps
          .reconcileCampaign
      ).not.toHaveBeenCalled();

      expect(
        deps.leaseStore.renew
      ).not.toHaveBeenCalled();

      expect(
        deps.leaseStore.release
      ).not.toHaveBeenCalled();

      expect(
        deps.startInterval
      ).not.toHaveBeenCalled();
    });

    it("acquires, renews before campaign reconciliation, runs one pass and releases", async () => {
      const deps =
        createDeps({
          candidateIds: [42],
        });

      const result =
        await runLeaseProtectedPostLiveLifecyclePass({
          asOfDate,
          deps,
        });

      expect(
        deps.leaseStore.acquire
      ).toHaveBeenCalledWith({
        key:
          POST_LIVE_LIFECYCLE_LEASE_KEY,
        ownerToken:
          "owner-token-a",
        ttlMs:
          POST_LIVE_LIFECYCLE_LEASE_TTL_MS,
      });

      expect(
        deps.startInterval
      ).toHaveBeenCalledWith(
        expect.any(Function),
        POST_LIVE_LIFECYCLE_HEARTBEAT_MS
      );

      expect(
        deps.leaseStore.renew
      ).toHaveBeenCalledWith({
        key:
          POST_LIVE_LIFECYCLE_LEASE_KEY,
        ownerToken:
          "owner-token-a",
        ttlMs:
          POST_LIVE_LIFECYCLE_LEASE_TTL_MS,
      });

      expect(
        deps.batchDeps.reconcileCampaign
      ).toHaveBeenCalledTimes(1);

      expect(
        deps.stopInterval
      ).toHaveBeenCalledTimes(1);

      expect(
        deps.leaseStore.release
      ).toHaveBeenCalledWith({
        key:
          POST_LIVE_LIFECYCLE_LEASE_KEY,
        ownerToken:
          "owner-token-a",
      });

      expect(result).toMatchObject({
        status: "completed",
        ran: true,
        releaseSucceeded: true,
        report: {
          candidateCount: 1,
          attempted: 1,
          failed: 0,
        },
      });
    });

    it("fails closed before campaign mutation when lease ownership cannot be renewed", async () => {
      const deps =
        createDeps({
          candidateIds: [42],
          renewResults: [false],
        });

      const result =
        await runLeaseProtectedPostLiveLifecyclePass({
          asOfDate,
          deps,
        });

      expect(
        deps.batchDeps.reconcileCampaign
      ).not.toHaveBeenCalled();

      expect(result).toMatchObject({
        status: "lease_lost",
        ran: true,
        report: {
          candidateCount: 1,
          attempted: 1,
          transitioned: 0,
          failed: 1,
        },
      });

      if (!result.ran) {
        throw new Error(
          "Expected the leased reconciliation pass to have run"
        );
      }

      expect(
        result.report.results[0]
      ).toEqual({
        campaignId: 42,
        status: "failed",
        error:
          POST_LIVE_LIFECYCLE_LEASE_LOST_ERROR,
      });
    });

    it("does not mutate later campaigns after ownership is lost", async () => {
      const deps =
        createDeps({
          candidateIds: [
            42,
            43,
            44,
          ],
          renewResults: [
            true,
            false,
          ],
        });

      const result =
        await runLeaseProtectedPostLiveLifecyclePass({
          asOfDate,
          deps,
        });

      expect(
        deps.batchDeps.reconcileCampaign
      ).toHaveBeenCalledTimes(1);

      expect(
        deps.batchDeps.reconcileCampaign
      ).toHaveBeenCalledWith({
        campaignId: 42,
        asOfDate,
      });

      expect(result).toMatchObject({
        status: "lease_lost",
        report: {
          candidateCount: 3,
          attempted: 3,
          noTransition: 1,
          failed: 2,
        },
      });
    });

    it("treats a Redis renewal error as lost ownership and fails closed", async () => {
      const deps =
        createDeps({
          candidateIds: [42],
        });

      deps.leaseStore.renew
        .mockRejectedValueOnce(
          new Error(
            "redis unavailable"
          )
        );

      const result =
        await runLeaseProtectedPostLiveLifecyclePass({
          asOfDate,
          deps,
        });

      expect(
        deps.batchDeps.reconcileCampaign
      ).not.toHaveBeenCalled();

      expect(result.status)
        .toBe("lease_lost");
    });

    it("reports release failure without replaying the pass", async () => {
      const deps =
        createDeps({
          candidateIds: [42],
          releaseResult: false,
        });

      const result =
        await runLeaseProtectedPostLiveLifecyclePass({
          asOfDate,
          deps,
        });

      expect(result).toMatchObject({
        status: "completed",
        ran: true,
        releaseSucceeded: false,
      });

      expect(
        deps.batchDeps.reconcileCampaign
      ).toHaveBeenCalledTimes(1);
    });

    it("rejects an invalid authority date before acquiring Redis ownership", async () => {
      const deps =
        createDeps();

      await expect(
        runLeaseProtectedPostLiveLifecyclePass({
          asOfDate:
            "19/09/2026",
          deps,
        })
      ).rejects.toThrow(
        "asOfDate must be YYYY-MM-DD"
      );

      expect(
        deps.leaseStore.acquire
      ).not.toHaveBeenCalled();
    });

    it("rejects unsafe lease timing before acquiring Redis ownership", async () => {
      const deps =
        createDeps();

      await expect(
        runLeaseProtectedPostLiveLifecyclePass({
          asOfDate,
          ttlMs: 30000,
          heartbeatMs: 30000,
          deps,
        })
      ).rejects.toThrow(
        "heartbeatMs must be less than ttlMs"
      );

      expect(
        deps.leaseStore.acquire
      ).not.toHaveBeenCalled();
    });
  }
);