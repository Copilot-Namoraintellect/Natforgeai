// ─── R8-F Strategic Intelligence Governance — closed recommendation taxonomy (F2) ───
//
// The closed vocabulary of strategic recommendation types this governance
// authority recognises. Future R8 streams (reasoning / opportunity / risk) and
// R9 propose recommendations from this list ONLY. Unknown or unregistered
// types are BLOCKED by the decision engine — never silently defaulted to a
// weaker class.
//
// Deliberately ABSENT from this vocabulary: any type that would BE execution
// — there is no CAMPAIGN_LAUNCH, STRATEGY_MUTATE, BUDGET_INCREASE,
// DNA_MUTATION, or PROVIDER_EXECUTION recommendation type. Strategic
// recommendations are advisory; execution authority lives with R9+ governed
// capabilities through their own separate authorities (charter F7).
//
// Pure module: no I/O, no clock, no state. R8-F owns this vocabulary; adding
// a type is a code change to this closed list, not runtime data.

/**
 * Closed strategic recommendation types (F2). These describe *classes* of
 * strategic advisory intent, not concrete operations: governance decides
 * whether a proposal of one of these types may be voiced as a recommendation,
 * requires human review, or is blocked. It never decides which strategy is
 * optimal — that is the strategic-reasoning engine's job (sibling R8
 * streams), which this stream must never become (charter principle 8).
 */
export const STRATEGIC_RECOMMENDATION_TYPES = [
  "STRATEGIC_OBSERVATION",
  "STRATEGIC_HYPOTHESIS",
  "MARKET_RESPONSE_RECOMMENDATION",
  "BUSINESS_PRIORITY_RECOMMENDATION",
  "CHANNEL_STRATEGY_RECOMMENDATION",
  "AUDIENCE_STRATEGY_RECOMMENDATION",
  "PRODUCT_MARKETING_RECOMMENDATION",
  "OPPORTUNITY_RESPONSE_RECOMMENDATION",
  "RISK_RESPONSE_RECOMMENDATION",
  "RESOURCE_PRIORITY_RECOMMENDATION",
] as const;

export type StrategicRecommendationType = (typeof STRATEGIC_RECOMMENDATION_TYPES)[number];

const STRATEGIC_RECOMMENDATION_TYPE_SET: ReadonlySet<string> = new Set(
  STRATEGIC_RECOMMENDATION_TYPES
);

export function isStrategicRecommendationType(
  value: unknown
): value is StrategicRecommendationType {
  return typeof value === "string" && STRATEGIC_RECOMMENDATION_TYPE_SET.has(value);
}

/**
 * Base strategic risk ordinal per recommendation type (0=LOW … 3=CRITICAL),
 * BEFORE declared-impact modifiers and injection suspicion are applied.
 * Policy and the risk classifier may only RAISE this, never lower it
 * (a client/agent can never lower its own risk class — AC29).
 */
export function baseRiskOrdinalForRecommendation(type: StrategicRecommendationType): number {
  switch (type) {
    // Purely advisory observations and explicitly-tentative hypotheses: the
    // lowest base risk. Their confidence is still bounded by evidence quality.
    case "STRATEGIC_OBSERVATION":
    case "STRATEGIC_HYPOTHESIS":
      return 0; // LOW
    // Named-strategy recommendations: they shape direction, so they start at
    // MEDIUM and rise with declared impact.
    case "MARKET_RESPONSE_RECOMMENDATION":
    case "CHANNEL_STRATEGY_RECOMMENDATION":
    case "AUDIENCE_STRATEGY_RECOMMENDATION":
    case "PRODUCT_MARKETING_RECOMMENDATION":
    case "OPPORTUNITY_RESPONSE_RECOMMENDATION":
    case "RESOURCE_PRIORITY_RECOMMENDATION":
      return 1; // MEDIUM
    // Business-priority and risk-response recommendations can redirect the
    // whole business; they start at HIGH.
    case "BUSINESS_PRIORITY_RECOMMENDATION":
    case "RISK_RESPONSE_RECOMMENDATION":
      return 2; // HIGH
  }
}
