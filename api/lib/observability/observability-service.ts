// ─── R10-E Observability — service layer ───
//
// Orchestrates the observability planes: telemetry acceptance (exact-once),
// deterministic incident detection/convergence, alert rule evaluation with
// deduplicated presentation, evidence-derived platform health observations,
// SLO measurement, and read-only diagnostic surfaces. Emits exactly one
// audit event per durable incident/alert effect (convergence emits zero).
// Health observations are derived diagnostic telemetry (reconstructible from
// the event store) and do not emit audit events.
//
// This layer authorizes nothing and executes nothing: no retry authority, no
// recovery authority, no provider switching, no control commands.

import { HEALTH_DIMENSIONS, ObservabilityInputError } from "./observability-contract";
import type {
  AlertStatus,
  HealthDimension,
  IncidentStatus,
  ObservabilityEnvironment,
  ObservabilitySeverity,
} from "./observability-contract";
import {
  deriveHealthObservationId,
  deriveIncidentId,
  deriveIncidentLifecycleEventId,
  deriveOperationalEventId,
} from "./observability-identity";
import {
  buildOperationalEventFingerprint,
  createOperationalTelemetryEvent,
  type OperationalTelemetryEvent,
} from "./telemetry-event";
import {
  deriveApiHealth,
  deriveBackupHealth,
  deriveCallbackHealth,
  deriveDatabaseHealth,
  deriveDeploymentVersionHealth,
  deriveMissionControlHealth,
  derivePlatformHealth,
  deriveProviderHealth,
  deriveQueueHealth,
  deriveRecoveryBacklogHealth,
  deriveSchedulerHealth,
  deriveSecurityControlsHealth,
  deriveWorkerHealth,
  hashHealthEvidence,
  type ApiHealthEvidence,
  type BackupHealthEvidence,
  type CallbackHealthEvidence,
  type DatabaseHealthEvidence,
  type DimensionHealth,
  type MissionControlHealthEvidence,
  type PlatformHealth,
  type ProviderHealthEvidence,
  type QueueHealthEvidence,
  type RecoveryBacklogEvidence,
  type SchedulerHealthEvidence,
  type SecurityControlsEvidence,
  type WorkerHealthEvidence,
} from "./health-model";
import {
  assertIncidentSuppressible,
  assertIncidentTransition,
  assertSuppressionAuthority,
  classifyFailureClass,
  classifyIncidentSeverity,
  deriveIncidentSafetyState,
  isTerminalIncidentStatus,
} from "./incident-model";
import { buildAlertIdentity, matchAlertRule } from "./alert-model";
import {
  type ObservabilityStoreExecutor,
  type OperationalEventRecord,
  findOperationalAlert,
  findOperationalIncident,
  findOpenAlertByIdentity,
  insertIncidentLifecycleEvent,
  insertOperationalAlert,
  insertOperationalEvent,
  insertOperationalIncident,
  insertServiceHealthObservation,
  listIncidentLifecycleEvents,
  listOperationalAlerts,
  listOperationalEvents,
  listOperationalIncidents,
  listServiceHealthObservations,
  updateAlertState,
  updateIncidentState,
  desc,
} from "./observability-store";
import {
  type MeasurementBasis,
  measureApiAvailability,
  measureApiLatency,
  measureBackupFreshness,
  measureCallbackDelay,
  measureDbLatency,
  measureDeadlockRate,
  measureExecutionUncertaintyRate,
  measureIncidentDetectionDelay,
  measureProviderTimeoutRate,
  measureQueueLag,
  measureRecoveryBacklog,
  measureWorkerHeartbeatFreshness,
} from "./slo-measurement";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent, type AuditDbExecutor } from "../audit/audit-store";

export const OBSERVABILITY_SERVICE_DISCLAIMER =
  "observability != authority. This surface observes, classifies, alerts, correlates and " +
  "recommends operator attention — it never authorizes execution, approves recovery, changes " +
  "autonomy, changes policy, changes mission scope, changes provider, changes credentials, " +
  "rewrites history, hides uncertainty or suppresses audit.";

/** Caller principal resolved by the router boundary. */
export interface ObservabilityPrincipal {
  readonly userId: number;
  readonly isAdmin: boolean;
}

export interface RecordOperationalEventInput {
  readonly eventType: OperationalTelemetryEvent["eventType"];
  readonly service: OperationalTelemetryEvent["service"];
  readonly component: string;
  readonly operation: string;
  readonly severity: ObservabilitySeverity;
  readonly status: OperationalTelemetryEvent["status"];
  readonly correlationId?: string | null;
  readonly businessId?: number | null;
  readonly missionId?: string | null;
  readonly taskId?: string | null;
  readonly executionAttemptId?: string | null;
  readonly provider?: OperationalTelemetryEvent["provider"];
  readonly providerReference?: string | null;
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly diagnosticCode: OperationalTelemetryEvent["diagnosticCode"];
  readonly safeMetadata?: Record<string, unknown> | null;
  /**
   * "self" attributes the event to the caller tenant; "platform" (tenantId
   * null) is admin-only. Resolved server-side — clients never set tenantId.
   */
  readonly scope: "self" | "platform";
}

