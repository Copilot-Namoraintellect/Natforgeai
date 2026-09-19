import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  PostLiveLifecycleLeasedPassResult,
} from "./post-live-lifecycle-leased-pass";

import {
  isPostLiveLifecycleSchedulerStarted,
  startPostLiveLifecycleScheduler,
  stopPostLiveLifecycleScheduler,
  type PostLiveLifecycleSchedulerDeps,
} from "./post-live-lifecycle-scheduler";

type IntervalHandle =
  ReturnType<typeof setInterval>;

function completedResult():
PostLiveLifecycleLeasedPassResult {
  return {
    status: "lease_contended",
    ran: false,
    leaseKey:
      "natforge:test:post-live",
  };
}

function createHarness(input?: {
  runPass?: PostLiveLifecycleSchedulerDeps["runPass"];
}) {
  let callback:
    (() => void) | null =
    null;

  let intervalMs:
    number | null =
    null;

  let stopCount =
    0;

  const runPass =
    input?.runPass ??
    vi.fn(
      async () =>
        completedResult()
    );

  const log =
    vi.fn();

  const logError =
    vi.fn();

  const deps:
    PostLiveLifecycleSchedulerDeps = {
      runPass,

      now: () =>
        new Date(
          "2026-09-19T10:15:00.000Z"
        ),

      startInterval: (
        handler,
        milliseconds
      ) => {
        callback =
          handler;

        intervalMs =
          milliseconds;

        return 1 as unknown as
          IntervalHandle;
      },

      stopInterval: () => {
        stopCount++;
      },

      log,

      logError,
    };

  return {
    deps,
    runPass,
    log,
    logError,

    getIntervalMs: () =>
      intervalMs,

    getStopCount: () =>
      stopCount,

    tick: () => {
      if (!callback) {
        throw new Error(
          "No interval callback registered"
        );
      }

      callback();
    },
  };
}

afterEach(() => {
  stopPostLiveLifecycleScheduler();
});

describe(
  "post-live lifecycle scheduler",
  () => {
    it(
      "runs once immediately and registers the configured interval",
      async () => {
        const harness =
          createHarness();

        const result =
          startPostLiveLifecycleScheduler({
            intervalMs: 120_000,
            deps: harness.deps,
          });

        expect(result).toEqual({
          status: "started",
          intervalMs: 120_000,
        });

        expect(
          harness.getIntervalMs()
        ).toBe(120_000);

        expect(
          harness.runPass
        ).toHaveBeenCalledTimes(1);

        expect(
          harness.runPass
        ).toHaveBeenCalledWith({
          asOfDate: "2026-09-19",
        });

        expect(
          isPostLiveLifecycleSchedulerStarted()
        ).toBe(true);

        await Promise.resolve();

        expect(
          harness.logError
        ).not.toHaveBeenCalled();
      }
    );

    it(
      "does not create a second scheduler when start is called twice",
      () => {
        const harness =
          createHarness();

        const first =
          startPostLiveLifecycleScheduler({
            intervalMs: 300_000,
            deps: harness.deps,
          });

        const second =
          startPostLiveLifecycleScheduler({
            intervalMs: 60_000,
            deps: harness.deps,
          });

        expect(first.status).toBe(
          "started"
        );

        expect(second).toEqual({
          status:
            "already_started",
          intervalMs: 300_000,
        });

        expect(
          harness.runPass
        ).toHaveBeenCalledTimes(1);
      }
    );

    it(
      "skips a local overlapping tick while a pass is still running",
      async () => {
        let resolveFirst:
          | ((
              value:
                PostLiveLifecycleLeasedPassResult
            ) => void)
          | null =
          null;

        const firstPass =
          new Promise<
            PostLiveLifecycleLeasedPassResult
          >((resolve) => {
            resolveFirst =
              resolve;
          });

        const runPass =
          vi.fn()
            .mockReturnValueOnce(
              firstPass
            )
            .mockResolvedValue(
              completedResult()
            );

        const harness =
          createHarness({
            runPass,
          });

        startPostLiveLifecycleScheduler({
          intervalMs: 300_000,
          deps: harness.deps,
        });

        expect(runPass)
          .toHaveBeenCalledTimes(1);

        harness.tick();

        expect(runPass)
          .toHaveBeenCalledTimes(1);

        expect(
          harness.log
        ).toHaveBeenCalledWith(
          expect.stringContaining(
            "previous pass is still running"
          )
        );

        resolveFirst!(
          completedResult()
        );

        await Promise.resolve();
        await Promise.resolve();

        harness.tick();

        expect(runPass)
          .toHaveBeenCalledTimes(2);
      }
    );

    it(
      "stops the registered interval idempotently",
      () => {
        const harness =
          createHarness();

        startPostLiveLifecycleScheduler({
          deps: harness.deps,
        });

        expect(
          stopPostLiveLifecycleScheduler()
        ).toBe(true);

        expect(
          harness.getStopCount()
        ).toBe(1);

        expect(
          isPostLiveLifecycleSchedulerStarted()
        ).toBe(false);

        expect(
          stopPostLiveLifecycleScheduler()
        ).toBe(false);

        expect(
          harness.getStopCount()
        ).toBe(1);
      }
    );

    it(
      "rejects invalid scheduler intervals before creating a timer",
      () => {
        const harness =
          createHarness();

        expect(() =>
          startPostLiveLifecycleScheduler({
            intervalMs: 0,
            deps: harness.deps,
          })
        ).toThrow(
          "intervalMs must be a positive safe integer"
        );

        expect(
          harness.getIntervalMs()
        ).toBeNull();

        expect(
          isPostLiveLifecycleSchedulerStarted()
        ).toBe(false);
      }
    );
  }
);