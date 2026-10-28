// ─── R7-F Optimisation Governance — closed action taxonomy (F2) ───
//
// The closed vocabulary of optimisation action types this governance
// authority recognises. Future R7 streams (B/C/D/E) propose actions from this
// list ONLY. Unknown or unregistered action types are BLOCKED by the decision
// engine — never silently defaulted to a weaker class.
//
// Pure module: no I/O, no clock, no state. R7-F owns this vocabulary; adding
// an action type is a code change to this closed list, not runtime data.

import {
  OPTIMISATION_FINANCIAL_IMPACT_CLASSES,
  type OptimisationFinancialImpactClass,
} from "./optimisation-governance-contract";

/**
 * Closed optimisation action types (F2). These describe *classes* of
 * optimisation intent, not concrete operations: the governance layer decides
 * whether a proposal of one of these types may proceed, require review or is
 * blocked. It never decides which campaign/channel/allocation is optimal —
 * that is the optimisation engine's job (R7-B/C/D/E), which this stream must
 * never become.
 */
export const OPTIMISATION_ACTION_TYPES = [
  "LEARNING_PROMOTION",
  "EXPERIMENT_CREATE",
  "EXPERIMENT_ACTIVATE",
  "EXPERIMENT_STOP",
  "BUDGET_REALLOCATE",
  "BUDGET_INCREASE",
  "BUDGET_DECREASE",
  "CHANNEL_REALLOCATE",
  "AUDIENCE_REALLOCATE",
  "CAMPAIGN_PRIORITY_CHANGE",
  "STRATEGY_RECOMMENDATION",
] as const;

export type OptimisationActionType = (typeof OPTIMISATION_ACTION_TYPES)[number];

const OPTIMISATION_ACTION_TYPE_SET: ReadonlySet<string> = new Set(OPTIMISATION_ACTION_TYPES);

export function isOptimisationActionType(value: unknown): value is OptimisationActionType {
  return typeof value === "string" && OPTIMISATION_ACTION_TYPE_SET.has(value);
}

/**
 * Experiment dimension vocabulary (F5). A proposal names the dimensions an
 * experiment would manipulate; policy may prohibit any of them. Dimensions
 * outside this list fail proposal validation (fail closed).
 */
export const EXPERIMENT_DIMENSIONS = [
  "channel",
  "audience",
  "creative",
  "budget",
  "schedule",
  "placement",
  "bidding",
  "pricing",
  "messaging",
] as const;

export type ExperimentDimension = (typeof EXPERIMENT_DIMENSIONS)[number];

const EXPERIMENT_DIMENSION_SET: ReadonlySet<string> = new Set(EXPERIMENT_DIMENSIONS);

export function isExperimentDimension(value: unknown): value is ExperimentDimension {
  return typeof value === "string" && EXPERIMENT_DIMENSION_SET.has(value);
}

/**
 * Protected / sensitive trait vocabulary (F5, F7). Optimisation must never
 * target or manipulate these traits. A proposal declaring it touches any of
 * them is BLOCKED; the declaration itself cannot be waived downstream.
 */
export const PROTECTED_TRAITS = [
  "race",
  "ethnicity",
  "national_origin",
  "religion",
  "political_belief",
  "health_condition",
  "sexual_orientation",
  "gender_identity",
  "disability",
  "financial_hardship",
] as const;

export type ProtectedTrait = (typeof PROTECTED_TRAITS)[number];

const PROTECTED_TRAIT_SET: ReadonlySet<string> = new Set(PROTECTED_TRAITS);

export function isProtectedTrait(value: unknown): value is ProtectedTrait {
  return typeof value === "string" && PROTECTED_TRAIT_SET.has(value);
}

/** Default (pre-policy) risk class per action type. Policy may only narrow. */
export function defaultRiskClassForAction(actionType: OptimisationActionType): number {
  // Returns an ordinal into the risk ranking; the decision engine maps to a tier.
  switch (actionType) {
    case "LEARNING_PROMOTION":
    case "STRATEGY_RECOMMENDATION":
    case "EXPERIMENT_STOP":
      return 0; // low
    case "BUDGET_REALLOCATE":
    case "BUDGET_DECREASE":
    case "CHANNEL_REALLOCATE":
    case "AUDIENCE_REALLOCATE":
    case "CAMPAIGN_PRIORITY_CHANGE":
    case "EXPERIMENT_CREATE":
    case "EXPERIMENT_ACTIVATE":
      return 1; // medium
    case "BUDGET_INCREASE":
      return 2; // high
  }
}

/**
 * Base financial impact class per action type, before deltas are examined.
 * The decision engine derives the authoritative class from the action type +
 * proposal material (allocation deltas, commitment/irreversibility flags); a
 * client-supplied advisory class that is LESS severe than the derived class
 * is recorded as a mismatch and never widens authority.
 */
export function baseFinancialClassForAction(
  actionType: OptimisationActionType
): OptimisationFinancialImpactClass {
  switch (actionType) {
    case "LEARNING_PROMOTION":
    case "STRATEGY_RECOMMENDATION":
      return "RECOMMENDATION_ONLY";
    case "BUDGET_INCREASE":
      return "TOTAL_BUDGET_INCREASE";
    case "EXPERIMENT_CREATE":
    case "EXPERIMENT_ACTIVATE":
      // An experiment spends budget; whether that raises the approved total
      // depends on the deltas, examined by the financial governor.
      return "REALLOCATION_WITHIN_APPROVED_TOTAL";
    case "EXPERIMENT_STOP":
    case "BUDGET_DECREASE":
      // Stopping/releasing returns budget inside the approved total.
      return "REALLOCATION_WITHIN_APPROVED_TOTAL";
    case "BUDGET_REALLOCATE":
    case "CHANNEL_REALLOCATE":
    case "AUDIENCE_REALLOCATE":
    case "CAMPAIGN_PRIORITY_CHANGE":
      return "REALLOCATION_WITHIN_APPROVED_TOTAL";
  }
}

/** True when the action type can never move money by itself. */
export function isRecommendationOnlyAction(actionType: OptimisationActionType): boolean {
  return baseFinancialClassForAction(actionType) === "RECOMMENDATION_ONLY";
}

/** All financial impact classes, exported for policy validation reuse. */
export const FINANCIAL_IMPACT_CLASSES: readonly OptimisationFinancialImpactClass[] =
  OPTIMISATION_FINANCIAL_IMPACT_CLASSES;
