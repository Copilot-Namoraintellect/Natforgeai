/**
 * Strategic opportunity/risk router — R8-E governed candidate surface.
 *
 * Narrow, tenant-scoped, authed-only. Clients supply business scope + R8-D
 * reasoning reference ids (+ bounded advisory model candidate types) only:
 * no kind/type verdicts, classifications, priority, confidence, risk,
 * governance, approval, fingerprint or status material may be supplied
 * (strictObject input schemas, contract §9). Derivation reads the frozen
 * R8-D projections, runs the deterministic rule-first classification,
 * analyses portfolio overlap, binds the mandatory R8-F governance decision,
 * and persists the immutable candidate exactly once. This stream never
 * executes candidates, never touches strategy/DNA/budget/campaigns/
 * experiments/providers/payments/billing, and never becomes a governance
 * engine.
 */

import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import {
  createRawSqlStrategicReasoningReadPort,
} from "./lib/strategic-opportunity-risk/strategic-opportunity-risk-reasoning-seam";
import {
  createRawSqlStrategicOpportunityRiskApprovalReadPort,
} from "./lib/strategic-opportunity-risk/strategic-opportunity-risk-governance-seam";
import { getStrategicOpportunityRiskGovernanceEngine } from "./lib/strategic-opportunity-risk/strategic-opportunity-risk-governance-seam";
import {
  deriveStrategicCandidates,
  getMissionControlHandoff,
  getStrategicCandidateForUser,
  listStrategicCandidateLifecycleForUser,
  listStrategicCandidateRelationsForUser,
  listStrategicCandidatesForUser,
  reevaluateStrategicCandidate,
  type StrategicOpportunityRiskDeps,
} from "./lib/strategic-opportunity-risk/strategic-opportunity-risk-service";
import { bindStrategicOpportunityRiskStoreExecutor } from "./lib/strategic-opportunity-risk/strategic-opportunity-risk-store";
import {
  DeriveStrategicCandidateInputSchema,
  GetMissionControlHandoffInputSchema,
  GetStrategicCandidateInputSchema,
  ListStrategicCandidateLifecycleInputSchema,
  ListStrategicCandidateRelationsInputSchema,
  ListStrategicCandidatesInputSchema,
  ReevaluateStrategicCandidateInputSchema,
  StrategicOpportunityRiskError,
  type StrategicOpportunityRiskErrorCode,
} from "./lib/strategic-opportunity-risk/strategic-opportunity-risk-contract";

const NOT_FOUND_CODES: ReadonlySet<StrategicOpportunityRiskErrorCode> = new Set([
  "CANDIDATE_NOT_FOUND",
]);

const FORBIDDEN_CODES: ReadonlySet<StrategicOpportunityRiskErrorCode> = new Set([
  "OWNERSHIP_MISMATCH",
  "UNKNOWN_REASONING_REFERENCE",
  "REASONING_SCOPE_MISMATCH",
]);

const CONFLICT_CODES: ReadonlySet<StrategicOpportunityRiskErrorCode> = new Set([
  "CANDIDATE_REPLAY_CONFLICT",
  "EVIDENCE_FINGERPRINT_MISMATCH",
  "LIFECYCLE_CONFLICT",
  "APPROVAL_BINDING_MISMATCH",
]);

/** Maps the candidate error taxonomy onto stable tRPC codes (fail closed). */
export function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof StrategicOpportunityRiskError) {
    if (NOT_FOUND_CODES.has(err.code)) {
      return new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (FORBIDDEN_CODES.has(err.code)) {
      return new TRPCError({ code: "FORBIDDEN", message: err.message });
    }
    if (CONFLICT_CODES.has(err.code)) {
      return new TRPCError({ code: "CONFLICT", message: err.message });
    }
    return new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: err instanceof Error ? err.message : "internal strategic opportunity/risk error",
  });
}

