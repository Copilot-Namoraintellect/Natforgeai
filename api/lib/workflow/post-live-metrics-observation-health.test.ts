import { describe, expect, it } from "vitest";
import { resolvePostLiveMetricsObservationSchedulerHealth } from "./post-live-metrics-observation-health";

describe("resolvePostLiveMetricsObservationSchedulerHealth", () => {
  it("reports healthy steady state when the default-on scheduler is running at the configured cadence", () => {
    const health = resolvePostLiveMetricsObservationSchedulerHealth({
      enabled: true,
      configuredIntervalMs: 300_000,
      runtime: { started: true, intervalMs: 300_000, passInFlight: false },
    });

    expect(health.status).toBe("ok");
    expect(health.message).toContain("running at 300000ms");
    expect(health.message).toContain("idle");
  });

  it("reports an error when the enabled scheduler is not started", () => {
    const health = resolvePostLiveMetricsObservationSchedulerHealth({
      enabled: true,
      configuredIntervalMs: 300_000,
      runtime: { started: false, intervalMs: null, passInFlight: false },
    });

    expect(health.status).toBe("error");
    expect(health.message).toContain("enabled but not started");
  });

  it("reports an error when the scheduler runs while explicitly disabled", () => {
    const health = resolvePostLiveMetricsObservationSchedulerHealth({
      enabled: false,
      configuredIntervalMs: 300_000,
      runtime: { started: true, intervalMs: 300_000, passInFlight: false },
    });

    expect(health.status).toBe("error");
    expect(health.message).toContain("running while disabled");
  });

  it("reports healthy when explicitly disabled and stopped", () => {
    const health = resolvePostLiveMetricsObservationSchedulerHealth({
      enabled: false,
      configuredIntervalMs: 300_000,
      runtime: { started: false, intervalMs: null, passInFlight: false },
    });

    expect(health.status).toBe("ok");
    expect(health.message).toContain("disabled by configuration");
  });

  it("reports an error on a configured vs runtime interval mismatch", () => {
    const health = resolvePostLiveMetricsObservationSchedulerHealth({
      enabled: true,
      configuredIntervalMs: 300_000,
      runtime: { started: true, intervalMs: 60_000, passInFlight: false },
    });

    expect(health.status).toBe("error");
    expect(health.message).toContain("interval mismatch");
  });

  it("notes an in-flight pass in the healthy message", () => {
    const health = resolvePostLiveMetricsObservationSchedulerHealth({
      enabled: true,
      configuredIntervalMs: 300_000,
      runtime: { started: true, intervalMs: 300_000, passInFlight: true },
    });

    expect(health.status).toBe("ok");
    expect(health.message).toContain("pass in flight");
  });
});
