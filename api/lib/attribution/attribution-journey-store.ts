// ─── R7-B Attribution Intelligence — journey source gathering ───
//
// Read-only consumption of upstream authorities (R4/R5/R6 tables). Every
// query is tenant-predicated (userId from the authenticated session). This
// store never writes upstream rows and never mutates upstream state. It
// resolves the numeric leadId → lid1 binding ONLY through the score-mediated
// chain (lead_score_snapshots → lead_qualifications), the same validated chain
// R6-C consumes; no bare-id inference, no fuzzy matching.

import { and, eq, inArray } from "drizzle-orm";
import {
  campaigns,
  conversionEvents,
  engagementReceipts,
  leadIdentityProvenance,
  leadQualifications,
  leadScoreSnapshots,
  nurtureTouchRecords,
  opportunityCandidates,
  opportunityEvidence,
  publishingQueue,
  salesHandoffs,
  socialSignals,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  parsePublicationOperationId,
  type CampaignSource,
  type ConversionProvenanceSource,
  type EngagementReceiptSource,
  type IdentityProvenanceSource,
  type JourneySourceBundle,
  type NurtureTouchSource,
  type OpportunityEvidenceSource,
  type OpportunitySource,
  type PublicationQueueSource,
  type SalesHandoffSource,
  type SignalSource,
} from "./attribution-journey";

type Db = ReturnType<typeof getDb>;

export interface JourneyStoreExecutor {
  select: Db["select"];
}

export function resolveJourneyDb(executor?: JourneyStoreExecutor): JourneyStoreExecutor {
  return executor ?? getDb();
}

function toIso(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? String(value) : new Date(ms).toISOString();
}

/** The score-mediated lead binding: numeric leads.id → validated lid1 set. */
export interface LeadChainResolution {
  readonly validatedLids: readonly string[];
  readonly leadChainValidated: boolean;
}

/**
 * Resolve the canonical lid set for an outcome's numeric lead. Chain:
 * lead_score_snapshots (numeric leadId → leadScoreId) → lead_qualifications
 * (leadScoreId → lid1 leadId). Read-only; empty when the outcome is unlinked
 * or the chain is absent.
 */
export async function resolveLeadChain(
  userId: number,
  leadId: number | null,
  executor?: JourneyStoreExecutor
): Promise<LeadChainResolution> {
  const db = resolveJourneyDb(executor);
  if (leadId === null) return { validatedLids: [], leadChainValidated: false };

  const scores = await db
    .select({ leadScoreId: leadScoreSnapshots.leadScoreId })
    .from(leadScoreSnapshots)
    .where(and(eq(leadScoreSnapshots.userId, userId), eq(leadScoreSnapshots.leadId, leadId)));
  if (scores.length === 0) return { validatedLids: [], leadChainValidated: false };

  const scoreIds = scores.map((s) => s.leadScoreId);
  const quals = await db
    .select({ leadId: leadQualifications.leadId })
    .from(leadQualifications)
    .where(
      and(
        eq(leadQualifications.userId, userId),
        scoreIds.length === 1
          ? eq(leadQualifications.leadScoreId, scoreIds[0])
          : inArray(leadQualifications.leadScoreId, scoreIds)
      )
    );
  const lids = [...new Set(quals.map((q) => q.leadId))];
  return { validatedLids: lids, leadChainValidated: lids.length > 0 };
}

/**
 * Gather the complete journey source bundle for one outcome context. All
 * queries are tenant-scoped; dependents are gathered in two phases so only
 * legitimately-reachable rows are ever loaded (no business-wide sweeps).
 */
