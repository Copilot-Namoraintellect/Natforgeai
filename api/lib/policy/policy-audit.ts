/**
 * Policy Decision Audit + Explainability (WBS-R5-E7).
 *
 * Every accepted policy decision produces exactly one canonical
 * `policy_decision` audit event. The event and the durable decision row are
 * explainable WITHOUT model chain-of-thought: closed reason codes, the
 * policy version, the thresholds used and opaque evidence references.
 *
 * Sensitive-data restrictions: metadata carries only decision vocabulary,
 * reason codes, threshold numbers, fingerprints and opaque ids (signal,
 * interpretation, billing identity). Raw social text, tokens, PII and
 * provider keys are never persisted — the canonical WBS7A sanitizer strips
 * any sensitive key as defence in depth.
 */

import { createAuditEvent, type AuditEvent } from "../audit/audit-event";
import type { PolicyDecision } from "./decision-engine";
import { POLICY_DECISIONS, type PolicyDecisionOutcome, type PolicyReasonCode } from "./policy-types";

export const POLICY_DECISION_AUDIT_EVENT_TYPE = "policy_decision" as const;

/** Bounded, operator-readable descriptions for every closed reason code. */
export const POLICY_REASON_EXPLANATIONS: Readonly<Record<PolicyReasonCode, string>> = {
  ACTION_ALLOWED_BY_POLICY: "The action type is in the business policy autonomous list and every gate passed.",
  ACTION_PROHIBITED_BY_POLICY: "The action type is explicitly prohibited by the business policy.",
  ACTION_REQUIRES_APPROVAL_BY_POLICY: "The action type always requires explicit human approval under the business policy.",
  ACTION_DEFAULTED_TO_APPROVAL: "The action type is not listed in the policy; the safe default requires approval.",
  ACTION_DEFAULTED_TO_DENY: "The action type is not listed in the policy; the configured default denies it.",
  POLICY_MISSING: "No business policy exists; the system fails closed.",
  UNKNOWN_ACTION_TYPE: "The action type is outside the governed vocabulary; the system fails closed.",
  ACTION_REQUEST_IDENTITY_CONFLICT: "The same action request id arrived with conflicting material identity.",
  APPROVAL_REQUIRED_BY_RISK: "The classified risk tier maps to human approval under the policy risk table.",
  ESCALATED_BY_RISK: "The classified risk tier maps to immediate human handling under the policy risk table.",
  CRITICAL_RISK_ESCALATION: "Critical-risk classes always escalate to immediate human handling.",
  CONFIDENCE_BELOW_AUTONOMY_MIN: "Interpretation confidence is below the policy autonomy floor, raising the risk tier.",
  INJECTION_SUSPECTED: "The interpretation authority flagged prompt-injection patterns; autonomy can only be reduced.",
  CHANNEL_PROHIBITED_BY_POLICY: "The platform is prohibited by the business policy.",
  CHANNEL_NOT_IN_ALLOWED_LIST: "The platform is outside the policy allowed-platform list.",
  OUTSIDE_BUSINESS_HOURS: "Autonomous execution is restricted to configured business hours; approval is required outside them.",
  COST_CLASS_DECLARATION_MISMATCH: "The caller-declared cost class differed from the derived class; the derived class was used.",
  BUDGET_INSUFFICIENT_BALANCE: "Available wallet balance (net of reservations) cannot cover the action estimate.",
  BUDGET_DAILY_SYSTEM_LIMIT: "The action would exceed the system daily AI credit limit.",
  BUDGET_MONTHLY_SYSTEM_LIMIT: "The action would exceed the system monthly AI credit limit.",
  BUDGET_WALLET_SPEND_LIMIT: "The action would exceed the wallet spend ceiling.",
  BUDGET_AUTONOMOUS_DAILY_CAP: "The action would exceed the business policy daily autonomous spend cap.",
  COST_CLASS_EXCEEDS_POLICY_CAP: "The derived action cost exceeds the per-action credit ceiling.",
  QUOTA_DAILY_ACTION_CAP: "The business policy daily action cap is reached.",
  QUOTA_CHANNEL_DAILY_CAP: "The business policy per-channel daily cap is reached.",
  RATE_LIMIT_PROVIDER: "The provider rate-limit state is tripped.",
  PROVIDER_CAPABILITY_UNAVAILABLE: "The provider does not offer the required capability for this action on the binding.",
  PROVIDER_BINDING_MISMATCH: "The provider account binding is missing, unverified or not connected.",
  OWNERSHIP_MISMATCH: "A referenced resource belongs to a different tenant.",
  INTELLIGENCE_BINDING_MISMATCH: "The authoritative interpretation does not match the action request's declared source.",
  SUPPRESSION_REQUESTED: "The action request asked policy to durably suppress this action.",
  NON_BILLABLE_ACTION: "The action type carries no charge.",
  ESCALATION_REQUIRES_OPERATOR: "Escalated items are handled by an operator; machine execution is never authorized.",
  EXPIRED_DECISION: "The decision or approval binding has expired.",
  APPROVAL_NOT_FOUND: "No approval exists for this decision.",
  APPROVAL_PENDING: "The approval request is still pending a human decision.",
  ACTION_REJECTED_BY_HUMAN: "A human rejected this action identity; the block is permanent.",
  STALE_POLICY_VERSION: "The business policy changed after evaluation; the authorization is stale.",
  CONTEXT_VERSION_MISMATCH: "The action context changed after evaluation; the authorization is stale.",
  APPROVAL_BINDING_MISMATCH: "The approval does not bind to exactly this decision and policy version.",
};

