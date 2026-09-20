import {
  runLeaseProtectedPostLiveLifecyclePass,
  type PostLiveLifecycleLeasedPassResult,
} from "./post-live-lifecycle-leased-pass";

export const POST_LIVE_LIFECYCLE_DEFAULT_INTERVAL_MS =
  300_000;

type IntervalHandle =
  ReturnType<typeof setInterval>;

export interface PostLiveLifecycleSchedulerDeps {
  runPass(input: {
    asOfDate: string;
  }): Promise<PostLiveLifecycleLeasedPassResult>;

  now(): Date;

  startInterval(
    callback: () => void,
    intervalMs: number
  ): IntervalHandle;

  stopInterval(
    handle: IntervalHandle
  ): void;

  log(message: string): void;

  logError(
    message: string,
    error?: unknown
  ): void;
}

interface PostLiveLifecycleSchedulerRuntimeState {
  intervalMs: number;
  deps: PostLiveLifecycleSchedulerDeps;
  passInFlight: boolean;
}

interface ActivePostLiveLifecycleScheduler {
  state: PostLiveLifecycleSchedulerRuntimeState;
  handle: IntervalHandle;
}

export type PostLiveLifecycleSchedulerStartResult =
  | {
      status: "started";
      intervalMs: number;
    }
  | {
      status: "already_started";
      intervalMs: number;
    };

let activeScheduler:
  ActivePostLiveLifecycleScheduler | null =
  null;

function assertIntervalMs(
  intervalMs: number
): void {
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs <= 0
  ) {
    throw new Error(
      "Post-live lifecycle scheduler intervalMs must be a positive safe integer"
    );
  }
}

function toAsOfDate(
  value: Date
): string {
  return value
    .toISOString()
    .slice(0, 10);
}

function createDefaultDeps():
PostLiveLifecycleSchedulerDeps {
  return {
    runPass: (input) =>
      runLeaseProtectedPostLiveLifecyclePass(
        input
      ),

    now: () =>
      new Date(),

    startInterval: (
      callback,
      intervalMs
    ) =>
      setInterval(
        callback,
        intervalMs
      ),

    stopInterval: (handle) =>
      clearInterval(handle),

    log: (message) =>
      console.log(message),

    logError: (
      message,
      error
    ) =>
      console.error(
        message,
        error
      ),
  };
}

async function runScheduledPass(
  state:
    PostLiveLifecycleSchedulerRuntimeState
): Promise<void> {
  if (state.passInFlight) {
    state.deps.log(
      "[PostLiveLifecycle] Scheduled pass skipped because the previous pass is still running"
    );

    return;
  }

  state.passInFlight = true;

  try {
    const asOfDate =
      toAsOfDate(
        state.deps.now()
      );

    const result =
      await state.deps.runPass({
        asOfDate,
      });

    state.deps.log(
      `[PostLiveLifecycle] Reconciliation pass finished | asOfDate=${asOfDate} | status=${result.status}`
    );
  } catch (error) {
    state.deps.logError(
      "[PostLiveLifecycle] Reconciliation pass failed",
      error
    );
  } finally {
    state.passInFlight = false;
  }
}

/**
 * Starts the process-local post-live lifecycle scheduler.
 *
 * Safety properties:
 * - startup remains explicit and caller-config-gated;
 * - one scheduler interval exists per process;
 * - one pass runs immediately after explicit startup;
 * - later passes run at the configured interval;
 * - overlapping process-local passes are skipped;
 * - cross-process exclusion remains owned by the existing Redis lease;
 * - pass failures are contained;
 * - this module installs no process signal handlers.
 */
export function startPostLiveLifecycleScheduler(
  input: {
    intervalMs?: number;
    deps?: PostLiveLifecycleSchedulerDeps;
  } = {}
): PostLiveLifecycleSchedulerStartResult {
  const intervalMs =
    input.intervalMs ??
    POST_LIVE_LIFECYCLE_DEFAULT_INTERVAL_MS;

  assertIntervalMs(
    intervalMs
  );

  if (activeScheduler) {
    return {
      status: "already_started",
      intervalMs:
        activeScheduler.state.intervalMs,
    };
  }

  const deps =
    input.deps ??
    createDefaultDeps();

  const state:
    PostLiveLifecycleSchedulerRuntimeState = {
      intervalMs,
      deps,
      passInFlight: false,
    };

  const handle =
    deps.startInterval(
      () => {
        void runScheduledPass(
          state
        );
      },
      intervalMs
    );

  activeScheduler = {
    state,
    handle,
  };

  deps.log(
    `[PostLiveLifecycle] Scheduler started | intervalMs=${intervalMs}`
  );

  void runScheduledPass(
    state
  );

  return {
    status: "started",
    intervalMs,
  };
}

/**
 * Stops future scheduled invocations.
 *
 * An already-running reconciliation pass is not cancelled.
 * Its distributed lease remains owned by the leased-pass layer.
 */
export function stopPostLiveLifecycleScheduler():
boolean {
  if (!activeScheduler) {
    return false;
  }

  const scheduler =
    activeScheduler;

  activeScheduler =
    null;

  scheduler.state.deps.stopInterval(
    scheduler.handle
  );

  scheduler.state.deps.log(
    "[PostLiveLifecycle] Scheduler stopped"
  );

  return true;
}

export interface PostLiveLifecycleSchedulerStatus {
  started: boolean;
  intervalMs: number | null;
  passInFlight: boolean;
}

/**
 * Returns a read-only process-local scheduler snapshot for health and
 * operational observation. Reading status never starts or stops the scheduler.
 */
export function getPostLiveLifecycleSchedulerStatus():
PostLiveLifecycleSchedulerStatus {
  if (!activeScheduler) {
    return {
      started: false,
      intervalMs: null,
      passInFlight: false,
    };
  }

  return {
    started: true,
    intervalMs: activeScheduler.state.intervalMs,
    passInFlight: activeScheduler.state.passInFlight,
  };
}

export function isPostLiveLifecycleSchedulerStarted():
boolean {
  return activeScheduler !== null;
}