import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { approvalRequests, campaigns, businesses, socialIntegrations, agentRuns, strategySnapshots } from "@db/schema";
import { eq, and, or, desc, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { onApprovalResolved } from "./lib/workflow/triggers";
import { createApprovalRequest } from "./lib/workflow/engine";
import { createAuditEvent } from "./lib/audit/audit-event";
import { persistAuditEvent } from "./lib/audit/audit-store";
import {
  isLearningPromotionApproval,
  sealApprovedLearningPromotionEnvelope,
  validateLearningPromotionApprovalBinding,
} from "./lib/learning/promotion/promotion-decision";
import {
  getStrategyApprovalStatus,
  isLineageAuthoritative,
  validateStrategyRunForCampaign,
  isStrategySnapshotAuthorityMatch,
} from "./lib/workflow/strategy-approval";
import {
  getLaunchApprovalStatus,
  buildLaunchApprovalLineage,
  isLaunchApprovalEvidenceUsable,
  readLaunchApprovalLineage,
  type LaunchApprovalLineage,
} from "./lib/workflow/launch-approval";

type ApprovalDb = ReturnType<typeof getDb>;

/**
 * Structural executor seam for approval decision work (WBS7C2). The default
 * getDb() client and a Drizzle transaction callback client both satisfy this
 * shape. Decision-flow call sites always pass their transaction executor so
 * transaction-owned reads and writes never escape to the global connection.
 */
interface ApprovalDbExecutor {
  select: ApprovalDb["select"];
  insert: ApprovalDb["insert"];
  update: ApprovalDb["update"];
}

/**
 * Validate that a pending strategy_review approval can still be authorised.
 * Authorisation requires a durable lineage in workflowContext that links the
 * approval request, strategy run and brief fingerprint. A mismatch means the
 * strategy is stale and approving it would ground creatives in an out-of-date
 * brief.
 */
async function validateStrategyApprovalLineage(
  approval: {
    id: number;
    campaignId: number | null;
    userId: number;
  },
  executor: ApprovalDbExecutor
) {
  if (!approval.campaignId) return;

  const db = executor;
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, approval.campaignId), eq(campaigns.userId, approval.userId)))
    .limit(1);

  if (!campaign) return;

  const [business] = campaign.businessId
    ? await db
        .select()
        .from(businesses)
        .where(and(eq(businesses.id, campaign.businessId), eq(businesses.userId, approval.userId)))
        .limit(1)
    : [null];

  const status = getStrategyApprovalStatus(campaign, business);
  if (!status.lineage) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This approval request is not linked to a recorded strategy lineage. Regenerate the strategy for approval.",
    });
  }

  if (status.lineage.approvalRequestId !== approval.id) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This approval request is not the current strategy approval request. Review the pending request created for the current brief.",
    });
  }

  if (
    !isLineageAuthoritative(campaign, {
      strategyRunId: status.lineage.strategyRunId,
      approvalRequestId: approval.id,
    }, business)
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "The campaign brief has changed since this strategy was generated. Regenerate the strategy for approval before authorising creative work.",
    });
  }

  const [run] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, status.lineage.strategyRunId),
        eq(agentRuns.campaignId, approval.campaignId),
        eq(agentRuns.userId, approval.userId),
        eq(agentRuns.agentType, "strategy")
      )
    )
    .limit(1);

  if (!run || run.status !== "completed") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "The strategy run linked to this approval request is missing or not complete. Regenerate the strategy for approval.",
    });
  }

  const [strategySnapshot] = await db
    .select()
    .from(strategySnapshots)
    .where(
      eq(
        strategySnapshots.strategyRunId,
        status.lineage.strategyRunId
      )
    )
    .limit(1);

  if (
    !strategySnapshot ||
    !isStrategySnapshotAuthorityMatch(
      status.lineage,
      strategySnapshot,
      approval.userId,
      Number(approval.campaignId),
      campaign.businessId
    )
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "The strategy approval lineage does not match the immutable Strategy snapshot. Regenerate the strategy for approval.",
    });
  }

  const semanticValidation = await validateStrategyRunForCampaign(campaign, approval.userId, run, business);
  if (!semanticValidation.valid) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `The strategy linked to this approval no longer matches the current campaign brief: ${semanticValidation.reason}. Regenerate the strategy for approval.`,
    });
  }
}

