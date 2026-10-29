// ─── R8-F Strategic Intelligence Governance — canonical governance contract ───
//
// PURE contract module: closed vocabularies, version identities, deterministic
// id/hash derivations, typed error taxonomy, zod router-input schemas and
// canonical hashing helpers for the strategic-intelligence governance
// authority (docs/contracts/strategic-intelligence-governance-contract.md).
// It performs no I/O of any kind and authorizes nothing.
//
// A strategic governance decision is AUTHORITY derived from a validated
// recommendation proposal + versioned policy + SERVER-DERIVED evidence trust,
// confidence, strategic risk + tenant ownership only. No model sits in the
// decision path; no client may supply decisions, risk classes, confidence
// classes, source trust classes, reason codes, approval state or policy
// content. Model/agent output is proposal material only — never authority.
// The only possible outcomes are ALLOW_RECOMMENDATION / REVIEW_REQUIRED /
// BLOCK: there is deliberately NO EXECUTE outcome anywhere in this stream.

import { createHash } from "crypto";
import { z } from "zod";

export const STRATEGIC_GOVERNANCE_CONTRACT_VERSION = "strategic-governance/v1" as const;
export const STRATEGIC_GOVERNANCE_ENGINE_VERSION = "strategic-governance-engine/v1" as const;
export const DEFAULT_STRATEGIC_POLICY_VERSION = "strategic-governance-policy/v1" as const;

export const GOVERNANCE_DECISION_ID_PREFIX = "sgd1:" as const;
export const GOVERNANCE_DECISION_ID_PATTERN = /^sgd1:[a-f0-9]{64}$/;
export const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const EVIDENCE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_|-]{0,127}$/;
export const HEX_64 = /^[a-f0-9]{64}$/;

export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isIsoUtc(value: string): boolean {
  return ISO_UTC_PATTERN.test(value);
}

// ─── Closed governance decision vocabulary (F1) ───
//
// Exhaustive: downstream R8 streams and R9 must never invent additional
// outcomes. Anything outside this vocabulary is a programming error, not a
// decision. There is NO "EXECUTE" — a strategic recommendation is advisory
// authority only, even when allowed or human-approved.

export const STRATEGIC_GOVERNANCE_DECISIONS = [
  "ALLOW_RECOMMENDATION",
  "REVIEW_REQUIRED",
  "BLOCK",
] as const;
export type StrategicGovernanceDecision = (typeof STRATEGIC_GOVERNANCE_DECISIONS)[number];

const STRATEGIC_GOVERNANCE_DECISION_SET: ReadonlySet<string> = new Set(
  STRATEGIC_GOVERNANCE_DECISIONS
);

export function isStrategicGovernanceDecision(value: unknown): value is StrategicGovernanceDecision {
  return typeof value === "string" && STRATEGIC_GOVERNANCE_DECISION_SET.has(value);
}

/**
 * Autonomy ranking: BLOCK < REVIEW_REQUIRED < ALLOW_RECOMMENDATION. Governance
 * may only ever narrow (move down) as more constraints apply; no evaluation
 * path may widen a disposition (charter core principle 7 + F7).
 */
export const STRATEGIC_DECISION_AUTONOMY_RANK: Readonly<
  Record<StrategicGovernanceDecision, number>
> = {
  ALLOW_RECOMMENDATION: 2,
  REVIEW_REQUIRED: 1,
  BLOCK: 0,
};

// ─── Closed strategic risk classes (F4) ───

export const STRATEGIC_RISK_CLASSES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type StrategicRiskClass = (typeof STRATEGIC_RISK_CLASSES)[number];

const STRATEGIC_RISK_CLASS_SET: ReadonlySet<string> = new Set(STRATEGIC_RISK_CLASSES);

export function isStrategicRiskClass(value: unknown): value is StrategicRiskClass {
  return typeof value === "string" && STRATEGIC_RISK_CLASS_SET.has(value);
}

