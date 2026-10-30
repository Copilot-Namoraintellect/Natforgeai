/**
 * Market Signal Router (WBS-R8-C).
 *
 * The server-side surface of the market/external-signal authority. Authority
 * rules:
 * - the client may REPORT external evidence (source material, claim text,
 *   closed-vocabulary type proposals, contradiction/supersession references);
 *   it can never supply signal/source identity, trust, registry class,
 *   confidence, freshness, corroboration, relevance, status, evidence hashes
 *   or any "verified/trusted" field (strict zod boundary + pure
 *   client-authority guard reject smuggling, fail closed);
 * - business and every lineage reference is re-verified server-side against
 *   durable rows on every call (cross-tenant/cross-business fails closed);
 * - trust/freshness/relevance/confidence are server-derived and deterministic
 *   (no model is signal authority; external content is inert evidence);
 * - no campaign, strategy, budget, Business DNA, provider, payment or billing
 *   effect is ever produced here — this stream exposes no execution surface.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import {
  MARKET_ACTIVE_FRESHNESS_CLASSES,
  MARKET_ACTIVE_SIGNAL_STATUSES,
  MARKET_FRESHNESS_CLASSES,
  MARKET_RELEVANCE_CLASSES,
  MARKET_SIGNAL_STATUSES,
  MARKET_SIGNAL_TYPES,
  MARKET_SOURCE_TRUST_CLASSES,
  MarketSignalError,
  MarketSignalIdentityConflictError,
  MarketSignalInputError,
  MarketSignalOwnershipError,
  MarketSignalStateError,
  MarketSignalTamperError,
  marketSignalIngestInputSchema,
  SIGNAL_ID_PATTERN,
} from "./lib/market-signals/market-signal-contract";
import {
  getMarketSignal,
  ingestMarketSignal,
  listMarketSignalLifecycle,
  listMarketSignals,
} from "./lib/market-signals/market-signal-service";
import { listSignals, listSources, resolveMarketSignalDb } from "./lib/market-signals/market-signal-store";
import {
  buildExternalSignalProjection,
  validateExternalSignalProjection,
} from "./lib/market-signals/market-signal-projection";

/** Surface the stable domain code in the message (house style) unless present. */
function withCode(err: MarketSignalError): string {
  return err.message.includes(err.code) ? err.message : `${err.code}: ${err.message}`;
}

function toTrpcError(err: unknown): never {
  if (err instanceof MarketSignalOwnershipError) {
    throw new TRPCError({ code: "FORBIDDEN", message: withCode(err) });
  }
  if (
    err instanceof MarketSignalIdentityConflictError ||
    err instanceof MarketSignalStateError ||
    err instanceof MarketSignalTamperError
  ) {
    throw new TRPCError({ code: "CONFLICT", message: withCode(err) });
  }
  if (err instanceof MarketSignalInputError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  if (err instanceof MarketSignalError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: withCode(err) });
  }
  throw err;
}

const signalIdSchema = z.object({ signalId: z.string().regex(SIGNAL_ID_PATTERN, "signalId must be an xsig1: id") }).strict();