export const strategicOpportunityRiskRouter = createRouter({
  /**
   * One governed candidate derivation over the supplied R8-D reasoning refs.
   * Deterministic: same authoritative basis ⇒ same candidateId ⇒ durable
   * convergence (idempotent_replay) with zero extra audit events. R8-F
   * governance is mandatory; BLOCK is terminal; REVIEW_REQUIRED requires a
   * bound human approval before the candidate reads as governed.
   */
  derive: authedQuery
    .input(DeriveStrategicCandidateInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const deps: StrategicOpportunityRiskDeps = {
        reasoning: createRawSqlStrategicReasoningReadPort(db),
        governance: getStrategicOpportunityRiskGovernanceEngine(),
        approvals: createRawSqlStrategicOpportunityRiskApprovalReadPort(db),
      };
      try {
        return await db.transaction(async (tx) =>
          deriveStrategicCandidates(
            {
              userId: ctx.user.id,
              businessId: input.businessId,
              reasoningIds: input.reasoningIds,
              modelCandidateTypes: input.modelAssistance?.candidateTypes,
            },
            deps,
            bindStrategicOpportunityRiskStoreExecutor(tx)
          )
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** One candidate + derived approval state (tenant-scoped). */
  get: authedQuery.input(GetStrategicCandidateInputSchema).query(async ({ ctx, input }) => {
    const db = getDb();
    const deps: StrategicOpportunityRiskDeps = {
      reasoning: createRawSqlStrategicReasoningReadPort(db),
      governance: getStrategicOpportunityRiskGovernanceEngine(),
      approvals: createRawSqlStrategicOpportunityRiskApprovalReadPort(db),
    };
    try {
      return await getStrategicCandidateForUser({
        userId: ctx.user.id,
        candidateId: input.candidateId,
        deps,
        executor: bindStrategicOpportunityRiskStoreExecutor(db),
      });
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /** Immutable candidate history (filters optional). */
  list: authedQuery.input(ListStrategicCandidatesInputSchema).query(async ({ ctx, input }) => {
    const db = getDb();
    const deps: StrategicOpportunityRiskDeps = {
      reasoning: createRawSqlStrategicReasoningReadPort(db),
      governance: getStrategicOpportunityRiskGovernanceEngine(),
      approvals: createRawSqlStrategicOpportunityRiskApprovalReadPort(db),
    };
    try {
      return await listStrategicCandidatesForUser({
        userId: ctx.user.id,
        businessId: input.businessId,
        status: input.status,
        candidateKind: input.candidateKind,
        priorityClass: input.priorityClass,
        deps,
        executor: bindStrategicOpportunityRiskStoreExecutor(db),
      });
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /** Durable overlap/portfolio relations of one candidate (lineage only). */
  listRelations: authedQuery
    .input(ListStrategicCandidateRelationsInputSchema)
    .query(async ({ ctx, input }) => {
      const db = getDb();
      try {
        return await listStrategicCandidateRelationsForUser({
          userId: ctx.user.id,
          candidateId: input.candidateId,
          executor: bindStrategicOpportunityRiskStoreExecutor(db),
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Append-only sorl1: lifecycle history of one candidate. */
  listLifecycle: authedQuery
    .input(ListStrategicCandidateLifecycleInputSchema)
    .query(async ({ ctx, input }) => {
      const db = getDb();
      try {
        return await listStrategicCandidateLifecycleForUser({
          userId: ctx.user.id,
          candidateId: input.candidateId,
          executor: bindStrategicOpportunityRiskStoreExecutor(db),
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Re-evaluation (contract §8): re-reads the governing R8-D projection,
   * re-runs the pipeline. D lifecycle changes (supersession / contradiction /
   * staleness / invalidation) transition this candidate with append-only
   * facts; material governance change is re-bound with a fresh R8-F
   * evaluation. Terminal states replay unchanged (zero events).
   */
  reevaluate: authedQuery
    .input(ReevaluateStrategicCandidateInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const deps: StrategicOpportunityRiskDeps = {
        reasoning: createRawSqlStrategicReasoningReadPort(db),
        governance: getStrategicOpportunityRiskGovernanceEngine(),
        approvals: createRawSqlStrategicOpportunityRiskApprovalReadPort(db),
      };
      try {
        return await db.transaction(async (tx) =>
          reevaluateStrategicCandidate({
            userId: ctx.user.id,
            candidateId: input.candidateId,
            deps,
            executor: bindStrategicOpportunityRiskStoreExecutor(tx),
          })
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Frozen read-only handoff projection for R9 mission control
   * (`strategic-intelligence-to-mission-control/v1`). Governance-eligible,
   * freshness-current candidates only unless `includeNonGoverned`. R9 may
   * read; it must never mutate R8 authority. candidate != mission;
   * recommendation != execution authorization.
   */
  getMissionControlHandoff: authedQuery
    .input(GetMissionControlHandoffInputSchema)
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const deps: StrategicOpportunityRiskDeps = {
        reasoning: createRawSqlStrategicReasoningReadPort(db),
        governance: getStrategicOpportunityRiskGovernanceEngine(),
        approvals: createRawSqlStrategicOpportunityRiskApprovalReadPort(db),
      };
      try {
        return await getMissionControlHandoff({
          userId: ctx.user.id,
          businessId: input.businessId,
          includeNonGoverned: input.includeNonGoverned,
          deps,
          executor: bindStrategicOpportunityRiskStoreExecutor(db),
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
});
