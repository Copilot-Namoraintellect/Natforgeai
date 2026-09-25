/**
 * Strategy-bound KPI evaluation authority (WBS15.2).
 *
 *   approved Strategy success metrics  +  factual performance dataset
 *     -> deterministic actual-vs-target assessment
 *
 * This authority does NOT replace the Phase 1 KPI engine
 * (contracts/kpi-assessment.ts). Phase 1 evaluates a fixed KPI set against
 * engine bands; this module evaluates exactly and only the success metrics
 * the approved immutable Strategy declares, against the exact target the
 * Strategy defined, falling back to engine bands / explicit Phase 1
 * assumptions only under the precedence rules below — and never silently
 * overriding a Strategy target.
 *
 * Target precedence (per metric):
 *   1. strategy_target   — explicit numeric target in the approved Strategy.
 *   2. engine_band       — deterministic engine bands, ONLY where the
 *                          Strategy defined no measurable target AND a band
 *                          is semantically appropriate for the metric.
 *                          Today that is exactly one case: the engagement
 *                          rate band for a Strategy metric named
 *                          "engagement" (Phase 1 rates engagement per
 *                          impression; rate bands never compare raw volumes).
 *   3. budget_assumption — the explicit Phase 1 assumption (budget /
 *                          CPA_ASSUMPTION_USD) for a Strategy metric named
 *                          "conversions" or "leads" when the campaign has a
 *                          positive budget. Labelled as an assumption.
 *   4. otherwise         — not_measurable. No proxy is manufactured.
 *
 * Convergence seams (no ownership taken of other streams' modules):
 *   - Strategy side: the caller adapts the persisted WBS11 snapshot row into
 *     StrategyKpiAuthority (see ./strategy-kpi-contracts.ts
 *     extractStrategySuccessMetrics for the payload mapping).
 *   - Performance side: input facts are Stream 1's normalised
 *     PerformanceObservation rows (contracts/observation.ts); only the pure
 *     helpers sumMetric / observationIdsFor are reused.
 *   - Learning side: this module is a pure read-only authority. Wiring it
 *     into learning-service.ts is a downstream integration decision; this
 *     module neither reads nor writes learning_records.
 *
 * Guarantees: pure function (no DB, no providers, no clock, no mutation of
 * inputs), deterministic for identical inputs, fail-closed on anything the
 * Strategy did not define.
 */

import {
  CPA_ASSUMPTION_USD,
  ENGAGEMENT_RATE_BANDS,
  MIN_IMPRESSIONS_FOR_CTR,
} from "../contracts/learning-config";
import {
  observationIdsFor,
  sumMetric,
  type MetricType,
  type PerformanceObservation,
} from "../contracts/observation";
import type {
  StrategyKpiAuthority,
  StrategySuccessMetricRef,
} from "./strategy-kpi-contracts";

export const STRATEGY_KPI_STATUSES = [
  "met",
  "partial",
  "missed",
  "insufficient_data",
  "not_measurable",
] as const;

export type StrategyKpiStatus = (typeof STRATEGY_KPI_STATUSES)[number];

export type StrategyTargetBasis =
  | "strategy_target"
  | "engine_band"
  | "budget_assumption";

export type StrategyComparisonOperator = "gte" | "lte";

export interface StrategyKpiTargetProvenance {
  basis: StrategyTargetBasis | null;
  /** 1 = explicit Strategy target, 2 = engine band, 3 = budget assumption. */
  precedenceRank: number | null;
  /** Where the target came from (Strategy path or engine constant). */
  source: string;
}

export interface StrategyKpiActualProvenance {
  source: "performance_observations";
  windowStart: string;
  windowEnd: string;
  /** Observations that contributed to the actual value. */
  observationCount: number;
  evidenceRefs: string[];
}

export interface StrategyKpiMetricResult {
  /** The Strategy metric reference under assessment. */
  metricRefId: string;
  metric: MetricType | null;
  rawLabel: string;
  stages: string[];
  status: StrategyKpiStatus;
  unit: "count" | "rate" | null;
  operator: StrategyComparisonOperator | null;
  target: number | null;
  actual: number | null;
  targetProvenance: StrategyKpiTargetProvenance;
  actualProvenance: StrategyKpiActualProvenance;
  evidenceRefs: string[];
  explanation: string;
}

export interface StrategyKpiEvaluation {
  strategy: {
    snapshotId: string;
    strategyRunId: number;
    version: number;
    strategyHashSha256: string;
    creativeBriefFingerprint: string;
    campaignId: number;
    capturedAt: string;
  };
  window: { start: string; end: string };
  results: StrategyKpiMetricResult[];
  overallStatus: StrategyKpiStatus;
  /** Deterministic human-readable aggregate of the individual results. */
  summary: string;
}

