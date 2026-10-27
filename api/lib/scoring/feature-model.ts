// ─── R6-B Lead Scoring — authoritative feature model (B2) ───
//
// PURE module: defines the allowed scoring features (closed catalog), their
// sources, ranges, normalization, missing-value behavior and provenance, and
// validates every raw input before it can influence a score. Fail-closed on
// malformed values (NaN / Infinity / negative / out-of-range), unknown closed
// vocabulary, or forbidden features (protected-trait / demographic proxies).
//
// Feature groups (scoring contract §4): FIT, INTENT, ENGAGEMENT, RECENCY,
// OPPORTUNITY (evidence strength). All features derive from R5 opportunity
// candidates/evidence and the authoritative lead seam — never from client
// input, never from raw social text, never from demographics.

import {
  ScoringValidationError,
  ScoringInputError,
  EXPLICIT_INTENT_TYPE_SET,
  FORBIDDEN_FEATURE_VALUES,
  OPPORTUNITY_TYPE_SET,
  fitTypeRelevance,
  intentTypeBase,
} from "./scoring-contract";
import {
  EVIDENCE_KIND_VALUES,
  CONFIDENCE_CLASS_VALUES,
  type EvidenceKind,
  type OpportunityType,
} from "../opportunity/opportunity-contract";

export const FEATURE_GROUP_VALUES = ["FIT", "INTENT", "ENGAGEMENT", "RECENCY", "OPPORTUNITY"] as const;
export type FeatureGroup = (typeof FEATURE_GROUP_VALUES)[number];

export interface FeatureProvenance {
  /** Durable source of the feature value. */
  source: "opportunity_candidate" | "opportunity_evidence" | "lead_identity" | "derived";
  /** Human-auditable derivation note (bounded, no PII, no text content). */
  derivation: string;
  /** Model/billable provenance: v1 features are all deterministic, non-billable. */
  billable: false;
}

// ─── Raw scoring inputs (gathered server-side by the scoring service) ───

/** One opportunity candidate contributing evidence to this lead's score. */
export interface CandidateFeatureInput {
  opportunityId: string;
  opportunityType: string;
  evidenceStrength: string;
  campaignId: number | null;
  contradictionCount: number;
}

/** One immutable R5 evidence row (closed labels only — references, no text). */
export interface EvidenceFeatureInput {
  interpretationId: string;
  kind: string;
  contributesToStrength: boolean;
  opportunityTypeAtEvaluation: string;
  overallConfidence: string;
  relevance: string;
  occurredAt: string;
}

/** Authoritative lead context from the identity seam (never client-supplied). */
export interface LeadContextInput {
  leadCampaignId: number | null;
}

export interface RawScoringInputs {
  candidates: CandidateFeatureInput[];
  evidence: EvidenceFeatureInput[];
  lead: LeadContextInput;
}

// ─── Validated feature vector (the only thing the engine may consume) ───

export interface ScoringFeatureVector {
  hasAnyEvidence: boolean;
  fitTypeRelevance: number; // 0..1
  fitCampaignAlignment: number; // 0..1
  intentTypeBase: number; // 0..100
  explicitHighCount: number; // >= 0 integer
  explicitMediumCount: number; // >= 0 integer
  validatedReceiptCount: number; // >= 0 integer
  distinctInterpretationCount: number; // >= 0 integer
  contributingEvidenceCount: number; // >= 0 integer
  evidenceStrengthOrdinal: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  contradictionCount: number; // >= 0 integer
  /** Opportunity type of the highest-relevance candidate (drives reason codes). */
  primaryOpportunityType: OpportunityType;
  /** Newest contributing evidence time (epoch ms); null = missing recency. */
  latestObservedAtMs: number | null;
  provenance: Record<string, FeatureProvenance>;
}

const STRENGTH_ORDINAL_SET = new Set<string>(CONFIDENCE_CLASS_VALUES);
const EVIDENCE_KIND_SET = new Set<string>(EVIDENCE_KIND_VALUES);
const FORBIDDEN_FEATURE_SET = new Set<string>(FORBIDDEN_FEATURE_VALUES);

// ─── Validation helpers (fail closed) ───

