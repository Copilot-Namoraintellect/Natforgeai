// ─── R8-E Strategic Opportunity & Risk — deterministic classification (E3–E5) ───
//
// Rule-first, model-free derivation and classification. Every formula is
// integer/fixed-point, documented in the canonical contract (§6), and
// reproducible: same projection inputs ⇒ same classes, same scores, same
// caps. No path — model, client or agent — may raise impact, urgency or
// confidence, hide contradiction, or inflate priority.
//
// Impact, urgency and confidence are SEPARATE dimensions (charter principle
// 4). Weak confidence caps priority (principle 5); contradiction lowers
// priority and stays visible (principle 6).

import {
  CONFIDENCE_CLASS_RANK,
  IMPACT_CLASS_RANK,
  URGENCY_CLASS_RANK,
  STRATEGIC_RISK_CLASS_RANK,
  fail,
  type CandidateKind,
  type CandidateType,
  type ConfidenceClass,
  type DerivationOutcome,
  type ImpactClass,
  type PriorityClass,
  type StrategicRiskClass,
  type TimeHorizon,
  type UrgencyClass,
} from "./strategic-opportunity-risk-contract";
import type {
  StrategicReasoningEvidenceItem,
  StrategicReasoningProjection,
} from "./strategic-opportunity-risk-reasoning-seam";

const HOURS_MS = 60 * 60 * 1000;
const DAYS_MS = 24 * HOURS_MS;

// ─── E3: derivation (rule-first; model proposals advisory only) ───

export interface DerivationVerdict {
  readonly outcome: DerivationOutcome;
  readonly candidateKind: CandidateKind | null;
  readonly candidateType: CandidateType | null;
  readonly limitationNote: string | null;
}

function riskRankOrNull(riskClass: string | null): number {
  return riskClass && riskClass in STRATEGIC_RISK_CLASS_RANK
    ? STRATEGIC_RISK_CLASS_RANK[riskClass as StrategicRiskClass]
    : 0;
}

/**
 * Deterministic (hypothesisType, implicationType, strategicRiskClass,
 * contradictingCount) rules (contract §6.1). Model assistance may propose
 * candidateTypes from the bounded space; a proposal that disagrees with the
 * deterministic verdict is ignored (never authority).
 */
