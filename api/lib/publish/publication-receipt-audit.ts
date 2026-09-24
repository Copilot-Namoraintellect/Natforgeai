// ─── Publication receipt → audit correlation helper (WBS13.7, Part E) ───
//
// Narrow consumer of the existing WBS7A/WBS7B audit authority: it embeds one
// canonical PublicationReceipt into the canonical publication_success audit
// event and correlates the governed package through the existing
// audit_events.packageId column. The audit system itself is NOT redesigned —
// createAuditEvent / persistAuditEvent stay untouched; this helper only fixes
// the receipt-shaped metadata and correlation for publication success so
// receipts are durable, replay-safe (unique event fingerprint), and
// reconstructable by lineage.

import { createAuditEvent, type AuditEvent } from "../audit/audit-event";
import {
  publicationReceiptToMetadata,
  type PublicationReceipt,
} from "./publication-receipt";

/**
 * Build the canonical publication_success audit envelope for one persisted
 * receipt. The event occurredAt is the receipt's own publishedAtIso — the one
 * shared publication-success clock — never an independent second read. The
 * governed package id occupies the first-class packageId correlation column;
 * legacy receipts leave it null. Metadata hygiene (sensitive-key stripping,
 * key sorting) is inherited from the audit contract.
 */
export function buildPublicationReceiptAuditEvent(input: {
  receipt: PublicationReceipt;
  userId: number;
  campaignId: number | null;
  businessId: number | null;
  contentId: number | null;
}): AuditEvent {
  const receipt = input.receipt;
  if (!receipt || typeof receipt !== "object") {
    throw new Error("buildPublicationReceiptAuditEvent requires a publication receipt");
  }
  return createAuditEvent({
    eventType: "publication_success",
    occurredAt: receipt.publishedAtIso,
    userId: input.userId,
    source: "workflow",
    outcome: "succeeded",
    campaignId: input.campaignId ?? null,
    businessId: input.businessId ?? null,
    contentId: input.contentId ?? null,
    workflowOperationId: null,
    workflowAttemptId: null,
    approvalRequestId: null,
    artifactId: null,
    packageId: receipt.publishPackageId,
    metadata: publicationReceiptToMetadata(receipt),
  });
}
