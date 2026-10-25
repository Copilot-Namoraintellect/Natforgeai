// ─── R6-E Conversion Tracking — server-side ownership re-verification ───
//
// Every referenced resource is re-verified from durable rows on every call
// (fail closed). Cross-tenant or cross-business references throw
// ConversionOwnershipError; reversal-target shape checks throw
// ConversionInputError. All reads go through the caller executor seam.

import { and, eq } from "drizzle-orm";
import {
  businesses,
  campaigns,
  leads,
  opportunityCandidates,
  engagementReceipts,
  socialSignals,
  type ConversionEventRow,
} from "@db/schema";
import {
  ConversionInputError,
  ConversionOwnershipError,
  REVERSAL_TYPE_SET,
  type ConversionIngestInput,
} from "./conversion-contract";
import {
  getConversionByConversionId,
  type ConversionStoreExecutor,
} from "./conversion-store";

export interface ConversionOwnershipResult {
  /** Reversal target row, loaded and verified, when this is a reversal. */
  target: ConversionEventRow | null;
}

/**
 * Re-verify ownership of businessId and every optional provenance/reference
 * from durable rows for the authenticated tenant. A mismatch is never
 * downgraded: it fails closed before any identity or persistence work.
 */
export async function assertConversionOwnership(
  db: ConversionStoreExecutor,
  userId: number,
  input: ConversionIngestInput
): Promise<ConversionOwnershipResult> {
  // ─── Business anchor ───
  const [business] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(and(eq(businesses.id, input.businessId), eq(businesses.userId, userId)))
    .limit(1);
  if (!business) {
    throw new ConversionOwnershipError(
      "OWNERSHIP_MISMATCH",
      "Business not found or not owned by the authenticated user."
    );
  }

  // ─── Optional lead linkage (must be same tenant + same business) ───
  if (input.leadId !== undefined) {
    const [lead] = await db
      .select({ id: leads.id, businessId: leads.businessId })
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.userId, userId)))
      .limit(1);
    if (!lead) {
      throw new ConversionOwnershipError(
        "FORBIDDEN",
        "Lead not found or not owned by the authenticated user."
      );
    }
    if (lead.businessId !== null && lead.businessId !== undefined && Number(lead.businessId) !== input.businessId) {
      throw new ConversionOwnershipError(
        "OWNERSHIP_MISMATCH",
        "Lead belongs to a different business; cross-business linkage rejected."
      );
    }
  }

  // ─── Optional campaign provenance ───
  if (input.sourceCampaignId !== undefined) {
    const [campaign] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, input.sourceCampaignId), eq(campaigns.userId, userId)))
      .limit(1);
    if (!campaign) {
      throw new ConversionOwnershipError(
        "FORBIDDEN",
        "Campaign not found or not owned by the authenticated user."
      );
    }
  }

  // ─── Optional opportunity provenance (same tenant + same business) ───
  if (input.sourceOpportunityId !== undefined) {
    const [opportunity] = await db
      .select({ opportunityId: opportunityCandidates.opportunityId })
      .from(opportunityCandidates)
      .where(
        and(
          eq(opportunityCandidates.opportunityId, input.sourceOpportunityId),
          eq(opportunityCandidates.userId, userId),
          eq(opportunityCandidates.businessId, input.businessId)
        )
      )
      .limit(1);
    if (!opportunity) {
      throw new ConversionOwnershipError(
        "FORBIDDEN",
        "Opportunity candidate not found or not owned by this user and business."
      );
    }
  }

  // ─── Optional engagement receipt provenance (business anchor) ───
  if (input.sourceEngagementReceiptId !== undefined) {
    const [receipt] = await db
      .select({
        engagementReceiptId: engagementReceipts.engagementReceiptId,
        userId: engagementReceipts.userId,
        businessId: engagementReceipts.businessId,
      })
      .from(engagementReceipts)
      .where(eq(engagementReceipts.engagementReceiptId, input.sourceEngagementReceiptId))
      .limit(1);
    if (!receipt) {
      throw new ConversionOwnershipError("FORBIDDEN", "Engagement receipt not found.");
    }
    if (Number(receipt.userId) !== userId || Number(receipt.businessId) !== input.businessId) {
      throw new ConversionOwnershipError(
        "OWNERSHIP_MISMATCH",
        "Engagement receipt belongs to a different tenant or business."
      );
    }
  }

  // ─── Optional social-signal provenance (stable signalKey anchor) ───
  if (input.sourceSignalId !== undefined) {
    const [signal] = await db
      .select({ signalKey: socialSignals.signalKey })
      .from(socialSignals)
      .where(
        and(eq(socialSignals.signalKey, input.sourceSignalId), eq(socialSignals.userId, userId))
      )
      .limit(1);
    if (!signal) {
      throw new ConversionOwnershipError(
        "FORBIDDEN",
        "Social signal not found or not owned by the authenticated user."
      );
    }
  }

  // ─── Reversal target (required iff reversal type; no reversal-of-reversal) ───
  const isReversal = REVERSAL_TYPE_SET.has(input.conversionType);
  if (isReversal) {
    if (input.reversesConversionId === undefined) {
      throw new ConversionInputError(
        "CONVERSION_REVERSAL_TARGET_REQUIRED",
        `conversion type "${input.conversionType}" requires reversesConversionId.`
      );
    }
    const target = await getConversionByConversionId(userId, input.reversesConversionId, db);
    if (!target) {
      throw new ConversionOwnershipError(
        "FORBIDDEN",
        "Reversal target conversion not found for the authenticated user."
      );
    }
    if (target.reversesConversionId !== null && target.reversesConversionId !== undefined) {
      throw new ConversionInputError(
        "CONVERSION_REVERSAL_OF_REVERSAL_FORBIDDEN",
        "Reversal-of-reversal is forbidden: the target is itself a reversal."
      );
    }
    if (
      input.currency !== undefined &&
      target.currency !== null &&
      target.currency !== undefined &&
      target.currency !== input.currency
    ) {
      throw new ConversionInputError(
        "CONVERSION_CURRENCY_MISMATCH",
        `Reversal currency ${input.currency} does not match target currency ${target.currency}.`
      );
    }
    return { target };
  }

  if (input.reversesConversionId !== undefined) {
    throw new ConversionInputError(
      "CONVERSION_REVERSAL_TARGET_REQUIRED",
      "reversesConversionId is only permitted for reversal types (refund, cancellation, reversal)."
    );
  }
  return { target: null };
}
