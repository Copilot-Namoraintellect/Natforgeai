// ─── R8-C Market & External Signal Intelligence — corroboration / contradiction (C4/C7) ───
//
// PURE module: deterministic corroboration and contradiction computation over
// same-tenant + same-business signals sharing a claimKey / claimFamilyKey.
// Corroboration relies on genuinely INDEPENDENT evidence: two sources are
// independent iff their source-independence keys differ AND their publication
// event keys differ — syndicated copies of one source (same publication under
// another origin, or the same origin re-delivered) never count as independent
// corroboration. No I/O, no clock, no authority.

import type { MarketCorroborationStatus } from "./market-signal-contract";

/** Terminal/lineage statuses that can never corroborate. */
const NON_CORROBORATING_STATUSES: ReadonlySet<string> = new Set(["INVALIDATED", "SUPERSEDED"]);

/** Freshness states that can never corroborate. */
const NON_CORROBORATING_FRESHNESS: ReadonlySet<string> = new Set(["EXPIRED"]);

export interface CorroborationCandidate {
  readonly signalId: string;
  readonly sourceIndependenceKey: string;
  readonly eventKey: string;
  readonly signalStatus: string;
  readonly freshnessClass: string;
}

/**
 * Independence test: distinct publisher/origin keys AND distinct publication
 * event identities. An aggregator copy of the same wire story carries the same
 * eventKey and is therefore NOT independent; a re-delivery under the same
 * origin is not even a separate row (exact-once natural key).
 */
export function isIndependentEvidence(
  self: Pick<CorroborationCandidate, "sourceIndependenceKey" | "eventKey">,
  other: Pick<CorroborationCandidate, "sourceIndependenceKey" | "eventKey">
): boolean {
  return other.sourceIndependenceKey !== self.sourceIndependenceKey && other.eventKey !== self.eventKey;
}

export interface CorroborationResult {
  /** Independent corroborating signals (same claimKey), newest first, ≤16. */
  readonly corroboratingSignalIds: readonly string[];
  /** Number of distinct independent sources behind those signals. */
  readonly independentCorroborationCount: number;
  /** Closed corroboration status (contradiction counts supplied by the caller). */
  readonly corroborationStatus: MarketCorroborationStatus;
}

/**
 * Compute corroboration for one signal from same-claimKey candidates (already
 * tenant + business scoped by the caller). Contradiction visibility is
 * caller-supplied: `activeContradictionCount` is the number of validated,
 * still-active contradicting signals (same claim family, different claim,
 * not invalidated/superseded).
 */
export function computeCorroboration(input: {
  self: CorroborationCandidate;
  sameClaimCandidates: readonly CorroborationCandidate[];
  activeContradictionCount: number;
}): CorroborationResult {
  const seenIndependenceKeys = new Set<string>();
  const corroborating: string[] = [];
  let independentCount = 0;
  for (const candidate of input.sameClaimCandidates) {
    if (candidate.signalId === input.self.signalId) continue;
    if (NON_CORROBORATING_STATUSES.has(candidate.signalStatus)) continue;
    if (NON_CORROBORATING_FRESHNESS.has(candidate.freshnessClass)) continue;
    if (!isIndependentEvidence(input.self, candidate)) continue;
    if (seenIndependenceKeys.has(candidate.sourceIndependenceKey)) continue;
    seenIndependenceKeys.add(candidate.sourceIndependenceKey);
    corroborating.push(candidate.signalId);
    independentCount += 1;
    if (corroborating.length >= 16) break;
  }
  const contradicted = input.activeContradictionCount > 0;
  const corroborated = independentCount > 0;
  const corroborationStatus: MarketCorroborationStatus = contradicted
    ? corroborated
      ? "MIXED"
      : "CONTRADICTED"
    : corroborated
      ? "CORROBORATED"
      : "UNCORROBORATED";
  return {
    corroboratingSignalIds: corroborating,
    independentCorroborationCount: independentCount,
    corroborationStatus,
  };
}
