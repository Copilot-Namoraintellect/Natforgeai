// ─── R7-C Business Learning Engine — deterministic candidate derivation ───
//
// PURE module (no I/O, no clock). Derives learning candidates from validated
// R7-A outcome + R7-B attribution pairs, rule-first and fully deterministic:
// subjects come from credited touchpoints in a stable order, direction from
// outcome families, classification from the closed derivation map, and the
// statement is rendered from a bounded closed template — no model text, no
// client text, no causal verb. "Is associated with" is the strongest claim.

import {
  LEARNING_ATTRIBUTION_CONFIDENCE_RANKS,
  LEARNING_TERMINAL_OUTCOME_STATUS_SET,
  LearningOwnershipError,
  LearningStateError,
  LEARNING_STATEMENT_TEMPLATE_VERSION,
  assertSafeSubjectId,
  type LearningDirection,
  type LearningSubjectType,
  type LearningType,
} from "./business-learning-contract";
import type {
  ConsumedAttributionProjection,
  ConsumedOutcomeProjection,
  ConsumedAttributionTouchpoint,
  BusinessLearningUpstreamPorts,
} from "./business-learning-upstream-seam";
import {
  deriveContextScope,
  type LearningContextScope,
} from "./business-learning-context";

// ─── R7-A outcome families (frozen vocabulary, mirrored read-only) ───

const R7A_REVERSAL_TYPES = new Set(["REFUND", "REVERSAL", "CANCELLATION"]);

/** One validated outcome-attribution pair. */
export interface OutcomeAttributionPair {
  readonly outcome: ConsumedOutcomeProjection;
  readonly attribution: ConsumedAttributionProjection;
}

/** A pair reduced to the references the record persists. */
export interface PairRef {
  readonly outcomeId: string;
  readonly attributionId: string;
}

export interface LearningStatement {
  readonly text: string;
  readonly templateVersion: typeof LEARNING_STATEMENT_TEMPLATE_VERSION;
  readonly variables: Readonly<Record<string, string | number>>;
}

/** One fully derived learning candidate (pre-novelty). */
export interface DerivedLearningCandidate {
  readonly learningType: LearningType;
  readonly subjectType: LearningSubjectType;
  readonly subjectId: string;
  readonly direction: LearningDirection;
  readonly outcomeTypeFamily: string;
  readonly contextScope: LearningContextScope;
  readonly statement: LearningStatement;
  readonly supportPairs: readonly PairRef[];
  readonly contradictionPairs: readonly PairRef[];
  readonly creditableSupportPairs: readonly OutcomeAttributionPair[];
  readonly supportCount: number;
  readonly contradictionCount: number;
  readonly limitations: readonly string[];
  readonly modelVersions: readonly string[];
  readonly pairs: readonly OutcomeAttributionPair[];
}

/** Validated evidence bundle material passed to derivation. */
export interface ValidatedLearningEvidence {
  readonly userId: number;
  readonly businessId: number;
  readonly outcomes: readonly ConsumedOutcomeProjection[];
  readonly attributions: readonly ConsumedAttributionProjection[];
  readonly pairs: readonly OutcomeAttributionPair[];
  readonly sourceVersions: Readonly<Record<string, string>>;
}

// ─── Intake validation (fail closed) ───

/**
 * Loads and validates every referenced authority through the frozen seams.
 * Unknown ids, cross-business evidence, bundle-external attribution outcome
 * references, superseded attributions and dangling reversals all fail
 * closed. The seams enforce tenant scope by construction.
 */
