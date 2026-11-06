// ─── R10-E Observability — incident model (E3/E15) ───
//
// PURE deterministic incident classification and lifecycle rules. Incident
// identity is deterministic (inc1:); duplicate detection converges to the
// open incident. Lifecycle transitions are validated here; only the service
// layer may persist them, and SUPPRESSED requires explicit authority and can
// never apply to critical incidents. Agents can never hide an incident.

import { INCIDENT_STATUSES, ObservabilityInputError } from "./observability-contract";
import type { DiagnosticCode, IncidentStatus, ObservabilitySeverity } from "./observability-contract";

// ─── Failure classes (closed) ───

export const INCIDENT_FAILURE_CLASSES = [
  "API_UNAVAILABLE",
  "API_LATENCY_DEGRADED",
  "DB_UNAVAILABLE",
  "DB_DEGRADED",
  "DB_CONFLICT_ELEVATED",
  "WORKER_OFFLINE",
  "WORKER_CRASH_LOOP",
  "WORKER_STALE_HEARTBEAT",
  "SCHEDULER_STALE_HEARTBEAT",
  "QUEUE_BACKLOG_HIGH",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_AUTH_FAILURE",
  "PROVIDER_RATE_LIMITED",
  "CALLBACK_FAILURES",
  "EXECUTION_UNCERTAINTY",
  "MISSION_BLOCKAGE",
  "GOVERNANCE_BACKLOG",
  "RECOVERY_BACKLOG",
  "SECURITY_CRITICAL_SIGNAL",
  "BACKUP_FAILURE",
  "BACKUP_STALE",
  "UNKNOWN_FAILURE",
] as const;
export type IncidentFailureClass = (typeof INCIDENT_FAILURE_CLASSES)[number];

/** Deterministic diagnostic-code → failure-class mapping. */
export function classifyFailureClass(diagnosticCode: DiagnosticCode): IncidentFailureClass {
  switch (diagnosticCode) {
    case "DB_CONNECTIVITY_FAILURE":
      return "DB_UNAVAILABLE";
    case "DB_POOL_SATURATION":
    case "DB_TRANSACTION_FAILURE":
      return "DB_DEGRADED";
    case "DB_DEADLOCK":
    case "DB_CAS_CONFLICT":
    case "DB_REPLAY_COLLISION":
      return "DB_CONFLICT_ELEVATED";
    case "WORKER_OFFLINE":
      return "WORKER_OFFLINE";
    case "WORKER_CRASH_LOOP":
      return "WORKER_CRASH_LOOP";
    case "WORKER_HEARTBEAT_STALE":
    case "SCHEDULER_HEARTBEAT_STALE":
      return "WORKER_STALE_HEARTBEAT";
    case "QUEUE_BACKLOG_HIGH":
    case "RETRY_STORM":
    case "DEAD_LETTER_GROWTH":
      return "QUEUE_BACKLOG_HIGH";
    case "PROVIDER_TIMEOUT":
    case "PROVIDER_5XX":
      return "PROVIDER_UNAVAILABLE";
    case "PROVIDER_AUTH_FAILURE":
      return "PROVIDER_AUTH_FAILURE";
    case "PROVIDER_RATE_LIMITED":
      return "PROVIDER_RATE_LIMITED";
    case "CALLBACK_DELAY_HIGH":
    case "RECONCILIATION_BACKLOG_HIGH":
      return "CALLBACK_FAILURES";
    case "EXECUTION_UNCERTAIN":
      return "EXECUTION_UNCERTAINTY";
    case "MISSION_BLOCKED":
    case "STALE_SCHEDULE":
      return "MISSION_BLOCKAGE";
    case "GOVERNANCE_REVIEW_BACKLOG":
    case "APPROVAL_BACKLOG_HIGH":
      return "GOVERNANCE_BACKLOG";
    case "RECOVERY_BACKLOG_HIGH":
    case "STALE_RECOVERY":
      return "RECOVERY_BACKLOG";
    case "AUTH_FAILURE":
    case "AUTHORIZATION_FAILURE":
    case "CROSS_TENANT_ATTEMPT":
    case "CROSS_BUSINESS_ATTEMPT":
    case "PROMPT_INJECTION_DETECTED":
    case "TOOL_POLICY_REJECTION":
    case "SECRET_SHAPED_PAYLOAD_REJECTED":
    case "APPROVAL_FORGERY_ATTEMPT":
    case "CALLBACK_FORGERY_ATTEMPT":
    case "PRIVILEGE_ESCALATION_ATTEMPT":
      return "SECURITY_CRITICAL_SIGNAL";
    case "BACKUP_JOB_FAILURE":
    case "BACKUP_VERIFICATION_FAILED":
      return "BACKUP_FAILURE";
    case "BACKUP_STALE":
    case "BACKUP_OFFSITE_COPY_MISSING":
    case "RESTORE_REHEARSAL_STALE":
    case "RETENTION_HEALTH_DEGRADED":
      return "BACKUP_STALE";
    case "WORKER_VERSION_DRIFT":
    case "JOB_LEASE_STALE":
    case "JOB_STUCK":
      return "WORKER_STALE_HEARTBEAT";
    case "DB_SCHEMA_VERSION_UNKNOWN":
      return "DB_DEGRADED";
    case "OK":
    case "UNKNOWN":
    default:
      return "UNKNOWN_FAILURE";
  }
}

