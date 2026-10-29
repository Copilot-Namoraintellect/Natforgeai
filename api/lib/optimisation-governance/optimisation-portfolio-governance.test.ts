/**
 * R7-F — Portfolio / concentration governance acceptance (F6).
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_OPTIMISATION_GOVERNANCE_POLICY as POLICY } from "./optimisation-policy";
import {
  evaluateOptimisationPortfolioGovernance,
  validateOptimisationPortfolioAuthoritySnapshot,
  type OptimisationPortfolioAuthoritySnapshot,
} from "./optimisation-portfolio-governance";
import type { OptimisationAllocationDelta } from "./optimisation-financial-governance";

const NOW = "2026-11-05T12:00:00.000Z";

function authority(
  overrides: Partial<OptimisationPortfolioAuthoritySnapshot> = {}
): OptimisationPortfolioAuthoritySnapshot {
  return {
    currentAllocations: { "camp:a": 300_000, "camp:b": 200_000, "camp:c": 100_000 },
    lastReallocationAtByKey: {},
    ...overrides,
  };
}

function deltas(entries: Array<[string, number]>): readonly OptimisationAllocationDelta[] {
  return entries.map(([allocationKey, deltaMinor]) => ({
    allocationKey,
    campaignId: null,
    provider: null,
    deltaMinor,
  }));
}

describe("portfolio authority snapshot validation", () => {
  it("accepts well-formed and fails closed on malformed", () => {
    expect(() => validateOptimisationPortfolioAuthoritySnapshot(authority())).not.toThrow();
    expect(() =>
      validateOptimisationPortfolioAuthoritySnapshot({ currentAllocations: { "": 1 }, lastReallocationAtByKey: {} })
    ).toThrow();
    expect(() =>
      validateOptimisationPortfolioAuthoritySnapshot({
        currentAllocations: { a: 1 },
        lastReallocationAtByKey: { a: "not-a-date" },
      })
    ).toThrow();
  });
});

describe("portfolio constraint evaluation", () => {
  it("non-portfolio actions are out of scope", () => {
    const result = evaluateOptimisationPortfolioGovernance({
      actionType: "LEARNING_PROMOTION",
      deltas: [],
      policy: POLICY,
      authority: authority(),
      now: NOW,
    });
    expect(result.isPortfolioRelevant).toBe(false);
  });

  it("a balanced reallocation passes", () => {
    const result = evaluateOptimisationPortfolioGovernance({
      actionType: "BUDGET_REALLOCATE",
      deltas: deltas([["camp:a", -20_000], ["camp:b", 20_000]]),
      policy: POLICY,
      authority: authority(),
      now: NOW,
    });
    expect(result.blockReasonCodes).toEqual([]);
    expect(result.reviewReasonCodes).toEqual([]);
  });

  it("concentration ceiling is enforced against the authoritative allocations (AC20)", () => {
    // Move 250k onto camp:a -> 550k of 600k total (≈92%) > 50% ceiling.
    const result = evaluateOptimisationPortfolioGovernance({
      actionType: "BUDGET_REALLOCATE",
      deltas: deltas([["camp:b", -180_000], ["camp:c", -70_000], ["camp:a", 250_000]]),
      policy: POLICY,
      authority: authority(),
      now: NOW,
    });
    expect(result.reviewReasonCodes).toContain("CONCENTRATION_LIMIT_EXCEEDED");
  });

  it("sudden excessive shift requires review (AC21)", () => {
    // 120k single move on 600k total = 20% exactly at the 0.2 boundary; use 121k.
    const result = evaluateOptimisationPortfolioGovernance({
      actionType: "BUDGET_REALLOCATE",
      deltas: deltas([["camp:a", -121_000], ["camp:b", 121_000]]),
      policy: POLICY,
      authority: authority(),
      now: NOW,
    });
    expect(result.reviewReasonCodes).toContain("SUDDEN_REALLOCATION_SHIFT_LIMIT");
  });

  it("oscillation within the policy interval requires review (AC21 repeat leg)", () => {
    const result = evaluateOptimisationPortfolioGovernance({
      actionType: "BUDGET_REALLOCATE",
      deltas: deltas([["camp:a", -10_000], ["camp:b", 10_000]]),
      policy: POLICY,
      authority: authority({
        lastReallocationAtByKey: { "camp:a": "2026-11-05T06:00:00.000Z" },
      }),
      now: NOW,
    });
    expect(result.reviewReasonCodes).toContain("REALLOCATION_OSCILLATION_DETECTED");
  });

  it("a delta driving an allocation negative is malformed and blocked", () => {
    const result = evaluateOptimisationPortfolioGovernance({
      actionType: "BUDGET_REALLOCATE",
      deltas: deltas([["camp:a", -999_999]]),
      policy: POLICY,
      authority: authority(),
      now: NOW,
    });
    expect(result.blockReasonCodes).toContain("MALFORMED_PROPOSAL");
  });
});