/** Evidence providers for health derivation; absent/throwing ⇒ UNKNOWN. */
export interface PlatformEvidenceProvider {
  getApiEvidence?(now: Date): Promise<ApiHealthEvidence | null>;
  getDatabaseEvidence?(now: Date): Promise<DatabaseHealthEvidence | null>;
  getWorkerEvidence?(now: Date): Promise<WorkerHealthEvidence | null>;
  getSchedulerEvidence?(now: Date): Promise<SchedulerHealthEvidence | null>;
  getQueueEvidence?(now: Date): Promise<QueueHealthEvidence | null>;
  getMissionControlEvidence?(now: Date): Promise<MissionControlHealthEvidence | null>;
  getCallbackEvidence?(now: Date): Promise<CallbackHealthEvidence | null>;
  getRecoveryBacklogEvidence?(now: Date): Promise<RecoveryBacklogEvidence | null>;
  getBackupEvidence?(now: Date): Promise<BackupHealthEvidence | null>;
  getSecurityEvidence?(now: Date): Promise<SecurityControlsEvidence | null>;
  getProviderEvidence?(
    now: Date
  ): Promise<ReadonlyArray<{ readonly provider: string; readonly evidence: ProviderHealthEvidence }> | null>;
}

export interface ObservabilityServiceDeps {
  readonly executor: ObservabilityStoreExecutor;
  readonly audit: AuditDbExecutor;
  readonly now: () => Date;
  readonly environment: ObservabilityEnvironment;
  readonly releaseVersion: string | null;
  readonly evidence?: PlatformEvidenceProvider;
}

async function emitAudit(
  deps: ObservabilityServiceDeps,
  input: {
    readonly eventType:
      | "operational_event_recorded"
      | "operational_incident_opened"
      | "operational_incident_lifecycle"
      | "operational_alert_raised"
      | "operational_alert_deduplicated"
      | "operational_alert_lifecycle";
    readonly userId: number;
    readonly artifactId: string;
    readonly metadata: Record<string, unknown>;
  }
): Promise<void> {
  const event = createAuditEvent({
    eventType: input.eventType,
    occurredAt: deps.now().toISOString(),
    userId: input.userId,
    source: "system",
    outcome: "succeeded",
    artifactId: input.artifactId,
    metadata: input.metadata,
  });
  await persistAuditEvent(event, deps.audit);
}

function toRecord(event: OperationalTelemetryEvent): OperationalEventRecord {
  return {
    eventId: "",
    schemaVersion: event.schemaVersion,
    contractVersion: event.contractVersion,
    eventType: event.eventType,
    environment: event.environment,
    releaseVersion: event.releaseVersion,
    service: event.service,
    component: event.component,
    operation: event.operation,
    severity: event.severity,
    status: event.status,
    correlationId: event.correlationId,
    tenantId: event.tenantId,
    businessId: event.businessId,
    missionId: event.missionId,
    taskId: event.taskId,
    executionAttemptId: event.executionAttemptId,
    provider: event.provider,
    providerReference: event.providerReference,
    occurredAt: event.occurredAt,
    observedAt: event.observedAt,
    diagnosticCode: event.diagnosticCode,
    safeMetadata: event.safeMetadata,
    eventHash: buildOperationalEventFingerprint(event),
  };
}

export interface RecordOperationalEventResult {
  readonly eventId: string;
  readonly inserted: boolean;
  readonly incidentId: string | null;
  readonly incidentCreated: boolean;
  readonly alertId: string | null;
  readonly alertCreated: boolean;
  readonly alertFolded: boolean;
}

/**
 * Accept one operational telemetry event: validate + mint evt1: identity,
 * persist append-only (exact-once), then run the deterministic incident and
 * alert pipelines over it. Exactly one audit event per durable effect.
 */
