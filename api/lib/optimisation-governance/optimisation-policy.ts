// ─── R7-F Optimisation Governance — versioned policy registry ───
//
// Server-side, versioned, immutable per version. No model, client or agent
// may alter policy at runtime; there is NO policy mutation endpoint. New
// versions are code-level registry artefacts registered at module scope.
// Where a policy knob is absent, the conservative default applies — it never
// fabricates permissive criteria (F7: an agent must never be able to modify
// its own policy, raise budget ceilings, or change approval thresholds).
//
// Policy version identity binds every governance decision; a stale policy
// version at evaluation or execution time fails closed.

import {
  canonicalJson,
  DEFAULT_OPTIMISATION_POLICY_VERSION,
  OptimisationGovernanceInputError,
  OptimisationGovernanceStateConflictError,
  OptimisationGovernanceValidationError,
  OPTIMISATION_FINANCIAL_IMPACT_CLASSES,
  OPTIMISATION_RISK_TIERS,
  type OptimisationRiskTier,
} from "./optimisation-governance-contract";
import {
  EXPERIMENT_DIMENSIONS,
  isExperimentDimension,
  isProtectedTrait,
  PROTECTED_TRAITS,
} from "./optimisation-action-taxonomy";

export const OPTIMISATION_POLICY_VERSION_PATTERN = /^[a-z0-9-]+\/v\d+$/;
export const MAX_OPTIMISATION_POLICY_VERSION_LENGTH = 96;

/** Dispositions the risk mapping may produce (BLOCK < REVIEW_REQUIRED < ALLOW). */
export const OPTIMISATION_RISK_DISPOSITIONS = ["ALLOW", "REVIEW_REQUIRED", "BLOCK"] as const;
export type OptimisationRiskDisposition = (typeof OPTIMISATION_RISK_DISPOSITIONS)[number];

const HOURS_MS = 60 * 60 * 1000;

export interface OptimisationGovernancePolicy {
  readonly policyVersion: string;
  /** Risk tier -> disposition. Validated monotone non-increasing in autonomy. */
  readonly riskDispositions: Readonly<Record<OptimisationRiskTier, OptimisationRiskDisposition>>;
  /** Decision validity window; also the approval binding expiry basis. */
  readonly maxDecisionValidityMs: number;
  /** F3 — financial authority boundaries. */
  readonly financial: {
    /** Max |delta| (minor units) a single autonomous reallocation may move. */
    readonly autonomousReallocationCapMinor: number;
    /** Max fraction of the approved total a single autonomous move may touch. */
    readonly maxAutonomousReallocationFraction: number;
    /**
     * Whether ANY autonomous total-budget increase is permitted. Default
     * false: an autonomous optimisation agent must never increase total
     * authorized business spend on its own recommendation (mission-critical
     * invariant, F3).
     */
    readonly allowAutonomousTotalIncrease: boolean;
    /** Max total-increase delta (minor) per action while autonomy is allowed. */
    readonly maxAutonomousIncreasePerActionMinor: number;
    /** New financial commitments outside the approved budget envelope. */
    readonly allowNewFinancialCommitments: boolean;
    /** Irreversible external spend (cannot be recalled once committed). */
    readonly allowIrreversibleExternalSpend: boolean;
    /** Budget authority snapshot older than this fails closed. */
    readonly staleBudgetStateMs: number;
  };
  /** F5 — experiment governance constraints (governs permission, not results). */
  readonly experiment: {
    readonly maxConcurrentExperiments: number;
    readonly maxExperimentBudgetMinor: number;
    readonly prohibitedDimensions: readonly string[];
    readonly minDurationDays: number;
    readonly maxDurationDays: number;
    readonly protectedTraits: readonly string[];
  };
  /** F6 — portfolio / concentration governance boundaries. */
  readonly portfolio: {
    /** No single allocation may exceed this fraction of the approved total. */
    readonly maxConcentrationFraction: number;
    /** No single reallocation move may exceed this fraction of the total. */
    readonly maxSingleShiftFraction: number;
    /** Minimum interval between moves touching the same allocation key. */
    readonly minReallocationIntervalMs: number;
    /** Learning older than this cannot authorize a budget movement. */
    readonly maxLearningAgeMs: number;
  };
  /** Disposition for action types outside the closed taxonomy: always BLOCK. */
  readonly unknownActionDisposition: "BLOCK";
}

