// ─── R7-E Budget & Portfolio Optimisation — evidence / performance model (E3) ───
//
// PURE module: folds governed upstream evidence (R7-A outcomes, R7-B
// attribution, R7-C learning — consumed as frozen projection shapes) into
// deterministic INTEGER performance scores per allocation key. No LLM/model
// opinion assigns financial weight; every factor is a code-level constant in
// the frozen EVIDENCE_WEIGHTS set. Attribution credit is association
// evidence, never causal certainty. Weak/contradicted/stale evidence reduces
// or blocks optimisation strength; single-event influence is explicitly
// capped so no one short-term outcome can trigger runaway allocation.
//
// No I/O, no clock (caller supplies `now`), no side effects.

import {
  BudgetPortfolioValidationError,
  campaignIdFromAllocationKey,
  type OptimisationConfidenceClass,
  type OptimisationReasonCode,
} from "./budget-portfolio-contract";

// ─── Frozen weight table (server-side constants; no runtime mutation) ───

export const EVIDENCE_WEIGHTS = Object.freeze({
  /** Outcome verification status weight — verified always outweighs provisional. */
  outcomeStatus: Object.freeze({ VERIFIED: 4, PROVISIONAL: 2, OBSERVED: 1 }),
  /** Attribution confidence weight (R7-B class → influence). NONE contributes zero. */
  attributionConfidence: Object.freeze({ HIGH: 4, MEDIUM: 2, LOW: 1, NONE: 0 }),
  /** Attribution evidence class weight — weak evidence must not drive aggressive shifts. */
  attributionEvidenceClass: Object.freeze({
    DIRECT_LINKAGE: 4,
    STRONG_ASSOCIATION: 3,
    WEAK_ASSOCIATION: 1,
    INSUFFICIENT_EVIDENCE: 0,
  }),
  /** Learning confidence weight (R7-C class → boost). */
  learningConfidence: Object.freeze({ STRONG: 3, MODERATE: 2, WEAK: 1, INSUFFICIENT_EVIDENCE: 0 }),
  /** Learning-only mass scale (keeps learning comparable to outcome mass). */
  learningScale: 1000,
  /** Maximum learning support multiplier (1 + min(supportCount, cap)). */
  maxSupportBoost: 4,
  /** Recency buckets (age ≤ bucket → weight; older → stale/excluded). */
  recency: Object.freeze({ sevenDays: 3, thirtyDays: 2, ninetyDays: 1 }),
  /** Single-event influence cap: one outcome may contribute at most this bps of total mass. */
  singleEventCapBps: 4000,
  /** Confidence thresholds over usable mass (weighted minor units). */
  strongMassThreshold: 100_000,
  moderateMassThreshold: 25_000,
  /** Evidence older than this is stale and excluded (ms). */
  staleEvidenceMs: 90 * 24 * 60 * 60 * 1000,
});

const BPS_DENOMINATOR = 100_000; // R7-B credit semantics: total credit = 100000 bps (100.000%)
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Frozen upstream projection shapes (consumed read-only; contract §6) ───

export interface EvidenceOutcomeProjection {
  readonly outcomeId: string;
  readonly businessId: number;
  readonly outcomeStatus: string;
  readonly valueType: string;
  readonly amountMinor: number | null;
  readonly occurredAt: string;
}

export interface EvidenceAttributionProjection {
  readonly attributionId: string;
  readonly businessId: number;
  readonly outcomeId: string;
  readonly outcomeStatus: string;
  readonly confidenceClass: string;
  readonly evidenceClass: string;
  readonly touchpoints: readonly {
    readonly type: string;
    readonly sourceIdentity: string;
    readonly creditBps: number;
  }[];
}

export interface EvidenceLearningProjection {
  readonly learningId: string;
  readonly businessId: number;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly status: string;
  readonly confidenceClass: string;
  readonly supportCount: number;
  readonly contradictionCount: number;
  readonly freshness: { readonly stale: boolean; readonly contradictionUnresolved: boolean };
  readonly derivedAt: string;
}

/** The evidence bundle proposed by the client (ids) and resolved server-side. */
export interface EvidenceBundle {
  readonly outcomes: readonly EvidenceOutcomeProjection[];
  readonly attributions: readonly EvidenceAttributionProjection[];
  readonly learnings: readonly EvidenceLearningProjection[];
}

export interface AllocationEvidence {
  readonly allocationKey: string;
  readonly campaignId: number;
  /** Deterministic integer performance score (higher = stronger evidence). */
  readonly score: number;
  /** Capped, recency-weighted evidence mass behind the score (weighted minor units). */
  readonly evidenceMass: number;
  readonly outcomeCount: number;
  readonly learningCount: number;
  /** True when current learning for this subject is contradicted (blocks movement). */
  readonly learningContradicted: boolean;
}