/**
 * G-04 fail-closed invariant: no code path may convert a pending or rejected
 * campaign_launch approval into an approval decision. Approval authority must
 * come from an explicit human decision recorded through approveAction /
 * editAndApproveAction only.
 *
 * Previously this function auto-resolved stale pending launch approvals to
 * "approved" whenever the campaign workflow state had advanced or AI content
 * existed — silently converting governed launch approval into machine
 * approval. Both behaviours have been removed. A stale pending request is
 * left pending for a human decision; the only permitted repair is recreation
 * of a MISSING pending request (see repairMissingLaunchApproval in
 * syncPendingApprovals), which restores the ask without fabricating the
 * answer.
 */
async function repairStaleApprovals(_userId: number) {
  // Intentionally a no-op: kept as the documented seam for approval-repair
  // bookkeeping so the fail-closed contract is explicit at the call site.
}

/**
 * Validate that a pending campaign_launch approval can still be authorised.
 * Authorisation requires a durable launch lineage in workflowContext that
 * links this exact approval request to the current campaign brief
 * fingerprint. A mismatch means the request is stale: authorising it would
 * launch a campaign on an out-of-date brief.
 */
async function validateLaunchApprovalLineage(
  approval: {
    id: number;
    campaignId: number | null;
    userId: number;
  },
  executor: ApprovalDbExecutor
) {
  if (!approval.campaignId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This launch approval request is not linked to a campaign.",
    });
  }

  const db = executor;
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, approval.campaignId), eq(campaigns.userId, approval.userId)))
    .limit(1);

  if (!campaign) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The campaign for this launch approval no longer exists.",
    });
  }

  const [business] = campaign.businessId
    ? await db
        .select()
        .from(businesses)
        .where(and(eq(businesses.id, campaign.businessId), eq(businesses.userId, approval.userId)))
        .limit(1)
    : [null];

  const status = getLaunchApprovalStatus(campaign, business);
  if (!status.lineage) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This launch approval request is not linked to a recorded launch approval lineage. Recreate the pending launch request for the current campaign brief.",
    });
  }

  if (status.lineage.approvalRequestId !== approval.id) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This launch approval request is not the current launch approval request. Review the pending request created for the current brief.",
    });
  }

  if (status.lineage.creativeBriefFingerprint !== status.currentFingerprint) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "The campaign brief has changed since this launch approval was requested. Recreate the launch approval for the current brief.",
    });
  }
}

async function persistLaunchApprovalLineage(
  campaignId: number,
  existingContext: Record<string, unknown> | null | undefined,
  creativeBriefFingerprint: string,
  approvalRequestId: number,
  status: LaunchApprovalLineage["status"],
  executor: ApprovalDbExecutor
) {
  const db = executor;
  await db
    .update(campaigns)
    .set({
      workflowContext: {
        ...(existingContext || {}),
        launchApprovalLineage: buildLaunchApprovalLineage(
          creativeBriefFingerprint,
          approvalRequestId,
          status
        ),
      } as any,
    })
    .where(eq(campaigns.id, campaignId));
}

/**
 * Persist the resolved launch lineage after an explicit human decision so the
 * durable record reflects the terminal state of the request.
 */
