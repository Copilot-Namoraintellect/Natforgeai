// ─── R5-X convergence — R5-C receipt → R5-D engagement-evidence seam binding ───
//
// Connects C's immutable engagement receipts into D's optional engagement-
// evidence seam (opportunity contract §13, engagement-to-opportunity
// contract). D's base detection works from R5-A + R5-B alone; this binding
// only ENRICHES an existing candidate and never redefines its identity, never
// creates one, and never creates a lead.
//
// Trust model (closes the raw-receipt forgery hole at the public boundary):
//   - the tRPC router accepts ONLY an opaque `engagementReceiptId`;
//   - the receipt row is fetched SERVER-SIDE through R5-C's read-only
//     `getReceiptByEngagementReceiptId` lookup (contract §13(c)) — clients can
//     never supply receipt material;
//   - the row is converted to the seam DTO by a pure mapper and the seam's
//     own `deriveReceiptHash` / `toValidatedEngagementReceipt` verification
//     runs inside D's `attachEngagementEvidence` (defence in depth);
//   - D's tenant checks (candidate ownership, business-scope match,
//     interpretation binding) and the receipt-id replay guard run unchanged.
//
// Outcome mapping is evidence-honest: an R5-C receipt proves the provider
// confirmed our follow-up was posted. It cannot observe user sentiment, so
// the only outcome it can truthfully evidence is `provider_confirmed_follow_up`
// (and only for `status = succeeded` receipts carrying a provider ack). A
// receipt that proves less is refused rather than inflated.

import { attachEngagementEvidence } from "./detector";
import {
  deriveReceiptHash,
  type EngagementReceiptLike,
} from "./engagement-evidence-seam";
import { OpportunityInputError } from "./opportunity-contract";
import type { OpportunityStoreExecutor } from "./opportunity-store";
import type { EngagementReceiptRecord } from "../engagement/execution-store";
import { getReceiptByEngagementReceiptId } from "../engagement/execution-store";

export const ENGAGEMENT_EVIDENCE_BINDING_VERSION = "engagement-evidence-binding/v1" as const;

/** Server-side receipt lookup; production binds it to R5-C's read-only store. */
export type EngagementReceiptLoader = (
  engagementReceiptId: string
) => Promise<EngagementReceiptRecord | null>;

/** Production loader: reads only receipts minted by the R5-C authority. */
export function engagementReceiptLoader(): EngagementReceiptLoader {
  return (engagementReceiptId) => getReceiptByEngagementReceiptId(engagementReceiptId);
}

/**
 * Pure mapper from R5-C's immutable receipt row to the R5-D seam DTO. The
 * integrity hash is derived from the exact coordinates D re-derives, so any
 * post-hoc tampering with the mapped fields fails closed in
 * `toValidatedEngagementReceipt`. Refuses receipts that do not prove a
 * provider-confirmed follow-up (status ≠ succeeded, or no provider ack, or an
 * over-long provider reference).
 */
export function toEngagementReceiptLike(row: EngagementReceiptRecord): EngagementReceiptLike {
  if (row.status !== "succeeded") {
    throw new OpportunityInputError(
      "RECEIPT_NOT_SUCCESSFUL",
      `engagement receipt ${row.engagementReceiptId} has status "${row.status}" and is not successful-outcome evidence.`
    );
  }
  const providerReceiptRef = row.providerExternalReceipt ?? null;
  if (providerReceiptRef !== null && providerReceiptRef.length > 255) {
    throw new OpportunityInputError(
      "RECEIPT_MATERIAL_OUT_OF_BOUNDS",
      `engagement receipt ${row.engagementReceiptId} carries an out-of-bounds provider reference.`
    );
  }
  const recordedAt =
    row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString();
  const coordinates = {
    engagementReceiptId: row.engagementReceiptId,
    sourceInterpretationId: row.interpretationId,
    sourceSignalId: row.signalId,
    businessId: row.businessId === null || row.businessId === undefined ? null : Number(row.businessId),
    outcome: "provider_confirmed_follow_up" as const,
    providerReceiptRef,
    occurredAt: row.executedAt,
  };
  return { ...coordinates, receiptHash: deriveReceiptHash(coordinates), recordedAt };
}

export interface AttachEngagementReceiptByIdInput {
  userId: number;
  opportunityId: string;
  engagementReceiptId: string;
  /** Defaults to the production R5-C store lookup (server-minted only). */
  loadReceipt?: EngagementReceiptLoader;
  now?: Date;
  executor?: OpportunityStoreExecutor;
}

/**
 * Attaches an existing R5-C engagement receipt (looked up server-side) as
 * enrichment evidence on an opportunity candidate. Forged ids (no such
 * receipt), cross-business receipts, unbound receipts and replays all fail
 * closed or collapse idempotently inside D's validated seam.
 */
export async function attachEngagementReceiptById(
  input: AttachEngagementReceiptByIdInput
): Promise<Awaited<ReturnType<typeof attachEngagementEvidence>>> {
  const load = input.loadReceipt ?? engagementReceiptLoader();
  const row = await load(input.engagementReceiptId);
  if (!row) {
    throw new OpportunityInputError(
      "RECEIPT_NOT_FOUND",
      "no server-minted engagement receipt exists with that id."
    );
  }
  const receipt = toEngagementReceiptLike(row);
  return attachEngagementEvidence({
    opportunityId: input.opportunityId,
    receipt,
    userId: input.userId,
    now: input.now,
    executor: input.executor,
  });
}
