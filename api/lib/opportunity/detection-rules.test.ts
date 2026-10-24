// Unit coverage for the pure R5-D rule table (contract §8, D2).
// No DB, no clock — deterministic outcomes only.

import { describe, expect, it } from "vitest";
import {
  evaluateDetectionRules,
  EMPTY_THREAD_HISTORY,
  type ThreadHistoryContext,
} from "./detection-rules";
import { toCanonicalInterpretation, type CanonicalInterpretationInput } from "./canonical-intelligence";
import type { SuppressionReason } from "./opportunity-contract";

let seq = 0;
function makeInterpretation(overrides: Partial<CanonicalInterpretationInput> = {}) {
  seq += 1;
  return toCanonicalInterpretation({
    interpretationId: `int-test-${seq}`,
    classifierVersion: "intent-sentiment-classifier/v1",
    userId: 1,
    businessId: 1,
    signalId: `sig-${seq}`,
    signalVersion: 1,
    signalType: "comment",
    provider: "meta",
    platform: "instagram",
    actorReference: "actor-1",
    occurredAt: "2026-10-24T10:00:00.000Z",
    source: "MODEL",
    intent: "purchase_interest",
    sentiment: "positive",
    urgency: "normal",
    relevance: "relevant",
    overallConfidence: "medium",
    topics: ["pricing"],
    riskFlags: [],
    opportunityIndicators: [{ indicator: "purchase_intent_detected", evidence: "asks for price" }],
    recommendedHandling: "opportunity_candidate",
    createdAt: "2026-10-24T10:00:01.000Z",
    ...overrides,
  } satisfies CanonicalInterpretationInput);
}

describe("opportunity-detector/v1 rule table", () => {
  it("R1: purchase_interest + relevant → purchase_interest candidate", () => {
    const result = evaluateDetectionRules(makeInterpretation(), EMPTY_THREAD_HISTORY);
    expect(result.outcome).toEqual({
      kind: "candidate",
      opportunityType: "purchase_interest",
      ruleId: "R1",
    });
  });

  it("R2: purchase_interest + not_relevant → LOW_RELEVANCE suppression", () => {
    const result = evaluateDetectionRules(
      makeInterpretation({ relevance: "not_relevant" }),
      EMPTY_THREAD_HISTORY
    );
    expect(result.outcome).toMatchObject({ kind: "suppression", reason: "LOW_RELEVANCE", ruleId: "R2" });
  });

  it("R4: service_question → service_enquiry candidate", () => {
    const result = evaluateDetectionRules(
      makeInterpretation({ intent: "service_question", opportunityIndicators: [] }),
      EMPTY_THREAD_HISTORY
    );
    expect(result.outcome).toMatchObject({ kind: "candidate", opportunityType: "service_enquiry", ruleId: "R4" });
  });

  it("R5: information_request + purchase indicator → weak purchase_interest", () => {
    const result = evaluateDetectionRules(
      makeInterpretation({ intent: "information_request" }),
      EMPTY_THREAD_HISTORY
    );
    expect(result.outcome).toMatchObject({ kind: "candidate", opportunityType: "purchase_interest", ruleId: "R5" });
  });

  it("R6: partnership_interest → partnership candidate", () => {
    const result = evaluateDetectionRules(
      makeInterpretation({ intent: "partnership_interest", opportunityIndicators: [] }),
      EMPTY_THREAD_HISTORY
    );
    expect(result.outcome).toMatchObject({ kind: "candidate", opportunityType: "partnership_interest", ruleId: "R6" });
  });

  it("R8: cancellation signal → retention_risk candidate", () => {
    const result = evaluateDetectionRules(
      makeInterpretation({ intent: "cancellation_or_churn_signal", sentiment: "negative", opportunityIndicators: [] }),
      EMPTY_THREAD_HISTORY
    );
    expect(result.outcome).toMatchObject({ kind: "candidate", opportunityType: "retention_risk", ruleId: "R8" });
  });

  it("R9: support_recovery indicator with prior complaint suppression → unresolved_complaint_opportunity", () => {
    const history: ThreadHistoryContext = {
      priorSuppressionIntents: ["complaint"],
      hasPriorComplaintClassSuppression: true,
      hasPriorPraiseClassSuppression: false,
    };
    const result = evaluateDetectionRules(
      makeInterpretation({
        intent: "praise",
        sentiment: "positive",
        opportunityIndicators: [{ indicator: "support_recovery_moment", evidence: "issue resolved" }],
      }),
      history
    );
    expect(result.outcome).toMatchObject({
      kind: "candidate",
      opportunityType: "unresolved_complaint_opportunity",
      ruleId: "R9",
    });
  });

  it("R12: complaint alone → NO_OPPORTUNITY_CLASSIFICATION suppression", () => {
    const result = evaluateDetectionRules(
      makeInterpretation({ intent: "complaint", sentiment: "negative", opportunityIndicators: [] }),
      EMPTY_THREAD_HISTORY
    );
    expect(result.outcome).toMatchObject({
      kind: "suppression",
      reason: "NO_OPPORTUNITY_CLASSIFICATION",
      ruleId: "R12",
    });
  });

  it("R10: repeated high-value praise → referral_or_advocacy", () => {
    const history: ThreadHistoryContext = {
      priorSuppressionIntents: ["praise"],
      hasPriorComplaintClassSuppression: false,
      hasPriorPraiseClassSuppression: true,
    };
    const result = evaluateDetectionRules(
      makeInterpretation({
        intent: "praise",
        opportunityIndicators: [{ indicator: "high_value_praise", evidence: "loves the product" }],
      }),
      history
    );
    expect(result.outcome).toMatchObject({
      kind: "candidate",
      opportunityType: "referral_or_advocacy",
      ruleId: "R10",
    });
  });

  it("R12: praise alone never becomes a sales opportunity", () => {
    const result = evaluateDetectionRules(
      makeInterpretation({ intent: "praise", opportunityIndicators: [] }),
      EMPTY_THREAD_HISTORY
    );
    expect(result.outcome).toMatchObject({ kind: "suppression", reason: "NO_OPPORTUNITY_CLASSIFICATION" });
  });

  it("R13: unknown intent → INSUFFICIENT_CLASSIFICATION", () => {
    const result = evaluateDetectionRules(
      makeInterpretation({ intent: "unknown", opportunityIndicators: [] }),
      EMPTY_THREAD_HISTORY
    );
    expect(result.outcome).toMatchObject({ kind: "suppression", reason: "INSUFFICIENT_CLASSIFICATION", ruleId: "R13" });
  });

  it("R14: spam/irrelevant → NOT_OPPORTUNITY_SIGNAL", () => {
    for (const intent of ["spam", "irrelevant", "abuse"] as const) {
      const result = evaluateDetectionRules(
        makeInterpretation({ intent, opportunityIndicators: [] }),
        EMPTY_THREAD_HISTORY
      );
      expect(result.outcome).toMatchObject({ kind: "suppression", reason: "NOT_OPPORTUNITY_SIGNAL", ruleId: "R14" });
    }
  });

  it("R11: support_request + purchase indicator → support_to_sales_transition", () => {
    const result = evaluateDetectionRules(
      makeInterpretation({ intent: "support_request" }),
      EMPTY_THREAD_HISTORY
    );
    expect(result.outcome).toMatchObject({
      kind: "candidate",
      opportunityType: "support_to_sales_transition",
      ruleId: "R11",
    });
  });
});
