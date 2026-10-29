// ─── R7-E Budget & Portfolio Optimisation — durable store ───
//
// DB-authoritative persistence over the R7-E-owned tables. Convergence
// anchors are durable unique keys — (userId, portfolioSnapshotId) for
// snapshots, (userId, optimisationId) for proposals, (userId,
// instructionId) for authorised instructions. Retried or raced writes
// re-read the committed row and converge (idempotent_replay); rows are
// insert-only — corrections are new records. The canonical tables live in
// @db/schema (the 0035 artefact is provisional — NOT executed; see
// docs/recovery/r7-e-unexecuted-migrations.md; R7-X owns sequencing).
//
// Every call site supplies an executor through the structural seam below —
// the same select/insert/update chain shape a Drizzle client or transaction
// callback provides. The bridge binds a real client/tx; tests bind the
// in-memory fake.

import {
  budgetPortfolioAllocationInstructions,
  budgetPortfolioProposals,
  budgetPortfolioSnapshots,
} from "@db/schema";
import {
  BudgetPortfolioStateConflictError,
  type OptimisationProposalStatus,
} from "./budget-portfolio-contract";

// ─── Table handles (canonical @db/schema imports) ───

export type BudgetPortfolioTableHandle =
  | typeof budgetPortfolioSnapshots
  | typeof budgetPortfolioProposals
  | typeof budgetPortfolioAllocationInstructions;

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

export interface BudgetPortfolioRowQuery {
  readonly all: () => Promise<unknown[]>;
  readonly limit: (n: number) => Promise<unknown[]>;
  readonly orderBy: (...terms: StoreOrderTerm[]) => BudgetPortfolioRowQuery;
}

export interface BudgetPortfolioSelectTarget {
  readonly where: (predicate: StorePredicate) => BudgetPortfolioRowQuery;
  readonly orderBy: (...terms: StoreOrderTerm[]) => BudgetPortfolioRowQuery;
  readonly all: () => Promise<unknown[]>;
  readonly limit: (n: number) => Promise<unknown[]>;
}

/**
 * Structural seam: the bridge binds a Drizzle client / transaction callback
 * to this select/insert/update chain shape (translating the local predicate
 * descriptors into Drizzle SQL over the canonical @db/schema tables); tests
 * bind the table-name-keyed in-memory fake.
 */
export interface BudgetPortfolioStoreExecutor {
  readonly select: () => { readonly from: (table: BudgetPortfolioTableHandle) => BudgetPortfolioSelectTarget };
  readonly insert: (
    table: BudgetPortfolioTableHandle
  ) => { readonly values: (row: Record<string, unknown>) => Promise<unknown> };
  readonly update: (
    table: BudgetPortfolioTableHandle
  ) => {
    readonly set: (patch: Record<string, unknown>) => {
      readonly where: (predicate: StorePredicate) => Promise<unknown>;
    };
  };
}

// ─── Row types ───

export interface BudgetPortfolioSnapshotRow {
  readonly portfolioSnapshotId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly budgetPeriod: string;
  readonly currency: string;
  readonly approvedTotalBudgetMinor: number;
  readonly committedMinor: number;
  readonly reservedMinor: number;
  readonly availableReallocatableMinor: number;
  /** JSON column ({allocationKey, campaignId, provider, amountMinor}[]). */
  readonly currentAllocations: unknown;
  /** JSON column (string[]). */
  readonly supportedProviders: unknown;
  /** JSON column (string[]). */
  readonly lockedAllocationKeys: unknown;
  /** JSON column (string[]). */
  readonly disabledAllocationKeys: unknown;
  readonly capturedAt: string;
  readonly createdAt: string;
}

export interface BudgetPortfolioProposalRow {
  readonly optimisationId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly portfolioSnapshotId: string;
  readonly budgetPeriod: string;
  readonly currency: string;
  readonly currentTotalBudgetMinor: number;
  /** JSON column ({allocationKey, campaignId, provider, amountMinor}[]). */
  readonly currentAllocations: unknown;
  /** JSON column ({allocationKey, campaignId, provider, amountMinor}[]). */
  readonly proposedAllocations: unknown;
  /** JSON column ({allocationKey, deltaMinor}[]). */
  readonly deltaAllocations: unknown;
  /** JSON column (string[]). */
  readonly evidenceRefs: unknown;
  /** JSON column (string[]). */
  readonly learningRefs: unknown;
  /** JSON column (string[]). */
  readonly attributionRefs: unknown;
  /** JSON column (string[]). */
  readonly outcomeRefs: unknown;
  readonly objective: string;
  readonly algorithmVersion: string;
  readonly constraintVersion: string;
  readonly evidenceBundleHash: string;
  readonly confidenceClass: string;
  /** JSON column (string[]). */
  readonly reasonCodes: unknown;
  readonly governanceDecisionId: string | null;
  /** JSON column (frozen R7-F decision view) — read back for execution gating. */
  readonly governanceDecision: unknown;
  readonly approvalRequired: boolean;
  readonly status: string;
  readonly proposalContentHash: string;
  readonly createdAt: string;
  readonly validUntil: string | null;
}

export interface BudgetPortfolioInstructionRow {
  readonly instructionId: string;
  readonly userId: number;
  readonly optimisationId: string;
  readonly governanceDecisionId: string;
  readonly approvalRequestId: number | null;
  readonly policyVersion: string;
  readonly authorisedAt: string;
  readonly expiresAt: string;
  /** JSON column ({allocationKey, amountMinor}[]) — the authorised target. */
  readonly allocations: unknown;
  readonly createdAt: string;
}

