// ─── R6-D Nurture / Sales Handoff — durable store (contract §1, §8, §11, §15) ───
//
// DB-authoritative persistence. Every convergence anchor is a durable unique
// key (no in-memory dedupe): (userId, decisionKey) and nurtureDecisionId for
// decisions, (userId, handoffKey) and handoffId for handoffs,
// executionIdentity for receipts, (userId, touchIdentity) for touches.
// Insert-first: duplicate/concurrent delivery converges by re-read; the same
// identity with different material fails closed (NURTURE_REPLAY_CONFLICT /
// HANDOFF_REPLAY_CONFLICT). Lifecycle transitions are optimistic-CAS guarded.
//
// Every entry point is information-schema guarded: while the provisional
// 0034 migration is unexecuted, reads degrade to honest `unavailable` and
// writes fail closed (NURTURE_SCHEMA_UNAVAILABLE) — the R5-F/R6-F bridge
// discipline. Optional caller executor seam: the default getDb() client and
// a transaction callback client both satisfy the shape.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  nurtureHandoffDecisions,
  salesHandoffs,
  handoffDispatchReceipts,
  nurtureTouchRecords,
  type NurtureHandoffDecisionRow,
  type SalesHandoffRow,
  type HandoffDispatchReceiptRow,
  type NurtureTouchRecordRow,
  type InsertNurtureHandoffDecisionRow,
  type InsertSalesHandoffRow,
  type InsertHandoffDispatchReceiptRow,
  type InsertNurtureTouchRecordRow,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import { canonicalJson } from "./nurture-identity";
import {
  failNurture,
  isDuplicateKeyError,
  type NurtureChannel,
  type HandoffLifecycleState,
} from "./nurture-contract";

type Db = ReturnType<typeof getDb>;

export interface NurtureStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
  execute: Db["execute"];
}

/** Narrower seam for read/write paths (transaction clients satisfy it). */
export interface NurtureReadWriteExecutor {
  select: Db["select"];
  update: Db["update"];
}

function resolveDb(executor?: NurtureReadWriteExecutor): NurtureReadWriteExecutor {
  return executor ?? getDb();
}

function resolveFullDb(executor?: NurtureStoreExecutor): NurtureStoreExecutor {
  return executor ?? getDb();
}

const NURTURE_TABLES = [
  "nurture_handoff_decisions",
  "sales_handoffs",
  "handoff_dispatch_receipts",
  "nurture_touch_records",
] as const;

/** True only when every D-owned table exists (information-schema guard). */
export async function nurtureTablesAvailable(executor?: NurtureStoreExecutor): Promise<boolean> {
  const db = resolveFullDb(executor);
  const result = await db.execute(sql`
    SELECT COUNT(DISTINCT table_name) AS c
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name IN (${sql.join(
      NURTURE_TABLES.map((t) => sql`${t}`),
      sql`, `
    )})
  `);
  const rows = (result as unknown as { c?: number | string | bigint }[][] | undefined)?.[0];
  const first = Array.isArray(rows) ? rows[0] : undefined;
  return Number(first?.c ?? 0) === NURTURE_TABLES.length;
}

export function assertNurtureSchemaAvailable(available: boolean): void {
  if (!available) {
    failNurture(
      "NURTURE_SCHEMA_UNAVAILABLE",
      "NURTURE_SCHEMA_UNAVAILABLE: nurture/handoff tables are absent (provisional 0034 not executed); writes fail closed."
    );
  }
}

export type NurtureDuplicateClassification = "inserted" | "idempotent_replay" | "conflict";

export interface StoreWriteResult<T> {
  row: T;
  inserted: boolean;
  duplicateClassification: Exclude<NurtureDuplicateClassification, "conflict">;
}

/** Material equality for convergence checks (identity fields + decision content; timestamps excluded). */
function decisionMaterial(row: NurtureHandoffDecisionRow): string {
  return canonicalJson({
    d: row.decision,
    r: row.reasonCodes,
    c: row.channel,
    p: row.policyVersion,
    q: row.qualificationId,
    l: row.leadId,
    b: row.businessId,
    a: row.approvalRequired,
  });
}