export interface EvidenceEvaluation {
  readonly byKey: Readonly<Record<string, AllocationEvidence>>;
  readonly confidenceClass: OptimisationConfidenceClass;
  readonly reasonCodes: readonly OptimisationReasonCode[];
  /** Usable (capped) mass across all keys — zero means INSUFFICIENT. */
  readonly usableMass: number;
}

function parseIsoMs(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new BudgetPortfolioValidationError(
      "EVIDENCE_VALIDATION_FAILED",
      `${field} is not a parseable ISO timestamp: ${String(value)}`
    );
  }
  return ms;
}

function isTerminalOutcomeStatus(status: string): boolean {
  return status === "REVERSED" || status === "CANCELLED" || status === "SUPERSEDED";
}

function recencyWeight(occurredAtMs: number, nowMs: number): number {
  const ageMs = nowMs - occurredAtMs;
  if (ageMs < 0) return 0; // future-dated evidence is not usable
  if (ageMs <= 7 * DAY_MS) return EVIDENCE_WEIGHTS.recency.sevenDays;
  if (ageMs <= 30 * DAY_MS) return EVIDENCE_WEIGHTS.recency.thirtyDays;
  if (ageMs <= 90 * DAY_MS) return EVIDENCE_WEIGHTS.recency.ninetyDays;
  return 0; // stale
}

/**
 * Validate + score an evidence bundle against the snapshot scope. Every row
 * must verify for the same tenant business; cross-tenant/cross-business
 * evidence fails closed. Terminal outcomes and insufficient-evidence
 * attributions contribute nothing (and are not errors — they are history).
 */
