/**
 * Governed variant analysis contracts (WBS15.3).
 *
 * These types define the pure seam between the convergence layer and the
 * variant analyzer: convergence feeds the analyzer a canonical performance
 * dataset (attributed PerformanceObservation sets plus durable publication
 * lineage), and the analyzer returns an evidence-bounded, deterministic
 * VariantAnalysis. Nothing in this module touches the database, routers or
 * workflow.
 *
 * Only variant dimensions backed by durable lineage identity are supported:
 * - platform      — publishing_queue.platform / analytics.platform
 * - message_copy  — approved copy coordinates (copyHashSha256 et al.)
 * - caption       — caption artifact id + lineage fingerprint
 * - creative      — visual asset id + render lineage fingerprint
 * - format        — content_posts.type
 *
 * "campaign_channel" is a documented unsupported dimension: campaigns only
 * carry free-form platform text, so there is no durable channel identity to
 * compare. Requests for it (or any unknown dimension) fail closed.
 */

import type { ConfidenceLevel } from "../contracts/learning-derivation";
import type {
  MetricTotals,
  MetricType,
  PerformanceObservation,
} from "../contracts/observation";
import type { VARIANT_ANALYSIS_VERSION } from "./variant-analysis-config";

export const SUPPORTED_VARIANT_DIMENSIONS = [
  "platform",
  "message_copy",
  "caption",
  "creative",
  "format",
] as const;

export type VariantDimension = (typeof SUPPORTED_VARIANT_DIMENSIONS)[number];

/**
 * Dimensions that were evaluated and rejected because no durable lineage
 * identity exists for them. Listed so the failure is explicit rather than
 * looking like an oversight; analyzer requests for these fail closed.
 */
export const UNSUPPORTED_VARIANT_DIMENSIONS = ["campaign_channel"] as const;

/** Approved semantic-copy identity (V2 approval envelope coordinates). */
export interface VariantCopyIdentity {
  copyHashSha256: string;
  copySchemaVersion?: string | null;
  approvedRevisionId?: string | null;
  assessmentHashSha256?: string | null;
  contextLockId?: string | null;
}

/** Caption artifact identity (caption pack / platform caption variant). */
export interface VariantCaptionIdentity {
  artifactId?: number | null;
  artifactKind?: string | null;
  lineageFingerprintSha256?: string | null;
  platform?: string | null;
}

/** Visual artifact identity (generated image or rendered video). */
export interface VariantCreativeIdentity {
  mediaKind?: "image" | "video" | null;
  generatedAssetId?: number | null;
  renderLineageFingerprintSha256?: string | null;
}

/**
 * Durable identity of one variant. The field matching `kind` must carry the
 * dimension-specific identity; other fields are optional context. `key` and
 * `label` may be omitted and are then derived deterministically from the
 * durable identity.
 */
export interface VariantIdentity {
  kind: VariantDimension;
  key?: string;
  label?: string;
  platform?: string | null;
  copy?: VariantCopyIdentity | null;
  caption?: VariantCaptionIdentity | null;
  creative?: VariantCreativeIdentity | null;
  format?: string | null;
}

/** One governed publication backing a variant's evidence. */
export interface VariantPublicationFact {
  /** Durable reference, e.g. "receipt:publication:instagram:42". */
  ref: string;
  platform: string;
  /** ISO calendar date (YYYY-MM-DD). */
  publishedAt: string;
  lineageComplete: boolean;
  publishPackageId?: string | null;
}

/**
 * Performance evidence attributed to one variant by the convergence layer.
 * `observations` are canonical PerformanceObservation rows; `publications`
 * carry the durable lineage that justifies the attribution.
 */
export interface VariantPerformanceRecord {
  identity: VariantIdentity;
  observations: PerformanceObservation[];
  publications: VariantPublicationFact[];
}

/** Convergence → analyzer input. Pure data; validated at runtime, fail-closed. */
export interface VariantAnalysisInput {
  campaignId: number;
  /** Inclusive YYYY-MM-DD bounds. */
  windowStart: string;
  windowEnd: string;
  /** Dimension to compare; validated against SUPPORTED_VARIANT_DIMENSIONS. */
  dimension: string;
  objectiveMetric?: MetricType | null;
  records: VariantPerformanceRecord[];
}

export type VariantComparability = "comparable" | "non_comparable";

export interface VariantRates {
  /** clicks / impressions; null below MIN_VARIANT_IMPRESSIONS. */
  ctr: number | null;
  /** conversions / clicks; null below MIN_VARIANT_CLICKS. */
  cvr: number | null;
  /** engagement / impressions; null below MIN_VARIANT_IMPRESSIONS. */
  engagementRate: number | null;
}

/** Factual, per-variant metric summary. Present even when not comparable. */
export interface VariantMetricSummary {
  key: string;
  label: string;
  identity: VariantIdentity;
  /** False when lineage is incomplete; comparative claims are then withheld. */
  lineageComplete: boolean;
  publicationCount: number;
  publicationWindow: { start: string; end: string } | null;
  observationCount: number;
  totals: MetricTotals;
  rates: VariantRates;
  /** Observation ids backing every number in this summary (sorted). */
  evidenceRefs: string[];
}

export type VariantFindingKind =
  | "variant_summary"
  | "share_of_total"
  | "rate_ordering"
  | "comparative_rate";

/**
 * One evidence-bounded statement. Statements are strictly factual
 * ("recorded", "accounted for"); causal language is never emitted.
 */
export interface VariantFinding {
  id: string;
  kind: VariantFindingKind;
  statement: string;
  metricType: MetricType | null;
  evidenceRefs: string[];
}

export interface VariantAnalysis {
  analysisVersion: typeof VARIANT_ANALYSIS_VERSION;
  campaignId: number;
  windowStart: string;
  windowEnd: string;
  /** Echo of the requested dimension string. */
  requestedDimension: string;
  /** Resolved dimension; null when the request failed validation. */
  dimension: VariantDimension | null;
  objectiveMetric: MetricType | null;
  comparability: VariantComparability;
  comparabilityReasons: string[];
  /** Metric types observed on every compared variant (canonical order). */
  comparedMetricTypes: MetricType[];
  /** Deterministically ordered by variant key. */
  variants: VariantMetricSummary[];
  findings: VariantFinding[];
  confidence: ConfidenceLevel;
  limitations: string[];
}
