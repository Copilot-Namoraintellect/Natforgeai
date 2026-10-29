// ─── R8-F Strategic Intelligence Governance — versioned policy registry ───
//
// Server-side, versioned, immutable per version. No model, client or agent
// may alter policy at runtime; there is NO policy mutation endpoint. New
// versions are code-level registry artefacts registered at module scope.
// Where a policy knob is absent, the conservative default applies — it never
// fabricates permissive criteria (F8 rogue-agent rules: an agent must never be
// able to modify policy thresholds, promote source trust, or lower risk —
// AC29/AC30/AC31).
//
// Policy version identity binds every governance decision; a stale policy
// version at evaluation or consumption time fails closed.

import {
  canonicalJson,
  DEFAULT_STRATEGIC_POLICY_VERSION,
  STRATEGIC_CONFIDENCE_CLASSES,
  STRATEGIC_EVIDENCE_TRUST_CLASSES,
  STRATEGIC_RISK_CLASSES,
  StrategicGovernanceInputError,
  StrategicGovernanceStateConflictError,
  StrategicGovernanceValidationError,
  type StrategicConfidenceClass,
  type StrategicEvidenceTrustClass,
  type StrategicRiskClass,
} from "./strategic-governance-contract";

export const STRATEGIC_POLICY_VERSION_PATTERN = /^[a-z0-9-]+\/v\d+$/;
export const MAX_STRATEGIC_POLICY_VERSION_LENGTH = 96;

/** Dispositions the risk mapping may produce (BLOCK < REVIEW_REQUIRED < ALLOW_RECOMMENDATION). */
export const STRATEGIC_RISK_DISPOSITIONS = [
  "ALLOW_RECOMMENDATION",
  "REVIEW_REQUIRED",
  "BLOCK",
] as const;
export type StrategicRiskDisposition = (typeof STRATEGIC_RISK_DISPOSITIONS)[number];

const HOURS_MS = 60 * 60 * 1000;
const DAYS_MS = 24 * HOURS_MS;

export interface StrategicGovernancePolicy {
  readonly policyVersion: string;
  /** Risk class -> disposition. Validated monotone non-increasing in autonomy. */
  readonly riskDispositions: Readonly<Record<StrategicRiskClass, StrategicRiskDisposition>>;
  /** Decision validity window; also the approval binding expiry basis. */
  readonly maxDecisionValidityMs: number;
  /** F3 — confidence ceilings implied by each evidence trust class. */
  readonly confidenceCeilings: Readonly<Record<StrategicEvidenceTrustClass, StrategicConfidenceClass>>;
  /** Confidence floor for ANY autonomous recommendation. */
  readonly minConfidenceForAutonomousRecommendation: StrategicConfidenceClass;
  /** F4 — HIGH/CRITICAL impact requires at least this derived confidence. */
  readonly minConfidenceForHighImpact: StrategicConfidenceClass;
  /** F3 — evidence older than this cannot justify a current recommendation. */
  readonly maxEvidenceAgeMs: number;
  /** Disposition for recommendation types outside the closed taxonomy: always BLOCK. */
  readonly unknownTypeDisposition: "BLOCK";
}

/**
 * Conservative server-side default policy. Nothing widens authority by
 * default: risk >= MEDIUM requires human review; CRITICAL is blocked
 * outright; confidence below MEDIUM can never be voiced autonomously; HIGH
 * impact requires HIGH derived confidence; stale evidence cannot justify a
 * current claim.
 */
export const DEFAULT_STRATEGIC_GOVERNANCE_POLICY: StrategicGovernancePolicy = Object.freeze({
  policyVersion: DEFAULT_STRATEGIC_POLICY_VERSION,
  riskDispositions: Object.freeze({
    LOW: "ALLOW_RECOMMENDATION",
    MEDIUM: "REVIEW_REQUIRED",
    HIGH: "REVIEW_REQUIRED",
    CRITICAL: "BLOCK",
  }),
  maxDecisionValidityMs: 24 * HOURS_MS,
  confidenceCeilings: Object.freeze({
    AUTHORITATIVE_INTERNAL: "HIGH",
    VERIFIED_EXTERNAL: "HIGH",
    CORROBORATED_EXTERNAL: "MEDIUM",
    SINGLE_EXTERNAL_SOURCE: "LOW",
    UNVERIFIED: "LOW",
    CONTRADICTED: "NONE",
    MALFORMED: "NONE",
  }),
  minConfidenceForAutonomousRecommendation: "MEDIUM",
  minConfidenceForHighImpact: "HIGH",
  maxEvidenceAgeMs: 30 * DAYS_MS,
  unknownTypeDisposition: "BLOCK",
});

