// ─── R6-D Nurture / Sales Handoff — cadence governance (contract §7) ───
//
// PURE module: deterministic, policy-controlled frequency bounds over the
// append-only durable touch history. No uncontrolled loop, no model-selected
// cadence, no in-memory state: eligibility is a pure function of
// (policy, touches, now). Over-cadence ⇒ WAIT (NURTURE_CADENCE_LIMITED),
// never a silent send. No I/O, no clock injection, no database access.

import type { NurtureHandoffPolicy } from "./nurture-policy";

export interface NurtureTouchRecord {
  /** ISO timestamp of the durable touch. */
  touchedAt: string;
}

export interface CadenceVerdict {
  allowed: boolean;
  /** Touches in the current rolling window. */
  touchesInWindow: number;
  /** ISO timestamp of the most recent touch on this channel, if any. */
  lastTouchAt: string | null;
  /** When the next touch becomes eligible (interval gate), if interval-blocked. */
  nextEligibleAt: string | null;
  /** When the rolling window next admits a touch, if cap-blocked. */
  windowNextEligibleAt: string | null;
}

export function checkNurtureCadence(input: {
  policy: NurtureHandoffPolicy;
  touches: readonly NurtureTouchRecord[];
  now: Date;
}): CadenceVerdict {
  const { policy, touches, now } = input;
  const cadence = policy.config.nurtureCadence;
  const nowMs = now.getTime();

  const parsed = touches
    .map((t) => ({ at: Date.parse(t.touchedAt) }))
    .filter((t) => !Number.isNaN(t.at))
    .sort((a, b) => a.at - b.at);

  const lastTouch = parsed.length > 0 ? parsed[parsed.length - 1] : null;
  const windowStartMs = nowMs - cadence.windowDays * 86_400_000;
  const inWindow = parsed.filter((t) => t.at >= windowStartMs && t.at <= nowMs);
  const lastTouchAt = lastTouch ? new Date(lastTouch.at).toISOString() : null;

  // Interval gate: minimum hours between touches on one channel.
  if (lastTouch && cadence.minIntervalHours > 0) {
    const intervalMs = cadence.minIntervalHours * 3_600_000;
    if (nowMs - lastTouch.at < intervalMs) {
      return {
        allowed: false,
        touchesInWindow: inWindow.length,
        lastTouchAt,
        nextEligibleAt: new Date(lastTouch.at + intervalMs).toISOString(),
        windowNextEligibleAt: null,
      };
    }
  }

  // Rolling-window cap: bounded contact frequency, policy-controlled only.
  if (inWindow.length >= cadence.maxTouchesPerWindow) {
    const oldestInWindow = inWindow[0];
    return {
      allowed: false,
      touchesInWindow: inWindow.length,
      lastTouchAt,
      nextEligibleAt: null,
      windowNextEligibleAt: new Date(oldestInWindow.at + cadence.windowDays * 86_400_000).toISOString(),
    };
  }

  return {
    allowed: true,
    touchesInWindow: inWindow.length,
    lastTouchAt,
    nextEligibleAt: null,
    windowNextEligibleAt: null,
  };
}

/**
 * Next deterministic touch sequence number: derived from durable rows only.
 * touchSeq = existing touch count + 1 for this lead/channel.
 */
export function nextTouchSeq(existingTouchCount: number): number {
  return existingTouchCount + 1;
}
