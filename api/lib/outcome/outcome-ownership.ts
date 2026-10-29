// ─── R7-A Conversion Outcome Intelligence — server-side ownership re-verification ───
//
// Every referenced resource is re-verified from durable rows on every call
// (fail closed): the business anchor, the canonical R6-E conversion, the
// conversion-carried numeric lead reference, and any lineage target (reversal /
// renewal / supersession). Cross-tenant or cross-business references throw
// OutcomeOwnershipError; shape/lineage-rule violations throw OutcomeInputError.
// All reads go through the caller executor seam.

import { and, eq } from "drizzle-orm";
import {
  businesses,
  conversionEvents,
  leads,
  type BusinessOutcomeRow,
  type ConversionEventRow,
} from "@db/schema";
import { isFinancialAuthorityTrustClass } from "../conversion/conversion-trust";
import {
  OutcomeInputError,
  OutcomeOwnershipError,
  type OutcomeRecordInput,
} from "./outcome-contract";
import { assertConversionValueConsistency, assertReversalValueConsistency } from "./outcome-value";
import { isReversalOutcomeType } from "./outcome-lifecycle";
import {
  getOutcomeByOutcomeId,
  type OutcomeStoreExecutor,
} from "./outcome-store";

export interface OutcomeOwnershipResult {
  /** Canonical conversion row, loaded and verified. */
  conversion: ConversionEventRow;
  /** Lineage target row, loaded and verified, when this outcome carries lineage. */
  target: BusinessOutcomeRow | null;
}

/**
 * Re-verify ownership of businessId, the canonical conversion, the lead
 * binding, and any lineage target from durable rows for the authenticated
 * tenant. A mismatch is never downgraded: it fails closed before any identity
 * or persistence work.
 */
