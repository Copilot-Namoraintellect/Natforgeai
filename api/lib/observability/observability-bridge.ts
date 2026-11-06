// ─── R10-E Observability — production bridge ───
//
// Binds a Drizzle client/transaction to the store's structural executor seam
// and resolves the mission-control operational evidence provider against the
// canonical R9 tables (E10 — read-only consumption; R9-E keeps mission-state
// authority).
//
// Guarded degradation: R9 table availability is probed once per provider
// instance through information_schema and memoized. When the R9 tables are
// absent (canonical 0037 not executed in this environment) the provider
// returns null so the mission_control dimension reports UNKNOWN — never
// HEALTHY. Business-ownership checks for tenant-scoped event attribution use
// the canonical businesses table (id + owning user).
//
// No secrets, no provider calls, no mutation of any upstream table.

import { and, eq as drizzleEq, gte as drizzleGte, lte as drizzleLte, sql, type SQL } from "drizzle-orm";
import { businesses } from "@db/schema";
import { getDb } from "../../queries/connection";
import { ObservabilityInputError } from "./observability-contract";
import type {
  MissionControlHealthEvidence,
  WorkerHealthEvidence,
  DatabaseHealthEvidence,
} from "./health-model";
import type { PlatformEvidenceProvider } from "./observability-service";
import type {
  ObservabilityStoreExecutor,
  ObservabilityTableHandle,
  StoreOrderTerm,
  StorePredicate,
} from "./observability-store";

const AUTHORITY_TABLES = [
  "mission_proposals",
  "mission_schedules",
  "mission_governance_decisions",
  "mission_recovery_candidates",
  "execution_attempts",
  "approval_requests",
] as const;

/**
 * Structural db seam: the default getDb() client and a Drizzle transaction
 * client both satisfy it; the test fake binds a scripted in-memory client.
 */
export interface ObservabilityBridgeDb {
  readonly select: (...args: never[]) => any;
  readonly execute: (query: SQL) => Promise<unknown>;
}

function normalizeSqlRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    const first = result[0];
    if (Array.isArray(first)) return first as Array<Record<string, unknown>>;
    if (first && typeof first === "object") return [first as Record<string, unknown>];
    if (result.length > 0 && typeof result[0] === "object") return result as Array<Record<string, unknown>>;
    return [];
  }
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

// ─── Store executor binding ───

function columnOf(table: unknown, field: string): any {
  const column = (table as Record<string, unknown>)[field];
  if (column === undefined || column === null) {
    throw new Error(`observability bridge: unknown column ${field} on table handle`);
  }
  return column;
}

function toSqlPredicate(table: unknown, predicate: StorePredicate): SQL {
  if (predicate.kind === "eq") return drizzleEq(columnOf(table, predicate.field), predicate.value);
  if (predicate.kind === "gte") return drizzleGte(columnOf(table, predicate.field), predicate.value);
  if (predicate.kind === "lte") return drizzleLte(columnOf(table, predicate.field), predicate.value);
  return and(
    ...predicate.conditions.map((condition) => toSqlPredicate(table, condition))
  ) as SQL;
}

function toSqlOrder(table: unknown, term: StoreOrderTerm): SQL {
  const column = columnOf(table, term.field);
  return sql`${column as never} ${sql.raw(term.direction === "asc" ? "asc" : "desc")}`;
}

/**
 * Binds a Drizzle-shaped client (real client, transaction callback, or the
 * in-memory fake) to the store's structural executor seam.
 */
export function bindObservabilityStoreExecutor(client: unknown): ObservabilityStoreExecutor {
  const db = client as {
    select: () => { from: (table: unknown) => any };
    insert: (table: unknown) => { values: (row: Record<string, unknown>) => unknown };
    update: (table: unknown) => { set: (values: Record<string, unknown>) => { where: (cond: unknown) => Promise<unknown> } };
  };

  const adapt = (table: unknown, query: any) => ({
    all: async () => await query,
    limit: async (n: number) => await query.limit(n),
    orderBy: (...terms: StoreOrderTerm[]) => adapt(table, query.orderBy(...terms.map((term) => toSqlOrder(table, term)))),
  });

  return {
    select: () => ({
      from: (table: ObservabilityTableHandle) => {
        const target = db.select().from(table);
        return {
          where: (predicate: StorePredicate) => adapt(table, target.where(toSqlPredicate(table, predicate))),
          orderBy: (...terms: StoreOrderTerm[]) => adapt(table, target.orderBy(...terms.map((term) => toSqlOrder(table, term)))),
          all: async () => await target,
          limit: async (n: number) => await target.limit(n),
        };
      },
    }),
    insert: (table: ObservabilityTableHandle) => ({
      values: async (row: Record<string, unknown>) => await db.insert(table).values(row),
    }),
    update: (table: ObservabilityTableHandle) => ({
      set: (values: Record<string, unknown>) => ({
        where: async (predicate: StorePredicate) =>
          (await db
            .update(table)
            .set(values)
            .where(toSqlPredicate(table, predicate))) as { affectedRows?: number },
      }),
    }),
  };
}

// ─── Business ownership (tenant-scoped event attribution) ───

export async function assertBusinessOwnership(
  db: ObservabilityBridgeDb,
  userId: number,
  businessId: number
): Promise<void> {
  const [row] = await db
    .select()
    .from(businesses)
    .where(and(drizzleEq(businesses.id, businessId), drizzleEq(businesses.userId, userId)))
    .limit(1);
  if (!row) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_BUSINESS_OWNERSHIP_INVALID",
      `business ${businessId} is not owned by tenant ${userId}.`
    );
  }
}

