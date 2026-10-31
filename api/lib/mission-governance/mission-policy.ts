// ─── R9-F Mission Governance & Approval — versioned policy registry ───
//
// Server-side, versioned, immutable per version. No model, client or agent
// may alter policy at runtime; there is NO policy mutation endpoint (an agent
// must never be able to modify its own thresholds or widen its own phase
// autonomy — charter F8). New versions are code-level registry artefacts
// registered at module scope. Where a knob is absent, the conservative
// default applies — it never fabricates permissive criteria.
//
// Policy version identity binds every governance decision; a stale policy
// version at evaluation or consumption time fails closed.

import {
  canonicalJson,
  DEFAULT_MISSION_POLICY_VERSION,
  DEFAULT_PROHIBITED_ACTION_TYPES,
  isMissionActionType,
  isMissionPhase,
  MISSION_ACTION_TYPES,
  MISSION_PHASES,
  MISSION_RISK_CLASSES,
  MissionGovernanceInputError,
  MissionGovernanceStateConflictError,
  MissionGovernanceValidationError,
  type MissionActionType,
  type MissionGovernanceDecision,
  type MissionPhase,
  type MissionRiskClass,
} from "./mission-governance-contract";

export const MISSION_POLICY_VERSION_PATTERN = /^[a-z0-9-]+\/v\d+$/;
export const MAX_MISSION_POLICY_VERSION_LENGTH = 96;

const HOURS_MS = 60 * 60 * 1000;

export interface MissionGovernancePolicy {
  readonly policyVersion: string;
  /** Risk class -> disposition. Validated monotone non-increasing in autonomy. */
  readonly riskDispositions: Readonly<Record<MissionRiskClass, MissionGovernanceDecision>>;
  /**
   * F2 phase separation: subjects in phases OUTSIDE this set can never
   * receive ALLOW — their disposition floors at REVIEW_REQUIRED. Default
   * excludes EXECUTION and LIFECYCLE (no phase escalation; execution and
   * lifecycle actions are never autonomous by default).
   */
  readonly autonomousPhases: readonly MissionPhase[];
  /** Actions that are durably BLOCKED regardless of risk (closed subset). */
  readonly prohibitedActionTypes: readonly MissionActionType[];
  /** Decision validity window; also the approval binding expiry basis. */
  readonly maxDecisionValidityMs: number;
  /** Max canonical-JSON size admitted for action params material. */
  readonly maxActionParamsBytes: number;
}

/**
 * Conservative server-side default policy. Nothing widens authority by
 * default: LOW risk may ALLOW formulation/planning/scheduling subjects only;
 * MEDIUM/HIGH require human review; CRITICAL is blocked outright; EXECUTION
 * and LIFECYCLE subjects (tasks, steps, retries, recoveries, escalations)
 * always require human review — planning authority never becomes execution
 * authority by default.
 */
export const DEFAULT_MISSION_GOVERNANCE_POLICY: MissionGovernancePolicy = Object.freeze({
  policyVersion: DEFAULT_MISSION_POLICY_VERSION,
  riskDispositions: Object.freeze({
    LOW: "ALLOW",
    MEDIUM: "REVIEW_REQUIRED",
    HIGH: "REVIEW_REQUIRED",
    CRITICAL: "BLOCK",
  }),
  autonomousPhases: Object.freeze(["FORMULATION", "PLANNING", "SCHEDULING"] as MissionPhase[]),
  prohibitedActionTypes: DEFAULT_PROHIBITED_ACTION_TYPES,
  maxDecisionValidityMs: 24 * HOURS_MS,
  maxActionParamsBytes: 16384,
});

const AUTONOMY_RANK: Record<MissionGovernanceDecision, number> = {
  ALLOW: 2,
  REVIEW_REQUIRED: 1,
  BLOCK: 0,
};

