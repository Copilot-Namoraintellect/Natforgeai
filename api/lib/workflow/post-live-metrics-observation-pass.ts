/**
 * Post-live metrics observation pass (WBS-R1.5).
 *
 * One pass resolves PUBLISHED candidates from the durable publication
 * authority (publishing_queue rows with status "published", a publishedAt
 * timestamp and an externalPostId), classifies them with a pure due/not_due
 * policy, and observes each due candidate through the governed chain:
 *
 *   provider binding → provider fetch → observation normalisation contract →
 *   durable analytics persistence.
 *
 * Boundaries and safety properties:
 * - The supported binding set is the surviving provider authority set
 *   (facebook, instagram, linkedin, twitter) — the same registration family
 *   as the governed platform adapter registry. TikTok is NOT supported and
 *   fails closed; no adapter is invented.
 * - Fetched metrics are filtered through the surviving Learning observation
 *   contract (normaliseObservations): unknown metric types or invalid values
 *   are skipped, never persisted.
 * - Per-candidate fault isolation: one failing candidate never aborts the
 *   pass; failures are collected as warnings.
 * - due/not_due policy ONLY: the pass never mutates publication state, queue
 *   rows or campaign state.
 * - All boundaries (candidate store, binding fetch, persistence) are
 *   injectable so tests run with zero live provider calls. The default
 *   bindings carry no live provider yet — fetching fails closed per
 *   candidate until a future provider expansion wires real metric reads.
 * - Durable persistence is idempotent (WBS-R4-D): every persisted row carries
 *   a deterministic observationId unique per campaign/platform/post/metric/
 *   day, so replays, restarts and same-day re-observation upsert instead of
 *   duplicating durable metrics.
 */

import { createHash } from "crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { analytics, publishingQueue } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  normaliseObservations,
  type MetricType,
  type RawAnalyticsRow,
} from "../learning/contracts/observation";

/** Durable observation cadence: a candidate is re-observed at most once per window. */
export const METRICS_OBSERVATION_DUE_WINDOW_MS = 300_000;

/**
 * The supported dormant registration set, consistent with the surviving
 * provider authority (platform adapter registry). TikTok is deliberately
 * absent.
 */
export const OBSERVATION_BINDING_PLATFORMS = [
  "facebook",
  "instagram",
  "linkedin",
  "twitter",
] as const;

export type ObservationBindingPlatform = (typeof OBSERVATION_BINDING_PLATFORMS)[number];

export function isObservationBindingPlatform(
  platform: string
): platform is ObservationBindingPlatform {
  return (OBSERVATION_BINDING_PLATFORMS as readonly string[]).includes(platform);
}

/** One raw post-metric sample reported by a provider binding. */
export interface RawPostMetricSample {
  metricType: string;
  value: number | null;
}

export interface PublishedObservationCandidate {
  queueItemId: number;
  userId: number;
  campaignId: number;
  platform: string;
  publishedAt: string;
  externalPostId: string;
}

/** The governed provider binding boundary for one platform. */
export interface MetricsObservationBinding {
  readonly platform: ObservationBindingPlatform;
  fetchPostMetrics(input: {
    externalPostId: string;
    publishedAt: string;
  }): Promise<RawPostMetricSample[]>;
}

export interface PostLiveMetricsObservationPassDeps {
  /** Durable publication authority: lists published queue candidates. */
  listPublishedCandidates(): Promise<PublishedObservationCandidate[]>;
  /** Durable observation authority: last observation timestamp per candidate. */
  loadLastObservedAt(candidate: PublishedObservationCandidate): Promise<string | null>;
  /** Resolves the provider binding for a platform; must fail closed for unsupported platforms. */
  resolveBinding(platform: string): MetricsObservationBinding | null;
  /** Persists normalised observations for one candidate. */
  persistObservations(input: {
    candidate: PublishedObservationCandidate;
    observedAt: string;
    metrics: Array<{ metricType: MetricType; value: number }>;
  }): Promise<void>;
}

export interface CandidateObservationReport {
  queueItemId: number;
  status: "observed" | "unsupported_platform" | "fetch_failed" | "persist_failed" | "not_due";
  detail?: string;
}

