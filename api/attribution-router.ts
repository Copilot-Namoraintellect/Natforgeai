/**
 * Attribution Router (WBS-R7-B).
 *
 * The server-side surface of the attribution authority. Authority rules:
 * - the client may reference an outcome and choose a model from the closed
 *   allow-list; it can never supply credit, weights, confidence, evidence
 *   class, window, identity, hashes, or any causal/authority field (strict
 *   zod boundary + pure client-authority guard reject smuggling, fail closed);
 * - outcome/business/lead/touchpoint ownership is consumed through the frozen
 *   upstream contracts and re-verified server-side on every call;
 * - allocation is deterministic integer arithmetic over durable rows — no LLM
 *   in the path, no client-supplied weights, no causal claims, ever;
 * - no upstream table (R4/R5/R6/R7-A) is ever written by this stream.
 *
 * Association is not causation: every read surface carries the disclaimer.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import {
  ATTRIBUTION_MODEL_TYPES,
  AttributionError,
  AttributionIdentityConflictError,
  AttributionInputError,
  AttributionOwnershipError,
  AttributionStateError,
  AttributionTamperError,
  attributionEvaluateInputSchema,
} from "./lib/attribution/attribution-contract";
import {
  evaluateAttribution,
  synchronizeAttribution,
} from "./lib/attribution/attribution-service";
import {
  getAttributionById,
  listAttributions,
  type ListAttributionsFilter,
} from "./lib/attribution/attribution-store";
import { buildAttributionLearningProjection } from "./lib/attribution/attribution-projection";

/** Surface the stable domain code in the message (house style) unless present. */
function withCode(err: AttributionError): string {
  return err.message.includes(err.code) ? err.message : `${err.code}: ${err.message}`;
}

function toTrpcError(err: unknown): never {
  if (err instanceof AttributionOwnershipError) {
    throw new TRPCError({ code: "FORBIDDEN", message: withCode(err) });
  }
  if (err instanceof AttributionIdentityConflictError || err instanceof AttributionTamperError) {
    throw new TRPCError({ code: "CONFLICT", message: withCode(err) });
  }
  if (err instanceof AttributionInputError || err instanceof AttributionStateError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  if (err instanceof AttributionError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  throw err;
}

const attributionIdSchema = z
  .object({ attributionId: z.string().min(1).max(69) })
  .strict();

const listFiltersSchema = z
  .object({
    outcomeId: z.string().min(1).max(69).optional(),
    businessId: z.number().int().positive().optional(),
    modelType: z.enum(ATTRIBUTION_MODEL_TYPES).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();

const evaluateInputSchema = attributionEvaluateInputSchema;

export const attributionRouter = createRouter({
  /**
   * Evaluate one attribution for a canonical R7-A outcome. Idempotent:
   * identical replays/concurrent duplicates converge; new evidence or
   * model/policy change mints a new supersession-linked result.
   */
  evaluate: authedQuery.input(evaluateInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await evaluateAttribution(
        undefined,
        {},
        { userId: ctx.user.id },
        input,
        new Date().toISOString()
      );
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /**
   * Synchronize after an outcome lifecycle change. A reversed/cancelled/
   * superseded outcome retires any active positive attribution through a
   * zero-credit successor (history preserved); an attributable outcome
   * re-evaluates through the normal pipeline.
   */
  synchronize: authedQuery.input(evaluateInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await synchronizeAttribution(
        undefined,
        {},
        { userId: ctx.user.id },
        input,
        new Date().toISOString()
      );
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /** Tenant-scoped read of one attribution result + learning projection. */
  get: authedQuery.input(attributionIdSchema).query(async ({ ctx, input }) => {
    const row = await getAttributionById(ctx.user.id, input.attributionId);
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Attribution not found." });
    }
    return { result: row, projection: buildAttributionLearningProjection(row) };
  }),

  /** Tenant-scoped list with optional filters; results + projections. */
  list: authedQuery.input(listFiltersSchema).query(async ({ ctx, input }) => {
    const filters: ListAttributionsFilter = {
      outcomeId: input.outcomeId,
      businessId: input.businessId,
      modelType: input.modelType,
      limit: input.limit ?? 100,
    };
    const rows = await listAttributions(ctx.user.id, filters);
    return {
      results: rows,
      projections: rows.map((r) => buildAttributionLearningProjection(r)),
    };
  }),
});
