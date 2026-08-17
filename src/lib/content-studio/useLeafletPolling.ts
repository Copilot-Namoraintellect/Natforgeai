import { useState, useEffect, useRef, useCallback } from "react";

export type LeafletPollingStatus =
  | "idle"
  | "generating"
  | "ready"
  | "not_generated"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface LeafletPollingOptions {
  /** Whether the component is mounted in a campaign context. */
  enabled: boolean;
  /** Resolved preview state. Polling only happens while this is "generating". */
  status: LeafletPollingStatus;
  /** Called on each poll tick. Should invalidate the queries that surface the leaflet record. */
  onPoll: () => void;
  /** Maximum number of polling attempts before the state is considered timed out. */
  maxAttempts: number;
  /** Polling interval in milliseconds. */
  intervalMs: number;
}

export interface LeafletPollingResult {
  /** Non-null when polling has exceeded its bounded limit. */
  timedOut: { attempts: number; elapsedMs: number } | null;
  /** Reset the timeout state and attempt counter. Safe to call while generating. */
  reset: () => void;
}

export interface LeafletPollingMachineOptions {
  maxAttempts: number;
  intervalMs: number;
  onPoll: () => void;
  onTimedOut: (info: { attempts: number; elapsedMs: number }) => void;
}

export interface LeafletPollingMachine {
  start: () => void;
  stop: () => void;
}

/**
 * Pure, testable timer machine for bounded leaflet polling.
 *
 * - Starts only when `start()` is called.
 * - Stops when `stop()` is called or when the attempt limit is exceeded.
 * - Calls `onPoll` every `intervalMs` until the limit is reached, then calls `onTimedOut` once.
 */
export function createLeafletPollingMachine(
  opts: LeafletPollingMachineOptions
): LeafletPollingMachine {
  let interval: ReturnType<typeof setInterval> | null = null;
  let attempts = 0;
  let startTime: number | null = null;

  return {
    start: () => {
      if (interval) return;
      attempts = 0;
      startTime = Date.now();
      interval = setInterval(() => {
        attempts += 1;
        if (attempts >= opts.maxAttempts) {
          opts.onTimedOut({ attempts, elapsedMs: startTime ? Date.now() - startTime : 0 });
          clearInterval(interval!);
          interval = null;
          return;
        }
        opts.onPoll();
      }, opts.intervalMs);
    },
    stop: () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}

/**
 * Bounded polling hook for leaflet generation.
 *
 * - Polls only while `status` is "generating".
 * - Stops immediately for ready, not_generated, failed, cancelled and timed_out.
 * - Clears the timer on unmount, status change, and `enabled` change.
 * - Never restarts automatically once timed out; the caller must call `reset()`.
 */
export function useLeafletPolling(options: LeafletPollingOptions): LeafletPollingResult {
  const { enabled, status, onPoll, maxAttempts, intervalMs } = options;
  const [timedOut, setTimedOut] = useState<{ attempts: number; elapsedMs: number } | null>(null);

  const onPollRef = useRef(onPoll);
  useEffect(() => {
    onPollRef.current = onPoll;
  }, [onPoll]);

  const machineRef = useRef<LeafletPollingMachine | null>(null);
  if (!machineRef.current) {
    machineRef.current = createLeafletPollingMachine({
      maxAttempts,
      intervalMs,
      onPoll: () => onPollRef.current(),
      onTimedOut: (info) => setTimedOut(info),
    });
  }

  useEffect(() => {
    if (!enabled || status !== "generating" || timedOut) {
      machineRef.current?.stop();
      return;
    }
    machineRef.current?.start();
    return () => machineRef.current?.stop();
  }, [enabled, status, timedOut]);

  const reset = useCallback(() => {
    setTimedOut(null);
    machineRef.current?.stop();
  }, []);

  return { timedOut, reset };
}