export interface PostLiveMetricsObservationPassReport {
  asOfDate: string;
  candidates: number;
  due: number;
  notDue: number;
  observed: number;
  results: CandidateObservationReport[];
}

/**
 * Pure due/not_due policy. A candidate is due when it has never been
 * observed or its last observation is older than the due window.
 */
export function isObservationDue(input: {
  lastObservedAt: string | null;
  asOfDate: string;
  dueWindowMs?: number;
}): boolean {
  if (input.lastObservedAt === null) return true;
  const last = new Date(input.lastObservedAt).getTime();
  if (Number.isNaN(last)) return true;
  const asOf = new Date(`${input.asOfDate}T00:00:00.000Z`).getTime();
  return asOf - last >= (input.dueWindowMs ?? METRICS_OBSERVATION_DUE_WINDOW_MS);
}

/**
 * Default fail-closed bindings: the registration set exists (so resolution
 * is governed and consistent) but no live provider is wired yet — fetching
 * fails closed per candidate until a future provider expansion implements
 * real metric reads.
 */
export function createDefaultMetricsObservationBindings(): Record<
  ObservationBindingPlatform,
  MetricsObservationBinding
> {
  const make = (platform: ObservationBindingPlatform): MetricsObservationBinding => ({
    platform,
    fetchPostMetrics: async () => {
      throw new Error(
        `Metrics observation binding for ${platform} has no live provider configured`
      );
    },
  });
  return {
    facebook: make("facebook"),
    instagram: make("instagram"),
    linkedin: make("linkedin"),
    twitter: make("twitter"),
  };
}

/**
 * Deterministic durable identity for one observed metric row:
 * `obs:` + SHA-256 over the canonical { campaignId, platform,
 * externalPostId, metricType, date } material. Provider-originated
 * identifiers are treated as untrusted input: they are hashed into the
 * identity, never persisted verbatim, and never reach logs through this
 * path. The same provider payload replayed on the same day collapses onto
 * one analytics row (upsert), so observation retries cannot duplicate
 * durable metrics.
 */