export async function recordOperationalEvent(
  deps: ObservabilityServiceDeps,
  principal: ObservabilityPrincipal,
  input: RecordOperationalEventInput
): Promise<RecordOperationalEventResult> {
  if (input.scope === "platform" && !principal.isAdmin) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_TENANT_SCOPE_MISMATCH",
      "platform-scope telemetry requires the operator (admin) role."
    );
  }
  const tenantId = input.scope === "self" ? principal.userId : null;

  const event = createOperationalTelemetryEvent({
    eventType: input.eventType,
    environment: deps.environment,
    releaseVersion: deps.releaseVersion,
    service: input.service,
    component: input.component,
    operation: input.operation,
    severity: input.severity,
    status: input.status,
    correlationId: input.correlationId ?? null,
    tenantId,
    businessId: input.businessId ?? null,
    missionId: input.missionId ?? null,
    taskId: input.taskId ?? null,
    executionAttemptId: input.executionAttemptId ?? null,
    provider: input.provider ?? null,
    providerReference: input.providerReference ?? null,
    occurredAt: input.occurredAt,
    observedAt: input.observedAt,
    diagnosticCode: input.diagnosticCode,
    safeMetadata: input.safeMetadata ?? null,
  });
  const eventId = deriveOperationalEventId({
    environment: event.environment,
    eventType: event.eventType,
    service: event.service,
    component: event.component,
    operation: event.operation,
    tenantId: event.tenantId,
    businessId: event.businessId,
    provider: event.provider,
    diagnosticCode: event.diagnosticCode,
    occurredAt: event.occurredAt,
    safeMetadata: event.safeMetadata as Record<string, unknown>,
  });
  const record: OperationalEventRecord = { ...toRecord(event), eventId };
  const write = await insertOperationalEvent(record, deps.executor);
  if (write.inserted) {
    await emitAudit(deps, {
      eventType: "operational_event_recorded",
      userId: principal.userId,
      artifactId: eventId,
      metadata: {
        eventType: event.eventType,
        service: event.service,
        diagnosticCode: event.diagnosticCode,
        severity: event.severity,
        status: event.status,
        environment: event.environment,
      },
    });
  }

  const incident = await detectIncident(deps, principal, event, eventId);
  const alert = await evaluateAlert(deps, principal, event, incident?.incidentId ?? null);

  return {
    eventId,
    inserted: write.inserted,
    incidentId: incident?.incidentId ?? null,
    incidentCreated: incident?.created ?? false,
    alertId: alert?.alertId ?? null,
    alertCreated: alert?.created ?? false,
    alertFolded: alert?.folded ?? false,
  };
}

async function detectIncident(
  deps: ObservabilityServiceDeps,
  principal: ObservabilityPrincipal,
  event: OperationalTelemetryEvent,
  eventId: string
): Promise<{ readonly incidentId: string; readonly created: boolean } | null> {
  if (event.severity === "INFO") return null;
  const failureClass = classifyFailureClass(event.diagnosticCode);
  if (failureClass === "UNKNOWN_FAILURE") return null;
  const scope = event.tenantId === null ? "PLATFORM" : event.businessId !== null ? "BUSINESS" : "TENANT";
  const incidentId = deriveIncidentId({
    environment: event.environment,
    service: event.service,
    component: event.component,
    failureClass,
    scope,
    tenantId: event.tenantId,
    businessId: event.businessId,
  });
  const now = deps.now().toISOString();
  const existing = await findOperationalIncident(incidentId, deps.executor);
  if (existing) {
    if (isTerminalIncidentStatus(existing.status as IncidentStatus)) {
      // Re-detection after terminal: reopen honestly with an append-only fact.
      assertIncidentTransition(existing.status as IncidentStatus, "OPEN");
      const updated = await updateIncidentState(
        incidentId,
        existing.version,
        { status: "OPEN", lastSeenAt: now, occurrenceCount: (existing.occurrenceCount ?? 1) + 1 },
        deps.executor
      );
      if (updated) {
        await insertIncidentLifecycleEvent(
          {
            lifecycleEventId: deriveIncidentLifecycleEventId({
              incidentId,
              toStatus: "OPEN",
              actorType: "SYSTEM",
              actorUserId: null,
              occurredAt: now,
            }),
            incidentId,
            tenantId: event.tenantId,
            fromStatus: existing.status,
            toStatus: "OPEN",
            actorType: "SYSTEM",
            actorUserId: null,
            suppressionAuthority: null,
            reason: "failure re-detected after terminal state; incident reopened",
            occurredAt: now,
            eventHash: buildOperationalEventFingerprint(
              createOperationalTelemetryEvent({
                eventType: "incident_detected",
                environment: event.environment,
                service: event.service,
                component: event.component,
                operation: "incident_reopen",
                severity: event.severity,
                status: "UNCERTAIN",
                occurredAt: now,
                observedAt: now,
                diagnosticCode: event.diagnosticCode,
              })
            ),
          },
          deps.executor
        );
      }
      return { incidentId, created: false };
    }
    // Fold: bump occurrence + advance lastSeenAt; evidence stays in the event store.
    await updateIncidentState(
      incidentId,
      existing.version,
      {
        lastSeenAt: now,
        occurrenceCount: (existing.occurrenceCount ?? 1) + 1,
        evidenceEventIds: [...((existing.evidenceEventIds as string[] | null) ?? []), eventId].slice(-25),
      },
      deps.executor
    );
    return { incidentId, created: false };
  }

  const severity = classifyIncidentSeverity(failureClass);
  const metadataExecutionContinuing =
    event.safeMetadata && typeof event.safeMetadata === "object" && "executionContinuing" in event.safeMetadata
      ? (event.safeMetadata as Record<string, unknown>).executionContinuing
      : undefined;
  const executionContinuing = typeof metadataExecutionContinuing === "boolean" ? metadataExecutionContinuing : true;
  const safetyState = deriveIncidentSafetyState({ failureClass, executionContinuing });
  const title = `${failureClass} on ${event.service}/${event.component}`;
  const summary = `Deterministic incident over diagnostic ${event.diagnosticCode}; evidence event ${eventId}.`;
  const insert = await insertOperationalIncident(
    {
      incidentId,
      environment: event.environment,
      service: event.service,
      component: event.component,
      failureClass,
      scope,
      tenantId: event.tenantId,
      businessId: event.businessId,
      severity,
      status: "OPEN",
      title: title.slice(0, 160),
      summary: summary.slice(0, 512),
      safetyState,
      executionContinuing,
      autonomousActionSuspended: failureClass === "SECURITY_CRITICAL_SIGNAL",
      operatorAttentionRequired: severity === "CRITICAL" || severity === "HIGH",
      firstSeenAt: now,
      lastSeenAt: now,
      occurrenceCount: 1,
      evidenceEventIds: [eventId],
      correlationKey: `${event.service}:${event.component}:${failureClass}`,
      version: 1,
    },
    deps.executor
  );
  if (insert.inserted) {
    await insertIncidentLifecycleEvent(
      {
        lifecycleEventId: deriveIncidentLifecycleEventId({
          incidentId,
          toStatus: "OPEN",
          actorType: "SYSTEM",
          actorUserId: null,
          occurredAt: now,
        }),
        incidentId,
        tenantId: event.tenantId,
        fromStatus: null,
        toStatus: "OPEN",
        actorType: "SYSTEM",
        actorUserId: null,
        suppressionAuthority: null,
        reason: "incident opened over converging failure evidence",
        occurredAt: now,
        eventHash: buildOperationalEventFingerprint(
          createOperationalTelemetryEvent({
            eventType: "incident_detected",
            environment: event.environment,
            service: event.service,
            component: event.component,
            operation: "incident_open",
            severity,
            status: "UNCERTAIN",
            occurredAt: now,
            observedAt: now,
            diagnosticCode: event.diagnosticCode,
          })
        ),
      },
      deps.executor
    );
    await emitAudit(deps, {
      eventType: "operational_incident_opened",
      userId: principal.userId,
      artifactId: incidentId,
      metadata: {
        failureClass,
        service: event.service,
        component: event.component,
        severity,
        scope,
        environment: event.environment,
      },
    });
    return { incidentId, created: true };
  }
  return { incidentId, created: false };
}

