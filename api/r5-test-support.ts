/**
 * Shared R5-F test support (plain module — NOT a vitest suite).
 *
 * One in-memory drizzle-SQL evaluator used by the R5-F router test suites
 * (F4 reads, F5 recovery, F8 acceptance). It is table-name-keyed and supports:
 * - select().from().where(eq/and/inArray/isNull + sql`` fragments)
 *   .orderBy(desc id).limit().offset(); every chain stage is awaitable;
 * - update().set().where() with affectedRows (including the
 *   JSON_EXTRACT(workflowContext, '$.nextCycle...') CAS guards the next-cycle
 *   authorities issue);
 * - insert().values() with insertId and an ER_DUP_ENTRY simulation on the
 *   queue_replay_requests.replayKey and audit_events.eventFingerprint unique
 *   authorities, plus a throwable toggle for audit_events inserts
 *   (audit-fail-closed tests);
 * - transaction(cb) with snapshot/rollback so mutation+audit atomicity is
 *   testable (R6-F lead governance).
 *
 * Raw exception/authority modules are never mocked: the real delegated
 * authorities run against this fake. Drizzle chunk shapes verified against
 * drizzle-orm: eq() embeds a Param, inArray embeds a raw values Array,
 * eq(sql`` fragment, value) embeds a raw primitive value, StringChunk carries
 * operator text (" is null").
 */

import { Param, StringChunk } from "drizzle-orm";
import { vi } from "vitest";

function getPathValue(value: unknown, path: string | null): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Extract the first column ref and `$.json.path` inside a sql`` fragment. */
function extractRef(sql: any): { col: string | null; path: string | null } {
  let col: string | null = null;
  let path: string | null = null;
  for (const chunk of sql?.queryChunks ?? []) {
    if (chunk && typeof chunk === "object") {
      if (typeof chunk.name === "string" && chunk.table) {
        col = chunk.name;
      } else if (chunk instanceof StringChunk) {
        const m = chunk.value.join("").match(/\$\.([A-Za-z0-9_.]+)/);
        if (m) path = m[1];
      }
    }
  }
  return { col, path };
}

function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return expected.includes(actual);
  return actual === expected;
}

/**
 * Evaluates a drizzle where-clause against one seed row. Nested sql fragments
 * (JSON_EXTRACT CAS guards) are recursed into and their column/path ref is
 * retained for a following comparison value. All conditions are ANDed (the
 * projection and the governed authorities only use and()).
 */
function evalCond(cond: any, row: any): boolean {
  const chunks: any[] = cond?.queryChunks ?? [];
  let ok = true;
  let col: string | null = null;
  let path: string | null = null;
  for (const chunk of chunks) {
    if (chunk === null || chunk === undefined) continue;
    if (Array.isArray(chunk?.queryChunks)) {
      if (!evalCond(chunk, row)) ok = false;
      const ref = extractRef(chunk);
      if (ref.col) col = ref.col;
      if (ref.path) path = ref.path;
      continue;
    }
    if (typeof chunk === "object") {
      if (typeof chunk.name === "string" && chunk.table) {
        col = chunk.name;
        continue;
      }
      if (chunk instanceof StringChunk) {
        if (/is\s+null/i.test(chunk.value.join(""))) {
          if (getPathValue(row[col ?? ""], path) != null) ok = false;
          col = null;
          path = null;
        }
        continue;
      }
      if (chunk instanceof Param) {
        if (!matches(getPathValue(row[col ?? ""], path), chunk.value)) ok = false;
        col = null;
        path = null;
        continue;
      }
      if (Array.isArray(chunk)) {
        // inArray(column, values) embeds an array of Param-wrapped values.
        const values = chunk.map((v) => (v instanceof Param ? v.value : v));
        if (!values.includes(getPathValue(row[col ?? ""], path))) ok = false;
        col = null;
        path = null;
        continue;
      }
      continue;
    }
    // Raw primitive comparison value (eq(sql`` fragment, value) shape).
    if (!matches(getPathValue(row[col ?? ""], path), chunk)) ok = false;
    col = null;
    path = null;
  }
  return ok;
}

export interface FakeDbOptions {
  /** When set, the next audit_events insert throws with this error (audit fail-closed tests). */
  failAuditInsert?: Error | null;
}

