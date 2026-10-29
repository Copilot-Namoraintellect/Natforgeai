// ─── R7-F Optimisation Governance — durable store ───
//
// DB-authoritative persistence over the R7-F-owned table. The convergence
// anchor is the durable unique key (userId, governanceDecisionId): retried
// or raced writes re-read the committed row and converge (idempotent_replay).
// Rows are insert-only — corrections are new decisions (immutability).
//
// The canonical table lives in @db/schema (single source of truth; the 0035
// migration artefact is provisional — NOT executed; see
// docs/recovery/r7-f-unexecuted-migrations.md; R7-X owns canonical
// sequencing). Every call site supplies an executor through the structural
// seam below — the same select/insert chain shape a Drizzle client or
// transaction callback provides. The bridge binds a real client/tx to these
// handles (translating the local predicate descriptors to Drizzle SQL);
// tests bind the in-memory fake.

import { optimisationGovernanceDecisions } from "@db/schema";
import { OptimisationGovernanceInputError } from "./optimisation-governance-contract";

// ─── Table handles (canonical @db/schema imports — single source of truth) ───

export type OptimisationGovernanceTableHandle = typeof optimisationGovernanceDecisions;

// ─── Predicate model (Drizzle-style, owned locally per repo convention) ───

export type StorePredicate =
  | { readonly kind: "eq"; readonly field: string; readonly value: unknown }
  | { readonly kind: "and"; readonly conditions: readonly StorePredicate[] };

export function eq(field: string, value: unknown): StorePredicate {
  return Object.freeze({ kind: "eq", field, value });
}

export function and(...conditions: StorePredicate[]): StorePredicate {
  return Object.freeze({ kind: "and", conditions: Object.freeze([...conditions]) });
}

export interface StoreOrderTerm {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

export function asc(field: string): StoreOrderTerm {
  return Object.freeze({ field, direction: "asc" });
}

export function desc(field: string): StoreOrderTerm {
  return Object.freeze({ field, direction: "desc" });
}

// ─── Structural executor seam ───

export interface OptimisationGovernanceRowQuery {
  readonly all: () => Promise<unknown[]>;
  readonly limit: (n: number) => Promise<unknown[]>;
  readonly orderBy: (...terms: StoreOrderTerm[]) => OptimisationGovernanceRowQuery;
}

export interface OptimisationGovernanceSelectTarget {
  readonly where: (predicate: StorePredicate) => OptimisationGovernanceRowQuery;
  readonly orderBy: (...terms: StoreOrderTerm[]) => OptimisationGovernanceRowQuery;
  readonly all: () => Promise<unknown[]>;
  readonly limit: (n: number) => Promise<unknown[]>;
}

/**
 * Structural seam: the bridge binds a Drizzle client / transaction callback
 * to this select/insert chain shape (translating the local predicate
 * descriptors below into Drizzle SQL over the canonical @db/schema table);
 * tests bind the table-name-keyed in-memory fake.
 */
export interface OptimisationGovernanceStoreExecutor {
  readonly select: () => {
    readonly from: (
      table: OptimisationGovernanceTableHandle
    ) => OptimisationGovernanceSelectTarget;
  };
  readonly insert: (
    table: OptimisationGovernanceTableHandle
  ) => { readonly values: (row: Record<string, unknown>) => Promise<unknown> };
}

// ─── Row types (decision record) ───

export interface OptimisationGovernanceDecisionRow {
  readonly governanceDecisionId: string;
  readonly contractVersion: string;
  readonly engineVersion: string;
  readonly userId: number;
  readonly businessId: number;
  readonly proposalId: string;
  readonly proposalType: string;
  readonly campaignId: number | null;
  readonly policyVersion: string | null;
  readonly decision: string;
  /** JSON column (string[]); carried as a JS value here. */
  readonly reasonCodes: unknown;
  readonly riskClass: string;
  readonly financialImpactClass: string;
  readonly financialDeltaMinor: number;
  readonly approvalRequired: boolean;
  /** JSON column (approval binding); carried as a JS value here. */
  readonly approvalBinding: unknown;
  readonly evidenceHash: string;
  readonly proposalFingerprint: string;
  readonly validUntil: string | null;
  readonly evaluatedAt: string;
  readonly evaluationFingerprint: string;
  /** JSON column (threshold snapshot); carried as a JS value here. */
  readonly thresholds: unknown;
  readonly createdAt: string;
}

export type InsertOptimisationGovernanceDecisionRow = OptimisationGovernanceDecisionRow;

export interface OptimisationGovernanceWriteResult {
  readonly inserted: boolean;
  readonly duplicateClassification: "none" | "idempotent_replay";
}

function isDuplicateKeyError(err: unknown): boolean {
  const seen = new WeakSet<object>();
  let current: unknown = err;
  let depth = 0;
  while (current && typeof current === "object" && depth < 5) {
    if (seen.has(current)) break;
    seen.add(current);
    const e = current as Record<string, unknown>;
    if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true;
    current = e.cause;
    depth += 1;
  }
  return false;
}

async function findDecisionRow(
  userId: number,
  governanceDecisionId: string,
  executor: OptimisationGovernanceStoreExecutor
): Promise<OptimisationGovernanceDecisionRow | null> {
  const [row] = (await executor
    .select()
    .from(optimisationGovernanceDecisions)
    .where(and(eq("userId", userId), eq("governanceDecisionId", governanceDecisionId)))
    .limit(1)) as unknown[];
  return (row as OptimisationGovernanceDecisionRow | undefined) ?? null;
}

/**
 * Insert under the durable convergence anchor unique (userId,
 * governanceDecisionId). A raced or retried call re-reads the committed row —
 * exactly one decision ever exists per identity binding.
 */
export async function insertOptimisationGovernanceDecision(
  row: InsertOptimisationGovernanceDecisionRow,
  executor: OptimisationGovernanceStoreExecutor
): Promise<OptimisationGovernanceWriteResult> {
  try {
    await executor.insert(optimisationGovernanceDecisions).values({ ...row });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findDecisionRow(Number(row.userId), row.governanceDecisionId, executor);
    if (existing) {
      return { inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  return { inserted: true, duplicateClassification: "none" };
}

export async function getOptimisationGovernanceDecision(
  userId: number,
  governanceDecisionId: string,
  executor: OptimisationGovernanceStoreExecutor
): Promise<OptimisationGovernanceDecisionRow> {
  const row = await findDecisionRow(userId, governanceDecisionId, executor);
  if (!row) {
    throw new OptimisationGovernanceInputError(
      "GOVERNANCE_DECISION_NOT_FOUND",
      `governance decision ${governanceDecisionId} not found for user ${userId}`
    );
  }
  return row;
}

/** Immutable decision history, oldest-first (fully deterministic). */
export async function listOptimisationGovernanceDecisions(
  userId: number,
  filters: { businessId?: number; proposalId?: string; decision?: string },
  executor: OptimisationGovernanceStoreExecutor
): Promise<OptimisationGovernanceDecisionRow[]> {
  const conditions = [eq("userId", userId)];
  if (filters.businessId !== undefined) conditions.push(eq("businessId", filters.businessId));
  if (filters.proposalId !== undefined) conditions.push(eq("proposalId", filters.proposalId));
  if (filters.decision !== undefined) conditions.push(eq("decision", filters.decision));
  const rows = await executor
    .select()
    .from(optimisationGovernanceDecisions)
    .where(and(...conditions))
    .orderBy(asc("evaluatedAt"), asc("governanceDecisionId"))
    .all();
  return rows as unknown as OptimisationGovernanceDecisionRow[];
}
