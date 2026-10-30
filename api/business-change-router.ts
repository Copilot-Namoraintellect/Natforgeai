/**
 * Business Change Router (WBS-R8-B).
 *
 * The server-side surface of the business-change authority. Authority rules:
 * - the client may name a governed upstream source (authority + identity) for
 *   evaluation, may attest a bounded observed state (OBJECTIVE subject), and
 *   may request a correction of an active change — it can never supply change
 *   identity, change type/domain, status, significance, confidence, state
 *   refs, fingerprints, evidence hash, or any *Claimed/*Disclaimer field
 *   (strict zod boundary + pure client-authority guard reject smuggling, fail
 *   closed);
 * - business/subject/source ownership is re-verified server-side against
 *   durable rows on every call (cross-tenant/cross-business fail closed);
 * - the previous state is always R8-A current strategic memory, consumed
 *   read-only through the memory seam — never stale/superseded memory, never
 *   a client payload; FACT vs ASSUMPTION anchors stay distinct and cap
 *   derived confidence;
 * - change rows are immutable (evidenceHash-bound cores); supersession /
 *   contradiction / confirmation / expiry are new bcl1: lifecycle facts
 *   binding exact predecessors; the active projection never silently includes
 *   non-active changes;
 * - confirmation is never client-settable: only independent governed-source
 *   corroboration of the same compared states mints a confirmation fact;
 * - no strategy, budget, experiment, campaign, approval, payment, provider,
 *   CRM, Business DNA, strategic-memory, or any R7/R8-A table write exists
 *   anywhere in this surface. Business change evidence is detection, never
 *   execution authority.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import {
  BUSINESS_CHANGE_DOMAINS,
  BUSINESS_CHANGE_STATUSES,
  BUSINESS_CHANGE_SUBJECT_TYPES,
  BUSINESS_CHANGE_SOURCE_AUTHORITIES,
  BUSINESS_CHANGE_TYPES,
  BusinessChangeError,
  BusinessChangeIdentityConflictError,
  BusinessChangeInputError,
  BusinessChangeOwnershipError,
  BusinessChangeStateConflictError,
  BusinessChangeTamperError,
  BusinessChangeValidationError,
  businessChangeAttestInputSchema,
  businessChangeCorrectInputSchema,
  businessChangeEvaluateInputSchema,
} from "./lib/business-change/business-change-contract";
import {
  attestBusinessChange,
  correctBusinessChange,
  evaluateBusinessChange,
  sweepBusinessChangeExpiry,
} from "./lib/business-change/business-change-service";
import {
  assertBusinessChangeEvidenceIntegrity,
  getChangeByChangeId,
  listChanges,
  listChangeLifecycleEvents,
  type ListChangesFilter,
} from "./lib/business-change/business-change-store";
import { buildBusinessChangeProjection } from "./lib/business-change/business-change-projection";
import { isActiveChangeStatus } from "./lib/business-change/business-change-temporal";

/** Surface the stable domain code in the message (house style) unless present. */
function withCode(err: BusinessChangeError): string {
  return err.message.includes(err.code) ? err.message : `${err.code}: ${err.message}`;
}

