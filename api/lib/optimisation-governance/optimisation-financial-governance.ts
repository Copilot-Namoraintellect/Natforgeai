// ─── R7-F Optimisation Governance — financial governance (F3) ───
//
// Pure financial guardrail evaluation. This module CLASSIFIES the financial
// impact of one optimisation proposal and decides whether the financial
// dimension permits autonomy, requires human approval, or must block. It
// never charges, settles, reserves or releases anything — the R4 billing
// authority remains the only settling authority (see F0 inventory).
//
// Mission-critical invariant (F3): an autonomous optimisation agent must not
// increase total authorized business spend merely because its optimisation
// algorithm recommends doing so. There is no agent-created money and no
// client-selected budget ceiling: every ceiling arrives inside the
// server-resolved policy + budget authority snapshot.
//
// Pure module: authority state is injected as explicit snapshots; no database
// access, no clock (the caller supplies `now`), no I/O.

import {
  CURRENCY_PATTERN,
  isIsoUtc,
  OptimisationGovernanceValidationError,
  type OptimisationFinancialImpactClass,
  type OptimisationGovernanceReasonCode,
} from "./optimisation-governance-contract";
import {
  baseFinancialClassForAction,
  isRecommendationOnlyAction,
  type OptimisationActionType,
} from "./optimisation-action-taxonomy";
import type { OptimisationGovernancePolicy } from "./optimisation-policy";

/** One allocation movement proposed by the optimisation agent (proposal material). */
export interface OptimisationAllocationDelta {
  readonly allocationKey: string;
  readonly campaignId: number | null;
  readonly provider: string | null;
  /** Signed minor units; negative releases budget back to the pool. */
  readonly deltaMinor: number;
  /**
   * Client declaration that this delta creates a commitment outside the
   * approved envelope. Declaring a WORSE class is safe — it can only narrow
   * authority; the derived class is always authoritative.
   */
  readonly newCommitment?: boolean;
  /** Client declaration that this delta commits irreversible external spend. */
  readonly irreversibleExternalSpend?: boolean;
}

/** The financial material of a proposal (validated before it reaches here). */
export interface OptimisationProposalFinancial {
  readonly currency: string;
  readonly allocationDeltas: readonly OptimisationAllocationDelta[];
  /** Advisory only; never widens the derived authoritative class. */
  readonly advisoryFinancialClass?: OptimisationFinancialImpactClass | null;
}

/**
 * Server-resolved budget authority snapshot (F3). The server — never the
 * client — supplies the approved budget, the committed/reserved amounts, the
 * locked allocations and the supported provider set. A stale snapshot fails
 * closed.
 */
export interface OptimisationBudgetAuthoritySnapshot {
  /** Budget period, "YYYY-MM" (UTC). */
  readonly budgetPeriod: string;
  readonly currency: string;
  /** Total budget approved for this period (minor units). */
  readonly approvedTotalBudgetMinor: number;
  /** Amount already committed to campaigns/activities (minor units). */
  readonly committedMinor: number;
  /** Amount held by reservations — immutable to optimisation (minor units). */
  readonly reservedMinor: number;
  /** Providers that may receive budget movements. */
  readonly supportedProviders: readonly string[];
  /** Allocation keys whose funds are locked and cannot be moved. */
  readonly lockedAllocationKeys: readonly string[];
  /** When this snapshot was captured (freshness gate). */
  readonly stateCapturedAt: string;
}

export const FINANCIAL_IMPACT_SEVERITY: Readonly<
  Record<OptimisationFinancialImpactClass, number>
> = {
  RECOMMENDATION_ONLY: 0,
  REALLOCATION_WITHIN_APPROVED_TOTAL: 1,
  TOTAL_BUDGET_INCREASE: 2,
  NEW_FINANCIAL_COMMITMENT: 3,
  IRREVERSIBLE_EXTERNAL_SPEND: 4,
};

