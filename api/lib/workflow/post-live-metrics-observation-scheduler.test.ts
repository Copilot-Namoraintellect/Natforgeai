import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPostLiveMetricsObservationSchedulerStatus,
  isPostLiveMetricsObservationSchedulerStarted,
  POST_LIVE_METRICS_OBSERVATION_DEFAULT_INTERVAL_MS,
  startPostLiveMetricsObservationScheduler,
  stopPostLiveMetricsObservationScheduler,
  type PostLiveMetricsObservationSchedulerDeps,
} from "./post-live-metrics-observation-scheduler";

function createDeps(overrides: Partial<PostLiveMetricsObservationSchedulerDeps> = {}) {
  const callbacks: Array<{ callback: () => void; intervalMs: number }> = [];
  const logs: string[] = [];
  const errors: unknown[] = [];
  let runPassImpl: PostLiveMetricsObservationSchedulerDeps["runPass"] = async () => ({
    status: "completed",
    ran: true,
    leaseKey: "k",
    report: {
      asOfDate: "2026-06-12",
      candidates: 0,
      due: 0,
      notDue: 0,
      observed: 0,
      results: [],
    },
    releaseSucceeded: true,
  });

  const deps: PostLiveMetricsObservationSchedulerDeps = {
    runPass: (...args) => runPassImpl(...args),
    now: () => new Date("2026-06-12T10:00:00.000Z"),
    startInterval: (callback, intervalMs) => {
      callbacks.push({ callback, intervalMs });
      return callbacks.length as unknown as ReturnType<typeof setInterval>;
    },
    stopInterval: vi.fn(),
    log: message => logs.push(message),
    logError: (_message, error) => errors.push(error),
    ...overrides,
  };

  return {
    deps,
    callbacks,
    logs,
    errors,
    setRunPass(impl: PostLiveMetricsObservationSchedulerDeps["runPass"]) {
      runPassImpl = impl;
    },
  };
}

describe("post-live metrics observation scheduler (WBS-R1.5)", () => {
  beforeEach(() => {
    stopPostLiveMetricsObservationScheduler();
  });

  afterEach(() => {
    stopPostLiveMetricsObservationScheduler();
  });

  it("defaults to a 300s interval and a default-off flag convention", () => {
    expect(POST_LIVE_METRICS_OBSERVATION_DEFAULT_INTERVAL_MS).toBe(300_000);
  });

  it("starts once, registers the interval and runs the first pass immediately", async () => {
    const { deps, callbacks } = createDeps();
    const runCalls: string[] = [];
    deps.runPass = async ({ asOfDate }) => {
      runCalls.push(asOfDate);
      return { status: "lease_contended", ran: false, leaseKey: "k" };
    };

    const first = startPostLiveMetricsObservationScheduler({ intervalMs: 1000, deps });
    expect(first).toEqual({ status: "started", intervalMs: 1000 });
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0].intervalMs).toBe(1000);
    // Allow the immediate first pass to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(runCalls).toEqual(["2026-06-12"]);

    const second = startPostLiveMetricsObservationScheduler({ intervalMs: 500, deps });
    expect(second).toEqual({ status: "already_started", intervalMs: 1000 });
    expect(isPostLiveMetricsObservationSchedulerStarted()).toBe(true);
  });

  it("rejects a non-positive interval", () => {
    const { deps } = createDeps();
    expect(() => startPostLiveMetricsObservationScheduler({ intervalMs: 0, deps })).toThrow(
      /positive safe integer/
    );
  });

  it("skips overlapping passes while one is in flight", async () => {
    const { deps, callbacks } = createDeps();
    let resolvePass: (() => void) | null = null;
    let running = 0;
    let completed = 0;
    deps.runPass = () => {
      running += 1;
      return new Promise(resolve => {
        resolvePass = () => {
          completed += 1;
          resolve({ status: "lease_contended", ran: false, leaseKey: "k" });
        };
      });
    };

    startPostLiveMetricsObservationScheduler({ intervalMs: 1000, deps });
    await Promise.resolve();
    await Promise.resolve();
    expect(running).toBe(1);

    // A scheduled tick fires while the first pass is still in flight.
    callbacks[0].callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(running).toBe(1);

    resolvePass!();
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(1);
    expect(getPostLiveMetricsObservationSchedulerStatus().lastPassStatus).toBe("lease_contended");
  });

  it("contains pass errors and keeps the interval alive", async () => {
    const { deps, callbacks, errors } = createDeps();
    let calls = 0;
    deps.runPass = async () => {
      calls += 1;
      if (calls === 1) throw new Error("pass exploded");
      return { status: "lease_contended", ran: false, leaseKey: "k" };
    };

    startPostLiveMetricsObservationScheduler({ intervalMs: 1000, deps });
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);

    callbacks[0].callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(isPostLiveMetricsObservationSchedulerStarted()).toBe(true);
  });

  it("stops and reports status", () => {
    const { deps } = createDeps();
    startPostLiveMetricsObservationScheduler({ intervalMs: 1000, deps });
    expect(getPostLiveMetricsObservationSchedulerStatus().started).toBe(true);
    stopPostLiveMetricsObservationScheduler();
    expect(getPostLiveMetricsObservationSchedulerStatus()).toEqual({
      started: false,
      intervalMs: null,
      lastPassAt: null,
      lastPassStatus: null,
      passInFlight: false,
    });
  });
});
