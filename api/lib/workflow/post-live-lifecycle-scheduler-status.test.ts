import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getPostLiveLifecycleSchedulerStatus,
  startPostLiveLifecycleScheduler,
  stopPostLiveLifecycleScheduler,
} from "./post-live-lifecycle-scheduler";

describe("post-live lifecycle scheduler status", () => {
  afterEach(() => {
    stopPostLiveLifecycleScheduler();
  });

  it("reports stopped state without starting runtime work", () => {
    expect(
      getPostLiveLifecycleSchedulerStatus()
    ).toEqual({
      started: false,
      intervalMs: null,
      passInFlight: false,
    });
  });

  it("reports the active process-local scheduler cadence", () => {
    const deps = {
      runPass: vi.fn(async () =>
        ({ status: "lease_contended" }) as any
      ),
      now: () =>
        new Date("2026-09-19T00:00:00.000Z"),
      startInterval: vi.fn(() =>
        1 as unknown as ReturnType<typeof setInterval>
      ),
      stopInterval: vi.fn(),
      log: vi.fn(),
      logError: vi.fn(),
    };

    startPostLiveLifecycleScheduler({
      intervalMs: 120_000,
      deps,
    });

    const status =
      getPostLiveLifecycleSchedulerStatus();

    expect(status.started).toBe(true);
    expect(status.intervalMs).toBe(120_000);
    expect(typeof status.passInFlight).toBe(
      "boolean"
    );

    expect(
      stopPostLiveLifecycleScheduler()
    ).toBe(true);

    expect(
      getPostLiveLifecycleSchedulerStatus()
    ).toEqual({
      started: false,
      intervalMs: null,
      passInFlight: false,
    });
  });
});
