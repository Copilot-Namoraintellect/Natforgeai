// ─── R7-C Business Learning Engine — novelty / repetition / contradiction ───
//
// PURE module (no I/O, no clock). Deterministically classifies a derived
// candidate against existing current learning for the same subject. Repeated
// identical evidence never inflates support (DUPLICATE replays the existing

// record); contradictions are retained, never deleted and never averaged
// away; supersession preserves both histories.

import type { LearningDirection, LearningNoveltyClass } from "./business-learning-contract";
import { isScopeComparable, type LearningContextScope } from "./business-learning-context";

/** Minimal read view of an existing learning record for comparison. */
export interface ExistingLearningView {
  readonly learningId: string;
  readonly learningType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly evidenceBundleId: string;
  readonly upstreamStateFingerprint: string;
  readonly status: string;
  readonly contextScope: LearningContextScope;
  readonly outcomeIds: readonly string[];
  readonly attributionIds: readonly string[];
}

/** Candidate comparison material (post-derivation, pre-persist). */
export interface NoveltyCandidateView {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly direction: LearningDirection;
  readonly evidenceBundleId: string;
  readonly upstreamStateFingerprint: string;
  readonly contextScope: LearningContextScope;
  readonly outcomeIds: readonly string[];
  readonly attributionIds: readonly string[];
  /** supersedesAttributionId values carried by the candidate's bundle. */
  readonly supersedesAttributionIds: readonly string[];
  /** supersedesOutcomeId values carried by the candidate's bundle. */
  readonly supersedesOutcomeIds: readonly string[];
}

/** Record directions implied by the closed learning-type vocabulary. */
export function directionOfLearningType(learningType: string): LearningDirection {
  if (learningType === "NEGATIVE_PATTERN") return "negative";
  if (learningType === "INSUFFICIENT_EVIDENCE") return "neutral";
  return "positive";
}

const OPPOSITE_DIRECTION: Record<"positive" | "negative", LearningDirection> = {
  positive: "negative",
  negative: "positive",
};

function isCurrent(record: ExistingLearningView): boolean {
  // SUPERSEDED / DEPRECATED / INVALIDATED records are history, never the
  // current projection; contradictions and invalidations stay fully readable.
  return (
    record.status !== "SUPERSEDED" &&
    record.status !== "DEPRECATED" &&
    record.status !== "INVALIDATED"
  );
}

export interface NoveltyClassification {
  readonly noveltyClass: LearningNoveltyClass;
  /** The existing record this classification refers to (when any). */
  readonly matchedLearningId: string | null;
}

/**
 * Closed novelty classification (contract §8), evaluated in order:
 * DUPLICATE → CONTRADICTING → SUPERSEDING → REINFORCING → NEW. Comparison is
 * scoped to the same subject and a comparable evidenced context; broader
 * context is never inferred.
 */
export function classifyNovelty(
  candidate: NoveltyCandidateView,
  existingRecords: readonly ExistingLearningView[]
): NoveltyClassification {
  const peers = existingRecords.filter(
    (r) =>
      isCurrent(r) &&
      r.subjectType === candidate.subjectType &&
      r.subjectId === candidate.subjectId &&
      isScopeComparable(candidate.contextScope, r.contextScope)
  );

  // DUPLICATE: identical evidence bundle AND identical upstream state → the
  // same authoritative derivation; replay converges without inflating support.
  const duplicate = peers.find(
    (r) =>
      r.evidenceBundleId === candidate.evidenceBundleId &&
      r.upstreamStateFingerprint === candidate.upstreamStateFingerprint
  );
  if (duplicate) {
    return { noveltyClass: "DUPLICATE", matchedLearningId: duplicate.learningId };
  }

  // CONTRADICTING: an existing current record carries the opposite
  // direction. Neutral candidates never contradict (insufficient evidence is
  // not counter-evidence).
  const candidateDirection = candidate.direction;
  const contradicting =
    candidateDirection === "positive" || candidateDirection === "negative"
      ? peers.find(
          (r) => directionOfLearningType(r.learningType) === OPPOSITE_DIRECTION[candidateDirection]
        )
      : undefined;
  if (contradicting) {
    return { noveltyClass: "CONTRADICTING", matchedLearningId: contradicting.learningId };
  }

  // SUPERSEDING: the candidate's bundle explicitly supersedes the existing
  // record's evidence (a carried supersedes* id names an id in the existing
  // bundle), or the same bundle is re-derived under changed upstream state
  // (verification/lifecycle fingerprint differs) — newer authority, same
  // subject, same direction.
  const superseding = peers.find(
    (r) =>
      (r.evidenceBundleId !== candidate.evidenceBundleId &&
        (candidate.supersedesAttributionIds.some((id) => r.attributionIds.includes(id)) ||
          candidate.supersedesOutcomeIds.some((id) => r.outcomeIds.includes(id)))) ||
      (r.evidenceBundleId === candidate.evidenceBundleId &&
        r.upstreamStateFingerprint !== candidate.upstreamStateFingerprint)
  );
  if (superseding) {
    return { noveltyClass: "SUPERSEDING", matchedLearningId: superseding.learningId };
  }

  // REINFORCING: same direction, disjoint bundle, no supersession link.
  const reinforcing = peers.find((r) => r.evidenceBundleId !== candidate.evidenceBundleId);
  if (reinforcing) {
    return { noveltyClass: "REINFORCING", matchedLearningId: reinforcing.learningId };
  }

  return { noveltyClass: "NEW", matchedLearningId: null };
}
