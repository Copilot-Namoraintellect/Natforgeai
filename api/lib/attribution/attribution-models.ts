// ─── R7-B Attribution Intelligence — closed deterministic model set ───
//
// PURE module (no I/O, no clock reads beyond injected outcome time). Every
// model is a pure deterministic function over the chronologically ordered
// eligible touchpoint list, returning exact rational weights that
// attribution-credit turns into integer basis points. Weights are
// model-version constants — clients and runtime agents can never supply or
// override weights, and no LLM participates in credit allocation.

import {
  AttributionInputError,
  type AttributionModelType,
  type AttributionTouchpoint,
} from "./attribution-contract";
import { allocateCreditBps, type CreditCandidate } from "./attribution-credit";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Chronological ordering with the deterministic contract tie-break. */
export function orderTouchpoints(
  touchpoints: readonly AttributionTouchpoint[]
): AttributionTouchpoint[] {
  return [...touchpoints].sort((a, b) => {
    const aMs = Date.parse(a.occurredAt);
    const bMs = Date.parse(b.occurredAt);
    const aNorm = Number.isNaN(aMs) ? 0 : aMs;
    const bNorm = Number.isNaN(bMs) ? 0 : bMs;
    if (aNorm !== bNorm) return aNorm - bNorm;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    if (a.sourceIdentity !== b.sourceIdentity) return a.sourceIdentity < b.sourceIdentity ? -1 : 1;
    return 0;
  });
}

type WeightFn = (
  ordered: readonly AttributionTouchpoint[],
  windowEndMs: number
) => CreditCandidate[];

function firstTouchWeights(ordered: readonly AttributionTouchpoint[]): CreditCandidate[] {
  return ordered.map((touchpoint, i) => ({
    touchpoint,
    weightNumerator: i === 0 ? 1 : 0,
    weightDenominator: 1,
  }));
}

function lastTouchWeights(ordered: readonly AttributionTouchpoint[]): CreditCandidate[] {
  const last = ordered.length - 1;
  return ordered.map((touchpoint, i) => ({
    touchpoint,
    weightNumerator: i === last ? 1 : 0,
    weightDenominator: 1,
  }));
}

function linearWeights(ordered: readonly AttributionTouchpoint[]): CreditCandidate[] {
  const n = ordered.length;
  return ordered.map((touchpoint) => ({
    touchpoint,
    weightNumerator: 1,
    weightDenominator: n,
  }));
}

/**
 * POSITION_BASED (v1): 40% first + 40% last + 20% linear across intermediates.
 * Degenerate cases: 1 touch → 100%; 2 touches → 50/50 (no intermediates).
 */
function positionBasedWeights(ordered: readonly AttributionTouchpoint[]): CreditCandidate[] {
  const n = ordered.length;
  if (n === 1) return firstTouchWeights(ordered);
  if (n === 2) return linearWeights(ordered);
  const middleCount = n - 2;
  // Common denominator D = 100 * middleCount:
  //   first = 40*middleCount/D, last = 40*middleCount/D, each middle = 20/D.
  const denominator = 100 * middleCount;
  return ordered.map((touchpoint, i) => ({
    touchpoint,
    weightNumerator: i === 0 || i === n - 1 ? 40 * middleCount : 20,
    weightDenominator: denominator,
  }));
}

/**
 * TIME_DECAY (v1): half-life 7 days, discretized at whole-day granularity —
 * weight ∝ 2^-floor(ageDays/7), age measured from the outcome time. All
 * weights are exact dyadic rationals over the common denominator 2^maxBucket;
 * the discretization is a documented model-version assumption (deterministic,
 * monotone, reproducible, integer-exact).
 */
function timeDecayWeights(
  ordered: readonly AttributionTouchpoint[],
  windowEndMs: number
): CreditCandidate[] {
  const buckets = ordered.map((t) => {
    const occurredMs = Date.parse(t.occurredAt);
    const ageDays = Math.max(
      0,
      Math.floor((windowEndMs - (Number.isNaN(occurredMs) ? windowEndMs : occurredMs)) / DAY_MS)
    );
    return Math.floor(ageDays / 7);
  });
  const maxBucket = buckets.reduce((m, b) => Math.max(m, b), 0);
  const numerators = buckets.map((b) => 2 ** (maxBucket - b));
  const denominator = numerators.reduce((sum, n) => sum + n, 0); // Σ 2^-b = 1 exactly
  return ordered.map((touchpoint, i) => ({
    touchpoint,
    weightNumerator: numerators[i],
    weightDenominator: denominator,
  }));
}

const MODEL_WEIGHT_FNS: Record<AttributionModelType, WeightFn> = {
  FIRST_TOUCH: (ordered) => firstTouchWeights(ordered),
  LAST_TOUCH: (ordered) => lastTouchWeights(ordered),
  LINEAR: (ordered) => linearWeights(ordered),
  POSITION_BASED: (ordered) => positionBasedWeights(ordered),
  TIME_DECAY: (ordered, windowEndMs) => timeDecayWeights(ordered, windowEndMs),
};

/**
 * Run one closed model over the eligible set. Returns the touchpoints with
 * model-allocated integer credit (exactly normalised to TOTAL_CREDIT_BPS for
 * a non-empty set). The input touchpoints must already carry creditBps = 0
 * (credit is attached here, once, by the authority).
 */
export function applyAttributionModel(input: {
  modelType: AttributionModelType;
  touchpoints: readonly AttributionTouchpoint[];
  windowEndMs: number;
}): AttributionTouchpoint[] {
  const weightFn = MODEL_WEIGHT_FNS[input.modelType];
  if (!weightFn) {
    throw new AttributionInputError(
      "ATTRIBUTION_MODEL_UNKNOWN",
      `Unknown attribution model ${String(input.modelType)}.`
    );
  }
  const ordered = orderTouchpoints(input.touchpoints);
  if (ordered.length === 0) return [];
  const candidates = weightFn(ordered, input.windowEndMs);
  const allocated = allocateCreditBps(candidates);
  return ordered.map((t) => ({
    ...t,
    creditBps: allocated.get(t.touchpointId) ?? 0,
  }));
}
