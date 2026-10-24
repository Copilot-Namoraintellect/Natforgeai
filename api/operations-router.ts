/**
 * R5-F4: Operator read endpoints (WBS-R5-F4).
 *
 * Admin-scoped, READ-ONLY operator surface over the canonical R5 operations
 * projection (`projectR5BusinessOperations`). Every procedure is `adminQuery`
 * (authenticated + OTP/2FA-verified + role admin); operator reads may cross
 * businesses by design (contract §6). No mutations live here — governed
 * recovery adapters are separate slices.
 *
 * Conventions (mirror the admin control plane):
 * - Bounded errors only: never leak raw exception text; NOT_FOUND for a
 *   missing business; zod validates every input.
 * - Secret-free: the projection's column allow-list is inherited unchanged;
 *   no token/credential/payload fields are added.
 * - Bounded reads: cross-business listings page over `businesses` with
 *   limit/offset and project ONLY the rows in the requested window.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc } from "drizzle-orm";
import { createRouter, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { businesses } from "@db/schema";
import { logError } from "./lib/logger";
import {
  projectR5BusinessOperations,
  R5_OPERATIONAL_HEALTH,
  type R5BusinessOperationsProjection,
} from "./lib/governance/r5-operations-projection";
import { summarizeR5Operations } from "./lib/governance/r5-operations-summary";

export const operationsRouter = createRouter({
  // Single-business canonical projection. Answers operator questions 1-10 by
  // construction (health, blockers, safe next action, staleness, evidence).
  getBusinessOperations: adminQuery
    .input(z.object({ businessId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const projection = await projectR5BusinessOperations({
        businessId: input.businessId,
      });
      if (!projection.business) {
        throw new TRPCError({ code: "NOT_FOUND", message: "business not found" });
      }
      return projection;
    }),

  // Bounded cross-business state listing, most recent businesses first.
  listOperationalStates: adminQuery
    .input(
      z.object({
        health: z.enum(R5_OPERATIONAL_HEALTH).optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const db = getDb();
      const now = new Date();

      const rows = await db
        .select({
          id: businesses.id,
          userId: businesses.userId,
          name: businesses.name,
        })
        .from(businesses)
        .orderBy(desc(businesses.id))
        .limit(input.limit)
        .offset(input.offset);

      const items: {
        business: { id: number; userId: number; name: string };
        health: R5BusinessOperationsProjection["health"];
        blockers: R5BusinessOperationsProjection["blockers"];
        safeNextAction: R5BusinessOperationsProjection["safeNextAction"];
        staleness: R5BusinessOperationsProjection["staleness"];
        capabilitiesPresent: number;
      }[] = [];

      for (const row of rows) {
        try {
          const projection = await projectR5BusinessOperations({
            businessId: row.id,
            now,
          });
          if (input.health && projection.health !== input.health) continue;
          items.push({
            business: { id: row.id, userId: row.userId, name: row.name },
            health: projection.health,
            blockers: projection.blockers,
            safeNextAction: projection.safeNextAction,
            staleness: projection.staleness,
            capabilitiesPresent: projection.capabilitiesPresent,
          });
        } catch (err) {
          // A single unreadable business must not take down the listing.
          logError("[R5] Failed to project business for operational state listing", {
            event: "r5_list_operational_states_business_failed",
            businessId: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
      }

      const totalRows = await db.select({ id: businesses.id }).from(businesses);
      return {
        items,
        total: totalRows.length,
        limit: input.limit,
        offset: input.offset,
      };
    }),

  // Platform-level aggregate over the same bounded projection window used by
  // the readiness surface (shared helper keeps the two consistent).
  getOperationsSummary: adminQuery.query(async () => {
    const db = getDb();
    const now = new Date();
    const summary = await summarizeR5Operations(db, now);
    return {
      generatedAt: now.toISOString(),
      projectedCount: summary.projectedCount,
      totalBusinesses: summary.totalBusinesses,
      truncated: summary.truncated,
      healthCounts: summary.healthCounts,
      blockerClassCounts: summary.blockerClassCounts,
    };
  }),
});
