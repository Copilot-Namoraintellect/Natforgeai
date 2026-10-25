/**
 * R6-F lead blocker / recovery taxonomy (F2).
 *
 * Closed vocabulary of lead-specific blocker classes and their normative
 * recovery classifications. Pure policy: no I/O, no clock, no DB. Mirrors the
 * R5-F governance taxonomy (`r5-blocker-taxonomy.ts`) with lead-specific
 * classes; the recovery-class and health-impact vocabularies are reused.
 *
 * Security/ownership classes are only produced from explicit fail-closed
 * evidence by the projection — never inferred from absence of data
 * (mirrors R5 rule).
 *
 * Invariant: automatic recovery is never declared for conditions that embed
 * a human/business decision (identity merge judgment, qualification review,
 * nurture policy, suppression lifting, retention disposition, security).
 */

export const LEAD_RECOVERY_CLASSES = [
  "AUTO_RECOVER",
  "OPERATOR_ACTION",
  "FAIL_CLOSED",
  "GOVERNANCE_APPROVAL",
] as const;

export type LeadRecoveryClass = (typeof LEAD_RECOVERY_CLASSES)[number];

export const LEAD_BLOCKER_HEALTH_IMPACTS = [
  "none",
  "auto",
  "configuration",
  "operator",
  "fail_closed",
] as const;

export type LeadBlockerHealthImpact = (typeof LEAD_BLOCKER_HEALTH_IMPACTS)[number];

/** Worst wins (mirrors R5). */
export const LEAD_BLOCKER_HEALTH_IMPACT_PRECEDENCE: Record<
  LeadBlockerHealthImpact,
  number
> = {
  none: 0,
  auto: 1,
  configuration: 2,
  operator: 3,
  fail_closed: 4,
};

export const LEAD_BLOCKER_CLASSES = [
  "IDENTITY_CONFLICT",
  "IDENTITY_INSUFFICIENT_EVIDENCE",
  "SCORE_STALE",
  "SCORE_UNAVAILABLE",
  "QUALIFICATION_REQUIRES_REVIEW",
  "QUALIFICATION_BLOCKED",
  "NURTURE_POLICY_BLOCKED",
  "SALES_HANDOFF_FAILED",
  "CRM_UNAVAILABLE",
  "CONVERSION_LINKAGE_UNRESOLVED",
  "PRIVACY_SUPPRESSED",
  "RETENTION_EXPIRED",
  "CROSS_TENANT_REJECTION",
  "SECURITY_REJECTION",
  "STALE_OPERATION",
  "UNSUPPORTED_CAPABILITY",
] as const;

export type LeadBlockerClass = (typeof LEAD_BLOCKER_CLASSES)[number];

const LEAD_BLOCKER_CLASS_SET: ReadonlySet<string> = new Set(LEAD_BLOCKER_CLASSES);

export function isLeadBlockerClass(value: unknown): value is LeadBlockerClass {
  return typeof value === "string" && LEAD_BLOCKER_CLASS_SET.has(value);
}

export interface LeadBlockerClassPolicy {
  readonly recoveryClass: LeadRecoveryClass;
  readonly healthImpact: LeadBlockerHealthImpact;
  /**
   * Whether the platform's own retry machinery may attempt recovery without
   * a human decision. TRUE only for AUTO_RECOVER classes.
   */
  readonly systemRetryAllowed: boolean;
  /** Normative rationale; surfaces in operator documentation. */
  readonly rationale: string;
}