function assertFiniteNumber(value: number, field: string, min: number, max: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ScoringValidationError(
      "INVALID_FEATURE_VALUE",
      `feature ${field} must be a finite number; got ${String(value)}.`
    );
  }
  if (value < min || value > max) {
    throw new ScoringValidationError(
      "INVALID_FEATURE_VALUE",
      `feature ${field} must be within [${min}, ${max}]; got ${value}.`
    );
  }
}

function assertCount(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ScoringValidationError(
      "INVALID_FEATURE_VALUE",
      `feature ${field} must be a non-negative integer; got ${String(value)}.`
    );
  }
}

/**
 * Guard for any future feature-supplying seam (deterministic or AI): reject
 * forbidden feature names outright. v1 inputs are server-built, but the
 * boundary defence is enforced here so no path can ever bypass it.
 */
export function assertAllowedFeatureNames(names: readonly string[]): void {
  for (const name of names) {
    if (FORBIDDEN_FEATURE_SET.has(name)) {
      throw new ScoringValidationError(
        "FORBIDDEN_FEATURE",
        `feature "${name}" is a forbidden protected-trait / demographic feature and can never influence a lead score.`
      );
    }
  }
}

function assertIsoTimestamp(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new ScoringValidationError(
      "INVALID_FEATURE_VALUE",
      `feature ${field} must be a parseable ISO 8601 timestamp.`
    );
  }
}

// ─── Feature construction (deterministic, documented per contract §4) ───

function campaignAlignment(candidateCampaignId: number | null, leadCampaignId: number | null): number {
  // Contract §4b: candidate attributed + lead attributed → 1.00 equal / 0.30 different;
  // candidate unattributed → 0.40; lead without campaign context → 0.50 (neutral).
  if (leadCampaignId === null) return 0.5;
  if (candidateCampaignId === null) return 0.4;
  return candidateCampaignId === leadCampaignId ? 1.0 : 0.3;
}

/**
 * Build the validated feature vector from raw R5 + lead-seam inputs.
 * Pure and deterministic: same inputs → same vector. Throws on any
 * malformed/forbidden value; nothing partial ever reaches the engine.
 */
