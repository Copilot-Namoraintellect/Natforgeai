// ─── R10-E Observability — alert model + deterministic dedup/correlation (E4/E5) ───
//
// PURE deterministic alert rules. Alerts are raised by rules over classified
// operational material — never ad hoc. Deduplication uses a deterministic
// alt1: identity: an open alert with the same identity folds new occurrences
// (occurrenceCount++, lastSeenAt advance + a fold event) while every
// underlying event stays preserved in the append-only event store.
// Deduplication compresses presentation, never deletes evidence.

import { ObservabilityInputError } from "./observability-contract";
import type { DiagnosticCode, ObservabilitySeverity } from "./observability-contract";
import { deriveAlertDedupKey, deriveAlertId } from "./observability-identity";
import type { IncidentFailureClass } from "./incident-model";

/** Deterministic alert rules (closed). */
export const ALERT_RULES = [
  "provider_outage",
  "provider_auth_failure",
  "provider_rate_limit",
  "worker_crash_loop",
  "worker_offline",
  "worker_stale_heartbeat",
  "scheduler_stale",
  "db_connectivity",
  "db_conflict_elevated",
  "queue_backlog",
  "callback_failures",
  "execution_uncertainty",
  "mission_blockage",
  "governance_backlog",
  "recovery_backlog",
  "security_critical_signal",
  "backup_failure",
  "backup_stale",
  "platform_degraded",
] as const;
export type AlertRuleId = (typeof ALERT_RULES)[number];

export interface AlertRuleMatch {
  readonly ruleId: AlertRuleId;
  readonly severity: ObservabilitySeverity;
  /** Fold target for dedup, e.g. "provider:outage:meta". */
  readonly dedupTarget: string;
  readonly title: string;
  readonly operatorAttentionRequired: boolean;
}