export const LEAD_BLOCKER_CLASS_POLICY: Record<LeadBlockerClass, LeadBlockerClassPolicy> = {
  IDENTITY_CONFLICT: {
    recoveryClass: "OPERATOR_ACTION",
    healthImpact: "operator",
    systemRetryAllowed: false,
    rationale:
      "Two or more identity records claim the same lead; resolution embeds human merge judgment. Force-merge is forbidden everywhere.",
  },
  IDENTITY_INSUFFICIENT_EVIDENCE: {
    recoveryClass: "AUTO_RECOVER",
    healthImpact: "auto",
    systemRetryAllowed: true,
    rationale:
      "Identity evidence collection is still in progress; bounded system retry/enrichment is safe and contains no human decision.",
  },
  SCORE_STALE: {
    recoveryClass: "AUTO_RECOVER",
    healthImpact: "auto",
    systemRetryAllowed: true,
    rationale:
      "Score predates its freshness window; deterministic recomputation is safe and contains no human decision.",
  },
  SCORE_UNAVAILABLE: {
    recoveryClass: "OPERATOR_ACTION",
    healthImpact: "configuration",
    systemRetryAllowed: false,
    rationale:
      "Scoring authority is present but cannot produce a score (configuration/model/data gap); a human must fix the configuration.",
  },
  QUALIFICATION_REQUIRES_REVIEW: {
    recoveryClass: "GOVERNANCE_APPROVAL",
    healthImpact: "operator",
    systemRetryAllowed: false,
    rationale:
      "Qualification decision is parked in a human review queue; auto-qualifying would fabricate pipeline authority.",
  },
  QUALIFICATION_BLOCKED: {
    recoveryClass: "GOVERNANCE_APPROVAL",
    healthImpact: "operator",
    systemRetryAllowed: false,
    rationale:
      "A policy/governance decision blocks qualification; only the governance authority may lift it.",
  },
  NURTURE_POLICY_BLOCKED: {
    recoveryClass: "GOVERNANCE_APPROVAL",
    healthImpact: "operator",
    systemRetryAllowed: false,
    rationale:
      "Nurture outreach is blocked by policy (privacy, suppression, approval); sending anyway would bypass governance.",
  },
  SALES_HANDOFF_FAILED: {
    recoveryClass: "AUTO_RECOVER",
    healthImpact: "auto",
    systemRetryAllowed: true,
    rationale:
      "Handoff transport failed transiently; bounded retry of the governed transport is safe and contains no human decision.",
  },
  CRM_UNAVAILABLE: {
    recoveryClass: "AUTO_RECOVER",
    healthImpact: "auto",
    systemRetryAllowed: true,
    rationale:
      "CRM authority is transiently unreachable; bounded retry is safe and contains no human decision.",
  },
  CONVERSION_LINKAGE_UNRESOLVED: {
    recoveryClass: "OPERATOR_ACTION",
    healthImpact: "operator",
    systemRetryAllowed: false,
    rationale:
      "A conversion cannot be deterministically linked to its lead/campaign; reconciliation needs human evidence review.",
  },
  PRIVACY_SUPPRESSED: {
    recoveryClass: "GOVERNANCE_APPROVAL",
    healthImpact: "operator",
    systemRetryAllowed: false,
    rationale:
      "Lead is suppressed by a governance decision; lifting it is itself a governance decision, never automatic.",
  },
  RETENTION_EXPIRED: {
    recoveryClass: "OPERATOR_ACTION",
    healthImpact: "operator",
    systemRetryAllowed: false,
    rationale:
      "Retention deadline passed; the lead must not silently remain actionable. Disposition (archive vs controlled erasure) is a human decision.",
  },
  CROSS_TENANT_REJECTION: {
    recoveryClass: "FAIL_CLOSED",
    healthImpact: "fail_closed",
    systemRetryAllowed: false,
    rationale:
      "Evidence or a request references a different tenant/business than the authoritative record; continuing would cross tenant boundaries.",
  },
  SECURITY_REJECTION: {
    recoveryClass: "FAIL_CLOSED",
    healthImpact: "fail_closed",
    systemRetryAllowed: false,
    rationale:
      "A security/governance authority rejected the operation; retrying would bypass fail-closed authority.",
  },
  STALE_OPERATION: {
    recoveryClass: "OPERATOR_ACTION",
    healthImpact: "operator",
    systemRetryAllowed: false,
    rationale:
      "An operation has been retrying beyond its bounded window without convergence; an operator must inspect the durable anchors.",
  },
  UNSUPPORTED_CAPABILITY: {
    recoveryClass: "OPERATOR_ACTION",
    healthImpact: "configuration",
    systemRetryAllowed: false,
    rationale:
      "A required capability is explicitly unsupported for this lead/business; integration or configuration is a human decision.",
  },
};

export function leadRecoveryClassFor(blockerClass: LeadBlockerClass): LeadRecoveryClass {
  return LEAD_BLOCKER_CLASS_POLICY[blockerClass].recoveryClass;
}

export function leadHealthImpactFor(blockerClass: LeadBlockerClass): LeadBlockerHealthImpact {
  return LEAD_BLOCKER_CLASS_POLICY[blockerClass].healthImpact;
}

export function isLeadSystemRetryAllowed(blockerClass: LeadBlockerClass): boolean {
  return LEAD_BLOCKER_CLASS_POLICY[blockerClass].systemRetryAllowed;
}

/**
 * Best-effort mapping of bounded failure codes/strings to blocker classes.
 * Returns null when nothing reliable matches — callers must then fall back to
 * their area default, never to a security class.
 */
export function mapLeadFailureCodeToBlockerClass(
  code: string | null | undefined
): LeadBlockerClass | null {
  if (!code) return null;
  const text = String(code).toLowerCase();
  if (/cross.?tenant|wrong_business|tenant_mismatch|ownership/.test(text)) {
    return "CROSS_TENANT_REJECTION";
  }
  if (/security|policy_deny|forbidden|safety_reject|blocked_by_policy/.test(text)) {
    return "SECURITY_REJECTION";
  }
  if (/suppressed|suppression/.test(text)) return "PRIVACY_SUPPRESSED";
  if (/retention_expired|retention_due/.test(text)) return "RETENTION_EXPIRED";
  if (/identity_conflict|duplicate_identity/.test(text)) return "IDENTITY_CONFLICT";
  if (/insufficient_evidence|identity_evidence/.test(text)) {
    return "IDENTITY_INSUFFICIENT_EVIDENCE";
  }
  if (/score_stale|stale_score/.test(text)) return "SCORE_STALE";
  if (/score_unavailable|scoring_failed/.test(text)) return "SCORE_UNAVAILABLE";
  if (/qualification_review|requires_review/.test(text)) {
    return "QUALIFICATION_REQUIRES_REVIEW";
  }
  if (/qualification_blocked/.test(text)) return "QUALIFICATION_BLOCKED";
  if (/nurture_policy|policy_blocked/.test(text)) return "NURTURE_POLICY_BLOCKED";
  if (/handoff|transport|crm_sync/.test(text)) return "SALES_HANDOFF_FAILED";
  if (/crm_unavailable|crm_down/.test(text)) return "CRM_UNAVAILABLE";
  if (/conversion_linkage|unlinked_conversion/.test(text)) {
    return "CONVERSION_LINKAGE_UNRESOLVED";
  }
  if (/unsupported_capability|capability_unsupported|not_supported/.test(text)) {
    return "UNSUPPORTED_CAPABILITY";
  }
  if (/stale_operation|retry_exhausted/.test(text)) return "STALE_OPERATION";
  return null;
}
