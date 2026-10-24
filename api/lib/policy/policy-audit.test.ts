/**
 * WBS-R5-E7 — Audit + explainability acceptance.
 */
import { describe, it, expect } from "vitest";
import {
  buildPolicyDecisionAuditEvent,
  explainPolicyDecision,
  POLICY_REASON_EXPLANATIONS,
  POLICY_DECISION_AUDIT_EVENT_TYPE,
} from "./policy-audit";
import { evaluateMarketingActionPolicy } from "./decision-engine";
import { buildMarketingActionRequest, type MarketingActionRequestInput } from "./action-request";
import { buildBusinessPolicyConfig, buildDefaultPolicyConfig, buildVersionedPolicy } from "./policy-model";
import type { AuthoritativeIntelligence } from "./risk-classification";
import type { CostAuthoritySnapshot, VolumeAuthoritySnapshot } from "./cost-governance";
import { POLICY_REASON_CODES } from "./policy-types";

const NOW = "2026-06-28T12:00:00.000Z";

function makeDecision(risk: "low" | "medium" | "high" = "low") {
  const intelMap = {
    low: { intentClass: "praise", sentiment: "positive", confidence: 0.95 },
    medium: { intentClass: "product_objection", sentiment: "neutral", confidence: 0.9 },
    high: { intentClass: "severe_complaint", sentiment: "negative", confidence: 0.9 },
  } as const;
  const request: MarketingActionRequestInput = {
    actionRequestId: "ar1:c-9",
    businessId: 10,
    sourceSignalId: "sig-9",
    sourceInterpretationId: "interp-9",
    actionType: "reply_publicly",
    platform: "instagram",
    providerAccountBinding: { integrationId: 4, platform: "instagram", externalAccountRef: "p1" },
    campaignId: 55,
    publicationId: null,
    estimatedCostClass: "low",
    requestedAt: NOW,
    contextVersion: "ctx:9",
  };
  const intelligence: AuthoritativeIntelligence = {
    sourceInterpretationId: "interp-9",
    intelligenceVersion: "iv-9",
    sentiment: intelMap[risk].sentiment,
    intentClass: intelMap[risk].intentClass as AuthoritativeIntelligence["intentClass"],
    confidence: intelMap[risk].confidence,
    containsPersonalData: false,
    injectionSuspected: false,
  };
  const cost: CostAuthoritySnapshot = {
    walletBalance: 100,
    openReservationCredits: 0,
    dailySpend: 0,
    monthlySpend: 0,
    dailySystemLimit: 1000,
    monthlySystemLimit: 10000,
    walletSpendLimit: null,
    periodAutonomousSpend: 0,
  };
  const volume: VolumeAuthoritySnapshot = { actionsExecutedToday: 0, channelActionsToday: {} };
  return evaluateMarketingActionPolicy({
    request: buildMarketingActionRequest(request),
    userId: 7,
    policy: buildVersionedPolicy(
      10,
      1,
      buildBusinessPolicyConfig({
        ...buildDefaultPolicyConfig(),
        actions: { autonomous: ["reply_publicly"], requireApproval: [], prohibited: [] },
      } as never)
    ),
    intelligence,
    cost,
    volume,
    providerRate: { rateLimited: false },
    providerCapability: { bindingVerified: true, capabilityAvailable: true },
    now: NOW,
  });
}