/**
 * Conservative server-side default policy. Nothing widens authority by
 * default: no autonomous total-budget increase, no new commitments, no
 * irreversible spend; risk >= medium requires human review; critical is
 * blocked outright.
 */
export const DEFAULT_OPTIMISATION_GOVERNANCE_POLICY: OptimisationGovernancePolicy = Object.freeze({
  policyVersion: DEFAULT_OPTIMISATION_POLICY_VERSION,
  riskDispositions: Object.freeze({
    low: "ALLOW",
    medium: "REVIEW_REQUIRED",
    high: "REVIEW_REQUIRED",
    critical: "BLOCK",
  }),
  maxDecisionValidityMs: 24 * HOURS_MS,
  financial: Object.freeze({
    autonomousReallocationCapMinor: 50_000,
    maxAutonomousReallocationFraction: 0.05,
    allowAutonomousTotalIncrease: false,
    maxAutonomousIncreasePerActionMinor: 0,
    allowNewFinancialCommitments: false,
    allowIrreversibleExternalSpend: false,
    staleBudgetStateMs: 15 * 60 * 1000,
  }),
  experiment: Object.freeze({
    maxConcurrentExperiments: 3,
    maxExperimentBudgetMinor: 100_000,
    prohibitedDimensions: Object.freeze(["pricing", "bidding"]),
    minDurationDays: 1,
    maxDurationDays: 42,
    protectedTraits: Object.freeze([...PROTECTED_TRAITS]),
  }),
  portfolio: Object.freeze({
    maxConcentrationFraction: 0.5,
    maxSingleShiftFraction: 0.2,
    minReallocationIntervalMs: 24 * HOURS_MS,
    maxLearningAgeMs: 7 * 24 * HOURS_MS,
  }),
  unknownActionDisposition: "BLOCK",
});

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
}

const AUTONOMY_RANK: Record<OptimisationRiskDisposition, number> = {
  ALLOW: 2,
  REVIEW_REQUIRED: 1,
  BLOCK: 0,
};

