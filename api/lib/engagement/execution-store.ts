import { eq, and, or, lt, lte, inArray } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { engagementExecutions, engagementReceipts } from "@db/schema";

export const ENGAGEMENT_EXECUTION_STORE_CONTRACT_VERSION = "engagement/execution-store@v1";

type Db = ReturnType<typeof getDb>;

/**
 * Executor seam shared by every engagement store. Structurally identical to
 * the R5-E store executors so the same drizzle instance (or the same fake
 * in tests, cast) flows through C and E persistence unchanged.
 */
export interface EngagementStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
}

export class EngagementExecutionStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngagementExecutionStoreError";
    this.code = code;
  }
}

export type EngagementExecutionRecord = typeof engagementExecutions.$inferSelect;
export type EngagementReceiptRecord = typeof engagementReceipts.$inferSelect;

function isDuplicateKeyError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const message = (err as { message?: string })?.message ?? "";
  return code === "ER_DUP_ENTRY" || /Duplicate entry/i.test(message);
}

export async function getExecutionByActionRequest(
  actionRequestId: string,
  executor?: EngagementStoreExecutor
): Promise<EngagementExecutionRecord | null> {
  const db = executor ?? (getDb() as unknown as EngagementStoreExecutor);
  const [row] = (await db
    .select()
    .from(engagementExecutions)
    .where(eq(engagementExecutions.actionRequestId, actionRequestId))
    .limit(1)) as EngagementExecutionRecord[];
  return row ?? null;
}

export async function getExecutionById(
  executionId: string,
  executor?: EngagementStoreExecutor
): Promise<EngagementExecutionRecord | null> {
  const db = executor ?? (getDb() as unknown as EngagementStoreExecutor);
  const [row] = (await db
    .select()
    .from(engagementExecutions)
    .where(eq(engagementExecutions.executionId, executionId))
    .limit(1)) as EngagementExecutionRecord[];
  return row ?? null;
}

export async function getReceiptByExecutionId(
  executionId: string,
  executor?: EngagementStoreExecutor
): Promise<EngagementReceiptRecord | null> {
  const db = executor ?? (getDb() as unknown as EngagementStoreExecutor);
  const [row] = (await db
    .select()
    .from(engagementReceipts)
    .where(eq(engagementReceipts.executionId, executionId))
    .limit(1)) as EngagementReceiptRecord[];
  return row ?? null;
}

export async function getReceiptByOperationIdentity(
  providerOperationIdentity: string,
  executor?: EngagementStoreExecutor
): Promise<EngagementReceiptRecord | null> {
  const db = executor ?? (getDb() as unknown as EngagementStoreExecutor);
  const [row] = (await db
    .select()
    .from(engagementReceipts)
    .where(eq(engagementReceipts.providerOperationIdentity, providerOperationIdentity))
    .limit(1)) as EngagementReceiptRecord[];
  return row ?? null;
}

export type InsertExecution = typeof engagementExecutions.$inferInsert;

/** Insert-first acceptance; duplicate actionRequestId converges to the row. */
export async function insertEngagementExecution(
  row: InsertExecution,
  executor?: EngagementStoreExecutor
): Promise<{ record: EngagementExecutionRecord; duplicateClassification: "none" | "idempotent_replay" }> {
  const db = executor ?? (getDb() as unknown as EngagementStoreExecutor);
  try {
    await db.insert(engagementExecutions).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getExecutionByActionRequest(String(row.actionRequestId), db);
    if (!existing) {
      throw new EngagementExecutionStoreError(
        "EXECUTION_REPLAY_UNRESOLVED",
        "Execution persistence conflict could not be resolved."
      );
    }
    if (
      existing.policyDecisionId !== row.policyDecisionId ||
      existing.responseContentId !== row.responseContentId ||
      existing.responseContentVersion !== row.responseContentVersion ||
      existing.signalId !== row.signalId ||
      existing.interpretationId !== row.interpretationId
    ) {
      throw new EngagementExecutionStoreError(
        "EXECUTION_IDENTITY_CONFLICT",
        "Same action request persisted with different material execution identity."
      );
    }
    return { record: existing, duplicateClassification: "idempotent_replay" };
  }
  const record = await getExecutionByActionRequest(String(row.actionRequestId), db);
  if (!record) {
    throw new EngagementExecutionStoreError(
      "EXECUTION_NOT_FOUND_AFTER_INSERT",
      "Execution row could not be re-read after insert."
    );
  }
  return { record, duplicateClassification: "none" };
}

/**
 * Atomic single-writer claim. The conditional UPDATE is the sole concurrency
 * authority over who may invoke the provider for this action: exactly one
 * caller observes a changed row, even under concurrent triggers. Claimable:
 * pending/failed_retryable rows, and executing rows whose lease expired
 * (crashed attempt). Ambiguous rows are NEVER claimed here — they route to
 * the reconciler for a provider probe first.
 */
