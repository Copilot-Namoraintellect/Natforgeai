// ─── R10-E Observability — platform health model (E2/E15) ───
//
// PURE deterministic derivation. Health is derived from evidence — never set
// by client or model. Absence of telemetry means UNKNOWN, never HEALTHY.
// Every dimension derivation takes explicit evidence + clock + thresholds so
// the rules are reproducible and testable; nothing here reads the environment
// or the database.

import { HEALTH_DIMENSIONS, ObservabilityInputError } from "./observability-contract";
import type {
  HealthClass,
  HealthDimension,
  ProviderHealthClass,
} from "./observability-contract";
import { sha256Hex } from "./observability-identity";

export const OBSERVABILITY_HEALTH_DISCLAIMER_MODEL =
  "health is derived from evidence — never set; absence of telemetry means UNKNOWN, never HEALTHY.";

// ─── Thresholds (explicit, caller-overridable) ───

export interface HealthThresholds {
  /** Worker heartbeat older than this is stale. */
  readonly workerHeartbeatStaleMs: number;
  /** Scheduler heartbeat older than this is stale. */
  readonly schedulerHeartbeatStaleMs: number;
  /** API latency above this degrades the API dimension. */
  readonly apiLatencyDegradedMs: number;
  /** API latency above this makes the API dimension AT_RISK. */
  readonly apiLatencyAtRiskMs: number;
  /** DB latency above this degrades the database dimension. */
  readonly dbLatencyDegradedMs: number;
  /** DB pool utilization above this degrades the database dimension. */
  readonly dbPoolUtilizationDegradedPct: number;
  /** Queue backlog above this degrades the queue dimension. */
  readonly queueBacklogDegradedCount: number;
  /** Callback processing delay above this degrades the callback dimension. */
  readonly callbackDelayDegradedMs: number;
  /** Recovery candidates older than this make the backlog AT_RISK. */
  readonly recoveryBacklogAtRiskAgeMs: number;
  /** Backup age above this makes backup freshness DEGRADED. */
  readonly backupAgeDegradedMs: number;
  /** Backup age above this makes backup freshness AT_RISK. */
  readonly backupAgeAtRiskMs: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = Object.freeze({
  workerHeartbeatStaleMs: 120_000,
  schedulerHeartbeatStaleMs: 300_000,
  apiLatencyDegradedMs: 1_000,
  apiLatencyAtRiskMs: 5_000,
  dbLatencyDegradedMs: 500,
  dbPoolUtilizationDegradedPct: 80,
  queueBacklogDegradedCount: 100,
  callbackDelayDegradedMs: 300_000,
  recoveryBacklogAtRiskAgeMs: 3_600_000,
  backupAgeDegradedMs: 86_400_000,
  backupAgeAtRiskMs: 604_800_000,
});

// ─── Evidence shapes per dimension ───

/** null = telemetry absent (⇒ UNKNOWN). boolean signals default false. */
export interface ApiHealthEvidence {
  readonly requestsObserved: boolean | null;
  readonly errorRatePct: number | null;
  readonly p50LatencyMs: number | null;
}

export interface DatabaseHealthEvidence {
  readonly connectivityObserved: boolean | null;
  readonly poolUtilizationPct: number | null;
  readonly p50LatencyMs: number | null;
  readonly deadlockCount: number | null;
  readonly transactionFailureCount: number | null;
  readonly casConflictCount: number | null;
  readonly replayCollisionCount: number | null;
  readonly schemaVersionKnown: boolean | null;
}

export interface WorkerHealthEvidence {
  readonly heartbeatObserved: boolean | null;
  readonly lastHeartbeatAgeMs: number | null;
  readonly leaseStale: boolean;
  readonly jobStuck: boolean;
  readonly crashLoop: boolean;
  readonly retryStorm: boolean;
  readonly deadLetterGrowth: boolean;
  readonly queueBacklogHigh: boolean;
  readonly versionDrift: boolean;
}

export interface SchedulerHealthEvidence {
  readonly heartbeatObserved: boolean | null;
  readonly lastHeartbeatAgeMs: number | null;
}

export interface QueueHealthEvidence {
  readonly backlogObserved: boolean | null;
  readonly waitingCount: number | null;
}

export interface MissionControlHealthEvidence {
  readonly telemetryObserved: boolean | null;
  readonly blockedMissions: number;
  readonly uncertainActions: number;
  readonly failedActions: number;
  readonly pendingExternalResults: number;
  readonly governanceBlocks: number;
  readonly approvalBacklog: number;
  readonly staleSchedules: number;
  readonly staleRecoveries: number;
}

export interface CallbackHealthEvidence {
  readonly telemetryObserved: boolean | null;
  readonly oldestUnprocessedAgeMs: number | null;
  readonly reconciliationBacklog: number | null;
}

export interface RecoveryBacklogEvidence {
  readonly telemetryObserved: boolean | null;
  readonly openCandidateCount: number | null;
  readonly oldestCandidateAgeMs: number | null;
}

export interface BackupHealthEvidence {
  readonly signalObserved: boolean | null;
  readonly lastBackupAgeMs: number | null;
  readonly lastBackupSucceeded: boolean | null;
  readonly verificationFailed: boolean | null;
  readonly offsiteCopyMissing: boolean | null;
  readonly restoreRehearsalAgeMs: number | null;
  readonly retentionDegraded: boolean;
}

export interface SecurityControlsEvidence {
  readonly telemetryObserved: boolean | null;
  /** Critical-class security signals in the window (forgery/injection/escalation). */
  readonly criticalSignalCount: number;
  /** High-class security signals in the window. */
  readonly highSignalCount: number;
}

export interface DeploymentVersionEvidence {
  readonly releaseVersionKnown: boolean | null;
}

// ─── Worst-of core ───

const RANK: Record<HealthClass, number> = {
  HEALTHY: 0,
  DEGRADED: 1,
  AT_RISK: 2,
  UNAVAILABLE: 3,
  UNKNOWN: -1,
};

export function worstHealth(classes: readonly HealthClass[]): HealthClass {
  let worst: HealthClass = "HEALTHY";
  let anyUnknown = false;
  for (const cls of classes) {
    if (cls === "UNKNOWN") {
      anyUnknown = true;
      continue;
    }
    if (RANK[cls] > RANK[worst]) worst = cls;
  }
  // UNKNOWN only surfaces when nothing worse is known — it never masks a
  // DEGRADED/AT_RISK/UNAVAILABLE signal.
  return anyUnknown && worst === "HEALTHY" ? "UNKNOWN" : worst;
}

// ─── Dimension derivations ───

export function deriveApiHealth(ev: ApiHealthEvidence, t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS): HealthClass {
  if (ev.requestsObserved === null || ev.requestsObserved === false) return "UNKNOWN";
  const classes: HealthClass[] = ["HEALTHY"];
  if (ev.errorRatePct !== null && ev.errorRatePct >= 25) classes.push("UNAVAILABLE");
  else if (ev.errorRatePct !== null && ev.errorRatePct >= 5) classes.push("AT_RISK");
  if (ev.p50LatencyMs !== null && ev.p50LatencyMs >= t.apiLatencyAtRiskMs) classes.push("AT_RISK");
  else if (ev.p50LatencyMs !== null && ev.p50LatencyMs >= t.apiLatencyDegradedMs) classes.push("DEGRADED");
  return worstHealth(classes);
}

export function deriveDatabaseHealth(
  ev: DatabaseHealthEvidence,
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS
): HealthClass {
  if (ev.connectivityObserved === null) return "UNKNOWN"; // DB telemetry absent ⇒ UNKNOWN (E15)
  if (ev.connectivityObserved === false) return "UNAVAILABLE";
  const classes: HealthClass[] = ["HEALTHY"];
  if (ev.poolUtilizationPct !== null && ev.poolUtilizationPct >= t.dbPoolUtilizationDegradedPct) classes.push("DEGRADED");
  if (ev.p50LatencyMs !== null && ev.p50LatencyMs >= t.dbLatencyDegradedMs) classes.push("DEGRADED");
  if (ev.deadlockCount !== null && ev.deadlockCount > 0) classes.push("AT_RISK");
  if (ev.transactionFailureCount !== null && ev.transactionFailureCount > 0) classes.push("DEGRADED");
  if (ev.casConflictCount !== null && ev.casConflictCount > 0) classes.push("DEGRADED");
  if (ev.replayCollisionCount !== null && ev.replayCollisionCount > 0) classes.push("AT_RISK");
  if (ev.schemaVersionKnown === false) classes.push("DEGRADED"); // version unknown degrades, never silently healthy
  return worstHealth(classes);
}

export function deriveWorkerHealth(
  ev: WorkerHealthEvidence,
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS
): HealthClass {
  if (ev.heartbeatObserved === null) return "UNKNOWN";
  if (ev.heartbeatObserved === false) return "UNAVAILABLE";
  if (ev.lastHeartbeatAgeMs !== null && ev.lastHeartbeatAgeMs > t.workerHeartbeatStaleMs) {
    // Stale heartbeat: degraded/unavailable — never HEALTHY (E15)
    return ev.lastHeartbeatAgeMs > t.workerHeartbeatStaleMs * 5 ? "UNAVAILABLE" : "DEGRADED";
  }
  const classes: HealthClass[] = ["HEALTHY"];
  if (ev.leaseStale) classes.push("DEGRADED");
  if (ev.jobStuck) classes.push("DEGRADED");
  if (ev.versionDrift) classes.push("DEGRADED");
  if (ev.deadLetterGrowth) classes.push("AT_RISK");
  if (ev.retryStorm) classes.push("AT_RISK");
  if (ev.queueBacklogHigh) classes.push("DEGRADED");
  if (ev.crashLoop) classes.push("UNAVAILABLE");
  return worstHealth(classes);
}

export function deriveSchedulerHealth(
  ev: SchedulerHealthEvidence,
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS
): HealthClass {
  if (ev.heartbeatObserved === null) return "UNKNOWN";
  if (ev.heartbeatObserved === false) return "UNAVAILABLE";
  if (ev.lastHeartbeatAgeMs !== null && ev.lastHeartbeatAgeMs > t.schedulerHeartbeatStaleMs) return "DEGRADED";
  return "HEALTHY";
}

export function deriveQueueHealth(
  ev: QueueHealthEvidence,
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS
): HealthClass {
  if (ev.backlogObserved === null || ev.waitingCount === null) return "UNKNOWN";
  return ev.waitingCount >= t.queueBacklogDegradedCount ? "DEGRADED" : "HEALTHY";
}

export function deriveMissionControlHealth(
  ev: MissionControlHealthEvidence
): HealthClass {
  if (ev.telemetryObserved === null || ev.telemetryObserved === false) return "UNKNOWN";
  const classes: HealthClass[] = ["HEALTHY"];
  if (ev.blockedMissions > 0) classes.push("AT_RISK");
  if (ev.uncertainActions > 0) classes.push("DEGRADED");
  if (ev.failedActions > 0) classes.push("DEGRADED");
  if (ev.pendingExternalResults > 0) classes.push("DEGRADED");
  if (ev.governanceBlocks > 0) classes.push("DEGRADED");
  if (ev.approvalBacklog > 0) classes.push("DEGRADED");
  if (ev.staleSchedules > 0) classes.push("DEGRADED");
  if (ev.staleRecoveries > 0) classes.push("DEGRADED");
  return worstHealth(classes);
}

export function deriveCallbackHealth(
  ev: CallbackHealthEvidence,
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS
): HealthClass {
  if (ev.telemetryObserved === null || ev.telemetryObserved === false) return "UNKNOWN";
  const classes: HealthClass[] = ["HEALTHY"];
  if (ev.oldestUnprocessedAgeMs !== null && ev.oldestUnprocessedAgeMs >= t.callbackDelayDegradedMs) classes.push("DEGRADED");
  if (ev.reconciliationBacklog !== null && ev.reconciliationBacklog >= t.queueBacklogDegradedCount) classes.push("DEGRADED");
  return worstHealth(classes);
}

export function deriveRecoveryBacklogHealth(
  ev: RecoveryBacklogEvidence,
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS
): HealthClass {
  if (ev.telemetryObserved === null) return "UNKNOWN";
  if (ev.openCandidateCount === null) return "UNKNOWN";
  if (ev.openCandidateCount === 0) return "HEALTHY";
  if (ev.oldestCandidateAgeMs !== null && ev.oldestCandidateAgeMs >= t.recoveryBacklogAtRiskAgeMs) return "AT_RISK";
  return "DEGRADED";
}

export function deriveBackupHealth(
  ev: BackupHealthEvidence,
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS
): HealthClass {
  // Backup signal unavailable ⇒ UNKNOWN — never claim backup healthy (E15)
  if (ev.signalObserved === null || ev.signalObserved === false) return "UNKNOWN";
  const classes: HealthClass[] = ["HEALTHY"];
  if (ev.lastBackupSucceeded === false) classes.push("UNAVAILABLE");
  if (ev.verificationFailed === true) classes.push("AT_RISK");
  if (ev.offsiteCopyMissing === true) classes.push("AT_RISK");
  if (ev.retentionDegraded) classes.push("DEGRADED");
  if (ev.lastBackupAgeMs !== null) {
    if (ev.lastBackupAgeMs >= t.backupAgeAtRiskMs) classes.push("AT_RISK");
    else if (ev.lastBackupAgeMs >= t.backupAgeDegradedMs) classes.push("DEGRADED");
  } else {
    classes.push("UNKNOWN");
  }
  if (ev.restoreRehearsalAgeMs !== null && ev.restoreRehearsalAgeMs >= t.backupAgeAtRiskMs) classes.push("DEGRADED");
  return worstHealth(classes);
}

export function deriveSecurityControlsHealth(ev: SecurityControlsEvidence): HealthClass {
  // Security telemetry unavailable ⇒ never silently claim secure (E15)
  if (ev.telemetryObserved === null || ev.telemetryObserved === false) return "UNKNOWN";
  if (ev.criticalSignalCount > 0) return "AT_RISK";
  if (ev.highSignalCount > 0) return "DEGRADED";
  return "HEALTHY";
}

export function deriveDeploymentVersionHealth(ev: DeploymentVersionEvidence): HealthClass {
  return ev.releaseVersionKnown === true ? "HEALTHY" : "UNKNOWN";
}

// ─── Provider health (E9) — its own five-class vocabulary ───

export interface ProviderHealthEvidence {
  readonly telemetryObserved: boolean | null;
  readonly authFailureObserved: boolean;
  readonly rateLimitObserved: boolean;
  readonly unavailableObserved: boolean;
  readonly timeoutRatePct: number | null;
}

export function deriveProviderHealth(
  ev: ProviderHealthEvidence
): { health: ProviderHealthClass; platformEquivalent: HealthClass } {
  if (ev.telemetryObserved === null || ev.telemetryObserved === false) {
    return { health: "UNKNOWN", platformEquivalent: "UNKNOWN" };
  }
  let health: ProviderHealthClass;
  if (ev.authFailureObserved || ev.unavailableObserved) health = "UNAVAILABLE";
  else if (ev.rateLimitObserved) health = "RATE_LIMITED";
  else if (ev.timeoutRatePct !== null && ev.timeoutRatePct >= 10) health = "DEGRADED";
  else health = "AVAILABLE";
  // Provider health never authorizes switching provider/account — the mapping
  // below feeds the platform aggregate only; no switching logic exists here.
  const platformEquivalent: HealthClass =
    health === "AVAILABLE" ? "HEALTHY" : health === "UNAVAILABLE" ? "UNAVAILABLE" : "DEGRADED";
  return { health, platformEquivalent };
}

// ─── Platform aggregation ───

export interface DimensionHealth {
  readonly dimension: HealthDimension;
  readonly health: HealthClass;
  readonly basis: string;
}

export interface PlatformHealth {
  readonly platformHealth: HealthClass;
  readonly dimensions: Record<HealthDimension, DimensionHealth>;
  /** Dimensions whose evidence was absent — explicit, never silently skipped. */
  readonly unknownDimensions: readonly HealthDimension[];
}

/**
 * Worst-of aggregation over dimension health. UNKNOWN evidence degrades the
 * aggregate to at most DEGRADED and lists the dimension explicitly — the
 * platform is never claimed HEALTHY on missing evidence.
 */
export function derivePlatformHealth(dimensions: Readonly<Partial<Record<HealthDimension, DimensionHealth>>>): PlatformHealth {
  const full = {} as Record<HealthDimension, DimensionHealth>;
  const unknownDimensions: HealthDimension[] = [];
  for (const dimension of HEALTH_DIMENSIONS) {
    const entry = dimensions[dimension];
    if (!entry) {
      full[dimension] = { dimension, health: "UNKNOWN", basis: "no evidence provider bound" };
      unknownDimensions.push(dimension);
    } else {
      full[dimension] = entry;
      if (entry.health === "UNKNOWN") unknownDimensions.push(dimension);
    }
  }
  const classes = Object.values(full).map((d) => d.health);
  const worst = worstHealth(classes);
  // UNKNOWN caps the aggregate at DEGRADED: missing evidence can never produce
  // a clean HEALTHY, but it also cannot prove the platform is worse than that.
  const platformHealth: HealthClass = worst === "UNKNOWN" ? "DEGRADED" : worst;
  return { platformHealth, dimensions: full, unknownDimensions: Object.freeze(unknownDimensions) as readonly HealthDimension[] };
}

/** Deterministic evidence hash for a health observation core. */
export function hashHealthEvidence(evidence: Record<string, unknown>): string {
  return sha256Hex(JSON.stringify(evidence));
}

export function assertHealthClass(value: string): HealthClass {
  if (!["HEALTHY", "DEGRADED", "AT_RISK", "UNAVAILABLE", "UNKNOWN"].includes(value)) {
    throw new ObservabilityInputError("OBSERVABILITY_INVALID_INPUT", `unknown health class ${JSON.stringify(value)}`);
  }
  return value as HealthClass;
}
