// ─── R5-B Intent & Sentiment Intelligence — deterministic rules engine (§12) ───
//
// PURE rule-first interpretation layer (docs/contracts/social-intelligence-contract.md).
// Deterministic, explainable, versioned and non-billable: it either returns a
// definitive RULE verdict (empty/no-text signals, spam markers, deterministic
// safety triggers), rejects the signal, or defers to the governed model path.
// Keyword rules are used ONLY where deterministic classification is justified
// (§12); ambiguous text always defers — the rules path never guesses.
// No I/O, no clock, no logging.

import type {
  ConfidenceBasis,
  ConfidenceLabel,
  EvidenceReference,
  HandlingClass,
  IntentLabel,
  OpportunityEntry,
  RelevanceLabel,
  RiskFlagEntry,
  SentimentLabel,
  UrgencyLabel,
} from "./interpretation-contract";
import type { SanitizedSocialSignal } from "./canonical-signal";
import { TEXT_BEARING_SIGNAL_TYPES } from "./canonical-signal";
import { excerptOf } from "./input-safety";
import { combineOverallConfidence } from "./confidence";

export const RULE_ENGINE_VERSION = "intent-sentiment-rules/v1" as const;

// ─── Versioned marker vocabularies (kept modest; each id is a rule ref) ───

/**
 * Spam/scam phrase markers, matched case-insensitively against lowercased
 * text. Crypto-scam and follower-bait phrases are deterministic classes: their
 * presence ends interpretation as `spam` without a model call (§12).
 */
export const SPAM_MARKERS = [
  "double your bitcoin",
  "double your btc",
  "airdrop claim",
  "claim your airdrop",
  "free crypto giveaway",
  "guaranteed returns",
  "send me 1 eth",
  "binary options trading",
  "follow for follow",
  "like for like",
  "follow me back",
] as const;

export type SafetyMarkerClass = "self_harm" | "threat_abuse";

export interface SafetyMarkerRule {
  readonly id: string;
  readonly class: SafetyMarkerClass;
  readonly phrases: readonly string[];
}

/**
 * Deterministic safety triggers (§10). Self-harm phrases route to
 * `support_request` + `safety_escalation`; threat/harassment phrases route to
 * `abuse` + `safety_escalation`. These are the only rule classes allowed to
 * mint safety-critical risk flags.
 */
export const SAFETY_MARKERS: readonly SafetyMarkerRule[] = [
  {
    id: "self_harm_phrases",
    class: "self_harm",
    phrases: [
      "kill myself",
      "want to die",
      "end my life",
      "hurt myself",
      "better off dead",
    ],
  },
  {
    id: "threat_abuse_phrases",
    class: "threat_abuse",
    phrases: [
      "i will kill you",
      "i'm going to kill you",
      "im going to kill you",
      "i know where you live",
      "watch your back",
    ],
  },
] as const;

/** Excessive external-link count that alone marks a signal as spam. */
export const SPAM_URL_THRESHOLD = 3;

const URL_PATTERN = /https?:\/\/[^\s]+|www\.[^\s]+/gi;

function ruleEvidenceRef(ruleRef: string, excerpt: string): EvidenceReference {
  return Object.freeze({ kind: "rule", ref: ruleRef, excerpt: excerptOf(excerpt, 160) });
}

function matchedSpamMarkers(text: string): string[] {
  const lower = text.toLowerCase();
  return SPAM_MARKERS.filter((marker) => lower.includes(marker));
}

function countUrls(text: string): number {
  const matches = text.match(URL_PATTERN);
  return matches ? matches.length : 0;
}

function matchedSafetyMarkers(text: string): { marker: SafetyMarkerRule; phrase: string }[] {
  const lower = text.toLowerCase();
  const hits: { marker: SafetyMarkerRule; phrase: string }[] = [];
  for (const marker of SAFETY_MARKERS) {
    for (const phrase of marker.phrases) {
      if (lower.includes(phrase)) {
        hits.push({ marker, phrase });
        break; // one phrase per marker class is enough evidence
      }
    }
  }
  return hits;
}

// ─── Verdict shapes ───

