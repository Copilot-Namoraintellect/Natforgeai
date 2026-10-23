/**
 * Post-live metrics observation scheduler (WBS-R1.5).
 *
 * Process-local singleton interval wrapper around the lease-protected
 * observation pass. The scheduler itself owns no provider, database or lease
 * logic — every boundary lives in the pass modules and is injected through
 * deps for tests.
 *
 * Safety properties:
 * - at most one active scheduler per process (module singleton);
 * - overlapping passes are skipped (a pass already in flight never stacks);
 * - a failing pass is logged and never propagates into the interval;
 * - the interval must be a positive safe integer;
 * - the first pass runs immediately at start.
 *
 * Startup wiring lives in api/boot.ts. Post-live metrics observation is part
 * of normal platform autonomy: the scheduler starts by default
 * (POST_LIVE_METRICS_OBSERVATION_ENABLED=false disables it explicitly).
 */

import {
  runLeaseProtectedPostLiveMetricsObservationPass,
  type PostLiveMetricsObservationLeasedPassResult,
} from "./post-live-metrics-observation-leased-pass";

export const POST_LIVE_METRICS_OBSERVATION_DEFAULT_INTERVAL_MS = 300_000;

type IntervalHandle = ReturnType<typeof setInterval>;

export interface PostLiveMetricsObservationSchedulerDeps {
  runPass(input: {
    asOfDate: string;
  }): Promise<PostLiveMetricsObservationLeasedPassResult>;
  now(): Date;
  startInterval(callback: () => void, intervalMs: number): IntervalHandle;
  stopInterval(handle: IntervalHandle): void;
  log(message: string): void;
  logError(message: string, error?: unknown): void;
}

export interface PostLiveMetricsObservationSchedulerStartResult {
  status: "started" | "already_started";
  intervalMs: number;
}

export interface PostLiveMetricsObservationSchedulerStatus {
  started: boolean;
  intervalMs: number | null;
  lastPassAt: string | null;
  lastPassStatus: string | null;
  passInFlight: boolean;
}

let activeScheduler: {
  intervalMs: number;
  intervalHandle: IntervalHandle;
  deps: PostLiveMetricsObservationSchedulerDeps;
  passInFlight: boolean;
  lastPassAt: string | null;
  lastPassStatus: string | null;
} | null = null;

function assertValidInterval(intervalMs: number): void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("intervalMs must be a positive safe integer");
  }
}

function createDefaultDeps(): PostLiveMetricsObservationSchedulerDeps {
  return {
    runPass: input => runLeaseProtectedPostLiveMetricsObservationPass(input),
    now: () => new Date(),
    startInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    stopInterval: handle => clearInterval(handle),
    log: message => console.log(message),
    logError: (message, error) => console.error(message, error),
  };
}

async function runScheduledPass(
  state: NonNullable<typeof activeScheduler>
): Promise<void> {
  if (state.passInFlight) {
    state.deps.log(
      "[MetricsObservation] Skipping scheduled pass: previous pass still in flight."
    );
    return;
  }

  state.passInFlight = true;
  const asOfDate = state.deps.now().toISOString().slice(0, 10);
  try {
    const result = await state.deps.runPass({ asOfDate });
    state.lastPassAt = new Date().toISOString();
    state.lastPassStatus = result.status;
  } catch (error) {
    state.deps.logError(
      `[MetricsObservation] Scheduled pass failed for ${asOfDate}:`,
      error
    );
  } finally {
    state.passInFlight = false;
  }
}

/**
 * Starts the singleton observation scheduler. A second start is a no-op
 * reporting already_started. The first pass runs immediately.
 */
export function startPostLiveMetricsObservationScheduler(input: {
  intervalMs?: number;
  deps?: PostLiveMetricsObservationSchedulerDeps;
}): PostLiveMetricsObservationSchedulerStartResult {
  if (activeScheduler) {
    return { status: "already_started", intervalMs: activeScheduler.intervalMs };
  }

  const intervalMs = input.intervalMs ?? POST_LIVE_METRICS_OBSERVATION_DEFAULT_INTERVAL_MS;
  assertValidInterval(intervalMs);

  const deps = input.deps ?? createDefaultDeps();
  const state = {
    intervalMs,
    intervalHandle: undefined as unknown as IntervalHandle,
    deps,
    passInFlight: false,
    lastPassAt: null as string | null,
    lastPassStatus: null as string | null,
  };

  state.intervalHandle = deps.startInterval(() => {
    void runScheduledPass(state);
  }, intervalMs);

  activeScheduler = state;
  deps.log(
    `[MetricsObservation] Scheduler started (intervalMs=${intervalMs}). Running first pass.`
  );
  void runScheduledPass(state);

  return { status: "started", intervalMs };
}

/** Stops the active scheduler, if any. */
export function stopPostLiveMetricsObservationScheduler(): void {
  if (!activeScheduler) return;
  activeScheduler.deps.stopInterval(activeScheduler.intervalHandle);
  activeScheduler = null;
}

export function getPostLiveMetricsObservationSchedulerStatus(): PostLiveMetricsObservationSchedulerStatus {
  return {
    started: activeScheduler !== null,
    intervalMs: activeScheduler?.intervalMs ?? null,
    lastPassAt: activeScheduler?.lastPassAt ?? null,
    lastPassStatus: activeScheduler?.lastPassStatus ?? null,
    passInFlight: activeScheduler?.passInFlight ?? false,
  };
}

export function isPostLiveMetricsObservationSchedulerStarted(): boolean {
  return activeScheduler !== null;
}
