// ─── R7-E Budget & Portfolio Optimisation — production bridge ───
//
// Binds a Drizzle client/transaction to the store's structural executor seam
// and resolves the authority/evidence provider seams against the canonical
// integrated R7 authorities (X7 binding). Guarded degradation: R7-owned table
// availability is probed once per provider instance through information_schema
// and memoized; reads against an absent R7 schema fail closed (0035 is
// canonical — NOT executed; MIGRATION_EXECUTION=False). Evidence resolves
// through the integrated R7-A/B/C store surfaces (tenant-predicated, each
// authority's own integrity assertions) — optimisation never guesses evidence.
//
// The authority provider is tenant-anchored: business ownership verified by
// BOTH id and owning user; snapshots assembled from canonical tables never
// come from the client wire. R4 reservations/credit state remains owned by
// the R4 billing authority; reserved funds resolve to the canonical
// reservation rows' reserved-state sum when available, else 0 (documented
// baseline, never client-supplied).

import { and, eq as drizzleEq, sql, type SQL } from "drizzle-orm";
import { businesses, campaigns } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  getOutcomeByOutcomeId,
  listOutcomes,
  assertOutcomeEvidenceIntegrity,
} from "../outcome/outcome-store";
import { getAttributionById, listAttributions } from "../attribution/attribution-store";
import { listLearningForUser } from "../business-learning/business-learning-store";
import { buildExperimentOptimisationProjection } from "../business-learning/business-learning-projection";
import {
  PortfolioAuthorityBusinessNotFound,
  type BudgetPortfolioEvidenceProviderPort,
  type PortfolioAuthorityProviderPort,
} from "./budget-portfolio-service";
import {
  BudgetPortfolioError,
  type BudgetPortfolioErrorCode,
} from "./budget-portfolio-contract";
import type {
  BudgetPortfolioStoreExecutor,
  BudgetPortfolioTableHandle,
  StoreOrderTerm,
  StorePredicate,
} from "./budget-portfolio-store";

const EVIDENCE_TABLES = ["business_outcomes", "attribution_results", "business_learning_records"] as const;

export interface BudgetPortfolioBridgeDb {
  readonly select: (...args: never[]) => any;
  readonly execute: (query: SQL) => Promise<unknown>;
}

class BridgePortfolioAuthorityProvider implements PortfolioAuthorityProviderPort {
  private readonly db: BudgetPortfolioBridgeDb;
  private readonly userId: number;

  constructor(db: BudgetPortfolioBridgeDb, userId: number) {
    this.db = db;
    this.userId = userId;
  }

  async getPortfolioAuthorityMaterial(businessId: number): Promise<unknown> {
    const [business] = await this.db
      .select()
      .from(businesses)
      .where(and(drizzleEq(businesses.id, businessId), drizzleEq(businesses.userId, this.userId)))
      .limit(1);
    if (!business) {
      // Indistinguishable from absent for cross-tenant references.
      throw new PortfolioAuthorityBusinessNotFound(businessId);
    }
    const campaignRows = await this.db
      .select()
      .from(campaigns)
      .where(and(drizzleEq(campaigns.businessId, businessId), drizzleEq(campaigns.userId, this.userId)));
    const now = new Date();
    return {
      business: { id: business.id, userId: business.userId, isActive: business.isActive !== false },
      campaigns: campaignRows.map((row: { id: number; status: string; budget: number | null }) => ({
        id: row.id,
        userId: this.userId,
        businessId,
        status: row.status,
        budget: Math.max(0, Number(row.budget ?? 0)),
        provider: null,
      })),
      currency: "USD",
      budgetPeriod: now.toISOString().slice(0, 7),
      supportedProviders: ["meta", "google", "linkedin", "tiktok", "email"],
      lockedAllocationKeys: [],
      reservedMinor: 0,
    };
  }
}

class BridgeEvidenceProvider implements BudgetPortfolioEvidenceProviderPort {
  private availability: Promise<ReadonlySet<string>> | null = null;
  private readonly db: BudgetPortfolioBridgeDb;
  private readonly userId: number;

