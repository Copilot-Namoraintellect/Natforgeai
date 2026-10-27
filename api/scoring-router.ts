/**
 * Lead scoring router — R6-B governed lead-scoring surface.
 *
 * Narrow, tenant-scoped, authed-only. Clients may supply ONLY a leadId
 * (strict schema: no score, no weights, no confidence, no evidence). The
 * server resolves identity, gathers R5 evidence, computes the deterministic
 * bounded score, and persists exactly one immutable record per (lead,
 * evidence snapshot, scoring version). A lead score is evidence, not a
 * qualification decision — this surface never qualifies leads, never touches
 * CRM/outreach, and never initiates governed marketing actions.
 */

import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { scoreLead, getScore, listScoreHistory } from "./lib/scoring/scoring-service";

export const scoringRouter = createRouter({
  /**
   * Score one canonical lead (idempotent, exact-once). Duplicate requests
   * replay the existing immutable score record; new evidence mints a new
   * versioned record. HIGH score ≠ qualified.
   */
  scoreLead: authedQuery
    .input(z.strictObject({ leadId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      return scoreLead({ userId: ctx.user.id, leadId: input.leadId });
    }),

  /** Read one immutable score record by its deterministic identity. */
  get: authedQuery
    .input(z.strictObject({ leadScoreId: z.string().min(1).max(69) }))
    .query(async ({ ctx, input }) => {
      return getScore(ctx.user.id, input.leadScoreId);
    }),

  /** Immutable score history for a lead (oldest first). */
  listHistory: authedQuery
    .input(z.strictObject({ leadId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      return listScoreHistory(ctx.user.id, input.leadId);
    }),
});
