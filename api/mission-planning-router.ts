// ─── R9-B Mission Planning & Decomposition — tRPC router ───
//
// Tenant-scoped, authed-only surface. Clients reference ids and propose
// bounded planning inputs only; every authority field is rejected at the
// boundary (z.strictObject + assertNoClientAuthorityFields). This router
// never schedules, never executes, never invokes providers, never decides
// governance.

import { TRPCError } from "@trpc/server";
import { getDb } from "./queries/connection";
import { authedQuery, createRouter } from "./middleware";
import {
  CreatePlanInputSchema,
  GetPlanInputSchema,
  GetSchedulingHandoffInputSchema,
  ListPlansInputSchema,
  MissionPlanningError,
  PlanLifecycleInputSchema,
  assertNoClientAuthorityFields,
  type MissionPlanningErrorCode,
} from "./lib/mission-planning/mission-planning-contract";
import {
  createRawSqlMissionAuthorityReadPort,
  type MissionAuthorityReadPort,
} from "./lib/mission-planning/mission-planning-mission-seam";
import { bindMissionPlanningStoreExecutor } from "./lib/mission-planning/mission-planning-store";
import {
  cancelPlanForUser,
  createPlanForUser,
  getPlanForUser,
  getSchedulingHandoffForUser,
  listPlanLifecycleForUser,
  listPlansForUser,
  markPlanReadyForScheduling,
  revisePlanForUser,
  type MissionPlanningDeps,
} from "./lib/mission-planning/mission-planning-service";

const NOT_FOUND_CODES: ReadonlySet<MissionPlanningErrorCode> = new Set([
  "MISSION_NOT_FOUND",
  "PLAN_NOT_FOUND",
]);

const CONFLICT_CODES: ReadonlySet<MissionPlanningErrorCode> = new Set([
  "MISSION_NOT_ELIGIBLE",
  "PLAN_MISSION_AUTHORITY_DRIFT",
  "PLAN_REPLAY_CONFLICT",
  "PLAN_STATE_CONFLICT",
  "PLAN_NOT_SCHEDULABLE",
]);

const UNAVAILABLE_CODES: ReadonlySet<MissionPlanningErrorCode> = new Set([
  "MISSION_AUTHORITY_UNAVAILABLE",
]);

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof MissionPlanningError) {
    if (NOT_FOUND_CODES.has(err.code)) {
      return new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (CONFLICT_CODES.has(err.code)) {
      return new TRPCError({ code: "CONFLICT", message: err.message });
    }
    if (UNAVAILABLE_CODES.has(err.code)) {
      return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message });
    }
    if (err.code === "CLIENT_AUTHORITY_FIELD_FORBIDDEN") {
      return new TRPCError({ code: "FORBIDDEN", message: err.message });
    }
    return new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: err instanceof Error ? err.message : "unexpected mission planning failure",
  });
}

function buildDeps(db: ReturnType<typeof getDb>): MissionPlanningDeps {
  const port: MissionAuthorityReadPort = createRawSqlMissionAuthorityReadPort(db);
  return { missionAuthority: port };
}

export const missionPlanningRouter = createRouter({
  createPlan: authedQuery
    .input(CreatePlanInputSchema)
    .mutation(async ({ ctx, input }) => {
      assertNoClientAuthorityFields(input as unknown as Record<string, unknown>);
      const db = getDb();
      try {
        return await createPlanForUser({
          userId: ctx.user.id,
          input,
          deps: buildDeps(db),
          executor: bindMissionPlanningStoreExecutor(db),
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  get: authedQuery.input(GetPlanInputSchema).query(async ({ ctx, input }) => {
    const db = getDb();
    try {
      return await getPlanForUser({
        userId: ctx.user.id,
        planId: input.planId,
        deps: buildDeps(db),
        executor: bindMissionPlanningStoreExecutor(db),
      });
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  list: authedQuery.input(ListPlansInputSchema).query(async ({ ctx, input }) => {
    const db = getDb();
    try {
      return await listPlansForUser({
        userId: ctx.user.id,
        missionId: input.missionId,
        status: input.status,
        deps: buildDeps(db),
        executor: bindMissionPlanningStoreExecutor(db),
      });
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  getSchedulingHandoff: authedQuery
    .input(GetSchedulingHandoffInputSchema)
    .query(async ({ ctx, input }) => {
      const db = getDb();
      try {
        return await getSchedulingHandoffForUser({
          userId: ctx.user.id,
          planId: input.planId,
          deps: buildDeps(db),
          executor: bindMissionPlanningStoreExecutor(db),
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listLifecycle: authedQuery.input(GetPlanInputSchema).query(async ({ ctx, input }) => {
    const db = getDb();
    try {
      return await listPlanLifecycleForUser({
        userId: ctx.user.id,
        planId: input.planId,
        executor: bindMissionPlanningStoreExecutor(db),
      });
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  markReadyForScheduling: authedQuery
    .input(PlanLifecycleInputSchema)
    .mutation(async ({ ctx, input }) => {
      assertNoClientAuthorityFields(input as unknown as Record<string, unknown>);
      const db = getDb();
      try {
        return await markPlanReadyForScheduling({
          userId: ctx.user.id,
          planId: input.planId,
          expectedVersion: input.expectedVersion,
          deps: buildDeps(db),
          executor: bindMissionPlanningStoreExecutor(db),
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  revise: authedQuery.input(PlanLifecycleInputSchema).mutation(async ({ ctx, input }) => {
    assertNoClientAuthorityFields(input as unknown as Record<string, unknown>);
    const db = getDb();
    try {
      return await revisePlanForUser({
        userId: ctx.user.id,
        planId: input.planId,
        expectedVersion: input.expectedVersion,
        deps: buildDeps(db),
        executor: bindMissionPlanningStoreExecutor(db),
      });
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  cancel: authedQuery.input(PlanLifecycleInputSchema).mutation(async ({ ctx, input }) => {
    assertNoClientAuthorityFields(input as unknown as Record<string, unknown>);
    const db = getDb();
    try {
      return await cancelPlanForUser({
        userId: ctx.user.id,
        planId: input.planId,
        expectedVersion: input.expectedVersion,
        reasonCode: input.reasonCode,
        deps: buildDeps(db),
        executor: bindMissionPlanningStoreExecutor(db),
      });
    } catch (err) {
      throw toTrpcError(err);
    }
  }),
});