export async function assertOutcomeOwnership(
  db: OutcomeStoreExecutor,
  userId: number,
  input: OutcomeRecordInput,
  opts: { tolerateTerminalLineageTarget?: boolean } = {}
): Promise<OutcomeOwnershipResult> {
  // ─── Business anchor ───
  const [business] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(and(eq(businesses.id, input.businessId), eq(businesses.userId, userId)))
    .limit(1);
  if (!business) {
    throw new OutcomeOwnershipError(
      "OWNERSHIP_MISMATCH",
      "Business not found or not owned by the authenticated user."
    );
  }

  // ─── Canonical conversion (tenant-scoped) ───
  const [conversion] = await db
    .select()
    .from(conversionEvents)
    .where(
      and(
        eq(conversionEvents.conversionId, input.conversionId),
        eq(conversionEvents.userId, userId)
      )
    )
    .limit(1);
  if (!conversion) {
    throw new OutcomeOwnershipError(
      "FORBIDDEN",
      "Canonical conversion not found for the authenticated user."
    );
  }
  if (Number(conversion.businessId) !== input.businessId) {
    throw new OutcomeOwnershipError(
      "OWNERSHIP_MISMATCH",
      "Outcome business scope does not match the canonical conversion's business; cross-business outcome rejected."
    );
  }

  // ─── Conversion-carried lead binding (re-verified from the durable lead row) ───
  const conversionLeadId =
    conversion.leadId === null || conversion.leadId === undefined ? null : Number(conversion.leadId);
  if (conversionLeadId !== null) {
    const [lead] = await db
      .select({ id: leads.id, businessId: leads.businessId })
      .from(leads)
      .where(and(eq(leads.id, conversionLeadId), eq(leads.userId, userId)))
      .limit(1);
    if (!lead) {
      throw new OutcomeOwnershipError(
        "FORBIDDEN",
        "Conversion-carried lead reference not found or not owned by the authenticated user."
      );
    }
    if (lead.businessId !== null && lead.businessId !== undefined && Number(lead.businessId) !== input.businessId) {
      throw new OutcomeOwnershipError(
        "OWNERSHIP_MISMATCH",
        "Conversion-carried lead belongs to a different business; cross-business lead binding rejected."
      );
    }
  }

  // ─── Stale evidence: an outcome cannot precede its own conversion ───
  if (Date.parse(input.occurredAt) < Date.parse(conversion.occurredAt)) {
    throw new OutcomeInputError(
      "OUTCOME_EVIDENCE_STALE",
      `outcome occurredAt ${input.occurredAt} precedes the canonical conversion occurredAt ${conversion.occurredAt}; stale evidence rejected.`
    );
  }

  // ─── R6-E amount revalidation: a conversion's authoritative monetary value
  // constrains the outcome business value (never trusted merely for containing
  // a number) ───
  if (
    isFinancialAuthorityTrustClass(conversion.sourceTrustClass as never) &&
    input.valueType === "MONETARY" &&
    conversion.amount !== null &&
    conversion.amount !== undefined
  ) {
    assertConversionValueConsistency({
      conversionAmount: Number(conversion.amount),
      conversionCurrency: conversion.currency ?? null,
      outcomeAmount: input.amountMinor ?? null,
      outcomeCurrency: input.currency ?? null,
    });
  }

  // ─── Lineage targets (at most one — enforced at the boundary) ───
  let target: BusinessOutcomeRow | null = null;
  const lineageId = input.reversesOutcomeId ?? input.renewsOutcomeId ?? input.supersedesOutcomeId;
  if (lineageId !== undefined) {
    target = await getOutcomeByOutcomeId(userId, lineageId, db);
    if (!target) {
      throw new OutcomeOwnershipError(
        "FORBIDDEN",
        "Lineage target outcome not found for the authenticated user."
      );
    }
    if (Number(target.businessId) !== input.businessId) {
      throw new OutcomeOwnershipError(
        "OWNERSHIP_MISMATCH",
        "Lineage target outcome belongs to a different business; cross-business lineage rejected."
      );
    }
    const targetStatus = target.outcomeStatus as never;
    if (
      !opts.tolerateTerminalLineageTarget &&
      (targetStatus === "REVERSED" || targetStatus === "CANCELLED" || targetStatus === "SUPERSEDED")
    ) {
      // A terminal target rejects NEW lineage. A replay of the outcome that
      // already applied the effect converges before this check (the service
      // pre-checks the natural key and passes the tolerate flag); conflicting
      // replay material still fails closed later on the evidence-hash compare.
      throw new OutcomeInputError(
        "OUTCOME_TRANSITION_INVALID",
        `lineage target outcome ${lineageId} is in terminal status ${targetStatus}.`
      );
    }

    if (input.reversesOutcomeId !== undefined) {
      if (isReversalOutcomeType(target.outcomeType)) {
        throw new OutcomeInputError(
          "OUTCOME_REVERSAL_OF_REVERSAL_FORBIDDEN",
          "Reversal-of-reversal is forbidden: the target outcome is itself a reversal."
        );
      }
      assertReversalValueConsistency({
        targetAmount: target.amountMinor === undefined || target.amountMinor === null ? null : Number(target.amountMinor),
        targetCurrency: target.currency ?? null,
        reversalAmount: input.amountMinor ?? null,
        reversalCurrency: input.currency ?? null,
      });
    }

    if (input.renewsOutcomeId !== undefined) {
      if (target.outcomeType !== "SUBSCRIPTION" && target.outcomeType !== "RENEWAL") {
        throw new OutcomeInputError(
          "OUTCOME_LINEAGE_INVALID",
          `renewal lineage requires a SUBSCRIPTION or RENEWAL target outcome; got ${target.outcomeType}.`
        );
      }
    }

    if (input.supersedesOutcomeId !== undefined) {
      if (isReversalOutcomeType(target.outcomeType)) {
        throw new OutcomeInputError(
          "OUTCOME_LINEAGE_INVALID",
          "reversal outcomes cannot be superseded (no reversal-of-reversal by proxy)."
        );
      }
    }
  }

  // ─── Lineage/type family consistency ───
  if (input.reversesOutcomeId === undefined && input.renewsOutcomeId === undefined && input.supersedesOutcomeId === undefined) {
    // Plain positive/non-monetary outcome — nothing further to bind here; the
    // classifier enforces the type family against the conversion semantics.
  }

  return { conversion, target };
}
