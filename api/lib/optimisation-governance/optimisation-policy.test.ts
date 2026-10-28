/**
 * R7-F — Optimisation governance policy registry acceptance.
 */
import { describe, it, expect } from "vitest";
import {
  assertOptimisationGovernancePolicy,
  DEFAULT_OPTIMISATION_GOVERNANCE_POLICY,
  getOptimisationGovernancePolicy,
  listOptimisationGovernancePolicies,
  registerOptimisationGovernancePolicy,
  type OptimisationGovernancePolicy,
} from "./optimisation-policy";
import {
  DEFAULT_OPTIMISATION_POLICY_VERSION,
  OptimisationGovernanceStateConflictError,
  OptimisationGovernanceInputError,
  OptimisationGovernanceValidationError,
} from "./optimisation-governance-contract";

describe("default conservative policy", () => {
  it("is valid and fails closed by default", () => {
    expect(() => assertOptimisationGovernancePolicy(DEFAULT_OPTIMISATION_GOVERNANCE_POLICY)).not.toThrow();
    expect(DEFAULT_OPTIMISATION_GOVERNANCE_POLICY.financial.allowAutonomousTotalIncrease).toBe(false);
    expect(DEFAULT_OPTIMISATION_GOVERNANCE_POLICY.financial.allowNewFinancialCommitments).toBe(false);
    expect(DEFAULT_OPTIMISATION_GOVERNANCE_POLICY.financial.allowIrreversibleExternalSpend).toBe(false);
    expect(DEFAULT_OPTIMISATION_GOVERNANCE_POLICY.riskDispositions.critical).toBe("BLOCK");
    expect(DEFAULT_OPTIMISATION_GOVERNANCE_POLICY.unknownActionDisposition).toBe("BLOCK");
  });

  it("resolves the default version without registration", () => {
    expect(getOptimisationGovernancePolicy()).toBe(DEFAULT_OPTIMISATION_GOVERNANCE_POLICY);
    expect(getOptimisationGovernancePolicy(DEFAULT_OPTIMISATION_POLICY_VERSION)).toBe(
      DEFAULT_OPTIMISATION_GOVERNANCE_POLICY
    );
  });

  it("unknown versions fail closed", () => {
    expect(() => getOptimisationGovernancePolicy("optimisation-governance-policy/v999")).toThrow(
      OptimisationGovernanceInputError
    );
  });
});

describe("policy registry immutability", () => {
  const altPolicy: OptimisationGovernancePolicy = {
    ...DEFAULT_OPTIMISATION_GOVERNANCE_POLICY,
    policyVersion: "optimisation-governance-policy/v2",
    financial: {
      ...DEFAULT_OPTIMISATION_GOVERNANCE_POLICY.financial,
      allowAutonomousTotalIncrease: true,
      maxAutonomousIncreasePerActionMinor: 10_000,
    },
  };

  it("registers new versions and lists default first", () => {
    registerOptimisationGovernancePolicy(altPolicy);
    expect(getOptimisationGovernancePolicy("optimisation-governance-policy/v2").policyVersion).toBe(
      "optimisation-governance-policy/v2"
    );
    expect(listOptimisationGovernancePolicies()[0]).toBe(DEFAULT_OPTIMISATION_GOVERNANCE_POLICY);
    // idempotent re-registration
    registerOptimisationGovernancePolicy(altPolicy);
  });

  it("same version with different content fails closed", () => {
    const conflicting: OptimisationGovernancePolicy = {
      ...altPolicy,
      financial: { ...altPolicy.financial, autonomousReallocationCapMinor: 999_000 },
    };
    expect(() => registerOptimisationGovernancePolicy(conflicting)).toThrow(
      OptimisationGovernanceStateConflictError
    );
  });

  it("rejects autonomy-widening risk mappings", () => {
    const bad: OptimisationGovernancePolicy = {
      ...DEFAULT_OPTIMISATION_GOVERNANCE_POLICY,
      policyVersion: "optimisation-governance-policy/v3",
      riskDispositions: { low: "BLOCK", medium: "ALLOW", high: "BLOCK", critical: "BLOCK" },
    };
    expect(() => registerOptimisationGovernancePolicy(bad)).toThrow(OptimisationGovernanceValidationError);
  });

  it("rejects an increase envelope without the autonomy flag", () => {
    const bad: OptimisationGovernancePolicy = {
      ...DEFAULT_OPTIMISATION_GOVERNANCE_POLICY,
      policyVersion: "optimisation-governance-policy/v4",
      financial: {
        ...DEFAULT_OPTIMISATION_GOVERNANCE_POLICY.financial,
        allowAutonomousTotalIncrease: false,
        maxAutonomousIncreasePerActionMinor: 5_000,
      },
    };
    expect(() => registerOptimisationGovernancePolicy(bad)).toThrow(OptimisationGovernanceValidationError);
  });
});
