/**
 * Shared R9-E test support (plain module — NOT a vitest suite).
 *
 * One in-memory fake database for the R9-E acceptance/security suites,
 * replicating the durable unique indexes of the stream-local tables
 * (mission_state_records / mission_task_states / mission_recovery_candidates /
 * mission_operational_timeline_events + the canonical audit_events ledger).
 * The factory mirrors the house r5-test-support evaluator shape (drizzle
 * chainable select/update/insert with and(eq(...)) conditions, orderBy,
 * limit) so the REAL stores run unmodified against it.
 */

import { getTableName } from "drizzle-orm";

const UNIQUE_CHECKS: Record<string, string[][]> = {
  audit_events: [["eventFingerprint"]],
  mission_state_records: [["missionStateId"], ["userId", "missionStateId"]],
  mission_task_states: [["taskStateId"], ["userId", "taskStateId"]],
  mission_recovery_candidates: [["recoveryCandidateId"], ["userId", "recoveryCandidateId"]],
  mission_operational_timeline_events: [["timelineEventId"], ["userId", "timelineEventId"]],
};

function flattenSql(fragment: any): string {
  if (fragment == null) return "";
  if (typeof fragment === "string") return fragment;
  if (typeof fragment === "number" || typeof fragment === "boolean") return String(fragment);
  if (Array.isArray(fragment)) return fragment.map(flattenSql).join("");
  if (typeof fragment === "object") {
    if (Array.isArray(fragment.queryChunks)) return fragment.queryChunks.map(flattenSql).join("");
    if (Array.isArray(fragment.value)) return fragment.value.map(flattenSql).join("");
    if (typeof fragment.name === "string") return fragment.name;
    if ("value" in fragment) return flattenSql(fragment.value);
  }
  return "";
}

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
      } else if (Array.isArray(chunk?.value)) {
        const text = chunk.value.map((c: unknown) => (typeof c === "string" ? c : "")).join("");
        const m = text.match(/\$\.([A-Za-z0-9_.]+)/);
        if (m) path = m[1];
      }
    }
  }
  return { col, path };
}

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
      if (Array.isArray(chunk?.value)) {
        if (/is\s+null/i.test(chunk.value.map((c: unknown) => String(c)).join(""))) {
          if (getPathValue(row[col ?? ""], path) != null) ok = false;
          col = null;
          path = null;
        } else {
          const m = chunk.value.map((c: unknown) => String(c)).join("").match(/\$\.([A-Za-z0-9_.]+)/);
          if (m) path = m[1];
        }
        continue;
      }
      if (chunk.constructor?.name === "Param" || typeof chunk.value !== "undefined") {
        if (getPathValue(row[col ?? ""], path) !== chunk.value) ok = false;
        col = null;
        path = null;
        continue;
      }
      if (Array.isArray(chunk)) {
        const values = chunk.map((v: any) => (v?.value !== undefined ? v.value : v));
        if (!values.includes(getPathValue(row[col ?? ""], path))) ok = false;
        col = null;
        path = null;
        continue;
      }
      continue;
    }
    if (getPathValue(row[col ?? ""], path) !== chunk) ok = false;
    col = null;
    path = null;
  }
  return ok;
}

export function makeFakeDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    mission_state_records: [],
    mission_task_states: [],
    mission_recovery_candidates: [],
    mission_operational_timeline_events: [],
    audit_events: [],
    ...seed,
  };
  let autoId = 9000;
  const fake: any = {};
  fake._tables = tables;

  function checkUnique(table: string, row: Record<string, unknown>): void {
    for (const keys of UNIQUE_CHECKS[table] ?? []) {
      for (const existing of tables[table]) {
        if (keys.every((k) => existing[k] === row[k])) {
          const err: any = new Error(`Duplicate entry for key '${table}.${keys.join("_")}'`);
          err.code = "ER_DUP_ENTRY";
          throw err;
        }
      }
    }
  }

  function selectChain(table: string) {
    const state: { cond?: any; orderCols: { col: string; dir: "asc" | "desc" }[]; limit?: number } = {
      orderCols: [],
    };
    const c: any = {};
    c.from = () => c;
    c.where = (w: any) => {
      state.cond = w;
      return c;
    };
    c.orderBy = (...cols: any[]) => {
      state.orderCols = cols.map((col) => {
        if (col && typeof col === "object" && Array.isArray(col.queryChunks)) {
          const named = col.queryChunks.find((chunk: any) => chunk && typeof chunk.name === "string");
          const text = flattenSql(col);
          return { col: named?.name ?? String(col), dir: /desc/i.test(text) ? ("desc" as const) : ("asc" as const) };
        }
        return { col: col?.name ?? String(col), dir: "asc" as const };
      });
      return c;
    };
    c.limit = (n: number) => {
      state.limit = n;
      return c;
    };
    c.then = (resolve: (rows: unknown[]) => unknown) => {
      let out = tables[table].slice();
      if (state.cond) out = out.filter((r) => evalCond(state.cond, r));
      for (const { col, dir } of state.orderCols.reverse()) {
        out = out.sort((a, b) => {
          const av = (a as Record<string, unknown>)[col];
          const bv = (b as Record<string, unknown>)[col];
          const an = av instanceof Date ? av.getTime() : Number(av);
          const bn = bv instanceof Date ? bv.getTime() : Number(bv);
          if (Number.isFinite(an) && Number.isFinite(bn)) return dir === "desc" ? bn - an : an - bn;
          const cmp = String(av ?? "").localeCompare(String(bv ?? ""));
          return dir === "desc" ? -cmp : cmp;
        });
      }
      if (state.limit != null) out = out.slice(0, state.limit);
      // Return copies — callers must never hold live row references (CAS
      // re-read validation depends on observing post-update state).
      return Promise.resolve(resolve(out.map((r) => ({ ...r }))));
    };
    return c;
  }

  fake.select = (_fields?: unknown) => ({
    from: (t: unknown) => selectChain(getTableName(t as never)),
  });

  fake.insert = (t: unknown) => ({
    values: async (values: Record<string, unknown> | Record<string, unknown>[]) => {
      const table = getTableName(t as never);
      const rows = Array.isArray(values) ? values : [values];
      const inserted: number[] = [];
      for (const row of rows) {
        checkUnique(table, row);
        const id = Number(row.id ?? ++autoId);
        tables[table].push({ ...row, id });
        inserted.push(id);
      }
      return [{ insertId: inserted[inserted.length - 1], affectedRows: rows.length }];
    },
  });

  fake.update = (t: unknown) => {
    const table = getTableName(t as never);
    const chain: any = {};
    let cond: any = null;
    chain.set = (values: Record<string, unknown>) => {
      chain._set = values;
      return chain;
    };
    chain.where = (w: any) => {
      cond = w;
      return {
        then: (resolve: (rows: unknown[]) => unknown) => {
          let affected = 0;
          for (const row of tables[table]) {
            if (cond && !evalCond(cond, row)) continue;
            Object.assign(row, chain._set);
            affected++;
          }
          return Promise.resolve(resolve([{ affectedRows: affected }]));
        },
      };
    };
    return chain;
  };

  return fake;
}
