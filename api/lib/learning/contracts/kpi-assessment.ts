/**
 * Objective/KPI evaluation for the Learning engine.
 *
 * Deterministically resolves the campaign objective from campaign facts and
 * evaluates a fixed KPI set against documented engine bands
 * (contracts/learning-config.ts). Every KPI result cites the observation ids
 * that evidence it; every target is labelled as either an engine band or an
 * explicit budget assumption — never an unlabelled guess.
 *
 * Pure module: no database access, no provider calls, no engine mutation.
 */

import {
  CTR_BANDS,
  CVR_BANDS,
  ENGAGEMENT_RATE_BANDS,
  CPA_ASSUMPTION_USD,
  MIN_IMPRESSIONS_FOR_CTR,
  MIN_CLICKS_FOR_CVR,
} from "./learning-config";
import {
  observationIdsFor,
  sumMetric,
  sumMetrics,
  type CampaignFacts,
  type MetricTotals,
  type MetricType,
  type PerformanceObservation,
} from "./observation";

export const OBJECTIVE_METRICS = [
  "conversions",
  "leads",
  "revenue",
  "engagement",
  "reach",
  "clicks",
  "followers",
] as const;

export type ObjectiveMetric = (typeof OBJECTIVE_METRICS)[number];

export type KpiStatus = "met" | "partial" | "missed" | "insufficient_data";

export type TargetBasis = "engine_band" | "budget_assumption" | null;

export interface KpiResult {
  kpi: string;
  label: string;
  status: KpiStatus;
  actual: number | null;
  target: number | null;
  targetBasis: TargetBasis;
  evidenceRefs: string[];
  detail: string;
}

export interface KpiAssessment {
  /** null when the objective could not be deterministically resolved. */
  objectiveMetric: ObjectiveMetric | null;
  objectiveBasis: "primaryOutcome" | "goal" | "unresolved";
  objectiveMatchedTerm: string | null;
  windowStart: string;
  windowEnd: string;
  totals: MetricTotals;
  kpis: KpiResult[];
  overallStatus: KpiStatus;
}

const OBJECTIVE_KEYWORDS: Array<[ObjectiveMetric, RegExp]> = [
  ["conversions", /\b(conversions?|sales?|signups?|sign[- ]?ups?|bookings?|purchases?|orders?|appointments?|enrols?|enrolments?|registrations?|checkouts?)\b/i],
  ["leads", /\b(leads?|captures?|inquir(?:y|ies)|enquir(?:y|ies)|demos?|quotes?|consultations?|applications?)\b/i],
  ["revenue", /\b(revenue|profits?|income|roas|roi|margins?|earnings?)\b/i],
  ["engagement", /\b(engagements?|interactions?|likes?|shares?|comments?|communities|participation)\b/i],
  ["reach", /\b(awareness|reach|visibility|brand|impressions?|exposure|recognition)\b/i],
  ["clicks", /\b(clicks?|traffic|visits?|ctr|landing page views?|lpv)\b/i],
  ["followers", /\b(followers?|subscribers?|subscribes?|audience growth|grow (?:our )?(?:audience|following))\b/i],
];

export type ObjectiveResolution =
  | {
      metric: ObjectiveMetric;
      basis: "primaryOutcome" | "goal";
      matchedTerm: string;
    }
  | { metric: null; basis: "unresolved"; matchedTerm: null };

/**
 * Resolves the single objective metric from primaryOutcome first, then goal,
 * using deterministic keyword matching. Fail-closed: when neither field maps
 * to a known objective the result is explicitly unresolved (metric null), so
 * downstream evaluation can suppress objective-dependent verdicts instead of
 * silently fabricating "conversions" as the campaign objective.
 */
export function resolveObjectiveMetric(campaign: {
  goal: string;
  primaryOutcome: string | null;
}): ObjectiveResolution {
  const candidates: Array<{
    text: string;
    basis: "primaryOutcome" | "goal";
  }> = [];

  if (typeof campaign.primaryOutcome === "string" && campaign.primaryOutcome.trim() !== "") {
    candidates.push({ text: campaign.primaryOutcome, basis: "primaryOutcome" });
  }
  if (typeof campaign.goal === "string" && campaign.goal.trim() !== "") {
    candidates.push({ text: campaign.goal, basis: "goal" });
  }

  for (const candidate of candidates) {
    for (const [metric, pattern] of OBJECTIVE_KEYWORDS) {
      const match = candidate.text.match(pattern);
      if (match) {
        return { metric, basis: candidate.basis, matchedTerm: match[0] };
      }
    }
  }

  return { metric: null, basis: "unresolved", matchedTerm: null };
}

function rateStatus(
  rate: number,
  bands: { met: number; partial: number }
): KpiStatus {
  if (rate >= bands.met) return "met";
  if (rate >= bands.partial) return "partial";
  return "missed";
}

const OVERALL_SEVERITY: Record<KpiStatus, number> = {
  missed: 3,
  partial: 2,
  insufficient_data: 1,
  met: 0,
};

function assessOverall(kpis: KpiResult[]): KpiStatus {
  const objectiveKpi = kpis.find((k) => k.kpi === "objective_volume");
  if (objectiveKpi && objectiveKpi.status !== "insufficient_data") {
    return objectiveKpi.status;
  }
  let worst: KpiStatus = "insufficient_data";
  for (const kpi of kpis) {
    if (OVERALL_SEVERITY[kpi.status] > OVERALL_SEVERITY[worst]) {
      worst = kpi.status;
    }
  }
  return worst;
}

