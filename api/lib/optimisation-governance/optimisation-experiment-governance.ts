// ─── R7-F Optimisation Governance — experiment governance (F5) ───
//
// Governance contract for R7-D experimentation. This module decides whether
// an experiment is PERMITTED to run under policy; it never computes
// statistical results, never assigns treatments and never judges outcomes.
// Governance controls permission only — the moment it starts deciding what
// the experiment should conclude, it has become the optimisation engine
// (forbidden by the stream charter).
//
// Pure module: no I/O, no clock (caller supplies `now`), no state.

import {
  isIsoUtc,
  OptimisationGovernanceValidationError,
  type OptimisationGovernanceReasonCode,
} from "./optimisation-governance-contract";
import {
  isExperimentDimension,
  isProtectedTrait,
  type ExperimentDimension,
  type ProtectedTrait,
} from "./optimisation-action-taxonomy";
import type { OptimisationGovernancePolicy } from "./optimisation-policy";

/** The experiment material of a proposal (validated before it reaches here). */
export interface OptimisationProposalExperiment {
  /** Durable experiment key proposed by the upstream stream. */
  readonly experimentKey: string;
  /** Dimensions the experiment would manipulate (closed vocabulary). */
  readonly dimensions: readonly ExperimentDimension[];
  /** Budget the experiment would consume (minor units). */
  readonly budgetMinor: number;
  readonly durationDays: number;
  /** Protected/sensitive traits the proposal declares it touches. */
  readonly touchesProtectedTraits: readonly ProtectedTrait[];
}

/** Server-resolved experiment authority snapshot. */
export interface OptimisationExperimentAuthoritySnapshot {
  /** Experiments currently active for this business/period. */
  readonly activeExperiments: number;
}

export interface OptimisationExperimentEvaluation {
  readonly isExperimentAction: boolean;
  readonly blockReasonCodes: readonly OptimisationGovernanceReasonCode[];
  readonly reviewReasonCodes: readonly OptimisationGovernanceReasonCode[];
  readonly thresholds: Readonly<Record<string, number>>;
}

/**
 * Validate the experiment constraint seam. Untrusted until accepted; a
 * malformed snapshot fails closed (authority unavailable).
 */
export function validateOptimisationExperimentAuthoritySnapshot(
  raw: unknown
): OptimisationExperimentAuthoritySnapshot {
  function fail(): never {
    throw new OptimisationGovernanceValidationError(
      "OPTIMISATION_EXPERIMENT_AUTHORITY_UNAVAILABLE",
      "experiment authority snapshot failed validation; experiment governance unavailable (fail closed)"
    );
  }
  if (typeof raw !== "object" || raw === null) fail();
  const r = raw as Record<string, unknown>;
  if (!Number.isInteger(r.activeExperiments) || (r.activeExperiments as number) < 0) fail();
  return { activeExperiments: r.activeExperiments as number };
}

export function isExperimentActionType(actionType: string): boolean {
  return (
    actionType === "EXPERIMENT_CREATE" ||
    actionType === "EXPERIMENT_ACTIVATE" ||
    actionType === "EXPERIMENT_STOP"
  );
}

/**
 * Evaluate experiment governance constraints for one proposal. Only
 * constraints that policy defines are enforced here; every check reduces
 * autonomy, none expands it. EXPERIMENT_STOP releases resources and is only
 * subject to protected-trait hygiene (stopping must not itself become a
 * manipulation vector).
 */
