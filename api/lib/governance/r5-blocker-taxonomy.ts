/**
 * R5 Operation / Blocker Taxonomy (WBS-R5-F2).
 *
 * Controlled vocabulary of operational blocker classes for R5 Marketing
 * Operations and their recovery classifications. This module is pure policy:
 * no I/O, no clock, no state. It answers two questions for every blocker
 * class:
 *
 *  1. Who/what can clear it?  -> R5RecoveryClass
 *  2. What health impact does an open blocker of this class have on the
 *     business operational projection? -> R5BlockerHealthImpact
 *
 * Normative rule (stream charter): automatic recovery is NEVER invented for
 * conditions that require a human decision. Anything involving credentials,
 * money, policy approval, ownership, or security is a human/governance
 * decision and is classified accordingly.
 */

export const R5_BLOCKER_CLASSES = [
  "PROVIDER_AUTH_EXPIRED",
  "PROVIDER_SCOPE_MISSING",
  "RATE_LIMITED",
  "QUEUE_UNAVAILABLE",
  "REDIS_UNAVAILABLE",
  "MODEL_TIMEOUT",
  "MODEL_CONFIGURATION_MISSING",
  "POLICY_REQUIRES_APPROVAL",
  "BUDGET_EXHAUSTED",
  "QUOTA_EXHAUSTED",
  "STALE_OPERATION",
  "UNSUPPORTED_PROVIDER_CAPABILITY",
  "OWNERSHIP_MISMATCH",
  "MALFORMED_EXTERNAL_PAYLOAD",
  "SECURITY_REJECTION",
] as const;

export type R5BlockerClass = (typeof R5_BLOCKER_CLASSES)[number];

const R5_BLOCKER_CLASS_SET: ReadonlySet<string> = new Set(R5_BLOCKER_CLASSES);

export function isR5BlockerClass(value: unknown): value is R5BlockerClass {
  return typeof value === "string" && R5_BLOCKER_CLASS_SET.has(value);
}

/**
 * Recovery classifications. Exactly one applies per blocker instance:
 *
 * - AUTO_RECOVER: the platform may retry/clear it on its own within bounded
 *   backoff; no human decision is embedded in the condition.
 * - OPERATOR_ACTION: a human operator must act (reconnect, requeue, reconfigure).
 * - FAIL_CLOSED: recovery is not possible/allowed; the operation stays
 *   terminal/inert and the evidence is preserved for review.
 * - GOVERNANCE_APPROVAL: a governed human approval/billing decision is
 *   required; the system must not self-approve.
 */
export const R5_RECOVERY_CLASSES = [
  "AUTO_RECOVER",
  "OPERATOR_ACTION",
  "FAIL_CLOSED",
  "GOVERNANCE_APPROVAL",
] as const;

export type R5RecoveryClass = (typeof R5_RECOVERY_CLASSES)[number];

/**
 * Health impact of an open blocker on the business operational projection.
 * Used by the F1 classifier to roll blockers up into a single health state.
 * Precedence (worst wins): fail_closed > operator > configuration > auto > none.
 */
export const R5_BLOCKER_HEALTH_IMPACTS = [
  "none",
  "auto",
  "configuration",
  "operator",
  "fail_closed",
] as const;

export type R5BlockerHealthImpact = (typeof R5_BLOCKER_HEALTH_IMPACTS)[number];

export interface R5BlockerClassPolicy {
  readonly recoveryClass: R5RecoveryClass;
  readonly healthImpact: R5BlockerHealthImpact;
  /**
   * Whether the platform's own retry machinery may attempt recovery without
   * a human decision. TRUE only for AUTO_RECOVER classes.
   */
  readonly systemRetryAllowed: boolean;
  /** Normative rationale; surfaces in operator documentation. */
  readonly rationale: string;
}

