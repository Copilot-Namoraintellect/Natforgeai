// ─── R9-D Execution Coordination — deterministic identity derivations ───
//
// PURE module (contract §3). Every identity rebuilds its hashed fragment
// field-by-field: callers cannot smuggle extra keys into a hash. Same
// authoritative inputs ⇒ same output; any material change ⇒ new identity.
// No clock, no I/O, no authority decisions.
//
// The execution action binds tenant + business + mission + plan + schedule +
// task + action type + exact parameters + the governance authorization
// fingerprint. A changed parameter set or a changed authorization mints a new
// identity — the old authorization can never silently cover new material.

import { canonicalJson, sha256Hex } from "../conversion/conversion-contract";

export const EXECUTION_ACTION_ID_PREFIX = "exa1:" as const;
export const EXECUTION_ATTEMPT_ID_PREFIX = "exr1:" as const;
export const EXECUTION_LIFECYCLE_ID_PREFIX = "exl1:" as const;
export const EXECUTION_IDEMPOTENCY_KEY_PREFIX = "idem1:" as const;
export const EXTERNAL_REFERENCE_PREFIX = "ext1:" as const;

/**
 * Fingerprint of the canonical action parameters (contract §3): binds
 * scheduleId + taskId + taskType + actionType + adapterType + capability +
 * the bounded parameters — exactly the object R9-F's actionParamsFingerprint
 * binds. Raw bounded parameters never persist; this hash is the durable
 * binding. Equals deriveGovernanceActionParamsFingerprint(canonicalParams).
 */
export function deriveActionParametersHash(canonicalActionParams: unknown): string {
  return sha256Hex(canonicalJson({ v: 1, params: canonicalActionParams }));
}

/**
 * Fingerprint of the consumed R9-F authorization: decision + policy version +
 * bound approval + risk class + expiry, exactly as the gate returned it.
 */
export function deriveAuthorizationFingerprint(input: {
  governanceDecisionId: string;
  policyVersion: string;
  approvalRequestId: number | null;
  missionRiskClass: string;
  expiresAt: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      governanceDecisionId: input.governanceDecisionId,
      policyVersion: input.policyVersion,
      approvalRequestId: input.approvalRequestId,
      missionRiskClass: input.missionRiskClass,
      expiresAt: input.expiresAt,
    })
  );
}

/**
 * The canonical action parameters bound into R9-F's actionParamsFingerprint.
 * R9-F evaluated a proposal over EXACTLY this object; R9-D recomputes it at
 * consumption and the frozen gate fails closed on any drift.
 */
export function deriveCanonicalActionParams(input: {
  scheduleId: string;
  taskId: string;
  taskType: string;
  actionType: string;
  adapterType: string;
  capability: string;
  parameters: unknown;
}): Record<string, unknown> {
  return {
    v: 1,
    scheduleId: input.scheduleId,
    taskId: input.taskId,
    taskType: input.taskType,
    actionType: input.actionType,
    adapterType: input.adapterType,
    capability: input.capability,
    parameters: input.parameters ?? {},
  };
}

/** Deterministic execution-action identity (the envelope anchor, D2). */
export function deriveExecutionActionId(input: {
  tenantUserId: number;
  businessId: number;
  missionId: string;
  planId: string;
  scheduleId: string;
  taskId: string;
  actionType: string;
  actionParametersHash: string;
  authorizationFingerprint: string;
  adapterType: string;
}): string {
  return `${EXECUTION_ACTION_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      missionId: input.missionId,
      planId: input.planId,
      scheduleId: input.scheduleId,
      taskId: input.taskId,
      actionType: input.actionType,
      actionParametersHash: input.actionParametersHash,
      authorizationFingerprint: input.authorizationFingerprint,
      adapterType: input.adapterType,
    })
  )}`;
}

/** Deterministic idempotency key — derived, never client-generated. */
export function deriveIdempotencyKey(tenantUserId: number, executionActionId: string): string {
  return `${EXECUTION_IDEMPOTENCY_KEY_PREFIX}${sha256Hex(
    canonicalJson({ v: 1, tenantUserId, executionActionId })
  )}`;
}

/** Deterministic per-attempt dispatch fingerprint. */
export function deriveDispatchFingerprint(input: {
  executionActionId: string;
  adapterType: string;
  capability: string;
  attemptNumber: number;
  actionParametersHash: string;
  idempotencyKey: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      executionActionId: input.executionActionId,
      adapterType: input.adapterType,
      capability: input.capability,
      attemptNumber: input.attemptNumber,
      actionParametersHash: input.actionParametersHash,
      idempotencyKey: input.idempotencyKey,
    })
  );
}

/** Deterministic execution-attempt identity. */
export function deriveAttemptId(input: {
  executionActionId: string;
  attemptNumber: number;
  dispatchFingerprint: string;
}): string {
  return `${EXECUTION_ATTEMPT_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      executionActionId: input.executionActionId,
      attemptNumber: input.attemptNumber,
      dispatchFingerprint: input.dispatchFingerprint,
    })
  )}`;
}

/**
 * Deterministic server-issued external reference for a pending attempt. The
 * callback path must present exactly this reference; a mismatch fails closed.
 */
export function deriveExternalReference(attemptId: string): string {
  return `${EXTERNAL_REFERENCE_PREFIX}${sha256Hex(canonicalJson({ v: 1, attemptId }))}`;
}

/** Fingerprint of the redacted classification material — never raw payloads. */
export function deriveResultHash(input: {
  attemptId: string;
  resultStatus: string;
  failureClass: string;
  uncertaintyClass: string;
  externalReference: string | null;
  classifiedResult: unknown;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      attemptId: input.attemptId,
      resultStatus: input.resultStatus,
      failureClass: input.failureClass,
      uncertaintyClass: input.uncertaintyClass,
      externalReference: input.externalReference,
      classifiedResult: input.classifiedResult ?? {},
    })
  );
}

/** Deterministic append-only lifecycle fact identity. */
export function deriveLifecycleEventId(input: {
  executionActionId: string;
  lifecycleType: string;
  fromState: string | null;
  toState: string;
  reasonCode: string | null;
  attemptId: string | null;
  occurredAt: string;
}): string {
  return `${EXECUTION_LIFECYCLE_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      executionActionId: input.executionActionId,
      lifecycleType: input.lifecycleType,
      fromState: input.fromState,
      toState: input.toState,
      reasonCode: input.reasonCode,
      attemptId: input.attemptId,
      occurredAt: input.occurredAt,
    })
  )}`;
}
