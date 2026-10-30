// ─── R8-C Market & External Signal Intelligence — server-side ownership re-verification ───
//
// Every referenced resource is re-verified from durable rows on every call
// (fail closed): the business anchor, contradiction lineage targets and
// supersession targets. Cross-tenant references throw
// MarketSignalOwnershipError; shape/lineage-rule violations throw
// MarketSignalInputError. All reads go through the caller executor seam.

import { and, eq } from "drizzle-orm";
import { businesses, type Business } from "@db/schema";
import {
  MarketSignalInputError,
  MarketSignalOwnershipError,
} from "./market-signal-contract";
import {
  getSignalById,
  type MarketSignalStoreExecutor,
} from "./market-signal-store";

/**
 * Re-verify that businessId belongs to the authenticated tenant and return
 * the durable business row (needed for deterministic relevance terms).
 */
export async function assertBusinessOwnership(
  db: MarketSignalStoreExecutor,
  userId: number,
  businessId: number
): Promise<Business> {
  const [business] = await db
    .select()
    .from(businesses)
    .where(and(eq(businesses.id, businessId), eq(businesses.userId, userId)))
    .limit(1);
  if (!business) {
    throw new MarketSignalOwnershipError(
      "MARKET_SIGNAL_OWNERSHIP_MISMATCH",
      "Business not found or not owned by the authenticated user."
    );
  }
  return business;
}

export interface LineageTargetCheck {
  /** Durable target row, loaded and verified. */
  row: Awaited<ReturnType<typeof getSignalById>> & object;
}

/**
 * Validate one contradiction lineage target: must exist in the same tenant +
 * business, share the same claim family, and carry a DIFFERENT claimKey (a
 * materially different claim about the same subject aspect).
 */
export async function assertContradictionScope(
  db: MarketSignalStoreExecutor,
  userId: number,
  businessId: number,
  selfFamilyKey: string,
  selfClaimKey: string,
  targetSignalId: string
): Promise<void> {
  const target = await getSignalById(userId, targetSignalId, db);
  if (!target) {
    throw new MarketSignalOwnershipError(
      "MARKET_SIGNAL_OWNERSHIP_MISMATCH",
      `Contradiction target ${targetSignalId} not found for the authenticated user.`
    );
  }
  if (Number(target.businessId) !== businessId) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_CROSS_BUSINESS_ASSOCIATION",
      "Cross-business signal association rejected: contradiction target belongs to a different business."
    );
  }
  if (target.claimFamilyKey !== selfFamilyKey) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_LINEAGE_SCOPE_CONFLICT",
      "Contradiction target is not in the same claim family; contradiction lineage rejected."
    );
  }
  if (target.claimKey === selfClaimKey) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_LINEAGE_SCOPE_CONFLICT",
      "Contradiction target carries an identical claim; identical claims corroborate, they do not contradict."
    );
  }
}

/**
 * Validate one supersession target: must exist in the same tenant + business,
 * share the same claim family (newer evidence about the same subject aspect),
 * and not already be in a terminal lineage status.
 */
export async function assertSupersessionScope(
  db: MarketSignalStoreExecutor,
  userId: number,
  businessId: number,
  selfFamilyKey: string,
  targetSignalId: string
): Promise<void> {
  const target = await getSignalById(userId, targetSignalId, db);
  if (!target) {
    throw new MarketSignalOwnershipError(
      "MARKET_SIGNAL_OWNERSHIP_MISMATCH",
      `Supersession target ${targetSignalId} not found for the authenticated user.`
    );
  }
  if (Number(target.businessId) !== businessId) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_CROSS_BUSINESS_ASSOCIATION",
      "Cross-business signal association rejected: supersession target belongs to a different business."
    );
  }
  if (target.claimFamilyKey !== selfFamilyKey) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_LINEAGE_SCOPE_CONFLICT",
      "Supersession target is not in the same claim family; supersession lineage rejected."
    );
  }
  if (target.signalStatus === "SUPERSEDED" || target.signalStatus === "INVALIDATED") {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_LINEAGE_SCOPE_CONFLICT",
      `Supersession target ${targetSignalId} is already ${target.signalStatus}.`
    );
  }
}
