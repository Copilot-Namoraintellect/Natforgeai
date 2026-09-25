/**
 * Learning promotion decision hooks (WBS15.6).
 *
 * Integration seam used by the Approval Centre decision flow
 * (api/approval-router.ts executeApprovalDecision). The human decision itself
 * is recorded exclusively by the canonical guarded approval flow; these hooks
 * only:
 *
 * 1. validate, before any terminal mutation, that the pending request still
 *    binds the exact immutable proposal (fail closed on any coordinate,
 *    fingerprint or learning-authority drift, and on edited approvals, which
 *    would break the fingerprint binding); and
 *
 * 2. seal, inside the same decision transaction, the durable approved
 *    promotion envelope as an immutable learning_promotion_resolved audit
 *    event when (and only when) the decision is an approval.
 *
 * Rejections intentionally change nothing here: they mutate no BI/Strategy
 * authority, the proposal row remains as auditable evidence, and no envelope
 * is sealed, so the recommendation can never be consumed as approved.
 */

import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { approvalRequests, learningRecords } from "@db/schema";
import { getDb } from "../../../queries/connection";
import { persistAuditEvent } from "../../audit/audit-store";
import { createAuditEvent } from "../../audit/audit-event";
import {
  LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE,
  LEARNING_PROMOTION_CONTEXT_SOURCE,
  buildLearningPromotionProposalFingerprint,
  extractLearningPromotionContext,
  type LearningPromotionContext,
} from "./promotion-contract";
import {
  buildApprovedPromotionEnvelope,
  type ApprovedPromotionEnvelope,
} from "./promotion-envelope";
import type { EvidenceItem, RecommendedAdjustment } from "../contracts/learning-derivation";

type PromotionDb = ReturnType<typeof getDb>;

/** Structural executor seam; satisfied by both getDb() and a drizzle tx. */
export interface LearningPromotionDecisionExecutor {
  select: PromotionDb["select"];
  insert: PromotionDb["insert"];
}

type ApprovalRequestRow = typeof approvalRequests.$inferSelect;

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

/**
 * True only for approval rows this stream created: the carrier enum value AND
 * the learning_promotion context discriminator. The discriminator is the
 * authority — a bare carrier-type row is never treated as a promotion.
 *
 * Detection is intentionally looser than extractLearningPromotionContext: a
 * tampered context (coordinates changed so the stored fingerprint no longer
 * rebinds) must still be detected as a promotion row so the strict validation
 * in validateLearningPromotionApprovalBinding can fail closed instead of the
 * row silently decaying into a generic carrier-type approval.
 */
export function isLearningPromotionApproval(request: {
  approvalType: string;
  context: unknown;
}): boolean {
  if (request.approvalType !== LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE) return false;
  if (typeof request.context !== "object" || request.context === null) return false;
  return (
    (request.context as Record<string, unknown>).source === LEARNING_PROMOTION_CONTEXT_SOURCE
  );
}

function precondition(message: string): TRPCError {
  return new TRPCError({ code: "PRECONDITION_FAILED", message });
}

/**
 * Fail-closed binding validation for a pending learning promotion approval.
 * Must run BEFORE the terminal approval mutation. Re-checks every bound
 * coordinate against the live learning record and the proposal fingerprint:
 * any mismatch means the source learning changed or the proposal coordinates
 * no longer identify the recommendation being approved.
 *
 * Edited approvals are rejected outright: an edited payload would no longer
 * be the exact immutable proposal the fingerprint binds.
 */
