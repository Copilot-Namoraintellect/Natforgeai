// ─── R10-E Observability, Operations & Incident Control — canonical contract ───
//
// PURE contract module: closed vocabularies, version identities, identity
// patterns, typed error taxonomy, zod router-input schemas and
// client-authority rejection for the production-observability capability
// (docs/contracts/production-observability-contract.md).
// No I/O of any kind; authorizes nothing; executes nothing; invokes nothing.
//
// Core principles (verbatim on every surface):
//   observability != authority
//   health is derived from evidence — never set
//   absence of telemetry means UNKNOWN, never HEALTHY
//   deduplication compresses presentation, never deletes evidence
//   provider health never authorizes switching provider or account
//
// z.strictObject everywhere: clients name bounded material only — never
// eventId, identity, health, incident state, alert state, severity outcomes,
// suppression authority or any execution/recovery/governance authority field.

import { z } from "zod";

// ─── Versions ───

export const OBSERVABILITY_CONTRACT_VERSION = "production-observability/v1" as const;
export const OBSERVABILITY_ENGINE_VERSION = "production-observability-engine/v1" as const;

/** Verbatim disclaimers preserved on every surface. */
export const OBSERVABILITY_AUTHORITY_DISCLAIMER =
  "observability != authority. Monitoring observes, classifies, alerts, correlates and " +
  "recommends operator attention — it never authorizes execution, approves recovery, changes " +
  "autonomy, changes policy, changes mission scope, changes provider, changes credentials, " +
  "rewrites history, hides uncertainty or suppresses audit.";

export const OBSERVABILITY_HEALTH_DISCLAIMER =
  "health is derived from evidence — never set. Absence of telemetry means UNKNOWN, never " +
  "HEALTHY. Uncertainty is reported as UNCERTAIN, never converted to success.";

export const OBSERVABILITY_DEDUP_DISCLAIMER =
  "deduplication compresses presentation, never deletes evidence. Every operational event is " +
  "preserved in the append-only event store.";

export const OBSERVABILITY_PROVIDER_DISCLAIMER =
  "provider health never authorizes switching provider or account; that decision remains " +
  "governed elsewhere.";

// ─── Identity patterns ───

export const OPERATIONAL_EVENT_ID_PATTERN = /^evt1:[a-f0-9]{64}$/;
export const INCIDENT_ID_PATTERN = /^inc1:[a-f0-9]{64}$/;
export const INCIDENT_LIFECYCLE_ID_PATTERN = /^icl1:[a-f0-9]{64}$/;
export const ALERT_ID_PATTERN = /^alt1:[a-f0-9]{64}$/;
export const HEALTH_OBSERVATION_ID_PATTERN = /^hlt1:[a-f0-9]{64}$/;
export const HEX_64_PATTERN = /^[a-f0-9]{64}$/;
export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export const MAX_SAFE_METADATA_DEPTH = 6;
export const MAX_SAFE_METADATA_KEYS = 32;
export const MAX_EVIDENCE_REFS = 25;
export const MAX_TIMELINE_EVENTS = 500;
export const MAX_ALERTS_RETURNED = 200;
export const MAX_INCIDENTS_RETURNED = 200;
export const MAX_REASON_LENGTH = 320;
export const MAX_SUPPRESSION_AUTHORITY_LENGTH = 160;
export const MAX_TITLE_LENGTH = 160;
export const MAX_SUMMARY_LENGTH = 512;

export function isIsoUtc(value: string): boolean {
  return ISO_UTC_PATTERN.test(value);
}

// ─── Closed vocabularies (contract §3) ───

export const OPERATIONAL_EVENT_TYPES = [
  "api_health_observed",
  "database_health_observed",
  "worker_heartbeat_observed",
  "worker_crash_observed",
  "queue_backlog_observed",
  "scheduler_heartbeat_observed",
  "provider_request_observed",
  "provider_auth_failure_observed",
  "provider_rate_limit_observed",
  "callback_processing_observed",
  "execution_uncertain_observed",
  "mission_blocked_observed",
  "governance_backlog_observed",
  "recovery_backlog_observed",
  "security_signal_observed",
  "backup_signal_observed",
  "incident_detected",
  "incident_lifecycle_observed",
  "alert_raised",
  "alert_deduplicated",
  "slo_measurement_observed",
] as const;
export type OperationalEventType = (typeof OPERATIONAL_EVENT_TYPES)[number];

