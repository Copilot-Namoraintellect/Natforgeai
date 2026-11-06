// ─── R10-E Observability, Operations & Incident Control — tRPC router ───
//
// Operator read surface + governed observability writes. Every input is
// z.strictObject: clients name bounded material only — never identity, health,
// state, severity outcomes, suppression authority or any execution/recovery/
// governance authority field.
//
// Read endpoints are mutation-free. Incident/alert lifecycle commands are
// explicit, admin-gated and audited. Control commands (suspend mission
// execution, disable provider, emergency safe mode, kill switch) are defined
// for the future R10-H/R10-X governed command boundary and explicitly
// rejected here — observability can never become a control plane by accident.
//
// This router authorizes nothing and executes nothing.

import { authedQuery, adminQuery, createRouter } from "./middleware";
import { getDb } from "./queries/connection";
import {
  acknowledgeAlertSchema,
  closeIncidentInputSchema,
  controlCommandSchema,
  findForbiddenField,
  findSecretKey,
  getIncidentSchema,
  getOperationalTimelineSchema,
  listActiveIncidentsSchema,
  listOperationalAlertsSchema,
  listServiceHealthSchema,
  recordOperationalEventSchema,
  resolveAlertSchema,
  suppressIncidentInputSchema,
  transitionIncidentSchema,
  CONTROL_COMMAND_TYPES,
  HEALTH_DIMENSIONS,
  SLO_INDICATORS,
  ObservabilityInputError,
} from "./lib/observability/observability-contract";
import {
  applyAlertTransition,
  getIncident,
  getOperationalTimeline,
  getSloMeasurements,
  listActiveIncidents,
  listAlerts,
  observePlatformHealth,
  recordOperationalEvent,
  suppressIncident,
  transitionIncident,
  type ObservabilityPrincipal,
  type ObservabilityServiceDeps,
} from "./lib/observability/observability-service";
import { listServiceHealthObservations } from "./lib/observability/observability-store";
import {
  assertBusinessOwnership,
  bindObservabilityStoreExecutor,
  createDefaultObservabilityEvidenceProvider,
  resolveObservabilityEnvironment,
  resolveObservabilityReleaseVersion,
  type ObservabilityBridgeDb,
} from "./lib/observability/observability-bridge";

function rejectSmuggledAuthority(input: Record<string, unknown>): void {
  const forbidden = findForbiddenField(input);
  if (forbidden) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_CLIENT_AUTHORITY_FIELD_FORBIDDEN",
      `client-supplied authority field "${forbidden}" is forbidden.`
    );
  }
  const secretKey = findSecretKey(input);
  if (secretKey) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_SECRET_MATERIAL_REJECTED",
      `secret-shaped key "${secretKey}" is rejected.`
    );
  }
}

function buildDeps(): ObservabilityServiceDeps {
  const db = getDb() as unknown as ObservabilityBridgeDb;
  return {
    executor: bindObservabilityStoreExecutor(db),
    audit: getDb(),
    now: () => new Date(),
    environment: resolveObservabilityEnvironment(),
    releaseVersion: resolveObservabilityReleaseVersion(),
    evidence: createDefaultObservabilityEvidenceProvider(db),
  };
}

function principal(ctx: { user: { id: number; role: string } }): ObservabilityPrincipal {
  return { userId: ctx.user.id, isAdmin: ctx.user.role === "admin" };
}

