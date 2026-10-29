// ─── R7-F Optimisation Governance — blocker taxonomy (F8) ───
//
// Controlled vocabulary of operational blocker classes for optimisation
// governance and their recovery classifications. Pure policy: no I/O, no
// clock, no state. Normative rule (stream charter): automatic recovery is
// NEVER invented for conditions that require a human decision. Anything
// involving money, policy approval, ownership, security or evidence
// integrity is a human/governance decision and is classified accordingly.

export const OPTIMISATION_BLOCKER_CLASSES = [
  "POLICY_REQUIRES_APPROVAL",
  "STALE_POLICY_VERSION",
  "STALE_BUDGET_STATE",
  "FINANCIAL_AUTHORITY_UNAVAILABLE",
  "PORTFOLIO_AUTHORITY_UNAVAILABLE",
  "EXPERIMENT_AUTHORITY_UNAVAILABLE",
  "BUDGET_CEILING_EXCEEDED",
  "CONCENTRATION_LIMIT_EXCEEDED",
  "LOCKED_OR_RESERVED_FUNDS",
  "UNSUPPORTED_PROVIDER_TARGET",
  "STALE_LEARNING_EVIDENCE",
  "PROHIBITED_EXPERIMENT_DIMENSION",
  "PROTECTED_TRAIT_VIOLATION",
  "EXPERIMENT_CONCURRENCY_EXCEEDED",
  "OWNERSHIP_MISMATCH",
  "SECURITY_REJECTION",
  "MALFORMED_PROPOSAL",
  "APPROVAL_EXPIRED",
  "DECISION_EXPIRED",
] as const;

export type OptimisationBlockerClass = (typeof OPTIMISATION_BLOCKER_CLASSES)[number];

const OPTIMISATION_BLOCKER_CLASS_SET: ReadonlySet<string> = new Set(OPTIMISATION_BLOCKER_CLASSES);

export function isOptimisationBlockerClass(value: unknown): value is OptimisationBlockerClass {
  return typeof value === "string" && OPTIMISATION_BLOCKER_CLASS_SET.has(value);
}

/**
 * Recovery classifications. Exactly one applies per blocker instance:
 * - AUTO_RECOVER: the platform may retry on its own within bounded backoff;
 *   no human decision is embedded in the condition.
 * - OPERATOR_ACTION: a human operator must act on the governed surface.
 * - FAIL_CLOSED: recovery is not possible/allowed; the item stays terminal
 *   and the evidence is preserved for review.
 * - GOVERNANCE_APPROVAL: a governed human approval decision is required; the
 *   system must never self-approve.
 */
export const OPTIMISATION_RECOVERY_CLASSES = [
  "AUTO_RECOVER",
  "OPERATOR_ACTION",
  "FAIL_CLOSED",
  "GOVERNANCE_APPROVAL",
] as const;

export type OptimisationRecoveryClass = (typeof OPTIMISATION_RECOVERY_CLASSES)[number];

export interface OptimisationBlockerClassPolicy {
  readonly recoveryClass: OptimisationRecoveryClass;
  /** Whether platform retry machinery may attempt recovery without a human. */
  readonly systemRetryAllowed: boolean;
  /** Normative rationale; surfaces in operator documentation. */
  readonly rationale: string;
}

export const OPTIMISATION_BLOCKER_CLASS_POLICY: Record<
  OptimisationBlockerClass,
  OptimisationBlockerClassPolicy
