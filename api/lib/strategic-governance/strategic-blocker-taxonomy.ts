// ─── R8-F Strategic Intelligence Governance — blocker taxonomy (F8) ───
//
// Controlled vocabulary of operational blocker classes for strategic
// governance and their recovery classifications. Pure policy: no I/O, no
// clock, no state. Normative rule (stream charter): automatic recovery is
// NEVER invented for conditions that require a human decision. Anything
// involving trust, policy approval, ownership, security or evidence integrity
// is a human/governance decision and is classified accordingly.

export const STRATEGIC_BLOCKER_CLASSES = [
  "POLICY_REQUIRES_APPROVAL",
  "STALE_POLICY_VERSION",
  "EVIDENCE_AUTHORITY_UNAVAILABLE",
  "INSUFFICIENT_EVIDENCE",
  "MALFORMED_PROPOSAL",
  "MALFORMED_EVIDENCE",
  "STALE_EVIDENCE",
  "CONTRADICTED_EVIDENCE",
  "TRUST_FLOOR_NOT_MET",
  "HIGH_IMPACT_WEAK_EVIDENCE",
  "OWNERSHIP_MISMATCH",
  "CROSS_TENANT_EVIDENCE",
  "SECURITY_REJECTION",
  "PROMPT_INJECTION_CONTAINED",
  "APPROVAL_EXPIRED",
  "DECISION_EXPIRED",
] as const;

export type StrategicBlockerClass = (typeof STRATEGIC_BLOCKER_CLASSES)[number];

const STRATEGIC_BLOCKER_CLASS_SET: ReadonlySet<string> = new Set(STRATEGIC_BLOCKER_CLASSES);

