/**
 * Intelligence router — tRPC surface for the R5-B intent & sentiment
 * interpretation authority (docs/contracts/social-intelligence-contract.md).
 *
 * Scope: interpretation only (contract §1). The router validates ownership
 * (business rows are owner-scoped by id AND userId, the same fail-closed
 * pattern as business-dna-governance), resolves real dependencies and returns
 * canonical records. Engagement execution, opportunity actions and final
 * engagement policy belong to downstream streams.
 */

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery, aiActionQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { businesses } from "@db/schema";
import {
  CanonicalSocialSignalInputSchema,
} from "./lib/intelligence/canonical-signal";
import { runInterpretation } from "./lib/intelligence/interpreter";
import {
  getInterpretationById,
  listInterpretationsForSignal,
} from "./lib/intelligence/interpretation-store";
import { getLatestBusinessDnaSnapshotForBusiness } from "./lib/business-dna-store";
import { persistAuditEvent } from "./lib/audit/audit-store";
import type { AuditEvent } from "./lib/audit/audit-event";

const interpretInputSchema = z.object({
  businessId: z.number().int().positive(),
  campaignId: z.number().int().positive().optional(),
  signal: CanonicalSocialSignalInputSchema,
});

async function requireOwnedBusiness(userId: number, businessId: number) {
  const db = getDb();
  const [row] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(and(eq(businesses.id, businessId), eq(businesses.userId, userId)))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "business not found" });
  }
  return row;
}

export const intelligenceRouter = createRouter({
  interpret: aiActionQuery.input(interpretInputSchema).mutation(async ({ ctx, input }) => {
    await requireOwnedBusiness(ctx.user.id, input.businessId);

    const result = await runInterpretation(
      {
        userId: ctx.user.id,
        businessId: input.businessId,
        signal: input.signal,
        campaignId: input.campaignId,
      },
      {
        loadOwnedBusinessDnaSnapshot: async ({ userId, businessId }) => {
          // Owner-scoped defense in depth (contract §9): the business row is
          // loaded by both id and userId before any snapshot is served.
          const db = getDb();
          const [business] = await db
            .select({ id: businesses.id })
            .from(businesses)
            .where(and(eq(businesses.id, businessId), eq(businesses.userId, userId)))
            .limit(1);
          if (!business) return null;
          return getLatestBusinessDnaSnapshotForBusiness(businessId);
        },
        persistAudit: async (event) => {
          await persistAuditEvent(event as AuditEvent);
        },
      }
    );

    return result;
  }),

  get: authedQuery
    .input(z.object({ interpretationId: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const row = await getInterpretationById(input.interpretationId);
      if (!row || row.userId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "interpretation not found" });
      }
      return row.record;
    }),

  listForSignal: authedQuery
    .input(
      z.object({
        businessId: z.number().int().positive(),
        signalId: z.string().min(1).max(128),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOwnedBusiness(ctx.user.id, input.businessId);
      const rows = await listInterpretationsForSignal(input.businessId, input.signalId);
      return rows.map((row) => row.record);
    }),
});
