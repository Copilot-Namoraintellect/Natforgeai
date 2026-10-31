/**
 * Mission authority router — R9-A governed mission formulation surface.
 *
 * Narrow, tenant-scoped, authed-only. Clients supply business scope + R8
 * candidate reference id + bounded formation inputs (objective wording,
 * expected outcome, success criteria, assumptions, optional constraint
 * additions, optional model wording draft) only: no identity, status,
 * fingerprints, risk, governance, approval, validity, scope or projection
 * material may be supplied (strictObject input schemas, contract §10).
 * Formation revalidates the frozen R8 candidate through the single
 * eligibility seam, derives every authority dimension deterministically,
 * and persists the immutable mission proposal exactly once. This stream
 * never plans tasks, never schedules, never executes, never invokes
 * providers, never touches strategy/DNA/budget/campaigns/payments/billing,
 * and never becomes a governance engine. mission proposal != execution
 * authorization; there is no EXECUTING status.
 */

import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { createRawSqlMissionCandidateRowPort } from "./lib/mission-authority/mission-authority-candidate-seam";
import {
  createRawSqlStrategicOpportunityRiskApprovalReadPort,
  getStrategicOpportunityRiskGovernanceEngine,
} from "./lib/strategic-opportunity-risk/strategic-opportunity-risk-governance-seam";
import {
  cancelMission,
  getMissionForUser,
  getPlanningHandoffForUser,
  listMissionLifecycleForUser,
  listMissionsForUser,
  proposeMission,
  revalidateMission,
  type MissionAuthorityDeps,
} from "./lib/mission-authority/mission-authority-service";
import { bindMissionAuthorityStoreExecutor } from "./lib/mission-authority/mission-authority-store";
import {
  CancelMissionInputSchema,
  GetMissionInputSchema,
  GetPlanningHandoffInputSchema,
  ListMissionLifecycleInputSchema,
  ListMissionsInputSchema,
  MissionAuthorityError,
  ProposeMissionInputSchema,
  RevalidateMissionInputSchema,
  assertNoClientAuthorityFields,
  type MissionAuthorityErrorCode,
} from "./lib/mission-authority/mission-authority-contract";

const NOT_FOUND_CODES: ReadonlySet<MissionAuthorityErrorCode> = new Set([
  "MISSION_NOT_FOUND",
  "UNKNOWN_SOURCE_CANDIDATE",
]);

const FORBIDDEN_CODES: ReadonlySet<MissionAuthorityErrorCode> = new Set([
  "OWNERSHIP_MISMATCH",
  "SOURCE_SCOPE_MISMATCH",
  "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  "EXECUTION_AUTHORITY_FORBIDDEN",
  "SOURCE_CANDIDATE_NOT_GOVERNED",
  "SOURCE_CANDIDATE_BLOCKED",
  "SOURCE_CANDIDATE_STALE",
  "SOURCE_CANDIDATE_EXPIRED",
  "GOVERNANCE_AUTHORITY_UNAVAILABLE",
  "SOURCE_PROJECTION_MALFORMED",
  "PREDECESSOR_INVALID",
]);

const CONFLICT_CODES: ReadonlySet<MissionAuthorityErrorCode> = new Set([
  "MISSION_REPLAY_CONFLICT",
  "MISSION_LIFECYCLE_CONFLICT",
]);

const BAD_REQUEST_CODES: ReadonlySet<MissionAuthorityErrorCode> = new Set([
  "MISSION_SCOPE_VIOLATION",
  "INVALID_OBJECTIVE_STATEMENT",
  "INVALID_EXPECTED_OUTCOME",
  "INVALID_SUCCESS_CRITERION",
  "INVALID_ASSUMPTION",
  "INVALID_CONSTRAINT",
  "INVALID_BUDGET_CEILING",
  "INVALID_CANCEL_REASON",
]);

/** Maps the mission error taxonomy onto stable tRPC codes (fail closed). */
export function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof MissionAuthorityError) {
    if (NOT_FOUND_CODES.has(err.code)) {
      return new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (CONFLICT_CODES.has(err.code)) {
      return new TRPCError({ code: "CONFLICT", message: err.message });
    }
    if (BAD_REQUEST_CODES.has(err.code)) {
      return new TRPCError({ code: "BAD_REQUEST", message: err.message });
    }
    if (FORBIDDEN_CODES.has(err.code)) {
      return new TRPCError({ code: "FORBIDDEN", message: err.message });
    }
    return new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: err instanceof Error ? err.message : "internal mission authority error",
  });
}

