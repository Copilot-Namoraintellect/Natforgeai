// ─── R10-C Runtime Resilience → R10-E observability handoff (C12) ───
//
// PURE, READ-ONLY projection: exposes runtime health to R10-E observability
// with ZERO authority. The consumer can observe, alert and page — it can never
// claim, complete, dead-letter, retry, drain, or mutate any runtime row. The
// projection is a derived view over durable rows; it carries verbatim
// disclaimers and a frozen key allowlist so a consumer can never invent new
// authority surface.

import {
  RUNTIME_OBSERVABILITY_PROJECTION_VERSION,
  RUNTIME_RESILIENCE_CONTRACT_VERSION,
} from "./runtime-resilience-contract";
import {
  evaluateWorkerLiveness,
  type LivenessThresholds,
  type LivenessWorkerView,
} from "./runtime-liveness";
import {
  detectStuckJobs,
  type StuckJobThresholds,
  type StuckJobView,
} from "./runtime-stuck-detection";

/** Frozen top-level key allowlist of the runtime-to-observability/v1 projection. */
export const RUNTIME_OBSERVABILITY_FIELD_KEYS = [
  "projectionVersion",
  "generatedAt",
  "disclaimers",
  "workers",
  "queueDepth",
  "jobAge",
  "leaseAge",
  "deadLetterCount",
  "crashLoops",
  "versionDrift",
  "stuckWork",
  "retryBacklog",
] as const;

export interface ObservabilityWorkerRow extends LivenessWorkerView {
  readonly service: string;
  readonly startedAt: string;
  readonly releaseVersion: string;
}

export interface ObservabilityJobRow extends StuckJobView {
  readonly createdAt: string;
  readonly notBefore: string;
  readonly leaseAcquiredAt?: string | null;
  readonly authorityRef: string;
  readonly runtimeVersion: string;
}

export interface RuntimeObservabilityProjection {
  readonly projectionVersion: typeof RUNTIME_OBSERVABILITY_PROJECTION_VERSION;
  readonly generatedAt: string;
  readonly disclaimers: readonly string[];
  readonly workers: ReadonlyArray<{
    workerInstanceId: string;
    workerId: string;
    service: string;
    runtimeState: string;
    liveness: string;
    heartbeatAt: string;
    heartbeatOverdueMs: number;
    runtimeVersion: string;
    releaseVersion: string;
    versionDrift: boolean;
  }>;
  readonly queueDepth: Readonly<{
    pending: number;
    leased: number;
    completed: number;
    deadLettered: number;
    cancelled: number;
  }>;
  readonly jobAge: Readonly<{
    oldestPendingMs: number | null;
    oldestLeasedMs: number | null;
  }>;
  readonly leaseAge: Readonly<{
    activeLeases: number;
    expiredLeases: number;
    oldestActiveLeaseMs: number | null;
  }>;
  readonly deadLetterCount: Readonly<{
    total: number;
    byReason: Readonly<Record<string, number>>;
  }>;
  readonly crashLoops: ReadonlyArray<{
    workerId: string;
    instancesInWindow: number;
  }>;
  readonly versionDrift: Readonly<{
    count: number;
    workerInstanceIds: readonly string[];
  }>;
  readonly stuckWork: ReadonlyArray<{
    jobId: string;
    stuckClass: string;
    proposedRecovery: string;
  }>;
  readonly retryBacklog: Readonly<{ pending: number; candidates: number }>;
}

const DISCLAIMER_OBSERVABILITY_NO_AUTHORITY =
  "This projection is read-only observability evidence. Observability never holds runtime authority: it cannot claim, complete, dead-letter, retry, drain or mutate any runtime row, and it cannot mark any execution outcome.";
const DISCLAIMER_UNCERTAINTY_NOT_SUCCESS =
  "Missing heartbeat, a lapsed lease or an absent callback is never proof of success or failure; ambiguous work remains UNCERTAIN until reconciled by the governed recovery path.";

