/**
 * Governed Learning cycle pipeline (WBS15.7) — pure assembly.
 *
 * Adapts the canonical CampaignPerformanceDataset (Stream 1) into the inputs
 * of the existing governed authorities and derives the learning-v2 record
 * content from their results:
 *
 *   dataset → StrategyKpiAuthority        (Stream 2 evaluator input)
 *   dataset → VariantAnalysisInput        (Stream 3 analyzer input, platform
 *                                          dimension only — the only
 *                                          dimension with durable observation
 *                                          attribution)
 *   (StrategyKpiEvaluation, VariantAnalysis, observations)
 *         → LearningDerivation            (governed recommendations)
 *
 * Evidence discipline (unchanged from Phase 1 and Streams 1–3):
 * - Facts only. Statements are past-tense and factual; causality is never
 *   asserted.
 * - Variant dimensions without durable observation attribution are skipped
 *   explicitly; the analyzer itself still fails closed (non_comparable) when
 *   platform evidence is thin, and NO comparative finding is fabricated.
 * - No numeric Strategy threshold is invented: the KPI authority carries
 *   `target: null` refs, so the Stream 2 precedence rules (Strategy target >
 *   engine band > budget assumption > not_measurable) engage unchanged.
 *
 * Pure module: no database access, no provider calls, no clock, no mutation.
 */

import {
  PSEUDO_PLATFORM,
  toISODate,
  type MetricTotals,
  type MetricType,
  type PerformanceObservation,
} from "./contracts/observation";
import { CONFIDENCE_IMPRESSIONS } from "./contracts/learning-config";
import type {
  EvidenceItem,
  LearningDerivation,
  Pattern,
  PerformanceFact,
  RecommendedAdjustment,
} from "./contracts/learning-derivation";
import type { CampaignPerformanceDataset } from "./performance/dataset";
import {
  buildStrategySuccessMetricRefsFromLabels,
  type StrategyKpiAuthority,
} from "./kpi/strategy-kpi-contracts";
import type { StrategyKpiEvaluation, StrategyKpiMetricResult } from "./kpi/strategy-kpi-assessment";
import type {
  VariantAnalysis,
  VariantAnalysisInput,
  VariantPerformanceRecord,
  VariantPublicationFact,
} from "./analysis/variant-analysis-contract";

// ─── Stream 2 input adapter ───

/**
 * Adapts the dataset's Strategy authority section into the Stream 2 KPI
 * evaluator input. Returns null when the dataset carries no Strategy snapshot
 * (the caller fails closed; no evaluation is fabricated).
 */
export function buildStrategyKpiAuthorityFromDataset(
  dataset: CampaignPerformanceDataset
): StrategyKpiAuthority | null {
  const snapshot = dataset.strategyAuthority.snapshot;
  if (!snapshot) return null;
  return {
    snapshotId: snapshot.snapshotId,
    strategyRunId: snapshot.strategyRunId,
    version: snapshot.strategyVersion,
    strategyHashSha256: snapshot.strategyHashSha256,
    creativeBriefFingerprint: snapshot.creativeBriefFingerprint,
    campaignId: dataset.identity.campaignId,
    capturedAt: snapshot.capturedAt,
    successMetrics: buildStrategySuccessMetricRefsFromLabels(
      dataset.strategyAuthority.successMetrics.metrics
    ),
  };
}

/** Deterministic cycle objective metric: first mappable Strategy metric. */
export function resolveCycleObjectiveMetric(
  authority: StrategyKpiAuthority
): MetricType | null {
  for (const ref of authority.successMetrics) {
    if (ref.metric !== null) return ref.metric;
  }
  return null;
}

// ─── Stream 3 input adapter ───

/**
 * Dimensions the cycle does NOT analyze: analytics observations carry no
 * durable attribution to message-copy, caption, creative or format artifacts,
 * so a comparison would fabricate attribution. Recorded explicitly in the
 * record lineage so the skip is a governed decision, not an oversight.
 */