function buildDeps(db: ReturnType<typeof getDb>): MissionAuthorityDeps {
  return {
    candidateRows: createRawSqlMissionCandidateRowPort(db),
    approvals: createRawSqlStrategicOpportunityRiskApprovalReadPort(db),
    governance: getStrategicOpportunityRiskGovernanceEngine(),
  };
}

export const missionAuthorityRouter = createRouter({
  /**
   * One governed mission formulation over a single R8 candidate reference.
   * Deterministic: same authoritative basis ⇒ same missionId ⇒ durable
   * convergence (idempotent_replay) with zero extra audit events. The source
   * candidate must be governed, current and consumable — otherwise fail
   * closed. Mission authority is formation authority only; no execution
   * authorization is created.
   */
  propose: authedQuery.input(ProposeMissionInputSchema).mutation(async ({ ctx, input }) => {
    assertNoClientAuthorityFields(input as Record<string, unknown>);
    const db = getDb();
    try {
      return await db.transaction(async (tx) =>
        proposeMission(
          {
            userId: ctx.user.id,
            businessId: input.businessId,
            sourceCandidateId: input.sourceCandidateId,
            objectiveStatement: input.objectiveStatement,
            expectedOutcome: input.expectedOutcome,
            successCriteria: input.successCriteria,
            assumptions: input.assumptions,
            constraints: input.constraints,
            modelAssistance: input.modelAssistance,
            supersedesMissionId: input.supersedesMissionId,
          },
          buildDeps(db),
          bindMissionAuthorityStoreExecutor(tx)
        )
      );
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /** One mission proposal + derived freshness (tenant-scoped). */
  get: authedQuery.input(GetMissionInputSchema).query(async ({ ctx, input }) => {
    const db = getDb();
    try {
      return await getMissionForUser({
        userId: ctx.user.id,
        missionId: input.missionId,
        deps: buildDeps(db),
        executor: bindMissionAuthorityStoreExecutor(db),
      });
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /** Immutable mission history (filters optional). */
  list: authedQuery.input(ListMissionsInputSchema).query(async ({ ctx, input }) => {
    const db = getDb();
    try {
      return await listMissionsForUser({
        userId: ctx.user.id,
        businessId: input.businessId,
        status: input.status,
        missionType: input.missionType,
        deps: buildDeps(db),
        executor: bindMissionAuthorityStoreExecutor(db),
      });
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /**
   * Lifecycle revalidation (contract §8): re-resolves the source candidate
   * through the frozen eligibility seam and derives the deterministic
   * target (ELIGIBLE_FOR_PLANNING / REVIEW_REQUIRED / BLOCKED / STALE /
   * SUPERSEDED / INVALIDATED). Append-only misl1: facts; terminal statuses
   * replay unchanged with zero events. Never transitions to EXECUTING —
   * no such transition exists.
   */
  revalidate: authedQuery.input(RevalidateMissionInputSchema).mutation(async ({ ctx, input }) => {
    const db = getDb();
    try {
      return await db.transaction(async (tx) =>
        revalidateMission({
          userId: ctx.user.id,
          missionId: input.missionId,
          deps: buildDeps(db),
          executor: bindMissionAuthorityStoreExecutor(tx),
        })
      );
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /** Bounded operator cancellation (closed reason codes; non-terminal only). */
  cancel: authedQuery.input(CancelMissionInputSchema).mutation(async ({ ctx, input }) => {
    const db = getDb();
    try {
      return await db.transaction(async (tx) =>
        cancelMission({
          userId: ctx.user.id,
          missionId: input.missionId,
          reasonCode: input.reasonCode,
          deps: buildDeps(db),
          executor: bindMissionAuthorityStoreExecutor(tx),
        })
      );
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /** Append-only misl1: lifecycle history of one mission. */
  listLifecycle: authedQuery
    .input(ListMissionLifecycleInputSchema)
    .query(async ({ ctx, input }) => {
      const db = getDb();
      try {
        return await listMissionLifecycleForUser({
          userId: ctx.user.id,
          missionId: input.missionId,
          executor: bindMissionAuthorityStoreExecutor(db),
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Frozen read-only planning projection (`mission-authority-to-planning/v1`,
   * 27-key exact allowlist). Planning may decompose; planning may never
   * rewrite mission authority. mission != task; recommendation != execution
   * authorization.
   */
  getPlanningHandoff: authedQuery
    .input(GetPlanningHandoffInputSchema)
    .query(async ({ ctx, input }) => {
      const db = getDb();
      try {
        return await getPlanningHandoffForUser({
          userId: ctx.user.id,
          missionId: input.missionId,
          deps: buildDeps(db),
          executor: bindMissionAuthorityStoreExecutor(db),
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
});