const listFiltersSchema = z
  .object({
    businessId: z.number().int().positive().optional(),
    signalType: z.enum(MARKET_SIGNAL_TYPES).optional(),
    signalStatus: z.enum(MARKET_SIGNAL_STATUSES).optional(),
    relevanceClass: z.enum(MARKET_RELEVANCE_CLASSES).optional(),
    sourceTrustClass: z.enum(MARKET_SOURCE_TRUST_CLASSES).optional(),
    freshnessClass: z.enum(MARKET_FRESHNESS_CLASSES).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();

async function buildProjectionFor(
  db: ReturnType<typeof resolveMarketSignalDb>,
  userId: number,
  row: NonNullable<Awaited<ReturnType<typeof getMarketSignal>>>["signal"]
) {
  const family = await listSignals(
    userId,
    { businessId: Number(row.businessId), claimFamilyKey: row.claimFamilyKey, limit: 500 },
    db
  );
  const contradictedBySignalIds = family
    .filter((r) => r.signalId !== row.signalId && ((r.contradictingSignalIds as string[]) ?? []).includes(row.signalId))
    .map((r) => r.signalId)
    .slice(0, 16);
  const supersededBySignalId =
    family.find((r) => r.supersedesSignalId === row.signalId)?.signalId ?? null;
  return buildExternalSignalProjection(row, { contradictedBySignalIds, supersededBySignalId });
}

export const marketSignalRouter = createRouter({
  /**
   * Report one external market signal. Idempotent: retries/replays converge;
   * conflicting replay fails closed. Server derives source registry standing,
   * trust, freshness, relevance, confidence, corroboration and lifecycle.
   */
  ingest: authedQuery.input(marketSignalIngestInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await ingestMarketSignal(undefined, { userId: ctx.user.id }, input, new Date().toISOString());
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /** Tenant-scoped read of one signal with lifecycle + contradiction visibility. */
  get: authedQuery.input(signalIdSchema).query(async ({ ctx, input }) => {
    try {
      const result = await getMarketSignal(undefined, { userId: ctx.user.id }, input.signalId, new Date().toISOString());
      if (!result) {
        throw new TRPCError({ code: "NOT_FOUND", message: "External signal not found." });
      }
      const db = resolveMarketSignalDb(undefined);
      const projection = await buildProjectionFor(db, ctx.user.id, result.signal);
      return { ...result, projection };
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /** Tenant-scoped list with optional filters; returns rows + projections. */
  list: authedQuery.input(listFiltersSchema).query(async ({ ctx, input }) => {
    try {
      const now = new Date().toISOString();
      const rows = await listMarketSignals(undefined, { userId: ctx.user.id }, input, now);
      const db = resolveMarketSignalDb(undefined);
      const projections = [];
      for (const row of rows) {
        projections.push(await buildProjectionFor(db, ctx.user.id, row));
      }
      return { signals: rows, projections };
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /**
   * Downstream (R8-D/R8-E) read-only current projection. Returns exactly the
   * active strategic evidence: active statuses, CURRENT/AGING freshness, and
   * non-IRRELEVANT relevance — labelled with freshness/corroboration.
   * `includeNonActive` additionally exposes labelled non-active history.
   */
  r8Projections: authedQuery
    .input(listFiltersSchema.extend({ includeNonActive: z.boolean().optional() }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const now = new Date().toISOString();
        const { includeNonActive, ...filters } = input;
        const rows = await listMarketSignals(undefined, { userId: ctx.user.id }, filters, now);
        const db = resolveMarketSignalDb(undefined);
        const projections = [];
        for (const row of rows) {
          const isActive =
            (MARKET_ACTIVE_SIGNAL_STATUSES as readonly string[]).includes(row.signalStatus) &&
            (MARKET_ACTIVE_FRESHNESS_CLASSES as readonly string[]).includes(row.freshnessClass) &&
            row.relevanceClass !== "IRRELEVANT";
          if (!isActive && includeNonActive !== true) continue;
          const projection = validateExternalSignalProjection(
            await buildProjectionFor(db, ctx.user.id, row)
          );
          projections.push({ ...projection, isActive });
        }
        return projections;
      } catch (err) {
        toTrpcError(err);
      }
    }),

  /** Lifecycle history for one tenant-scoped signal (immutable xsf1: facts). */
  listLifecycle: authedQuery.input(signalIdSchema).query(async ({ ctx, input }) => {
    try {
      return await listMarketSignalLifecycle(undefined, { userId: ctx.user.id }, input.signalId);
    } catch (err) {
      toTrpcError(err);
    }
  }),

  /** Tenant-scoped view of the server-side source registry (trust is derived). */
  listSources: authedQuery
    .input(
      z
        .object({
          registryClass: z.enum(["OFFICIAL", "VERIFIED", "UNVERIFIED"]).optional(),
          limit: z.number().int().positive().max(500).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listSources(ctx.user.id, input);
      } catch (err) {
        toTrpcError(err);
      }
    }),
});
