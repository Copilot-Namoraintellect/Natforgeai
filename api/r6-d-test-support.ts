/**
 * Shared R6-D test support (plain module — NOT a vitest suite).
 *
 * One in-memory executor for the R6-D nurture/handoff tables plus the shared
 * governance tables the service touches (approval_requests, audit_events),
 * and frozen-upstream port fakes implementing the A/C/E/F contract shapes.
 * Every harness call passes an explicit executor — no real database is ever
 * touched, no real CRM/provider is ever called (the transport is the
 * explicitly fake/test-only in-memory transport).
 *
 * Supported drizzle surface (tailored to the D store/service):
 *   select() / select({ alias: col }) .from().where(eq/and/inArray)
 *     .orderBy(desc col).limit(); every chain stage is awaitable;
 *   insert().values() with ER_DUP_ENTRY simulation on the durable unique
 *     anchors (decision key/id, handoff key/id, execution identity, touch
 *     identity, approval idempotency key, audit fingerprint);
 *   update().set().where(eq/and/inArray) with version-bump fragments;
 *   execute(sql) answering the information_schema table-availability probe.
 */

import { Param, StringChunk, getTableName } from "drizzle-orm";
import {
  nurtureHandoffDecisions,
  salesHandoffs,
  handoffDispatchReceipts,
  nurtureTouchRecords,
  approvalRequests,
  auditEvents,
} from "@db/schema";
import type { NurtureUpstreamPorts } from "./lib/nurture/nurture-service";
import { createFakeNurtureTransport, type FakeNurtureTransport } from "./lib/nurture/nurture-transport";
import { FAKE_TEST_PROVIDER } from "./lib/nurture/nurture-provider-capability";

// ─── table registry ───

const TABLE_BY_NAME: Record<string, { name: string; uniqueKeys: string[][] }> = {
  nurture_handoff_decisions: {
    name: "nurture_handoff_decisions",
    uniqueKeys: [["userId", "decisionKey"], ["nurtureDecisionId"]],
  },
  sales_handoffs: {
    name: "sales_handoffs",
    uniqueKeys: [["userId", "handoffKey"], ["handoffId"]],
  },
  handoff_dispatch_receipts: {
    name: "handoff_dispatch_receipts",
    uniqueKeys: [["executionIdentity"]],
  },
  nurture_touch_records: {
    name: "nurture_touch_records",
    uniqueKeys: [["userId", "touchIdentity"]],
  },
  approval_requests: { name: "approval_requests", uniqueKeys: [["idempotencyKey"]] },
  audit_events: { name: "audit_events", uniqueKeys: [["eventFingerprint"]] },
};

function tableNameOf(table: unknown): string {
  try {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  } catch {
    return "";
  }
}

class DuplicateKeyError extends Error {
  code = "ER_DUP_ENTRY";
  errno = 1062;
}

// ─── condition evaluation ───

function extractColumn(chunk: unknown): string | null {
  if (chunk && typeof chunk === "object") {
    const c = chunk as { name?: string; table?: unknown };
    if (typeof c.name === "string" && c.table) return c.name;
  }
  return null;
}

function extractOperatorAndValue(chunks: unknown[], start: number): { op: string; value: unknown; consumed: number } {
  const opChunk = chunks[start];
  const paramChunk = chunks[start + 1];
  const opText =
    opChunk instanceof StringChunk
      ? opChunk.value.join("")
      : typeof (opChunk as { operator?: string })?.operator === "string"
        ? (opChunk as { operator: string }).operator
        : "=";
  let value: unknown = paramChunk;
  if (paramChunk instanceof Param) value = paramChunk.value;
  else if (Array.isArray(paramChunk)) {
    // inArray embeds a raw values array whose elements are Param-wrapped.
    value = paramChunk.map((v) => (v instanceof Param ? v.value : v));
  } else if (paramChunk && typeof paramChunk === "object" && Array.isArray((paramChunk as { queryChunks?: unknown[] }).queryChunks)) {
    // nested sql fragment (inArray values or version arithmetic)
    const nested = (paramChunk as { queryChunks: unknown[] }).queryChunks;
    const values: unknown[] = [];
    for (const n of nested) {
      if (n instanceof Param) values.push(n.value);
      else if (Array.isArray(n)) for (const v of n) values.push(v instanceof Param ? v.value : v);
    }
    value = values;
  }
  return { op: opText, value, consumed: 2 };
}

