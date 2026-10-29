/**
 * Budget & Portfolio Optimisation router — R7-E governed optimisation surface.
 *
 * Narrow, tenant-scoped, authed-only. Clients reference ids and choose an
 * objective only: no allocations, totals, confidence, reason codes,
 * governance verdicts or approval state may be supplied (strictObject input
 * schemas, contract §10). Every material proposal is evaluated by R7-F
 * governance before execution eligibility; this stream emits optimisation
 * instructions only — no billing, payments, provider spend, campaign or
 * strategy execution exists here.
 *
 * Production governance (X5 binding): the canonical integrated R7-F engine
 * evaluates every material proposal through the tenant-anchored governance
 * port; if governance authority is unavailable the failure is fail-closed —
 * proposals may be created, but no proposal can become execution-eligible
 * and no instruction can be authorised.
 */

import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import {
  bindBudgetPortfolioStoreExecutor,
  createBudgetPortfolioAuthorityProvider,
  createBudgetPortfolioEvidenceProvider,
} from "./lib/budget-portfolio/budget-portfolio-bridge";
import {
  createPortfolioSnapshot,
  getAuthorisedInstruction,
  getInstructionByOptimisationForUser,
  getOptimisationProposalForUser,
  getPortfolioSnapshotForUser,
  getStrategyHandoffProjection,
  listOptimisationProposalsForUser,
  listPortfolioSnapshotsForUser,
  proposeOptimisation,
} from "./lib/budget-portfolio/budget-portfolio-service";
import { createCanonicalGovernancePort } from "./lib/budget-portfolio/governance-seam";
import {
  BudgetPortfolioError,
  CreatePortfolioSnapshotInputSchema,
  GetAuthorisedInstructionInputSchema,
  GetOptimisationProposalInputSchema,
  GetPortfolioSnapshotInputSchema,
  GetStrategyHandoffInputSchema,
  ListOptimisationProposalsInputSchema,
  ListPortfolioSnapshotsInputSchema,
  ProposeOptimisationInputSchema,
  type BudgetPortfolioErrorCode,
} from "./lib/budget-portfolio/budget-portfolio-contract";

const NOT_FOUND_CODES: ReadonlySet<BudgetPortfolioErrorCode> = new Set([
  "SNAPSHOT_NOT_FOUND",
  "OPTIMISATION_NOT_FOUND",
]);

const FORBIDDEN_CODES: ReadonlySet<BudgetPortfolioErrorCode> = new Set(["OWNERSHIP_MISMATCH"]);

const CONFLICT_CODES: ReadonlySet<BudgetPortfolioErrorCode> = new Set([
  "OPTIMISATION_REPLAY_CONFLICT",
  "GOVERNANCE_REPLAY_CONFLICT",
  "SNAPSHOT_REPLAY_CONFLICT",
]);

/** Maps the R7-E error taxonomy onto stable tRPC codes (fail closed). */
export function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof BudgetPortfolioError) {
    if (NOT_FOUND_CODES.has(err.code)) {
      return new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (FORBIDDEN_CODES.has(err.code)) {
      return new TRPCError({ code: "FORBIDDEN", message: err.message });
    }
    if (CONFLICT_CODES.has(err.code)) {
      return new TRPCError({ code: "CONFLICT", message: err.message });
    }
    // Stale/tampered/unavailable/unexecutable inputs are caller-correctable
    // precondition failures — never guessed, never served.
    return new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: err instanceof Error ? err.message : "internal budget portfolio error",
  });
}

function depsFor(tx: unknown, userId: number) {
  return {
    authorityProvider: createBudgetPortfolioAuthorityProvider(
      tx as Parameters<typeof createBudgetPortfolioAuthorityProvider>[0],
      userId
    ),
    evidenceProvider: createBudgetPortfolioEvidenceProvider(
      tx as Parameters<typeof createBudgetPortfolioEvidenceProvider>[0],
      userId
    ),
    governance: createCanonicalGovernancePort(
      tx as Parameters<typeof createCanonicalGovernancePort>[0]
    ),
  };
}

