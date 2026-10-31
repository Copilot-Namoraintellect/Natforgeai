// ─── R9-F Mission Governance & Approval — durable store ───
//
// DB-authoritative persistence over the R9-F-owned table. The convergence
// anchor is the durable unique key (userId, governanceDecisionId): retried or
// raced writes re-read the committed row and converge (idempotent_replay).
// Rows are insert-only — corrections are new decisions (receipt immutability,
// F5).
//
// The canonical table lives in @db/schema (single source of truth; the 0037
// migration artefact is provisional — NOT executed; see
// docs/recovery/r9-f-unexecuted-migrations.md; R9-X owns canonical 0037
// sequencing). Every call site supplies an executor through the structural
// seam below — the same select/insert chain shape a Drizzle client or
// transaction callback provides. The bridge binds a real client/tx to these
// handles (translating the local predicate descriptors to Drizzle SQL);
// tests bind the in-memory fake.

import { missionGovernanceDecisions } from "@db/schema";
import { MissionGovernanceInputError } from "./mission-governance-contract";

// ─── Table handles (canonical @db/schema imports — single source of truth) ───

export type MissionGovernanceTableHandle = typeof missionGovernanceDecisions;

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

export interface MissionGovernanceRowQuery {
  readonly all: () => Promise<unknown[]>;
  readonly limit: (n: number) => Promise<unknown[]>;
  readonly orderBy: (...terms: StoreOrderTerm[]) => MissionGovernanceRowQuery;
}

export interface MissionGovernanceSelectTarget {
  readonly where: (predicate: StorePredicate) => MissionGovernanceRowQuery;
  readonly orderBy: (...terms: StoreOrderTerm[]) => MissionGovernanceRowQuery;
  readonly all: () => Promise<unknown[]>;
  readonly limit: (n: number) => Promise<unknown[]>;
}

/**
 * Structural seam: the bridge binds a Drizzle client / transaction callback
 * to this select/insert chain shape (translating the local predicate
 * descriptors below into Drizzle SQL over the canonical @db/schema table);
 * tests bind the table-name-keyed in-memory fake.
 */
export interface MissionGovernanceStoreExecutor {
  readonly select: () => {
    readonly from: (table: MissionGovernanceTableHandle) => MissionGovernanceSelectTarget;
  };
  readonly insert: (
    table: MissionGovernanceTableHandle
  ) => { readonly values: (row: Record<string, unknown>) => Promise<unknown> };
}

// ─── Row types (immutable governance receipt record) ───

export interface MissionGovernanceDecisionRow {
  readonly governanceDecisionId: string;
  readonly contractVersion: string;
  readonly engineVersion: string;
  readonly userId: number;
  readonly businessId: number;
  readonly missionRef: string;
  readonly planRef: string | null;
  readonly taskRef: string | null;
  readonly subjectClass: string;
  readonly actionType: string;
  readonly actionParamsFingerprint: string;
  readonly missionRiskClass: string;
  /** JSON column (risk factor snapshot); carried as a JS value here. */
  readonly riskFactors: unknown;
  readonly policyVersion: string | null;
  readonly decision: string;
  /** JSON column (string[]); carried as a JS value here. */
  readonly reasonCodes: unknown;
  readonly approvalRequired: boolean;
  /** JSON column (approval binding); carried as a JS value here. */
  readonly approvalBinding: unknown;
  readonly evaluationFingerprint: string;
  readonly validUntil: string | null;
  readonly evaluatedAt: string;
  /** JSON column (threshold snapshot); carried as a JS value here. */
  readonly thresholds: unknown;
  readonly createdAt: string;
}

export type InsertMissionGovernanceDecisionRow = MissionGovernanceDecisionRow;

export interface MissionGovernanceWriteResult {
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
  executor: MissionGovernanceStoreExecutor
): Promise<MissionGovernanceDecisionRow | null> {
  const [row] = (await executor
    .select()
    .from(missionGovernanceDecisions)
    .where(and(eq("userId", userId), eq("governanceDecisionId", governanceDecisionId)))
    .limit(1)) as unknown[];
  return (row as MissionGovernanceDecisionRow | undefined) ?? null;
}

/**
 * Insert under the durable convergence anchor unique (userId,
 * governanceDecisionId). A raced or retried call re-reads the committed row —
 * exactly one receipt ever exists per identity binding.
 */
export async function insertMissionGovernanceDecision(
  row: InsertMissionGovernanceDecisionRow,
  executor: MissionGovernanceStoreExecutor
): Promise<MissionGovernanceWriteResult> {
  try {
    await executor.insert(missionGovernanceDecisions).values({ ...row });
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

export async function getMissionGovernanceDecision(
  userId: number,
  governanceDecisionId: string,
  executor: MissionGovernanceStoreExecutor
): Promise<MissionGovernanceDecisionRow> {
  const row = await findDecisionRow(userId, governanceDecisionId, executor);
  if (!row) {
    throw new MissionGovernanceInputError(
      "GOVERNANCE_DECISION_NOT_FOUND",
      `mission governance decision ${governanceDecisionId} not found for user ${userId}`
    );
  }
  return row;
}

/** Immutable receipt history, oldest-first (fully deterministic). */
export async function listMissionGovernanceDecisions(
  userId: number,
  filters: { businessId?: number; missionRef?: string; decision?: string },
  executor: MissionGovernanceStoreExecutor
): Promise<MissionGovernanceDecisionRow[]> {
  const conditions = [eq("userId", userId)];
  if (filters.businessId !== undefined) conditions.push(eq("businessId", filters.businessId));
  if (filters.missionRef !== undefined) conditions.push(eq("missionRef", filters.missionRef));
  if (filters.decision !== undefined) conditions.push(eq("decision", filters.decision));
  const rows = await executor
    .select()
    .from(missionGovernanceDecisions)
    .where(and(...conditions))
    .orderBy(asc("evaluatedAt"), asc("governanceDecisionId"))
    .all();
  return rows as unknown as MissionGovernanceDecisionRow[];
}