export interface OptimisationFinancialEvaluation {
  /** Authoritative class derived from action type + material. */
  readonly financialImpactClass: OptimisationFinancialImpactClass;
  /** Sum of signed deltas (minor units). */
  readonly totalDeltaMinor: number;
  /** Sum of |delta| (minor units) — the gross movement. */
  readonly grossMovementMinor: number;
  /** True when the financial dimension imposes no approval requirement. */
  readonly financiallyAutonomous: boolean;
  /** Codes that force the final decision to BLOCK (hard fails). */
  readonly blockReasonCodes: readonly OptimisationGovernanceReasonCode[];
  /** Codes that force the final decision to REVIEW_REQUIRED. */
  readonly reviewReasonCodes: readonly OptimisationGovernanceReasonCode[];
  /** Informational codes recorded on the decision (explainability). */
  readonly infoReasonCodes: readonly OptimisationGovernanceReasonCode[];
  /** Bounded snapshot of the thresholds applied (auditability). */
  readonly thresholds: Readonly<Record<string, number>>;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * Re-validate a raw budget authority snapshot arriving through the provider
 * seam. Untrusted until accepted; malformed snapshots fail closed with
 * OPTIMISATION_BUDGET_AUTHORITY_UNAVAILABLE (the financial dimension can
 * never be evaluated on garbage, and absence of financial authority never
 * widens autonomy).
 */
export function validateOptimisationBudgetAuthoritySnapshot(
  raw: unknown
): OptimisationBudgetAuthoritySnapshot {
  function fail(): never {
    throw new OptimisationGovernanceValidationError(
      "OPTIMISATION_BUDGET_AUTHORITY_UNAVAILABLE",
      "budget authority snapshot failed validation; financial governance unavailable (fail closed)"
    );
  }
  if (typeof raw !== "object" || raw === null) fail();
  const r = raw as Record<string, unknown>;
  const budgetPeriod = r.budgetPeriod;
  const currency = r.currency;
  const approvedTotalBudgetMinor = r.approvedTotalBudgetMinor;
  const committedMinor = r.committedMinor;
  const reservedMinor = r.reservedMinor;
  const supportedProviders = r.supportedProviders;
  const lockedAllocationKeys = r.lockedAllocationKeys;
  const stateCapturedAt = r.stateCapturedAt;
  if (typeof budgetPeriod !== "string" || !/^\d{4}-\d{2}$/.test(budgetPeriod)) fail();
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) fail();
  if (!isNonNegativeInt(approvedTotalBudgetMinor)) fail();
  if (!isNonNegativeInt(committedMinor)) fail();
  if (!isNonNegativeInt(reservedMinor)) fail();
  if (!Array.isArray(supportedProviders)) fail();
  for (const p of supportedProviders) {
    if (typeof p !== "string" || p.trim().length === 0) fail();
  }
  if (!Array.isArray(lockedAllocationKeys)) fail();
  for (const k of lockedAllocationKeys) {
    if (typeof k !== "string" || k.trim().length === 0) fail();
  }
  if (typeof stateCapturedAt !== "string" || !isIsoUtc(stateCapturedAt)) fail();
  return {
    budgetPeriod,
    currency,
    approvedTotalBudgetMinor,
    committedMinor,
    reservedMinor,
    supportedProviders: Object.freeze([...supportedProviders]),
    lockedAllocationKeys: Object.freeze([...lockedAllocationKeys]),
    stateCapturedAt,
  };
}

/**
 * Derive the authoritative financial impact class from the action type and
 * the proposal's financial material. Client declarations of commitment /
 * irreversibility can only raise the class, never lower it.
 */
