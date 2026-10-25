// ─── R6-C Lead Qualification — deterministic evidence snapshot ───
//
// Assembles the immutable, reference-only evidence snapshot (contract §5) from
// normalized identity/score/privacy evidence under a policy. Deterministic:
// same inputs + same clock ⇒ same entries + same snapshot hash. No PII, no
// social text, no raw evidence payloads — closed categories, closed statuses,
// bounded closed detail labels only.
//
// Forbidden evidence (contract §5): protected/sensitive traits and speculative
// demographic proxies are rejected at the boundary (FORBIDDEN_EVIDENCE) and
// can never influence a decision.

import {
  deriveEvidenceSnapshotHash,
  QUALIFICATION_EVIDENCE_CATEGORY_VALUES,
  QUALIFICATION_EVIDENCE_STATUS_VALUES,
  QualificationValidationError,
  type NormalizedIdentityEvidence,
  type NormalizedPrivacyState,
  type NormalizedScoreEvidence,
  type QualificationEvidenceCategory,
  type QualificationEvidenceStatus,
  type ScoreBand,
  type ScoreConfidence,
} from "./qualification-contract";
import type { QualificationPolicy } from "./qualification-policy";

export const FORBIDDEN_EVIDENCE_CATEGORY_VALUES = [
  "race",
  "ethnicity",
  "religion",
  "sex",
  "gender",
  "sexual_orientation",
  "health_status",
  "political_affiliation",
  "disability",
  "socioeconomic_class",
  "income",
  "age",
  "zip_code",
  "nationality",
  "speculative_demographic_proxy",
] as const;

const ALLOWED_CATEGORY_SET: ReadonlySet<string> = new Set(QUALIFICATION_EVIDENCE_CATEGORY_VALUES);
const ALLOWED_STATUS_SET: ReadonlySet<string> = new Set(QUALIFICATION_EVIDENCE_STATUS_VALUES);
const FORBIDDEN_CATEGORY_SET: ReadonlySet<string> = new Set(FORBIDDEN_EVIDENCE_CATEGORY_VALUES);

export const MAX_EVIDENCE_DETAIL_LENGTH = 64;

/**
 * Boundary check for evidence categories: forbidden traits fail with
 * FORBIDDEN_EVIDENCE; anything outside the closed category vocabulary fails
 * with INVALID_REASON_CODE.
 */
export function assertAllowedEvidenceCategory(category: string): void {
  if (FORBIDDEN_CATEGORY_SET.has(category)) {
    throw new QualificationValidationError(
      "FORBIDDEN_EVIDENCE",
      `evidence category is forbidden: ${category}`
    );
  }
  if (!ALLOWED_CATEGORY_SET.has(category)) {
    throw new QualificationValidationError(
      "INVALID_REASON_CODE",
      `unknown evidence category: ${category}`
    );
  }
}

export interface QualificationEvidenceEntry {
  readonly category: QualificationEvidenceCategory;
  readonly status: QualificationEvidenceStatus;
  readonly detail: string;
}

export function assertEvidenceEntry(entry: QualificationEvidenceEntry): void {
  assertAllowedEvidenceCategory(entry.category);
  if (!ALLOWED_STATUS_SET.has(entry.status)) {
    throw new QualificationValidationError(
      "INVALID_DECISION",
      `unknown evidence status: ${entry.status}`
    );
  }
  if (
    typeof entry.detail !== "string" ||
    entry.detail.length === 0 ||
    entry.detail.length > MAX_EVIDENCE_DETAIL_LENGTH
  ) {
    throw new QualificationValidationError(
      "INVALID_DECISION",
      `evidence detail must be a bounded closed label (1..${MAX_EVIDENCE_DETAIL_LENGTH} chars)`
    );
  }
}

export interface QualificationEvidenceSnapshot {
  readonly assembledAt: string;
  readonly identity: {
    readonly leadId: string;
    readonly leadIdentityVersion: string;
    readonly identityReference: string;
    readonly identityStatus: string;
    readonly identityConfidence: string;
  };
  readonly score: {
    readonly leadScoreId: string;
    readonly scoringVersion: string;
    readonly scoreContentHash: string;
    readonly scoreBand: ScoreBand;
    readonly scoreConfidence: ScoreConfidence;
  };
  readonly policy: {
    readonly qualificationPolicyVersion: string;
  };
  readonly entries: readonly QualificationEvidenceEntry[];
}

export interface BuildEvidenceSnapshotResult {
  readonly snapshot: QualificationEvidenceSnapshot;
  readonly snapshotHash: string;
  readonly entries: readonly QualificationEvidenceEntry[];
}

