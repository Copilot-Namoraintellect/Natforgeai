// ─── R9-F Mission Governance & Approval — production authority bridge ───
//
// Binds a Drizzle client/transaction to the store's structural executor seam
// and resolves the authority provider seams against the canonical tables.
//
// Guarded degradation: table availability is probed once per provider
// instance through information_schema and memoized. A read against an absent
// R9-F schema fails closed with ProviderAuthorityUnavailable (the canonical
// 0037 migration is provisional — NOT executed; see
// docs/recovery/r9-f-unexecuted-migrations.md; R9-X owns sequencing).
//
// The provider is tenant-anchored: authority queries predicate the
// authenticated tenant — business ownership is verified by BOTH id and
// owning user. Approval status reads the shared approval ledger read-only
// (approvalType 'mission_action'); the ledger remains the approval
// authority. Mission/plan/task stores belong to sibling R9 streams; R9-F
// binds them as opaque pattern-checked references (no upstream mutation).

import { and, eq as drizzleEq, sql, type SQL } from "drizzle-orm";
import { businesses } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  ProviderAuthorityUnavailable,
  type MissionGovernanceAuthorityProvider,
} from "./mission-governance-service";
import type {
  MissionGovernanceRowQuery,
  MissionGovernanceSelectTarget,
  MissionGovernanceStoreExecutor,
  MissionGovernanceTableHandle,
  StoreOrderTerm,
  StorePredicate,
} from "./mission-governance-store";

const AUTHORITY_TABLES = ["mission_governance_decisions"] as const;

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

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

/**
 * Structural db seam: the default getDb() client and a Drizzle transaction
 * client both satisfy it; the test fake binds a scripted in-memory client.
 * Loosely typed so both dialects fit — every use is internal and translated.
 */
export interface MissionGovernanceBridgeDb {
  readonly select: (...args: never[]) => any;
  readonly execute: (query: SQL) => Promise<unknown>;
}

class MissionGovernanceBridgeProvider implements MissionGovernanceAuthorityProvider {
  private availability: Promise<ReadonlySet<string>> | null = null;
  private readonly db: MissionGovernanceBridgeDb;
  private readonly userId: number;

  constructor(db: MissionGovernanceBridgeDb, userId: number) {
    this.db = db;
    this.userId = userId;
  }

  private availableTables(): Promise<ReadonlySet<string>> {
    if (!this.availability) {
      this.availability = this.probeTables().catch((err) => {
        this.availability = null;
        throw err;
      });
    }
    return this.availability;
  }