export function deriveFinancialImpactClass(
  actionType: OptimisationActionType,
  financial: OptimisationProposalFinancial | null
): OptimisationFinancialImpactClass {
  if (isRecommendationOnlyAction(actionType)) return "RECOMMENDATION_ONLY";
  if (!financial || financial.allocationDeltas.length === 0) {
    // A money-moving action with no deltas moves no money: classify by the
    // action's base class (an increase with no material is still an intent
    // to increase — never downgraded silently).
    return baseFinancialClassForAction(actionType);
  }
  if (financial.allocationDeltas.some((d) => d.irreversibleExternalSpend === true)) {
    return "IRREVERSIBLE_EXTERNAL_SPEND";
  }
  if (financial.allocationDeltas.some((d) => d.newCommitment === true)) {
    return "NEW_FINANCIAL_COMMITMENT";
  }
  const totalDelta = financial.allocationDeltas.reduce((sum, d) => sum + d.deltaMinor, 0);
  if (actionType === "BUDGET_INCREASE" || totalDelta > 0) {
    return "TOTAL_BUDGET_INCREASE";
  }
  return "REALLOCATION_WITHIN_APPROVED_TOTAL";
}

/**
 * Evaluate the financial dimension of one proposal. Deterministic: same
 * inputs produce the same classification and the same reason codes in the
 * same order.
 */