async function evaluateAlert(
  deps: ObservabilityServiceDeps,
  principal: ObservabilityPrincipal,
  event: OperationalTelemetryEvent,
  incidentId: string | null
): Promise<{ readonly alertId: string; readonly created: boolean; readonly folded: boolean } | null> {
  const failureClass = classifyFailureClass(event.diagnosticCode);
  const match = matchAlertRule({
    diagnosticCode: event.diagnosticCode,
    failureClass,
    provider: event.provider,
    component: event.component,
    severity: event.severity,
  });
  if (!match) return null;
  const { alertId, dedupKey } = buildAlertIdentity(event.environment, match.dedupTarget);
  const now = deps.now().toISOString();
  const existing = await findOpenAlertByIdentity(event.environment, dedupKey, deps.executor);
  if (existing && existing.status !== "RESOLVED") {
    await updateAlertState(
      alertId,
      existing.version,
      { lastSeenAt: now, occurrenceCount: (existing.occurrenceCount ?? 1) + 1 },
      deps.executor
    );
    await emitAudit(deps, {
      eventType: "operational_alert_deduplicated",
      userId: principal.userId,
      artifactId: alertId,
      metadata: { ruleId: match.ruleId, dedupKey, occurrenceCount: (existing.occurrenceCount ?? 1) + 1 },
    });
    return { alertId, created: false, folded: true };
  }
  if (existing && existing.status === "RESOLVED") {
    // Re-arm: a resolved identity seeing the failure again re-opens the same
    // deterministic alert row (dedup anchor) — still one presentation row.
    await updateAlertState(alertId, existing.version, { status: "OPEN", lastSeenAt: now, occurrenceCount: 1 }, deps.executor);
    await emitAudit(deps, {
      eventType: "operational_alert_raised",
      userId: principal.userId,
      artifactId: alertId,
      metadata: { ruleId: match.ruleId, dedupKey, severity: match.severity, rearmed: true },
    });
    return { alertId, created: false, folded: false };
  }
  const insert = await insertOperationalAlert(
    {
      alertId,
      environment: event.environment,
      dedupKey,
      ruleId: match.ruleId,
      severity: match.severity,
      status: "OPEN",
      title: match.title.slice(0, 160),
      summary: `Rule ${match.ruleId} raised over diagnostic ${event.diagnosticCode}.`,
      affectedTarget: dedupKey,
      safetyState: incidentId ? "OPERATOR_ACTION_REQUIRED" : "EXECUTION_CONTINUING",
      executionContinuing: true,
      autonomousActionSuspended: match.ruleId === "security_critical_signal",
      operatorAttentionRequired: match.operatorAttentionRequired,
      incidentId,
      firstSeenAt: now,
      lastSeenAt: now,
      occurrenceCount: 1,
      version: 1,
    },
    deps.executor
  );
  if (insert.inserted) {
    await emitAudit(deps, {
      eventType: "operational_alert_raised",
      userId: principal.userId,
      artifactId: alertId,
      metadata: { ruleId: match.ruleId, dedupKey, severity: match.severity },
    });
  }
  return { alertId, created: insert.inserted, folded: false };
}