export const OBSERVABILITY_SERVICES = [
  "api",
  "database",
  "worker",
  "scheduler",
  "queue",
  "mission_control",
  "provider",
  "callback",
  "recovery",
  "security",
  "backup",
  "platform",
] as const;
export type ObservabilityService = (typeof OBSERVABILITY_SERVICES)[number];

export const OBSERVABILITY_PROVIDERS = [
  "openai",
  "meta",
  "linkedin",
  "stripe",
  "paypal",
  "smtp",
  "firebase",
  "aws_s3",
  "internal",
] as const;
export type ObservabilityProvider = (typeof OBSERVABILITY_PROVIDERS)[number];

export const DIAGNOSTIC_CODES = [
  "OK",
  "DB_CONNECTIVITY_FAILURE",
  "DB_POOL_SATURATION",
  "DB_DEADLOCK",
  "DB_TRANSACTION_FAILURE",
  "DB_CAS_CONFLICT",
  "DB_REPLAY_COLLISION",
  "DB_SCHEMA_VERSION_UNKNOWN",
  "WORKER_OFFLINE",
  "WORKER_HEARTBEAT_STALE",
  "WORKER_CRASH_LOOP",
  "WORKER_VERSION_DRIFT",
  "JOB_LEASE_STALE",
  "JOB_STUCK",
  "RETRY_STORM",
  "DEAD_LETTER_GROWTH",
  "QUEUE_BACKLOG_HIGH",
  "SCHEDULER_HEARTBEAT_STALE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_5XX",
  "PROVIDER_4XX",
  "PROVIDER_AUTH_FAILURE",
  "PROVIDER_RATE_LIMITED",
  "CALLBACK_DELAY_HIGH",
  "RECONCILIATION_BACKLOG_HIGH",
  "EXECUTION_UNCERTAIN",
  "MISSION_BLOCKED",
  "GOVERNANCE_REVIEW_BACKLOG",
  "APPROVAL_BACKLOG_HIGH",
  "RECOVERY_BACKLOG_HIGH",
  "STALE_SCHEDULE",
  "STALE_RECOVERY",
  "AUTH_FAILURE",
  "AUTHORIZATION_FAILURE",
  "CROSS_TENANT_ATTEMPT",
  "CROSS_BUSINESS_ATTEMPT",
  "PROMPT_INJECTION_DETECTED",
  "TOOL_POLICY_REJECTION",
  "SECRET_SHAPED_PAYLOAD_REJECTED",
  "APPROVAL_FORGERY_ATTEMPT",
  "CALLBACK_FORGERY_ATTEMPT",
  "PRIVILEGE_ESCALATION_ATTEMPT",
  "BACKUP_JOB_FAILURE",
  "BACKUP_STALE",
  "BACKUP_VERIFICATION_FAILED",
  "BACKUP_OFFSITE_COPY_MISSING",
  "RESTORE_REHEARSAL_STALE",
  "RETENTION_HEALTH_DEGRADED",
  "UNKNOWN",
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export const OBSERVABILITY_SEVERITIES = ["INFO", "WARNING", "HIGH", "CRITICAL"] as const;
export type ObservabilitySeverity = (typeof OBSERVABILITY_SEVERITIES)[number];

export const OBSERVABILITY_STATUSES = ["SUCCEEDED", "FAILED", "UNCERTAIN", "PENDING_EXTERNAL"] as const;
export type ObservabilityStatus = (typeof OBSERVABILITY_STATUSES)[number];

export const OBSERVABILITY_ENVIRONMENTS = ["development", "staging", "production"] as const;
export type ObservabilityEnvironment = (typeof OBSERVABILITY_ENVIRONMENTS)[number];

/** Platform health classes (contract §4). */
export const HEALTH_CLASSES = ["HEALTHY", "DEGRADED", "AT_RISK", "UNAVAILABLE", "UNKNOWN"] as const;
export type HealthClass = (typeof HEALTH_CLASSES)[number];

/** Health dimensions (contract §4). */
export const HEALTH_DIMENSIONS = [
  "api",
  "database",
  "workers",
  "scheduler",
  "queue",
  "mission_control",
  "providers",
  "callback_processing",
  "recovery_backlog",
  "backup_freshness",
  "security_controls",
  "deployment_version",
] as const;
export type HealthDimension = (typeof HEALTH_DIMENSIONS)[number];

/** Incident lifecycle (contract §5). SUPPRESSED is authority-gated. */
export const INCIDENT_STATUSES = [
  "OPEN",
  "INVESTIGATING",
  "MITIGATING",
  "MONITORING",
  "RESOLVED",
  "CLOSED",
  "SUPPRESSED",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_SCOPES = ["PLATFORM", "TENANT", "BUSINESS"] as const;
export type IncidentScope = (typeof INCIDENT_SCOPES)[number];

/** Safety-state labels carried on incidents/alerts (what is the current safety state). */
export const SAFETY_STATES = [
  "EXECUTION_CONTINUING",
  "EXECUTION_SUSPENDED",
  "AUTONOMY_DEGRADED",
  "OPERATOR_ACTION_REQUIRED",
  "NO_IMPACT_OBSERVED",
] as const;
export type SafetyState = (typeof SAFETY_STATES)[number];

/** Alert presentation states. */
export const ALERT_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** Provider health classes (contract §9, E9). */
export const PROVIDER_HEALTH_CLASSES = [
  "AVAILABLE",
  "DEGRADED",
  "RATE_LIMITED",
  "UNAVAILABLE",
  "UNKNOWN",
] as const;
export type ProviderHealthClass = (typeof PROVIDER_HEALTH_CLASSES)[number];

/** Security observability signal types (E11). */
export const SECURITY_SIGNAL_TYPES = [
  "AUTH_FAILURE",
  "AUTHORIZATION_FAILURE",
  "CROSS_TENANT_ATTEMPT",
  "CROSS_BUSINESS_ATTEMPT",
  "PROMPT_INJECTION_DETECTED",
  "TOOL_POLICY_REJECTION",
  "SECRET_SHAPED_PAYLOAD_REJECTED",
  "APPROVAL_FORGERY_ATTEMPT",
  "CALLBACK_FORGERY_ATTEMPT",
  "PRIVILEGE_ESCALATION_ATTEMPT",
] as const;
export type SecuritySignalType = (typeof SECURITY_SIGNAL_TYPES)[number];

/** Backup / DR observability signal types (E12, R10-G compatible). */
export const BACKUP_SIGNAL_TYPES = [
  "BACKUP_SUCCEEDED",
  "BACKUP_JOB_FAILURE",
  "BACKUP_VERIFIED",
  "BACKUP_VERIFICATION_FAILED",
  "OFFSITE_COPY_CONFIRMED",
  "OFFSITE_COPY_MISSING",
  "RESTORE_REHEARSAL_SUCCEEDED",
  "RETENTION_HEALTH_DEGRADED",
] as const;
export type BackupSignalType = (typeof BACKUP_SIGNAL_TYPES)[number];

/** Worker health evidence signals (E7). */
export const WORKER_HEALTH_SIGNALS = [
  "WORKER_ONLINE",
  "WORKER_OFFLINE",
  "HEARTBEAT_STALE",
  "JOB_LEASE_STALE",
  "JOB_STUCK",
  "CRASH_LOOP",
  "RETRY_STORM",
  "DEAD_LETTER_GROWTH",
  "QUEUE_BACKLOG_HIGH",
  "VERSION_DRIFT",
] as const;
export type WorkerHealthSignal = (typeof WORKER_HEALTH_SIGNALS)[number];

/** SLO indicators (E16). Measurement foundation only — no contractual SLA. */
export const SLO_INDICATORS = [
  "api_availability",
  "api_latency",
  "worker_heartbeat_freshness",
  "queue_lag",
  "execution_uncertainty_rate",
  "provider_timeout_rate",
  "callback_delay",
  "db_latency",
  "deadlock_rate",
  "incident_detection_delay",
  "recovery_backlog",
  "backup_freshness",
] as const;
export type SloIndicator = (typeof SLO_INDICATORS)[number];

// ─── Error taxonomy ───

export const OBSERVABILITY_ERROR_CODES = [
  "OBSERVABILITY_CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  "OBSERVABILITY_SECRET_MATERIAL_REJECTED",
  "OBSERVABILITY_INVALID_INPUT",
  "OBSERVABILITY_EVENT_TYPE_UNKNOWN",
  "OBSERVABILITY_DIAGNOSTIC_CODE_UNKNOWN",
  "OBSERVABILITY_SERVICE_UNKNOWN",
  "OBSERVABILITY_PROVIDER_UNKNOWN",
  "OBSERVABILITY_TENANT_SCOPE_MISMATCH",
  "OBSERVABILITY_BUSINESS_OWNERSHIP_INVALID",
  "OBSERVABILITY_INCIDENT_NOT_FOUND",
  "OBSERVABILITY_INCIDENT_TRANSITION_INVALID",
  "OBSERVABILITY_INCIDENT_SUPPRESSION_FORBIDDEN",
  "OBSERVABILITY_INCIDENT_CRITICAL_NOT_SUPPRESSIBLE",
  "OBSERVABILITY_ALERT_NOT_FOUND",
  "OBSERVABILITY_CONTROL_COMMAND_NOT_IMPLEMENTED",
  "OBSERVABILITY_REPLAY_CONFLICT",
  "OBSERVABILITY_UPSTREAM_UNAVAILABLE",
  "OBSERVABILITY_EVENT_EVIDENCE_NOT_FOUND",
] as const;
export type ObservabilityErrorCode = (typeof OBSERVABILITY_ERROR_CODES)[number];

export class ObservabilityInputError extends Error {
  readonly code: ObservabilityErrorCode;
  constructor(code: ObservabilityErrorCode, message: string) {
    super(message);
    this.name = "ObservabilityInputError";
    this.code = code;
  }
}

// ─── Client-authority rejection (E14/E17) ───

/**
 * Fields a client/model may never supply. Presence of any of these in any
 * input object fails closed before validation — health, state and authority
 * are server-derived only.
 */
export const FORBIDDEN_CLIENT_FIELDS = [
  "eventId",
  "incidentId",
  "alertId",
  "observationId",
  "health",
  "healthClass",
  "platformHealth",
  "dimensionHealth",
  "incidentStatus",
  "alertStatus",
  "environment",
  "releaseVersion",
  "sourceVersion",
  "eventHash",
  "evidenceHash",
  "correlationKey",
  "dedupKey",
  "occurrenceCount",
  "firstSeenAt",
  "lastSeenAt",
  "actorType",
  "actorUserId",
  "suppressionAuthority",
  "resolvedAt",
  "closedAt",
  "acknowledgedAt",
  "authorized",
  "approval",
  "decision",
  "policyVersion",
  "executionAuthorization",
  "recoveryAuthorization",
  "retryAuthorization",
  "missionState",
  "executionResult",
  "providerSwitch",
  "disableMonitoring",
  "disableBackup",
  "killSwitch",
  "emergencySafeMode",
] as const;

const SECRET_KEY_PATTERN =
  /token|password|passwd|authorization|secret|credential|api[-_]?key|session|cookie|private[-_]?key|access[-_]?key/i;

export function findForbiddenField(input: Record<string, unknown>): string | null {
  for (const key of Object.keys(input)) {
    if ((FORBIDDEN_CLIENT_FIELDS as readonly string[]).includes(key)) return key;
  }
  return null;
}

export function findSecretKey(input: Record<string, unknown>): string | null {
  for (const key of Object.keys(input)) {
    if (SECRET_KEY_PATTERN.test(key)) return key;
  }
  return null;
}

// ─── zod router-input schemas ───

const boundedString = (max: number) => z.string().trim().min(1).max(max);
const isoUtcString = z.string().regex(ISO_UTC_PATTERN, "must be an explicit ISO-8601 UTC timestamp");
const optionalIsoUtc = isoUtcString.nullable().optional();
const idRef = z.string().trim().min(1).max(128);
const optionalRef = idRef.nullable().optional();

export const recordOperationalEventSchema = z.strictObject({
  eventType: z.enum(OPERATIONAL_EVENT_TYPES),
  service: z.enum(OBSERVABILITY_SERVICES),
  component: boundedString(64),
  operation: boundedString(64),
  severity: z.enum(OBSERVABILITY_SEVERITIES),
  status: z.enum(OBSERVABILITY_STATUSES),
  correlationId: boundedString(64).nullable().optional(),
  /** Tenant scope: "self" attributes to the caller; "platform" is admin-only. */
  scope: z.enum(["self", "platform"]).optional(),
  businessId: z.number().int().positive().nullable().optional(),
  missionId: optionalRef,
  taskId: optionalRef,
  executionAttemptId: optionalRef,
  provider: z.enum(OBSERVABILITY_PROVIDERS).nullable().optional(),
  providerReference: boundedString(128).nullable().optional(),
  occurredAt: isoUtcString,
  observedAt: isoUtcString,
  diagnosticCode: z.enum(DIAGNOSTIC_CODES),
  safeMetadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const listOperationalEventsSchema = z.strictObject({
  eventType: z.enum(OPERATIONAL_EVENT_TYPES).optional(),
  service: z.enum(OBSERVABILITY_SERVICES).optional(),
  severity: z.enum(OBSERVABILITY_SEVERITIES).optional(),
  diagnosticCode: z.enum(DIAGNOSTIC_CODES).optional(),
  /** Tenant-predicated reads default to the caller's own scope. */
  scope: z.enum(["self", "platform", "all"]).optional(),
  businessId: z.number().int().positive().optional(),
  missionId: idRef.optional(),
  correlationId: boundedString(64).optional(),
  fromOccurredAt: optionalIsoUtc,
  toOccurredAt: optionalIsoUtc,
  limit: z.number().int().min(1).max(MAX_TIMELINE_EVENTS).optional(),
});

export const listActiveIncidentsSchema = z.strictObject({
  scope: z.enum(["PLATFORM", "TENANT", "BUSINESS"]).optional(),
  service: z.enum(OBSERVABILITY_SERVICES).optional(),
  status: z.enum(INCIDENT_STATUSES).optional(),
  businessId: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(MAX_INCIDENTS_RETURNED).optional(),
});

export const getIncidentSchema = z.strictObject({
  incidentId: idRef,
  /** Required when the caller is a non-admin tenant reading a scoped incident. */
  businessId: z.number().int().positive().optional(),
});

const incidentTransitionSchema = z.strictObject({
  incidentId: idRef,
  toStatus: z.enum(["INVESTIGATING", "MITIGATING", "MONITORING", "RESOLVED"]),
  reason: boundedString(MAX_REASON_LENGTH),
  businessId: z.number().int().positive().optional(),
});

const closeIncidentSchema = z.strictObject({
  incidentId: idRef,
  reason: boundedString(MAX_REASON_LENGTH),
  businessId: z.number().int().positive().optional(),
});

const suppressIncidentSchema = z.strictObject({
  incidentId: idRef,
  /** Explicit operator/policy authority reference (attestation id or policy id). */
  suppressionAuthority: boundedString(MAX_SUPPRESSION_AUTHORITY_LENGTH),
  reason: boundedString(MAX_REASON_LENGTH),
  businessId: z.number().int().positive().optional(),
});

export const transitionIncidentSchema = incidentTransitionSchema;
export const closeIncidentInputSchema = closeIncidentSchema;
export const suppressIncidentInputSchema = suppressIncidentSchema;

export const acknowledgeAlertSchema = z.strictObject({
  alertId: idRef.max(69),
  reason: boundedString(MAX_REASON_LENGTH),
});

export const resolveAlertSchema = acknowledgeAlertSchema;

export const listOperationalAlertsSchema = z.strictObject({
  status: z.enum(ALERT_STATUSES).optional(),
  severity: z.enum(OBSERVABILITY_SEVERITIES).optional(),
  ruleId: boundedString(48).optional(),
  limit: z.number().int().min(1).max(MAX_ALERTS_RETURNED).optional(),
});

export const getOperationalTimelineSchema = z.strictObject({
  incidentId: idRef.optional(),
  correlationId: boundedString(64).optional(),
  eventType: z.enum(OPERATIONAL_EVENT_TYPES).optional(),
  fromOccurredAt: optionalIsoUtc,
  toOccurredAt: optionalIsoUtc,
  scope: z.enum(["self", "platform", "all"]).optional(),
  businessId: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(MAX_TIMELINE_EVENTS).optional(),
});

export const getHealthHistorySchema = z.strictObject({
  dimension: z.enum(HEALTH_DIMENSIONS).optional(),
  service: z.enum(OBSERVABILITY_SERVICES).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const listServiceHealthSchema = z.strictObject({
  environment: z.enum(OBSERVABILITY_ENVIRONMENTS).optional(),
});

/** Control commands are defined for the future governed boundary only (E14). */
export const CONTROL_COMMAND_TYPES = [
  "suspend_mission_execution",
  "disable_provider",
  "enable_emergency_safe_mode",
  "invoke_kill_switch",
] as const;
export type ControlCommandType = (typeof CONTROL_COMMAND_TYPES)[number];

export const controlCommandSchema = z.strictObject({
  command: z.enum(CONTROL_COMMAND_TYPES),
  reason: boundedString(MAX_REASON_LENGTH).optional(),
});
