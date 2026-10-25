// ─── R6-B Lead Scoring — durable store (B7 exact-once convergence) ───
//
// DB-authoritative persistence. Every convergence anchor is a durable unique
// key (no in-memory dedupe): (userId, leadId, evidenceSnapshotHash,
// scoringVersion) plus leadScoreId. Duplicate and concurrent scoring
// converge to one row; the loser re-reads (idempotent_replay). Rows are
// insert-only — historical scores are immutable. Snapshot hash drift on read
// is tampering and fails closed (SCORING_EVIDENCE_TAMPERED).

import { and, asc, eq } from "drizzle-orm";
import {
  leadScoreSnapshots,
  type LeadScoreSnapshotRow,
  type InsertLeadScoreSnapshotRow,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  ScoringTamperError,
  sha256Hex,
  canonicalJson,
  type ScoringDuplicateClassification,
} from "./scoring-contract";

type Db = ReturnType<typeof getDb>;

export interface ScoringStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
}

function resolveDb(executor?: ScoringStoreExecutor): ScoringStoreExecutor {
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

export interface ScoreWriteResult {
  row: LeadScoreSnapshotRow;
  inserted: boolean;
  duplicateClassification: ScoringDuplicateClassification;
}

/** Recompute the manifest hash — drift between stored row and hash is tampering. */
export function assertSnapshotIntegrity(row: LeadScoreSnapshotRow): void {
  const storedManifest = Array.isArray(row.evidenceManifest)
    ? (row.evidenceManifest as unknown[])
    : [];
  const expected = sha256Hex(canonicalJson(storedManifest));
  if (expected !== row.evidenceSnapshotHash) {
    throw new ScoringTamperError(
      "SCORING_EVIDENCE_TAMPERED",
      `lead_score_snapshots row ${row.id} evidence manifest hash drift detected; refusing to serve tampered score.`
    );
  }
}

export async function findScoreByLeadScoreId(
  userId: number,
  leadScoreId: string,
  executor?: ScoringStoreExecutor
): Promise<LeadScoreSnapshotRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(leadScoreSnapshots)
    .where(and(eq(leadScoreSnapshots.userId, userId), eq(leadScoreSnapshots.leadScoreId, leadScoreId)))
    .limit(1);
  if (row) assertSnapshotIntegrity(row);
  return row ?? null;
}

export async function findScoreByConvergenceKey(
  userId: number,
  leadId: number,
  evidenceSnapshotHash: string,
  scoringVersion: string,
  executor?: ScoringStoreExecutor
): Promise<LeadScoreSnapshotRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(leadScoreSnapshots)
    .where(
      and(
        eq(leadScoreSnapshots.userId, userId),
        eq(leadScoreSnapshots.leadId, leadId),
        eq(leadScoreSnapshots.evidenceSnapshotHash, evidenceSnapshotHash),
        eq(leadScoreSnapshots.scoringVersion, scoringVersion)
      )
    )
    .limit(1);
  if (row) assertSnapshotIntegrity(row);
  return row ?? null;
}

/**
 * Insert under the durable convergence unique key. A raced or retried call
 * re-reads the existing row — exactly one score ever exists per identity.
 */
export async function insertScore(
  row: InsertLeadScoreSnapshotRow,
  executor?: ScoringStoreExecutor
): Promise<ScoreWriteResult> {
  const db = resolveDb(executor);
  try {
    await db.insert(leadScoreSnapshots).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findScoreByConvergenceKey(
      Number(row.userId),
      Number(row.leadId),
      row.evidenceSnapshotHash,
      row.scoringVersion,
      executor
    );
    if (existing) {
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await findScoreByConvergenceKey(
    Number(row.userId),
    Number(row.leadId),
    row.evidenceSnapshotHash,
    row.scoringVersion,
    executor
  );
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

/** Immutable score history for a lead (oldest first). */
export async function listScoresForLead(
  userId: number,
  leadId: number,
  executor?: ScoringStoreExecutor
): Promise<LeadScoreSnapshotRow[]> {
  const db = resolveDb(executor);
  const rows = await db
    .select()
    .from(leadScoreSnapshots)
    .where(and(eq(leadScoreSnapshots.userId, userId), eq(leadScoreSnapshots.leadId, leadId)))
    .orderBy(asc(leadScoreSnapshots.createdAt), asc(leadScoreSnapshots.id));
  for (const row of rows) assertSnapshotIntegrity(row);
  return rows;
}
