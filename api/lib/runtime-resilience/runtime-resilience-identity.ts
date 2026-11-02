// ─── R10-C Runtime Resilience — deterministic identity derivations ───
//
// PURE module (contract §2). Every identity rebuilds its hashed fragment
// field-by-field: callers cannot smuggle extra keys into a hash. Same
// authoritative inputs ⇒ same output; any material change ⇒ new identity.
// No clock, no I/O, no authority decisions.
//
// A job identity binds tenant + business + mission/plan/schedule/task (where
// applicable) + jobType + authorityRef + attemptRef (where applicable). A
// lease identity binds the exact job + claiming worker + the lease epoch it
// was minted under. Neither grants execution authority — they fence runtime
// access to authority that was already validated upstream.

import { canonicalJson, sha256Hex } from "../conversion/conversion-contract";

export const WORKER_INSTANCE_ID_PREFIX = "wrk1:" as const;
export const RUNTIME_JOB_ID_PREFIX = "job1:" as const;
export const RUNTIME_LEASE_ID_PREFIX = "lea1:" as const;
export const RUNTIME_LIFECYCLE_ID_PREFIX = "rlf1:" as const;
export const RUNTIME_DEAD_LETTER_ID_PREFIX = "dlq1:" as const;

/**
 * Deterministic worker-instance identity. The logical workerId names a role;
 * the instance id is minted per process start and binds the release the
 * process is running. Two concurrent instances of the same logical worker
 * yield distinct instance ids (the nonce is server-generated at registration).
 */
export function deriveWorkerInstanceId(input: {
  workerId: string;
  service: string;
  releaseVersion: string;
  registrationNonce: string;
}): string {
  return `${WORKER_INSTANCE_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      workerId: input.workerId,
      service: input.service,
      releaseVersion: input.releaseVersion,
      registrationNonce: input.registrationNonce,
    })
  )}`;
}

/** Fingerprint of the bounded job parameters — raw parameters never persist. */
export function deriveJobParametersFingerprint(
  canonicalParams: unknown
): string {
  return sha256Hex(canonicalJson({ v: 1, params: canonicalParams ?? {} }));
}

/** Deterministic runtime job identity (the work-queue anchor, C2). */
export function deriveRuntimeJobId(input: {
  tenantUserId: number;
  businessId: number;
  jobType: string;
  authorityRef: string;
  missionId: string | null;
  planId: string | null;
  scheduleId: string | null;
  taskId: string | null;
  attemptRef: string | null;
  parametersFingerprint: string;
}): string {
  return `${RUNTIME_JOB_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      jobType: input.jobType,
      authorityRef: input.authorityRef,
      missionId: input.missionId ?? null,
      planId: input.planId ?? null,
      scheduleId: input.scheduleId ?? null,
      taskId: input.taskId ?? null,
      attemptRef: input.attemptRef ?? null,
      parametersFingerprint: input.parametersFingerprint,
    })
  )}`;
}

/**
 * Immutable job-core hash: binds the identity coordinates + authorityRef +
 * fingerprint. Drift on a persisted row fails closed (JOB_TAMPER) — a job can
 * never be repointed at different authority or parameters in place.
 */
export function deriveJobFingerprint(input: {
  jobId: string;
  tenantUserId: number;
  businessId: number;
  jobType: string;
  authorityRef: string;
  missionId: string | null;
  planId: string | null;
  scheduleId: string | null;
  taskId: string | null;
  attemptRef: string | null;
  parametersFingerprint: string;
  runtimeVersion: string;
  releaseVersion: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      jobId: input.jobId,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      jobType: input.jobType,
      authorityRef: input.authorityRef,
      missionId: input.missionId ?? null,
      planId: input.planId ?? null,
      scheduleId: input.scheduleId ?? null,
      taskId: input.taskId ?? null,
      attemptRef: input.attemptRef ?? null,
      parametersFingerprint: input.parametersFingerprint,
      runtimeVersion: input.runtimeVersion,
      releaseVersion: input.releaseVersion,
    })
  );
}

