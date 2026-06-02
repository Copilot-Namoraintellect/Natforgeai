import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { campaigns, businesses, approvalRequests, agentRuns } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { checkLimit, incrementCampaignUsage } from "./lib/subscription";
import { transitionCampaignState, getWorkflowState } from "./lib/workflow/engine";

export const autonomousWorkflowRouter = createRouter({
  startCampaignWorkflow: authedQuery
    .input(
      z.object({
        businessId: z.number(),
        name: z.string().min(1),
        goal: z.string().min(1),
        strategyText: z.string().optional(),
        approvalMode: z.enum(["assisted", "autonomous"]).default("assisted"),
        autoPublish: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      // Check campaign limit
      const campaignCheck = await checkLimit(ctx.user.id, "campaign");
      if (!campaignCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: campaignCheck.reason!,
        });
      }

      // Verify business ownership
      const [business] = await db
        .select()
        .from(businesses)
        .where(and(eq(businesses.id, input.businessId), eq(businesses.userId, ctx.user.id)))
        .limit(1);

      if (!business) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Business not found" });
      }

      // Create campaign with workflow state
      const [camp] = await db.insert(campaigns).values({
        userId: ctx.user.id,
        businessId: input.businessId,
        name: input.name,
        goal: input.goal,
        status: "draft",
        workflowState: "strategy_pending",
        workflowContext: {
          startedAt: new Date().toISOString(),
          strategyText: input.strategyText,
        } as any,
        approvalMode: input.approvalMode,
        autoPublish: input.autoPublish,
        aiGenerated: true,
      });

      await incrementCampaignUsage(ctx.user.id);

      const campaignId = Number(camp.insertId);

      // If strategy text provided, auto-trigger strategy agent
      if (input.strategyText) {
        // This will be triggered by the frontend or a background job
        // For now, we just set the state
      }

      return { id: campaignId, success: true };
    }),

  pauseCampaignWorkflow: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await transitionCampaignState(input.campaignId, ctx.user.id, "pause");
      return { success: true };
    }),

  resumeCampaignWorkflow: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await transitionCampaignState(input.campaignId, ctx.user.id, "resume");
      return { success: true };
    }),

  getWorkflowStatus: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();

      const workflow = await getWorkflowState(input.campaignId, ctx.user.id);

      // Get pending approvals
      const pendingApprovals = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.campaignId, input.campaignId),
            eq(approvalRequests.userId, ctx.user.id),
            eq(approvalRequests.status, "pending")
          )
        )
        .orderBy(desc(approvalRequests.createdAt));

      // Get recent agent runs
      const recentRuns = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, input.campaignId),
            eq(agentRuns.userId, ctx.user.id)
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(10);

      return {
        ...workflow,
        pendingApprovals,
        recentAgentRuns: recentRuns,
      };
    }),
});
