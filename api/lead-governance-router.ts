/**
 * R6-F lead governance / operations router.
 *
 * Admin-scoped operator surface (verified admin session on every procedure).
 * Read procedures answer the ten F5 operator questions from the canonical
 * projection; mutations are narrow governed actions only:
 *
 * - `setPrivacyState` — governance transition on the F-owned privacy state
 *   machine (CAS-guarded, tx-atomic with its audit event);
 * - `retryOperation` — governed recovery over real authority only
 *   (`retention_sweep` → deterministic retention reconciliation), kill-switch
 *   gated, tx-atomic with its audit event.
 *
 * Forbidden everywhere (asserted by the F9 acceptance suite): force merge,
 * force score, force qualify, force contact/nurture, force handoff success,
 * force conversion, arbitrary lifecycle-state setters, generic force-complete,
 * client-supplied lifecycle/recovery/billing identity.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { businesses, leadPrivacyStates, leads } from "@db/schema";
import { createRouter, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { logError } from "./lib/logger";
import {
  extractAdminRequestId,
  recordAdminMutationAudit,
} from "./lib/governance/admin-audit";
import {
  projectLeadOperations,
  LEAD_OPERATIONAL_HEALTH,
  type LeadOperationsProjection,
} from "./lib/governance/lead-operations-projection";
import { summarizeLeadGovernance } from "./lib/governance/lead-operations-summary";
import {
  LEAD_PRIVACY_STATES,
  LeadPrivacyGovernanceError,
  readLeadPrivacyEvidence,
  sweepLeadRetention,
  transitionLeadPrivacyState,
  type LeadPrivacyState,
} from "./lib/governance/lead-privacy-store";

const R6_LEAD_RECOVERY_ENV = "R6_LEAD_RECOVERY_ADMIN_ENABLED";

function requireR6LeadRecoveryEnabled(): void {
  if (process.env[R6_LEAD_RECOVERY_ENV] !== "true") {
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "R6 lead recovery is disabled.",
    });
  }
}

/** Bounded mapping of governance-store errors; never leaks internals. */
function mapLeadGovernanceError(err: unknown): never {
  if (err instanceof LeadPrivacyGovernanceError) {
    switch (err.code) {
      case "LEAD_PRIVACY_SCHEMA_UNAVAILABLE":
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "lead privacy governance schema is not migrated yet.",
        });
      case "LEAD_PRIVACY_TRANSITION_FORBIDDEN":
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "privacy state transition is not allowed.",
        });
      case "LEAD_PRIVACY_STALE_STATE":
        throw new TRPCError({ code: "CONFLICT", message: "stale privacy state." });
      case "LEAD_PRIVACY_VALIDATION":
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message.slice(0, 160) });
    }
  }
  logError("[R6-F] lead governance mutation failed", {
    event: "r6_lead_governance_mutation_failed",
    error: err instanceof Error ? err.message : String(err),
  });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Lead governance action failed." });
}

const REASON_REQUIRED_TARGETS: readonly LeadPrivacyState[] = [
  "SUPPRESSED",
  "RESTRICTED",
  "RETENTION_EXPIRED",
  "ARCHIVED",
];

const LEAD_OPERATION_KINDS = ["retention_sweep"] as const;