function handoffMaterial(row: SalesHandoffRow): string {
  return canonicalJson({
    h: row.handoffId,
    l: row.leadId,
    q: row.qualificationId,
    p: row.handoffPolicyVersion,
    c: row.contentSnapshotHash,
    b: row.businessId,
    // nurtureDecisionId is lineage (the first decision that prepared the
    // handoff), not identity — later converged decisions reference the same
    // handoff and must not conflict.
  });
}

// ─── Decisions (immutable, insert-only) ───

export async function recordDecision(
  row: InsertNurtureHandoffDecisionRow,
  executor?: NurtureStoreExecutor
): Promise<StoreWriteResult<NurtureHandoffDecisionRow>> {
  const db = resolveFullDb(executor);
  try {
    await db.insert(nurtureHandoffDecisions).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getDecisionByKey(row.userId, row.decisionKey, executor);
    if (!existing) {
      failNurture("NURTURE_REPLAY_CONFLICT", "Decision insert raced but the row is unreadable; failing closed.");
    }
    if (decisionMaterial(existing) !== decisionMaterial(row as NurtureHandoffDecisionRow)) {
      failNurture(
        "NURTURE_REPLAY_CONFLICT",
        "NURTURE_REPLAY_CONFLICT: the same decision identity was replayed with different material; refusing to converge on tampered content."
      );
    }
    return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
  }
  const inserted = await getDecisionByKey(row.userId, row.decisionKey, executor);
  if (!inserted) failNurture("NURTURE_REPLAY_CONFLICT", "Decision insert did not converge to a readable row.");
  return { row: inserted, inserted: true, duplicateClassification: "inserted" };
}

export async function getDecisionById(
  userId: number,
  nurtureDecisionId: string,
  executor?: NurtureReadWriteExecutor
): Promise<NurtureHandoffDecisionRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(nurtureHandoffDecisions)
    .where(and(eq(nurtureHandoffDecisions.userId, userId), eq(nurtureHandoffDecisions.nurtureDecisionId, nurtureDecisionId)))
    .limit(1);
  return row ?? null;
}

export async function getDecisionByKey(
  userId: number,
  decisionKey: string,
  executor?: NurtureReadWriteExecutor
): Promise<NurtureHandoffDecisionRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(nurtureHandoffDecisions)
    .where(and(eq(nurtureHandoffDecisions.userId, userId), eq(nurtureHandoffDecisions.decisionKey, decisionKey)))
    .limit(1);
  return row ?? null;
}

export async function getLatestDecisionForLead(
  userId: number,
  leadId: string,
  executor?: NurtureReadWriteExecutor
): Promise<NurtureHandoffDecisionRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(nurtureHandoffDecisions)
    .where(and(eq(nurtureHandoffDecisions.userId, userId), eq(nurtureHandoffDecisions.leadId, leadId)))
    .orderBy(desc(nurtureHandoffDecisions.id))
    .limit(1);
  return row ?? null;
}

export async function listDecisionsForQualification(
  userId: number,
  qualificationId: string,
  executor?: NurtureReadWriteExecutor
): Promise<NurtureHandoffDecisionRow[]> {
  const db = resolveDb(executor);
  return db
    .select()
    .from(nurtureHandoffDecisions)
    .where(and(eq(nurtureHandoffDecisions.userId, userId), eq(nurtureHandoffDecisions.qualificationId, qualificationId)))
    .orderBy(desc(nurtureHandoffDecisions.id));
}

// ─── Handoffs (exact-once identity, CAS lifecycle) ───