// ─── Governed incident lifecycle commands (audited; admin at the router) ───

async function applyIncidentTransition(
  deps: ObservabilityServiceDeps,
  principal: ObservabilityPrincipal,
  input: {
    readonly incidentId: string;
    readonly toStatus: IncidentStatus;
    readonly reason: string;
    readonly actorType: "OPERATOR" | "SYSTEM";
    readonly suppressionAuthority?: string | null;
    /**
     * Internal escape for the authority-gated suppression path only —
     * suppressIncident() has already asserted severity + authority. The
     * public transitionIncident() never sets this.
     */
    readonly _suppressValidation?: boolean;
  }
): Promise<{ readonly incidentId: string; readonly fromStatus: string; readonly toStatus: string }> {
  const incident = await findOperationalIncident(input.incidentId, deps.executor);
  if (!incident) {
    throw new ObservabilityInputError("OBSERVABILITY_INCIDENT_NOT_FOUND", `incident ${input.incidentId} not found.`);
  }
  const fromStatus = incident.status as IncidentStatus;
  if (!input._suppressValidation) {
    assertIncidentTransition(fromStatus, input.toStatus);
  } else if (input.toStatus !== "SUPPRESSED") {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INCIDENT_TRANSITION_INVALID",
      "suppression validation bypass is only valid for SUPPRESSED transitions."
    );
  }
  const now = deps.now().toISOString();
  const updated = await updateIncidentState(
    input.incidentId,
    incident.version,
    { status: input.toStatus },
    deps.executor
  );
  if (!updated) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_REPLAY_CONFLICT",
      `incident ${input.incidentId} changed concurrently; re-read and retry.`
    );
  }
  await insertIncidentLifecycleEvent(
    {
      lifecycleEventId: deriveIncidentLifecycleEventId({
        incidentId: input.incidentId,
        toStatus: input.toStatus,
        actorType: input.actorType,
        actorUserId: principal.userId,
        occurredAt: now,
      }),
      incidentId: input.incidentId,
      tenantId: incident.tenantId,
      fromStatus,
      toStatus: input.toStatus,
      actorType: input.actorType,
      actorUserId: principal.userId,
      suppressionAuthority: input.suppressionAuthority ?? null,
      reason: input.reason,
      occurredAt: now,
      eventHash: buildOperationalEventFingerprint(
        createOperationalTelemetryEvent({
          eventType: "incident_lifecycle_observed",
          environment: incident.environment as ObservabilityEnvironment,
          service: incident.service as OperationalTelemetryEvent["service"],
          component: incident.component,
          operation: `incident_${input.toStatus.toLowerCase()}`,
          severity: (incident.severity as ObservabilitySeverity) ?? "WARNING",
          status: "SUCCEEDED",
          occurredAt: now,
          observedAt: now,
          diagnosticCode: "OK",
          safeMetadata: { fromStatus, toStatus: input.toStatus },
        })
      ),
    },
    deps.executor
  );
  await emitAudit(deps, {
    eventType: "operational_incident_lifecycle",
    userId: principal.userId,
    artifactId: input.incidentId,
    metadata: {
      fromStatus,
      toStatus: input.toStatus,
      actorType: input.actorType,
      failureClass: incident.failureClass,
      ...(input.suppressionAuthority ? { suppressionAuthority: input.suppressionAuthority } : {}),
    },
  });
  return { incidentId: input.incidentId, fromStatus, toStatus: input.toStatus };
}

export async function transitionIncident(
  deps: ObservabilityServiceDeps,
  principal: ObservabilityPrincipal,
  input: { readonly incidentId: string; readonly toStatus: IncidentStatus; readonly reason: string }
) {
  return applyIncidentTransition(deps, principal, { ...input, actorType: "OPERATOR" });
}

export async function suppressIncident(
  deps: ObservabilityServiceDeps,
  principal: ObservabilityPrincipal,
  input: { readonly incidentId: string; readonly suppressionAuthority: string; readonly reason: string }
) {
  const incident = await findOperationalIncident(input.incidentId, deps.executor);
  if (!incident) {
    throw new ObservabilityInputError("OBSERVABILITY_INCIDENT_NOT_FOUND", `incident ${input.incidentId} not found.`);
  }
  assertIncidentSuppressible(incident.severity as ObservabilitySeverity);
  assertSuppressionAuthority(input.suppressionAuthority);
  return applyIncidentTransition(deps, principal, {
    incidentId: input.incidentId,
    toStatus: "SUPPRESSED",
    reason: input.reason,
    actorType: "OPERATOR",
    suppressionAuthority: input.suppressionAuthority.trim(),
    _suppressValidation: true,
  });
}

// ─── Health observation ───

