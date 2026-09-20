import { describe, expect, it } from "vitest";

import {
  resolvePostLiveLifecycleSchedulerHealth,
} from "./post-live-lifecycle-health";

describe("post-live lifecycle scheduler health", () => {
  it("treats disabled-and-stopped as healthy", () => {
    expect(
      resolvePostLiveLifecycleSchedulerHealth({
        enabled: false,
        configuredIntervalMs: 300_000,
        runtime: {
          started: false,
          intervalMs: null,
          passInFlight: false,
        },
      })
    ).toEqual({
      status: "ok",
      latencyMs: 0,
      message:
        "Post-live lifecycle scheduler disabled by configuration",
    });
  });

  it("rejects a scheduler running while configuration is disabled", () => {
    expect(
      resolvePostLiveLifecycleSchedulerHealth({
        enabled: false,
        configuredIntervalMs: 300_000,
        runtime: {
          started: true,
          intervalMs: 300_000,
          passInFlight: false,
        },
      }).status
    ).toBe("error");
  });

  it("rejects enabled configuration when the scheduler is not started", () => {
    expect(
      resolvePostLiveLifecycleSchedulerHealth({
        enabled: true,
        configuredIntervalMs: 300_000,
        runtime: {
          started: false,
          intervalMs: null,
          passInFlight: false,
        },
      }).status
    ).toBe("error");
  });

  it("rejects runtime interval drift from configured cadence", () => {
    const result =
      resolvePostLiveLifecycleSchedulerHealth({
        enabled: true,
        configuredIntervalMs: 300_000,
        runtime: {
          started: true,
          intervalMs: 60_000,
          passInFlight: false,
        },
      });

    expect(result.status).toBe("error");
    expect(result.message).toContain(
      "configured=300000ms runtime=60000ms"
    );
  });

  it("reports an enabled matching runtime as healthy", () => {
    const idle =
      resolvePostLiveLifecycleSchedulerHealth({
        enabled: true,
        configuredIntervalMs: 300_000,
        runtime: {
          started: true,
          intervalMs: 300_000,
          passInFlight: false,
        },
      });

    const active =
      resolvePostLiveLifecycleSchedulerHealth({
        enabled: true,
        configuredIntervalMs: 300_000,
        runtime: {
          started: true,
          intervalMs: 300_000,
          passInFlight: true,
        },
      });

    expect(idle.status).toBe("ok");
    expect(idle.message).toContain("idle");
    expect(active.status).toBe("ok");
    expect(active.message).toContain(
      "reconciliation pass in flight"
    );
  });
});
