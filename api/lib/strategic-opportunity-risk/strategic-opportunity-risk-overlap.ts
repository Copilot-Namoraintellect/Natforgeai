// ─── R8-E Strategic Opportunity & Risk — overlap / portfolio interaction (E6) ───
//
// Deterministic candidate overlap analysis. Relations are lineage only:
// they preserve source reasoning references and are NEVER score inputs —
// overlapping candidates do not inflate importance (charter principles 8/9,
// contract §8). Same-authority duplicates converge by identity (E2) before
// this analysis runs; what remains here is cross-reasoning interaction.

import type { CandidateKind, PortfolioRelation } from "./strategic-opportunity-risk-contract";
import type { StrategicReasoningProjection } from "./strategic-opportunity-risk-reasoning-seam";

/** Minimal existing-candidate view needed for overlap analysis. */
export interface ExistingCandidateView {
  readonly candidateId: string;
  readonly candidateKind: CandidateKind;
  readonly candidateType: string;
  readonly subjectKey: string;
  readonly reasoningIds: readonly string[];
  readonly anchorRefs: readonly string[];
}

export interface OverlapInput {
  readonly candidateKind: CandidateKind;
  readonly candidateType: string;
  readonly subjectKey: string;
  readonly reasoningIds: readonly string[];
  readonly anchorRefs: readonly string[];
  readonly existing: readonly ExistingCandidateView[];
  /** Governing projections keyed by reasoningId (supersession chains). */
  readonly projectionsByReasoningId: ReadonlyMap<string, StrategicReasoningProjection>;
}

export interface OverlapVerdict {
  readonly relation: PortfolioRelation;
  readonly relatedCandidateIds: readonly string[];
}

function intersects(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return b.some((x) => set.has(x));
}

/**
 * Deterministic relation rules, checked in order:
 *  1. SUPERSEDING — an existing candidate is bound to a reasoning that the
 *     new governing reasoning supersedes (history moves forward).
 *  2. CONFLICTING — same subject, opposite kind (opportunity vs risk on the
 *     same subject stays visible; never a silent winner).
 *  3. REINFORCING — same kind + same type + same subject (different
 *     reasoning): converging evidence, lineage preserved.
 *  4. OVERLAPPING — same subject different type, or shared anchor evidence.
 *  5. NEW — no deterministic interaction.
 */
export function computePortfolioRelation(input: OverlapInput): OverlapVerdict {
  // 1. Supersession via the R8-D supersedesReasoningId chain.
  for (const existing of input.existing) {
    for (const reasoningId of input.reasoningIds) {
      const projection = input.projectionsByReasoningId.get(reasoningId);
      if (projection && projection.supersedesReasoningId) {
        if (existing.reasoningIds.includes(projection.supersedesReasoningId)) {
          return { relation: "SUPERSEDING", relatedCandidateIds: [existing.candidateId] };
        }
      }
    }
  }

  // 2/3/4. Subject / reasoning / anchor analysis.
  const conflicting: string[] = [];
  const reinforcing: string[] = [];
  const overlapping: string[] = [];
  for (const existing of input.existing) {
    const sameSubject = existing.subjectKey === input.subjectKey;
    const sharedReasoning = intersects(existing.reasoningIds, input.reasoningIds);
    const sharedAnchors = intersects(existing.anchorRefs, input.anchorRefs);
    if (!sameSubject && !sharedReasoning && !sharedAnchors) continue;
    if ((sameSubject || sharedReasoning) && existing.candidateKind !== input.candidateKind) {
      conflicting.push(existing.candidateId);
    } else if (
      sameSubject &&
      existing.candidateKind === input.candidateKind &&
      existing.candidateType === input.candidateType
    ) {
      reinforcing.push(existing.candidateId);
    } else {
      overlapping.push(existing.candidateId);
    }
  }

  const related: string[] = [];
  let relation: PortfolioRelation = "NEW";
  if (conflicting.length > 0) {
    relation = "CONFLICTING";
    related.push(...conflicting);
  }
  if (reinforcing.length > 0) {
    if (relation === "NEW") relation = "REINFORCING";
    related.push(...reinforcing);
  }
  if (overlapping.length > 0) {
    if (relation === "NEW") relation = "OVERLAPPING";
    related.push(...overlapping);
  }
  return { relation, relatedCandidateIds: [...new Set(related)] };
}