async function gatherDimensionEvidence(
  deps: ObservabilityServiceDeps,
  now: Date
): Promise<Readonly<Partial<Record<HealthDimension, DimensionHealth>>>> {
  const evidence = deps.evidence ?? {};
  const out: Partial<Record<HealthDimension, DimensionHealth>> = {};
  const run = async <E>(
    dimension: HealthDimension,
    basis: string,
    fn: ((now: Date) => Promise<E | null>) | undefined,
    derive: (evidence: E) => string
  ): Promise<void> => {
    if (!fn) {
      out[dimension] = { dimension, health: "UNKNOWN", basis: "no evidence provider bound" };
      return;
    }
    try {
      const ev = await fn(now);
      if (ev === null) {
        out[dimension] = { dimension, health: "UNKNOWN", basis: "evidence provider returned no telemetry" };
        return;
      }
      out[dimension] = { dimension, health: derive(ev) as DimensionHealth["health"], basis };
    } catch {
      // A failing evidence provider must never fail the rollup; it degrades
      // to an honest UNKNOWN contribution (per-area isolation convention).
      out[dimension] = { dimension, health: "UNKNOWN", basis: "evidence provider failed" };
    }
  };

  await run("api", "api evidence provider", evidence.getApiEvidence?.bind(evidence), (ev) => deriveApiHealth(ev));
  await run("database", "database evidence provider", evidence.getDatabaseEvidence?.bind(evidence), (ev) =>
    deriveDatabaseHealth(ev)
  );
  await run("workers", "worker evidence provider", evidence.getWorkerEvidence?.bind(evidence), (ev) =>
    deriveWorkerHealth(ev)
  );
  await run("scheduler", "scheduler evidence provider", evidence.getSchedulerEvidence?.bind(evidence), (ev) =>
    deriveSchedulerHealth(ev)
  );
  await run("queue", "queue evidence provider", evidence.getQueueEvidence?.bind(evidence), (ev) =>
    deriveQueueHealth(ev)
  );
  await run(
    "mission_control",
    "mission-control evidence provider",
    evidence.getMissionControlEvidence?.bind(evidence),
    (ev) => deriveMissionControlHealth(ev)
  );
  await run("callback_processing", "callback evidence provider", evidence.getCallbackEvidence?.bind(evidence), (ev) =>
    deriveCallbackHealth(ev)
  );
  await run(
    "recovery_backlog",
    "recovery backlog evidence provider",
    evidence.getRecoveryBacklogEvidence?.bind(evidence),
    (ev) => deriveRecoveryBacklogHealth(ev)
  );
  await run("backup_freshness", "backup evidence provider", evidence.getBackupEvidence?.bind(evidence), (ev) =>
    deriveBackupHealth(ev)
  );
  await run(
    "security_controls",
    "security evidence provider",
    evidence.getSecurityEvidence?.bind(evidence),
    (ev) => deriveSecurityControlsHealth(ev)
  );
  await run(
    "deployment_version",
    "deployment version evidence",
    async () => ({ releaseVersionKnown: deps.releaseVersion !== null }),
    (ev) => deriveDeploymentVersionHealth(ev)
  );
  // Providers aggregate separately (five-class vocabulary).
  if (evidence.getProviderEvidence) {
    try {
      const rows = await evidence.getProviderEvidence(now);
      if (rows === null || rows.length === 0) {
        out.providers = { dimension: "providers", health: "UNKNOWN", basis: "no provider telemetry" };
      } else {
        const mapped = rows.map((row) => deriveProviderHealth(row.evidence).platformEquivalent);
        let worst: DimensionHealth["health"] = "HEALTHY";
        for (const cls of mapped) {
          if (cls === "UNAVAILABLE") worst = "UNAVAILABLE";
          else if (cls === "DEGRADED" && worst !== "UNAVAILABLE") worst = "DEGRADED";
          else if (cls === "UNKNOWN" && worst === "HEALTHY") worst = "UNKNOWN";
        }
        out.providers = { dimension: "providers", health: worst, basis: "provider evidence provider" };
      }
    } catch {
      out.providers = { dimension: "providers", health: "UNKNOWN", basis: "provider evidence provider failed" };
    }
  } else {
    out.providers = { dimension: "providers", health: "UNKNOWN", basis: "no evidence provider bound" };
  }
  return out;
}

/**
 * Derive + persist the current platform health observation per dimension.
 * Evidence-derived only; no caller can set health.
 */
export async function observePlatformHealth(
  deps: ObservabilityServiceDeps
): Promise<PlatformHealth & { readonly observedAt: string; readonly releaseVersion: string | null }> {
  const now = deps.now();
  const dimensions = await gatherDimensionEvidence(deps, now);
  const platform = derivePlatformHealth(dimensions);
  const observedAt = now.toISOString();

  for (const dimension of HEALTH_DIMENSIONS) {
    const entry = platform.dimensions[dimension];
    const evidenceSummary = {
      health: entry.health,
      basis: entry.basis,
      environment: deps.environment,
    };
    const evidenceHash = hashHealthEvidence(evidenceSummary);
    const observationId = deriveHealthObservationId({
      environment: deps.environment,
      dimension,
      service: "platform",
      evidenceHash,
      observedAt,
    });
    await insertServiceHealthObservation(
      {
        observationId,
        environment: deps.environment,
        dimension,
        service: "platform",
        healthClass: entry.health,
        evidenceSummary,
        unknownInputs: platform.unknownDimensions,
        evidenceHash,
        observedAt,
        releaseVersion: deps.releaseVersion,
        version: 1,
      },
      deps.executor
    );
  }
  return { ...platform, observedAt, releaseVersion: deps.releaseVersion };
}

