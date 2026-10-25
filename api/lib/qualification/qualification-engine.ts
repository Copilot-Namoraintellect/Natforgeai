// ─── R6-C Lead Qualification — deterministic rule-first engine ───
//
// PURE function over validated, normalized evidence (contract §9). No model in
// the decision path; no AI-generated verdict. Normative precedence (first
// match wins): BLOCKED → INSUFFICIENT_EVIDENCE → NOT_QUALIFIED →
// REVIEW_REQUIRED → QUALIFIED. Score is evidence, not qualification: no path
// maps score/band directly to QUALIFIED.

import {
  IDENTITY_CONFIDENCE_ORDINAL,
  MAX_REASON_CODES,
  QUALIFICATION_REASON_CODE_VALUES,
  SCORE_BAND_ORDINAL,
  SCORE_CONFIDENCE_ORDINAL,
  type NormalizedIdentityEvidence,
  type NormalizedPrivacyState,
  type NormalizedScoreEvidence,
  type QualificationDecision,
  type QualificationReasonCode,
  type ScoreBand,
  type ScoreConfidence,
} from "./qualification-contract";
import type { QualificationPolicy } from "./qualification-policy";
import type { QualificationEvidenceEntry } from "./qualification-evidence";

const QUALIFICATION_REASON_CODE_SET: ReadonlySet<string> = new Set(
  QUALIFICATION_REASON_CODE_VALUES
);

const NON_ACTIONABLE_IDENTITY_STATUSES: ReadonlySet<string> = new Set([
  "suppressed",
  "archived",
  "conflicting",
]);

/** Governance read from R6-A: suppressed/archived/conflicting identities are non-actionable. */
export function isIdentityActionableStatus(identityStatus: string): boolean {
  return !NON_ACTIONABLE_IDENTITY_STATUSES.has(identityStatus);
}

const IDENTITY_CONFIDENCE_FACTOR: Readonly<Record<string, number>> = Object.freeze({
  unknown: 600,
  low: 800,
  medium: 900,
  high: 1000,
});

const SCORE_CONFIDENCE_FACTOR: Readonly<Record<ScoreConfidence, number>> = Object.freeze({
  UNKNOWN: 500,
  LOW: 750,
  MEDIUM: 900,
  HIGH: 1000,
});

const REQUIRED_EVIDENCE_CATEGORIES = ["business_fit", "demonstrated_intent"] as const;

export interface QualificationEvaluationResult {
  readonly decision: QualificationDecision;
  readonly reasonCodes: readonly QualificationReasonCode[];
  readonly confidenceScore: number;
  readonly reviewRequired: boolean;
}

function entryFor(
  entries: readonly QualificationEvidenceEntry[],
  category: string
): QualificationEvidenceEntry | undefined {
  return entries.find((candidate) => candidate.category === category);
}

function identityConfidenceOrdinal(identityConfidence: string): number {
  return (
    IDENTITY_CONFIDENCE_ORDINAL[
      identityConfidence as keyof typeof IDENTITY_CONFIDENCE_ORDINAL
    ] ?? 0
  );
}

function scoreBandOrdinal(scoreBand: ScoreBand): number {
  return SCORE_BAND_ORDINAL[scoreBand];
}

function scoreConfidenceOrdinal(scoreConfidence: ScoreConfidence): number {
  return SCORE_CONFIDENCE_ORDINAL[scoreConfidence];
}

/**
 * Deterministic confidence 0..10000 (contract §7): identity confidence factor
 * ×3 + score confidence factor ×3 + evidence density factor. Integer
 * arithmetic only; never client/model-set; not a probability.
 */
export function computeConfidenceScore(input: {
  identity: NormalizedIdentityEvidence;
  score: NormalizedScoreEvidence;
  policy: QualificationPolicy;
  entries: readonly QualificationEvidenceEntry[];
}): number {
  const identityFactor =
    IDENTITY_CONFIDENCE_FACTOR[input.identity.identityConfidence] ??
    IDENTITY_CONFIDENCE_FACTOR.unknown;
  const scoreConfidenceFactor = SCORE_CONFIDENCE_FACTOR[input.score.scoreConfidence];
  const requiredCategories = input.policy.requireEngagementEvidence
    ? [...REQUIRED_EVIDENCE_CATEGORIES, "engagement_evidence" as const]
    : [...REQUIRED_EVIDENCE_CATEGORIES];
  const presentCount = requiredCategories.filter(
    (category) => entryFor(input.entries, category)?.status === "present"
  ).length;
  const evidenceFactor = Math.round((4000 * presentCount) / requiredCategories.length);
  return identityFactor * 3 + scoreConfidenceFactor * 3 + evidenceFactor;
}

function dedupeCap(reasonCodes: QualificationReasonCode[]): QualificationReasonCode[] {
  const seen = new Set<QualificationReasonCode>();
  const result: QualificationReasonCode[] = [];
  for (const code of reasonCodes) {
    if (seen.has(code)) continue;
    seen.add(code);
    result.push(code);
    if (result.length >= MAX_REASON_CODES) break;
  }
  return result;
}

function isReasonCode(value: string): value is QualificationReasonCode {
  return QUALIFICATION_REASON_CODE_SET.has(value);
}

/**
 * Normative precedence engine (contract §9). Pure and reproducible from
 * evidence + rules alone: same inputs ⇒ byte-identical result.
 */