export function deriveCandidateVerdict(
  projection: StrategicReasoningProjection,
  modelCandidateTypes: readonly CandidateType[] | undefined
): DerivationVerdict {
  const hypothesisType = projection.hypothesisType;
  const implicationType = projection.implicationType;
  const contradictingCount = projection.contradictingEvidence.length;
  const riskRank = riskRankOrNull(projection.strategicRiskClass);

  // NO_CANDIDATE gates first — not every conclusion becomes a candidate.
  if (projection.status !== "SUPPORTED" && projection.status !== "APPROVED_RECOMMENDATION" && projection.status !== "REVIEW_REQUIRED") {
    return {
      outcome: "NO_CANDIDATE",
      candidateKind: null,
      candidateType: null,
      limitationNote: `reasoning status ${projection.status} is not active`,
    };
  }
  if (projection.freshness !== "current") {
    return {
      outcome: "NO_CANDIDATE",
      candidateKind: null,
      candidateType: null,
      limitationNote: "stale reasoning cannot anchor a new candidate without re-evaluation",
    };
  }
  if (hypothesisType === "NO_ACTIONABLE_CONCLUSION" || implicationType === "NO_ACTION") {
    return {
      outcome: "NO_CANDIDATE",
      candidateKind: null,
      candidateType: null,
      limitationNote: "conclusion explicitly recommends no action",
    };
  }
  if (projection.supportingEvidence.length === 0) {
    return {
      outcome: "NO_CANDIDATE",
      candidateKind: null,
      candidateType: null,
      limitationNote: "zero usable supporting evidence",
    };
  }
  // INSUFFICIENT confidence with no material risk: nothing to monitor yet.
  if (
    projection.confidenceClass === "INSUFFICIENT" &&
    (projection.strategicRiskClass === null || riskRank === 0)
  ) {
    return {
      outcome: "NO_CANDIDATE",
      candidateKind: null,
      candidateType: null,
      limitationNote: "insufficient confidence with no material risk",
    };
  }

  let kind: CandidateKind;
  let type: CandidateType;
  switch (hypothesisType) {
    case "GROWTH_SIGNAL":
    case "DEMAND_CHANGE":
      kind = "OPPORTUNITY";
      type = "DEMAND_GROWTH";
      break;
    case "MARKET_SHIFT":
      kind = "OPPORTUNITY";
      type = "MARKET_EXPANSION";
      break;
    case "DECLINE_SIGNAL":
      kind = "RISK";
      type = "MARKET_DECLINE";
      break;
    case "COMPETITIVE_PRESSURE":
      if (riskRank >= 2 || contradictingCount > 0) {
        kind = "RISK";
        type = "COMPETITIVE_RESPONSE";
      } else {
        kind = "OPPORTUNITY";
        type = "COMPETITIVE_RESPONSE";
      }
      break;
    case "BUSINESS_CAPABILITY_GAP":
      kind = "RISK";
      type = "CAPABILITY_RISK";
      break;
    case "STRATEGIC_ALIGNMENT":
    case "POSITIONING_SIGNAL":
      kind = "OPPORTUNITY";
      type = "POSITIONING_CHANGE";
      break;
    case "RESOURCE_MISMATCH":
      if (implicationType === "REVIEW_RESOURCE_PRIORITY") {
        kind = "OPPORTUNITY";
        type = "RESOURCE_REALLOCATION";
      } else {
        kind = "RISK";
        type = "PORTFOLIO_RISK";
      }
      break;
    case "REGULATORY_IMPLICATION":
      kind = "RISK";
      type = "REGULATORY_RESPONSE";
      break;
    case "TECHNOLOGY_IMPLICATION":
      kind = "OPPORTUNITY";
      type = "TECHNOLOGY_ADOPTION";
      break;
    default:
      // Unknown hypothesis types never produce a candidate (fail closed).
      return {
        outcome: "NO_CANDIDATE",
        candidateKind: null,
        candidateType: null,
        limitationNote: `hypothesis type ${hypothesisType} outside derivation rules`,
      };
  }

  // Advisory model proposal: honoured only when it agrees with the
  // deterministic kind-compatible verdict; otherwise ignored.
  if (modelCandidateTypes && modelCandidateTypes.length > 0) {
    const proposed = modelCandidateTypes.find((t) => t === type);
    if (!proposed) {
      // Disagreement is ignored, never authority; the deterministic verdict stands.
      return {
        outcome: projection.confidenceClass === "INSUFFICIENT" ? "MONITOR_ONLY" : "CANDIDATE_CREATED",
        candidateKind: kind,
        candidateType: type,
        limitationNote: "model-proposed candidate type disagreed with deterministic derivation and was ignored",
      };
    }
  }

  return {
    outcome: projection.confidenceClass === "INSUFFICIENT" ? "MONITOR_ONLY" : "CANDIDATE_CREATED",
    candidateKind: kind,
    candidateType: type,
    limitationNote: null,
  };
}

// ─── E4: impact (integer 0–100; contract §6.2) ───

export function computeImpactScore(input: {
  strategicRiskClass: string | null;
  supportingAnchors: number;
  objectiveAnchorPresent: boolean;
  evidenceClasses: ReadonlySet<string>;
}): number {
  const riskWeight = riskRankOrNull(input.strategicRiskClass) * 20;
  const supportWeight = Math.min(input.supportingAnchors, 4) * 5;
  const objectiveWeight = input.objectiveAnchorPresent ? 10 : 0;
  const breadthWeight = input.evidenceClasses.size >= 2 ? 10 : 5;
  return Math.min(100, riskWeight + supportWeight + objectiveWeight + breadthWeight);
}

export function impactClassOf(score: number): ImpactClass {
  if (score < 25) return "MINOR";
  if (score < 50) return "MODERATE";
  if (score < 75) return "MAJOR";
  return "SEVERE";
}

// ─── E4: urgency (integer 0–100; contract §6.3) ───