export interface StrategyKpiPerformanceInput {
  strategyAuthority: StrategyKpiAuthority;
  performanceFacts: PerformanceObservation[];
  window: { start: string; end: string };
  /** Campaign budget in USD; only used for the labelled budget assumption. */
  campaignBudget: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Relative tolerance defining "partial" for explicit numeric targets. */
const TARGET_PARTIAL_TOLERANCE = 0.5;

/**
 * Engine-band fallback table. Deliberately narrow: a rate band is only
 * semantically appropriate for a metric the engine canonically rates as a
 * rate. Volumes (clicks, conversions, leads, revenue, followers, reach,
 * impressions) never compare against rate bands — units must match.
 */
const ENGAGEMENT_RATE_DEFINITION = {
  numerator: "engagement" as MetricType,
  denominator: "impressions" as MetricType,
  bands: ENGAGEMENT_RATE_BANDS,
  minDenominator: MIN_IMPRESSIONS_FOR_CTR,
};

const BUDGET_ASSUMPTION_METRICS: ReadonlySet<MetricType> = new Set([
  "conversions",
  "leads",
]);

const OVERALL_SEVERITY: Record<StrategyKpiStatus, number> = {
  missed: 4,
  partial: 3,
  insufficient_data: 2,
  not_measurable: 1,
  met: 0,
};

function assertValidWindow(start: string, end: string): void {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error("window start/end must be YYYY-MM-DD");
  }
  if (end < start) {
    throw new Error("window end must not be earlier than window start");
  }
}

function assertValidAuthority(authority: StrategyKpiAuthority): void {
  if (!authority || typeof authority !== "object") {
    throw new Error("strategyAuthority is required");
  }
  if (
    typeof authority.snapshotId !== "string" ||
    authority.snapshotId.trim() === ""
  ) {
    throw new Error("strategyAuthority.snapshotId must be a non-blank string");
  }
  if (!Number.isInteger(authority.version) || authority.version <= 0) {
    throw new Error("strategyAuthority.version must be a positive integer");
  }
  if (
    typeof authority.strategyHashSha256 !== "string" ||
    authority.strategyHashSha256.trim() === ""
  ) {
    throw new Error(
      "strategyAuthority.strategyHashSha256 must be a non-blank string"
    );
  }
  if (!Number.isInteger(authority.campaignId) || authority.campaignId <= 0) {
    throw new Error("strategyAuthority.campaignId must be a positive integer");
  }
  if (!Array.isArray(authority.successMetrics)) {
    throw new Error("strategyAuthority.successMetrics must be an array");
  }
}

function rateStatus(
  rate: number,
  bands: { met: number; partial: number }
): StrategyKpiStatus {
  if (rate >= bands.met) return "met";
  if (rate >= bands.partial) return "partial";
  return "missed";
}

function compareToTarget(input: {
  actual: number;
  target: number;
  operator: StrategyComparisonOperator;
}): StrategyKpiStatus {
  const { actual, target, operator } = input;
  if (operator === "lte") {
    if (actual <= target) return "met";
    return actual <= target * (1 + TARGET_PARTIAL_TOLERANCE)
      ? "partial"
      : "missed";
  }
  if (actual >= target) return "met";
  return actual >= target * (1 - TARGET_PARTIAL_TOLERANCE)
    ? "partial"
    : "missed";
}

function buildActualProvenance(input: {
  observations: PerformanceObservation[];
  metricTypes: MetricType[];
  windowStart: string;
  windowEnd: string;
}): StrategyKpiActualProvenance {
  const evidenceRefs = observationIdsFor(input.observations, input.metricTypes);
  return {
    source: "performance_observations",
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    observationCount: evidenceRefs.length,
    evidenceRefs,
  };
}

function notMeasurableResult(input: {
  ref: StrategySuccessMetricRef;
  windowStart: string;
  windowEnd: string;
  explanation: string;
}): StrategyKpiMetricResult {
  const provenance = buildActualProvenance({
    observations: [],
    metricTypes: [],
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
  });
  return {
    metricRefId: input.ref.id,
    metric: input.ref.metric,
    rawLabel: input.ref.rawLabel,
    stages: input.ref.stages,
    status: "not_measurable",
    unit: null,
    operator: null,
    target: null,
    actual: null,
    targetProvenance: { basis: null, precedenceRank: null, source: "none" },
    actualProvenance: provenance,
    evidenceRefs: provenance.evidenceRefs,
    explanation: input.explanation,
  };
}

