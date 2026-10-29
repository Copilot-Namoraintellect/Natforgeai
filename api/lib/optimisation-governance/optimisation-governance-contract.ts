// ─── R7-F Optimisation Governance — canonical governance contract ───
//
// PURE contract module: closed vocabularies, version identities, deterministic
// id/hash derivations, typed error taxonomy, zod router-input schemas and
// canonical hashing helpers for the business-optimisation governance
// authority (docs/contracts/business-optimisation-governance-contract.md).
// It performs no I/O of any kind and authorizes nothing.
//
// A governance decision is AUTHORITY derived from a validated optimisation
// proposal + versioned policy + server-resolved financial/risk/portfolio/
// experiment authority + privacy constraints only. No model sits in the
// decision path; no client may supply decisions, risk classes, financial
// impact classes, reason codes, approval state or policy content. Model
// output is proposal material only — never authority.

import { createHash } from "crypto";
import { z } from "zod";

export const OPTIMISATION_GOVERNANCE_CONTRACT_VERSION = "optimisation-governance/v1" as const;
export const OPTIMISATION_GOVERNANCE_ENGINE_VERSION = "optimisation-governance-engine/v1" as const;
export const DEFAULT_OPTIMISATION_POLICY_VERSION = "optimisation-governance-policy/v1" as const;

export const GOVERNANCE_DECISION_ID_PREFIX = "ogd1:" as const;
export const GOVERNANCE_DECISION_ID_PATTERN = /^ogd1:[a-f0-9]{64}$/;
export const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const ALLOCATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_|-]{0,95}$/;
export const HEX_64 = /^[a-f0-9]{64}$/;

export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isIsoUtc(value: string): boolean {
  return ISO_UTC_PATTERN.test(value);
}

// ─── Closed vocabularies (governance contract §3–§5 — closed) ───

/**
 * Closed governance decision vocabulary (F1). Exhaustive: downstream R7
 * streams must never invent additional outcomes. Anything outside this
 * vocabulary is a programming error, not a decision.
 */
export const OPTIMISATION_GOVERNANCE_DECISIONS = [
  "ALLOW",
  "REVIEW_REQUIRED",
  "BLOCK",
] as const;
export type OptimisationGovernanceDecision =
  (typeof OPTIMISATION_GOVERNANCE_DECISIONS)[number];

const OPTIMISATION_GOVERNANCE_DECISION_SET: ReadonlySet<string> = new Set(
  OPTIMISATION_GOVERNANCE_DECISIONS
);

export function isOptimisationGovernanceDecision(
  value: unknown
): value is OptimisationGovernanceDecision {
  return typeof value === "string" && OPTIMISATION_GOVERNANCE_DECISION_SET.has(value);
}

/**
 * Autonomy ranking: BLOCK < REVIEW_REQUIRED < ALLOW. Governance may only ever
 * narrow (move down) as more constraints are applied; no evaluation path may
 * widen a disposition (F7).
 */
export const GOVERNANCE_DECISION_AUTONOMY_RANK: Readonly<
  Record<OptimisationGovernanceDecision, number>
> = {
  ALLOW: 2,
  REVIEW_REQUIRED: 1,
  BLOCK: 0,
};

/** Governed risk tiers (aligned with the R5-E ordering low < medium < high < critical). */
export const OPTIMISATION_RISK_TIERS = ["low", "medium", "high", "critical"] as const;
export type OptimisationRiskTier = (typeof OPTIMISATION_RISK_TIERS)[number];

export const OPTIMISATION_RISK_TIER_SET: ReadonlySet<string> = new Set(OPTIMISATION_RISK_TIERS);

export function isOptimisationRiskTier(value: unknown): value is OptimisationRiskTier {
  return typeof value === "string" && OPTIMISATION_RISK_TIER_SET.has(value);
}

export const OPTIMISATION_RISK_TIER_RANK: Readonly<Record<OptimisationRiskTier, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Closed financial impact classes (F3). Ordered by financial authority
 * demanded: recommendation only < reallocation within an already-approved
 * total < increase in total budget < new financial commitment < irreversible
 * external spend.
 */
