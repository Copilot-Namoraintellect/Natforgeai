// ─── R7-E Budget & Portfolio Optimisation — bounded allocation solver (E4) ───
//
// PURE module: deterministic bounded reallocation over a portfolio snapshot,
// driven ONLY by the deterministic evidence scores (E3) and the frozen
// constraint set. No model sits in the allocation path. Guarantees, for every
// proposal that changes money:
//
//   1. Σ proposed allocations ≤ approved total budget, and = current
//      allocatable total for a pure reallocation (no money creation);
//   2. no negative allocation; every delta is a movement between in-scope keys;
//   3. locked funds, reserved funds, disabled campaigns and unsupported
//      providers are preserved exactly (zero delta);
//   4. per-cycle shift cap, concentration ceiling and minimum-allocation floor
//      enforced with exact integer arithmetic (BigInt internally);
//   5. weak evidence cannot drive aggressive shifts (confidence-capped shifts).
//
// Redistribution rounding is deterministic largest-remainder with a stable
// allocation-key tie-break — rounding never creates or destroys money.
// No I/O, no clock, no side effects.

import {
  BUDGET_PORTFOLIO_ALGORITHM_VERSION,
  BudgetPortfolioValidationError,
  campaignIdFromAllocationKey,
  type OptimisationObjective,
  type OptimisationReasonCode,
} from "./budget-portfolio-contract";
import type { EvidenceEvaluation } from "./evidence-model";
import type { PortfolioSnapshot } from "./portfolio-snapshot";

/** Frozen constraint set (contract §7; code-level, never client-supplied). */
export interface OptimisationConstraints {
  /** Basis points of pool: no single allocation may exceed this fraction. */
  readonly concentrationCeilingBps: number;
  /** Basis points of pool: no single |delta| may exceed this fraction per cycle. */
  readonly maxShiftPerCycleBps: number;
  /** Absolute per-key per-cycle shift cap (minor units). */
  readonly maxShiftPerCycleMinor: number;
  /** Minimum allocation floor applied to funded keys where affordable. */
  readonly minAllocationMinor: number;
  /** Gross movement below this ⇒ NO_CHANGE (hysteresis threshold). */
  readonly minChangeThresholdMinor: number;
  /** Confidence-capped shift ceilings: WEAK evidence moves at most this bps. */
  readonly weakConfidenceShiftCapBps: number;
  /** PROVISIONAL-class evidence (MODERATE confidence) moves at most this bps. */
  readonly moderateConfidenceShiftCapBps: number;
}

export const DEFAULT_OPTIMISATION_CONSTRAINTS: OptimisationConstraints = Object.freeze({
  concentrationCeilingBps: 5000, // 50% — aligned with R7-F default policy
  maxShiftPerCycleBps: 2000, // 20% — aligned with R7-F maxSingleShiftFraction
  maxShiftPerCycleMinor: 50_000, // $500 — aligned with R7-F autonomous cap
  minAllocationMinor: 100, // $1.00 floor where affordable
  minChangeThresholdMinor: 50, // $0.50 gross movement floor
  weakConfidenceShiftCapBps: 500, // 5% — weak evidence cannot shift aggressively
  moderateConfidenceShiftCapBps: 1000, // 10% — provisional-class evidence moves cautiously
});

const BPS = 10_000n;

export interface AllocationSolveResult {
  readonly algorithmVersion: typeof BUDGET_PORTFOLIO_ALGORITHM_VERSION;
  readonly changed: boolean;
  /** Key → proposed amount (minor). Ineligible keys keep current exactly. */
  readonly proposedByKey: Readonly<Record<string, number>>;
  /** Key → signed delta (minor). Σ deltas = 0 whenever changed. */
  readonly deltaByKey: Readonly<Record<string, number>>;
  readonly reasonCodes: readonly OptimisationReasonCode[];
}

function sortedKeys(map: Readonly<Record<string, number>>): string[] {
  return Object.keys(map).sort();
}

