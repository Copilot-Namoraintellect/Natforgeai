/**
 * Opportunity router — R5-D governed opportunity-detection surface.
 *
 * Narrow, tenant-scoped, authed-only. Evaluation accepts a canonical R5-B
 * interpretation record (structurally adapted at R5-X convergence), validates
 * ownership server-side, and produces exactly one durable outcome: an
 * evidence-backed pre-lead opportunity candidate or a durable suppression.
 * This stream never creates leads, scores, CRM rows, or outreach actions.
 */

import { z } from "zod";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import {
  evaluateOpportunity,
  attachEngagementEvidence,
  suppressCandidate,
  unsuppressCandidate,
  escalateCandidate,
  sweepExpiredOpportunities,
  handoffToR6,
  listOpportunities,
  getOpportunity,
  listOpportunityHandoffs,
} from "./lib/opportunity/detector";

export const opportunityRouter = createRouter({
  /**
   * Evaluate one R5-B canonical interpretation for opportunity evidence.
   * Identity/ownership are server-derived; clients may not supply confidence,
   * opportunity types, or status.
   */
  evaluate: authedQuery
    .input(z.object({ interpretation: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      return evaluateOpportunity({
        interpretation: input.interpretation,
        userId: ctx.user.id,
      });
    }),

  /** Attach an R5-C engagement receipt (validated seam) as enrichment evidence. */
  attachEngagementEvidence: authedQuery
    .input(z.object({ opportunityId: z.string().min(1), receipt: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      return attachEngagementEvidence({
        opportunityId: input.opportunityId,
        receipt: input.receipt,
        userId: ctx.user.id,
      });
    }),

  list: authedQuery
    .input(
      z
        .object({
          status: z.string().optional(),
          opportunityType: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return listOpportunities(ctx.user.id, input ?? {});
    }),

  get: authedQuery
    .input(z.object({ opportunityId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      return getOpportunity(ctx.user.id, input.opportunityId);
    }),

  suppress: authedQuery
    .input(z.object({ opportunityId: z.string().min(1), reason: z.string().min(1).max(255) }))
    .mutation(async ({ ctx, input }) => {
      return suppressCandidate({
        opportunityId: input.opportunityId,
        userId: ctx.user.id,
        reason: input.reason,
      });
    }),

  unsuppress: authedQuery
    .input(z.object({ opportunityId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return unsuppressCandidate({ opportunityId: input.opportunityId, userId: ctx.user.id });
    }),

  escalate: authedQuery
    .input(z.object({ opportunityId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return escalateCandidate({ opportunityId: input.opportunityId, userId: ctx.user.id });
    }),

  /** Deterministic expiry sweep across tenants (operator/maintenance surface). */
  sweepExpiry: adminQuery.mutation(async () => {
    return sweepExpiredOpportunities({});
  }),

  /** Durable, exactly-once R6 handoff envelope. R5 never creates the lead. */
  handoffToR6: authedQuery
    .input(z.object({ opportunityId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return handoffToR6({ opportunityId: input.opportunityId, userId: ctx.user.id });
    }),

  listHandoffs: authedQuery.query(async ({ ctx }) => {
    return listOpportunityHandoffs(ctx.user.id);
  }),
});
