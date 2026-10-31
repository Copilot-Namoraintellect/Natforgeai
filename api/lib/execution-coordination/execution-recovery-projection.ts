// ─── R9-D Execution Coordination — read-only state/recovery projection ───
//
// Frozen downstream projection (D11) for the future R9-E state & recovery
// stream: docs/contracts/mission-execution-to-state-recovery-contract.md.
// Exact key allowlist — asserted exact in acceptance. Verbatim disclaimers
// travel with every projection. Read-only: it authorizes nothing, mutates
// nothing and carries no secrets, credentials, action parameters or raw
// provider payloads — only hashes, closed labels and bounded references.

import { EXECUTION_RECOVERY_PROJECTION_VERSION } from "./execution-coordination-contract";

export const EXECUTION_DISCLAIMER =
  "Execution state is observable evidence only — never recovery authority. dispatch != success; " +
  "uncertainty != success. Retry requires fresh R9-F governance consumption; recovery orchestration " +
  "is R9-E authority. This projection authorizes nothing and mutates nothing.";

export const EXECUTION_OBSERVABILITY_DISCLAIMER =
  "association != causation. This projection carries no outcome truth, no approval state, no secrets " +
  "and no action parameters. History is append-only; consumers must never rewrite execution records.";

export const EXECUTION_RECOVERY_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "executionActionId",
  "attemptId",
  "missionId",
  "planId",
  "scheduleId",
  "taskId",
  "actionType",
  "adapterType",
  "attemptNumber",
  "dispatchState",
  "resultStatus",
  "failureClass",
  "uncertaintyClass",
  "externalReference",
  "authorizationFingerprint",
  "idempotencyKey",
  "startedAt",
  "completedAt",
  "retryCandidate",
  "limitations",
  "executionDisclaimer",
  "observabilityDisclaimer",
] as const;

export type ExecutionRecoveryProjectionKey = (typeof EXECUTION_RECOVERY_PROJECTION_FIELD_KEYS)[number];

export interface ExecutionRecoveryProjection {
  readonly contractVersion: typeof EXECUTION_RECOVERY_PROJECTION_VERSION;
  readonly executionActionId: string;
  readonly attemptId: string | null;
  readonly missionId: string;
  readonly planId: string;
  readonly scheduleId: string;
  readonly taskId: string;
  readonly actionType: string;
  readonly adapterType: string;
  readonly attemptNumber: number | null;
  readonly dispatchState: string;
  readonly resultStatus: string | null;
  readonly failureClass: string;
  readonly uncertaintyClass: string;
  readonly externalReference: string | null;
  readonly authorizationFingerprint: string;
  readonly idempotencyKey: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly retryCandidate: { readonly required: boolean; readonly reason: string | null };
  readonly limitations: readonly string[];
  readonly executionDisclaimer: typeof EXECUTION_DISCLAIMER;
  readonly observabilityDisclaimer: typeof EXECUTION_OBSERVABILITY_DISCLAIMER;
}

const BASE_LIMITATIONS: readonly string[] = [
  "dispatch != success; uncertainty != success",
  "retry candidate is not retry authorization — fresh R9-F consumption required",
  "projection carries no secrets, action parameters or provider payloads",
  "history is append-only; consumers must never rewrite execution records",
];

export function buildRecoveryProjection(input: {
  executionActionId: string;
  attemptId: string | null;
  missionId: string;
  planId: string;
  scheduleId: string;
  taskId: string;
  actionType: string;
  adapterType: string;
  attemptNumber: number | null;
  dispatchState: string;
  resultStatus: string | null;
  failureClass: string;
  uncertaintyClass: string;
  externalReference: string | null;
  authorizationFingerprint: string;
  idempotencyKey: string;
  startedAt: string | null;
  completedAt: string | null;
  retryCandidate: { readonly required: boolean; readonly reason: string | null };
  extraLimitations?: readonly string[];
}): ExecutionRecoveryProjection {
  return {
    contractVersion: EXECUTION_RECOVERY_PROJECTION_VERSION,
    executionActionId: input.executionActionId,
    attemptId: input.attemptId,
    missionId: input.missionId,
    planId: input.planId,
    scheduleId: input.scheduleId,
    taskId: input.taskId,
    actionType: input.actionType,
    adapterType: input.adapterType,
    attemptNumber: input.attemptNumber,
    dispatchState: input.dispatchState,
    resultStatus: input.resultStatus,
    failureClass: input.failureClass,
    uncertaintyClass: input.uncertaintyClass,
    externalReference: input.externalReference,
    authorizationFingerprint: input.authorizationFingerprint,
    idempotencyKey: input.idempotencyKey,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    retryCandidate: input.retryCandidate,
    limitations: [...BASE_LIMITATIONS, ...(input.extraLimitations ?? [])],
    executionDisclaimer: EXECUTION_DISCLAIMER,
    observabilityDisclaimer: EXECUTION_OBSERVABILITY_DISCLAIMER,
  };
}
