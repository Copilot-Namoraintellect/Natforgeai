/**
 * Conversion Router (WBS-R6-E).
 *
 * The server-side surface of the conversion/outcome authority. Authority
 * rules:
 * - the client may REPORT a conversion and supply provenance references; it
 *   can never supply trust class, outcome status, identity, evidence hash or
 *   any "verified*" field (strict zod boundary + pure client-authority guard
 *   reject smuggling, fail closed);
 * - business/lead/campaign/opportunity/receipt/signal ownership is
 *   re-verified server-side against durable rows on every call (cross-tenant
 *   requests fail closed);
 * - trust class and the initial outcome status are server-derived only;
 * - provenance lineage is recorded but NEVER asserted as causation (the R7
 *   projection carries an explicit causation disclaimer).
 *
 * No lead, score, or outreach is ever created here.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import {
  CONVERSION_OUTCOME_STATUSES,
  CONVERSION_TRUST_CLASSES,
  CONVERSION_TYPES,
  ConversionError,
  ConversionIdentityConflictError,
  ConversionInputError,
  ConversionOwnershipError,
  ConversionStateConflictError,
  ConversionTamperError,
  ConversionValidationError,
  conversionIngestInputSchema,
} from "./lib/conversion/conversion-contract";
import { ingestConversion } from "./lib/conversion/conversion-service";
import {
  assertConversionEvidenceIntegrity,
  getConversionByConversionId,
  listConversions,
  listLifecycleEvents,
  type ListConversionsFilter,
} from "./lib/conversion/conversion-store";
import { buildR7ConversionProjection } from "./lib/conversion/conversion-projection";

/** Surface the stable domain code in the message (house style) unless present. */
function withCode(err: ConversionError): string {
  return err.message.includes(err.code) ? err.message : `${err.code}: ${err.message}`;
}

function toTrpcError(err: unknown): never {
  if (err instanceof ConversionOwnershipError) {
    throw new TRPCError({ code: "FORBIDDEN", message: withCode(err) });
  }
  if (
    err instanceof ConversionIdentityConflictError ||
    err instanceof ConversionStateConflictError ||
    err instanceof ConversionTamperError
  ) {
    throw new TRPCError({ code: "CONFLICT", message: withCode(err) });
  }
  if (err instanceof ConversionInputError || err instanceof ConversionValidationError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  if (err instanceof ConversionError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  throw err;
}

const listFiltersSchema = z
  .object({
    businessId: z.number().int().positive().optional(),
    leadId: z.number().int().positive().optional(),
    conversionType: z.enum(CONVERSION_TYPES).optional(),
    outcomeStatus: z.enum(CONVERSION_OUTCOME_STATUSES).optional(),
    sourceTrustClass: z.enum(CONVERSION_TRUST_CLASSES).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();

const r7FiltersSchema = z
  .object({
    businessId: z.number().int().positive().optional(),
    leadId: z.number().int().positive().optional(),
    conversionType: z.enum(CONVERSION_TYPES).optional(),
    outcomeStatus: z.enum(CONVERSION_OUTCOME_STATUSES).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();

const conversionIdSchema = z.object({ conversionId: z.string().min(1).max(69) }).strict();

async function projectWithLifecycle(
  userId: number,
  conversion: Awaited<ReturnType<typeof getConversionByConversionId>> & object
) {
  assertConversionEvidenceIntegrity(conversion as never);
  const lifecycle = await listLifecycleEvents(userId, conversion.conversionId);
  return {
    conversion,
    lifecycle,
    projection: buildR7ConversionProjection(conversion as never, lifecycle),
  };
}

export const conversionRouter = createRouter({
  /**
   * Ingest one conversion outcome. Idempotent: retries/replays converge to the
   * durable row; reversal types additionally mint a deterministic lifecycle
   * fact and transition the target outcome status.
   */
  ingest: authedQuery.input(conversionIngestInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await ingestConversion(undefined, {}, { userId: ctx.user.id }, input, new Date().toISOString());
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /** Tenant-scoped read of one conversion with its lifecycle + R7 projection. */
  get: authedQuery.input(conversionIdSchema).query(async ({ ctx, input }) => {
    const row = await getConversionByConversionId(ctx.user.id, input.conversionId);
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Conversion not found." });
    }
    return projectWithLifecycle(ctx.user.id, row);
  }),

  /** Tenant-scoped list with optional filters; returns rows + projections. */
  list: authedQuery.input(listFiltersSchema).query(async ({ ctx, input }) => {
    const filters: ListConversionsFilter = { ...input };
    const rows = await listConversions(ctx.user.id, filters);
    const projections = [];
    for (const row of rows) {
      assertConversionEvidenceIntegrity(row);
      const lifecycle = await listLifecycleEvents(ctx.user.id, row.conversionId);
      projections.push(buildR7ConversionProjection(row, lifecycle));
    }
    return { conversions: rows, projections };
  }),

  /** R7 attribution projections only (no raw rows, no PII). */
  r7Projections: authedQuery.input(r7FiltersSchema).query(async ({ ctx, input }) => {
    const filters: ListConversionsFilter = { ...input };
    const rows = await listConversions(ctx.user.id, filters);
    const projections = [];
    for (const row of rows) {
      assertConversionEvidenceIntegrity(row);
      const lifecycle = await listLifecycleEvents(ctx.user.id, row.conversionId);
      projections.push(buildR7ConversionProjection(row, lifecycle));
    }
    return projections;
  }),

  /** Lifecycle history for one tenant-scoped conversion. */
  listLifecycle: authedQuery.input(conversionIdSchema).query(async ({ ctx, input }) => {
    const row = await getConversionByConversionId(ctx.user.id, input.conversionId);
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Conversion not found." });
    }
    return listLifecycleEvents(ctx.user.id, input.conversionId);
  }),
});
