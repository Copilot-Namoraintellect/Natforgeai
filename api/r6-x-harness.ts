/**
 * Shared R6-X connected-harness support (plain module — NOT a vitest suite).
 *
 * One table-name-keyed in-memory store + a fluent drizzle-shaped client that
 * the REAL R6 services run against for the integrated end-to-end acceptance:
 * A identity intake, B scoring, C qualification, D nurture/handoff (via the
 * REAL production ports module), E conversion intake, F governance reads.
 * No real MySQL, no network, no wall-clock reliance (explicit `now` injected
 * at service level), no live provider/CRM/billing.
 *
 * Supported drizzle surface (tailored to the real code paths exercised):
 *   select() / select({ alias: col }) .from().where(eq/and/inArray/isNull/
 *     gt/gte/lt/lte/ne + nested sql`` fragments) .orderBy(asc|desc col)
 *     .limit().offset(); every chain stage is thenable;
 *   insert().values() with ER_DUP_ENTRY simulation on the durable unique
 *     anchors (full R6 registry below) and serial id minting;
 *   update().set().where(...) with affectedRows;
 *   execute(sql) answering the information_schema table-availability probe,
 *     COUNT(*) availability probes, and SELECT 1;
 *   transaction(cb) with snapshot/rollback so audit-atomicity is testable.
 *
 * Nullable unique members follow MySQL semantics (any NULL member ⇒ distinct).
 */

import { Param, StringChunk, getTableName } from "drizzle-orm";

export type FakeRow = Record<string, unknown>;
export type FakeTables = Record<string, FakeRow[]>;

/** Durable unique anchors the fake enforces (mirrors db/schema.ts uniques). */
export const HARNESS_UNIQUE_CONSTRAINTS: Record<string, string[][]> = {
  opportunity_candidates: [["userId", "opportunityKey"]],
  opportunity_evidence: [["interpretationId", "kind"], ["engagementReceiptId"]],
  opportunity_suppressions: [["interpretationId"]],
  opportunity_handoffs: [["userId", "opportunityId"], ["handoffId"]],
  lead_identities: [
    ["userId", "identityKey"],
    ["userId", "leadId"],
    ["userId", "emailIdentityHash"],
    ["userId", "phoneIdentityHash"],
    ["userId", "customerReferenceHash"],
  ],
  lead_identity_provenance: [["userId", "handoffId"], ["userId", "kind", "evidenceHash"]],
  lead_identity_merges: [
    ["userId", "mergeId"],
    ["userId", "canonicalLeadId", "absorbedLeadId"],
    ["userId", "mergeHash"],
  ],
  lead_score_snapshots: [
    ["userId", "leadId", "evidenceSnapshotHash", "scoringVersion"],
    ["leadScoreId"],
  ],
  lead_qualifications: [["userId", "qualificationId"]],
  lead_qualification_reviews: [["userId", "reviewId"], ["userId", "qualificationId"]],
  lead_privacy_states: [["leadId"]],
  conversion_events: [["conversionId"], ["userId", "sourceSystem", "externalConversionId"]],
  conversion_lifecycle_events: [["lifecycleEventId"], ["conversionId", "externalLifecycleId"]],
  nurture_handoff_decisions: [["userId", "decisionKey"], ["nurtureDecisionId"]],
  sales_handoffs: [["handoffId"], ["userId", "handoffKey"]],
  handoff_dispatch_receipts: [["executionIdentity"]],
  nurture_touch_records: [["userId", "touchIdentity"]],
  approval_requests: [["idempotencyKey"]],
  audit_events: [["eventFingerprint"]],
  two_factor_challenges: [["challengeId"]],
};

const DEFAULT_TABLES: FakeTables = {
  audit_events: [],
  businesses: [],
  campaigns: [],
  leads: [],
  lead_activities: [],
  opportunity_candidates: [],
  opportunity_evidence: [],
  opportunity_suppressions: [],
  opportunity_handoffs: [],
  lead_identities: [],
  lead_identity_provenance: [],
  lead_identity_merges: [],
  lead_score_snapshots: [],
  lead_qualifications: [],
  lead_qualification_reviews: [],
  lead_privacy_states: [],
  conversion_events: [],
  conversion_lifecycle_events: [],
  nurture_handoff_decisions: [],
  sales_handoffs: [],
  handoff_dispatch_receipts: [],
  nurture_touch_records: [],
  approval_requests: [],
  two_factor_challenges: [],
  social_signals: [],
  social_interpretations: [],
};

