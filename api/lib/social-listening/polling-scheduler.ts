/**
 * Listening polling scheduler (WBS-R5-A A5).
 *
 * Process-local singleton interval wrapper around the polling pass. Mirrors
 * the R4 scheduler contract: at most one active scheduler per process,
 * overlapping passes are skipped, a failing pass never propagates into the
 * interval, first pass runs immediately at start.
 *
 * Startup wiring lives in api/boot.ts and is DEFAULT OFF
 * (SOCIAL_LISTENING_POLLING_ENABLED=true enables it); without operator-
 * configured provider fetch seams each pass fails closed with
 * OPERATOR_ACTION rather than faking success.
 */

import { runListeningPollingPass, type PollingPassSummary } from "./polling";

export const LISTENING_POLLING_DEFAULT_INTERVAL_MS = 300_000;

type IntervalHandle = ReturnType<typeof setInterval>;

export interface ListeningPollingSchedulerDeps {
  runPass(): Promise<PollingPassSummary>;
  startInterval(callback: () => void, intervalMs: number): IntervalHandle;
  stopInterval(handle: IntervalHandle): void;
  log(message: string): void;
  logError(message: string, error?: unknown): void;
}

export interface ListeningPollingSchedulerStartResult {
  status: "started" | "already_started";
  intervalMs: number;
}

export interface ListeningPollingSchedulerStatus {
  started: boolean;
  intervalMs: number | null;
  lastPassAt: string | null;
  lastPassSummary: PollingPassSummary | null;
  passInFlight: boolean;
}

let activeScheduler: {
  intervalMs: number;
  intervalHandle: IntervalHandle;
  deps: ListeningPollingSchedulerDeps;
  passInFlight: boolean;
  lastPassAt: string | null;
  lastPassSummary: PollingPassSummary | null;
} | null = null;

function assertValidInterval(intervalMs: number): void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("intervalMs must be a positive safe integer");
  }
}

function createDefaultDeps(): ListeningPollingSchedulerDeps {
  return {
    runPass: () => runListeningPollingPass(),
    startInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    stopInterval: (handle) => clearInterval(handle),
    log: (message) => console.log(message),
    logError: (message, error) => console.error(message, error),
  };
}

async function runScheduledPass(
  state: NonNullable<typeof activeScheduler>
): Promise<void> {
  if (state.passInFlight) {
    state.deps.log("[ListeningPolling] Skipping pass: previous pass still in flight.");
    return;
  }
  state.passInFlight = true;
  try {
    const summary = await state.deps.runPass();
    state.lastPassAt = new Date().toISOString();
    state.lastPassSummary = summary;
  } catch (error) {
    state.deps.logError("[ListeningPolling] Scheduled pass failed:", error);
  } finally {
    state.passInFlight = false;
  }
}

export function startListeningPollingScheduler(input: {
  intervalMs?: number;
  deps?: ListeningPollingSchedulerDeps;
}): ListeningPollingSchedulerStartResult {
  if (activeScheduler) {
    return { status: "already_started", intervalMs: activeScheduler.intervalMs };
  }
  const intervalMs = input.intervalMs ?? LISTENING_POLLING_DEFAULT_INTERVAL_MS;
  assertValidInterval(intervalMs);
  const deps = input.deps ?? createDefaultDeps();
  const state = {
    intervalMs,
    intervalHandle: undefined as unknown as IntervalHandle,
    deps,
    passInFlight: false,
    lastPassAt: null as string | null,
    lastPassSummary: null as PollingPassSummary | null,
  };
  state.intervalHandle = deps.startInterval(() => {
    void runScheduledPass(state);
  }, intervalMs);
  activeScheduler = state;
  deps.log(`[ListeningPolling] Scheduler started (intervalMs=${intervalMs}). Running first pass.`);
  void runScheduledPass(state);
  return { status: "started", intervalMs };
}

export function stopListeningPollingScheduler(): void {
  if (!activeScheduler) return;
  activeScheduler.deps.stopInterval(activeScheduler.intervalHandle);
  activeScheduler = null;
}

export function getListeningPollingSchedulerStatus(): ListeningPollingSchedulerStatus {
  return {
    started: activeScheduler !== null,
    intervalMs: activeScheduler?.intervalMs ?? null,
    lastPassAt: activeScheduler?.lastPassAt ?? null,
    lastPassSummary: activeScheduler?.lastPassSummary ?? null,
    passInFlight: activeScheduler?.passInFlight ?? false,
  };
}
