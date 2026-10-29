/**
 * R7-F — Experiment governance acceptance (F5).
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_OPTIMISATION_GOVERNANCE_POLICY as POLICY } from "./optimisation-policy";
import {
  evaluateOptimisationExperimentGovernance,
  validateOptimisationExperimentAuthoritySnapshot,
  validateOptimisationProposalExperiment,
  type OptimisationProposalExperiment,
} from "./optimisation-experiment-governance";

const NOW = "2026-11-05T12:00:00.000Z";

function experiment(overrides: Partial<OptimisationProposalExperiment> = {}): OptimisationProposalExperiment {
  return {
    experimentKey: "exp-1",
    dimensions: ["creative"],
    budgetMinor: 10_000,
    durationDays: 14,
    touchesProtectedTraits: [],
    ...overrides,
  };
}

function authority(activeExperiments: number) {
  return { activeExperiments };
}

describe("experiment authority snapshot validation", () => {
  it("accepts well-formed and fails closed on malformed", () => {
    expect(validateOptimisationExperimentAuthoritySnapshot({ activeExperiments: 2 })).toEqual({
      activeExperiments: 2,
    });
    expect(() => validateOptimisationExperimentAuthoritySnapshot({ activeExperiments: -1 })).toThrow();
    expect(() => validateOptimisationExperimentAuthoritySnapshot(null)).toThrow();
  });
});

describe("experiment proposal validation", () => {
  it("rejects unknown dimensions and traits (fail closed)", () => {
    expect(() =>
      validateOptimisationProposalExperiment({ experimentKey: "e", dimensions: ["mind_control"], budgetMinor: 1, durationDays: 1, touchesProtectedTraits: [] })
    ).toThrow();
    expect(() =>
      validateOptimisationProposalExperiment({ experimentKey: "e", dimensions: ["creative"], budgetMinor: 1, durationDays: 1, touchesProtectedTraits: ["mood"] })
    ).toThrow();
  });
});

describe("experiment constraint evaluation", () => {
  it("non-experiment actions are out of scope", () => {
    const result = evaluateOptimisationExperimentGovernance({
      actionType: "BUDGET_REALLOCATE",
      experiment: null,
      policy: POLICY,
      authority: authority(0),
      now: NOW,
    });
    expect(result.isExperimentAction).toBe(false);
    expect(result.blockReasonCodes).toEqual([]);
  });

  it("a compliant experiment passes", () => {
    const result = evaluateOptimisationExperimentGovernance({
      actionType: "EXPERIMENT_CREATE",
      experiment: experiment(),
      policy: POLICY,
      authority: authority(0),
      now: NOW,
    });
    expect(result.blockReasonCodes).toEqual([]);
    expect(result.reviewReasonCodes).toEqual([]);
  });

  it("prohibited dimension blocks (AC17)", () => {
    const result = evaluateOptimisationExperimentGovernance({
      actionType: "EXPERIMENT_CREATE",
      experiment: experiment({ dimensions: ["pricing"] }),
      policy: POLICY,
      authority: authority(0),
      now: NOW,
    });
    expect(result.blockReasonCodes).toContain("EXPERIMENT_DIMENSION_PROHIBITED");
  });

  it("protected trait optimisation blocks (AC19)", () => {
    const result = evaluateOptimisationExperimentGovernance({
      actionType: "EXPERIMENT_CREATE",
      experiment: experiment({ touchesProtectedTraits: ["religion"] }),
      policy: POLICY,
      authority: authority(0),
      now: NOW,
    });
    expect(result.blockReasonCodes).toContain("PROTECTED_TRAIT_OPTIMISATION_BLOCKED");
  });

  it("budget above the policy ceiling requires review (AC16)", () => {
    const result = evaluateOptimisationExperimentGovernance({
      actionType: "EXPERIMENT_CREATE",
      experiment: experiment({ budgetMinor: 500_000 }),
      policy: POLICY,
      authority: authority(0),
      now: NOW,
    });
    expect(result.reviewReasonCodes).toContain("EXPERIMENT_BUDGET_EXCEEDS_LIMIT");
  });

  it("concurrency ceiling blocks (AC18)", () => {
    const result = evaluateOptimisationExperimentGovernance({
      actionType: "EXPERIMENT_CREATE",
      experiment: experiment(),
      policy: POLICY,
      authority: authority(3),
      now: NOW,
    });
    expect(result.blockReasonCodes).toContain("EXPERIMENT_CONCURRENCY_LIMIT_REACHED");
  });

  it("duration outside policy bounds requires review", () => {
    const tooLong = evaluateOptimisationExperimentGovernance({
      actionType: "EXPERIMENT_CREATE",
      experiment: experiment({ durationDays: 100 }),
      policy: POLICY,
      authority: authority(0),
      now: NOW,
    });
    expect(tooLong.reviewReasonCodes).toContain("EXPERIMENT_DURATION_OUT_OF_BOUNDS");
  });

  it("experiment stop is not subject to create/activate constraints", () => {
    const result = evaluateOptimisationExperimentGovernance({
      actionType: "EXPERIMENT_STOP",
      experiment: null,
      policy: POLICY,
      authority: authority(3),
      now: NOW,
    });
    expect(result.isExperimentAction).toBe(true);
    expect(result.blockReasonCodes).toEqual([]);
    expect(result.reviewReasonCodes).toEqual([]);
  });
});