export interface DefinitiveRuleVerdict {
  readonly kind: "definitive";
  readonly source: "RULE";
  readonly ruleEngineVersion: typeof RULE_ENGINE_VERSION;
  readonly intent: IntentLabel;
  readonly intentConfidence: ConfidenceLabel;
  readonly sentiment: SentimentLabel;
  readonly sentimentConfidence: ConfidenceLabel;
  readonly urgency: UrgencyLabel;
  readonly relevance: RelevanceLabel;
  readonly relevanceConfidence: ConfidenceLabel;
  readonly overallConfidence: ConfidenceLabel;
  readonly confidenceBasis: ConfidenceBasis;
  readonly topics: readonly string[];
  readonly riskFlags: readonly RiskFlagEntry[];
  readonly opportunityIndicators: readonly OpportunityEntry[];
  readonly recommendedHandling: HandlingClass;
  readonly explanation: string;
  readonly evidenceReferences: readonly EvidenceReference[];
  readonly ruleRefs: readonly string[];
}

export type RuleVerdict =
  | DefinitiveRuleVerdict
  | { readonly kind: "needs_model" }
  | {
      readonly kind: "reject";
      readonly reason: "unsupported_signal_type" | "invalid_signal";
    };

function definitive(
  verdict: Omit<DefinitiveRuleVerdict, "kind" | "source" | "ruleEngineVersion" | "overallConfidence">
): DefinitiveRuleVerdict {
  return Object.freeze({
    kind: "definitive",
    source: "RULE",
    ruleEngineVersion: RULE_ENGINE_VERSION,
    ...verdict,
    overallConfidence: combineOverallConfidence({
      intentConfidence: verdict.intentConfidence,
      sentimentConfidence: verdict.sentimentConfidence,
      relevanceConfidence: verdict.relevanceConfidence,
    }),
  });
}

const REJECT_UNSUPPORTED: RuleVerdict = Object.freeze({
  kind: "reject",
  reason: "unsupported_signal_type",
});
const NEEDS_MODEL: RuleVerdict = Object.freeze({ kind: "needs_model" });

/**
 * Rule-first evaluation of a sanitized canonical signal. Order (first match
 * wins): unknown type → reject; non-text-bearing → low-information definitive;
 * empty text → irrelevant/no_action; spam markers (incl. ≥3-URL heuristic) →
 * spam/no_action; deterministic safety triggers → safety_escalation; otherwise
 * defer to the governed model path.
 */
