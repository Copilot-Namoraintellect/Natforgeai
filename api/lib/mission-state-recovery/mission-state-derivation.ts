// ─── R9-E Mission State, Recovery & Observability — deterministic derivation ───
//
// PURE derivation module (contract §6/§7/§8). Rule-ordered, first-match-wins.
// Inputs are validated upstream row views (seams) + the server clock + the
// bound policy horizons. No I/O, no clock ownership (now is injected), no
// authority decisions, no model anywhere in the path.
//
// Hard guarantees: no inferred success (only an authoritative R9-D SUCCEEDED
// attempt derives SUCCEEDED); uncertainty is never converted to success; a
// final failure is never downgraded; stale/uncertain states stay visible.

import {
  MISSION_FAILURE_CLASSES,
  MISSION_UNCERTAINTY_CLASSES,
  MISSION_RECOVERY_TYPES,
  MISSION_BLOCKING_REASONS,
  type MissionBlockingReason,
  type MissionFailureClass,
  type MissionHealthClass,
  type MissionRecoveryType,
  type MissionUncertaintyClass,
  type TaskOperationalStatus,
} from "./mission-state-recovery-contract";
import type { TaskStateCoreInput } from "./mission-state-recovery-identity";
import type { TaskAuthorityView, ScheduleBlockingStateView } from "./mission-state-upstream-seam";
import type {
  ExecutionActionView,
  ExecutionAttemptView,
} from "./mission-execution-seam";

export interface TaskDerivationInput {
  /** The R9-B task row; null when the task is unknown to planning. */
  readonly task: TaskAuthorityView | null;
  /** task ∈ current schedule orderedTaskIds. */
  readonly inCurrentSchedule: boolean;
  /** R9-C per-task blocking state, when present. */
  readonly scheduleBlocking: ScheduleBlockingStateView | null;
  /** All R9-D execution actions bound to this exact task. */
  readonly actions: readonly ExecutionActionView[];
  /** All R9-D attempts across those actions (any order; the engine picks). */
  readonly attempts: readonly ExecutionAttemptView[];
  /** Verbatim R9-A mission status. */
  readonly missionStatus: string;
  /** Verbatim R9-C schedule status. */
  readonly scheduleStatus: string;
  /** Server clock (injected). */
  readonly nowMs: number;
  /** Policy horizon: PENDING_EXTERNAL beyond this is STALE (visible). */
  readonly pendingExternalStaleMs: number;
  /** Policy horizon: DISPATCHED without result beyond this is STALE. */
  readonly dispatchedStaleMs: number;
}

export interface TaskOperationalDerivation {
  readonly status: TaskOperationalStatus;
  readonly failureClass: MissionFailureClass;
  readonly uncertaintyClass: MissionUncertaintyClass;
  readonly retryEligibility: boolean;
  readonly recoveryRequired: boolean;
  readonly blockingReasons: readonly MissionBlockingReason[];
  readonly uncertainties: readonly MissionUncertaintyClass[];
  readonly latestAttemptId: string | null;
  readonly latestActionId: string | null;
}

const FAILURE = new Set(MISSION_FAILURE_CLASSES);
const UNCERTAINTY = new Set(MISSION_UNCERTAINTY_CLASSES);
const BLOCKING = new Set(MISSION_BLOCKING_REASONS as readonly string[]);
const RECOVERY_TYPES = new Set(MISSION_RECOVERY_TYPES as readonly string[]);

function asFailure(value: string): MissionFailureClass {
  return (FAILURE.has(value as MissionFailureClass) ? value : "NONE") as MissionFailureClass;
}

function asUncertainty(value: string): MissionUncertaintyClass {
  return (UNCERTAINTY.has(value as MissionUncertaintyClass) ? value : "NONE") as MissionUncertaintyClass;
}

function asBlocking(value: string): MissionBlockingReason {
  return (BLOCKING.has(value as MissionBlockingReason) ? value : "MISSION_NOT_CURRENT") as MissionBlockingReason;
}

const CURRENT_MISSION_STATUSES = new Set(["PROPOSED", "ELIGIBLE_FOR_PLANNING", "REVIEW_REQUIRED"]);
const CURRENT_SCHEDULE_STATUS = "READY";

