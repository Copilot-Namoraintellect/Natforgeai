/**
 * Production read-only loader for the canonical CampaignPerformanceDataset.
 *
 * Loads the persisted rows that ground one campaign's performance dataset and
 * assembles it through the pure builder in dataset.ts. This loader performs
 * SELECTs only: it never inserts, updates, deletes, or rebuilds any Strategy,
 * Creative, Distribution, analytics or billing state. It exists so production
 * reads live here instead of inside the Phase 1 learning-service, which stays
 * untouched.
 *
 * Ownership note: this stream owns the dataset contract, this loader and the
 * focused tests — nothing else.
 */

import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  aiUsage,
  analytics,
  approvalRequests,
  auditEvents,
  campaigns,
  contentPosts,
  leads,
  publishingQueue,
  socialEngagementEvents,
  strategySnapshots,
} from "@db/schema";
import { getDb } from "../../../queries/connection";
import { toISODate, type RawAnalyticsRow } from "../contracts/observation";
import { buildCampaignPerformanceDataset } from "./dataset";
import {
  extractStrategyApprovalLineage,
  isManualPublishMetadata,
  type AiUsageSource,
  type ApprovalRequestSource,
  type ContentPostSource,
  type EngagementEventSource,
  type LeadSource,
  type ManualPublicationSource,
  type PerformanceDatasetInput,
  type QueuePublicationSource,
  type StrategySnapshotSource,
} from "./sources";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertPositiveId(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${name} must be a positive integer` });
  }
}

function assertValidWindow(start: string, end: string): void {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "windowStart/windowEnd must be YYYY-MM-DD",
    });
  }
  if (end < start) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "windowEnd must not be earlier than windowStart",
    });
  }
}

/**
 * Loads and assembles the canonical performance dataset for one campaign.
 * Read-only: every database access below is a SELECT.
 */
export async function loadCampaignPerformanceDataset(input: {
  userId: number;
  campaignId: number;
  windowStart?: string;
  windowEnd?: string;
}): Promise<ReturnType<typeof buildCampaignPerformanceDataset>> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.campaignId, "campaignId");
  const db = getDb();

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.userId, input.userId)))
    .limit(1);
  if (!campaign) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
  }

  const analyticsRows = await db
    .select()
    .from(analytics)
    .where(and(eq(analytics.campaignId, input.campaignId), eq(analytics.userId, input.userId)));

  // Resolve the evaluation window exactly like the Phase 1 engine: explicit
  // input wins, then campaign dates, then the observed analytics span.
  let windowStart = input.windowStart ?? null;
  let windowEnd = input.windowEnd ?? null;
  if (windowStart && windowEnd) {
    assertValidWindow(windowStart, windowEnd);
  } else {
    const dates = analyticsRows.map((r) => toISODate(r.date)).sort();
    windowStart =
      windowStart ??
      (campaign.startDate ? toISODate(campaign.startDate) : null) ??
      dates[0] ??
      null;
    windowEnd =
      windowEnd ??
      (campaign.endDate ? toISODate(campaign.endDate) : null) ??
      dates[dates.length - 1] ??
      null;
    if (windowStart && windowEnd) assertValidWindow(windowStart, windowEnd);
  }
  if (!windowStart || !windowEnd) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "No evaluation window could be resolved: the campaign has no dates and no analytics observations exist.",
    });
  }

  // ─── Strategy authority (immutable snapshot + approval evidence) ───
  const [snapshotRow] = await db
    .select()
    .from(strategySnapshots)
    .where(eq(strategySnapshots.campaignId, input.campaignId))
    .orderBy(desc(strategySnapshots.version))
    .limit(1);
  const strategySnapshot: StrategySnapshotSource | null = snapshotRow
    ? { ...snapshotRow }
    : null;

  const lineage = extractStrategyApprovalLineage(campaign.workflowContext);
  let strategyApproval: ApprovalRequestSource | null = null;
  if (lineage) {
    const [approvalRow] = await db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.id, lineage.approvalRequestId),
          eq(approvalRequests.userId, input.userId)
        )
      )
      .limit(1);
    strategyApproval = approvalRow ? { ...approvalRow } : null;
  }

  // ─── Publications (publishing_queue + manual legacy posts) ───
  const queueRows = await db
    .select()
    .from(publishingQueue)
    .where(
      and(
        eq(publishingQueue.campaignId, input.campaignId),
        eq(publishingQueue.userId, input.userId)
      )
    );

  const receiptRows = await db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "publication_success"),
        eq(auditEvents.campaignId, input.campaignId)
      )
    );
  const receiptByQueueId = new Map<number, { externalUrl: string | null; auditEventId: number }>();
  for (const row of receiptRows) {
    const receipt = (row.metadata as Record<string, unknown> | null)?.publicationReceipt as
      | Record<string, unknown>
      | undefined;
    const queueItemId = receipt?.queueItemId;
    if (typeof queueItemId === "number" && Number.isInteger(queueItemId)) {
      receiptByQueueId.set(queueItemId, {
        externalUrl: typeof receipt?.externalUrl === "string" ? receipt.externalUrl : null,
        auditEventId: row.id,
      });
    }
  }

  const publications: QueuePublicationSource[] = queueRows.map((row) => {
    const receipt = receiptByQueueId.get(row.id);
    return {
      id: row.id,
      contentPostId: row.contentPostId ?? null,
      platform: row.platform,
      status: row.status,
      scheduledAt: row.scheduledAt,
      publishedAt: row.publishedAt,
      externalPostId: row.externalPostId ?? null,
      metadata: row.metadata,
      receiptExternalUrl: receipt?.externalUrl ?? null,
      receiptAuditEventId: receipt?.auditEventId ?? null,
    };
  });

  const queueContentPostIds = new Set(
    queueRows.map((r) => r.contentPostId).filter((v): v is number => typeof v === "number")
  );

  const candidatePosts = await db
    .select()
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.campaignId, input.campaignId),
        eq(contentPosts.userId, input.userId),
        eq(contentPosts.status, "published")
      )
    );
  const manualPublications: ManualPublicationSource[] = candidatePosts
    .filter((post) => isManualPublishMetadata(post.metadata) && !queueContentPostIds.has(post.id))
    .map((post) => ({
      contentPostId: post.id,
      platform: post.platform,
      publishedAt: post.publishedAt,
      metadata: post.metadata,
    }));

  const contentPostIds = new Set<number>(queueContentPostIds);
  for (const manual of manualPublications) contentPostIds.add(manual.contentPostId);
  const contentPostRows =
    contentPostIds.size > 0
      ? await db
          .select()
          .from(contentPosts)
          .where(
            and(
              inArray(contentPosts.id, [...contentPostIds]),
              eq(contentPosts.userId, input.userId)
            )
          )
      : [];
  const contentPostSources: ContentPostSource[] = contentPostRows.map((row) => ({
    id: row.id,
    title: row.title,
    type: row.type,
    platform: row.platform,
    status: row.status,
    metadata: row.metadata,
  }));

  // ─── Factual outcomes ───
  const rawAnalyticsRows: RawAnalyticsRow[] = analyticsRows.map((row) => ({
    id: row.id,
    metricType: row.metricType,
    platform: row.platform,
    value: row.value,
    date: row.date,
  }));

  const engagementRows = await db
    .select()
    .from(socialEngagementEvents)
    .where(
      and(
        eq(socialEngagementEvents.userId, input.userId),
        or(
          eq(socialEngagementEvents.campaignId, input.campaignId),
          isNull(socialEngagementEvents.campaignId)
        )
      )
    );
  const engagementEvents: EngagementEventSource[] = engagementRows.map((row) => ({
    id: row.id,
    campaignId: row.campaignId ?? null,
    platform: row.platform,
    eventType: row.eventType,
    externalContentId: row.externalContentId ?? null,
    eventTimestamp: row.eventTimestamp,
  }));

  const leadRows = await db
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.userId, input.userId),
        or(eq(leads.campaignId, input.campaignId), isNull(leads.campaignId))
      )
    );
  const leadSources: LeadSource[] = leadRows.map((row) => ({
    id: row.id,
    campaignId: row.campaignId ?? null,
    status: row.status,
    createdAt: row.createdAt,
  }));

  const usageRows = await db
    .select()
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.userId, input.userId),
        or(eq(aiUsage.campaignId, input.campaignId), isNull(aiUsage.campaignId))
      )
    );
  const aiUsageSources: AiUsageSource[] = usageRows.map((row) => ({
    id: row.id,
    campaignId: row.campaignId ?? null,
    agentType: row.agentType,
    model: row.model,
    actualCostUsd: row.actualCostUsd,
    creditsDeducted: row.creditsDeducted,
    createdAt: row.createdAt,
  }));

  const datasetInput: PerformanceDatasetInput = {
    campaign: {
      id: campaign.id,
      userId: campaign.userId,
      businessId: campaign.businessId ?? null,
      goal: campaign.goal,
      primaryOutcome: campaign.primaryOutcome,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      workflowContext: campaign.workflowContext,
    },
    window: { start: windowStart, end: windowEnd },
    strategySnapshot,
    strategyApproval,
    publications,
    manualPublications,
    contentPosts: contentPostSources,
    analyticsRows: rawAnalyticsRows,
    engagementEvents,
    leads: leadSources,
    aiUsageRows: aiUsageSources,
  };

  return buildCampaignPerformanceDataset(datasetInput);
}