/** Validates the full policy shape and ranges; throws INVALID_POLICY on drift. */
export function assertOptimisationGovernancePolicy(
  policy: OptimisationGovernancePolicy
): void {
  function fail(message: string): never {
    throw new OptimisationGovernanceValidationError("INVALID_POLICY", message);
  }
  if (policy === null || typeof policy !== "object") fail("policy must be an object");
  if (
    typeof policy.policyVersion !== "string" ||
    policy.policyVersion.length === 0 ||
    policy.policyVersion.length > MAX_OPTIMISATION_POLICY_VERSION_LENGTH ||
    !OPTIMISATION_POLICY_VERSION_PATTERN.test(policy.policyVersion)
  ) {
    fail(
      `policyVersion must match ${OPTIMISATION_POLICY_VERSION_PATTERN} and be ≤ ${MAX_OPTIMISATION_POLICY_VERSION_LENGTH} chars`
    );
  }
  if (policy.policyVersion === DEFAULT_OPTIMISATION_GOVERNANCE_POLICY.policyVersion) {
    if (canonicalJson(policy) !== canonicalJson(DEFAULT_OPTIMISATION_GOVERNANCE_POLICY)) {
      fail("the default policy version is reserved by the default policy content");
    }
    return;
  }
  const rd = policy.riskDispositions as Record<string, unknown>;
  if (rd === null || typeof rd !== "object") fail("riskDispositions must be an object");
  for (const tier of OPTIMISATION_RISK_TIERS) {
    if (!(OPTIMISATION_RISK_DISPOSITIONS as readonly string[]).includes(rd[tier] as string)) {
      fail(`riskDispositions.${tier} must be one of ${OPTIMISATION_RISK_DISPOSITIONS.join(",")}`);
    }
  }
  // Hard invariant: higher risk can only reduce autonomy, never expand it.
  for (let i = 1; i < OPTIMISATION_RISK_TIERS.length; i++) {
    const lower = OPTIMISATION_RISK_TIERS[i - 1];
    const higher = OPTIMISATION_RISK_TIERS[i];
    if (
      AUTONOMY_RANK[rd[higher] as OptimisationRiskDisposition] >
      AUTONOMY_RANK[rd[lower] as OptimisationRiskDisposition]
    ) {
      fail(
        `riskDispositions.${higher} grants more autonomy than ${lower}; higher risk can only reduce autonomy`
      );
    }
  }
  if (
    typeof policy.maxDecisionValidityMs !== "number" ||
    !Number.isFinite(policy.maxDecisionValidityMs) ||
    policy.maxDecisionValidityMs <= 0
  ) {
    fail("maxDecisionValidityMs must be a positive finite number");
  }
  const f = policy.financial as Record<string, unknown>;
  if (f === null || typeof f !== "object") fail("financial must be an object");
  if (!isNonNegativeInt(f.autonomousReallocationCapMinor)) {
    fail("financial.autonomousReallocationCapMinor must be a non-negative integer");
  }
  if (!isFraction(f.maxAutonomousReallocationFraction)) {
    fail("financial.maxAutonomousReallocationFraction must be in (0, 1]");
  }
  if (typeof f.allowAutonomousTotalIncrease !== "boolean") {
    fail("financial.allowAutonomousTotalIncrease must be a boolean");
  }
  const maxAutonomousIncreasePerActionMinor = f.maxAutonomousIncreasePerActionMinor;
  if (!isNonNegativeInt(maxAutonomousIncreasePerActionMinor)) {
    fail("financial.maxAutonomousIncreasePerActionMinor must be a non-negative integer");
  }
  // Invariant: an autonomous total-increase envelope requires the flag.
  if (maxAutonomousIncreasePerActionMinor > 0 && f.allowAutonomousTotalIncrease !== true) {
    fail(
      "financial.maxAutonomousIncreasePerActionMinor > 0 requires allowAutonomousTotalIncrease=true"
    );
  }
  if (typeof f.allowNewFinancialCommitments !== "boolean") {
    fail("financial.allowNewFinancialCommitments must be a boolean");
  }
  if (typeof f.allowIrreversibleExternalSpend !== "boolean") {
    fail("financial.allowIrreversibleExternalSpend must be a boolean");
  }
  if (
    typeof f.staleBudgetStateMs !== "number" ||
    !Number.isFinite(f.staleBudgetStateMs) ||
    f.staleBudgetStateMs <= 0
  ) {
    fail("financial.staleBudgetStateMs must be a positive finite number");
  }
  const e = policy.experiment as Record<string, unknown>;
  if (e === null || typeof e !== "object") fail("experiment must be an object");
  if (!Number.isInteger(e.maxConcurrentExperiments) || (e.maxConcurrentExperiments as number) <= 0) {
    fail("experiment.maxConcurrentExperiments must be a positive integer");
  }
  if (!isNonNegativeInt(e.maxExperimentBudgetMinor)) {
    fail("experiment.maxExperimentBudgetMinor must be a non-negative integer");
  }
  if (
    !Array.isArray(e.prohibitedDimensions) ||
    e.prohibitedDimensions.some((d) => !isExperimentDimension(d))
  ) {
    fail(`experiment.prohibitedDimensions must reference the closed dimension vocabulary`);
  }
  if (
    !Number.isInteger(e.minDurationDays) ||
    !Number.isInteger(e.maxDurationDays) ||
    (e.minDurationDays as number) <= 0 ||
    (e.maxDurationDays as number) < (e.minDurationDays as number)
  ) {
    fail("experiment duration bounds must be positive integers with max >= min");
  }
  if (
    !Array.isArray(e.protectedTraits) ||
    e.protectedTraits.some((t) => !isProtectedTrait(t))
  ) {
    fail("experiment.protectedTraits must reference the closed protected-trait vocabulary");
  }
  const p = policy.portfolio as Record<string, unknown>;
  if (p === null || typeof p !== "object") fail("portfolio must be an object");
  if (!isFraction(p.maxConcentrationFraction)) {
    fail("portfolio.maxConcentrationFraction must be in (0, 1]");
  }
  if (!isFraction(p.maxSingleShiftFraction)) {
    fail("portfolio.maxSingleShiftFraction must be in (0, 1]");
  }
  if (
    typeof p.minReallocationIntervalMs !== "number" ||
    !Number.isFinite(p.minReallocationIntervalMs) ||
    p.minReallocationIntervalMs < 0
  ) {
    fail("portfolio.minReallocationIntervalMs must be a non-negative finite number");
  }
  if (
    typeof p.maxLearningAgeMs !== "number" ||
    !Number.isFinite(p.maxLearningAgeMs) ||
    p.maxLearningAgeMs <= 0
  ) {
    fail("portfolio.maxLearningAgeMs must be a positive finite number");
  }
  if (policy.unknownActionDisposition !== "BLOCK") {
    fail("unknownActionDisposition must be BLOCK (unknown actions can never proceed)");
  }
}