export async function validateEvidenceInput(input: {
  userId: number;
  outcomeIds: readonly string[];
  attributionIds: readonly string[];
  ports: BusinessLearningUpstreamPorts;
}): Promise<ValidatedLearningEvidence> {
  const outcomes: ConsumedOutcomeProjection[] = [];
  for (const outcomeId of input.outcomeIds) {
    const outcome = await input.ports.outcomes.getOutcomeForLearning(input.userId, outcomeId);
    if (!outcome) {
      throw new LearningOwnershipError(
        "LEARNING_UNKNOWN_OUTCOME",
        `Outcome ${outcomeId} does not exist for this tenant; learning cannot be fabricated from unknown evidence.`
      );
    }
    outcomes.push(outcome);
  }

  const attributions: ConsumedAttributionProjection[] = [];
  for (const attributionId of input.attributionIds) {
    const attribution = await input.ports.attributions.getAttributionForLearning(
      input.userId,
      attributionId
    );
    if (!attribution) {
      throw new LearningOwnershipError(
        "LEARNING_UNKNOWN_ATTRIBUTION",
        `Attribution ${attributionId} does not exist for this tenant; learning cannot be fabricated from unknown evidence.`
      );
    }
    attributions.push(attribution);
  }

  const businessIds = new Set<number>([
    ...outcomes.map((o) => o.businessId),
    ...attributions.map((a) => a.businessId),
  ]);
  if (businessIds.size !== 1) {
    throw new LearningOwnershipError(
      "LEARNING_CROSS_BUSINESS_EVIDENCE",
      "Evidence spans multiple business scopes; cross-business learning is forbidden."
    );
  }
  const businessId = [...businessIds][0];

  const bundleOutcomeIds = new Set(outcomes.map((o) => o.outcomeId));
  for (const attribution of attributions) {
    if (!bundleOutcomeIds.has(attribution.outcomeId)) {
      throw new LearningStateError(
        "LEARNING_ATTRIBUTION_OUTCOME_MISMATCH",
        `Attribution ${attribution.attributionId} binds outcome ${attribution.outcomeId}, which is not part of this evidence bundle.`
      );
    }
    const superseding = await input.ports.attributions.findSupersedingAttribution(
      input.userId,
      attribution.attributionId
    );
    if (superseding) {
      throw new LearningStateError(
        "LEARNING_STALE_ATTRIBUTION",
        `Attribution ${attribution.attributionId} was superseded by ${superseding}; stale attributions never back learning.`
      );
    }
  }

  for (const outcome of outcomes) {
    if (R7A_REVERSAL_TYPES.has(outcome.outcomeType) && outcome.reversesOutcomeId !== null) {
      // The reversal target must be a real upstream outcome for this tenant —
      // the bundle itself binds the reversal row; the target is verified
      // authority, not silently assumed.
      const target = await input.ports.outcomes.getOutcomeForLearning(
        input.userId,
        outcome.reversesOutcomeId
      );
      if (!target) {
        throw new LearningStateError(
          "LEARNING_DANGLING_REVERSAL",
          `Reversal outcome ${outcome.outcomeId} references ${outcome.reversesOutcomeId}, which does not exist upstream for this tenant.`
        );
      }
    }
  }

  const outcomeById = new Map(outcomes.map((o) => [o.outcomeId, o]));
  const pairs: OutcomeAttributionPair[] = attributions.map((attribution) => ({
    outcome: outcomeById.get(attribution.outcomeId)!,
    attribution,
  }));

  const sourceVersions: Record<string, string> = {
    "conversion-outcome/v1": "conversion-outcome/v1",
    "attribution-to-learning/v1": "attribution-to-learning/v1",
    "attribution/v1": "attribution/v1",
    "conversion-outcome-to-attribution-learning/v1":
      "conversion-outcome-to-attribution-learning/v1",
    "business-learning/v1": "business-learning/v1",
  };

  return Object.freeze({
    userId: input.userId,
    businessId,
    outcomes: Object.freeze(outcomes),
    attributions: Object.freeze(attributions),
    pairs: Object.freeze(pairs),
    sourceVersions: Object.freeze(sourceVersions),
  });
}

// ─── Deterministic derivation ───

/** Pair direction from the outcome family (contract §2). */
export function pairDirection(outcome: ConsumedOutcomeProjection): LearningDirection {
  if (R7A_REVERSAL_TYPES.has(outcome.outcomeType)) return "negative";
  if (LEARNING_TERMINAL_OUTCOME_STATUS_SET.has(outcome.outcomeStatus)) {
    return outcome.outcomeType === "NON_MONETARY_SUCCESS" ||
      outcome.outcomeType === "OTHER_VERIFIED_OUTCOME"
      ? "neutral"
      : "negative";
  }
  return "positive";
}

function creditedTouchpoints(
  attribution: ConsumedAttributionProjection
): ConsumedAttributionTouchpoint[] {
  return attribution.touchpoints
    .filter((t) => t.eligibility === "eligible" && t.creditBps > 0)
    .slice()
    .sort((a, b) => {
      if (a.creditBps !== b.creditBps) return b.creditBps - a.creditBps;
      if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
      if (a.type !== b.type) return a.type < b.type ? -1 : 1;
      return a.sourceIdentity < b.sourceIdentity ? -1 : a.sourceIdentity > b.sourceIdentity ? 1 : 0;
    });
}

/**
 * Subject linkage touchpoint: the primary credited touchpoint when credit
 * was allocated; otherwise the first deterministically-ordered excluded
 * candidate, so reversal/zero-credit evidence still attaches to the journey
 * subject it concerns (contradiction visibility). Excluded candidates never
 * carry credit — they name the subject only.
 */