/**
 * Deterministic lease identity. Binds the exact job + claiming worker instance
 * + the epoch the lease was minted under. Because the epoch derives from the
 * job row's monotonic version at claim time, a lease minted after a reclaim
 * can never collide with the stale holder's lease — the fencing token.
 */
export function deriveLeaseId(input: {
  jobId: string;
  workerInstanceId: string;
  leaseEpoch: number;
  acquiredAt: string;
}): string {
  return `${RUNTIME_LEASE_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      jobId: input.jobId,
      workerInstanceId: input.workerInstanceId,
      leaseEpoch: input.leaseEpoch,
      acquiredAt: input.acquiredAt,
    })
  )}`;
}

/**
 * Fingerprint of the exact authority material a job may resume under (C6/C7):
 * the upstream authority reference set + the governance decision + approval +
 * authorization fingerprint + the action parameters hash. Safe resume and the
 * retry boundary re-derive this and fail closed on any drift.
 */
export function deriveAuthorityBindingFingerprint(input: {
  authorityRef: string;
  missionId: string | null;
  planId: string | null;
  scheduleId: string | null;
  taskId: string | null;
  actionType: string | null;
  parametersFingerprint: string;
  governanceDecisionId: string | null;
  approvalReference: number | null;
  authorizationFingerprint: string | null;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      authorityRef: input.authorityRef,
      missionId: input.missionId ?? null,
      planId: input.planId ?? null,
      scheduleId: input.scheduleId ?? null,
      taskId: input.taskId ?? null,
      actionType: input.actionType ?? null,
      parametersFingerprint: input.parametersFingerprint,
      governanceDecisionId: input.governanceDecisionId ?? null,
      approvalReference: input.approvalReference ?? null,
      authorizationFingerprint: input.authorizationFingerprint ?? null,
    })
  );
}

/** Deterministic append-only runtime lifecycle fact identity. */
export function deriveLifecycleEventId(input: {
  lifecycleType: string;
  jobId: string | null;
  workerInstanceId: string | null;
  leaseId: string | null;
  fromState: string | null;
  toState: string;
  reasonCode: string | null;
  occurredAt: string;
}): string {
  return `${RUNTIME_LIFECYCLE_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      lifecycleType: input.lifecycleType,
      jobId: input.jobId ?? null,
      workerInstanceId: input.workerInstanceId ?? null,
      leaseId: input.leaseId ?? null,
      fromState: input.fromState ?? null,
      toState: input.toState,
      reasonCode: input.reasonCode ?? null,
      occurredAt: input.occurredAt,
    })
  )}`;
}

/** Deterministic dead-letter identity (C8) — preserves the job it retired. */
export function deriveDeadLetterId(input: {
  jobId: string;
  reason: string;
  failureClass: string;
  uncertaintyClass: string;
  attemptRef: string | null;
  occurredAt: string;
}): string {
  return `${RUNTIME_DEAD_LETTER_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      jobId: input.jobId,
      reason: input.reason,
      failureClass: input.failureClass,
      uncertaintyClass: input.uncertaintyClass,
      attemptRef: input.attemptRef ?? null,
      occurredAt: input.occurredAt,
    })
  )}`;
}

/** Fingerprint of the dead-letter evidence core — drift fails closed. */
export function deriveDeadLetterFingerprint(input: {
  jobId: string;
  jobFingerprint: string;
  authorityRef: string;
  attemptRef: string | null;
  reason: string;
  failureClass: string;
  uncertaintyClass: string;
  diagnostic: unknown;
  occurredAt: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      jobId: input.jobId,
      jobFingerprint: input.jobFingerprint,
      authorityRef: input.authorityRef,
      attemptRef: input.attemptRef ?? null,
      reason: input.reason,
      failureClass: input.failureClass,
      uncertaintyClass: input.uncertaintyClass,
      diagnostic: input.diagnostic ?? {},
      occurredAt: input.occurredAt,
    })
  );
}