export function computeUrgencyScore(input: {
  validUntil: string | null;
  newestObservedAt: string | null;
  implicationType: string;
  freshness: "current" | "stale";
  nowMs: number;
}): number {
  let validityWeight = 10;
  if (input.validUntil !== null) {
    const untilMs = Date.parse(input.validUntil);
    if (!Number.isNaN(untilMs)) {
      const delta = untilMs - input.nowMs;
      if (delta < 24 * HOURS_MS) validityWeight = 40;
      else if (delta < 7 * DAYS_MS) validityWeight = 30;
      else if (delta < 30 * DAYS_MS) validityWeight = 20;
      else validityWeight = 10;
    }
  }
  let recencyWeight = 5;
  if (input.newestObservedAt !== null) {
    const observedMs = Date.parse(input.newestObservedAt);
    if (!Number.isNaN(observedMs)) {
      const age = input.nowMs - observedMs;
      if (age < 7 * DAYS_MS) recencyWeight = 30;
      else if (age < 30 * DAYS_MS) recencyWeight = 20;
      else if (age < 90 * DAYS_MS) recencyWeight = 10;
      else recencyWeight = 5;
    }
  }
  let implicationWeight = 0;
  switch (input.implicationType) {
    case "REVIEW_MARKET_RESPONSE":
    case "REVIEW_POSITIONING":
      implicationWeight = 20;
      break;
    case "REVIEW_RESOURCE_PRIORITY":
    case "REVIEW_CHANNEL_STRATEGY":
    case "REVIEW_PRODUCT_MARKETING":
      implicationWeight = 15;
      break;
    case "INVESTIGATE":
    case "VALIDATE_ASSUMPTION":
      implicationWeight = 10;
      break;
    case "MONITOR":
      implicationWeight = 5;
      break;
    default:
      implicationWeight = 0;
  }
  const freshnessWeight = input.freshness === "current" ? 10 : 0;
  return validityWeight + recencyWeight + implicationWeight + freshnessWeight;
}

export function urgencyClassOf(score: number): UrgencyClass {
  if (score < 25) return "LOW";
  if (score < 50) return "MODERATE";
  if (score < 75) return "HIGH";
  return "IMMEDIATE";
}

// ─── E4: time horizon (contract §6.4) ───

export function deriveTimeHorizon(input: {
  urgencyClass: UrgencyClass;
  validUntil: string | null;
  nowMs: number;
}): TimeHorizon {
  let within7d = false;
  let within30d = false;
  let within90d = false;
  if (input.validUntil !== null) {
    const untilMs = Date.parse(input.validUntil);
    if (!Number.isNaN(untilMs)) {
      const delta = untilMs - input.nowMs;
      within7d = delta < 7 * DAYS_MS;
      within30d = delta < 30 * DAYS_MS;
      within90d = delta < 90 * DAYS_MS;
    }
  }
  if (input.urgencyClass === "IMMEDIATE" || within7d) return "IMMEDIATE";
  if (input.urgencyClass === "HIGH" || within30d) return "NEAR_TERM";
  if (input.urgencyClass === "MODERATE" || within90d) return "MEDIUM_TERM";
  return "LONG_TERM";
}

// ─── E5: evidence quality (integer 0–100; contract §6.5) ───

export function computeEvidenceQualityScore(input: {
  confidenceClass: ConfidenceClass;
  contradictingCount: number;
  missingEvidenceCount: number;
}): number {
  const base = CONFIDENCE_CLASS_RANK[input.confidenceClass] * 20;
  const contradictionPenalty = Math.min(30, 10 * input.contradictingCount);
  const missingPenalty = Math.min(10, 5 * input.missingEvidenceCount);
  return Math.max(0, Math.min(100, base - contradictionPenalty - missingPenalty));
}

// ─── E5: priority (integer fixed-point + binding caps; contract §6.6) ───

