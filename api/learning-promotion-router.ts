/**
 * Learning promotion router (WBS15.6) — governed promotion boundary surface.
 *
 * Exposes proposal creation and inspection only. Approval and rejection are
 * deliberately NOT implemented here: the only authority path is the existing
 * Approval Centre decision flow (trpc.approval.approveAction / rejectAction),
 * which validates the exact immutable proposal binding and seals the durable
 * approved promotion envelope inside the same transaction as the human
 * decision. There is no autonomous Learning -> BI/Strategy mutation.
 */

import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import {
  getApprovedPromotionEnvelopes,
  getLearningPromotionProposal,
  listLearningPromotionProposals,
  proposeLearningPromotion,
} from "./lib/learning/promotion/promotion-service";

export const learningPromotionRouter = createRouter({
  propose: authedQuery
    .input(
      z.object({
        learningRecordId: z.number().int().positive(),
        recommendationId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return proposeLearningPromotion({
        userId: ctx.user.id,
        learningRecordId: input.learningRecordId,
        recommendationId: input.recommendationId,
      });
    }),

  proposals: authedQuery
    .input(z.object({ campaignId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      return listLearningPromotionProposals({
        userId: ctx.user.id,
        campaignId: input.campaignId,
      });
    }),

  proposal: authedQuery
    .input(z.object({ approvalRequestId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      return getLearningPromotionProposal({
        userId: ctx.user.id,
        approvalRequestId: input.approvalRequestId,
      });
    }),

  /**
   * WBS15.7 consumption seam: durable approved promotion envelopes that pass
   * fail-closed availability validation. A future BI/Strategy generation
   * cycle consumes exactly these envelopes — nothing else is promotion
   * authority.
   */
  approvedEnvelopes: authedQuery
    .input(z.object({ campaignId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      return getApprovedPromotionEnvelopes({
        userId: ctx.user.id,
        campaignId: input.campaignId,
      });
    }),
});