export function evaluateEvidence(input: {
  businessId: number;
  bundle: EvidenceBundle;
  allocatableKeys: readonly string[];
  now: string;
}): EvidenceEvaluation {
  const { businessId, bundle, allocatableKeys, now } = input;
  const nowMs = parseIsoMs(now, "now");
  const keySet = new Set(allocatableKeys);
  const reasons: OptimisationReasonCode[] = [];

  for (const o of bundle.outcomes) {
    if (o.businessId !== businessId) {
      throw new BudgetPortfolioValidationError(
        "EVIDENCE_VALIDATION_FAILED",
        `outcome ${o.outcomeId} does not verify for business ${businessId} (cross-tenant evidence is never accepted)`
      );
    }
  }
  for (const a of bundle.attributions) {
    if (a.businessId !== businessId) {
      throw new BudgetPortfolioValidationError(
        "EVIDENCE_VALIDATION_FAILED",
        `attribution ${a.attributionId} does not verify for business ${businessId}`
      );
    }
  }
  for (const l of bundle.learnings) {
    if (l.businessId !== businessId) {
      throw new BudgetPortfolioValidationError(
        "EVIDENCE_VALIDATION_FAILED",
        `learning ${l.learningId} does not verify for business ${businessId}`
      );
    }
  }

  const outcomeById = new Map(bundle.outcomes.map((o) => [o.outcomeId, o]));
  const campaignSubject = (subjectType: string, subjectId: string): string | null => {
    if (subjectType !== "CAMPAIGN") return null;
    const id = Number(subjectId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const key = `camp:${id}`;
    return keySet.has(key) ? key : null;
  };

  // ── Pass 1: raw per-key contributions from outcome+attribution evidence ──
  const rawContributions = new Map<string, number[]>();
  let sawStale = false;
  let sawAnyEvidence = false;

  for (const attribution of bundle.attributions) {
    const outcome = outcomeById.get(attribution.outcomeId);
    // Attributions are evaluated against the outcome row they cite; a missing
    // or terminal outcome carries no usable mass.
    if (!outcome || isTerminalOutcomeStatus(attribution.outcomeStatus)) continue;
    const confidenceW =
      EVIDENCE_WEIGHTS.attributionConfidence[
        attribution.confidenceClass as keyof typeof EVIDENCE_WEIGHTS.attributionConfidence
      ] ?? 0;
    const evidenceW =
      EVIDENCE_WEIGHTS.attributionEvidenceClass[
        attribution.evidenceClass as keyof typeof EVIDENCE_WEIGHTS.attributionEvidenceClass
      ] ?? 0;
    if (confidenceW === 0 || evidenceW === 0) continue; // weak attribution reduces to zero

    for (const touchpoint of attribution.touchpoints) {
      if (touchpoint.type !== "CAMPAIGN") continue;
      const key = campaignSubject(touchpoint.type, touchpoint.sourceIdentity);
      if (key === null || touchpoint.creditBps <= 0) continue;
      sawAnyEvidence = true;
      if (isTerminalOutcomeStatus(outcome.outcomeStatus)) continue;
      const statusW: number =
        EVIDENCE_WEIGHTS.outcomeStatus[
          outcome.outcomeStatus as keyof typeof EVIDENCE_WEIGHTS.outcomeStatus
        ] ?? 0;
      if (statusW === 0) continue;
      const recencyW = recencyWeight(parseIsoMs(outcome.occurredAt, `outcome ${outcome.outcomeId} occurredAt`), nowMs);
      if (recencyW === 0) {
        sawStale = true;
        continue;
      }
      const amountMinor = outcome.valueType === "MONETARY" && outcome.amountMinor !== null
        ? Math.max(0, outcome.amountMinor)
        : 0;
      // Credit allocated to this campaign, in bps of the outcome value.
      const creditMinor = Math.floor((amountMinor * touchpoint.creditBps) / BPS_DENOMINATOR);
      const contribution = creditMinor * statusW * confidenceW * evidenceW * recencyW;
      const list = rawContributions.get(key) ?? [];
      list.push(contribution);
      rawContributions.set(key, list);
    }
  }

  // ── Pass 2: single-event cap — no one outcome drives runaway allocation ──
  let totalRaw = 0;
  for (const list of rawContributions.values()) for (const c of list) totalRaw += c;
  const perEventCap =
    totalRaw > 0 ? Math.max(1, Math.floor((totalRaw * EVIDENCE_WEIGHTS.singleEventCapBps) / BPS_DENOMINATOR)) : 0;

  const byKey: Record<string, AllocationEvidence> = {};
  let usableMass = 0;
  let sawVerified = false;
  let anyContradiction = false;

  for (const key of allocatableKeys) {
    const campaignId = campaignIdFromAllocationKey(key);
    const list = rawContributions.get(key) ?? [];
    let mass = 0;
    for (const c of list) mass += Math.min(c, perEventCap);
    if (mass > 0) {
      // Verified presence is tracked on the capped mass source rows: re-derive
      // cheaply — any contribution implies a non-terminal, non-stale outcome;
      // verified-ness is folded via statusW already. Track via outcome status.
      const outcomeVerified = bundle.outcomes.some(
        (o) =>
          !isTerminalOutcomeStatus(o.outcomeStatus) &&
          EVIDENCE_WEIGHTS.outcomeStatus[o.outcomeStatus as keyof typeof EVIDENCE_WEIGHTS.outcomeStatus] ===
            EVIDENCE_WEIGHTS.outcomeStatus.VERIFIED &&
          recencyWeight(parseIsoMs(o.occurredAt, `outcome ${o.outcomeId} occurredAt`), nowMs) > 0
      );
      if (outcomeVerified) sawVerified = true;
    }

    // ── Learning boost per subject ──
    let learningBoost = 0;
    let learningMass = 0;
    let learningCount = 0;
    let learningContradicted = false;
    for (const learning of bundle.learnings) {
      const subjectKey = campaignSubject(learning.subjectType, learning.subjectId);
      if (subjectKey !== key) continue;
      learningCount += 1;
      if (
        learning.freshness.contradictionUnresolved ||
        learning.contradictionCount > 0 ||
        learning.status === "CONTRADICTED"
      ) {
        learningContradicted = true;
        anyContradiction = true;
        continue; // contradicted learning blocks movement on the subject
      }
      if (learning.freshness.stale || learning.status !== "SUPPORTED" && learning.status !== "CANDIDATE") continue;
      const confidenceW =
        EVIDENCE_WEIGHTS.learningConfidence[
          learning.confidenceClass as keyof typeof EVIDENCE_WEIGHTS.learningConfidence
        ] ?? 0;
      if (confidenceW === 0) continue;
      const supportW = 1 + Math.min(Math.max(0, learning.supportCount), EVIDENCE_WEIGHTS.maxSupportBoost);
      learningBoost = Math.max(learningBoost, confidenceW);
      learningMass += confidenceW * supportW * EVIDENCE_WEIGHTS.learningScale;
    }

    const score = mass * (1 + learningBoost) + learningMass;
    usableMass += mass;
    byKey[key] = Object.freeze({
      allocationKey: key,
      campaignId: campaignId ?? 0,
      score,
      evidenceMass: mass,
      outcomeCount: list.length,
      learningCount,
      learningContradicted,
    });
  }

  // ── Global confidence class (deterministic) ──
  let confidenceClass: OptimisationConfidenceClass;
  if (!sawAnyEvidence || usableMass === 0) {
    confidenceClass = "INSUFFICIENT";
    reasons.push("EVIDENCE_INSUFFICIENT");
  } else if (usableMass >= EVIDENCE_WEIGHTS.strongMassThreshold && sawVerified && !anyContradiction) {
    confidenceClass = "STRONG";
  } else if (usableMass >= EVIDENCE_WEIGHTS.moderateMassThreshold) {
    confidenceClass = "MODERATE";
  } else {
    confidenceClass = "WEAK";
  }
  if (sawStale) reasons.push("EVIDENCE_STALE");
  if (anyContradiction) reasons.push("LEARNING_CONTRADICTED");

  return Object.freeze({
    byKey: Object.freeze(byKey),
    confidenceClass,
    reasonCodes: Object.freeze(reasons),
    usableMass,
  });
}