export const OPTIMISATION_FINANCIAL_IMPACT_CLASSES = [
  "RECOMMENDATION_ONLY",
  "REALLOCATION_WITHIN_APPROVED_TOTAL",
  "TOTAL_BUDGET_INCREASE",
  "NEW_FINANCIAL_COMMITMENT",
  "IRREVERSIBLE_EXTERNAL_SPEND",
] as const;
export type OptimisationFinancialImpactClass =
  (typeof OPTIMISATION_FINANCIAL_IMPACT_CLASSES)[number];

export const OPTIMISATION_FINANCIAL_IMPACT_CLASS_SET: ReadonlySet<string> = new Set(
  OPTIMISATION_FINANCIAL_IMPACT_CLASSES
);

export function isOptimisationFinancialImpactClass(
  value: unknown
): value is OptimisationFinancialImpactClass {
  return typeof value === "string" && OPTIMISATION_FINANCIAL_IMPACT_CLASS_SET.has(value);
}

/**
 * Closed governance reason codes. Bounded: a decision carries at most
 * MAX_GOVERNANCE_REASON_CODES codes (deterministic selection order).
 */
export const OPTIMISATION_GOVERNANCE_REASON_CODES = [
  "PROPOSAL_ALLOWED_BY_POLICY",
  "ACTION_PROHIBITED_BY_POLICY",
  "UNKNOWN_OPTIMISATION_ACTION_TYPE",
  "POLICY_MISSING",
  "UNKNOWN_POLICY_VERSION",
  "STALE_POLICY_VERSION",
  "OWNERSHIP_MISMATCH",
  "CROSS_TENANT_PROPOSAL",
  "MALFORMED_PROPOSAL",
  "STALE_BUDGET_STATE",
  "BUDGET_AUTHORITY_UNAVAILABLE",
  "FINANCIAL_IMPACT_CLASS_REQUIRES_APPROVAL",
  "TOTAL_BUDGET_INCREASE_REQUIRES_APPROVAL",
  "AUTONOMOUS_TOTAL_BUDGET_INCREASE_FORBIDDEN",
  "NEW_FINANCIAL_COMMITMENT_REQUIRES_APPROVAL",
  "IRREVERSIBLE_SPEND_REQUIRES_APPROVAL",
  "REALLOCATION_EXCEEDS_AUTONOMOUS_CAP",
  "REALLOCATION_EXCEEDS_FRACTION_LIMIT",
  "REALLOCATION_SOURCE_LOCKED",
  "RESERVED_FUNDS_IMMUTABLE",
  "UNSUPPORTED_PROVIDER",
  "STALE_LEARNING",
  "EXPERIMENT_BUDGET_EXCEEDS_LIMIT",
  "EXPERIMENT_DIMENSION_PROHIBITED",
  "EXPERIMENT_CONCURRENCY_LIMIT_REACHED",
  "EXPERIMENT_DURATION_OUT_OF_BOUNDS",
  "PROTECTED_TRAIT_OPTIMISATION_BLOCKED",
  "CONCENTRATION_LIMIT_EXCEEDED",
  "SUDDEN_REALLOCATION_SHIFT_LIMIT",
  "REALLOCATION_OSCILLATION_DETECTED",
  "APPROVAL_REQUIRED_BY_RISK",
  "HIGH_RISK_REVIEW_REQUIRED",
  "CRITICAL_RISK_BLOCKED",
  "PROMPT_INJECTION_SUSPECTED",
  "CLIENT_AUTHORITY_FIELD_REJECTED",
  "FINANCIAL_CLASS_DECLARATION_MISMATCH",
  "APPROVAL_NOT_FOUND",
  "APPROVAL_PENDING",
  "APPROVAL_REJECTED_BY_HUMAN",
  "APPROVAL_BINDING_MISMATCH",
  "EXPIRED_APPROVAL",
  "EXPIRED_DECISION",
  "AGENT_SELF_APPROVAL_FORBIDDEN",
] as const;
export type OptimisationGovernanceReasonCode =
  (typeof OPTIMISATION_GOVERNANCE_REASON_CODES)[number];

