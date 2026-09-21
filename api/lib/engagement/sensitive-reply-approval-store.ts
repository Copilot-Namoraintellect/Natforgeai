/**
 * Durable sensitive-reply approval store (WBS 4F / Wave 2 / WBS14B).
 *
 * Persists exactly one approval request per escalated inbound event into the
 * generic approval_requests table, replay-safe across webhook redeliveries and
 * recovery passes:
 *
 * - The WBS14A hashed idempotency key is the durable replay authority; the raw
 *   provider event dedupKey is NEVER persisted (user-facing text or context).
 * - First escalation inserts one `pending` sensitive_reply request whose
 *   aiRecommendation is the proposed reply (which remains a proposal only —
 *   zero outbound dispatch is a hard invariant).
 * - An exact replay (same idempotency key, materially identical payload) reuses
 *   the existing request, whatever its status: a rejected/approved historical
 *   request is never silently rewritten back to pending.
 * - The same idempotency key with a materially different payload fails closed
 *   with an error instead of reusing or overwriting the existing request.
 *
 * The executor seam keeps the store testable without a real database: tests
 * inject an in-memory executor, production defaults to the drizzle-backed
 * executor below. No real database is touched by unit tests.
 *
 * `requireApprovalBeforeReplying` is frontend/onboarding state only and is
 * intentionally NOT consulted here; it is not backend authority.
 */

import { eq } from "drizzle-orm";
import { approvalRequests } from "@db/schema";
import { getDb } from "../../queries/connection";
import { isMySqlDuplicateKeyError } from "../billing/credit-engine";
import {
  SENSITIVE_REPLY_APPROVAL_TYPE,
  type SensitiveReplyApprovalCommand,
  type SensitiveReplySentiment,
} from "./sensitive-reply-approval";

/** Structured lineage persisted in approval_requests.context. */
export interface SensitiveReplyApprovalContext {
  source: "engagement_inbound";
  contractVersion: string;
  threadId: number;
  sentiment: SensitiveReplySentiment;
  escalationReason: string | null;
}

/** Row shape the store reads back from approval_requests. */
export interface SensitiveReplyApprovalRecord {
  id: number;
  userId: number;
  campaignId: number | null;
  approvalType: string;
  title: string;
  description: string | null;
  aiRecommendation: string | null;
  riskLevel: string;
  status: string;
  idempotencyKey: string | null;
  context: unknown;
}

/** Row shape the store inserts into approval_requests (always pending). */
export interface SensitiveReplyApprovalInsert {
  userId: number;
  campaignId: number | null;
  approvalType: string;
  title: string;
  description: string;
  aiRecommendation: string;
  riskLevel: string;
  idempotencyKey: string;
  context: SensitiveReplyApprovalContext;
}

/**
 * Minimal persistence surface. Deliberately narrower than a drizzle instance
 * so tests can substitute an in-memory fake without a database.
 */
export interface SensitiveReplyApprovalExecutor {
  findByIdempotencyKey(
    idempotencyKey: string
  ): Promise<SensitiveReplyApprovalRecord | null>;
  insertPendingApproval(row: SensitiveReplyApprovalInsert): Promise<number>;
}

export type CreateOrReuseSensitiveReplyApprovalResult =
  | { outcome: "created"; approvalRequestId: number }
  | {
      outcome: "reused";
      approvalRequestId: number;
      /** Status of the reused row; a terminal row is never reopened. */
      existingStatus: string;
    };

/**
 * The payload fields that define approval identity for conflict detection.
 * Derived/cosmetic fields (title, description) are excluded so a replay is
 * judged on what is being approved, not on how it is labelled.
 */
interface MaterialApprovalShape {
  userId: number;
  campaignId: number | null;
  approvalType: string;
  aiRecommendation: string;
  riskLevel: string;
  threadId: number;
  sentiment: SensitiveReplySentiment;
  escalationReason: string | null;
  contractVersion: string;
}

function toMaterialShape(
  command: SensitiveReplyApprovalCommand
): MaterialApprovalShape {
  return {
    userId: command.userId,
    campaignId: command.campaignId,
    approvalType: command.approvalType,
    aiRecommendation: command.aiRecommendation,
    riskLevel: command.riskLevel,
    threadId: command.threadId,
    sentiment: command.lineage.sentiment,
    escalationReason: command.lineage.escalationReason,
    contractVersion: command.lineage.contractVersion,
  };
}