function subjectTouchpoint(
  attribution: ConsumedAttributionProjection
): ConsumedAttributionTouchpoint | null {
  const credited = creditedTouchpoints(attribution);
  if (credited.length > 0) return credited[0];
  const excluded = attribution.excludedTouchpoints
    .filter((t) => t.eligibility === "excluded")
    .slice()
    .sort((a, b) => {
      if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
      if (a.type !== b.type) return a.type < b.type ? -1 : 1;
      return a.sourceIdentity < b.sourceIdentity ? -1 : a.sourceIdentity > b.sourceIdentity ? 1 : 0;
    });
  return excluded[0] ?? null;
}

const TOUCHPOINT_SUBJECT_MAP: Record<string, LearningSubjectType> = {
  CAMPAIGN: "CAMPAIGN",
  PUBLICATION: "PUBLICATION",
  ENGAGEMENT: "ENGAGEMENT",
  OPPORTUNITY: "OPPORTUNITY",
  NURTURE_TOUCH: "NURTURE_TOUCH",
  SALES_HANDOFF: "SALES_HANDOFF",
};

function learningTypeForSubject(subjectType: LearningSubjectType): LearningType {
  switch (subjectType) {
    case "CAMPAIGN":
      return "PERFORMANCE_PATTERN";
    case "PUBLICATION":
      return "CHANNEL_PATTERN";
    case "ENGAGEMENT":
    case "OPPORTUNITY":
    case "NURTURE_TOUCH":
    case "SALES_HANDOFF":
      return "JOURNEY_PATTERN";
    default:
      return "INSUFFICIENT_EVIDENCE";
  }
}

function pairRef(pair: OutcomeAttributionPair): PairRef {
  return { outcomeId: pair.outcome.outcomeId, attributionId: pair.attribution.attributionId };
}

/** Renders the bounded closed-template statement (exported for the service,
 *  which re-renders after confidence classification binds the class label). */
export function renderLearningStatement(input: {
  subjectType: LearningSubjectType;
  subjectId: string;
  outcomeTypeFamily: string;
  businessId: number;
  supportCount: number;
  contradictionCount: number;
  confidenceClass: string;
}): LearningStatement {
  const variables = {
    subjectId: input.subjectId,
    subjectType: input.subjectType,
    outcomeTypeFamily: input.outcomeTypeFamily,
    businessId: input.businessId,
    supportCount: input.supportCount,
    contradictionCount: input.contradictionCount,
    confidenceClass: input.confidenceClass,
  } as const;
  const text =
    `Subject ${input.subjectId} (${input.subjectType}) is associated with outcome family ` +
    `${input.outcomeTypeFamily} in business scope ${input.businessId}; support ` +
    `${input.supportCount} outcome-attribution pair(s), contradiction(s) ` +
    `${input.contradictionCount}; attribution confidence ${input.confidenceClass}; ` +
    `this is association evidence, not causation.`;
  return Object.freeze({
    text,
    templateVersion: LEARNING_STATEMENT_TEMPLATE_VERSION,
    variables: Object.freeze({ ...variables }),
  });
}

function baseLimitations(input: {
  provisional: boolean;
  modelVersions: readonly string[];
}): string[] {
  const limitations = [
    "association_not_causation",
    "bounded_context",
    "attribution_model_assumption",
  ];
  if (input.modelVersions.length > 0) {
    limitations.push(`attribution_models:${input.modelVersions.join("|")}`);
  }
  if (input.provisional) limitations.push("provisional_cap");
  limitations.push("no_single_outcome_generalisation");
  return limitations;
}

export interface DeriveCandidatesResult {
  readonly candidates: readonly DerivedLearningCandidate[];
}

/**
 * Derives learning candidates from validated evidence. One candidate per
 * distinct (subject, direction-bearing group) over credited touchpoint
 * subjects; deterministic ordering throughout; no model in the path.
 */
