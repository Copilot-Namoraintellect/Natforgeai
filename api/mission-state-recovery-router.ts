// ─── R9-E Mission State, Recovery & Observability — tRPC router ───
//
// Tenant-scoped, authed-only surface. Every input is z.strictObject: clients
// name missions/tasks/candidates and bounded material only — never state,
// health, classifications, decisions, approvals, fingerprints or execution
// authority. The read surface mutates nothing; governed write commands are
// explicit and each persists exactly one audit event per durable effect.
//
// This router authorizes nothing and executes nothing: recovery proposals
// are advisory, recovery authorization is R9-F authority consumed read-only
// through the frozen gate, and execution is handed back to R9-D.

import { authedQuery, createRouter } from "./middleware";
import {
  bindRecoveryGovernanceSchema,
  cancelRecoverySchema,
  consumeRecoverySchema,
  findForbiddenField,
  findSecretKey,
  getMissionControlHandoffSchema,
  getMissionHealthSchema,
  getOperationalTimelineSchema,
  getRecoveryCandidateSchema,
  getMissionStateSchema,
  listExecutionAttemptsSchema,
  listMissionTaskStatesSchema,
  listRecoveryCandidatesSchema,
  observeMissionStateSchema,
  proposeRecoverySchema,
  reevaluateMissionStateSchema,
  MISSION_STATE_CLIENT_AUTHORITY_FIELD_FORBIDDEN,
  SECRET_MATERIAL_REJECTED,
  MissionStateInputError,
} from "./lib/mission-state-recovery/mission-state-recovery-contract";
import {
  bindRecoveryGovernance,
  cancelRecovery,
  consumeRecovery,
  getMissionControlHandoff,
  getMissionHealth,
  getMissionState,
  getOperationalTimeline,
  getRecoveryCandidate,
  listExecutionAttemptsForMission,
  listMissionTaskStates,
  listRecoveryCandidates,
  observeMissionState,
  proposeRecovery,
  reevaluateMissionState,
} from "./lib/mission-state-recovery/mission-state-recovery-service";

function rejectSmuggledAuthority(input: Record<string, unknown>): void {
  const forbidden = findForbiddenField(input);
  if (forbidden) {
    throw new MissionStateInputError(
      MISSION_STATE_CLIENT_AUTHORITY_FIELD_FORBIDDEN,
      `client-supplied authority field "${forbidden}" is forbidden.`
    );
  }
  const secretKey = findSecretKey(input);
  if (secretKey) {
    throw new MissionStateInputError(SECRET_MATERIAL_REJECTED, `secret-shaped key "${secretKey}" is rejected.`);
  }
}

export const missionStateRecoveryRouter = createRouter({
  /** Derive + persist the current operational state observation. */
  observe: authedQuery.input(observeMissionStateSchema).mutation(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return observeMissionState(ctx.user.id, input);
  }),

  /** Latest persisted mission-state observation (read-only). */
  getMissionState: authedQuery.input(getMissionStateSchema).query(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return getMissionState(ctx.user.id, input);
  }),

  /** Latest per-task operational states (read-only). */
  listMissionTaskStates: authedQuery.input(listMissionTaskStatesSchema).query(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return listMissionTaskStates(ctx.user.id, input);
  }),

  /** R9-D execution attempts for the mission/task (immutable read-only input). */
  listExecutionAttempts: authedQuery.input(listExecutionAttemptsSchema).query(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return listExecutionAttemptsForMission(ctx.user.id, input);
  }),

  /** Recovery candidates (advisory; read-only). */
  listRecoveryCandidates: authedQuery.input(listRecoveryCandidatesSchema).query(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return listRecoveryCandidates(ctx.user.id, input);
  }),

  getRecoveryCandidate: authedQuery.input(getRecoveryCandidateSchema).query(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return getRecoveryCandidate(ctx.user.id, input);
  }),

  /** Explicit recovery proposal for a task (advisory only — never authority). */
  proposeRecovery: authedQuery.input(proposeRecoverySchema).mutation(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return proposeRecovery(ctx.user.id, input);
  }),

  /** Bind the exact R9-F decision to a candidate (frozen gate; read-only F). */
  bindRecoveryGovernance: authedQuery.input(bindRecoveryGovernanceSchema).mutation(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return bindRecoveryGovernance(ctx.user.id, input);
  }),

  /**
   * Consume an AUTHORIZED recovery: fresh gate revalidation + governed
   * execution-recovery handoff for R9-D. Performs no execution itself.
   */
  consumeRecovery: authedQuery.input(consumeRecoverySchema).mutation(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return consumeRecovery(ctx.user.id, input);
  }),

  /** Stale/drift re-evaluation: fresh observation + candidate sweep. */
  reevaluate: authedQuery.input(reevaluateMissionStateSchema).mutation(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return reevaluateMissionState(ctx.user.id, input);
  }),

  /** Governed operator cancellation (audited, visible). */
  cancelRecovery: authedQuery.input(cancelRecoverySchema).mutation(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return cancelRecovery(ctx.user.id, input);
  }),

  /** Append-only operational timeline (read-only). */
  getOperationalTimeline: authedQuery.input(getOperationalTimelineSchema).query(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return getOperationalTimeline(ctx.user.id, input);
  }),

  /** Deterministic mission health (read-only). */
  getMissionHealth: authedQuery.input(getMissionHealthSchema).query(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return getMissionHealth(ctx.user.id, input);
  }),

  /** Frozen downstream projection for R9-X mission control (read-only). */
  getMissionControlHandoff: authedQuery.input(getMissionControlHandoffSchema).query(async ({ ctx, input }) => {
    rejectSmuggledAuthority(input as Record<string, unknown>);
    return getMissionControlHandoff(ctx.user.id, input);
  }),
});
