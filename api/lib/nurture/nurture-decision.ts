// ─── R6-D Nurture / Sales Handoff — deterministic decision engine (contract §5, §6) ───
//
// PURE module: derives the governed nurture/handoff decision from the
// validated upstream world-state. First match wins; every path is
// deterministic and replay-safe (same input world-state ⇒ same decisionKey ⇒
// one durable row). Privacy always overrides progression; qualification is
// necessary, never sufficient. No I/O, no database access.

import {
  deriveDecisionKey,
  deriveNurtureDecisionId,
  fingerprintQualificationProjection,
} from "./nurture-identity";
import {
  type NurtureChannel,
  type NurtureDecision,
  type NurtureReasonCode,
} from "./nurture-contract";
import {
  type NurtureHandoffPolicy,
  isChannelAllowed,
  doesChannelRequireApproval,
  deriveDecisionValidity,
} from "./nurture-policy";
import {
  type QualificationHandoffProjection,
  type PrivacyEvidence,
  isPrivacyActionable,
  privacyBlockReason,
} from "./nurture-upstream";
import { checkNurtureCadence, type NurtureTouchRecord } from "./nurture-cadence";

export interface NurtureDecisionInput {
  userId: number;
  qualification: QualificationHandoffProjection;
  privacy: PrivacyEvidence;
  /** True when an authoritative, non-reversed conversion exists (E port, §13). */
  conversionStopped: boolean;
  /** True when a sales_handoffs row already exists for the identity (§8). */
  handoffExists: boolean;
  policy: NurtureHandoffPolicy;
  /** null = progression evaluation (SALES_HANDOFF path); set = nurture path. */
  channel: NurtureChannel | null;
  /** Durable touch history for the lead+channel (nurture path only). */
  touches: readonly NurtureTouchRecord[];
  now: Date;
}

export interface DerivedNurtureDecision {
  decisionKey: string;
  nurtureDecisionId: string;
  qualificationFingerprint: string;
  decision: NurtureDecision;
  reasonCodes: readonly NurtureReasonCode[];
  approvalRequired: boolean;
  channel: NurtureChannel | null;
  policyVersion: string;
  validUntil: string;
}

function reviewReason(
  qualification: QualificationHandoffProjection
): Extract<NurtureReasonCode, "REVIEW_REQUIRED_PENDING" | "REVIEW_REJECTED"> {
  return qualification.review?.status === "progression_rejected"
    ? "REVIEW_REJECTED"
    : "REVIEW_REQUIRED_PENDING";
}

/**
 * Deterministic decision derivation (contract §5–§6). Gate order is
 * normative: privacy → freshness → qualification decision → conversion stop
 * → progression (handoff / nurture+channel+cadence).
 */
export function deriveNurtureDecision(input: NurtureDecisionInput): DerivedNurtureDecision {
  const { qualification, privacy, policy, channel, now } = input;
  const qualificationFingerprint = fingerprintQualificationProjection(qualification);

  let decision: NurtureDecision;
  let reasonCodes: readonly NurtureReasonCode[];
  let approvalRequired = false;
  let cadenceBlocked: boolean | null = null;

  // 1. Privacy gate — always overrides progression (contract §4).
  if (!isPrivacyActionable(privacy, now)) {
    const reason = privacyBlockReason(privacy);
    decision = "BLOCKED";
    reasonCodes = [reason];
  }
  // 2. Freshness — only the current, unexpired decision may progress (C §9).
  else if (now.getTime() > Date.parse(qualification.validUntil)) {
    decision = "BLOCKED";
    reasonCodes = ["STALE_DECISION"];
  }
  // 3. Qualification decision (closed vocabulary).
  else if (qualification.decision === "BLOCKED") {
    decision = "BLOCKED";
    reasonCodes = ["DECISION_BLOCKED"];
  } else if (qualification.decision === "REVIEW_REQUIRED") {
    decision = "REVIEW_REQUIRED";
    reasonCodes = [reviewReason(qualification)];
  } else if (qualification.decision === "INSUFFICIENT_EVIDENCE") {
    decision = "WAIT";
    reasonCodes = ["INSUFFICIENT_EVIDENCE"];
  } else if (qualification.decision === "NOT_QUALIFIED") {
    decision = "NO_ACTION";
    reasonCodes = ["DECISION_NOT_QUALIFIED"];
  }
  // 4. Conversion stop (contract §13) — policy-controlled, default true.
  else if (input.conversionStopped && policy.config.stopOnAuthoritativeConversion) {
    decision = "NO_ACTION";
    reasonCodes = ["CONVERSION_STOP"];
  }
  // 5. Progression.
  else {
    if (channel === null) {
      // Progression evaluation: the governed sales-handoff path (contract §8).
      decision = "SALES_HANDOFF";
      approvalRequired = policy.config.handoffRequiresApproval;
      reasonCodes = approvalRequired
        ? ["APPROVAL_REQUIRED_BY_POLICY"]
        : ["ACTION_ALLOWED_BY_POLICY"];
    } else {
      // Nurture evaluation on one channel (contract §6–§7).
      if (!isChannelAllowed(policy, channel)) {
        decision = "BLOCKED";
        reasonCodes = ["CAPABILITY_BLOCKED"];
      } else {
        const cadence = checkNurtureCadence({ policy, touches: input.touches, now });
        cadenceBlocked = !cadence.allowed;
        if (!cadence.allowed) {
          decision = "WAIT";
          reasonCodes = ["NURTURE_CADENCE_LIMITED"];
        } else {
          decision = "NURTURE";
          approvalRequired = doesChannelRequireApproval(policy, channel);
          reasonCodes = approvalRequired
            ? ["APPROVAL_REQUIRED_BY_POLICY"]
            : ["ACTION_ALLOWED_BY_POLICY"];
        }
      }
    }
  }

  const decisionKey = deriveDecisionKey({
    userId: input.userId,
    businessId: qualification.businessId,
    leadId: qualification.leadId,
    qualificationId: qualification.qualificationId,
    qualificationFingerprint,
    privacyState: privacy.state,
    privacyStateUpdatedAt: privacy.updatedAt ?? null,
    conversionStopped: input.conversionStopped,
    handoffExists: input.handoffExists,
    policyVersion: policy.policyVersion,
    channel,
    cadenceBlocked,
  });

  return {
    decisionKey,
    nurtureDecisionId: deriveNurtureDecisionId(decisionKey),
    qualificationFingerprint,
    decision,
    reasonCodes,
    approvalRequired,
    channel,
    policyVersion: policy.policyVersion,
    validUntil: deriveDecisionValidity(policy, now),
  };
}

/** A decision is progression-bearing when it authorizes nurture or handoff. */
export function isProgressionDecision(decision: NurtureDecision): boolean {
  return decision === "NURTURE" || decision === "SALES_HANDOFF";
}
