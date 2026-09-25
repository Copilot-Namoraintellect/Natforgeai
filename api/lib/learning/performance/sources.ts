/**
 * Structural source contracts for the canonical CampaignPerformanceDataset.
 *
 * These types mirror the persisted rows the read-only dataset loader reads,
 * but are structurally typed so the pure dataset builder and its tests need
 * no database. Every type here is a read projection of one durable row; the
 * builder never mutates them and never writes anywhere.
 *
 * Extraction helpers in this module are deliberately lenient readers (the
 * opposite of the fail-closed writers): the dataset records what is actually
 * persisted, including incomplete or unexpected shapes, instead of throwing.
 * Nothing here invents data that is absent.
 */

import type { RawAnalyticsRow } from "../contracts/observation";

// ─── Campaign authority ───

/** Projection of the durable `campaigns` row fields the dataset cites. */
export interface CampaignSource {
  readonly id: number;
  readonly userId: number;
  readonly businessId: number | null;
  readonly goal: string;
  readonly primaryOutcome: string | null;
  readonly startDate: string | Date | null;
  readonly endDate: string | Date | null;
  /** Verbatim `campaigns.workflowContext` JSON (may be null). */
  readonly workflowContext: unknown;
}

/** Projection of the immutable `strategy_snapshots` row. */
export interface StrategySnapshotSource {
  readonly id: number;
  readonly snapshotId: string;
  readonly strategyRunId: number;
  readonly businessDnaSnapshotId: string;
  readonly version: number;
  readonly creativeBriefFingerprint: string;
  readonly strategyHashSha256: string;
  /** Verbatim canonical strategy snapshot JSON (StrategyOutput shape). */
  readonly snapshot: unknown;
  readonly capturedAt: string | Date;
}

/** Projection of the `approval_requests` row tied to the strategy lineage. */
export interface ApprovalRequestSource {
  readonly id: number;
  readonly status: string;
  readonly approvedAt: string | Date | null;
}

// ─── Publication lineage ───

/**
 * Projection of one `publishing_queue` row. `metadata` is the verbatim JSON
 * column (governed rows carry the persisted publish-package envelope).
 */
export interface QueuePublicationSource {
  readonly id: number;
  readonly contentPostId: number | null;
  readonly platform: string;
  readonly status: string;
  readonly scheduledAt: string | Date | null;
  readonly publishedAt: string | Date | null;
  readonly externalPostId: string | null;
  readonly metadata: unknown;
  /**
   * `externalUrl` from the durable `publication_success` audit-event receipt
   * for this queue item, when one exists. Provenance is cited separately via
   * `receiptAuditEventId`.
   */
  readonly receiptExternalUrl?: string | null;
  readonly receiptAuditEventId?: number | null;
}

/**
 * Projection of a manually published `content_posts` row: status "published"
 * with `metadata.publishMode === "manual"` and no publishing_queue row. These
 * are legacy publications by definition — the dataset classifies them as such
 * instead of fabricating governed lineage.
 */
export interface ManualPublicationSource {
  readonly contentPostId: number;
  readonly platform: string | null;
  readonly publishedAt: string | Date | null;
  /** Verbatim `content_posts.metadata` JSON. */
  readonly metadata: unknown;
}

/** Projection of the `content_posts` rows referenced by publications. */
export interface ContentPostSource {
  readonly id: number;
  readonly title: string;
  readonly type: string;
  readonly platform: string | null;
  readonly status: string;
  /** Verbatim `content_posts.metadata` JSON. */
  readonly metadata: unknown;
}

// ─── Factual outcomes ───

/** Projection of one `social_engagement_events` row. */
export interface EngagementEventSource {
  readonly id: number;
  readonly campaignId: number | null;
  readonly platform: string;
  readonly eventType: string;
  /** Provider post identity; links the event to a publication when matched. */
  readonly externalContentId: string | null;
  readonly eventTimestamp: string | Date;
}

/** Projection of one `leads` row. */
export interface LeadSource {
  readonly id: number;
  readonly campaignId: number | null;
  readonly status: string;
  readonly createdAt: string | Date;
}

