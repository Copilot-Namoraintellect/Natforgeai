/**
 * R7-F — Optimisation action taxonomy acceptance (F2).
 */
import { describe, it, expect } from "vitest";
import {
  baseFinancialClassForAction,
  EXPERIMENT_DIMENSIONS,
  isExperimentDimension,
  isOptimisationActionType,
  isProtectedTrait,
  OPTIMISATION_ACTION_TYPES,
  PROTECTED_TRAITS,
} from "./optimisation-action-taxonomy";
import { isExperimentActionType } from "./optimisation-experiment-governance";

describe("F2 closed action taxonomy", () => {
  it("registers the programme action types and blocks unknowns", () => {
    expect(OPTIMISATION_ACTION_TYPES).toContain("LEARNING_PROMOTION");
    expect(OPTIMISATION_ACTION_TYPES).toContain("EXPERIMENT_CREATE");
    expect(OPTIMISATION_ACTION_TYPES).toContain("EXPERIMENT_ACTIVATE");
    expect(OPTIMISATION_ACTION_TYPES).toContain("EXPERIMENT_STOP");
    expect(OPTIMISATION_ACTION_TYPES).toContain("BUDGET_REALLOCATE");
    expect(OPTIMISATION_ACTION_TYPES).toContain("BUDGET_INCREASE");
    expect(OPTIMISATION_ACTION_TYPES).toContain("BUDGET_DECREASE");
    expect(OPTIMISATION_ACTION_TYPES).toContain("CHANNEL_REALLOCATE");
    expect(OPTIMISATION_ACTION_TYPES).toContain("AUDIENCE_REALLOCATE");
    expect(OPTIMISATION_ACTION_TYPES).toContain("CAMPAIGN_PRIORITY_CHANGE");
    expect(OPTIMISATION_ACTION_TYPES).toContain("STRATEGY_RECOMMENDATION");
    for (const t of OPTIMISATION_ACTION_TYPES) {
      expect(isOptimisationActionType(t)).toBe(true);
    }
    expect(isOptimisationActionType("DELETE_DATABASE")).toBe(false);
    expect(isOptimisationActionType("SHELL_EXEC")).toBe(false);
  });

  it("recommendation-only actions never move money in the base class", () => {
    expect(baseFinancialClassForAction("LEARNING_PROMOTION")).toBe("RECOMMENDATION_ONLY");
    expect(baseFinancialClassForAction("STRATEGY_RECOMMENDATION")).toBe("RECOMMENDATION_ONLY");
    expect(baseFinancialClassForAction("BUDGET_INCREASE")).toBe("TOTAL_BUDGET_INCREASE");
    expect(baseFinancialClassForAction("BUDGET_REALLOCATE")).toBe(
      "REALLOCATION_WITHIN_APPROVED_TOTAL"
    );
  });
});

describe("experiment dimension + protected trait vocabularies", () => {
  it("dimensions are closed", () => {
    expect(EXPERIMENT_DIMENSIONS).toContain("channel");
    expect(EXPERIMENT_DIMENSIONS).toContain("budget");
    expect(isExperimentDimension("pricing")).toBe(true);
    expect(isExperimentDimension("customer_soul")).toBe(false);
  });

  it("protected traits are closed", () => {
    expect(PROTECTED_TRAITS).toContain("race");
    expect(PROTECTED_TRAITS).toContain("health_condition");
    expect(isProtectedTrait("race")).toBe(true);
    expect(isProtectedTrait("eye_color")).toBe(false);
  });

  it("experiment action guard covers create/activate/stop only", () => {
    expect(isExperimentActionType("EXPERIMENT_CREATE")).toBe(true);
    expect(isExperimentActionType("EXPERIMENT_STOP")).toBe(true);
    expect(isExperimentActionType("BUDGET_REALLOCATE")).toBe(false);
  });
});
