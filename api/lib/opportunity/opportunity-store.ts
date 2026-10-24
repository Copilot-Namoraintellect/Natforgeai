// ─── R5-D Opportunity Detection — durable store (contract §5, §7, §10, §11) ───
//
// DB-authoritative persistence. Every convergence anchor is a durable unique
// key (no in-memory dedupe): (userId, opportunityKey) for candidates,
// interpretationId for evidence/suppressions, (userId, opportunityId) for
// handoffs. State transitions are optimistic-CAS guarded (version); stale or
// illegal writes fail closed. Evidence is append-only and hash-verified on
// read — drift is tampering (OPPORTUNITY_EVIDENCE_CONFLICT).
//
// Optional caller executor seam (same discipline as audit-store): the default
// getDb() client and a transaction callback client both satisfy the shape.

import { and, eq, lt, gte, sql } from "drizzle-orm";
import {
  opportunityCandidates,
  opportunityEvidence,
  opportunitySuppressions,
  opportunityHandoffs,
  type OpportunityCandidateRow,
  type OpportunityEvidenceRow,
  type OpportunitySuppressionRow,
  type OpportunityHandoffRow,
  type InsertOpportunityCandidateRow,
  type InsertOpportunityEvidenceRow,
  type InsertOpportunitySuppressionRow,
  type InsertOpportunityHandoffRow,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  OpportunityStateConflictError,
  OpportunityTamperError,
  type OpportunityDuplicateClassification,
} from "./opportunity-contract";
import { deriveEvidenceHash } from "./opportunity-identity";

type Db = ReturnType<typeof getDb>;

export interface OpportunityStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
}

function resolveDb(executor?: OpportunityStoreExecutor): OpportunityStoreExecutor {
  return executor ?? getDb();
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

export interface StoreWriteResult<T> {
  row: T;
  inserted: boolean;
  duplicateClassification: OpportunityDuplicateClassification;
}

// ─── Evidence (immutable, hash-verified) ───

export function assertEvidenceIntegrity(row: OpportunityEvidenceRow): void {
  const expected = deriveEvidenceHash({
    candidateId: Number(row.candidateId),
    interpretationId: row.interpretationId,
    signalId: row.signalId,
    signalVersion: row.signalVersion,
    kind: row.kind,
    engagementReceiptId: row.engagementReceiptId ?? null,
    opportunityTypeAtEvaluation: row.opportunityTypeAtEvaluation,
    intent: row.intent,
    overallConfidence: row.overallConfidence,
    relevance: row.relevance,
    sentiment: row.sentiment,
    urgency: row.urgency,
    sourceCampaignId: row.sourceCampaignId ? Number(row.sourceCampaignId) : null,
    occurredAt: row.occurredAt,
  });
  if (expected !== row.evidenceHash) {
    throw new OpportunityTamperError(
      "OPPORTUNITY_EVIDENCE_CONFLICT",
      `opportunity_evidence row ${row.id} hash drift detected; refusing to use tampered evidence.`
    );
  }
}

export async function findEvidenceByInterpretation(
  userId: number,
  interpretationId: string,
  kind: "signal_interpretation" | "engagement_receipt" = "signal_interpretation",
  executor?: OpportunityStoreExecutor
): Promise<OpportunityEvidenceRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(opportunityEvidence)
    .where(
      and(
        eq(opportunityEvidence.userId, userId),
        eq(opportunityEvidence.interpretationId, interpretationId),
        eq(opportunityEvidence.kind, kind)
      )
    )
    .limit(1);
  if (row) assertEvidenceIntegrity(row);
  return row ?? null;
}

export async function listEvidenceForCandidate(
  candidateId: number,
  executor?: OpportunityStoreExecutor
): Promise<OpportunityEvidenceRow[]> {
  const db = resolveDb(executor);
  const rows = await db
    .select()
    .from(opportunityEvidence)
    .where(eq(opportunityEvidence.candidateId, candidateId));
  for (const row of rows) assertEvidenceIntegrity(row);
  return rows;
}

export async function findEvidenceByReceiptId(
  userId: number,
  engagementReceiptId: string,
  executor?: OpportunityStoreExecutor
): Promise<OpportunityEvidenceRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(opportunityEvidence)
    .where(
      and(
        eq(opportunityEvidence.userId, userId),
        eq(opportunityEvidence.engagementReceiptId, engagementReceiptId)
      )
    )
    .limit(1);
  if (row) assertEvidenceIntegrity(row);
  return row ?? null;
}

