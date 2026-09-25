/**
 * Learning record authority — deterministic authority hardening for the
 * Phase 1 Learning engine (WBS15.4 recommendation authority / WBS15.5
 * governed, versioned learning record authority).
 *
 * This module closes four authority gaps that the persisted record alone
 * does not cover, without changing any existing Phase 1 behavior:
 *
 * 1. Record fingerprint — a deterministic hash over the canonical governed
 *    Learning authority (campaign, evaluation version/window, evidence
 *    identity, KPI/analysis authority, recommendations). The persisted
 *    `provenance.inputDigest` only covers input coordinates (version,
 *    window, observation ids); it does not bind the governed record content.
 *
 * 2. Record lineage — stable coordinates sufficient for downstream
 *    promotion: learningRecordId, evaluationVersion, campaignId, window,
 *    evidence fingerprint and record fingerprint.
 *
 * 3. Recommendation identity — a deterministic, collision-resistant identity
 *    per governed recommendation, scoped to its record coordinates. The
 *    existing rule-stable recommendation `id` (e.g. "rec_improve_hook_ctr")
 *    is preserved and never replaced; the derived identity composes it with
 *    the record coordinates so recommendations from different windows or
 *    versions can never collide.
 *
 * 4. Promotion readiness — a PURE assessment (record exists, approval-gated,
 *    evidence-valid, not superseded). It never mutates the record, never
 *    auto-promotes anything, and never writes to Strategy, Creative or
 *    Distribution state.
 *
 * Historical immutability note (design-gap report): when new underlying
 * evidence arrives for an existing immutable evaluation key, the service
 * correctly replays the originally persisted record instead of rewriting
 * history. However, the replay path never re-verifies the stored
 * `inputDigest`, so evidence drift behind an immutable key is invisible to
 * callers. `detectEvidenceDrift` exposes that drift as a pure check; it does
 * not change replay semantics.
 *
 * Pure module: no database access, no provider calls, no engine mutation.
 */

import { createHash } from "crypto";
import { LEARNING_RECORD_STATUSES } from "./contracts/learning-config";
import type { RecommendedAdjustment } from "./contracts/learning-derivation";
import type { PerformanceObservation } from "./contracts/observation";
import { buildInputDigest, type LearningRecordView } from "./learning-service";

/**
 * Fingerprint schema version. Bumped only when the canonical fingerprint
 * payload layout changes; persisted fingerprints remain verifiable against
 * the schema version that produced them.
 */
export const RECORD_FINGERPRINT_SCHEMA = 1;

/**
 * The single recommendation whose empty evidence set is explicit
 * insufficient-evidence semantics rather than a missing-evidence defect
 * (see learning-derivation.ts: collect_more_evidence intentionally carries
 * no concrete refs because its purpose is precisely that evidence is thin).
 */
export const INSUFFICIENT_EVIDENCE_ADJUSTMENT = "collect_more_evidence";

/** Promotion-readiness check results; every check must pass for eligibility. */
export interface PromotionReadinessChecks {
  /** Record exists and carries a persisted (recorded) status. */
  recordExists: boolean;
  /** Record-level and per-recommendation governance pins approval-gating. */
  approvalGated: boolean;
  /** Every actionable recommendation cites evidence; the explicit
   *  insufficient-evidence recommendation is allowed an empty set. */
  evidenceBound: boolean;
  /** No sibling record for the same campaign holds strictly newer
   *  authority (evaluation version, then window, then id). */
  recordCurrent: boolean;
}

/** Stable lineage coordinates for one persisted learning record. */
export interface LearningRecordLineage {
  learningRecordId: number;
  campaignId: number;
  evaluationVersion: string;
  windowStart: string;
  windowEnd: string;
  /** Deterministic hash over the evidence/source observation identity. */
  evidenceFingerprint: string;
  /** Deterministic hash over the canonical governed record authority. */
  recordFingerprint: string;
  /** Input digest persisted by the engine at evaluation time. */
  inputDigest: string;
}