function toTrpcError(err: unknown): never {
  if (err instanceof BusinessChangeOwnershipError) {
    throw new TRPCError({ code: "FORBIDDEN", message: withCode(err) });
  }
  if (
    err instanceof BusinessChangeIdentityConflictError ||
    err instanceof BusinessChangeStateConflictError ||
    err instanceof BusinessChangeTamperError
  ) {
    throw new TRPCError({ code: "CONFLICT", message: withCode(err) });
  }
  if (err instanceof BusinessChangeInputError || err instanceof BusinessChangeValidationError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  if (err instanceof BusinessChangeError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  throw err;
}

const listFiltersSchema = z
  .object({
    businessId: z.number().int().positive().optional(),
    changeDomain: z.enum(BUSINESS_CHANGE_DOMAINS).optional(),
    changeType: z.enum(BUSINESS_CHANGE_TYPES).optional(),
    status: z.enum(BUSINESS_CHANGE_STATUSES).optional(),
    subjectType: z.enum(BUSINESS_CHANGE_SUBJECT_TYPES).optional(),
    subjectId: z.string().min(1).max(191).optional(),
    sourceAuthority: z.enum(BUSINESS_CHANGE_SOURCE_AUTHORITIES).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();

const changeIdSchema = z.object({ changeId: z.string().min(1).max(69) }).strict();

async function projectWithLifecycle(userId: number, change: NonNullable<Awaited<ReturnType<typeof getChangeByChangeId>>>) {
  assertBusinessChangeEvidenceIntegrity(change as never);
  const lifecycle = await listChangeLifecycleEvents(userId, change.changeId);
  return {
    change,
    lifecycle,
    projection: buildBusinessChangeProjection(change as never, lifecycle as never),
  };
}

export const businessChangeRouter = createRouter({
  /**
   * Evaluate one governed new-state observation (R7 budget snapshot, R7
   * learning, R7 governance decision, Business DNA snapshot, strategy
   * snapshot) against the current R8-A memory anchor for the subject. Returns
   * `{ change: null }` when the authoritative states are unchanged.
   * Idempotent; corroboration and contradiction lineage converge by replay.
   */
  evaluate: authedQuery.input(businessChangeEvaluateInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await evaluateBusinessChange(undefined, { userId: ctx.user.id }, input, new Date().toISOString());
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /**
   * Evaluate one operator-attested observation (OBJECTIVE subject; bounded,
   * protected-trait scanned, untrusted content). PROVISIONAL by construction —
   * an attestation can never mint a CONFIRMED change and its significance is
   * confidence-capped.
   */
  attest: authedQuery.input(businessChangeAttestInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await attestBusinessChange(undefined, { userId: ctx.user.id }, input, new Date().toISOString());
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /**
   * Correct an active change: re-load the corrected current state for the
   * same subject, compare against the same previous-state anchor, mint a
   * successor change bound by supersedesChangeId, and transition the
   * predecessor to SUPERSEDED (immutable history preserved). Replaying the
   * correction converges.
   */
  correct: authedQuery.input(businessChangeCorrectInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await correctBusinessChange(undefined, { userId: ctx.user.id }, input, new Date().toISOString());
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /** Tenant-scoped read of one change with its lifecycle + downstream projection. */
  get: authedQuery.input(changeIdSchema).query(async ({ ctx, input }) => {
    try {
      const row = await getChangeByChangeId(ctx.user.id, input.changeId);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Business change not found." });
      }
      return await projectWithLifecycle(ctx.user.id, row);
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /** Tenant-scoped list with optional filters; returns rows + projections (status labelled). */
  list: authedQuery.input(listFiltersSchema).query(async ({ ctx, input }) => {
    try {
      const filters: ListChangesFilter = { ...input };
      const rows = await listChanges(ctx.user.id, filters);
      const projections = [];
      for (const row of rows) {
        assertBusinessChangeEvidenceIntegrity(row);
        const lifecycle = await listChangeLifecycleEvents(ctx.user.id, row.changeId);
        projections.push(buildBusinessChangeProjection(row as never, lifecycle as never));
      }
      return { changes: rows, projections };
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /**
   * Active-change projection for R8-D/E (`business-change-to-reasoning/v1`):
   * only DETECTED/CONFIRMED/PROVISIONAL changes are active; CONTRADICTED/
   * SUPERSEDED/INVALIDATED/EXPIRED records are excluded unless requested via
   * `includeNonActive` (then labelled — never silently active).
   */
  r8Projections: authedQuery
    .input(
      listFiltersSchema.extend({
        includeNonActive: z.boolean().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        const { includeNonActive, ...rest } = input;
        const rows = await listChanges(ctx.user.id, { ...rest, limit: 500 });
        const projections = [];
        for (const row of rows) {
          assertBusinessChangeEvidenceIntegrity(row);
          if (!includeNonActive && !isActiveChangeStatus(row.status)) continue;
          const lifecycle = await listChangeLifecycleEvents(ctx.user.id, row.changeId);
          projections.push(buildBusinessChangeProjection(row as never, lifecycle as never));
        }
        return projections;
      } catch (err) {
        toTrpcError(err);
      }
    }),

  /** Lifecycle history for one tenant-scoped change (immutable, append-only). */
  listLifecycle: authedQuery.input(changeIdSchema).query(async ({ ctx, input }) => {
    try {
      const row = await getChangeByChangeId(ctx.user.id, input.changeId);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Business change not found." });
      }
      return await listChangeLifecycleEvents(ctx.user.id, input.changeId);
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /**
   * Bounded tenant-scoped expiry sweep: materializes EXPIRED for changes whose
   * validUntil has passed (insert-first facts + CAS; replays converge).
   * Changes status only — never content.
   */
  sweepExpiry: authedQuery
    .input(z.object({ businessId: z.number().int().positive().optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await sweepBusinessChangeExpiry(undefined, { userId: ctx.user.id }, input, new Date().toISOString());
      } catch (err) {
        toTrpcError(err);
      }
    }),
});