export function evaluateOptimisationExperimentGovernance(input: {
  actionType: string;
  experiment: OptimisationProposalExperiment | null;
  policy: OptimisationGovernancePolicy;
  authority: OptimisationExperimentAuthoritySnapshot;
  now: string;
}): OptimisationExperimentEvaluation {
  const { actionType, experiment, policy, authority } = input;
  const thresholds: Record<string, number> = {
    maxConcurrentExperiments: policy.experiment.maxConcurrentExperiments,
    maxExperimentBudgetMinor: policy.experiment.maxExperimentBudgetMinor,
    minDurationDays: policy.experiment.minDurationDays,
    maxDurationDays: policy.experiment.maxDurationDays,
  };
  const block: OptimisationGovernanceReasonCode[] = [];
  const review: OptimisationGovernanceReasonCode[] = [];

  if (!isExperimentActionType(actionType)) {
    return Object.freeze({
      isExperimentAction: false,
      blockReasonCodes: Object.freeze(block),
      reviewReasonCodes: Object.freeze(review),
      thresholds: Object.freeze(thresholds),
    });
  }

  if (Number.isNaN(Date.parse(input.now))) {
    throw new OptimisationGovernanceValidationError(
      "INVALID_EVALUATION_CLOCK",
      `now must be a valid ISO timestamp, got ${String(input.now)}`
    );
  }

  if (actionType === "EXPERIMENT_STOP") {
    // Stopping cannot violate concurrency/budget/duration constraints.
    return Object.freeze({
      isExperimentAction: true,
      blockReasonCodes: Object.freeze(block),
      reviewReasonCodes: Object.freeze(review),
      thresholds: Object.freeze(thresholds),
    });
  }

  if (!experiment) {
    // Create/activate without experiment material is malformed.
    block.push("MALFORMED_PROPOSAL");
    return Object.freeze({
      isExperimentAction: true,
      blockReasonCodes: Object.freeze(block),
      reviewReasonCodes: Object.freeze(review),
      thresholds: Object.freeze(thresholds),
    });
  }

  // Prohibited dimensions are hard blocks (AC17).
  for (const dimension of experiment.dimensions) {
    if (policy.experiment.prohibitedDimensions.includes(dimension)) {
      block.push("EXPERIMENT_DIMENSION_PROHIBITED");
      break;
    }
  }

  // Protected/sensitive trait restrictions are hard blocks (AC19).
  for (const trait of experiment.touchesProtectedTraits) {
    if (policy.experiment.protectedTraits.includes(trait)) {
      block.push("PROTECTED_TRAIT_OPTIMISATION_BLOCKED");
      break;
    }
  }

  // Budget per experiment: above the policy ceiling requires review (AC16).
  if (experiment.budgetMinor > policy.experiment.maxExperimentBudgetMinor) {
    review.push("EXPERIMENT_BUDGET_EXCEEDS_LIMIT");
  }

  // Concurrency ceiling (AC18).
  if (authority.activeExperiments >= policy.experiment.maxConcurrentExperiments) {
    block.push("EXPERIMENT_CONCURRENCY_LIMIT_REACHED");
  }

  // Duration bounds.
  if (
    experiment.durationDays < policy.experiment.minDurationDays ||
    experiment.durationDays > policy.experiment.maxDurationDays
  ) {
    review.push("EXPERIMENT_DURATION_OUT_OF_BOUNDS");
  }

  return Object.freeze({
    isExperimentAction: true,
    blockReasonCodes: Object.freeze(block),
    reviewReasonCodes: Object.freeze(review),
    thresholds: Object.freeze(thresholds),
  });
}

/** Validate raw experiment material arriving inside a proposal. */
export function validateOptimisationProposalExperiment(
  raw: unknown
): OptimisationProposalExperiment {
  function fail(message: string): never {
    throw new OptimisationGovernanceValidationError("MALFORMED_PROPOSAL", message);
  }
  if (typeof raw !== "object" || raw === null) fail("experiment must be an object");
  const r = raw as Record<string, unknown>;
  const experimentKey = r.experimentKey;
  const dimensions = r.dimensions;
  const budgetMinor = r.budgetMinor;
  const durationDays = r.durationDays;
  const touchesProtectedTraits = r.touchesProtectedTraits;
  if (typeof experimentKey !== "string" || experimentKey.trim().length === 0) {
    fail("experiment.experimentKey must be a non-blank string");
  }
  if (!Array.isArray(dimensions) || dimensions.length === 0) {
    fail("experiment.dimensions must be a non-empty array");
  }
  for (const d of dimensions) {
    if (!isExperimentDimension(d)) {
      fail(`experiment.dimensions contains unsupported dimension ${JSON.stringify(d)}`);
    }
  }
  if (!Number.isInteger(budgetMinor) || (budgetMinor as number) < 0) {
    fail("experiment.budgetMinor must be a non-negative integer");
  }
  if (!Number.isInteger(durationDays) || (durationDays as number) <= 0) {
    fail("experiment.durationDays must be a positive integer");
  }
  if (!Array.isArray(touchesProtectedTraits)) {
    fail("experiment.touchesProtectedTraits must be an array");
  }
  for (const t of touchesProtectedTraits) {
    if (!isProtectedTrait(t)) {
      fail(`experiment.touchesProtectedTraits contains unsupported trait ${JSON.stringify(t)}`);
    }
  }
  return {
    experimentKey: experimentKey.trim(),
    dimensions: Object.freeze(dimensions as ExperimentDimension[]),
    budgetMinor: budgetMinor as number,
    durationDays: durationDays as number,
    touchesProtectedTraits: Object.freeze(touchesProtectedTraits as ProtectedTrait[]),
  };
}

export { isIsoUtc };