interface PickedAttempt {
  readonly action: ExecutionActionView;
  readonly attempt: ExecutionAttemptView;
}

/** Latest authoritative attempt across all of the task's actions. */
export function pickLatestAttempt(
  actions: readonly ExecutionActionView[],
  attempts: readonly ExecutionAttemptView[]
): PickedAttempt | null {
  let best: PickedAttempt | null = null;
  let bestKey = "";
  const actionById = new Map(actions.map((a) => [a.executionActionId, a]));
  for (const attempt of attempts) {
    const action = actionById.get(attempt.executionActionId);
    if (!action) continue;
    const timeKey = attempt.completedAt ?? attempt.startedAt ?? attempt.createdAt ?? "";
    const key = `${timeKey}#${String(attempt.attemptNumber).padStart(8, "0")}#${attempt.attemptId}`;
    if (key > bestKey) {
      bestKey = key;
      best = { action, attempt };
    }
  }
  return best;
}

function base() {
  return {
    retryEligibility: false,
    recoveryRequired: false,
    blockingReasons: [] as MissionBlockingReason[],
    uncertainties: [] as MissionUncertaintyClass[],
    latestAttemptId: null as string | null,
    latestActionId: null as string | null,
  };
}

/** Rule-ordered task operational-state derivation (contract §6.2). */
export function deriveTaskOperationalState(input: TaskDerivationInput): TaskOperationalDerivation {
  const out = base();
  const picked = pickLatestAttempt(input.actions, input.attempts);
  if (picked) {
    out.latestAttemptId = picked.attempt.attemptId;
    out.latestActionId = picked.action.executionActionId;
  } else if (input.actions.length > 0) {
    // Deterministic latest-action pick when no attempts exist yet.
    const latest = [...input.actions].sort((a, b) => b.executionActionId.localeCompare(a.executionActionId))[0];
    out.latestActionId = latest.executionActionId;
  }

  // Rule 1 — authority drift (mission first, then schedule).
  if (!CURRENT_MISSION_STATUSES.has(input.missionStatus)) {
    const reason =
      input.missionStatus === "SUPERSEDED"
        ? "MISSION_SUPERSEDED"
        : input.missionStatus === "STALE"
          ? "MISSION_STALE"
          : input.missionStatus === "CANCELLED"
            ? "MISSION_CANCELLED"
            : input.missionStatus === "INVALIDATED"
              ? "MISSION_INVALIDATED"
              : "MISSION_BLOCKED";
    out.blockingReasons.push(asBlocking(reason));
    if (input.missionStatus === "STALE") out.uncertainties.push("SCHEDULE_DRIFT");
    return {
      status: "BLOCKED",
      failureClass: "NONE",
      uncertaintyClass: out.uncertainties[0] ?? "NONE",
      retryEligibility: false,
      recoveryRequired: true,
      blockingReasons: out.blockingReasons,
      uncertainties: out.uncertainties,
      latestAttemptId: out.latestAttemptId,
      latestActionId: out.latestActionId,
    };
  }
  if (input.scheduleStatus !== CURRENT_SCHEDULE_STATUS) {
    const reason =
      input.scheduleStatus === "SUPERSEDED"
        ? "SCHEDULE_SUPERSEDED"
        : input.scheduleStatus === "STALE"
          ? "SCHEDULE_STALE"
          : input.scheduleStatus === "INVALIDATED"
            ? "SCHEDULE_INVALIDATED"
            : input.scheduleStatus === "CANCELLED"
              ? "SCHEDULE_CANCELLED"
              : input.scheduleStatus === "BLOCKED"
                ? "SCHEDULE_BLOCKED"
                : "SCHEDULE_NOT_READY";
    out.blockingReasons.push(asBlocking(reason));
    const uncertainty: MissionUncertaintyClass = input.scheduleStatus === "STALE" ? "SCHEDULE_DRIFT" : "NONE";
    if (uncertainty !== "NONE") out.uncertainties.push(uncertainty);
    return {
      status: "BLOCKED",
      failureClass: "SCHEDULE_STALE",
      uncertaintyClass: uncertainty,
      retryEligibility: false,
      recoveryRequired: true,
      blockingReasons: out.blockingReasons,
      uncertainties: out.uncertainties,
      latestAttemptId: out.latestAttemptId,
      latestActionId: out.latestActionId,
    };
  }

  // Rule 2 — task not executable by planning.
  if (!input.task || !input.inCurrentSchedule) {
    out.blockingReasons.push(asBlocking("TASK_NOT_SCHEDULED"));
    return finish("BLOCKED", "NONE", "NONE", out);
  }
  if (input.task.status === "UNRESOLVED") {
    out.blockingReasons.push(asBlocking("TASK_UNRESOLVED"));
    return finish("BLOCKED", "NONE", "NONE", out);
  }
  if (input.task.status === "BLOCKED") {
    out.blockingReasons.push(asBlocking("TASK_BLOCKED"));
    return finish("BLOCKED", "NONE", "NONE", out);
  }
  if (input.task.status === "GOVERNANCE_REVIEW_REQUIRED") {
    out.blockingReasons.push(asBlocking("GOVERNANCE_REVIEW_PENDING"));
    return finish("BLOCKED", "NONE", "NONE", out);
  }
  if (input.task.status === "SUPERSEDED") {
    out.blockingReasons.push(asBlocking("TASK_SUPERSEDED"));
    return finish("BLOCKED", "NONE", "NONE", out);
  }
  if (input.task.capabilityStatus !== null && input.task.capabilityStatus.startsWith("UNSUPPORTED")) {
    out.blockingReasons.push(asBlocking("TASK_BLOCKED"));
    return finish("BLOCKED", "CAPABILITY_UNAVAILABLE", "NONE", { ...out, recoveryRequired: true });
  }
  if (input.scheduleBlocking && input.scheduleBlocking.readiness !== "READY_FOR_SCHEDULING") {
    out.blockingReasons.push(asBlocking("DEPENDENCY_NOT_SATISFIED"));
    return finish("BLOCKED", "DEPENDENCY_INVALID", "NONE", { ...out, recoveryRequired: true });
  }

  // Rules 3–5 — dispatch lifecycle without terminal result.
  const action = picked?.action ?? (input.actions.length > 0 ? latestAction(input.actions) : null);
  if (!action) {
    // Rule 3 — never attempted.
    return finish("PENDING", "NONE", "NONE", out);
  }
  if (action.dispatchState === "CANCELLED") {
    return finish("CANCELLED", "NONE", "NONE", out);
  }
  if (action.dispatchState === "DISPATCH_PREPARED") {
    return finish("READY", "NONE", "NONE", out);
  }
  if (action.dispatchState === "DISPATCHED" || action.dispatchState === "ACKNOWLEDGED") {
    const attempt = picked?.attempt ?? null;
    const pendingExternal = attempt?.resultStatus === "PENDING_EXTERNAL";
    if (pendingExternal) {
      const anchorMs = Date.parse(attempt?.startedAt ?? "") || input.nowMs;
      if (input.nowMs - anchorMs > input.pendingExternalStaleMs) {
        out.uncertainties.push("STALE_STATE");
        return finish("STALE", "PROVIDER_PENDING", "STALE_STATE", { ...out, recoveryRequired: true });
      }
      out.uncertainties.push("PROVIDER_PENDING");
      return finish("PENDING_EXTERNAL", "PROVIDER_PENDING", "PROVIDER_PENDING", out);
    }
    const anchorMs = Date.parse(attempt?.startedAt ?? "") || input.nowMs;
    if (input.nowMs - anchorMs > input.dispatchedStaleMs) {
      out.uncertainties.push("STALE_STATE");
      return finish("STALE", "NONE", "STALE_STATE", { ...out, recoveryRequired: true });
    }
    return finish("DISPATCHED", "NONE", "NONE", out);
  }

  // Rules 6–9 — terminal results ride the LATEST authoritative attempt.
  if (!picked) {
    // Terminal dispatch state without a readable attempt is corrupted evidence.
    return finish("UNCERTAIN", "AMBIGUOUS_RESULT", "PROVIDER_STATE_UNKNOWN", { ...out, recoveryRequired: true });
  }
  const result = picked.attempt.resultStatus;
  if (result === "SUCCEEDED") {
    return finish("SUCCEEDED", "NONE", "NONE", out);
  }
  if (result === "FAILED_FINAL") {
    const failure: MissionFailureClass = picked.attempt.failureClass === "AMBIGUOUS_CALLBACK" ? "CALLBACK_MISMATCH" : "FINAL";
    return finish("FAILED_FINAL", failure, "NONE", { ...out, recoveryRequired: true });
  }
  if (result === "FAILED_RETRYABLE") {
    return finish("FAILED_RETRYABLE", "TRANSIENT", "NONE", { ...out, retryEligibility: true, recoveryRequired: true });
  }
  if (result === "PENDING_EXTERNAL") {
    const anchorMs = Date.parse(picked.attempt.startedAt ?? "") || input.nowMs;
    if (input.nowMs - anchorMs > input.pendingExternalStaleMs) {
      out.uncertainties.push("STALE_STATE");
      return finish("STALE", "PROVIDER_PENDING", "STALE_STATE", { ...out, recoveryRequired: true });
    }
    out.uncertainties.push("PROVIDER_PENDING");
    return finish("PENDING_EXTERNAL", "PROVIDER_PENDING", "PROVIDER_PENDING", out);
  }
  if (result === "UNCERTAIN") {
    const uncertainty = mapExecutionUncertainty(picked.attempt.uncertaintyClass);
    if (uncertainty !== "NONE") out.uncertainties.push(uncertainty);
    return finish("UNCERTAIN", "AMBIGUOUS_RESULT", uncertainty, { ...out, recoveryRequired: true });
  }
  // Null result on a terminal dispatch state — corrupted/ambiguous evidence.
  return finish("UNCERTAIN", "AMBIGUOUS_RESULT", "PROVIDER_STATE_UNKNOWN", { ...out, recoveryRequired: true });
}

