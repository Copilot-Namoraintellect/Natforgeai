/**
 * R5 Stream Evidence Boundary (WBS-R5-F1).
 *
 * Schema-free, read-only bridge between R5-F's canonical operations
 * projection and durable authorities owned by the capability streams that
 * have NOT landed on this branch yet.
 *
 * The only such authority today is R5-A social listening
 * (`social_listening_states` / `social_signals`, defined on
 * `feature/r5-a-social-listening`, migration 0029, unexecuted at inventory
 * time). R5-F must not duplicate A's schema and must not break when A's
 * migration has not run, so this module:
 *
 *  - checks `information_schema` for table existence before reading
 *    (absence => `{ available: false, reason: "stream_tables_absent" }`,
 *    surfaced by the projection as unsupported — never guessed);
 *  - reads through explicit, allow-listed columns only — never provider
 *    tokens, never raw payload content;
 *  - maps rows into a narrow F-owned DTO (`R5ListeningEvidence`).
 *
 * When R5-B/C/D land, register their evidence readers here (or natively in
 * the projection once their tables exist on the integration branch) and
 * extend `R5OperationsEvidence` — per the stream contract.
 */

import { sql } from "drizzle-orm";
import type { getDb } from "../../queries/connection";

type Db = ReturnType<typeof getDb>;

export interface R5ListeningBindingEvidence {
  integrationId: number;
  provider: string;
  platform: string;
  providerAccountId: string;
  mechanism: "webhook" | "polling" | "unsupported";
  status: "active" | "blocked" | "unsupported" | "stale";
  cursorUpdatedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureClass: "AUTO_RECOVER" | "OPERATOR_ACTION" | "FAIL_CLOSED" | null;
  lastFailureCode: string | null;
  lastFailureReason: string | null;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  /** Signals observed in the trailing 24h window for this binding. */
  signalsLast24h: number;
  latestSignalObservedAt: Date | null;
}

export interface R5ListeningEvidence {
  available: boolean;
  reason?: string;
  bindings: R5ListeningBindingEvidence[];
}

const LISTENING_TABLE = "social_listening_states";
const SIGNALS_TABLE = "social_signals";
const SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;

async function tableExists(db: Db, tableName: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT COUNT(*) AS c
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = ${tableName}
  `);
  const rows = result[0] as unknown as { c?: number | string | bigint }[] | undefined;
  const first = rows?.[0];
  const count = first?.c === undefined ? 0 : Number(first.c);
  return count > 0;
}

interface ListeningRow {
  integrationId: number;
  provider: string;
  platform: string;
  providerAccountId: string;
  mechanism: string;
  status: string;
  cursorUpdatedAt: Date | string | null;
  lastSuccessAt: Date | string | null;
  lastFailureAt: Date | string | null;
  lastFailureClass: string | null;
  lastFailureCode: string | null;
  lastFailureReason: string | null;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
}

interface SignalRollupRow {
  integrationId: number;
  c: number | string | bigint;
  latest: Date | string | null;
}

function toDate(value: Date | string | null): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Read R5-A listening evidence for a business. Read-only; allow-listed
 * columns only; safe to call when A's migration has not run (returns
 * `available: false`).
 */
export async function readR5ListeningEvidence(
  db: Db,
  businessId: number,
  userId: number,
  now: Date
): Promise<R5ListeningEvidence> {
  const listeningExists = await tableExists(db, LISTENING_TABLE);
  const signalsExists = listeningExists && (await tableExists(db, SIGNALS_TABLE));
  if (!listeningExists) {
    return { available: false, reason: "stream_tables_absent", bindings: [] };
  }

  const rowsResult = await db.execute(sql`
    SELECT
      integrationId, provider, platform, providerAccountId,
      mechanism, status,
      cursorUpdatedAt, lastSuccessAt, lastFailureAt,
      lastFailureClass, lastFailureCode, lastFailureReason,
      acceptedCount, duplicateCount, rejectedCount
    FROM ${sql.raw(LISTENING_TABLE)}
    WHERE (businessId = ${businessId} OR (businessId IS NULL AND userId = ${userId}))
  `);
  const rows = (rowsResult[0] as unknown as ListeningRow[] | undefined) ?? [];
  if (rows.length === 0) {
    return { available: true, bindings: [] };
  }

  // Integration ids are bigints read from the same store; still validate
  // before interpolating the IN list so the raw fragment can never carry
  // attacker-influenced text.
  const integrationIds = rows
    .map((r) => Number(r.integrationId))
    .filter((n) => Number.isInteger(n) && n > 0);
  const rollups: SignalRollupRow[] = [];
  if (signalsExists && integrationIds.length > 0) {
    const list = integrationIds.join(",");
    const rollupResult = await db.execute(sql`
      SELECT integrationId, COUNT(*) AS c, MAX(observedAt) AS latest
      FROM ${sql.raw(SIGNALS_TABLE)}
      WHERE integrationId IN (${sql.raw(list)}) AND observedAt >= ${new Date(now.getTime() - SIGNAL_WINDOW_MS)}
      GROUP BY integrationId
    `);
    rollups.push(...(((rollupResult[0] as unknown as SignalRollupRow[] | undefined) ?? [])));
  }

  const bindings: R5ListeningBindingEvidence[] = rows.map((row) => {
    const rollup = rollups.find((r) => Number(r.integrationId) === Number(row.integrationId));
    return {
      integrationId: Number(row.integrationId),
      provider: row.provider,
      platform: row.platform,
      providerAccountId: row.providerAccountId,
      mechanism: row.mechanism as R5ListeningBindingEvidence["mechanism"],
      status: row.status as R5ListeningBindingEvidence["status"],
      cursorUpdatedAt: toDate(row.cursorUpdatedAt),
      lastSuccessAt: toDate(row.lastSuccessAt),
      lastFailureAt: toDate(row.lastFailureAt),
      lastFailureClass: row.lastFailureClass as R5ListeningBindingEvidence["lastFailureClass"],
      lastFailureCode: row.lastFailureCode,
      lastFailureReason: row.lastFailureReason,
      acceptedCount: Number(row.acceptedCount ?? 0),
      duplicateCount: Number(row.duplicateCount ?? 0),
      rejectedCount: Number(row.rejectedCount ?? 0),
      signalsLast24h: rollup ? Number(rollup.c) : 0,
      latestSignalObservedAt: rollup ? toDate(rollup.latest) : null,
    };
  });

  return { available: true, bindings };
}
