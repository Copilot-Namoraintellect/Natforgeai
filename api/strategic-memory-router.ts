/**
 * Strategic Memory Router (WBS-R8-A).
 *
 * The server-side surface of the strategic-memory authority. Authority rules:
 * - the client may ATTEST assumptions/objectives/decisions/constraints and may
 *   name an upstream source (authority + identity) for governed ingestion; it
 *   can never supply memory identity, fact status, confidence, evidence hash,
 *   source fingerprint, or any *Claimed/*Disclaimer field (strict zod boundary
 *   + pure client-authority guard reject smuggling, fail closed);
 * - business/campaign/lineage/evidence ownership is re-verified server-side
 *   against durable rows on every call (cross-tenant/cross-business fail
 *   closed);
 * - FACT derives only from governed upstream ingestion (R7 authorities,
 *   Business DNA, strategy snapshots) loaded through the frozen seam — client
 *   text can never create or promote a FACT, and ASSUMPTION → FACT promotion
 *   has no boundary path at all;
 * - history is immutable; supersession/contradiction/expiry are new lifecycle
 *   facts binding exact predecessors; the current projection never silently
 *   includes superseded/expired memory as active;
 * - no strategy, budget, experiment, campaign, approval, payment, provider,
 *   CRM, or any R7-table write exists anywhere in this surface. Strategic
 *   memory is durable context, never execution authority.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import {
  STRATEGIC_MEMORY_TYPES,
  STRATEGIC_MEMORY_STATUSES,
  STRATEGIC_MEMORY_SOURCE_AUTHORITIES,
  STRATEGIC_MEMORY_SUBJECT_TYPES,
  StrategicMemoryError,
  StrategicMemoryIdentityConflictError,
  StrategicMemoryInputError,
  StrategicMemoryOwnershipError,
  StrategicMemoryStateConflictError,
  StrategicMemoryTamperError,
  StrategicMemoryValidationError,
  strategicMemoryIngestInputSchema,
  strategicMemoryRecordInputSchema,
} from "./lib/strategic-memory/strategic-memory-contract";
import {
  ingestStrategicMemory,
  recordStrategicMemory,
  sweepStrategicMemoryExpiry,
} from "./lib/strategic-memory/strategic-memory-service";
import {
  assertStrategicMemoryEvidenceIntegrity,
  getMemoryByMemoryId,
  listMemories,
  listMemoryLifecycleEvents,
  type ListMemoryFilter,
} from "./lib/strategic-memory/strategic-memory-store";
import { buildStrategicMemoryProjection } from "./lib/strategic-memory/strategic-memory-projection";
import { isActiveStatus } from "./lib/strategic-memory/strategic-memory-temporal";

/** Surface the stable domain code in the message (house style) unless present. */
function withCode(err: StrategicMemoryError): string {
  return err.message.includes(err.code) ? err.message : `${err.code}: ${err.message}`;
}