export async function recordHandoff(
  row: InsertSalesHandoffRow,
  executor?: NurtureStoreExecutor
): Promise<StoreWriteResult<SalesHandoffRow>> {
  const db = resolveFullDb(executor);
  try {
    await db.insert(salesHandoffs).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getHandoffByKey(row.userId, row.handoffKey, executor);
    if (!existing) {
      failNurture("HANDOFF_REPLAY_CONFLICT", "Handoff insert raced but the row is unreadable; failing closed.");
    }
    if (handoffMaterial(existing) !== handoffMaterial(row as SalesHandoffRow)) {
      failNurture(
        "HANDOFF_REPLAY_CONFLICT",
        "HANDOFF_REPLAY_CONFLICT: the same handoff identity was replayed with different material; refusing to converge on tampered content."
      );
    }
    return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
  }
  const inserted = await getHandoffByKey(row.userId, row.handoffKey, executor);
  if (!inserted) failNurture("HANDOFF_REPLAY_CONFLICT", "Handoff insert did not converge to a readable row.");
  return { row: inserted, inserted: true, duplicateClassification: "inserted" };
}

export async function getHandoffById(
  userId: number,
  handoffId: string,
  executor?: NurtureReadWriteExecutor
): Promise<SalesHandoffRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(salesHandoffs)
    .where(and(eq(salesHandoffs.userId, userId), eq(salesHandoffs.handoffId, handoffId)))
    .limit(1);
  return row ?? null;
}

export async function getHandoffByKey(
  userId: number,
  handoffKey: string,
  executor?: NurtureReadWriteExecutor
): Promise<SalesHandoffRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(salesHandoffs)
    .where(and(eq(salesHandoffs.userId, userId), eq(salesHandoffs.handoffKey, handoffKey)))
    .limit(1);
  return row ?? null;
}

export interface HandoffTransitionResult {
  row: SalesHandoffRow;
  transitioned: boolean;
}

/**
 * Optimistic-CAS lifecycle transition (contract §8). When `expectedVersion`
 * is supplied the row version must match; `fromStatuses` constrains legal
 * source states. A lost race re-reads and reports `transitioned: false` —
 * callers fail closed on unexpected current state.
 */
export async function transitionHandoffStatus(
  userId: number,
  handoffId: string,
  transition: {
    fromStatuses: readonly HandoffLifecycleState[];
    toStatus: HandoffLifecycleState;
    expectedVersion?: number;
    lastError?: string | null;
    dispatchedAt?: string | null;
    acknowledgedAt?: string | null;
    approvalRequestId?: number | null;
  },
  executor?: NurtureReadWriteExecutor
): Promise<HandoffTransitionResult> {
  const db = resolveDb(executor);
  const set: Record<string, unknown> = {
    handoffStatus: transition.toStatus,
    version: sql`${salesHandoffs.version} + 1`,
    updatedAt: new Date(),
  };
  if (transition.lastError !== undefined) set.lastError = transition.lastError;
  if (transition.dispatchedAt !== undefined) set.dispatchedAt = transition.dispatchedAt;
  if (transition.acknowledgedAt !== undefined) set.acknowledgedAt = transition.acknowledgedAt;
  if (transition.approvalRequestId !== undefined) set.approvalRequestId = transition.approvalRequestId;

  const conditions = [
    eq(salesHandoffs.userId, userId),
    eq(salesHandoffs.handoffId, handoffId),
    inArray(salesHandoffs.handoffStatus, [...transition.fromStatuses]),
  ];
  if (transition.expectedVersion !== undefined) {
    conditions.push(eq(salesHandoffs.version, transition.expectedVersion));
  }
  await db.update(salesHandoffs).set(set).where(and(...conditions));

  const row = await getHandoffById(userId, handoffId, executor);
  if (!row) failNurture("HANDOFF_NOT_FOUND", `Handoff ${handoffId} not found for this tenant.`);
  return { row, transitioned: row.handoffStatus === transition.toStatus };
}

// ─── Dispatch receipts (append-only) ───