async function persistResolvedLaunchApprovalLineage(
  request: { id: number; campaignId: number | null; userId: number; approvalType: string },
  decision: "approved" | "rejected",
  executor: ApprovalDbExecutor
) {
  if (request.approvalType !== "campaign_launch" || !request.campaignId) return;

  const db = executor;
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, request.campaignId), eq(campaigns.userId, request.userId)))
    .limit(1);

  if (!campaign) return;

  const existing = readLaunchApprovalLineage((campaign.workflowContext || {}) as Record<string, unknown>);
  const creativeBriefFingerprint =
    existing?.creativeBriefFingerprint ?? getLaunchApprovalStatus(campaign).currentFingerprint;

  await persistLaunchApprovalLineage(
    campaign.id,
    (campaign.workflowContext || {}) as Record<string, unknown>,
    creativeBriefFingerprint,
    request.id,
    decision,
    executor
  );
}

/**
 * Repair a MISSING campaign_launch approval request for a campaign that needs
 * one. Fail closed:
 * - explicit approval evidence is reused only when lineage and campaign
 *   context still match (isLaunchApprovalEvidenceUsable);
 * - an existing pending request is adopted into the lineage (safe bookkeeping
 *   that links the ask to the current brief — never a decision);
 * - a rejected request is preserved as evidence and never repaired into an
 *   approval; a fresh pending request is created for a new human decision.
 */
async function repairMissingLaunchApproval(
  campaign: {
    id: number;
    userId: number;
    name: string;
    platforms: string | null;
    businessId: number | null;
    workflowContext: unknown;
    createdAt?: Date | string | null;
  },
  userId: number,
  opts: { requireConnectedAutoPlatform: boolean }
) {
  const db = getDb();

  if (opts.requireConnectedAutoPlatform) {
    const campaignPlatforms = (campaign.platforms || "")
      .split(/[,;]+/)
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    const autoPublishPlatforms = ["facebook", "instagram", "linkedin", "twitter", "tiktok", "email"];

    const hasAutoPublishPlatform = campaignPlatforms.some((p) => autoPublishPlatforms.includes(p));
    if (!hasAutoPublishPlatform) return;

    const campaignBusinessId = campaign.businessId ?? null;
    const businessFilter =
      campaignBusinessId == null
        ? isNull(socialIntegrations.businessId)
        : or(isNull(socialIntegrations.businessId), eq(socialIntegrations.businessId, campaignBusinessId));

    const connectedIntegrations = await db
      .select()
      .from(socialIntegrations)
      .where(and(eq(socialIntegrations.userId, userId), eq(socialIntegrations.status, "connected"), businessFilter));

    const connectedPlatforms = new Set(connectedIntegrations.map((i) => i.platform));
    const hasConnectedAutoPlatform = campaignPlatforms.some(
      (p) => autoPublishPlatforms.includes(p) && connectedPlatforms.has(p as any)
    );

    if (!hasConnectedAutoPlatform) return;
  }

  const launchRows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.campaignId, campaign.id),
        eq(approvalRequests.userId, userId),
        eq(approvalRequests.approvalType, "campaign_launch")
      )
    );

  const [business] = campaign.businessId
    ? await db
        .select()
        .from(businesses)
        .where(and(eq(businesses.id, campaign.businessId), eq(businesses.userId, userId)))
        .limit(1)
    : [null];

  const status = getLaunchApprovalStatus(campaign, business);
  const fingerprint = status.currentFingerprint;

  // Reuse explicit approval evidence only when lineage and campaign context
  // still match. A bare approved row without corroborating lineage is never
  // sufficient authority.
  const hasUsableApproval = launchRows.some(
    (row) =>
      (row.status === "approved" || row.status === "edited") &&
      isLaunchApprovalEvidenceUsable(campaign, row, business)
  );
  if (hasUsableApproval) return;

  const pendingRows = launchRows
    .filter((row) => row.status === "pending")
    .sort(
      (a, b) =>
        new Date((b as any).createdAt || 0).getTime() - new Date((a as any).createdAt || 0).getTime()
    );

  // Adopt the most recent pending request into the durable lineage. This only
  // links the existing human-asked request to the current brief fingerprint;
  // it does not fabricate an approval decision.
  if (pendingRows.length > 0) {
    const latest = pendingRows[0];
    const lineage = status.lineage;
    if (
      !lineage ||
      lineage.approvalRequestId !== latest.id ||
      lineage.creativeBriefFingerprint !== fingerprint ||
      lineage.status !== "pending"
    ) {
      await persistLaunchApprovalLineage(
        campaign.id,
        (campaign.workflowContext || {}) as Record<string, unknown>,
        fingerprint,
        latest.id,
        "pending",
        db
      );
      console.log(`[ApprovalRepair] Linked pending launch approval ${latest.id} to current brief for campaign ${campaign.id}`);
    }
    return;
  }

  // No pending request exists: recreate one so a human decision can be made.
  // Any rejected request remains untouched as historical evidence.
  const { id } = await createApprovalRequest({
    userId,
    campaignId: campaign.id,
    approvalType: "campaign_launch",
    title: `Approve Launch: ${campaign.name}`,
    description: `The campaign "${campaign.name}" is ready to launch. Review and approve the launch to publish to connected channels.`,
    aiRecommendation: "All strategy and creative assets are ready. Approve the launch to go live.",
    riskLevel: "low",
  });
  await persistLaunchApprovalLineage(
    campaign.id,
    (campaign.workflowContext || {}) as Record<string, unknown>,
    fingerprint,
    id,
    "pending",
    db
  );
  console.log(`[ApprovalRepair] Recreated missing pending launch approval ${id} for campaign ${campaign.id}`);
}