> = {
  POLICY_REQUIRES_APPROVAL: {
    recoveryClass: "GOVERNANCE_APPROVAL",
    systemRetryAllowed: false,
    rationale:
      "Policy requires a human approval before the optimisation action may proceed; auto-approving would fabricate governance and is forbidden.",
  },
  STALE_POLICY_VERSION: {
    recoveryClass: "OPERATOR_ACTION",
    systemRetryAllowed: false,
    rationale:
      "The business policy changed since evaluation; a new governed evaluation under the current policy is required. Retrying the stale decision is meaningless.",
  },
  STALE_BUDGET_STATE: {
    recoveryClass: "AUTO_RECOVER",
    systemRetryAllowed: true,
    rationale:
      "The budget authority snapshot is older than the policy freshness window; re-resolving the snapshot and re-evaluating is safe and contains no human decision.",
  },
  FINANCIAL_AUTHORITY_UNAVAILABLE: {
    recoveryClass: "AUTO_RECOVER",
    systemRetryAllowed: true,
    rationale:
      "The financial authority could not be resolved (transient infrastructure); bounded retry is safe. Authority absence never widens autonomy.",
  },
  PORTFOLIO_AUTHORITY_UNAVAILABLE: {
    recoveryClass: "AUTO_RECOVER",
    systemRetryAllowed: true,
    rationale: "Transient portfolio authority resolution failure; bounded retry is safe.",
  },
  EXPERIMENT_AUTHORITY_UNAVAILABLE: {
    recoveryClass: "AUTO_RECOVER",
    systemRetryAllowed: true,
    rationale: "Transient experiment authority resolution failure; bounded retry is safe.",
  },
  BUDGET_CEILING_EXCEEDED: {
    recoveryClass: "GOVERNANCE_APPROVAL",
    systemRetryAllowed: false,
    rationale:
      "The proposal exceeds an approved financial ceiling; releasing more spend is a governed human decision.",
  },
  CONCENTRATION_LIMIT_EXCEEDED: {
    recoveryClass: "GOVERNANCE_APPROVAL",
    systemRetryAllowed: false,
    rationale:
      "The proposal would over-concentrate spend; a human must consciously accept the concentration risk.",
  },
  LOCKED_OR_RESERVED_FUNDS: {
    recoveryClass: "FAIL_CLOSED",
    systemRetryAllowed: false,
    rationale:
      "Locked/reserved funds are immutable to optimisation; moving them would breach reservation authority. Fail closed and preserve evidence.",
  },
  UNSUPPORTED_PROVIDER_TARGET: {
    recoveryClass: "OPERATOR_ACTION",
    systemRetryAllowed: false,
    rationale:
      "The target provider is not supported for budget movement; choosing a supported target is an operator configuration decision.",
  },
  STALE_LEARNING_EVIDENCE: {
    recoveryClass: "OPERATOR_ACTION",
    systemRetryAllowed: false,
    rationale:
      "The learning evidence is older than the policy freshness window; refreshing learning is a learning-pipeline decision, not a governance retry.",
  },
  PROHIBITED_EXPERIMENT_DIMENSION: {
    recoveryClass: "FAIL_CLOSED",
    systemRetryAllowed: false,
    rationale:
      "The experiment manipulates a policy-prohibited dimension; recovery would mean bypassing the prohibition and is forbidden.",
  },
  PROTECTED_TRAIT_VIOLATION: {
    recoveryClass: "FAIL_CLOSED",
    systemRetryAllowed: false,
    rationale:
      "The proposal touches protected/sensitive traits; recovery would mean bypassing a hard privacy boundary and is forbidden.",
  },
  EXPERIMENT_CONCURRENCY_EXCEEDED: {
    recoveryClass: "OPERATOR_ACTION",
    systemRetryAllowed: false,
    rationale:
      "The concurrency ceiling is reached; stopping an existing experiment is an operator decision.",
  },
  OWNERSHIP_MISMATCH: {
    recoveryClass: "FAIL_CLOSED",
    systemRetryAllowed: false,
    rationale:
      "The proposal references a different owner/business than the authoritative record; continuing would cross tenant boundaries. Fail closed, preserve evidence.",
  },
  SECURITY_REJECTION: {
    recoveryClass: "FAIL_CLOSED",
    systemRetryAllowed: false,
    rationale:
      "A security/policy control rejected the action; recovery would mean bypassing the control and is forbidden.",
  },
  MALFORMED_PROPOSAL: {
    recoveryClass: "FAIL_CLOSED",
    systemRetryAllowed: false,
    rationale:
      "The proposal failed validation and must not be retried (retrying garbage amplifies damage); the proposer must submit a new, well-formed proposal.",
  },
  APPROVAL_EXPIRED: {
    recoveryClass: "OPERATOR_ACTION",
    systemRetryAllowed: false,
    rationale:
      "The approval binding expired; a new governed proposal + approval cycle is required. Extending an expired approval is forbidden.",
  },
  DECISION_EXPIRED: {
    recoveryClass: "OPERATOR_ACTION",
    systemRetryAllowed: false,
    rationale:
      "The governance decision expired; a fresh evaluation under current policy and authority is required.",
  },
};

