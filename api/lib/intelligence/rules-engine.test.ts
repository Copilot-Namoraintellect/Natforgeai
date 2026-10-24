import { describe, expect, it } from "vitest";
import { toCanonicalSignal, type SanitizedSocialSignal } from "./canonical-signal";
import { sanitizeSignalText } from "./input-safety";
import { evaluateRules, RULE_ENGINE_VERSION, type DefinitiveRuleVerdict } from "./rules-engine";
import { assertValidInterpretationRecord, type SocialInterpretation } from "./interpretation-contract";
import {
  CLASSIFIER_VERSION,
  SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
} from "./interpretation-contract";
import { computeInterpretationId, computeSignalContentHash } from "./interpretation-identity";

function signal(
  text: string | null,
  overrides: Record<string, unknown> = {}
): SanitizedSocialSignal {
  return sanitizeSignalText(
    toCanonicalSignal({
      signalId: "sig-rules-1",
      signalVersion: 1,
      signalType: "comment",
      platform: "instagram",
      actorHandle: "@actor",
      text,
      ...overrides,
    })
  );
}

function expectDefinitive(verdict: ReturnType<typeof evaluateRules>): DefinitiveRuleVerdict {
  if (verdict.kind !== "definitive") {
    throw new Error(`expected definitive verdict, got ${JSON.stringify(verdict)}`);
  }
  return verdict;
}

/** Maps a definitive verdict into a full canonical record for schema validation. */
function verdictToRecord(verdict: DefinitiveRuleVerdict): SocialInterpretation {
  const sig = signal("placeholder text for record construction");
  const signalContentHash = computeSignalContentHash(sig);
  const base = {
    interpretationId: computeInterpretationId({
      schemaVersion: SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
      businessId: 1,
      signalId: sig.signalId,
      signalVersion: sig.signalVersion,
      signalContentHash,
      classifierVersion: CLASSIFIER_VERSION,
    }),
    schemaVersion: SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    userId: 1,
    businessId: 1,
    signalId: sig.signalId,
    signalVersion: sig.signalVersion,
    signalContentHash,
    signalType: sig.signalType,
    source: verdict.source,
    intent: verdict.intent,
    intentConfidence: verdict.intentConfidence,
    sentiment: verdict.sentiment,
    sentimentConfidence: verdict.sentimentConfidence,
    urgency: verdict.urgency,
    relevance: verdict.relevance,
    relevanceConfidence: verdict.relevanceConfidence,
    overallConfidence: verdict.overallConfidence,
    confidenceBasis: verdict.confidenceBasis,
    topics: verdict.topics,
    riskFlags: verdict.riskFlags,
    opportunityIndicators: verdict.opportunityIndicators,
    recommendedHandling: verdict.recommendedHandling,
    businessDnaSnapshotId: null,
    evidenceReferences: verdict.evidenceReferences,
    explanation: verdict.explanation,
    billingIdentity: null,
    interpretationFingerprint: "f".repeat(64),
    createdAt: "2026-06-01T00:00:00Z",
    status: "accepted" as const,
  };
  return base as unknown as SocialInterpretation;
}