export interface BudgetPortfolioWriteResult {
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

// ─── Snapshots ───

export async function findSnapshotRow(
  userId: number,
  portfolioSnapshotId: string,
  executor: BudgetPortfolioStoreExecutor
): Promise<BudgetPortfolioSnapshotRow | null> {
  const [row] = (await executor
    .select()
    .from(budgetPortfolioSnapshots)
    .where(and(eq("userId", userId), eq("portfolioSnapshotId", portfolioSnapshotId)))
    .limit(1)) as unknown[];
  return (row as BudgetPortfolioSnapshotRow | undefined) ?? null;
}

export async function listSnapshotRows(
  userId: number,
  businessId: number,
  limit: number,
  executor: BudgetPortfolioStoreExecutor
): Promise<BudgetPortfolioSnapshotRow[]> {
  return (await executor
    .select()
    .from(budgetPortfolioSnapshots)
    .where(and(eq("userId", userId), eq("businessId", businessId)))
    .orderBy(desc("capturedAt"), desc("createdAt"))
    .limit(limit)) as unknown as BudgetPortfolioSnapshotRow[];
}

export async function insertSnapshot(
  row: BudgetPortfolioSnapshotRow,
  executor: BudgetPortfolioStoreExecutor
): Promise<BudgetPortfolioWriteResult> {
  try {
    await executor.insert(budgetPortfolioSnapshots).values({ ...row });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findSnapshotRow(Number(row.userId), row.portfolioSnapshotId, executor);
    if (existing) return { inserted: false, duplicateClassification: "idempotent_replay" };
    throw err;
  }
  return { inserted: true, duplicateClassification: "none" };
}

// ─── Proposals ───

export async function findProposalRow(
  userId: number,
  optimisationId: string,
  executor: BudgetPortfolioStoreExecutor
): Promise<BudgetPortfolioProposalRow | null> {
  const [row] = (await executor
    .select()
    .from(budgetPortfolioProposals)
    .where(and(eq("userId", userId), eq("optimisationId", optimisationId)))
    .limit(1)) as unknown[];
  return (row as BudgetPortfolioProposalRow | undefined) ?? null;
}

export async function listProposalRows(
  userId: number,
  businessId: number,
  status: OptimisationProposalStatus | undefined,
  limit: number,
  executor: BudgetPortfolioStoreExecutor
): Promise<BudgetPortfolioProposalRow[]> {
  const predicates = [eq("userId", userId), eq("businessId", businessId)];
  if (status !== undefined) predicates.push(eq("status", status));
  return (await executor
    .select()
    .from(budgetPortfolioProposals)
    .where(and(...predicates))
    .orderBy(desc("createdAt"))
    .limit(limit)) as unknown as BudgetPortfolioProposalRow[];
}

export async function insertProposal(
  row: BudgetPortfolioProposalRow,
  executor: BudgetPortfolioStoreExecutor
): Promise<BudgetPortfolioWriteResult> {
  try {
    await executor.insert(budgetPortfolioProposals).values({ ...row });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findProposalRow(Number(row.userId), row.optimisationId, executor);
    if (existing) {
      // Conflict detection: same identity, different material is tampering.
      if (existing.proposalContentHash !== row.proposalContentHash) {
        throw new BudgetPortfolioStateConflictError(
          "OPTIMISATION_REPLAY_CONFLICT",
          `optimisation ${row.optimisationId} already exists with different material`
        );
      }
      return { inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  return { inserted: true, duplicateClassification: "none" };
}

export async function updateProposalStatus(
  userId: number,
  optimisationId: string,
  status: OptimisationProposalStatus,
  executor: BudgetPortfolioStoreExecutor
): Promise<void> {
  await executor
    .update(budgetPortfolioProposals)
    .set({ status })
    .where(and(eq("userId", userId), eq("optimisationId", optimisationId)));
}

// ─── Authorised instructions ───

export async function findInstructionRow(
  userId: number,
  instructionId: string,
  executor: BudgetPortfolioStoreExecutor
): Promise<BudgetPortfolioInstructionRow | null> {
  const [row] = (await executor
    .select()
    .from(budgetPortfolioAllocationInstructions)
    .where(and(eq("userId", userId), eq("instructionId", instructionId)))
    .limit(1)) as unknown[];
  return (row as BudgetPortfolioInstructionRow | undefined) ?? null;
}

export async function findInstructionByOptimisationRow(
  userId: number,
  optimisationId: string,
  executor: BudgetPortfolioStoreExecutor
): Promise<BudgetPortfolioInstructionRow | null> {
  const [row] = (await executor
    .select()
    .from(budgetPortfolioAllocationInstructions)
    .where(and(eq("userId", userId), eq("optimisationId", optimisationId)))
    .limit(1)) as unknown[];
  return (row as BudgetPortfolioInstructionRow | undefined) ?? null;
}

export async function insertInstruction(
  row: BudgetPortfolioInstructionRow,
  executor: BudgetPortfolioStoreExecutor
): Promise<BudgetPortfolioWriteResult> {
  try {
    await executor.insert(budgetPortfolioAllocationInstructions).values({ ...row });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findInstructionRow(Number(row.userId), row.instructionId, executor);
    if (existing) return { inserted: false, duplicateClassification: "idempotent_replay" };
    throw err;
  }
  return { inserted: true, duplicateClassification: "none" };
}