export const STRATEGIC_RISK_CLASS_RANK: Readonly<Record<StrategicRiskClass, number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

// ─── Closed confidence vocabulary (aligned with R7-B) ───

export const STRATEGIC_CONFIDENCE_CLASSES = ["NONE", "LOW", "MEDIUM", "HIGH"] as const;
export type StrategicConfidenceClass = (typeof STRATEGIC_CONFIDENCE_CLASSES)[number];

const STRATEGIC_CONFIDENCE_CLASS_SET: ReadonlySet<string> = new Set(STRATEGIC_CONFIDENCE_CLASSES);

export function isStrategicConfidenceClass(value: unknown): value is StrategicConfidenceClass {
  return typeof value === "string" && STRATEGIC_CONFIDENCE_CLASS_SET.has(value);
}

/** Confidence rank: NONE < LOW < MEDIUM < HIGH (higher = stronger claim). */
export const STRATEGIC_CONFIDENCE_RANK: Readonly<Record<StrategicConfidenceClass, number>> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

// ─── Closed evidence source-trust classes (F3) ───
//
// SERVER-DERIVED ONLY. The derivation lives in strategic-evidence-governance;
// clients and agents can never supply or influence a trust class (a source can
// never mark itself trustworthy — charter F6, acceptance AC14/AC30).

export const STRATEGIC_EVIDENCE_TRUST_CLASSES = [
  "AUTHORITATIVE_INTERNAL",
  "VERIFIED_EXTERNAL",
  "CORROBORATED_EXTERNAL",
  "SINGLE_EXTERNAL_SOURCE",
  "UNVERIFIED",
  "CONTRADICTED",
  "MALFORMED",
] as const;
export type StrategicEvidenceTrustClass = (typeof STRATEGIC_EVIDENCE_TRUST_CLASSES)[number];

const STRATEGIC_EVIDENCE_TRUST_CLASS_SET: ReadonlySet<string> = new Set(
  STRATEGIC_EVIDENCE_TRUST_CLASSES
);

export function isStrategicEvidenceTrustClass(
  value: unknown
): value is StrategicEvidenceTrustClass {
  return typeof value === "string" && STRATEGIC_EVIDENCE_TRUST_CLASS_SET.has(value);
}

/**
 * Trust rank (higher = more trustworthy). MALFORMED (0) is below CONTRADICTED
 * (1): a malformed descriptor carries no information at all, while a
 * contradiction at least carries the information that sources disagree.
 */
export const STRATEGIC_EVIDENCE_TRUST_RANK: Readonly<
  Record<StrategicEvidenceTrustClass, number>
> = {
  MALFORMED: 0,
  CONTRADICTED: 1,
  UNVERIFIED: 2,
  SINGLE_EXTERNAL_SOURCE: 3,
  CORROBORATED_EXTERNAL: 4,
  VERIFIED_EXTERNAL: 5,
  AUTHORITATIVE_INTERNAL: 6,
};

/**
 * Closed governance reason codes. Bounded: a decision carries at most
 * MAX_STRATEGIC_REASON_CODES codes (deterministic selection order).
 */