export function computePriorityScore(input: {
  impactClass: ImpactClass;
  urgencyClass: UrgencyClass;
  confidenceClass: ConfidenceClass;
  objectiveAnchorPresent: boolean;
  supportingAnchors: number;
  contradictingCount: number;
  uncertaintyClassCount: number;
  missingEvidenceNonEmpty: boolean;
}): number {
  const impactComponent = IMPACT_CLASS_RANK[input.impactClass] * 30;
  const urgencyComponent = URGENCY_CLASS_RANK[input.urgencyClass] * 20;
  const confidenceComponent = CONFIDENCE_CLASS_RANK[input.confidenceClass] * 25;
  const alignmentBonus = (input.objectiveAnchorPresent ? 10 : 0) + (input.supportingAnchors >= 3 ? 5 : 0);
  const contradictionPenalty = Math.min(45, 15 * input.contradictingCount);
  const uncertaintyPenalty = Math.min(30, 5 * input.uncertaintyClassCount);
  const missingPenalty = input.missingEvidenceNonEmpty ? 10 : 0;
  return (
    impactComponent +
    urgencyComponent +
    confidenceComponent +
    alignmentBonus -
    contradictionPenalty -
    uncertaintyPenalty -
    missingPenalty
  );
}

/**
 * Deterministic priority mapping + binding caps (contract §6.6, checked in
 * order). Caps enforce: weak confidence can never reach top priority; high
 * impact + weak confidence becomes MONITOR (human review), never an
 * autonomous top priority; CRITICAL_REVIEW requires strong evidence.
 */
export function priorityClassOf(input: {
  priorityScore: number;
  impactClass: ImpactClass;
  confidenceClass: ConfidenceClass;
}): PriorityClass {
  const confidenceRank = CONFIDENCE_CLASS_RANK[input.confidenceClass];
  // Cap 1: INSUFFICIENT confidence ⇒ MONITOR.
  if (confidenceRank === 0) return "MONITOR";
  // Cap 3: confidence ≤ LOW and impact ≥ MAJOR ⇒ MONITOR (review/monitor,
  // never autonomous top priority).
  if (confidenceRank <= 1 && IMPACT_CLASS_RANK[input.impactClass] >= IMPACT_CLASS_RANK.MAJOR) {
    return "MONITOR";
  }
  let cls: PriorityClass;
  const s = input.priorityScore;
  if (s < 50) cls = "MONITOR";
  else if (s < 90) cls = "LOW";
  else if (s < 130) cls = "MEDIUM";
  else if (s < 170) cls = "HIGH";
  else cls = "CRITICAL_REVIEW";
  // Cap 2: LOW confidence ⇒ at most MEDIUM.
  if (confidenceRank === 1 && (cls === "HIGH" || cls === "CRITICAL_REVIEW")) cls = "MEDIUM";
  // Cap 4: CRITICAL_REVIEW requires confidence ≥ MODERATE and impact ≥ MAJOR.
  if (cls === "CRITICAL_REVIEW" && (confidenceRank < 2 || IMPACT_CLASS_RANK[input.impactClass] < 2)) {
    cls = "HIGH";
  }
  return cls;
}

// ─── Shared evidence helpers ───

export function anchorEvidence(projection: StrategicReasoningProjection): readonly StrategicReasoningEvidenceItem[] {
  const anchors = projection.supportingEvidence.filter((e) => e.role === "ANCHOR");
  return anchors.length > 0 ? anchors : projection.supportingEvidence;
}

export function objectiveAnchorPresent(projections: readonly StrategicReasoningProjection[]): boolean {
  // STRATEGIC_OBJECTIVE memory anchors are an R8-A memory-type concept; the
  // frozen projection does not expose memory types, so objective alignment is
  // carried only when the governing reasoning itself is a STRATEGIC_ALIGNMENT
  // hypothesis (bounded, deterministic — never guessed).
  return projections.some((p) => p.hypothesisType === "STRATEGIC_ALIGNMENT");
}

export function collectEvidenceClasses(
  projections: readonly StrategicReasoningProjection[]
): Set<string> {
  const classes = new Set<string>();
  for (const p of projections) {
    for (const e of p.supportingEvidence) classes.add(e.evidenceClass);
  }
  return classes;
}

export function newestObservedAt(projection: StrategicReasoningProjection): string | null {
  // The frozen projection does not carry observedAt; validity and freshness
  // are the authoritative urgency clocks (contract §6.3). Extension point
  // documented — never fabricated.
  void projection;
  return null;
}

export function assertConfidenceClass(value: string): asserts value is ConfidenceClass {
  if (!(value in CONFIDENCE_CLASS_RANK)) {
    fail("REASONING_PROJECTION_MALFORMED", `confidence class ${value} outside frozen vocabulary`);
  }
}