/**
 * Evaluates the fixed KPI set for one campaign over one observation window:
 * click-through rate, conversion rate, objective volume (budget-relative when
 * a budget assumption applies) and, when engagement data exists, engagement
 * rate. Rate KPIs degrade to insufficient_data below minimum sample sizes
 * rather than reporting noise.
 */
export function evaluateKpiAssessment(input: {
  campaign: CampaignFacts;
  observations: PerformanceObservation[];
  windowStart: string;
  windowEnd: string;
}): KpiAssessment {
  const { campaign, observations, windowStart, windowEnd } = input;
  const totals = sumMetrics(observations);
  const objective = resolveObjectiveMetric(campaign);
  // Fail-closed: an unresolved objective never fabricates a volume verdict.
  const objectiveMetric: MetricType | null = objective.metric;
  const objectiveVolume = objectiveMetric
    ? sumMetric(observations, objectiveMetric)
    : 0;

  const kpis: KpiResult[] = [];

  // Click-through rate
  if (totals.impressions > 0) {
    const ctr = totals.clicks / totals.impressions;
    const insufficient = totals.impressions < MIN_IMPRESSIONS_FOR_CTR;
    kpis.push({
      kpi: "click_through_rate",
      label: "Click-through rate",
      status: insufficient
        ? "insufficient_data"
        : rateStatus(ctr, CTR_BANDS),
      actual: Number(ctr.toFixed(6)),
      target: CTR_BANDS.met,
      targetBasis: "engine_band",
      evidenceRefs: observationIdsFor(observations, ["impressions", "clicks"]),
      detail: insufficient
        ? `Only ${totals.impressions} impressions observed; minimum ${MIN_IMPRESSIONS_FOR_CTR} required for a rate reading.`
        : `${totals.clicks} clicks from ${totals.impressions} impressions (CTR ${(ctr * 100).toFixed(2)}%).`,
    });
  }

  // Conversion rate (clicks -> conversions)
  if (totals.clicks > 0) {
    const cvr = totals.conversions / totals.clicks;
    const insufficient = totals.clicks < MIN_CLICKS_FOR_CVR;
    kpis.push({
      kpi: "conversion_rate",
      label: "Conversion rate",
      status: insufficient
        ? "insufficient_data"
        : rateStatus(cvr, CVR_BANDS),
      actual: Number(cvr.toFixed(6)),
      target: CVR_BANDS.met,
      targetBasis: "engine_band",
      evidenceRefs: observationIdsFor(observations, ["clicks", "conversions"]),
      detail: insufficient
        ? `Only ${totals.clicks} clicks observed; minimum ${MIN_CLICKS_FOR_CVR} required for a rate reading.`
        : `${totals.conversions} conversions from ${totals.clicks} clicks (CvR ${(cvr * 100).toFixed(2)}%).`,
    });
  }

  // Objective volume vs deterministic budget-relative target (only when the
  // objective resolved; an unresolved objective suppresses this verdict).
  const budgetApplies =
    objectiveMetric !== null &&
    typeof campaign.budget === "number" &&
    campaign.budget !== null &&
    campaign.budget > 0 &&
    (objective.metric === "conversions" || objective.metric === "leads");

  if (objectiveMetric && budgetApplies) {
    const target = Number((campaign.budget! / CPA_ASSUMPTION_USD).toFixed(2));
    const ratio = target > 0 ? objectiveVolume / target : 0;
    const status: KpiStatus =
      ratio >= 1 ? "met" : ratio >= 0.5 ? "partial" : "missed";
    kpis.push({
      kpi: "objective_volume",
      label: `${objective.metric} volume vs budget-relative target`,
      status,
      actual: objectiveVolume,
      target,
      targetBasis: "budget_assumption",
      evidenceRefs: observationIdsFor(observations, [objectiveMetric]),
      detail: `${objectiveVolume} ${objective.metric} observed against a deterministic target of ${target} (budget ${campaign.budget} / assumed CPA ${CPA_ASSUMPTION_USD} USD). The target is an explicit engine assumption, not a measured fact.`,
    });
  } else if (objectiveMetric && objectiveVolume > 0) {
    kpis.push({
      kpi: "objective_volume",
      label: `${objective.metric} volume`,
      status: "insufficient_data",
      actual: objectiveVolume,
      target: null,
      targetBasis: null,
      evidenceRefs: observationIdsFor(observations, [objectiveMetric]),
      detail: `${objectiveVolume} ${objective.metric} observed; no deterministic target applies for this objective/budget combination, so volume is reported without a verdict.`,
    });
  }

  // Engagement rate (informational when engagement data exists)
  if (totals.engagement > 0 && totals.impressions > 0) {
    const rate = totals.engagement / totals.impressions;
    const insufficient = totals.impressions < MIN_IMPRESSIONS_FOR_CTR;
    kpis.push({
      kpi: "engagement_rate",
      label: "Engagement rate",
      status: insufficient
        ? "insufficient_data"
        : rateStatus(rate, ENGAGEMENT_RATE_BANDS),
      actual: Number(rate.toFixed(6)),
      target: ENGAGEMENT_RATE_BANDS.met,
      targetBasis: "engine_band",
      evidenceRefs: observationIdsFor(observations, ["engagement", "impressions"]),
      detail: insufficient
        ? `Only ${totals.impressions} impressions observed; minimum ${MIN_IMPRESSIONS_FOR_CTR} required for a rate reading.`
        : `${totals.engagement} engagements per ${totals.impressions} impressions (${(rate * 100).toFixed(2)}%).`,
    });
  }

  return {
    objectiveMetric: objective.metric,
    objectiveBasis: objective.basis,
    objectiveMatchedTerm: objective.matchedTerm,
    windowStart,
    windowEnd,
    totals,
    kpis,
    overallStatus: assessOverall(kpis),
  };
}