export const SKIPPED_VARIANT_DIMENSIONS: readonly { dimension: string; reason: string }[] =
  Object.freeze([
    {
      dimension: "message_copy",
      reason:
        "analytics observations carry no durable attribution to approved copy artifacts; comparison would fabricate attribution",
    },
    {
      dimension: "caption",
      reason:
        "analytics observations carry no durable attribution to caption artifacts; comparison would fabricate attribution",
    },
    {
      dimension: "creative",
      reason:
        "analytics observations carry no durable attribution to visual asset artifacts; comparison would fabricate attribution",
    },
    {
      dimension: "format",
      reason:
        "analytics observations carry no durable attribution to content-post formats; comparison would fabricate attribution",
    },
  ]);

/**
 * Builds the platform-dimension variant-analysis input from the canonical
 * dataset. Observations are attributed by their durable `analytics.platform`
 * identity; publication facts carry the durable artifact refs and fail-closed
 * lineage classification from the dataset. Publications without any persisted
 * date are omitted rather than given a fabricated exposure date.
 */
export function buildPlatformVariantAnalysisInput(
  dataset: CampaignPerformanceDataset,
  objectiveMetric: MetricType | null
): VariantAnalysisInput {
  const observationsByPlatform = new Map<string, PerformanceObservation[]>();
  for (const observation of dataset.outcomes.observations) {
    if (observation.platform === PSEUDO_PLATFORM) continue;
    const list = observationsByPlatform.get(observation.platform) ?? [];
    list.push(observation);
    observationsByPlatform.set(observation.platform, list);
  }

  const publicationsByPlatform = new Map<string, VariantPublicationFact[]>();
  for (const publication of dataset.publications) {
    const platformRaw = publication.queue?.platform ?? publication.content.platform ?? null;
    const platform = typeof platformRaw === "string" ? platformRaw.trim().toLowerCase() : "";
    if (platform === "") continue;
    const dateRaw = publication.queue?.publishedAt ?? publication.queue?.scheduledAt ?? null;
    if (dateRaw === null) continue;
    const fact: VariantPublicationFact = {
      ref: publication.artifactId,
      platform,
      publishedAt: toISODate(dateRaw),
      lineageComplete: publication.lineage === "governed",
      publishPackageId: publication.package?.packageId ?? null,
    };
    const list = publicationsByPlatform.get(platform) ?? [];
    list.push(fact);
    publicationsByPlatform.set(platform, list);
  }

  const platformKeys = [...observationsByPlatform.keys()].sort();
  const records: VariantPerformanceRecord[] = platformKeys.map((platform) => ({
    identity: { kind: "platform", platform, label: platform },
    observations: [...(observationsByPlatform.get(platform) ?? [])],
    publications: [...(publicationsByPlatform.get(platform) ?? [])],
  }));

  return {
    campaignId: dataset.identity.campaignId,
    windowStart: dataset.identity.window.start,
    windowEnd: dataset.identity.window.end,
    dimension: "platform",
    objectiveMetric,
    records,
  };
}

// ─── learning-v2 derivation ───

const GOVERNANCE = { autoApply: false, requiresApproval: true } as const;

/**
 * Deterministic metric → advisory target-engine mapping for Strategy-bound
 * KPI misses. These are advisory targets only; nothing is auto-applied.
 */
const KPI_MISS_ENGINE_MAP: Record<
  MetricType,
  { targetEngine: RecommendedAdjustment["targetEngine"]; adjustmentType: string; summary: string }