export const STRATEGIC_GOVERNANCE_REASON_CODES = [
  "RECOMMENDATION_ALLOWED_BY_POLICY",
  "RECOMMENDATION_BLOCKED_BY_POLICY",
  "UNKNOWN_RECOMMENDATION_TYPE",
  "POLICY_MISSING",
  "UNKNOWN_POLICY_VERSION",
  "STALE_POLICY_VERSION",
  "OWNERSHIP_MISMATCH",
  "CROSS_TENANT_PROPOSAL",
  "CROSS_TENANT_EVIDENCE",
  "MALFORMED_PROPOSAL",
  "MALFORMED_EVIDENCE",
  "INSUFFICIENT_EVIDENCE",
  "EVIDENCE_AUTHORITY_UNAVAILABLE",
  "STALE_EVIDENCE",
  "CONTRADICTED_EVIDENCE_PRESENT",
  "MODEL_GENERATED_NOT_SOURCE_TRUTH",
  "CONFIDENCE_BOUNDED_BY_EVIDENCE",
  "INSUFFICIENT_CONFIDENCE",
  "HIGH_IMPACT_REQUIRES_STRONG_EVIDENCE",
  "DECLARED_IMPACT_RAISES_RISK",
  "PROMPT_INJECTION_SUSPECTED",
  "CLIENT_AUTHORITY_FIELD_REJECTED",
  "APPROVAL_REQUIRED_BY_RISK",
  "HIGH_RISK_REVIEW_REQUIRED",
  "CRITICAL_RISK_BLOCKED",
  "APPROVAL_NOT_FOUND",
  "APPROVAL_PENDING",
  "APPROVAL_REJECTED_BY_HUMAN",
  "APPROVAL_BINDING_MISMATCH",
  "EXPIRED_APPROVAL",
  "EXPIRED_DECISION",
  "AGENT_SELF_APPROVAL_FORBIDDEN",
] as const;
export type StrategicGovernanceReasonCode = (typeof STRATEGIC_GOVERNANCE_REASON_CODES)[number];

const STRATEGIC_GOVERNANCE_REASON_CODE_SET: ReadonlySet<string> = new Set(
  STRATEGIC_GOVERNANCE_REASON_CODES
);

export function isStrategicGovernanceReasonCode(
  value: unknown
): value is StrategicGovernanceReasonCode {
  return typeof value === "string" && STRATEGIC_GOVERNANCE_REASON_CODE_SET.has(value);
}

export const MAX_STRATEGIC_REASON_CODES = 8;

// ─── Deterministic id/hash derivations (contract §1, §5) ───
//
// Each derivation rebuilds its hashed fragment field-by-field: callers cannot
// smuggle extra keys into a hash. Same authoritative inputs ⇒ same output;
// any material change ⇒ new identity.

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
    return value;
  }
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

/** Canonical JSON (key-sorted, whitespace-normalised) for stable hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Deterministic fingerprint of the material proposal fields. `requestedAt` is
 * excluded (a retry may legitimately re-stamp time) so a replayed logical
 * proposal converges on the same identity.
 */
export function deriveProposalFingerprint(proposal: {
  proposalId: string;
  businessId: number;
  recommendationType: string;
  summary: string;
  evidenceRefs: readonly string[];
  claimedConfidence: string;
  declaredImpact: unknown;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      proposalId: proposal.proposalId,
      businessId: proposal.businessId,
      recommendationType: proposal.recommendationType,
      summary: proposal.summary,
      evidenceRefs: proposal.evidenceRefs,
      claimedConfidence: proposal.claimedConfidence,
      declaredImpact: proposal.declaredImpact,
    })
  );
}

/**
 * Deterministic fingerprint of the SERVER-RESOLVED evidence bundle: the
 * ordered evidence refs bound to their server-derived trust classes. A client
 * cannot influence this fingerprint by re-labelling evidence — the trust
 * classes are the authority's own derivation.
 */
export function deriveEvidenceFingerprint(
  resolvedEvidence: ReadonlyArray<{ evidenceRef: string; trustClass: string }>
): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      evidence: resolvedEvidence.map((e) => ({
        evidenceRef: e.evidenceRef,
        trustClass: e.trustClass,
      })),
    })
  );
}

/**
 * Deterministic governance decision identity: one proposal material + one
 * resolved evidence fingerprint + one policy version -> one stable
 * governanceDecisionId. Retries and concurrent evaluations converge through
 * the durable store's unique insert anchor.
 */
