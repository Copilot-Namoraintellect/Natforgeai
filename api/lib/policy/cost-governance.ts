/**
 * Cost / Quota / Rate Governance (WBS-R5-E5).
 *
 * Policy-level eligibility evaluation for money and volume. This module
 * DECIDES eligibility; it never charges. Charging/settlement stays in the R4
 * billing authority (credit-engine / cost-control / reservation store) and
 * downstream consumers settle only against the deterministic billing identity
 * produced here.
 *
 * Rules enforced (R5-E mission):
 * - no action executes because a budget check was skipped — the decision
 *   engine always runs these checks for executable dispositions;
 * - one logical billable action -> one stable billing identity (derived from
 *   the action request identity, never random, never re-stamped);
 * - denied/suppressed/escalated actions are non-billable by construction;
 * - non-billable policy checks remain non-billable (this module performs no
 *   deductions and its own work is never metered);
 * - approval-waiting actions carry no charge: the billing identity is only
 *   consumed at execution settlement time;
 * - retries preserve cost identity: the same request derives the same
 *   billing identity forever.
 *
 * Pure module: all authority state is injected as explicit snapshots by the
 * server-side resolver; no database access, no clock, no I/O.
 */

import { createHash } from "crypto";
import {
  ACTION_COST_CREDITS,
  isBillableAction,
  type MarketingActionRequest,
} from "./action-request";
import type { PolicyReasonCode } from "./policy-types";

/** Server-resolved financial authority snapshot (UTC day semantics). */
export interface CostAuthoritySnapshot {
  /** Current wallet balance (credits). */
  walletBalance: number;
  /** Credits currently held by open reservations. */
  openReservationCredits: number;
  /** Credits deducted so far today (ai_usage). */
  dailySpend: number;
  /** Credits deducted so far this month. */
  monthlySpend: number;
  /** System-wide daily AI limit. */
  dailySystemLimit: number;
  /** System-wide monthly AI limit. */
  monthlySystemLimit: number;
  /** Per-wallet spend ceiling; null = unlimited. */
  walletSpendLimit: number | null;
  /** Credits already spent by executed AUTONOMOUS actions today. */
  periodAutonomousSpend: number;
}

/** Server-resolved action volume snapshot (UTC day semantics). */
export interface VolumeAuthoritySnapshot {
  actionsExecutedToday: number;
  channelActionsToday: Record<string, number>;
}

/** Provider-side rate-limit state. */
export interface ProviderRateSnapshot {
  rateLimited: boolean;
  rateLimitReason?: string | null;
}

export interface PolicySpendCaps {
  maxAutonomousCreditsPerDay: number;
  maxActionCredits: number;
}

export interface PolicyVolumeCaps {
  maxActionsPerDay: number;
  maxActionsPerChannelPerDay: number;
}

export interface CostEligibility {
  costEligible: boolean;
  reasonCodes: PolicyReasonCode[];
  /** Authoritative per-action credit estimate. */
  estimatedCredits: number;
}