function latestAction(actions: readonly ExecutionActionView[]): ExecutionActionView {
  return [...actions].sort((a, b) => b.executionActionId.localeCompare(a.executionActionId))[0];
}

function mapExecutionUncertainty(value: string): MissionUncertaintyClass {
  switch (value) {
    case "TIMEOUT":
      return "TIMEOUT";
    case "CALLBACK_AMBIGUOUS":
      return "CALLBACK_AMBIGUOUS";
    case "PARTIAL_CONFIRMATION":
      return "PARTIAL_CONFIRMATION";
    case "PROVIDER_STATE_UNKNOWN":
      return "PROVIDER_STATE_UNKNOWN";
    default:
      return "PROVIDER_STATE_UNKNOWN";
  }
}

function finish(
  status: TaskOperationalStatus,
  failureClass: MissionFailureClass,
  uncertaintyClass: MissionUncertaintyClass,
  out: {
    retryEligibility: boolean;
    recoveryRequired: boolean;
    blockingReasons: readonly MissionBlockingReason[];
    uncertainties: readonly MissionUncertaintyClass[];
    latestAttemptId: string | null;
    latestActionId: string | null;
  }
): TaskOperationalDerivation {
  const uncertainties = out.uncertainties.includes(uncertaintyClass)
    ? out.uncertainties
    : uncertaintyClass === "NONE"
      ? out.uncertainties
      : [...out.uncertainties, uncertaintyClass];
  return {
    status,
    failureClass: asFailure(failureClass),
    uncertaintyClass: asUncertainty(uncertaintyClass),
    retryEligibility: out.retryEligibility,
    recoveryRequired: out.recoveryRequired,
    blockingReasons: out.blockingReasons,
    uncertainties,
    latestAttemptId: out.latestAttemptId,
    latestActionId: out.latestActionId,
  };
}