const OPTIMISATION_GOVERNANCE_REASON_CODE_SET: ReadonlySet<string> = new Set(
  OPTIMISATION_GOVERNANCE_REASON_CODES
);

export function isOptimisationGovernanceReasonCode(
  value: unknown
): value is OptimisationGovernanceReasonCode {
  return typeof value === "string" && OPTIMISATION_GOVERNANCE_REASON_CODE_SET.has(value);
}

export const MAX_GOVERNANCE_REASON_CODES = 8;

// ─── Monetary convention ───
//
// All financial impact is expressed in integer minor units (cents) per the
// repository monetary convention (R6-E conversion authority). Currency is a
// closed 3-letter uppercase code; deltas are signed (negative releases budget).

export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

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
  proposalType: string;
  financial: unknown;
  experiment: unknown;
  portfolio: unknown;
  learningReference: unknown;
  campaignId: number | null;
  evidenceHash: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      proposalId: proposal.proposalId,
      businessId: proposal.businessId,
      proposalType: proposal.proposalType,
      financial: proposal.financial,
      experiment: proposal.experiment,
      portfolio: proposal.portfolio,
      learningReference: proposal.learningReference,
      campaignId: proposal.campaignId,
      evidenceHash: proposal.evidenceHash,
    })
  );
}

/**
 * Deterministic governance decision identity: one proposal material + one
 * policy version -> one stable governanceDecisionId. Retries and concurrent
 * evaluations converge through the durable store's unique insert anchor.
 */
export function deriveGovernanceDecisionId(input: {
  userId: number;
  businessId: number;
  proposalId: string;
  proposalType: string;
  policyVersion: string;
  proposalFingerprint: string;
  evidenceHash: string;
}): string {
  return `${GOVERNANCE_DECISION_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      userId: input.userId,
      businessId: input.businessId,
      proposalId: input.proposalId,
      proposalType: input.proposalType,
      policyVersion: input.policyVersion,
      proposalFingerprint: input.proposalFingerprint,
      evidenceHash: input.evidenceHash,
    })
  )}`;
}

/** Deterministic approval binding hash (F4): binds decision + proposal material + policy version. */
export function deriveApprovalBindingHash(input: {
  governanceDecisionId: string;
  policyVersion: string;
  proposalFingerprint: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      governanceDecisionId: input.governanceDecisionId,
      policyVersion: input.policyVersion,
      proposalFingerprint: input.proposalFingerprint,
    })
  );
}

/** Deterministic evaluation fingerprint for replay/evidence verification. */
export function deriveEvaluationFingerprint(input: {
  governanceDecisionId: string;
  decision: string;
  reasonCodes: readonly string[];
  riskClass: string;
  financialImpactClass: string;
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
      riskClass: input.riskClass,
      financialImpactClass: input.financialImpactClass,
      policyVersion: input.policyVersion,
      proposalFingerprint: input.proposalFingerprint,
      approvalRequired: input.approvalRequired,
    })
  );
}

// ─── Typed error taxonomy (fail closed, mirrors R6-C discipline) ───

export type OptimisationGovernanceErrorCode =
  | "MALFORMED_PROPOSAL"
  | "UNKNOWN_OPTIMISATION_ACTION_TYPE"
  | "UNKNOWN_POLICY_VERSION"
  | "POLICY_VERSION_CONFLICT"
  | "POLICY_MISSING"
  | "OWNERSHIP_MISMATCH"
  | "CROSS_TENANT_PROPOSAL"
  | "GOVERNANCE_DECISION_NOT_FOUND"
  | "GOVERNANCE_REPLAY_CONFLICT"
  | "GOVERNANCE_AUTHORITY_UNAVAILABLE"
  | "OPTIMISATION_BUDGET_AUTHORITY_UNAVAILABLE"
  | "OPTIMISATION_PORTFOLIO_AUTHORITY_UNAVAILABLE"
  | "OPTIMISATION_EXPERIMENT_AUTHORITY_UNAVAILABLE"
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
  | "EXPIRED_APPROVAL";

