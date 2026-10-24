import { describe, expect, it } from "vitest";
import {
  assertValidInterpretationRecord,
  CLASSIFIER_VERSION,
  CONFIDENCE_VALUES,
  ConfidenceLabelEnum,
  HANDLING_VALUES,
  HandlingClassEnum,
  INTENT_VALUES,
  IntentLabelEnum,
  InterpretationValidationError,
  OPPORTUNITY_INDICATOR_VALUES,
  OpportunityIndicatorEnum,
  RELEVANCE_VALUES,
  RelevanceLabelEnum,
  RISK_FLAG_VALUES,
  RiskFlagEnum,
  SENTIMENT_VALUES,
  SentimentLabelEnum,
  SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
  SocialInterpretationSchema,
  URGENCY_VALUES,
  UrgencyLabelEnum,
  type SocialInterpretation,
} from "./interpretation-contract";
import { sanitizeSignalText } from "./input-safety";
import { toCanonicalSignal } from "./canonical-signal";
import {
  computeInterpretationFingerprint,
  computeInterpretationId,
  computeSignalContentHash,
} from "./interpretation-identity";

function sanitizedSignal(text = "How much does the starter plan cost?") {
  return sanitizeSignalText(
    toCanonicalSignal({
      signalId: "sig-contract-1",
      signalVersion: 1,
      signalType: "comment",
      provider: "meta",
      platform: "instagram",
      attributionType: "business",
      actorDisplayName: "Jane Doe",
      contentText: text,
      occurredAt: "2026-06-01T10:00:00Z",
      providerEvidenceHash: "a".repeat(64),
    })
  );
}

function makeRecord(overrides: Partial<SocialInterpretation> = {}): SocialInterpretation {
  const signal = sanitizedSignal();
  const signalContentHash = computeSignalContentHash(signal);
  const base = {
    interpretationId: computeInterpretationId({
      schemaVersion: SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
      businessId: 3,
      signalId: signal.signalId,
      signalVersion: signal.signalVersion,
      signalContentHash,
      classifierVersion: CLASSIFIER_VERSION,
    }),
    schemaVersion: SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    userId: 7,
    businessId: 3,
    signalId: signal.signalId,
    signalVersion: signal.signalVersion,
    signalContentHash,
    signalType: signal.signalType,
    source: "RULE" as const,
    intent: "information_request" as const,
    intentConfidence: "high" as const,
    sentiment: "positive" as const,
    sentimentConfidence: "high" as const,
    urgency: "normal" as const,
    relevance: "relevant" as const,
    relevanceConfidence: "high" as const,
    overallConfidence: "high" as const,
    confidenceBasis: "deterministic_rule" as const,
    topics: ["pricing"],
    riskFlags: [{ flag: "normal_engagement" as const, evidence: "no risk markers" }],
    opportunityIndicators: [],
    recommendedHandling: "candidate_for_engagement" as const,
    businessDnaSnapshotId: null,
    evidenceReferences: [
      { kind: "signal_excerpt" as const, ref: "sig-contract-1", excerpt: "How much does" },
    ],
    explanation: "Deterministic contract test record.",
    billingIdentity: null,
    interpretationFingerprint: "",
    createdAt: "2026-06-01T12:00:00Z",
    status: "accepted" as const,
  };
  const fingerprint = computeInterpretationFingerprint(base as unknown as SocialInterpretation);
  return Object.freeze({ ...base, interpretationFingerprint: fingerprint, ...overrides });
}

