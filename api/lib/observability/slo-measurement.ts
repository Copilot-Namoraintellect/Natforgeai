// ─── R10-E Observability — SLO / service measurement foundation (E16) ───
//
// PURE deterministic indicators over typed measurement inputs. These are
// measurement foundations only — no contractual SLA is invented or claimed.
// Every indicator returns an explicit UNKNOWN basis when its numerator or
// denominator evidence is absent.

import { SLO_INDICATORS, ObservabilityInputError } from "./observability-contract";
import type { SloIndicator } from "./observability-contract";

export interface MeasurementBasis {
  readonly indicator: SloIndicator;
  /** 0..1 where measurable; null when evidence is absent. */
  readonly value: number | null;
  readonly unit: "ratio" | "milliseconds" | "count" | "seconds";
  readonly evidenceCount: number;
  readonly basis: "measured" | "insufficient_evidence" | "no_evidence";
}

function ratio(numerator: number, denominator: number, indicator: SloIndicator): MeasurementBasis {
  if (denominator <= 0) {
    return { indicator, value: null, unit: "ratio", evidenceCount: 0, basis: "no_evidence" };
  }
  if (numerator < 0) {
    throw new ObservabilityInputError("OBSERVABILITY_INVALID_INPUT", `${indicator} numerator must be >= 0.`);
  }
  return { indicator, value: numerator / denominator, unit: "ratio", evidenceCount: denominator, basis: "measured" };
}

function latency(valuesMs: readonly number[], indicator: SloIndicator): MeasurementBasis {
  if (valuesMs.length === 0) {
    return { indicator, value: null, unit: "milliseconds", evidenceCount: 0, basis: "no_evidence" };
  }
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  return { indicator, value: p50, unit: "milliseconds", evidenceCount: valuesMs.length, basis: "measured" };
}

function count(value: number, indicator: SloIndicator, unit: "count" | "seconds" | "milliseconds"): MeasurementBasis {
  if (value < 0) {
    throw new ObservabilityInputError("OBSERVABILITY_INVALID_INPUT", `${indicator} count must be >= 0.`);
  }
  return { indicator, value, unit, evidenceCount: 1, basis: "measured" };
}

/** API availability = successful requests / total requests. */
export function measureApiAvailability(input: {
  readonly totalRequests: number;
  readonly failedRequests: number;
}): MeasurementBasis {
  const succeeded = input.totalRequests - input.failedRequests;
  return ratio(succeeded, input.totalRequests, "api_availability");
}

export function measureApiLatency(samplesMs: readonly number[]): MeasurementBasis {
  return latency(samplesMs, "api_latency");
}

/** Worker heartbeat freshness = 1 when the newest heartbeat is within maxAgeMs. */
export function measureWorkerHeartbeatFreshness(input: {
  readonly lastHeartbeatAgeMs: number | null;
  readonly maxAgeMs: number;
}): MeasurementBasis {
  if (input.lastHeartbeatAgeMs === null) {
    return { indicator: "worker_heartbeat_freshness", value: null, unit: "ratio", evidenceCount: 0, basis: "no_evidence" };
  }
  const value = input.lastHeartbeatAgeMs <= input.maxAgeMs ? 1 : 0;
  return { indicator: "worker_heartbeat_freshness", value, unit: "ratio", evidenceCount: 1, basis: "measured" };
}

/** Queue lag = age of the oldest waiting job in ms. */
export function measureQueueLag(oldestWaitingJobAgeMs: number | null): MeasurementBasis {
  if (oldestWaitingJobAgeMs === null) {
    return { indicator: "queue_lag", value: null, unit: "milliseconds", evidenceCount: 0, basis: "no_evidence" };
  }
  return count(oldestWaitingJobAgeMs, "queue_lag", "milliseconds");
}

/** Execution uncertainty rate = uncertain results / classified results. */
export function measureExecutionUncertaintyRate(input: {
  readonly classifiedResults: number;
  readonly uncertainResults: number;
}): MeasurementBasis {
  return ratio(input.uncertainResults, input.classifiedResults, "execution_uncertainty_rate");
}

/** Provider timeout rate = timed-out requests / provider requests. */
export function measureProviderTimeoutRate(input: {
  readonly providerRequests: number;
  readonly timedOutRequests: number;
}): MeasurementBasis {
  return ratio(input.timedOutRequests, input.providerRequests, "provider_timeout_rate");
}

/** Callback delay = age of the oldest unprocessed callback in ms. */
export function measureCallbackDelay(oldestUnprocessedAgeMs: number | null): MeasurementBasis {
  if (oldestUnprocessedAgeMs === null) {
    return { indicator: "callback_delay", value: null, unit: "milliseconds", evidenceCount: 0, basis: "no_evidence" };
  }
  return count(oldestUnprocessedAgeMs, "callback_delay", "milliseconds");
}

export function measureDbLatency(samplesMs: readonly number[]): MeasurementBasis {
  return latency(samplesMs, "db_latency");
}

/** Deadlock rate = deadlock observations / transaction observations. */
export function measureDeadlockRate(input: {
  readonly transactionsObserved: number;
  readonly deadlocksObserved: number;
}): MeasurementBasis {
  return ratio(input.deadlocksObserved, input.transactionsObserved, "deadlock_rate");
}

/** Incident detection delay = seconds between occurrence and detection. */
export function measureIncidentDetectionDelay(delaysSeconds: readonly number[]): MeasurementBasis {
  if (delaysSeconds.length === 0) {
    return { indicator: "incident_detection_delay", value: null, unit: "seconds", evidenceCount: 0, basis: "no_evidence" };
  }
  const sorted = [...delaysSeconds].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  if (p50 < 0) {
    throw new ObservabilityInputError("OBSERVABILITY_INVALID_INPUT", "incident_detection_delay samples must be >= 0.");
  }
  return { indicator: "incident_detection_delay", value: p50, unit: "seconds", evidenceCount: delaysSeconds.length, basis: "measured" };
}

/** Recovery backlog = count of open recovery candidates. */
export function measureRecoveryBacklog(openCandidates: number | null): MeasurementBasis {
  if (openCandidates === null) {
    return { indicator: "recovery_backlog", value: null, unit: "count", evidenceCount: 0, basis: "no_evidence" };
  }
  return count(openCandidates, "recovery_backlog", "count");
}

/** Backup freshness = age of the last successful backup in seconds. */
export function measureBackupFreshness(lastSuccessfulBackupAgeMs: number | null): MeasurementBasis {
  if (lastSuccessfulBackupAgeMs === null) {
    return { indicator: "backup_freshness", value: null, unit: "seconds", evidenceCount: 0, basis: "no_evidence" };
  }
  return count(Math.floor(lastSuccessfulBackupAgeMs / 1000), "backup_freshness", "seconds");
}

export function emptyMeasurement(indicator: SloIndicator): MeasurementBasis {
  if (!(SLO_INDICATORS as readonly string[]).includes(indicator)) {
    throw new ObservabilityInputError("OBSERVABILITY_INVALID_INPUT", `unknown SLO indicator ${JSON.stringify(indicator)}.`);
  }
  return { indicator, value: null, unit: "count", evidenceCount: 0, basis: "no_evidence" };
}

export const SLO_DISCLAIMER =
  "SLO indicators are measurement foundations only; no contractual SLA is claimed.";
