// ─── R7-D Experimentation Engine — experiment lifecycle (D5) ───
//
// PURE module. Closed CAS-guarded transition graph. Activation only from
// READY; design is immutable once approved/active; pause/stop/invalidate
// require bounded reason codes; COMPLETED can never silently reopen;
// INVALIDATED preserves history; duplicate activation converges; conflicting
// transitions fail closed. No generic force-state endpoint exists.

import {
  ExperimentStateError,
  EXPERIMENT_LIFECYCLE_TYPES,
  type ExperimentStatus,
  type ExperimentLifecycleType,
} from "./experimentation-contract";

export const EXPERIMENT_TERMINAL_STATUSES: ReadonlySet<ExperimentStatus> = new Set([
  "COMPLETED",
  "INVALIDATED",
  "CANCELLED",
]);

export interface TransitionSpec {
  readonly from: ExperimentStatus;
  readonly to: ExperimentStatus;
  readonly lifecycleType: ExperimentLifecycleType;
  readonly requiresReason: boolean;
}

const T = (from: ExperimentStatus, to: ExperimentStatus, lifecycleType: ExperimentLifecycleType, requiresReason: boolean): TransitionSpec => ({ from, to, lifecycleType, requiresReason });

/** The closed transition graph — anything not listed fails closed. */
export const EXPERIMENT_TRANSITIONS: readonly TransitionSpec[] = [
  T("DRAFT", "GOVERNANCE_REQUIRED", "governance", false),
  // Governance decision transitions straight from DRAFT (GOVERNANCE_REQUIRED
  // remains a valid resting state when evaluation is staged separately).
  T("DRAFT", "READY", "governance", false),
  T("DRAFT", "APPROVAL_REQUIRED", "governance", false),
  T("DRAFT", "CANCELLED", "cancellation", true),
  T("GOVERNANCE_REQUIRED", "READY", "governance", false),
  T("GOVERNANCE_REQUIRED", "APPROVAL_REQUIRED", "governance", false),
  T("GOVERNANCE_REQUIRED", "CANCELLED", "cancellation", true),
  T("APPROVAL_REQUIRED", "READY", "approval", false),
  T("APPROVAL_REQUIRED", "CANCELLED", "cancellation", true),
  T("READY", "ACTIVE", "activation", false),
  T("READY", "CANCELLED", "cancellation", true),
  T("ACTIVE", "PAUSED", "pause", true),
  T("ACTIVE", "STOPPED", "stop", true),
  T("ACTIVE", "INVALIDATED", "invalidation", true),
  T("ACTIVE", "COMPLETED", "completion", false),
  T("PAUSED", "ACTIVE", "resume", false),
  T("PAUSED", "STOPPED", "stop", true),
  T("PAUSED", "INVALIDATED", "invalidation", true),
  T("STOPPED", "INVALIDATED", "invalidation", true),
];

const REASON_MAX_LEN = 191;

export function findTransition(from: ExperimentStatus, to: ExperimentStatus): TransitionSpec | null {
  return EXPERIMENT_TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

/** Validate a proposed transition + reason. Throws fail-closed on breach. */
export function assertTransitionLegal(input: {
  from: ExperimentStatus;
  to: ExperimentStatus;
  reasonCode?: string | null;
}): TransitionSpec {
  const { from, to } = input;
  if (EXPERIMENT_TERMINAL_STATUSES.has(from)) {
    throw new ExperimentStateError(
      "EXPERIMENT_TRANSITION_INVALID",
      `Experiment is in terminal status ${from} and cannot transition.`
    );
  }
  const spec = findTransition(from, to);
  if (spec === null) {
    throw new ExperimentStateError(
      "EXPERIMENT_TRANSITION_INVALID",
      `Transition ${from} → ${to} is not in the closed lifecycle graph.`
    );
  }
  const reason = input.reasonCode?.trim() ?? null;
  if (spec.requiresReason && (reason === null || reason.length === 0)) {
    throw new ExperimentStateError(
      "EXPERIMENT_TRANSITION_REASON_REQUIRED",
      `Transition ${from} → ${to} requires a bounded reason code.`
    );
  }
  if (reason !== null && reason.length > REASON_MAX_LEN) {
    throw new ExperimentStateError(
      "EXPERIMENT_TRANSITION_REASON_REQUIRED",
      "Transition reason code exceeds the 191-char bound."
    );
  }
  return spec;
}

export function lifecycleTypeForCreation(): ExperimentLifecycleType {
  return "creation";
}

export { EXPERIMENT_LIFECYCLE_TYPES };