/** Deterministic diagnostic-code → alert-rule mapping. */
export function matchAlertRule(input: {
  readonly diagnosticCode: DiagnosticCode;
  readonly failureClass: IncidentFailureClass;
  readonly provider: string | null;
  readonly component: string;
  readonly severity: ObservabilitySeverity;
}): AlertRuleMatch | null {
  const providerTarget = input.provider ?? "internal";
  const componentTarget = input.component || "unknown";
  switch (input.diagnosticCode) {
    case "PROVIDER_TIMEOUT":
    case "PROVIDER_5XX":
      return {
        ruleId: "provider_outage",
        severity: bumpSeverity(input.severity, "HIGH"),
        dedupTarget: deriveAlertDedupKey({ failureClass: "provider:outage", target: providerTarget }),
        title: `Provider outage signals: ${providerTarget}`,
        operatorAttentionRequired: true,
      };
    case "PROVIDER_AUTH_FAILURE":
      return {
        ruleId: "provider_auth_failure",
        severity: "CRITICAL",
        dedupTarget: deriveAlertDedupKey({ failureClass: "provider:auth_failure", target: providerTarget }),
        title: `Provider authentication failure: ${providerTarget}`,
        operatorAttentionRequired: true,
      };
    case "PROVIDER_RATE_LIMITED":
      return {
        ruleId: "provider_rate_limit",
        severity: "WARNING",
        dedupTarget: deriveAlertDedupKey({ failureClass: "provider:rate_limit", target: providerTarget }),
        title: `Provider rate limited: ${providerTarget}`,
        operatorAttentionRequired: false,
      };
    case "WORKER_CRASH_LOOP":
      return {
        ruleId: "worker_crash_loop",
        severity: "HIGH",
        dedupTarget: deriveAlertDedupKey({ failureClass: "worker:crash_loop", target: componentTarget }),
        title: `Worker crash loop: ${componentTarget}`,
        operatorAttentionRequired: true,
      };
    case "WORKER_OFFLINE":
      return {
        ruleId: "worker_offline",
        severity: "CRITICAL",
        dedupTarget: deriveAlertDedupKey({ failureClass: "worker:offline", target: componentTarget }),
        title: `Worker offline: ${componentTarget}`,
        operatorAttentionRequired: true,
      };
    case "WORKER_HEARTBEAT_STALE":
    case "JOB_LEASE_STALE":
    case "JOB_STUCK":
      return {
        ruleId: "worker_stale_heartbeat",
        severity: "WARNING",
        dedupTarget: deriveAlertDedupKey({ failureClass: "worker:stale_heartbeat", target: componentTarget }),
        title: `Worker heartbeat/lease stale: ${componentTarget}`,
        operatorAttentionRequired: false,
      };
    case "SCHEDULER_HEARTBEAT_STALE":
      return {
        ruleId: "scheduler_stale",
        severity: "WARNING",
        dedupTarget: deriveAlertDedupKey({ failureClass: "scheduler:stale", target: componentTarget }),
        title: `Scheduler heartbeat stale: ${componentTarget}`,
        operatorAttentionRequired: false,
      };
    case "DB_CONNECTIVITY_FAILURE":
      return {
        ruleId: "db_connectivity",
        severity: "CRITICAL",
        dedupTarget: deriveAlertDedupKey({ failureClass: "db:connectivity", target: "primary" }),
        title: "Database connectivity failure",
        operatorAttentionRequired: true,
      };
    case "DB_DEADLOCK":
    case "DB_CAS_CONFLICT":
    case "DB_REPLAY_COLLISION":
      return {
        ruleId: "db_conflict_elevated",
        severity: "WARNING",
        dedupTarget: deriveAlertDedupKey({ failureClass: "db:conflict", target: "primary" }),
        title: "Database conflict rate elevated",
        operatorAttentionRequired: false,
      };
    case "QUEUE_BACKLOG_HIGH":
    case "RETRY_STORM":
    case "DEAD_LETTER_GROWTH":
      return {
        ruleId: "queue_backlog",
        severity: "WARNING",
        dedupTarget: deriveAlertDedupKey({ failureClass: "queue:backlog", target: componentTarget }),
        title: `Queue backlog elevated: ${componentTarget}`,
        operatorAttentionRequired: false,
      };
    case "CALLBACK_DELAY_HIGH":
    case "RECONCILIATION_BACKLOG_HIGH":
      return {
        ruleId: "callback_failures",
        severity: "HIGH",
        dedupTarget: deriveAlertDedupKey({ failureClass: "callback:failures", target: componentTarget }),
        title: `Callback/reconciliation backlog: ${componentTarget}`,
        operatorAttentionRequired: true,
      };
    case "EXECUTION_UNCERTAIN":
      return {
        ruleId: "execution_uncertainty",
        severity: "WARNING",
        dedupTarget: deriveAlertDedupKey({ failureClass: "execution:uncertain", target: componentTarget }),
        title: `Uncertain execution results: ${componentTarget}`,
        operatorAttentionRequired: true,
      };
    case "MISSION_BLOCKED":
    case "STALE_SCHEDULE":
      return {
        ruleId: "mission_blockage",
        severity: "HIGH",
        dedupTarget: deriveAlertDedupKey({ failureClass: "mission:blocked", target: componentTarget }),
        title: `Mission blockage signals: ${componentTarget}`,
        operatorAttentionRequired: true,
      };
    case "GOVERNANCE_REVIEW_BACKLOG":
    case "APPROVAL_BACKLOG_HIGH":
      return {
        ruleId: "governance_backlog",
        severity: "WARNING",
        dedupTarget: deriveAlertDedupKey({ failureClass: "governance:backlog", target: "platform" }),
        title: "Governance/approval backlog elevated",
        operatorAttentionRequired: true,
      };
    case "RECOVERY_BACKLOG_HIGH":
    case "STALE_RECOVERY":
      return {
        ruleId: "recovery_backlog",
        severity: "WARNING",
        dedupTarget: deriveAlertDedupKey({ failureClass: "recovery:backlog", target: "platform" }),
        title: "Recovery backlog elevated",
        operatorAttentionRequired: true,
      };
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
      return {
        ruleId: "security_critical_signal",
        severity: "CRITICAL",
        dedupTarget: deriveAlertDedupKey({ failureClass: "security:signal", target: input.diagnosticCode }),
        title: `Security signal: ${input.diagnosticCode}`,
        operatorAttentionRequired: true,
      };
    case "BACKUP_JOB_FAILURE":
    case "BACKUP_VERIFICATION_FAILED":
      return {
        ruleId: "backup_failure",
        severity: "CRITICAL",
        dedupTarget: deriveAlertDedupKey({ failureClass: "backup:failure", target: "platform" }),
        title: "Backup job/verification failure",
        operatorAttentionRequired: true,
      };
    case "BACKUP_STALE":
    case "BACKUP_OFFSITE_COPY_MISSING":
    case "RESTORE_REHEARSAL_STALE":
    case "RETENTION_HEALTH_DEGRADED":
      return {
        ruleId: "backup_stale",
        severity: "WARNING",
        dedupTarget: deriveAlertDedupKey({ failureClass: "backup:stale", target: "platform" }),
        title: "Backup freshness degraded",
        operatorAttentionRequired: true,
      };
    default:
      return null;
  }
}

function bumpSeverity(severity: ObservabilitySeverity, floor: ObservabilitySeverity): ObservabilitySeverity {
  const rank: Record<ObservabilitySeverity, number> = { INFO: 0, WARNING: 1, HIGH: 2, CRITICAL: 3 };
  return rank[severity] >= rank[floor] ? severity : floor;
}

/** Deterministic alert identity for a fold target in an environment. */
export function buildAlertIdentity(environment: string, dedupKey: string): { alertId: string; dedupKey: string } {
  if (!dedupKey || dedupKey.trim().length === 0) {
    throw new ObservabilityInputError("OBSERVABILITY_INVALID_INPUT", "alert dedup key must be non-blank.");
  }
  const key = dedupKey.trim();
  return { alertId: deriveAlertId({ environment, dedupKey: key }), dedupKey: key };
}

export const ALERT_MODEL_DISCLAIMER =
  "deduplication compresses presentation, never deletes evidence; alert storms fold into one identity with occurrence counts.";