export interface RateEligibility {
  rateEligible: boolean;
  reasonCodes: PolicyReasonCode[];
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertSnapshotNumber(value: unknown, field: string): number {
  if (!isNonNegativeFinite(value)) {
    throw new Error(`cost-governance: ${field} must be a non-negative finite number, got ${String(value)}.`);
  }
  return value;
}

/**
 * Evaluate cost eligibility for one action. Non-billable actions are
 * eligible with zero cost and a NON_BILLABLE marker. Billable actions must
 * clear every financial gate; all violated gates are reported in a fixed,
 * deterministic order.
 */
export function evaluateCostEligibility(input: {
  request: MarketingActionRequest;
  billable: boolean;
  policySpend: PolicySpendCaps;
  cost: CostAuthoritySnapshot;
}): CostEligibility {
  const { billable, policySpend, cost } = input;
  const estimatedCredits = ACTION_COST_CREDITS[input.request.actionType];

  if (!billable) {
    return { costEligible: true, reasonCodes: ["NON_BILLABLE_ACTION"], estimatedCredits: 0 };
  }

  assertSnapshotNumber(cost.walletBalance, "walletBalance");
  assertSnapshotNumber(cost.openReservationCredits, "openReservationCredits");
  assertSnapshotNumber(cost.dailySpend, "dailySpend");
  assertSnapshotNumber(cost.monthlySpend, "monthlySpend");
  assertSnapshotNumber(cost.dailySystemLimit, "dailySystemLimit");
  assertSnapshotNumber(cost.monthlySystemLimit, "monthlySystemLimit");
  assertSnapshotNumber(cost.periodAutonomousSpend, "periodAutonomousSpend");

  const reasonCodes: PolicyReasonCode[] = [];

  if (estimatedCredits > policySpend.maxActionCredits) {
    reasonCodes.push("COST_CLASS_EXCEEDS_POLICY_CAP");
  }
  if (cost.walletBalance - cost.openReservationCredits < estimatedCredits) {
    reasonCodes.push("BUDGET_INSUFFICIENT_BALANCE");
  }
  if (cost.dailySpend + estimatedCredits > cost.dailySystemLimit) {
    reasonCodes.push("BUDGET_DAILY_SYSTEM_LIMIT");
  }
  if (cost.monthlySpend + estimatedCredits > cost.monthlySystemLimit) {
    reasonCodes.push("BUDGET_MONTHLY_SYSTEM_LIMIT");
  }
  if (
    cost.walletSpendLimit !== null &&
    cost.dailySpend + estimatedCredits > cost.walletSpendLimit
  ) {
    reasonCodes.push("BUDGET_WALLET_SPEND_LIMIT");
  }
  if (cost.periodAutonomousSpend + estimatedCredits > policySpend.maxAutonomousCreditsPerDay) {
    reasonCodes.push("BUDGET_AUTONOMOUS_DAILY_CAP");
  }

  return { costEligible: reasonCodes.length === 0, reasonCodes, estimatedCredits };
}

/**
 * Evaluate rate/volume eligibility: policy per-day and per-channel caps plus
 * the provider's own rate-limit state. A provider rate limit never widens
 * anything — it can only block.
 */
export function evaluateRateEligibility(input: {
  platform: string;
  policyVolume: PolicyVolumeCaps;
  volume: VolumeAuthoritySnapshot;
  providerRate: ProviderRateSnapshot;
}): RateEligibility {
  const { platform, policyVolume, volume, providerRate } = input;

  assertSnapshotNumber(volume.actionsExecutedToday, "actionsExecutedToday");
  const channelCount = volume.channelActionsToday[platform] ?? 0;
  if (!isNonNegativeFinite(channelCount)) {
    throw new Error(`cost-governance: channel count for ${platform} must be a non-negative finite number.`);
  }

  const reasonCodes: PolicyReasonCode[] = [];

  if (providerRate.rateLimited === true) {
    reasonCodes.push("RATE_LIMIT_PROVIDER");
  }
  if (volume.actionsExecutedToday + 1 > policyVolume.maxActionsPerDay) {
    reasonCodes.push("QUOTA_DAILY_ACTION_CAP");
  }
  if (channelCount + 1 > policyVolume.maxActionsPerChannelPerDay) {
    reasonCodes.push("QUOTA_CHANNEL_DAILY_CAP");
  }

  return { rateEligible: reasonCodes.length === 0, reasonCodes };
}

/**
 * Deterministic billing identity for one logical billable action. Derived
 * only from durable identity fields (never time, never randomness) so every
 * retry of the same action request converges on the same identity and no
 * double charge is possible. Non-billable actions carry null.
 */
export function buildBillingIdentity(
  request: MarketingActionRequest,
  derivedCostClass: "none" | "low" | "standard" | "high"
): string | null {
  if (!isBillableAction(request.actionType)) return null;
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        scope: "natforge-policy-billing",
        actionRequestId: request.actionRequestId,
        businessId: request.businessId,
        actionType: request.actionType,
        platform: request.platform,
        derivedCostClass,
      }),
      "utf8"
    )
    .digest("hex")
    .slice(0, 40);
  return `bill_${hash}`;
}
