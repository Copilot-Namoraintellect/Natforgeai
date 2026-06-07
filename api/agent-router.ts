import { z } from "zod";
import { createRouter, authedQuery, aiActionQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { agentRuns, campaigns, businesses } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { runStrategyAgent } from "./lib/agents/strategy-agent";
import { runCreativeAgent } from "./lib/agents/creative-agent";
import { runDistributionAgent } from "./lib/agents/distribution-agent";
import { runAudienceAgent } from "./lib/agents/audience-agent";
import { generateReply } from "./lib/agents/engagement-agent";
import { generateFollowUpSequence, generateProposal, generateMeetingPrompt } from "./lib/agents/sales-agent";
import { onAgentRunComplete } from "./lib/workflow/triggers";
import { transitionCampaignState } from "./lib/workflow/engine";
import { TRPCError } from "@trpc/server";

export const agentRouter = createRouter({
  runStrategyAgent: aiActionQuery
    .input(
      z.object({
        campaignId: z.number(),
        strategyText: z.string().optional(),
        generate: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      // Verify campaign ownership
      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, input.campaignId),
            eq(campaigns.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      // Get business info
      const [business] = campaign.businessId
        ? await db
            .select()
            .from(businesses)
            .where(eq(businesses.id, campaign.businessId))
            .limit(1)
        : [null];

      if (!business) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Campaign must be linked to a business",
        });
      }

      // Prevent duplicate strategy runs
      const blockedStates = [
        "strategy_generated",
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
      ];
      if (blockedStates.includes(campaign.workflowState)) {
        return {
          success: true,
          skipped: true,
          reason: `Strategy already generated. Campaign is in "${campaign.workflowState}" state.`,
          runId: null,
          output: null,
        };
      }

      // Check for existing running or completed strategy run
      const existingRun = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, input.campaignId),
            eq(agentRuns.agentType, "strategy"),
            eq(agentRuns.userId, ctx.user.id)
          )
        )
        .orderBy(agentRuns.createdAt)
        .limit(1);

      if (existingRun.length > 0 && ["running", "completed"].includes(existingRun[0].status)) {
        return {
          success: true,
          skipped: true,
          reason: `A strategy agent run already exists with status "${existingRun[0].status}".`,
          runId: existingRun[0].id,
          output: existingRun[0].output as any,
        };
      }

      // Run strategy agent
      const result = await runStrategyAgent({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        business: {
          name: business.name,
          industry: business.industry,
          location: business.location,
          productOrService: business.productOrService,
          targetCustomer: business.targetCustomer,
          brandTone: business.brandTone,
          mainGoal: business.mainGoal,
          monthlyBudget: business.monthlyBudget,
          preferredPlatforms: business.preferredPlatforms,
          website: business.website,
        },
        strategyText: input.strategyText,
      });

      // Trigger workflow advancement
      await onAgentRunComplete(result.runId);

      return { success: true, runId: result.runId, output: result.output };
    }),

  runCreativeAgent: aiActionQuery
    .input(
      z.object({
        campaignId: z.number(),
        assetTypes: z
          .array(
            z.enum([
              "image",
              "video_script",
              "carousel",
              "ad_copy",
              "caption",
              "hashtag_set",
              "cta_variant",
              "email_copy",
              "whatsapp_copy",
              "video_concept",
              "reel_script",
              "carousel_ad",
              "whatsapp_promo",
              "lead_gen_ad",
              "launch_pack",
            ])
          )
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, input.campaignId),
            eq(campaigns.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      // Transition campaign to creatives_generating before starting
      try {
        await transitionCampaignState(input.campaignId, ctx.user.id, "generate_creatives");
      } catch {
        // If transition fails (wrong current state), continue anyway and let the agent run
      }

      const result = await runCreativeAgent({
        userId: ctx.user.id,
        campaignId: input.campaignId,
      });

      try {
        await onAgentRunComplete(result.packRunId);
      } catch (err: any) {
        console.error("[AgentRouter] onAgentRunComplete failed:", err.message);
      }

      return { success: true, ...result };
    }),

  runAudienceAgent: aiActionQuery
    .input(
      z.object({
        campaignId: z.number(),
        isB2B: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, input.campaignId),
            eq(campaigns.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      const result = await runAudienceAgent({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        isB2B: input.isB2B,
      });

      await onAgentRunComplete(result.runId);

      return { success: true, ...result };
    }),

  runDistributionAgent: aiActionQuery
    .input(z.object({ campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, input.campaignId),
            eq(campaigns.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      const result = await runDistributionAgent({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        approvalMode: campaign.approvalMode as "assisted" | "autonomous",
      });

      await onAgentRunComplete(result.runId);

      return { success: true, ...result };
    }),

  runEngagementAgent: aiActionQuery
    .input(
      z.object({
        campaignId: z.number().optional(),
        threadId: z.number().optional(),
        messageText: z.string().optional(),
        platform: z.string().optional(),
        externalThreadId: z.string().optional(),
        businessName: z.string().optional(),
        productOrService: z.string().optional(),
        brandTone: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.threadId && input.messageText) {
        const result = await generateReply({
          userId: ctx.user.id,
          campaignId: input.campaignId || 0,
          threadId: input.threadId,
          messageText: input.messageText,
          platform: input.platform || "general",
          businessContext: {
            name: input.businessName || "Your Business",
            productOrService: input.productOrService,
            brandTone: input.brandTone,
          },
        });
        return { success: true, ...result };
      }

      return { success: false, message: "Provide threadId and messageText" };
    }),

  runSalesAgent: aiActionQuery
    .input(
      z.object({
        campaignId: z.number(),
        leadId: z.number(),
        action: z.enum(["follow_up", "proposal", "meeting"]).default("follow_up"),
        channel: z.enum(["email", "whatsapp", "sms"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.action === "follow_up") {
        const result = await generateFollowUpSequence({
          userId: ctx.user.id,
          campaignId: input.campaignId,
          leadId: input.leadId,
          channel: input.channel || "email",
        });
        return { success: true, ...result };
      }

      if (input.action === "proposal") {
        const result = await generateProposal({
          userId: ctx.user.id,
          campaignId: input.campaignId,
          leadId: input.leadId,
        });
        return { success: true, ...result };
      }

      if (input.action === "meeting") {
        const result = await generateMeetingPrompt({
          userId: ctx.user.id,
          campaignId: input.campaignId,
          leadId: input.leadId,
        });
        return { success: true, ...result };
      }

      return { success: false, message: "Unknown action" };
    }),

  runOptimisationAgent: aiActionQuery
    .input(z.object({ campaignId: z.number().optional() }))
    .mutation(async () => {
      // Stub for Phase 5
      return { success: false, message: "Optimisation Agent coming in Phase 5" };
    }),

  getAgentRuns: authedQuery
    .input(
      z
        .object({
          campaignId: z.number().optional(),
          agentType: z
            .enum([
              "strategy",
              "creative",
              "audience",
              "distribution",
              "engagement",
              "sales",
              "optimisation",
            ])
            .optional(),
          status: z.enum(["pending", "running", "completed", "failed"]).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      let query = db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.userId, ctx.user.id))
        .orderBy(desc(agentRuns.createdAt));

      // Note: Drizzle doesn't support dynamic WHERE chaining easily without query builder
      // For simplicity, we fetch all and filter in memory
      const results = await query;

      return results.filter((run) => {
        if (input?.campaignId && run.campaignId !== input.campaignId) return false;
        if (input?.agentType && run.agentType !== input.agentType) return false;
        if (input?.status && run.status !== input.status) return false;
        return true;
      });
    }),
});