export function createFakeDb(
  seed: Record<string, Record<string, unknown>[]>,
  options: FakeDbOptions = {}
) {
  // Field projection mirrors real drizzle: where() filters run against the
  // RAW row (conditions may reference unselected columns), and the selected
  // column map is applied afterwards. Bare select() returns full rows.
  const projectRow = (row: any, fields: any) => {
    const out: Record<string, unknown> = {};
    for (const [alias, col] of Object.entries(fields)) {
      out[alias] =
        col && typeof col === "object" && typeof (col as { name?: unknown }).name === "string"
          ? row[(col as { name: string }).name]
          : row[alias];
    }
    return out;
  };
  const exec = (
    rows: any[],
    state: {
      cond?: any;
      orderDesc?: boolean;
      limit?: number;
      offset?: number;
      fields?: unknown;
    }
  ) => {
    let out = rows;
    if (state.cond) out = out.filter((r) => evalCond(state.cond, r));
    if (state.orderDesc) out = [...out].sort((a, b) => Number(b.id) - Number(a.id));
    if (state.offset) out = out.slice(state.offset);
    if (state.limit != null) out = out.slice(0, state.limit);
    if (state.fields) out = out.map((r) => projectRow(r, state.fields));
    return Promise.resolve(out);
  };
  const chain = (rows: any[], state: any): any => ({
    where: (cond: any) => chain(rows, { ...state, cond }),
    orderBy: (_order: any) => chain(rows, { ...state, orderDesc: true }),
    limit: (n: number) => chain(rows, { ...state, limit: n }),
    offset: (n: number) => chain(rows, { ...state, offset: n }),
    then: (onF: any, onR: any) => exec(rows, state).then(onF, onR),
  });
  const duplicateKeyError = (message: string) => {
    const err = new Error(message) as Error & { code: string };
    err.code = "ER_DUP_ENTRY";
    return err;
  };
  const db = {
    select: (fields?: unknown) => ({
      from: (table: unknown) =>
        chain(seed[tableName(table)] ?? [], { fields: fields ?? null }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async (cond: any) => {
          const rows = seed[tableName(table)] ?? [];
          let affected = 0;
          for (const row of rows) {
            if (evalCond(cond, row)) {
              Object.assign(row, values);
              affected += 1;
            }
          }
          // Dual-shape result header: governed stores read either
          // `result.affectedRows` (mysql2 ResultSetHeader shape, e.g.
          // opportunity-store CAS guard) or `result[0].affectedRows`
          // ([ResultSetHeader, ...] shape, e.g. workflow next-cycle/budget
          // CAS). Both conventions resolve correctly from one header.
          const header = { affectedRows: affected } as { affectedRows: number; 0?: unknown };
          header[0] = header;
          return header;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (row: Record<string, unknown>) => {
        const name = tableName(table);
        const rows = seed[name] ?? (seed[name] = []);
        if (name === "queue_replay_requests") {
          if (rows.some((r) => r.replayKey === row.replayKey)) {
            throw duplicateKeyError("Duplicate entry 'replayKey'");
          }
        }
        if (name === "lead_privacy_states") {
          if (rows.some((r) => r.leadId === row.leadId)) {
            throw duplicateKeyError("Duplicate entry 'leadId'");
          }
        }
        if (name === "audit_events") {
          if (options.failAuditInsert) throw options.failAuditInsert;
          if (rows.some((r) => r.eventFingerprint === row.eventFingerprint)) {
            throw duplicateKeyError("Duplicate entry 'eventFingerprint'");
          }
        }
        if (name === "optimisation_governance_decisions") {
          // R7-F durable convergence anchor: unique (userId, governanceDecisionId).
          if (
            rows.some(
              (r) => r.userId === row.userId && r.governanceDecisionId === row.governanceDecisionId
            )
          ) {
            throw duplicateKeyError("Duplicate entry 'userId-governanceDecisionId'");
          }
        }
        const id = rows.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
        rows.push({ ...row, id });
        return [{ insertId: id, affectedRows: 1 }];
      },
    }),
    execute: vi.fn(),
    /**
     * Transaction support for mutation+audit atomicity tests: runs the
     * callback against the same in-memory db; on failure the seed is restored
     * from a structured snapshot (real MySQL would roll back the tx).
     */
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const snapshot = structuredClone(seed);
      try {
        return await cb(db);
      } catch (err) {
        for (const key of Object.keys(seed)) delete seed[key];
        Object.assign(seed, snapshot);
        throw err;
      }
    },
  };
  return { db, seed };
}

export function tableName(table: unknown): string {
  return (table as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "unknown";
}

/** Builds a tRPC caller context. `user: null` models an unauthenticated caller. */
export function buildCtx(user: Record<string, unknown> | null) {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user,
    session: user ? { userId: user.id, type: "local", verified: true } : undefined,
  } as never;
}

/**
 * Full R5ListeningBindingEvidence DTO with healthy defaults; override per
 * fixture. Mirrors the shape r5-stream-evidence returns.
 */
export function listeningBinding(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    integrationId: 8001,
    provider: "meta",
    platform: "instagram",
    providerAccountId: "acct-9",
    mechanism: "webhook",
    status: "active",
    cursorUpdatedAt: now,
    lastSuccessAt: now,
    lastFailureAt: null,
    lastFailureClass: null,
    lastFailureCode: null,
    lastFailureReason: null,
    acceptedCount: 12,
    duplicateCount: 1,
    rejectedCount: 0,
    signalsLast24h: 6,
    latestSignalObservedAt: now,
    ...overrides,
  };
}