// ─── Code-level registry (immutable per version; no runtime mutation) ───

const registry = new Map<string, OptimisationGovernancePolicy>();

/**
 * Registers a policy artefact. Same policyVersion + deep-equal content is an
 * idempotent no-op; same version with different content fails closed with
 * POLICY_VERSION_CONFLICT — versions are immutable.
 */
export function registerOptimisationGovernancePolicy(
  policy: OptimisationGovernancePolicy
): void {
  assertOptimisationGovernancePolicy(policy);
  const existing = registry.get(policy.policyVersion);
  if (existing) {
    if (canonicalJson(existing) === canonicalJson(policy)) return;
    throw new OptimisationGovernanceStateConflictError(
      "POLICY_VERSION_CONFLICT",
      `policyVersion ${policy.policyVersion} is already registered with different content`
    );
  }
  if (policy.policyVersion === DEFAULT_OPTIMISATION_GOVERNANCE_POLICY.policyVersion) {
    // Default version is reserved by the default content (asserted above).
    return;
  }
  registry.set(
    policy.policyVersion,
    Object.freeze({
      ...policy,
      riskDispositions: Object.freeze({ ...policy.riskDispositions }),
      financial: Object.freeze({ ...policy.financial }),
      experiment: Object.freeze({
        ...policy.experiment,
        prohibitedDimensions: Object.freeze([...policy.experiment.prohibitedDimensions]),
        protectedTraits: Object.freeze([...policy.experiment.protectedTraits]),
      }),
      portfolio: Object.freeze({ ...policy.portfolio }),
    })
  );
}

/** Resolves a policy version; undefined resolves to the conservative default. */
export function getOptimisationGovernancePolicy(
  policyVersion?: string
): OptimisationGovernancePolicy {
  if (policyVersion === undefined) return DEFAULT_OPTIMISATION_GOVERNANCE_POLICY;
  const registered = registry.get(policyVersion);
  if (registered) return registered;
  if (policyVersion === DEFAULT_OPTIMISATION_GOVERNANCE_POLICY.policyVersion) {
    return DEFAULT_OPTIMISATION_GOVERNANCE_POLICY;
  }
  throw new OptimisationGovernanceInputError(
    "UNKNOWN_POLICY_VERSION",
    `unknown optimisation governance policy version: ${policyVersion}`
  );
}

/** Lists all registered policies; the default conservative policy is always first. */
export function listOptimisationGovernancePolicies(): OptimisationGovernancePolicy[] {
  return [DEFAULT_OPTIMISATION_GOVERNANCE_POLICY, ...registry.values()];
}

/** Closed financial classes re-exported for engine convenience. */
export const FINANCIAL_CLASSES = OPTIMISATION_FINANCIAL_IMPACT_CLASSES;
export { EXPERIMENT_DIMENSIONS };
