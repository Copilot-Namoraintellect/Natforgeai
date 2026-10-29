/**
 * Optimisation governance router — R7-F governed optimisation-governance
 * surface.
 *
 * Narrow, tenant-scoped, authed-only. Clients propose material and reference
 * ids only: no decision, reason codes, risk class, financial impact class,
 * approval state or policy content may be supplied (strictObject input
 * schemas, contract §9). Evaluation persists the immutable decision and its
 * audit event in one transaction. This stream never executes optimisation
 * actions, never touches billing/payments/providers/CRM, and never becomes
 * the optimisation engine.
 */

import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import {
  bindOptimisationGovernanceStoreExecutor,
  createOptimisationGovernanceBridgeProvider,
} from "./lib/optimisation-governance/optimisation-governance-bridge";
import {
  evaluateOptimisationGovernanceForProposal,
  getOptimisationGovernanceDecisionForUser,
  getOptimisationGovernanceOperationsProjectionForUser,
  listOptimisationGovernanceDecisionsForUser,
  recordOptimisationGovernanceRecovery,
  revalidateOptimisationGovernanceDecision,
} from "./lib/optimisation-governance/optimisation-governance-service";
import {
  EvaluateOptimisationGovernanceInputSchema,
  GetGovernanceDecisionInputSchema,
  ListGovernanceDecisionsInputSchema,
  OptimisationGovernanceError,
  RecordGovernanceRecoveryInputSchema,
  RevalidateGovernanceDecisionInputSchema,
  type OptimisationGovernanceErrorCode,
} from "./lib/optimisation-governance/optimisation-governance-contract";
import {
  getOptimisationGovernancePolicy,
  listOptimisationGovernancePolicies,
} from "./lib/optimisation-governance/optimisation-policy";

const NOT_FOUND_CODES: ReadonlySet<OptimisationGovernanceErrorCode> = new Set([
  "GOVERNANCE_DECISION_NOT_FOUND",
]);

const FORBIDDEN_CODES: ReadonlySet<OptimisationGovernanceErrorCode> = new Set([
  "OWNERSHIP_MISMATCH",
  "CROSS_TENANT_PROPOSAL",
]);

const CONFLICT_CODES: ReadonlySet<OptimisationGovernanceErrorCode> = new Set([
  "GOVERNANCE_REPLAY_CONFLICT",
  "POLICY_VERSION_CONFLICT",
]);

/** Maps the governance error taxonomy onto stable tRPC codes (fail closed). */
export function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof OptimisationGovernanceError) {
    if (NOT_FOUND_CODES.has(err.code)) {
      return new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (FORBIDDEN_CODES.has(err.code)) {
      return new TRPCError({ code: "FORBIDDEN", message: err.message });
    }
    if (CONFLICT_CODES.has(err.code)) {
      return new TRPCError({ code: "CONFLICT", message: err.message });
    }
    // Stale/tampered/unknown-version/invalid/unavailable inputs are
    // caller-correctable precondition failures — never guessed, never served.
    return new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: err instanceof Error ? err.message : "internal optimisation governance error",
  });
}

export const optimisationGovernanceRouter = createRouter({
  /**
   * One governed evaluation (F1 target flow). Deterministic: same
   * authoritative inputs ⇒ same governanceDecisionId ⇒ durable convergence;
   * replay returns the existing decision (idempotent_replay) with zero extra
   * audit events. The approval ledger is untouched here; REVIEW_REQUIRED
   * decisions carry their binding and the caller routes them to the Approval
   * Centre (approvalType "optimisation_action").
   */
  evaluate: authedQuery
    .input(EvaluateOptimisationGovernanceInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createOptimisationGovernanceBridgeProvider(db, ctx.user.id);
      try {
        return await db.transaction(async (tx) =>
          evaluateOptimisationGovernanceForProposal(
            { userId: ctx.user.id, proposal: input.proposal, policyVersion: input.policyVersion },
            { provider },
            bindOptimisationGovernanceStoreExecutor(tx)
          )
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  get: authedQuery.input(GetGovernanceDecisionInputSchema).query(async ({ ctx, input }) => {
    try {
      return await getOptimisationGovernanceDecisionForUser(
        { userId: ctx.user.id, governanceDecisionId: input.governanceDecisionId },
        bindOptimisationGovernanceStoreExecutor(getDb())
      );
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /** Immutable decision history (filters optional), oldest-first. */
  listDecisions: authedQuery.input(ListGovernanceDecisionsInputSchema).query(async ({ ctx, input }) => {
    try {
      return await listOptimisationGovernanceDecisionsForUser(
        {
          userId: ctx.user.id,
          businessId: input.businessId,
          proposalId: input.proposalId,
          decision: input.decision,
        },
        bindOptimisationGovernanceStoreExecutor(getDb())
      );
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /** Truthful read-only operations projection (F8). */
  getOperationsProjection: authedQuery
    .input(ListGovernanceDecisionsInputSchema.pick({ businessId: true }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createOptimisationGovernanceBridgeProvider(db, ctx.user.id);
      try {
        return await getOptimisationGovernanceOperationsProjectionForUser(
          { userId: ctx.user.id, businessId: input.businessId },
          { provider },
          bindOptimisationGovernanceStoreExecutor(db)
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Downstream contract seam (F9/downstream contract): re-evaluate a stored
   * decision against the CURRENT policy + authority state using fresh
   * proposal material. The stored decision is never mutated; the caller
   * receives the current evaluation and must persist a new governed decision
   * if it differs. R7-B/C/D/E call this immediately before any material
   * state change.
   */
  revalidate: authedQuery
    .input(RevalidateGovernanceDecisionInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createOptimisationGovernanceBridgeProvider(db, ctx.user.id);
      try {
        return await revalidateOptimisationGovernanceDecision(
          {
            userId: ctx.user.id,
            governanceDecisionId: input.governanceDecisionId,
            proposal: input.proposal,
          },
          { provider },
          bindOptimisationGovernanceStoreExecutor(db)
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Narrow recovery (F8): record a closed-vocabulary operator action against
   * an existing decision. AUDIT-ONLY — the immutable decision is never
   * mutated and no execution state changes. There is deliberately no
   * forceAllow/forceComplete/setApproved/overridePolicy.
   */
  recordRecovery: authedQuery
    .input(RecordGovernanceRecoveryInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createOptimisationGovernanceBridgeProvider(db, ctx.user.id);
      try {
        return await db.transaction(async (tx) =>
          recordOptimisationGovernanceRecovery(
            {
              userId: ctx.user.id,
              governanceDecisionId: input.governanceDecisionId,
              action: input.action,
              note: input.note,
            },
            { provider },
            bindOptimisationGovernanceStoreExecutor(tx)
          )
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** The conservative default policy + all registered policy versions. */
  getPolicy: authedQuery.query(() => ({
    policy: getOptimisationGovernancePolicy(),
    availableVersions: listOptimisationGovernancePolicies(),
  })),
});
