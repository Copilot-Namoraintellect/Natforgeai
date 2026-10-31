/**
 * Execution Coordination Router (WBS-R9-D).
 *
 * The server-side surface of the execution coordination authority
 * (docs/contracts/mission-execution-coordination-contract.md). Authority
 * rules:
 * - clients name schedules/tasks/decisions and bounded action material only;
 *   execution identity, dispatch state, results, adapters, capabilities,
 *   idempotency keys and authorization material are server-derived and can
 *   never be client-supplied (strict zod boundary + client-authority guards);
 * - schedule readiness, task definitions and mission approval are never
 *   execution authorization — every dispatch re-validates R9-A/B/C upstream
 *   authority and the exact R9-F consumption gate immediately before the
 *   side-effect boundary;
 * - dispatch intents are insert-first and exactly-once; attempts are
 *   immutable and conservatively classified (uncertainty is never success);
 * - retries require fresh, exact R9-F authority and can never broaden the
 *   original action scope; retry candidates are read-only signals for R9-E;
 * - this surface never writes upstream authority tables, never exposes
 *   secrets, and (D6) never invokes live providers — sandbox adapters only.
 */

import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import {
  ExecutionCoordinationError,
  ExecutionIdentityConflictError,
  ExecutionInputError,
  ExecutionOwnershipError,
  ExecutionStateConflictError,
  ExecutionTamperError,
  ExecutionUpstreamError,
  cancelExecutionActionSchema,
  dispatchExecutionActionSchema,
  getExecutionActionSchema,
  getRecoveryProjectionSchema,
  listExecutionAttemptsSchema,
  prepareExecutionActionSchema,
  recordExecutionResultSchema,
} from "./lib/execution-coordination/execution-coordination-contract";
import {
  cancelExecutionAction,
  dispatchExecutionAction,
  getExecutionAction,
  getRecoveryProjection,
  listExecutionAttempts,
  listRecoveryProjectionsForMission,
  prepareExecutionAction,
  recordExecutionResult,
} from "./lib/execution-coordination/execution-coordination-service";
import { createExecutionUpstreamAuthority } from "./lib/execution-coordination/execution-upstream-seams";
import { createMissionGovernanceConsumptionAuthority } from "./lib/execution-coordination/execution-governance-seam";
import { createSandboxAdapterHarness } from "./lib/execution-coordination/execution-adapter-registry";
import type { ExecutionCoordinationServiceDeps } from "./lib/execution-coordination/execution-coordination-service";

function withCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return code ? `[${String(code)}] ${(err as Error).message}` : (err as Error).message;
}

function toTRPCError(err: unknown): TRPCError {
  if (err instanceof ExecutionOwnershipError) {
    return new TRPCError({ code: "FORBIDDEN", message: withCode(err) });
  }
  if (
    err instanceof ExecutionIdentityConflictError ||
    err instanceof ExecutionStateConflictError ||
    err instanceof ExecutionTamperError
  ) {
    return new TRPCError({ code: "CONFLICT", message: withCode(err) });
  }
  if (
    err instanceof ExecutionInputError ||
    err instanceof ExecutionUpstreamError ||
    err instanceof ExecutionCoordinationError
  ) {
    return new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  throw err;
}

/**
 * Production dependency set. Upstream + governance seams read durable rows
 * behind guarded information-schema checks (fail closed when the frozen
 * R9 tables are absent); the adapter registry binds the SANDBOX harness
 * only — no live provider/CRM/billing/campaign adapter exists in this
 * stream (LIVE_EXECUTION=False).
 */
export function createExecutionCoordinationDeps(): ExecutionCoordinationServiceDeps {
  return {
    upstream: createExecutionUpstreamAuthority(),
    governance: createMissionGovernanceConsumptionAuthority(),
    adapters: createSandboxAdapterHarness().registry,
  };
}

export const executionCoordinationRouter = createRouter({
  prepare: authedQuery
    .input(prepareExecutionActionSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await prepareExecutionAction(
          undefined,
          createExecutionCoordinationDeps(),
          { userId: ctx.user.id },
          input
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  dispatch: authedQuery
    .input(dispatchExecutionActionSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await dispatchExecutionAction(
          undefined,
          createExecutionCoordinationDeps(),
          { userId: ctx.user.id },
          input
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  recordResult: authedQuery
    .input(recordExecutionResultSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await recordExecutionResult(
          undefined,
          createExecutionCoordinationDeps(),
          { userId: ctx.user.id },
          input
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  cancel: authedQuery
    .input(cancelExecutionActionSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await cancelExecutionAction(
          undefined,
          createExecutionCoordinationDeps(),
          { userId: ctx.user.id },
          input
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  get: authedQuery
    .input(getExecutionActionSchema)
    .query(async ({ ctx, input }) => {
      try {
        const action = await getExecutionAction(undefined, { userId: ctx.user.id }, input.executionActionId);
        if (!action) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Execution action not found." });
        }
        return action;
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw toTRPCError(err);
      }
    }),

  listAttempts: authedQuery
    .input(listExecutionAttemptsSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listExecutionAttempts(
          undefined,
          { userId: ctx.user.id },
          input.executionActionId,
          input.limit ?? 50
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  getRecoveryProjection: authedQuery
    .input(getRecoveryProjectionSchema)
    .query(async ({ ctx, input }) => {
      try {
        if (input.executionActionId) {
          const projection = await getRecoveryProjection(
            undefined,
            { userId: ctx.user.id },
            input.executionActionId
          );
          if (!projection) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Execution action not found." });
          }
          return { projections: [projection] };
        }
        if (input.missionId) {
          return {
            projections: await listRecoveryProjectionsForMission(
              undefined,
              { userId: ctx.user.id },
              input.missionId
            ),
          };
        }
        throw new TRPCError({ code: "BAD_REQUEST", message: "executionActionId or missionId required." });
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw toTRPCError(err);
      }
    }),
});