export async function gatherJourneySources(input: {
  userId: number;
  conversionId: string;
  validatedLids: readonly string[];
  executor?: JourneyStoreExecutor;
}): Promise<JourneySourceBundle> {
  const db = resolveJourneyDb(input.executor);
  const userId = input.userId;
  const lids = input.validatedLids;

  // ─── Phase A: conversion provenance + lead lineage roots ───
  const [conversion] = await db
    .select({
      sourceOpportunityId: conversionEvents.sourceOpportunityId,
      sourceEngagementReceiptId: conversionEvents.sourceEngagementReceiptId,
      sourceSignalId: conversionEvents.sourceSignalId,
      sourceCampaignId: conversionEvents.sourceCampaignId,
      sourcePublicationId: conversionEvents.sourcePublicationId,
    })
    .from(conversionEvents)
    .where(
      and(eq(conversionEvents.userId, userId), eq(conversionEvents.conversionId, input.conversionId))
    )
    .limit(1);

  const conversionProvenance: ConversionProvenanceSource | null = conversion
    ? {
        sourceOpportunityId: conversion.sourceOpportunityId ?? null,
        sourceEngagementReceiptId: conversion.sourceEngagementReceiptId ?? null,
        sourceSignalId: conversion.sourceSignalId ?? null,
        sourceCampaignId:
          conversion.sourceCampaignId === null || conversion.sourceCampaignId === undefined
            ? null
            : Number(conversion.sourceCampaignId),
        sourcePublicationId:
          conversion.sourcePublicationId === null || conversion.sourcePublicationId === undefined
            ? null
            : Number(conversion.sourcePublicationId),
      }
    : null;

  const identityProvenanceRows = lids.length
    ? await db
        .select({
          leadId: leadIdentityProvenance.leadId,
          handoffId: leadIdentityProvenance.handoffId,
          opportunityId: leadIdentityProvenance.opportunityId,
          campaignId: leadIdentityProvenance.campaignId,
          publicationId: leadIdentityProvenance.publicationId,
          occurredAt: leadIdentityProvenance.occurredAt,
          evidenceHash: leadIdentityProvenance.evidenceHash,
        })
        .from(leadIdentityProvenance)
        .where(
          and(
            eq(leadIdentityProvenance.userId, userId),
            eq(leadIdentityProvenance.kind, "opportunity_handoff"),
            lids.length === 1
              ? eq(leadIdentityProvenance.leadId, lids[0])
              : inArray(leadIdentityProvenance.leadId, lids)
          )
        )
    : [];
  const identityProvenance: IdentityProvenanceSource[] = identityProvenanceRows.map((r) => ({
    leadId: r.leadId,
    handoffId: r.handoffId ?? null,
    opportunityId: r.opportunityId ?? null,
    campaignId: r.campaignId === null || r.campaignId === undefined ? null : Number(r.campaignId),
    publicationId: r.publicationId ?? null,
    occurredAt: r.occurredAt,
    evidenceHash: r.evidenceHash,
  }));

  const opportunityIds = [
    ...new Set(
      [
        ...identityProvenance.map((p) => p.opportunityId),
        conversionProvenance?.sourceOpportunityId ?? null,
      ].filter((v): v is string => v !== null)
    ),
  ];

  const opportunityRows = opportunityIds.length
    ? await db
        .select({
          id: opportunityCandidates.id,
          opportunityId: opportunityCandidates.opportunityId,
          businessId: opportunityCandidates.businessId,
          campaignId: opportunityCandidates.campaignId,
          publicationId: opportunityCandidates.publicationId,
          firstObservedAt: opportunityCandidates.firstObservedAt,
        })
        .from(opportunityCandidates)
        .where(
          and(
            eq(opportunityCandidates.userId, userId),
            opportunityIds.length === 1
              ? eq(opportunityCandidates.opportunityId, opportunityIds[0])
              : inArray(opportunityCandidates.opportunityId, opportunityIds)
          )
        )
    : [];
  const opportunities: OpportunitySource[] = opportunityRows.map((o) => ({
    opportunityId: o.opportunityId,
    businessId: o.businessId === null || o.businessId === undefined ? null : Number(o.businessId),
    campaignId: o.campaignId === null || o.campaignId === undefined ? null : Number(o.campaignId),
    publicationId: o.publicationId ?? null,
    firstObservedAt: o.firstObservedAt,
  }));

  // ─── Phase B: evidence → receipts → signals; nurture/handoff; refs ───
  const candidateDbIds = opportunityRows.map((o) => Number(o.id));
  const evidenceRows = candidateDbIds.length
    ? await db
        .select({
          candidateId: opportunityEvidence.candidateId,
          engagementReceiptId: opportunityEvidence.engagementReceiptId,
          signalId: opportunityEvidence.signalId,
          occurredAt: opportunityEvidence.occurredAt,
          evidenceHash: opportunityEvidence.evidenceHash,
        })
        .from(opportunityEvidence)
        .where(
          and(
            eq(opportunityEvidence.userId, userId),
            candidateDbIds.length === 1
              ? eq(opportunityEvidence.candidateId, candidateDbIds[0])
              : inArray(opportunityEvidence.candidateId, candidateDbIds)
          )
        )
    : [];
  const opportunityEvidenceOut: OpportunityEvidenceSource[] = evidenceRows.map((e) => ({
    candidateId: Number(e.candidateId),
    engagementReceiptId: e.engagementReceiptId ?? null,
    signalId: e.signalId,
    occurredAt: e.occurredAt,
    evidenceHash: e.evidenceHash,
  }));

  const receiptIds = [
    ...new Set(
      [
        ...opportunityEvidenceOut.map((e) => e.engagementReceiptId),
        conversionProvenance?.sourceEngagementReceiptId ?? null,
      ].filter((v): v is string => v !== null)
    ),
  ];
  const receiptRows = receiptIds.length
    ? await db
        .select({
          engagementReceiptId: engagementReceipts.engagementReceiptId,
          businessId: engagementReceipts.businessId,
          signalId: engagementReceipts.signalId,
          executedAt: engagementReceipts.executedAt,
        })
        .from(engagementReceipts)
        .where(
          and(
            eq(engagementReceipts.userId, userId),
            receiptIds.length === 1
              ? eq(engagementReceipts.engagementReceiptId, receiptIds[0])
              : inArray(engagementReceipts.engagementReceiptId, receiptIds)
          )
        )
    : [];
  const engagementReceiptsOut: EngagementReceiptSource[] = receiptRows.map((r) => ({
    engagementReceiptId: r.engagementReceiptId,
    businessId: Number(r.businessId),
    signalId: r.signalId,
    executedAt: r.executedAt,
  }));

  const signalKeys = [
    ...new Set(
      [
        ...opportunityEvidenceOut.map((e) => e.signalId),
        ...engagementReceiptsOut.map((r) => r.signalId),
        conversionProvenance?.sourceSignalId ?? null,
      ].filter((v): v is string => v !== null)
    ),
  ];
  const signalRows = signalKeys.length
    ? await db
        .select({
          signalKey: socialSignals.signalKey,
          businessId: socialSignals.businessId,
          occurredAt: socialSignals.occurredAt,
          sourceCampaignId: socialSignals.sourceCampaignId,
          sourcePublicationId: socialSignals.sourcePublicationId,
          attributionType: socialSignals.attributionType,
        })
        .from(socialSignals)
        .where(
          and(
            eq(socialSignals.userId, userId),
            signalKeys.length === 1
              ? eq(socialSignals.signalKey, signalKeys[0])
              : inArray(socialSignals.signalKey, signalKeys)
          )
        )
    : [];
  const signalsOut: SignalSource[] = signalRows.map((s) => ({
    signalKey: s.signalKey,
    businessId: s.businessId === null || s.businessId === undefined ? null : Number(s.businessId),
    occurredAt: toIso(s.occurredAt),
    sourceCampaignId:
      s.sourceCampaignId === null || s.sourceCampaignId === undefined ? null : Number(s.sourceCampaignId),
    sourcePublicationId: s.sourcePublicationId ?? null,
    attributionType: s.attributionType,
  }));

  const nurtureRows = lids.length
    ? await db
        .select({
          touchIdentity: nurtureTouchRecords.touchIdentity,
          leadId: nurtureTouchRecords.leadId,
          businessId: nurtureTouchRecords.businessId,
          touchedAt: nurtureTouchRecords.touchedAt,
        })
        .from(nurtureTouchRecords)
        .where(
          and(
            eq(nurtureTouchRecords.userId, userId),
            lids.length === 1
              ? eq(nurtureTouchRecords.leadId, lids[0])
              : inArray(nurtureTouchRecords.leadId, lids)
          )
        )
    : [];
  const nurtureTouchesOut: NurtureTouchSource[] = nurtureRows.map((t) => ({
    touchIdentity: t.touchIdentity,
    leadId: t.leadId,
    businessId: t.businessId === null || t.businessId === undefined ? null : Number(t.businessId),
    touchedAt: t.touchedAt,
  }));

  const handoffRows = lids.length
    ? await db
        .select({
          handoffId: salesHandoffs.handoffId,
          leadId: salesHandoffs.leadId,
          businessId: salesHandoffs.businessId,
          preparedAt: salesHandoffs.preparedAt,
        })
        .from(salesHandoffs)
        .where(
          and(
            eq(salesHandoffs.userId, userId),
            lids.length === 1
              ? eq(salesHandoffs.leadId, lids[0])
              : inArray(salesHandoffs.leadId, lids)
          )
        )
    : [];
  const salesHandoffsOut: SalesHandoffSource[] = handoffRows.map((h) => ({
    handoffId: h.handoffId,
    leadId: h.leadId,
    businessId: h.businessId === null || h.businessId === undefined ? null : Number(h.businessId),
    preparedAt: h.preparedAt,
  }));

  const campaignRefs = [
    ...new Set(
      [
        ...opportunities.map((o) => o.campaignId),
        ...identityProvenance.map((p) => p.campaignId),
        ...signalsOut
          .filter((s) => s.attributionType === "direct")
          .map((s) => s.sourceCampaignId),
        conversionProvenance?.sourceCampaignId ?? null,
      ].filter((v): v is number => v !== null)
    ),
  ];
  const campaignRows = campaignRefs.length
    ? await db
        .select({
          id: campaigns.id,
          businessId: campaigns.businessId,
          createdAt: campaigns.createdAt,
        })
        .from(campaigns)
        .where(
          and(
            eq(campaigns.userId, userId),
            campaignRefs.length === 1
              ? eq(campaigns.id, campaignRefs[0])
              : inArray(campaigns.id, campaignRefs)
          )
        )
    : [];
  const campaignsOut: CampaignSource[] = campaignRows.map((c) => ({
    id: Number(c.id),
    businessId: c.businessId === null || c.businessId === undefined ? null : Number(c.businessId),
    createdAt: toIso(c.createdAt),
  }));

  const queueRefs = [
    ...new Set(
      [
        conversionProvenance?.sourcePublicationId ?? null,
        ...signalsOut
          .filter((s) => s.attributionType === "direct" && s.sourcePublicationId !== null)
          .map((s) => parsePublicationOperationId(s.sourcePublicationId as string)),
      ].filter((v): v is number => v !== null)
    ),
  ];
  const queueRows = queueRefs.length
    ? await db
        .select({
          id: publishingQueue.id,
          publishedAt: publishingQueue.publishedAt,
        })
        .from(publishingQueue)
        .where(
          and(
            eq(publishingQueue.userId, userId),
            queueRefs.length === 1
              ? eq(publishingQueue.id, queueRefs[0])
              : inArray(publishingQueue.id, queueRefs)
          )
        )
    : [];
  const publicationQueueOut: PublicationQueueSource[] = queueRows.map((q) => ({
    id: Number(q.id),
    publishedAt: q.publishedAt === null || q.publishedAt === undefined ? null : toIso(q.publishedAt),
  }));

  return {
    conversionProvenance,
    identityProvenance,
    opportunities,
    opportunityEvidence: opportunityEvidenceOut,
    engagementReceipts: engagementReceiptsOut,
    signals: signalsOut,
    nurtureTouches: nurtureTouchesOut,
    salesHandoffs: salesHandoffsOut,
    campaigns: campaignsOut,
    publicationQueue: publicationQueueOut,
  };
}
