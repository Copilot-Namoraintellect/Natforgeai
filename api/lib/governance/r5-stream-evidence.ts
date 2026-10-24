/**
 * R5 Stream Evidence Boundary (WBS-R5-F1).
 *
 * Schema-free, read-only bridge between R5-F's canonical operations
 * projection and durable authorities owned by the capability streams.
 *
 * Registered authorities (all migrations unexecuted at integration time,
 * so every reader keeps the information_schema guard):
 *
 *  - R5-A social listening (`social_listening_states` / `social_signals`);
 *  - R5-B interpretation (`social_interpretations`) — counts/freshness only,
 *    never the canonical `record` JSON or signal content;
 *  - R5-D opportunity detection (`opportunity_candidates`) — status-class
 *    counts only, never evidence payloads or actor references.
 *
 * R5-F must not duplicate any stream schema and must not break when a
 * migration has not run, so this module:
 *
 *  - checks `information_schema` for table existence before reading
 *    (absence => `{ available: false, reason: "stream_tables_absent" }`,
 *    surfaced by the projection as unavailable — never guessed, never an
 *    error);
 *  - reads through explicit, allow-listed columns only — never provider
 *    tokens, never raw payload content;
 *  - maps rows into narrow F-owned DTOs (`R5ListeningEvidence`,
 *    `R5InterpretationEvidence`, `R5OpportunityEvidence`) plus platform-level
 *    count rollups for the readiness surface.
 *
 * When further streams land, register their evidence readers here (or
 * natively in the projection once their tables exist on the integration
 * branch) and extend `R5OperationsEvidence` — per the stream contract.
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

/**
 * Interpretation (R5-B) per-business evidence for the operations
 * projection. Counts/freshness only — the canonical interpretation `record`
 * JSON and any signal content are never read.
 */
export interface R5InterpretationEvidence {
  available: boolean;
  reason?: string;
  /** Interpretations observed in the trailing 24h window for this scope. */
  interpretationsLast24h: number;
}

/**
 * Opportunity detection (R5-D) per-business evidence for the operations
 * projection. Status-class counts only — evidence payloads (`firstEvidence`/
 * `latestEvidence`) and actor references are never read.
 */
export interface R5OpportunityEvidence {
  available: boolean;
  reason?: string;
  /** Candidates not yet handed off to R6 (`opportunityStatus != handed_off_to_r6`). */
  openCandidates: number;
  /** Candidates handed off to R6. */
  handedOff: number;
  /** Candidates created in the trailing 24h window for this scope. */
  candidatesLast24h: number;
}

/**
 * Platform-wide listening rollup for the R5-F readiness surface (F3).
 * Narrower than `R5ListeningEvidence`: counts only, no per-binding detail,
 * no payload content. The information_schema guard runs once; each present
 * table contributes a single bounded aggregate query.
 */
export interface R5ListeningRollup {
  available: boolean;
  reason?: string;
  /** Bindings currently ingesting without an open failure. */
  active: number;
  /** Bindings currently blocked. */
  blocked: number;
  /** Signals observed across all bindings in the trailing 24h window. */
  signalsLast24h: number;
}

/**
 * Platform-wide interpretation (R5-B) rollup for the readiness surface.
 * Counts/freshness only, no per-row detail, no `record` JSON.
 */
export interface R5InterpretationRollup {
  available: boolean;
  reason?: string;
  /** All interpretations ever recorded. */
  total: number;
  /** Interpretations recorded in the trailing 24h window. */
  last24h: number;
  /** 24h-window interpretations produced by the MODEL path. */
  modelCount24h: number;
  /** 24h-window interpretations produced by the RULE path. */
  ruleCount24h: number;
  /** Most recent `createdAt` across all interpretations, if any. */
  latestObservedAt: Date | null;
}

/**
 * Platform-wide opportunity detection (R5-D) rollup for the readiness
 * surface. Status-class counts only, no evidence payloads.
 */
export interface R5OpportunityRollup {
  available: boolean;
  reason?: string;
  /** All opportunity candidates ever recorded. */
  candidates: number;
  /** Candidates not yet handed off to R6. */
  openCandidates: number;
  /** Candidates handed off to R6. */
  handedOff: number;
  /** Candidates created in the trailing 24h window. */
  last24h: number;
  /** Most recent `updatedAt` across all candidates, if any. */
  latestObservedAt: Date | null;
}