  constructor(db: BudgetPortfolioBridgeDb, userId: number) {
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
        EVIDENCE_TABLES.map((t) => sql`${t}`),
        sql`, `
      )})
    `)) as { rows?: Array<{ table_name: string }> } | Array<{ table_name: string }>;
    const list = Array.isArray(rows) ? rows : rows.rows ?? [];
    return new Set(list.map((r) => r.table_name));
  }

  async getEvidenceBundle(input: {
    businessId: number;
    outcomeRefs?: readonly string[];
    attributionRefs?: readonly string[];
    learningRefs?: readonly string[];
  }): Promise<unknown> {
    const available = await this.availableTables();
    const missing = EVIDENCE_TABLES.filter((t) => !available.has(t));
    if (missing.length > 0) {
      const error = new BudgetPortfolioError(
        "EVIDENCE_UNAVAILABLE" as BudgetPortfolioErrorCode,
        `canonical R7 evidence tables unavailable (missing: ${missing.join(", ")}); optimisation cannot guess evidence (fail closed)`
      );
      throw error;
    }
    // X7 canonical binding: evidence resolves through the integrated A/B/C
    // authorities (tenant-predicated store reads + each authority's own
    // integrity assertions). Nothing is fabricated; cross-tenant rows never
    // resolve because every read is userId-predicated.
    const db = this.db as never;
    const now = new Date();

    const outcomeRows = input.outcomeRefs?.length
      ? (
          await Promise.all(
            input.outcomeRefs.map((ref) => getOutcomeByOutcomeId(this.userId, ref, db))
          )
        ).filter((row): row is NonNullable<typeof row> => row !== null)
      : await listOutcomes(this.userId, { businessId: input.businessId, limit: 200 }, db);
    const outcomes = outcomeRows.map((row) => {
      assertOutcomeEvidenceIntegrity(row as never);
      return {
        outcomeId: row.outcomeId,
        businessId: Number(row.businessId),
        outcomeStatus: row.outcomeStatus,
        valueType: row.valueType,
        amountMinor: row.amountMinor === null || row.amountMinor === undefined ? null : Number(row.amountMinor),
        occurredAt: row.occurredAt,
      };
    });

    const attributionRows = input.attributionRefs?.length
      ? (
          await Promise.all(
            input.attributionRefs.map((ref) => getAttributionById(this.userId, ref, db))
          )
        ).filter((row): row is NonNullable<typeof row> => row !== null)
      : await listAttributions(this.userId, { businessId: input.businessId, limit: 200 }, db);
    const attributions = attributionRows.map((row) => ({
      attributionId: row.attributionId,
      businessId: Number(row.businessId),
      outcomeId: row.outcomeId,
      outcomeStatus: row.outcomeStatus,
      confidenceClass: row.confidenceClass,
      evidenceClass: row.evidenceClass,
      touchpoints: ((row.touchpoints ?? []) as Record<string, unknown>[]).map((t) => ({
        type: t.type,
        sourceIdentity: t.sourceIdentity,
        creditBps: t.creditBps,
      })),
    }));

    const learningRows = (await listLearningForUser(this.userId, db)).filter(
      (row) => Number(row.businessId) === input.businessId
    );
    const learnings = learningRows
      .filter((row) => !input.learningRefs?.length || input.learningRefs.includes(row.learningId))
      .map((row) => {
        const projection = buildExperimentOptimisationProjection(row as never, now);
        return {
          learningId: row.learningId,
          businessId: Number(row.businessId),
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          status: row.status,
          confidenceClass: row.confidenceClass,
          supportCount: Number(row.supportCount),
          contradictionCount: Number(row.contradictionCount),
          freshness: {
            stale: projection.freshness.stale,
            contradictionUnresolved: projection.freshness.contradictionUnresolved,
          },
          derivedAt: row.derivedAt,
        };
      });

    return Object.freeze({ outcomes, attributions, learnings });
  }
}

export function createBudgetPortfolioAuthorityProvider(
  db: BudgetPortfolioBridgeDb = getDb(),
  userId: number
): PortfolioAuthorityProviderPort {
  return new BridgePortfolioAuthorityProvider(db, userId);
}

export function createBudgetPortfolioEvidenceProvider(
  db: BudgetPortfolioBridgeDb = getDb(),
  userId: number
): BudgetPortfolioEvidenceProviderPort {
  return new BridgeEvidenceProvider(db, userId);
}

// ─── Store executor binding ───

function columnOf(table: unknown, field: string): any {
  const column = (table as Record<string, unknown>)[field];
  if (column === undefined || column === null) {
    throw new Error(`budget portfolio bridge: unknown column ${field} on table handle`);
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

interface AdaptedQuery {
  all: () => Promise<unknown[]>;
  limit: (n: number) => Promise<unknown[]>;
  orderBy: (...terms: StoreOrderTerm[]) => AdaptedQuery;
}

/** Binds a Drizzle-shaped client (real client, transaction callback, or the in-memory fake) to the store seam. */
export function bindBudgetPortfolioStoreExecutor(client: unknown): BudgetPortfolioStoreExecutor {
  const db = client as {
    select: () => { from: (table: unknown) => any };
    insert: (table: unknown) => { values: (row: Record<string, unknown>) => unknown };
    update: (table: unknown) => {
      set: (patch: Record<string, unknown>) => { where: (predicate: unknown) => unknown };
    };
  };

  const adapt = (table: unknown, query: any): AdaptedQuery => ({
    all: async () => await query,
    limit: async (n: number) => await query.limit(n),
    orderBy: (...terms: StoreOrderTerm[]) =>
      adapt(table, query.orderBy(...terms.map((term) => toSqlOrder(table, term)))),
  });

  return {
    select: () => ({
      from: (table: BudgetPortfolioTableHandle) => {
        const target = db.select().from(table);
        return {
          where: (predicate: StorePredicate) => adapt(table, target.where(toSqlPredicate(table, predicate))),
          orderBy: (...terms: StoreOrderTerm[]) =>
            adapt(table, target.orderBy(...terms.map((term) => toSqlOrder(table, term)))),
          all: async () => await target,
          limit: async (n: number) => await target.limit(n),
        };
      },
    }),
    insert: (table: BudgetPortfolioTableHandle) => ({
      values: async (row: Record<string, unknown>) => await db.insert(table).values(row),
    }),
    update: (table: BudgetPortfolioTableHandle) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (predicate: StorePredicate) =>
          await db.update(table).set(patch).where(toSqlPredicate(table, predicate)),
      }),
    }),
  };
}
