import { describe, expect, it, vi } from "vitest";

const redisMock = vi.hoisted(() => ({
  isRedisConfigured: vi.fn(),
}));

vi.mock("../redis", () => ({
  isRedisConfigured: redisMock.isRedisConfigured,
  connectRedis: vi.fn(),
  getRedisClient: vi.fn(),
  disconnectRedis: vi.fn(),
}));

import {
  createInProcessMetricsObservationLeaseStore,
  runLeaseProtectedPostLiveMetricsObservationPass,
  POST_LIVE_METRICS_OBSERVATION_LEASE_LOST_ERROR,
} from "./post-live-metrics-observation-leased-pass";
import type { PostLiveMetricsObservationPassDeps } from "./post-live-metrics-observation-pass";
import type { PostLiveMetricsObservationLeasedPassDeps } from "./post-live-metrics-observation-leased-pass";

function fakePassDeps(overrides?: Partial<PostLiveMetricsObservationPassDeps>) {
  return {
    listPublishedCandidates: async () => [],
    loadLastObservedAt: async () => null,
    resolveBinding: () => null,
    persistObservations: async () => {},
    ...overrides,
  } satisfies PostLiveMetricsObservationPassDeps;
}

function fakeLeasedDeps(input: {
  passDeps?: PostLiveMetricsObservationPassDeps;
  leaseStore?: PostLiveMetricsObservationLeasedPassDeps["leaseStore"];
}) {
  return {
    leaseStore: input.leaseStore ?? createInProcessMetricsObservationLeaseStore(),
    passDeps: input.passDeps ?? fakePassDeps(),
    createOwnerToken: () => "owner-1",
    startInterval: vi.fn(() => 0 as unknown as ReturnType<typeof setInterval>),
    stopInterval: vi.fn(),
  } satisfies PostLiveMetricsObservationLeasedPassDeps;
}

describe("createInProcessMetricsObservationLeaseStore", () => {
  it("grants sole ownership per key and honours owner tokens", async () => {
    const store = createInProcessMetricsObservationLeaseStore();

    await expect(
      store.acquire({ key: "k", ownerToken: "a", ttlMs: 1000 })
    ).resolves.toBe(true);
    await expect(
      store.acquire({ key: "k", ownerToken: "b", ttlMs: 1000 })
    ).resolves.toBe(false);

    await expect(store.renew({ key: "k", ownerToken: "b", ttlMs: 1000 })).resolves.toBe(false);
    await expect(store.renew({ key: "k", ownerToken: "a", ttlMs: 1000 })).resolves.toBe(true);

    await expect(store.release({ key: "k", ownerToken: "b" })).resolves.toBe(false);
    await expect(store.release({ key: "k", ownerToken: "a" })).resolves.toBe(true);

    // Released keys can be re-acquired by a new owner.
    await expect(
      store.acquire({ key: "k", ownerToken: "b", ttlMs: 1000 })
    ).resolves.toBe(true);
  });

  it("rejects empty keys and owner tokens", async () => {
    const store = createInProcessMetricsObservationLeaseStore();
    await expect(
      store.acquire({ key: " ", ownerToken: "a", ttlMs: 1000 })
    ).rejects.toThrow("Lease key must not be empty");
    await expect(
      store.acquire({ key: "k", ownerToken: "", ttlMs: 1000 })
    ).rejects.toThrow("Lease ownerToken must not be empty");
  });
});

describe("runLeaseProtectedPostLiveMetricsObservationPass without Redis (dev autonomy)", () => {
  it("runs the pass to completion under the in-process lease", async () => {
    redisMock.isRedisConfigured.mockReturnValue(false);

    const persistObservations = vi.fn().mockResolvedValue(undefined);
    const result = await runLeaseProtectedPostLiveMetricsObservationPass({
      asOfDate: "2026-06-24",
      deps: fakeLeasedDeps({
        passDeps: fakePassDeps({
          listPublishedCandidates: async () => [
            {
              queueItemId: 1,
              userId: 10,
              campaignId: 20,
              platform: "facebook",
              publishedAt: "2026-06-23T10:00:00.000Z",
              externalPostId: "post-1",
            },
          ],
          loadLastObservedAt: async () => null,
          resolveBinding: () => null,
          persistObservations,
        }),
      }),
    });

    if (result.status === "lease_contended") {
      throw new Error("expected to hold the observation lease for the pass");
    }
    expect(result.status).toBe("completed");
    expect(result.ran).toBe(true);
    expect(result.report.candidates).toBe(1);
    // No binding in dev → fail-closed unsupported_platform, never a throw.
    expect(result.report.results[0].status).toBe("unsupported_platform");
    expect(persistObservations).not.toHaveBeenCalled();
  });

  it("aborts persistence when lease ownership is lost before a candidate write", async () => {
    redisMock.isRedisConfigured.mockReturnValue(false);

    let releaseCalled = false;
    const leaseStore = createInProcessMetricsObservationLeaseStore();
    const originalRelease = leaseStore.release.bind(leaseStore);
    leaseStore.release = async (input) => {
      releaseCalled = true;
      return originalRelease(input);
    };
    // Deterministic lease loss (e.g. Redis key eviction/expiry): the guarded
    // persist boundary renews ownership before every write and must refuse
    // once renewal fails.
    leaseStore.renew = async () => false;

    const persistObservations = vi.fn().mockResolvedValue(undefined);
    const result = await runLeaseProtectedPostLiveMetricsObservationPass({
      asOfDate: "2026-06-24",
      deps: fakeLeasedDeps({
        leaseStore,
        passDeps: fakePassDeps({
          listPublishedCandidates: async () => [
            {
              queueItemId: 1,
              userId: 10,
              campaignId: 20,
              platform: "facebook",
              publishedAt: "2026-06-23T10:00:00.000Z",
              externalPostId: "post-1",
            },
          ],
          loadLastObservedAt: async () => null,
          resolveBinding: () => ({
            platform: "facebook",
            fetchPostMetrics: async () => [{ metricType: "impressions", value: 100 }],
          }),
          persistObservations,
        }),
      }),
    });

    if (result.status === "lease_contended") {
      throw new Error("expected to hold the observation lease for the pass");
    }
    expect(result.status).toBe("lease_lost");
    expect(result.report.results[0].status).toBe("persist_failed");
    expect(result.report.results[0].detail).toBe(POST_LIVE_METRICS_OBSERVATION_LEASE_LOST_ERROR);
    expect(persistObservations).not.toHaveBeenCalled();
    expect(releaseCalled).toBe(true);
  });
});