export const leadGovernanceRouter = createRouter({
  /**
   * F5.1 — current lead state: one projection answering identity / scoring /
   * qualification / nurture / handoff / conversion / privacy readiness,
   * blockers, staleness and required operator action.
   */
  getLeadOperations: adminQuery
    .input(z.object({ leadId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [leadRow] = await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.id, input.leadId))
        .limit(1);
      if (!leadRow) {
        throw new TRPCError({ code: "NOT_FOUND", message: "lead not found" });
      }
      return projectLeadOperations({ leadId: input.leadId, now: new Date() });
    }),

  /** F5.2 — business-scoped listing of per-lead operational states. */
  listLeadOperationalStates: adminQuery
    .input(
      z.object({
        businessId: z.number().int().positive(),
        health: z.enum(LEAD_OPERATIONAL_HEALTH).optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const db = getDb();
      const [businessRow] = await db
        .select({ id: businesses.id })
        .from(businesses)
        .where(eq(businesses.id, input.businessId))
        .limit(1);
      if (!businessRow) {
        throw new TRPCError({ code: "NOT_FOUND", message: "business not found" });
      }
      const leadRows = await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.businessId, input.businessId))
        .orderBy(desc(leads.id));

      const items: LeadOperationsProjection[] = [];
      for (const leadRow of leadRows) {
        try {
          const projection = await projectLeadOperations({ leadId: leadRow.id, now: new Date() });
          if (input.health && projection.health !== input.health) continue;
          items.push(projection);
        } catch (err) {
          logError("[R6-F] Failed to project lead for operational listing", {
            event: "r6_list_lead_operational_states_failed",
            businessId: input.businessId,
            leadId: leadRow.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const window = items.slice(input.offset, input.offset + input.limit);
      return {
        businessId: input.businessId,
        total: items.length,
        items: window,
        truncated: input.offset + window.length < items.length,
      };
    }),

  /** F5.3 — platform rollup for operator overview. */
  getLeadGovernanceSummary: adminQuery.query(async () => {
    return summarizeLeadGovernance(getDb(), new Date());
  }),

  /**
   * F3/F6 — governed privacy state transition. Binds the exact lead
   * re-derived from the durable row; CAS-guarded; tx-atomic with audit.
   */
  setPrivacyState: adminQuery
    .input(
      z.object({
        leadId: z.number().int().positive(),
        targetState: z.enum(LEAD_PRIVACY_STATES),
        reason: z.string().max(500).optional(),
        retentionDeadlineAt: z.coerce.date().optional(),
        // Staleness assertion only; never trusted for binding.
        expectedStatus: z.string().max(32).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [leadRow] = await db
        .select({ id: leads.id, userId: leads.userId, businessId: leads.businessId })
        .from(leads)
        .where(eq(leads.id, input.leadId))
        .limit(1);
      if (!leadRow) {
        throw new TRPCError({ code: "NOT_FOUND", message: "lead not found" });
      }
      if (REASON_REQUIRED_TARGETS.includes(input.targetState) && !input.reason?.trim()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `a governance reason is required for target state ${input.targetState}.`,
        });
      }
      if (input.expectedStatus !== undefined) {
        const current = await readLeadPrivacyEvidence(db, input.leadId);
        if (current.state !== input.expectedStatus) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `stale privacy state: expected ${input.expectedStatus}, current ${current.state}`,
          });
        }
      }

      try {
        return await db.transaction(async (tx) => {
          const result = await transitionLeadPrivacyState(tx, {
            leadId: leadRow.id,
            userId: leadRow.userId,
            businessId: leadRow.businessId ?? null,
            targetState: input.targetState,
            reason: input.reason ?? null,
            retentionDeadlineAt: input.retentionDeadlineAt ?? null,
            source: "operator",
            actorUserId: ctx.user.id,
            now: new Date(),
          });
          if (result.outcome === "transitioned") {
            await recordAdminMutationAudit({
              actorUserId: ctx.user.id,
              action: "admin.lead_privacy_state_changed",
              targetType: "lead_privacy_state",
              targetId: leadRow.id,
              businessId: leadRow.businessId ?? null,
              reason: input.reason ?? null,
              occurredAt: new Date(),
              metadata: {
                leadId: leadRow.id,
                before: result.before,
                after: result.after,
                source: "operator",
              },
              requestId: extractAdminRequestId(ctx.req),
              executor: tx,
            });
          }
          return result;
        });
      } catch (err) {
        mapLeadGovernanceError(err);
      }
    }),

  /**
   * F6 — governed recovery over real authority only. Today the single
   * supported kind is the deterministic retention sweep; R6-X may add stream
   * kinds solely when their governed authority exists.
   */
  retryOperation: adminQuery
    .input(
      z.object({
        operationKind: z.enum(LEAD_OPERATION_KINDS),
        /** For retention_sweep this is the owning business id. */
        operationId: z.number().int().positive(),
        // Staleness assertion only; never trusted for binding.
        expectedDueCount: z.number().int().min(0).optional(),
        reason: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireR6LeadRecoveryEnabled();
      const db = getDb();

      if (input.operationKind === "retention_sweep") {
        const businessId = input.operationId;
        const [businessRow] = await db
          .select({ id: businesses.id })
          .from(businesses)
          .where(eq(businesses.id, businessId))
          .limit(1);
        if (!businessRow) {
          throw new TRPCError({ code: "NOT_FOUND", message: "business not found" });
        }

        const now = new Date();
        if (input.expectedDueCount !== undefined) {
          const pending = await db
            .select({ retentionDeadlineAt: leadPrivacyStates.retentionDeadlineAt })
            .from(leadPrivacyStates)
            .where(
              and(
                eq(leadPrivacyStates.businessId, businessId),
                eq(leadPrivacyStates.privacyState, "RETENTION_PENDING")
              )
            );
          const due = pending.filter(
            (r) =>
              r.retentionDeadlineAt instanceof Date &&
              !Number.isNaN(r.retentionDeadlineAt.getTime()) &&
              r.retentionDeadlineAt.getTime() <= now.getTime()
          ).length;
          if (due !== input.expectedDueCount) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `stale sweep state: expected ${input.expectedDueCount} due, current ${due}`,
            });
          }
        }

        try {
          return await db.transaction(async (tx) => {
            const result = await sweepLeadRetention(tx, { businessId, now });
            if (result.expiredCount > 0) {
              await recordAdminMutationAudit({
                actorUserId: ctx.user.id,
                action: "admin.lead_retention_sweep",
                targetType: "lead_operation",
                targetId: `retention_sweep:${businessId}`,
                businessId,
                reason: input.reason ?? null,
                occurredAt: new Date(),
                metadata: {
                  operationKind: input.operationKind,
                  businessId,
                  evaluatedCount: result.evaluatedCount,
                  expiredCount: result.expiredCount,
                },
                requestId: extractAdminRequestId(ctx.req),
                executor: tx,
              });
            }
            return {
              outcome: result.converged ? ("converged" as const) : ("expired" as const),
              evaluatedCount: result.evaluatedCount,
              expiredCount: result.expiredCount,
            };
          });
        } catch (err) {
          mapLeadGovernanceError(err);
        }
      }

      throw new TRPCError({ code: "BAD_REQUEST", message: "unsupported operation kind." });
    }),
});