describe("closed vocabularies (contract §6)", () => {
  it("accepts every in-vocabulary value for every label enum", () => {
    for (const value of INTENT_VALUES) expect(IntentLabelEnum.safeParse(value).success).toBe(true);
    for (const value of SENTIMENT_VALUES)
      expect(SentimentLabelEnum.safeParse(value).success).toBe(true);
    for (const value of URGENCY_VALUES) expect(UrgencyLabelEnum.safeParse(value).success).toBe(true);
    for (const value of RELEVANCE_VALUES)
      expect(RelevanceLabelEnum.safeParse(value).success).toBe(true);
    for (const value of CONFIDENCE_VALUES)
      expect(ConfidenceLabelEnum.safeParse(value).success).toBe(true);
    for (const value of HANDLING_VALUES)
      expect(HandlingClassEnum.safeParse(value).success).toBe(true);
    for (const value of RISK_FLAG_VALUES) expect(RiskFlagEnum.safeParse(value).success).toBe(true);
    for (const value of OPPORTUNITY_INDICATOR_VALUES)
      expect(OpportunityIndicatorEnum.safeParse(value).success).toBe(true);
  });

  it("rejects out-of-vocabulary strings via schema parse failure", () => {
    expect(IntentLabelEnum.safeParse("buy_now").success).toBe(false);
    expect(IntentLabelEnum.safeParse("information_request ").success).toBe(false);
    expect(SentimentLabelEnum.safeParse("angry").success).toBe(false);
    expect(UrgencyLabelEnum.safeParse("extreme").success).toBe(false);
    expect(RelevanceLabelEnum.safeParse("sorta_relevant").success).toBe(false);
    expect(ConfidenceLabelEnum.safeParse("very_high").success).toBe(false);
    expect(HandlingClassEnum.safeParse("auto_reply").success).toBe(false);
    expect(RiskFlagEnum.safeParse("violence").success).toBe(false);
    expect(OpportunityIndicatorEnum.safeParse("upsell").success).toBe(false);
  });

  it("has exactly the contract §6 cardinalities", () => {
    expect(INTENT_VALUES).toHaveLength(15);
    expect(SENTIMENT_VALUES).toHaveLength(5);
    expect(URGENCY_VALUES).toHaveLength(4);
    expect(RELEVANCE_VALUES).toHaveLength(4);
    expect(CONFIDENCE_VALUES).toHaveLength(4);
    expect(HANDLING_VALUES).toHaveLength(6);
    expect(RISK_FLAG_VALUES).toHaveLength(10);
    expect(OPPORTUNITY_INDICATOR_VALUES).toHaveLength(6);
  });
});

describe("SocialInterpretationSchema (canonical record)", () => {
  it("round-trips a fully-constructed record through assertValidInterpretationRecord", () => {
    const record = makeRecord();
    const validated = assertValidInterpretationRecord(record);
    expect(validated.intent).toBe("information_request");
    expect(validated.schemaVersion).toBe("social-intelligence/v1");
    expect(validated.classifierVersion).toBe("intent-sentiment-classifier/v1");
    expect(validated.status).toBe("accepted");
    expect(validated.interpretationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(SocialInterpretationSchema.safeParse(record).success).toBe(true);
  });

  it("throws InterpretationValidationError with a stable code on out-of-vocab labels", () => {
    try {
      assertValidInterpretationRecord(makeRecord({ intent: "buy_now" as never }));
      expect.unreachable("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InterpretationValidationError);
      expect((error as InterpretationValidationError).code).toBe("INVALID_INTERPRETATION_RECORD");
    }
  });

  it("rejects oversize explanation and empty fingerprints", () => {
    expect(() =>
      assertValidInterpretationRecord(makeRecord({ explanation: "x".repeat(281) }))
    ).toThrow(InterpretationValidationError);
    expect(() =>
      assertValidInterpretationRecord(makeRecord({ interpretationFingerprint: "deadbeef" }))
    ).toThrow(InterpretationValidationError);
  });

  it("rejects schemaVersion or classifierVersion drift", () => {
    expect(() =>
      assertValidInterpretationRecord(makeRecord({ schemaVersion: "social-intelligence/v2" as never }))
    ).toThrow(InterpretationValidationError);
    expect(() =>
      assertValidInterpretationRecord(
        makeRecord({ classifierVersion: "intent-sentiment-classifier/v2" as never })
      )
    ).toThrow(InterpretationValidationError);
  });
});

describe("ModelInterpretationSchema", () => {
  it("accepts a valid structured model output", async () => {
    const { ModelInterpretationSchema } = await import("./interpretation-contract");
    const result = ModelInterpretationSchema.safeParse({
      intent: "purchase_interest",
      sentiment: "positive",
      urgency: "normal",
      modelConfidence: "high",
      relevanceHint: "relevant",
      topics: ["pricing"],
      riskHints: [],
      opportunityHints: ["purchase_intent_detected"],
      evidence: ["asks about price"],
      explanation: "The signal asks about purchasing.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects labels outside the closed vocabularies and unknown extra fields", async () => {
    const { ModelInterpretationSchema } = await import("./interpretation-contract");
    const valid = {
      intent: "praise",
      sentiment: "positive",
      urgency: "low",
      modelConfidence: "medium",
      topics: [],
      riskHints: [],
      opportunityHints: [],
      evidence: [],
      explanation: "Short factual note.",
    };
    expect(
      ModelInterpretationSchema.safeParse({ ...valid, intent: "buy_everything" }).success
    ).toBe(false);
    expect(
      ModelInterpretationSchema.safeParse({ ...valid, modelConfidence: "unknown" }).success
    ).toBe(false);
    expect(
      ModelInterpretationSchema.safeParse({ ...valid, surprise_field: "x" }).success
    ).toBe(false);
  });
});