/** Authority view of one governed recommendation. */
export interface RecommendationAuthority {
  /** Deterministic identity scoped to the record coordinates. */
  identity: string;
  /** Existing rule-stable recommendation id (preserved, never rewritten). */
  recommendationId: string;
  targetEngine: RecommendedAdjustment["targetEngine"];
  adjustmentType: string;
  /** False only for the explicit insufficient-evidence recommendation. */
  actionable: boolean;
  /** Actionable recommendations cite evidence; the explicit
   *  insufficient-evidence recommendation is valid with an empty set. */
  evidenceBound: boolean;
  evidenceRefs: string[];
}

/** Pure promotion-readiness assessment. Eligibility is advisory only. */
export interface PromotionReadiness {
  eligible: boolean;
  reasons: string[];
  checks: PromotionReadinessChecks;
  lineage: LearningRecordLineage;
  recommendations: RecommendationAuthority[];
}

/** Drift between the evidence bound at evaluation time and current evidence. */
export interface EvidenceDrift {
  drifted: boolean;
  storedDigest: string;
  recomputedDigest: string;
}

function sha256(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Canonical JSON: object keys sorted recursively, arrays preserved in order,
 * undefined entries dropped. Identical logical content always serialises to
 * an identical string regardless of source key ordering (e.g. values that
 * round-tripped through a database JSON column).
 */
function canonicalise(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalise(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalise(entryValue)}`)
    .join(",")}}`;
}

function hashCanonical(payload: unknown): string {
  return sha256(canonicalise(payload));
}

/**
 * Deterministic fingerprint over the evidence/source observation identity:
 * the sorted set of observation ids the record is grounded in.
 */
export function computeEvidenceFingerprint(observationIds: string[]): string {
  return hashCanonical({ authority: "learning-evidence", ids: [...observationIds].sort() });
}

/**
 * Deterministic record fingerprint over the canonical governed Learning
 * authority: campaign, evaluation version/window, evidence identity,
 * KPI/analysis authority and recommendations. Recomputed identically from
 * the persisted record content; any change to governed content, coordinates
 * or evidence identity changes the fingerprint.
 */
export function computeRecordFingerprint(record: LearningRecordView): string {
  return hashCanonical({
    authority: "learning-record",
    schema: RECORD_FINGERPRINT_SCHEMA,
    campaignId: record.campaignId,
    evaluationVersion: record.evaluationVersion,
    windowStart: record.windowStart,
    windowEnd: record.windowEnd,
    observations: record.sourceObservations.map((o) => o.id).sort(),
    kpiAssessment: record.kpiAssessment,
    positivePatterns: record.positivePatterns,
    negativePatterns: record.negativePatterns,
    recommendedAdjustments: record.recommendedAdjustments,
  });
}

/** Builds the stable lineage coordinates for one persisted record. */
export function buildRecordLineage(record: LearningRecordView): LearningRecordLineage {
  return {
    learningRecordId: record.id,
    campaignId: record.campaignId,
    evaluationVersion: record.evaluationVersion,
    windowStart: record.windowStart,
    windowEnd: record.windowEnd,
    evidenceFingerprint: computeEvidenceFingerprint(
      record.sourceObservations.map((o) => o.id)
    ),
    recordFingerprint: computeRecordFingerprint(record),
    inputDigest: record.provenance.inputDigest,
  };
}

/**
 * Deterministic recommendation authority for every governed recommendation
 * in the record. Identities are stable across recomputation and distinct
 * across records: the identity payload composes the existing
 * recommendation id with the record's campaign/version/window coordinates.
 */
export function deriveRecommendationAuthorities(
  record: LearningRecordView
): RecommendationAuthority[] {
  return record.recommendedAdjustments.map((rec) => ({
    identity: `lri:${hashCanonical({
      authority: "learning-recommendation",
      campaignId: record.campaignId,
      evaluationVersion: record.evaluationVersion,
      windowStart: record.windowStart,
      windowEnd: record.windowEnd,
      recommendationId: rec.id,
    })}`,
    recommendationId: rec.id,
    targetEngine: rec.targetEngine,
    adjustmentType: rec.adjustmentType,
    actionable: rec.adjustmentType !== INSUFFICIENT_EVIDENCE_ADJUSTMENT,
    evidenceBound:
      rec.adjustmentType === INSUFFICIENT_EVIDENCE_ADJUSTMENT ||
      rec.evidenceRefs.length > 0,
    evidenceRefs: [...rec.evidenceRefs],
  }));
}

type AuthorityTuple = [string, string, string, number];

function authorityOrder(record: LearningRecordView): AuthorityTuple {
  return [
    record.evaluationVersion,
    record.windowEnd,
    record.windowStart,
    record.id,
  ];
}

function compareTuples(a: AuthorityTuple, b: AuthorityTuple): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Supersession semantics: a record is superseded when a sibling record for
 * the same campaign holds strictly newer authority — a higher evaluation
 * version (deterministic lexicographic order on the pinned engine version
 * string), or the same version with a newer window, or the same version and
 * window with a higher id. Historical records stay persisted and immutable;
 * supersession is a read-time assessment only.
 */
export function isSuperseded(
  record: LearningRecordView,
  peers: LearningRecordView[]
): boolean {
  const order = authorityOrder(record);
  return peers.some(
    (peer) =>
      peer.campaignId === record.campaignId &&
      peer.id !== record.id &&
      compareTuples(authorityOrder(peer), order) > 0
  );
}

/**
 * Pure promotion-readiness assessment for one persisted learning record.
 * Pass the sibling records for the same campaign as `peers` (an empty array
 * when none exist) so currentness can be evaluated. The assessment reads
 * record content only: it never mutates the record, never auto-promotes any
 * recommendation, and never writes to Strategy, Creative or Distribution
 * state. Promotion execution remains a downstream governed decision.
 */
export function assessPromotionReadiness(
  record: LearningRecordView,
  peers: LearningRecordView[]
): PromotionReadiness {
  const recommendations = deriveRecommendationAuthorities(record);

  const recordExists = (LEARNING_RECORD_STATUSES as readonly string[]).includes(
    record.status
  );
  const approvalGated =
    record.governance.autoApply === false &&
    record.governance.requiresApproval === true &&
    record.recommendedAdjustments.every(
      (rec) =>
        rec.governance.autoApply === false && rec.governance.requiresApproval === true
    );
  const evidenceBound = recommendations.every((rec) => rec.evidenceBound);
  const recordCurrent = !isSuperseded(record, peers);

  const reasons: string[] = [];
  if (!recordExists) reasons.push("record does not carry a persisted status");
  if (!approvalGated) reasons.push("recommendation governance is not approval-gated");
  if (!evidenceBound)
    reasons.push("an actionable recommendation cites no evidence");
  if (!recordCurrent)
    reasons.push("a newer learning record supersedes this one for the campaign");

  return {
    eligible: recordExists && approvalGated && evidenceBound && recordCurrent,
    reasons,
    checks: { recordExists, approvalGated, evidenceBound, recordCurrent },
    lineage: buildRecordLineage(record),
    recommendations,
  };
}

/**
 * Detects evidence drift behind an immutable evaluation key: recomputes the
 * engine input digest over the CURRENT observations for the record's window
 * and compares it with the digest persisted at evaluation time. A mismatch
 * means new underlying evidence arrived after the record was persisted; the
 * persisted record is intentionally left untouched (history is not
 * rewritten), and the drift is surfaced for the caller instead.
 */
export function detectEvidenceDrift(
  record: LearningRecordView,
  currentObservations: PerformanceObservation[]
): EvidenceDrift {
  const recomputedDigest = buildInputDigest({
    evaluationVersion: record.evaluationVersion,
    windowStart: record.windowStart,
    windowEnd: record.windowEnd,
    observationIds: currentObservations.map((o) => o.id),
  });
  return {
    drifted: recomputedDigest !== record.provenance.inputDigest,
    storedDigest: record.provenance.inputDigest,
    recomputedDigest,
  };
}