export function deriveGovernanceDecisionId(input: {
  userId: number;
  businessId: number;
  proposalId: string;
  recommendationType: string;
  policyVersion: string;
  proposalFingerprint: string;
  evidenceFingerprint: string;
}): string {
  return `${GOVERNANCE_DECISION_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      userId: input.userId,
      businessId: input.businessId,
      proposalId: input.proposalId,
      recommendationType: input.recommendationType,
      policyVersion: input.policyVersion,
      proposalFingerprint: input.proposalFingerprint,
      evidenceFingerprint: input.evidenceFingerprint,
    })
  )}`;
}

/** Deterministic approval binding hash (F5): binds decision + policy version + proposal material + evidence snapshot. */
export function deriveApprovalBindingHash(input: {
  governanceDecisionId: string;
  policyVersion: string;
  proposalFingerprint: string;
  evidenceFingerprint: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      governanceDecisionId: input.governanceDecisionId,
      policyVersion: input.policyVersion,
      proposalFingerprint: input.proposalFingerprint,
      evidenceFingerprint: input.evidenceFingerprint,
    })
  );
}

/** Deterministic evaluation fingerprint for replay/evidence verification. */
export function deriveEvaluationFingerprint(input: {
  governanceDecisionId: string;
  decision: string;
  reasonCodes: readonly string[];
  strategicRiskClass: string;
  confidenceClass: string;
  sourceTrustClass: string;
  policyVersion: string | null;
  proposalFingerprint: string;
  approvalRequired: boolean;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      governanceDecisionId: input.governanceDecisionId,
      decision: input.decision,
      reasonCodes: input.reasonCodes,
      strategicRiskClass: input.strategicRiskClass,
      confidenceClass: input.confidenceClass,
      sourceTrustClass: input.sourceTrustClass,
      policyVersion: input.policyVersion,
      proposalFingerprint: input.proposalFingerprint,
      approvalRequired: input.approvalRequired,
    })
  );
}

// ─── Typed error taxonomy (fail closed, mirrors R6-C/R7-F discipline) ───

export type StrategicGovernanceErrorCode =
  | "MALFORMED_PROPOSAL"
  | "UNKNOWN_RECOMMENDATION_TYPE"
  | "UNKNOWN_POLICY_VERSION"
  | "POLICY_VERSION_CONFLICT"
  | "POLICY_MISSING"
  | "OWNERSHIP_MISMATCH"
  | "CROSS_TENANT_PROPOSAL"
  | "CROSS_TENANT_EVIDENCE"
  | "INSUFFICIENT_EVIDENCE"
  | "GOVERNANCE_DECISION_NOT_FOUND"
  | "GOVERNANCE_REPLAY_CONFLICT"
  | "GOVERNANCE_AUTHORITY_UNAVAILABLE"
  | "EVIDENCE_AUTHORITY_UNAVAILABLE"
  | "INVALID_POLICY"
  | "CLIENT_AUTHORITY_FIELD_REJECTED"
  | "RECOVERY_ACTION_FORBIDDEN"
  | "INVALID_RECOVERY_ACTION"
  | "INVALID_EVALUATION_CLOCK"
  | "INVALID_DECISION_IDENTITY"
  | "INVALID_APPROVAL_INPUT"
  | "INVALID_APPROVAL_MODE"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_BINDING_MISMATCH"
  | "STALE_POLICY_VERSION"
  | "EXPIRED_APPROVAL"
  | "REVIEW_CHALLENGE_UNAVAILABLE"
  | "REVIEW_CHALLENGE_INVALID";

export class StrategicGovernanceError extends Error {
  readonly code: StrategicGovernanceErrorCode;
  constructor(code: StrategicGovernanceErrorCode, message: string) {
    super(message);
    this.name = "StrategicGovernanceError";
    this.code = code;
  }
}

export class StrategicGovernanceInputError extends StrategicGovernanceError {
  constructor(code: StrategicGovernanceErrorCode, message: string) {
    super(code, message);
    this.name = "StrategicGovernanceInputError";
  }
}

export class StrategicGovernanceOwnershipError extends StrategicGovernanceError {
  constructor(code: StrategicGovernanceErrorCode, message: string) {
    super(code, message);
    this.name = "StrategicGovernanceOwnershipError";
  }
}

