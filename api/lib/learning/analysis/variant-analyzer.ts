/**
 * Governed variant analyzer (WBS15.3).
 *
 * Pure analyzer that the convergence layer feeds with the canonical
 * performance dataset: per-variant PerformanceObservation sets attributed
 * through durable publication lineage (publish packages, publication
 * receipts, queue rows). The analyzer never touches the database, never
 * throws on malformed input, and is deterministic — identical inputs
 * (in any order) always produce byte-identical analyses.
 *
 * Evidence discipline:
 * - Statements are factual and past-tense ("recorded", "accounted for").
 *   Causality is never asserted.
 * - Comparisons fail closed (comparability "non_comparable") when variants
 *   are fewer than two, lack common measurable metrics, sit below minimum
 *   evidence volumes, carry incomplete lineage, or published in materially
 *   incompatible windows. Factual per-variant summaries are still preserved.
 * - The pseudo-platform "all" (unscoped analytics rows) is not a distribution
 *   channel and is never treated as a variant.
 */

import type { ConfidenceLevel } from "../contracts/learning-derivation";
import {
  METRIC_TYPES,
  PSEUDO_PLATFORM,
  observationIdsFor,
  sumMetric,
  sumMetrics,
  type MetricType,
  type PerformanceObservation,
} from "../contracts/observation";
import {
  MAX_VARIANT_WINDOW_GAP_DAYS,
  MIN_COMPARED_VARIANTS,
  MIN_VARIANT_CLICKS,
  MIN_VARIANT_IMPRESSIONS,
  MIN_VARIANT_OBSERVATION_COUNT,
  VARIANT_ANALYSIS_VERSION,
  VARIANT_CONFIDENCE_MIN_IMPRESSIONS,
  VARIANT_CONFIDENCE_MIN_OBJECTIVE_VOLUME,
  VARIANT_CONFIDENCE_MIN_WINDOW_DAYS,
} from "./variant-analysis-config";
import {
  SUPPORTED_VARIANT_DIMENSIONS,
  type VariantAnalysis,
  type VariantAnalysisInput,
  type VariantComparability,
  type VariantDimension,
  type VariantFinding,
  type VariantIdentity,
  type VariantMetricSummary,
  type VariantPerformanceRecord,
  type VariantPublicationFact,
  type VariantRates,
} from "./variant-analysis-contract";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const UNKNOWN_VARIANT_KEY = "(unknown)";
const METRIC_TYPE_ORDER = new Map<MetricType, number>(
  METRIC_TYPES.map((m, i) => [m, i])
);
const SUPPORTED_DIMENSION_SET = new Set<string>(SUPPORTED_VARIANT_DIMENSIONS);

/** Same stable ordering as ../contracts/observation.ts. */
function compareObservations(
  a: PerformanceObservation,
  b: PerformanceObservation
): number {
  return a.date === b.date
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
      : 1;
}

