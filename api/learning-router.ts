/**
 * Learning router — internal callable surface for the Phase 1 Learning engine.
 *
 * Phase 1 scope: evaluation is user-initiated only (manual trigger via
 * `evaluate`); there is no autonomous/scheduled trigger. Output is governed
 * recommendation data — nothing here mutates Strategy, Creative or
 * Distribution state.
 */

import { z } from "zod";
import { createRouter, authedQuery, aiActionQuery } from "./middleware";
import {
  evaluateCampaignLearning,
  getLearningRecord,
  listLearningRecords,
} from "./lib/learning/learning-service";

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const learningRouter = createRouter({
  evaluate: aiActionQuery
    .input(
      z.object({
        campaignId: z.number().int().positive(),
        windowStart: isoDateSchema.optional(),
        windowEnd: isoDateSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return evaluateCampaignLearning({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        trigger: "manual",
      });
    }),

  records: authedQuery
    .input(z.object({ campaignId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      return listLearningRecords({
        userId: ctx.user.id,
        campaignId: input.campaignId,
      });
    }),

  record: authedQuery
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      return getLearningRecord({ userId: ctx.user.id, id: input.id });
    }),
});
