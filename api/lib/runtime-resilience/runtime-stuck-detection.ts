// ─── R10-C Runtime Resilience — stuck job detection (C9) ───
//
// PURE derivation: given the durable job population, their leases and the
// worker population, identify jobs that cannot safely progress. Detection may
// ALERT / PROPOSE recovery — it must NEVER blindly replay. Every finding is
// advisory: the actual recovery path is R9-E (proposal → R9-F governance), and
// this module never executes, retries or requeues on its own.

import {
  RUNTIME_UNCERTAINTY_CLASSES,
  type RuntimeStuckClass,
} from "./runtime-resilience-contract";
import {
  evaluateWorkerLiveness,
  type LivenessThresholds,
  type LivenessWorkerView,
} from "./runtime-liveness";

export interface StuckJobThresholds {
  /** LEASED job whose lease expired more than this ago → LEASE_EXPIRED. */
  readonly leaseExpiredAfterMs: number;
  /** PENDING_EXTERNAL/uncertain result older than this → PROVIDER_PENDING. */
  readonly providerPendingAfterMs: number;
  /** A job whose state/version has not advanced for this → STATE_UNCHANGED. */
  readonly unchangedAfterMs: number;
}

export const DEFAULT_STUCK_THRESHOLDS: StuckJobThresholds = Object.freeze({
  leaseExpiredAfterMs: 60_000,
  providerPendingAfterMs: 15 * 60_000,
  unchangedAfterMs: 60 * 60_000,
});

export interface StuckJobView {
  readonly jobId: string;
  readonly state: string;
  readonly leaseId: string | null;
  readonly leaseOwnerInstanceId: string | null;
  readonly leaseExpiresAt: string | null;
  readonly resultStatus: string | null;
  readonly uncertaintyClass: string;
  readonly version: number;
  readonly updatedAt: string;
}

export interface StuckJobFinding {
  readonly jobId: string;
  readonly stuckClass: RuntimeStuckClass;
  readonly reason: string;
  /** Advisory only — the recovery authority (R9-E/F) decides, never this. */
  readonly proposedRecovery: "REVALIDATE" | "REQUEST_HUMAN_REVIEW" | "ESCALATE";
}

export function detectStuckJobs(input: {
  jobs: readonly StuckJobView[];
  workers: readonly LivenessWorkerView[];
  thresholds?: StuckJobThresholds;
  livenessThresholds?: LivenessThresholds;
  nowMs: number;
}): StuckJobFinding[] {
  const thresholds = input.thresholds ?? DEFAULT_STUCK_THRESHOLDS;
  const findings: StuckJobFinding[] = [];

  for (const job of input.jobs) {
    const leaseExpiryMs = job.leaseExpiresAt
      ? Date.parse(job.leaseExpiresAt)
      : NaN;
    const updatedMs = Date.parse(job.updatedAt);

    // LEASE_EXPIRED: LEASED with a lease that has lapsed and stayed lapsed.
    if (job.state === "LEASED" && !Number.isNaN(leaseExpiryMs)) {
      const expiredForMs = input.nowMs - leaseExpiryMs;
      if (expiredForMs > thresholds.leaseExpiredAfterMs) {
        findings.push({
          jobId: job.jobId,
          stuckClass: "LEASE_EXPIRED",
          reason: `lease expired ${Math.round(expiredForMs / 1000)}s ago and was not renewed.`,
          proposedRecovery: "REVALIDATE",
        });
        continue;
      }
    }

    // WORKER_DEAD: LEASED to a worker whose liveness is DEAD/STALE.
    if (job.state === "LEASED" && job.leaseOwnerInstanceId) {
      const owner = input.workers.find(
        w => w.workerInstanceId === job.leaseOwnerInstanceId
      );
      if (!owner) {
        findings.push({
          jobId: job.jobId,
          stuckClass: "WORKER_DEAD",
          reason: "lease owner missing",
          proposedRecovery: "REVALIDATE",
        });
        continue;
      }
      if (owner) {
        const lv = evaluateWorkerLiveness({
          worker: owner,
          allWorkers: input.workers,
          thresholds: input.livenessThresholds,
          nowMs: input.nowMs,
        });
        if (!["HEALTHY", "LATE"].includes(lv.classification)) {
          findings.push({
            jobId: job.jobId,
            stuckClass: "WORKER_DEAD",
            reason: `lease owner ${owner.workerId} is ${lv.classification}.`,
            proposedRecovery: "REVALIDATE",
          });
          continue;
        }
      }
    }

    // PROVIDER_PENDING: awaiting an external result beyond the threshold.
    if (
      (job.resultStatus === "PENDING_EXTERNAL" ||
        (job.uncertaintyClass !== "NONE" && job.uncertaintyClass !== "")) &&
      RUNTIME_UNCERTAINTY_CLASSES.includes(job.uncertaintyClass as never) &&
      job.uncertaintyClass !== "NONE"
    ) {
      if (
        !Number.isNaN(updatedMs) &&
        input.nowMs - updatedMs > thresholds.providerPendingAfterMs
      ) {
        findings.push({
          jobId: job.jobId,
          stuckClass: "PROVIDER_PENDING",
          reason: `provider/callback unresolved for ${Math.round((input.nowMs - updatedMs) / 1000)}s.`,
          proposedRecovery: "REQUEST_HUMAN_REVIEW",
        });
        continue;
      }
    }

    // CALLBACK_MISSING: still PENDING_EXTERNAL with no forward progress.
    if (job.resultStatus === "PENDING_EXTERNAL" && !Number.isNaN(updatedMs)) {
      if (input.nowMs - updatedMs > thresholds.providerPendingAfterMs) {
        findings.push({
          jobId: job.jobId,
          stuckClass: "CALLBACK_MISSING",
          reason: "callback missing beyond threshold.",
          proposedRecovery: "ESCALATE",
        });
        continue;
      }
    }

    // STATE_UNCHANGED: not terminal, but no forward progress for a long time.
    if (
      job.state !== "COMPLETED" &&
      job.state !== "DEAD_LETTERED" &&
      job.state !== "CANCELLED"
    ) {
      if (
        !Number.isNaN(updatedMs) &&
        input.nowMs - updatedMs > thresholds.unchangedAfterMs
      ) {
        findings.push({
          jobId: job.jobId,
          stuckClass: "STATE_UNCHANGED",
          reason: "no state progress beyond threshold.",
          proposedRecovery: "REVALIDATE",
        });
      }
    }
  }

  return findings;
}