// ─── Mission-control operational evidence (E10) ───

class MissionControlEvidenceProvider implements PlatformEvidenceProvider {
  private availability: Promise<ReadonlySet<string>> | null = null;
  private readonly db: ObservabilityBridgeDb;

  constructor(db: ObservabilityBridgeDb) {
    this.db = db;
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
      // R9 tables absent (0037 not executed in this environment): honest
      // UNKNOWN for the mission_control dimension — never HEALTHY.
      throw new Error(`mission-control evidence tables missing: ${missing.join(", ")}`);
    }
  }

  /**
   * Read-only aggregate over the canonical R9 tables. R9-E keeps
   * mission-state authority; this is an operational rollup of counts only.
   */
  async getMissionControlEvidence(now: Date): Promise<MissionControlHealthEvidence | null> {
    await this.assertAvailable();
    const staleBefore = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const rows = normalizeSqlRows(
      await this.db.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM mission_proposals mp
            WHERE mp.status NOT IN ('CANCELLED','INVALIDATED','SUPERSEDED')) AS activeMissions,
          (SELECT COUNT(*) FROM mission_proposals mp2
            WHERE mp2.status IN ('BLOCKED','REVIEW_REQUIRED')) AS blockedMissions,
          (SELECT COUNT(*) FROM execution_attempts ea
            WHERE ea.resultClassification = 'UNCERTAIN') AS uncertainActions,
          (SELECT COUNT(*) FROM execution_attempts ea2
            WHERE ea2.resultClassification IN ('FAILED_RETRYABLE','FAILED_FINAL')) AS failedActions,
          (SELECT COUNT(*) FROM execution_attempts ea3
            WHERE ea3.resultClassification = 'PENDING_EXTERNAL') AS pendingExternalResults,
          (SELECT COUNT(*) FROM mission_governance_decisions mgd
            WHERE mgd.decision = 'BLOCK') AS governanceBlocks,
          (SELECT COUNT(*) FROM approval_requests ar
            WHERE ar.status = 'pending') AS approvalBacklog,
          (SELECT COUNT(*) FROM mission_schedules ms
            WHERE ms.updatedAt < ${staleBefore}
              AND ms.status NOT IN ('CANCELLED','INVALIDATED','SUPERSEDED')) AS staleSchedules,
          (SELECT COUNT(*) FROM mission_recovery_candidates mrc
            WHERE mrc.status IN ('PROPOSED','REVIEW_REQUIRED','AUTHORIZED','IN_PROGRESS')) AS openRecoveries,
          (SELECT COUNT(*) FROM mission_recovery_candidates mrc2
            WHERE mrc2.status = 'STALE') AS staleRecoveries
      `)
    );
    const row = rows[0] ?? {};
    const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);
    return {
      telemetryObserved: true,
      blockedMissions: num(row.blockedMissions),
      uncertainActions: num(row.uncertainActions),
      failedActions: num(row.failedActions),
      pendingExternalResults: num(row.pendingExternalResults),
      governanceBlocks: num(row.governanceBlocks),
      approvalBacklog: num(row.approvalBacklog),
      staleSchedules: num(row.staleSchedules),
      staleRecoveries: num(row.staleRecoveries),
    };
  }

  /** Recovery backlog evidence (E10 aggregate reused for the dimension). */
  async getRecoveryBacklogEvidence(now: Date): Promise<import("./health-model").RecoveryBacklogEvidence | null> {
    await this.assertAvailable();
    const rows = normalizeSqlRows(
      await this.db.execute(sql`
        SELECT COUNT(*) AS openCandidates,
               MAX(updatedAt) AS newestUpdate
        FROM mission_recovery_candidates
        WHERE status IN ('PROPOSED','REVIEW_REQUIRED','AUTHORIZED','IN_PROGRESS')
      `)
    );
    const row = rows[0] ?? {};
    const open = typeof row.openCandidates === "number" ? row.openCandidates : Number(row.openCandidates ?? 0) || 0;
    const newest = typeof row.newestUpdate === "string" ? Date.parse(row.newestUpdate) : NaN;
    return {
      telemetryObserved: true,
      openCandidateCount: open,
      oldestCandidateAgeMs: Number.isNaN(newest) ? null : Math.max(0, now.getTime() - newest),
    };
  }
}

/**
 * Default production evidence provider: mission-control rollup over the R9
 * tables. Dimensions without an in-repo observable surface (workers, queue,
 * providers, backup, security platform signals) stay unbound and report
 * UNKNOWN until R10-A/R10-X bind the OneGrid telemetry described in
 * docs/contracts/observability-to-production-platform-contract.md.
 */
export function createDefaultObservabilityEvidenceProvider(
  db: ObservabilityBridgeDb = getDb()
): PlatformEvidenceProvider {
  return new MissionControlEvidenceProvider(db);
}

// ─── Environment / release attribution ───

export function resolveObservabilityEnvironment(): "development" | "staging" | "production" {
  const raw = (
    process.env.ENVIRONMENT_NAME ?? (process.env.NODE_ENV === "production" ? "production" : "development")
  ).toLowerCase();
  return raw === "production" || raw === "staging" ? raw : "development";
}

export function resolveObservabilityReleaseVersion(): string | null {
  return process.env.RELEASE_VERSION ?? process.env.GIT_SHA ?? null;
}

export type { WorkerHealthEvidence, DatabaseHealthEvidence };
