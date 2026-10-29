// ─── R7-D Experimentation Engine — deterministic identity & hashing ───
//
// PURE module. Experiment, hypothesis, assignment and result identities are
// deterministic, server-minted, tenant/business-anchored pure functions of
// authoritative inputs — no wall-clock, no randomness. The tenant and
// business are bound INSIDE every hash so cross-tenant/cross-business
// correlation is impossible. No client ever supplies an identity.

import {
  canonicalJson,
  sha256Hex,
  type ExperimentDesign,
} from "./experimentation-contract";

/** Immutable design hash bound into hypothesis + experiment identities. */
export function deriveDesignHash(input: {
  userId: number;
  businessId: number;
  design: ExperimentDesign;
}): string {
  const d = input.design;
  return sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.userId,
      businessId: input.businessId,
      designType: d.designType,
      controlDefinition: d.controlDefinition,
      treatmentDefinitions: d.treatmentDefinitions,
      allocationPolicy: d.allocationPolicy,
      primaryMetric: d.primaryMetric,
      secondaryMetrics: d.secondaryMetrics,
      guardrails: d.guardrails,
      minimumSamplePerArm: d.minimumSamplePerArm,
      durationDays: d.durationDays,
    })
  );
}

export function deriveHypothesisId(input: {
  userId: number;
  businessId: number;
  learningId: string;
  statement: string;
  designHash: string;
}): string {
  return (
    "hyp1:" +
    sha256Hex(
      canonicalJson({
        v: 1,
        tenantUserId: input.userId,
        businessId: input.businessId,
        learningId: input.learningId,
        statement: input.statement,
        designHash: input.designHash,
      })
    )
  );
}

export function deriveExperimentId(input: {
  userId: number;
  businessId: number;
  learningId: string;
  hypothesisId: string;
  designHash: string;
}): string {
  return (
    "exp1:" +
    sha256Hex(
      canonicalJson({
        v: 1,
        tenantUserId: input.userId,
        businessId: input.businessId,
        learningId: input.learningId,
        hypothesisId: input.hypothesisId,
        designHash: input.designHash,
      })
    )
  );
}

/**
 * Assignment salt: pinned at activation, immutable thereafter. A policy or
 * governance change can never silently reshuffle live assignments.
 */
export function deriveAssignmentVersion(input: { experimentId: string; startAt: string }): string {
  return sha256Hex(
    canonicalJson({ v: 1, experimentId: input.experimentId, startAt: input.startAt })
  );
}

/** Opaque subject key — the raw subjectRef is never persisted. */
export function deriveSubjectKey(input: {
  userId: number;
  experimentId: string;
  subjectRef: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.userId,
      experimentId: input.experimentId,
      subjectRef: input.subjectRef.trim(),
    })
  );
}

/**
 * Deterministic assignment bucket for one subject. Same experiment +
 * same assignmentVersion + same subjectKey ⇒ same bucket, always.
 */
export function deriveAssignmentBucket(input: {
  experimentId: string;
  assignmentVersion: string;
  subjectKey: string;
}): number {
  const hex = sha256Hex(
    canonicalJson({
      v: 1,
      experimentId: input.experimentId,
      assignmentVersion: input.assignmentVersion,
      subjectKey: input.subjectKey,
    })
  );
  return parseInt(hex.slice(0, 15), 16) % 10000;
}

/** Map a bucket to an arm index via cumulative allocation fractions (bps). */
export function armIndexForBucket(
  bucket: number,
  fractionsBps: readonly number[]
): number {
  let cumulative = 0;
  for (let i = 0; i < fractionsBps.length; i++) {
    cumulative += fractionsBps[i];
    if (bucket < cumulative) return i;
  }
  // Defensive: exact-10000 sums guarantee a hit; land on final arm.
  return fractionsBps.length - 1;
}

/** Deterministic assignment id for persistence + replay verification. */
export function deriveAssignmentId(input: {
  experimentId: string;
  subjectKey: string;
}): string {
  return (
    "exa1:" +
    sha256Hex(canonicalJson({ v: 1, experimentId: input.experimentId, subjectKey: input.subjectKey }))
  );
}

/** Deterministic outcome-evidence binding id. */
export function deriveEvidenceId(input: {
  experimentId: string;
  outcomeId: string;
}): string {
  return (
    "exe1:" +
    sha256Hex(canonicalJson({ v: 1, experimentId: input.experimentId, outcomeId: input.outcomeId }))
  );
}