export async function validateLearningPromotionApprovalBinding(input: {
  request: Pick<ApprovalRequestRow, "id" | "userId" | "approvalType" | "context">;
  decisionKind: "approve" | "reject" | "edit";
  executor: LearningPromotionDecisionExecutor;
}): Promise<void> {
  const { request, executor } = input;

  const context = extractLearningPromotionContext(request.context);
  if (!context) {
    throw precondition(
      `Learning promotion approval ${request.id} is missing its immutable proposal context.`
    );
  }

  if (input.decisionKind === "edit") {
    throw precondition(
      "Learning promotion approvals cannot be edited: an edited payload would break the exact proposal fingerprint binding. Approve or reject the proposal as-is."
    );
  }

  const { coordinates } = context;

  const [row] = await executor
    .select()
    .from(learningRecords)
    .where(
      and(eq(learningRecords.id, coordinates.learningRecordId), eq(learningRecords.userId, request.userId))
    )
    .limit(1);
  if (!row) {
    throw precondition(
      `Learning record ${coordinates.learningRecordId} bound to promotion approval ${request.id} is not available.`
    );
  }

  if (row.campaignId !== coordinates.campaignId) {
    throw precondition(
      `Promotion approval ${request.id}: bound campaign ${coordinates.campaignId} does not match the learning record's campaign ${row.campaignId}.`
    );
  }
  if (row.evaluationVersion !== coordinates.evaluationVersion) {
    throw precondition(
      `Promotion approval ${request.id}: bound evaluationVersion ${coordinates.evaluationVersion} does not match the learning record's ${row.evaluationVersion}.`
    );
  }

  const provenance = parseJsonColumn<Record<string, unknown> | null>(row.provenance, null);
  const engine = typeof provenance?.engine === "string" ? provenance.engine : "";
  const engineVersion = typeof provenance?.engineVersion === "string" ? provenance.engineVersion : "";
  const inputDigest = typeof provenance?.inputDigest === "string" ? provenance.inputDigest : "";
  if (
    engine !== coordinates.learningEngine ||
    engineVersion !== coordinates.learningEngineVersion ||
    inputDigest !== coordinates.learningInputDigest
  ) {
    throw precondition(
      `Promotion approval ${request.id}: the learning authority (engine/version/input digest) no longer matches the bound proposal.`
    );
  }

  const recommendations = parseJsonColumn<RecommendedAdjustment[]>(row.recommendedAdjustments, []);
  const rec = recommendations.find((r) => r.id === coordinates.recommendationId) ?? null;
  if (!rec) {
    throw precondition(
      `Promotion approval ${request.id}: recommendation ${coordinates.recommendationId} is no longer present on learning record ${coordinates.learningRecordId}.`
    );
  }

  const materialMismatch: string[] = [];
  if (rec.targetEngine !== coordinates.targetEngine) materialMismatch.push("targetEngine");
  if (rec.adjustmentType !== coordinates.adjustmentType) materialMismatch.push("adjustmentType");
  if (rec.summary !== coordinates.summary) materialMismatch.push("summary");
  if (rec.rationale !== coordinates.rationale) materialMismatch.push("rationale");
  if (JSON.stringify(rec.evidenceRefs) !== JSON.stringify(coordinates.evidenceRefs)) {
    materialMismatch.push("evidenceRefs");
  }
  if (materialMismatch.length > 0) {
    throw precondition(
      `Promotion approval ${request.id}: recommendation ${coordinates.recommendationId} content drifted (${materialMismatch.join(", ")}). The proposal no longer binds the recommendation.`
    );
  }

  const recomputed = buildLearningPromotionProposalFingerprint(coordinates);
  if (recomputed !== context.proposalFingerprint) {
    throw precondition(
      `Promotion approval ${request.id}: proposal fingerprint mismatch. The immutable proposal was altered.`
    );
  }
}

/**
 * Seal the durable approved promotion envelope inside the approval decision
 * transaction. The envelope is immutable audit evidence: the canonical
 * learning_promotion_resolved event, fingerprint-deduplicated by the audit
 * store. It never mutates Strategy snapshots, Business DNA, Creative,
 * Distribution, campaigns or learning records.
 */
export async function sealApprovedLearningPromotionEnvelope(input: {
  request: Pick<ApprovalRequestRow, "id" | "userId" | "campaignId" | "context">;
  decidedAt: Date;
  decidedByUserId: number;
  executor: LearningPromotionDecisionExecutor;
}): Promise<ApprovedPromotionEnvelope> {
  const { request, executor } = input;

  const context: LearningPromotionContext | null = extractLearningPromotionContext(request.context);
  if (!context) {
    throw precondition(
      `Learning promotion approval ${request.id} is missing its immutable proposal context; refusing to seal an envelope.`
    );
  }
  const { coordinates } = context;

  const [row] = await executor
    .select()
    .from(learningRecords)
    .where(
      and(eq(learningRecords.id, coordinates.learningRecordId), eq(learningRecords.userId, request.userId))
    )
    .limit(1);
  if (!row) {
    throw precondition(
      `Learning record ${coordinates.learningRecordId} bound to promotion approval ${request.id} is not available; refusing to seal an envelope.`
    );
  }
  const recordEvidence = parseJsonColumn<EvidenceItem[]>(row.evidence, []);

  const envelope = buildApprovedPromotionEnvelope({
    context,
    approvalRequestId: request.id,
    decidedAt: input.decidedAt.toISOString(),
    decidedByUserId: input.decidedByUserId,
    recordEvidence,
  });

  const sealedEvent = createAuditEvent({
    eventType: "learning_promotion_resolved",
    occurredAt: input.decidedAt.toISOString(),
    userId: input.decidedByUserId,
    source: "user",
    outcome: "succeeded",
    campaignId: request.campaignId ?? coordinates.campaignId,
    businessId: null,
    approvalRequestId: request.id,
    workflowOperationId: null,
    workflowAttemptId: null,
    artifactId: null,
    packageId: null,
    contentId: null,
    metadata: { ...envelope },
  });
  await persistAuditEvent(sealedEvent, executor);

  return envelope;
}
