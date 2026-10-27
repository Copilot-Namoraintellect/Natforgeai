// ─── R6-A Lead Identity — tRPC surface ───
//
// Thin boundary over the lead-identity authority. Every procedure is
// tenant-scoped from ctx.user.id; identity, merge, confidence, and status are
// never client-supplied. Intake accepts ONLY an opportunityId reference — the
// durable R5 envelope is loaded and verified server-side; clients can never
// submit envelope content, a leadId, or a merge.

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import {
  consumeOpportunityHandoff,
  submitIdentityEvidence,
  suppressLeadIdentity,
  archiveLeadIdentity,
  getLeadIdentity,
  listLeadIdentities,
} from "./lib/lead-identity/lead-identity-service";
import {
  IDENTITY_STATUS_VALUES,
  IDENTITY_TYPE_VALUES,
  IDENTITY_EVIDENCE_INPUT_TYPE_VALUES,
  IDENTITY_SUPPRESSION_REASON_VALUES,
  LeadIdentityOwnershipError,
  LeadIdentityInputError,
  LeadIdentityValidationError,
  LeadIdentityTamperError,
  LeadIdentityStateConflictError,
} from "./lib/lead-identity/lead-identity-contract";
import { findHandoff } from "./lib/opportunity/opportunity-store";

function toTrpcError(err: unknown): never {
  if (err instanceof LeadIdentityOwnershipError) {
    throw new TRPCError({ code: "FORBIDDEN", message: `${err.code}: ${err.message}` });
  }
  if (err instanceof LeadIdentityTamperError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${err.code}: ${err.message}` });
  }
  if (
    err instanceof LeadIdentityValidationError ||
    err instanceof LeadIdentityInputError ||
    err instanceof LeadIdentityStateConflictError
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${err.code}: ${err.message}` });
  }
  throw err;
}

export const leadIdentityRouter = createRouter({
  /**
   * Consume one R5 opportunity handoff envelope and resolve it to exactly one
   * canonical lead identity. The client supplies ONLY an opportunityId
   * reference; the durable envelope is loaded server-side (tenant-scoped) and
   * validated + tamper-verified before any identity is derived. Replay returns
   * the existing identity (`idempotent_replay`).
   */
  consumeOpportunityHandoff: authedQuery
    .input(z.object({ opportunityId: z.string().regex(/^opp1:[a-f0-9]{64}$/) }))
    .mutation(async ({ ctx, input }) => {
      const handoff = await findHandoff(ctx.user.id, input.opportunityId);
      if (!handoff) {
        // Forged/foreign/cross-tenant handoffs are indistinguishable from
        // missing ones — fail closed with a single safe error (no oracle).
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "OPPORTUNITY_HANDOFF_NOT_FOUND: no handoff envelope exists for this tenant.",
        });
      }
      try {
        return await consumeOpportunityHandoff({
          envelope: handoff.envelope,
          userId: ctx.user.id,
        });
      } catch (err) {
        toTrpcError(err);
      }
    }),

  /** Downstream-safe identity projection (A8). */
  get: authedQuery
    .input(z.object({ leadId: z.string().regex(/^lid1:[a-f0-9]{64}$/) }))
    .query(async ({ ctx, input }) => {
      try {
        return await getLeadIdentity(ctx.user.id, input.leadId);
      } catch (err) {
        toTrpcError(err);
      }
    }),

  /** Bounded, filtered identity listing (summary projections). */
  list: authedQuery
    .input(
      z
        .object({
          status: z.enum(IDENTITY_STATUS_VALUES).optional(),
          identityType: z.enum(IDENTITY_TYPE_VALUES).optional(),
          businessId: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return listLeadIdentities(ctx.user.id, input ?? {}, input?.limit ?? 50);
    }),

  /**
   * Controlled enrichment: submit verified identity evidence (email/phone/
   * customer reference). The raw value is normalized + hashed server-side and
   * never persisted; deterministic merge/conflict rules apply automatically.
   */
  submitIdentityEvidence: authedQuery
    .input(
      z.object({
        leadId: z.string().regex(/^lid1:[a-f0-9]{64}$/),
        evidenceType: z.enum(IDENTITY_EVIDENCE_INPUT_TYPE_VALUES),
        value: z.string().min(1).max(512),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await submitIdentityEvidence({
          userId: ctx.user.id,
          leadId: input.leadId,
          evidenceType: input.evidenceType,
          value: input.value,
        });
      } catch (err) {
        toTrpcError(err);
      }
    }),

  /** Governed suppression (privacy/safety/operator/data-quality). */
  suppress: authedQuery
    .input(
      z.object({
        leadId: z.string().regex(/^lid1:[a-f0-9]{64}$/),
        reason: z.enum(IDENTITY_SUPPRESSION_REASON_VALUES),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await suppressLeadIdentity({
          userId: ctx.user.id,
          leadId: input.leadId,
          reason: input.reason,
        });
      } catch (err) {
        toTrpcError(err);
      }
    }),

  /** Governed archival (terminal). */
  archive: authedQuery
    .input(z.object({ leadId: z.string().regex(/^lid1:[a-f0-9]{64}$/) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await archiveLeadIdentity({ userId: ctx.user.id, leadId: input.leadId });
      } catch (err) {
        toTrpcError(err);
      }
    }),
});
