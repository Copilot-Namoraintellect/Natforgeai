/**
 * Listening observability router (WBS-R5-A A6).
 *
 * Read-only operational surface. Everything is strictly tenant-scoped from
 * ctx.user.id — never from client input — and provider secrets/tokens are
 * never selected (social_integrations token columns are not in any payload).
 */

import { z } from "zod";
import { createRouter, authedQuery, adminQuery } from "../../middleware";
import {
  getListeningOverview,
  listSignalsForUser,
} from "./observability";
import { SOCIAL_SIGNAL_ATTRIBUTION_TYPES } from "./signal-contract";

export const listeningRouter = createRouter({
  /** Per-binding listening status for the authenticated user's workspace. */
  getOverview: authedQuery.query(async ({ ctx }) => {
    const bindings = await getListeningOverview({ userId: ctx.user.id });
    const summary = {
      totalBindings: bindings.length,
      active: bindings.filter((b) => b.status === "active").length,
      blocked: bindings.filter((b) => b.status === "blocked").length,
      unsupported: bindings.filter((b) => b.unsupported || b.status === "unsupported").length,
      stale: bindings.filter((b) => b.stale).length,
      totalAccepted: bindings.reduce((n, b) => n + b.acceptedCount, 0),
      totalDuplicates: bindings.reduce((n, b) => n + b.duplicateCount, 0),
      totalRejected: bindings.reduce((n, b) => n + b.rejectedCount, 0),
    };
    return { summary, bindings };
  }),

  /** Read-only canonical signals for the authenticated user's tenant only. */
  listSignals: authedQuery
    .input(
      z.object({
        integrationId: z.number().optional(),
        attributionType: z.enum(SOCIAL_SIGNAL_ATTRIBUTION_TYPES).optional(),
        limit: z.number().min(1).max(200).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const signals = await listSignalsForUser({
        userId: ctx.user.id,
        integrationId: input.integrationId,
        attributionType: input.attributionType,
        limit: input.limit,
      });
      return { signals };
    }),

  /** Cross-tenant operator view (admin only). */
  adminGetOverview: adminQuery.query(async () => {
    const bindings = await getListeningOverview();
    const summary = {
      totalBindings: bindings.length,
      active: bindings.filter((b) => b.status === "active").length,
      blocked: bindings.filter((b) => b.status === "blocked").length,
      unsupported: bindings.filter((b) => b.unsupported || b.status === "unsupported").length,
      stale: bindings.filter((b) => b.stale).length,
      failClosedFailures: bindings.filter((b) => b.lastFailureClass === "FAIL_CLOSED").length,
      operatorActionFailures: bindings.filter((b) => b.lastFailureClass === "OPERATOR_ACTION").length,
      totalAccepted: bindings.reduce((n, b) => n + b.acceptedCount, 0),
      totalDuplicates: bindings.reduce((n, b) => n + b.duplicateCount, 0),
      totalRejected: bindings.reduce((n, b) => n + b.rejectedCount, 0),
    };
    return { summary, bindings };
  }),
});