function tableName(table: unknown): string {
  try {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  } catch {
    return (table as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "unknown";
  }
}

function fragText(chunk: unknown): string {
  if (chunk instanceof StringChunk) return chunk.value.join("");
  if (
    chunk &&
    typeof chunk === "object" &&
    Array.isArray((chunk as { value?: unknown[] }).value)
  ) {
    return ((chunk as { value: string[] }).value.join("")) as string;
  }
  return "";
}

function chunkParamValue(chunk: unknown): unknown {
  if (chunk instanceof Param) return chunk.value;
  if (chunk && typeof chunk === "object" && "value" in chunk) {
    return (chunk as { value: unknown }).value;
  }
  return chunk;
}

function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function compareOp(opText: string, rowValue: unknown, param: unknown): boolean {
  const op = opText.includes(">=")
    ? ">="
    : opText.includes("<=")
      ? "<="
      : opText.includes("!=") || opText.includes("<>")
        ? "!="
        : opText.includes("=")
          ? "="
          : opText.includes(">")
            ? ">"
            : opText.includes("<")
              ? "<"
              : "=";
  const rowMs = toEpochMs(rowValue);
  const paramMs = toEpochMs(param);
  const useTime =
    rowMs !== null && paramMs !== null && (rowValue instanceof Date || param instanceof Date);
  const l: unknown = useTime ? rowMs : rowValue;
  const r: unknown = useTime ? paramMs : param;
  switch (op) {
    case ">=":
      return (l as number) >= (r as number);
    case "<=":
      return (l as number) <= (r as number);
    case ">":
      return (l as number) > (r as number);
    case "<":
      return (l as number) < (r as number);
    case "!=":
      return l !== r;
    default:
      return l === r;
  }
}

/** Evaluate one drizzle where-fragment against a row (state-machine walker:
 *  tracks the last column ref, comparison operator, and value; nested sql
 *  fragments recurse; inArray arrives as a raw Array chunk of Params). */
export function harnessEvalCond(cond: unknown, row: FakeRow): boolean {
  const chunks: unknown[] = (cond as { queryChunks?: unknown[] })?.queryChunks ?? [];
  let ok = true;
  let col: string | null = null;
  let op: string = "=";
  for (const chunk of chunks) {
    if (chunk === null || chunk === undefined) continue;
    if (Array.isArray((chunk as { queryChunks?: unknown[] }).queryChunks)) {
      if (!harnessEvalCond(chunk, row)) ok = false;
      continue;
    }
    if (typeof chunk === "object") {
      if (typeof (chunk as { name?: unknown }).name === "string" && (chunk as { table?: unknown }).table) {
        col = (chunk as { name: string }).name;
        continue;
      }
      if (chunk instanceof StringChunk) {
        const text = chunk.value.join("");
        if (/is\s+null/i.test(text)) {
          if (row[col ?? ""] != null) ok = false;
          col = null;
          op = "=";
        } else {
          op = text.includes(">=")
            ? ">="
            : text.includes("<=")
              ? "<="
              : text.includes("!=") || text.includes("<>")
                ? "!="
                : text.includes(">")
                  ? ">"
                  : text.includes("<")
                    ? "<"
                    : "=";
        }
        continue;
      }
      if (chunk instanceof Param) {
        if (!compareOp(op, row[col ?? ""], chunk.value)) ok = false;
        col = null;
        op = "=";
        continue;
      }
      if (Array.isArray(chunk)) {
        const values = chunk.map((v) => (v instanceof Param ? v.value : v));
        if (!values.includes(row[col ?? ""])) ok = false;
        col = null;
        op = "=";
        continue;
      }
      continue;
    }
    if (!compareOp(op, row[col ?? ""], chunk)) ok = false;
    col = null;
    op = "=";
  }
  return ok;
}

function duplicateKeyError(): Error & { code: string } {
  const err = new Error("Duplicate entry (simulated unique-key violation)") as Error & {
    code: string;
  };
  err.code = "ER_DUP_ENTRY";
  return err;
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ER_DUP_ENTRY";
}

export interface HarnessDb {
  select: (fields?: unknown) => any;
  insert: (table: unknown) => any;
  update: (table: unknown) => any;
  execute: (query: unknown) => Promise<unknown>;
  transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
}

export interface Harness {
  db: HarnessDb;
  tables: FakeTables;
  seed: (table: string, rows: FakeRow[]) => void;
  snapshot: () => FakeTables;
  restore: (snap: FakeTables) => void;
}

function parseOrderTerms(args: unknown[]): { col: string; dir: "asc" | "desc" }[] {
  const terms: { col: string; dir: "asc" | "desc" }[] = [];
  for (const arg of args) {
    const chunks = (arg as { queryChunks?: unknown[] })?.queryChunks;
    if (Array.isArray(chunks)) {
      const col = chunks.find((c) => c && typeof (c as { name?: unknown }).name === "string") as
        | { name: string }
        | undefined;
      const text = chunks.map((c) => fragText(c)).join(" ");
      if (col) terms.push({ col: col.name, dir: /\bdesc\b/i.test(text) ? "desc" : "asc" });
    } else if (arg && typeof (arg as { name?: unknown }).name === "string") {
      terms.push({ col: (arg as { name: string }).name, dir: "asc" });
    }
  }
  return terms;
}

export function createHarnessDb(seed: FakeTables = {}): Harness {
  const tables: FakeTables = {};
  for (const name of Object.keys(DEFAULT_TABLES)) {
    tables[name] = [...(DEFAULT_TABLES[name] ?? [])];
  }
  for (const name of Object.keys(seed)) {
    tables[name] = [...(seed[name] ?? [])];
  }
  const nextIds: Record<string, number> = {};
  for (const name of Object.keys(tables)) {
    const maxId = tables[name].reduce((m, r) => Math.max(m, Number(r.id ?? 0)), 0);
    nextIds[name] = maxId + 1;
  }
  const uniqueConstraints: Record<string, string[][]> = HARNESS_UNIQUE_CONSTRAINTS;

  function checkUnique(name: string, row: FakeRow): void {
    for (const cols of uniqueConstraints[name] ?? []) {
      if (cols.some((c) => row[c] === null || row[c] === undefined)) continue;
      if (tables[name].some((r) => cols.every((c) => r[c] === row[c]))) {
        throw duplicateKeyError();
      }
    }
  }

  function projectRow(fields: unknown, row: FakeRow): FakeRow {
    if (fields === undefined) return row;
    if (typeof fields === "object" && fields !== null) {
      const out: FakeRow = {};
      for (const [alias, col] of Object.entries(fields as Record<string, unknown>)) {
        const name = (col as { name?: string }).name;
        out[alias] = name !== undefined ? row[name] : undefined;
      }
      return out;
    }
    return row;
  }

  const makeClient = (): HarnessDb => ({
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        const name = tableName(table);
        const all = (): FakeRow[] => tables[name] ?? [];
        const build = (cond: unknown, order: { col: string; dir: "asc" | "desc" }[], offsetN: number) => {
          const run = (): FakeRow[] => {
            let rows = all().filter((r) => harnessEvalCond(cond, r));
            for (let t = order.length - 1; t >= 0; t -= 1) {
              const { col, dir } = order[t];
              rows = [...rows].sort((a, b) => {
                const av = toEpochMs(a[col]) ?? a[col];
                const bv = toEpochMs(b[col]) ?? b[col];
                if (av === bv) return 0;
                if (av === null || av === undefined) return 1;
                if (bv === null || bv === undefined) return -1;
                const cmp = av < bv ? -1 : 1;
                return dir === "desc" ? -cmp : cmp;
              });
            }
            if (offsetN > 0) rows = rows.slice(offsetN);
            return rows;
          };
          const chain: any = {
            where: (c: unknown) => build(c, order, offsetN),
            orderBy: (...args: unknown[]) => build(cond, parseOrderTerms(args), offsetN),
            limit: async (n: number) => run().slice(0, n).map((r) => projectRow(fields, r)),
            offset: (n: number) => build(cond, order, n),
            then: (onF: unknown, onR: unknown) =>
              Promise.resolve(run().map((r) => projectRow(fields, r))).then(onF as never, onR as never),
          };
          return chain;
        };
        return build(undefined, [], 0);
      },
    }),
    insert: (table: unknown) => ({
      values: (values: FakeRow) => {
        const name = tableName(table);
        checkUnique(name, values);
        const row: FakeRow = { ...values };
        if (row.id === undefined) {
          row.id = nextIds[name]++;
        } else {
          nextIds[name] = Math.max(nextIds[name] ?? 1, Number(row.id) + 1);
        }
        tables[name].push(row);
        // Mirror real drizzle mysql: [ResultSetHeader, FieldPacket[]].
        return Promise.resolve([{ insertId: row.id, affectedRows: 1 }, []]);
      },
    }),
    update: (table: unknown) => ({
      set: (patch: FakeRow) => ({
        where: (cond: unknown) => {
          const name = tableName(table);
          const matched = (tables[name] ?? []).filter((r) => harnessEvalCond(cond, r));
          for (const r of matched) {
            for (const [key, value] of Object.entries(patch)) {
              if (value !== null && typeof value === "object" && Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
                // sql`col + 1` style fragment (CAS version bumps): increment.
                r[key] = Number(r[key] ?? 0) + 1;
              } else {
                r[key] = value;
              }
            }
          }
          return Promise.resolve({ affectedRows: matched.length });
        },
      }),
    }),
    execute: async (query: unknown) => {
      const flattenText = (node: unknown): string => {
        if (typeof node === "string") return node;
        if (node instanceof StringChunk) return node.value.join("");
        if (node instanceof Param) return "";
        if (node && typeof node === "object" && Array.isArray((node as { queryChunks?: unknown[] }).queryChunks)) {
          return (node as { queryChunks: unknown[] }).queryChunks.map(flattenText).join("");
        }
        if (node && typeof node === "object" && "value" in node && Array.isArray((node as { value: unknown[] }).value)) {
          return (node as { value: string[] }).value.join("");
        }
        return "";
      };
      const text: string = flattenText(query);
      if (/information_schema\.tables/i.test(text)) {
        // The probed table names arrive as raw string/Param chunks; collect
        // every string primitive in the fragment as the wanted set.
        const wanted = new Set<string>();
        const collectParams = (node: unknown): void => {
          if (typeof node === "string") {
            wanted.add(node.toLowerCase());
            return;
          }
          if (node instanceof Param) {
            if (typeof node.value === "string") wanted.add(node.value.toLowerCase());
            return;
          }
          if (node && typeof node === "object" && Array.isArray((node as { queryChunks?: unknown[] }).queryChunks)) {
            for (const c of (node as { queryChunks: unknown[] }).queryChunks) collectParams(c);
          }
        };
        collectParams(query);
        const names = Object.keys(tables).filter((n) =>
          wanted.size > 0 ? wanted.has(n.toLowerCase()) : true
        );
        if (/count\s*\(/i.test(text)) {
          return [[{ c: names.length }], []];
        }
        return [names.map((table_name) => ({ table_name })), []];
      }
      if (/count\s*\(/i.test(text)) {
        // COUNT(*) over a table named in the fragment (F/D availability probes).
        const m = /from\s+`?([a-z_]+)`?/i.exec(text);
        const count = m ? (tables[m[1]] ?? []).length : 0;
        return [[{ c: count }], []];
      }
      return [[{ 1: 1 }], []];
    },
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const snap = JSON.parse(JSON.stringify(tables)) as FakeTables;
      try {
        const result = await cb(makeClient());
        return result;
      } catch (err) {
        for (const k of Object.keys(tables)) delete tables[k];
        Object.assign(tables, snap);
        throw err;
      }
    },
  });

  const client = makeClient();

  return {
    db: client,
    tables,
    seed: (table, rows) => {
      tables[table] = [...rows];
      const maxId = rows.reduce((m, r) => Math.max(m, Number(r.id ?? 0)), 0);
      nextIds[table] = Math.max(nextIds[table] ?? 1, maxId + 1);
    },
    snapshot: () => JSON.parse(JSON.stringify(tables)) as FakeTables,
    restore: (snap) => {
      for (const k of Object.keys(tables)) delete tables[k];
      Object.assign(tables, JSON.parse(JSON.stringify(snap)) as FakeTables);
    },
  };
}

export { tableName as harnessTableName, isDuplicateKeyError as harnessIsDuplicateKeyError };
