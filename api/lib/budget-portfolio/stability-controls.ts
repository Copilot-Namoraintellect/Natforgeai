// ─── R7-E Budget & Portfolio Optimisation — anti-oscillation / stability (E5) ───
//
// PURE module: prevents optimisation thrashing. Applies cooldown, hysteresis
// (minimum evidence delta), and repeated-reversal detection to a solved
// reallocation. A triggered control does not partially dampen — it holds the
// WHOLE cycle to NO_CHANGE (conservative, deterministic, explainable): budget
// never moves back and forth on small noisy signals. History remains
// auditable via the persisted proposals + instruction ledger.
//
// No I/O, no clock (caller supplies `now`), no side effects.

import type { OptimisationReasonCode } from "./budget-portfolio-contract";
import type { AllocationSolveResult } from "./allocation-solver";

/** Frozen stability knobs (code-level; never client-supplied). */
export interface StabilityConstraints {
  /** Minimum interval between movements touching the same allocation key. */
  readonly cooldownMs: number;
  /** Hysteresis: a key must move at least this bps of its current allocation. */
  readonly minEvidenceDeltaBps: number;
  /** A reversal within this window of the prior move triggers the hold. */
  readonly reversalWindowMs: number;
}

export const DEFAULT_STABILITY_CONSTRAINTS: StabilityConstraints = Object.freeze({
  cooldownMs: 24 * 60 * 60 * 1000, // 24h — aligned with R7-F minReallocationIntervalMs
  minEvidenceDeltaBps: 100, // 1% of current — below this the move is noise
  reversalWindowMs: 7 * 24 * 60 * 60 * 1000, // 7d reversal memory
});

/** Stability memory derived from prior AUTHORIZED instructions (service-side). */
export interface StabilityState {
  /** Last movement time per allocation key (ISO 8601). */
  readonly lastReallocationAtByKey: Readonly<Record<string, string>>;
  /** Last authorized delta per allocation key (signed minor units). */
  readonly previousDeltaByKey: Readonly<Record<string, number>>;
}

export interface StabilityEvaluation {
  readonly held: boolean;
  readonly reasonCodes: readonly OptimisationReasonCode[];
}

/**
 * Evaluate stability controls against a solved reallocation. `currentByKey`
 * is the snapshot's current allocation. Returns held=true (with the single
 * triggering code) when the cycle must not proceed.
 */
export function evaluateStability(input: {
  solved: AllocationSolveResult;
  state: StabilityState;
  currentByKey: Readonly<Record<string, number>>;
  now: string;
  constraints?: StabilityConstraints;
}): StabilityEvaluation {
  const { solved, state, currentByKey, now } = input;
  const constraints = input.constraints ?? DEFAULT_STABILITY_CONSTRAINTS;
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    throw new Error(`evaluateStability: now must be a valid ISO timestamp, got ${String(now)}`);
  }
  if (!solved.changed) {
    return Object.freeze({ held: false, reasonCodes: Object.freeze([]) });
  }

  // ── Cooldown: a key that already moved within the interval must not move ──
  for (const [key, delta] of Object.entries(solved.deltaByKey)) {
    if (delta === 0) continue;
    const lastAt = state.lastReallocationAtByKey[key];
    if (lastAt !== undefined && nowMs - Date.parse(lastAt) < constraints.cooldownMs) {
      return Object.freeze({ held: true, reasonCodes: Object.freeze(["COOLDOWN_ACTIVE"] as const) });
    }
  }

  // ── Hysteresis: every moved key must clear the minimum evidence delta ──
  // (a move below the hysteresis band on EVERY touched key is noise)
  const moved = Object.entries(solved.deltaByKey).filter(([, d]) => d !== 0);
  if (moved.length > 0) {
    const allBelowHysteresis = moved.every(([key, delta]) => {
      const current = currentByKey[key] ?? 0;
      if (current <= 0) return false;
      // |delta| * 10000 < current * bps  ⇒ below band (integer cross-multiply)
      return Math.abs(delta) * 10_000 < current * constraints.minEvidenceDeltaBps;
    });
    if (allBelowHysteresis) {
      return Object.freeze({
        held: true,
        reasonCodes: Object.freeze(["CHANGE_BELOW_MINIMUM_THRESHOLD"] as const),
      });
    }
  }

  // ── Repeated reversal: sign flip of a recent move is thrash ──
  for (const [key, delta] of Object.entries(solved.deltaByKey)) {
    if (delta === 0) continue;
    const previous = state.previousDeltaByKey[key];
    if (previous === undefined || previous === 0) continue;
    const lastAt = state.lastReallocationAtByKey[key];
    const withinWindow =
      lastAt !== undefined && nowMs - Date.parse(lastAt) < constraints.reversalWindowMs;
    if (withinWindow && Math.sign(delta) === -Math.sign(previous)) {
      return Object.freeze({
        held: true,
        reasonCodes: Object.freeze(["REVERSAL_STABILITY_HOLD"] as const),
      });
    }
  }

  return Object.freeze({ held: false, reasonCodes: Object.freeze([]) });
}

/** Merge a stability hold into a solve result (whole-cycle NO_CHANGE). */
export function applyStabilityHold(
  solved: AllocationSolveResult,
  evaluation: StabilityEvaluation
): AllocationSolveResult {
  if (!evaluation.held) return solved;
  const zeroDelta: Record<string, number> = {};
  for (const key of Object.keys(solved.deltaByKey)) zeroDelta[key] = 0;
  const merged = [...solved.reasonCodes, ...evaluation.reasonCodes];
  return Object.freeze({
    algorithmVersion: solved.algorithmVersion,
    changed: false,
    proposedByKey: solved.proposedByKey,
    deltaByKey: Object.freeze(zeroDelta),
    reasonCodes: Object.freeze([...new Set(merged)].slice(0, 8) as OptimisationReasonCode[]),
  });
}