  private async probeTables(): Promise<ReadonlySet<string>> {
    const rows = (await this.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name IN (${sql.join(
        AUTHORITY_TABLES.map((t) => sql`${t}`),
        sql`, `
      )})
    `)) as { rows?: Array<{ table_name: string }> } | Array<{ table_name: string }>;
    const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
    return new Set(list.map((r) => r.table_name));
  }

  private async assertAvailable(): Promise<void> {
    const available = await this.availableTables();
    const missing = AUTHORITY_TABLES.filter((t) => !available.has(t));
    if (missing.length > 0) {
      throw new ProviderAuthorityUnavailable(
        "mission governance",
        `tables missing: ${missing.join(", ")}`
      );
    }
  }

  async getBusinessAuthority(businessId: number): Promise<unknown> {
    const [row] = await this.db
      .select()
      .from(businesses)
      .where(and(drizzleEq(businesses.id, businessId), drizzleEq(businesses.userId, this.userId)))
      .limit(1);
    if (!row) return null;
    return {
      businessId: row.id,
      owningUserId: row.userId,
      businessActive: row.isActive !== false,
    };
  }

  /**
   * Approval-ledger read view for the operations projection. Reads the shared
   * approval_requests ledger (approvalType 'mission_action') and folds
   * per-decision status with conservative precedence: rejected wins over
   * approved/edited wins over pending. The ledger remains the approval
   * authority — this is a read view only.
   */
  async getApprovalStatusByDecisionId(
    userId: number,
    governanceDecisionIds: readonly string[]
  ): Promise<Readonly<Map<string, { status: "pending" | "approved" | "rejected" } | null>>> {
    const wanted = new Set(governanceDecisionIds);
    const out = new Map<string, { status: "pending" | "approved" | "rejected" } | null>();
    if (wanted.size === 0) return out;
    const rows = normalizeSqlRows(
      await this.db.execute(sql`
        SELECT status, context FROM approval_requests
        WHERE userId = ${userId} AND approvalType = 'mission_action'
      `)
    );
    const rank = { pending: 0, approved: 1, rejected: 2 } as const;
    for (const row of rows) {
      const context = parseJsonObject(row.context);
      const binding = context && parseJsonObject(context.missionGovernanceBinding);
      const decisionId =
        binding && typeof binding.governanceDecisionId === "string"
          ? binding.governanceDecisionId
          : null;
      if (!decisionId || !wanted.has(decisionId)) continue;
      const rawStatus = String(row.status ?? "pending");
      const status: "pending" | "approved" | "rejected" =
        rawStatus === "rejected"
          ? "rejected"
          : rawStatus === "approved" || rawStatus === "edited"
            ? "approved"
            : "pending";
      const existing = out.get(decisionId);
      if (!existing || rank[status] > rank[existing.status]) out.set(decisionId, { status });
    }
    for (const id of wanted) if (!out.has(id)) out.set(id, null);
    return out;
  }

  async assertGovernanceTableAvailable(): Promise<void> {
    await this.assertAvailable();
  }
}

/**
 * Production provider: tenant-anchored by the authenticated user id. The
 * governance decisions table presence is enforced only for decision
 * persistence/reads — business authority derives from the canonical
 * pre-existing businesses table.
 */
export function createMissionGovernanceBridgeProvider(
  db: MissionGovernanceBridgeDb = getDb(),
  userId: number
): MissionGovernanceBridgeProvider {
  return new MissionGovernanceBridgeProvider(db, userId);
}

// ─── Store executor binding ───

function columnOf(table: unknown, field: string): any {
  const column = (table as Record<string, unknown>)[field];
  if (column === undefined || column === null) {
    throw new Error(`mission governance bridge: unknown column ${field} on table handle`);
  }
  return column;
}

const asc = (column: unknown): SQL => sql`${column as never} asc`;
const desc = (column: unknown): SQL => sql`${column as never} desc`;

function toSqlPredicate(table: unknown, predicate: StorePredicate): SQL {
  if (!isStorePredicate(predicate)) {
    return predicate as unknown as SQL;
  }
  if (predicate.kind === "eq") {
    return drizzleEq(columnOf(table, predicate.field), predicate.value);
  }
  return and(...predicate.conditions.map((condition) => toSqlPredicate(table, condition))) as SQL;
}

function isStorePredicate(value: unknown): value is StorePredicate {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    ((value as { kind: unknown }).kind === "eq" || (value as { kind: unknown }).kind === "and")
  );
}

function toSqlOrder(table: unknown, term: StoreOrderTerm): SQL {
  const column = columnOf(table, term.field);
  return term.direction === "asc" ? asc(column) : desc(column);
}

/**
 * Binds a Drizzle-shaped client (real client, transaction callback, or the
 * in-memory fake) to the store's structural executor seam.
 */
export function bindMissionGovernanceStoreExecutor(
  client: unknown
): MissionGovernanceStoreExecutor {
  const db = client as {
    select: () => { from: (table: unknown) => any };
    insert: (table: unknown) => { values: (row: Record<string, unknown>) => unknown };
  };

  const adapt = (table: unknown, query: any): MissionGovernanceRowQuery => ({
    all: async () => await query,
    limit: async (n: number) => await query.limit(n),
    orderBy: (...terms: StoreOrderTerm[]) =>
      adapt(table, query.orderBy(...terms.map((term) => toSqlOrder(table, term)))),
  });

  return {
    select: () => ({
      from: (table: MissionGovernanceTableHandle): MissionGovernanceSelectTarget => {
        const target = db.select().from(table);
        return {
          where: (predicate: StorePredicate) =>
            adapt(table, target.where(toSqlPredicate(table, predicate))),
          orderBy: (...terms: StoreOrderTerm[]) =>
            adapt(table, target.orderBy(...terms.map((term) => toSqlOrder(table, term)))),
          all: async () => await target,
          limit: async (n: number) => await target.limit(n),
        };
      },
    }),
    insert: (table: MissionGovernanceTableHandle) => ({
      values: async (row: Record<string, unknown>) => await db.insert(table).values(row),
    }),
  };
}