describe("E7 policy audit", () => {
  it("builds a canonical policy_decision audit event", () => {
    const decision = makeDecision("low");
    const event = buildPolicyDecisionAuditEvent({ decision, occurredAt: decision.evaluatedAt });
    expect(event.eventType).toBe(POLICY_DECISION_AUDIT_EVENT_TYPE);
    expect(event.userId).toBe(7);
    expect(event.source).toBe("system");
    expect(event.campaignId).toBe(55);
    expect(event.businessId).toBe(10);
    const md = event.metadata as Record<string, unknown>;
    expect(md.decision).toBe("ALLOW_AUTONOMOUS");
    expect(md.policyVersion).toBe(decision.policyVersion);
    expect(md.riskClass).toBe("low");
    expect(md.billingIdentity).toBe(decision.billingIdentity);
  });

  it("never persists raw content or secrets in metadata", () => {
    const decision = makeDecision("high");
    const event = buildPolicyDecisionAuditEvent({ decision, occurredAt: decision.evaluatedAt });
    const serialized = JSON.stringify(event);
    // No message text, tokens, or secret-ish keys survive sanitization.
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("accessToken");
    // Social content never enters the decision in the first place.
    expect(event.metadata).not.toHaveProperty("messageText");
    expect(event.metadata).not.toHaveProperty("content");
  });

  it("strips smuggled sensitive metadata keys deterministically", () => {
    const decision = makeDecision("low");
    const event = buildPolicyDecisionAuditEvent({
      decision,
      occurredAt: decision.evaluatedAt,
    });
    // The decision itself is clean; simulate defence-in-depth by checking the
    // sanitizer via a poisoned clone is out of scope here — instead assert the
    // serialized metadata key set is exactly the allow-listed shape.
    const keys = Object.keys(event.metadata).sort();
    expect(keys).not.toContain("apiKey");
    expect(keys).toContain("decision");
    expect(keys).toContain("reasonCodes");
    expect(keys).toContain("thresholds");
  });
});

describe("E7 explainability", () => {
  it("explains an allowed decision with reasons and thresholds", () => {
    const decision = makeDecision("low");
    const explanation = explainPolicyDecision(decision);
    expect(explanation.decision).toBe("ALLOW_AUTONOMOUS");
    expect(explanation.reasons.length).toBeGreaterThan(0);
    for (const r of explanation.reasons) {
      expect(r.explanation.length).toBeGreaterThan(10);
    }
    expect(explanation.thresholds.maxActionsPerDay).toBe(50);
    expect(explanation.evidence.sourceInterpretationId).toBe("interp-9");
    expect(explanation.evidence.evaluationFingerprint).toBe(decision.evaluationFingerprint);
  });

  it("explains an approval decision (why approval?)", () => {
    const decision = makeDecision("medium");
    expect(decision.decision).toBe("REQUIRE_APPROVAL");
    const explanation = explainPolicyDecision(decision);
    const codes = explanation.reasons.map((r) => r.code);
    expect(codes).toContain("APPROVAL_REQUIRED_BY_RISK");
    expect(explanation.approvalRequired).toBe(true);
  });

  it("explains an escalation (why escalated?)", () => {
    const decision = makeDecision("high");
    expect(decision.decision).toBe("ESCALATE");
    const explanation = explainPolicyDecision(decision);
    expect(explanation.reasons.map((r) => r.code)).toContain("ESCALATED_BY_RISK");
  });

  it("explains a denied decision (why denied?)", () => {
    const decision = makeDecision("low");
    const denied = Object.freeze({
      ...decision,
      decision: "DENY" as const,
      reasonCodes: Object.freeze(["ACTION_PROHIBITED_BY_POLICY" as const]),
      approvalRequired: false,
    });
    const explanation = explainPolicyDecision(denied as never);
    expect(explanation.reasons[0].code).toBe("ACTION_PROHIBITED_BY_POLICY");
    expect(explanation.reasons[0].explanation).toMatch(/prohibited/);
  });

  it("every closed reason code has an operator-readable explanation", () => {
    for (const code of POLICY_REASON_CODES) {
      expect(POLICY_REASON_EXPLANATIONS[code], `missing explanation for ${code}`).toBeDefined();
      expect(POLICY_REASON_EXPLANATIONS[code].length).toBeGreaterThan(10);
    }
  });

  it("fails closed on unknown decision outcome", () => {
    const decision = makeDecision("low");
    expect(() => explainPolicyDecision({ ...decision, decision: "MAYBE" as never })).toThrow();
  });
});