export function evaluateQualification(input: {
  identity: NormalizedIdentityEvidence;
  score: NormalizedScoreEvidence;
  policy: QualificationPolicy;
  entries: readonly QualificationEvidenceEntry[];
  privacy: NormalizedPrivacyState;
  now: Date;
}): QualificationEvaluationResult {
  const { identity, score, policy, entries, privacy } = input;
  const confidenceScore = computeConfidenceScore(input);

  // (1) BLOCKED — privacy gate not actionable; non-actionable identity status.
  if (!privacy.actionable) {
    const reasons: QualificationReasonCode[] = [
      privacy.blockedReason === "RETENTION_EXPIRED" ? "RETENTION_EXPIRED" : "PRIVACY_SUPPRESSED",
    ];
    return result("BLOCKED", reasons, confidenceScore);
  }
  if (!isIdentityActionableStatus(identity.identityStatus)) {
    return result("BLOCKED", ["IDENTITY_NOT_ACTIONABLE"], confidenceScore);
  }

  const fitEntry = entryFor(entries, "business_fit");
  const intentEntry = entryFor(entries, "demonstrated_intent");
  const engagementEntry = entryFor(entries, "engagement_evidence");
  const leadScoreEntry = entryFor(entries, "lead_score");
  const recencyEntry = entryFor(entries, "recency");
  const eligibilityEntry = entryFor(entries, "eligibility_restrictions");
  const identityEntry = entryFor(entries, "identity_validity");
  const scoreReasonCodes = new Set(score.reasonCodes);

  // (2) INSUFFICIENT_EVIDENCE — required categories missing/stale.
  const insufficientReasons: QualificationReasonCode[] = [];
  if (fitEntry?.status === "missing") insufficientReasons.push("MISSING_FIT_EVIDENCE");
  if (intentEntry?.status === "missing") insufficientReasons.push("MISSING_INTENT_EVIDENCE");
  if (
    policy.requireEngagementEvidence &&
    engagementEntry?.status === "missing"
  ) {
    insufficientReasons.push("INSUFFICIENT_EVIDENCE_DENSITY");
  }
  if (
    leadScoreEntry?.status === "stale" ||
    recencyEntry?.status === "stale"
  ) {
    insufficientReasons.push("INSUFFICIENT_EVIDENCE_DENSITY");
  }
  if (insufficientReasons.length > 0) {
    if (identityEntry?.status === "present") insufficientReasons.push("IDENTITY_CURRENT");
    return result("INSUFFICIENT_EVIDENCE", insufficientReasons, confidenceScore);
  }

  // (3) NOT_QUALIFIED — disqualifying evidence, then score below policy floor.
  if (eligibilityEntry?.status === "blocked") {
    return result("NOT_QUALIFIED", ["DISQUALIFYING_EVIDENCE"], confidenceScore);
  }
  if (scoreBandOrdinal(score.scoreBand) < scoreBandOrdinal(policy.minimumScoreBand)) {
    return result("NOT_QUALIFIED", ["SCORE_BELOW_THRESHOLD"], confidenceScore);
  }

  // (4) REVIEW_REQUIRED — policy triggers, unknown confidences, confidence floor.
  const reviewReasons: QualificationReasonCode[] = [];
  const triggered = policy.reviewTriggerReasonCodes.filter((code) => scoreReasonCodes.has(code));
  if (triggered.length > 0) {
    reviewReasons.push("REVIEW_TRIGGERED_BY_POLICY");
    for (const code of triggered) {
      if (isReasonCode(code)) reviewReasons.push(code);
    }
  }
  if (score.scoreConfidence === "UNKNOWN") reviewReasons.push("LOW_SCORE_CONFIDENCE");
  if (
    identityConfidenceOrdinal(identity.identityConfidence) <
    identityConfidenceOrdinal(policy.minimumIdentityConfidenceForAutonomy)
  ) {
    reviewReasons.push("IDENTITY_CONFIDENCE_UNKNOWN");
  }
  if (confidenceScore < policy.minimumConfidence) reviewReasons.push("CONFIDENCE_BELOW_THRESHOLD");
  if (reviewReasons.length > 0) {
    return result("REVIEW_REQUIRED", reviewReasons, confidenceScore);
  }

  // (5) QUALIFIED — sufficient, current evidence and policy authorization.
  const qualifiedReasons: QualificationReasonCode[] = ["POLICY_REQUIREMENTS_MET"];
  if (identityEntry?.status === "present") qualifiedReasons.push("IDENTITY_CURRENT");
  qualifiedReasons.push("SCORE_BAND_SUFFICIENT");
  if (fitEntry?.status === "present") qualifiedReasons.push("FIT_EVIDENCE_PRESENT");
  if (intentEntry?.status === "present") qualifiedReasons.push("INTENT_EVIDENCE_PRESENT");
  if (recencyEntry?.status === "present") qualifiedReasons.push("RECENCY_WITHIN_POLICY");
  if (confidenceScore >= policy.minimumConfidence) qualifiedReasons.push("CONFIDENCE_SUFFICIENT");
  return result("QUALIFIED", qualifiedReasons, confidenceScore);
}

function result(
  decision: QualificationDecision,
  reasonCodes: QualificationReasonCode[],
  confidenceScore: number
): QualificationEvaluationResult {
  const bounded = dedupeCap(reasonCodes);
  return Object.freeze({
    decision,
    reasonCodes: Object.freeze(bounded),
    confidenceScore,
    reviewRequired: decision === "REVIEW_REQUIRED",
  });
}