/** Deterministic recovery type selection (contract §8). */
export function selectRecoveryType(state: TaskOperationalDerivation): MissionRecoveryType | null {
  switch (state.status) {
    case "FAILED_RETRYABLE":
      return "RETRY";
    case "UNCERTAIN":
      return "REVALIDATE";
    case "STALE":
      return state.failureClass === "PROVIDER_PENDING" || state.uncertaintyClass === "PROVIDER_PENDING"
        ? "REVALIDATE"
        : "REVALIDATE";
    case "PENDING_EXTERNAL":
      return state.uncertainties.includes("STALE_STATE") ? "REVALIDATE" : "WAIT_EXTERNAL";
    case "FAILED_FINAL":
      return "REQUEST_HUMAN_REVIEW";
    case "BLOCKED": {
      const reasons = state.blockingReasons;
      if (reasons.includes("SCHEDULE_SUPERSEDED") || reasons.includes("SCHEDULE_STALE") || reasons.includes("SCHEDULE_INVALIDATED")) {
        return "RESCHEDULE";
      }
      if (
        reasons.includes("PLAN_SUPERSEDED") ||
        reasons.includes("PLAN_STALE") ||
        reasons.includes("PLAN_INVALIDATED") ||
        reasons.includes("PLAN_NOT_CURRENT")
      ) {
        return "REPLAN";
      }
      if (
        reasons.includes("MISSION_CANCELLED") ||
        reasons.includes("MISSION_INVALIDATED") ||
        reasons.includes("MISSION_BLOCKED")
      ) {
        return "CANCEL_MISSION";
      }
      if (reasons.includes("MISSION_STALE") || reasons.includes("MISSION_SUPERSEDED")) {
        return "ESCALATE";
      }
      if (reasons.includes("TASK_SUPERSEDED") || reasons.includes("TASK_NOT_SCHEDULED")) {
        return "CANCEL_TASK";
      }
      if (reasons.includes("TASK_UNRESOLVED") || reasons.includes("TASK_BLOCKED")) {
        return "ESCALATE";
      }
      if (reasons.includes("GOVERNANCE_REVIEW_PENDING")) {
        return "REQUEST_HUMAN_REVIEW";
      }
      if (reasons.includes("DEPENDENCY_NOT_SATISFIED")) {
        return "WAIT_EXTERNAL";
      }
      return "ESCALATE";
    }
    case "SUCCEEDED":
    case "CANCELLED":
    case "READY":
    case "DISPATCHED":
    case "PENDING":
      return null;
    default:
      return null;
  }
}

