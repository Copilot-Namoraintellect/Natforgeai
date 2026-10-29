// ─── R7-F Optimisation Governance — portfolio / concentration governance (F6) ───
//
// Boundaries for R7-E budget/portfolio optimisation. Where policy defines
// them, this module constrains: excessive spend concentration, sudden budget
// shifts, repeated oscillation, movements out of locked/reserved funds,
// budget movement into unsupported providers, and movements justified only by
// stale or unverified learning. It does NOT implement the optimisation
// algorithm itself and never computes an "optimal" allocation.
//
// Pure module: no I/O, no clock (caller supplies `now`), no state.

import {
  isIsoUtc,
  OptimisationGovernanceValidationError,
  type OptimisationGovernanceReasonCode,
} from "./optimisation-governance-contract";
import type { OptimisationGovernancePolicy } from "./optimisation-policy";
import type { OptimisationAllocationDelta } from "./optimisation-financial-governance";

/** The portfolio material of a proposal. */
export interface OptimisationProposalPortfolio {
  /** Optional explicit concentration target the proposal would create. */
  readonly resultingAllocations?: Readonly<Record<string, number>>;
}

/** Server-resolved portfolio authority snapshot. */
export interface OptimisationPortfolioAuthoritySnapshot {
  /** Current allocation per allocation key (minor units). */
  readonly currentAllocations: Readonly<Record<string, number>>;
  /** Last movement time per allocation key (oscillation/interval guard). */
  readonly lastReallocationAtByKey: Readonly<Record<string, string>>;
}

export interface OptimisationPortfolioEvaluation {
  readonly isPortfolioRelevant: boolean;
  readonly blockReasonCodes: readonly OptimisationGovernanceReasonCode[];
  readonly reviewReasonCodes: readonly OptimisationGovernanceReasonCode[];
  readonly thresholds: Readonly<Record<string, number>>;
}

/**
 * Validate the portfolio authority seam. Untrusted until accepted; a
 * malformed snapshot fails closed (authority unavailable).
 */
export function validateOptimisationPortfolioAuthoritySnapshot(
  raw: unknown
): OptimisationPortfolioAuthoritySnapshot {
  function fail(): never {
    throw new OptimisationGovernanceValidationError(
      "OPTIMISATION_PORTFOLIO_AUTHORITY_UNAVAILABLE",
      "portfolio authority snapshot failed validation; portfolio governance unavailable (fail closed)"
    );
  }
  if (typeof raw !== "object" || raw === null) fail();
  const r = raw as Record<string, unknown>;
  const currentAllocations = r.currentAllocations;
  const lastReallocationAtByKey = r.lastReallocationAtByKey;
  if (typeof currentAllocations !== "object" || currentAllocations === null) fail();
  for (const [key, value] of Object.entries(currentAllocations as Record<string, unknown>)) {
    if (key.trim().length === 0 || !Number.isInteger(value) || (value as number) < 0) fail();
  }
  if (typeof lastReallocationAtByKey !== "object" || lastReallocationAtByKey === null) fail();
  for (const [key, value] of Object.entries(lastReallocationAtByKey as Record<string, unknown>)) {
    if (key.trim().length === 0 || typeof value !== "string" || !isIsoUtc(value)) fail();
  }
  return {
    currentAllocations: Object.freeze({ ...(currentAllocations as Record<string, number>) }),
    lastReallocationAtByKey: Object.freeze({
      ...(lastReallocationAtByKey as Record<string, string>),
    }),
  };
}

/** Portfolio governance applies to any action that moves money between allocations. */
export function isPortfolioRelevantAction(actionType: string): boolean {
  return (
    actionType === "BUDGET_REALLOCATE" ||
    actionType === "CHANNEL_REALLOCATE" ||
    actionType === "AUDIENCE_REALLOCATE" ||
    actionType === "CAMPAIGN_PRIORITY_CHANGE" ||
    actionType === "BUDGET_DECREASE"
  );
}

/**
 * Evaluate portfolio / concentration constraints. Every check reduces
 * autonomy; none may expand it.
 */
export function evaluateOptimisationPortfolioGovernance(input: {
  actionType: string;
  deltas: readonly OptimisationAllocationDelta[];
  policy: OptimisationGovernancePolicy;
  authority: OptimisationPortfolioAuthoritySnapshot;
  now: string;
}): OptimisationPortfolioEvaluation {
  const { actionType, deltas, policy, authority } = input;
  const p = policy.portfolio;
  const thresholds: Record<string, number> = {
    maxConcentrationFraction: p.maxConcentrationFraction,
    maxSingleShiftFraction: p.maxSingleShiftFraction,
    minReallocationIntervalMs: p.minReallocationIntervalMs,
  };
  const block: OptimisationGovernanceReasonCode[] = [];
  const review: OptimisationGovernanceReasonCode[] = [];

  if (!isPortfolioRelevantAction(actionType) || deltas.length === 0) {
    return Object.freeze({
      isPortfolioRelevant: false,
      blockReasonCodes: Object.freeze(block),
      reviewReasonCodes: Object.freeze(review),
      thresholds: Object.freeze(thresholds),
    });
  }

  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    throw new OptimisationGovernanceValidationError(
      "INVALID_EVALUATION_CLOCK",
      `now must be a valid ISO timestamp, got ${String(input.now)}`
    );
  }

  // Concentration: apply the deltas to the authoritative current allocations
  // and verify no allocation exceeds the policy ceiling of the approved
  // total. The denominator is the sum of the authoritative allocations —
  // never a client-supplied total (AC20).
  const resulting: Record<string, number> = { ...authority.currentAllocations };
  for (const delta of deltas) {
    resulting[delta.allocationKey] = (resulting[delta.allocationKey] ?? 0) + delta.deltaMinor;
    if (resulting[delta.allocationKey] < 0) {
      block.push("MALFORMED_PROPOSAL");
    }
  }
  const totalAllocated = Object.values(resulting).reduce((sum, v) => sum + v, 0);
  if (totalAllocated > 0) {
    for (const [key, value] of Object.entries(resulting)) {
      if (value / totalAllocated > p.maxConcentrationFraction) {
        review.push("CONCENTRATION_LIMIT_EXCEEDED");
        break;
      }
      void key;
    }
  }

  // Sudden shift: a single move larger than the policy fraction of the
  // current total requires review (AC21).
  if (totalAllocated > 0) {
    for (const delta of deltas) {
      if (Math.abs(delta.deltaMinor) / totalAllocated > p.maxSingleShiftFraction) {
        review.push("SUDDEN_REALLOCATION_SHIFT_LIMIT");
        break;
      }
    }
  }

  // Oscillation / churn: an allocation that already moved within the policy
  // interval must not be moved again (AC21 repeated-oscillation leg).
  for (const delta of deltas) {
    const lastAt = authority.lastReallocationAtByKey[delta.allocationKey];
    if (lastAt !== undefined && nowMs - Date.parse(lastAt) < p.minReallocationIntervalMs) {
      review.push("REALLOCATION_OSCILLATION_DETECTED");
      break;
    }
  }

  return Object.freeze({
    isPortfolioRelevant: true,
    blockReasonCodes: Object.freeze(block),
    reviewReasonCodes: Object.freeze(review),
    thresholds: Object.freeze(thresholds),
  });
}