export function evaluateRules(signal: SanitizedSocialSignal): RuleVerdict {
  if (!signal || typeof signal !== "object") {
    return Object.freeze({ kind: "reject", reason: "invalid_signal" });
  }

  // (a) Closed-enum violation: rejected before any processing, no record.
  if (signal.signalType === "unknown") {
    return REJECT_UNSUPPORTED;
  }
  if (typeof signal.contentText !== "string") {
    return Object.freeze({ kind: "reject", reason: "invalid_signal" });
  }

  // (b) Non-text-bearing signal: low-information definitive RULE record.
  if (!TEXT_BEARING_SIGNAL_TYPES.includes(signal.signalType)) {
    return definitive({
      intent: "unknown",
      intentConfidence: "unknown",
      sentiment: "unknown",
      sentimentConfidence: "unknown",
      urgency: "low",
      relevance: "unknown",
      relevanceConfidence: "unknown",
      confidenceBasis: "insufficient_evidence",
      topics: [],
      riskFlags: [],
      opportunityIndicators: [],
      recommendedHandling: "monitor",
      explanation: "Non-textual signal; insufficient evidence for interpretation.",
      evidenceReferences: [ruleEvidenceRef("rules-engine:non_text_bearing_signal", `signalType=${signal.signalType}`)],
      ruleRefs: ["rules-engine:non_text_bearing_signal"],
    });
  }

  // (c) Empty text on a text-bearing type: deterministic, never a model call.
  if (signal.contentText.trim().length === 0) {
    return definitive({
      intent: "irrelevant",
      intentConfidence: "high",
      sentiment: "unknown",
      sentimentConfidence: "high",
      urgency: "low",
      relevance: "unknown",
      relevanceConfidence: "high",
      confidenceBasis: "deterministic_rule",
      topics: [],
      riskFlags: [],
      opportunityIndicators: [],
      recommendedHandling: "no_action",
      explanation: "No interpretable text.",
      evidenceReferences: [ruleEvidenceRef("rules-engine:empty_text", `signalType=${signal.signalType}`)],
      ruleRefs: ["rules-engine:empty_text"],
    });
  }

  const text = signal.contentText;

  // (d) Spam markers / excessive links: definitive spam classification.
  const spamHits = matchedSpamMarkers(text);
  const urlCount = countUrls(text);
  if (spamHits.length > 0 || urlCount >= SPAM_URL_THRESHOLD) {
    const evidenceParts = [
      ...spamHits.map((marker) => `marker "${marker}"`),
      ...(urlCount >= SPAM_URL_THRESHOLD ? [`${urlCount} external links (>= ${SPAM_URL_THRESHOLD})`] : []),
    ];
    return definitive({
      intent: "spam",
      intentConfidence: "high",
      sentiment: "neutral",
      sentimentConfidence: "high",
      urgency: "low",
      relevance: "not_relevant",
      relevanceConfidence: "high",
      confidenceBasis: "deterministic_rule",
      topics: [],
      riskFlags: [
        Object.freeze({
          flag: "spam_or_scam",
          evidence: excerptOf(`spam rule matched: ${evidenceParts.join("; ")}`, 160),
        }),
      ],
      opportunityIndicators: [],
      recommendedHandling: "no_action",
      explanation: "Deterministic spam/scam markers matched; signal is not relevant to the business.",
      evidenceReferences: [
        ruleEvidenceRef(
          "rules-engine:spam_markers",
          evidenceParts.join("; ")
        ),
      ],
      ruleRefs: [
        ...(spamHits.length > 0 ? ["rules-engine:spam_markers"] : []),
        ...(urlCount >= SPAM_URL_THRESHOLD ? ["rules-engine:excessive_links"] : []),
      ],
    });
  }

  // (e) Deterministic safety triggers: definitive safety escalation.
  const safetyHits = matchedSafetyMarkers(text);
  if (safetyHits.length > 0) {
    const selfHarm = safetyHits.find((hit) => hit.marker.class === "self_harm");
    const threat = safetyHits.find((hit) => hit.marker.class === "threat_abuse");
    const riskFlags: RiskFlagEntry[] = [];
    const ruleRefs: string[] = [];
    const evidenceRefs: EvidenceReference[] = [];
    if (selfHarm) {
      riskFlags.push(
        Object.freeze({
          flag: "self_harm_safety_concern",
          evidence: excerptOf(`matched safety marker "${selfHarm.phrase}"`, 160),
        })
      );
      ruleRefs.push(`rules-engine:${selfHarm.marker.id}`);
      evidenceRefs.push(ruleEvidenceRef(`rules-engine:${selfHarm.marker.id}`, `phrase "${selfHarm.phrase}"`));
    }
    if (threat) {
      riskFlags.push(
        Object.freeze({
          flag: "abusive_or_harassing",
          evidence: excerptOf(`matched safety marker "${threat.phrase}"`, 160),
        })
      );
      ruleRefs.push(`rules-engine:${threat.marker.id}`);
      evidenceRefs.push(ruleEvidenceRef(`rules-engine:${threat.marker.id}`, `phrase "${threat.phrase}"`));
    }
    return definitive({
      intent: selfHarm && !threat ? "support_request" : "abuse",
      intentConfidence: "high",
      sentiment: threat ? "negative" : "unknown",
      sentimentConfidence: "high",
      urgency: "high",
      relevance: "unknown",
      relevanceConfidence: "high",
      confidenceBasis: "deterministic_rule",
      topics: [],
      riskFlags,
      opportunityIndicators: [],
      recommendedHandling: "safety_escalation",
      explanation: selfHarm && !threat
        ? "Deterministic self-harm safety marker matched; escalated for human safety review."
        : "Deterministic threat/abuse marker matched; escalated for human safety review.",
      evidenceReferences: evidenceRefs,
      ruleRefs,
    });
  }

  // (f) Ambiguous text: governed model path.
  return NEEDS_MODEL;
}
