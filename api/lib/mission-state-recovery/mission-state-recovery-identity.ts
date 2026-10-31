// ─── R9-E Mission State, Recovery & Observability — deterministic identity ───
//
// PURE module (contract §4). Every identity rebuilds its hashed fragment
// field-by-field: callers cannot smuggle extra keys into a hash. Same
// authoritative inputs ⇒ same identity; any material change ⇒ new identity.
// No clock, no I/O, no authority decisions.
//
// The recovery candidate binds tenant + business + mission + task/action +
// failure/uncertainty state + the LATEST AUTHORITATIVE ATTEMPT + recovery
// type. The candidate scope is the verbatim original mission/task/action
// scope loaded server-side from the durable R9-D row — recovery preserves
// the original scope; any drift INVALIDATES the candidate.

import { canonicalJson, sha256Hex } from "../conversion/conversion-contract";

export const MISSION_STATE_ID_PREFIX = "mst1:" as const;
export const TASK_STATE_ID_PREFIX = "tst1:" as const;
export const RECOVERY_CANDIDATE_ID_PREFIX = "rcn1:" as const;
export const RECOVERY_LIFECYCLE_ID_PREFIX = "rcl1:" as const;
export const TIMELINE_EVENT_ID_PREFIX = "mot1:" as const;

/** Canonical task-state core bound into the state hash. */
export interface TaskStateCoreInput {
  readonly taskId: string;
  readonly status: string;
  readonly failureClass: string;
  readonly uncertaintyClass: string;
  readonly retryEligibility: boolean;
  readonly recoveryRequired: boolean;
  readonly blockingReasons: readonly string[];
  readonly uncertainties: readonly string[];
  readonly latestAttemptId: string | null;
}

/** Fingerprint of the full derivation input set (contract §4). */
export function deriveStateDerivationHash(input: {
  missionFingerprint: string;
  planFingerprint: string;
  scheduleFingerprint: string;
  missionStatus: string;
  planStatus: string;
  scheduleStatus: string;
  taskStateCores: readonly TaskStateCoreInput[];
  nowBucket: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      missionFingerprint: input.missionFingerprint,
      planFingerprint: input.planFingerprint,
      scheduleFingerprint: input.scheduleFingerprint,
      missionStatus: input.missionStatus,
      planStatus: input.planStatus,
      scheduleStatus: input.scheduleStatus,
      taskStateCores: input.taskStateCores,
      nowBucket: input.nowBucket,
    })
  );
}

/** Immutable per-task-state core hash. */
export function deriveTaskStateHash(core: TaskStateCoreInput): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      taskId: core.taskId,
      status: core.status,
      failureClass: core.failureClass,
      uncertaintyClass: core.uncertaintyClass,
      retryEligibility: core.retryEligibility,
      recoveryRequired: core.recoveryRequired,
      blockingReasons: [...core.blockingReasons].sort(),
      uncertainties: [...core.uncertainties].sort(),
      latestAttemptId: core.latestAttemptId,
    })
  );
}

/** Deterministic mission-state identity (the observation anchor, §4). */
export function deriveMissionStateId(input: {
  tenantUserId: number;
  businessId: number;
  missionId: string;
  planId: string;
  scheduleId: string;
  stateDerivationHash: string;
}): string {
  return `${MISSION_STATE_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      missionId: input.missionId,
      planId: input.planId,
      scheduleId: input.scheduleId,
      stateDerivationHash: input.stateDerivationHash,
    })
  )}`;
}

/** Deterministic task-state identity (§4). */
export function deriveTaskStateId(input: {
  tenantUserId: number;
  businessId: number;
  missionId: string;
  planId: string;
  scheduleId: string;
  taskId: string;
  latestAttemptId: string | null;
  taskStateHash: string;
}): string {
  return `${TASK_STATE_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      missionId: input.missionId,
      planId: input.planId,
      scheduleId: input.scheduleId,
      taskId: input.taskId,
      latestAttemptId: input.latestAttemptId,
      taskStateHash: input.taskStateHash,
    })
  )}`;
}

/**
 * The verbatim original scope preserved by a recovery candidate
 * (contract §8). Loaded server-side from durable R9-D/upstream rows —
 * clients never supply any of it.
 */
