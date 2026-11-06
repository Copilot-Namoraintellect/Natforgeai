// ─── R10-C Runtime Resilience — heartbeat / liveness (C3) ───
//
// PURE classification module: given a worker row, the worker population and the
// expected runtime contract version, classify liveness. No I/O, no clock —
// the caller passes `nowMs` explicitly.
//
// Hard rule carried verbatim: ABSENCE OF HEARTBEAT IS NEVER PROOF THAT AN
// EXTERNAL ACTION DID NOT EXECUTE. A worker classified DEAD/STALE leaves its
// in-flight external action UNCERTAIN (reconciled by safe resume, C6) — never
// "not happened". Liveness only decides whether the worker may CONTINUE to
// hold/renew work; it never rewrites an execution outcome.

import {
  RUNTIME_RESILIENCE_CONTRACT_VERSION,
  type RuntimeLivenessClass,
} from "./runtime-resilience-contract";

export interface LivenessThresholds {
  /** Heartbeat overdue by more than this → LATE (worker may be slowing). */
  readonly lateAfterMs: number;
  /** Overdue by more than this → STALE (worker may be dead; do not renew). */
  readonly staleAfterMs: number;
  /** Overdue by more than this → DEAD (worker assumed lost). */
  readonly deadAfterMs: number;
}

export const DEFAULT_LIVENESS_THRESHOLDS: LivenessThresholds = Object.freeze({
  lateAfterMs: 15_000,
  staleAfterMs: 60_000,
  deadAfterMs: 300_000,
});

export interface LivenessWorkerView {
  readonly workerInstanceId: string;
  readonly workerId: string;
  readonly runtimeVersion: string;
  readonly runtimeState: string;
  readonly heartbeatAt: string;
}

export interface LivenessEvaluation {
  readonly classification: RuntimeLivenessClass;
  readonly heartbeatOverdueMs: number;
  readonly reason: string;
}

export function assertThresholds(t: LivenessThresholds): void {
  if (
    !(t.lateAfterMs > 0) ||
    !(t.staleAfterMs > t.lateAfterMs) ||
    !(t.deadAfterMs > t.staleAfterMs)
  ) {
    throw new Error(
      "liveness thresholds must satisfy 0 < late < stale < dead."
    );
  }
}

/**
 * Classify one worker's liveness. Priority: duplicate identity and version
 * drift fail closed before heartbeat staleness, because either can make a
 * heartbeat misleading. A STOPPED/FAILED worker is DEAD regardless of how
 * fresh its last heartbeat was (the process is gone by its own admission).
 */
export function evaluateWorkerLiveness(input: {
  worker: LivenessWorkerView;
  allWorkers: readonly LivenessWorkerView[];
  expectedRuntimeVersion?: string;
  thresholds?: LivenessThresholds;
  nowMs: number;
}): LivenessEvaluation {
  const thresholds = input.thresholds ?? DEFAULT_LIVENESS_THRESHOLDS;
  assertThresholds(thresholds);
  const { worker } = input;
  const expected =
    input.expectedRuntimeVersion ?? RUNTIME_RESILIENCE_CONTRACT_VERSION;
  const heartbeatMs = Date.parse(worker.heartbeatAt);
  const overdueMs = Number.isNaN(heartbeatMs)
    ? Number.POSITIVE_INFINITY
    : input.nowMs - heartbeatMs;

  if (
    !Number.isFinite(input.nowMs) ||
    !Number.isFinite(heartbeatMs) ||
    overdueMs < -1000
  ) {
    return {
      classification: "UNKNOWN",
      heartbeatOverdueMs: Number.isFinite(overdueMs) ? overdueMs : 0,
      reason: "invalid clock or heartbeat",
    };
  }
  // Duplicate identity: multiple registrations claiming the same instance id. Logical replicas are allowed.
  const livePeers = input.allWorkers.filter(
    w =>
      w.workerInstanceId === worker.workerInstanceId &&
      w.runtimeState !== "STOPPED" &&
      w.runtimeState !== "FAILED"
  );
  if (livePeers.length > 1) {
    return {
      classification: "DUPLICATE_IDENTITY",
      heartbeatOverdueMs: overdueMs,
      reason: `logical worker ${worker.workerId} has ${livePeers.length} registrations of the same instance.`,
    };
  }

  if (worker.runtimeVersion !== expected) {
    return {
      classification: "VERSION_DRIFT",
      heartbeatOverdueMs: overdueMs,
      reason: `worker runtime ${worker.runtimeVersion} != expected ${expected}.`,
    };
  }

  if (worker.runtimeState === "STOPPED" || worker.runtimeState === "FAILED") {
    return {
      classification: "DEAD",
      heartbeatOverdueMs: overdueMs,
      reason: `worker state ${worker.runtimeState} is terminal.`,
    };
  }

  if (overdueMs <= thresholds.lateAfterMs) {
    return {
      classification: "HEALTHY",
      heartbeatOverdueMs: overdueMs,
      reason: "heartbeat fresh.",
    };
  }
  if (overdueMs <= thresholds.staleAfterMs) {
    return {
      classification: "LATE",
      heartbeatOverdueMs: overdueMs,
      reason: "heartbeat late.",
    };
  }
  if (overdueMs <= thresholds.deadAfterMs) {
    return {
      classification: "STALE",
      heartbeatOverdueMs: overdueMs,
      reason: "heartbeat stale.",
    };
  }
  return {
    classification: "DEAD",
    heartbeatOverdueMs: overdueMs,
    reason: "heartbeat dead.",
  };
}

/**
 * May this worker continue to hold or renew work? Only HEALTHY and LATE
 * workers may. STALE/DEAD workers stop renewing (their leases expire and are
 * reclaimed); VERSION_DRIFT and DUPLICATE_IDENTITY fail closed immediately.
 * This gates renewal/claim — it NEVER rewrites a recorded execution outcome.
 */
export function mayWorkerHoldWork(evaluation: LivenessEvaluation): boolean {
  return (
    evaluation.classification === "HEALTHY" ||
    evaluation.classification === "LATE"
  );
}