export function buildRuntimeObservabilityProjection(input: {
  workers: readonly ObservabilityWorkerRow[];
  jobs: readonly ObservabilityJobRow[];
  deadLetters: ReadonlyArray<{
    jobId: string;
    reason: string;
    occurredAt: string;
  }>;
  livenessThresholds?: LivenessThresholds;
  stuckThresholds?: StuckJobThresholds;
  crashLoopWindowMs?: number;
  expectedReleaseVersion?: string;
  nowMs: number;
  generatedAt: string;
}): RuntimeObservabilityProjection {
  const crashLoopWindowMs = input.crashLoopWindowMs ?? 10 * 60_000;
  const workers = input.workers.map(w => {
    const lv = evaluateWorkerLiveness({
      worker: w,
      allWorkers: input.workers,
      thresholds: input.livenessThresholds,
      nowMs: input.nowMs,
    });
    return {
      workerInstanceId: w.workerInstanceId,
      workerId: w.workerId,
      service: w.service,
      runtimeState: w.runtimeState,
      liveness: lv.classification,
      heartbeatAt: w.heartbeatAt,
      heartbeatOverdueMs: Math.round(lv.heartbeatOverdueMs),
      runtimeVersion: w.runtimeVersion,
      releaseVersion: w.releaseVersion,
      versionDrift:
        w.runtimeVersion !== RUNTIME_RESILIENCE_CONTRACT_VERSION ||
        (input.expectedReleaseVersion !== undefined &&
          w.releaseVersion !== input.expectedReleaseVersion),
    };
  });

  const count = (s: string) => input.jobs.filter(j => j.state === s).length;
  const age = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : Math.max(0, input.nowMs - ms);
  };
  const oldest = (
    rows: readonly ObservabilityJobRow[],
    pick: (j: ObservabilityJobRow) => string
  ): number | null => {
    let best: number | null = null;
    for (const j of rows) {
      const a = age(pick(j));
      if (a !== null && (best === null || a > best)) best = a;
    }
    return best;
  };

  const activeLeases = input.jobs.filter(
    j =>
      j.state === "LEASED" &&
      j.leaseExpiresAt &&
      Date.parse(j.leaseExpiresAt) > input.nowMs
  );
  const expiredLeases = input.jobs.filter(
    j =>
      j.state === "LEASED" &&
      j.leaseExpiresAt &&
      Date.parse(j.leaseExpiresAt) <= input.nowMs
  );

  const byReason: Record<string, number> = Object.create(null);
  for (const d of input.deadLetters)
    byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;

  // Crash loop: many short-lived instances of one logical worker inside the window.
  const crashLoops: Array<{ workerId: string; instancesInWindow: number }> = [];
  const byWorkerId = new Map<string, number>();
  for (const w of input.workers) {
    const startedMs = Date.parse(w.startedAt);
    if (
      !Number.isNaN(startedMs) &&
      input.nowMs - startedMs <= crashLoopWindowMs
    ) {
      byWorkerId.set(w.workerId, (byWorkerId.get(w.workerId) ?? 0) + 1);
    }
  }
  for (const [workerId, instancesInWindow] of byWorkerId) {
    if (instancesInWindow > 1) crashLoops.push({ workerId, instancesInWindow });
  }

  const versionDriftIds = workers
    .filter(w => w.versionDrift)
    .map(w => w.workerInstanceId);

  const stuckWork = detectStuckJobs({
    jobs: input.jobs,
    workers: input.workers,
    thresholds: input.stuckThresholds,
    livenessThresholds: input.livenessThresholds,
    nowMs: input.nowMs,
  });

  const retryCandidates = input.jobs.filter(
    j =>
      j.resultStatus === "FAILED_RETRYABLE" ||
      j.resultStatus === "UNCERTAIN" ||
      j.resultStatus === "PENDING_EXTERNAL"
  ).length;

  return {
    projectionVersion: RUNTIME_OBSERVABILITY_PROJECTION_VERSION,
    generatedAt: input.generatedAt,
    disclaimers: [
      DISCLAIMER_OBSERVABILITY_NO_AUTHORITY,
      DISCLAIMER_UNCERTAINTY_NOT_SUCCESS,
    ],
    workers,
    queueDepth: {
      pending: count("PENDING"),
      leased: count("LEASED"),
      completed: count("COMPLETED"),
      deadLettered: count("DEAD_LETTERED"),
      cancelled: count("CANCELLED"),
    },
    jobAge: {
      oldestPendingMs: oldest(
        input.jobs.filter(j => j.state === "PENDING"),
        j => j.createdAt
      ),
      oldestLeasedMs: oldest(
        input.jobs.filter(j => j.state === "LEASED"),
        j => j.createdAt
      ),
    },
    leaseAge: {
      activeLeases: activeLeases.length,
      expiredLeases: expiredLeases.length,
      oldestActiveLeaseMs: oldest(activeLeases, j => j.leaseAcquiredAt ?? ""),
    },
    deadLetterCount: { total: input.deadLetters.length, byReason },
    crashLoops,
    versionDrift: {
      count: versionDriftIds.length,
      workerInstanceIds: versionDriftIds,
    },
    stuckWork: stuckWork.map(s => ({
      jobId: s.jobId,
      stuckClass: s.stuckClass,
      proposedRecovery: s.proposedRecovery,
    })),
    retryBacklog: { pending: count("PENDING"), candidates: retryCandidates },
  };
}

/** Asserts a projection object carries exactly the frozen top-level allowlist. */
export function assertRuntimeObservabilityShape(
  projection: Record<string, unknown>
): void {
  const keys = Object.keys(projection).sort();
  const allowed = [...RUNTIME_OBSERVABILITY_FIELD_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(allowed)) {
    throw new Error(
      `runtime-to-observability projection shape drift: got [${keys.join(",")}].`
    );
  }
  if (
    projection.projectionVersion !== RUNTIME_OBSERVABILITY_PROJECTION_VERSION
  ) {
    throw new Error("runtime-to-observability projection version drift.");
  }
}

export { RUNTIME_RESILIENCE_CONTRACT_VERSION };