export const budgetPortfolioRouter = createRouter({
  /**
   * Server-assembled deterministic portfolio snapshot (E2). The client supplies
   * only the businessId; the total budget, allocations, locked/reserved funds
   * and provider capability are derived from canonical rows. Replays converge
   * on (userId, portfolioSnapshotId) with zero extra audit events.
   */
  createSnapshot: authedQuery
    .input(CreatePortfolioSnapshotInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      try {
        return await db.transaction(async (tx) =>
          createPortfolioSnapshot(
            { userId: ctx.user.id, businessId: input.businessId },
            depsFor(tx, ctx.user.id),
            bindBudgetPortfolioStoreExecutor(tx)
          )
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getSnapshot: authedQuery.input(GetPortfolioSnapshotInputSchema).query(async ({ ctx, input }) => {
    try {
      return await getPortfolioSnapshotForUser(
        { userId: ctx.user.id, portfolioSnapshotId: input.portfolioSnapshotId },
        bindBudgetPortfolioStoreExecutor(getDb())
      );
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  listSnapshots: authedQuery
    .input(ListPortfolioSnapshotsInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listPortfolioSnapshotsForUser(
          { userId: ctx.user.id, businessId: input.businessId, limit: input.limit },
          bindBudgetPortfolioStoreExecutor(getDb())
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * One bounded, explainable optimisation proposal (E3–E7). Snapshot →
   * deterministic evidence scoring → bounded solve → stability controls →
   * R7-F governance evaluation → exactly-once persistence. Duplicate requests
   * converge (idempotent_replay) with zero extra audit events.
   */
  proposeOptimisation: authedQuery
    .input(ProposeOptimisationInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      try {
        return await db.transaction(async (tx) =>
          proposeOptimisation(
            {
              userId: ctx.user.id,
              businessId: input.businessId,
              portfolioSnapshotId: input.portfolioSnapshotId,
              objective: input.objective,
              evidenceRefs: input.evidenceRefs,
            },
            depsFor(tx, ctx.user.id),
            bindBudgetPortfolioStoreExecutor(tx)
          )
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getProposal: authedQuery
    .input(GetOptimisationProposalInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getOptimisationProposalForUser(
          { userId: ctx.user.id, optimisationId: input.optimisationId },
          bindBudgetPortfolioStoreExecutor(getDb())
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listProposals: authedQuery
    .input(ListOptimisationProposalsInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listOptimisationProposalsForUser(
          { userId: ctx.user.id, businessId: input.businessId, status: input.status, limit: input.limit },
          bindBudgetPortfolioStoreExecutor(getDb())
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Execution boundary (E7): converts a governance-authorized proposal into
   * the durable, read-only authorised optimisation instruction. Revalidates
   * governance immediately before the transition (fresh policy, approval
   * binding, decision validity, exact proposal material). BLOCKED / NO_CHANGE
   * / REJECTED proposals are never executable; human rejection permanently
   * blocks the proposal identity.
   */
  getAuthorisedInstruction: authedQuery
    .input(GetAuthorisedInstructionInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      try {
        return await db.transaction(async (tx) =>
          getAuthorisedInstruction(
            { userId: ctx.user.id, optimisationId: input.optimisationId },
            depsFor(tx, ctx.user.id),
            bindBudgetPortfolioStoreExecutor(tx)
          )
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getInstruction: authedQuery
    .input(GetAuthorisedInstructionInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getInstructionByOptimisationForUser(
          { userId: ctx.user.id, optimisationId: input.optimisationId },
          bindBudgetPortfolioStoreExecutor(getDb())
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Read-only downstream strategy handoff projection (E8) for future R8
   * strategic intelligence/planning. Carries the optimisation id, business,
   * budget period, current vs proposed allocation, evidence refs, confidence,
   * constraints, governance decision, approval status, validity,
   * algorithm/version and reason codes. Never mutates strategy.
   */
  getStrategyHandoff: authedQuery
    .input(GetStrategyHandoffInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getStrategyHandoffProjection(
          { userId: ctx.user.id, optimisationId: input.optimisationId },
          bindBudgetPortfolioStoreExecutor(getDb())
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
});