async function syncPendingApprovals(userId: number) {
  const db = getDb();

  // G-04: stale approvals are never auto-resolved (fail closed). The seam is
  // kept explicitly so no future "repair" reintroduces fabricated decisions.
  await repairStaleApprovals(userId);

  // Find campaigns that should have pending approvals but don't
  const stuckCampaigns = await db
    .select()
    .from(campaigns)
    .where(
      and(
        eq(campaigns.userId, userId),
        eq(campaigns.aiGenerated, true)
      )
    );

  for (const campaign of stuckCampaigns) {
    const state = campaign.workflowState;

    // Repair missing strategy_review approvals (only if still at strategy_generated)
    if (state === "strategy_generated") {
      // Check if there is already an approved/edited approval for this campaign.
      const alreadyResolved = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.campaignId, campaign.id),
            eq(approvalRequests.userId, userId),
            eq(approvalRequests.approvalType, "strategy_review"),
            eq(approvalRequests.status, "approved")
          )
        )
        .limit(1);

      if (alreadyResolved.length > 0) {
        continue;
      }

      const alreadyEdited = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.campaignId, campaign.id),
            eq(approvalRequests.userId, userId),
            eq(approvalRequests.approvalType, "strategy_review"),
            eq(approvalRequests.status, "edited")
          )
        )
        .limit(1);

      if (alreadyEdited.length > 0) {
        continue;
      }

      const existingPending = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.campaignId, campaign.id),
            eq(approvalRequests.userId, userId),
            eq(approvalRequests.approvalType, "strategy_review"),
            eq(approvalRequests.status, "pending")
          )
        )
        .limit(1);

      if (existingPending.length === 0) {
        await createApprovalRequest({
          userId,
          campaignId: campaign.id,
          approvalType: "strategy_review",
          title: `Approve Strategy: ${campaign.name}`,
          description: `The strategy for "${campaign.name}" has been generated. Review and approve to continue to creative content generation.`,
          aiRecommendation: "Based on the campaign goal and target audience, this strategy aligns with best practices for the selected platforms.",
          riskLevel: "low",
        });
      }
    }

    // Repair missing campaign_launch approvals. Reuse of explicit approval
    // evidence is lineage-gated; missing pending requests are recreated
    // without ever fabricating an approval decision.
    if (state === "launch_approval_required") {
      await repairMissingLaunchApproval(campaign, userId, { requireConnectedAutoPlatform: false });
    }

    // Repair missing campaign_launch approvals for campaigns that are content-ready
    // but still in the creatives_ready state (e.g. Campaign #23). Only applies when
    // a connected auto-publish platform exists.
    if (state === "creatives_ready") {
      await repairMissingLaunchApproval(campaign, userId, { requireConnectedAutoPlatform: true });
    }
  }
}

