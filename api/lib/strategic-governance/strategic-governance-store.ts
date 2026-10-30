// ─── R8-F Strategic Intelligence Governance — durable store ───
//
// DB-authoritative persistence over the R8-F-owned table. The convergence
// anchor is the durable unique key (userId, governanceDecisionId): retried or
// raced writes re-read the committed row and converge (idempotent_replay).
// Rows are insert-only — corrections are new decisions (immutability).
//
// The canonical table lives in @db/schema (single source of truth; the 0036
// migration artefact is provisional — NOT executed; see
// docs/recovery/r8-f-unexecuted-migrations.md; R8-X owns canonical
// sequencing). Every call site supplies an executor through the structural
// seam below — the same select/insert chain shape a Drizzle client or
// transaction callback provides. The bridge binds a real client/tx to these
// handles (translating the local predicate descriptors to Drizzle SQL);
// tests bind the in-memory fake.

import { strategicGovernanceDecisions } from "@db/schema";
import { StrategicGovernanceInputError } from "./strategic-governance-contract";

// ─── Table handles (canonical @db/schema imports — single source of truth) ───

export type StrategicGovernanceTableHandle = typeof strategicGovernanceDecisions;

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

export interface StrategicGovernanceRowQuery {
  readonly all: () => Promise<unknown[]>;
  readonly limit: (n: number) => Promise<unknown[]>;
  readonly orderBy: (...terms: StoreOrderTerm[]) => StrategicGovernanceRowQuery;
}

export interface StrategicGovernanceSelectTarget {
  readonly where: (predicate: StorePredicate) => StrategicGovernanceRowQuery;
  readonly orderBy: (...terms: StoreOrderTerm[]) => StrategicGovernanceRowQuery;
  readonly all: () => Promise<unknown[]>;
  readonly limit: (n: number) => Promise<unknown[]>;
}

/**
 * Structural seam: the bridge binds a Drizzle client / transaction callback
 * to this select/insert chain shape (translating the local predicate
 * descriptors below into Drizzle SQL over the canonical @db/schema table);
 * tests bind the table-name-keyed in-memory fake.
 */
export interface StrategicGovernanceStoreExecutor {
  readonly select: () => {
    readonly from: (
      table: StrategicGovernanceTableHandle
    ) => StrategicGovernanceSelectTarget;
  };
  readonly insert: (
    table: StrategicGovernanceTableHandle
  ) => { readonly values: (row: Record<string, unknown>) => Promise<unknown> };
}

// ─── Row types (decision record) ───

export interface StrategicGovernanceDecisionRow {
  readonly governanceDecisionId: string;
  readonly contractVersion: string;
  readonly engineVersion: string;
  readonly userId: number;
  readonly businessId: number;
  readonly proposalId: string;
  readonly recommendationType: string;
  /** JSON column (string[]); carried as a JS value here. */
  readonly evidenceRefs: unknown;
  readonly sourceTrustClass: string;
  readonly confidenceClass: string;
  readonly strategicRiskClass: string;
  readonly policyVersion: string | null;
  readonly decision: string;
  /** JSON column (string[]); carried as a JS value here. */
  readonly reasonCodes: unknown;
  readonly approvalRequired: boolean;
  /** JSON column (approval binding); carried as a JS value here. */
  readonly approvalBinding: unknown;
  readonly evidenceFingerprint: string;
  readonly proposalFingerprint: string;
  readonly validUntil: string | null;
  readonly evaluatedAt: string;
  readonly evaluationFingerprint: string;
  /** JSON column (threshold snapshot); carried as a JS value here. */
  readonly thresholds: unknown;
  readonly createdAt: string;
}

export type InsertStrategicGovernanceDecisionRow = StrategicGovernanceDecisionRow;

export interface StrategicGovernanceWriteResult {
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
  executor: StrategicGovernanceStoreExecutor
): Promise<StrategicGovernanceDecisionRow | null> {
  const [row] = (await executor
    .select()
    .from(strategicGovernanceDecisions)
    .where(and(eq("userId", userId), eq("governanceDecisionId", governanceDecisionId)))
    .limit(1)) as unknown[];
  return (row as StrategicGovernanceDecisionRow | undefined) ?? null;
}

/**
 * Insert under the durable convergence anchor unique (userId,
 * governanceDecisionId). A raced or retried call re-reads the committed row —
 * exactly one decision ever exists per identity binding.
 */
export async function insertStrategicGovernanceDecision(
  row: InsertStrategicGovernanceDecisionRow,
  executor: StrategicGovernanceStoreExecutor
): Promise<StrategicGovernanceWriteResult> {
  try {
    await executor.insert(strategicGovernanceDecisions).values({ ...row });
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

export async function getStrategicGovernanceDecision(
  userId: number,
  governanceDecisionId: string,
  executor: StrategicGovernanceStoreExecutor
): Promise<StrategicGovernanceDecisionRow> {
  const row = await findDecisionRow(userId, governanceDecisionId, executor);
  if (!row) {
    throw new StrategicGovernanceInputError(
      "GOVERNANCE_DECISION_NOT_FOUND",
      `strategic governance decision ${governanceDecisionId} not found for user ${userId}`
    );
  }
  return row;
}

/** Immutable decision history, oldest-first (fully deterministic). */
export async function listStrategicGovernanceDecisions(
  userId: number,
  filters: { businessId?: number; proposalId?: string; decision?: string },
  executor: StrategicGovernanceStoreExecutor
): Promise<StrategicGovernanceDecisionRow[]> {
  const conditions = [eq("userId", userId)];
  if (filters.businessId !== undefined) conditions.push(eq("businessId", filters.businessId));
  if (filters.proposalId !== undefined) conditions.push(eq("proposalId", filters.proposalId));
  if (filters.decision !== undefined) conditions.push(eq("decision", filters.decision));
  const rows = await executor
    .select()
    .from(strategicGovernanceDecisions)
    .where(and(...conditions))
    .orderBy(asc("evaluatedAt"), asc("governanceDecisionId"))
    .all();
  return rows as unknown as StrategicGovernanceDecisionRow[];
}