/**
 * Largest-remainder integer split of `pool` proportional to `weights`
 * (non-negative integers). Exact BigInt arithmetic; deterministic tie-break
 * on allocationKey asc. Σ result === pool exactly.
 */
export function splitProportionally(
  pool: number,
  weights: Readonly<Record<string, number>>
): Record<string, number> {
  const keys = sortedKeys(weights).filter((k) => weights[k] > 0);
  const result: Record<string, number> = {};
  if (pool <= 0 || keys.length === 0) {
    for (const k of Object.keys(weights)) result[k] = 0;
    return result;
  }
  const poolBn = BigInt(pool);
  let totalW = 0n;
  for (const k of keys) totalW += BigInt(weights[k]);
  if (totalW === 0n) {
    for (const k of Object.keys(weights)) result[k] = 0;
    return result;
  }

  const raw = new Map<string, bigint>();
  const remainders: { key: string; numerator: bigint; frac: bigint }[] = [];
  let assigned = 0n;
  for (const k of keys) {
    const w = BigInt(weights[k]);
    const exact = (poolBn * w) / totalW;
    raw.set(k, exact);
    assigned += exact;
    // Remainder fraction for largest-remainder: (pool*w) mod totalW, compare
    // by cross-multiplication later.
    remainders.push({ key: k, numerator: (poolBn * w) % totalW, frac: 0n });
  }
  let leftover = poolBn - assigned;

  // Largest remainder: order by (numerator desc, key asc). Compare fractions
  // a/totalW vs b/totalW via a*? — same denominator, so numerator ordering
  // IS the fraction ordering. Deterministic.
  remainders.sort((a, b) => {
    if (a.numerator !== b.numerator) return a.numerator > b.numerator ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
  for (let i = 0; leftover > 0n && i < remainders.length; i++, leftover -= 1n) {
    raw.set(remainders[i].key, (raw.get(remainders[i].key) ?? 0n) + 1n);
  }

  for (const k of Object.keys(weights)) result[k] = Number(raw.get(k) ?? 0n);
  return result;
}

/**
 * Solve the bounded reallocation. Pure function of (snapshot, evidence,
 * objective, constraints). Emits reason codes for every constraint that
 * shaped the outcome — explainability is a first-class output.
 */
export function solvePortfolioAllocation(input: {
  snapshot: PortfolioSnapshot;
  evidence: EvidenceEvaluation;
  objective: OptimisationObjective;
  constraints?: OptimisationConstraints;
}): AllocationSolveResult {
  const { snapshot, evidence, objective } = input;
  const constraints = input.constraints ?? DEFAULT_OPTIMISATION_CONSTRAINTS;
  const reasons: OptimisationReasonCode[] = [];

  const currentByKey: Record<string, number> = {};
  for (const entry of snapshot.currentAllocations) {
    currentByKey[entry.allocationKey] = entry.amountMinor;
  }
  const locked = new Set(snapshot.lockedAllocationKeys);
  const disabled = new Set(snapshot.disabledAllocationKeys);

  // Minimum evidence threshold: keys without usable evidence cannot receive.
  const eligible = sortedKeys(currentByKey).filter((key) => {
    if (locked.has(key) || disabled.has(key)) return false;
    const ev = evidence.byKey[key];
    return ev !== undefined && ev.score > 0 && !ev.learningContradicted;
  });
  const noChange = (noChangeReasons: readonly OptimisationReasonCode[]): AllocationSolveResult => {
    const zeroDelta: Record<string, number> = {};
    for (const k of sortedKeys(currentByKey)) zeroDelta[k] = 0;
    return finalize(zeroDelta, currentByKey, [...noChangeReasons, ...reasons]);
  };

  // ── Early NO_CHANGE paths (weak/blocked evidence never moves money) ──
  if (evidence.confidenceClass === "INSUFFICIENT") {
    return noChange(["EVIDENCE_INSUFFICIENT"]);
  }
  if (eligible.length === 0) {
    return noChange(["NO_VIABLE_IMPROVEMENT"]);
  }
  const movablePool = eligible.reduce((sum, k) => sum + currentByKey[k], 0);
  if (movablePool <= 0) {
    return noChange(["NO_VIABLE_IMPROVEMENT"]);
  }
  const weights: Record<string, number> = {};
  for (const key of eligible) {
    weights[key] =
      objective === "REBALANCE_TO_POLICY_TARGET" ? 1 : Math.max(0, evidence.byKey[key]?.score ?? 0);
  }
  const targets = splitProportionally(movablePool, weights);

  // ── Minimum allocation floor (where affordable) ──
  const floor = Math.min(constraints.minAllocationMinor, movablePool);
  let floorApplied = false;
  if (floor > 0) {
    const shortfallKeys = eligible.filter((k) => targets[k] > 0 && targets[k] < floor);
    const totalShortfall = shortfallKeys.reduce((s, k) => s + (floor - targets[k]), 0);
    const reducible = eligible.filter((k) => targets[k] > floor);
    const reducibleSurplus = reducible.reduce((s, k) => s + (targets[k] - floor), 0);
    if (shortfallKeys.length > 0 && reducibleSurplus >= totalShortfall) {
      // Lift under-floor keys, taking from over-floor keys proportional to excess.
      const excessWeights: Record<string, number> = {};
      for (const k of reducible) excessWeights[k] = targets[k] - floor;
      const take = splitProportionally(totalShortfall, excessWeights);
      for (const k of shortfallKeys) targets[k] = floor;
      for (const k of reducible) targets[k] -= take[k] ?? 0;
      floorApplied = true;
    }
    // If not affordable, floors are skipped deterministically (no partial mess).
  }

  // ── Concentration ceiling (integer cross-multiplication, no floats) ──
  const ceilingNumerator = BigInt(constraints.concentrationCeilingBps);
  let ceilingApplied = false;
  {
    // Clamp iteratively: keys above ceiling give to keys below, deterministic.
    for (let iteration = 0; iteration < eligible.length + 1; iteration++) {
      const total = eligible.reduce((s, k) => s + targets[k], 0);
      if (total <= 0) break;
      const offenders = eligible.filter(
        (k) => BigInt(targets[k]) * BPS > ceilingNumerator * BigInt(total)
      );
      if (offenders.length === 0) break;
      const receivers = eligible.filter((k) => !offenders.includes(k));
      if (receivers.length === 0) {
        // Concentration ceiling is unsatisfiable (every eligible key is at or
        // above the ceiling — e.g. a single-key portfolio): redistribution is
        // impossible, so the ceiling cannot apply. Keep targets unchanged.
        break;
      }
      ceilingApplied = true;
      const capped: Record<string, number> = { ...targets };
      let excessTotal = 0;
      for (const k of offenders) {
        const cap = Number((ceilingNumerator * BigInt(total)) / BPS);
        excessTotal += targets[k] - cap;
        capped[k] = cap;
      }
      const receiverWeights: Record<string, number> = {};
      for (const k of receivers) receiverWeights[k] = weights[k] > 0 ? weights[k] : 1;
      const give = splitProportionally(excessTotal, receiverWeights);
      for (const k of receivers) capped[k] += give[k] ?? 0;
      for (const k of eligible) targets[k] = capped[k];
    }
  }

  // ── Deltas + per-cycle shift cap (confidence-aware) ──
  let shiftCapBps = constraints.maxShiftPerCycleBps;
  if (evidence.confidenceClass === "WEAK") {
    shiftCapBps = Math.min(shiftCapBps, constraints.weakConfidenceShiftCapBps);
  } else if (evidence.confidenceClass === "MODERATE") {
    // Provisional-class evidence (verified outcomes absent or contradictions
    // present) moves cautiously: verified outcomes always carry more weight.
    shiftCapBps = Math.min(shiftCapBps, constraints.moderateConfidenceShiftCapBps);
  }
  const totalAllocated = eligible.reduce((s, k) => s + targets[k], 0);
  const deltaByKey: Record<string, number> = {};
  for (const k of Object.keys(currentByKey)) deltaByKey[k] = 0; // ineligible: preserved

  let shiftCapApplied = false;
  const absCap = constraints.maxShiftPerCycleMinor;
  for (const k of eligible) {
    let desired = targets[k] - currentByKey[k];
    const capByFraction =
      totalAllocated > 0
        ? Number((BigInt(shiftCapBps) * BigInt(totalAllocated)) / BPS)
        : 0;
    const cap = Math.min(absCap, capByFraction);
    if (desired > cap) {
      desired = cap;
      shiftCapApplied = true;
    } else if (desired < -cap) {
      desired = -cap;
      shiftCapApplied = true;
    }
    deltaByKey[k] = desired;
  }
  // Re-zero-sum after capping: scale the surplus side down deterministically.
  {
    let positive = 0;
    let negative = 0;
    for (const k of eligible) {
      if (deltaByKey[k] > 0) positive += deltaByKey[k];
      else negative -= deltaByKey[k];
    }
    if (positive !== negative && positive > 0 && negative > 0) {
      if (positive > negative) {
        const scaleNumerator = BigInt(negative);
        const scaled = splitProportionallyFromBig(
          eligible.filter((k) => deltaByKey[k] > 0),
          (k) => deltaByKey[k],
          scaleNumerator,
          BigInt(positive)
        );
        for (const k of eligible) if (deltaByKey[k] > 0) deltaByKey[k] = scaled.get(k) ?? 0;
      } else {
        const scaleNumerator = BigInt(positive);
        const scaled = splitProportionallyFromBig(
          eligible.filter((k) => deltaByKey[k] < 0),
          (k) => -deltaByKey[k],
          scaleNumerator,
          BigInt(negative)
        );
        for (const k of eligible) if (deltaByKey[k] < 0) deltaByKey[k] = -(scaled.get(k) ?? 0);
      }
    }
  }

  // ── Hysteresis: gross movement below threshold ⇒ hold ──
  let gross = 0;
  for (const k of eligible) gross += Math.abs(deltaByKey[k]);
  if (gross < constraints.minChangeThresholdMinor) {
    for (const k of eligible) deltaByKey[k] = 0;
    reasons.push("CHANGE_BELOW_MINIMUM_THRESHOLD");
  } else {
    if (floorApplied) reasons.push("MIN_ALLOCATION_FLOOR_APPLIED");
    if (ceilingApplied) reasons.push("CONCENTRATION_CEILING_APPLIED");
    if (shiftCapApplied) reasons.push("PER_CYCLE_SHIFT_CAP_APPLIED");
  }

  pushPreservationCodes(reasons, snapshot);
  return finalize(deltaByKey, currentByKey, reasons);
}

function splitProportionallyFromBig(
  keys: readonly string[],
  valueOf: (key: string) => number,
  numerator: bigint,
  denominator: bigint
): Map<string, number> {
  const out = new Map<string, number>();
  if (keys.length === 0 || numerator <= 0n || denominator <= 0n) {
    for (const k of keys) out.set(k, 0);
    return out;
  }
  const raw = new Map<string, bigint>();
  const remainders: { key: string; rem: bigint }[] = [];
  let assigned = 0n;
  for (const k of keys) {
    const exact = (numerator * BigInt(valueOf(k))) / denominator;
    raw.set(k, exact);
    assigned += exact;
    remainders.push({ key: k, rem: (numerator * BigInt(valueOf(k))) % denominator });
  }
  let leftover = numerator - assigned;
  remainders.sort((a, b) => (a.rem !== b.rem ? (a.rem > b.rem ? -1 : 1) : a.key.localeCompare(b.key)));
  for (let i = 0; leftover > 0n && i < remainders.length; i++, leftover -= 1n) {
    raw.set(remainders[i].key, (raw.get(remainders[i].key) ?? 0n) + 1n);
  }
  for (const k of keys) out.set(k, Number(raw.get(k) ?? 0n));
  return out;
}

function pushPreservationCodes(
  reasons: OptimisationReasonCode[],
  snapshot: PortfolioSnapshot
): void {
  const currentByKey: Record<string, number> = {};
  for (const e of snapshot.currentAllocations) currentByKey[e.allocationKey] = e.amountMinor;
  if (snapshot.lockedAllocationKeys.some((k) => (currentByKey[k] ?? 0) > 0)) {
    reasons.push("LOCKED_FUNDS_PRESERVED");
  }
  if (snapshot.reservedMinor > 0) reasons.push("RESERVED_FUNDS_PRESERVED");
  const disabledWithFunds = snapshot.disabledAllocationKeys.filter(
    (k) => (currentByKey[k] ?? 0) > 0
  );
  if (disabledWithFunds.length > 0) {
    const unsupported = snapshot.currentAllocations.filter(
      (e) =>
        disabledWithFunds.includes(e.allocationKey) &&
        e.provider !== null &&
        !snapshot.supportedProviders.includes(e.provider)
    );
    reasons.push(
      unsupported.length > 0 ? "UNSUPPORTED_PROVIDER_EXCLUDED" : "DISABLED_CAMPAIGN_EXCLUDED"
    );
  }
}

function finalize(
  deltaByKey: Record<string, number>,
  currentByKey: Record<string, number>,
  reasons: readonly OptimisationReasonCode[]
): AllocationSolveResult {
  const proposedByKey: Record<string, number> = {};
  let sumDelta = 0;
  let sumProposed = 0;
  for (const k of sortedKeys(currentByKey)) {
    proposedByKey[k] = currentByKey[k] + deltaByKey[k];
    if (proposedByKey[k] < 0) {
      throw new BudgetPortfolioValidationError(
        "BUDGET_INVARIANT_VIOLATION",
        `solver produced a negative allocation for ${k}`
      );
    }
    sumDelta += deltaByKey[k];
    sumProposed += proposedByKey[k];
  }
  const changed = sortedKeys(deltaByKey).some((k) => deltaByKey[k] !== 0);
  if (changed && sumDelta !== 0) {
    throw new BudgetPortfolioValidationError(
      "BUDGET_INVARIANT_VIOLATION",
      `pure reallocation must conserve money (Σdelta=${sumDelta})`
    );
  }
  void sumProposed;
  return Object.freeze({
    algorithmVersion: BUDGET_PORTFOLIO_ALGORITHM_VERSION,
    changed,
    proposedByKey: Object.freeze(proposedByKey),
    deltaByKey: Object.freeze(deltaByKey),
    reasonCodes: Object.freeze([...new Set(reasons)].slice(0, 8)),
  });
}

/** True when the proposed state obeys the hard budget invariants (defence in depth). */
export function assertBudgetInvariants(input: {
  snapshot: PortfolioSnapshot;
  proposedByKey: Readonly<Record<string, number>>;
}): void {
  const { snapshot, proposedByKey } = input;
  let total = 0;
  for (const [key, amount] of Object.entries(proposedByKey)) {
    if (!Number.isInteger(amount) || amount < 0) {
      throw new BudgetPortfolioValidationError(
        "BUDGET_INVARIANT_VIOLATION",
        `allocation for ${key} must be a non-negative integer`
      );
    }
    if (campaignIdFromAllocationKey(key) === null) {
      throw new BudgetPortfolioValidationError(
        "BUDGET_INVARIANT_VIOLATION",
        `unknown allocation key ${key}`
      );
    }
    total += amount;
  }
  if (total > snapshot.approvedTotalBudgetMinor) {
    throw new BudgetPortfolioValidationError(
      "BUDGET_INVARIANT_VIOLATION",
      `Σ proposed (${total}) exceeds the approved total (${snapshot.approvedTotalBudgetMinor})`
    );
  }
  for (const key of snapshot.lockedAllocationKeys) {
    const current = snapshot.currentAllocations.find((e) => e.allocationKey === key)?.amountMinor ?? 0;
    if ((proposedByKey[key] ?? current) !== current) {
      throw new BudgetPortfolioValidationError(
        "BUDGET_INVARIANT_VIOLATION",
        `locked allocation ${key} was modified`
      );
    }
  }
}
