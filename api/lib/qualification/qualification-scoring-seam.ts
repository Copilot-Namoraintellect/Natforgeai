// ─── R6-C Lead Qualification — score payload seam (C boundary) ───
//
// Re-validates the untrusted R6-B LeadScoreProjection — it arrives as
// `unknown` and is never trusted until it passes this seam: exact key set,
// version allow-lists (scoring / feature / score-contract / identity),
// bounded integers, closed vocabularies, component-weight coherence, the
// bridge-written scoreContentHash tamper guard, and the deterministic
// C-derived scoreContentHash recomputation (contract §1, §14.4). R6-B's legacy
// numeric leads.id is accepted for the score's leadId anchor and normalized to
// its deterministic string form (binding is tenant + business scope, never
// leadId/version equality). Score is evidence, never qualification: no
// decision/authority field crosses here.

import {
  deriveScoreContentHash,
  HEX_64,
  isAllowedLeadIdentityVersion,
  isIsoUtc,
  LEAD_ID_PATTERN,
  LEAD_SCORE_ID_PATTERN,
  QualificationInputError,
  QualificationTamperError,
  QualificationValidationError,
  scoreBandFor,
  SCORE_BAND_VALUES,
  SCORE_CONFIDENCE_VALUES,
  SCORE_CONTRACT_VERSION_ALLOWED,
  SCORING_VERSION_ALLOWED,
  type NormalizedScoreEvidence,
  type ScoreBand,
  type ScoreConfidence,
} from "./qualification-contract";
import { SCORE_REASON_CODE_VALUES } from "./qualification-policy";

export const SCORE_FEATURE_VERSION = "lead-scoring-features/v1" as const;
export const EVIDENCE_SNAPSHOT_ID_PATTERN = /^lss1:[a-f0-9]{64}$/;
export const SCORE_DUPLICATE_CLASSIFICATION_VALUES = ["none", "idempotent_replay"] as const;

const SCORE_PAYLOAD_REQUIRED_KEYS = [
  "leadScoreId",
  "leadId",
  "leadIdentityVersion",
  "scoringVersion",
  "featureVersion",
  "scoreContractVersion",
  "evidenceSnapshotId",
  "evidenceSnapshotHash",
  "overallScore",
  "scoreBand",
  "scoreConfidence",
  "fitScore",
  "intentScore",
  "engagementScore",
  "recencyScore",
  "opportunityScore",
  "componentWeights",
  "reasonCodes",
  "evidenceFreshness",
  "computedAt",
  "createdAt",
  "businessId",
  "userId",
  "duplicateClassification",
] as const;

/** Optional bridge-written tamper guard (contract §3.3). */
const SCORE_CONTENT_HASH_KEY = "scoreContentHash";

const SCORE_BAND_SET: ReadonlySet<string> = new Set(SCORE_BAND_VALUES);
const SCORE_CONFIDENCE_SET: ReadonlySet<string> = new Set(SCORE_CONFIDENCE_VALUES);
const SCORE_REASON_CODE_SET: ReadonlySet<string> = new Set(SCORE_REASON_CODE_VALUES);
const SCORE_DUPLICATE_CLASSIFICATION_SET: ReadonlySet<string> = new Set(
  SCORE_DUPLICATE_CLASSIFICATION_VALUES
);
const COMPONENT_WEIGHT_KEYS = [
  "fit",
  "intent",
  "engagement",
  "recency",
  "opportunity",
] as const;
const MAX_REASON_CODES = 8;
const WEIGHT_SUM_TOLERANCE = 0.001;

function fail(message: string): never {
  throw new QualificationValidationError("INVALID_SCORE_PAYLOAD", message);
}

