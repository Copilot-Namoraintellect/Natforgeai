import { eq, and } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { engagementResponseContents } from "@db/schema";
import type { EngagementStoreExecutor } from "./execution-store";

export const ENGAGEMENT_RESPONSE_STORE_CONTRACT_VERSION = "engagement/response-store@v1";

export class EngagementResponseStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngagementResponseStoreError";
    this.code = code;
  }
}

export interface EngagementResponseContentRecord {
  responseContentId: string;
  version: number;
  contentHash: string;
  businessId: number;
  userId: number;
  actionRequestId: string;
  interpretationId: string;
  platform: string;
  actionType: string;
  content: string;
  status: "accepted" | "internal_note";
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  billingIdentity?: string | null;
}

function isDuplicateKeyError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const message = (err as { message?: string })?.message ?? "";
  return code === "ER_DUP_ENTRY" || /Duplicate entry/i.test(message);
}

/**
 * Exact-once durable acceptance of generated response content. The unique
 * (responseContentId, version) key is the convergence anchor: a retried
 * generation of the same logical content reuses the existing row; the same
 * key with different material content fails closed (content identity
 * conflict). Rows are immutable — there is no update path.
 */
export async function persistEngagementResponseContent(
  record: EngagementResponseContentRecord,
  executor?: EngagementStoreExecutor
): Promise<{ record: EngagementResponseContentRecord; duplicateClassification: "none" | "idempotent_replay" }> {
  const db = executor ?? (getDb() as unknown as EngagementStoreExecutor);
  try {
    await db.insert(engagementResponseContents).values({
      responseContentId: record.responseContentId,
      version: record.version,
      contentHash: record.contentHash,
      businessId: record.businessId,
      userId: record.userId,
      actionRequestId: record.actionRequestId,
      interpretationId: record.interpretationId,
      platform: record.platform,
      actionType: record.actionType,
      content: record.content,
      status: record.status,
      model: record.model ?? null,
      promptTokens: record.promptTokens ?? null,
      completionTokens: record.completionTokens ?? null,
      billingIdentity: record.billingIdentity ?? null,
    });
    return { record, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const [existing] = (await db
      .select()
      .from(engagementResponseContents)
      .where(
        and(
          eq(engagementResponseContents.responseContentId, record.responseContentId),
          eq(engagementResponseContents.version, record.version)
        )
      )
      .limit(1)) as Array<{ contentHash: string; content: string }>;
    if (!existing) {
      throw new EngagementResponseStoreError(
        "RESPONSE_REPLAY_UNRESOLVED",
        "Response content persistence conflict could not be resolved."
      );
    }
    if (existing.contentHash !== record.contentHash || existing.content !== record.content) {
      throw new EngagementResponseStoreError(
        "RESPONSE_CONTENT_IDENTITY_CONFLICT",
        "Same response content identity persisted with different material content."
      );
    }
    return { record, duplicateClassification: "idempotent_replay" };
  }
}
