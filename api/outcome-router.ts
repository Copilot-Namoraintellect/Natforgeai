/**
 * Outcome Router (WBS-R7-A).
 *
 * The server-side surface of the business-outcome authority. Authority rules:
 * - the client may REPORT business-outcome evidence against a canonical R6-E
 *   conversion and supply a closed-vocabulary outcome-type proposal; it can
 *   never supply outcome status, verification state, evidence authority,
 *   outcome identity, evidence hash, or any "verified*" field (strict zod
 *   boundary + pure client-authority guard reject smuggling, fail closed);
 * - business/conversion/lead/lineage ownership is re-verified server-side
 *   against durable rows on every call (cross-tenant requests fail closed);
 * - classification is deterministic and rule-first; evidence authority and the
 *   initial status are server-derived only (no model is outcome authority);
 * - provenance is reference-only and NEVER asserted as causation or
 *   attribution (the downstream projection disclaims both, verbatim);
 * - no payment, billing, CRM, lead, score, qualification, or nurture effect is
 *   ever produced here.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import {
  OUTCOME_STATUSES,
  OUTCOME_TYPES,
  OUTCOME_VALUE_TYPES,
  OutcomeError,
  OutcomeIdentityConflictError,
  OutcomeInputError,
  OutcomeOwnershipError,
  OutcomeStateConflictError,
  OutcomeTamperError,
  OutcomeValidationError,
  outcomeRecordInputSchema,
  outcomeVerifyInputSchema,
} from "./lib/outcome/outcome-contract";
import { recordOutcome, verifyOutcome } from "./lib/outcome/outcome-service";
import {
  assertOutcomeEvidenceIntegrity,
  getOutcomeByOutcomeId,
  listOutcomeLifecycleEvents,
  listOutcomes,
  type ListOutcomesFilter,
} from "./lib/outcome/outcome-store";
import { buildOutcomeProjection } from "./lib/outcome/outcome-projection";

/** Surface the stable domain code in the message (house style) unless present. */
function withCode(err: OutcomeError): string {
  return err.message.includes(err.code) ? err.message : `${err.code}: ${err.message}`;
}

function toTrpcError(err: unknown): never {
  if (err instanceof OutcomeOwnershipError) {
    throw new TRPCError({ code: "FORBIDDEN", message: withCode(err) });
  }
  if (
    err instanceof OutcomeIdentityConflictError ||
    err instanceof OutcomeStateConflictError ||
    err instanceof OutcomeTamperError
  ) {
    throw new TRPCError({ code: "CONFLICT", message: withCode(err) });
  }
  if (err instanceof OutcomeInputError || err instanceof OutcomeValidationError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  if (err instanceof OutcomeError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  throw err;
}

const listFiltersSchema = z
  .object({
    businessId: z.number().int().positive().optional(),
    leadId: z.number().int().positive().optional(),
    conversionId: z.string().min(1).max(69).optional(),
    outcomeType: z.enum(OUTCOME_TYPES).optional(),
    outcomeStatus: z.enum(OUTCOME_STATUSES).optional(),
    valueType: z.enum(OUTCOME_VALUE_TYPES).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();

const outcomeIdSchema = z.object({ outcomeId: z.string().min(1).max(69) }).strict();

async function projectWithLifecycle(
  userId: number,
  outcome: NonNullable<Awaited<ReturnType<typeof getOutcomeByOutcomeId>>>
) {
  assertOutcomeEvidenceIntegrity(outcome as never);
  const lifecycle = await listOutcomeLifecycleEvents(userId, outcome.outcomeId);
  return {
    outcome,
    lifecycle,
    projection: buildOutcomeProjection(outcome as never, lifecycle),
  };
}

export const outcomeRouter = createRouter({
  /**
   * Record one business outcome from a canonical R6-E conversion. Idempotent:
   * retries/replays converge to the durable row; reversal/renewal/supersession
   * lineage additionally mints a deterministic lifecycle fact and transitions
   * the target status under CAS.
   */
  record: authedQuery.input(outcomeRecordInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await recordOutcome(undefined, {}, { userId: ctx.user.id }, input, new Date().toISOString());
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /**
   * Governed verification transition (OBSERVED/PROVISIONAL → VERIFIED) bound to
   * corroborating authoritative evidence. User attestation and unverified
   * external evidence can never verify.
   */
  verify: authedQuery.input(outcomeVerifyInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await verifyOutcome(undefined, { userId: ctx.user.id }, input, new Date().toISOString());
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /** Tenant-scoped read of one outcome with its lifecycle + downstream projection. */
  get: authedQuery.input(outcomeIdSchema).query(async ({ ctx, input }) => {
    const row = await getOutcomeByOutcomeId(ctx.user.id, input.outcomeId);
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Outcome not found." });
    }
    return projectWithLifecycle(ctx.user.id, row);
  }),

  /** Tenant-scoped list with optional filters; returns rows + projections. */
  list: authedQuery.input(listFiltersSchema).query(async ({ ctx, input }) => {
    const filters: ListOutcomesFilter = { ...input };
    const rows = await listOutcomes(ctx.user.id, filters);
    const projections = [];
    for (const row of rows) {
      assertOutcomeEvidenceIntegrity(row);
      const lifecycle = await listOutcomeLifecycleEvents(ctx.user.id, row.outcomeId);
      projections.push(buildOutcomeProjection(row, lifecycle));
    }
    return { outcomes: rows, projections };
  }),

  /** Downstream (R7-B/R7-C) projections only — read-only, no raw mutation surface. */
  r7Projections: authedQuery.input(listFiltersSchema).query(async ({ ctx, input }) => {
    const filters: ListOutcomesFilter = { ...input };
    const rows = await listOutcomes(ctx.user.id, filters);
    const projections = [];
    for (const row of rows) {
      assertOutcomeEvidenceIntegrity(row);
      const lifecycle = await listOutcomeLifecycleEvents(ctx.user.id, row.outcomeId);
      projections.push(buildOutcomeProjection(row, lifecycle));
    }
    return projections;
  }),

  /** Lifecycle history for one tenant-scoped outcome. */
  listLifecycle: authedQuery.input(outcomeIdSchema).query(async ({ ctx, input }) => {
    const row = await getOutcomeByOutcomeId(ctx.user.id, input.outcomeId);
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Outcome not found." });
    }
    return listOutcomeLifecycleEvents(ctx.user.id, input.outcomeId);
  }),
});
