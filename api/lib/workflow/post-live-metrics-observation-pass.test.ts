import { describe, it, expect } from "vitest";
import {
  createDefaultMetricsObservationBindings,
  isObservationBindingPlatform,
  isObservationDue,
  OBSERVATION_BINDING_PLATFORMS,
  runPostLiveMetricsObservationPass,
  type MetricsObservationBinding,
  type PostLiveMetricsObservationPassDeps,
  type PublishedObservationCandidate,
  type RawPostMetricSample,
} from "./post-live-metrics-observation-pass";

function candidate(overrides: Partial<PublishedObservationCandidate> = {}): PublishedObservationCandidate {
  return {
    queueItemId: 101,
    userId: 42,
    campaignId: 29,
    platform: "facebook",
    publishedAt: "2026-06-11T08:00:00.000Z",
    externalPostId: "ext-1",
    ...overrides,
  };
}

function binding(
  platform: string,
  fetch: (input: { externalPostId: string; publishedAt: string }) => Promise<RawPostMetricSample[]>
): MetricsObservationBinding {
  return { platform: platform as MetricsObservationBinding["platform"], fetchPostMetrics: fetch };
}

interface Harness {
  deps: PostLiveMetricsObservationPassDeps;
  persisted: unknown[];
  fetchCalls: unknown[];
}

function createHarness(options: {
  candidates?: PublishedObservationCandidate[];
  lastObservedAt?: Record<number, string | null>;
  bindings?: Record<string, MetricsObservationBinding>;
}) {
  const persisted: unknown[] = [];
  const fetchCalls: unknown[] = [];
  const candidates = options.candidates ?? [];
  const lastObservedAt = options.lastObservedAt ?? {};
  const defaultBindings = createDefaultMetricsObservationBindings();

  const deps: PostLiveMetricsObservationPassDeps = {
    listPublishedCandidates: async () => candidates,
    loadLastObservedAt: async (c) => lastObservedAt[c.queueItemId] ?? null,
    resolveBinding: platform => {
      const custom = options.bindings?.[platform];
      if (custom) return custom;
      return defaultBindings[platform as keyof typeof defaultBindings] ?? null;
    },
    persistObservations: async input => {
      persisted.push(input);
    },
  };
  void fetchCalls;

  return { deps, persisted, fetchCalls };
}

describe("metrics observation due policy", () => {
  it("is due when never observed or outside the due window", () => {
    expect(isObservationDue({ lastObservedAt: null, asOfDate: "2026-06-12" })).toBe(true);
    expect(
      isObservationDue({ lastObservedAt: "2026-06-12T00:00:00.000Z", asOfDate: "2026-06-12" })
    ).toBe(false);
    expect(
      isObservationDue({ lastObservedAt: "2026-06-11T00:00:00.000Z", asOfDate: "2026-06-12" })
    ).toBe(true);
    expect(
      isObservationDue({
        lastObservedAt: "2026-06-11T12:00:00.000Z",
        asOfDate: "2026-06-11",
        dueWindowMs: 60_000,
      })
    ).toBe(false);
  });
});

describe("observation binding registration set", () => {
  it("stays consistent with the surviving provider authority and excludes TikTok", () => {
    expect(OBSERVATION_BINDING_PLATFORMS).toEqual(["facebook", "instagram", "linkedin", "twitter"]);
    expect(isObservationBindingPlatform("tiktok")).toBe(false);
    expect(isObservationBindingPlatform("Facebook")).toBe(false);
    expect(isObservationBindingPlatform("facebook")).toBe(true);
  });
});

describe("runPostLiveMetricsObservationPass", () => {
  it("observes due candidates and persists only contract-valid metrics", async () => {
    const candidates = [candidate()];
    const { deps, persisted } = createHarness({
      candidates,
      bindings: {
        facebook: binding("facebook", async () => [
          { metricType: "impressions", value: 120 },
          { metricType: "bogus_metric", value: 5 },
          { metricType: "clicks", value: -3 },
        ]),
      },
    });

    const report = await runPostLiveMetricsObservationPass({ asOfDate: "2026-06-12", deps });

    expect(report).toMatchObject({ candidates: 1, due: 1, notDue: 0, observed: 1 });
    expect(report.results).toEqual([{ queueItemId: 101, status: "observed" }]);
    expect(persisted).toHaveLength(1);
    const written = persisted[0] as {
      candidate: PublishedObservationCandidate;
      observedAt: string;
      metrics: Array<{ metricType: string; value: number }>;
    };
    expect(written.candidate.queueItemId).toBe(101);
    // unknown metric types are skipped; negatives coerce to 0; the contract
    // orders observations deterministically by metricType.
    expect(written.metrics).toEqual([
      { metricType: "clicks", value: 0 },
      { metricType: "impressions", value: 120 },
    ]);
  });

  it("skips candidates observed inside the due window", async () => {
    const candidates = [candidate()];
    const { deps, persisted } = createHarness({
      candidates,
      lastObservedAt: { 101: "2026-06-12T00:00:00.000Z" },
      bindings: { facebook: binding("facebook", async () => [{ metricType: "impressions", value: 1 }]) },
    });

    const report = await runPostLiveMetricsObservationPass({ asOfDate: "2026-06-12", deps });

    expect(report).toMatchObject({ candidates: 1, due: 0, notDue: 1, observed: 0 });
    expect(report.results[0].status).toBe("not_due");
    expect(persisted).toHaveLength(0);
  });

  it("fails closed on unsupported platforms (TikTok) without fetching", async () => {
    const candidates = [candidate({ queueItemId: 102, platform: "tiktok" })];
    const { deps, persisted } = createHarness({ candidates });

    const report = await runPostLiveMetricsObservationPass({ asOfDate: "2026-06-12", deps });

    expect(report.observed).toBe(0);
    expect(report.results[0].status).toBe("unsupported_platform");
    expect(persisted).toHaveLength(0);
  });

  it("isolates per-candidate fetch failures", async () => {
    const candidates = [
      candidate({ queueItemId: 1, externalPostId: "ext-1" }),
      candidate({ queueItemId: 2, externalPostId: "ext-2" }),
    ];
    const { deps, persisted } = createHarness({
      candidates,
      bindings: {
        facebook: binding("facebook", async ({ externalPostId }) => {
          if (externalPostId === "ext-1") throw new Error("provider exploded");
          return [{ metricType: "reach", value: 55 }];
        }),
      },
    });

    const report = await runPostLiveMetricsObservationPass({ asOfDate: "2026-06-12", deps });

    expect(report.observed).toBe(1);
    expect(report.results.find(r => r.queueItemId === 1)?.status).toBe("fetch_failed");
    expect(report.results.find(r => r.queueItemId === 2)?.status).toBe("observed");
    expect(persisted).toHaveLength(1);
  });

  it("rejects a non ISO asOfDate", async () => {
    const { deps } = createHarness({});
    await expect(
      runPostLiveMetricsObservationPass({ asOfDate: "12/06/2026", deps })
    ).rejects.toThrow(/YYYY-MM-DD/);
  });
});