function evalCond(cond: unknown, row: Record<string, unknown>): boolean {
  const chunks: unknown[] = (cond as { queryChunks?: unknown[] })?.queryChunks ?? [];
  if (chunks.length === 0) return true;
  let ok = true;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === null || chunk === undefined) continue;
    if (Array.isArray((chunk as { queryChunks?: unknown[] }).queryChunks)) {
      if (!evalCond(chunk, row)) ok = false;
      continue;
    }
    const col = extractColumn(chunk);
    if (col) {
      const { op, value, consumed } = extractOperatorAndValue(chunks, i + 1);
      i += consumed;
      const rowValue = row[col];
      if (/\bin\b/i.test(op) && Array.isArray(value)) {
        if (!value.includes(rowValue)) ok = false;
      } else if (op.includes(">") && op.includes("<")) {
        if (!(rowValue !== value)) ok = false; // <> — treat as inequality
      } else if (op.includes(">") || op.includes("<")) {
        // unsupported directional op for this harness
        ok = false;
      } else if (Array.isArray(value)) {
        if (!value.includes(rowValue)) ok = false;
      } else if (rowValue !== value) {
        ok = false;
      }
    }
  }
  return ok;
}

function projectRow(projection: unknown, row: Record<string, unknown>): Record<string, unknown> {
  if (!projection || Object.keys(projection as object).length === 0) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [alias, col] of Object.entries(projection as Record<string, unknown>)) {
    const colName = extractColumn(col) ?? (col as { name?: string })?.name;
    out[alias] = colName !== null && colName !== undefined ? row[colName] : undefined;
  }
  return out;
}

function sqlTextOf(fragment: unknown): string {
  const direct = (fragment as { sql?: string })?.sql;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const chunks = (fragment as { queryChunks?: unknown[] })?.queryChunks ?? [];
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (chunk instanceof StringChunk) parts.push(chunk.value.join(""));
    else if (typeof chunk === "string") parts.push(chunk);
    else if (chunk && typeof chunk === "object" && Array.isArray((chunk as { queryChunks?: unknown[] }).queryChunks)) {
      parts.push(sqlTextOf(chunk));
    } else if (chunk instanceof Param) {
      parts.push(String(chunk.value));
    }
  }
  return parts.join("");
}

// ─── chain implementation ───

class MemChain {
  private state: {
    tables: Map<string, Array<Record<string, unknown>>>;
    autoIds: Map<string, number>;
    kind: "select" | "insert" | "update" | "execute";
    table?: string;
    projection?: unknown;
    cond?: unknown;
    orderCol?: string;
    orderDesc?: boolean;
    limitN?: number;
    valuesRow?: Record<string, unknown>;
    setFields?: Record<string, unknown>;
    sqlText?: string;
    availableTables: Set<string>;
  };

  constructor(init: MemChain["state"]) {
    this.state = init;
  }

  from(table: unknown): MemChain {
    return new MemChain({ ...this.state, table: tableNameOf(table) });
  }

  where(cond: unknown): MemChain {
    return new MemChain({ ...this.state, cond });
  }

  orderBy(..._cols: unknown[]): MemChain {
    // desc(col) arrives as a SQL wrapper; approximate by scanning the first
    // column reference in the wrapper chunks.
    const col = _cols[0] as { queryChunks?: unknown[] } | undefined;
    let name: string | null = null;
    for (const c of col?.queryChunks ?? []) {
      name = extractColumn(c) ?? name;
    }
    return new MemChain({ ...this.state, orderCol: name ?? "id", orderDesc: true });
  }

  limit(n: number): MemChain {
    return new MemChain({ ...this.state, limitN: n });
  }

  values(row: Record<string, unknown>): MemChain {
    return new MemChain({ ...this.state, valuesRow: row });
  }

  set(fields: Record<string, unknown>): MemChain {
    return new MemChain({ ...this.state, setFields: fields });
  }

  async then(resolve: (value: unknown) => void, reject: (err: unknown) => void): Promise<void> {
    try {
      resolve(this.run());
    } catch (err) {
      reject(err);
    }
  }