type ApprovalDecisionKind = "approve" | "reject" | "edit";

interface ApprovalDecisionResult {
  success: true;
  campaignId: number | null;
  approvalType: string;
}

/**
 * Execute one explicit human approval decision as a single atomic database
 * unit (WBS7C2): the authoritative approval-request terminal mutation, any
 * campaign-launch lineage terminalisation, and exactly one canonical
 * approval_resolved audit event all commit or roll back together.
 *
 * The terminal mutation is guarded (id + userId + status='pending') and
 * verified by affected rows: exactly one competing decision can win, a loser
 * fails closed after rereading through the same transaction, and an
 * already-terminal human decision is never overwritten or re-audited.
 *
 * onApprovalResolved is scheduled only after the transaction commits; the
 * audit event records the human decision, not downstream workflow outcome.
 */
async function executeApprovalDecision(
  ctx: { user: { id: number } },
  input: {
    approvalId: number;
    notes?: string;
    editedPayload?: Record<string, unknown>;
  },
  kind: ApprovalDecisionKind
): Promise<ApprovalDecisionResult> {
  const db = getDb();

  const decision = await db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.id, input.approvalId),
          eq(approvalRequests.userId, ctx.user.id)
        )
      )
      .limit(1);

    if (!request) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Approval request not found" });
    }

    if (request.status !== "pending") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Approval request is already ${request.status}`,
      });
    }

    if (kind !== "reject" && request.approvalType === "strategy_review") {
      await validateStrategyApprovalLineage(
        {
          id: request.id,
          campaignId: request.campaignId,
          userId: ctx.user.id,
        },
        tx
      );
    }

    if (kind !== "reject" && request.approvalType === "campaign_launch") {
      await validateLaunchApprovalLineage(
        {
          id: request.id,
          campaignId: request.campaignId,
          userId: ctx.user.id,
        },
        tx
      );
    }

    // WBS15.6: a learning promotion approval binds one exact immutable
    // proposal. Fail closed before any terminal mutation when the source
    // learning record or recommendation no longer matches the bound
    // coordinates, and never allow edited approvals (they would break the
    // proposal fingerprint binding).
    if (kind !== "reject" && isLearningPromotionApproval(request)) {
      await validateLearningPromotionApprovalBinding(
        { request, decisionKind: kind, executor: tx }
      );
    }

    // ONE decision timestamp, shared by the approval row and the audit event.
    const decidedAt = new Date();

    const setPayload =
      kind === "approve"
        ? {
            status: "approved" as const,
            approvedAt: decidedAt,
            description: input.notes
              ? `${request.description || ""}\n\nApproval notes: ${input.notes}`
              : request.description,
          }
        : kind === "reject"
          ? {
              status: "rejected" as const,
              rejectedAt: decidedAt,
              description: input.notes
                ? `${request.description || ""}\n\nRejection reason: ${input.notes}`
                : request.description,
            }
          : {
              status: "edited" as const,
              approvedAt: decidedAt,
              description: input.notes
                ? `${request.description || ""}\n\nEdited by user: ${JSON.stringify(input.editedPayload)}\n\nNotes: ${input.notes}`
                : `${request.description || ""}\n\nEdited by user: ${JSON.stringify(input.editedPayload)}`,
            };

    const updateResult = await tx
      .update(approvalRequests)
      .set(setPayload)
      .where(
        and(
          eq(approvalRequests.id, input.approvalId),
          eq(approvalRequests.userId, ctx.user.id),
          eq(approvalRequests.status, "pending")
        )
      );

    // MySQL2 returns [ResultSetHeader, ...] where affectedRows is on the first element.
    const affectedRows = (updateResult as any)?.[0]?.affectedRows ?? 0;
    if (affectedRows === 0) {
      // A competing decision won the terminal mutation between the pre-check
      // read and this write. Reread through the SAME tx, fail closed with the
      // existing terminal/request semantics, and emit no audit evidence.
      const [current] = await tx
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.id, input.approvalId),
            eq(approvalRequests.userId, ctx.user.id)
          )
        )
        .limit(1);
      if (!current) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Approval request not found" });
      }
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Approval request is already ${current.status}`,
      });
    }

    const semanticDecision = kind === "reject" ? "rejected" : "approved";

    await persistResolvedLaunchApprovalLineage(request, semanticDecision, tx);

    let businessId: number | null = null;
    if (request.campaignId) {
      const [campaign] = await tx
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.id, request.campaignId), eq(campaigns.userId, ctx.user.id)))
        .limit(1);
      businessId = campaign?.businessId ?? null;
    }

    const auditEvent = createAuditEvent({
      eventType: "approval_resolved",
      occurredAt: decidedAt.toISOString(),
      userId: ctx.user.id,
      source: "user",
      outcome: "succeeded",
      campaignId: request.campaignId,
      businessId,
      approvalRequestId: request.id,
      workflowOperationId: null,
      workflowAttemptId: null,
      artifactId: null,
      packageId: null,
      contentId: null,
      metadata: {
        approvalType: request.approvalType,
        decision: semanticDecision,
        resolutionMode: kind === "edit" ? "edited" : "direct",
      },
    });

    await persistAuditEvent(auditEvent, tx);

    // WBS15.6: approval seals the durable approved promotion envelope in the
    // same transaction as the decision. Rejections seal nothing: a rejected
    // proposal remains auditable evidence and is never consumable.
    if (kind === "approve" && isLearningPromotionApproval(request)) {
      await sealApprovedLearningPromotionEnvelope({
        request,
        decidedAt,
        decidedByUserId: ctx.user.id,
        executor: tx,
      });
    }

    return {
      success: true as const,
      campaignId: request.campaignId,
      approvalType: request.approvalType,
    };
  });

  // Resume workflow through the trigger system — only after the decision
  // transaction has committed, and fire asynchronously so the HTTP response
  // returns immediately and does not wait for long-running agent chains.
  Promise.resolve().then(() =>
    onApprovalResolved(input.approvalId, kind === "reject" ? "rejected" : "approved", ctx.user.id).catch(
      (err) => {
        console.error(
          `[Approval] Async workflow trigger failed for approval ${input.approvalId}:`,
          err.message
        );
      }
    )
  );

  return decision;
}