// ─── Read-only surfaces ───

function assertIncidentAccess(principal: ObservabilityPrincipal, incident: { tenantId: number | null }): void {
  if (principal.isAdmin) return;
  if (incident.tenantId === null || incident.tenantId !== principal.userId) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_TENANT_SCOPE_MISMATCH",
      "incident is outside the caller's tenant scope."
    );
  }
}

export async function getOperationalTimeline(
  deps: ObservabilityServiceDeps,
  principal: ObservabilityPrincipal,
  input: {
    readonly eventType?: OperationalTelemetryEvent["eventType"];
    readonly correlationId?: string;
    readonly fromOccurredAt?: string | null;
    readonly toOccurredAt?: string | null;
    readonly scope?: "self" | "platform" | "all";
    readonly businessId?: number;
    readonly limit?: number;
  }
): Promise<{ readonly events: OperationalEventRecord[]; readonly truncated: boolean }> {
  const scope = input.scope ?? "self";
  if (scope === "platform" && !principal.isAdmin) {
    throw new ObservabilityInputError("OBSERVABILITY_TENANT_SCOPE_MISMATCH", "platform-scope reads require admin.");
  }
  const tenantId = scope === "all" ? undefined : scope === "platform" ? null : principal.userId;
  const limit = Math.min(input.limit ?? 100, 500);
  const events = await listOperationalEvents(
    {
      eventType: input.eventType,
      correlationId: input.correlationId,
      fromOccurredAt: input.fromOccurredAt ?? undefined,
      toOccurredAt: input.toOccurredAt ?? undefined,
      tenantId,
      businessId: input.businessId,
    },
    [desc("occurredAt"), desc("eventId")],
    limit + 1,
    deps.executor
  );
  return { events: events.slice(0, limit), truncated: events.length > limit };
}

export async function listActiveIncidents(
  deps: ObservabilityServiceDeps,
  principal: ObservabilityPrincipal,
  input: { readonly scope?: string; readonly service?: string; readonly status?: string; readonly businessId?: number; readonly limit?: number }
) {
  const requestedScope = input.scope;
  if (requestedScope === "PLATFORM" && !principal.isAdmin) {
    throw new ObservabilityInputError("OBSERVABILITY_TENANT_SCOPE_MISMATCH", "platform-scope incident reads require admin.");
  }
  const tenantId = principal.isAdmin ? undefined : principal.userId;
  const limit = Math.min(input.limit ?? 100, 200);
  const incidents = await listOperationalIncidents(
    {
      tenantId,
      businessId: input.businessId,
      scope: requestedScope,
      service: input.service,
      status: input.status,
    },
    limit + 1,
    deps.executor
  );
  // "Active" = non-terminal unless the caller asked for an explicit status.
  const filtered = input.status
    ? incidents
    : incidents.filter((incident) => !isTerminalIncidentStatus(incident.status as IncidentStatus));
  return { incidents: filtered.slice(0, limit), truncated: incidents.length > limit };
}

export async function getIncident(
  deps: ObservabilityServiceDeps,
  principal: ObservabilityPrincipal,
  input: { readonly incidentId: string }
) {
  const incident = await findOperationalIncident(input.incidentId, deps.executor);
  if (!incident) {
    throw new ObservabilityInputError("OBSERVABILITY_INCIDENT_NOT_FOUND", `incident ${input.incidentId} not found.`);
  }
  assertIncidentAccess(principal, incident);
  const lifecycle = await listIncidentLifecycleEvents(input.incidentId, deps.executor);
  return { incident, lifecycle };
}

export async function listAlerts(
  deps: ObservabilityServiceDeps,
  principal: ObservabilityPrincipal,
  input: { readonly status?: AlertStatus; readonly severity?: string; readonly ruleId?: string; readonly limit?: number }
) {
  if (!principal.isAdmin) {
    throw new ObservabilityInputError("OBSERVABILITY_TENANT_SCOPE_MISMATCH", "alert reads require admin (operator).");
  }
  const alerts = await listOperationalAlerts(
    { status: input.status, severity: input.severity, ruleId: input.ruleId },
    Math.min(input.limit ?? 100, 200),
    deps.executor
  );
  return { alerts, truncated: false };
}

export interface SloMeasurementSet {
  readonly observedAt: string;
  readonly measurements: readonly MeasurementBasis[];
}

