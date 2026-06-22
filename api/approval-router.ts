import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { approvalRequests, campaigns, contentPosts } from "@db/schema";
import { eq, and, desc, count } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { onApprovalResolved } from "./lib/workflow/triggers";
import { createApprovalRequest } from "./lib/workflow/engine";

const beyondStrategyReviewStates = new Set([
  "strategy_approved",
  "creatives_generating",
  "creatives_ready",
  "audience_generating",
  "audience_ready",
  "schedule_generated",
  "launch_approval_required",
  "campaign_live",
  "engagement_active",
  "leads_converting",
  "optimisation_active",
  "completed",
]);

async function repairStaleApprovals(userId: number) {
  const db = getDb();

  // Find pending strategy approvals for campaigns that have already moved beyond strategy review
  const stale = await db
    .select({ id: approvalRequests.id, campaignId: approvalRequests.campaignId })
    .from(approvalRequests)
    .innerJoin(campaigns, eq(approvalRequests.campaignId, campaigns.id))
    .where(
      and(
        eq(approvalRequests.userId, userId),
        eq(approvalRequests.approvalType, "strategy_review"),
        eq(approvalRequests.status, "pending"),
        eq(campaigns.userId, userId)
      )
    );

  for (const row of stale) {
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, row.campaignId!), eq(campaigns.userId, userId)))
      .limit(1);

    if (!campaign) continue;

    // If campaign has moved beyond strategy review, auto-resolve the stale pending approval
    if (beyondStrategyReviewStates.has(campaign.workflowState)) {
      await db
        .update(approvalRequests)
        .set({
          status: "approved",
          approvedAt: new Date(),
          description: `Auto-resolved: campaign workflow state is now ${campaign.workflowState}.`,
        })
        .where(eq(approvalRequests.id, row.id));
      console.log(`[ApprovalRepair] Auto-resolved stale strategy approval ${row.id} for campaign ${row.campaignId} (state=${campaign.workflowState})`);
      continue;
    }

    // If campaign already has content posts, auto-resolve stale strategy approval
    const [contentCount] = await db
      .select({ value: count() })
      .from(contentPosts)
      .where(and(eq(contentPosts.campaignId, row.campaignId!), eq(contentPosts.aiGenerated, true)));

    if (contentCount && contentCount.value > 0) {
      await db
        .update(approvalRequests)
        .set({
          status: "approved",
          approvedAt: new Date(),
          description: `Auto-resolved: campaign already has ${contentCount.value} generated content posts.`,
        })
        .where(eq(approvalRequests.id, row.id));
      console.log(`[ApprovalRepair] Auto-resolved stale strategy approval ${row.id} for campaign ${row.campaignId} (contentCount=${contentCount.value})`);
    }
  }
}

async function syncPendingApprovals(userId: number) {
  const db = getDb();

  // First, auto-resolve any stale pending approvals
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

    // Repair missing campaign_launch approvals
    if (state === "launch_approval_required") {
      const alreadyApproved = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.campaignId, campaign.id),
            eq(approvalRequests.userId, userId),
            eq(approvalRequests.approvalType, "campaign_launch"),
            eq(approvalRequests.status, "approved")
          )
        )
        .limit(1);

      if (alreadyApproved.length > 0) {
        continue;
      }

      const existingPending = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.campaignId, campaign.id),
            eq(approvalRequests.userId, userId),
            eq(approvalRequests.approvalType, "campaign_launch"),
            eq(approvalRequests.status, "pending")
          )
        )
        .limit(1);

      if (existingPending.length === 0) {
        await createApprovalRequest({
          userId,
          campaignId: campaign.id,
          approvalType: "campaign_launch",
          title: `Approve Launch: ${campaign.name}`,
          description: `The campaign "${campaign.name}" is ready to launch. All strategy, creative, audience, and schedule assets have been generated.`,
          aiRecommendation: "Based on the generated strategy and content, this campaign is ready to go live. Expected reach aligns with budget allocation.",
          riskLevel: "low",
        });
      }
    }
  }
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
      const db = getDb();

      const [request] = await db
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

      await db
        .update(approvalRequests)
        .set({
          status: "approved",
          approvedAt: new Date(),
          description: input.notes
            ? `${request.description || ""}\n\nApproval notes: ${input.notes}`
            : request.description,
        })
        .where(eq(approvalRequests.id, input.approvalId));

      // Resume workflow through the trigger system — fire asynchronously so the HTTP
      // response returns immediately and does not wait for long-running agent chains.
      Promise.resolve().then(() =>
        onApprovalResolved(input.approvalId, "approved", ctx.user.id).catch((err) => {
          console.error(`[Approval] Async workflow trigger failed for approval ${input.approvalId}:`, err.message);
        })
      );

      return { success: true, campaignId: request.campaignId, approvalType: request.approvalType };
    }),

  rejectAction: authedQuery
    .input(
      z.object({
        approvalId: z.number(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [request] = await db
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

      await db
        .update(approvalRequests)
        .set({
          status: "rejected",
          rejectedAt: new Date(),
          description: input.notes
            ? `${request.description || ""}\n\nRejection reason: ${input.notes}`
            : request.description,
        })
        .where(eq(approvalRequests.id, input.approvalId));

      // Resume workflow through the trigger system — fire asynchronously so the HTTP
      // response returns immediately and does not wait for long-running agent chains.
      Promise.resolve().then(() =>
        onApprovalResolved(input.approvalId, "rejected", ctx.user.id).catch((err) => {
          console.error(`[Approval] Async workflow trigger failed for approval ${input.approvalId}:`, err.message);
        })
      );

      return { success: true, campaignId: request.campaignId, approvalType: request.approvalType };
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
      const db = getDb();

      const [request] = await db
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

      await db
        .update(approvalRequests)
        .set({
          status: "edited",
          approvedAt: new Date(),
          description: input.notes
            ? `${request.description || ""}\n\nEdited by user: ${JSON.stringify(input.editedPayload)}\n\nNotes: ${input.notes}`
            : `${request.description || ""}\n\nEdited by user: ${JSON.stringify(input.editedPayload)}`,
        })
        .where(eq(approvalRequests.id, input.approvalId));

      // Resume workflow through the trigger system — fire asynchronously so the HTTP
      // response returns immediately and does not wait for long-running agent chains.
      Promise.resolve().then(() =>
        onApprovalResolved(input.approvalId, "approved", ctx.user.id).catch((err) => {
          console.error(`[Approval] Async workflow trigger failed for approval ${input.approvalId}:`, err.message);
        })
      );

      return { success: true, campaignId: request.campaignId, approvalType: request.approvalType };
    }),
});