/**
 * Build the canonical audit event for one durable decision. The caller
 * supplies occurredAt (the evaluation time); this module never invents time.
 */
export function buildPolicyDecisionAuditEvent(input: {
  decision: PolicyDecision;
  occurredAt: string;
}): AuditEvent {
  const d = input.decision;
  return createAuditEvent({
    eventType: POLICY_DECISION_AUDIT_EVENT_TYPE,
    occurredAt: input.occurredAt,
    userId: d.userId,
    source: "system",
    outcome: "succeeded",
    campaignId: d.campaignId,
    businessId: d.businessId,
    approvalRequestId: null,
    metadata: {
      actionRequestId: d.actionRequestId,
      actionType: d.actionType,
      platform: d.platform,
      decision: d.decision,
      policyId: d.policyId,
      policyVersion: d.policyVersion,
      reasonCodes: [...d.reasonCodes],
      riskClass: d.riskClass,
      approvalRequired: d.approvalRequired,
      costEligible: d.costEligible,
      rateEligible: d.rateEligible,
      providerEligible: d.providerEligible,
      estimatedCostClass: d.estimatedCostClass,
      estimatedCredits: d.estimatedCredits,
      billingIdentity: d.billingIdentity,
      intelligenceVersion: d.intelligenceVersion,
      sourceSignalId: d.sourceSignalId,
      sourceInterpretationId: d.sourceInterpretationId,
      thresholds: { ...d.thresholds },
      expiresAt: d.expiresAt,
      evaluationFingerprint: d.evaluationFingerprint,
    },
  });
}

export interface PolicyDecisionExplanation {
  policyDecisionId: string;
  actionRequestId: string;
  decision: PolicyDecisionOutcome;
  policyVersion: string | null;
  riskClass: string;
  approvalRequired: boolean;
  costEligible: boolean;
  rateEligible: boolean;
  providerEligible: boolean;
  /** Operator answer to "why?" — one entry per closed reason code. */
  reasons: Array<{ code: PolicyReasonCode; explanation: string }>;
  /** Bounded thresholds used at evaluation time. */
  thresholds: Record<string, number>;
  /** Opaque evidence references (no content). */
  evidence: {
    sourceSignalId: string | null;
    sourceInterpretationId: string | null;
    intelligenceVersion: string | null;
    evaluationFingerprint: string;
    evaluatedAt: string;
  };
  billingIdentity: string | null;
  expiresAt: string | null;
}

/**
 * Deterministic explanation of a durable decision — answers "why allowed?",
 * "why denied?", "why approval?", "why escalated?" from recorded facts only,
 * with no hidden reasoning.
 */
export function explainPolicyDecision(decision: PolicyDecision): PolicyDecisionExplanation {
  if (!POLICY_DECISIONS.includes(decision.decision)) {
    throw new Error(`explainPolicyDecision: unknown decision outcome ${String(decision.decision)}.`);
  }
  return {
    policyDecisionId: decision.policyDecisionId,
    actionRequestId: decision.actionRequestId,
    decision: decision.decision,
    policyVersion: decision.policyVersion,
    riskClass: decision.riskClass,
    approvalRequired: decision.approvalRequired,
    costEligible: decision.costEligible,
    rateEligible: decision.rateEligible,
    providerEligible: decision.providerEligible,
    reasons: decision.reasonCodes.map((code) => ({
      code,
      explanation: POLICY_REASON_EXPLANATIONS[code] ?? "Unknown reason code.",
    })),
    thresholds: { ...decision.thresholds },
    evidence: {
      sourceSignalId: decision.sourceSignalId,
      sourceInterpretationId: decision.sourceInterpretationId,
      intelligenceVersion: decision.intelligenceVersion,
      evaluationFingerprint: decision.evaluationFingerprint,
      evaluatedAt: decision.evaluatedAt,
    },
    billingIdentity: decision.billingIdentity,
    expiresAt: decision.expiresAt,
  };
}
