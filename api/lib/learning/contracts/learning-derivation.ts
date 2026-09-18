/**
 * Derives an evidence-backed learning record from a KPI assessment and the
 * normalised observations behind it.
 *
 * Output contract (Phase 1):
 * - performance facts: deterministic, citable statements about what was observed;
 * - positive/negative patterns: rule-based detections, each citing observation ids;
 * - confidence: scored from evidence volume and breadth (see learning-config);
 * - recommended adjustments: governed advice only — autoApply is always false
 *   and requiresApproval is always true. Phase 1 never mutates Strategy,
 *   Creative or Distribution; those engines are named only as advisory targets.
 *
 * Pure module: no database access, no provider calls, no engine mutation.
 */

import {
  CVR_BANDS,
  CTR_BANDS,
  MOMENTUM_DOWN_RATIO,
  MOMENTUM_MIN_BASE_VOLUME,
  MOMENTUM_UP_RATIO,
  MIN_CLICKS_FOR_PLATFORM_EFFICIENCY,
  CONFIDENCE_IMPRESSIONS,
  CONFIDENCE_MIN_PLATFORMS,
  CONFIDENCE_MIN_WINDOW_DAYS,
  CONFIDENCE_OBJECTIVE_VOLUME,
  PLATFORM_DEPENDENCY_MIN_VOLUME,
  PLATFORM_DEPENDENCY_RATIO,
} from "./learning-config";
import type { KpiAssessment } from "./kpi-assessment";
import {
  observationIdsFor,
  sumMetric,
  PSEUDO_PLATFORM,
  type MetricType,
  type PerformanceObservation,
} from "./observation";

export type ConfidenceLevel = "low" | "medium" | "high";

export type AdjustmentTargetEngine = "strategy" | "creative" | "distribution";

export interface PerformanceFact {
  statement: string;
  metricType: MetricType;
  value: number;
  evidenceRefs: string[];
}

export interface Pattern {
  id: string;
  direction: "positive" | "negative";
  rule: string;
  statement: string;
  evidenceRefs: string[];
}

export interface EvidenceItem {
  kind: "observation" | "assumption" | "rule";
  ref: string;
  note: string;
}

export interface RecommendedAdjustment {
  id: string;
  targetEngine: AdjustmentTargetEngine;
  adjustmentType: string;
  summary: string;
  rationale: string;
  evidenceRefs: string[];
  governance: { autoApply: false; requiresApproval: true };
}

