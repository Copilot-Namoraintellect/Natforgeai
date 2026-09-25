/**
 * Strategy-bound KPI contracts (WBS15.2).
 *
 * Narrow seam with the WBS11 Strategy authority: the approved, immutable
 * Strategy payload (persisted `strategySnapshots.snapshot`, shaped by
 * StrategyOutputSchema in api/lib/agents/strategy-agent.ts) is adapted here
 * into metric references the Strategy-bound KPI authority can evaluate.
 *
 * What the approved Strategy actually persists as success criteria
 * (verified against the WBS11 snapshot contract and the Strategy output
 * schema):
 *   - `funnelStages[].metrics` — the ONLY Strategy-authored success-metric
 *     field: an array of metric name strings per funnel stage (e.g.
 *     "impressions", "engagement", "conversions"). It declares WHICH metrics
 *     the Strategy considers successful; it declares NO numeric thresholds.
 *   - No other field of the approved Strategy payload carries a numeric
 *     performance target (`budgetRecommendation` is a budget, not a KPI
 *     target).
 *
 * Therefore this module never invents a target: extraction yields
 * `target: null` for every metric until the Strategy schema itself gains
 * explicit targets, at which point the same refs carry them and the
 * evaluation authority's precedence-1 rule engages without further change.
 *
 * Pure module: no database access, no provider calls, no engine mutation.
 */

import type { MetricType } from "../contracts/observation";
import type { JsonValue } from "../../strategy/strategy-snapshot";

/** One success metric as named by the approved Strategy. */
export interface StrategySuccessMetricRef {
  /** Deterministic id, assigned after stable dedupe (`sm:0`, `sm:1`, ...). */
  id: string;
  /** Canonical metric when the Strategy label maps to one; null otherwise. */
  metric: MetricType | null;
  /** The Strategy's original wording, always preserved verbatim. */
  rawLabel: string;
  /** Trimmed/lowercased label used for alias mapping. */
  normalizedLabel: string;
  /** Funnel stages that named this metric, in first-encounter order. */
  stages: string[];
  /** Explicit numeric target declared by the Strategy; null when none. */
  target: number | null;
  /** Unit of the target/actual: "count" or "rate". Null when no target. */
  unit: "count" | "rate" | null;
  /** Comparison for the explicit target; defaults to ">=" (gte). */
  operator?: "gte" | "lte";
  /** JSON path into the snapshot payload, kept for lineage. */
  sourcePath: string;
}

/**
 * The Strategy-bound evaluation input: the immutable Strategy authority
 * coordinates plus the extracted success metrics. Structurally compatible
 * with PersistedStrategySnapshot from api/lib/strategy/strategy-snapshot-store
 * so a persisted row can be adapted directly.
 */
export interface StrategyKpiAuthority {
  snapshotId: string;
  strategyRunId: number;
  version: number;
  strategyHashSha256: string;
  creativeBriefFingerprint: string;
  campaignId: number;
  /** ISO timestamp of snapshot capture. */
  capturedAt: string;
  successMetrics: StrategySuccessMetricRef[];
}

/**
 * Deterministic alias table from Strategy metric wording to canonical
 * performance-fact metric types. Anything not listed here is preserved but
 * unmappable — it is never silently mapped to a guessed metric.
 */
const STRATEGY_METRIC_ALIASES: Record<string, MetricType> = {
  impressions: "impressions",
  impression: "impressions",
  clicks: "clicks",
  click: "clicks",
  conversions: "conversions",
  conversion: "conversions",
  sales: "conversions",
  orders: "conversions",
  purchases: "conversions",
  bookings: "conversions",
  signups: "conversions",
  "sign ups": "conversions",
  "sign-ups": "conversions",
  leads: "leads",
  lead: "leads",
  inquiries: "leads",
  enquiries: "leads",
  revenue: "revenue",
  income: "revenue",
  engagement: "engagement",
  engagements: "engagement",
  interactions: "engagement",
  followers: "followers",
  follower: "followers",
  subscribers: "followers",
  reach: "reach",
};

function normalizeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();
}

function mapStrategyMetric(label: string): MetricType | null {
  const normalized = normalizeLabel(label);
  if (!normalized) return null;
  return STRATEGY_METRIC_ALIASES[normalized] ?? null;
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Extracts the success metrics the approved Strategy declares, from
 * `funnelStages[].metrics` string labels. Labels naming the same canonical
 * metric are merged (stages accumulate); labels that do not map to a known
 * metric are preserved with `metric: null` so evaluation can report them as
 * not_measurable instead of fabricating a proxy. Malformed entries are
 * skipped. Output is stably ordered and deterministic for identical input.
 */
export function extractStrategySuccessMetrics(
  snapshot: JsonValue
): StrategySuccessMetricRef[] {
  if (!isRecord(snapshot)) return [];

  const funnelStages = snapshot.funnelStages;
  if (!Array.isArray(funnelStages)) return [];

  interface Accumulator {
    metric: MetricType | null;
    rawLabel: string;
    normalizedLabel: string;
    stages: string[];
    sourcePath: string;
  }

  const byKey = new Map<string, Accumulator>();

  funnelStages.forEach((stageValue, stageIndex) => {
    if (!isRecord(stageValue)) return;

    const stageName =
      typeof stageValue.stage === "string" ? stageValue.stage : null;
    const metrics = stageValue.metrics;
    if (!Array.isArray(metrics)) return;

    metrics.forEach((metricValue, metricIndex) => {
      if (typeof metricValue !== "string") return;

      const rawLabel = metricValue;
      const normalizedLabel = normalizeLabel(rawLabel);
      if (!normalizedLabel) return;

      const metric = mapStrategyMetric(rawLabel);
      const key = metric ?? `raw:${normalizedLabel}`;
      const sourcePath = `snapshot.funnelStages[${stageIndex}].metrics[${metricIndex}]`;

      const existing = byKey.get(key);
      if (existing) {
        if (stageName && !existing.stages.includes(stageName)) {
          existing.stages.push(stageName);
        }
        return;
      }

      byKey.set(key, {
        metric,
        rawLabel,
        normalizedLabel,
        stages: stageName ? [stageName] : [],
        sourcePath,
      });
    });
  });

  const sorted = Array.from(byKey.values()).sort((a, b) => {
    const aKey = a.metric ?? a.normalizedLabel;
    const bKey = b.metric ?? b.normalizedLabel;
    return aKey === bKey ? 0 : aKey < bKey ? -1 : 1;
  });

  return sorted.map((entry, index) => ({
    id: `sm:${index}`,
    metric: entry.metric,
    rawLabel: entry.rawLabel,
    normalizedLabel: entry.normalizedLabel,
    stages: entry.stages,
    // The current approved Strategy schema declares metric names only — no
    // numeric targets. These stay null until the Strategy payload itself
    // carries explicit targets.
    target: null,
    unit: null,
    sourcePath: entry.sourcePath,
  }));
}