export const observabilityRouter = createRouter({
  /** Accept one operational telemetry event (exact-once; incident+alert pipelines). */
  recordEvent: authedQuery.input(recordOperationalEventSchema).mutation(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    const deps = buildDeps();
    if (input.businessId != null && input.scope !== "platform") {
      await assertBusinessOwnership(
        getDb() as unknown as ObservabilityBridgeDb,
        ctx.user.id,
        input.businessId
      );
    }
    return recordOperationalEvent(deps, principal(ctx), { ...input, scope: input.scope ?? "self" });
  }),

  /** Read-only operational event timeline (tenant-predicated; admin may read all). */
  getOperationalTimeline: authedQuery.input(getOperationalTimelineSchema).query(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return getOperationalTimeline(buildDeps(), principal(ctx), input);
  }),

  /** Derive + persist current platform health (evidence-derived; admin operator view). */
  getPlatformHealth: adminQuery.query(async () => {
    const result = await observePlatformHealth(buildDeps());
    return { ...result, disclaimers: [OBSERVABILITY_DISCLAIMERS.health, OBSERVABILITY_DISCLAIMERS.authority] };
  }),

  /** Latest persisted per-dimension health observations (read-only). */
  listServiceHealth: adminQuery.input(listServiceHealthSchema).query(async ({ input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    const observations = await listServiceHealthObservations(
      input.environment ? { service: "platform" } : {},
      500,
      bindObservabilityStoreExecutor(getDb())
    );
    return { observations, dimensions: HEALTH_DIMENSIONS };
  }),

  /** Active (non-terminal) incidents — tenant sees its own; admin sees all. */
  listActiveIncidents: authedQuery.input(listActiveIncidentsSchema).query(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return listActiveIncidents(buildDeps(), principal(ctx), input);
  }),

  getIncident: authedQuery.input(getIncidentSchema).query(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return getIncident(buildDeps(), principal(ctx), input);
  }),

  /** Governed operator lifecycle transition (audited). */
  transitionIncident: adminQuery.input(transitionIncidentSchema).mutation(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return transitionIncident(buildDeps(), principal(ctx), input);
  }),

  /** Governed operator closure from RESOLVED (audited). */
  closeIncident: adminQuery.input(closeIncidentInputSchema).mutation(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return transitionIncident(buildDeps(), principal(ctx), { ...input, toStatus: "CLOSED" });
  }),

  /**
   * Authority-bearing suppression (audited). CRITICAL incidents are never
   * suppressible; the authority reference is recorded verbatim.
   */
  suppressIncident: adminQuery.input(suppressIncidentInputSchema).mutation(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return suppressIncident(buildDeps(), principal(ctx), input);
  }),

  /** Dedup'd alert presentation (admin operator view; read-only list). */
  listOperationalAlerts: authedQuery.input(listOperationalAlertsSchema).query(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return listAlerts(buildDeps(), principal(ctx), input);
  }),

  acknowledgeAlert: adminQuery.input(acknowledgeAlertSchema).mutation(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return applyAlertTransition(buildDeps(), principal(ctx), { ...input, toStatus: "ACKNOWLEDGED" });
  }),

  resolveAlert: adminQuery.input(resolveAlertSchema).mutation(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return applyAlertTransition(buildDeps(), principal(ctx), { ...input, toStatus: "RESOLVED" });
  }),

  /** Mission-control operational health rollup (read-only R9 consumption). */
  getMissionControlOperationalHealth: adminQuery.query(async () => {
    const deps = buildDeps();
    const evidence = await deps.evidence?.getMissionControlEvidence?.(deps.now()).catch(() => null);
    return {
      evidence,
      telemetryObserved: evidence !== null,
      note: "R9-E mission-state authority is consumed read-only; this rollup owns no mission state.",
    };
  }),

  /** SLO measurement foundation (no contractual SLA). */
  getSloMeasurements: adminQuery.query(async () => {
    const measurements = await getSloMeasurements(buildDeps());
    return { ...measurements, indicators: SLO_INDICATORS };
  }),

  /**
   * Explicit operator-control boundary (E14): these commands belong to a
   * separate governed command boundary (R10-H/R10-X). They are DEFINED and
   * REJECTED — observability itself remains read-only and can never suspend
   * execution, disable providers, enter safe mode or trip a kill switch.
   */
  controlCommand: authedQuery.input(controlCommandSchema).mutation(async ({ input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    throw new ObservabilityInputError(
      "OBSERVABILITY_CONTROL_COMMAND_NOT_IMPLEMENTED",
      `control command "${input.command}" is outside the observability authority. ` +
        `Control commands (${CONTROL_COMMAND_TYPES.join(", ")}) are owned by the future ` +
        `governed operator-command boundary (R10-H/R10-X); observability remains read-only.`
    );
  }),
});

const OBSERVABILITY_DISCLAIMERS = {
  authority:
    "observability != authority: monitoring observes, classifies, alerts, correlates and recommends operator attention — it never authorizes execution or changes any authority.",
  health: "health is derived from evidence — never set; absence of telemetry means UNKNOWN, never HEALTHY.",
};