export interface LearningDerivation {
  objectiveSummary: string;
  performanceFacts: PerformanceFact[];
  positivePatterns: Pattern[];
  negativePatterns: Pattern[];
  confidence: ConfidenceLevel;
  evidence: EvidenceItem[];
  recommendedAdjustments: RecommendedAdjustment[];
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function windowDays(windowStart: string, windowEnd: string): number {
  const start = Date.parse(`${windowStart}T00:00:00Z`);
  const end = Date.parse(`${windowEnd}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

function splitWindow(
  observations: PerformanceObservation[],
  windowStart: string,
  windowEnd: string
): { firstHalf: PerformanceObservation[]; secondHalf: PerformanceObservation[]; midpoint: string } {
  const days = windowDays(windowStart, windowEnd);
  const midpointDate = new Date(Date.parse(`${windowStart}T00:00:00Z`) + Math.floor(days / 2) * 86_400_000);
  const midpoint = midpointDate.toISOString().slice(0, 10);
  return {
    firstHalf: observations.filter((o) => o.date <= midpoint),
    secondHalf: observations.filter((o) => o.date > midpoint),
    midpoint,
  };
}

function platformValues(
  observations: PerformanceObservation[],
  metricType: MetricType
): Map<string, number> {
  const map = new Map<string, number>();
  for (const obs of observations) {
    if (obs.metricType !== metricType) continue;
    map.set(obs.platform, (map.get(obs.platform) ?? 0) + obs.value);
  }
  return map;
}

function buildFacts(
  assessment: KpiAssessment,
  observations: PerformanceObservation[]
): PerformanceFact[] {
  const facts: PerformanceFact[] = [];
  const { totals } = assessment;

  facts.push({
    statement: `Campaign recorded ${totals.impressions} impressions, ${totals.clicks} clicks and ${totals.conversions} conversions between ${assessment.windowStart} and ${assessment.windowEnd}.`,
    metricType: "impressions",
    value: totals.impressions,
    evidenceRefs: observationIdsFor(observations, ["impressions", "clicks", "conversions"]),
  });

  if (totals.impressions > 0) {
    facts.push({
      statement: `Click-through rate was ${pct(totals.clicks / totals.impressions)} across the window.`,
      metricType: "clicks",
      value: round6(totals.clicks / totals.impressions),
      evidenceRefs: observationIdsFor(observations, ["impressions", "clicks"]),
    });
  }

  // Objective volume fact — only when the objective resolved. An unresolved
  // objective must not fabricate a "conversions" fact.
  if (assessment.objectiveMetric !== null) {
    const objectiveMetric = assessment.objectiveMetric;
    const objectiveVolume = sumMetric(observations, objectiveMetric);
    facts.push({
      statement: `Objective metric (${objectiveMetric}) totalled ${objectiveVolume} for the window.`,
      metricType: objectiveMetric,
      value: objectiveVolume,
      evidenceRefs: observationIdsFor(observations, [objectiveMetric]),
    });
  }

  if (totals.clicks > 0) {
    facts.push({
      statement: `Conversion rate on clicks was ${pct(totals.conversions / totals.clicks)}.`,
      metricType: "conversions",
      value: round6(totals.conversions / totals.clicks),
      evidenceRefs: observationIdsFor(observations, ["clicks", "conversions"]),
    });
  }

  return facts;
}

function buildPatterns(
  assessment: KpiAssessment,
  observations: PerformanceObservation[]
): { positive: Pattern[]; negative: Pattern[] } {
  const positive: Pattern[] = [];
  const negative: Pattern[] = [];
  const { totals } = assessment;

  // CTR weakness — evidence-bounded: the metric is below the configured band;
  // causes are investigation hypotheses, not observed facts.
  if (
    totals.impressions >= 200 &&
    totals.clicks / totals.impressions < CTR_BANDS.partial
  ) {
    negative.push({
      id: "pat_weak_ctr",
      direction: "negative",
      rule: "click_through_rate_below_partial_band",
      statement: `Click-through rate ${pct(totals.clicks / totals.impressions)} is below the configured partial band (${pct(CTR_BANDS.partial)}) on ${totals.impressions} impressions; hook and placement should be investigated as possible causes.`,
      evidenceRefs: observationIdsFor(observations, ["impressions", "clicks"]),
    });
  }

  // Clicks not converting — evidence-bounded, no causal claim.
  if (
    totals.clicks >= 50 &&
    totals.conversions / totals.clicks < CVR_BANDS.partial
  ) {
    negative.push({
      id: "pat_clicks_not_converting",
      direction: "negative",
      rule: "conversion_rate_below_partial_band",
      statement: `Conversion rate ${pct(totals.conversions / totals.clicks)} is below the configured partial band (${pct(CVR_BANDS.partial)}) on ${totals.clicks} clicks; offer, audience and post-click alignment should be investigated.`,
      evidenceRefs: observationIdsFor(observations, ["clicks", "conversions"]),
    });
  }

  // Platform conversion efficiency (per-platform CVR vs campaign average).
  // The pseudo-platform "all" (unscoped rows) is not a channel and can never
  // be credited as a high-performing platform.
  if (totals.clicks >= 50 && totals.conversions > 0) {
    const campaignCvr = totals.conversions / totals.clicks;
    const clicksByPlatform = platformValues(observations, "clicks");
    const conversionsByPlatform = platformValues(observations, "conversions");
    for (const [platform, clicks] of clicksByPlatform) {
      if (platform === PSEUDO_PLATFORM) continue;
      if (clicks < MIN_CLICKS_FOR_PLATFORM_EFFICIENCY) continue;
      const conversions = conversionsByPlatform.get(platform) ?? 0;
      const cvr = conversions / clicks;
      if (cvr > campaignCvr * 1.25) {
        positive.push({
          id: `pat_platform_efficiency:${platform}`,
          direction: "positive",
          rule: "platform_conversion_efficiency_above_average",
          statement: `Platform "${platform}" converts at ${pct(cvr)}, above the campaign average of ${pct(campaignCvr)}.`,
          evidenceRefs: observationIdsFor(observations, ["clicks", "conversions"], platform),
        });
      }
    }
  }

  // Momentum across window halves (objective metric) — suppressed when the
  // objective is unresolved.
  if (assessment.objectiveMetric !== null) {
    const objectiveMetric = assessment.objectiveMetric;
    const { firstHalf, secondHalf, midpoint } = splitWindow(
      observations,
      assessment.windowStart,
      assessment.windowEnd
    );
    const firstVolume = sumMetric(firstHalf, objectiveMetric);
    const secondVolume = sumMetric(secondHalf, objectiveMetric);
    if (firstVolume >= MOMENTUM_MIN_BASE_VOLUME) {
      if (secondVolume >= firstVolume * MOMENTUM_UP_RATIO) {
        positive.push({
          id: "pat_momentum_up",
          direction: "positive",
          rule: "objective_volume_up_second_half",
          statement: `${objectiveMetric} volume rose from ${firstVolume} (first half) to ${secondVolume} (second half) after ${midpoint}.`,
          evidenceRefs: observationIdsFor(observations, [objectiveMetric]),
        });
      } else if (secondVolume <= firstVolume * MOMENTUM_DOWN_RATIO) {
        negative.push({
          id: "pat_momentum_down",
          direction: "negative",
          rule: "objective_volume_down_second_half",
          statement: `${objectiveMetric} volume fell from ${firstVolume} (first half) to ${secondVolume} (second half) after ${midpoint}.`,
          evidenceRefs: observationIdsFor(observations, [objectiveMetric]),
        });
      }
    }

    // Single-platform concentration on the objective metric, over named
    // platforms only. Unscoped ("all") volume cannot create or dilute a
    // dependency finding.
    const objectiveByPlatform = platformValues(observations, objectiveMetric);
    const namedEntries = [...objectiveByPlatform.entries()].filter(
      ([platform]) => platform !== PSEUDO_PLATFORM
    );
    const namedTotal = namedEntries.reduce((acc, [, value]) => acc + value, 0);
    if (namedTotal >= PLATFORM_DEPENDENCY_MIN_VOLUME) {
      for (const [platform, value] of namedEntries) {
        if (value / namedTotal >= PLATFORM_DEPENDENCY_RATIO) {
          negative.push({
            id: `pat_platform_dependency:${platform}`,
            direction: "negative",
            rule: "single_platform_objective_dependency",
            statement: `Platform "${platform}" accounts for ${pct(value / namedTotal)} of named-platform ${objectiveMetric} volume in the window (single-platform concentration).`,
            evidenceRefs: observationIdsFor(observations, [objectiveMetric], platform),
          });
        }
      }
    }
  }

  return { positive, negative };
}

function scoreConfidence(
  assessment: KpiAssessment,
  observations: PerformanceObservation[]
): { level: ConfidenceLevel; score: number } {
  let score = 0;
  // The pseudo-platform "all" (unscoped rows) is not a channel and never
  // counts toward multi-platform confidence.
  const platformCount = new Set(
    observations.filter((o) => o.platform !== PSEUDO_PLATFORM).map((o) => o.platform)
  ).size;
  const objectiveVolume =
    assessment.objectiveMetric !== null
      ? sumMetric(observations, assessment.objectiveMetric)
      : 0;

  if (objectiveVolume >= CONFIDENCE_OBJECTIVE_VOLUME) score += 1;
  if (assessment.totals.impressions >= CONFIDENCE_IMPRESSIONS) score += 1;
  if (platformCount >= CONFIDENCE_MIN_PLATFORMS) score += 1;
  if (windowDays(assessment.windowStart, assessment.windowEnd) >= CONFIDENCE_MIN_WINDOW_DAYS)
    score += 1;

  const level: ConfidenceLevel = score >= 3 ? "high" : score === 2 ? "medium" : "low";
  return { level, score };
}

const GOVERNANCE = { autoApply: false, requiresApproval: true } as const;

function buildRecommendations(
  assessment: KpiAssessment,
  patterns: { positive: Pattern[]; negative: Pattern[] }
): RecommendedAdjustment[] {
  const recommendations: RecommendedAdjustment[] = [];
  const byRule = new Map<string, Pattern>();
  for (const p of [...patterns.negative, ...patterns.positive]) {
    byRule.set(p.rule, p);
  }

  const weakCtr = byRule.get("click_through_rate_below_partial_band");
  if (weakCtr) {
    recommendations.push({
      id: "rec_improve_hook_ctr",
      targetEngine: "creative",
      adjustmentType: "improve_hook_ctr",
      summary: "Strengthen hooks and primary creative to lift click-through.",
      rationale: weakCtr.statement,
      evidenceRefs: weakCtr.evidenceRefs,
      governance: GOVERNANCE,
    });
  }

  const notConverting = byRule.get("conversion_rate_below_partial_band");
  if (notConverting) {
    recommendations.push({
      id: "rec_align_offer_conversion",
      targetEngine: "strategy",
      adjustmentType: "improve_offer_conversion_alignment",
      summary: "Re-examine offer, audience and post-click alignment to convert existing clicks.",
      rationale: notConverting.statement,
      evidenceRefs: notConverting.evidenceRefs,
      governance: GOVERNANCE,
    });
  }

  const dependency = [...byRule.values()].find((p) =>
    p.rule.startsWith("single_platform_objective_dependency")
  );
  if (dependency) {
    recommendations.push({
      id: "rec_rebalance_platform_mix",
      targetEngine: "distribution",
      adjustmentType: "rebalance_platform_mix",
      summary: "Broaden distribution across additional platforms to reduce single-channel dependency.",
      rationale: dependency.statement,
      evidenceRefs: dependency.evidenceRefs,
      governance: GOVERNANCE,
    });
  }

  const momentumDown = byRule.get("objective_volume_down_second_half");
  if (momentumDown) {
    recommendations.push({
      id: "rec_review_declining_momentum",
      targetEngine: "strategy",
      adjustmentType: "review_declining_objective_momentum",
      summary: "Review strategy inputs: the objective metric is declining across the window.",
      rationale: momentumDown.statement,
      evidenceRefs: momentumDown.evidenceRefs,
      governance: GOVERNANCE,
    });
  }

  if (recommendations.length === 0) {
    if (assessment.overallStatus === "met") {
      // Evidence-backed default: cite the KPIs that were met rather than
      // returning an empty evidence set when evidence exists.
      const metEvidenceRefs = [
        ...new Set(
          assessment.kpis
            .filter((k) => k.status === "met")
            .flatMap((k) => k.evidenceRefs)
        ),
      ];
      recommendations.push({
        id: "rec_maintain_and_monitor",
        targetEngine: "strategy",
        adjustmentType: "maintain_and_monitor",
        summary: "KPIs are being met; maintain the current approach and keep monitoring.",
        rationale: `Overall status "${assessment.overallStatus}" with no negative patterns detected for the window.`,
        evidenceRefs: metEvidenceRefs,
        governance: GOVERNANCE,
      });
    } else {
      // collect_more_evidence intentionally carries no concrete refs: its
      // purpose is precisely that evidence is insufficient.
      recommendations.push({
        id: "rec_collect_more_evidence",
        targetEngine: "strategy",
        adjustmentType: "collect_more_evidence",
        summary: "Evidence is too thin for targeted adjustment; gather more performance data before changing approach.",
        rationale: `Overall status "${assessment.overallStatus}" with insufficient evidence volume for pattern detection.`,
        evidenceRefs: [],
        governance: GOVERNANCE,
      });
    }
  }

  return recommendations;
}

/**
 * Derives the full learning record content from an assessment and its
 * observations. Deterministic: identical inputs always produce identical
 * records.
 */
export function deriveLearning(input: {
  assessment: KpiAssessment;
  observations: PerformanceObservation[];
}): LearningDerivation {
  const { assessment, observations } = input;

  const performanceFacts = buildFacts(assessment, observations);
  const patterns = buildPatterns(assessment, observations);
  const confidence = scoreConfidence(assessment, observations);

  const evidence: EvidenceItem[] = [
    ...observations.map((o) => ({
      kind: "observation" as const,
      ref: o.id,
      note: `${o.metricType}=${o.value} on ${o.platform} at ${o.date} (analytics row ${o.provenance.analyticsId})`,
    })),
    ...assessment.kpis
      .filter((k) => k.targetBasis === "budget_assumption")
      .map((k) => ({
        kind: "assumption" as const,
        ref: k.kpi,
        note: k.detail,
      })),
    ...patterns.positive.map((p) => ({ kind: "rule" as const, ref: p.rule, note: p.statement })),
    ...patterns.negative.map((p) => ({ kind: "rule" as const, ref: p.rule, note: p.statement })),
  ];

  const objectiveSummary =
    assessment.objectiveMetric === null
      ? `Campaign objective could not be deterministically resolved from primaryOutcome/goal over ${assessment.windowStart}..${assessment.windowEnd}; objective-dependent findings are suppressed and only supported funnel metrics are reported.`
      : `Objective "${assessment.objectiveMetric}" (resolved from ${assessment.objectiveBasis}${assessment.objectiveMatchedTerm ? `, matched "${assessment.objectiveMatchedTerm}"` : ""}) assessed ${assessment.overallStatus} over ${assessment.windowStart}..${assessment.windowEnd}.`;

  return {
    objectiveSummary,
    performanceFacts,
    positivePatterns: patterns.positive,
    negativePatterns: patterns.negative,
    confidence: confidence.level,
    evidence,
    recommendedAdjustments: buildRecommendations(assessment, patterns),
  };
}