function isConfidence(value: unknown): value is StrategicConfidenceClass {
  return (
    typeof value === "string" && (STRATEGIC_CONFIDENCE_CLASSES as readonly string[]).includes(value)
  );
}

const AUTONOMY_RANK: Record<StrategicRiskDisposition, number> = {
  ALLOW_RECOMMENDATION: 2,
  REVIEW_REQUIRED: 1,
  BLOCK: 0,
};

/** Validates the full policy shape and ranges; throws INVALID_POLICY on drift. */
export function assertStrategicGovernancePolicy(policy: StrategicGovernancePolicy): void {
  function fail(message: string): never {
    throw new StrategicGovernanceValidationError("INVALID_POLICY", message);
  }
  if (policy === null || typeof policy !== "object") fail("policy must be an object");
  if (
    typeof policy.policyVersion !== "string" ||
    policy.policyVersion.length === 0 ||
    policy.policyVersion.length > MAX_STRATEGIC_POLICY_VERSION_LENGTH ||
    !STRATEGIC_POLICY_VERSION_PATTERN.test(policy.policyVersion)
  ) {
    fail(
      `policyVersion must match ${STRATEGIC_POLICY_VERSION_PATTERN} and be ≤ ${MAX_STRATEGIC_POLICY_VERSION_LENGTH} chars`
    );
  }
  if (policy.policyVersion === DEFAULT_STRATEGIC_GOVERNANCE_POLICY.policyVersion) {
    if (canonicalJson(policy) !== canonicalJson(DEFAULT_STRATEGIC_GOVERNANCE_POLICY)) {
      fail("the default policy version is reserved by the default policy content");
    }
    return;
  }
  const rd = policy.riskDispositions as Record<string, unknown>;
  if (rd === null || typeof rd !== "object") fail("riskDispositions must be an object");
  for (const risk of STRATEGIC_RISK_CLASSES) {
    if (!(STRATEGIC_RISK_DISPOSITIONS as readonly string[]).includes(rd[risk] as string)) {
      fail(`riskDispositions.${risk} must be one of ${STRATEGIC_RISK_DISPOSITIONS.join(",")}`);
    }
  }
  // Hard invariant: higher risk can only reduce autonomy, never expand it.
  for (let i = 1; i < STRATEGIC_RISK_CLASSES.length; i++) {
    const lower = STRATEGIC_RISK_CLASSES[i - 1];
    const higher = STRATEGIC_RISK_CLASSES[i];
    if (
      AUTONOMY_RANK[rd[higher] as StrategicRiskDisposition] >
      AUTONOMY_RANK[rd[lower] as StrategicRiskDisposition]
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
  const ceilings = policy.confidenceCeilings as Record<string, unknown>;
  if (ceilings === null || typeof ceilings !== "object") fail("confidenceCeilings must be an object");
  for (const trust of STRATEGIC_EVIDENCE_TRUST_CLASSES) {
    if (!isConfidence(ceilings[trust])) {
      fail(`confidenceCeilings.${trust} must be one of ${STRATEGIC_CONFIDENCE_CLASSES.join(",")}`);
    }
  }
  // Hard invariant: higher trust can only raise (or keep) the confidence ceiling.
  const CEILING_RANK: Record<StrategicConfidenceClass, number> = {
    NONE: 0,
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
  };
  const trustOrder: readonly StrategicEvidenceTrustClass[] = [
    "MALFORMED",
    "CONTRADICTED",
    "UNVERIFIED",
    "SINGLE_EXTERNAL_SOURCE",
    "CORROBORATED_EXTERNAL",
    "VERIFIED_EXTERNAL",
    "AUTHORITATIVE_INTERNAL",
  ];
  for (let i = 1; i < trustOrder.length; i++) {
    const lowerTrust = trustOrder[i - 1];
    const higherTrust = trustOrder[i];
    if (
      CEILING_RANK[ceilings[higherTrust] as StrategicConfidenceClass] <
      CEILING_RANK[ceilings[lowerTrust] as StrategicConfidenceClass]
    ) {
      fail(
        `confidenceCeilings.${higherTrust} is lower than ${lowerTrust}; higher trust can only raise the confidence ceiling`
      );
    }
  }
  if (!isConfidence(policy.minConfidenceForAutonomousRecommendation)) {
    fail("minConfidenceForAutonomousRecommendation must be a closed confidence class");
  }
  if (!isConfidence(policy.minConfidenceForHighImpact)) {
    fail("minConfidenceForHighImpact must be a closed confidence class");
  }
  if (
    CEILING_RANK[policy.minConfidenceForHighImpact] <
    CEILING_RANK[policy.minConfidenceForAutonomousRecommendation]
  ) {
    fail("minConfidenceForHighImpact cannot be lower than minConfidenceForAutonomousRecommendation");
  }
  if (
    typeof policy.maxEvidenceAgeMs !== "number" ||
    !Number.isFinite(policy.maxEvidenceAgeMs) ||
    policy.maxEvidenceAgeMs <= 0
  ) {
    fail("maxEvidenceAgeMs must be a positive finite number");
  }
  if (policy.unknownTypeDisposition !== "BLOCK") {
    fail("unknownTypeDisposition must be BLOCK (unknown recommendation types can never proceed)");
  }
}

// ─── Code-level registry (immutable per version; no runtime mutation) ───

const registry = new Map<string, StrategicGovernancePolicy>();

/**
 * Registers a policy artefact. Same policyVersion + deep-equal content is an
 * idempotent no-op; same version with different content fails closed with
 * POLICY_VERSION_CONFLICT — versions are immutable.
 */
export function registerStrategicGovernancePolicy(policy: StrategicGovernancePolicy): void {
  assertStrategicGovernancePolicy(policy);
  const existing = registry.get(policy.policyVersion);
  if (existing) {
    if (canonicalJson(existing) === canonicalJson(policy)) return;
    throw new StrategicGovernanceStateConflictError(
      "POLICY_VERSION_CONFLICT",
      `policyVersion ${policy.policyVersion} is already registered with different content`
    );
  }
  if (policy.policyVersion === DEFAULT_STRATEGIC_GOVERNANCE_POLICY.policyVersion) {
    // Default version is reserved by the default content (asserted above).
    return;
  }
  registry.set(
    policy.policyVersion,
    Object.freeze({
      ...policy,
      riskDispositions: Object.freeze({ ...policy.riskDispositions }),
      confidenceCeilings: Object.freeze({ ...policy.confidenceCeilings }),
    })
  );
}

/** Resolves a policy version; undefined resolves to the conservative default. */
export function getStrategicGovernancePolicy(
  policyVersion?: string
): StrategicGovernancePolicy {
  if (policyVersion === undefined) return DEFAULT_STRATEGIC_GOVERNANCE_POLICY;
  const registered = registry.get(policyVersion);
  if (registered) return registered;
  if (policyVersion === DEFAULT_STRATEGIC_GOVERNANCE_POLICY.policyVersion) {
    return DEFAULT_STRATEGIC_GOVERNANCE_POLICY;
  }
  throw new StrategicGovernanceInputError(
    "UNKNOWN_POLICY_VERSION",
    `unknown strategic governance policy version: ${policyVersion}`
  );
}

/** Lists all registered policies; the default conservative policy is always first. */
export function listStrategicGovernancePolicies(): StrategicGovernancePolicy[] {
  return [DEFAULT_STRATEGIC_GOVERNANCE_POLICY, ...registry.values()];
}
