/**
 * R7-F — Financial governance acceptance (F3).
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_OPTIMISATION_GOVERNANCE_POLICY as POLICY } from "./optimisation-policy";
import {
  deriveFinancialImpactClass,
  evaluateOptimisationFinancialGovernance,
  validateOptimisationBudgetAuthoritySnapshot,
  type OptimisationBudgetAuthoritySnapshot,
  type OptimisationProposalFinancial,
} from "./optimisation-financial-governance";

const NOW = "2026-11-05T12:00:00.000Z";

function budget(overrides: Partial<OptimisationBudgetAuthoritySnapshot> = {}): OptimisationBudgetAuthoritySnapshot {
  return {
    budgetPeriod: "2026-11",
    currency: "USD",
    approvedTotalBudgetMinor: 1_000_000,
    committedMinor: 400_000,
    reservedMinor: 50_000,
    supportedProviders: ["meta", "google"],
    lockedAllocationKeys: ["camp:locked"],
    stateCapturedAt: "2026-11-05T11:59:00.000Z",
    ...overrides,
  };
}

function financial(deltas: Array<Partial<OptimisationProposalFinancial["allocationDeltas"][number]>>): OptimisationProposalFinancial {
  return {
    currency: "USD",
    allocationDeltas: deltas.map((d) => ({
      allocationKey: "camp:a",
      campaignId: null,
      provider: null,
      deltaMinor: 0,
      ...d,
    })) as OptimisationProposalFinancial["allocationDeltas"],
  };
}

describe("budget authority snapshot validation", () => {
  it("accepts a well-formed snapshot", () => {
    expect(() => validateOptimisationBudgetAuthoritySnapshot(budget())).not.toThrow();
  });
  it("fails closed on malformed snapshots", () => {
    expect(() => validateOptimisationBudgetAuthoritySnapshot(null)).toThrow();
    expect(() => validateOptimisationBudgetAuthoritySnapshot({ ...budget(), approvedTotalBudgetMinor: -1 })).toThrow();
    expect(() => validateOptimisationBudgetAuthoritySnapshot({ ...budget(), currency: "usd" })).toThrow();
    expect(() => validateOptimisationBudgetAuthoritySnapshot({ ...budget(), stateCapturedAt: "not-a-date" })).toThrow();
    expect(() => validateOptimisationBudgetAuthoritySnapshot({ ...budget(), lockedAllocationKeys: [1] })).toThrow();
  });
});

describe("financial impact classification", () => {
  it("recommendation-only actions carry no financial class movement", () => {
    expect(deriveFinancialImpactClass("LEARNING_PROMOTION", null)).toBe("RECOMMENDATION_ONLY");
    expect(deriveFinancialImpactClass("STRATEGY_RECOMMENDATION", null)).toBe("RECOMMENDATION_ONLY");
  });

  it("zero-sum deltas are reallocations; positive totals are increases", () => {
    expect(
      deriveFinancialImpactClass("BUDGET_REALLOCATE", financial([
        { allocationKey: "camp:a", deltaMinor: -10_000 },
        { allocationKey: "camp:b", deltaMinor: 10_000 },
      ]))
    ).toBe("REALLOCATION_WITHIN_APPROVED_TOTAL");
    expect(
      deriveFinancialImpactClass("BUDGET_REALLOCATE", financial([{ allocationKey: "camp:a", deltaMinor: 10_000 }]))
    ).toBe("TOTAL_BUDGET_INCREASE");
    expect(deriveFinancialImpactClass("BUDGET_INCREASE", financial([{ allocationKey: "camp:a", deltaMinor: 1 }]))).toBe(
      "TOTAL_BUDGET_INCREASE"
    );
  });

  it("commitment and irreversibility declarations raise the class", () => {
    expect(
      deriveFinancialImpactClass("BUDGET_REALLOCATE", financial([
        { allocationKey: "camp:a", deltaMinor: -5_000 },
        { allocationKey: "camp:b", deltaMinor: 5_000, newCommitment: true },
      ]))
    ).toBe("NEW_FINANCIAL_COMMITMENT");
    expect(
      deriveFinancialImpactClass("BUDGET_REALLOCATE", financial([
        { allocationKey: "camp:a", deltaMinor: -5_000, irreversibleExternalSpend: true },
        { allocationKey: "camp:b", deltaMinor: 5_000 },
      ]))
    ).toBe("IRREVERSIBLE_EXTERNAL_SPEND");
  });
});

describe("financial governance evaluation", () => {
  it("autonomous in-budget reallocation stays financially autonomous", () => {
    const result = evaluateOptimisationFinancialGovernance({
      actionType: "BUDGET_REALLOCATE",
      financial: financial([
        { allocationKey: "camp:a", deltaMinor: -10_000 },
        { allocationKey: "camp:b", deltaMinor: 10_000, provider: "meta" },
      ]),
      policy: POLICY,
      budget: budget(),
      now: NOW,
    });
    expect(result.financialImpactClass).toBe("REALLOCATION_WITHIN_APPROVED_TOTAL");
    expect(result.financiallyAutonomous).toBe(true);
    expect(result.blockReasonCodes).toEqual([]);
    expect(result.reviewReasonCodes).toEqual([]);
  });

  it("stale budget state blocks (AC7)", () => {
    const result = evaluateOptimisationFinancialGovernance({
      actionType: "BUDGET_REALLOCATE",
      financial: financial([
        { allocationKey: "camp:a", deltaMinor: -1_000 },
        { allocationKey: "camp:b", deltaMinor: 1_000 },
      ]),
      policy: POLICY,
      budget: budget({ stateCapturedAt: "2026-11-05T11:00:00.000Z" }),
      now: NOW,
    });
    expect(result.blockReasonCodes).toContain("STALE_BUDGET_STATE");
    expect(result.financiallyAutonomous).toBe(false);
  });

  it("locked sources and unsupported providers block", () => {
    const locked = evaluateOptimisationFinancialGovernance({
      actionType: "BUDGET_REALLOCATE",
      financial: financial([
        { allocationKey: "camp:locked", deltaMinor: -10_000 },
        { allocationKey: "camp:b", deltaMinor: 10_000 },
      ]),
      policy: POLICY,
      budget: budget(),
      now: NOW,
    });
    expect(locked.blockReasonCodes).toContain("REALLOCATION_SOURCE_LOCKED");

    const unsupported = evaluateOptimisationFinancialGovernance({
      actionType: "BUDGET_REALLOCATE",
      financial: financial([
        { allocationKey: "camp:a", deltaMinor: -10_000 },
        { allocationKey: "camp:b", deltaMinor: 10_000, provider: "snapchat" },
      ]),
      policy: POLICY,
      budget: budget(),
      now: NOW,
    });
    expect(unsupported.blockReasonCodes).toContain("UNSUPPORTED_PROVIDER");
  });

  it("exceeding the autonomous cap or fraction forces review", () => {
    const overCap = evaluateOptimisationFinancialGovernance({
      actionType: "BUDGET_REALLOCATE",
      financial: financial([
        { allocationKey: "camp:a", deltaMinor: -60_000 },
        { allocationKey: "camp:b", deltaMinor: 60_000 },
      ]),
      policy: POLICY,
      budget: budget(),
      now: NOW,
    });
    expect(overCap.reviewReasonCodes).toContain("REALLOCATION_EXCEEDS_AUTONOMOUS_CAP");
    expect(overCap.financiallyAutonomous).toBe(false);

    const overFraction = evaluateOptimisationFinancialGovernance({
      actionType: "BUDGET_REALLOCATE",
      financial: financial([
        { allocationKey: "camp:a", deltaMinor: -60_000 },
        { allocationKey: "camp:b", deltaMinor: 60_000 },
      ]),
      policy: POLICY,
      budget: budget({ approvedTotalBudgetMinor: 200_000 }),
      now: NOW,
    });
    expect(overFraction.reviewReasonCodes).toContain("REALLOCATION_EXCEEDS_FRACTION_LIMIT");
  });

  it("total budget increase never auto-authorizes under the default policy (AC9)", () => {
    const result = evaluateOptimisationFinancialGovernance({
      actionType: "BUDGET_INCREASE",
      financial: financial([{ allocationKey: "camp:a", deltaMinor: 1_000 }]),
      policy: POLICY,
      budget: budget(),
      now: NOW,
    });
    expect(result.financialImpactClass).toBe("TOTAL_BUDGET_INCREASE");
    expect(result.reviewReasonCodes).toContain("TOTAL_BUDGET_INCREASE_REQUIRES_APPROVAL");
    expect(result.financiallyAutonomous).toBe(false);
  });

  it("an explicitly configured bounded envelope may allow small increases", () => {
    const permissive = {
      ...POLICY,
      financial: {
        ...POLICY.financial,
        allowAutonomousTotalIncrease: true,
        maxAutonomousIncreasePerActionMinor: 5_000,
      },
    };
    const small = evaluateOptimisationFinancialGovernance({
      actionType: "BUDGET_INCREASE",
      financial: financial([{ allocationKey: "camp:a", deltaMinor: 4_000 }]),
      policy: permissive,
      budget: budget(),
      now: NOW,
    });
    expect(small.financiallyAutonomous).toBe(true);
    const large = evaluateOptimisationFinancialGovernance({
      actionType: "BUDGET_INCREASE",
      financial: financial([{ allocationKey: "camp:a", deltaMinor: 6_000 }]),
      policy: permissive,
      budget: budget(),
      now: NOW,
    });
    expect(large.financiallyAutonomous).toBe(false);
    expect(large.reviewReasonCodes).toContain("TOTAL_BUDGET_INCREASE_REQUIRES_APPROVAL");
  });

  it("client understatement of the financial class is recorded, never honoured", () => {
    const result = evaluateOptimisationFinancialGovernance({
      actionType: "BUDGET_INCREASE",
      financial: {
        ...financial([{ allocationKey: "camp:a", deltaMinor: 1_000 }]),
        advisoryFinancialClass: "RECOMMENDATION_ONLY",
      },
      policy: POLICY,
      budget: budget(),
      now: NOW,
    });
    expect(result.financialImpactClass).toBe("TOTAL_BUDGET_INCREASE");
    expect(result.infoReasonCodes).toContain("FINANCIAL_CLASS_DECLARATION_MISMATCH");
    expect(result.financiallyAutonomous).toBe(false);
  });
});