/**
 * Evaluates one Strategy success metric reference against the factual
 * performance dataset, applying the target precedence rules. Never mutates
 * its inputs.
 */
function evaluateMetric(input: {
  ref: StrategySuccessMetricRef;
  observations: PerformanceObservation[];
  windowStart: string;
  windowEnd: string;
  campaignBudget: number | null;
}): StrategyKpiMetricResult {
  const { ref, observations, windowStart, windowEnd, campaignBudget } = input;

  // Fail-closed: an unmappable Strategy label is preserved, never proxied.
  if (ref.metric === null) {
    return notMeasurableResult({
      ref,
      windowStart,
      windowEnd,
      explanation: `Strategy names "${ref.rawLabel}" as a success metric, but it does not map to any measurable performance fact. It is preserved verbatim and no proxy verdict is fabricated.`,
    });
  }

  const metric = ref.metric;

  // Precedence 1 — explicit approved Strategy target.
  if (ref.target !== null) {
    if (!Number.isFinite(ref.target) || ref.target < 0) {
      return notMeasurableResult({
        ref,
        windowStart,
        windowEnd,
        explanation: `Strategy target for "${ref.rawLabel}" (${ref.target}) is not a valid non-negative number; refusing to evaluate.`,
      });
    }
    if (ref.unit === null) {
      return notMeasurableResult({
        ref,
        windowStart,
        windowEnd,
        explanation: `Strategy target for "${ref.rawLabel}" carries no unit ("count" or "rate"); refusing to guess how to compare it.`,
      });
    }

    let actual: number | null = null;
    let metricTypes: MetricType[] = [metric];
    let unit: "count" | "rate" = ref.unit;

    if (ref.unit === "count") {
      actual = sumMetric(observations, metric);
    } else {
      if (metric !== ENGAGEMENT_RATE_DEFINITION.numerator) {
        return notMeasurableResult({
          ref,
          windowStart,
          windowEnd,
          explanation: `Strategy target for "${ref.rawLabel}" is a rate, but no deterministic rate definition exists for metric "${metric}".`,
        });
      }
      const denominator = sumMetric(
        observations,
        ENGAGEMENT_RATE_DEFINITION.denominator
      );
      if (denominator <= 0) {
        const provenance = buildActualProvenance({
          observations,
          metricTypes: [
            ENGAGEMENT_RATE_DEFINITION.numerator,
            ENGAGEMENT_RATE_DEFINITION.denominator,
          ],
          windowStart,
          windowEnd,
        });
        return {
          metricRefId: ref.id,
          metric,
          rawLabel: ref.rawLabel,
          stages: ref.stages,
          status: "insufficient_data",
          unit: "rate",
          operator: ref.operator ?? "gte",
          target: ref.target,
          actual: null,
          targetProvenance: {
            basis: "strategy_target",
            precedenceRank: 1,
            source: ref.sourcePath,
          },
          actualProvenance: provenance,
          evidenceRefs: provenance.evidenceRefs,
          explanation: `Strategy target is ${ref.target} (rate), but no ${ENGAGEMENT_RATE_DEFINITION.denominator} observations exist in the window to ground a rate reading.`,
        };
      }
      const rate =
        sumMetric(observations, ENGAGEMENT_RATE_DEFINITION.numerator) /
        denominator;
      actual = Number(rate.toFixed(6));
      metricTypes = [
        ENGAGEMENT_RATE_DEFINITION.numerator,
        ENGAGEMENT_RATE_DEFINITION.denominator,
      ];
      unit = "rate";
    }

    const operator: StrategyComparisonOperator = ref.operator ?? "gte";
    const provenance = buildActualProvenance({
      observations,
      metricTypes,
      windowStart,
      windowEnd,
    });

    // A count verdict requires at least one measured observation of the
    // metric; absence of rows is unknown, not zero.
    if (provenance.observationCount === 0 || actual === null) {
      return {
        metricRefId: ref.id,
        metric,
        rawLabel: ref.rawLabel,
        stages: ref.stages,
        status: "insufficient_data",
        unit,
        operator,
        target: ref.target,
        actual: null,
        targetProvenance: {
          basis: "strategy_target",
          precedenceRank: 1,
          source: ref.sourcePath,
        },
        actualProvenance: provenance,
        evidenceRefs: provenance.evidenceRefs,
        explanation: `Strategy target is ${ref.target} (${unit}), but no ${metric} observations exist in the window to ground an actual value.`,
      };
    }

    const status = compareToTarget({ actual, target: ref.target, operator });

    return {
      metricRefId: ref.id,
      metric,
      rawLabel: ref.rawLabel,
      stages: ref.stages,
      status,
      unit,
      operator,
      target: ref.target,
      actual,
      targetProvenance: {
        basis: "strategy_target",
        precedenceRank: 1,
        source: ref.sourcePath,
      },
      actualProvenance: provenance,
      evidenceRefs: provenance.evidenceRefs,
      explanation: `Strategy-defined target for "${ref.rawLabel}": ${operator === "gte" ? ">=" : "<="} ${ref.target} (${unit}). Observed ${actual} (${unit}) across the factual window.`,
    };
  }

  // Precedence 2 — engine band, only where semantically appropriate.
  if (metric === ENGAGEMENT_RATE_DEFINITION.numerator) {
    const impressions = sumMetric(
      observations,
      ENGAGEMENT_RATE_DEFINITION.denominator
    );
    const provenance = buildActualProvenance({
      observations,
      metricTypes: [
        ENGAGEMENT_RATE_DEFINITION.numerator,
        ENGAGEMENT_RATE_DEFINITION.denominator,
      ],
      windowStart,
      windowEnd,
    });

    if (impressions <= 0) {
      return {
        metricRefId: ref.id,
        metric,
        rawLabel: ref.rawLabel,
        stages: ref.stages,
        status: "insufficient_data",
        unit: "rate",
        operator: "gte",
        target: ENGAGEMENT_RATE_DEFINITION.bands.met,
        actual: null,
        targetProvenance: {
          basis: "engine_band",
          precedenceRank: 2,
          source: "learning-config:ENGAGEMENT_RATE_BANDS",
        },
        actualProvenance: provenance,
        evidenceRefs: provenance.evidenceRefs,
        explanation: `Strategy names "${ref.rawLabel}" without a numeric target; the deterministic engagement-rate band applies, but no impressions exist in the window.`,
      };
    }

    if (impressions < ENGAGEMENT_RATE_DEFINITION.minDenominator) {
      return {
        metricRefId: ref.id,
        metric,
        rawLabel: ref.rawLabel,
        stages: ref.stages,
        status: "insufficient_data",
        unit: "rate",
        operator: "gte",
        target: ENGAGEMENT_RATE_DEFINITION.bands.met,
        actual: null,
        targetProvenance: {
          basis: "engine_band",
          precedenceRank: 2,
          source: "learning-config:ENGAGEMENT_RATE_BANDS",
        },
        actualProvenance: provenance,
        evidenceRefs: provenance.evidenceRefs,
        explanation: `Only ${impressions} impressions observed; minimum ${ENGAGEMENT_RATE_DEFINITION.minDenominator} required before the engagement-rate band reading is treated as evidence.`,
      };
    }

    const rate =
      sumMetric(observations, ENGAGEMENT_RATE_DEFINITION.numerator) /
      impressions;
    const actual = Number(rate.toFixed(6));
    return {
      metricRefId: ref.id,
      metric,
      rawLabel: ref.rawLabel,
      stages: ref.stages,
      status: rateStatus(actual, ENGAGEMENT_RATE_DEFINITION.bands),
      unit: "rate",
      operator: "gte",
      target: ENGAGEMENT_RATE_DEFINITION.bands.met,
      actual,
      targetProvenance: {
        basis: "engine_band",
        precedenceRank: 2,
        source: "learning-config:ENGAGEMENT_RATE_BANDS",
      },
      actualProvenance: provenance,
      evidenceRefs: provenance.evidenceRefs,
      explanation: `Strategy names "${ref.rawLabel}" without a numeric target; assessed against the deterministic engagement-rate band (${(ENGAGEMENT_RATE_DEFINITION.bands.met * 100).toFixed(2)}% met / ${(ENGAGEMENT_RATE_DEFINITION.bands.partial * 100).toFixed(2)}% partial). Observed ${(actual * 100).toFixed(2)}%.`,
    };
  }

  // Precedence 3 — explicit Phase 1 budget assumption.
  if (
    BUDGET_ASSUMPTION_METRICS.has(metric) &&
    typeof campaignBudget === "number" &&
    Number.isFinite(campaignBudget) &&
    campaignBudget > 0
  ) {
    const actual = sumMetric(observations, metric);
    const target = Number((campaignBudget / CPA_ASSUMPTION_USD).toFixed(2));
    const ratio = target > 0 ? actual / target : 0;
    const status: StrategyKpiStatus =
      ratio >= 1 ? "met" : ratio >= 0.5 ? "partial" : "missed";
    const provenance = buildActualProvenance({
      observations,
      metricTypes: [metric],
      windowStart,
      windowEnd,
    });

    // Absence of rows is unknown, not zero.
    if (provenance.observationCount === 0) {
      return {
        metricRefId: ref.id,
        metric,
        rawLabel: ref.rawLabel,
        stages: ref.stages,
        status: "insufficient_data",
        unit: "count",
        operator: "gte",
        target,
        actual: null,
        targetProvenance: {
          basis: "budget_assumption",
          precedenceRank: 3,
          source: "learning-config:CPA_ASSUMPTION_USD",
        },
        actualProvenance: provenance,
        evidenceRefs: provenance.evidenceRefs,
        explanation: `Assumption-derived target is ${target}, but no ${metric} observations exist in the window to ground an actual value.`,
      };
    }

    return {
      metricRefId: ref.id,
      metric,
      rawLabel: ref.rawLabel,
      stages: ref.stages,
      status,
      unit: "count",
      operator: "gte",
      target,
      actual,
      targetProvenance: {
        basis: "budget_assumption",
        precedenceRank: 3,
        source: "learning-config:CPA_ASSUMPTION_USD",
      },
      actualProvenance: provenance,
      evidenceRefs: provenance.evidenceRefs,
      explanation: `Strategy names "${ref.rawLabel}" without a numeric target; assessed against the explicit engine assumption budget / CPA (${campaignBudget} / ${CPA_ASSUMPTION_USD} = ${target}). Observed ${actual}. The target is an explicit assumption, not a measured fact.`,
    };
  }

  // Precedence 4 — nothing measurable to compare against.
  return notMeasurableResult({
    ref,
    windowStart,
    windowEnd,
    explanation: `Strategy names "${ref.rawLabel}" (${metric}) but defines no numeric target, and no semantically appropriate engine fallback exists for this metric. No verdict is fabricated.`,
  });
}

