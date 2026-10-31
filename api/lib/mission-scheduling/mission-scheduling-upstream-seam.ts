// ─── R9-C Dependency & Scheduling Intelligence — R9-A mission authority seam ───
//
// Consumes R9-A mission authority READ-ONLY, behind a guarded
// information-schema check (house seam pattern — R8-D's
// strategic-reasoning-evidence-seam is the model). The upstream
// `mission_proposals` table is provisional on the frozen R9-A branch
// (273ce40); R9-X owns canonical binding. Every row is re-validated at
// consumption: identity pattern, closed mission status vocabulary, ISO
// timestamps, tenant + business ownership. This seam never writes any
// upstream table, never re-derives mission status, never widens scope.
//
// Absent authority (table missing) fails closed:
// MISSION_SCHEDULING_AUTHORITY_UNAVAILABLE — scheduling never fabricates
// mission state.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  MISSION_ID_PATTERN,
  MissionSchedulingError,
  isIsoUtc,
} from "./mission-scheduling-contract";

/** Frozen R9-A closed mission statuses (mission-authority/v1 @ 273ce40). */
const MISSION_STATUSES = new Set([
  "PROPOSED",
  "ELIGIBLE_FOR_PLANNING",
  "REVIEW_REQUIRED",
  "BLOCKED",
  "SUPERSEDED",
  "STALE",
  "CANCELLED",
  "INVALIDATED",
]);

export interface MissionAuthorityView {
  readonly missionId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly missionType: string;
  readonly status: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly strategicRiskClass: string;
  readonly version: number;
}

export interface MissionScopeView {
  readonly userId: number;
  readonly businessId: number;
}

export interface MissionSchedulingUpstreamAuthority {
  /** Tenant-predicated resolve; null = unknown to this tenant. */
  resolveMission(userId: number, missionId: string): Promise<MissionAuthorityView | null>;
  /**
   * Unscoped existence probe used ONLY to classify cross-tenant declarations
   * (the row itself is never returned to the caller). Unknown vs cross-tenant
   * stays distinguishable for fail-closed error taxonomy without leaking data.
   */
  resolveMissionGlobal(missionId: string): Promise<MissionScopeView | null>;
}

// ─── Shared row shaper (identical semantics in production + in-memory) ───

function toIso(value: unknown): string {
  const text = String(value ?? "");
  return isIsoUtc(text) ? text : "";
}

export function shapeMissionRow(row: Record<string, unknown>): MissionAuthorityView {
  const missionId = String(row.missionId ?? "");
  if (!MISSION_ID_PATTERN.test(missionId)) {
    throw new MissionSchedulingError("SCHEDULING_INPUT_MALFORMED", "mission row has malformed missionId.");
  }
  const status = String(row.status ?? "");
  if (!MISSION_STATUSES.has(status)) {
    throw new MissionSchedulingError("SCHEDULING_INPUT_MALFORMED", `mission ${missionId} has unknown status ${status}.`);
  }
  const validFrom = toIso(row.validFrom);
  const validUntil = toIso(row.validUntil);
  if (!validFrom || !validUntil) {
    throw new MissionSchedulingError("SCHEDULING_INPUT_MALFORMED", `mission ${missionId} has malformed validity.`);
  }
  return {
    missionId,
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    missionType: String(row.missionType ?? ""),
    status,
    validFrom,
    validUntil,
    strategicRiskClass: String(row.strategicRiskClass ?? ""),
    version: Number(row.version ?? 1),
  };
}

// ─── Production port: raw SQL behind a guarded information-schema check ───

type SqlExecutor = { execute: ReturnType<typeof getDb>["execute"] };

function normalizeSqlRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    const first = result[0];
    if (Array.isArray(first)) return first as Array<Record<string, unknown>>;
    if (first && typeof first === "object") return [first as Record<string, unknown>];
    return [];
  }
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

async function upstreamTableExists(db: SqlExecutor, table: string): Promise<boolean> {
  try {
    const rows = normalizeSqlRows(
      await db.execute(sql`
        SELECT COUNT(*) AS c FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}
      `)
    );
    const first = rows[0];
    const count = first ? Number(first.c ?? 0) : 0;
    return Number.isInteger(count) && count > 0;
  } catch {
    return false;
  }
}

export class MissionAuthorityUnavailable extends MissionSchedulingError {
  constructor() {
    super(
      "MISSION_SCHEDULING_AUTHORITY_UNAVAILABLE",
      "mission authority tables are unavailable; scheduling cannot verify mission ownership and fails closed."
    );
    this.name = "MissionAuthorityUnavailable";
  }
}

/** Injected production port. Never writes. Absent authority ⇒ throws. */
export function createMissionUpstreamAuthority(
  executor?: SqlExecutor
): MissionSchedulingUpstreamAuthority {
  const db = executor ?? getDb();
  return {
    async resolveMission(userId, missionId) {
      if (!MISSION_ID_PATTERN.test(missionId)) return null;
      if (!(await upstreamTableExists(db, "mission_proposals"))) throw new MissionAuthorityUnavailable();
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT missionId, userId, businessId, missionType, status, validFrom, validUntil,
                 strategicRiskClass, version
          FROM mission_proposals
          WHERE userId = ${userId} AND missionId = ${missionId}
          LIMIT 1
        `)
      );
      const row = rows[0];
      if (!row) return null;
      const view = shapeMissionRow(row);
      if (view.userId !== userId) return null;
      return view;
    },
    async resolveMissionGlobal(missionId) {
      if (!MISSION_ID_PATTERN.test(missionId)) return null;
      if (!(await upstreamTableExists(db, "mission_proposals"))) throw new MissionAuthorityUnavailable();
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT userId, businessId FROM mission_proposals WHERE missionId = ${missionId} LIMIT 1
        `)
      );
      const row = rows[0];
      if (!row) return null;
      return { userId: Number(row.userId), businessId: Number(row.businessId) };
    },
  };
}

// ─── In-memory port over planted raw rows (identical validation) ───

export interface FakeMissionRow {
  readonly row: Record<string, unknown>;
}

export function createInMemoryMissionUpstreamAuthority(
  rows: readonly FakeMissionRow[]
): MissionSchedulingUpstreamAuthority {
  return {
    async resolveMission(userId, missionId) {
      if (!MISSION_ID_PATTERN.test(missionId)) return null;
      const hit = rows.find((r) => r.row.missionId === missionId);
      if (!hit) return null;
      const view = shapeMissionRow(hit.row);
      return view.userId === userId ? view : null;
    },
    async resolveMissionGlobal(missionId) {
      if (!MISSION_ID_PATTERN.test(missionId)) return null;
      const hit = rows.find((r) => r.row.missionId === missionId);
      if (!hit) return null;
      return { userId: Number(hit.row.userId), businessId: Number(hit.row.businessId) };
    },
  };
}
