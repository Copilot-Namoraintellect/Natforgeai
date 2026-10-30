/**
 * Strategic reasoning router — R8-D governed strategic-reasoning surface.
 *
 * Narrow, tenant-scoped, authed-only. Clients supply evidence reference ids
 * and business scope only: no decision, confidence, uncertainty, risk class,
 * trust class, status, approval state, fingerprint, policy or graph material
 * may be supplied (strictObject input schemas, contract §9). Evaluation
 * resolves every evidence reference server-side, runs the deterministic
 * rule-first synthesis, persists the immutable conclusion exactly once, and
 * binds the mandatory R8-F governance decision. This stream never executes
 * strategic conclusions, never touches campaigns, strategy, budgets,
 * Business DNA, billing/payments/providers/CRM, and never becomes a
 * governance engine.
 */

import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { createStrategicEvidenceAuthority } from "./lib/strategic-reasoning/strategic-reasoning-evidence-seam";
import { createStrategicApprovalReadPort } from "./lib/strategic-reasoning/strategic-reasoning-governance-seam";
import {
  evaluateStrategicReasoning,
  getStrategicReasoningForUser,
  getStrategicReasoningHandoffProjections,
  listStrategicReasoningForUser,
  reevaluateStrategicReasoning,
} from "./lib/strategic-reasoning/strategic-reasoning-service";
import { bindStrategicReasoningStoreExecutor } from "./lib/strategic-reasoning/strategic-reasoning-store";
import {
  EvaluateStrategicReasoningInputSchema,
  GetStrategicReasoningHandoffInputSchema,
  GetStrategicReasoningInputSchema,
  ListStrategicReasoningInputSchema,
  ListStrategicReasoningLifecycleInputSchema,
  ReevaluateStrategicReasoningInputSchema,
  StrategicReasoningError,
  type StrategicReasoningErrorCode,
} from "./lib/strategic-reasoning/strategic-reasoning-contract";

const NOT_FOUND_CODES: ReadonlySet<StrategicReasoningErrorCode> = new Set(["REASONING_NOT_FOUND"]);

const FORBIDDEN_CODES: ReadonlySet<StrategicReasoningErrorCode> = new Set([
  "OWNERSHIP_MISMATCH",
  "UNKNOWN_EVIDENCE_REFERENCE",
  "EVIDENCE_SCOPE_MISMATCH",
]);

const CONFLICT_CODES: ReadonlySet<StrategicReasoningErrorCode> = new Set([
  "REASONING_REPLAY_CONFLICT",
  "EVIDENCE_FINGERPRINT_MISMATCH",
  "LIFECYCLE_CONFLICT",
  "APPROVAL_BINDING_MISMATCH",
]);

/** Maps the reasoning error taxonomy onto stable tRPC codes (fail closed). */
export function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof StrategicReasoningError) {
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
    message: err instanceof Error ? err.message : "internal strategic reasoning error",
  });
}

export const strategicReasoningRouter = createRouter({
  /**
   * One governed strategic-reasoning evaluation. Deterministic: same
   * authoritative evidence set ⇒ same evidenceBundleId ⇒ same reasoningId ⇒
   * durable convergence; replay returns the existing conclusion
   * (idempotent_replay) with zero extra audit events. Governance (R8-F) is
   * mandatory for voiced recommendations; BLOCK is terminal; REVIEW_REQUIRED
   * requires a bound human approval before the conclusion reads as approved.
   */
  evaluate: authedQuery
    .input(EvaluateStrategicReasoningInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const deps = {
        evidence: createStrategicEvidenceAuthority(),
        approvals: createStrategicApprovalReadPort(),
      };
      try {
        return await db.transaction(async (tx) =>
          evaluateStrategicReasoning(
            {
              userId: ctx.user.id,
              businessId: input.businessId,
              memoryRefs: input.memoryRefs,
              changeRefs: input.changeRefs,
              externalSignalRefs: input.externalSignalRefs,
              modelCandidateHypothesisTypes: input.modelAssistance?.candidateHypothesisTypes,
            },
            deps,
            bindStrategicReasoningStoreExecutor(tx)
          )
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** One conclusion + lifecycle + derived approval state (tenant-scoped). */
  get: authedQuery.input(GetStrategicReasoningInputSchema).query(async ({ ctx, input }) => {
    const db = getDb();
    const executor = bindStrategicReasoningStoreExecutor(db);
    const deps = {
      evidence: createStrategicEvidenceAuthority(),
      approvals: createStrategicApprovalReadPort(),
    };
    try {
      return await getStrategicReasoningForUser({
        userId: ctx.user.id,
        reasoningId: input.reasoningId,
        deps,
        executor,
      });
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /** Immutable conclusion history (filters optional), oldest-first. */
  list: authedQuery.input(ListStrategicReasoningInputSchema).query(async ({ ctx, input }) => {
    const db = getDb();
    const executor = bindStrategicReasoningStoreExecutor(db);
    const deps = {
      evidence: createStrategicEvidenceAuthority(),
      approvals: createStrategicApprovalReadPort(),
    };
    try {
      return await listStrategicReasoningForUser({
        userId: ctx.user.id,
        businessId: input.businessId,
        status: input.status,
        hypothesisType: input.hypothesisType,
        deps,
        executor,
      });
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /** Append-only srl1: lifecycle history of one conclusion. */
  listLifecycle: authedQuery
    .input(ListStrategicReasoningLifecycleInputSchema)
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const executor = bindStrategicReasoningStoreExecutor(db);
      try {
        const result = await getStrategicReasoningForUser({
          userId: ctx.user.id,
          reasoningId: input.reasoningId,
          deps: {
            evidence: createStrategicEvidenceAuthority(),
            approvals: createStrategicApprovalReadPort(),
          },
          executor,
        });
        return { lifecycle: result.lifecycle };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Re-evaluation (contract §8): re-resolves the bound evidence, re-runs the
   * pipeline. Material change ⇒ a NEW superseding record (immutable history);
   * unchanged ⇒ idempotent convergence, with contradiction / staleness
   * demotions recorded as append-only lifecycle facts.
   */
  reevaluate: authedQuery
    .input(ReevaluateStrategicReasoningInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const deps = {
        evidence: createStrategicEvidenceAuthority(),
        approvals: createStrategicApprovalReadPort(),
      };
      try {
        return await db.transaction(async (tx) =>
          reevaluateStrategicReasoning(
            {
              userId: ctx.user.id,
              reasoningId: input.reasoningId,
              deps,
              executor: bindStrategicReasoningStoreExecutor(tx),
            }
          )
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Frozen read-only handoff projection for R8-E opportunity/risk
   * intelligence (`strategic-reasoning-to-opportunity-risk/v1`). R8-E may
   * rank and classify; it must never mutate R8-D authority.
   */
  getHandoffProjections: authedQuery
    .input(GetStrategicReasoningHandoffInputSchema)
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const executor = bindStrategicReasoningStoreExecutor(db);
      const deps = {
        evidence: createStrategicEvidenceAuthority(),
        approvals: createStrategicApprovalReadPort(),
      };
      try {
        return await getStrategicReasoningHandoffProjections({
          userId: ctx.user.id,
          businessId: input.businessId,
          includeNonActive: input.includeNonActive,
          deps,
          executor,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
});