/** Projection of one `ai_usage` row (the only campaign-attributable cost). */
export interface AiUsageSource {
  readonly id: number;
  readonly campaignId: number | null;
  readonly agentType: string;
  readonly model: string;
  /** Micro-USD integer (1 USD = 1_000_000), as persisted. */
  readonly actualCostUsd: number;
  readonly creditsDeducted: number;
  readonly createdAt: string | Date | null;
}

/** Complete structural input for one dataset build. */
export interface PerformanceDatasetInput {
  readonly campaign: CampaignSource;
  readonly window: { readonly start: string; readonly end: string };
  readonly strategySnapshot?: StrategySnapshotSource | null;
  readonly strategyApproval?: ApprovalRequestSource | null;
  readonly publications?: readonly QueuePublicationSource[];
  readonly manualPublications?: readonly ManualPublicationSource[];
  readonly contentPosts?: readonly ContentPostSource[];
  readonly analyticsRows?: readonly RawAnalyticsRow[];
  readonly engagementEvents?: readonly EngagementEventSource[];
  readonly leads?: readonly LeadSource[];
  readonly aiUsageRows?: readonly AiUsageSource[];
}

// ─── Lenient metadata readers ───
//
// These read what is actually persisted. They return null for absent or
// malformed shapes instead of throwing: the dataset documents reality, it
// does not gatekeep it.

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Strategy coordinates carried by creative artifact lineage. */
export interface PersistedStrategyCoordinates {
  readonly strategySnapshotId: string;
  readonly strategyVersion: number | null;
  readonly businessDnaSnapshotId: string;
  readonly strategyHashSha256: string;
  readonly strategyRunId: number | null;
  readonly approvalRequestId: number | null;
  readonly creativeBriefFingerprint: string | null;
}

/** Approved-copy coordinates carried by creative artifact lineage. */
export interface PersistedApprovedCopyCoordinates {
  readonly copyHashSha256: string;
  readonly copySchemaVersion: string;
  readonly approvedRevisionId: string;
  readonly assessmentHashSha256: string;
  readonly contextLockId: string;
}

/** Subset of the persisted creative artifact lineage the dataset cites. */
export interface PersistedCreativeLineage {
  readonly artifactKind: string;
  readonly platform: string | null;
  readonly lineageFingerprintSha256: string | null;
  readonly strategy: PersistedStrategyCoordinates | null;
  readonly approvedCopy: PersistedApprovedCopyCoordinates | null;
}

/**
 * Reads `metadata.creativeArtifactLineage` from a content post (or campaign
 * asset) row, leniently. Returns null when the lineage is absent or does not
 * carry the expected shape.
 */
export function extractCreativeLineage(metadata: unknown): PersistedCreativeLineage | null {
  if (!isObject(metadata)) return null;
  const raw = metadata.creativeArtifactLineage;
  if (!isObject(raw)) return null;

  const strategyRaw = isObject(raw.strategy) ? raw.strategy : null;
  const copyRaw = isObject(raw.approvedCopy) ? raw.approvedCopy : null;

  const strategy: PersistedStrategyCoordinates | null = strategyRaw
    ? {
        strategySnapshotId: readString(strategyRaw.strategySnapshotId) ?? "",
        strategyVersion:
          typeof strategyRaw.strategyVersion === "number" &&
          Number.isInteger(strategyRaw.strategyVersion)
            ? strategyRaw.strategyVersion
            : null,
        businessDnaSnapshotId: readString(strategyRaw.businessDnaSnapshotId) ?? "",
        strategyHashSha256: readString(strategyRaw.strategyHashSha256) ?? "",
        strategyRunId:
          typeof strategyRaw.strategyRunId === "number" && Number.isInteger(strategyRaw.strategyRunId)
            ? strategyRaw.strategyRunId
            : null,
        approvalRequestId:
          typeof strategyRaw.approvalRequestId === "number" &&
          Number.isInteger(strategyRaw.approvalRequestId)
            ? strategyRaw.approvalRequestId
            : null,
        creativeBriefFingerprint: readString(strategyRaw.creativeBriefFingerprint),
      }
    : null;

  const approvedCopy: PersistedApprovedCopyCoordinates | null = copyRaw
    ? {
        copyHashSha256: readString(copyRaw.copyHashSha256) ?? "",
        copySchemaVersion: readString(copyRaw.copySchemaVersion) ?? "",
        approvedRevisionId: readString(copyRaw.approvedRevisionId) ?? "",
        assessmentHashSha256: readString(copyRaw.assessmentHashSha256) ?? "",
        contextLockId: readString(copyRaw.contextLockId) ?? "",
      }
    : null;

  const artifactKind = readString(raw.artifactKind);
  if (!artifactKind) return null;

  return {
    artifactKind,
    platform: readString(raw.platform),
    lineageFingerprintSha256: readString(raw.lineageFingerprintSha256),
    strategy,
    approvedCopy,
  };
}

