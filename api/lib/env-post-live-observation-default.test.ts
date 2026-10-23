import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Post-live metrics observation is default-on platform autonomy (WBS-R4-D):
 * no developer command may be needed to initiate normal post-live
 * observation. Explicit opt-out stays available via
 * POST_LIVE_METRICS_OBSERVATION_ENABLED=false.
 */

describe("env post-live metrics observation default", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to enabled when the flag is unset", async () => {
    vi.stubEnv("POST_LIVE_METRICS_OBSERVATION_ENABLED", "");
    delete process.env.POST_LIVE_METRICS_OBSERVATION_ENABLED;

    const { env } = await import("./env");
    expect(env.postLiveMetricsObservationEnabled).toBe(true);
  });
  it("stays enabled when explicitly set to true", async () => {
    vi.stubEnv("POST_LIVE_METRICS_OBSERVATION_ENABLED", "true");

    const { env } = await import("./env");
    expect(env.postLiveMetricsObservationEnabled).toBe(true);
  });

  it("can be disabled explicitly with false", async () => {
    vi.stubEnv("POST_LIVE_METRICS_OBSERVATION_ENABLED", "false");

    const { env } = await import("./env");
    expect(env.postLiveMetricsObservationEnabled).toBe(false);
  });

  it("keeps the interval default at 300000ms", async () => {
    vi.stubEnv("POST_LIVE_METRICS_OBSERVATION_INTERVAL_MS", "");

    const { env } = await import("./env");
    expect(env.postLiveMetricsObservationIntervalMs).toBe(300_000);
  });
});