export function buildObservationId(input: {
  campaignId: number;
  platform: string;
  externalPostId: string;
  metricType: string;
  date: string;
}): string {
  const canonical = JSON.stringify({
    campaignId: input.campaignId,
    date: input.date,
    externalPostId: input.externalPostId,
    metricType: input.metricType,
    platform: input.platform,
  });
  return `obs:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function createDefaultPostLiveMetricsObservationPassDeps(): PostLiveMetricsObservationPassDeps {
  const bindings = createDefaultMetricsObservationBindings();
  const db = getDb();

  return {
    async listPublishedCandidates() {
      const rows = await db
        .select({
          queueItemId: publishingQueue.id,
          userId: publishingQueue.userId,
          campaignId: publishingQueue.campaignId,
          platform: publishingQueue.platform,
          publishedAt: publishingQueue.publishedAt,
          externalPostId: publishingQueue.externalPostId,
        })
        .from(publishingQueue)
        .where(
          and(
            eq(publishingQueue.status, "published"),
            isNotNull(publishingQueue.publishedAt),
            isNotNull(publishingQueue.externalPostId)
          )
        );
      return rows.map((row) => ({
        queueItemId: row.queueItemId,
        userId: row.userId,
        campaignId: row.campaignId,
        platform: row.platform,
        publishedAt:
          row.publishedAt instanceof Date
            ? row.publishedAt.toISOString()
            : String(row.publishedAt),
        externalPostId: String(row.externalPostId),
      }));
    },

    async loadLastObservedAt(candidate) {
      // The analytics table is the durable observation authority: the newest
      // provider-observed row attributed to this campaign + platform.
      // Manually recorded rows (observationId IS NULL) are not observations
      // and must never suppress a due observation.
      const rows = await db
        .select({ date: analytics.date })
        .from(analytics)
        .where(
          and(
            eq(analytics.userId, candidate.userId),
            eq(analytics.campaignId, candidate.campaignId),
            eq(analytics.platform, candidate.platform),
            isNotNull(analytics.observationId)
          )
        )
        .orderBy(desc(analytics.date))
        .limit(1);
      const latest = rows[0];
      if (!latest) return null;
      return latest.date instanceof Date
        ? latest.date.toISOString()
        : String(latest.date);
    },

    resolveBinding(platform) {
      const key = platform.trim().toLowerCase();
      return isObservationBindingPlatform(key) ? bindings[key] : null;
    },

    async persistObservations(input) {
      const observedDate = new Date(`${input.observedAt.slice(0, 10)}T00:00:00.000Z`);
      const observationDate = input.observedAt.slice(0, 10);
      for (const metric of input.metrics) {
        const value = Math.round(metric.value);
        // Idempotent durable persistence: the deterministic observationId is
        // unique, so a replayed payload, a restarted pass or a re-run inside
        // the same observation day upserts the value onto the SAME row
        // instead of creating duplicate durable metrics.
        await db
          .insert(analytics)
          .values({
            userId: input.candidate.userId,
            campaignId: input.candidate.campaignId,
            metricType: metric.metricType,
            platform: input.candidate.platform,
            value,
            date: observedDate,
            observationId: buildObservationId({
              campaignId: input.candidate.campaignId,
              platform: input.candidate.platform,
              externalPostId: input.candidate.externalPostId,
              metricType: metric.metricType,
              date: observationDate,
            }),
          })
          .onDuplicateKeyUpdate({ set: { value } });
      }
    },
  };
}

function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("asOfDate must be YYYY-MM-DD");
  }
}

/**
 * Runs one due-only metrics observation pass. Mutates nothing outside the
 * durable analytics persistence boundary.
 */
export async function runPostLiveMetricsObservationPass(input: {
  asOfDate: string;
  deps?: PostLiveMetricsObservationPassDeps;
}): Promise<PostLiveMetricsObservationPassReport> {
  assertIsoDate(input.asOfDate);

  const deps = input.deps ?? createDefaultPostLiveMetricsObservationPassDeps();
  const observedAt = new Date(`${input.asOfDate}T00:00:00.000Z`).toISOString();

  const candidates = await deps.listPublishedCandidates();
  const results: CandidateObservationReport[] = [];
  let due = 0;
  let notDue = 0;
  let observed = 0;

  for (const candidate of candidates) {
    const lastObservedAt = await deps.loadLastObservedAt(candidate);
    if (!isObservationDue({ lastObservedAt, asOfDate: input.asOfDate })) {
      notDue += 1;
      results.push({ queueItemId: candidate.queueItemId, status: "not_due" });
      continue;
    }
    due += 1;

    const binding = deps.resolveBinding(candidate.platform);
    if (!binding) {
      results.push({
        queueItemId: candidate.queueItemId,
        status: "unsupported_platform",
        detail: `platform ${candidate.platform} has no observation binding`,
      });
      continue;
    }

    let samples: RawPostMetricSample[];
    try {
      samples = await binding.fetchPostMetrics({
        externalPostId: candidate.externalPostId,
        publishedAt: candidate.publishedAt,
      });
    } catch (error) {
      results.push({
        queueItemId: candidate.queueItemId,
        status: "fetch_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    // Governed observation contract: only known metric types with valid,
    // non-negative values survive normalisation.
    const rawRows: RawAnalyticsRow[] = samples.map((sample, index) => ({
      id: index + 1,
      metricType: sample.metricType,
      platform: candidate.platform,
      value: sample.value,
      date: observedAt,
    }));
    const { observations } = normaliseObservations(rawRows, input.asOfDate, input.asOfDate);
    const metrics = observations.map((o) => ({ metricType: o.metricType, value: o.value }));

    try {
      await deps.persistObservations({ candidate, observedAt, metrics });
    } catch (error) {
      results.push({
        queueItemId: candidate.queueItemId,
        status: "persist_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    observed += 1;
    results.push({ queueItemId: candidate.queueItemId, status: "observed" });
  }

  return {
    asOfDate: input.asOfDate,
    candidates: candidates.length,
    due,
    notDue,
    observed,
    results,
  };
}
