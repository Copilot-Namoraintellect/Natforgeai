/**
 * Canonical cross-engine CampaignPerformanceDataset (WBS15.1).
 *
 * One deterministic, evidence-backed factual input layer for Engine 6: it
 * combines, where actual persisted data exists, the approved Strategy
 * authority, published Creative/Distribution lineage, analytics observations,
 * engagement outcomes, campaign-linked leads/conversions and available cost
 * evidence for one campaign over one evaluation window.
 *
 * Grounding rules (Phase 1 compatible):
 * - Facts only. No recommendations, no causal inference, no mutation.
 * - Every derived element cites durable source coordinates (table + row id).
 * - Same persisted inputs + same evaluation window => byte-identical dataset
 *   and fingerprint. Nothing nondeterministic (wall-clock, key order) feeds
 *   the dataset or its fingerprint.
 * - Missing optional evidence is reported as an optional readiness issue;
 *   missing required authority is reported as a required issue. The builder
 *   never throws for absent evidence and never fabricates lineage.
 * - Legacy publications are explicitly classified as legacy/unlinked rather
 *   than receiving fabricated governed lineage.
 *
 * This module is pure: no database, provider, or network access. The
 * production loader (loader.ts) owns reads; this module owns the contract and
 * its deterministic assembly.
 */

import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  normaliseObservations,
  sumMetrics,
  toISODate,
  type MetricTotals,
  type PerformanceObservation,
} from "../contracts/observation";
import { resolveQueuePublishPackage } from "../../publish/publish-package-queue-store";
import type {
  PublishPackageApprovedCopyIdentity,
  PublishPackageStrategyAuthority,
} from "../../publish/publish-package-contract";
import {
  extractCreativeLineage,
  extractFunnelMetricHints,
  extractStrategyApprovalLineage,
  type PerformanceDatasetInput,
} from "./sources";

export const PERFORMANCE_DATASET_SCHEMA_VERSION = 1 as const;

// ─── Provenance ───

/** Durable source coordinates every derived element cites. */
export interface SourceCoordinates {
  readonly table: string;
  readonly id: number;
  readonly column?: string;
}

// ─── Identity ───

export interface EvaluationWindow {
  readonly start: string;
  readonly end: string;
}

export interface DatasetIdentity {
  readonly schemaVersion: typeof PERFORMANCE_DATASET_SCHEMA_VERSION;
  readonly campaignId: number;
  readonly userId: number;
  readonly businessId: number | null;
  readonly window: EvaluationWindow;
  /** SHA-256 over the canonical dataset JSON excluding this fingerprint. */
  readonly fingerprint: string;
}

// ─── Strategy authority ───

export type StrategyAuthorityStatus = "approved" | "unapproved" | "missing";

export interface StrategySnapshotCoordinates {
  readonly snapshotId: string;
  readonly strategyVersion: number;
  readonly strategyHashSha256: string;
  readonly strategyRunId: number;
  readonly businessDnaSnapshotId: string;
  readonly creativeBriefFingerprint: string;
  readonly capturedAt: string;
}

export interface StrategyApprovalEvidence {
  readonly approvalRequestId: number | null;
  /** Terminal lineage status recorded in workflowContext, when present. */
  readonly lineageStatus: string | null;
  /** approval_requests.status, when the request row was loaded. */
  readonly requestStatus: string | null;
  readonly approvedAt: string | null;
}

export interface StrategySuccessMetrics {
  /** True when the snapshot recorded funnel-stage metric names. */
  readonly available: boolean;
  /** Free-text funnel metric hints from the immutable snapshot; never thresholds. */
  readonly metrics: readonly string[];
  readonly source: "strategy_snapshot_funnel_metrics" | null;
}

export interface StrategyAuthoritySection {
  readonly status: StrategyAuthorityStatus;
  readonly snapshot: StrategySnapshotCoordinates | null;
  readonly approval: StrategyApprovalEvidence;
  readonly objective: { readonly text: string | null; readonly source: "primaryOutcome" | "goal" | null };
  readonly successMetrics: StrategySuccessMetrics;
  readonly provenance: readonly SourceCoordinates[];
}

// ─── Published artifacts ───

export type PublicationKind = "queue" | "manual";
/** Governed = persisted publish package verified; invalid = governed-marked but tampered/absent. */
export type PublicationLineage = "governed" | "legacy" | "invalid_package";