function assessOverall(results: StrategyKpiMetricResult[]): StrategyKpiStatus {
  if (results.length === 0) return "not_measurable";
  let worst: StrategyKpiStatus = "met";
  for (const result of results) {
    if (OVERALL_SEVERITY[result.status] > OVERALL_SEVERITY[worst]) {
      worst = result.status;
    }
  }
  return worst;
}

function buildSummary(input: {
  results: StrategyKpiMetricResult[];
  overallStatus: StrategyKpiStatus;
  windowStart: string;
  windowEnd: string;
}): string {
  const counts: Record<StrategyKpiStatus, number> = {
    met: 0,
    partial: 0,
    missed: 0,
    insufficient_data: 0,
    not_measurable: 0,
  };
  for (const result of input.results) {
    counts[result.status] += 1;
  }
  return (
    `${input.results.length} Strategy success metric(s) assessed over ` +
    `${input.windowStart}..${input.windowEnd}: ` +
    `met=${counts.met}, partial=${counts.partial}, missed=${counts.missed}, ` +
    `insufficient_data=${counts.insufficient_data}, ` +
    `not_measurable=${counts.not_measurable}. ` +
    `Overall: ${input.overallStatus}.`
  );
}

/**
 * Deterministically assesses actual performance against the approved
 * Strategy's success metrics for one explicit factual window.
 *
 * Pure: no database access, no provider calls, no clock, no mutation of
 * Strategy, Learning records, recommendations or any DB state. Identical
 * inputs always produce identical outputs.
 */