function failScore(message: string): never {
  throw new QualificationValidationError("INVALID_SCORE", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireExactKeySet(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): void {
  const allowed = new Set<string>([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`score payload carries unknown field: ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) fail(`score payload is missing required field: ${key}`);
  }
}

function requirePattern(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${field} must match ${pattern}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireIsoUtc(value: unknown, field: string): string {
  if (typeof value !== "string" || !isIsoUtc(value) || Number.isNaN(Date.parse(value))) {
    fail(`${field} must be a strict ISO-8601 UTC timestamp, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNullableIsoUtc(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireIsoUtc(value, field);
}

/**
 * R6-B keys its score surface on the LEGACY numeric leads.id and the bridge
 * carries that column verbatim; canonical R6-A ids cross as `lid1:` strings.
 * C binds score↔identity by tenant + business scope, never by leadId
 * equality, so either anchor shape is accepted and normalized to the
 * deterministic string form bound into the score content hash.
 */
function requireLeadId(value: unknown, field: string): string {
  if (typeof value === "string" && LEAD_ID_PATTERN.test(value)) return value;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  fail(
    `${field} must be a canonical lead id (${LEAD_ID_PATTERN}) or a positive legacy numeric leads.id, got ${JSON.stringify(value)}`
  );
}

function requireClosedString(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
  code: "INVALID_SCORE_PAYLOAD" | "INVALID_SCORE" | "SCORE_BAND_UNKNOWN" | "INVALID_REASON_CODE"
): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    const message = `${field} must be one of ${Array.from(allowed).join(", ")}, got ${JSON.stringify(value)}`;
    if (code === "INVALID_SCORE") failScore(message);
    if (code === "SCORE_BAND_UNKNOWN") {
      throw new QualificationValidationError("SCORE_BAND_UNKNOWN", message);
    }
    if (code === "INVALID_REASON_CODE") {
      throw new QualificationValidationError("INVALID_REASON_CODE", message);
    }
    fail(message);
  }
  return value;
}

function requireComponentScore(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    failScore(`${field} must be an integer in [0,100], got ${String(value)}`);
  }
  return value;
}

function validateComponentWeights(value: unknown): Record<string, number> {
  if (!isPlainObject(value)) failScore("componentWeights must be an object");
  const keys = Object.keys(value);
  if (
    keys.length !== COMPONENT_WEIGHT_KEYS.length ||
    COMPONENT_WEIGHT_KEYS.some((key) => !keys.includes(key))
  ) {
    failScore(
      `componentWeights must carry exactly the keys ${COMPONENT_WEIGHT_KEYS.join(", ")}`
    );
  }
  let sum = 0;
  const weights: Record<string, number> = {};
  for (const key of COMPONENT_WEIGHT_KEYS) {
    const weight = value[key];
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 1) {
      failScore(`componentWeights.${key} must be a finite number in [0,1], got ${String(weight)}`);
    }
    weights[key] = weight;
    sum += weight;
  }
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    failScore(`componentWeights must sum to 1 (±${WEIGHT_SUM_TOLERANCE}), got ${sum}`);
  }
  return weights;
}

function validateReasonCodes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new QualificationValidationError("INVALID_REASON_CODE", "reasonCodes must be an array");
  }
  if (value.length > MAX_REASON_CODES) {
    throw new QualificationValidationError(
      "INVALID_REASON_CODE",
      `reasonCodes must carry at most ${MAX_REASON_CODES} codes`
    );
  }
  const codes: string[] = [];
  for (const raw of value) {
    codes.push(requireClosedString(raw, SCORE_REASON_CODE_SET, "reasonCodes[]", "INVALID_REASON_CODE"));
  }
  return Object.freeze(codes);
}

function validateEvidenceFreshness(value: unknown): {
  latestObservedAt: string | null;
  computedAt: string;
} {
  if (!isPlainObject(value)) fail("evidenceFreshness must be an object");
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("latestObservedAt") || !keys.includes("computedAt")) {
    fail("evidenceFreshness must carry exactly {latestObservedAt, computedAt}");
  }
  return Object.freeze({
    latestObservedAt: requireNullableIsoUtc(value.latestObservedAt, "evidenceFreshness.latestObservedAt"),
    computedAt: requireIsoUtc(value.computedAt, "evidenceFreshness.computedAt"),
  });
}

/**
 * Strict boundary validation for the R6-B score projection. Every malformed,
* out-of-vocabulary, inconsistent or tampered payload fails closed; a present
 * scoreContentHash that disagrees with the recomputed binding is tampering
 * (SCORE_TAMPERED).
 */