export async function insertEvidence(
  row: InsertOpportunityEvidenceRow,
  executor?: OpportunityStoreExecutor
): Promise<StoreWriteResult<OpportunityEvidenceRow>> {
  const db = resolveDb(executor);
  try {
    await db.insert(opportunityEvidence).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findEvidenceByInterpretation(
      Number(row.userId),
      row.interpretationId,
      row.kind as "signal_interpretation" | "engagement_receipt",
      executor
    );
    if (existing) {
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await findEvidenceByInterpretation(
    Number(row.userId),
    row.interpretationId,
    row.kind as "signal_interpretation" | "engagement_receipt",
    executor
  );
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

// ─── Suppressions (durable evaluation rejections) ───

export async function findSuppressionByInterpretation(
  userId: number,
  interpretationId: string,
  executor?: OpportunityStoreExecutor
): Promise<OpportunitySuppressionRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(opportunitySuppressions)
    .where(
      and(
        eq(opportunitySuppressions.userId, userId),
        eq(opportunitySuppressions.interpretationId, interpretationId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function findThreadSuppressionHistory(
  userId: number,
  threadKey: string,
  sinceIso: string,
  executor?: OpportunityStoreExecutor
): Promise<OpportunitySuppressionRow[]> {
  const db = resolveDb(executor);
  return db
    .select()
    .from(opportunitySuppressions)
    .where(
      and(
        eq(opportunitySuppressions.userId, userId),
        eq(opportunitySuppressions.threadKey, threadKey),
        gte(opportunitySuppressions.occurredAt, sinceIso)
      )
    );
}

export async function insertSuppression(
  row: InsertOpportunitySuppressionRow,
  executor?: OpportunityStoreExecutor
): Promise<StoreWriteResult<OpportunitySuppressionRow>> {
  const db = resolveDb(executor);
  try {
    await db.insert(opportunitySuppressions).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findSuppressionByInterpretation(
      Number(row.userId),
      row.interpretationId,
      executor
    );
    if (existing) {
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await findSuppressionByInterpretation(
    Number(row.userId),
    row.interpretationId,
    executor
  );
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

// ─── Candidates ───

export async function findCandidateByKey(
  userId: number,
  opportunityKey: string,
  executor?: OpportunityStoreExecutor
): Promise<OpportunityCandidateRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(opportunityCandidates)
    .where(
      and(
        eq(opportunityCandidates.userId, userId),
        eq(opportunityCandidates.opportunityKey, opportunityKey)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function findCandidateById(
  userId: number,
  id: number,
  executor?: OpportunityStoreExecutor
): Promise<OpportunityCandidateRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(opportunityCandidates)
    .where(and(eq(opportunityCandidates.userId, userId), eq(opportunityCandidates.id, id)))
    .limit(1);
  return row ?? null;
}

export async function findCandidateByOpportunityId(
  userId: number,
  opportunityId: string,
  executor?: OpportunityStoreExecutor
): Promise<OpportunityCandidateRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(opportunityCandidates)
    .where(
      and(
        eq(opportunityCandidates.userId, userId),
        eq(opportunityCandidates.opportunityId, opportunityId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function insertCandidate(
  row: InsertOpportunityCandidateRow,
  executor?: OpportunityStoreExecutor
): Promise<StoreWriteResult<OpportunityCandidateRow>> {
  const db = resolveDb(executor);
  try {
    await db.insert(opportunityCandidates).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Lost the create race: re-read through the durable unique key.
    const existing = await findCandidateByKey(Number(row.userId), row.opportunityKey, executor);
    if (existing) {
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await findCandidateByKey(Number(row.userId), row.opportunityKey, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

export interface CandidateStatePatch {
  opportunityStatus?: OpportunityCandidateRow["opportunityStatus"];
  confidenceClass?: OpportunityCandidateRow["confidenceClass"];
  evidenceStrength?: OpportunityCandidateRow["evidenceStrength"];
  urgency?: OpportunityCandidateRow["urgency"];
  topic?: string | null;
  latestEvidence?: unknown;
  firstObservedAt?: string;
  lastObservedAt?: string;
  evidenceCount?: number;
  contradictionCount?: number;
  detectorRulesVersion?: string;
  classifierVersions?: unknown;
  statusChangedAt?: Date;
  updatedAt?: Date;
  handedOffAt?: Date | null;
}

/**
 * Optimistic-CAS guarded update. Stale writes (version drift) and raced
 * transitions fail closed — stale evidence can never overwrite newer state.
 */
export async function updateCandidateState(
  userId: number,
  id: number,
  expectedVersion: number,
  patch: CandidateStatePatch,
  executor?: OpportunityStoreExecutor
): Promise<OpportunityCandidateRow> {
  const db = resolveDb(executor);
  const set: Record<string, unknown> = { ...patch, version: expectedVersion + 1 };
  const result = await db
    .update(opportunityCandidates)
    .set(set)
    .where(
      and(
        eq(opportunityCandidates.userId, userId),
        eq(opportunityCandidates.id, id),
        eq(opportunityCandidates.version, expectedVersion)
      )
    );
  // MySQL2 update resolves a ResultSetHeader-like object with affectedRows;
  // some drivers expose rowsAffected. Read either, fail closed on absence.
  const header = result as unknown as Record<string, unknown>;
  const affected = Number(header.affectedRows ?? header.rowsAffected ?? 0);
  if (affected === 0) {
    const current = await findCandidateById(userId, id, executor);
    if (!current) {
      throw new OpportunityStateConflictError("STALE_STATE", `candidate ${id} not found for user ${userId}.`);
    }
    throw new OpportunityStateConflictError(
      "STALE_STATE",
      `candidate ${id} is at version ${current.version}; expected ${expectedVersion}. Stale write rejected.`
    );
  }
  const updated = await findCandidateById(userId, id, executor);
  return updated!;
}

export async function listCandidates(
  userId: number,
  filters: { status?: string; opportunityType?: string } = {},
  executor?: OpportunityStoreExecutor
): Promise<OpportunityCandidateRow[]> {
  const db = resolveDb(executor);
  const conditions = [eq(opportunityCandidates.userId, userId)];
  if (filters.status) conditions.push(eq(opportunityCandidates.opportunityStatus, filters.status as never));
  if (filters.opportunityType) {
    conditions.push(eq(opportunityCandidates.opportunityType, filters.opportunityType as never));
  }
  return db.select().from(opportunityCandidates).where(and(...conditions));
}

export async function countRecentCandidatesForActor(
  userId: number,
  actorKey: string,
  sinceMs: number,
  executor?: OpportunityStoreExecutor
): Promise<number> {
  const db = resolveDb(executor);
  const since = new Date(sinceMs);
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(opportunityCandidates)
    .where(
      and(
        eq(opportunityCandidates.userId, userId),
        eq(opportunityCandidates.actorKey, actorKey),
        gte(opportunityCandidates.createdAt, since)
      )
    );
  return Number(rows[0]?.count ?? 0);
}

// ─── Expiry sweep (D8) ───

export async function listActiveCandidatesPastExpiry(
  expiryIso: string,
  executor?: OpportunityStoreExecutor
): Promise<OpportunityCandidateRow[]> {
  const db = resolveDb(executor);
  // Active statuses only; ISO strings compare lexicographically (same format).
  return db
    .select()
    .from(opportunityCandidates)
    .where(
      and(
        lt(opportunityCandidates.lastObservedAt, expiryIso),
        sql`${opportunityCandidates.opportunityStatus} IN ('candidate','strengthening','weak')`
      )
    );
}

// ─── Handoffs (exactly-once, D8/§11) ───

export async function findHandoff(
  userId: number,
  opportunityId: string,
  executor?: OpportunityStoreExecutor
): Promise<OpportunityHandoffRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(opportunityHandoffs)
    .where(
      and(
        eq(opportunityHandoffs.userId, userId),
        eq(opportunityHandoffs.opportunityId, opportunityId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function insertHandoff(
  row: InsertOpportunityHandoffRow,
  executor?: OpportunityStoreExecutor
): Promise<StoreWriteResult<OpportunityHandoffRow>> {
  const db = resolveDb(executor);
  try {
    await db.insert(opportunityHandoffs).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findHandoff(Number(row.userId), row.opportunityId, executor);
    if (existing) {
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await findHandoff(Number(row.userId), row.opportunityId, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

export async function listHandoffs(
  userId: number,
  executor?: OpportunityStoreExecutor
): Promise<OpportunityHandoffRow[]> {
  const db = resolveDb(executor);
  return db.select().from(opportunityHandoffs).where(eq(opportunityHandoffs.userId, userId));
}
