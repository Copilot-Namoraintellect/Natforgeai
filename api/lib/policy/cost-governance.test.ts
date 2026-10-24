/**
 * WBS-R5-E5 — Cost / quota / rate governance acceptance.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateCostEligibility,
  evaluateRateEligibility,
  buildBillingIdentity,
  type CostAuthoritySnapshot,
  type VolumeAuthoritySnapshot,
} from "./cost-governance";
import { buildMarketingActionRequest, type MarketingActionRequestInput } from "./action-request";

const SPEND = { maxAutonomousCreditsPerDay: 20, maxActionCredits: 20 };
const VOLUME = { maxActionsPerDay: 50, maxActionsPerChannelPerDay: 20 };

function cost(overrides: Partial<CostAuthoritySnapshot> = {}): CostAuthoritySnapshot {
  return {
    walletBalance: 100,
    openReservationCredits: 0,
    dailySpend: 0,
    monthlySpend: 0,
    dailySystemLimit: 1000,
    monthlySystemLimit: 10000,
    walletSpendLimit: null,
    periodAutonomousSpend: 0,
    ...overrides,
  };
}

const REPLY: MarketingActionRequestInput = {
  actionRequestId: "ar1:c-1",
  businessId: 10,
  sourceSignalId: "sig-1",
  sourceInterpretationId: "interp-1",
  actionType: "reply_publicly",
  platform: "instagram",
  providerAccountBinding: { integrationId: 4, platform: "instagram", externalAccountRef: "p1" },
  campaignId: null,
  publicationId: null,
  estimatedCostClass: "low",
  requestedAt: "2026-06-28T10:00:00.000Z",
  contextVersion: "ctx:1",
};

const OBSERVE: MarketingActionRequestInput = {
  ...REPLY,
  actionRequestId: "ar1:o-1",
  actionType: "observe_only",
  estimatedCostClass: "none",
  providerAccountBinding: null,
};

describe("E5 cost governance", () => {
  it("non-billable actions are eligible at zero cost and never billable", () => {
    const request = buildMarketingActionRequest(OBSERVE);
    const result = evaluateCostEligibility({ request, billable: false, policySpend: SPEND, cost: cost() });
    expect(result.costEligible).toBe(true);
    expect(result.reasonCodes).toEqual(["NON_BILLABLE_ACTION"]);
    expect(result.estimatedCredits).toBe(0);
    expect(buildBillingIdentity(request, "none")).toBeNull();
  });

  it("affordable billable action is eligible with the derived estimate", () => {
    const request = buildMarketingActionRequest(REPLY);
    const result = evaluateCostEligibility({ request, billable: true, policySpend: SPEND, cost: cost() });
    expect(result.costEligible).toBe(true);
    expect(result.reasonCodes).toEqual([]);
    expect(result.estimatedCredits).toBe(1);
  });

  it("budget exhaustion fails closed with BUDGET_INSUFFICIENT_BALANCE", () => {
    const request = buildMarketingActionRequest(REPLY);
    const result = evaluateCostEligibility({
      request,
      billable: true,
      policySpend: SPEND,
      cost: cost({ walletBalance: 0 }),
    });
    expect(result.costEligible).toBe(false);
    expect(result.reasonCodes).toContain("BUDGET_INSUFFICIENT_BALANCE");
  });

  it("open reservations reduce available balance", () => {
    const request = buildMarketingActionRequest(REPLY);
    const result = evaluateCostEligibility({
      request,
      billable: true,
      policySpend: SPEND,
      cost: cost({ walletBalance: 5, openReservationCredits: 5 }),
    });
    expect(result.costEligible).toBe(false);
    expect(result.reasonCodes).toContain("BUDGET_INSUFFICIENT_BALANCE");
  });

  it("daily system limit blocks", () => {
    const request = buildMarketingActionRequest(REPLY);
    const result = evaluateCostEligibility({
      request,
      billable: true,
      policySpend: SPEND,
      cost: cost({ dailySpend: 1000, dailySystemLimit: 1000 }),
    });
    expect(result.costEligible).toBe(false);
    expect(result.reasonCodes).toContain("BUDGET_DAILY_SYSTEM_LIMIT");
  });

  it("monthly system limit blocks", () => {
    const request = buildMarketingActionRequest(REPLY);
    const result = evaluateCostEligibility({
      request,
      billable: true,
      policySpend: SPEND,
      cost: cost({ monthlySpend: 10000, monthlySystemLimit: 10000 }),
    });
    expect(result.costEligible).toBe(false);
    expect(result.reasonCodes).toContain("BUDGET_MONTHLY_SYSTEM_LIMIT");
  });

  it("wallet spend limit blocks", () => {
    const request = buildMarketingActionRequest(REPLY);
    const result = evaluateCostEligibility({
      request,
      billable: true,
      policySpend: SPEND,
      cost: cost({ dailySpend: 10, walletSpendLimit: 10 }),
    });
    expect(result.costEligible).toBe(false);
    expect(result.reasonCodes).toContain("BUDGET_WALLET_SPEND_LIMIT");
  });

  it("autonomous daily spend cap blocks", () => {
    const request = buildMarketingActionRequest(REPLY);
    const result = evaluateCostEligibility({
      request,
      billable: true,
      policySpend: SPEND,
      cost: cost({ periodAutonomousSpend: 20 }),
    });
    expect(result.costEligible).toBe(false);
    expect(result.reasonCodes).toContain("BUDGET_AUTONOMOUS_DAILY_CAP");
  });

  it("per-action credit ceiling blocks expensive classes", () => {
    const request = buildMarketingActionRequest({ ...REPLY, actionType: "nurture_candidate", estimatedCostClass: "standard" });
    const result = evaluateCostEligibility({
      request,
      billable: true,
      policySpend: { maxAutonomousCreditsPerDay: 100, maxActionCredits: 2 },
      cost: cost(),
    });
    expect(result.costEligible).toBe(false);
    expect(result.reasonCodes).toContain("COST_CLASS_EXCEEDS_POLICY_CAP");
  });

  it("reports multiple violated gates deterministically", () => {
    const request = buildMarketingActionRequest(REPLY);
    const result = evaluateCostEligibility({
      request,
      billable: true,
      policySpend: SPEND,
      cost: cost({ walletBalance: 0, dailySpend: 1000, dailySystemLimit: 1000 }),
    });
    expect(result.reasonCodes).toEqual([
      "BUDGET_INSUFFICIENT_BALANCE",
      "BUDGET_DAILY_SYSTEM_LIMIT",
    ]);
  });
});

describe("E5 rate governance", () => {
  const vol = (overrides: Partial<VolumeAuthoritySnapshot> = {}): VolumeAuthoritySnapshot => ({
    actionsExecutedToday: 0,
    channelActionsToday: {},
    ...overrides,
  });

  it("allows within caps", () => {
    const result = evaluateRateEligibility({
      platform: "instagram",
      policyVolume: VOLUME,
      volume: vol(),
      providerRate: { rateLimited: false },
    });
    expect(result.rateEligible).toBe(true);
    expect(result.reasonCodes).toEqual([]);
  });

  it("provider rate limit blocks", () => {
    const result = evaluateRateEligibility({
      platform: "instagram",
      policyVolume: VOLUME,
      volume: vol(),
      providerRate: { rateLimited: true, rateLimitReason: "provider 429" },
    });
    expect(result.rateEligible).toBe(false);
    expect(result.reasonCodes).toContain("RATE_LIMIT_PROVIDER");
  });

  it("daily action cap blocks", () => {
    const result = evaluateRateEligibility({
      platform: "instagram",
      policyVolume: VOLUME,
      volume: vol({ actionsExecutedToday: 50 }),
      providerRate: { rateLimited: false },
    });
    expect(result.rateEligible).toBe(false);
    expect(result.reasonCodes).toContain("QUOTA_DAILY_ACTION_CAP");
  });

  it("per-channel cap blocks", () => {
    const result = evaluateRateEligibility({
      platform: "instagram",
      policyVolume: VOLUME,
      volume: vol({ channelActionsToday: { instagram: 20 } }),
      providerRate: { rateLimited: false },
    });
    expect(result.rateEligible).toBe(false);
    expect(result.reasonCodes).toContain("QUOTA_CHANNEL_DAILY_CAP");
  });
});

describe("E5 billing identity", () => {
  it("is stable for retries of the same request", () => {
    const a = buildMarketingActionRequest(REPLY);
    const b = buildMarketingActionRequest({ ...REPLY, requestedAt: "2026-06-28T12:00:00.000Z" });
    expect(buildBillingIdentity(a, "low")).toBe(buildBillingIdentity(b, "low"));
  });

  it("differs across logical actions", () => {
    const a = buildMarketingActionRequest(REPLY);
    const b = buildMarketingActionRequest({ ...REPLY, actionRequestId: "ar1:c-2" });
    expect(buildBillingIdentity(a, "low")).not.toBe(buildBillingIdentity(b, "low"));
  });

  it("is null for non-billable actions (denied/suppressed cannot charge)", () => {
    const observe = buildMarketingActionRequest(OBSERVE);
    const escalate = buildMarketingActionRequest({ ...OBSERVE, actionRequestId: "ar1:e-1", actionType: "escalate_to_human" });
    expect(buildBillingIdentity(observe, "none")).toBeNull();
    expect(buildBillingIdentity(escalate, "none")).toBeNull();
  });
});
