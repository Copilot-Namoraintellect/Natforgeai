/**
 * Stale credit-reservation reaper (WBS-R4E self-healing).
 *
 * A crash between reserveWalletCredits and the run's settle/release leaves
 * the hold in `reserved` forever, permanently shrinking the owner's
 * available balance even though no run will ever consume it. This module
 * classifies such holds (state `reserved`, hold older than a conservative
 * TTL) and releases them through the governed reservation authority, never
 * by direct wallet or table mutation.
 *
 * Safety argument for AUTO_RELEASE: governed agent runs are bounded by
 * provider timeouts (minutes) and the 30-minute stale-run terminalisation,
 * so a hold older than the reap TTL is definitively abandoned, not merely
 * slow. The TTL must always exceed the longest legitimate run lifetime.
 *
 * Exact-once: each release uses the deterministic key
 * `stale-reap:{reservationId}`; a concurrent or repeated reap replays
 * idempotently through the reservation state machine, and a hold that
 * legitimately settled between the sweep read and the release fails closed
 * as a terminal-state conflict and is counted, not retried blindly.
 */

import { and, eq, lt } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { creditReservations } from "@db/schema";
import { releaseWalletCredits } from "./credit-reservation-engine";

/** A reserved hold older than this is abandoned. Keep well above the longest
 * legitimate agent-run lifetime (provider timeouts are minutes; stale runs
 * terminalise at 30 minutes). */
export const STALE_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Bound on holds examined per sweep so a huge backlog cannot monopolise the
 * transaction-owning release authority. */
export const STALE_RESERVATION_REAP_LIMIT = 500;

type ReaperDb = ReturnType<typeof getDb>;

/**
 * Structural executor seam (same convention as the reservation store): the
 * default getDb() client and a Drizzle transaction callback client both
 * satisfy this shape. Tests supply pure fakes.
 */
export interface StaleReservationReaperExecutor {
  select: ReaperDb["select"];
}

export interface StaleReservationReapSummary {
  examined: number;
  released: number;
  /** Holds that could not be released (terminal conflict after a legitimate
   * settle/release won the race, or an engine error). Never re-attempted
   * blindly inside the same sweep. */
  failed: number;
}

function toEpochMillis(value: unknown): number | null {
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isNaN(millis) ? null : millis;
  }
  if (typeof value === "string" || typeof value === "number") {
    const millis = new Date(value).getTime();
    return Number.isNaN(millis) ? null : millis;
  }
  return null;
}

/** Deterministic release key: one reap identity per reservation. */
export function buildStaleReservationReleaseKey(reservationId: string): string {
  return `stale-reap:${reservationId}`;
}

/**
 * Pure staleness classification. Only a `reserved` hold can be reaped;
 * settled/released rows are historical ledger evidence and are never touched.
 */
export function isStaleReservation(input: {
  state: string;
  reservedAt: unknown;
  now: Date;
  ttlMs?: number;
}): boolean {
  if (input.state !== "reserved") return false;
  const reservedAt = toEpochMillis(input.reservedAt);
  if (reservedAt === null) return false;
  const ttlMs = input.ttlMs ?? STALE_RESERVATION_TTL_MS;
  return input.now.getTime() - reservedAt >= ttlMs;
}

/**
 * Release abandoned reserved holds through the governed reservation
 * authority. Read-then-release per row; the release itself is the
 * transaction-owning authority, so a stale read can never mutate a hold
 * that legitimately settled in the meantime.
 */
export async function reapStaleCreditReservations(input?: {
  now?: Date;
  ttlMs?: number;
  limit?: number;
  executor?: StaleReservationReaperExecutor;
}): Promise<StaleReservationReapSummary> {
  const executor = input?.executor ?? getDb();
  const now = input?.now ?? new Date();
  const ttlMs = input?.ttlMs ?? STALE_RESERVATION_TTL_MS;
  const limit = input?.limit ?? STALE_RESERVATION_REAP_LIMIT;

  const cutoff = new Date(now.getTime() - ttlMs);

  const rows = await executor
    .select({
      reservationId: creditReservations.reservationId,
      state: creditReservations.state,
      reservedAt: creditReservations.reservedAt,
    })
    .from(creditReservations)
    .where(
      and(
        eq(creditReservations.state, "reserved"),
        lt(creditReservations.reservedAt, cutoff)
      )
    )
    .limit(limit);

  const summary: StaleReservationReapSummary = {
    examined: 0,
    released: 0,
    failed: 0,
  };

  for (const row of rows) {
    if (!isStaleReservation({ ...row, now, ttlMs })) continue;
    summary.examined += 1;

    try {
      await releaseWalletCredits({
        reservationId: row.reservationId,
        releaseKey: buildStaleReservationReleaseKey(row.reservationId),
        reason: "stale_reservation_reap",
        asOf: now.toISOString(),
      });
      summary.released += 1;
    } catch {
      // Terminal conflict (the hold legitimately settled/released between
      // the sweep read and this release) or an engine error: count and move
      // on — never turn an uncertain failure into a blind replay.
      summary.failed += 1;
    }
  }

  return summary;
}