function toMaterialShapeFromRecord(
  record: SensitiveReplyApprovalRecord
): MaterialApprovalShape {
  const context = (record.context ??
    {}) as Partial<SensitiveReplyApprovalContext>;
  return {
    userId: record.userId,
    campaignId: record.campaignId ?? null,
    approvalType: record.approvalType,
    aiRecommendation: record.aiRecommendation ?? "",
    riskLevel: record.riskLevel,
    // Missing/malformed context fields surface as mismatches and fail closed.
    threadId: context.threadId as number,
    sentiment: context.sentiment as SensitiveReplySentiment,
    escalationReason: context.escalationReason ?? null,
    contractVersion: context.contractVersion as string,
  };
}

function assertNoMaterialConflict(
  existing: SensitiveReplyApprovalRecord,
  desired: MaterialApprovalShape,
  idempotencyKey: string
): void {
  const stored = toMaterialShapeFromRecord(existing);
  const mismatched = (
    Object.keys(desired) as (keyof MaterialApprovalShape)[]
  ).filter(key => stored[key] !== desired[key]);

  if (mismatched.length > 0) {
    throw new Error(
      `sensitive_reply approval: idempotency key ${idempotencyKey} already ` +
        `exists with a different approval payload (${mismatched.join(", ")}). ` +
        "Refusing to reuse or overwrite it."
    );
  }
}

const drizzleExecutor: SensitiveReplyApprovalExecutor = {
  async findByIdempotencyKey(idempotencyKey) {
    const db = getDb();
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.idempotencyKey, idempotencyKey))
      .limit(1);
    return (row as SensitiveReplyApprovalRecord | undefined) ?? null;
  },

  async insertPendingApproval(row) {
    const db = getDb();
    const [result] = await db.insert(approvalRequests).values({
      userId: row.userId,
      campaignId: row.campaignId,
      approvalType: row.approvalType as any,
      title: row.title,
      description: row.description,
      aiRecommendation: row.aiRecommendation,
      riskLevel: row.riskLevel as any,
      status: "pending",
      idempotencyKey: row.idempotencyKey,
      context: row.context,
    });
    return Number(result.insertId);
  },
};

/**
 * Create the pending sensitive_reply approval for one escalated inbound event,
 * or reuse the existing request on exact replay. See the module header for
 * the full replay/conflict contract.
 */
export async function createOrReuseSensitiveReplyApproval(
  command: SensitiveReplyApprovalCommand,
  executor: SensitiveReplyApprovalExecutor = drizzleExecutor
): Promise<CreateOrReuseSensitiveReplyApprovalResult> {
  if (
    !command ||
    typeof command.idempotencyKey !== "string" ||
    command.idempotencyKey.length === 0
  ) {
    throw new Error(
      "sensitive_reply approval: command.idempotencyKey is required"
    );
  }
  if (command.approvalType !== SENSITIVE_REPLY_APPROVAL_TYPE) {
    throw new Error(
      `sensitive_reply approval: unsupported approvalType "${command.approvalType}"`
    );
  }

  const desired = toMaterialShape(command);

  const existing = await executor.findByIdempotencyKey(command.idempotencyKey);
  if (existing) {
    assertNoMaterialConflict(existing, desired, command.idempotencyKey);
    return {
      outcome: "reused",
      approvalRequestId: existing.id,
      existingStatus: existing.status,
    };
  }

  try {
    const approvalRequestId = await executor.insertPendingApproval({
      userId: command.userId,
      // campaignId stays null when the thread is unlinked; never faked.
      campaignId: command.campaignId,
      approvalType: command.approvalType,
      title: command.title,
      description: command.description,
      aiRecommendation: command.aiRecommendation,
      riskLevel: command.riskLevel,
      idempotencyKey: command.idempotencyKey,
      context: {
        source: "engagement_inbound",
        contractVersion: command.lineage.contractVersion,
        threadId: command.threadId,
        sentiment: command.lineage.sentiment,
        escalationReason: command.lineage.escalationReason,
      },
    });
    return { outcome: "created", approvalRequestId };
  } catch (err) {
    if (!isMySqlDuplicateKeyError(err)) throw err;
    // Lost the create race to a concurrent caller (unique idempotency key).
    // Fall through and reuse the winner's row after the same conflict check.
  }

  const raced = await executor.findByIdempotencyKey(command.idempotencyKey);
  if (!raced) {
    throw new Error(
      `sensitive_reply approval: insert raced on idempotency key ${command.idempotencyKey} but no row can be reloaded. Refusing to continue.`
    );
  }
  assertNoMaterialConflict(raced, desired, command.idempotencyKey);
  return {
    outcome: "reused",
    approvalRequestId: raced.id,
    existingStatus: raced.status,
  };
}
