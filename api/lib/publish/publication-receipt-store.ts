// ─── Publication receipt durable store (WBS13.7) ───
//
// Thin persistence seam over the EXISTING durable authorities — no schema
// migration, no new tables:
//
//   - receipts persist as canonical publication_success audit events through
//     the replay-safe WBS7B store (unique event fingerprint: exact replay
//     reuses the durable row, conflicting content fails closed);
//   - governed correlation is the existing audit_events.packageId column;
//   - the publishing_queue row itself remains the primary success authority
//     (status + publishedAt + externalPostId), so rows published before this
//     authority still hydrate honest legacy receipts through
//     buildLegacyReceiptFromQueueSuccess.
//
// Production runner wiring (persist on success, consult before provider
// invocation) lands after WBS13 convergence; this module only owns the
// durable shape and the load/persist helpers.

import { and, desc, eq } from "drizzle-orm";
import { auditEvents, type AuditEventRow } from "@db/schema";
import {
  persistAuditEvent,
  type AuditDbExecutor,
  type PersistAuditEventResult,
} from "../audit/audit-store";
import { buildPublicationReceiptAuditEvent } from "./publication-receipt-audit";
import {
  extractPublicationReceiptFromMetadata,
  normalizePublicationReceipt,
  type PublicationReceipt,
} from "./publication-receipt";

export type PublicationReceiptStoreExecutor = AuditDbExecutor;

const DEFAULT_LOAD_LIMIT = 20;

/**
 * Persist one canonical receipt durably as the canonical publication_success
 * audit event. Replay-safe by construction: an identical receipt produces an
 * identical canonical event (same fingerprint), so an exact retry reuses the
 * existing durable row instead of duplicating evidence.
 */
export async function persistPublicationReceipt(input: {
  receipt: PublicationReceipt;
  userId: number;
  campaignId?: number | null;
  businessId?: number | null;
  contentId?: number | null;
  executor?: PublicationReceiptStoreExecutor;
}): Promise<PersistAuditEventResult> {
  const event = buildPublicationReceiptAuditEvent({
    receipt: normalizePublicationReceipt(input.receipt),
    userId: input.userId,
    campaignId: input.campaignId ?? null,
    businessId: input.businessId ?? null,
    contentId: input.contentId ?? null,
  });
  return persistAuditEvent(event, input.executor);
}

/**
 * Load the canonical stored receipt for one queue item, newest durable
 * success first. Returns null when no canonical receipt was ever persisted
 * for the item (callers then fall back to the queue-row legacy receipt).
 * A receipt-shaped value that fails validation is evidence tampering and
 * throws — never silently ignored, never guessed.
 */
export async function loadPublicationReceiptForQueueItem(input: {
  queueItemId: number;
  userId: number;
  limit?: number;
  executor: PublicationReceiptStoreExecutor;
}): Promise<PublicationReceipt | null> {
  if (
    typeof input.queueItemId !== "number" ||
    !Number.isInteger(input.queueItemId) ||
    input.queueItemId <= 0
  ) {
    throw new Error("loadPublicationReceiptForQueueItem requires a positive queueItemId");
  }
  if (typeof input.userId !== "number" || !Number.isInteger(input.userId) || input.userId <= 0) {
    throw new Error("loadPublicationReceiptForQueueItem requires a positive userId");
  }
  if (!input.executor || typeof input.executor.select !== "function") {
    throw new Error("loadPublicationReceiptForQueueItem requires a store executor");
  }
  const limit = input.limit ?? DEFAULT_LOAD_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
    throw new Error("loadPublicationReceiptForQueueItem limit must be a positive integer ≤ 200");
  }

  const rows = (await input.executor
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "publication_success"),
        eq(auditEvents.userId, input.userId)
      )
    )
    .orderBy(desc(auditEvents.occurredAt))
    .limit(limit)) as AuditEventRow[];

  for (const row of rows) {
    const metadata = row.metadata as Record<string, unknown> | null;
    const candidate = extractPublicationReceiptFromMetadata(metadata ?? null);
    if (!candidate) continue;
    if (candidate.queueItemId !== input.queueItemId) continue;
    return candidate;
  }
  return null;
}