export class OptimisationGovernanceError extends Error {
  readonly code: OptimisationGovernanceErrorCode;
  constructor(code: OptimisationGovernanceErrorCode, message: string) {
    super(message);
    this.name = "OptimisationGovernanceError";
    this.code = code;
  }
}

export class OptimisationGovernanceInputError extends OptimisationGovernanceError {
  constructor(code: OptimisationGovernanceErrorCode, message: string) {
    super(code, message);
    this.name = "OptimisationGovernanceInputError";
  }
}

export class OptimisationGovernanceOwnershipError extends OptimisationGovernanceError {
  constructor(code: OptimisationGovernanceErrorCode, message: string) {
    super(code, message);
    this.name = "OptimisationGovernanceOwnershipError";
  }
}

export class OptimisationGovernanceValidationError extends OptimisationGovernanceError {
  constructor(code: OptimisationGovernanceErrorCode, message: string) {
    super(code, message);
    this.name = "OptimisationGovernanceValidationError";
  }
}

export class OptimisationGovernanceStateConflictError extends OptimisationGovernanceError {
  constructor(code: OptimisationGovernanceErrorCode, message: string) {
    super(code, message);
    this.name = "OptimisationGovernanceStateConflictError";
  }
}

// ─── zod router-input schemas ───
//
// z.strictObject rejects unknown keys: no client-supplied authority of any
// kind (decision, reason codes, risk class, financial impact class, approval
// state, policy content). Clients reference ids and propose material only.

export const EvaluateOptimisationGovernanceInputSchema = z.strictObject({
  proposal: z.unknown(),
  policyVersion: z.string().min(1).max(96).optional(),
});
export type EvaluateOptimisationGovernanceInput = z.infer<
  typeof EvaluateOptimisationGovernanceInputSchema
>;

export const GetGovernanceDecisionInputSchema = z.strictObject({
  governanceDecisionId: z.string().regex(GOVERNANCE_DECISION_ID_PATTERN),
});
export type GetGovernanceDecisionInput = z.infer<typeof GetGovernanceDecisionInputSchema>;

export const ListGovernanceDecisionsInputSchema = z.strictObject({
  businessId: z.number().int().positive().optional(),
  proposalId: z.string().regex(PROPOSAL_ID_PATTERN).optional(),
  decision: z.enum(OPTIMISATION_GOVERNANCE_DECISIONS).optional(),
});
export type ListGovernanceDecisionsInput = z.infer<typeof ListGovernanceDecisionsInputSchema>;

export const RevalidateGovernanceDecisionInputSchema = z.strictObject({
  governanceDecisionId: z.string().regex(GOVERNANCE_DECISION_ID_PATTERN),
  proposal: z.unknown().optional(),
});
export type RevalidateGovernanceDecisionInput = z.infer<
  typeof RevalidateGovernanceDecisionInputSchema
>;

/** Narrow, closed recovery vocabulary (F8): no forceAllow/forceComplete/setApproved/overridePolicy. */
export const OPTIMISATION_RECOVERY_ACTIONS = [
  "operator_acknowledged",
  "operator_requeued",
  "operator_dismissed",
] as const;
export type OptimisationRecoveryAction = (typeof OPTIMISATION_RECOVERY_ACTIONS)[number];

export const RecordGovernanceRecoveryInputSchema = z.strictObject({
  governanceDecisionId: z.string().regex(GOVERNANCE_DECISION_ID_PATTERN),
  action: z.enum(OPTIMISATION_RECOVERY_ACTIONS),
  note: z.string().min(1).max(500),
});
export type RecordGovernanceRecoveryInput = z.infer<typeof RecordGovernanceRecoveryInputSchema>;