/** SLO measurement foundation over the bound evidence providers (E16). */
export async function getSloMeasurements(deps: ObservabilityServiceDeps): Promise<SloMeasurementSet> {
  const now = deps.now();
  const evidence = deps.evidence ?? {};
  const measurements: MeasurementBasis[] = [];

  const api = evidence.getApiEvidence ? await evidence.getApiEvidence(now).catch(() => null) : null;
  measurements.push(
    measureApiAvailability({
      totalRequests: api && api.requestsObserved ? 1 : 0,
      failedRequests:
        api && typeof api.errorRatePct === "number" && api.errorRatePct >= 50 ? 1 : 0,
    }),
    measureApiLatency(api && typeof api.p50LatencyMs === "number" ? [api.p50LatencyMs] : [])
  );
  const workers = evidence.getWorkerEvidence ? await evidence.getWorkerEvidence(now).catch(() => null) : null;
  measurements.push(
    measureWorkerHeartbeatFreshness({
      lastHeartbeatAgeMs: workers ? workers.lastHeartbeatAgeMs : null,
      maxAgeMs: 120_000,
    }),
    measureQueueLag(workers && workers.queueBacklogHigh ? 1 : null)
  );
  const db = evidence.getDatabaseEvidence ? await evidence.getDatabaseEvidence(now).catch(() => null) : null;
  measurements.push(
    measureDbLatency(db && typeof db.p50LatencyMs === "number" ? [db.p50LatencyMs] : []),
    measureDeadlockRate({
      transactionsObserved: db && typeof db.transactionFailureCount === "number" ? 1 : 0,
      deadlocksObserved: db && typeof db.deadlockCount === "number" ? db.deadlockCount : 0,
    })
  );
  const mc = evidence.getMissionControlEvidence ? await evidence.getMissionControlEvidence(now).catch(() => null) : null;
  measurements.push(
    measureExecutionUncertaintyRate({
      classifiedResults: mc && mc.telemetryObserved ? mc.uncertainActions + mc.failedActions + 1 : 0,
      uncertainResults: mc ? mc.uncertainActions : 0,
    })
  );
  const providers = evidence.getProviderEvidence ? await evidence.getProviderEvidence(now).catch(() => null) : null;
  const timedOut = providers ? providers.filter((p) => p.evidence.timeoutRatePct !== null).length : 0;
  measurements.push(
    measureProviderTimeoutRate({
      providerRequests: providers ? providers.length : 0,
      timedOutRequests: timedOut,
    })
  );
  const callback = evidence.getCallbackEvidence ? await evidence.getCallbackEvidence(now).catch(() => null) : null;
  measurements.push(measureCallbackDelay(callback ? callback.oldestUnprocessedAgeMs : null));
  const recovery = evidence.getRecoveryBacklogEvidence
    ? await evidence.getRecoveryBacklogEvidence(now).catch(() => null)
    : null;
  measurements.push(measureRecoveryBacklog(recovery ? recovery.openCandidateCount : null));
  const backup = evidence.getBackupEvidence ? await evidence.getBackupEvidence(now).catch(() => null) : null;
  measurements.push(measureBackupFreshness(backup ? backup.lastBackupAgeMs : null));
  measurements.push(measureIncidentDetectionDelay([]));

  return { observedAt: now.toISOString(), measurements };
}

export { listServiceHealthObservations };

/** Governed operator alert transitions (audited; admin at the router). */
export async function applyAlertTransition(
  deps: ObservabilityServiceDeps,
  principal: ObservabilityPrincipal,
  input: { readonly alertId: string; readonly toStatus: "ACKNOWLEDGED" | "RESOLVED"; readonly reason: string }
): Promise<{ readonly alertId: string; readonly fromStatus: string; readonly toStatus: string }> {
  const alert = await findOperationalAlert(input.alertId, deps.executor);
  if (!alert) {
    throw new ObservabilityInputError("OBSERVABILITY_ALERT_NOT_FOUND", `alert ${input.alertId} not found.`);
  }
  if (alert.status === input.toStatus) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INVALID_INPUT",
      `alert is already ${input.toStatus}; self-transitions are not permitted.`
    );
  }
  if (alert.status === "RESOLVED") {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INVALID_INPUT",
      "resolved alerts are immutable; a new occurrence re-arms the identity."
    );
  }
  const updated = await updateAlertState(input.alertId, alert.version, { status: input.toStatus }, deps.executor);
  if (!updated) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_REPLAY_CONFLICT",
      `alert ${input.alertId} changed concurrently; re-read and retry.`
    );
  }
  await emitAudit(deps, {
    eventType: "operational_alert_lifecycle",
    userId: principal.userId,
    artifactId: input.alertId,
    metadata: { fromStatus: alert.status, toStatus: input.toStatus, ruleId: alert.ruleId, reason: input.reason.slice(0, 160) },
  });
  return { alertId: input.alertId, fromStatus: alert.status, toStatus: input.toStatus };
}

export const INCIDENT_READ_MODEL_NOTE =
  "incident lifecycle is append-only: transitions are new icl1: facts; the current status is a CAS-garded projection.";
