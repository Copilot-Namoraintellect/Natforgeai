// ─── R5-D Opportunity Detection — lifecycle transitions (contract §4, §10, D8) ───
//
// PURE transition authority. Every mutation path in the store funnels through
// canTransition; illegal or stale transitions fail closed (STALE_STATE /
// ILLEGAL_TRANSITION). No I/O, no clock — callers pass explicit time.

import type { OpportunityStatus } from "./opportunity-contract";

export type LifecycleTransition =
  | "create"
  | "evidence_strengthened"
  | "confidence_decayed"
  | "suppress"
  | "unsuppress"
  | "expire"
  | "escalate"
  | "handoff"
  | "revive";

const ACTIVE: readonly OpportunityStatus[] = ["candidate", "strengthening", "weak"];

export function isActiveStatus(status: OpportunityStatus): boolean {
  return ACTIVE.includes(status);
}

/**
 * Allowed transitions (closed). Design notes:
 * - create mints candidate (strength MEDIUM/HIGH) or weak (LOW/UNKNOWN).
 * - strengthen/decay move between candidate/strengthening/weak.
 * - suppress is explicit (operator/policy/spam reclassification); unsuppress
 *   restores weak (never straight to candidate — re-evaluation required).
 * - expire applies to active statuses only; revive restores from new evidence.
 * - escalate is safety-driven and terminal pre-R6.
 * - handoff is exactly-once from any active status.
 */
const TRANSITIONS: Readonly<Record<LifecycleTransition, readonly OpportunityStatus[]>> = {
  create: ["candidate", "weak"],
  evidence_strengthened: ["candidate", "strengthening", "weak"],
  confidence_decayed: ["candidate", "strengthening", "weak"],
  suppress: ["candidate", "strengthening", "weak", "expired"],
  unsuppress: ["suppressed"],
  expire: ["candidate", "strengthening", "weak"],
  escalate: ["candidate", "strengthening", "weak", "suppressed", "expired"],
  handoff: ["candidate", "strengthening", "weak"],
  revive: ["expired"],
};

export function allowedTargetStatuses(transition: LifecycleTransition): readonly OpportunityStatus[] {
  return TRANSITIONS[transition];
}

export function canTransition(
  transition: LifecycleTransition,
  from: OpportunityStatus
): boolean {
  return TRANSITIONS[transition].includes(from);
}

/**
 * Deterministic status for fresh evidence on a candidate (create/strengthen/
 * revive paths): MEDIUM/HIGH strength → candidate; LOW/UNKNOWN → weak.
 * An upward move from the current status is recorded as strengthening.
 */
export function statusForStrength(
  strength: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN",
  previousStatus: OpportunityStatus | null
): OpportunityStatus {
  if (previousStatus === "expired") {
    return strength === "LOW" || strength === "UNKNOWN" ? "weak" : "candidate";
  }
  if (strength === "MEDIUM" || strength === "HIGH") {
    if (previousStatus === "weak") return "strengthening";
    return "candidate";
  }
  return "weak";
}
