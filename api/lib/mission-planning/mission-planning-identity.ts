// ─── R9-B Mission Planning — deterministic identities (B2) ───
//
// pln1: plan identity — same authoritative basis (tenant + business +
// mission + mission authority fingerprint + plan scope + derived task set +
// constraint set) ⇒ same plan; conflicting replay under the same identity
// fails closed (contract §3). tsk1: task identity. mpl1: append-only plan
// lifecycle fact identity. No client- or model-minted identity exists
// anywhere in this stream. Task wording never controls identity: only the
// server-derived canonical objective is hashed; advisory rewording travels
// separately and is never an identity input.

import { canonicalJson, sha256Hex } from "./mission-planning-contract";

export const PLAN_ID_PREFIX = "pln1:" as const;
export const TASK_ID_PREFIX = "tsk1:" as const;
export const PLAN_LIFECYCLE_EVENT_ID_PREFIX = "mpl1:" as const;

/** Canonical planning scope key — carried from the R9-A scopeKey, verbatim. */
export function derivePlanScopeKey(missionScopeKey: string): string {
  return `${missionScopeKey}|planning:v1`;
}

/** Canonical constraint-set fingerprint (same derivation as R9-A §3). */
export function deriveConstraintSetFingerprint(
  constraints: ReadonlyArray<{
    readonly constraintType: string;
    readonly statement: string;
    readonly referenceValue?: string | null;
    readonly amountMinorUnits?: number | null;
    readonly currency?: string | null;
  }>
): string {
  const canonical = [...constraints]
    .map((c) => {
      const record = c as Record<string, unknown>;
      return {
        constraintType: String(record.constraintType ?? ""),
        statement: String(record.statement ?? ""),
        referenceValue: typeof record.referenceValue === "string" ? record.referenceValue : null,
        amountMinorUnits: typeof record.amountMinorUnits === "number" ? record.amountMinorUnits : null,
        currency: typeof record.currency === "string" ? record.currency : null,
      };
    })
    .sort((a, b) => {
      const ka = `${a.constraintType}|${a.statement}`;
      const kb = `${b.constraintType}|${b.statement}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  return sha256Hex(canonicalJson({ v: 1, constraints: canonical }));
}

/** Fingerprint over one canonical artifact/condition list. */
export function deriveListFingerprint(values: readonly string[]): string {
  return sha256Hex(canonicalJson({ v: 1, values: [...values].sort() }));
}

/** Canonical task-set core (contributes to the task-set fingerprint). */
export interface TaskIdentityCore {
  readonly taskType: string;
  readonly taskObjective: string;
  readonly inputsFingerprint: string;
  readonly outputsFingerprint: string;
  readonly constraintsFingerprint: string;
}

/** Deterministic task-set fingerprint over sorted canonical task cores. */
export function deriveTaskSetFingerprint(cores: readonly TaskIdentityCore[]): string {
  const canonical = [...cores].sort((a, b) => {
    const ka = `${a.taskType}|${a.taskObjective}`;
    const kb = `${b.taskType}|${b.taskObjective}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return sha256Hex(canonicalJson({ v: 1, tasks: canonical }));
}

/** Deterministic plan identity (contract §3). planVersion is an identity
 * input: the same authoritative basis at the same version converges, while a
 * governed revision mints planVersion N+1 — a new pln1 identity carrying
 * supersedesPlanId lineage (history is never rewritten). */
export function derivePlanId(input: {
  userId: number;
  businessId: number;
  missionId: string;
  missionAuthorityVersion: string;
  planVersion: number;
  planScopeKey: string;
  taskSetFingerprint: string;
  constraintSetFingerprint: string;
}): string {
  return (
    PLAN_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        userId: input.userId,
        businessId: input.businessId,
        missionId: input.missionId,
        missionAuthorityVersion: input.missionAuthorityVersion,
        planVersion: input.planVersion,
        planScopeKey: input.planScopeKey,
        taskSetFingerprint: input.taskSetFingerprint,
        constraintSetFingerprint: input.constraintSetFingerprint,
      })
    )
  );
}

/** Deterministic task identity (contract §3). */
export function deriveTaskId(input: {
  userId: number;
  businessId: number;
  missionId: string;
  planId: string;
  taskType: string;
  taskObjective: string;
  inputsFingerprint: string;
  outputsFingerprint: string;
  constraintsFingerprint: string;
}): string {
  return (
    TASK_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        userId: input.userId,
        businessId: input.businessId,
        missionId: input.missionId,
        planId: input.planId,
        taskType: input.taskType,
        taskObjective: input.taskObjective,
        inputsFingerprint: input.inputsFingerprint,
        outputsFingerprint: input.outputsFingerprint,
        constraintsFingerprint: input.constraintsFingerprint,
      })
    )
  );
}

/** Immutable plan core fingerprint — the replay-conflict anchor. */
export function derivePlanFingerprint(input: {
  planId: string;
  missionId: string;
  missionAuthorityVersion: string;
  taskSetFingerprint: string;
  constraintSetFingerprint: string;
  unresolvedItemsFingerprint: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      planId: input.planId,
      missionId: input.missionId,
      missionAuthorityVersion: input.missionAuthorityVersion,
      taskSetFingerprint: input.taskSetFingerprint,
      constraintSetFingerprint: input.constraintSetFingerprint,
      unresolvedItemsFingerprint: input.unresolvedItemsFingerprint,
    })
  );
}

/** Immutable task core fingerprint. */
export function deriveTaskFingerprint(input: {
  taskId: string;
  taskType: string;
  taskObjective: string;
  requiredInputs: readonly string[];
  expectedOutputs: readonly string[];
  requiredCapabilities: readonly string[];
  constraintsFingerprint: string;
  preconditions: readonly { condition: string; ref: string | null }[];
  postconditions: readonly { condition: string; ref: string | null }[];
  governanceClass: string;
  sideEffectClass: string;
  executionClass: string;
  capabilityStatus: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      taskId: input.taskId,
      taskType: input.taskType,
      taskObjective: input.taskObjective,
      requiredInputs: [...input.requiredInputs].sort(),
      expectedOutputs: [...input.expectedOutputs].sort(),
      requiredCapabilities: [...input.requiredCapabilities].sort(),
      constraintsFingerprint: input.constraintsFingerprint,
      preconditions: input.preconditions,
      postconditions: input.postconditions,
      governanceClass: input.governanceClass,
      sideEffectClass: input.sideEffectClass,
      executionClass: input.executionClass,
      capabilityStatus: input.capabilityStatus,
    })
  );
}

/** Deterministic plan lifecycle fact identity (mpl1:). */
export function derivePlanLifecycleEventId(input: {
  planId: string;
  lifecycleType: string;
  targetStatus: string;
  successorPlanId: string | null;
  occurredAt: string;
  reasonCode: string;
}): string {
  return (
    PLAN_LIFECYCLE_EVENT_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        planId: input.planId,
        lifecycleType: input.lifecycleType,
        targetStatus: input.targetStatus,
        successorPlanId: input.successorPlanId,
        occurredAt: input.occurredAt,
        reasonCode: input.reasonCode,
      })
    )
  );
}