/** Deterministic experiment result id. */
export function deriveResultId(input: {
  experimentId: string;
  calculationVersion: string;
  evidenceFingerprint: string;
}): string {
  return (
    "exr1:" +
    sha256Hex(
      canonicalJson({
        v: 1,
        experimentId: input.experimentId,
        calculationVersion: input.calculationVersion,
        evidenceFingerprint: input.evidenceFingerprint,
      })
    )
  );
}

/** Fingerprint over the exact evidence set a result is reproducible from. */
export function deriveEvidenceFingerprint(
  evidenceRows: ReadonlyArray<{ evidenceId: string; armIndex: number; outcomeStatus: string; outcomeType: string }>
): string {
  const sorted = [...evidenceRows].sort((a, b) =>
    a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0
  );
  return sha256Hex(
    canonicalJson(
      sorted.map((r) => ({
        evidenceId: r.evidenceId,
        armIndex: r.armIndex,
        outcomeStatus: r.outcomeStatus,
        outcomeType: r.outcomeType,
      }))
    )
  );
}

/** Deterministic lifecycle event id. */
export function deriveLifecycleEventId(input: {
  experimentId: string;
  lifecycleType: string;
  toStatus: string;
  occurredAt: string;
  reasonCode: string | null;
  seq: number;
}): string {
  return (
    "exl1:" +
    sha256Hex(
      canonicalJson({
        v: 1,
        experimentId: input.experimentId,
        lifecycleType: input.lifecycleType,
        toStatus: input.toStatus,
        occurredAt: input.occurredAt,
        reasonCode: input.reasonCode,
        seq: input.seq,
      })
    )
  );
}

/**
 * sha256 over the canonical immutable core of the experiment row: identity +
 * hypothesis + design. Lifecycle-mutated columns (status, startAt, endAt,
 * assignmentVersion, governanceDecisionId, approvalReference, resultId) are
 * excluded — they change through governed CAS transitions, each minting an
 * immutable lifecycle fact. The hash proves the security-critical property:
 * design/identity immutability after creation (control/treatment can never
 * silently change).
 */
export function deriveRecordHash(input: {
  experimentId: string;
  hypothesisId: string;
  userId: number;
  businessId: number;
  learningId: string;
  statement: string;
  designType: string;
  dimension: string;
  controlDefinition: unknown;
  treatmentDefinitions: unknown;
  allocationPolicy: unknown;
  primaryMetric: unknown;
  secondaryMetrics: unknown;
  guardrails: unknown;
  minimumSamplePerArm: number;
  durationDays: number;
  designHash: string;
  narrativeDraft: string | null;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      experimentId: input.experimentId,
      hypothesisId: input.hypothesisId,
      tenantUserId: input.userId,
      businessId: input.businessId,
      learningId: input.learningId,
      statement: input.statement,
      designType: input.designType,
      dimension: input.dimension,
      controlDefinition: input.controlDefinition,
      treatmentDefinitions: input.treatmentDefinitions,
      allocationPolicy: input.allocationPolicy,
      primaryMetric: input.primaryMetric,
      secondaryMetrics: input.secondaryMetrics,
      guardrails: input.guardrails,
      minimumSamplePerArm: input.minimumSamplePerArm,
      durationDays: input.durationDays,
      designHash: input.designHash,
      narrativeDraft: input.narrativeDraft,
    })
  );
}

/** sha256 over a result row's immutable core. */
export function deriveResultHash(input: {
  resultId: string;
  experimentId: string;
  userId: number;
  calculationVersion: string;
  verdict: string;
  confidenceClass: string;
  primaryMetric: unknown;
  armSummaries: unknown;
  comparison: unknown;
  evidenceCounts: unknown;
  limitations: unknown;
  conclusion: string;
  evidenceFingerprint: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      resultId: input.resultId,
      experimentId: input.experimentId,
      tenantUserId: input.userId,
      calculationVersion: input.calculationVersion,
      verdict: input.verdict,
      confidenceClass: input.confidenceClass,
      primaryMetric: input.primaryMetric,
      armSummaries: input.armSummaries,
      comparison: input.comparison,
      evidenceCounts: input.evidenceCounts,
      limitations: input.limitations,
      conclusion: input.conclusion,
      evidenceFingerprint: input.evidenceFingerprint,
    })
  );
}