export interface PublicationPackageIdentity {
  readonly packageId: string;
  readonly packageFingerprintSha256: string;
  readonly classification: "governed" | "legacy";
  readonly legacyReasons: readonly string[];
  readonly strategyAuthority: PublishPackageStrategyAuthority | null;
  readonly approvedCopy: PublishPackageApprovedCopyIdentity | null;
}

export interface PublicationContentIdentity {
  readonly contentPostId: number | null;
  readonly title: string | null;
  readonly type: string | null;
  readonly platform: string | null;
  readonly status: string | null;
}

export interface PublicationCreativeLineage {
  readonly artifactKind: string | null;
  readonly lineageFingerprintSha256: string | null;
  readonly strategy: PublishPackageStrategyAuthority | null;
  readonly approvedCopy: PublishPackageApprovedCopyIdentity | null;
}

export interface PublishedArtifact {
  /** Deterministic artifact key: `pub:queue:<id>` or `pub:manual:<contentPostId>`. */
  readonly artifactId: string;
  readonly kind: PublicationKind;
  readonly lineage: PublicationLineage;
  readonly queue: {
    readonly queueItemId: number;
    readonly status: string;
    readonly platform: string;
    readonly scheduledAt: string | null;
    readonly publishedAt: string | null;
  } | null;
  readonly package: PublicationPackageIdentity | null;
  readonly content: PublicationContentIdentity;
  readonly creativeLineage: PublicationCreativeLineage | null;
  readonly provider: {
    readonly externalPostId: string | null;
    readonly externalUrl: string | null;
  };
  readonly provenance: readonly SourceCoordinates[];
}

// ─── Factual outcomes ───

export interface DatasetNormalisationIssue {
  readonly analyticsId: number;
  readonly reason: string;
  readonly rawMetricType?: string;
}

export interface OutcomeSection {
  /** Grounded, window-scoped observations (one per persisted analytics row). */
  readonly observations: readonly PerformanceObservation[];
  readonly totals: MetricTotals;
  /** Analytics rows supplied for this campaign (before window filtering). */
  readonly rowsConsidered: number;
  readonly normalisationIssues: readonly DatasetNormalisationIssue[];
}

// ─── Engagement facts ───

export interface EngagementFact {
  readonly platform: string;
  readonly eventType: string;
  readonly eventCount: number;
  readonly sourceEventIds: readonly number[];
  readonly provenance: readonly SourceCoordinates[];
}

export interface EngagementSection {
  /** Campaign-linked events inside the evaluation window, grouped factually. */
  readonly facts: readonly EngagementFact[];
  readonly inWindowEventCount: number;
  /** Same-user events not linked to this campaign; excluded, never attributed. */
  readonly unlinkedEventCount: number;
}

// ─── Leads / conversions ───

export interface LeadSection {
  /** Campaign-linked leads created inside the evaluation window. */
  readonly inWindowLeadCount: number;
  readonly byStatus: Record<string, number>;
  /** Campaign-linked in-window leads with status "won". */
  readonly conversionsWon: number;
  readonly leadIds: readonly number[];
  readonly provenance: readonly SourceCoordinates[];
}

// ─── Spend / cost ───

export interface SpendFact {
  readonly aiUsageId: number;
  readonly agentType: string;
  readonly model: string;
  /** Exact decimal USD string converted from persisted micro-USD integers. */
  readonly actualCostUsd: string;
  readonly creditsDeducted: number;
  readonly recordedAt: string | null;
  readonly provenance: SourceCoordinates;
}

export interface SpendSection {
  /** True when at least one campaign-linked ai_usage row exists in-window. */
  readonly available: boolean;
  /** Always "partial" when available: only model inference cost is campaign-linked. */
  readonly coverage: "partial" | "none";
  readonly basis: readonly string[];
  /** Exact decimal USD string; null when no cost evidence exists. */
  readonly totalCostUsd: string | null;
  readonly facts: readonly SpendFact[];
  readonly classificationNote: string;
}

// ─── Data quality / readiness ───

export type DatasetIssueSeverity = "required" | "optional";

export type DatasetIssueCode =
  | "strategy_authority_missing"
  | "strategy_approval_missing"
  | "no_publication_evidence"
  | "publication_lineage_incomplete"
  | "no_analytics_observations"
  | "insufficient_date_overlap"
  | "unlinked_engagement_data"
  | "cost_evidence_unavailable";