> = {
  impressions: {
    targetEngine: "distribution",
    adjustmentType: "expand_reach",
    summary: "Expand distribution reach to lift recorded impressions toward the Strategy expectation.",
  },
  reach: {
    targetEngine: "distribution",
    adjustmentType: "expand_reach",
    summary: "Expand distribution reach to lift recorded reach toward the Strategy expectation.",
  },
  clicks: {
    targetEngine: "creative",
    adjustmentType: "improve_hook_ctr",
    summary: "Strengthen hooks and primary creative to lift click-through toward the Strategy expectation.",
  },
  engagement: {
    targetEngine: "creative",
    adjustmentType: "strengthen_content_engagement",
    summary: "Strengthen content engagement appeal toward the Strategy expectation.",
  },
  conversions: {
    targetEngine: "strategy",
    adjustmentType: "improve_offer_conversion_alignment",
    summary: "Re-examine offer, audience and post-click alignment to convert recorded clicks toward the Strategy expectation.",
  },
  leads: {
    targetEngine: "strategy",
    adjustmentType: "improve_lead_capture_alignment",
    summary: "Re-examine lead-capture alignment toward the Strategy expectation.",
  },
  revenue: {
    targetEngine: "strategy",
    adjustmentType: "improve_revenue_per_conversion",
    summary: "Re-examine offer value and pricing alignment toward the Strategy revenue expectation.",
  },
  followers: {
    targetEngine: "distribution",
    adjustmentType: "grow_audience",
    summary: "Broaden audience-building distribution toward the Strategy expectation.",
  },
};

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function basisLabel(result: StrategyKpiMetricResult): string {
  const basis = result.targetProvenance.basis;
  if (basis === "strategy_target") return "Strategy-defined target";
  if (basis === "engine_band") return "deterministic engine band";
  if (basis === "budget_assumption") return "explicit budget/CPA assumption";
  return "no comparable authority";
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

export interface LearningCycleDerivationInput {
  dataset: CampaignPerformanceDataset;
  strategyKpi: StrategyKpiEvaluation;
  variantAnalysis: VariantAnalysis;
}

function buildCycleFacts(
  totals: MetricTotals,
  observations: PerformanceObservation[],
  strategyKpi: StrategyKpiEvaluation
): PerformanceFact[] {
  const facts: PerformanceFact[] = [];
  const window = strategyKpi.window;

  facts.push({
    statement: `Campaign recorded ${totals.impressions} impressions, ${totals.clicks} clicks and ${totals.conversions} conversions between ${window.start} and ${window.end}.`,
    metricType: "impressions",
    value: totals.impressions,
    evidenceRefs: observations.map((o) => o.id),
  });

  if (totals.impressions > 0) {
    facts.push({
      statement: `Click-through rate was ${pct(totals.clicks / totals.impressions)} across the window.`,
      metricType: "clicks",
      value: round6(totals.clicks / totals.impressions),
      evidenceRefs: observations.map((o) => o.id),
    });
  }

  for (const result of strategyKpi.results) {
    if (result.actual === null || result.metric === null) continue;
    const rendered = result.unit === "rate" ? pct(result.actual) : String(result.actual);
    facts.push({
      statement: `Strategy metric "${result.rawLabel}" (${result.metric}) recorded ${rendered} against ${basisLabel(result).toLowerCase()}${result.target !== null ? ` target ${result.target}` : ""}; status ${result.status}.`,
      metricType: result.metric,
      value: result.actual,
      evidenceRefs: [...result.evidenceRefs],
    });
  }

  return facts;
}

function buildCyclePatterns(
  strategyKpi: StrategyKpiEvaluation,
  variantAnalysis: VariantAnalysis
): { positive: Pattern[]; negative: Pattern[] } {
  const positive: Pattern[] = [];
  const negative: Pattern[] = [];

  for (const result of strategyKpi.results) {
    if (result.metric === null) continue;
    if (result.status === "met") {
      positive.push({
        id: `pat_strategy_kpi_met:${result.metricRefId}`,
        direction: "positive",
        rule: "strategy_kpi_met",
        statement: result.explanation,
        evidenceRefs: [...result.evidenceRefs],
      });
    } else if (result.status === "missed" || result.status === "partial") {
      negative.push({
        id: `pat_strategy_kpi_${result.status}:${result.metricRefId}`,
        direction: "negative",
        rule: `strategy_kpi_${result.status}`,
        statement: result.explanation,
        evidenceRefs: [...result.evidenceRefs],
      });
    }
  }

  if (variantAnalysis.comparability === "comparable") {
    for (const finding of variantAnalysis.findings) {
      if (finding.kind !== "comparative_rate") continue;
      positive.push({
        id: `pat_variant_comparative:${variantAnalysis.dimension}:${finding.id}`,
        direction: "positive",
        rule: "variant_recorded_comparative_rate",
        statement: finding.statement,
        evidenceRefs: [...finding.evidenceRefs],
      });
    }
  }

  return { positive, negative };
}

function buildCycleRecommendations(
  strategyKpi: StrategyKpiEvaluation,
  patterns: { positive: Pattern[]; negative: Pattern[] },
  variantAnalysis: VariantAnalysis
): RecommendedAdjustment[] {
  const recommendations: RecommendedAdjustment[] = [];
  const seen = new Set<string>();

  // Strategy-bound KPI misses first (missed before partial), in result order.
  const negativeBySeverity = [...patterns.negative]
    .filter((p) => p.rule === "strategy_kpi_missed" || p.rule === "strategy_kpi_partial")
    .sort((a, b) => (a.rule === b.rule ? 0 : a.rule === "strategy_kpi_missed" ? -1 : 1));
  for (const pattern of negativeBySeverity) {
    const result = strategyKpi.results.find(
      (r) => `pat_strategy_kpi_${r.status}:${r.metricRefId}` === pattern.id
    );
    if (!result || result.metric === null) continue;
    const mapping = KPI_MISS_ENGINE_MAP[result.metric];
    const key = `${mapping.adjustmentType}:${result.metric}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recommendations.push({
      id: `rec_strategy_kpi_${result.metric}_${result.status}`,
      targetEngine: mapping.targetEngine,
      adjustmentType: mapping.adjustmentType,
      summary: mapping.summary,
      rationale: result.explanation,
      evidenceRefs: [...result.evidenceRefs],
      governance: GOVERNANCE,
    });
  }

  // Comparable variant evidence: a single, evidence-bounded distribution
  // recommendation citing the analyzer's own comparative findings.
  if (variantAnalysis.comparability === "comparable") {
    const comparative = variantAnalysis.findings.filter((f) => f.kind === "comparative_rate");
    if (comparative.length > 0) {
      recommendations.push({
        id: `rec_variant_rebalance_${variantAnalysis.dimension}`,
        targetEngine: "distribution",
        adjustmentType: "rebalance_toward_recorded_variant",
        summary:
          `Recorded variant evidence in this window differs across ${variantAnalysis.dimension} variants; consider rebalancing distribution toward the better-recorded variant (non-causal, descriptive only).`,
        rationale: comparative.map((f) => f.statement).join(" "),
        evidenceRefs: [...new Set(comparative.flatMap((f) => f.evidenceRefs))].sort(),
        governance: GOVERNANCE,
      });
    }
  }

  if (recommendations.length === 0) {
    if (strategyKpi.overallStatus === "met") {
      const metEvidenceRefs = [
        ...new Set(
          strategyKpi.results.filter((r) => r.status === "met").flatMap((r) => r.evidenceRefs)
        ),
      ].sort();
      recommendations.push({
        id: "rec_maintain_and_monitor",
        targetEngine: "strategy",
        adjustmentType: "maintain_and_monitor",
        summary: "Strategy-bound KPIs are being met; maintain the current approach and keep monitoring.",
        rationale: `Overall Strategy KPI status "${strategyKpi.overallStatus}" with no actionable negative pattern in this window.`,
        evidenceRefs: metEvidenceRefs,
        governance: GOVERNANCE,
      });
    } else {
      recommendations.push({
        id: "rec_collect_more_evidence",
        targetEngine: "strategy",
        adjustmentType: "collect_more_evidence",
        summary: "Evidence is too thin for targeted adjustment; gather more performance data before changing approach.",
        rationale: `Overall Strategy KPI status "${strategyKpi.overallStatus}" with insufficient grounded evidence for pattern detection.`,
        evidenceRefs: [],
        governance: GOVERNANCE,
      });
    }
  }

  return recommendations;
}

function buildCycleEvidence(
  observations: PerformanceObservation[],
  strategyKpi: StrategyKpiEvaluation,
  variantAnalysis: VariantAnalysis
): EvidenceItem[] {
  const evidence: EvidenceItem[] = observations.map((o) => ({
    kind: "observation" as const,
    ref: o.id,
    note: `${o.metricType}=${o.value} on ${o.platform} at ${o.date} (analytics row ${o.provenance.analyticsId})`,
  }));

  for (const result of strategyKpi.results) {
    if (result.targetProvenance.basis === "budget_assumption") {
      evidence.push({
        kind: "assumption" as const,
        ref: `strategy-kpi:${result.metricRefId}`,
        note: result.explanation,
      });
    } else {
      evidence.push({
        kind: "rule" as const,
        ref: `strategy-kpi:${result.metricRefId}`,
        note: result.explanation,
      });
    }
  }

  for (const finding of variantAnalysis.findings) {
    evidence.push({ kind: "rule" as const, ref: finding.id, note: finding.statement });
  }

  return evidence;
}

function scoreCycleConfidence(
  strategyKpi: StrategyKpiEvaluation,
  variantAnalysis: VariantAnalysis,
  totals: MetricTotals
): "low" | "medium" | "high" {
  let score = 0;
  const groundedResults = strategyKpi.results.filter(
    (r) => r.actual !== null && r.actualProvenance.observationCount > 0
  );
  if (groundedResults.length > 0) score += 1;
  if (strategyKpi.overallStatus === "met" || strategyKpi.overallStatus === "partial") score += 1;
  if (variantAnalysis.comparability === "comparable") score += 1;
  if (totals.impressions >= CONFIDENCE_IMPRESSIONS) score += 1;
  if (score >= 3) return "high";
  if (score === 2) return "medium";
  return "low";
}

/**
 * Derives the learning-v2 record content from the governed authorities'
 * results. Deterministic: identical inputs always produce identical records.
 * All recommendations keep the governed pins (autoApply=false,
 * requiresApproval=true); nothing here mutates Strategy, Creative,
 * Distribution or BI state.
 */
export function deriveLearningCycle(input: LearningCycleDerivationInput): LearningDerivation {
  const { dataset, strategyKpi, variantAnalysis } = input;
  const observations = [...dataset.outcomes.observations];
  const totals = dataset.outcomes.totals;

  const performanceFacts = buildCycleFacts(totals, observations, strategyKpi);
  const patterns = buildCyclePatterns(strategyKpi, variantAnalysis);
  const confidence = scoreCycleConfidence(strategyKpi, variantAnalysis, totals);

  const objective = dataset.strategyAuthority.objective;
  const objectiveSummary = objective.text
    ? `Objective "${objective.text}" (source: ${objective.source}) assessed ${strategyKpi.overallStatus} over ${strategyKpi.window.start}..${strategyKpi.window.end} against the approved Strategy (${strategyKpi.strategy.snapshotId} v${strategyKpi.strategy.version}); platform variant comparability: ${variantAnalysis.comparability}.`
    : `Campaign objective text is unavailable; Strategy-bound KPIs were assessed ${strategyKpi.overallStatus} over ${strategyKpi.window.start}..${strategyKpi.window.end} against the approved Strategy (${strategyKpi.strategy.snapshotId} v${strategyKpi.strategy.version}); platform variant comparability: ${variantAnalysis.comparability}.`;

  return {
    objectiveSummary,
    performanceFacts,
    positivePatterns: patterns.positive,
    negativePatterns: patterns.negative,
    confidence,
    evidence: buildCycleEvidence(observations, strategyKpi, variantAnalysis),
    recommendedAdjustments: buildCycleRecommendations(strategyKpi, patterns, variantAnalysis),
  };
}