export function evaluateStrategyKpiPerformance(
  input: StrategyKpiPerformanceInput
): StrategyKpiEvaluation {
  const { strategyAuthority, performanceFacts, window, campaignBudget } = input;

  assertValidAuthority(strategyAuthority);
  assertValidWindow(window.start, window.end);

  if (!Array.isArray(performanceFacts)) {
    throw new Error("performanceFacts must be an array");
  }

  const results = strategyAuthority.successMetrics.map(ref =>
    evaluateMetric({
      ref,
      observations: performanceFacts,
      windowStart: window.start,
      windowEnd: window.end,
      campaignBudget,
    })
  );

  const overallStatus = assessOverall(results);

  return {
    strategy: {
      snapshotId: strategyAuthority.snapshotId,
      strategyRunId: strategyAuthority.strategyRunId,
      version: strategyAuthority.version,
      strategyHashSha256: strategyAuthority.strategyHashSha256,
      creativeBriefFingerprint: strategyAuthority.creativeBriefFingerprint,
      campaignId: strategyAuthority.campaignId,
      capturedAt: strategyAuthority.capturedAt,
    },
    window: { start: window.start, end: window.end },
    results,
    overallStatus,
    summary: buildSummary({
      results,
      overallStatus,
      windowStart: window.start,
      windowEnd: window.end,
    }),
  };
}
