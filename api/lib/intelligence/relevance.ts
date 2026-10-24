// ─── R5-B Intent & Sentiment Intelligence — Business DNA relevance (§9) ───
//
// PURE deterministic relevance assessment. When an owner-scoped Business DNA
// snapshot exists, relevance is normalized token overlap between the signal
// text and the snapshot's primaryOffering + productsAndServices — explainable
// but not semantic. When no snapshot exists, relevance is honestly the model
// hint (bounded confidence) or unknown; business/product linkage is never
// fabricated. Owner-scoped snapshot fetching lives in the orchestrator slice,
// not here. No I/O, no clock, no logging.

import type { BusinessDNASnapshot } from "../business-dna";
import type { EvidenceReference, RelevanceLabel } from "./interpretation-contract";
import { RelevanceLabelEnum } from "./interpretation-contract";
import { excerptOf } from "./input-safety";

export interface RelevanceAssessment {
  readonly relevance: RelevanceLabel;
  readonly relevanceConfidence: "high" | "medium" | "low";
  readonly evidence: EvidenceReference | null;
  readonly businessDnaSnapshotId: string | null;
}

const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "you", "your", "are", "was", "were",
  "this", "that", "have", "has", "from", "they", "them", "our", "out",
  "who", "what", "when", "where", "how", "all", "any", "can", "not", "but",
]);

const MIN_TOKEN_LEN = 3;
const STRONG_TOKEN_HITS = 2;

/** Lowercase alphanumeric tokens, min length 3, common stopwords removed. */
function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return matches.filter((token) => token.length >= MIN_TOKEN_LEN && !STOPWORDS.has(token));
}

function uniqueTokens(tokens: readonly string[]): string[] {
  return [...new Set(tokens)];
}

/**
 * Deterministic token-overlap relevance against a Business DNA snapshot
 * (contract §9). Buckets: any candidate fully present in the text, or ≥2
 * matched tokens on a single candidate → relevant; any single token hit →
 * partially_relevant; none → not_relevant. Confidence is high for
 * relevant/not_relevant and medium for partially_relevant.
 */
export function assessRelevanceWithContext(
  text: string,
  snapshot: BusinessDNASnapshot
): RelevanceAssessment {
  const textTokens = new Set(uniqueTokens(tokenize(text)));
  const candidates = [snapshot.primaryOffering, ...snapshot.productsAndServices];

  let bestCandidateMatch = 0;
  let totalMatched: string[] = [];
  let strongestCandidate: string | null = null;

  for (const candidate of candidates) {
    const candidateTokens = uniqueTokens(tokenize(candidate));
    if (candidateTokens.length === 0) continue;
    const matched = candidateTokens.filter((token) => textTokens.has(token));
    if (matched.length === 0) continue;
    if (matched.length > totalMatched.length) {
      totalMatched = matched;
      strongestCandidate = candidate;
    }
    // Full-candidate presence (the whole offering/product mention appears).
    if (matched.length === candidateTokens.length && matched.length > bestCandidateMatch) {
      bestCandidateMatch = matched.length;
    }
    if (matched.length >= STRONG_TOKEN_HITS && matched.length > bestCandidateMatch) {
      bestCandidateMatch = matched.length;
    }
  }

  const matchedTokens = uniqueTokens(totalMatched);
  const evidence: EvidenceReference | null =
    matchedTokens.length > 0
      ? Object.freeze({
          kind: "business_dna" as const,
          ref: `snapshot:${snapshot.snapshotId}`,
          excerpt: excerptOf(
            `matched tokens (${matchedTokens.slice(0, 8).join(", ")})${
              strongestCandidate ? ` on candidate "${strongestCandidate.trim()}"` : ""
            }`,
            160
          ),
        })
      : null;

  if (bestCandidateMatch > 0 || matchedTokens.length >= STRONG_TOKEN_HITS) {
    return Object.freeze({
      relevance: "relevant",
      relevanceConfidence: "high",
      evidence,
      businessDnaSnapshotId: snapshot.snapshotId,
    });
  }
  if (matchedTokens.length === 1) {
    return Object.freeze({
      relevance: "partially_relevant",
      relevanceConfidence: "medium",
      evidence,
      businessDnaSnapshotId: snapshot.snapshotId,
    });
  }
  return Object.freeze({
    relevance: "not_relevant",
    relevanceConfidence: "high",
    evidence: null,
    businessDnaSnapshotId: snapshot.snapshotId,
  });
}

/**
 * Context-free relevance (contract §9): the validated model hint is consumed
 * at bounded confidence — medium for relevant/not_relevant, low for
 * partially_relevant/unknown — or relevance is honestly unknown when no hint
 * exists. No snapshot participates: businessDnaSnapshotId stays null.
 */
export function assessRelevanceWithoutContext(
  modelRelevanceHint: unknown
): RelevanceAssessment {
  const hint = RelevanceLabelEnum.safeParse(modelRelevanceHint);
  if (!hint.success) {
    return Object.freeze({
      relevance: "unknown",
      relevanceConfidence: "low",
      evidence: null,
      businessDnaSnapshotId: null,
    });
  }
  switch (hint.data) {
    case "relevant":
    case "not_relevant":
      return Object.freeze({
        relevance: hint.data,
        relevanceConfidence: "medium",
        evidence: Object.freeze({ kind: "model" as const, ref: "model_relevance_hint" }),
        businessDnaSnapshotId: null,
      });
    case "partially_relevant":
    case "unknown":
      return Object.freeze({
        relevance: hint.data,
        relevanceConfidence: "low",
        evidence:
          hint.data === "partially_relevant"
            ? Object.freeze({ kind: "model" as const, ref: "model_relevance_hint" })
            : null,
        businessDnaSnapshotId: null,
      });
  }
}
