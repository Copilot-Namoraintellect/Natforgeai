import { describe, it, expect } from "vitest";
import {
  POST_LIVE_METRICS_OBSERVATION_HEARTBEAT_MS,
  POST_LIVE_METRICS_OBSERVATION_LEASE_KEY,
  POST_LIVE_METRICS_OBSERVATION_LEASE_LOST_ERROR,
  POST_LIVE_METRICS_OBSERVATION_LEASE_TTL_MS,
  runLeaseProtectedPostLiveMetricsObservationPass,
  type PostLiveMetricsObservationLeasedPassDeps,
} from "./post-live-metrics-observation-leased-pass";
import type {
  MetricsObservationBinding,
  PostLiveMetricsObservationPassDeps,
  PublishedObservationCandidate,
} from "./post-live-metrics-observation-pass";

const CANDIDATE: PublishedObservationCandidate = {
  queueItemId: 101,
  userId: 42,
  campaignId: 29,
  platform: "facebook",
  publishedAt: "2026-06-11T08:00:00.000Z",
  externalPostId: "ext-1",
};

function createLeaseStore(overrides: {
  acquire?: boolean;
  renew?: boolean;
} = {}) {
  const calls: Array<{ op: string; key: string }> = [];
  return {
    calls,
    store: {
      acquire: async ({ key }: { key: string; ownerToken: string; ttlMs: number }) => {
        calls.push({ op: "acquire", key });
        return overrides.acquire ?? true;
      },
      renew: async ({ key }: { key: string; ownerToken: string; ttlMs: number }) => {
        calls.push({ op: "renew", key });
        return overrides.renew ?? true;
      },
      release: async ({ key }: { key: string; ownerToken: string }) => {
        calls.push({ op: "release", key });
        return true;
      },
    },
  };
}

function createPassDeps(overrides: Partial<PostLiveMetricsObservationPassDeps> = {}) {
  const persisted: unknown[] = [];
  const deps: PostLiveMetricsObservationPassDeps = {
    listPublishedCandidates: async () => [CANDIDATE],
    loadLastObservedAt: async () => null,
    resolveBinding: () =>
      ({
        platform: "facebook",
        fetchPostMetrics: async () => [{ metricType: "impressions", value: 10 }],
      }) as MetricsObservationBinding,
    persistObservations: async input => {
      persisted.push(input);
    },
    ...overrides,
  };
  return { deps, persisted };
}

function createDeps(options: {
  acquire?: boolean;
  renew?: boolean;
  passOverrides?: Partial<PostLiveMetricsObservationPassDeps>;
} = {}) {
  const { store, calls } = createLeaseStore({ acquire: options.acquire, renew: options.renew });
  const { deps: passDeps, persisted } = createPassDeps(options.passOverrides);
  const intervals: Array<{ callback: () => void; intervalMs: number }> = [];
  let stopped = 0;

  const deps: PostLiveMetricsObservationLeasedPassDeps = {
    leaseStore: store,
    passDeps,
    createOwnerToken: () => "owner-token",
    startInterval: (callback, intervalMs) => {
      intervals.push({ callback, intervalMs });
      return intervals.length as unknown as ReturnType<typeof setInterval>;
    },
    stopInterval: () => {
      stopped += 1;
    },
  };

  return { deps, calls, persisted, intervals, stoppedCount: () => stopped };
}

describe("lease-protected post-live metrics observation pass (WBS-R1.5)", () => {
  it("uses the dedicated lease key, TTL and heartbeat constants", () => {
    expect(POST_LIVE_METRICS_OBSERVATION_LEASE_KEY).toBe(
      "natforge:p1:post-live-metrics-observation"
    );
    expect(POST_LIVE_METRICS_OBSERVATION_LEASE_TTL_MS).toBe(120_000);
    expect(POST_LIVE_METRICS_OBSERVATION_HEARTBEAT_MS).toBe(30_000);
  });

  it("returns lease_contended without running when another owner holds the lease", async () => {
    const { deps, calls, persisted } = createDeps({ acquire: false });

    const result = await runLeaseProtectedPostLiveMetricsObservationPass({
      asOfDate: "2026-06-12",
      deps,
    });

    expect(result.status).toBe("lease_contended");
    expect(result.ran).toBe(false);
    expect(calls.map(c => c.op)).toEqual(["acquire"]);
    expect(persisted).toHaveLength(0);
  });

  it("runs the pass, renews before persisting and releases on completion", async () => {
    const { deps, calls, persisted } = createDeps();

    const result = await runLeaseProtectedPostLiveMetricsObservationPass({
      asOfDate: "2026-06-12",
      deps,
    });

    expect(result.status).toBe("completed");
    if (result.status === "lease_contended") throw new Error("expected the pass to run");
    expect(result.ran).toBe(true);
    expect(result.releaseSucceeded).toBe(true);
    expect(result.report.observed).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(calls[0]).toEqual({ op: "acquire", key: POST_LIVE_METRICS_OBSERVATION_LEASE_KEY });
    // Ownership revalidated (renewed) before the persist, then released.
    expect(calls[calls.length - 1].op).toBe("release");
    expect(calls.some(c => c.op === "renew")).toBe(true);
    expect(deps).toBeTruthy();
  });

  it("marks the pass lease_lost when ownership renewal fails before persist", async () => {
    const { deps, persisted } = createDeps({ renew: false });

    const result = await runLeaseProtectedPostLiveMetricsObservationPass({
      asOfDate: "2026-06-12",
      deps,
    });

    expect(result.status).toBe("lease_lost");
    if (result.status === "lease_contended") throw new Error("expected the pass to run");
    expect(result.ran).toBe(true);
    // The guarded persist threw the lease-lost error before delegating.
    expect(persisted).toHaveLength(0);
    expect(result.report.results[0].status).toBe("persist_failed");
    expect(result.report.results[0].detail).toBe(POST_LIVE_METRICS_OBSERVATION_LEASE_LOST_ERROR);
  });

  it("rejects an invalid heartbeat/ttl combination", async () => {
    const { deps } = createDeps();
    await expect(
      runLeaseProtectedPostLiveMetricsObservationPass({
        asOfDate: "2026-06-12",
        deps,
        ttlMs: 30_000,
        heartbeatMs: 30_000,
      })
    ).rejects.toThrow(/heartbeatMs must be less than ttlMs/);
  });
});