export async function claimEngagementExecution(
  input: {
    executionId: string;
    leaseMs: number;
    attempt: number;
    claimableStatuses: readonly string[];
    /** When set, an expired `executing` lease (crashed attempt) is also claimable. */
    staleLeaseNow?: Date;
  },
  executor?: EngagementStoreExecutor
): Promise<{ claimed: boolean; record: EngagementExecutionRecord | null }> {
  const db = executor ?? (getDb() as unknown as EngagementStoreExecutor);
  const now = new Date();
  const claimExpiresAt = new Date(now.getTime() + input.leaseMs);

  const staleLeaseCondition = input.staleLeaseNow
    ? [and(eq(engagementExecutions.status, "executing"), lt(engagementExecutions.claimExpiresAt, input.staleLeaseNow))]
    : [];

  const result = (await db
    .update(engagementExecutions)
    .set({
      status: "executing",
      attempt: input.attempt,
      claimedAt: now,
      claimExpiresAt,
    })
    .where(
      and(
        eq(engagementExecutions.executionId, input.executionId),
        or(
          inArray(engagementExecutions.status, [...input.claimableStatuses]),
          ...staleLeaseCondition
        )
      )
    )) as { affectedRows?: number }[];

  const affected = Number((result as unknown as { affectedRows?: number })?.affectedRows ?? 0);
  if (affected === 0) {
    const current = await getExecutionById(input.executionId, db);
    return { claimed: false, record: current };
  }
  const record = await getExecutionById(input.executionId, db);
  return { claimed: true, record };
}

/** Patch terminal/working state after a claimed attempt. */
export async function updateEngagementExecutionState(
  input: {
    executionId: string;
    expectedStatus?: string;
    patch: Partial<{
      status: string;
      attempt: number;
      providerOperationIdentity: string | null;
      claimedAt: Date | null;
      claimExpiresAt: Date | null;
      nextRetryAt: Date | null;
      reconciliationState: string;
      failureClass: string | null;
      billingReservationId: string | null;
      lastError: string | null;
      updatedAt: Date;
    }>;
  },
  executor?: EngagementStoreExecutor
): Promise<{ updated: boolean; record: EngagementExecutionRecord | null }> {
  const db = executor ?? (getDb() as unknown as EngagementStoreExecutor);
  const conditions = [eq(engagementExecutions.executionId, input.executionId)];
  if (input.expectedStatus) {
    conditions.push(eq(engagementExecutions.status, input.expectedStatus));
  }
  const result = (await db
    .update(engagementExecutions)
    .set({ ...input.patch, updatedAt: new Date() })
    .where(and(...conditions))) as unknown as { affectedRows?: number };
  if (Number(result?.affectedRows ?? 0) === 0) {
    const current = await getExecutionById(input.executionId, db);
    return { updated: false, record: current };
  }
  const record = await getExecutionById(input.executionId, db);
  return { updated: true, record };
}

export type InsertReceipt = typeof engagementReceipts.$inferInsert;

/**
 * Immutable receipt acceptance. Unique executionId + providerOperationIdentity
 * are the convergence anchors: crash-after-provider-success replay converges
 * to the existing row; same identity with different material evidence fails
 * closed. There is deliberately NO update path — receipts are immutable once
 * accepted.
 */
export async function persistEngagementReceipt(
  row: InsertReceipt,
  executor?: EngagementStoreExecutor
): Promise<{ record: EngagementReceiptRecord; duplicateClassification: "none" | "idempotent_replay" }> {
  const db = executor ?? (getDb() as unknown as EngagementStoreExecutor);
  try {
    await db.insert(engagementReceipts).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing =
      (await getReceiptByExecutionId(String(row.executionId), db)) ??
      (await getReceiptByOperationIdentity(String(row.providerOperationIdentity), db));
    if (!existing) {
      throw new EngagementExecutionStoreError(
        "RECEIPT_REPLAY_UNRESOLVED",
        "Receipt persistence conflict could not be resolved."
      );
    }
    if (
      existing.providerExternalReceipt !== row.providerExternalReceipt ||
      existing.externalTarget !== row.externalTarget ||
      existing.responseContentId !== row.responseContentId
    ) {
      throw new EngagementExecutionStoreError(
        "RECEIPT_IDENTITY_CONFLICT",
        "Same receipt identity persisted with different material evidence."
      );
    }
    return { record: existing, duplicateClassification: "idempotent_replay" };
  }
  const record = await getReceiptByExecutionId(String(row.executionId), db);
  if (!record) {
    throw new EngagementExecutionStoreError(
      "RECEIPT_NOT_FOUND_AFTER_INSERT",
      "Receipt row could not be re-read after insert."
    );
  }
  return { record, duplicateClassification: "none" };
}

/** Sweep candidates: rows needing reconciliation or due retries. */
export async function listExecutionsNeedingAttention(
  input: { limit: number; now: Date },
  executor?: EngagementStoreExecutor
): Promise<EngagementExecutionRecord[]> {
  const db = executor ?? (getDb() as unknown as EngagementStoreExecutor);
  const rows = (await db
    .select()
    .from(engagementExecutions)
    .where(
      or(
        eq(engagementExecutions.reconciliationState, "needed"),
        and(
          inArray(engagementExecutions.status, ["pending_claim", "pending_retry"]),
          lte(engagementExecutions.nextRetryAt, input.now)
        ),
        and(
          eq(engagementExecutions.status, "executing"),
          lt(engagementExecutions.claimExpiresAt, input.now)
        ),
        eq(engagementExecutions.status, "failed_retryable")
      )
    )
    .limit(input.limit)) as EngagementExecutionRecord[];
  return rows;
}