export const R5_BLOCKER_CLASS_POLICY: Record<R5BlockerClass, R5BlockerClassPolicy> = {
  PROVIDER_AUTH_EXPIRED: {
    recoveryClass: "OPERATOR_ACTION",
    healthImpact: "operator",
    systemRetryAllowed: false,
    rationale:
      "Credentials for a provider binding have expired; reconnecting is a human account decision and must never be auto-retried.",
  },
  PROVIDER_SCOPE_MISSING: {
    recoveryClass: "OPERATOR_ACTION",
    healthImpact: "operator",
    systemRetryAllowed: false,
    rationale:
      "The provider binding lacks a required permission scope; granting scope is a human consent decision.",
  },
  RATE_LIMITED: {
    recoveryClass: "AUTO_RECOVER",
    healthImpact: "auto",
    systemRetryAllowed: true,
    rationale:
      "Provider/platform throttling; bounded backoff retry is safe and contains no human decision.",
  },
  QUEUE_UNAVAILABLE: {
    recoveryClass: "AUTO_RECOVER",
    healthImpact: "auto",
    systemRetryAllowed: true,
    rationale:
      "Transient queue infrastructure unavailability; bounded retry is safe.",
  },
  REDIS_UNAVAILABLE: {
    recoveryClass: "AUTO_RECOVER",
    healthImpact: "auto",
    systemRetryAllowed: true,
    rationale:
      "Transient cache/coordination store unavailability; bounded retry is safe.",
  },
  MODEL_TIMEOUT: {
    recoveryClass: "AUTO_RECOVER",
    healthImpact: "auto",
    systemRetryAllowed: true,
    rationale:
      "Model/provider call timeout; bounded retry is safe.",
  },
  MODEL_CONFIGURATION_MISSING: {
    recoveryClass: "OPERATOR_ACTION",
    healthImpact: "configuration",
    systemRetryAllowed: false,
    rationale:
      "A required model/provider configuration value is absent; supplying it is an operator configuration decision.",
  },
  POLICY_REQUIRES_APPROVAL: {
    recoveryClass: "GOVERNANCE_APPROVAL",
    healthImpact: "operator",
    systemRetryAllowed: false,
    rationale:
      "Policy requires a human approval before action; auto-approving would fabricate governance and is forbidden.",
  },
  BUDGET_EXHAUSTED: {
    recoveryClass: "GOVERNANCE_APPROVAL",
    healthImpact: "configuration",
    systemRetryAllowed: false,
    rationale:
      "Credits/budget for the business are exhausted; releasing more spend is a governed billing decision.",
  },
  QUOTA_EXHAUSTED: {
    recoveryClass: "GOVERNANCE_APPROVAL",
    healthImpact: "configuration",
    systemRetryAllowed: false,
    rationale:
      "A plan/tier quota is exhausted; raising the limit is a governed subscription decision.",
  },
  STALE_OPERATION: {
    recoveryClass: "OPERATOR_ACTION",
    healthImpact: "operator",
    systemRetryAllowed: false,
    rationale:
      "An operation stopped progressing without reaching a terminal state; requeueing is an explicit operator decision on a governed recovery surface.",
  },
  UNSUPPORTED_PROVIDER_CAPABILITY: {
    recoveryClass: "OPERATOR_ACTION",
    healthImpact: "configuration",
    systemRetryAllowed: false,
    rationale:
      "The bound provider cannot perform the requested capability; choosing a different binding/capability is an operator configuration decision.",
  },
  OWNERSHIP_MISMATCH: {
    recoveryClass: "FAIL_CLOSED",
    healthImpact: "fail_closed",
    systemRetryAllowed: false,
    rationale:
      "Evidence references a different owner/business than the authoritative record; continuing would cross tenant boundaries. Fail closed, preserve evidence.",
  },
  MALFORMED_EXTERNAL_PAYLOAD: {
    recoveryClass: "FAIL_CLOSED",
    healthImpact: "fail_closed",
    systemRetryAllowed: false,
    rationale:
      "An external payload failed validation and must not be retried (retrying garbage amplifies damage); operator reviews bounded evidence.",
  },
  SECURITY_REJECTION: {
    recoveryClass: "FAIL_CLOSED",
    healthImpact: "fail_closed",
    systemRetryAllowed: false,
    rationale:
      "A security/policy control rejected the action; recovery would mean bypassing the control and is forbidden.",
  },
};

export function recoveryClassFor(blockerClass: R5BlockerClass): R5RecoveryClass {
  return R5_BLOCKER_CLASS_POLICY[blockerClass].recoveryClass;
}

export function healthImpactFor(blockerClass: R5BlockerClass): R5BlockerHealthImpact {
  return R5_BLOCKER_CLASS_POLICY[blockerClass].healthImpact;
}

export function isSystemRetryAllowed(blockerClass: R5BlockerClass): boolean {
  return R5_BLOCKER_CLASS_POLICY[blockerClass].systemRetryAllowed;
}

export const R5_BLOCKER_HEALTH_IMPACT_PRECEDENCE: Record<
  R5BlockerHealthImpact,
  number
> = {
  none: 0,
  auto: 1,
  configuration: 2,
  operator: 3,
  fail_closed: 4,
};

/**
 * Best-effort mapping from a bounded provider/platform failure code or error
 * string to a blocker class. Returns null when nothing reliable can be
 * inferred; callers then fall back to the area's own default handling
 * (the projection never guesses a security or ownership class).
 */
export function mapFailureCodeToBlockerClass(
  code: string | null | undefined
): R5BlockerClass | null {
  if (!code) return null;
  const text = String(code).toLowerCase();
  if (/ownership|tenant|cross.?business|wrong_business/.test(text)) {
    return "OWNERSHIP_MISMATCH";
  }
  if (/malformed|invalid_payload|parse_error|schema_violation|bad_payload/.test(text)) {
    return "MALFORMED_EXTERNAL_PAYLOAD";
  }
  if (/security|policy_deny|forbidden|safety_reject|blocked_by_policy/.test(text)) {
    return "SECURITY_REJECTION";
  }
  if (/scope|permission|insufficient_scope|missing_scope/.test(text)) {
    return "PROVIDER_SCOPE_MISSING";
  }
  if (/unsupported_capability|capability_unsupported|not_supported/.test(text)) {
    return "UNSUPPORTED_PROVIDER_CAPABILITY";
  }
  if (
    /auth|token|expired|unauthorized|401|invalid_grant|credential/.test(text)
  ) {
    return "PROVIDER_AUTH_EXPIRED";
  }
  if (/rate|429|throttle|too_many|quota_exceeded_provider/.test(text)) {
    return "RATE_LIMITED";
  }
  if (/redis/.test(text)) return "REDIS_UNAVAILABLE";
  if (/timeout|timed_out|deadline|etimedout/.test(text)) return "MODEL_TIMEOUT";
  if (/model_config|missing_model|not_configured|configuration_missing/.test(text)) {
    return "MODEL_CONFIGURATION_MISSING";
  }
  if (/queue|bullmq|econnrefused|connection_refused|unavailable/.test(text)) {
    return "QUEUE_UNAVAILABLE";
  }
  return null;
}