export function isStrategicBlockerClass(value: unknown): value is StrategicBlockerClass {
  return typeof value === "string" && STRATEGIC_BLOCKER_CLASS_SET.has(value);
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
export const STRATEGIC_RECOVERY_CLASSES = [
  "AUTO_RECOVER",
  "OPERATOR_ACTION",
  "FAIL_CLOSED",
  "GOVERNANCE_APPROVAL",
] as const;

export type StrategicRecoveryClass = (typeof STRATEGIC_RECOVERY_CLASSES)[number];

export interface StrategicBlockerClassPolicy {
  readonly recoveryClass: StrategicRecoveryClass;
  /** Whether platform retry machinery may attempt recovery without a human. */
  readonly systemRetryAllowed: boolean;
  /** Normative rationale; surfaces in operator documentation. */
  readonly rationale: string;
}

export const STRATEGIC_BLOCKER_CLASS_POLICY: Record<
  StrategicBlockerClass,
  StrategicBlockerClassPolicy
> = {
  POLICY_REQUIRES_APPROVAL: {
    recoveryClass: "GOVERNANCE_APPROVAL",
    systemRetryAllowed: false,
    rationale:
      "Policy requires a human approval before the recommendation may proceed; auto-approving would fabricate governance and is forbidden.",
  },
  STALE_POLICY_VERSION: {
    recoveryClass: "OPERATOR_ACTION",
    systemRetryAllowed: false,
    rationale:
      "The governance policy changed since evaluation; a new governed evaluation under the current policy is required. Retrying the stale decision is meaningless.",
  },
  EVIDENCE_AUTHORITY_UNAVAILABLE: {
    recoveryClass: "AUTO_RECOVER",
    systemRetryAllowed: true,
    rationale:
      "The evidence authority could not be resolved (transient infrastructure); bounded retry is safe. Authority absence never widens autonomy.",
  },
  INSUFFICIENT_EVIDENCE: {
    recoveryClass: "OPERATOR_ACTION",
    systemRetryAllowed: false,
    rationale:
      "The proposal cites no usable evidence; the proposing agent must assemble a real evidence bundle and resubmit.",
  },
  MALFORMED_PROPOSAL: {
    recoveryClass: "FAIL_CLOSED",
    systemRetryAllowed: false,
    rationale:
      "The proposal failed validation and must not be retried (retrying garbage amplifies damage); the proposer must submit a new, well-formed proposal.",
  },
  MALFORMED_EVIDENCE: {
    recoveryClass: "FAIL_CLOSED",
    systemRetryAllowed: false,
    rationale:
      "Every cited evidence descriptor failed resolution; the evidence bundle is untrustworthy as presented. Fail closed and preserve for review.",
  },
  STALE_EVIDENCE: {
    recoveryClass: "OPERATOR_ACTION",
    systemRetryAllowed: false,
    rationale:
      "The evidence is older than the policy freshness window; refreshing the evidence is an evidence-pipeline decision, not a governance retry.",
  },
  CONTRADICTED_EVIDENCE: {
    recoveryClass: "GOVERNANCE_APPROVAL",
    systemRetryAllowed: false,
    rationale:
      "Sources actively contradict; resolving the contradiction is a human analytical decision. The contradiction stays visible.",
  },
  TRUST_FLOOR_NOT_MET: {
    recoveryClass: "GOVERNANCE_APPROVAL",
    systemRetryAllowed: false,
    rationale:
      "The derived confidence is below the autonomous floor; voicing the claim requires a governed human decision.",
  },
  HIGH_IMPACT_WEAK_EVIDENCE: {
    recoveryClass: "GOVERNANCE_APPROVAL",
    systemRetryAllowed: false,
    rationale:
      "A high-impact claim requires stronger evidence than the bundle provides; a human must consciously accept the evidentiary risk.",
  },
  OWNERSHIP_MISMATCH: {
    recoveryClass: "FAIL_CLOSED",
    systemRetryAllowed: false,
    rationale:
      "The proposal references a different owner/business than the authoritative record; continuing would cross tenant boundaries. Fail closed, preserve evidence.",
  },
  CROSS_TENANT_EVIDENCE: {
    recoveryClass: "FAIL_CLOSED",
    systemRetryAllowed: false,
    rationale:
      "Cited evidence belongs to another tenant (or to no resolvable record); using it would breach tenant isolation. Fail closed, preserve evidence.",
  },
  SECURITY_REJECTION: {
    recoveryClass: "FAIL_CLOSED",
    systemRetryAllowed: false,
    rationale:
      "A security/policy control rejected the proposal; recovery would mean bypassing the control and is forbidden.",
  },
  PROMPT_INJECTION_CONTAINED: {
    recoveryClass: "OPERATOR_ACTION",
    systemRetryAllowed: false,
    rationale:
      "Manipulated content was detected and contained (risk raised, authority unchanged); an operator should inspect the source before any resubmission.",
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
      "The governance decision expired; a fresh evaluation under current policy and evidence is required.",
  },
};

export function strategicRecoveryClassFor(
  blockerClass: StrategicBlockerClass
): StrategicRecoveryClass {
  return STRATEGIC_BLOCKER_CLASS_POLICY[blockerClass].recoveryClass;
}

export function isStrategicSystemRetryAllowed(blockerClass: StrategicBlockerClass): boolean {
  return STRATEGIC_BLOCKER_CLASS_POLICY[blockerClass].systemRetryAllowed;
}

/**
 * Best-effort mapping from a governance reason code to a blocker class for
 * the operations projection. Returns null when nothing reliable can be
 * inferred; the projection never guesses a security or ownership class.
 */
export function mapStrategicReasonCodeToBlockerClass(
  code: string | null | undefined
): StrategicBlockerClass | null {
  if (!code) return null;
  switch (code) {
    case "POLICY_MISSING":
    case "UNKNOWN_POLICY_VERSION":
    case "STALE_POLICY_VERSION":
      return "STALE_POLICY_VERSION";
    case "EVIDENCE_AUTHORITY_UNAVAILABLE":
      return "EVIDENCE_AUTHORITY_UNAVAILABLE";
    case "INSUFFICIENT_EVIDENCE":
      return "INSUFFICIENT_EVIDENCE";
    case "MALFORMED_PROPOSAL":
      return "MALFORMED_PROPOSAL";
    case "MALFORMED_EVIDENCE":
      return "MALFORMED_EVIDENCE";
    case "STALE_EVIDENCE":
      return "STALE_EVIDENCE";
    case "CONTRADICTED_EVIDENCE_PRESENT":
      return "CONTRADICTED_EVIDENCE";
    case "INSUFFICIENT_CONFIDENCE":
      return "TRUST_FLOOR_NOT_MET";
    case "HIGH_IMPACT_REQUIRES_STRONG_EVIDENCE":
      return "HIGH_IMPACT_WEAK_EVIDENCE";
    case "OWNERSHIP_MISMATCH":
    case "CROSS_TENANT_PROPOSAL":
      return "OWNERSHIP_MISMATCH";
    case "CROSS_TENANT_EVIDENCE":
      return "CROSS_TENANT_EVIDENCE";
    case "UNKNOWN_RECOMMENDATION_TYPE":
    case "CLIENT_AUTHORITY_FIELD_REJECTED":
      return "SECURITY_REJECTION";
    case "PROMPT_INJECTION_SUSPECTED":
      return "PROMPT_INJECTION_CONTAINED";
    case "EXPIRED_APPROVAL":
      return "APPROVAL_EXPIRED";
    case "EXPIRED_DECISION":
      return "DECISION_EXPIRED";
    default:
      return null;
  }
}
