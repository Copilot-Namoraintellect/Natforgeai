/**
 * Mission Dependency & Scheduling Router (WBS-R9-C).
 *
 * The server-side surface of the dependency & scheduling authority.
 * Authority rules:
 * - clients name missions/plans/tasks and bounded declaration material only
 *   — never identity, readiness, risk, ordering, requiresApproval, status,
 *   fingerprints, hashes or validity (z.strictObject + pure boundary reject
 *   smuggling, fail closed);
 * - mission authority is re-verified server-side against durable R9-A rows
 *   on every call (cross-tenant/cross-business fail closed);
 * - dependency edges are immutable, hash-bound and validated against the full
 *   plan graph — self/direct/indirect cycles, unknown endpoints and
 *   cross-scope references fail closed, and no agent or model can override
 *   cycle detection;
 * - schedules are deterministic with content-addressed identity: duplicate
 *   requests converge by replay, conflicting replay fails closed, and input
 *   changes mint superseding schedules with preserved lineage;
 * - scheduling consumes R9-F read-only: it may set requiresApproval=true, it
 *   never creates ALLOW and never invokes the execution consumption gate;
 * - no mission/governance/approval table write, no provider invocation, no
 *   budget movement, no capability minting, no EXECUTING status anywhere in
 *   this surface. Scheduling is never execution authorization.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import {
  DEPENDENCY_ID_PATTERN,
  SCHEDULE_ID_PATTERN,
  MissionSchedulingError,
  MissionSchedulingIdentityConflictError,
  MissionSchedulingInputError,
  MissionSchedulingOwnershipError,
  MissionSchedulingStateConflictError,
  MissionSchedulingTamperError,
  MissionSchedulingValidationError,
  listMissionDependenciesSchema,
  listMissionSchedulesSchema,
  missionTaskPlanPortSchema,
  produceMissionScheduleSchema,
  recordMissionDependencySchema,
} from "./lib/mission-scheduling/mission-scheduling-contract";
import {
  cancelMissionSchedule,
  getMissionSchedule,
  produceMissionSchedule,
  recordMissionDependency,
  registerMissionTaskPlan,
  sweepMissionScheduleExpiry,
} from "./lib/mission-scheduling/mission-scheduling-service";
import { createMissionUpstreamAuthority } from "./lib/mission-scheduling/mission-scheduling-upstream-seam";
import { createMissionGovernanceAuthority } from "./lib/mission-scheduling/mission-scheduling-governance-seam";
import {
  assertDependencyEvidenceIntegrity,
  getDependencyByDependencyId,
  listDependencies,
  listSchedules,
  listScheduleLifecycleEvents,
} from "./lib/mission-scheduling/mission-scheduling-store";
import type { MissionSchedulingServiceDeps } from "./lib/mission-scheduling/mission-scheduling-service";

function withCode(err: MissionSchedulingError): string {
  return err.message.includes(err.code) ? err.message : `${err.code}: ${err.message}`;
}

function toTrpcError(err: unknown): never {
  if (err instanceof MissionSchedulingOwnershipError) {
    throw new TRPCError({ code: "FORBIDDEN", message: withCode(err) });
  }
  if (
    err instanceof MissionSchedulingIdentityConflictError ||
    err instanceof MissionSchedulingStateConflictError ||
    err instanceof MissionSchedulingTamperError
  ) {
    throw new TRPCError({ code: "CONFLICT", message: withCode(err) });
  }
  if (err instanceof MissionSchedulingInputError || err instanceof MissionSchedulingValidationError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  if (err instanceof MissionSchedulingError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  throw err;
}

function productionDeps(): MissionSchedulingServiceDeps {
  return {
    upstream: createMissionUpstreamAuthority(),
    governance: createMissionGovernanceAuthority(),
  };
}

export const missionSchedulingRouter = createRouter({
  /**
   * Register (or replay) an accepted mission-task-plan/v1 port document as
   * verbatim scheduling material. The mission must exist for the tenant; the
   * port version must be exactly mission-task-plan/v1. Re-registration with
   * identical material converges; a changed plan mints a new fingerprint
   * version. Scheduling never rewrites plan content.
   */
  registerPlan: authedQuery.input(missionTaskPlanPortSchema).mutation(async ({ ctx, input }) => {
    try {
      return await registerMissionTaskPlan(undefined, productionDeps(), { userId: ctx.user.id }, input);
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /**
   * Record one immutable dependency edge, validated against the full plan
   * graph (self/direct/indirect cycles fail closed). Idempotent: duplicate
   * declarations converge; conflicting replay fails closed.
   */
  recordDependency: authedQuery.input(recordMissionDependencySchema).mutation(async ({ ctx, input }) => {
    try {
      return await recordMissionDependency(
        undefined,
        productionDeps(),
        { userId: ctx.user.id },
        input,
        new Date().toISOString()
      );
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /**
   * Produce the deterministic schedule for a mission+plan. Identical inputs
   * converge to the same sch1: (idempotent replay, zero new effects); changed
   * inputs supersede the prior active schedule with preserved lineage. No
   * schedule is produced (fail closed) for cycles, expired missions,
   * unschedulable mission status or unknown plans.
   */
  produceSchedule: authedQuery.input(produceMissionScheduleSchema).mutation(async ({ ctx, input }) => {
    try {
      return await produceMissionSchedule(
        undefined,
        productionDeps(),
        { userId: ctx.user.id },
        input,
        new Date().toISOString()
      );
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /** Tenant-scoped read of one dependency edge (integrity-asserted). */
  getDependency: authedQuery.input(z.object({ dependencyId: z.string().regex(DEPENDENCY_ID_PATTERN) }).strict()).query(
    async ({ ctx, input }) => {
      try {
        const row = await getDependencyByDependencyId(ctx.user.id, input.dependencyId);
        if (!row) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Dependency not found." });
        }
        assertDependencyEvidenceIntegrity(row);
        return { dependency: row };
      } catch (err) {
        toTrpcError(err);
      }
    }
  ),

  /** Tenant-scoped dependency list for one mission+plan. */
  listDependencies: authedQuery.input(listMissionDependenciesSchema).query(async ({ ctx, input }) => {
    try {
      const rows = await listDependencies(ctx.user.id, input);
      for (const row of rows) assertDependencyEvidenceIntegrity(row);
      return { dependencies: rows };
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /** Tenant-scoped schedule read with lifecycle + downstream projection. */
  getSchedule: authedQuery.input(z.object({ scheduleId: z.string().regex(SCHEDULE_ID_PATTERN) }).strict()).query(
    async ({ ctx, input }) => {
      try {
        return await getMissionSchedule(undefined, productionDeps(), { userId: ctx.user.id }, input.scheduleId);
      } catch (err) {
        toTrpcError(err);
      }
    }
  ),

  /** Tenant-scoped schedule list with optional filters. */
  listSchedules: authedQuery.input(listMissionSchedulesSchema).query(async ({ ctx, input }) => {
    try {
      const rows = await listSchedules(ctx.user.id, input);
      return { schedules: rows };
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /** Immutable lifecycle history for one tenant-scoped schedule. */
  listLifecycle: authedQuery.input(z.object({ scheduleId: z.string().regex(SCHEDULE_ID_PATTERN) }).strict()).query(
    async ({ ctx, input }) => {
      try {
        return { lifecycle: await listScheduleLifecycleEvents(ctx.user.id, input.scheduleId) };
      } catch (err) {
        toTrpcError(err);
      }
    }
  ),

  /**
   * Governed operator cancellation of an active schedule (optimistic-CAS
   * guarded). Terminal/superseded schedules cannot be cancelled.
   */
  cancelSchedule: authedQuery.input(cancelMissionScheduleSchema).mutation(async ({ ctx, input }) => {
    try {
      return await cancelMissionSchedule(undefined, { userId: ctx.user.id }, input, new Date().toISOString());
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /**
   * Bounded expiry sweep: active schedules whose validity has lapsed
   * transition to STALE with append-only msl1 facts. Status only — never
   * content.
   */
  sweepExpiry: authedQuery
    .input(z.object({ businessId: z.number().int().positive().optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await sweepMissionScheduleExpiry(undefined, { userId: ctx.user.id }, input, new Date().toISOString());
      } catch (err) {
        toTrpcError(err);
      }
    }),

  /** Convenience read: the frozen execution-order projection for one schedule. */
  getExecutionProjection: authedQuery
    .input(z.object({ scheduleId: z.string().regex(SCHEDULE_ID_PATTERN) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const result = await getMissionSchedule(undefined, productionDeps(), { userId: ctx.user.id }, input.scheduleId);
        return { projection: result.projection };
      } catch (err) {
        toTrpcError(err);
      }
    }),
});
