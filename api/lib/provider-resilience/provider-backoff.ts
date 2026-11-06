// ─── R10-D Provider & Integration Resilience — bounded backoff (D10) ───
//
// PURE module. Computes a bounded exponential backoff schedule with
// deterministic hash jitter. CRITICAL AUTHORITY RULE: the backoff schedule
// itself is never permission to retry. A retry requires fresh, exact R9-F
// governance consumption (retry != new authority) and a new R9-D attempt;
// backoff only says WHEN a governed retry may next be attempted, and past
// maxAttempts it demands reauthorization instead.

import { canonicalJson, sha256Hex } from "../conversion/conversion-contract";

export interface BackoffInput {
  readonly requestId: string;
  readonly attemptNumber: number;
  readonly baseDelayMs: number;
  readonly multiplier: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
  readonly maxAttempts: number;
}

export interface BackoffSchedule {
  /** Delay before the next governed retry may be attempted. */
  readonly delayMs: number;
  /** False on every output — the schedule never authorizes a retry. */
  readonly authorizesRetry: false;
  readonly note: string;
  /** True once the schedule is exhausted; the safe response is reauthorization. */
  readonly reauthorizationRequired: boolean;
}

/**
 * Deterministic jitter in [-jitterRatio, +jitterRatio] derived from the
 * request identity + attempt number — reproducible in acceptance, never
 * wall-clock random.
 */
function deterministicJitterRatio(seed: string): number {
  const hex = sha256Hex(canonicalJson({ v: 1, seed })).slice(0, 8);
  const value = parseInt(hex, 16) / 0xffffffff; // [0,1]
  return value * 2 - 1; // [-1,1]
}

export function computeBackoffSchedule(input: BackoffInput): BackoffSchedule {
  if (input.attemptNumber >= input.maxAttempts) {
    return {
      delayMs: input.maxDelayMs,
      authorizesRetry: false,
      note:
        "backoff schedule exhausted — further attempts REQUIRE fresh governed reauthorization; " +
        "the schedule itself never authorizes a retry.",
      reauthorizationRequired: true,
    };
  }
  const exponential = Math.min(
    input.maxDelayMs,
    input.baseDelayMs *
      Math.pow(input.multiplier, Math.max(0, input.attemptNumber - 1))
  );
  const jitter = deterministicJitterRatio(
    `${input.requestId}:${input.attemptNumber}`
  );
  const jittered = Math.round(exponential * (1 + jitter * input.jitterRatio));
  const delayMs = Math.max(0, Math.min(input.maxDelayMs, jittered));
  return {
    delayMs,
    authorizesRetry: false,
    note:
      "advisory backoff only — a retry still requires fresh R9-F governance consumption " +
      "and a new R9-D attempt; backoff never widens scope.",
    reauthorizationRequired: false,
  };
}

export interface BackoffSpec {
  readonly baseDelayMs: number;
  readonly multiplier: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
  readonly maxAttempts: number;
}

export function backoffScheduleFromSpec(
  spec: BackoffSpec,
  requestId: string,
  attemptNumber: number
): BackoffSchedule {
  return computeBackoffSchedule({ requestId, attemptNumber, ...spec });
}
