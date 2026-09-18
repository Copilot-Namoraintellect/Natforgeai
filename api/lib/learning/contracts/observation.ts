/**
 * Normalises raw analytics rows into structured, factual performance
 * observations with provenance.
 *
 * Phase 1 grounding rule: a Learning observation is always a direct,
 * lossless transform of a persisted analytics row. No LLM inference, no
 * imputation, no external data. Each observation carries its source row id so
 * downstream learning records can cite concrete evidence.
 *
 * This module is pure: it never throws on malformed input, never touches the
 * database, and is deterministic (output is stably ordered).
 */

export const METRIC_TYPES = [
  "impressions",
  "clicks",
  "conversions",
  "leads",
  "revenue",
  "engagement",
  "followers",
  "reach",
] as const;

export type MetricType = (typeof METRIC_TYPES)[number];

const METRIC_TYPE_SET = new Set<string>(METRIC_TYPES);

/** A raw analytics row, structurally typed so pure tests need no database. */
export interface RawAnalyticsRow {
  id: number;
  metricType: string;
  platform: string | null;
  value: number | null;
  date: string | Date;
}

/** Stable campaign facts used as learning input, structurally typed. */
export interface CampaignFacts {
  id: number;
  goal: string;
  primaryOutcome: string | null;
  budget: number | null;
  platforms: string | null;
  startDate: string | Date | null;
  endDate: string | Date | null;
}

export interface ObservationProvenance {
  kind: "analytics";
  analyticsId: number;
  metricType: MetricType;
  platform: string | null;
  date: string;
}

export interface PerformanceObservation {
  /** Deterministic id: one analytics row produces exactly one observation. */
  id: string;
  metricType: MetricType;
  /** Normalised platform key; "all" when the source row has no platform. */
  platform: string;
  /** ISO calendar date (YYYY-MM-DD). */
  date: string;
  /** Non-negative finite value coerced from the source row. */
  value: number;
  provenance: ObservationProvenance;
}

/** Rows that could not be grounded to a known metric are skipped. */
export interface NormalisationIssue {
  analyticsId: number;
  reason: "unknown_metric_type" | "invalid_value";
  rawMetricType?: string;
}

export interface NormaliseResult {
  observations: PerformanceObservation[];
  issues: NormalisationIssue[];
}

export function toISODate(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

/**
 * Platform key used for unscoped analytics rows. It is NOT a real distribution
 * channel and must never count as a platform anywhere in the Learning engine.
 */
export const PSEUDO_PLATFORM = "all";

function normalisePlatform(platform: string | null): string {
  if (typeof platform !== "string") return PSEUDO_PLATFORM;
  const trimmed = platform.trim().toLowerCase();
  return trimmed === "" ? PSEUDO_PLATFORM : trimmed;
}

function coerceValue(value: number | null): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, num);
}

/**
 * Converts raw analytics rows inside [windowStart, windowEnd] into
 * observations. Rows outside the window, with unknown metric types, or with
 * non-finite values are excluded (and reported). Output is stably ordered by
 * (date, metricType, platform, analytics id) so identical inputs always
 * produce byte-identical observation lists.
 */
export function normaliseObservations(
  rows: RawAnalyticsRow[],
  windowStart: string,
  windowEnd: string
): NormaliseResult {
  const observations: PerformanceObservation[] = [];
  const issues: NormalisationIssue[] = [];

  for (const row of rows) {
    const date = toISODate(row.date);
    if (date < windowStart || date > windowEnd) continue;

    if (!METRIC_TYPE_SET.has(row.metricType)) {
      issues.push({
        analyticsId: row.id,
        reason: "unknown_metric_type",
        rawMetricType: row.metricType,
      });
      continue;
    }

    const value = coerceValue(row.value);
    if (value === null) {
      issues.push({ analyticsId: row.id, reason: "invalid_value" });
      continue;
    }

    const metricType = row.metricType as MetricType;
    const platform = normalisePlatform(row.platform);

    observations.push({
      id: `ao:${row.id}`,
      metricType,
      platform,
      date,
      value,
      provenance: {
        kind: "analytics",
        analyticsId: row.id,
        metricType,
        platform: typeof row.platform === "string" ? row.platform : null,
        date,
      },
    });
  }

  observations.sort((a, b) =>
    a.date === b.date
      ? a.metricType === b.metricType
        ? a.platform === b.platform
          ? a.id < b.id
            ? -1
            : 1
          : a.platform < b.platform
            ? -1
            : 1
        : a.metricType < b.metricType
          ? -1
          : 1
      : a.date < b.date
        ? -1
        : 1
  );

  return { observations, issues };
}

export interface MetricTotals {
  impressions: number;
  clicks: number;
  conversions: number;
  engagement: number;
  reach: number;
  followers: number;
  leads: number;
  revenue: number;
}

export function sumMetrics(observations: PerformanceObservation[]): MetricTotals {
  const totals: MetricTotals = {
    impressions: 0,
    clicks: 0,
    conversions: 0,
    engagement: 0,
    reach: 0,
    followers: 0,
    leads: 0,
    revenue: 0,
  };
  for (const obs of observations) {
    totals[obs.metricType] += obs.value;
  }
  return totals;
}

export function sumMetric(
  observations: PerformanceObservation[],
  metricType: MetricType
): number {
  return observations
    .filter((o) => o.metricType === metricType)
    .reduce((acc, o) => acc + o.value, 0);
}

export function observationIdsFor(
  observations: PerformanceObservation[],
  metricTypes: MetricType[],
  platform?: string
): string[] {
  return observations
    .filter(
      (o) =>
        metricTypes.includes(o.metricType) &&
        (platform === undefined || o.platform === platform)
    )
    .map((o) => o.id)
    .sort();
}
