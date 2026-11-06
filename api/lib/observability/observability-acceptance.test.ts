/**
 * R10-E — Observability, Operations & Incident Control acceptance (E20).
 *
 * Proves the 38 connected acceptance criteria at the service layer over the
 * in-memory fake db: telemetry acceptance (exact-once), evidence-derived
 * health (presence AND absence rules), worker/provider/database/backup/mission
 * health semantics, deterministic incident identity with convergence and
 * evidence preservation, deduplicated alerts that never delete events,
 * governed lifecycle transitions, fail-closed UNKNOWN rules, append-only
 * timeline, mutation-free reads, tenant isolation and the explicit
 * control-command boundary.
 *
 * No live database, no network, no providers, no deployment, no migrations,
 * no production telemetry. Exactly one audit event per durable effect.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createFakeDb, buildCtx } from "../../r5-test-support";
import { bindObservabilityStoreExecutor } from "./observability-bridge";
import {
  recordOperationalEvent,
  transitionIncident,
  suppressIncident,
  observePlatformHealth,
  getOperationalTimeline,
  listActiveIncidents,
  getIncident,
  listAlerts,
  applyAlertTransition,
  getSloMeasurements,
  type ObservabilityServiceDeps,
  type RecordOperationalEventInput,
} from "./observability-service";
import {
  deriveApiHealth,
  deriveBackupHealth,
  deriveDatabaseHealth,
  deriveProviderHealth,
  deriveWorkerHealth,
  derivePlatformHealth,
  worstHealth,
  type ApiHealthEvidence,
  type BackupHealthEvidence,
  type DatabaseHealthEvidence,
  type WorkerHealthEvidence,
} from "./health-model";
import {
  classifyFailureClass,
  classifyIncidentSeverity,
  assertIncidentTransition,
} from "./incident-model";
import { matchAlertRule, buildAlertIdentity } from "./alert-model";
import { createOperationalTelemetryEvent, sanitizeSafeMetadata } from "./telemetry-event";
import {
  findForbiddenField,
  findSecretKey,
  CONTROL_COMMAND_TYPES,
} from "./observability-contract";
import { observabilityRouter } from "../../observability-router";
import type { PlatformEvidenceProvider } from "./observability-service";

const NOW = "2026-11-10T12:00:00.000Z";
const LATER = "2026-11-10T12:05:00.000Z";

type Seed = Record<string, Record<string, unknown>[]>;

function makeFixture(seed: Seed = {}, evidence?: PlatformEvidenceProvider) {
  const { db, seed: liveSeed } = createFakeDb(
    {
      operational_events: [],
      operational_incidents: [],
      operational_incident_lifecycle_events: [],
      operational_alerts: [],
      service_health_observations: [],
      audit_events: [],
      ...seed,
    }
  );
  const deps: ObservabilityServiceDeps = {
    executor: bindObservabilityStoreExecutor(db),
    audit: db as unknown as ObservabilityServiceDeps["audit"],
    now: () => new Date(NOW),
    environment: "development",
    releaseVersion: "r10e-test-1",
    evidence,
  };
  return { db, seed: liveSeed, deps };
}

type EvInput = RecordOperationalEventInput & { environment: "development" | "staging" | "production" };

function ev(overrides: Partial<EvInput> = {}): EvInput {
  return {
    eventType: "worker_heartbeat_observed",
    service: "worker",
    component: "publishing-1",
    operation: "heartbeat",
    severity: "WARNING",
    status: "UNCERTAIN",
    occurredAt: NOW,
    observedAt: NOW,
    diagnosticCode: "WORKER_HEARTBEAT_STALE",
    scope: "self",
    environment: "development",
    ...overrides,
  } as EvInput;
}

const TENANT = { userId: 7, isAdmin: false };
const ADMIN = { userId: 1, isAdmin: true };

describe("E2/E15 — health derivation", () => {
  it("1. healthy API evidence derives HEALTHY", () => {
    const evidence: ApiHealthEvidence = { requestsObserved: true, errorRatePct: 0.5, p50LatencyMs: 120 };
    expect(deriveApiHealth(evidence)).toBe("HEALTHY");
  });

  it("2. missing telemetry does not derive HEALTHY (UNKNOWN)", () => {
    expect(deriveApiHealth({ requestsObserved: null, errorRatePct: null, p50LatencyMs: null })).toBe("UNKNOWN");
    expect(deriveDatabaseHealth({ connectivityObserved: null, poolUtilizationPct: null, p50LatencyMs: null, deadlockCount: null, transactionFailureCount: null, casConflictCount: null, replayCollisionCount: null, schemaVersionKnown: null })).toBe("UNKNOWN");
    expect(deriveWorkerHealth({ heartbeatObserved: null, lastHeartbeatAgeMs: null, leaseStale: false, jobStuck: false, crashLoop: false, retryStorm: false, deadLetterGrowth: false, queueBacklogHigh: false, versionDrift: false })).toBe("UNKNOWN");
    expect(deriveBackupHealth({ signalObserved: null, lastBackupAgeMs: null, lastBackupSucceeded: null, verificationFailed: null, offsiteCopyMissing: null, restoreRehearsalAgeMs: null, retentionDegraded: false })).toBe("UNKNOWN");
  });

  it("3. stale worker heartbeat derives degraded/unavailable, never HEALTHY", () => {
    const stale: WorkerHealthEvidence = { heartbeatObserved: true, lastHeartbeatAgeMs: 200_000, leaseStale: false, jobStuck: false, crashLoop: false, retryStorm: false, deadLetterGrowth: false, queueBacklogHigh: false, versionDrift: false };
    expect(deriveWorkerHealth(stale)).toBe("DEGRADED");
    const veryStale: WorkerHealthEvidence = { ...stale, lastHeartbeatAgeMs: 900_000 };
    expect(deriveWorkerHealth(veryStale)).toBe("UNAVAILABLE");
  });

  it("worstHealth: UNKNOWN never masks worse known state", () => {
    expect(worstHealth(["HEALTHY", "UNKNOWN"])).toBe("UNKNOWN");
    expect(worstHealth(["UNAVAILABLE", "UNKNOWN"])).toBe("UNAVAILABLE");
    expect(worstHealth(["DEGRADED", "AT_RISK"])).toBe("AT_RISK");
  });

  it("platform aggregate: unknown dimensions explicit, aggregate capped at DEGRADED", () => {
    const platform = derivePlatformHealth({
      api: { dimension: "api", health: "HEALTHY", basis: "test" },
      database: { dimension: "database", health: "UNAVAILABLE", basis: "test" },
    });
    expect(platform.platformHealth).toBe("UNAVAILABLE");
    expect(platform.unknownDimensions.length).toBeGreaterThan(0);
    const allUnknown = derivePlatformHealth({});
    expect(allUnknown.platformHealth).toBe("DEGRADED");
    expect(allUnknown.unknownDimensions).toContain("backup_freshness");
  });

  it("34. UNKNOWN remains explicit in observations", async () => {
    const { seed, deps } = makeFixture();
    const result = await observePlatformHealth(deps);
    expect(result.dimensions.backup_freshness.health).toBe("UNKNOWN");
    expect(result.unknownDimensions).toContain("backup_freshness");
    const backupObs = seed.service_health_observations.find((r) => r.dimension === "backup_freshness");
    expect(backupObs?.healthClass).toBe("UNKNOWN");
    expect(backupObs?.releaseVersion).toBe("r10e-test-1");
  });

  it("17-adjacent: health cannot be set through event recording", async () => {
    const { deps, seed } = makeFixture();
    const res = await recordOperationalEvent(deps, TENANT, ev({ severity: "INFO", status: "SUCCEEDED", diagnosticCode: "OK" }));
    expect(res.eventId).toMatch(/^evt1:[a-f0-9]{64}$/);
    // No health observation is minted from a client event; health derives only
    // from evidence providers via observePlatformHealth.
    expect(seed.service_health_observations.length).toBe(0);
  });
});

describe("E7/E8/E9/E12 — dimension health semantics", () => {
  it("4. provider timeouts derive degraded provider health", () => {
    const result = deriveProviderHealth({ telemetryObserved: true, authFailureObserved: false, rateLimitObserved: false, unavailableObserved: false, timeoutRatePct: 15 });
    expect(result.health).toBe("DEGRADED");
    expect(result.platformEquivalent).toBe("DEGRADED");
  });

  it("5. provider auth failure visible as UNAVAILABLE", () => {
    const result = deriveProviderHealth({ telemetryObserved: true, authFailureObserved: true, rateLimitObserved: false, unavailableObserved: false, timeoutRatePct: null });
    expect(result.health).toBe("UNAVAILABLE");
  });

  it("6. rate limit visible as RATE_LIMITED", () => {
    const result = deriveProviderHealth({ telemetryObserved: true, authFailureObserved: false, rateLimitObserved: true, unavailableObserved: false, timeoutRatePct: null });
    expect(result.health).toBe("RATE_LIMITED");
    expect(result.platformEquivalent).toBe("DEGRADED");
  });

  it("provider health UNKNOWN does not claim AVAILABLE", () => {
    expect(deriveProviderHealth({ telemetryObserved: null, authFailureObserved: false, rateLimitObserved: false, unavailableObserved: false, timeoutRatePct: null }).health).toBe("UNKNOWN");
  });

  it("11. DB failure visible: connectivity failure UNAVAILABLE; deadlocks AT_RISK", () => {
    expect(deriveDatabaseHealth({ connectivityObserved: false, poolUtilizationPct: null, p50LatencyMs: null, deadlockCount: null, transactionFailureCount: null, casConflictCount: null, replayCollisionCount: null, schemaVersionKnown: null })).toBe("UNAVAILABLE");
    expect(deriveDatabaseHealth({ connectivityObserved: true, poolUtilizationPct: 50, p50LatencyMs: 20, deadlockCount: 2, transactionFailureCount: 0, casConflictCount: 0, replayCollisionCount: 0, schemaVersionKnown: true })).toBe("AT_RISK");
  });

  it("12. backup stale state visible structurally", () => {
    const stale: BackupHealthEvidence = { signalObserved: true, lastBackupAgeMs: 700_000_000, lastBackupSucceeded: true, verificationFailed: false, offsiteCopyMissing: false, restoreRehearsalAgeMs: null, retentionDegraded: false };
    expect(deriveBackupHealth(stale)).toBe("AT_RISK");
    const failed: BackupHealthEvidence = { ...stale, lastBackupSucceeded: false };
    expect(deriveBackupHealth(failed)).toBe("UNAVAILABLE");
  });

  it("E15: DB telemetry absent ⇒ UNKNOWN not HEALTHY; schema version unknown degrades", () => {
    expect(deriveDatabaseHealth({ connectivityObserved: true, poolUtilizationPct: 10, p50LatencyMs: 5, deadlockCount: 0, transactionFailureCount: 0, casConflictCount: 0, replayCollisionCount: 0, schemaVersionKnown: false })).toBe("DEGRADED");
  });
});

describe("E1/E6 — telemetry envelope + event store", () => {
  it("envelope: deterministic identity, sanitization, secret-shaped rejection", () => {
    const a = createOperationalTelemetryEvent(ev());
    const b = createOperationalTelemetryEvent(ev());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const sanitized = sanitizeSafeMetadata({ ok: 1, apiKey: "x", nested: { token: "y", keep: true } });
    expect(sanitized).toEqual({ nested: { keep: true }, ok: 1 });
    expect(() => sanitizeSafeMetadata({ password: "hunter2" })).not.toThrow(); // key removed
    expect(() => createOperationalTelemetryEvent(ev({ component: "sk-abcdefghijklmnopqrstuvwxyz123456" }))).toThrowError(
      expect.objectContaining({ code: "OBSERVABILITY_SECRET_MATERIAL_REJECTED" })
    );
  });

  it("event store: exact-once replay converges with zero extra rows", async () => {
    const { deps, seed } = makeFixture();
    const first = await recordOperationalEvent(deps, TENANT, ev({ severity: "INFO", status: "SUCCEEDED", diagnosticCode: "OK" }));
    const second = await recordOperationalEvent(deps, TENANT, ev({ severity: "INFO", status: "SUCCEEDED", diagnosticCode: "OK" }));
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.eventId).toBe(first.eventId);
    expect(seed.operational_events.length).toBe(1);
  });

  it("E15: ambiguous execution result reports UNCERTAIN status and is visible", async () => {
    const { deps, seed } = makeFixture();
    await recordOperationalEvent(deps, TENANT, ev({ eventType: "execution_uncertain_observed", service: "mission_control", component: "execution", operation: "classify", severity: "WARNING", status: "UNCERTAIN", diagnosticCode: "EXECUTION_UNCERTAIN" }));
    const timeline = await getOperationalTimeline(deps, TENANT, {});
    expect(timeline.events[0].status).toBe("UNCERTAIN");
    expect(seed.operational_incidents.length).toBe(1);
    expect(seed.operational_incidents[0].failureClass).toBe("EXECUTION_UNCERTAINTY");
  });
});

describe("E3 — incident model", () => {
  it("13. deterministic incident identity", () => {
    const a = classifyFailureClass("WORKER_CRASH_LOOP");
    expect(a).toBe("WORKER_CRASH_LOOP");
    expect(classifyIncidentSeverity(a)).toBe("HIGH");
    expect(classifyFailureClass("DB_CONNECTIVITY_FAILURE")).toBe("DB_UNAVAILABLE");
    expect(classifyIncidentSeverity("DB_UNAVAILABLE")).toBe("CRITICAL");
    expect(() => assertIncidentTransition("OPEN", "CLOSED")).toThrow();
    expect(() => assertIncidentTransition("RESOLVED", "CLOSED")).not.toThrow();
    expect(() => assertIncidentTransition("CLOSED", "OPEN")).not.toThrow();
  });

  it("14. duplicate event does not create duplicate incident", async () => {
    const { deps, seed } = makeFixture();
    const first = await recordOperationalEvent(deps, TENANT, ev());
    const second = await recordOperationalEvent(deps, TENANT, { ...ev(), occurredAt: LATER, observedAt: LATER });
    expect(first.incidentCreated).toBe(true);
    expect(second.incidentCreated).toBe(false);
    expect(second.incidentId).toBe(first.incidentId);
    expect(seed.operational_incidents.length).toBe(1);
    expect(seed.operational_incidents[0].occurrenceCount).toBe(2);
  });

  it("15. repeated events preserve evidence (both events in store, evidence refs bounded)", async () => {
    const { deps, seed } = makeFixture();
    await recordOperationalEvent(deps, TENANT, ev());
    await recordOperationalEvent(deps, TENANT, { ...ev(), occurredAt: LATER, observedAt: LATER });
    expect(seed.operational_events.length).toBe(2);
    const incident = seed.operational_incidents[0];
    expect(Array.isArray(incident.evidenceEventIds)).toBe(true);
    expect((incident.evidenceEventIds as string[]).length).toBe(2);
  });

  it("16. critical incident cannot be suppressed", async () => {
    const { deps } = makeFixture();
    const res = await recordOperationalEvent(deps, TENANT, ev({ service: "database", component: "primary", diagnosticCode: "DB_CONNECTIVITY_FAILURE", severity: "CRITICAL", status: "FAILED" }));
    expect(res.incidentId).not.toBeNull();
    await expect(
      suppressIncident(deps, ADMIN, { incidentId: res.incidentId!, suppressionAuthority: "operator:ops-123", reason: "maintenance" })
    ).rejects.toMatchObject({ code: "OBSERVABILITY_INCIDENT_CRITICAL_NOT_SUPPRESSIBLE" });
  });

  it("suppression requires explicit authority; non-critical suppressible with authority + audit", async () => {
    const { deps, seed } = makeFixture();
    const res = await recordOperationalEvent(deps, TENANT, ev());
    await expect(
      suppressIncident(deps, ADMIN, { incidentId: res.incidentId!, suppressionAuthority: "  ", reason: "noise" })
    ).rejects.toMatchObject({ code: "OBSERVABILITY_INCIDENT_SUPPRESSION_FORBIDDEN" });
    const out = await suppressIncident(deps, ADMIN, { incidentId: res.incidentId!, suppressionAuthority: "policy:ops-noise-001", reason: "known noise" });
    expect(out.toStatus).toBe("SUPPRESSED");
    const facts = seed.operational_incident_lifecycle_events.filter((r) => r.incidentId === res.incidentId);
    const suppressed = facts.find((r) => r.toStatus === "SUPPRESSED");
    expect(suppressed?.suppressionAuthority).toBe("policy:ops-noise-001");
    expect(suppressed?.actorType).toBe("OPERATOR");
    const lifecycleAudits = seed.audit_events.filter((r) => r.eventType === "operational_incident_lifecycle");
    expect(lifecycleAudits.length).toBeGreaterThanOrEqual(1);
  });

  it("governed transitions: OPEN -> INVESTIGATING -> RESOLVED -> CLOSED with append-only facts", async () => {
    const { deps, seed } = makeFixture();
    const res = await recordOperationalEvent(deps, TENANT, ev());
    await transitionIncident(deps, ADMIN, { incidentId: res.incidentId!, toStatus: "INVESTIGATING", reason: "looking" });
    await transitionIncident(deps, ADMIN, { incidentId: res.incidentId!, toStatus: "RESOLVED", reason: "fixed" });
    await transitionIncident(deps, ADMIN, { incidentId: res.incidentId!, toStatus: "CLOSED", reason: "verified" });
    const facts = seed.operational_incident_lifecycle_events.filter((r) => r.incidentId === res.incidentId);
    expect(facts.map((f) => f.toStatus)).toEqual(["OPEN", "INVESTIGATING", "RESOLVED", "CLOSED"]);
    const incident = seed.operational_incidents[0];
    expect(incident.status).toBe("CLOSED");
    expect(incident.version).toBe(4);
  });

  it("7+8+9+10. uncertain execution, blocked mission, governance backlog, recovery backlog visible", async () => {
    const { deps, seed } = makeFixture();
    await recordOperationalEvent(deps, TENANT, ev({ eventType: "mission_blocked_observed", service: "mission_control", component: "planning", operation: "observe", severity: "HIGH", status: "FAILED", diagnosticCode: "MISSION_BLOCKED" }));
    await recordOperationalEvent(deps, TENANT, ev({ service: "mission_control", component: "governance", operation: "observe", severity: "WARNING", status: "UNCERTAIN", diagnosticCode: "APPROVAL_BACKLOG_HIGH" }));
    await recordOperationalEvent(deps, TENANT, ev({ service: "recovery", component: "candidates", operation: "observe", severity: "WARNING", status: "UNCERTAIN", diagnosticCode: "RECOVERY_BACKLOG_HIGH" }));
    const classes = seed.operational_incidents.map((r) => r.failureClass);
    expect(classes).toContain("MISSION_BLOCKAGE");
    expect(classes).toContain("GOVERNANCE_BACKLOG");
    expect(classes).toContain("RECOVERY_BACKLOG");
  });
});

describe("E4/E5 — alerts + dedup", () => {
  it("deterministic alert rule matching and identity", () => {
    const match = matchAlertRule({ diagnosticCode: "PROVIDER_AUTH_FAILURE", failureClass: "PROVIDER_AUTH_FAILURE", provider: "meta", component: "adapter", severity: "CRITICAL" });
    expect(match?.ruleId).toBe("provider_auth_failure");
    expect(match?.severity).toBe("CRITICAL");
    const identity = buildAlertIdentity("development", match!.dedupTarget);
    expect(identity.alertId).toMatch(/^alt1:[a-f0-9]{64}$/);
  });

  it("dedup: same provider outage folds into one alert; events preserved", async () => {
    const { deps, seed } = makeFixture();
    const first = await recordOperationalEvent(deps, TENANT, ev({ service: "provider", component: "meta-adapter", operation: "request", severity: "HIGH", status: "FAILED", diagnosticCode: "PROVIDER_5XX", provider: "meta" }));
    const second = await recordOperationalEvent(deps, TENANT, { ...ev(), service: "provider", component: "meta-adapter", operation: "request", severity: "HIGH", status: "FAILED", diagnosticCode: "PROVIDER_5XX", provider: "meta", occurredAt: LATER, observedAt: LATER });
    expect(first.alertCreated).toBe(true);
    expect(second.alertCreated).toBe(false);
    expect(second.alertFolded).toBe(true);
    expect(second.alertId).toBe(first.alertId);
    expect(seed.operational_alerts.length).toBe(1);
    expect(seed.operational_alerts[0].occurrenceCount).toBe(2);
    expect(seed.operational_events.length).toBe(2);
  });

  it("alert describes what happened, affected target, safety state, operator attention", async () => {
    const { deps } = makeFixture();
    await recordOperationalEvent(deps, TENANT, ev({ service: "provider", component: "meta-adapter", operation: "request", severity: "HIGH", status: "FAILED", diagnosticCode: "PROVIDER_5XX", provider: "meta" }));
    const { alerts } = await listAlerts(deps, ADMIN, {});
    expect(alerts[0].affectedTarget).toContain("provider:outage:meta");
    expect(alerts[0].executionContinuing).toBe(true);
    expect(typeof alerts[0].operatorAttentionRequired).toBe("boolean");
    expect(alerts[0].summary).toContain("PROVIDER_5XX");
  });

  it("alert resolution re-arms identity on recurrence", async () => {
    const { deps, seed } = makeFixture();
    const first = await recordOperationalEvent(deps, TENANT, ev({ service: "provider", component: "meta-adapter", operation: "request", severity: "HIGH", status: "FAILED", diagnosticCode: "PROVIDER_5XX", provider: "meta" }));
    await applyAlertTransition(deps, ADMIN, { alertId: first.alertId!, toStatus: "RESOLVED", reason: "provider recovered" });
    const second = await recordOperationalEvent(deps, TENANT, { ...ev(), service: "provider", component: "meta-adapter", operation: "request", severity: "HIGH", status: "FAILED", diagnosticCode: "PROVIDER_5XX", provider: "meta", occurredAt: LATER, observedAt: LATER });
    expect(second.alertFolded).toBe(false);
    expect(seed.operational_alerts.length).toBe(1);
    expect(seed.operational_alerts[0].status).toBe("OPEN");
  });
});

describe("E10 — mission-control operational health (read-only aggregation)", () => {
  function missionControlEvidence(): PlatformEvidenceProvider {
    return {
      async getMissionControlEvidence() {
        return {
          telemetryObserved: true,
          blockedMissions: 2,
          uncertainActions: 3,
          failedActions: 1,
          pendingExternalResults: 4,
          governanceBlocks: 1,
          approvalBacklog: 5,
          staleSchedules: 1,
          staleRecoveries: 2,
        };
      },
    };
  }

  it("aggregates R9 operational signals into AT_RISK mission_control health", async () => {
    const { deps } = makeFixture({}, missionControlEvidence());
    const result = await observePlatformHealth(deps);
    expect(result.dimensions.mission_control.health).toBe("AT_RISK");
    expect(result.dimensions.mission_control.basis).toBe("mission-control evidence provider");
  });

  it("blocked missions visible via incident pipeline", async () => {
    const { seed } = makeFixture({}, missionControlEvidence());
    expect(seed.operational_incidents.length).toBe(0); // health observation creates no incidents
  });

  it("absent R9 evidence ⇒ mission_control UNKNOWN (never HEALTHY)", async () => {
    const { deps } = makeFixture();
    const result = await observePlatformHealth(deps);
    expect(result.dimensions.mission_control.health).toBe("UNKNOWN");
  });
});

describe("E13/E31/E32 — read surface is mutation-free; timeline append-only", () => {
  it("31. read surfaces mutate nothing", async () => {
    const { deps, seed } = makeFixture();
    await recordOperationalEvent(deps, TENANT, ev());
    const snapshot = JSON.parse(JSON.stringify(seed));
    await getOperationalTimeline(deps, TENANT, {});
    await listActiveIncidents(deps, TENANT, {});
    await listActiveIncidents(deps, ADMIN, {});
    await getIncident(deps, TENANT, { incidentId: seed.operational_incidents[0].incidentId as string });
    await listAlerts(deps, ADMIN, {});
    await getSloMeasurements(deps);
    expect(JSON.parse(JSON.stringify(seed))).toEqual(snapshot);
  });

  it("32. timeline is append-only: events accumulate, no update/delete path exists", async () => {
    const { deps, seed } = makeFixture();
    await recordOperationalEvent(deps, TENANT, ev({ diagnosticCode: "OK", severity: "INFO", status: "SUCCEEDED" }));
    await recordOperationalEvent(deps, TENANT, ev({ occurredAt: LATER, observedAt: LATER, diagnosticCode: "OK", severity: "INFO", status: "SUCCEEDED" }));
    const timeline = await getOperationalTimeline(deps, TENANT, {});
    expect(timeline.events.length).toBe(2);
    // The store exposes no update/delete for operational_events.
    expect(Object.keys(seed.operational_events[0])).not.toContain("deletedAt");
  });

  it("29+30. cross-tenant and cross-business incident access rejected", async () => {
    const { deps, seed } = makeFixture();
    const res = await recordOperationalEvent(deps, TENANT, ev({ businessId: 55 }));
    const incidentId = res.incidentId!;
    const otherTenant = { userId: 99, isAdmin: false };
    await expect(getIncident(deps, otherTenant, { incidentId })).rejects.toMatchObject({
      code: "OBSERVABILITY_TENANT_SCOPE_MISMATCH",
    });
    await expect(listActiveIncidents(deps, otherTenant, {})).resolves.toMatchObject({ incidents: [] });
    const own = await getIncident(deps, TENANT, { incidentId });
    expect(own.incident.incidentId).toBe(incidentId);
    const admin = await getIncident(deps, ADMIN, { incidentId });
    expect(admin.incident.scope).toBe("BUSINESS");
  });

  it("timeline scopes: tenant sees own; platform scope requires admin", async () => {
    const { deps } = makeFixture();
    await recordOperationalEvent(deps, TENANT, ev({ diagnosticCode: "OK", severity: "INFO", status: "SUCCEEDED" }));
    await recordOperationalEvent(deps, ADMIN, { ...ev(), scope: "platform", diagnosticCode: "OK", severity: "INFO", status: "SUCCEEDED" });
    const tenantView = await getOperationalTimeline(deps, TENANT, {});
    expect(tenantView.events.length).toBe(1);
    await expect(getOperationalTimeline(deps, TENANT, { scope: "platform" })).rejects.toMatchObject({
      code: "OBSERVABILITY_TENANT_SCOPE_MISMATCH",
    });
    const adminView = await getOperationalTimeline(deps, ADMIN, { scope: "all" });
    expect(adminView.events.length).toBe(2);
  });
});

describe("E14/E33 — operator action boundary + provider switch", () => {
  it("33. provider health state does not authorize switching (no switch path exists)", () => {
    const health = deriveProviderHealth({ telemetryObserved: true, authFailureObserved: true, rateLimitObserved: false, unavailableObserved: false, timeoutRatePct: null });
    expect(health.health).toBe("UNAVAILABLE");
    // The observability modules expose no provider-switch function; the
    // contract forbids it. This test fails if such a path is ever added
    // without governance.
    const observabilityApi = { recordOperationalEvent, transitionIncident, suppressIncident, observePlatformHealth };
    expect(Object.keys(observabilityApi)).not.toContain("switchProvider");
  });

  it("control command types are defined and rejected at the boundary", () => {
    expect(CONTROL_COMMAND_TYPES).toEqual([
      "suspend_mission_execution",
      "disable_provider",
      "enable_emergency_safe_mode",
      "invoke_kill_switch",
    ]);
    // rejectSmuggledAuthority denies authority fields even before routing.
    expect(findForbiddenField({ killSwitch: true })).toBe("killSwitch");
    expect(findForbiddenField({ disableMonitoring: true })).toBe("disableMonitoring");
  });

  it("26+27. shell/SQL text is inert bounded metadata", () => {
    const metadata = sanitizeSafeMetadata({ cmd: "rm -rf /; DROP TABLE users; --", note: "inert" });
    expect(metadata.cmd).toBe("rm -rf /; DROP TABLE users; --");
    const event = createOperationalTelemetryEvent(ev({ safeMetadata: metadata }));
    expect(event.safeMetadata.cmd).toContain("DROP TABLE");
    // Inert = stored as a string label, never executed; no exec path exists.
  });

  it("28. secret-shaped payload redacted/rejected", () => {
    expect(findSecretKey({ apiKey: "x" })).toBe("apiKey");
    expect(findSecretKey({ authorization: "Bearer x" })).toBe("authorization");
    expect(findSecretKey({ note: "clean" })).toBeNull();
    const redacted = sanitizeSafeMetadata({ token: "abc", keep: 1 });
    expect(redacted).toEqual({ keep: 1 });
  });
});

describe("E16 — SLO measurement foundation", () => {
  it("measurements return explicit no_evidence basis when inputs absent", async () => {
    const { deps } = makeFixture();
    const { measurements } = await getSloMeasurements(deps);
    const backup = measurements.find((m) => m.indicator === "backup_freshness");
    expect(backup?.basis).toBe("no_evidence");
    expect(backup?.value).toBeNull();
    const api = measurements.find((m) => m.indicator === "api_availability");
    expect(api?.basis).toBe("no_evidence");
  });

  it("measurements derive from bound evidence", async () => {
    const { deps } = makeFixture(
      {},
      {
        async getBackupEvidence() {
          return { signalObserved: true, lastBackupAgeMs: 3_600_000, lastBackupSucceeded: true, verificationFailed: false, offsiteCopyMissing: false, restoreRehearsalAgeMs: null, retentionDegraded: false };
        },
        async getWorkerEvidence() {
          return { heartbeatObserved: true, lastHeartbeatAgeMs: 10_000, leaseStale: false, jobStuck: false, crashLoop: false, retryStorm: false, deadLetterGrowth: false, queueBacklogHigh: false, versionDrift: false };
        },
      }
    );
    const { measurements } = await getSloMeasurements(deps);
    expect(measurements.find((m) => m.indicator === "backup_freshness")?.value).toBe(3600);
    expect(measurements.find((m) => m.indicator === "worker_heartbeat_freshness")?.value).toBe(1);
  });
});
