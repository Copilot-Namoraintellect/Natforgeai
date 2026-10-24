// ─── R5-D Opportunity Detection — policy / suppression gates (contract §9, D6) ───
//
// PURE gate layer applied BEFORE the rule table. Opportunity detection is
// observational: a candidate's existence is never an authorization to contact
// anyone, and this stream never initiates governed marketing actions (R5-E
// owns action policy; decisions are consumed read-only). DENY/ESCALATE
// engagement decisions are never treated as outreach permission.

import type { CanonicalInterpretation } from "./canonical-intelligence";
import {
  hasGatingRiskFlag,
  hasSafetyCriticalFlag,
} from "./canonical-intelligence";
import type { SuppressionReason } from "./opportunity-contract";

export type PolicyGateOutcome =
  | { readonly gated: false }
  | { readonly gated: true; readonly reason: SuppressionReason; readonly detail: string };

/**
 * Safety + risk gates. Safety-critical evidence is suppressed (and an existing
 * candidate would be escalated by the orchestrator); non-safety gating risk
 * flags suppress candidate creation. These are routing outcomes, not
 * moderation verdicts and not action permissions.
 */
export function applyPolicyGates(interpretation: CanonicalInterpretation): PolicyGateOutcome {
  if (
    interpretation.recommendedHandling === "safety_escalation" ||
    hasSafetyCriticalFlag(interpretation)
  ) {
    return {
      gated: true,
      reason: "SAFETY_ESCALATION",
      detail: "safety-critical classification from R5-B; opportunity evaluation halted",
    };
  }
  if (hasGatingRiskFlag(interpretation)) {
    return {
      gated: true,
      reason: "RISK_GATED",
      detail: "gating risk flag present; opportunity evaluation halted pending review",
    };
  }
  return { gated: false };
}

/**
 * Explicit R5-E policy suppression input (read-only seam). When a durable
 * policy decision bound to this interpretation records suppression
 * (NO_ACTION / suppress_action / DENY of an engagement action), detection
 * honors it as POLICY_SUPPRESSED. ALLOW_AUTONOMOUS is never derived here.
 */
export interface PolicyDecisionLike {
  readonly decision: "ALLOW_AUTONOMOUS" | "REQUIRE_APPROVAL" | "DENY" | "ESCALATE" | "NO_ACTION";
  readonly actionType: string;
}

export function applyExplicitPolicySuppression(
  decision: PolicyDecisionLike | null | undefined
): PolicyGateOutcome {
  if (!decision) return { gated: false };
  if (decision.decision === "NO_ACTION" || decision.actionType === "suppress_action") {
    return {
      gated: true,
      reason: "POLICY_SUPPRESSED",
      detail: "explicit policy suppression decision bound to the interpretation",
    };
  }
  // DENY / ESCALATE on an engagement action are not, by themselves, policy
  // suppression of detection — but they are never outreach permission either.
  // Detection proceeds; any downstream action remains separately governed.
  return { gated: false };
}