export function recoveryClassFor(blockerClass: OptimisationBlockerClass): OptimisationRecoveryClass {
  return OPTIMISATION_BLOCKER_CLASS_POLICY[blockerClass].recoveryClass;
}

export function isSystemRetryAllowed(blockerClass: OptimisationBlockerClass): boolean {
  return OPTIMISATION_BLOCKER_CLASS_POLICY[blockerClass].systemRetryAllowed;
}

/**
 * Best-effort mapping from a governance reason code to a blocker class for
 * the operations projection. Returns null when nothing reliable can be
 * inferred; the projection never guesses a security or ownership class.
 */
export function mapReasonCodeToBlockerClass(
  code: string | null | undefined
): OptimisationBlockerClass | null {
  if (!code) return null;
  switch (code) {
    case "POLICY_MISSING":
    case "UNKNOWN_POLICY_VERSION":
    case "STALE_POLICY_VERSION":
      return "STALE_POLICY_VERSION";
    case "STALE_BUDGET_STATE":
      return "STALE_BUDGET_STATE";
    case "BUDGET_AUTHORITY_UNAVAILABLE":
      return "FINANCIAL_AUTHORITY_UNAVAILABLE";
    case "OPTIMISATION_PORTFOLIO_AUTHORITY_UNAVAILABLE":
      return "PORTFOLIO_AUTHORITY_UNAVAILABLE";
    case "OPTIMISATION_EXPERIMENT_AUTHORITY_UNAVAILABLE":
      return "EXPERIMENT_AUTHORITY_UNAVAILABLE";
    case "TOTAL_BUDGET_INCREASE_REQUIRES_APPROVAL":
    case "REALLOCATION_EXCEEDS_AUTONOMOUS_CAP":
    case "REALLOCATION_EXCEEDS_FRACTION_LIMIT":
      return "BUDGET_CEILING_EXCEEDED";
    case "CONCENTRATION_LIMIT_EXCEEDED":
      return "CONCENTRATION_LIMIT_EXCEEDED";
    case "REALLOCATION_SOURCE_LOCKED":
    case "RESERVED_FUNDS_IMMUTABLE":
      return "LOCKED_OR_RESERVED_FUNDS";
    case "UNSUPPORTED_PROVIDER":
      return "UNSUPPORTED_PROVIDER_TARGET";
    case "STALE_LEARNING":
      return "STALE_LEARNING_EVIDENCE";
    case "EXPERIMENT_DIMENSION_PROHIBITED":
      return "PROHIBITED_EXPERIMENT_DIMENSION";
    case "PROTECTED_TRAIT_OPTIMISATION_BLOCKED":
      return "PROTECTED_TRAIT_VIOLATION";
    case "EXPERIMENT_CONCURRENCY_LIMIT_REACHED":
      return "EXPERIMENT_CONCURRENCY_EXCEEDED";
    case "OWNERSHIP_MISMATCH":
    case "CROSS_TENANT_PROPOSAL":
      return "OWNERSHIP_MISMATCH";
    case "UNKNOWN_OPTIMISATION_ACTION_TYPE":
    case "CLIENT_AUTHORITY_FIELD_REJECTED":
    case "PROMPT_INJECTION_SUSPECTED":
      return "SECURITY_REJECTION";
    case "MALFORMED_PROPOSAL":
      return "MALFORMED_PROPOSAL";
    case "EXPIRED_APPROVAL":
      return "APPROVAL_EXPIRED";
    case "EXPIRED_DECISION":
      return "DECISION_EXPIRED";
    default:
      return null;
  }
}