export function deriveCandidates(
  evidence: ValidatedLearningEvidence,
  creditedCampaignIds: readonly number[]
): DeriveCandidatesResult {
  interface Group {
    subjectType: LearningSubjectType;
    subjectId: string;
    pairs: OutcomeAttributionPair[];
    primary: ConsumedAttributionTouchpoint | null;
  }

  const groups = new Map<string, Group>();
  for (const pair of evidence.pairs) {
    const primary = subjectTouchpoint(pair.attribution);
    const subjectType: LearningSubjectType = primary
      ? (TOUCHPOINT_SUBJECT_MAP[primary.type] ?? "OUTCOME")
      : "OUTCOME";
    const subjectId = primary ? primary.sourceIdentity : pair.outcome.outcomeId;
    assertSafeSubjectId(subjectId);
    const key = `${subjectType}|${subjectId}`;
    const group = groups.get(key) ?? { subjectType, subjectId, pairs: [], primary };
    group.pairs.push(pair);
    groups.set(key, group);
  }

  const candidates: DerivedLearningCandidate[] = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const directions = group.pairs.map((p) => pairDirection(p.outcome));
    const positivePairs = group.pairs.filter((_, i) => directions[i] === "positive");
    const negativePairs = group.pairs.filter((_, i) => directions[i] === "negative");

    const direction: LearningDirection =
      positivePairs.length > 0
        ? "positive"
        : negativePairs.length > 0
          ? "negative"
          : "neutral";

    const outcomeTypes = [...new Set(group.pairs.map((p) => p.outcome.outcomeType))].sort();
    const outcomeTypeFamily = outcomeTypes.length === 1 ? outcomeTypes[0] : "MIXED";

    const groupAttributions = [
      ...new Map(group.pairs.map((p) => [p.attribution.attributionId, p.attribution])).values(),
    ];

    const contextScope = deriveContextScope({
      businessId: evidence.businessId,
      attributions: groupAttributions,
      outcomeTypes,
      creditedCampaignIds,
    });

    const modelVersions = [
      ...new Set(
        groupAttributions.map((a) => `${a.modelType}@${a.modelVersion}`)
      ),
    ].sort();

    const supportPairs =
      direction === "positive" ? positivePairs : direction === "negative" ? negativePairs : [];
    const contradictionPairs =
      direction === "positive" ? negativePairs : direction === "negative" ? positivePairs : [];

    // Support requires allocated credit and a non-terminal, non-reversal
    // outcome; reversal/terminal evidence never counts as positive support.
    const creditableSupport = supportPairs.filter(
      (p) =>
        p.attribution.totalCreditBps > 0 &&
        !R7A_REVERSAL_TYPES.has(p.outcome.outcomeType) &&
        !LEARNING_TERMINAL_OUTCOME_STATUS_SET.has(p.outcome.outcomeStatus)
    );
    const supportCount = creditableSupport.length;
    const contradictionCount = new Set(contradictionPairs.map(pairRef)).size;

    let learningType: LearningType;
    if (direction === "negative") {
      learningType = "NEGATIVE_PATTERN";
    } else if (direction === "neutral" || group.primary === null) {
      const distinctFamilies = new Set(
        group.pairs.map((p) => `${p.outcome.valueType}:${p.outcome.outcomeType}`)
      );
      learningType =
        direction === "neutral" && distinctFamilies.size >= 2 ? "VALUE_PATTERN" : "INSUFFICIENT_EVIDENCE";
    } else {
      learningType = learningTypeForSubject(group.subjectType);
    }

    const provisional = group.pairs.some((p) =>
      p.outcome.outcomeStatus === "PROVISIONAL" || p.outcome.outcomeStatus === "OBSERVED"
    );

    // Confidence classification happens in the confidence module; the
    // statement is rendered after counts are fixed (template v1 includes the
    // class label, so the service re-renders with the classified value).
    const provisionalStatement = renderLearningStatement({
      subjectType: group.subjectType,
      subjectId: group.subjectId,
      outcomeTypeFamily,
      businessId: evidence.businessId,
      supportCount,
      contradictionCount,
      confidenceClass: "INSUFFICIENT_EVIDENCE",
    });

    candidates.push(
      Object.freeze({
        learningType,
        subjectType: group.subjectType,
        subjectId: group.subjectId,
        direction,
        outcomeTypeFamily,
        contextScope,
        statement: provisionalStatement,
        supportPairs: Object.freeze(supportPairs.map(pairRef)),
        contradictionPairs: Object.freeze(contradictionPairs.map(pairRef)),
        creditableSupportPairs: Object.freeze(creditableSupport),
        supportCount,
        contradictionCount,
        limitations: Object.freeze(baseLimitations({ provisional, modelVersions })),
        modelVersions: Object.freeze(modelVersions),
        pairs: Object.freeze(group.pairs),
      })
    );
    void key;
  }

  return { candidates: Object.freeze(candidates) };
}

/** Attribution confidence floor (min rank across contributing attributions). */
export function attributionConfidenceFloor(
  pairs: readonly OutcomeAttributionPair[]
): number {
  let floor = 3;
  for (const pair of pairs) {
    const rank = LEARNING_ATTRIBUTION_CONFIDENCE_RANKS[pair.attribution.confidenceClass] ?? 0;
    if (rank < floor) floor = rank;
  }
  return pairs.length === 0 ? 0 : floor;
}