const LISTENING_TABLE = "social_listening_states";
const SIGNALS_TABLE = "social_signals";
const INTERPRETATION_TABLE = "social_interpretations";
const OPPORTUNITY_TABLE = "opportunity_candidates";
const HANDED_OFF_STATUS = "handed_off_to_r6";
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

/**
 * Roll listening evidence up to platform-level counts for the readiness
 * surface. Read-only; counts only; safe to call when A's migration has not
 * run (returns `available: false`, never throws for absent tables). Raw
 * store errors propagate so callers can map them honestly.
 */
export async function readR5ListeningRollup(
  db: Db,
  now: Date
): Promise<R5ListeningRollup> {
  const listeningExists = await tableExists(db, LISTENING_TABLE);
  if (!listeningExists) {
    return {
      available: false,
      reason: "stream_tables_absent",
      active: 0,
      blocked: 0,
      signalsLast24h: 0,
    };
  }
  const signalsExists = await tableExists(db, SIGNALS_TABLE);

  const statesResult = await db.execute(sql`
    SELECT status, COUNT(*) AS c
    FROM ${sql.raw(LISTENING_TABLE)}
    GROUP BY status
  `);
  const stateRows =
    (statesResult[0] as unknown as
      | { status?: string | null; c?: number | string | bigint }[]
      | undefined) ?? [];
  let active = 0;
  let blocked = 0;
  for (const row of stateRows) {
    const c = Number(row.c ?? 0);
    if (row.status === "active") active += c;
    else if (row.status === "blocked") blocked += c;
  }

  let signalsLast24h = 0;
  if (signalsExists) {
    const signalResult = await db.execute(sql`
      SELECT COUNT(*) AS c
      FROM ${sql.raw(SIGNALS_TABLE)}
      WHERE observedAt >= ${new Date(now.getTime() - SIGNAL_WINDOW_MS)}
    `);
    const signalRows = signalResult[0] as unknown as
      | { c?: number | string | bigint }[]
      | undefined;
    signalsLast24h = Number(signalRows?.[0]?.c ?? 0);
  }

  return { available: true, active, blocked, signalsLast24h };
}

/**
 * Read R5-B interpretation evidence for a business. Read-only; counts only
 * (never the canonical `record` JSON or signal content); safe to call when
 * B's migration has not run (returns `available: false`).
 */
export async function readR5InterpretationEvidence(
  db: Db,
  businessId: number,
  userId: number,
  now: Date
): Promise<R5InterpretationEvidence> {
  const tablePresent = await tableExists(db, INTERPRETATION_TABLE);
  if (!tablePresent) {
    return {
      available: false,
      reason: "stream_tables_absent",
      interpretationsLast24h: 0,
    };
  }

  const result = await db.execute(sql`
    SELECT COUNT(*) AS c
    FROM ${sql.raw(INTERPRETATION_TABLE)}
    WHERE (businessId = ${businessId} OR (businessId IS NULL AND userId = ${userId}))
      AND createdAt >= ${new Date(now.getTime() - SIGNAL_WINDOW_MS)}
  `);
  const rows = result[0] as unknown as
    | { c?: number | string | bigint }[]
    | undefined;
  return { available: true, interpretationsLast24h: Number(rows?.[0]?.c ?? 0) };
}

/**
 * Read R5-D opportunity evidence for a business. Read-only; status-class
 * counts only (never evidence payloads or actor references); safe to call
 * when D's migration has not run (returns `available: false`).
 */
export async function readR5OpportunityEvidence(
  db: Db,
  businessId: number,
  userId: number,
  now: Date
): Promise<R5OpportunityEvidence> {
  const tablePresent = await tableExists(db, OPPORTUNITY_TABLE);
  if (!tablePresent) {
    return {
      available: false,
      reason: "stream_tables_absent",
      openCandidates: 0,
      handedOff: 0,
      candidatesLast24h: 0,
    };
  }

  const windowStart = new Date(now.getTime() - SIGNAL_WINDOW_MS);
  const result = await db.execute(sql`
    SELECT
      COUNT(CASE WHEN opportunityStatus != ${HANDED_OFF_STATUS} THEN 1 END) AS openCandidates,
      COUNT(CASE WHEN opportunityStatus = ${HANDED_OFF_STATUS} THEN 1 END) AS handedOff,
      COUNT(CASE WHEN createdAt >= ${windowStart} THEN 1 END) AS last24h
    FROM ${sql.raw(OPPORTUNITY_TABLE)}
    WHERE (businessId = ${businessId} OR (businessId IS NULL AND userId = ${userId}))
  `);
  const row = (result[0] as unknown as
    | {
        openCandidates?: number | string | bigint;
        handedOff?: number | string | bigint;
        last24h?: number | string | bigint;
      }[]
    | undefined)?.[0];
  return {
    available: true,
    openCandidates: Number(row?.openCandidates ?? 0),
    handedOff: Number(row?.handedOff ?? 0),
    candidatesLast24h: Number(row?.last24h ?? 0),
  };
}