export interface RecoveryScope {
  readonly missionId: string;
  readonly planId: string;
  readonly scheduleId: string;
  readonly taskId: string;
  readonly executionActionId: string | null;
  readonly latestAttemptId: string | null;
  readonly actionType: string | null;
  readonly adapterType: string | null;
  readonly capability: string | null;
  readonly actionParametersHash: string | null;
}

/** Deterministic recovery proposal hash (the immutable candidate core). */
export function deriveRecoveryProposalHash(input: {
  tenantUserId: number;
  businessId: number;
  missionId: string;
  planId: string;
  scheduleId: string;
  taskId: string;
  executionActionId: string | null;
  latestAttemptId: string | null;
  failureClass: string;
  uncertaintyClass: string;
  recoveryType: string;
  scope: RecoveryScope;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      missionId: input.missionId,
      planId: input.planId,
      scheduleId: input.scheduleId,
      taskId: input.taskId,
      executionActionId: input.executionActionId,
      latestAttemptId: input.latestAttemptId,
      failureClass: input.failureClass,
      uncertaintyClass: input.uncertaintyClass,
      recoveryType: input.recoveryType,
      scope: input.scope,
    })
  );
}

/**
 * Deterministic recovery candidate identity (§4). Binds tenant + business +
 * mission + task/action + failure/uncertainty state + latest authoritative
 * attempt + recovery type + exact proposal hash. A retry candidate preserves
 * the exact failed attempt; replay under the same anchor with different
 * material fails closed.
 */
export function deriveRecoveryCandidateId(input: {
  tenantUserId: number;
  businessId: number;
  missionId: string;
  taskId: string;
  latestAttemptId: string | null;
  recoveryType: string;
  recoveryProposalHash: string;
}): string {
  return `${RECOVERY_CANDIDATE_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      missionId: input.missionId,
      taskId: input.taskId,
      latestAttemptId: input.latestAttemptId,
      recoveryType: input.recoveryType,
      recoveryProposalHash: input.recoveryProposalHash,
    })
  )}`;
}

/** Canonical recovery action parameters bound into R9-F's params fingerprint. */
export function deriveCanonicalRecoveryParams(input: {
  recoveryCandidateId: string;
  recoveryType: string;
  executionActionId: string | null;
  latestAttemptId: string | null;
  taskId: string;
  scope: RecoveryScope;
}): Record<string, unknown> {
  return {
    v: 1,
    recoveryCandidateId: input.recoveryCandidateId,
    recoveryType: input.recoveryType,
    executionActionId: input.executionActionId,
    latestAttemptId: input.latestAttemptId,
    taskId: input.taskId,
    scope: input.scope,
  };
}

/** Governance params fingerprint (frozen R9-F derivation semantics). */
export function deriveRecoveryActionParamsFingerprint(canonicalRecoveryParams: unknown): string {
  return sha256Hex(canonicalJson({ v: 1, params: canonicalRecoveryParams }));
}

/** Deterministic append-only recovery lifecycle fact identity. */
export function deriveRecoveryLifecycleId(input: {
  recoveryCandidateId: string;
  lifecycleType: string;
  fromStatus: string | null;
  toStatus: string;
  occurredAt: string;
}): string {
  return `${RECOVERY_LIFECYCLE_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      recoveryCandidateId: input.recoveryCandidateId,
      lifecycleType: input.lifecycleType,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      occurredAt: input.occurredAt,
    })
  )}`;
}

/** Deterministic append-only operational timeline event identity. */
export function deriveTimelineEventId(input: {
  eventType: string;
  missionId: string;
  scheduleId: string | null;
  taskId: string | null;
  recoveryCandidateId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  occurredAt: string;
  subjectHash: string;
}): string {
  return `${TIMELINE_EVENT_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      eventType: input.eventType,
      missionId: input.missionId,
      scheduleId: input.scheduleId,
      taskId: input.taskId,
      recoveryCandidateId: input.recoveryCandidateId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      occurredAt: input.occurredAt,
      subjectHash: input.subjectHash,
    })
  )}`;
}

/** Hash of a bounded timeline subject (labels only — never content). */
export function deriveTimelineSubjectHash(subject: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({ v: 1, subject }));
}
