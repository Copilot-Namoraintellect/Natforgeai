// ─── R8-C Market & External Signal Intelligence — business relevance (C6) ───
//
// PURE module: deterministic, rule-first business-relevance classification.
// Relevance is whether a signal bears on THIS business — separate from truth
// (an irrelevant signal can be verified truth; a relevant signal can be
// rumour). A model may PROPOSE a relevance class, but the server bounds it by
// deterministic term evidence; no external source may declare itself relevant
// (source-declared relevance fields are rejected at the contract boundary).
// No I/O, no clock, no authority.

import type { MarketRelevanceClass } from "./market-signal-contract";

// ─── Business context input (verified business row fields only) ───

export interface BusinessRelevanceContext {
  readonly name: string | null;
  readonly industry: string | null;
  readonly description: string | null;
  readonly productOrService: string | null;
  readonly targetAudience: string | null;
  readonly targetCustomer: string | null;
  readonly mainGoal: string | null;
  readonly website: string | null;
}

// ─── Deterministic tokenization ───

const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "their", "our", "are", "was", "were",
  "has", "have", "had", "not", "but", "all", "any", "can", "will", "about", "after", "before", "between",
  "through", "over", "under", "more", "most", "other", "some", "such", "than", "then", "they", "them",
  "its", "also", "because", "while", "where", "when", "what", "which", "who", "whom", "how", "why",
  "business", "company", "market", "marketing", "customers", "customer", "service", "services", "product",
  "products", "offer", "offers", "solution", "solutions", "brand", "new", "now", "get", "use", "used",
  "help", "helps", "make", "made", "like", "just", "per", "each", "very", "really", "great", "best",
]);

function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  const raw = text.toLowerCase().normalize("NFC").split(/[^a-z0-9]+/);
  const out: string[] = [];
  for (const token of raw) {
    if (token.length < 3 || token.length > 24) continue;
    if (STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

/** Bounded business term set from the verified business row. */
export function buildBusinessTermSet(ctx: BusinessRelevanceContext): ReadonlySet<string> {
  const terms = new Set<string>();
  const fields = [
    ctx.name,
    ctx.industry,
    ctx.description,
    ctx.productOrService,
    ctx.targetAudience,
    ctx.targetCustomer,
    ctx.mainGoal,
    // Website contributes its registrable host tokens (not TLD fragments).
    ctx.website ? ctx.website.replace(/^https?:\/\//, "").split(/[/?#]/)[0] : null,
  ];
  for (const field of fields) {
    for (const token of tokenize(field)) {
      terms.add(token);
      if (terms.size >= 200) return terms;
    }
  }
  return terms;
}

// ─── Deterministic scoring + closed class mapping (contract §9) ───

export interface RelevanceEvidence {
  /** Exact matched business terms, verbatim, bounded. */
  readonly matchedTerms: readonly string[];
  readonly businessTermCount: number;
  readonly signalTermCount: number;
  /** Deterministic overlap score, rounded to 4 decimals. */
  readonly score: number;
}

export interface RelevanceResult {
  readonly relevanceClass: MarketRelevanceClass;
  readonly evidence: RelevanceEvidence;
}

function classifyScore(score: number): MarketRelevanceClass {
  if (score >= 0.5) return "DIRECT";
  if (score >= 0.25) return "RELATED";
  if (score >= 0.1) return "WEAK";
  return "IRRELEVANT";
}

const RELEVANCE_ORDINAL: Record<MarketRelevanceClass, number> = { DIRECT: 3, RELATED: 2, WEAK: 1, IRRELEVANT: 0 };

/** The model may propose, the server ceiling wins: min(proposal, ceiling). */
export function boundProposedRelevance(
  proposed: MarketRelevanceClass,
  ceiling: MarketRelevanceClass
): MarketRelevanceClass {
  return RELEVANCE_ORDINAL[proposed] <= RELEVANCE_ORDINAL[ceiling] ? proposed : ceiling;
}

/**
 * Score one signal's evidence against the verified business term set.
 * Signal terms come from subjectRef, claimAspect and the normalized claim
 * text. Score = |matched| / |distinct signal terms| — directly relevant
 * signals retain their exact matched-term evidence in every projection.
 */
export function evaluateRelevance(input: {
  subjectRef: string;
  claimAspect: string;
  claimText: string;
  businessTerms: ReadonlySet<string>;
  proposedRelevanceClass?: MarketRelevanceClass | undefined;
}): RelevanceResult {
  const signalTerms = new Set<string>([
    ...tokenize(input.subjectRef),
    ...tokenize(input.claimAspect),
    ...tokenize(input.claimText),
  ]);
  const matched: string[] = [];
  for (const term of signalTerms) {
    if (input.businessTerms.has(term)) matched.push(term);
  }
  matched.sort();
  const signalTermCount = signalTerms.size;
  const score = signalTermCount === 0 ? 0 : Math.round((matched.length / signalTermCount) * 10_000) / 10_000;
  const ceiling = classifyScore(score);
  const relevanceClass =
    input.proposedRelevanceClass !== undefined
      ? boundProposedRelevance(input.proposedRelevanceClass, ceiling)
      : ceiling;
  return {
    relevanceClass,
    evidence: {
      matchedTerms: matched.slice(0, 24),
      businessTermCount: input.businessTerms.size,
      signalTermCount,
      score,
    },
  };
}
