/**
 * WBS-R5-E4 — Risk tier acceptance.
 */
import { describe, it, expect } from "vitest";
import {
  classifyRisk,
  validateAuthoritativeIntelligence,
  INTENT_CLASS_BASE_TIER,
  INTENT_CLASSES,
  RiskClassificationError,
  type AuthoritativeIntelligence,
} from "./risk-classification";
import { RISK_TIER_RANK } from "./policy-types";

const MIN_CONFIDENCE = 0.6;

function intel(overrides: Partial<AuthoritativeIntelligence> = {}): AuthoritativeIntelligence {
  return {
    sourceInterpretationId: "interp-9",
    intelligenceVersion: "iv-1",
    sentiment: "positive",
    intentClass: "praise",
    confidence: 0.95,
    containsPersonalData: false,
    injectionSuspected: false,
    ...overrides,
  };
}

describe("E4 risk tiers", () => {
  it("maps every intent class to a defined base tier", () => {
    for (const ic of INTENT_CLASSES) {
      expect(RISK_TIER_RANK[INTENT_CLASS_BASE_TIER[ic]]).toBeGreaterThanOrEqual(0);
    }
    expect(INTENT_CLASS_BASE_TIER.praise).toBe("low");
    expect(INTENT_CLASS_BASE_TIER.severe_complaint).toBe("high");
    expect(INTENT_CLASS_BASE_TIER.legal_compliance).toBe("high");
    expect(INTENT_CLASS_BASE_TIER.safety_concern).toBe("critical");
    expect(INTENT_CLASS_BASE_TIER.reputational_crisis).toBe("critical");
  });

  it("classifies routine praise as LOW", () => {
    expect(classifyRisk(intel(), MIN_CONFIDENCE).riskClass).toBe("low");
  });

  it("classifies a product objection as MEDIUM", () => {
    expect(classifyRisk(intel({ intentClass: "product_objection" }), MIN_CONFIDENCE).riskClass).toBe("medium");
  });

  it("classifies a moderate complaint as MEDIUM", () => {
    expect(classifyRisk(intel({ intentClass: "moderate_complaint" }), MIN_CONFIDENCE).riskClass).toBe("medium");
  });

  it("classifies a severe complaint as HIGH", () => {
    expect(classifyRisk(intel({ intentClass: "severe_complaint" }), MIN_CONFIDENCE).riskClass).toBe("high");
  });

  it("classifies legal/compliance, privacy and payment dispute as HIGH", () => {
    for (const intentClass of ["legal_compliance", "privacy_issue", "payment_dispute", "refund_request"] as const) {
      expect(classifyRisk(intel({ intentClass }), MIN_CONFIDENCE).riskClass).toBe("high");
    }
  });

  it("classifies safety concerns and reputational crisis as CRITICAL", () => {
    expect(classifyRisk(intel({ intentClass: "safety_concern" }), MIN_CONFIDENCE).riskClass).toBe("critical");
    expect(classifyRisk(intel({ intentClass: "reputational_crisis" }), MIN_CONFIDENCE).riskClass).toBe("critical");
  });

  it("floors negative sentiment at MEDIUM for otherwise-low intent", () => {
    expect(classifyRisk(intel({ sentiment: "negative" }), MIN_CONFIDENCE).riskClass).toBe("medium");
  });

  it("floors urgent sentiment at HIGH", () => {
    expect(classifyRisk(intel({ sentiment: "urgent" }), MIN_CONFIDENCE).riskClass).toBe("high");
  });

  it("floors personal data at HIGH (privacy-sensitive escalation)", () => {
    expect(classifyRisk(intel({ containsPersonalData: true }), MIN_CONFIDENCE).riskClass).toBe("high");
  });

  it("floors injection-suspected content at HIGH and records the factor", () => {
    const result = classifyRisk(intel({ injectionSuspected: true }), MIN_CONFIDENCE);
    expect(result.riskClass).toBe("high");
    expect(result.factors).toContain("INJECTION_SUSPECTED");
  });

  it("injection suspicion can only raise risk, never lower it", () => {
    // Critical stays critical; injection is still recorded.
    const result = classifyRisk(intel({ intentClass: "reputational_crisis", injectionSuspected: true }), MIN_CONFIDENCE);
    expect(result.riskClass).toBe("critical");
    expect(result.factors).toContain("INJECTION_SUSPECTED");
  });

  it("bumps one tier when confidence is below the policy floor", () => {
    const result = classifyRisk(intel({ confidence: 0.4 }), MIN_CONFIDENCE);
    expect(result.riskClass).toBe("medium");
    expect(result.factors).toContain("CONFIDENCE_BELOW_AUTONOMY_MIN");
  });

  it("low confidence on an objection escalates objection MEDIUM -> HIGH", () => {
    expect(classifyRisk(intel({ intentClass: "product_objection", confidence: 0.3 }), MIN_CONFIDENCE).riskClass).toBe(
      "high"
    );
  });

  it("monotone property: adding adverse factors never lowers the tier", () => {
    const base = intel({ intentClass: "product_objection", confidence: 0.9 });
    const adverse = intel({
      intentClass: "product_objection",
      confidence: 0.3,
      sentiment: "negative",
      containsPersonalData: true,
    });
    expect(RISK_TIER_RANK[classifyRisk(adverse, MIN_CONFIDENCE).riskClass]).toBeGreaterThanOrEqual(
      RISK_TIER_RANK[classifyRisk(base, MIN_CONFIDENCE).riskClass]
    );
  });

  it("rejects forged risk fields on intelligence (fail closed)", () => {
    expect(() => validateAuthoritativeIntelligence({ ...intel(), riskClass: "low" } as any)).toThrowError(
      /must never be supplied/
    );
    expect(() => validateAuthoritativeIntelligence({ ...intel(), riskLevel: "low" } as any)).toThrowError(
      RiskClassificationError
    );
  });

  it("rejects malformed intelligence", () => {
    expect(() => validateAuthoritativeIntelligence({ ...intel(), confidence: 2 })).toThrowError(/confidence/);
    expect(() => validateAuthoritativeIntelligence({ ...intel(), intentClass: "nonsense" } as any)).toThrowError(
      /intentClass/
    );
    expect(() => validateAuthoritativeIntelligence({ ...intel(), containsPersonalData: "yes" } as any)).toThrowError(
      /boolean/
    );
  });
});
