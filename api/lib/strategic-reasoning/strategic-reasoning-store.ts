// ─── R8-D Strategic Reasoning — durable store ───
//
// DB-authoritative persistence over the R8-D-owned tables. Convergence
// anchors are the durable unique keys (userId, bundleId) and (userId,
// reasoningId): retried or raced writes re-read the committed row and
// converge (idempotent_replay); a stored row under the same anchor with
// different material fails closed (REASONING_REPLAY_CONFLICT). Rows are
// insert-only — corrections are new reasoning records that supersede.
//
// The canonical tables live in @db/schema (single source of truth; the 0036
// migration artefact is provisional — NOT executed; R8-X owns canonical
// sequencing). The structural executor seam matches the AuditDbExecutor
// convention: a Drizzle client / transaction callback and the in-memory
// fake both satisfy it.

import { and, eq } from "drizzle-orm";
import {
  strategicReasoningBundles,
  strategicReasoningLifecycleEvents,
  strategicReasoningRecords,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import { fail } from "./strategic-reasoning-contract";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface StrategicReasoningStoreExecutor {
  readonly select: Db["select"];
  readonly insert: Db["insert"];
}

/** Bind a Drizzle client or transaction callback to the executor seam. */
export function bindStrategicReasoningStoreExecutor(
  db: Pick<Db, "select" | "insert">
): StrategicReasoningStoreExecutor {
  return db as StrategicReasoningStoreExecutor;
}

// ─── Bundle rows ───

export interface StrategicReasoningBundleRow {
  readonly bundleId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly evidenceRefs: unknown;
  readonly evidenceFingerprint: string;
  readonly reasoningGraph: unknown;
  readonly sourceVersions: unknown;
  readonly createdAt?: string;
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

export async function getStrategicReasoningBundle(
  executor: StrategicReasoningStoreExecutor,
  userId: number,
  bundleId: string
): Promise<StrategicReasoningBundleRow | null> {
  const rows = await executor
    .select()
    .from(strategicReasoningBundles)
    .where(and(eq(strategicReasoningBundles.userId, userId), eq(strategicReasoningBundles.bundleId, bundleId)))
    .limit(1);
  return (rows[0] as unknown as StrategicReasoningBundleRow | undefined) ?? null;
}

export async function insertStrategicReasoningBundle(
  executor: StrategicReasoningStoreExecutor,
  row: StrategicReasoningBundleRow
): Promise<{ inserted: boolean }> {
  const existing = await getStrategicReasoningBundle(executor, row.userId, row.bundleId);
  if (existing) {
    if (existing.evidenceFingerprint !== row.evidenceFingerprint) {
      fail(
        "EVIDENCE_FINGERPRINT_MISMATCH",
        `bundle ${row.bundleId} exists with a different evidence fingerprint — tampered evidence material`
      );
    }
    return { inserted: false };
  }
  try {
    const { createdAt: _createdAt1, ...bundleRow } = row;
    void _createdAt1;
    await executor.insert(strategicReasoningBundles).values(bundleRow);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const raced = await getStrategicReasoningBundle(executor, row.userId, row.bundleId);
    if (raced && raced.evidenceFingerprint === row.evidenceFingerprint) return { inserted: false };
    fail("EVIDENCE_FINGERPRINT_MISMATCH", `bundle ${row.bundleId} raced with conflicting material`);
  }
  return { inserted: true };
}

// ─── Reasoning record rows ───

export interface StrategicReasoningRecordRow {
  readonly reasoningId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly bundleId: string;
  readonly hypothesisId: string;
  readonly hypothesisType: string;
  readonly implicationType: string;
  readonly supportingEvidence: unknown;
  readonly contradictingEvidence: unknown;
  readonly missingEvidence: unknown;
  readonly confidenceClass: string;
  readonly uncertaintyClasses: unknown;
  readonly strategicRiskClass: string | null;
  readonly status: string;
  readonly governanceDecisionId: string | null;
  readonly governanceDecision: string | null;
  readonly governanceDecisionRecord: unknown;
  readonly policyVersion: string | null;
  readonly evidenceFingerprint: string;
  readonly reasoningFingerprint: string;
  readonly limitations: unknown;
  readonly validUntil: string | null;
  readonly supersedesReasoningId: string | null;
  readonly sourceVersions: unknown;
  readonly createdAt?: string;
}

export async function getStrategicReasoningRecord(
  executor: StrategicReasoningStoreExecutor,
  userId: number,
  reasoningId: string
): Promise<StrategicReasoningRecordRow | null> {
  const rows = await executor
    .select()
    .from(strategicReasoningRecords)
    .where(and(eq(strategicReasoningRecords.userId, userId), eq(strategicReasoningRecords.reasoningId, reasoningId)))
    .limit(1);
  return (rows[0] as unknown as StrategicReasoningRecordRow | undefined) ?? null;
}

export async function insertStrategicReasoningRecord(
  executor: StrategicReasoningStoreExecutor,
  row: StrategicReasoningRecordRow
): Promise<{ inserted: boolean }> {
  const existing = await getStrategicReasoningRecord(executor, row.userId, row.reasoningId);
  if (existing) {
    if (existing.reasoningFingerprint !== row.reasoningFingerprint) {
      fail(
        "REASONING_REPLAY_CONFLICT",
        `reasoning ${row.reasoningId} exists with different material — conflicting replay is refused`
      );
    }
    return { inserted: false };
  }
  try {
    const { createdAt: _createdAt2, ...recordRow } = row;
    void _createdAt2;
    await executor.insert(strategicReasoningRecords).values(recordRow);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const raced = await getStrategicReasoningRecord(executor, row.userId, row.reasoningId);
    if (raced && raced.reasoningFingerprint === row.reasoningFingerprint) return { inserted: false };
    fail("REASONING_REPLAY_CONFLICT", `reasoning ${row.reasoningId} raced with conflicting material`);
  }
  return { inserted: true };
}

export async function listStrategicReasoningRecords(
  executor: StrategicReasoningStoreExecutor,
  input: { userId: number; businessId?: number; status?: string; hypothesisType?: string }
): Promise<StrategicReasoningRecordRow[]> {
  const all = (await executor.select().from(strategicReasoningRecords)) as unknown as StrategicReasoningRecordRow[];
  return all
    .filter((r) => r.userId === input.userId)
    .filter((r) => (input.businessId === undefined ? true : r.businessId === input.businessId))
    .filter((r) => (input.status === undefined ? true : r.status === input.status))
    .filter((r) => (input.hypothesisType === undefined ? true : r.hypothesisType === input.hypothesisType))
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
}

// ─── Lifecycle rows (append-only) ───

export interface StrategicReasoningLifecycleEventRow {
  readonly lifecycleEventId: string;
  readonly reasoningId: string;
  readonly userId: number;
  readonly lifecycleType: string;
  readonly targetStatus: string;
  readonly successorReasoningId: string | null;
  readonly occurredAt: string;
  readonly reasonCode: string | null;
  readonly createdAt?: string;
}

export async function listStrategicReasoningLifecycle(
  executor: StrategicReasoningStoreExecutor,
  userId: number,
  reasoningId: string
): Promise<StrategicReasoningLifecycleEventRow[]> {
  const all = (await executor
    .select()
    .from(strategicReasoningLifecycleEvents)) as unknown as StrategicReasoningLifecycleEventRow[];
  return all
    .filter((r) => r.userId === userId && r.reasoningId === reasoningId)
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
}

export async function insertStrategicReasoningLifecycleEvent(
  executor: StrategicReasoningStoreExecutor,
  row: StrategicReasoningLifecycleEventRow
): Promise<{ inserted: boolean }> {
  const existing = (await executor
    .select()
    .from(strategicReasoningLifecycleEvents)
    .where(eq(strategicReasoningLifecycleEvents.lifecycleEventId, row.lifecycleEventId))
    .limit(1)) as unknown as Array<StrategicReasoningLifecycleEventRow>;
  if (existing[0]) {
    if (existing[0].targetStatus !== row.targetStatus) {
      fail("LIFECYCLE_CONFLICT", `lifecycle fact ${row.lifecycleEventId} exists with a different target status`);
    }
    return { inserted: false };
  }
  const { createdAt: _createdAt3, ...lifecycleRow } = row;
  void _createdAt3;
  await executor.insert(strategicReasoningLifecycleEvents).values(lifecycleRow);
  return { inserted: true };
}
