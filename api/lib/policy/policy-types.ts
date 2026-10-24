/**
 * Shared policy kernel vocabularies (WBS-R5-E2/E3/E4).
 *
 * Pure closed vocabularies shared by the policy model, risk classifier and
 * decision engine. No logic lives here — only the typed words the governed
 * policy layer speaks. Everything fails closed outside these vocabularies.
 */

/** Governed risk tiers (E4). Ordered: low < medium < high < critical. */
export const RISK_TIERS = ["low", "medium", "high", "critical"] as const;

export type RiskTier = (typeof RISK_TIERS)[number];

const RISK_TIER_SET: ReadonlySet<string> = new Set(RISK_TIERS);

export function isRiskTier(value: unknown): value is RiskTier {
  return typeof value === "string" && RISK_TIER_SET.has(value);
}

export const RISK_TIER_RANK: Readonly<Record<RiskTier, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Canonical policy decision vocabulary (E3). Controlled and exhaustive:
 * downstream consumers must never invent additional outcomes.
 */
export const POLICY_DECISIONS = [
  "ALLOW_AUTONOMOUS",
  "REQUIRE_APPROVAL",
  "DENY",
  "ESCALATE",
  "NO_ACTION",
] as const;

export type PolicyDecisionOutcome = (typeof POLICY_DECISIONS)[number];

const POLICY_DECISION_SET: ReadonlySet<string> = new Set(POLICY_DECISIONS);

export function isPolicyDecisionOutcome(value: unknown): value is PolicyDecisionOutcome {
  return typeof value === "string" && POLICY_DECISION_SET.has(value);
}

/**
 * Autonomy ranking used to enforce the E4 invariant "higher risk can only
 * reduce autonomy, never expand it" and the E2 policy validation. Lower rank
 * = less autonomy. NO_ACTION is not part of the ranking: it is reserved for
 * explicit suppression requests and is never a risk-mapped outcome.
 */
export const DECISION_AUTONOMY_RANK: Readonly<
  Record<Exclude<PolicyDecisionOutcome, "NO_ACTION">, number>
> = {
  ALLOW_AUTONOMOUS: 3,
  REQUIRE_APPROVAL: 2,
  ESCALATE: 1,
  DENY: 0,
};

/** Closed vocabulary of policy reason codes (E3/E7 explainability). */
export const POLICY_REASON_CODES = [
  "ACTION_ALLOWED_BY_POLICY",
  "ACTION_PROHIBITED_BY_POLICY",
  "ACTION_REQUIRES_APPROVAL_BY_POLICY",
  "ACTION_DEFAULTED_TO_APPROVAL",
  "ACTION_DEFAULTED_TO_DENY",
  "POLICY_MISSING",
  "UNKNOWN_ACTION_TYPE",
  "ACTION_REQUEST_IDENTITY_CONFLICT",
  "APPROVAL_REQUIRED_BY_RISK",
  "ESCALATED_BY_RISK",
  "CRITICAL_RISK_ESCALATION",
  "CONFIDENCE_BELOW_AUTONOMY_MIN",
  "INJECTION_SUSPECTED",
  "CHANNEL_PROHIBITED_BY_POLICY",
  "CHANNEL_NOT_IN_ALLOWED_LIST",
  "OUTSIDE_BUSINESS_HOURS",
  "COST_CLASS_DECLARATION_MISMATCH",
  "BUDGET_INSUFFICIENT_BALANCE",
  "BUDGET_DAILY_SYSTEM_LIMIT",
  "BUDGET_MONTHLY_SYSTEM_LIMIT",
  "BUDGET_WALLET_SPEND_LIMIT",
  "BUDGET_AUTONOMOUS_DAILY_CAP",
  "COST_CLASS_EXCEEDS_POLICY_CAP",
  "QUOTA_DAILY_ACTION_CAP",
  "QUOTA_CHANNEL_DAILY_CAP",
  "RATE_LIMIT_PROVIDER",
  "PROVIDER_CAPABILITY_UNAVAILABLE",
  "PROVIDER_BINDING_MISMATCH",
  "OWNERSHIP_MISMATCH",
  "INTELLIGENCE_BINDING_MISMATCH",
  "SUPPRESSION_REQUESTED",
  "NON_BILLABLE_ACTION",
  "ESCALATION_REQUIRES_OPERATOR",
  "EXPIRED_DECISION",
  "APPROVAL_NOT_FOUND",
  "APPROVAL_PENDING",
  "ACTION_REJECTED_BY_HUMAN",
  "STALE_POLICY_VERSION",
  "CONTEXT_VERSION_MISMATCH",
  "APPROVAL_BINDING_MISMATCH",
] as const;

export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

const POLICY_REASON_CODE_SET: ReadonlySet<string> = new Set(POLICY_REASON_CODES);

export function isPolicyReasonCode(value: unknown): value is PolicyReasonCode {
  return typeof value === "string" && POLICY_REASON_CODE_SET.has(value);
}
