// ─── R8-F Strategic Intelligence Governance — production authority bridge ───
//
// Binds a Drizzle client/transaction to the store's structural executor seam
// and resolves the authority provider seams against the canonical tables.
//
// Guarded degradation: table availability is probed once per provider
// instance through information_schema and memoized. A read against an absent
// R8-F schema fails closed with ProviderAuthorityUnavailable (the canonical
// 0036 migration is provisional — NOT executed; see
// docs/recovery/r8-f-unexecuted-migrations.md; R8-X owns sequencing).
//
// The provider is tenant-anchored: authority queries predicate the
// authenticated tenant — business ownership is verified by BOTH id and owning
// user. Strategic evidence stores belong to sibling R8 streams (market
// intelligence, strategic memory); until R8-X binds a canonical evidence
// authority, evidence resolution fails closed (EVIDENCE_AUTHORITY_UNAVAILABLE)
// rather than guessing. The trusted-source registry is likewise empty until
// R8-X provides one — so no external source is implicitly trusted (F3).

import { and, eq as drizzleEq, sql, type SQL } from "drizzle-orm";
import { businesses } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  ProviderAuthorityUnavailable,
  type StrategicGovernanceAuthorityProvider,
} from "./strategic-governance-service";
import type {
  StrategicGovernanceRowQuery,
  StrategicGovernanceSelectTarget,
  StrategicGovernanceStoreExecutor,
  StrategicGovernanceTableHandle,
  StoreOrderTerm,
  StorePredicate,
} from "./strategic-governance-store";

const AUTHORITY_TABLES = ["strategic_governance_decisions"] as const;

/**
 * Structural db seam: the default getDb() client and a Drizzle transaction
 * client both satisfy it; the test fake binds a scripted in-memory client.
 * Loosely typed so both dialects fit — every use is internal and translated.
 */
export interface StrategicGovernanceBridgeDb {
  readonly select: (...args: never[]) => any;
  readonly execute: (query: SQL) => Promise<unknown>;
}

class StrategicGovernanceBridgeProvider implements StrategicGovernanceAuthorityProvider {
  private availability: Promise<ReadonlySet<string>> | null = null;
  private readonly db: StrategicGovernanceBridgeDb;
  private readonly userId: number;

  constructor(db: StrategicGovernanceBridgeDb, userId: number) {
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
        "strategic governance",
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

  async resolveEvidence(): Promise<unknown> {
    // Strategic evidence stores (market signals, strategic memory, business
    // change records) are owned by sibling R8 streams. R8-F consumes them
    // only through this seam; until R8-X binds a canonical, tenant-scoped
    // evidence authority, resolution fails closed rather than fabricating
    // evidence truth (charter F3; EVIDENCE_AUTHORITY_UNAVAILABLE).
    throw new ProviderAuthorityUnavailable(
      "strategic evidence",
      "no canonical strategic evidence authority bound at R8-F; R8-X convergence wires the evidence stores"
    );
  }

  async getTrustedSourceKeys(): Promise<readonly string[]> {
    // The registered/trusted external-source registry is a server-side
    // authority provided at R8-X. Until then it is empty: no external source
    // is implicitly trusted, so external evidence derives at best
    // SINGLE_EXTERNAL_SOURCE / UNVERIFIED (F3).
    return [];
  }

  async getApprovalStatusByDecisionId(): Promise<
    Readonly<Map<string, { status: "pending" | "approved" | "rejected" } | null>>
  > {
    // The approval ledger is keyed by approval row, not decision id; a lookup
    // index over context JSON is added with the R8-X convergence. Until then
    // the projection reports approval status as unknown.
    return new Map();
  }

  async assertGovernanceTableAvailable(): Promise<void> {
    await this.assertAvailable();
  }
}

/**
 * Production provider: tenant-anchored by the authenticated user id. The
 * governance decisions table presence is enforced only for decision
 * persistence/reads — business authority derives from the canonical
 * pre-existing businesses table; evidence resolution fails closed until R8-X
 * binds the evidence stores.
 */
export function createStrategicGovernanceBridgeProvider(
  db: StrategicGovernanceBridgeDb = getDb(),
  userId: number
): StrategicGovernanceBridgeProvider {
  return new StrategicGovernanceBridgeProvider(db, userId);
}

// ─── Store executor binding ───

function columnOf(table: unknown, field: string): any {
  const column = (table as Record<string, unknown>)[field];
  if (column === undefined || column === null) {
    throw new Error(`strategic governance bridge: unknown column ${field} on table handle`);
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
export function bindStrategicGovernanceStoreExecutor(
  client: unknown
): StrategicGovernanceStoreExecutor {
  const db = client as {
    select: () => { from: (table: unknown) => any };
    insert: (table: unknown) => { values: (row: Record<string, unknown>) => unknown };
  };

  const adapt = (table: unknown, query: any): StrategicGovernanceRowQuery => ({
    all: async () => await query,
    limit: async (n: number) => await query.limit(n),
    orderBy: (...terms: StoreOrderTerm[]) =>
      adapt(table, query.orderBy(...terms.map((term) => toSqlOrder(table, term)))),
  });

  return {
    select: () => ({
      from: (table: StrategicGovernanceTableHandle): StrategicGovernanceSelectTarget => {
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
    insert: (table: StrategicGovernanceTableHandle) => ({
      values: async (row: Record<string, unknown>) => await db.insert(table).values(row),
    }),
  };
}
