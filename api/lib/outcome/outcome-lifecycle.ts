// ─── R7-A Conversion Outcome Intelligence — lifecycle transition rules ───
//
// PURE module: the allowed outcome-status transition graph and the reversal
// type → lifecycle fact mapping. Truthful change is modelled as new immutable
// facts plus CAS-guarded status transitions — never history edits. Impossible
// transitions fail closed. No I/O, no clock.

import { OutcomeStateConflictError, type OutcomeStatus, type OutcomeType } from "./outcome-contract";

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["REVERSED", "CANCELLED", "SUPERSEDED"]);

export function isTerminalOutcomeStatus(status: OutcomeStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

const ALLOWED_TRANSITIONS: Readonly<Record<OutcomeStatus, readonly OutcomeStatus[]>> = {
  OBSERVED: ["PROVISIONAL", "VERIFIED", "REVERSED", "CANCELLED", "SUPERSEDED"],
  PROVISIONAL: ["VERIFIED", "REVERSED", "CANCELLED", "SUPERSEDED"],
  VERIFIED: ["REVERSED", "CANCELLED", "SUPERSEDED"],
  REVERSED: [],
  CANCELLED: [],
  SUPERSEDED: [],
};

/**
 * True when `from → to` is a legal lifecycle transition (contract §8):
 * verification proceeds OBSERVED → PROVISIONAL → VERIFIED (or directly to
 * VERIFIED), and any non-terminal state may be reversed, cancelled or
 * superseded. Terminal states have no outgoing transitions.
 */
export function canTransitionOutcomeStatus(from: OutcomeStatus, to: OutcomeStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** Outcome reversal type → lifecycle fact type minted on the target. */
export const REVERSAL_LIFECYCLE_TYPE: Readonly<Record<string, string>> = {
  REFUND: "refund",
  REVERSAL: "reversal",
  CANCELLATION: "cancellation",
};

/** Outcome reversal type → target outcome status. */
export const REVERSAL_TARGET_STATUS: Readonly<Record<string, OutcomeStatus>> = {
  REFUND: "REVERSED",
  REVERSAL: "REVERSED",
  CANCELLATION: "CANCELLED",
};

/** True when an outcome type participates in reversal lineage. */
export function isReversalOutcomeType(outcomeType: OutcomeType | string): boolean {
  return outcomeType === "REFUND" || outcomeType === "REVERSAL" || outcomeType === "CANCELLATION";
}

/** Fail-closed helper for illegal lifecycle transitions. */
export function assertTransitionAllowed(from: OutcomeStatus, to: OutcomeStatus): void {
  if (!canTransitionOutcomeStatus(from, to)) {
    throw new OutcomeStateConflictError(
      "OUTCOME_TRANSITION_INVALID",
      `outcome status transition ${from} → ${to} is not permitted.`
    );
  }
}