export function buildFeatureVector(raw: RawScoringInputs): ScoringFeatureVector {
  // Closed-vocabulary + structural validation first (fail closed).
  for (const candidate of raw.candidates) {
    if (!OPPORTUNITY_TYPE_SET.has(candidate.opportunityType)) {
      throw new ScoringInputError(
        "UNKNOWN_OPPORTUNITY_TYPE",
        `candidate ${candidate.opportunityId} carries unsupported opportunity type "${candidate.opportunityType}".`
      );
    }
    if (!STRENGTH_ORDINAL_SET.has(candidate.evidenceStrength)) {
      throw new ScoringInputError(
        "UNKNOWN_EVIDENCE_STRENGTH",
        `candidate ${candidate.opportunityId} carries unsupported evidence strength "${candidate.evidenceStrength}".`
      );
    }
    assertCount(candidate.contradictionCount, "contradictionCount");
    if (candidate.campaignId !== null) assertCount(candidate.campaignId, "campaignId");
  }
  for (const ev of raw.evidence) {
    if (!EVIDENCE_KIND_SET.has(ev.kind)) {
      throw new ScoringInputError(
        "UNKNOWN_EVIDENCE_KIND",
        `evidence ${ev.interpretationId} carries unsupported kind "${ev.kind}".`
      );
    }
    if (!OPPORTUNITY_TYPE_SET.has(ev.opportunityTypeAtEvaluation)) {
      throw new ScoringInputError(
        "UNKNOWN_OPPORTUNITY_TYPE",
        `evidence ${ev.interpretationId} carries unsupported opportunity type "${ev.opportunityTypeAtEvaluation}".`
      );
    }
    assertIsoTimestamp(ev.occurredAt, "occurredAt");
  }
  if (raw.lead.leadCampaignId !== null) assertCount(raw.lead.leadCampaignId, "leadCampaignId");

  const contributing = raw.evidence.filter((e) => e.contributesToStrength);
  const hasAnyEvidence = raw.evidence.length > 0;

  // FIT: primary candidate = the one with the highest type relevance present.
  let fitRelevance = 0;
  let fitAlignment = 0.5;
  let chosenType: OpportunityType = "unknown";
  if (raw.candidates.length > 0) {
    let best: CandidateFeatureInput | null = null;
    for (const candidate of raw.candidates) {
      if (
        !best ||
        fitTypeRelevance(candidate.opportunityType as OpportunityType) >
          fitTypeRelevance(best.opportunityType as OpportunityType)
      ) {
        best = candidate;
      }
    }
    const primary = best!;
    chosenType = primary.opportunityType as OpportunityType;
    fitRelevance = fitTypeRelevance(chosenType);
    fitAlignment = campaignAlignment(primary.campaignId, raw.lead.leadCampaignId);
  }
  assertFiniteNumber(fitRelevance, "fitTypeRelevance", 0, 1);
  assertFiniteNumber(fitAlignment, "fitCampaignAlignment", 0, 1);

  // INTENT: explicit evidence counts over the R5 §6 explicit type set.
  let explicitHighCount = 0;
  let explicitMediumCount = 0;
  for (const ev of contributing) {
    if (!EXPLICIT_INTENT_TYPE_SET.has(ev.opportunityTypeAtEvaluation as OpportunityType)) continue;
    if (ev.overallConfidence === "high" && ev.relevance === "relevant") explicitHighCount += 1;
    else if (
      ev.overallConfidence === "medium" &&
      (ev.relevance === "relevant" || ev.relevance === "partially_relevant")
    ) {
      explicitMediumCount += 1;
    }
  }

  // ENGAGEMENT: validated R5-C receipts + thread continuation.
  const validatedReceiptCount = contributing.filter((e) => e.kind === ("engagement_receipt" as EvidenceKind)).length;
  const distinctInterpretationCount = new Set(contributing.map((e) => e.interpretationId)).size;

  // RECENCY: newest contributing evidence time (age computed by the engine
  // against the explicit scoring clock — this module has no clock).
  let latestObservedAtMs: number | null = null;
  if (contributing.length > 0) {
    latestObservedAtMs = Math.max(...contributing.map((e) => Date.parse(e.occurredAt)));
  }

  // OPPORTUNITY: strongest evidence strength across candidates + contradictions.
  let evidenceStrengthOrdinal: ScoringFeatureVector["evidenceStrengthOrdinal"] = "UNKNOWN";
  const rank: Record<string, number> = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
  let contradictionCount = 0;
  for (const candidate of raw.candidates) {
    const ordinal = candidate.evidenceStrength as ScoringFeatureVector["evidenceStrengthOrdinal"];
    if (rank[ordinal] > rank[evidenceStrengthOrdinal]) evidenceStrengthOrdinal = ordinal;
    contradictionCount += candidate.contradictionCount;
  }

  const vector: ScoringFeatureVector = {
    hasAnyEvidence,
    fitTypeRelevance: fitRelevance,
    fitCampaignAlignment: fitAlignment,
    intentTypeBase: intentTypeBase(chosenType),
    explicitHighCount,
    explicitMediumCount,
    validatedReceiptCount,
    distinctInterpretationCount,
    contributingEvidenceCount: contributing.length,
    evidenceStrengthOrdinal,
    contradictionCount,
    primaryOpportunityType: chosenType,
    latestObservedAtMs,
    provenance: {
      fitTypeRelevance: { source: "opportunity_candidate", derivation: "opportunityType relevance table (contract §4b)", billable: false },
      fitCampaignAlignment: { source: "derived", derivation: "candidate.campaignId vs authoritative lead.campaignId (contract §4b)", billable: false },
      intentTypeBase: { source: "opportunity_candidate", derivation: "opportunityType intent base table (contract §4a)", billable: false },
      explicitHighCount: { source: "opportunity_evidence", derivation: "R5 §6 explicit set, confidence=high, relevance=relevant", billable: false },
      explicitMediumCount: { source: "opportunity_evidence", derivation: "R5 §6 explicit set, confidence=medium, relevance relevant/partial", billable: false },
      validatedReceiptCount: { source: "opportunity_evidence", derivation: "kind=engagement_receipt, contributesToStrength", billable: false },
      distinctInterpretationCount: { source: "opportunity_evidence", derivation: "distinct contributing interpretationIds", billable: false },
      evidenceStrengthOrdinal: { source: "opportunity_candidate", derivation: "max evidenceStrength ordinal across candidates", billable: false },
      contradictionCount: { source: "opportunity_candidate", derivation: "sum of R5 contradictionCount", billable: false },
      latestObservedAtMs: { source: "opportunity_evidence", derivation: "max contributing occurredAt (age vs explicit clock in engine)", billable: false },
    },
  };
  return vector;
}