/** Deterministic failure-class → severity mapping (E4: rules, not judgement). */
export function classifyIncidentSeverity(failureClass: IncidentFailureClass): ObservabilitySeverity {
  switch (failureClass) {
    case "API_UNAVAILABLE":
    case "DB_UNAVAILABLE":
    case "WORKER_OFFLINE":
    case "PROVIDER_UNAVAILABLE":
    case "SECURITY_CRITICAL_SIGNAL":
    case "BACKUP_FAILURE":
      return "CRITICAL";
    case "WORKER_CRASH_LOOP":
    case "PROVIDER_AUTH_FAILURE":
    case "CALLBACK_FAILURES":
    case "MISSION_BLOCKAGE":
    case "DB_CONFLICT_ELEVATED":
      return "HIGH";
    case "PROVIDER_RATE_LIMITED":
    case "QUEUE_BACKLOG_HIGH":
    case "GOVERNANCE_BACKLOG":
    case "RECOVERY_BACKLOG":
    case "BACKUP_STALE":
    case "EXECUTION_UNCERTAINTY":
      return "WARNING";
    case "API_LATENCY_DEGRADED":
    case "DB_DEGRADED":
    case "WORKER_STALE_HEARTBEAT":
    case "SCHEDULER_STALE_HEARTBEAT":
    default:
      return "WARNING";
  }
}

// ─── Lifecycle rules ───

/** Allowed transitions. Re-detection reopens terminal incidents honestly. */
const TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  OPEN: ["INVESTIGATING", "MITIGATING", "MONITORING", "RESOLVED"],
  INVESTIGATING: ["MITIGATING", "MONITORING", "RESOLVED"],
  MITIGATING: ["MONITORING", "RESOLVED"],
  MONITORING: ["MITIGATING", "RESOLVED"],
  RESOLVED: ["CLOSED", "OPEN"],
  CLOSED: ["OPEN"],
  SUPPRESSED: ["OPEN", "INVESTIGATING"],
};

export function assertIncidentTransition(from: IncidentStatus, to: IncidentStatus): void {
  if (!(INCIDENT_STATUSES as readonly string[]).includes(to)) {
    throw new ObservabilityInputError("OBSERVABILITY_INCIDENT_TRANSITION_INVALID", `unknown incident status ${JSON.stringify(to)}.`);
  }
  if (from === to) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INCIDENT_TRANSITION_INVALID",
      `incident is already ${from}; self-transitions are not permitted.`
    );
  }
  if (!TRANSITIONS[from].includes(to)) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INCIDENT_TRANSITION_INVALID",
      `incident transition ${from} -> ${to} is not permitted.`
    );
  }
}

/**
 * SUPPRESSED is only reachable through an explicit authority-bearing operator
 * command, never through the normal transition set. Critical-severity
 * incidents are never suppressible. Un-suppressing returns to OPEN.
 */
export function assertIncidentSuppressible(severity: ObservabilitySeverity): void {
  if (severity === "CRITICAL") {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INCIDENT_CRITICAL_NOT_SUPPRESSIBLE",
      "critical-severity incidents cannot be suppressed; they require resolution."
    );
  }
}

export function assertSuppressionAuthority(suppressionAuthority: string): void {
  const trimmed = suppressionAuthority.trim();
  if (trimmed.length === 0) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INCIDENT_SUPPRESSION_FORBIDDEN",
      "suppression requires an explicit operator/policy authority reference."
    );
  }
}

/** Safety-state derivation for an incident (E4: alerts describe safety state). */
export function deriveIncidentSafetyState(input: {
  readonly failureClass: IncidentFailureClass;
  readonly executionContinuing: boolean;
}): string {
  if (!input.executionContinuing) return "EXECUTION_SUSPENDED";
  switch (input.failureClass) {
    case "SECURITY_CRITICAL_SIGNAL":
      return "OPERATOR_ACTION_REQUIRED";
    case "MISSION_BLOCKAGE":
    case "GOVERNANCE_BACKLOG":
      return "AUTONOMY_DEGRADED";
    default:
      return "EXECUTION_CONTINUING";
  }
}

export function isTerminalIncidentStatus(status: IncidentStatus): boolean {
  return status === "CLOSED" || status === "RESOLVED";
}

export const INCIDENT_MODEL_DISCLAIMER =
  "incident suppression requires explicit operator/policy authority; agents can never hide an incident.";
