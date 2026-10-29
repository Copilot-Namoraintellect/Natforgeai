/**
 * Business Learning router — R7-C governed learning surface.
 *
 * Learning is evidence, not authority: this router derives durable,
 * evidence-bounded learning records from frozen R7-A outcome projections
 * and R7-B attribution projections (consumed via seams, never merged), and
 * exposes narrow read-only projections for R7-D experimentation / R7-E
 * optimisation. Nothing here mutates upstream or downstream authority, and
 * no governance decision is made — R7-D/R7-E must separately obtain R7-F
 * authority before any material action.
 *
 * Clients reference ids only: every input is a strict object and any
 * client-supplied authority field is rejected at the boundary.
 */

import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { assertNoClientAuthorityFields } from "./lib/business-learning/business-learning-contract";
import {
  deriveBusinessLearning,
  synchronizeBusinessLearning,
  getBusinessLearning,
  listBusinessLearning,
  getCurrentLearningForSubject,
  getExperimentOptimisationProjection,
  listExperimentOptimisationProjections,
} from "./lib/business-learning/business-learning-service";

const out1IdSchema = z.string().regex(/^out1:[a-f0-9]{64}$/, "outcomeId must be an out1: id");
const atr1IdSchema = z.string().regex(/^atr1:[a-f0-9]{64}$/, "attributionId must be an atr1: id");
const lrn1IdSchema = z.string().regex(/^lrn1:[a-f0-9]{64}$/, "learningId must be an lrn1: id");

export const businessLearningRouter = createRouter({
  derive: authedQuery
    .input(
      z.strictObject({
        outcomeIds: z.array(out1IdSchema).min(1).max(200),
        attributionIds: z.array(atr1IdSchema).min(1).max(200),
        narrativeDraft: z.string().min(1).max(4096).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertNoClientAuthorityFields(input as Record<string, unknown>);
      return deriveBusinessLearning(ctx.user.id, input);
    }),

  synchronize: authedQuery
    .input(
      z
        .strictObject({
          outcomeId: out1IdSchema.optional(),
          attributionId: atr1IdSchema.optional(),
        })
        .refine((value) => (value.outcomeId ? 1 : 0) + (value.attributionId ? 1 : 0) === 1, {
          message: "Exactly one of outcomeId or attributionId is required.",
        })
    )
    .mutation(async ({ ctx, input }) => {
      return synchronizeBusinessLearning(ctx.user.id, input);
    }),

  get: authedQuery
    .input(z.strictObject({ learningId: lrn1IdSchema }))
    .query(async ({ ctx, input }) => {
      return getBusinessLearning(ctx.user.id, input.learningId);
    }),

  list: authedQuery
    .input(
      z.strictObject({
        businessId: z.number().int().positive().optional(),
        status: z
          .enum(["CANDIDATE", "SUPPORTED", "CONTRADICTED", "SUPERSEDED", "DEPRECATED", "INVALIDATED"])
          .optional(),
        subjectType: z
          .enum([
            "CAMPAIGN",
            "PUBLICATION",
            "ENGAGEMENT",
            "OPPORTUNITY",
            "NURTURE_TOUCH",
            "SALES_HANDOFF",
            "OUTCOME",
            "INSUFFICIENT",
          ])
          .optional(),
        subjectId: z.string().min(1).max(191).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      return listBusinessLearning(ctx.user.id, input);
    }),

  getCurrentForSubject: authedQuery
    .input(z.strictObject({ subjectType: z.string().min(1).max(24), subjectId: z.string().min(1).max(191) }))
    .query(async ({ ctx, input }) => {
      return getCurrentLearningForSubject(ctx.user.id, input.subjectType, input.subjectId);
    }),

  // ─── Read-only downstream projections (R7-D / R7-E consumption surface) ───

  getExperimentProjection: authedQuery
    .input(z.strictObject({ learningId: lrn1IdSchema }))
    .query(async ({ ctx, input }) => {
      return getExperimentOptimisationProjection(ctx.user.id, input.learningId);
    }),

  listExperimentProjections: authedQuery
    .input(z.strictObject({}))
    .query(async ({ ctx }) => {
      return listExperimentOptimisationProjections(ctx.user.id);
    }),
});
