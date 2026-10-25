// ─── R6-C Lead Qualification — durable store (contract §2, §10, §11, §12) ───
//
// DB-authoritative persistence over the R6-C-owned tables. Every convergence
// anchor is a durable unique key (no in-memory dedupe): (userId,
// qualificationId) for decisions, (userId, reviewId) + (userId,
// qualificationId) for reviews. Retried or raced writes re-read the committed
// row and converge (idempotent_replay); rows are insert-only — corrections
// are new decisions. Review resolution is optimistic-CAS guarded (version);
// stale writes fail closed (REVIEW_ALREADY_RESOLVED).
//
// The canonical tables live in @db/schema (single source of truth; the 0034
// migration artefact is provisional — NOT executed; see
// docs/recovery/r6-c-unexecuted-migrations.md; R6-X owns canonical
// sequencing). Every call site supplies an executor through the structural
// seam below — the same select/insert/update chain shape a Drizzle client or
// transaction callback provides. The bridge binds a real client/tx to these
// handles (translating the local predicate descriptors to Drizzle SQL);
// tests bind the in-memory fake.

import {
  leadQualificationReviews,
  leadQualifications,
} from "@db/schema";
import {
  QualificationInputError,
  QualificationStateConflictError,
  type QualificationDuplicateClassification,
} from "./qualification-contract";

// ─── Table handles (canonical @db/schema imports — single source of truth) ───

/**
 * The R6-C schema tables. Rows travel the seam as `unknown` and are viewed
 * through the structural row types below; real Drizzle tables carry
 * Symbol.for("drizzle:Name"), which the executor implementations key on.
 */
export type QualificationTableHandle =
  | typeof leadQualifications
  | typeof leadQualificationReviews;

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

export interface QualificationRowQuery {
  readonly all: () => Promise<unknown[]>;
  readonly limit: (n: number) => Promise<unknown[]>;
  readonly orderBy: (...terms: StoreOrderTerm[]) => QualificationRowQuery;
}

export interface QualificationSelectTarget {
  readonly where: (predicate: StorePredicate) => QualificationRowQuery;
  readonly orderBy: (...terms: StoreOrderTerm[]) => QualificationRowQuery;
  readonly all: () => Promise<unknown[]>;
  readonly limit: (n: number) => Promise<unknown[]>;
}

/**
 * Structural seam: the bridge binds a Drizzle client / transaction callback
 * to this select/insert/update chain shape (translating the local predicate
 * descriptors below into Drizzle SQL over the canonical @db/schema tables);
 * tests bind the table-name-keyed in-memory fake.
 */
export interface QualificationStoreExecutor {
  readonly select: () => { readonly from: (table: QualificationTableHandle) => QualificationSelectTarget };
  readonly insert: (
    table: QualificationTableHandle
  ) => { readonly values: (row: Record<string, unknown>) => Promise<unknown> };
  readonly update: (
    table: QualificationTableHandle
  ) => {
    readonly set: (patch: Record<string, unknown>) => {
      readonly where: (predicate: StorePredicate) => Promise<unknown>;
    };
  };
}

// ─── Row types (contract §2 record + §10 review record) ───

export interface LeadQualificationRow {
  readonly qualificationId: string;
  readonly contractVersion: string;
  readonly engineVersion: string;
  readonly userId: number;
  readonly businessId: number | null;
  readonly leadId: string;
  readonly leadIdentityVersion: string;
  readonly identityReference: string;
  readonly leadScoreId: string;
  readonly scoringVersion: string;
  readonly scoreContentHash: string;
  readonly qualificationPolicyVersion: string;
  readonly evidenceSnapshotHash: string;
  /** JSON column (QualificationEvidenceSnapshot); carried as a JS value here. */
  readonly evidenceSnapshot: unknown;
  readonly decision: string;
  /** JSON column (string[]); carried as a JS value here. */
  readonly reasonCodes: unknown;
  readonly confidenceScore: number;
  readonly reviewRequired: boolean;
  readonly evaluatedAt: string;
  readonly validUntil: string;
  readonly createdAt: string;
}