  run(): unknown {
    const s = this.state;
    if (s.kind === "execute") {
      const text = s.sqlText ?? "";
      if (text.includes("information_schema")) {
        let present = 0;
        for (const t of [
          "nurture_handoff_decisions",
          "sales_handoffs",
          "handoff_dispatch_receipts",
          "nurture_touch_records",
        ]) {
          if (s.availableTables.has(t)) present += 1;
        }
        return [{ c: present }];
      }
      return [];
    }

    const table = TABLE_BY_NAME[s.table ?? ""];
    if (!table) throw new Error(`harness: unknown table ${s.table}`);
    const rows = s.tables.get(table.name) ?? [];

    if (s.kind === "insert") {
      const row = { ...s.valuesRow } as Record<string, unknown>;
      if (row.id === undefined) {
        const next = (s.autoIds.get(table.name) ?? 0) + 1;
        s.autoIds.set(table.name, next);
        row.id = next;
      }
      for (const key of table.uniqueKeys) {
        if (key.some((k) => row[k] === undefined || row[k] === null)) continue;
        const clash = rows.some((existing) => key.every((k) => existing[k] === row[k]));
        if (clash) throw new DuplicateKeyError(`duplicate key on ${table.name} (${key.join(",")})`);
      }
      rows.push(row);
      return { insertId: row.id, affectedRows: 1 };
    }

    if (s.kind === "update") {
      let affected = 0;
      for (const row of rows) {
        if (s.cond !== undefined && !evalCond(s.cond, row)) continue;
        for (const [key, value] of Object.entries(s.setFields ?? {})) {
          if (key === "version" && value !== null && typeof value === "object") {
            row.version = Number(row.version ?? 0) + 1; // sql`version + 1` fragment
          } else {
            row[key] = value;
          }
        }
        affected += 1;
      }
      return { affectedRows: affected };
    }

    // select
    let out = rows.filter((row) => (s.cond === undefined ? true : evalCond(s.cond, row)));
    if (s.orderCol) {
      out = [...out].sort((a, b) => {
        const av = a[s.orderCol!];
        const bv = b[s.orderCol!];
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return s.orderDesc ? -cmp : cmp;
      });
    }
    if (s.limitN !== undefined) out = out.slice(0, s.limitN);
    return out.map((row) => projectRow(s.projection, row));
  }
}

// ─── harness ───

export interface NurtureHarnessOptions {
  /** D tables present in the information_schema probe (default: all four). */
  availableTables?: string[];
  now?: string;
  failFirstTransportAttempts?: number;
  rejectAllTransport?: boolean;
}

export interface NurtureHarness {
  executor: {
    select: (projection?: unknown) => MemChain;
    insert: () => MemChain;
    update: () => MemChain;
    execute: (fragment: unknown) => Promise<unknown>;
  };
  transport: FakeNurtureTransport & { providerId: string };
  ports: NurtureUpstreamPorts;
  /** Simulated human approval surface (the governed approval router). */
  approve: (approvalRequestId: number, actorUserId?: number) => void;
  reject: (approvalRequestId: number) => void;
  table: (name: string) => Array<Record<string, unknown>>;
  auditEvents: () => Array<Record<string, unknown>>;
  setPrivacyState: (leadId: string, state: string, updatedAt?: string) => void;
  setConversions: (leadId: string, rows: Array<Record<string, unknown>>) => void;
  setProjection: (qualificationId: string, raw: Record<string, unknown> | null) => void;
  setIdentity: (leadId: string, raw: Record<string, unknown> | null) => void;
}