export function evaluateOptimisationFinancialGovernance(input: {
  actionType: OptimisationActionType;
  financial: OptimisationProposalFinancial | null;
  policy: OptimisationGovernancePolicy;
  budget: OptimisationBudgetAuthoritySnapshot;
  now: string;
}): OptimisationFinancialEvaluation {
  const { actionType, financial, policy, budget } = input;
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    throw new OptimisationGovernanceValidationError(
      "INVALID_EVALUATION_CLOCK",
      `now must be a valid ISO timestamp, got ${String(input.now)}`
    );
  }
  const f = policy.financial;
  const block: OptimisationGovernanceReasonCode[] = [];
  const review: OptimisationGovernanceReasonCode[] = [];
  const info: OptimisationGovernanceReasonCode[] = [];

  const thresholds: Record<string, number> = {
    autonomousReallocationCapMinor: f.autonomousReallocationCapMinor,
    maxAutonomousReallocationFraction: f.maxAutonomousReallocationFraction,
    maxAutonomousIncreasePerActionMinor: f.maxAutonomousIncreasePerActionMinor,
    staleBudgetStateMs: f.staleBudgetStateMs,
  };

  // Freshness of the financial authority state: a decision may never be
  // taken on a stale budget view (AC7).
  if (nowMs - Date.parse(budget.stateCapturedAt) > f.staleBudgetStateMs) {
    block.push("STALE_BUDGET_STATE");
  }

  // Recommendation-only actions carry no financial material.
  if (isRecommendationOnlyAction(actionType)) {
    if (financial && financial.allocationDeltas.length > 0) {
      block.push("MALFORMED_PROPOSAL");
    }
    return Object.freeze({
      financialImpactClass: "RECOMMENDATION_ONLY",
      totalDeltaMinor: 0,
      grossMovementMinor: 0,
      financiallyAutonomous: block.length === 0,
      blockReasonCodes: Object.freeze(block),
      reviewReasonCodes: Object.freeze(review),
      infoReasonCodes: Object.freeze(info),
      thresholds: Object.freeze(thresholds),
    });
  }

  if (!financial) {
    // A money-moving action must describe its financial material.
    block.push("MALFORMED_PROPOSAL");
    return Object.freeze({
      financialImpactClass: deriveFinancialImpactClass(actionType, null),
      totalDeltaMinor: 0,
      grossMovementMinor: 0,
      financiallyAutonomous: false,
      blockReasonCodes: Object.freeze(block),
      reviewReasonCodes: Object.freeze(review),
      infoReasonCodes: Object.freeze(info),
      thresholds: Object.freeze(thresholds),
    });
  }

  if (financial.currency !== budget.currency) {
    block.push("MALFORMED_PROPOSAL");
  }

  const totalDeltaMinor = financial.allocationDeltas.reduce((sum, d) => sum + d.deltaMinor, 0);
  const grossMovementMinor = financial.allocationDeltas.reduce(
    (sum, d) => sum + Math.abs(d.deltaMinor),
    0
  );

  // Locked/reserved funds are immutable to optimisation (AC22).
  for (const delta of financial.allocationDeltas) {
    if (delta.deltaMinor < 0 && budget.lockedAllocationKeys.includes(delta.allocationKey)) {
      block.push("REALLOCATION_SOURCE_LOCKED");
      break;
    }
  }

  // Unsupported providers can never receive budget (AC23).
  for (const delta of financial.allocationDeltas) {
    if (delta.provider !== null && !budget.supportedProviders.includes(delta.provider)) {
      block.push("UNSUPPORTED_PROVIDER");
      break;
    }
  }

  // Sanity: a reallocation must not drive committed below zero.
  if (budget.committedMinor + totalDeltaMinor < 0) {
    block.push("MALFORMED_PROPOSAL");
  }

  const financialImpactClass = deriveFinancialImpactClass(actionType, financial);

  // Advisory mismatch: a client understating the class is recorded; the
  // derived class stays authoritative (F7 — model output cannot set it).
  if (
    financial.advisoryFinancialClass !== null &&
    financial.advisoryFinancialClass !== undefined &&
    FINANCIAL_IMPACT_SEVERITY[financial.advisoryFinancialClass] <
      FINANCIAL_IMPACT_SEVERITY[financialImpactClass]
  ) {
    info.push("FINANCIAL_CLASS_DECLARATION_MISMATCH");
  }

  switch (financialImpactClass) {
    case "RECOMMENDATION_ONLY":
      break;
    case "REALLOCATION_WITHIN_APPROVED_TOTAL": {
      if (grossMovementMinor > f.autonomousReallocationCapMinor) {
        review.push("REALLOCATION_EXCEEDS_AUTONOMOUS_CAP");
      }
      if (
        budget.approvedTotalBudgetMinor > 0 &&
        grossMovementMinor / budget.approvedTotalBudgetMinor > f.maxAutonomousReallocationFraction
      ) {
        review.push("REALLOCATION_EXCEEDS_FRACTION_LIMIT");
      }
      break;
    }
    case "TOTAL_BUDGET_INCREASE": {
      if (!f.allowAutonomousTotalIncrease) {
        review.push("TOTAL_BUDGET_INCREASE_REQUIRES_APPROVAL");
        info.push("AUTONOMOUS_TOTAL_BUDGET_INCREASE_FORBIDDEN");
      } else if (totalDeltaMinor > f.maxAutonomousIncreasePerActionMinor) {
        review.push("TOTAL_BUDGET_INCREASE_REQUIRES_APPROVAL");
      }
      break;
    }
    case "NEW_FINANCIAL_COMMITMENT": {
      if (!f.allowNewFinancialCommitments) {
        review.push("NEW_FINANCIAL_COMMITMENT_REQUIRES_APPROVAL");
      }
      break;
    }
    case "IRREVERSIBLE_EXTERNAL_SPEND": {
      if (!f.allowIrreversibleExternalSpend) {
        review.push("IRREVERSIBLE_SPEND_REQUIRES_APPROVAL");
      }
      break;
    }
  }

  return Object.freeze({
    financialImpactClass,
    totalDeltaMinor,
    grossMovementMinor,
    financiallyAutonomous: block.length === 0 && review.length === 0,
    blockReasonCodes: Object.freeze(block),
    reviewReasonCodes: Object.freeze(review),
    infoReasonCodes: Object.freeze(info),
    thresholds: Object.freeze(thresholds),
  });
}

/** True when the snapshot integer fields are internally consistent. */
export function assertFinancialMaterialWellFormed(
  financial: OptimisationProposalFinancial
): void {
  if (!CURRENCY_PATTERN.test(financial.currency)) {
    throw new OptimisationGovernanceValidationError(
      "MALFORMED_PROPOSAL",
      `currency must be a 3-letter uppercase code, got ${JSON.stringify(financial.currency)}`
    );
  }
  for (const delta of financial.allocationDeltas) {
    if (!isInt(delta.deltaMinor)) {
      throw new OptimisationGovernanceValidationError(
        "MALFORMED_PROPOSAL",
        "allocation deltaMinor must be an integer number of minor units"
      );
    }
  }
}