function toTrpcError(err: unknown): never {
  if (err instanceof StrategicMemoryOwnershipError) {
    throw new TRPCError({ code: "FORBIDDEN", message: withCode(err) });
  }
  if (
    err instanceof StrategicMemoryIdentityConflictError ||
    err instanceof StrategicMemoryStateConflictError ||
    err instanceof StrategicMemoryTamperError
  ) {
    throw new TRPCError({ code: "CONFLICT", message: withCode(err) });
  }
  if (err instanceof StrategicMemoryInputError || err instanceof StrategicMemoryValidationError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  if (err instanceof StrategicMemoryError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  throw err;
}

const listFiltersSchema = z
  .object({
    businessId: z.number().int().positive().optional(),
    memoryType: z.enum(STRATEGIC_MEMORY_TYPES).optional(),
    factStatus: z.enum(STRATEGIC_MEMORY_STATUSES).optional(),
    subjectType: z.enum(STRATEGIC_MEMORY_SUBJECT_TYPES).optional(),
    subjectId: z.string().min(1).max(191).optional(),
    sourceAuthority: z.enum(STRATEGIC_MEMORY_SOURCE_AUTHORITIES).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();

const memoryIdSchema = z.object({ memoryId: z.string().min(1).max(69) }).strict();

async function projectWithLifecycle(userId: number, memory: NonNullable<Awaited<ReturnType<typeof getMemoryByMemoryId>>>) {
  assertStrategicMemoryEvidenceIntegrity(memory as never);
  const lifecycle = await listMemoryLifecycleEvents(userId, memory.memoryId);
  // Contradiction visibility: successors that declared this record contradicted.
  const all = await listMemories(userId, { businessId: Number(memory.businessId), limit: 500 });
  const contradictedBy = all
    .filter((m) => (m.contradictsMemoryIds as string[]).includes(memory.memoryId))
    .map((m) => m.memoryId);
  return {
    memory,
    lifecycle,
    projection: buildStrategicMemoryProjection(memory as never, lifecycle as never, contradictedBy),
  };
}

export const strategicMemoryRouter = createRouter({
  /**
   * Record one operator-attested memory (ASSUMPTION / STRATEGIC_OBJECTIVE /
   * STRATEGIC_DECISION / CONSTRAINT). Idempotent; supersession/contradiction
   * bindings are scope-checked and history-preserving. FACT is not
   * client-mintable — use `ingestR7`.
   */
  record: authedQuery.input(strategicMemoryRecordInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await recordStrategicMemory(undefined, { userId: ctx.user.id }, input, new Date().toISOString());
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /**
   * Ingest one governed upstream evidence record (R7 authority, Business DNA,
   * strategy snapshot) as FACT strategic memory. The server loads every
   * authority field through the frozen seam; upstream supersession chains and
   * invalidations re-evaluate dependent memory with immutable lifecycle facts.
   */
  ingestR7: authedQuery.input(strategicMemoryIngestInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await ingestStrategicMemory(undefined, { userId: ctx.user.id }, input, new Date().toISOString());
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /** Tenant-scoped read of one memory with its lifecycle + downstream projection. */
  get: authedQuery.input(memoryIdSchema).query(async ({ ctx, input }) => {
    try {
      const row = await getMemoryByMemoryId(ctx.user.id, input.memoryId);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Strategic memory not found." });
      }
      return await projectWithLifecycle(ctx.user.id, row);
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /** Tenant-scoped list with optional filters; returns rows + projections (status labelled). */
  list: authedQuery.input(listFiltersSchema).query(async ({ ctx, input }) => {
    try {
      const filters: ListMemoryFilter = { ...input };
      const rows = await listMemories(ctx.user.id, filters);
      const projections = [];
      for (const row of rows) {
        assertStrategicMemoryEvidenceIntegrity(row);
        const lifecycle = await listMemoryLifecycleEvents(ctx.user.id, row.memoryId);
        projections.push(buildStrategicMemoryProjection(row as never, lifecycle as never));
      }
      return { memories: rows, projections };
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /**
   * Current-state projection for R8-B/C/D/E (`strategic-memory-to-reasoning/v1`):
   * only CURRENT memory is active; STALE/SUPERSEDED/CONTRADICTED/EXPIRED/
   * INVALIDATED records are excluded from the active set unless requested via
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
        const rows = await listMemories(ctx.user.id, { ...rest, limit: 500 });
        const projections = [];
        for (const row of rows) {
          assertStrategicMemoryEvidenceIntegrity(row);
          if (!includeNonActive && !isActiveStatus(row.factStatus)) continue;
          const lifecycle = await listMemoryLifecycleEvents(ctx.user.id, row.memoryId);
          projections.push(buildStrategicMemoryProjection(row as never, lifecycle as never));
        }
        return projections;
      } catch (err) {
        toTrpcError(err);
      }
    }),

  /** Lifecycle history for one tenant-scoped memory (immutable, append-only). */
  listLifecycle: authedQuery.input(memoryIdSchema).query(async ({ ctx, input }) => {
    try {
      const row = await getMemoryByMemoryId(ctx.user.id, input.memoryId);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Strategic memory not found." });
      }
      return await listMemoryLifecycleEvents(ctx.user.id, input.memoryId);
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /**
   * Bounded tenant-scoped expiry sweep: materializes EXPIRED for memories whose
   * validUntil has passed (insert-first facts + CAS; replays converge). Changes
   * status only — never content.
   */
  sweepExpiry: authedQuery
    .input(z.object({ businessId: z.number().int().positive().optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await sweepStrategicMemoryExpiry(undefined, { userId: ctx.user.id }, input, new Date().toISOString());
      } catch (err) {
        toTrpcError(err);
      }
    }),
});
