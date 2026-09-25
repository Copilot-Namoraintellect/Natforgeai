/**
 * Learning promotion service (WBS15.6) — governed promotion proposal lifecycle.
 *
 * proposeLearningPromotion binds one EXACT recommended adjustment from one
 * EXACT learning record into a durable, fingerprinted proposal:
 *
 * - The proposal is a pending approval_requests row whose context JSON carries
 *   the immutable coordinates + proposal fingerprint. Creation is idempotent
 *   via a fingerprint-derived unique idempotency key: an exact replay reuses
 *   the existing proposal; the same key with different material fails closed.
 * - One canonical approval_requested audit event is emitted per proposal,
 *   anchored to the learning record's evaluatedAt so replays are
 *   bit-identical (the audit store dedupes by fingerprint).
 * - This service performs NO approval decisions and NO BI/Strategy, Business
 *   DNA, Creative, Distribution or historical campaign/learning mutation.
 *   The only insert targets are approval_requests and audit_events.
 *
 * Approval and rejection happen exclusively through the Approval Centre
 * decision flow (api/approval-router.ts), which calls into
 * promotion-decision.ts for fail-closed binding validation and envelope
 * sealing. Future consumption goes through getApprovedPromotionEnvelopes,
 * the WBS15.7 consumption seam.
 */

import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { approvalRequests, auditEvents, learningRecords } from "@db/schema";
import { getDb } from "../../../queries/connection";
import { isMySqlDuplicateKeyError } from "../../billing/credit-engine";
import { persistAuditEvent } from "../../audit/audit-store";
import { createAuditEvent } from "../../audit/audit-event";
import {
  LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE,
  buildLearningPromotionContext,
  buildLearningPromotionIdempotencyKey,
  buildLearningPromotionProposalFingerprint,
  extractLearningPromotionContext,
  type LearningPromotionCoordinates,
} from "./promotion-contract";
import {
  envelopeMatchesContext,
  type ApprovedPromotionEnvelope,
} from "./promotion-envelope";
import type { EvidenceItem, RecommendedAdjustment } from "../contracts/learning-derivation";

type PromotionDb = ReturnType<typeof getDb>;

/**
 * Structural executor seam. The default getDb() client and a Drizzle
 * transaction callback client both satisfy this shape, so the Approval Centre
 * decision flow can run promotion work inside its own transaction.
 */
export interface LearningPromotionDbExecutor {
  select: PromotionDb["select"];
  insert: PromotionDb["insert"];
}

function resolveExecutor(executor?: LearningPromotionDbExecutor): LearningPromotionDbExecutor {
  return executor ?? getDb();
}

type LearningRecordRow = typeof learningRecords.$inferSelect;
type ApprovalRequestRow = typeof approvalRequests.$inferSelect;

