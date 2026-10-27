// ─── R6-C Lead Qualification — versioned qualification policy registry ───
//
// Server-side, versioned, immutable per version. No model or client may alter
// policy; there is no runtime mutation endpoint. New versions are new code-level
// registry artefacts registered at module scope. Where a business-specific rule
// does not exist, the conservative default returns INSUFFICIENT_EVIDENCE /
// REVIEW_REQUIRED — never fabricated criteria (contract §6).

import {
  canonicalJson,
  DEFAULT_QUALIFICATION_POLICY_VERSION,
  IDENTITY_CONFIDENCE_ORDINAL,
  QualificationInputError,
  QualificationStateConflictError,
  QualificationValidationError,
  SCORE_BAND_VALUES,
  SCORE_CONFIDENCE_VALUES,
  type IdentityConfidence,
  type ScoreBand,
  type ScoreConfidence,
} from "./qualification-contract";

/** R6-B closed score-reason vocabulary — the only codes a policy may reference. */
export const SCORE_REASON_CODE_VALUES = [
  "STRONG_PURCHASE_INTENT",
  "REPEATED_INTENT_SIGNALS",
  "EXPLICIT_SERVICE_ENQUIRY",
  "PARTNERSHIP_INTEREST",
  "VALIDATED_ENGAGEMENT_RESPONSE",
  "RECENT_EVIDENCE",
  "HIGH_EVIDENCE_STRENGTH",
  "CAMPAIGN_ALIGNED",
  "NEUTRAL_CAMPAIGN_ALIGNMENT",
  "STALE_EVIDENCE",
  "LOW_EVIDENCE_STRENGTH",
  "CONTRADICTING_EVIDENCE",
  "SINGLE_EVIDENCE_SOURCE",
  "MISSING_ENGAGEMENT_EVIDENCE",
  "MISSING_RECENCY_EVIDENCE",
  "INSUFFICIENT_EVIDENCE",
  "PRAISE_ONLY_EVIDENCE",
  "COMPLAINT_ONLY_EVIDENCE",
  "UNRESOLVED_COMPLAINT_SIGNAL",
] as const;
export type ScoreReasonCode = (typeof SCORE_REASON_CODE_VALUES)[number];

const SCORE_REASON_CODE_SET: ReadonlySet<string> = new Set(SCORE_REASON_CODE_VALUES);

export const POLICY_VERSION_PATTERN = /^[a-z0-9-]+\/v\d+$/;
export const MAX_POLICY_VERSION_LENGTH = 96;

const HOURS_MS = 60 * 60 * 1000;

export interface QualificationPolicy {
  readonly policyVersion: string;
  readonly minimumScoreBand: ScoreBand;
  readonly minimumScoreConfidence: ScoreConfidence;
  readonly fitEvidenceThreshold: number;
  readonly intentEvidenceThreshold: number;
  readonly engagementEvidenceThreshold: number;
  readonly requireEngagementEvidence: boolean;
  readonly maximumEvidenceAgeMs: number;
  readonly staleIdentityMs: number;
  readonly disqualifyingScoreReasonCodes: readonly string[];
  readonly reviewTriggerReasonCodes: readonly string[];
  readonly minimumConfidence: number;
  readonly minimumIdentityConfidenceForAutonomy: IdentityConfidence;
  readonly validityMs: number;
}

/** Conservative server-side default (contract §6). */
export const DEFAULT_QUALIFICATION_POLICY: QualificationPolicy = Object.freeze({
  policyVersion: DEFAULT_QUALIFICATION_POLICY_VERSION,
  minimumScoreBand: "HIGH",
  minimumScoreConfidence: "LOW",
  fitEvidenceThreshold: 40,
  intentEvidenceThreshold: 40,
  engagementEvidenceThreshold: 0,
  requireEngagementEvidence: false,
  maximumEvidenceAgeMs: 336 * HOURS_MS,
  staleIdentityMs: 336 * HOURS_MS,
  disqualifyingScoreReasonCodes: Object.freeze(["UNRESOLVED_COMPLAINT_SIGNAL"] as const),
  reviewTriggerReasonCodes: Object.freeze(["CONTRADICTING_EVIDENCE"] as const),
  minimumConfidence: 4000,
  minimumIdentityConfidenceForAutonomy: "low",
  validityMs: 168 * HOURS_MS,
});

function isComponentThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** Validates the full policy shape and ranges; throws INVALID_POLICY on drift. */
export function assertQualificationPolicy(policy: QualificationPolicy): void {
  const fail = (message: string): never => {
    throw new QualificationValidationError("INVALID_POLICY", message);
  };
  if (policy === null || typeof policy !== "object") fail("policy must be an object");
  if (
    typeof policy.policyVersion !== "string" ||
    policy.policyVersion.length === 0 ||
    policy.policyVersion.length > MAX_POLICY_VERSION_LENGTH ||
    !POLICY_VERSION_PATTERN.test(policy.policyVersion)
  ) {
    fail(`policyVersion must match ${POLICY_VERSION_PATTERN} and be ≤ ${MAX_POLICY_VERSION_LENGTH} chars`);
  }
  if (!(SCORE_BAND_VALUES as readonly string[]).includes(policy.minimumScoreBand)) {
    fail(`minimumScoreBand must be one of ${SCORE_BAND_VALUES.join(",")}`);
  }
  if (!(SCORE_CONFIDENCE_VALUES as readonly string[]).includes(policy.minimumScoreConfidence)) {
    fail(`minimumScoreConfidence must be one of ${SCORE_CONFIDENCE_VALUES.join(",")}`);
  }
  if (!isComponentThreshold(policy.fitEvidenceThreshold)) fail("fitEvidenceThreshold must be in [0,100]");
  if (!isComponentThreshold(policy.intentEvidenceThreshold)) {
    fail("intentEvidenceThreshold must be in [0,100]");
  }
  if (!isComponentThreshold(policy.engagementEvidenceThreshold)) {
    fail("engagementEvidenceThreshold must be in [0,100]");
  }
  if (typeof policy.requireEngagementEvidence !== "boolean") {
    fail("requireEngagementEvidence must be a boolean");
  }
  if (
    typeof policy.maximumEvidenceAgeMs !== "number" ||
    !Number.isFinite(policy.maximumEvidenceAgeMs) ||
    policy.maximumEvidenceAgeMs <= 0
  ) {
    fail("maximumEvidenceAgeMs must be a positive finite number");
  }
  if (
    typeof policy.staleIdentityMs !== "number" ||
    !Number.isFinite(policy.staleIdentityMs) ||
    policy.staleIdentityMs <= 0
  ) {
    fail("staleIdentityMs must be a positive finite number");
  }
  if (
    !Array.isArray(policy.disqualifyingScoreReasonCodes) ||
    policy.disqualifyingScoreReasonCodes.some(
      (code) => typeof code !== "string" || !SCORE_REASON_CODE_SET.has(code)
    )
  ) {
    fail("disqualifyingScoreReasonCodes must reference the closed score-reason vocabulary");
  }
  if (
    !Array.isArray(policy.reviewTriggerReasonCodes) ||
    policy.reviewTriggerReasonCodes.some(
      (code) => typeof code !== "string" || !SCORE_REASON_CODE_SET.has(code)
    )
  ) {
    fail("reviewTriggerReasonCodes must reference the closed score-reason vocabulary");
  }
  if (
    typeof policy.minimumConfidence !== "number" ||
    !Number.isInteger(policy.minimumConfidence) ||
    policy.minimumConfidence < 0 ||
    policy.minimumConfidence > 10000
  ) {
    fail("minimumConfidence must be an integer in [0,10000]");
  }
  if (
    !Object.keys(IDENTITY_CONFIDENCE_ORDINAL).includes(
      policy.minimumIdentityConfidenceForAutonomy
    )
  ) {
    fail("minimumIdentityConfidenceForAutonomy must be an identity confidence ordinal");
  }
  if (
    typeof policy.validityMs !== "number" ||
    !Number.isFinite(policy.validityMs) ||
    policy.validityMs <= 0
  ) {
    fail("validityMs must be a positive finite number");
  }
}

// ─── Code-level registry (contract §6) ───

const registry = new Map<string, QualificationPolicy>();

/**
 * Registers a policy artefact. Same policyVersion + deep-equal content is an
 * idempotent no-op; same version with different content fails closed with
 * POLICY_VERSION_CONFLICT — versions are immutable.
 */
export function registerQualificationPolicy(policy: QualificationPolicy): void {
  assertQualificationPolicy(policy);
  const existing = registry.get(policy.policyVersion);
  if (existing) {
    if (canonicalJson(existing) === canonicalJson(policy)) return;
    throw new QualificationStateConflictError(
      "POLICY_VERSION_CONFLICT",
      `policyVersion ${policy.policyVersion} is already registered with different content`
    );
  }
  if (policy.policyVersion === DEFAULT_QUALIFICATION_POLICY.policyVersion) {
    if (canonicalJson(policy) !== canonicalJson(DEFAULT_QUALIFICATION_POLICY)) {
      throw new QualificationStateConflictError(
        "POLICY_VERSION_CONFLICT",
        `policyVersion ${policy.policyVersion} is reserved by the default policy`
      );
    }
    return;
  }
  registry.set(
    policy.policyVersion,
    Object.freeze({
      ...policy,
      disqualifyingScoreReasonCodes: Object.freeze([...policy.disqualifyingScoreReasonCodes]),
      reviewTriggerReasonCodes: Object.freeze([...policy.reviewTriggerReasonCodes]),
    })
  );
}

/** Resolves a policy version; undefined resolves to the conservative default. */
export function getQualificationPolicy(policyVersion?: string): QualificationPolicy {
  if (policyVersion === undefined) return DEFAULT_QUALIFICATION_POLICY;
  const registered = registry.get(policyVersion);
  if (registered) return registered;
  if (policyVersion === DEFAULT_QUALIFICATION_POLICY.policyVersion) {
    return DEFAULT_QUALIFICATION_POLICY;
  }
  throw new QualificationInputError(
    "UNKNOWN_POLICY_VERSION",
    `unknown qualification policy version: ${policyVersion}`
  );
}

/** Lists all registered policies; the default conservative policy is always first. */
export function listQualificationPolicies(): QualificationPolicy[] {
  return [DEFAULT_QUALIFICATION_POLICY, ...registry.values()];
}