export interface MissionHealthDerivation {
  readonly healthClass: MissionHealthClass;
  readonly blockingReasons: readonly MissionBlockingReason[];
  readonly uncertainties: readonly MissionUncertaintyClass[];
}

/**
 * Deterministic mission health derivation (contract §7), rule-ordered.
 * requiredStates = states of tasks in the current schedule ∩ current plan.
 * driftNotes = out-of-schedule execution actions (visible, non-blocking).
 */
export function deriveMissionHealth(input: {
  readonly missionStatus: string;
  readonly planStatus: string;
  readonly scheduleStatus: string;
  readonly requiredStates: readonly TaskOperationalDerivation[];
  readonly driftNoteCount: number;
}): MissionHealthDerivation {
  const blocking: MissionBlockingReason[] = [];
  const uncertainties: MissionUncertaintyClass[] = [];
  const push = (arr: unknown[], value: unknown) => {
    if (!arr.includes(value)) arr.push(value);
  };

  // 1. Authority terminal-negative / drift.
  if (input.missionStatus === "CANCELLED" || input.missionStatus === "INVALIDATED") {
    push(blocking, asBlocking(input.missionStatus === "CANCELLED" ? "MISSION_CANCELLED" : "MISSION_INVALIDATED"));
    return { healthClass: "FAILED", blockingReasons: blocking, uncertainties };
  }
  if (input.missionStatus === "BLOCKED") {
    push(blocking, asBlocking("MISSION_BLOCKED"));
    return { healthClass: "BLOCKED", blockingReasons: blocking, uncertainties };
  }
  if (input.missionStatus === "SUPERSEDED" || input.missionStatus === "STALE") {
    push(blocking, asBlocking(input.missionStatus === "SUPERSEDED" ? "MISSION_SUPERSEDED" : "MISSION_STALE"));
    push(uncertainties, "SCHEDULE_DRIFT");
    return { healthClass: "UNCERTAIN", blockingReasons: blocking, uncertainties };
  }
  if (input.planStatus === "SUPERSEDED" || input.planStatus === "STALE" || input.planStatus === "INVALIDATED" || input.planStatus === "CANCELLED") {
    push(
      blocking,
      asBlocking(
        input.planStatus === "SUPERSEDED"
          ? "PLAN_SUPERSEDED"
          : input.planStatus === "STALE"
            ? "PLAN_STALE"
            : input.planStatus === "INVALIDATED"
              ? "PLAN_INVALIDATED"
              : "PLAN_NOT_CURRENT"
      )
    );
    push(uncertainties, "SCHEDULE_DRIFT");
    return { healthClass: "UNCERTAIN", blockingReasons: blocking, uncertainties };
  }
  if (input.scheduleStatus !== "READY") {
    push(
      blocking,
      asBlocking(
        input.scheduleStatus === "SUPERSEDED"
          ? "SCHEDULE_SUPERSEDED"
          : input.scheduleStatus === "STALE"
            ? "SCHEDULE_STALE"
            : input.scheduleStatus === "INVALIDATED"
              ? "SCHEDULE_INVALIDATED"
              : input.scheduleStatus === "CANCELLED"
                ? "SCHEDULE_CANCELLED"
                : input.scheduleStatus === "BLOCKED"
                  ? "SCHEDULE_BLOCKED"
                  : "SCHEDULE_NOT_READY"
      )
    );
    if (input.scheduleStatus === "STALE") push(uncertainties, "SCHEDULE_DRIFT");
    return { healthClass: "BLOCKED", blockingReasons: blocking, uncertainties };
  }

  const required = input.requiredStates;
  const any = (statuses: readonly TaskOperationalStatus[]) =>
    required.some((s) => (statuses as readonly string[]).includes(s.status));

  // 2. Unknown external result prevents false completion.
  if (any(["UNCERTAIN", "PENDING_EXTERNAL"])) {
    for (const s of required) {
      if (s.status === "UNCERTAIN" || s.status === "PENDING_EXTERNAL") {
        for (const u of s.uncertainties.length > 0 ? s.uncertainties : [s.uncertaintyClass]) push(uncertainties, u);
      }
    }
    return { healthClass: "UNCERTAIN", blockingReasons: blocking, uncertainties };
  }
  // 3. Blocked required work.
  if (any(["BLOCKED"])) {
    for (const s of required) {
      if (s.status === "BLOCKED") for (const b of s.blockingReasons) push(blocking, b);
    }
    return { healthClass: "BLOCKED", blockingReasons: blocking, uncertainties };
  }
  // 4. Final failures.
  if (any(["FAILED_FINAL"])) {
    const allTerminalFailed =
      required.length > 0 && required.every((s) => s.status === "FAILED_FINAL" || s.status === "CANCELLED");
    return { healthClass: allTerminalFailed ? "FAILED" : "AT_RISK", blockingReasons: blocking, uncertainties };
  }
  // 5. Retryable / stale.
  if (any(["FAILED_RETRYABLE", "STALE"])) {
    return { healthClass: "DEGRADED", blockingReasons: blocking, uncertainties };
  }
  // 6. Completion: every required task SUCCEEDED from authoritative evidence.
  if (required.length > 0 && required.every((s) => s.status === "SUCCEEDED")) {
    return { healthClass: "COMPLETED", blockingReasons: blocking, uncertainties };
  }
  // 7. Otherwise healthy in-flight work.
  if (input.driftNoteCount > 0) push(uncertainties, "SCHEDULE_DRIFT");
  return { healthClass: input.driftNoteCount > 0 ? "DEGRADED" : "HEALTHY", blockingReasons: blocking, uncertainties };
}

/** Re-export for service/harness use (single validator set). */
export function toTaskStateCore(input: TaskOperationalDerivation, taskId: string): TaskStateCoreInput {
  return {
    taskId,
    status: input.status,
    failureClass: input.failureClass,
    uncertaintyClass: input.uncertaintyClass,
    retryEligibility: input.retryEligibility,
    recoveryRequired: input.recoveryRequired,
    blockingReasons: [...input.blockingReasons],
    uncertainties: [...input.uncertainties],
    latestAttemptId: input.latestAttemptId,
  };
}

export function isKnownRecoveryType(value: string): value is MissionRecoveryType {
  return RECOVERY_TYPES.has(value);
}