/** Validates the full policy shape and ranges; throws INVALID_POLICY on drift. */
export function assertMissionGovernancePolicy(policy: MissionGovernancePolicy): void {
  function fail(message: string): never {
    throw new MissionGovernanceValidationError("INVALID_POLICY", message);
  }
  if (policy === null || typeof policy !== "object") fail("policy must be an object");
  if (
    typeof policy.policyVersion !== "string" ||
    policy.policyVersion.length === 0 ||
    policy.policyVersion.length > MAX_MISSION_POLICY_VERSION_LENGTH ||
    !MISSION_POLICY_VERSION_PATTERN.test(policy.policyVersion)
  ) {
    fail(
      `policyVersion must match ${MISSION_POLICY_VERSION_PATTERN} and be ≤ ${MAX_MISSION_POLICY_VERSION_LENGTH} chars`
    );
  }
  if (policy.policyVersion === DEFAULT_MISSION_GOVERNANCE_POLICY.policyVersion) {
    if (canonicalJson(policy) !== canonicalJson(DEFAULT_MISSION_GOVERNANCE_POLICY)) {
      fail("the default policy version is reserved by the default policy content");
    }
    return;
  }
  const rd = policy.riskDispositions as Record<string, unknown>;
  if (rd === null || typeof rd !== "object") fail("riskDispositions must be an object");
  for (const risk of MISSION_RISK_CLASSES) {
    if (!["ALLOW", "REVIEW_REQUIRED", "BLOCK"].includes(rd[risk] as string)) {
      fail(`riskDispositions.${risk} must be one of ALLOW,REVIEW_REQUIRED,BLOCK`);
    }
  }
  // Hard invariant: higher risk can only reduce autonomy, never expand it.
  for (let i = 1; i < MISSION_RISK_CLASSES.length; i++) {
    const lower = MISSION_RISK_CLASSES[i - 1];
    const higher = MISSION_RISK_CLASSES[i];
    if (
      AUTONOMY_RANK[rd[higher] as MissionGovernanceDecision] >
      AUTONOMY_RANK[rd[lower] as MissionGovernanceDecision]
    ) {
      fail(
        `riskDispositions.${higher} grants more autonomy than ${lower}; higher risk can only reduce autonomy`
      );
    }
  }
  if (!Array.isArray(policy.autonomousPhases)) fail("autonomousPhases must be an array");
  for (const phase of policy.autonomousPhases) {
    if (!isMissionPhase(phase)) fail(`autonomousPhases contains unknown phase: ${String(phase)}`);
  }
  // Hard invariant: EXECUTION and LIFECYCLE are never in the default-set
  // widenings unless a version explicitly re-registers them — and even then
  // riskDispositions still governs. (No invariant against explicit versions:
  // a deliberate code-level policy version may grant execution autonomy for
  // LOW risk; it remains immutable, versioned and auditable.)
  if (!Array.isArray(policy.prohibitedActionTypes)) {
    fail("prohibitedActionTypes must be an array");
  }
  for (const action of policy.prohibitedActionTypes) {
    if (!isMissionActionType(action)) {
      fail(`prohibitedActionTypes contains unknown action: ${String(action)}`);
    }
  }
  if (
    typeof policy.maxDecisionValidityMs !== "number" ||
    !Number.isFinite(policy.maxDecisionValidityMs) ||
    policy.maxDecisionValidityMs <= 0
  ) {
    fail("maxDecisionValidityMs must be a positive finite number");
  }
  if (
    typeof policy.maxActionParamsBytes !== "number" ||
    !Number.isInteger(policy.maxActionParamsBytes) ||
    policy.maxActionParamsBytes <= 0 ||
    policy.maxActionParamsBytes > 65536
  ) {
    fail("maxActionParamsBytes must be a positive integer ≤ 65536");
  }
}

// ─── Code-level registry (immutable per version; no runtime mutation) ───

const registry = new Map<string, MissionGovernancePolicy>();

/**
 * Registers a policy artefact. Same policyVersion + deep-equal content is an
 * idempotent no-op; same version with different content fails closed with
 * POLICY_VERSION_CONFLICT — versions are immutable.
 */
export function registerMissionGovernancePolicy(policy: MissionGovernancePolicy): void {
  assertMissionGovernancePolicy(policy);
  const existing = registry.get(policy.policyVersion);
  if (existing) {
    if (canonicalJson(existing) === canonicalJson(policy)) return;
    throw new MissionGovernanceStateConflictError(
      "POLICY_VERSION_CONFLICT",
      `policyVersion ${policy.policyVersion} is already registered with different content`
    );
  }
  if (policy.policyVersion === DEFAULT_MISSION_GOVERNANCE_POLICY.policyVersion) {
    // Default version is reserved by the default content (asserted above).
    return;
  }
  registry.set(
    policy.policyVersion,
    Object.freeze({
      ...policy,
      riskDispositions: Object.freeze({ ...policy.riskDispositions }),
      autonomousPhases: Object.freeze([...policy.autonomousPhases]),
      prohibitedActionTypes: Object.freeze([...policy.prohibitedActionTypes]),
    })
  );
}

/** Resolves a policy version; undefined resolves to the conservative default. */
export function getMissionGovernancePolicy(policyVersion?: string): MissionGovernancePolicy {
  if (policyVersion === undefined) return DEFAULT_MISSION_GOVERNANCE_POLICY;
  const registered = registry.get(policyVersion);
  if (registered) return registered;
  if (policyVersion === DEFAULT_MISSION_GOVERNANCE_POLICY.policyVersion) {
    return DEFAULT_MISSION_GOVERNANCE_POLICY;
  }
  throw new MissionGovernanceInputError(
    "UNKNOWN_POLICY_VERSION",
    `unknown mission governance policy version: ${policyVersion}`
  );
}

/** Lists all registered policies; the default conservative policy is always first. */
export function listMissionGovernancePolicies(): MissionGovernancePolicy[] {
  return [DEFAULT_MISSION_GOVERNANCE_POLICY, ...registry.values()];
}