/** The durable strategy approval lineage recorded in workflowContext. */
export interface PersistedStrategyApprovalLineage {
  readonly creativeBriefFingerprint: string;
  readonly strategyRunId: number;
  readonly strategySnapshotId: string;
  readonly strategyVersion: number;
  readonly businessDnaSnapshotId: string;
  readonly strategyHashSha256: string;
  readonly approvalRequestId: number;
  readonly status: string;
}

/**
 * Reads `workflowContext.strategyApprovalLineage`, leniently. Returns null
 * when the lineage is absent or incomplete.
 */
export function extractStrategyApprovalLineage(
  workflowContext: unknown
): PersistedStrategyApprovalLineage | null {
  if (!isObject(workflowContext)) return null;
  const raw = workflowContext.strategyApprovalLineage;
  if (!isObject(raw)) return null;

  const creativeBriefFingerprint = readString(raw.creativeBriefFingerprint);
  const strategySnapshotId = readString(raw.strategySnapshotId);
  const businessDnaSnapshotId = readString(raw.businessDnaSnapshotId);
  const strategyHashSha256 = readString(raw.strategyHashSha256);
  const status = readString(raw.status);
  const strategyRunId =
    typeof raw.strategyRunId === "number" && Number.isInteger(raw.strategyRunId)
      ? raw.strategyRunId
      : null;
  const strategyVersion =
    typeof raw.strategyVersion === "number" && Number.isInteger(raw.strategyVersion)
      ? raw.strategyVersion
      : null;
  const approvalRequestId =
    typeof raw.approvalRequestId === "number" && Number.isInteger(raw.approvalRequestId)
      ? raw.approvalRequestId
      : null;

  if (
    !creativeBriefFingerprint ||
    !strategySnapshotId ||
    !businessDnaSnapshotId ||
    !strategyHashSha256 ||
    !status ||
    strategyRunId === null ||
    strategyVersion === null ||
    approvalRequestId === null
  ) {
    return null;
  }

  return {
    creativeBriefFingerprint,
    strategyRunId,
    strategySnapshotId,
    strategyVersion,
    businessDnaSnapshotId,
    strategyHashSha256,
    approvalRequestId,
    status,
  };
}

/**
 * Extracts the free-text funnel metric hints recorded inside the canonical
 * strategy snapshot (`funnelStages[].metrics`). These are descriptive metric
 * names only — the snapshot never persisted numeric thresholds, so none are
 * invented here. Deduped, first-seen order, deterministic.
 */
export function extractFunnelMetricHints(snapshotJson: unknown): string[] {
  if (!isObject(snapshotJson)) return [];
  const stages = snapshotJson.funnelStages;
  if (!Array.isArray(stages)) return [];
  const hints: string[] = [];
  const seen = new Set<string>();
  for (const stage of stages) {
    if (!isObject(stage)) continue;
    const metrics = stage.metrics;
    if (!Array.isArray(metrics)) continue;
    for (const metric of metrics) {
      const text = readString(metric)?.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      hints.push(text);
    }
  }
  return hints;
}

/**
 * True when a content post's persisted metadata marks it as manually posted
 * (`metadata.publishMode === "manual"`). Used by the loader to separate
 * manual legacy publications from governed queue publications.
 */
export function isManualPublishMetadata(metadata: unknown): boolean {
  if (!isObject(metadata)) return false;
  return metadata.publishMode === "manual";
}