export async function recordDispatchReceipt(
  row: InsertHandoffDispatchReceiptRow,
  executor?: NurtureStoreExecutor
): Promise<StoreWriteResult<HandoffDispatchReceiptRow>> {
  const db = resolveFullDb(executor);
  try {
    await db.insert(handoffDispatchReceipts).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getReceiptByExecutionIdentity(row.executionIdentity, executor);
    if (!existing) {
      failNurture("HANDOFF_REPLAY_CONFLICT", "Receipt insert raced but the row is unreadable; failing closed.");
    }
    if (existing.outcome !== row.outcome || existing.handoffId !== row.handoffId) {
      failNurture(
        "HANDOFF_REPLAY_CONFLICT",
        "HANDOFF_REPLAY_CONFLICT: the same execution identity was replayed with a different outcome; refusing to converge."
      );
    }
    return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
  }
  const inserted = await getReceiptByExecutionIdentity(row.executionIdentity, executor);
  if (!inserted) failNurture("HANDOFF_REPLAY_CONFLICT", "Receipt insert did not converge to a readable row.");
  return { row: inserted, inserted: true, duplicateClassification: "inserted" };
}

export async function getReceiptByExecutionIdentity(
  executionIdentity: string,
  executor?: NurtureReadWriteExecutor
): Promise<HandoffDispatchReceiptRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(handoffDispatchReceipts)
    .where(eq(handoffDispatchReceipts.executionIdentity, executionIdentity))
    .limit(1);
  return row ?? null;
}

export async function listReceiptsForHandoff(
  userId: number,
  handoffId: string,
  executor?: NurtureReadWriteExecutor
): Promise<HandoffDispatchReceiptRow[]> {
  const db = resolveDb(executor);
  return db
    .select()
    .from(handoffDispatchReceipts)
    .where(and(eq(handoffDispatchReceipts.userId, userId), eq(handoffDispatchReceipts.handoffId, handoffId)))
    .orderBy(desc(handoffDispatchReceipts.attemptSeq));
}

// ─── Nurture touches (append-only, exact-once) ───

export async function recordTouch(
  row: InsertNurtureTouchRecordRow,
  executor?: NurtureStoreExecutor
): Promise<StoreWriteResult<NurtureTouchRecordRow>> {
  const db = resolveFullDb(executor);
  try {
    await db.insert(nurtureTouchRecords).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getTouchByIdentity(row.userId, row.touchIdentity, executor);
    if (!existing) {
      failNurture("NURTURE_REPLAY_CONFLICT", "Touch insert raced but the row is unreadable; failing closed.");
    }
    if (
      existing.outcome !== row.outcome ||
      existing.leadId !== row.leadId ||
      existing.channel !== row.channel
    ) {
      failNurture(
        "NURTURE_REPLAY_CONFLICT",
        "NURTURE_REPLAY_CONFLICT: the same touch identity was replayed with different material; refusing to converge."
      );
    }
    return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
  }
  const inserted = await getTouchByIdentity(row.userId, row.touchIdentity, executor);
  if (!inserted) failNurture("NURTURE_REPLAY_CONFLICT", "Touch insert did not converge to a readable row.");
  return { row: inserted, inserted: true, duplicateClassification: "inserted" };
}

export async function getTouchByIdentity(
  userId: number,
  touchIdentity: string,
  executor?: NurtureReadWriteExecutor
): Promise<NurtureTouchRecordRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(nurtureTouchRecords)
    .where(and(eq(nurtureTouchRecords.userId, userId), eq(nurtureTouchRecords.touchIdentity, touchIdentity)))
    .limit(1);
  return row ?? null;
}

export async function listTouchesForLeadChannel(
  userId: number,
  leadId: string,
  channel: NurtureChannel,
  executor?: NurtureReadWriteExecutor
): Promise<NurtureTouchRecordRow[]> {
  const db = resolveDb(executor);
  return db
    .select()
    .from(nurtureTouchRecords)
    .where(
      and(
        eq(nurtureTouchRecords.userId, userId),
        eq(nurtureTouchRecords.leadId, leadId),
        eq(nurtureTouchRecords.channel, channel)
      )
    )
    .orderBy(desc(nurtureTouchRecords.touchSeq));
}