export const approvalRouter = createRouter({
  listApprovals: authedQuery
    .input(
      z
        .object({
          status: z.enum(["pending", "approved", "rejected", "edited"]).optional(),
          campaignId: z.number().optional(),
          riskLevel: z.enum(["low", "medium", "high"]).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      try {
        const db = getDb();

        // Repair missing approvals for stuck campaigns before listing
        await syncPendingApprovals(ctx.user.id);

        const results = await db
          .select()
          .from(approvalRequests)
          .where(eq(approvalRequests.userId, ctx.user.id))
          .orderBy(desc(approvalRequests.createdAt));

        return results.filter((req) => {
          if (input?.status && req.status !== input.status) return false;
          if (input?.campaignId && req.campaignId !== input.campaignId) return false;
          if (input?.riskLevel && req.riskLevel !== input.riskLevel) return false;
          return true;
        });
      } catch (err: any) {
        console.error("[approval.listApprovals] Query failed:", err.message);
        return [];
      }
    }),

  approveAction: authedQuery
    .input(
      z.object({
        approvalId: z.number(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return executeApprovalDecision(ctx, input, "approve");
    }),

  rejectAction: authedQuery
    .input(
      z.object({
        approvalId: z.number(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return executeApprovalDecision(ctx, input, "reject");
    }),

  editAndApproveAction: authedQuery
    .input(
      z.object({
        approvalId: z.number(),
        editedPayload: z.record(z.string(), z.any()),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return executeApprovalDecision(ctx, input, "edit");
    }),
});