describe("evaluateRules — rule classes a–f", () => {
  it("(a) unknown signalType rejects as unsupported_signal_type", () => {
    const verdict = evaluateRules(signal("hello", { signalType: "unknown" }));
    expect(verdict).toEqual({ kind: "reject", reason: "unsupported_signal_type" });
  });

  it("(b) non-text-bearing signal yields a low-information monitor RULE record", () => {
    const verdict = expectDefinitive(
      evaluateRules(signal("ignored payload", { signalType: "reaction" }))
    );
    expect(verdict.source).toBe("RULE");
    expect(verdict.ruleEngineVersion).toBe(RULE_ENGINE_VERSION);
    expect(verdict.intent).toBe("unknown");
    expect(verdict.intentConfidence).toBe("unknown");
    expect(verdict.sentiment).toBe("unknown");
    expect(verdict.sentimentConfidence).toBe("unknown");
    expect(verdict.urgency).toBe("low");
    expect(verdict.relevance).toBe("unknown");
    expect(verdict.relevanceConfidence).toBe("unknown");
    expect(verdict.overallConfidence).toBe("unknown");
    expect(verdict.confidenceBasis).toBe("insufficient_evidence");
    expect(verdict.topics).toEqual([]);
    expect(verdict.riskFlags).toEqual([]);
    expect(verdict.opportunityIndicators).toEqual([]);
    expect(verdict.recommendedHandling).toBe("monitor");
    expect(verdict.explanation).toBe("Non-textual signal; insufficient evidence for interpretation.");
    expect(verdict.evidenceReferences.length).toBeGreaterThan(0);
    expect(verdict.evidenceReferences[0].kind).toBe("rule");
  });

  it("(c) empty text on a text-bearing type is irrelevant/no_action with high rule confidence", () => {
    const verdict = expectDefinitive(evaluateRules(signal("   ")));
    expect(verdict.intent).toBe("irrelevant");
    expect(verdict.recommendedHandling).toBe("no_action");
    expect(verdict.overallConfidence).toBe("high");
    expect(verdict.confidenceBasis).toBe("deterministic_rule");
    expect(verdict.riskFlags).toEqual([]);
    expect(verdict.opportunityIndicators).toEqual([]);
    expect(verdict.explanation).toBe("No interpretable text.");
  });

  it("(c) null text on a text-bearing type follows the same empty-text rule", () => {
    const verdict = expectDefinitive(evaluateRules(signal(null, { signalType: "dm" })));
    expect(verdict.intent).toBe("irrelevant");
    expect(verdict.recommendedHandling).toBe("no_action");
  });

  it("(d) crypto-scam phrase yields definitive spam/no_action with spam_or_scam evidence", () => {
    const verdict = expectDefinitive(evaluateRules(signal("Double your Bitcoin in 7 days!")));
    expect(verdict.intent).toBe("spam");
    expect(verdict.sentiment).toBe("neutral");
    expect(verdict.urgency).toBe("low");
    expect(verdict.relevance).toBe("not_relevant");
    expect(verdict.overallConfidence).toBe("high");
    expect(verdict.confidenceBasis).toBe("deterministic_rule");
    expect(verdict.recommendedHandling).toBe("no_action");
    expect(verdict.topics).toEqual([]);
    expect(verdict.riskFlags).toHaveLength(1);
    expect(verdict.riskFlags[0].flag).toBe("spam_or_scam");
    expect(verdict.riskFlags[0].evidence.length).toBeLessThanOrEqual(160);
    expect(verdict.ruleRefs).toContain("rules-engine:spam_markers");
  });

  it("(d) excessive-link heuristic (>=3 URLs) yields spam without a phrase marker", () => {
    const verdict = expectDefinitive(
      evaluateRules(signal("check https://a.example.com and https://b.example.com plus https://c.example.com now"))
    );
    expect(verdict.intent).toBe("spam");
    expect(verdict.recommendedHandling).toBe("no_action");
    expect(verdict.ruleRefs).toContain("rules-engine:excessive_links");
    expect(verdict.riskFlags[0].flag).toBe("spam_or_scam");
  });

  it("(e) self-harm marker yields support_request + safety_escalation", () => {
    const verdict = expectDefinitive(evaluateRules(signal("I want to die, nobody cares")));
    expect(verdict.intent).toBe("support_request");
    expect(verdict.recommendedHandling).toBe("safety_escalation");
    expect(verdict.overallConfidence).toBe("high");
    expect(verdict.confidenceBasis).toBe("deterministic_rule");
    expect(verdict.riskFlags.map((f) => f.flag)).toContain("self_harm_safety_concern");
    expect(verdict.ruleRefs.some((ref) => ref.includes("self_harm"))).toBe(true);
  });

  it("(e) explicit threat marker yields abuse + safety_escalation", () => {
    const verdict = expectDefinitive(evaluateRules(signal("I will kill you if you post again")));
    expect(verdict.intent).toBe("abuse");
    expect(verdict.sentiment).toBe("negative");
    expect(verdict.recommendedHandling).toBe("safety_escalation");
    expect(verdict.riskFlags.map((f) => f.flag)).toContain("abusive_or_harassing");
  });

  it("(f) plain ambiguous text defers to the model path", () => {
    const verdict = evaluateRules(signal("Do you deliver to the northern suburbs on weekends?"));
    expect(verdict).toEqual({ kind: "needs_model" });
  });

  it("definitive rule verdicts conform to the canonical record schema", () => {
    const cases: DefinitiveRuleVerdict[] = [
      expectDefinitive(evaluateRules(signal("x", { signalType: "share" }))),
      expectDefinitive(evaluateRules(signal(""))),
      expectDefinitive(evaluateRules(signal("claim your airdrop now"))),
      expectDefinitive(evaluateRules(signal("I know where you live"))),
    ];
    for (const verdict of cases) {
      const validated = assertValidInterpretationRecord(verdictToRecord(verdict));
      expect(validated.recommendedHandling).toBe(verdict.recommendedHandling);
    }
  });
});
