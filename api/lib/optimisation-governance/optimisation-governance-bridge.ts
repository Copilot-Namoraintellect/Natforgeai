// ─── R7-F Optimisation Governance — production authority bridge ───
//
// Binds a Drizzle client/transaction to the store's structural executor seam
// and resolves the authority provider seams against the canonical tables.
//
// Guarded degradation: table availability is probed once per provider
// instance through information_schema and memoized. A read against an absent
// R7-F schema fails closed with ProviderAuthorityUnavailable (the canonical
// 0035 migration is provisional — NOT executed; see
// docs/recovery/r7-f-unexecuted-migrations.md; R7-X owns sequencing).
//
// The provider is tenant-anchored: authority queries predicate the
// authenticated tenant — business ownership is verified by BOTH id and
// owning user; snapshots assembled from canonical tables never come from the
// client wire.

import { and, eq as drizzleEq, sql, type SQL } from "drizzle-orm";
import { businesses, campaigns } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  ProviderAuthorityUnavailable,
  type OptimisationGovernanceAuthorityProvider,
} from "./optimisation-governance-service";
import type {
  OptimisationGovernanceRowQuery,
  OptimisationGovernanceSelectTarget,
  OptimisationGovernanceStoreExecutor,
  OptimisationGovernanceTableHandle,
  StoreOrderTerm,
  StorePredicate,
} from "./optimisation-governance-store";

const AUTHORITY_TABLES = ["optimisation_governance_decisions"] as const;

/**
 * Structural db seam: the default getDb() client and a Drizzle transaction
 * client both satisfy it; the test fake binds a scripted in-memory client.
 * Loosely typed so both dialects fit — every use is internal and translated.
 */
export interface OptimisationGovernanceBridgeDb {
  readonly select: (...args: never[]) => any;
  readonly execute: (query: SQL) => Promise<unknown>;
}

class OptimisationGovernanceBridgeProvider implements OptimisationGovernanceAuthorityProvider {
  private availability: Promise<ReadonlySet<string>> | null = null;
  private readonly db: OptimisationGovernanceBridgeDb;
  private readonly userId: number;

  constructor(db: OptimisationGovernanceBridgeDb, userId: number) {
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
      throw new ProviderAuthorityUnavailable("optimisation governance", `tables missing: ${missing.join(", ")}`);
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

  async getBudgetAuthority(businessId: number): Promise<unknown> {
    // Financial truth is assembled server-side from the canonical campaigns
    // budget columns for this tenant's business. Reservations and wallet
    // state remain owned by the R4 billing authority; until R7-E lands a
    // dedicated budget-envelope table, reserved/locked sets resolve empty
    // and the snapshot is explicitly marked with its capture time.
    const rows = await this.db
      .select()
      .from(campaigns)
      .where(and(drizzleEq(campaigns.businessId, businessId), drizzleEq(campaigns.userId, this.userId)));
    const committedMinor = rows.reduce(
      (sum: number, r: { budget?: number | null }) => sum + Math.max(0, Number(r.budget ?? 0) * 100),
      0
    );
    const now = new Date();
    const budgetPeriod = now.toISOString().slice(0, 7);
    return {
      budgetPeriod,
      currency: "USD",
      // Approved total is the business's campaign envelope; R7-X may replace
      // this derivation with a dedicated budget-authority table. Until then
      // the approved total equals the committed envelope (no autonomous headroom).
      approvedTotalBudgetMinor: committedMinor,
      committedMinor,
      reservedMinor: 0,
      supportedProviders: ["meta", "google", "linkedin", "tiktok", "email"],
      lockedAllocationKeys: [],
      stateCapturedAt: now.toISOString(),
    };
  }

  async getPortfolioAuthority(businessId: number): Promise<unknown> {
    const rows = await this.db
      .select()
      .from(campaigns)
      .where(and(drizzleEq(campaigns.businessId, businessId), drizzleEq(campaigns.userId, this.userId)));
    const currentAllocations: Record<string, number> = {};
    for (const r of rows as Array<{ id: number; budget?: number | null }>) {
      currentAllocations[`camp:${r.id}`] = Math.max(0, Number(r.budget ?? 0) * 100);
    }
    return { currentAllocations, lastReallocationAtByKey: {} };
  }

  async getExperimentAuthority(_businessId: number): Promise<unknown> {
    // No experiment ledger exists until R7-D lands; zero active experiments
    // is the truthful server-side value for the pre-R7-D baseline.
    return { activeExperiments: 0 };
  }

  async getApprovalStatusByDecisionId(): Promise<Readonly<Map<string, { status: "pending" | "approved" | "rejected" } | null>>> {
    // The approval ledger is keyed by approval row, not decision id; a
    // lookup index over context JSON is added with the R7-X convergence.
    // Until then the projection reports approval status as unknown.
    return new Map();
  }

  async assertGovernanceTableAvailable(): Promise<void> {
    await this.assertAvailable();
  }
}

/**
 * Production provider: tenant-anchored by the authenticated user id. The
 * governance decisions table presence is enforced only for decision
 * persistence/reads — authority snapshots derive from canonical pre-existing
 * tables so evaluation degrades gracefully while 0035 is unexecuted.
 */
export function createOptimisationGovernanceBridgeProvider(
  db: OptimisationGovernanceBridgeDb = getDb(),
  userId: number
): OptimisationGovernanceBridgeProvider {
  return new OptimisationGovernanceBridgeProvider(db, userId);
}

// ─── Store executor binding ───

function columnOf(table: unknown, field: string): any {
  const column = (table as Record<string, unknown>)[field];
  if (column === undefined || column === null) {
    throw new Error(`optimisation governance bridge: unknown column ${field} on table handle`);
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
export function bindOptimisationGovernanceStoreExecutor(
  client: unknown
): OptimisationGovernanceStoreExecutor {
  const db = client as {
    select: () => { from: (table: unknown) => any };
    insert: (table: unknown) => { values: (row: Record<string, unknown>) => unknown };
  };

  const adapt = (table: unknown, query: any): OptimisationGovernanceRowQuery => ({
    all: async () => await query,
    limit: async (n: number) => await query.limit(n),
    orderBy: (...terms: StoreOrderTerm[]) =>
      adapt(table, query.orderBy(...terms.map((term) => toSqlOrder(table, term)))),
  });

  return {
    select: () => ({
      from: (table: OptimisationGovernanceTableHandle): OptimisationGovernanceSelectTarget => {
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
    insert: (table: OptimisationGovernanceTableHandle) => ({
      values: async (row: Record<string, unknown>) => await db.insert(table).values(row),
    }),
  };
}