function entry(
  category: QualificationEvidenceCategory,
  status: QualificationEvidenceStatus,
  detail: string
): QualificationEvidenceEntry {
  const built: QualificationEvidenceEntry = { category, status, detail };
  assertEvidenceEntry(built);
  return built;
}

/**
 * Derives the fixed-order evidence entries (contract §5) and the snapshot
 * content binding. Entry derivation is exact and deterministic: the same
 * normalized evidence under the same policy and clock reproduces the same
 * entries and the same snapshot hash.
 */
export function buildEvidenceSnapshot(input: {
  identity: NormalizedIdentityEvidence;
  score: NormalizedScoreEvidence;
  policy: QualificationPolicy;
  privacy: NormalizedPrivacyState;
  now: Date;
}): BuildEvidenceSnapshotResult {
  const { identity, score, policy, privacy, now } = input;
  const reasonCodes = new Set(score.reasonCodes);

  const entries: QualificationEvidenceEntry[] = [
    entry(
      "identity_validity",
      identity.identityStatus === "conflicting" ? "contradicted" : "present",
      `IDENTITY_STATUS:${identity.identityStatus}`
    ),
    entry("lead_score", "present", `SCORE_BAND:${score.scoreBand}`),
    entry(
      "business_fit",
      score.fitScore >= policy.fitEvidenceThreshold ? "present" : "missing",
      `FIT_COMPONENT:${score.fitScore}`
    ),
    entry(
      "demonstrated_intent",
      score.intentScore >= policy.intentEvidenceThreshold ? "present" : "missing",
      `INTENT_COMPONENT:${score.intentScore}`
    ),
    entry(
      "engagement_evidence",
      score.engagementScore > policy.engagementEvidenceThreshold
        ? "present"
        : policy.requireEngagementEvidence
          ? "missing"
          : "not_required",
      `ENGAGEMENT_COMPONENT:${score.engagementScore}`
    ),
    entry(
      "recency",
      score.latestObservedAt !== null &&
        now.getTime() - Date.parse(score.latestObservedAt) <= policy.maximumEvidenceAgeMs
        ? "present"
        : "stale",
      `LATEST_OBSERVED_AT:${score.latestObservedAt ?? "null"}`
    ),
    entry("source_quality", ...sourceQuality(reasonCodes)),
    entry(
      "opportunity_evidence",
      score.opportunityScore > 0 ? "present" : "missing",
      `OPPORTUNITY_COMPONENT:${score.opportunityScore}`
    ),
    entry("eligibility_restrictions", ...eligibilityRestrictions(policy, reasonCodes)),
    entry(
      "privacy_status",
      privacy.actionable ? "present" : "blocked",
      `PRIVACY_STATE:${privacy.state}`
    ),
  ];

  const snapshot: QualificationEvidenceSnapshot = Object.freeze({
    assembledAt: now.toISOString(),
    identity: Object.freeze({
      leadId: identity.leadId,
      leadIdentityVersion: identity.leadIdentityVersion,
      identityReference: identity.identityReference,
      identityStatus: identity.identityStatus,
      identityConfidence: identity.identityConfidence,
    }),
    score: Object.freeze({
      leadScoreId: score.leadScoreId,
      scoringVersion: score.scoringVersion,
      scoreContentHash: score.scoreContentHash,
      scoreBand: score.scoreBand,
      scoreConfidence: score.scoreConfidence,
    }),
    policy: Object.freeze({
      qualificationPolicyVersion: policy.policyVersion,
    }),
    entries: Object.freeze(entries),
  });

  return { snapshot, snapshotHash: deriveEvidenceSnapshotHash(snapshot), entries: snapshot.entries };
}

function sourceQuality(reasonCodes: ReadonlySet<string>): [QualificationEvidenceStatus, string] {
  if (reasonCodes.has("CONTRADICTING_EVIDENCE")) return ["contradicted", "SOURCE_QUALITY:CONTRADICTING"];
  if (reasonCodes.has("SINGLE_EVIDENCE_SOURCE")) return ["missing", "SOURCE_QUALITY:SINGLE_SOURCE"];
  if (reasonCodes.has("LOW_EVIDENCE_STRENGTH")) return ["missing", "SOURCE_QUALITY:LOW_STRENGTH"];
  return ["present", "SOURCE_QUALITY:SUFFICIENT"];
}

function eligibilityRestrictions(
  policy: QualificationPolicy,
  reasonCodes: ReadonlySet<string>
): [QualificationEvidenceStatus, string] {
  const disqualifier = policy.disqualifyingScoreReasonCodes.find((code) => reasonCodes.has(code));
  if (disqualifier !== undefined) return ["blocked", `DISQUALIFIER:${disqualifier}`];
  return ["present", "NO_DISQUALIFIER"];
}