export interface LeadQualificationReviewRow {
  readonly reviewId: string;
  readonly userId: number;
  readonly businessId: number | null;
  readonly leadId: string;
  readonly qualificationId: string;
  readonly decisionBindingHash: string;
  readonly status: string;
  /** JSON column (string[]); carried as a JS value here. */
  readonly triggerReasonCodes: unknown;
  readonly resolvedBy: number | null;
  readonly resolvedAt: string | null;
  readonly resolutionReason: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type InsertLeadQualificationRow = LeadQualificationRow;
export type InsertLeadQualificationReviewRow = LeadQualificationReviewRow;

export interface QualificationWriteResult {
  readonly inserted: boolean;
  readonly duplicateClassification: QualificationDuplicateClassification;
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

function affectedRowsOf(result: unknown): number {
  const header = result as Record<string, unknown> | null;
  if (!header || typeof header !== "object") return 0;
  return Number(header.affectedRows ?? header.rowsAffected ?? 0);
}

// ─── Qualification decisions (insert-only, exact-once) ───

async function findQualificationRow(
  userId: number,
  qualificationId: string,
  executor: QualificationStoreExecutor
): Promise<LeadQualificationRow | null> {
  const [row] = (await executor
    .select()
    .from(leadQualifications)
    .where(and(eq("userId", userId), eq("qualificationId", qualificationId)))
    .limit(1)) as unknown[];
  return (row as LeadQualificationRow | undefined) ?? null;
}

/**
 * Insert under the durable convergence anchor unique (userId,
 * qualificationId). A raced or retried call re-reads the committed row —
 * exactly one decision ever exists per identity binding.
 */
export async function insertQualification(
  row: InsertLeadQualificationRow,
  executor: QualificationStoreExecutor
): Promise<QualificationWriteResult> {
  try {
    await executor.insert(leadQualifications).values({ ...row });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findQualificationRow(Number(row.userId), row.qualificationId, executor);
    if (existing) {
      return { inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  return { inserted: true, duplicateClassification: "none" };
}

export async function getQualification(
  userId: number,
  qualificationId: string,
  executor: QualificationStoreExecutor
): Promise<LeadQualificationRow> {
  const row = await findQualificationRow(userId, qualificationId, executor);
  if (!row) {
    throw new QualificationInputError(
      "QUALIFICATION_NOT_FOUND",
      `qualification ${qualificationId} not found for user ${userId}`
    );
  }
  return row;
}

/** Immutable decision history for a lead, oldest-first (fully deterministic). */
export async function listQualificationHistory(
  userId: number,
  leadId: string,
  executor: QualificationStoreExecutor
): Promise<LeadQualificationRow[]> {
  const rows = await executor
    .select()
    .from(leadQualifications)
    .where(and(eq("userId", userId), eq("leadId", leadId)))
    .orderBy(asc("evaluatedAt"), asc("qualificationId"))
    .all();
  return rows as unknown as LeadQualificationRow[];
}

/** The lead's current decision (latest by evaluatedAt, deterministic tiebreak). */
export async function getLatestQualification(
  userId: number,
  leadId: string,
  executor: QualificationStoreExecutor
): Promise<LeadQualificationRow | null> {
  const [row] = (await executor
    .select()
    .from(leadQualifications)
    .where(and(eq("userId", userId), eq("leadId", leadId)))
    .orderBy(desc("evaluatedAt"), desc("qualificationId"))
    .limit(1)) as unknown[];
  return (row as LeadQualificationRow | undefined) ?? null;
}

// ─── Reviews (one per decision, CAS-guarded) ───

async function findReviewRow(
  userId: number,
  reviewId: string,
  executor: QualificationStoreExecutor
): Promise<LeadQualificationReviewRow | null> {
  const [row] = (await executor
    .select()
    .from(leadQualificationReviews)
    .where(and(eq("userId", userId), eq("reviewId", reviewId)))
    .limit(1)) as unknown[];
  return (row as LeadQualificationReviewRow | undefined) ?? null;
}

export async function getReviewByQualification(
  userId: number,
  qualificationId: string,
  executor: QualificationStoreExecutor
): Promise<LeadQualificationReviewRow | null> {
  const [row] = (await executor
    .select()
    .from(leadQualificationReviews)
    .where(and(eq("userId", userId), eq("qualificationId", qualificationId)))
    .limit(1)) as unknown[];
  return (row as LeadQualificationReviewRow | undefined) ?? null;
}

/** Insert under the durable anchors unique (userId, reviewId)/(userId, qualificationId). */
export async function insertReview(
  row: InsertLeadQualificationReviewRow,
  executor: QualificationStoreExecutor
): Promise<QualificationWriteResult> {
  try {
    await executor.insert(leadQualificationReviews).values({ ...row });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findReviewRow(Number(row.userId), row.reviewId, executor);
    if (existing) {
      return { inserted: false, duplicateClassification: "idempotent_replay" };
    }
    // One review per decision: a duplicate under (userId, qualificationId)
    // converges onto the existing review for the same decision.
    const existingForDecision = await getReviewByQualification(
      Number(row.userId),
      row.qualificationId,
      executor
    );
    if (existingForDecision) {
      return { inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  return { inserted: true, duplicateClassification: "none" };
}

export async function getReview(
  userId: number,
  reviewId: string,
  executor: QualificationStoreExecutor
): Promise<LeadQualificationReviewRow> {
  const row = await findReviewRow(userId, reviewId, executor);
  if (!row) {
    throw new QualificationInputError(
      "REVIEW_NOT_FOUND",
      `review ${reviewId} not found for user ${userId}`
    );
  }
  return row;
}

export async function listReviews(
  userId: number,
  filters: { leadId?: string; status?: string },
  executor: QualificationStoreExecutor
): Promise<LeadQualificationReviewRow[]> {
  const conditions = [eq("userId", userId)];
  if (filters.leadId !== undefined) conditions.push(eq("leadId", filters.leadId));
  if (filters.status !== undefined) conditions.push(eq("status", filters.status));
  const rows = await executor
    .select()
    .from(leadQualificationReviews)
    .where(and(...conditions))
    .orderBy(asc("createdAt"), asc("reviewId"))
    .all();
  return rows as unknown as LeadQualificationReviewRow[];
}

export interface ReviewResolutionPatch {
  readonly status: string;
  readonly resolvedBy: number;
  readonly resolvedAt: string;
  readonly resolutionReason: string;
}

/**
 * Optimistic-CAS resolution. The version predicate makes exactly one
 * resolution possible; any raced or repeated call affects zero rows and
 * fails closed — a review is resolved at most once.
 */
export async function updateReviewResolution(
  userId: number,
  reviewId: string,
  expectedVersion: number,
  patch: ReviewResolutionPatch,
  executor: QualificationStoreExecutor
): Promise<LeadQualificationReviewRow> {
  const result = await executor
    .update(leadQualificationReviews)
    .set({
      status: patch.status,
      resolvedBy: patch.resolvedBy,
      resolvedAt: patch.resolvedAt,
      resolutionReason: patch.resolutionReason,
      version: expectedVersion + 1,
      updatedAt: patch.resolvedAt,
    })
    .where(
      and(eq("userId", userId), eq("reviewId", reviewId), eq("version", expectedVersion))
    );
  if (affectedRowsOf(result) === 0) {
    throw new QualificationStateConflictError(
      "REVIEW_ALREADY_RESOLVED",
      `review ${reviewId} is not at version ${expectedVersion}; already resolved or stale. Stale write rejected.`
    );
  }
  const updated = await findReviewRow(userId, reviewId, executor);
  if (!updated) {
    throw new QualificationStateConflictError(
      "REVIEW_ALREADY_RESOLVED",
      `review ${reviewId} disappeared during resolution; refusing ambiguous outcome.`
    );
  }
  return updated;
}