/**
 * Roll interpretation evidence up to platform-level counts for the
 * readiness surface. Read-only; counts/freshness/source-class only; safe to
 * call when B's migration has not run (returns `available: false`, never
 * throws for absent tables). Raw store errors propagate so callers can map
 * them honestly.
 */
export async function readR5InterpretationRollup(
  db: Db,
  now: Date
): Promise<R5InterpretationRollup> {
  const tablePresent = await tableExists(db, INTERPRETATION_TABLE);
  if (!tablePresent) {
    return {
      available: false,
      reason: "stream_tables_absent",
      total: 0,
      last24h: 0,
      modelCount24h: 0,
      ruleCount24h: 0,
      latestObservedAt: null,
    };
  }

  const windowStart = new Date(now.getTime() - SIGNAL_WINDOW_MS);
  const result = await db.execute(sql`
    SELECT
      COUNT(*) AS total,
      COUNT(CASE WHEN createdAt >= ${windowStart} THEN 1 END) AS last24h,
      COUNT(CASE WHEN createdAt >= ${windowStart} AND modelOrRuleSource = 'MODEL' THEN 1 END) AS modelCount24h,
      COUNT(CASE WHEN createdAt >= ${windowStart} AND modelOrRuleSource = 'RULE' THEN 1 END) AS ruleCount24h,
      MAX(createdAt) AS latestObservedAt
    FROM ${sql.raw(INTERPRETATION_TABLE)}
  `);
  const row = (result[0] as unknown as
    | {
        total?: number | string | bigint;
        last24h?: number | string | bigint;
        modelCount24h?: number | string | bigint;
        ruleCount24h?: number | string | bigint;
        latestObservedAt?: Date | string | null;
      }[]
    | undefined)?.[0];
  return {
    available: true,
    total: Number(row?.total ?? 0),
    last24h: Number(row?.last24h ?? 0),
    modelCount24h: Number(row?.modelCount24h ?? 0),
    ruleCount24h: Number(row?.ruleCount24h ?? 0),
    latestObservedAt: toDate(row?.latestObservedAt ?? null),
  };
}

/**
 * Roll opportunity evidence up to platform-level counts for the readiness
 * surface. Read-only; status-class counts only; safe to call when D's
 * migration has not run (returns `available: false`, never throws for absent
 * tables). Raw store errors propagate so callers can map them honestly.
 */
export async function readR5OpportunityRollup(
  db: Db,
  now: Date
): Promise<R5OpportunityRollup> {
  const tablePresent = await tableExists(db, OPPORTUNITY_TABLE);
  if (!tablePresent) {
    return {
      available: false,
      reason: "stream_tables_absent",
      candidates: 0,
      openCandidates: 0,
      handedOff: 0,
      last24h: 0,
      latestObservedAt: null,
    };
  }

  const windowStart = new Date(now.getTime() - SIGNAL_WINDOW_MS);
  const result = await db.execute(sql`
    SELECT
      COUNT(*) AS candidates,
      COUNT(CASE WHEN opportunityStatus != ${HANDED_OFF_STATUS} THEN 1 END) AS openCandidates,
      COUNT(CASE WHEN opportunityStatus = ${HANDED_OFF_STATUS} THEN 1 END) AS handedOff,
      COUNT(CASE WHEN createdAt >= ${windowStart} THEN 1 END) AS last24h,
      MAX(updatedAt) AS latestObservedAt
    FROM ${sql.raw(OPPORTUNITY_TABLE)}
  `);
  const row = (result[0] as unknown as
    | {
        candidates?: number | string | bigint;
        openCandidates?: number | string | bigint;
        handedOff?: number | string | bigint;
        last24h?: number | string | bigint;
        latestObservedAt?: Date | string | null;
      }[]
    | undefined)?.[0];
  return {
    available: true,
    candidates: Number(row?.candidates ?? 0),
    openCandidates: Number(row?.openCandidates ?? 0),
    handedOff: Number(row?.handedOff ?? 0),
    last24h: Number(row?.last24h ?? 0),
    latestObservedAt: toDate(row?.latestObservedAt ?? null),
  };
}
