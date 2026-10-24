/**
 * WBS-R5-E3 — Policy decision engine acceptance.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateMarketingActionPolicy,
  buildPolicyDecisionId,
  type PolicyEvaluationInput,
} from "./decision-engine";
import { buildMarketingActionRequest, type MarketingActionRequestInput } from "./action-request";
import {
  buildBusinessPolicyConfig,
  buildDefaultPolicyConfig,
  buildVersionedPolicy,
  type BusinessPolicyConfig,
} from "./policy-model";
import type { AuthoritativeIntelligence } from "./risk-classification";
import type { CostAuthoritySnapshot, VolumeAuthoritySnapshot } from "./cost-governance";

const NOW = "2026-06-28T12:00:00.000Z";

function policyConfig(overrides: Partial<BusinessPolicyConfig> = {}): BusinessPolicyConfig {
  const base = buildDefaultPolicyConfig();
  return buildBusinessPolicyConfig({
    ...base,
    actions: {
      autonomous: ["react", "reply_publicly", "observe_only"],
      requireApproval: ["reply_privately"],
      prohibited: ["nurture_candidate"],
    },
    ...overrides,
  } as unknown as BusinessPolicyConfig);
}

const POLICY = buildVersionedPolicy(10, 1, policyConfig());

const REQUEST: MarketingActionRequestInput = {
  actionRequestId: "ar1:c-1",
  businessId: 10,
  sourceSignalId: "sig-1",
  sourceInterpretationId: "interp-1",
  actionType: "reply_publicly",
  platform: "instagram",
  providerAccountBinding: { integrationId: 4, platform: "instagram", externalAccountRef: "p1" },
  campaignId: 55,
  publicationId: null,
  estimatedCostClass: "low",
  requestedAt: NOW,
  contextVersion: "ctx:1",
};

const INTEL: AuthoritativeIntelligence = {
  sourceInterpretationId: "interp-1",
  intelligenceVersion: "iv-1",
  sentiment: "positive",
  intentClass: "praise",
  confidence: 0.95,
  containsPersonalData: false,
  injectionSuspected: false,
};

const COST: CostAuthoritySnapshot = {
  walletBalance: 100,
  openReservationCredits: 0,
  dailySpend: 0,
  monthlySpend: 0,
  dailySystemLimit: 1000,
  monthlySystemLimit: 10000,
  walletSpendLimit: null,
  periodAutonomousSpend: 0,
};

const VOLUME: VolumeAuthoritySnapshot = { actionsExecutedToday: 0, channelActionsToday: {} };

function evalInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    request: buildMarketingActionRequest(REQUEST),
    userId: 7,
    policy: POLICY,
    intelligence: INTEL,
    cost: COST,
    volume: VOLUME,
    providerRate: { rateLimited: false },
    providerCapability: { bindingVerified: true, capabilityAvailable: true },
    now: NOW,
    ...overrides,
  };
}

describe("E3 decision engine", () => {
  it("allows a low-risk action in the autonomous list", () => {
    const d = evaluateMarketingActionPolicy(evalInput());
    expect(d.decision).toBe("ALLOW_AUTONOMOUS");
    expect(d.reasonCodes).toContain("ACTION_ALLOWED_BY_POLICY");
    expect(d.riskClass).toBe("low");
    expect(d.approvalRequired).toBe(false);
    expect(d.costEligible).toBe(true);
    expect(d.rateEligible).toBe(true);
    expect(d.providerEligible).toBe(true);
    expect(d.billingIdentity).toMatch(/^bill_[0-9a-f]{40}$/);
    expect(d.expiresAt).not.toBeNull();
  });

  it("requires approval for medium risk even when the action is autonomous-listed", () => {
    const d = evaluateMarketingActionPolicy(
      evalInput({ intelligence: { ...INTEL, intentClass: "product_objection", confidence: 0.9 } })
    );
    expect(d.decision).toBe("REQUIRE_APPROVAL");
    expect(d.reasonCodes).toContain("APPROVAL_REQUIRED_BY_RISK");
    expect(d.approvalRequired).toBe(true);
    expect(d.approvalBinding).not.toBeNull();
    expect(d.approvalBinding?.policyVersion).toBe(POLICY.policyVersion);
  });

  it("escalates high risk", () => {
    const d = evaluateMarketingActionPolicy(
      evalInput({ intelligence: { ...INTEL, intentClass: "severe_complaint" } })
    );
    expect(d.decision).toBe("ESCALATE");
    expect(d.reasonCodes).toContain("ESCALATED_BY_RISK");
    expect(d.approvalBinding).toBeNull();
  });

  it("escalates critical risk with a distinct reason", () => {
    const d = evaluateMarketingActionPolicy(
      evalInput({ intelligence: { ...INTEL, intentClass: "safety_concern" } })
    );
    expect(d.decision).toBe("ESCALATE");
    expect(d.reasonCodes).toContain("CRITICAL_RISK_ESCALATION");
  });

  it("denies a prohibited action regardless of risk", () => {
    const d = evaluateMarketingActionPolicy(
      evalInput({
        request: buildMarketingActionRequest({ ...REQUEST, actionRequestId: "ar1:n-1", actionType: "nurture_candidate", estimatedCostClass: "standard" }),
      })
    );
    expect(d.decision).toBe("DENY");
    expect(d.reasonCodes).toContain("ACTION_PROHIBITED_BY_POLICY");
  });

  it("denies an unlisted action under a deny-by-default policy", () => {
    const denyPolicy = buildVersionedPolicy(
      10,
      1,
      policyConfig({ defaultActionDisposition: "deny" })
    );
    const d = evaluateMarketingActionPolicy(
      evalInput({
        policy: denyPolicy,
        request: buildMarketingActionRequest({ ...REQUEST, actionRequestId: "ar1:cl-1", actionType: "classify", estimatedCostClass: "none", providerAccountBinding: null }),
      })
    );
    expect(d.decision).toBe("DENY");
    expect(d.reasonCodes).toContain("ACTION_DEFAULTED_TO_DENY");
  });

  it("fails closed on missing policy", () => {
    const d = evaluateMarketingActionPolicy(evalInput({ policy: null }));
    expect(d.decision).toBe("DENY");
    expect(d.reasonCodes).toEqual(["POLICY_MISSING"]);
    expect(d.policyVersion).toBeNull();
  });

  it("fails closed on unknown action type (defence in depth below request validation)", () => {
    const d = evaluateMarketingActionPolicy(
      evalInput({ request: { ...buildMarketingActionRequest(REQUEST), actionType: "nuke" as never } })
    );
    expect(d.decision).toBe("DENY");
    expect(d.reasonCodes).toEqual(["UNKNOWN_ACTION_TYPE"]);
  });

  it("fails closed on intelligence binding mismatch", () => {
    const d = evaluateMarketingActionPolicy(
      evalInput({ intelligence: { ...INTEL, sourceInterpretationId: "interp-OTHER" } })
    );
    expect(d.decision).toBe("DENY");
    expect(d.reasonCodes).toEqual(["INTELLIGENCE_BINDING_MISMATCH"]);
  });

  it("denies when the provider binding is unverified", () => {
    const d = evaluateMarketingActionPolicy(
      evalInput({ providerCapability: { bindingVerified: false, capabilityAvailable: true } })
    );
    expect(d.decision).toBe("DENY");
    expect(d.reasonCodes).toContain("PROVIDER_BINDING_MISMATCH");
    expect(d.providerEligible).toBe(false);
  });

  it("denies when the provider capability is unavailable", () => {
    const d = evaluateMarketingActionPolicy(
      evalInput({ providerCapability: { bindingVerified: true, capabilityAvailable: false } })
    );
    expect(d.decision).toBe("DENY");
    expect(d.reasonCodes).toContain("PROVIDER_CAPABILITY_UNAVAILABLE");
  });

  it("denies when budget is exhausted", () => {
    const d = evaluateMarketingActionPolicy(evalInput({ cost: { ...COST, walletBalance: 0 } }));
    expect(d.decision).toBe("DENY");
    expect(d.reasonCodes).toContain("BUDGET_INSUFFICIENT_BALANCE");
    expect(d.costEligible).toBe(false);
  });

  it("denies when the provider rate limit is tripped", () => {
    const d = evaluateMarketingActionPolicy(
      evalInput({ providerRate: { rateLimited: true, rateLimitReason: "429" } })
    );
    expect(d.decision).toBe("DENY");
    expect(d.reasonCodes).toContain("RATE_LIMIT_PROVIDER");
    expect(d.rateEligible).toBe(false);
  });

  it("denies when the daily action cap is reached", () => {
    const d = evaluateMarketingActionPolicy(
      evalInput({ volume: { actionsExecutedToday: 50, channelActionsToday: {} } })
    );
    expect(d.decision).toBe("DENY");
    expect(d.reasonCodes).toContain("QUOTA_DAILY_ACTION_CAP");
  });

  it("denies a prohibited channel outright even for low risk", () => {
    const p = buildVersionedPolicy(
      10,
      1,
      policyConfig({ prohibitedPlatforms: ["instagram"] })
    );
    const d = evaluateMarketingActionPolicy(evalInput({ policy: p }));
    expect(d.decision).toBe("DENY");
    expect(d.reasonCodes).toContain("CHANNEL_PROHIBITED_BY_POLICY");
  });

  it("narrows autonomous execution to approval outside business hours", () => {
    const p = buildVersionedPolicy(
      10,
      1,
      policyConfig({ businessHours: { enabled: true, windows: [{ start: "13:00", end: "14:00" }] } })
    );
    // NOW is 12:00 UTC -> outside window.
    const d = evaluateMarketingActionPolicy(evalInput({ policy: p }));
    expect(d.decision).toBe("REQUIRE_APPROVAL");
    expect(d.reasonCodes).toContain("OUTSIDE_BUSINESS_HOURS");
  });

  it("executes autonomously inside configured business hours", () => {
    const p = buildVersionedPolicy(
      10,
      1,
      policyConfig({ businessHours: { enabled: true, windows: [{ start: "11:00", end: "13:00" }] } })
    );
    const d = evaluateMarketingActionPolicy(evalInput({ policy: p }));
    expect(d.decision).toBe("ALLOW_AUTONOMOUS");
  });

  it("suppress_action produces a durable NO_ACTION", () => {
    const d = evaluateMarketingActionPolicy(
      evalInput({
        request: buildMarketingActionRequest({
          ...REQUEST,
          actionRequestId: "ar1:s-1",
          actionType: "suppress_action",
          estimatedCostClass: "none",
          providerAccountBinding: null,
        }),
      })
    );
    expect(d.decision).toBe("NO_ACTION");
    expect(d.reasonCodes).toContain("SUPPRESSION_REQUESTED");
    expect(d.billingIdentity).toBeNull();
  });

  it("an approval-listed action requires approval even at low risk", () => {
    const d = evaluateMarketingActionPolicy(
      evalInput({
        request: buildMarketingActionRequest({ ...REQUEST, actionRequestId: "ar1:p-1", actionType: "reply_privately" }),
      })
    );
    expect(d.decision).toBe("REQUIRE_APPROVAL");
    expect(d.reasonCodes).toContain("ACTION_REQUIRES_APPROVAL_BY_POLICY");
  });

  it("prompt-injection suspicion cannot widen authority (low-risk action escalated)", () => {
    const d = evaluateMarketingActionPolicy(
      evalInput({ intelligence: { ...INTEL, injectionSuspected: true } })
    );
    expect(d.decision).not.toBe("ALLOW_AUTONOMOUS");
    expect(d.riskClass).toBe("high");
    expect(d.reasonCodes).toContain("INJECTION_SUSPECTED");
  });

  it("produces identical decisions for identical inputs (retry convergence)", () => {
    const a = evaluateMarketingActionPolicy(evalInput());
    const b = evaluateMarketingActionPolicy(evalInput());
    expect(a).toEqual(b);
    expect(a.policyDecisionId).toBe(b.policyDecisionId);
    expect(a.evaluationFingerprint).toBe(b.evaluationFingerprint);
  });

  it("produces a new decision identity under a new policy version", () => {
    const p2 = buildVersionedPolicy(10, 2, policyConfig());
    const a = evaluateMarketingActionPolicy(evalInput());
    const b = evaluateMarketingActionPolicy(evalInput({ policy: p2 }));
    expect(a.policyDecisionId).not.toBe(b.policyDecisionId);
  });

  it("decision id is stable per (request, policy version) regardless of clock", () => {
    const a = evaluateMarketingActionPolicy(evalInput({ now: "2026-06-28T12:00:00.000Z" }));
    const b = evaluateMarketingActionPolicy(evalInput({ now: "2026-06-28T13:00:00.000Z" }));
    expect(a.policyDecisionId).toBe(b.policyDecisionId);
    expect(a.expiresAt).not.toBe(b.expiresAt);
  });

  it("records the thresholds snapshot used (explainability)", () => {
    const d = evaluateMarketingActionPolicy(evalInput());
    expect(d.thresholds.minAutonomousConfidence).toBe(0.6);
    expect(d.thresholds.maxActionsPerDay).toBe(50);
    expect(d.thresholds.maxAutonomousCreditsPerDay).toBe(20);
  });

  it("declared cost-class mismatch is recorded informationally with derived class used", () => {
    const d = evaluateMarketingActionPolicy(
      evalInput({
        request: buildMarketingActionRequest({ ...REQUEST, estimatedCostClass: "high" }),
      })
    );
    expect(d.reasonCodes).toContain("COST_CLASS_DECLARATION_MISMATCH");
    expect(d.estimatedCostClass).toBe("low");
    expect(d.estimatedCredits).toBe(1);
  });

  it("buildPolicyDecisionId is deterministic and scoped", () => {
    const id = () =>
      buildPolicyDecisionId({
        actionRequestId: "ar1:x",
        businessId: 10,
        policyVersion: "v1-abc",
        actionType: "react",
        platform: "twitter",
        contextVersion: "ctx",
        sourceInterpretationId: null,
        intelligenceVersion: null,
      });
    expect(id()).toBe(id());
    expect(id()).toMatch(/^pdec_[0-9a-f]{40}$/);
  });
});
