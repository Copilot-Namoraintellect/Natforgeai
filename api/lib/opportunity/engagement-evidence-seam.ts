// ─── R5-D Opportunity Detection — R5-C engagement evidence seam (contract §13, D7) ───
//
// R5-C's durable engagement receipt was not available at implementation time
// (its branch ref equals the programme base), so R5-D consumes engagement
// evidence ONLY through this narrow structural seam. Basic detection works
// from R5-A + R5-B alone; a validated receipt can strengthen an existing
// candidate but never creates one and is never required.
//
// R5-X convergence requirements (documented in the candidate contract §13):
//   (a) R5-C mints immutable receipt rows with a verifiable receiptHash over
//       canonical receipt coordinates;
//   (b) each receipt binds exactly one interpretation/signal identity;
//   (c) a read-only lookup by engagementReceiptId backs this seam.
//
// PURE validation module: no I/O, no clock. Forged or malformed receipts fail
// closed with ForgedEvidenceError before any persistence.

import { z } from "zod";
import {
  ForgedEvidenceError,
  canonicalJson,
  sha256Hex,
} from "./opportunity-contract";

export const ENGAGEMENT_RECEIPT_SEAM_VERSION = "engagement-receipt-seam/v1" as const;

export const ENGAGEMENT_RECEIPT_OUTCOMES = [
  "positive_response",
  "provider_confirmed_follow_up",
  "thread_remained_active",
] as const;

const ISO_8601_PARSEABLE = (value: string) => !Number.isNaN(Date.parse(value));
const ISO_REFINEMENT = { message: "must be a parseable ISO 8601 timestamp" } as const;

export const EngagementReceiptLikeSchema = z.strictObject({
  engagementReceiptId: z.string().min(1).max(128),
  sourceInterpretationId: z.string().min(1).max(64),
  sourceSignalId: z.string().min(1).max(128),
  businessId: z.number().int().positive().nullable(),
  outcome: z.enum(ENGAGEMENT_RECEIPT_OUTCOMES),
  providerReceiptRef: z.string().min(1).max(255).nullable(),
  occurredAt: z.string().min(1).refine(ISO_8601_PARSEABLE, ISO_REFINEMENT),
  receiptHash: z.string().regex(/^[a-f0-9]{64}$/, "receiptHash must be 64 hex chars"),
  recordedAt: z.string().min(1).refine(ISO_8601_PARSEABLE, ISO_REFINEMENT),
});

export type EngagementReceiptLike = z.infer<typeof EngagementReceiptLikeSchema>;

/** Canonical receipt fragment bound into receiptHash by the producer. The
 *  hashed fragment is rebuilt field-by-field so callers cannot smuggle extra
 *  material into (or out of) the integrity hash. */
export function deriveReceiptHash(input: {
  engagementReceiptId: string;
  sourceInterpretationId: string;
  sourceSignalId: string;
  businessId: number | null;
  outcome: string;
  providerReceiptRef: string | null;
  occurredAt: string;
}): string {
  return sha256Hex(
    canonicalJson({
      engagementReceiptId: input.engagementReceiptId,
      sourceInterpretationId: input.sourceInterpretationId,
      sourceSignalId: input.sourceSignalId,
      businessId: input.businessId,
      outcome: input.outcome,
      providerReceiptRef: input.providerReceiptRef,
      occurredAt: input.occurredAt,
    })
  );
}

/**
 * Validates an R5-C-facing receipt. Fails closed (ForgedEvidenceError) on any
 * schema deviation or hash mismatch — a forged receipt can never strengthen a
 * candidate (adversarial case 20).
 */
export function toValidatedEngagementReceipt(input: unknown): EngagementReceiptLike {
  const parsed = EngagementReceiptLikeSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ForgedEvidenceError("INVALID_ENGAGEMENT_RECEIPT", `Engagement receipt failed validation: ${issues}`);
  }
  const data = parsed.data;
  const expected = deriveReceiptHash({
    engagementReceiptId: data.engagementReceiptId,
    sourceInterpretationId: data.sourceInterpretationId,
    sourceSignalId: data.sourceSignalId,
    businessId: data.businessId,
    outcome: data.outcome,
    providerReceiptRef: data.providerReceiptRef,
    occurredAt: data.occurredAt,
  });
  if (expected !== data.receiptHash) {
    throw new ForgedEvidenceError(
      "FORGED_ENGAGEMENT_RECEIPT",
      "Engagement receipt hash mismatch; refusing to accept forged evidence."
    );
  }
  return data;
}