function assertPositiveId(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${name} must be a positive integer` });
  }
}

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

interface LearningRecordParts {
  row: LearningRecordRow;
  provenance: {
    engine: string;
    engineVersion: string;
    inputDigest: string;
    evaluatedAt: string;
  };
  recommendations: RecommendedAdjustment[];
  evidence: EvidenceItem[];
}

function toRecordParts(row: LearningRecordRow): LearningRecordParts {
  const rawProvenance = parseJsonColumn<Record<string, unknown> | null>(row.provenance, null);
  const evaluatedAt =
    row.evaluatedAt instanceof Date ? row.evaluatedAt.toISOString() : String(row.evaluatedAt ?? "");
  return {
    row,
    provenance: {
      engine: typeof rawProvenance?.engine === "string" ? rawProvenance.engine : "",
      engineVersion:
        typeof rawProvenance?.engineVersion === "string" ? rawProvenance.engineVersion : "",
      inputDigest: typeof rawProvenance?.inputDigest === "string" ? rawProvenance.inputDigest : "",
      evaluatedAt,
    },
    recommendations: parseJsonColumn<RecommendedAdjustment[]>(row.recommendedAdjustments, []),
    evidence: parseJsonColumn<EvidenceItem[]>(row.evidence, []),
  };
}

async function loadLearningRecordParts(
  executor: LearningPromotionDbExecutor,
  userId: number,
  learningRecordId: number
): Promise<LearningRecordParts | null> {
  const [row] = await executor
    .select()
    .from(learningRecords)
    .where(and(eq(learningRecords.id, learningRecordId), eq(learningRecords.userId, userId)))
    .limit(1);
  return row ? toRecordParts(row) : null;
}

/** The material fields that bind a recommendation to its proposal. */
function recommendationMatchesCoordinates(
  rec: RecommendedAdjustment,
  coordinates: LearningPromotionCoordinates
): boolean {
  return (
    rec.id === coordinates.recommendationId &&
    rec.targetEngine === coordinates.targetEngine &&
    rec.adjustmentType === coordinates.adjustmentType &&
    rec.summary === coordinates.summary &&
    rec.rationale === coordinates.rationale &&
    JSON.stringify(rec.evidenceRefs) === JSON.stringify(coordinates.evidenceRefs)
  );
}

function buildCoordinates(
  parts: LearningRecordParts,
  rec: RecommendedAdjustment
): LearningPromotionCoordinates {
  return {
    learningRecordId: parts.row.id,
    campaignId: parts.row.campaignId,
    evaluationVersion: parts.row.evaluationVersion,
    learningEngine: parts.provenance.engine,
    learningEngineVersion: parts.provenance.engineVersion,
    learningInputDigest: parts.provenance.inputDigest,
    recommendationId: rec.id,
    targetEngine: rec.targetEngine,
    adjustmentType: rec.adjustmentType,
    summary: rec.summary,
    rationale: rec.rationale,
    evidenceRefs: [...rec.evidenceRefs],
  };
}

/** User-facing view of one promotion proposal. */
export interface LearningPromotionProposalView {
  approvalRequestId: number;
  status: string;
  userId: number;
  campaignId: number;
  learningRecordId: number;
  recommendationId: string;
  targetEngine: string;
  proposalFingerprint: string;
  idempotencyKey: string;
  coordinates: LearningPromotionCoordinates;
  title: string;
  description: string | null;
  aiRecommendation: string | null;
  riskLevel: string;
  createdAt: string;
}

function toProposalView(row: ApprovalRequestRow): LearningPromotionProposalView | null {
  const context = extractLearningPromotionContext(row.context);
  if (!context) return null;
  return {
    approvalRequestId: row.id,
    status: row.status,
    userId: row.userId,
    campaignId: row.campaignId ?? context.coordinates.campaignId,
    learningRecordId: context.coordinates.learningRecordId,
    recommendationId: context.coordinates.recommendationId,
    targetEngine: context.coordinates.targetEngine,
    proposalFingerprint: context.proposalFingerprint,
    idempotencyKey: row.idempotencyKey ?? "",
    coordinates: context.coordinates,
    title: row.title,
    description: row.description,
    aiRecommendation: row.aiRecommendation,
    riskLevel: row.riskLevel,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt ?? ""),
  };
}

export type ProposeLearningPromotionResult =
  | { outcome: "created"; proposal: LearningPromotionProposalView }
  | { outcome: "reused"; proposal: LearningPromotionProposalView };

function conflict(key: string, detail: string): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message: `learning promotion: idempotency key ${key} already exists with different material (${detail}). Refusing to reuse or overwrite it.`,
  });
}

/**
 * Propose promoting one exact recommendation of one exact learning record.
 * Idempotent: proposing the same exact recommendation reuses the durable
 * proposal; the same key with drifted material fails closed.
 */
export async function proposeLearningPromotion(input: {
  userId: number;
  learningRecordId: number;
  recommendationId: string;
  executor?: LearningPromotionDbExecutor;
}): Promise<ProposeLearningPromotionResult> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.learningRecordId, "learningRecordId");
  if (typeof input.recommendationId !== "string" || input.recommendationId.trim().length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "recommendationId must be a non-blank string",
    });
  }
  const executor = resolveExecutor(input.executor);

  const parts = await loadLearningRecordParts(executor, input.userId, input.learningRecordId);
  if (!parts) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Learning record not found" });
  }

  const rec =
    parts.recommendations.find((r) => r.id === input.recommendationId) ?? null;
  if (!rec) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Recommendation "${input.recommendationId}" is not present on learning record ${input.learningRecordId}`,
    });
  }

  // Fail closed: only governed recommendations (autoApply=false,
  // requiresApproval=true) may be proposed. Anything else indicates the
  // recommendation stream changed semantics under this stream.
  if (rec.governance?.autoApply !== false || rec.governance?.requiresApproval !== true) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Recommendation "${rec.id}" does not carry governed (requiresApproval) semantics; refusing to propose it`,
    });
  }

  const coordinates = buildCoordinates(parts, rec);
  const proposalFingerprint = buildLearningPromotionProposalFingerprint(coordinates);
  const idempotencyKey = buildLearningPromotionIdempotencyKey(proposalFingerprint);
  const context = buildLearningPromotionContext({ coordinates, proposalFingerprint });

  const materialSummary = `recommendation ${coordinates.recommendationId} of learning record ${coordinates.learningRecordId}`;

  const [existing] = await executor
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.idempotencyKey, idempotencyKey))
    .limit(1);
  if (existing) {
    const existingContext = extractLearningPromotionContext(existing.context);
    if (!existingContext || existingContext.proposalFingerprint !== proposalFingerprint) {
      throw conflict(idempotencyKey, materialSummary);
    }
    return { outcome: "reused", proposal: toProposalView(existing)! };
  }

  const title = `Learning Promotion (${rec.targetEngine}): ${rec.summary}`.slice(0, 255);
  const description =
    `Proposes promoting learning recommendation "${rec.id}" from learning record ${parts.row.id} ` +
    `(evaluationVersion ${parts.row.evaluationVersion}) of campaign ${parts.row.campaignId} for future ` +
    `BI/Strategy consumption. Approving seals a durable approved-evidence envelope; it does not modify ` +
    `existing Strategy snapshots, Business DNA, Creative, Distribution or historical campaign state.`;

  let approvalRequestId: number;
  try {
    const [result] = await executor
      .insert(approvalRequests)
      .values({
        userId: input.userId,
        campaignId: parts.row.campaignId,
        approvalType: LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE,
        title,
        description,
        aiRecommendation: `${rec.summary}\n\nRationale: ${rec.rationale}`,
        riskLevel: "medium",
        status: "pending",
        idempotencyKey,
        context,
      });
    approvalRequestId = Number((result as { insertId?: number | bigint }).insertId ?? 0);
  } catch (err) {
    if (!isMySqlDuplicateKeyError(err)) throw err;
    // Lost the create race: reuse the winner after the same conflict check.
    const [raced] = await executor
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.idempotencyKey, idempotencyKey))
      .limit(1);
    if (!raced) throw err;
    const racedContext = extractLearningPromotionContext(raced.context);
    if (!racedContext || racedContext.proposalFingerprint !== proposalFingerprint) {
      throw conflict(idempotencyKey, materialSummary);
    }
    return { outcome: "reused", proposal: toProposalView(raced)! };
  }

  // One canonical audit event per proposal. occurredAt is anchored to the
  // learning record's evaluatedAt so exact replays are bit-identical and the
  // audit store's fingerprint dedupe keeps this insert idempotent.
  const requestedEvent = createAuditEvent({
    eventType: "approval_requested",
    occurredAt: parts.provenance.evaluatedAt,
    userId: input.userId,
    source: "user",
    outcome: "succeeded",
    campaignId: parts.row.campaignId,
    businessId: null,
    approvalRequestId,
    workflowOperationId: null,
    workflowAttemptId: null,
    artifactId: null,
    packageId: null,
    contentId: null,
    metadata: {
      approvalType: LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE,
      campaignId: parts.row.campaignId,
      evaluationVersion: parts.row.evaluationVersion,
      learningEngineVersion: parts.provenance.engineVersion,
      learningInputDigest: parts.provenance.inputDigest,
      learningRecordId: parts.row.id,
      proposalFingerprint,
      promotionSource: "learning_promotion",
      recommendationId: rec.id,
      targetEngine: rec.targetEngine,
    },
  });
  await persistAuditEvent(requestedEvent, executor);

  const [inserted] = await executor
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalRequestId))
    .limit(1);

  const fallbackRow = {
    id: approvalRequestId,
    userId: input.userId,
    campaignId: parts.row.campaignId,
    approvalType: LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE,
    title,
    description,
    aiRecommendation: null,
    riskLevel: "medium",
    status: "pending",
    approvedAt: null,
    rejectedAt: null,
    idempotencyKey,
    context,
    createdAt: new Date(),
  } as unknown as ApprovalRequestRow;

  return {
    outcome: "created",
    proposal: toProposalView(inserted ?? fallbackRow)!,
  };
}

/** Lists every promotion proposal for a campaign, newest first. */
export async function listLearningPromotionProposals(input: {
  userId: number;
  campaignId: number;
  executor?: LearningPromotionDbExecutor;
}): Promise<LearningPromotionProposalView[]> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.campaignId, "campaignId");
  const executor = resolveExecutor(input.executor);

  const rows = await executor
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.userId, input.userId),
        eq(approvalRequests.campaignId, input.campaignId),
        eq(approvalRequests.approvalType, LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE)
      )
    )
    .orderBy(desc(approvalRequests.createdAt));

  return rows
    .map((row) => toProposalView(row))
    .filter((view): view is LearningPromotionProposalView => view !== null);
}

/** Fetches one promotion proposal owned by the user. */
export async function getLearningPromotionProposal(input: {
  userId: number;
  approvalRequestId: number;
  executor?: LearningPromotionDbExecutor;
}): Promise<LearningPromotionProposalView> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.approvalRequestId, "approvalRequestId");
  const executor = resolveExecutor(input.executor);

  const [row] = await executor
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.id, input.approvalRequestId),
        eq(approvalRequests.userId, input.userId)
      )
    )
    .limit(1);

  const view = row ? toProposalView(row) : null;
  if (!view) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Learning promotion proposal not found" });
  }
  return view;
}

/**
 * Fail-closed availability resolution for one approved approval row. The row
 * must be terminal-approved, its context fingerprint-bound, the sealed audit
 * envelope must exist and agree exactly with the context, and the live
 * learning record must still match the bound coordinates. Returns the
 * validated durable envelope, or null when any check fails.
 */
async function resolveApprovedEnvelopeForRow(input: {
  row: ApprovalRequestRow;
  userId: number;
  executor: LearningPromotionDbExecutor;
}): Promise<ApprovedPromotionEnvelope | null> {
  const { row, executor } = input;
  if (row.status !== "approved") return null;

  const context = extractLearningPromotionContext(row.context);
  if (!context) return null;
  const { coordinates } = context;

  const sealedRows = await executor
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.approvalRequestId, row.id),
        eq(auditEvents.eventType, "learning_promotion_resolved")
      )
    )
    .orderBy(desc(auditEvents.occurredAt));
  const sealed = sealedRows[0];
  if (!sealed) return null;

  const envelope = parseJsonColumn<ApprovedPromotionEnvelope | null>(sealed.metadata, null);
  if (!envelope) return null;
  if (!envelopeMatchesContext({ envelope, context, approvalRequestId: row.id })) return null;

  // Live-record revalidation: the learning authority the envelope cites must
  // still match the bound coordinates. Historical learning records are never
  // mutated by this stream, so a mismatch means tampering or derivation drift
  // and the envelope must not be consumed.
  const parts = await loadLearningRecordParts(executor, row.userId, coordinates.learningRecordId);
  if (!parts) return null;
  if (
    parts.row.id !== coordinates.learningRecordId ||
    parts.row.campaignId !== coordinates.campaignId ||
    parts.row.evaluationVersion !== coordinates.evaluationVersion ||
    parts.provenance.engine !== coordinates.learningEngine ||
    parts.provenance.engineVersion !== coordinates.learningEngineVersion ||
    parts.provenance.inputDigest !== coordinates.learningInputDigest
  ) {
    return null;
  }
  const rec = parts.recommendations.find((r) => r.id === coordinates.recommendationId) ?? null;
  if (!rec || !recommendationMatchesCoordinates(rec, coordinates)) return null;

  return envelope;
}

/**
 * WBS15.7 consumption seam. Returns every durable approved promotion envelope
 * for a campaign that passes fail-closed availability validation. Rejected or
 * pending proposals, tampered contexts, unsealed approvals and drifted
 * learning authority are all excluded.
 */
export async function getApprovedPromotionEnvelopes(input: {
  userId: number;
  campaignId: number;
  executor?: LearningPromotionDbExecutor;
}): Promise<ApprovedPromotionEnvelope[]> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.campaignId, "campaignId");
  const executor = resolveExecutor(input.executor);

  const rows = await executor
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.userId, input.userId),
        eq(approvalRequests.campaignId, input.campaignId),
        eq(approvalRequests.approvalType, LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE)
      )
    )
    .orderBy(desc(approvalRequests.createdAt));

  const envelopes: ApprovedPromotionEnvelope[] = [];
  for (const row of rows) {
    const envelope = await resolveApprovedEnvelopeForRow({ row, userId: input.userId, executor });
    if (envelope) envelopes.push(envelope);
  }
  return envelopes;
}