function normaliseKey(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function windowDays(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1;
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function computeRates(observations: PerformanceObservation[]): VariantRates {
  const impressions = sumMetric(observations, "impressions");
  const clicks = sumMetric(observations, "clicks");
  return {
    ctr: impressions >= MIN_VARIANT_IMPRESSIONS ? clicks / impressions : null,
    cvr:
      clicks >= MIN_VARIANT_CLICKS
        ? sumMetric(observations, "conversions") / clicks
        : null,
    engagementRate:
      impressions >= MIN_VARIANT_IMPRESSIONS
        ? sumMetric(observations, "engagement") / impressions
        : null,
  };
}

/** Lineage requirement for the dimension-specific identity, or null when sound. */
function identityLineageIssue(
  identity: VariantIdentity,
  dimension: VariantDimension
): string | null {
  switch (dimension) {
    case "platform": {
      const platform = normaliseKey(identity.platform);
      if (platform === "") return "missing platform identity";
      if (platform === PSEUDO_PLATFORM)
        return `pseudo-platform "${PSEUDO_PLATFORM}" is not a distribution channel`;
      return null;
    }
    case "message_copy":
      return typeof identity.copy?.copyHashSha256 === "string" &&
        identity.copy.copyHashSha256 !== ""
        ? null
        : "missing approved copy identity (copyHashSha256)";
    case "caption": {
      const caption = identity.caption;
      if (!caption) return "missing caption artifact identity";
      return (caption.artifactId !== null &&
        caption.artifactId !== undefined) ||
        (typeof caption.lineageFingerprintSha256 === "string" &&
          caption.lineageFingerprintSha256 !== "")
        ? null
        : "missing caption artifact identity";
    }
    case "creative": {
      const creative = identity.creative;
      if (!creative) return "missing visual artifact identity";
      return (creative.generatedAssetId !== null &&
        creative.generatedAssetId !== undefined) ||
        (typeof creative.renderLineageFingerprintSha256 === "string" &&
          creative.renderLineageFingerprintSha256 !== "")
        ? null
        : "missing visual artifact identity";
    }
    case "format":
      return normaliseKey(identity.format) === ""
        ? "missing content format identity"
        : null;
  }
}

/** Deterministic comparison key for a variant, derived from durable identity. */
function deriveKey(
  identity: VariantIdentity,
  dimension: VariantDimension
): string {
  const provided = normaliseKey(identity.key);
  if (provided !== "") return provided;
  switch (dimension) {
    case "platform":
      return normaliseKey(identity.platform);
    case "message_copy":
      return normaliseKey(identity.copy?.copyHashSha256 ?? null);
    case "caption":
      return (
        normaliseKey(identity.caption?.lineageFingerprintSha256 ?? null) ||
        (identity.caption?.artifactId != null
          ? `caption-artifact:${identity.caption.artifactId}`
          : "")
      );
    case "creative":
      return (
        normaliseKey(
          identity.creative?.renderLineageFingerprintSha256 ?? null
        ) ||
        (identity.creative?.generatedAssetId != null
          ? `visual-asset:${identity.creative.generatedAssetId}`
          : "")
      );
    case "format":
      return normaliseKey(identity.format);
  }
}

interface MergedVariant {
  identity: VariantIdentity;
  observations: Map<string, PerformanceObservation>;
  publications: Map<string, VariantPublicationFact>;
}

/**
 * Groups records by variant key. Records are pre-sorted by (key, label) so
 * the surviving identity is independent of input order. The pseudo-platform
 * is never materialised as a variant: such records are returned separately.
 */
function mergeRecords(
  records: VariantPerformanceRecord[],
  dimension: VariantDimension
): { merged: MergedVariant[]; pseudoRecords: number } {
  const keyed: {
    key: string;
    identity: VariantIdentity;
    record: VariantPerformanceRecord;
  }[] = [];
  let pseudoRecords = 0;

  for (const record of records) {
    if (!record || typeof record !== "object" || !record.identity) continue;
    const identity = record.identity;
    if (
      dimension === "platform" &&
      normaliseKey(identity.platform) === PSEUDO_PLATFORM
    ) {
      pseudoRecords += 1;
      continue;
    }
    keyed.push({ key: deriveKey(identity, dimension), identity, record });
  }

  keyed.sort((a, b) =>
    a.key === b.key
      ? (a.identity.label ?? "") < (b.identity.label ?? "")
        ? -1
        : 1
      : a.key < b.key
        ? -1
        : 1
  );

  const groups = new Map<string, MergedVariant>();
  for (const { key, identity, record } of keyed) {
    const effectiveKey = key === "" ? UNKNOWN_VARIANT_KEY : key;
    let group = groups.get(effectiveKey);
    if (!group) {
      group = { identity, observations: new Map(), publications: new Map() };
      groups.set(effectiveKey, group);
    }
    for (const observation of Array.isArray(record.observations)
      ? record.observations
      : []) {
      if (!group.observations.has(observation.id))
        group.observations.set(observation.id, observation);
    }
    for (const publication of Array.isArray(record.publications)
      ? record.publications
      : []) {
      if (!group.publications.has(publication.ref))
        group.publications.set(publication.ref, publication);
    }
  }

  return { merged: [...groups.values()], pseudoRecords };
}

function comparePublications(
  a: VariantPublicationFact,
  b: VariantPublicationFact
): number {
  return a.publishedAt === b.publishedAt
    ? a.ref < b.ref
      ? -1
      : 1
    : a.publishedAt < b.publishedAt
      ? -1
      : 1;
}

function buildSummary(
  group: MergedVariant,
  dimension: VariantDimension,
  windowStart: string,
  windowEnd: string
): { summary: VariantMetricSummary; lineageIssue: string | null } {
  const key = deriveKey(group.identity, dimension) || UNKNOWN_VARIANT_KEY;
  const observations = [...group.observations.values()]
    .filter(o => o.date >= windowStart && o.date <= windowEnd)
    .sort(compareObservations);
  const publications = [...group.publications.values()].sort(
    comparePublications
  );
  const totals = sumMetrics(observations);
  const publicationWindow =
    publications.length > 0
      ? {
          start: publications[0].publishedAt,
          end: publications[publications.length - 1].publishedAt,
        }
      : null;

  const identityIssue = identityLineageIssue(group.identity, dimension);
  const lineageIssue = identityIssue;
  const lineageComplete =
    lineageIssue === null &&
    publications.length > 0 &&
    publications.every(p => p.lineageComplete);

  return {
    summary: {
      key,
      label:
        group.identity.label && group.identity.label.trim() !== ""
          ? group.identity.label
          : key,
      identity: group.identity,
      lineageComplete,
      publicationCount: publications.length,
      publicationWindow,
      observationCount: observations.length,
      totals,
      rates: computeRates(observations),
      evidenceRefs: observationIdsFor(observations, [...METRIC_TYPES]),
    },
    lineageIssue,
  };
}

function metricTypesOf(observations: PerformanceObservation[]): MetricType[] {
  const present = new Set(observations.map(o => o.metricType));
  return METRIC_TYPES.filter(m => present.has(m));
}

/** Gap in days between the end of `a` and the start of `b` (negative = overlap). */
function spanGapDays(
  a: { start: string; end: string },
  b: { start: string; end: string }
): number {
  return Math.round((Date.parse(b.start) - Date.parse(a.end)) / DAY_MS);
}

function publicationWindowsCompatible(
  summaries: VariantMetricSummary[]
): boolean {
  const spans = summaries
    .map(s => s.publicationWindow)
    .filter((w): w is { start: string; end: string } => w !== null)
    .sort((a, b) =>
      a.start === b.start
        ? a.end < b.end
          ? -1
          : 1
        : a.start < b.start
          ? -1
          : 1
    );
  if (spans.length < MIN_COMPARED_VARIANTS || spans.length < summaries.length)
    return false;
  for (let i = 0; i + 1 < spans.length; i += 1) {
    if (spanGapDays(spans[i], spans[i + 1]) > MAX_VARIANT_WINDOW_GAP_DAYS)
      return false;
  }
  return true;
}

const RATE_FIELDS = [
  { field: "ctr", name: "click-through rate" },
  { field: "cvr", name: "conversion rate" },
  { field: "engagementRate", name: "engagement rate" },
] as const;

/**
 * Analyzes attributed variant evidence for one campaign window and
 * dimension. Never throws; malformed or unsupported requests fail closed
 * with comparability "non_comparable" and explicit reasons/limitations.
 */
export function analyzeVariantPerformance(
  input: VariantAnalysisInput
): VariantAnalysis {
  const requestedDimension =
    typeof input.dimension === "string" ? input.dimension.trim() : "";
  const windowStart =
    typeof input.windowStart === "string" ? input.windowStart : "";
  const windowEnd = typeof input.windowEnd === "string" ? input.windowEnd : "";
  const objectiveMetric: MetricType | null =
    input.objectiveMetric && METRIC_TYPE_ORDER.has(input.objectiveMetric)
      ? input.objectiveMetric
      : null;

  const base: VariantAnalysis = {
    analysisVersion: VARIANT_ANALYSIS_VERSION,
    campaignId: typeof input.campaignId === "number" ? input.campaignId : 0,
    windowStart,
    windowEnd,
    requestedDimension,
    dimension: null,
    objectiveMetric,
    comparability: "non_comparable",
    comparabilityReasons: [],
    comparedMetricTypes: [],
    variants: [],
    findings: [],
    confidence: "low",
    limitations: [],
  };

  const reasons: string[] = [];
  const limitations: string[] = [];

  // --- Request validation (fail closed) -----------------------------------
  if (!SUPPORTED_DIMENSION_SET.has(requestedDimension)) {
    reasons.push(
      `unsupported dimension "${requestedDimension === "" ? "(empty)" : requestedDimension}"`
    );
  }
  const windowValid =
    DATE_RE.test(windowStart) &&
    DATE_RE.test(windowEnd) &&
    windowStart <= windowEnd;
  if (!windowValid) reasons.push("invalid analysis window");

  const rawRecords = Array.isArray(input.records) ? input.records : [];
  const records = rawRecords.filter(
    (r): r is VariantPerformanceRecord =>
      typeof r === "object" && r !== null && typeof r.identity === "object"
  );
  if (records.length < rawRecords.length) {
    limitations.push(
      `${rawRecords.length - records.length} malformed record(s) were ignored.`
    );
  }
  if (records.length === 0) reasons.push("no variant records provided");

  const dimension = SUPPORTED_DIMENSION_SET.has(requestedDimension)
    ? (requestedDimension as VariantDimension)
    : null;

  if (!dimension || !windowValid) {
    if (!dimension) {
      limitations.push(
        `Dimension "${requestedDimension === "" ? "(empty)" : requestedDimension}" has no durable lineage support; no comparative analysis was attempted.`
      );
    }
    if (!windowValid)
      limitations.push(
        "The analysis window is invalid; observations could not be bounded."
      );
    base.comparabilityReasons = [...reasons].sort();
    base.limitations = limitations;
    return base;
  }

  // --- Merge records into variants ----------------------------------------
  const { merged, pseudoRecords } = mergeRecords(records, dimension);
  if (pseudoRecords > 0) {
    limitations.push(
      `${pseudoRecords} record(s) keyed to the pseudo-platform "${PSEUDO_PLATFORM}" were excluded; unscoped rows are not a distribution channel.`
    );
  }

  const summaries: VariantMetricSummary[] = [];
  const lineageIssues = new Map<string, string>();
  const metricTypesByKey = new Map<string, MetricType[]>();
  let sawPseudoObservation = false;

  for (const group of merged) {
    const { summary, lineageIssue } = buildSummary(
      group,
      dimension,
      windowStart,
      windowEnd
    );
    if (lineageIssue !== null) lineageIssues.set(summary.key, lineageIssue);
    const observations = [...group.observations.values()].filter(
      o => o.date >= windowStart && o.date <= windowEnd
    );
    metricTypesByKey.set(summary.key, metricTypesOf(observations));
    if (observations.some(o => o.platform === PSEUDO_PLATFORM))
      sawPseudoObservation = true;
    if (dimension === "platform") {
      const foreign = observations.filter(
        o => o.platform !== PSEUDO_PLATFORM && o.platform !== summary.key
      ).length;
      if (foreign > 0) {
        limitations.push(
          `Variant "${summary.label}" included ${foreign} observation(s) attributed to other platforms; totals were treated as provided.`
        );
      }
    }
    summaries.push(summary);
  }
  summaries.sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? -1 : 1));

  base.variants = summaries;
  base.dimension = dimension;
  if (summaries.length === 0) reasons.push("no variant records provided");

  // --- Comparability gates (fail closed) ----------------------------------
  if (summaries.length < MIN_COMPARED_VARIANTS) {
    reasons.push(
      summaries.length === 1
        ? `only one variant has recorded evidence; comparison requires at least ${MIN_COMPARED_VARIANTS}`
        : `no comparable variants; comparison requires at least ${MIN_COMPARED_VARIANTS}`
    );
  }

  const incomplete = summaries.filter(s => !s.lineageComplete);
  if (incomplete.length > 0) {
    reasons.push("incomplete variant lineage");
    for (const summary of incomplete) {
      const issue = lineageIssues.get(summary.key);
      limitations.push(
        issue !== undefined && issue !== null
          ? `Variant "${summary.label}" has incomplete lineage (${issue}); comparative claims are withheld.`
          : `Variant "${summary.label}" has incomplete lineage; comparative claims are withheld.`
      );
    }
  }

  const comparedMetricTypes =
    summaries.length > 0
      ? metricTypesByKey
          .get(summaries[0].key)!
          .filter(m =>
            summaries.every(s => metricTypesByKey.get(s.key)!.includes(m))
          )
      : [];
  base.comparedMetricTypes = comparedMetricTypes;
  if (
    summaries.length >= MIN_COMPARED_VARIANTS &&
    comparedMetricTypes.length === 0
  ) {
    reasons.push("variants share no common measurable metric types");
  }

  const thin = summaries.filter(
    s =>
      s.observationCount < MIN_VARIANT_OBSERVATION_COUNT ||
      s.totals.impressions < MIN_VARIANT_IMPRESSIONS ||
      s.totals.clicks < MIN_VARIANT_CLICKS
  );
  if (summaries.length >= MIN_COMPARED_VARIANTS && thin.length > 0) {
    reasons.push("insufficient observation volume");
    for (const summary of thin) {
      limitations.push(
        `Variant "${summary.label}" is below minimum evidence thresholds (${summary.observationCount} observations, ${summary.totals.impressions} impressions, ${summary.totals.clicks} clicks).`
      );
    }
  }

  if (
    summaries.length >= MIN_COMPARED_VARIANTS &&
    !publicationWindowsCompatible(summaries)
  ) {
    reasons.push("publication windows are materially incompatible");
    limitations.push(
      `Variant publication windows are separated by more than ${MAX_VARIANT_WINDOW_GAP_DAYS} days; exposure windows do not align.`
    );
  }

  const comparability: VariantComparability =
    reasons.length === 0 ? "comparable" : "non_comparable";
  base.comparability = comparability;
  base.comparabilityReasons = [...reasons].sort();

  // --- Findings (factual summaries always; comparative only when sound) ---
  const findings: VariantFinding[] = [];
  for (const summary of summaries) {
    findings.push({
      id: `vfind:${dimension}:summary:${summary.key}`,
      kind: "variant_summary",
      statement:
        `Variant "${summary.label}" recorded ${summary.totals.impressions} impressions, ` +
        `${summary.totals.clicks} clicks, and ${summary.totals.conversions} conversions in this window.`,
      metricType: null,
      evidenceRefs: summary.evidenceRefs,
    });
  }

  const shareMetric =
    objectiveMetric && comparedMetricTypes.includes(objectiveMetric)
      ? objectiveMetric
      : (comparedMetricTypes.find(
          m => summaries.reduce((acc, s) => acc + s.totals[m], 0) > 0
        ) ?? null);
  if (summaries.length >= MIN_COMPARED_VARIANTS && shareMetric !== null) {
    const totalAcross = summaries.reduce(
      (acc, s) => acc + s.totals[shareMetric],
      0
    );
    if (totalAcross > 0) {
      const ordered = [...summaries].sort((a, b) => {
        const shareDiff =
          b.totals[shareMetric] / totalAcross -
          a.totals[shareMetric] / totalAcross;
        return shareDiff !== 0 ? shareDiff : a.key < b.key ? -1 : 1;
      });
      for (const summary of ordered) {
        const pct = (summary.totals[shareMetric] / totalAcross) * 100;
        findings.push({
          id: `vfind:${dimension}:share:${shareMetric}:${summary.key}`,
          kind: "share_of_total",
          statement: `Variant "${summary.label}" accounted for ${pct.toFixed(2)}% of recorded ${shareMetric} across the compared variants in this window.`,
          metricType: shareMetric,
          evidenceRefs: summary.evidenceRefs,
        });
      }
    }
  }

  if (comparability === "comparable") {
    for (const { field, name } of RATE_FIELDS) {
      const ranked = summaries
        .filter(s => s.rates[field] !== null)
        .sort((a, b) => {
          const diff = (b.rates[field] as number) - (a.rates[field] as number);
          return diff !== 0 ? diff : a.key < b.key ? -1 : 1;
        });
      if (ranked.length < MIN_COMPARED_VARIANTS) continue;

      const parts: string[] = [];
      for (let i = 0; i < ranked.length; i += 1) {
        const part = `"${ranked[i].label}" (${formatPercent(ranked[i].rates[field] as number)})`;
        if (i === 0) {
          parts.push(part);
        } else {
          const prev = ranked[i - 1].rates[field] as number;
          const curr = ranked[i].rates[field] as number;
          parts.push(`${curr === prev ? "=" : ">"} ${part}`);
        }
      }
      const involvedRefs = [
        ...new Set(ranked.flatMap(s => s.evidenceRefs)),
      ].sort();
      findings.push({
        id: `vfind:${dimension}:ordering:${field}`,
        kind: "rate_ordering",
        statement: `Recorded ${name} ordering across variants in this window: ${parts.join(" ")}.`,
        metricType: null,
        evidenceRefs: involvedRefs,
      });

      const top = ranked[0];
      const second = ranked[1];
      if ((top.rates[field] as number) > (second.rates[field] as number)) {
        findings.push({
          id: `vfind:${dimension}:comparative:${field}`,
          kind: "comparative_rate",
          statement:
            `Variant "${top.label}" recorded a higher ${name} than variant "${second.label}" ` +
            `in this window (${formatPercent(top.rates[field] as number)} vs ${formatPercent(second.rates[field] as number)}).`,
          metricType: null,
          evidenceRefs: [
            ...new Set([...top.evidenceRefs, ...second.evidenceRefs]),
          ].sort(),
        });
      }
    }
  }

  base.findings = findings;

  // --- Confidence (reuse Learning engine point-score philosophy) ----------
  // A "high" verdict additionally requires the objective metric to carry
  // recorded evidence: a comparison whose objective never fired cannot be
  // high-confidence evidence of anything.
  let score = 0;
  if (comparability === "comparable") score += 1;
  if (summaries.length > 0 && summaries.every(s => s.lineageComplete))
    score += 1;
  const objectiveVolume = objectiveMetric
    ? summaries.reduce((acc, s) => acc + s.totals[objectiveMetric], 0)
    : 0;
  if (objectiveVolume > 0) score += 1;
  if (objectiveVolume >= VARIANT_CONFIDENCE_MIN_OBJECTIVE_VOLUME) score += 1;
  const totalImpressions = summaries.reduce(
    (acc, s) => acc + s.totals.impressions,
    0
  );
  if (totalImpressions >= VARIANT_CONFIDENCE_MIN_IMPRESSIONS) score += 1;
  if (
    windowValid &&
    windowDays(windowStart, windowEnd) >= VARIANT_CONFIDENCE_MIN_WINDOW_DAYS
  )
    score += 1;
  const confidence: ConfidenceLevel =
    comparability === "comparable" && score >= 5
      ? "high"
      : score >= 3 && (comparability === "comparable" || score >= 4)
        ? "medium"
        : "low";
  base.confidence = confidence;

  // --- Standing limitations -----------------------------------------------
  limitations.push(
    "Variant attribution of performance observations is provided by the convergence layer and is treated as factual input."
  );
  if (sawPseudoObservation || dimension === "platform") {
    limitations.push(
      `Unscoped analytics rows (platform "${PSEUDO_PLATFORM}") are not a distribution channel and are never treated as a variant.`
    );
  }
  limitations.push(
    "Findings describe observations recorded within the analysis window; no causal relationship is asserted."
  );
  base.limitations = limitations;

  return base;
}