export function validateScorePayload(input: unknown): NormalizedScoreEvidence {
  if (!isPlainObject(input)) {
    fail("score payload must be a plain object");
  }
  requireExactKeySet(input, SCORE_PAYLOAD_REQUIRED_KEYS, [SCORE_CONTENT_HASH_KEY]);

  const leadScoreId = requirePattern(input.leadScoreId, LEAD_SCORE_ID_PATTERN, "leadScoreId");
  const leadId = requireLeadId(input.leadId, "leadId");
  requirePattern(input.evidenceSnapshotId, EVIDENCE_SNAPSHOT_ID_PATTERN, "evidenceSnapshotId");
  const evidenceSnapshotHash = requirePattern(input.evidenceSnapshotHash, HEX_64, "evidenceSnapshotHash");

  const leadIdentityVersion = input.leadIdentityVersion;
  if (typeof leadIdentityVersion !== "string" || !isAllowedLeadIdentityVersion(leadIdentityVersion)) {
    throw new QualificationInputError(
      "IDENTITY_VERSION_UNKNOWN",
      `unknown leadIdentityVersion: ${String(leadIdentityVersion)}`
    );
  }

  const scoringVersion = input.scoringVersion;
  if (typeof scoringVersion !== "string" || !(SCORING_VERSION_ALLOWED as readonly string[]).includes(scoringVersion)) {
    throw new QualificationInputError(
      "UNKNOWN_SCORE_VERSION",
      `unknown scoringVersion: ${String(scoringVersion)}`
    );
  }
  const featureVersion = input.featureVersion;
  if (featureVersion !== SCORE_FEATURE_VERSION) {
    throw new QualificationInputError(
      "UNKNOWN_SCORE_VERSION",
      `featureVersion must be ${SCORE_FEATURE_VERSION}, got ${String(featureVersion)}`
    );
  }
  const scoreContractVersion = input.scoreContractVersion;
  if (
    typeof scoreContractVersion !== "string" ||
    !(SCORE_CONTRACT_VERSION_ALLOWED as readonly string[]).includes(scoreContractVersion)
  ) {
    throw new QualificationInputError(
      "UNKNOWN_SCORE_VERSION",
      `unknown scoreContractVersion: ${String(scoreContractVersion)}`
    );
  }

  const overallScore = requireComponentScore(input.overallScore, "overallScore");
  const scoreBand = requireClosedString(input.scoreBand, SCORE_BAND_SET, "scoreBand", "SCORE_BAND_UNKNOWN") as ScoreBand;
  // A band that disagrees with its overall score is tampering, not a
  // vocabulary error: both fields were individually well-formed.
  if (scoreBandFor(overallScore) !== scoreBand) {
    throw new QualificationTamperError(
      "SCORE_TAMPERED",
      `scoreBand ${scoreBand} is inconsistent with overallScore ${overallScore} (expected ${scoreBandFor(overallScore)})`
    );
  }
  const scoreConfidence = requireClosedString(
    input.scoreConfidence,
    SCORE_CONFIDENCE_SET,
    "scoreConfidence",
    "INVALID_SCORE"
  ) as ScoreConfidence;

  const fitScore = requireComponentScore(input.fitScore, "fitScore");
  const intentScore = requireComponentScore(input.intentScore, "intentScore");
  const engagementScore = requireComponentScore(input.engagementScore, "engagementScore");
  const recencyScore = requireComponentScore(input.recencyScore, "recencyScore");
  const opportunityScore = requireComponentScore(input.opportunityScore, "opportunityScore");

  validateComponentWeights(input.componentWeights);
  const reasonCodes = validateReasonCodes(input.reasonCodes);
  const evidenceFreshness = validateEvidenceFreshness(input.evidenceFreshness);
  const computedAt = requireIsoUtc(input.computedAt, "computedAt");
  requireIsoUtc(input.createdAt, "createdAt");

  const businessId = ((): number | null => {
    if (input.businessId === null) return null;
    if (typeof input.businessId !== "number" || !Number.isInteger(input.businessId) || input.businessId <= 0) {
      fail(`businessId must be a positive integer or null, got ${String(input.businessId)}`);
    }
    return input.businessId;
  })();
  if (typeof input.userId !== "number" || !Number.isInteger(input.userId) || input.userId <= 0) {
    fail(`userId must be a positive integer, got ${String(input.userId)}`);
  }
  const userId = input.userId;
  requireClosedString(
    input.duplicateClassification,
    SCORE_DUPLICATE_CLASSIFICATION_SET,
    "duplicateClassification",
    "INVALID_SCORE_PAYLOAD"
  );

  const expectedScoreContentHash = deriveScoreContentHash({
    leadScoreId,
    scoringVersion,
    featureVersion,
    scoreContractVersion,
    leadIdentityVersion,
    leadId,
    businessId,
    overallScore,
    scoreBand,
    scoreConfidence,
    fitScore,
    intentScore,
    engagementScore,
    recencyScore,
    opportunityScore,
    reasonCodes: [...reasonCodes].sort(),
    evidenceSnapshotHash,
    evidenceFreshness,
  });

  const suppliedContentHash = input[SCORE_CONTENT_HASH_KEY];
  if (suppliedContentHash !== undefined) {
    if (typeof suppliedContentHash !== "string" || !HEX_64.test(suppliedContentHash)) {
      fail(`scoreContentHash must be a 64-hex string when present, got ${JSON.stringify(suppliedContentHash)}`);
    }
    if (suppliedContentHash !== expectedScoreContentHash) {
      throw new QualificationTamperError(
        "SCORE_TAMPERED",
        "scoreContentHash does not match the recomputed score content binding; refusing tampered score evidence"
      );
    }
  }

  return Object.freeze({
    leadScoreId,
    scoringVersion,
    scoreContentHash: expectedScoreContentHash,
    overallScore,
    scoreBand,
    scoreConfidence,
    fitScore,
    intentScore,
    engagementScore,
    recencyScore,
    opportunityScore,
    reasonCodes: Object.freeze([...reasonCodes].sort()),
    latestObservedAt: evidenceFreshness.latestObservedAt,
    computedAt,
    leadId,
    businessId,
    userId,
    leadIdentityVersion,
  });
}
