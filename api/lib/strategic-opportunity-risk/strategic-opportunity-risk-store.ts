// ─── R8-E Strategic Opportunity & Risk — durable store ───
//
// DB-authoritative persistence over the R8-E-owned tables. Convergence
// anchors are the durable unique keys (userId, candidateId): retried or
// raced writes re-read the committed row and converge (idempotent_replay);
// a stored row under the same anchor with a different material fingerprint
// fails closed (CANDIDATE_REPLAY_CONFLICT). Candidate rows are immutable in
// their material core — corrections are NEW superseding candidates; only
// the lifecycle status (and derived approval view) transitions in place,
// guarded by an optimistic version CAS. Lifecycle history is append-only.
//
// The canonical tables live in @db/schema (single source of truth; the 0036
// migration artefact is provisional — NOT executed; R8-X owns canonical
// sequencing). The structural executor seam matches the AuditDbExecutor
// convention.

import { and, eq } from "drizzle-orm";
import {
  strategicOpportunityRiskCandidates,
  strategicOpportunityRiskLifecycleEvents,
  strategicOpportunityRiskRelations,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import { fail } from "./strategic-opportunity-risk-contract";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface StrategicOpportunityRiskStoreExecutor {
  readonly select: Db["select"];
  readonly insert: Db["insert"];
  readonly update: Db["update"];
}

/** Bind a Drizzle client or transaction callback to the executor seam. */
export function bindStrategicOpportunityRiskStoreExecutor(
  db: Pick<Db, "select" | "insert" | "update">
): StrategicOpportunityRiskStoreExecutor {
  return db as StrategicOpportunityRiskStoreExecutor;
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

// ─── Candidate rows ───

export interface StrategicCandidateRow {
  readonly candidateId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly candidateKind: string;
  readonly candidateType: string;
  readonly reasoningIds: unknown;
  readonly memoryRefs: unknown;
  readonly changeRefs: unknown;
  readonly signalRefs: unknown;
  readonly supportingEvidence: unknown;
  readonly contradictingEvidence: unknown;
  readonly anchorRefs: unknown;
  readonly subjectKey: string;
  readonly evidenceBundleFingerprint: string;
  readonly candidateFingerprint: string;
  readonly impactClass: string;
  readonly urgencyClass: string;
  readonly timeHorizon: string;
  readonly confidenceClass: string;
  readonly evidenceQualityScore: number;
  readonly priorityScore: number;
  readonly priorityClass: string;
  readonly strategicRiskClass: string | null;
  readonly governanceDecisionId: string | null;
  readonly governanceDecision: string | null;
  readonly governanceRecord: unknown;
  readonly policyVersion: string | null;
  readonly approvalStatus: string;
  readonly status: string;
  readonly portfolioRelation: string;
  readonly relationCandidateIds: unknown;
  readonly derivationOutcome: string;
  readonly limitations: unknown;
  readonly validUntil: string | null;
  readonly supersedesCandidateId: string | null;
  readonly sourceVersions: unknown;
  readonly version: number;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
}

export async function getStrategicCandidate(
  executor: StrategicOpportunityRiskStoreExecutor,
  userId: number,
  candidateId: string
): Promise<StrategicCandidateRow | null> {
  const rows = await executor
    .select()
    .from(strategicOpportunityRiskCandidates)
    .where(
      and(
        eq(strategicOpportunityRiskCandidates.userId, userId),
        eq(strategicOpportunityRiskCandidates.candidateId, candidateId)
      )
    )
    .limit(1);
  return (rows[0] as unknown as StrategicCandidateRow | undefined) ?? null;
}

export async function insertStrategicCandidate(
  executor: StrategicOpportunityRiskStoreExecutor,
  row: StrategicCandidateRow
): Promise<{ inserted: boolean }> {
  const existing = await getStrategicCandidate(executor, row.userId, row.candidateId);
  if (existing) {
    if (existing.candidateFingerprint !== row.candidateFingerprint) {
      fail(
        "CANDIDATE_REPLAY_CONFLICT",
        `candidate ${row.candidateId} exists with a different material fingerprint — conflicting replay`
      );
    }
    return { inserted: false };
  }
  try {
    const { createdAt: _c, updatedAt: _u, ...insertRow } = row;
    void _c;
    void _u;
    await executor.insert(strategicOpportunityRiskCandidates).values(insertRow as never);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const raced = await getStrategicCandidate(executor, row.userId, row.candidateId);
    if (raced && raced.candidateFingerprint === row.candidateFingerprint) return { inserted: false };
    fail("CANDIDATE_REPLAY_CONFLICT", `candidate ${row.candidateId} raced with conflicting material`);
  }
  return { inserted: true };
}

export interface ListStrategicCandidatesFilter {
  readonly businessId?: number;
  readonly status?: string;
  readonly candidateKind?: string;
  readonly priorityClass?: string;
}

export async function listStrategicCandidateRows(
  executor: StrategicOpportunityRiskStoreExecutor,
  userId: number,
  filter: ListStrategicCandidatesFilter
): Promise<StrategicCandidateRow[]> {
  const rows = await executor
    .select()
    .from(strategicOpportunityRiskCandidates)
    .where(eq(strategicOpportunityRiskCandidates.userId, userId));
  return (rows as unknown as StrategicCandidateRow[]).filter((r) => {
    if (filter.businessId !== undefined && r.businessId !== filter.businessId) return false;
    if (filter.status !== undefined && r.status !== filter.status) return false;
    if (filter.candidateKind !== undefined && r.candidateKind !== filter.candidateKind) return false;
    if (filter.priorityClass !== undefined && r.priorityClass !== filter.priorityClass) return false;
    return true;
  });
}

/** Optimistic-CAS status transition; concurrent drift fails closed. */
export async function transitionStrategicCandidateStatus(
  executor: StrategicOpportunityRiskStoreExecutor,
  input: {
    userId: number;
    candidateId: string;
    expectedVersion: number;
    nextStatus: string;
    nextApprovalStatus?: string;
    nextCandidateFingerprint?: string;
  }
): Promise<void> {
  const current = await getStrategicCandidate(executor, input.userId, input.candidateId);
  if (!current) fail("CANDIDATE_NOT_FOUND", `candidate ${input.candidateId} not found`);
  if (current.version !== input.expectedVersion) {
    fail("LIFECYCLE_CONFLICT", `candidate ${input.candidateId} version drift — concurrent lifecycle transition`);
  }
  const set: Record<string, unknown> = {
    status: input.nextStatus,
    version: input.expectedVersion + 1,
  };
  if (input.nextApprovalStatus !== undefined) set.approvalStatus = input.nextApprovalStatus;
  if (input.nextCandidateFingerprint !== undefined) set.candidateFingerprint = input.nextCandidateFingerprint;
  const result = await executor
    .update(strategicOpportunityRiskCandidates)
    .set(set as never)
    .where(
      and(
        eq(strategicOpportunityRiskCandidates.userId, input.userId),
        eq(strategicOpportunityRiskCandidates.candidateId, input.candidateId),
        eq(strategicOpportunityRiskCandidates.version, input.expectedVersion)
      )
    );
  const affected = Array.isArray(result) ? result.length : Number((result as { affectedRows?: number })?.affectedRows ?? 0);
  if (affected === 0) {
    fail("LIFECYCLE_CONFLICT", `candidate ${input.candidateId} CAS transition lost — concurrent lifecycle change`);
  }
}

// ─── Relation rows ───

export interface StrategicCandidateRelationRow {
  readonly relationId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly candidateId: string;
  readonly relatedCandidateId: string;
  readonly relation: string;
  readonly createdAt?: unknown;
}

export async function insertStrategicCandidateRelation(
  executor: StrategicOpportunityRiskStoreExecutor,
  row: StrategicCandidateRelationRow
): Promise<{ inserted: boolean }> {
  const rows = await executor
    .select()
    .from(strategicOpportunityRiskRelations)
    .where(eq(strategicOpportunityRiskRelations.relationId, row.relationId))
    .limit(1);
  if (rows.length > 0) return { inserted: false };
  try {
    const { createdAt: _c, ...insertRow } = row;
    void _c;
    await executor.insert(strategicOpportunityRiskRelations).values(insertRow as never);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    return { inserted: false };
  }
  return { inserted: true };
}

export async function listStrategicCandidateRelationRows(
  executor: StrategicOpportunityRiskStoreExecutor,
  userId: number,
  candidateId: string
): Promise<StrategicCandidateRelationRow[]> {
  const rows = await executor
    .select()
    .from(strategicOpportunityRiskRelations)
    .where(eq(strategicOpportunityRiskRelations.candidateId, candidateId));
  return (rows as unknown as StrategicCandidateRelationRow[]).filter((r) => r.userId === userId);
}

// ─── Lifecycle rows (append-only) ───

export interface StrategicCandidateLifecycleRow {
  readonly lifecycleEventId: string;
  readonly userId: number;
  readonly candidateId: string;
  readonly lifecycleType: string;
  readonly targetStatus: string;
  readonly successorCandidateId: string | null;
  readonly occurredAt: string;
  readonly reasonCode: string | null;
  readonly createdAt?: unknown;
}

export async function insertStrategicCandidateLifecycleEvent(
  executor: StrategicOpportunityRiskStoreExecutor,
  row: StrategicCandidateLifecycleRow
): Promise<{ inserted: boolean }> {
  const rows = await executor
    .select()
    .from(strategicOpportunityRiskLifecycleEvents)
    .where(eq(strategicOpportunityRiskLifecycleEvents.lifecycleEventId, row.lifecycleEventId))
    .limit(1);
  if (rows.length > 0) return { inserted: false };
  try {
    const { createdAt: _c, ...insertRow } = row;
    void _c;
    await executor.insert(strategicOpportunityRiskLifecycleEvents).values(insertRow as never);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    return { inserted: false };
  }
  return { inserted: true };
}

export async function listStrategicCandidateLifecycleRows(
  executor: StrategicOpportunityRiskStoreExecutor,
  userId: number,
  candidateId: string
): Promise<StrategicCandidateLifecycleRow[]> {
  const rows = await executor
    .select()
    .from(strategicOpportunityRiskLifecycleEvents)
    .where(eq(strategicOpportunityRiskLifecycleEvents.candidateId, candidateId));
  return (rows as unknown as StrategicCandidateLifecycleRow[]).filter(
    (r) => r.userId === userId
  );
}
