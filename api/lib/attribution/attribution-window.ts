// ─── R7-B Attribution Intelligence — attribution windowing ───
//
// PURE module (no I/O, no clock reads). The window is derived deterministically
// from the authoritative outcome time and the deterministic policy. The window
// is never client-supplied: windowEnd = outcome occurredAt; windowStart =
// windowEnd - windowDays. All math is epoch-ms integer; results are ISO 8601
// strings in UTC.

import { AttributionInputError } from "./attribution-contract";
import { MAX_WINDOW_DAYS, MIN_WINDOW_DAYS, MIN_TOUCHPOINT_OCCURRED_YEAR } from "./attribution-policy";

export interface AttributionWindow {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}

export function parseTimestampMs(value: string): number | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  const year = Number(value.slice(0, 4));
  if (!Number.isInteger(year) || year < MIN_TOUCHPOINT_OCCURRED_YEAR) return null;
  return ms;
}

function toIsoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Derive the bounded attribution window for one outcome. The outcome
 * timestamp must be parseable and plausible (fail closed otherwise — a
 * malformed outcome time poisons every ordering decision downstream).
 */
export function deriveAttributionWindow(
  outcomeOccurredAt: string,
  windowDays: number,
  nowMs: number
): AttributionWindow {
  if (!Number.isInteger(windowDays) || windowDays < MIN_WINDOW_DAYS || windowDays > MAX_WINDOW_DAYS) {
    throw new AttributionInputError(
      "ATTRIBUTION_POLICY_INVALID",
      `Attribution windowDays must be an integer in [${MIN_WINDOW_DAYS}, ${MAX_WINDOW_DAYS}].`
    );
  }
  const outcomeMs = parseTimestampMs(outcomeOccurredAt);
  if (outcomeMs === null) {
    throw new AttributionInputError(
      "ATTRIBUTION_OUTCOME_TIMESTAMP_INVALID",
      `Outcome occurredAt is not a parseable, plausible ISO 8601 timestamp: ${JSON.stringify(outcomeOccurredAt)}.`
    );
  }
  if (nowMs - outcomeMs < -5 * 60 * 1000) {
    throw new AttributionInputError(
      "ATTRIBUTION_OUTCOME_TIMESTAMP_INVALID",
      "Outcome occurredAt is implausibly far in the future."
    );
  }
  const windowEndMs = outcomeMs;
  const windowStartMs = outcomeMs - windowDays * 24 * 60 * 60 * 1000;
  return {
    windowStart: toIsoUtc(windowStartMs),
    windowEnd: toIsoUtc(windowEndMs),
    windowStartMs,
    windowEndMs,
  };
}

/** Inclusive window membership on authoritative epoch-ms time. */
export function isWithinWindow(occurredMs: number, window: AttributionWindow): boolean {
  return occurredMs >= window.windowStartMs && occurredMs <= window.windowEndMs;
}