export interface DatasetIssue {
  readonly code: DatasetIssueCode;
  readonly severity: DatasetIssueSeverity;
  readonly message: string;
  readonly subject: SourceCoordinates | null;
}

export type DatasetReadinessStatus = "ready" | "degraded" | "authority_missing";

export interface ReadinessSection {
  readonly status: DatasetReadinessStatus;
  readonly issues: readonly DatasetIssue[];
  readonly requiredIssueCount: number;
  readonly optionalIssueCount: number;
}

// ─── Canonical dataset ───

export interface CampaignPerformanceDataset {
  readonly identity: DatasetIdentity;
  readonly strategyAuthority: StrategyAuthoritySection;
  readonly publications: readonly PublishedArtifact[];
  readonly outcomes: OutcomeSection;
  readonly engagement: EngagementSection;
  readonly leads: LeadSection;
  readonly spend: SpendSection;
  readonly readiness: ReadinessSection;
}

// ─── Deterministic helpers ───

function fail(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function toIsoTimestamp(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function compareStrings(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareNumbers(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function assertPositiveId(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer`);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertValidWindow(start: string, end: string): void {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    fail("window start/end must be YYYY-MM-DD");
  }
  if (end < start) {
    fail("window end must not be earlier than window start");
  }
}

/**
 * Exact decimal USD string from a persisted micro-USD integer (1 USD =
 * 1_000_000). Integer arithmetic only — no float rounding can occur, so the
 * string form is deterministic.
 */
export function microUsdToDecimalString(microUsd: number): string {
  if (!Number.isFinite(microUsd)) return "0";
  const rounded = Math.round(Math.abs(microUsd));
  const sign = microUsd < 0 ? "-" : "";
  const whole = Math.floor(rounded / 1_000_000);
  const fraction = rounded % 1_000_000;
  if (fraction === 0) return `${sign}${whole}`;
  const fractionText = String(fraction).padStart(6, "0").replace(/0+$/, "");
  return `${sign}${whole}.${fractionText}`;
}

/**
 * Deterministic SHA-256 fingerprint of the canonical dataset JSON excluding
 * the fingerprint field. Same inputs + same window => identical hash.
 */
export function computePerformanceDatasetFingerprint(
  dataset: Omit<CampaignPerformanceDataset, "identity"> & {
    identity: Omit<DatasetIdentity, "fingerprint">;
  }
): string {
  return sha256Hex(canonicalize(dataset));
}

// ─── Builder ───

interface MutableIssue {
  code: DatasetIssueCode;
  severity: DatasetIssueSeverity;
  message: string;
  subject: SourceCoordinates | null;
}

function buildStrategyAuthoritySection(
  input: PerformanceDatasetInput
): { section: StrategyAuthoritySection; issues: MutableIssue[] } {
  const { campaign, strategySnapshot, strategyApproval } = input;
  const issues: MutableIssue[] = [];
  const lineage = extractStrategyApprovalLineage(campaign.workflowContext);
  const snapshot = strategySnapshot ?? null;

  let status: StrategyAuthorityStatus;
  if (!snapshot) {
    status = "missing";
    issues.push({
      code: "strategy_authority_missing",
      severity: "required",
      message: `No immutable strategy snapshot exists for campaign ${campaign.id}.`,
      subject: { table: "strategy_snapshots", id: campaign.id },
    });
  } else if (lineage && lineage.status === "approved") {
    status = "approved";
  } else {
    status = "unapproved";
    issues.push({
      code: "strategy_approval_missing",
      severity: "required",
      message: lineage
        ? `Strategy snapshot authority for campaign ${campaign.id} has lineage status "${lineage.status}", not "approved".`
        : `Strategy snapshot authority for campaign ${campaign.id} has no recorded strategy approval lineage.`,
      subject: { table: "strategy_snapshots", id: snapshot.id },
    });
  }

  const objectiveText =
    typeof campaign.primaryOutcome === "string" && campaign.primaryOutcome.trim().length > 0
      ? campaign.primaryOutcome
      : typeof campaign.goal === "string" && campaign.goal.trim().length > 0
        ? campaign.goal
        : null;
  const objectiveSource: "primaryOutcome" | "goal" | null = objectiveText
    ? typeof campaign.primaryOutcome === "string" && campaign.primaryOutcome.trim().length > 0
      ? "primaryOutcome"
      : "goal"
    : null;

  const metricHints = snapshot ? extractFunnelMetricHints(snapshot.snapshot) : [];

  const provenance: SourceCoordinates[] = [];
  if (snapshot) {
    provenance.push({ table: "strategy_snapshots", id: snapshot.id });
  }
  if (lineage) {
    provenance.push({
      table: "campaigns",
      id: campaign.id,
      column: "workflowContext.strategyApprovalLineage",
    });
  }
  if (strategyApproval) {
    provenance.push({ table: "approval_requests", id: strategyApproval.id });
  }

  const section: StrategyAuthoritySection = {
    status,
    snapshot: snapshot
      ? {
          snapshotId: snapshot.snapshotId,
          strategyVersion: snapshot.version,
          strategyHashSha256: snapshot.strategyHashSha256,
          strategyRunId: snapshot.strategyRunId,
          businessDnaSnapshotId: snapshot.businessDnaSnapshotId,
          creativeBriefFingerprint: snapshot.creativeBriefFingerprint,
          capturedAt: toIsoTimestamp(snapshot.capturedAt) ?? "",
        }
      : null,
    approval: {
      approvalRequestId: lineage?.approvalRequestId ?? strategyApproval?.id ?? null,
      lineageStatus: lineage?.status ?? null,
      requestStatus: strategyApproval?.status ?? null,
      approvedAt: toIsoTimestamp(strategyApproval?.approvedAt),
    },
    objective: { text: objectiveText, source: objectiveSource },
    successMetrics: {
      available: metricHints.length > 0,
      metrics: metricHints,
      source: metricHints.length > 0 ? "strategy_snapshot_funnel_metrics" : null,
    },
    provenance,
  };

  return { section, issues };
}

function buildPublications(
  input: PerformanceDatasetInput
): { publications: PublishedArtifact[]; issues: MutableIssue[] } {
  const issues: MutableIssue[] = [];
  const contentById = new Map((input.contentPosts ?? []).map((p) => [p.id, p]));
  const publications: PublishedArtifact[] = [];

  const lineageIssue = (
    message: string,
    subject: SourceCoordinates
  ): MutableIssue => ({
    code: "publication_lineage_incomplete",
    severity: "optional",
    message,
    subject,
  });

  for (const pub of input.publications ?? []) {
    if (pub.status !== "published") continue;

    const resolution = resolveQueuePublishPackage(pub.metadata);
    const lineage: PublicationLineage =
      resolution.kind === "governed"
        ? "governed"
        : resolution.kind === "invalid"
          ? "invalid_package"
          : "legacy";

    if (lineage !== "governed") {
      issues.push(
        lineageIssue(
          lineage === "invalid_package"
            ? `Publishing queue row ${pub.id} is governed-marked but its persisted publish package is missing or failed integrity verification.`
            : `Publishing queue row ${pub.id} resolved as legacy: no persisted publish package.`,
          { table: "publishing_queue", id: pub.id }
        )
      );
    }

    const contentPost = pub.contentPostId != null ? contentById.get(pub.contentPostId) ?? null : null;
    if (!contentPost) {
      issues.push(
        lineageIssue(
          `Publishing queue row ${pub.id} has no resolvable content_posts row.`,
          { table: "publishing_queue", id: pub.id }
        )
      );
    }

    const creativeLineage = contentPost
      ? extractCreativeLineage(contentPost.metadata)
      : null;
    const packageIdentity =
      resolution.kind === "governed"
        ? {
            packageId: resolution.publishPackage.packageId,
            packageFingerprintSha256: resolution.publishPackage.packageFingerprintSha256,
            classification: resolution.publishPackage.classification,
            legacyReasons: [...resolution.publishPackage.legacyReasons],
            strategyAuthority: resolution.publishPackage.identity.strategyAuthority,
            approvedCopy: resolution.publishPackage.identity.approvedCopy,
          }
        : null;

    const provenance: SourceCoordinates[] = [{ table: "publishing_queue", id: pub.id }];
    if (contentPost) provenance.push({ table: "content_posts", id: contentPost.id });
    if (pub.receiptAuditEventId != null) {
      provenance.push({ table: "audit_events", id: pub.receiptAuditEventId });
    }

    publications.push({
      artifactId: `pub:queue:${pub.id}`,
      kind: "queue",
      lineage,
      queue: {
        queueItemId: pub.id,
        status: pub.status,
        platform: pub.platform,
        scheduledAt: toIsoTimestamp(pub.scheduledAt),
        publishedAt: toIsoTimestamp(pub.publishedAt),
      },
      package: packageIdentity,
      content: {
        contentPostId: contentPost?.id ?? pub.contentPostId ?? null,
        title: contentPost?.title ?? null,
        type: contentPost?.type ?? null,
        platform: contentPost?.platform ?? null,
        status: contentPost?.status ?? null,
      },
      creativeLineage: creativeLineage
        ? {
            artifactKind: creativeLineage.artifactKind,
            lineageFingerprintSha256: creativeLineage.lineageFingerprintSha256,
            strategy: creativeLineage.strategy,
            approvedCopy: creativeLineage.approvedCopy,
          }
        : null,
      provider: {
        externalPostId: pub.externalPostId ?? null,
        externalUrl: pub.receiptExternalUrl ?? null,
      },
      provenance,
    });
  }

  for (const manual of input.manualPublications ?? []) {
    issues.push(
      lineageIssue(
        `Content post ${manual.contentPostId} was published manually: no publishing_queue row or publish package exists, so it is classified legacy.`,
        { table: "content_posts", id: manual.contentPostId }
      )
    );
    const contentPost = contentById.get(manual.contentPostId) ?? null;
    const creativeLineage = contentPost
      ? extractCreativeLineage(contentPost.metadata)
      : null;

    publications.push({
      artifactId: `pub:manual:${manual.contentPostId}`,
      kind: "manual",
      lineage: "legacy",
      queue: null,
      package: null,
      content: {
        contentPostId: manual.contentPostId,
        title: contentPost?.title ?? null,
        type: contentPost?.type ?? null,
        platform: contentPost?.platform ?? manual.platform ?? null,
        status: contentPost?.status ?? null,
      },
      creativeLineage: creativeLineage
        ? {
            artifactKind: creativeLineage.artifactKind,
            lineageFingerprintSha256: creativeLineage.lineageFingerprintSha256,
            strategy: creativeLineage.strategy,
            approvedCopy: creativeLineage.approvedCopy,
          }
        : null,
      provider: { externalPostId: null, externalUrl: null },
      provenance: [{ table: "content_posts", id: manual.contentPostId }],
    });
  }

  publications.sort((a, b) => {
    const aTime =
      a.queue?.publishedAt ?? a.queue?.scheduledAt ?? "";
    const bTime =
      b.queue?.publishedAt ?? b.queue?.scheduledAt ?? "";
    return compareStrings(aTime, bTime) || compareStrings(a.artifactId, b.artifactId);
  });

  return { publications, issues };
}

function buildOutcomes(
  input: PerformanceDatasetInput,
  start: string,
  end: string
): OutcomeSection {
  const rows = [...(input.analyticsRows ?? [])];
  const { observations, issues } = normaliseObservations(rows, start, end);
  const normalisationIssues = [...issues].sort(
    (a, b) =>
      compareNumbers(a.analyticsId, b.analyticsId) || compareStrings(a.reason, b.reason)
  );
  return {
    observations,
    totals: sumMetrics(observations),
    rowsConsidered: rows.length,
    normalisationIssues,
  };
}

function buildEngagementSection(
  input: PerformanceDatasetInput,
  campaignId: number,
  start: string,
  end: string
): { section: EngagementSection; unlinkedCount: number } {
  const groups = new Map<string, { platform: string; eventType: string; ids: number[] }>();
  let unlinkedCount = 0;

  const events = [...(input.engagementEvents ?? [])].sort((a, b) => compareNumbers(a.id, b.id));
  for (const event of events) {
    if (event.campaignId !== campaignId) {
      unlinkedCount += 1;
      continue;
    }
    const day = toISODate(event.eventTimestamp);
    if (day < start || day > end) continue;
    const key = `${event.platform}|${event.eventType}`;
    const group = groups.get(key) ?? { platform: event.platform, eventType: event.eventType, ids: [] };
    group.ids.push(event.id);
    groups.set(key, group);
  }

  const facts: EngagementFact[] = [...groups.values()]
    .sort(
      (a, b) =>
        compareStrings(a.platform, b.platform) || compareStrings(a.eventType, b.eventType)
    )
    .map((group) => ({
      platform: group.platform,
      eventType: group.eventType,
      eventCount: group.ids.length,
      sourceEventIds: Object.freeze([...group.ids].sort(compareNumbers)),
      provenance: Object.freeze(
        group.ids
          .map((id): SourceCoordinates => ({ table: "social_engagement_events", id }))
          .sort((a, b) => compareNumbers(a.id, b.id))
      ),
    }));

  const inWindowEventCount = facts.reduce((acc, fact) => acc + fact.eventCount, 0);
  return {
    section: { facts, inWindowEventCount, unlinkedEventCount: unlinkedCount },
    unlinkedCount,
  };
}

function buildLeadSection(
  input: PerformanceDatasetInput,
  campaignId: number,
  start: string,
  end: string
): LeadSection {
  const linked = (input.leads ?? [])
    .filter((lead) => {
      if (lead.campaignId !== campaignId) return false;
      const day = toISODate(lead.createdAt);
      return day >= start && day <= end;
    })
    .sort((a, b) => compareNumbers(a.id, b.id));

  const byStatus: Record<string, number> = {};
  let conversionsWon = 0;
  for (const lead of linked) {
    const status = typeof lead.status === "string" && lead.status.length > 0 ? lead.status : "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (lead.status === "won") conversionsWon += 1;
  }
  const sortedByStatus: Record<string, number> = {};
  for (const key of Object.keys(byStatus).sort()) {
    sortedByStatus[key] = byStatus[key];
  }

  return {
    inWindowLeadCount: linked.length,
    byStatus: sortedByStatus,
    conversionsWon,
    leadIds: Object.freeze(linked.map((lead) => lead.id)),
    provenance: Object.freeze(
      linked.map((lead): SourceCoordinates => ({ table: "leads", id: lead.id }))
    ),
  };
}

function buildSpendSection(
  input: PerformanceDatasetInput,
  campaignId: number,
  start: string,
  end: string
): { section: SpendSection; available: boolean } {
  const linked = (input.aiUsageRows ?? [])
    .filter((row) => {
      if (row.campaignId !== campaignId) return false;
      if (row.createdAt === null || row.createdAt === undefined) return true;
      const day = toISODate(row.createdAt);
      return day >= start && day <= end;
    })
    .sort((a, b) => compareNumbers(a.id, b.id));

  const facts: SpendFact[] = linked.map((row) => ({
    aiUsageId: row.id,
    agentType: row.agentType,
    model: row.model,
    actualCostUsd: microUsdToDecimalString(row.actualCostUsd),
    creditsDeducted: row.creditsDeducted,
    recordedAt: toIsoTimestamp(row.createdAt),
    provenance: { table: "ai_usage", id: row.id },
  }));

  const totalMicro = linked.reduce((acc, row) => acc + Math.round(row.actualCostUsd), 0);
  const available = facts.length > 0;

  const section: SpendSection = available
    ? {
        available: true,
        coverage: "partial",
        basis: Object.freeze(["ai_usage"]),
        totalCostUsd: microUsdToDecimalString(totalMicro),
        facts: Object.freeze(facts),
        classificationNote:
          "Campaign-linked cost evidence is limited to ai_usage rows (model inference cost). Ad spend, payments and credit transactions are not persisted per campaign, so this total is partial, not full campaign spend.",
      }
    : {
        available: false,
        coverage: "none",
        basis: Object.freeze([]),
        totalCostUsd: null,
        facts: Object.freeze([]),
        classificationNote:
          "No campaign-linked cost evidence exists: no ai_usage rows are recorded for this campaign in the evaluation window.",
      };

  return { section, available };
}

/**
 * Assembles the canonical CampaignPerformanceDataset from structural persisted
 * sources. Pure and deterministic: identical inputs produce a byte-identical,
 * deep-frozen dataset and fingerprint. Never mutates its inputs, never writes
 * anywhere, never throws for absent evidence (invalid windows/ids aside).
 */
export function buildCampaignPerformanceDataset(
  input: PerformanceDatasetInput
): CampaignPerformanceDataset {
  const { campaign } = input;
  assertPositiveId(campaign.id, "campaign.id");
  assertPositiveId(campaign.userId, "campaign.userId");
  const { start, end } = input.window;
  assertValidWindow(start, end);

  const issues: MutableIssue[] = [];

  const strategy = buildStrategyAuthoritySection(input);
  issues.push(...strategy.issues);

  const builtPublications = buildPublications(input);
  issues.push(...builtPublications.issues);

  if (builtPublications.publications.length === 0) {
    issues.push({
      code: "no_publication_evidence",
      severity: "optional",
      message: `Campaign ${campaign.id} has no published artifacts in the persisted publishing_queue or manual publication records.`,
      subject: { table: "campaigns", id: campaign.id },
    });
  }

  const outcomes = buildOutcomes(input, start, end);
  if (outcomes.observations.length === 0) {
    issues.push({
      code: "no_analytics_observations",
      severity: "optional",
      message: `No factual analytics observations exist for campaign ${campaign.id} in window ${start}..${end}.`,
      subject: { table: "analytics", id: campaign.id },
    });
  }

  const engagement = buildEngagementSection(input, campaign.id, start, end);
  if (engagement.unlinkedCount > 0) {
    issues.push({
      code: "unlinked_engagement_data",
      severity: "optional",
      message: `${engagement.unlinkedCount} engagement event(s) recorded for this user are not linked to campaign ${campaign.id} and were excluded from the dataset.`,
      subject: { table: "social_engagement_events", id: campaign.id },
    });
  }

  const leads = buildLeadSection(input, campaign.id, start, end);

  const spend = buildSpendSection(input, campaign.id, start, end);
  if (!spend.available) {
    issues.push({
      code: "cost_evidence_unavailable",
      severity: "optional",
      message: `No campaign-linked cost evidence (ai_usage) exists for campaign ${campaign.id} in window ${start}..${end}.`,
      subject: { table: "ai_usage", id: campaign.id },
    });
  }

  // Deterministic date-overlap signal over every evidence date supplied.
  const evidenceDates: string[] = [];
  for (const row of input.analyticsRows ?? []) evidenceDates.push(toISODate(row.date));
  for (const event of input.engagementEvents ?? []) {
    evidenceDates.push(toISODate(event.eventTimestamp));
  }
  for (const lead of input.leads ?? []) evidenceDates.push(toISODate(lead.createdAt));
  for (const pub of input.publications ?? []) {
    if (pub.publishedAt != null) evidenceDates.push(toISODate(pub.publishedAt));
    else if (pub.scheduledAt != null) evidenceDates.push(toISODate(pub.scheduledAt));
  }
  for (const manual of input.manualPublications ?? []) {
    if (manual.publishedAt != null) evidenceDates.push(toISODate(manual.publishedAt));
  }
  const overlapCount = evidenceDates.filter((day) => day >= start && day <= end).length;
  if (evidenceDates.length > 0 && overlapCount === 0) {
    issues.push({
      code: "insufficient_date_overlap",
      severity: "optional",
      message: `The evaluation window ${start}..${end} overlaps none of the ${evidenceDates.length} persisted evidence date(s) for campaign ${campaign.id}.`,
      subject: { table: "campaigns", id: campaign.id },
    });
  }

  const severityRank: Record<DatasetIssueSeverity, number> = { required: 0, optional: 1 };
  const sortedIssues = issues.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      compareStrings(a.code, b.code) ||
      compareStrings(a.subject?.table ?? "", b.subject?.table ?? "") ||
      compareNumbers(a.subject?.id ?? 0, b.subject?.id ?? 0) ||
      compareStrings(a.message, b.message)
  );
  const requiredIssueCount = sortedIssues.filter((i) => i.severity === "required").length;
  const optionalIssueCount = sortedIssues.length - requiredIssueCount;
  const readinessStatus: DatasetReadinessStatus =
    requiredIssueCount > 0
      ? "authority_missing"
      : optionalIssueCount > 0
        ? "degraded"
        : "ready";

  const datasetBase = {
    identity: {
      schemaVersion: PERFORMANCE_DATASET_SCHEMA_VERSION,
      campaignId: campaign.id,
      userId: campaign.userId,
      businessId: campaign.businessId ?? null,
      window: { start, end },
    },
    strategyAuthority: strategy.section,
    publications: builtPublications.publications,
    outcomes,
    engagement: engagement.section,
    leads,
    spend: spend.section,
    readiness: {
      status: readinessStatus,
      issues: sortedIssues,
      requiredIssueCount,
      optionalIssueCount,
    },
  };

  const fingerprint = computePerformanceDatasetFingerprint(datasetBase);

  return deepFreeze({
    ...datasetBase,
    identity: { ...datasetBase.identity, fingerprint },
  });
}