export class StrategicGovernanceValidationError extends StrategicGovernanceError {
  constructor(code: StrategicGovernanceErrorCode, message: string) {
    super(code, message);
    this.name = "StrategicGovernanceValidationError";
  }
}

export class StrategicGovernanceStateConflictError extends StrategicGovernanceError {
  constructor(code: StrategicGovernanceErrorCode, message: string) {
    super(code, message);
    this.name = "StrategicGovernanceStateConflictError";
  }
}

// ─── zod router-input schemas ───
//
// z.strictObject rejects unknown keys: no client-supplied authority of any
// kind (decision, reason codes, risk class, confidence class, source trust
// class, approval state, policy content). Clients reference ids and propose
// material only.

export const EvaluateStrategicGovernanceInputSchema = z.strictObject({
  proposal: z.unknown(),
  policyVersion: z.string().min(1).max(96).optional(),
});
export type EvaluateStrategicGovernanceInput = z.infer<typeof EvaluateStrategicGovernanceInputSchema>;

export const GetStrategicGovernanceDecisionInputSchema = z.strictObject({
  governanceDecisionId: z.string().regex(GOVERNANCE_DECISION_ID_PATTERN),
});
export type GetStrategicGovernanceDecisionInput = z.infer<
  typeof GetStrategicGovernanceDecisionInputSchema
>;

export const ListStrategicGovernanceDecisionsInputSchema = z.strictObject({
  businessId: z.number().int().positive().optional(),
  proposalId: z.string().regex(PROPOSAL_ID_PATTERN).optional(),
  decision: z.enum(STRATEGIC_GOVERNANCE_DECISIONS).optional(),
});
export type ListStrategicGovernanceDecisionsInput = z.infer<
  typeof ListStrategicGovernanceDecisionsInputSchema
>;

export const RevalidateStrategicGovernanceDecisionInputSchema = z.strictObject({
  governanceDecisionId: z.string().regex(GOVERNANCE_DECISION_ID_PATTERN),
  proposal: z.unknown().optional(),
});
export type RevalidateStrategicGovernanceDecisionInput = z.infer<
  typeof RevalidateStrategicGovernanceDecisionInputSchema
>;

/** Narrow, closed recovery vocabulary (F8): no forceAllow/forceApprove/setTrusted/overrideRisk/overridePolicy. */
export const STRATEGIC_RECOVERY_ACTIONS = [
  "operator_acknowledged",
  "operator_requeued",
  "operator_dismissed",
] as const;
export type StrategicRecoveryAction = (typeof STRATEGIC_RECOVERY_ACTIONS)[number];

export const RecordStrategicGovernanceRecoveryInputSchema = z.strictObject({
  governanceDecisionId: z.string().regex(GOVERNANCE_DECISION_ID_PATTERN),
  action: z.enum(STRATEGIC_RECOVERY_ACTIONS),
  note: z.string().min(1).max(500),
});
export type RecordStrategicGovernanceRecoveryInput = z.infer<
  typeof RecordStrategicGovernanceRecoveryInputSchema
>;

// ─── F5 approval resolution surface schemas (human review) ───

export const RequestStrategicApprovalChallengeInputSchema = z.strictObject({
  governanceDecisionId: z.string().regex(GOVERNANCE_DECISION_ID_PATTERN),
});
export type RequestStrategicApprovalChallengeInput = z.infer<
  typeof RequestStrategicApprovalChallengeInputSchema
>;

export const ResolveStrategicApprovalChallengeInputSchema = z.strictObject({
  governanceDecisionId: z.string().regex(GOVERNANCE_DECISION_ID_PATTERN),
  challengeToken: z.string().min(1).max(255),
  code: z.string().min(4).max(12),
});
export type ResolveStrategicApprovalChallengeInput = z.infer<
  typeof ResolveStrategicApprovalChallengeInputSchema
>;
