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
// user. R8-X convergence binds the strategic evidence authority: mem1:/chg1:/
// xsig1: references resolve read-only against the canonical R8-A/B/C stores
// (tenant-predicated, never cross-tenant — an unresolvable reference returns
// null and F's trust derivation classifies it MALFORMED/CROSS_TENANT, failing
// the evaluation closed). The trusted-source registry reads the R8-C server
// registry (OFFICIAL/VERIFIED classes only — a source can never mark itself
// trusted). Approval status reads the shared approval ledger read-only.

import { and, eq as drizzleEq, inArray, sql, type SQL } from "drizzle-orm";
import { businesses, externalSources } from "@db/schema";
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

/** Canonical evidence stores bound at R8-X convergence (read-only). */
function parseJsonArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

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

  private evidenceTablePresence = new Map<string, Promise<boolean>>();

  /** Per-evidence-table existence probe (memoized). Absent ⇒ resolution returns null (fail closed). */
  private evidenceTablePresent(table: string): Promise<boolean> {
    let probe = this.evidenceTablePresence.get(table);
    if (!probe) {
      probe = (async () => {
        try {
          const rows = normalizeSqlRows(
            await this.db.execute(sql`
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
      })();
      this.evidenceTablePresence.set(table, probe);
    }
    return probe;
  }

  /**
   * Canonical R8-X evidence resolution. Prefix dispatch over the frozen R8
   * identity vocabularies; every read is tenant-predicated and read-only.
   * Unknown prefixes and absent rows resolve null — F's trust derivation then
   * classifies MALFORMED/CROSS_TENANT and the evaluation fails closed.
   *
   * Conservative mapping (documented, deterministic):
   *   mem1:  FACT → INTERNAL_AUTHORITATIVE; ASSUMPTION → MODEL_GENERATED
   *          (assumptions are never source truth; they can never mint
   *          AUTHORITATIVE_INTERNAL trust); CONTRADICTED status poisons trust.
   *   chg1:  INTERNAL_AUTHORITATIVE (the change record is authoritative
   *          internal evidence of a detected change); CONTRADICTED poisons.
   *   xsig1: EXTERNAL_SOURCE with the R8-C registry sourceId, corroboration
   *          count and contradiction flag carried verbatim; the SERVER-side
   *          trusted registry (getTrustedSourceKeys) decides VERIFIED_EXTERNAL.
   */
  async resolveEvidence(evidenceRef: string): Promise<unknown> {
    if (evidenceRef.startsWith("mem1:")) {
      if (!(await this.evidenceTablePresent("strategic_memory_records"))) return null;
      const rows = normalizeSqlRows(
        await this.db.execute(sql`
          SELECT userId, businessId, statementType, factStatus, observedAt
          FROM strategic_memory_records
          WHERE userId = ${this.userId} AND memoryId = ${evidenceRef}
          LIMIT 1
        `)
      );
      const row = rows[0];
      if (!row) return null;
      return {
        ownerUserId: Number(row.userId),
        businessId: row.businessId === null || row.businessId === undefined ? null : Number(row.businessId),
        sourceKind: row.statementType === "FACT" ? "INTERNAL_AUTHORITATIVE" : "MODEL_GENERATED",
        registeredSourceKey: null,
        corroborationCount: 0,
        contradictionFlag: row.factStatus === "CONTRADICTED",
        observedAt: String(row.observedAt ?? ""),
      };
    }
    if (evidenceRef.startsWith("chg1:")) {
      if (!(await this.evidenceTablePresent("business_change_events"))) return null;
      const rows = normalizeSqlRows(
        await this.db.execute(sql`
          SELECT userId, businessId, status, detectedAt
          FROM business_change_events
          WHERE userId = ${this.userId} AND changeId = ${evidenceRef}
          LIMIT 1
        `)
      );
      const row = rows[0];
      if (!row) return null;
      return {
        ownerUserId: Number(row.userId),
        businessId: row.businessId === null || row.businessId === undefined ? null : Number(row.businessId),
        sourceKind: "INTERNAL_AUTHORITATIVE",
        registeredSourceKey: null,
        corroborationCount: 0,
        contradictionFlag: row.status === "CONTRADICTED",
        observedAt: String(row.detectedAt ?? ""),
      };
    }
    if (evidenceRef.startsWith("xsig1:")) {
      if (!(await this.evidenceTablePresent("external_signals"))) return null;
      const rows = normalizeSqlRows(
        await this.db.execute(sql`
          SELECT userId, businessId, sourceId, sourceTrustClass, corroborationStatus,
                 corroboratingSignalIds, contradictingSignalIds, observedAt
          FROM external_signals
          WHERE userId = ${this.userId} AND signalId = ${evidenceRef}
          LIMIT 1
        `)
      );
      const row = rows[0];
      if (!row) return null;
      const corroborating = parseJsonArray(row.corroboratingSignalIds);
      const contradicting = parseJsonArray(row.contradictingSignalIds);
      const corroborationStatus = String(row.corroborationStatus ?? "");
      return {
        ownerUserId: Number(row.userId),
        businessId: row.businessId === null || row.businessId === undefined ? null : Number(row.businessId),
        sourceKind: "EXTERNAL_SOURCE",
        registeredSourceKey: typeof row.sourceId === "string" ? row.sourceId : null,
        corroborationCount: corroborationStatus === "CORROBORATED" ? corroborating.length : 0,
        contradictionFlag: corroborationStatus === "CONTRADICTED" || contradicting.length > 0,
        observedAt: String(row.observedAt ?? ""),
      };
    }
    return null;
  }

  /**
   * Server-side trusted-source registry: R8-C external_sources rows in the
   * OFFICIAL/VERIFIED registry classes for this tenant. A source can never
   * mark itself trusted — this registry is the only authority (F3).
   */
  async getTrustedSourceKeys(): Promise<readonly string[]> {
    const rows: Array<{ sourceId: string }> = await this.db
      .select()
      .from(externalSources)
      .where(
        and(
          drizzleEq(externalSources.userId, this.userId),
          inArray(externalSources.registryClass, ["OFFICIAL", "VERIFIED"])
        )
      );
    return rows.map((r) => String(r.sourceId));
  }

  /**
   * Approval-ledger read view for the operations projection. Reads the shared
   * approval_requests ledger (approvalType 'strategic_recommendation') and
   * folds per-decision status with conservative precedence: rejected wins over
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
        WHERE userId = ${userId} AND approvalType = 'strategic_recommendation'
      `)
    );
    const rank = { pending: 0, approved: 1, rejected: 2 } as const;
    for (const row of rows) {
      const context = parseJsonObject(row.context);
      const binding = context && parseJsonObject(context.binding);
      const decisionId = binding && typeof binding.governanceDecisionId === "string" ? binding.governanceDecisionId : null;
      if (!decisionId || !wanted.has(decisionId)) continue;
      const rawStatus = String(row.status ?? "pending");
      const status: "pending" | "approved" | "rejected" =
        rawStatus === "rejected" ? "rejected" : rawStatus === "approved" || rawStatus === "edited" ? "approved" : "pending";
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
