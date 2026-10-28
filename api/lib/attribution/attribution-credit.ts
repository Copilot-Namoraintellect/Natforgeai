// ─── R7-B Attribution Intelligence — deterministic credit allocation ───
//
// PURE module (no I/O, no clock). Credit is integer basis points and total
// credit is normalised EXACTLY to TOTAL_CREDIT_BPS (100000 = 100.000%) for
// every non-empty eligible set. No floating-point credit anywhere: models
// express weights as rational integer numerators over a common denominator
// and the largest-remainder method distributes the remainder deterministically.
// Rounding is fully deterministic and replay-stable: ties break on
// (occurredAt asc, type asc, sourceIdentity asc).

import { TOTAL_CREDIT_BPS, type AttributionTouchpoint } from "./attribution-contract";

/**
 * One candidate for remainder distribution. `weightNumerator`/`weightDenominator`
 * is an exact rational weight; `tiebreak` is the deterministic ordering key.
 */
export interface CreditCandidate {
  readonly touchpoint: AttributionTouchpoint;
  readonly weightNumerator: number;
  readonly weightDenominator: number;
}

function tiebreakKey(t: AttributionTouchpoint): [number, string, string] {
  const ms = Date.parse(t.occurredAt);
  return [Number.isNaN(ms) ? 0 : ms, t.type, t.sourceIdentity];
}

function compareTiebreak(a: AttributionTouchpoint, b: AttributionTouchpoint): number {
  const [aMs, aType, aSrc] = tiebreakKey(a);
  const [bMs, bType, bSrc] = tiebreakKey(b);
  if (aMs !== bMs) return aMs - bMs;
  if (aType !== bType) return aType < bType ? -1 : 1;
  if (aSrc !== bSrc) return aSrc < bSrc ? -1 : 1;
  return 0;
}

/**
 * Allocate integer basis points over a non-empty candidate set with exact
 * normalisation. Returns a map from touchpointId to creditBps whose values
 * sum to exactly TOTAL_CREDIT_BPS.
 *
 * Method: floor(exact rational share) for each candidate; distribute the
 * remaining bps one at a time to the largest fractional remainders, ties
 * broken by the deterministic ordering key. Integer arithmetic only.
 */
export function allocateCreditBps(candidates: readonly CreditCandidate[]): Map<string, number> {
  const total = TOTAL_CREDIT_BPS;
  if (candidates.length === 0) return new Map();

  // Exact rational shares: credit_i = TOTAL * num_i / den_i. Floor via integer
  // division; remainder_i = (TOTAL * num_i) % den_i (exact, no floats).
  const floors: number[] = [];
  const remainders: number[] = [];
  let assigned = 0;
  for (const c of candidates) {
    if (
      !Number.isInteger(c.weightNumerator) ||
      !Number.isInteger(c.weightDenominator) ||
      c.weightNumerator < 0 ||
      c.weightDenominator <= 0
    ) {
      throw new Error("ATTRIBUTION_CREDIT_WEIGHT_INVALID: model weights must be non-negative integers.");
    }
    const scaled = total * c.weightNumerator;
    const floor = Math.floor(scaled / c.weightDenominator);
    floors.push(floor);
    remainders.push(scaled - floor * c.weightDenominator);
    assigned += floor;
  }

  let left = total - assigned;
  // Order indices by (remainder desc, tiebreak asc) — deterministic.
  const order = candidates.map((_, i) => i).sort((x, y) => {
    if (remainders[x] !== remainders[y]) return remainders[y] - remainders[x];
    return compareTiebreak(candidates[x].touchpoint, candidates[y].touchpoint);
  });

  const credit = floors.slice();
  for (const idx of order) {
    if (left <= 0) break;
    credit[idx] += 1;
    left -= 1;
  }

  const out = new Map<string, number>();
  candidates.forEach((c, i) => out.set(c.touchpoint.touchpointId, credit[i]));
  return out;
}

/** Sum check used by acceptance + service hardening. */
export function sumCreditBps(credits: Iterable<number>): number {
  let sum = 0;
  for (const c of credits) sum += c;
  return sum;
}