export function createNurtureHarness(options: NurtureHarnessOptions = {}): NurtureHarness {
  const available = new Set(
    options.availableTables ?? [
      "nurture_handoff_decisions",
      "sales_handoffs",
      "handoff_dispatch_receipts",
      "nurture_touch_records",
    ]
  );
  const tables = new Map<string, Array<Record<string, unknown>>>();
  for (const name of Object.keys(TABLE_BY_NAME)) tables.set(name, []);
  const autoIds = new Map<string, number>();

  const executor = {
    select: (projection?: unknown) =>
      new MemChain({
        tables, autoIds, kind: "select", projection, availableTables: available,
      }),
    insert: (table: unknown) =>
      new MemChain({ tables, autoIds, kind: "insert", table: tableNameOf(table), availableTables: available }),
    update: (table: unknown) =>
      new MemChain({ tables, autoIds, kind: "update", table: tableNameOf(table), availableTables: available }),
    execute: async (fragment: unknown) => {
      const text = sqlTextOf(fragment);
      const chain = new MemChain({
        tables, autoIds, kind: "execute", sqlText: text, availableTables: available,
      });
      // mysql2 execute() resolves [rows, fields] — the store reads rows[0][0].
      const rows = chain.run() as unknown[];
      return [rows];
    },
  };

  const transport = Object.assign(
    createFakeNurtureTransport({
      now: options.now,
      failFirstAttempts: options.failFirstTransportAttempts ?? 0,
      rejectAll: options.rejectAllTransport ?? false,
    }),
    { providerId: FAKE_TEST_PROVIDER }
  );

  // ── frozen-upstream port fakes (A/C/E/F contract shapes) ──
  const projections = new Map<string, Record<string, unknown> | null>();
  const privacyStates = new Map<string, { state: string; updatedAt: string | null }>();
  const conversionsByLead = new Map<string, Array<Record<string, unknown>>>();

  const identityByLead = new Map<string, Record<string, unknown>>();

  const ports: NurtureUpstreamPorts = {
    async getQualificationProjection({ qualificationId }) {
      return projections.get(qualificationId) ?? null;
    },
    async getLeadIdentity({ leadId }) {
      return identityByLead.get(leadId) ?? null;
    },
    async getPrivacyEvidence({ leadId }) {
      const p = privacyStates.get(leadId);
      return {
        available: true,
        state: p?.state ?? "ACTIVE",
        explicit: p !== undefined,
        retentionDeadlineAt: null,
        previousState: null,
        source: p ? "governance_test" : null,
        actorUserId: null,
        updatedAt: p?.updatedAt ?? null,
      };
    },
    async listConversionsForLead({ leadId }) {
      return conversionsByLead.get(leadId) ?? [];
    },
    async getApprovalRequest({ approvalRequestId }) {
      const row = (tables.get("approval_requests") ?? []).find((r) => r.id === approvalRequestId);
      return row ?? null;
    },
  };

  return {
    executor: executor as unknown as NurtureHarness["executor"],
    transport,
    ports,
    approve(approvalRequestId) {
      const row = (tables.get("approval_requests") ?? []).find((r) => r.id === approvalRequestId);
      if (!row) throw new Error(`harness: approval ${approvalRequestId} not found`);
      row.status = "approved";
      row.approvedAt = options.now ?? new Date().toISOString();
      // Mirror the governed human surface (approval-router): approving a
      // sales_handoff approval CAS-transitions the bound handoff to APPROVED.
      const binding = (row.context as { salesHandoffBinding?: { handoffId?: string } } | null)
        ?.salesHandoffBinding;
      if (binding?.handoffId) {
        const handoffRow = (tables.get("sales_handoffs") ?? []).find((r) => r.handoffId === binding.handoffId);
        if (handoffRow && handoffRow.handoffStatus === "APPROVAL_REQUIRED") {
          handoffRow.handoffStatus = "APPROVED";
          handoffRow.version = Number(handoffRow.version) + 1;
        }
      }
    },
    reject(approvalRequestId) {
      const row = (tables.get("approval_requests") ?? []).find((r) => r.id === approvalRequestId);
      if (!row) throw new Error(`harness: approval ${approvalRequestId} not found`);
      row.status = "rejected";
      row.rejectedAt = options.now ?? new Date().toISOString();
    },
    table: (name) => tables.get(name) ?? [],
    auditEvents: () => tables.get("audit_events") ?? [],
    setPrivacyState(leadId, state, updatedAt) {
      privacyStates.set(leadId, { state, updatedAt: updatedAt ?? (options.now ?? new Date().toISOString()) });
    },
    setConversions(leadId, rows) {
      conversionsByLead.set(leadId, rows);
    },
    setProjection(qualificationId, raw) {
      projections.set(qualificationId, raw);
    },
    setIdentity(leadId, raw) {
      if (raw === null) identityByLead.delete(leadId);
      else identityByLead.set(leadId, raw);
    },
  };
}

// ─── frozen fixture builders ───

export const HEX = (c: string) => c.repeat(64);

export interface LeadFixtureIds {
  leadId: string;
  qualificationId: string;
  businessId: number;
  userId: number;
}

export function makeIdentityFixture(ids: LeadFixtureIds): Record<string, unknown> {
  return {
    leadId: ids.leadId,
    businessId: ids.businessId,
    identityStatus: "resolved",
    canonicalLeadId: null,
  };
}

export function makeQualificationFixture(
  ids: LeadFixtureIds,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    qualificationId: ids.qualificationId,
    businessId: ids.businessId,
    leadId: ids.leadId,
    decision: "QUALIFIED",
    reasonCodes: ["SCORE_BAND_HIGH"],
    scoreReference: { leadScoreId: `lsc1:${HEX("c")}`, scoringVersion: "lead-scoring/v1", scoreContentHash: HEX("d") },
    evidenceSnapshotReference: { evidenceSnapshotHash: HEX("e") },
    qualificationPolicyVersion: "lead-qualification-policy/v1",
    engineVersion: "lead-qualification/v1",
    evaluatedAt: "2026-06-27T00:00:00.000Z",
    validUntil: "2026-07-04T00:00:00.000Z",
    review: null,
    privacy: { state: "ACTIVE", actionable: true },
    mayProgress: true,
    progressBlockedReason: null,
    ...overrides,
  };
}
