import { z } from "zod";
import { generateObject } from "ai";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { campaigns, businesses, agentRuns } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { checkLimit, incrementCampaignUsage, incrementResultUsage } from "./lib/subscription";
import { TRPCError } from "@trpc/server";
import { defaultModel } from "./lib/agents/openai";
import { runStrategyAgent } from "./lib/agents/strategy-agent";
import { onAgentRunComplete } from "./lib/workflow/triggers";

export const campaignRouter = createRouter({
  list: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    return db
      .select()
      .from(campaigns)
      .where(eq(campaigns.userId, ctx.user.id))
      .orderBy(desc(campaigns.createdAt));
  }),

  get: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const [camp] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, input.id),
            eq(campaigns.userId, ctx.user.id)
          )
        );
      return camp ?? null;
    }),

  create: authedQuery
    .input(
      z.object({
        name: z.string().min(1),
        goal: z.string().min(1),
        businessId: z.number().optional(),
        targetAudience: z.string().optional(),
        coreMessage: z.string().optional(),
        platforms: z.string().optional(),
        budget: z.number().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        strategy: z.string().optional(),
        personas: z.any().optional(),
        contentCalendar: z.any().optional(),
        adConcepts: z.any().optional(),
        funnelStages: z.any().optional(),
        offers: z.any().optional(),
        ctaStrategy: z.string().optional(),
        aiGenerated: z.boolean().optional(),
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

      // Determine onboarding status and auto-link business
      let businessId = input.businessId;
      let isOnboarded = ctx.user.onboardingComplete ?? false;

      if (!businessId) {
        const [biz] = await db
          .select()
          .from(businesses)
          .where(eq(businesses.userId, ctx.user.id))
          .orderBy(desc(businesses.createdAt))
          .limit(1);
        if (biz) {
          businessId = biz.id;
          if (biz.onboardingComplete) isOnboarded = true;
        }
      } else {
        const [biz] = await db
          .select()
          .from(businesses)
          .where(and(eq(businesses.id, businessId), eq(businesses.userId, ctx.user.id)))
          .limit(1);
        if (biz && biz.onboardingComplete) isOnboarded = true;
      }

      const workflowState = isOnboarded ? "strategy_pending" : "business_onboarding";

      const data: any = {
        userId: ctx.user.id,
        businessId: businessId ?? null,
        name: input.name,
        goal: input.goal,
        targetAudience: input.targetAudience,
        coreMessage: input.coreMessage,
        platforms: input.platforms,
        budget: input.budget,
        strategy: input.strategy,
        personas: input.personas,
        contentCalendar: input.contentCalendar,
        adConcepts: input.adConcepts,
        funnelStages: input.funnelStages,
        offers: input.offers,
        ctaStrategy: input.ctaStrategy,
        aiGenerated: input.aiGenerated ?? isOnboarded,
        workflowState,
      };
      if (input.startDate) data.startDate = new Date(input.startDate);
      if (input.endDate) data.endDate = new Date(input.endDate);
      const [camp] = await db.insert(campaigns).values(data);
      const campaignId = Number(camp.insertId);

      // Increment campaign usage
      await incrementCampaignUsage(ctx.user.id);

      // Auto-start Strategy Agent for onboarded businesses
      if (workflowState === "strategy_pending" && businessId) {
        Promise.resolve().then(async () => {
          try {
            const [business] = await db
              .select()
              .from(businesses)
              .where(eq(businesses.id, businessId))
              .limit(1);

            if (!business) return;

            // Deduplication guard
            const existing = await db
              .select()
              .from(agentRuns)
              .where(
                and(
                  eq(agentRuns.campaignId, campaignId),
                  eq(agentRuns.agentType, "strategy")
                )
              )
              .orderBy(agentRuns.createdAt)
              .limit(1);

            if (existing.length > 0 && ["running", "completed"].includes(existing[0].status)) {
              console.log(`[CampaignCreate] Strategy agent already ${existing[0].status} for campaign ${campaignId}`);
              if (existing[0].status === "completed") {
                await onAgentRunComplete(existing[0].id);
              }
              return;
            }

            const result = await runStrategyAgent({
              userId: ctx.user.id,
              campaignId,
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
            });

            await onAgentRunComplete(result.runId);
          } catch (err: any) {
            console.error(`[CampaignCreate] Strategy agent failed for campaign ${campaignId}:`, err.message);
          }
        });
      }

      return { id: campaignId, success: true, workflowState };
    }),

  improveBrief: authedQuery
    .input(
      z.object({
        name: z.string().optional(),
        goal: z.string().optional(),
        targetAudience: z.string().optional(),
        platforms: z.string().optional(),
        budget: z.number().optional(),
        coreMessage: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const briefParts = [
          input.name ? `Campaign Name: ${input.name}` : "",
          input.goal ? `Objective: ${input.goal}` : "",
          input.targetAudience ? `Target Audience: ${input.targetAudience}` : "",
          input.platforms ? `Platforms: ${input.platforms}` : "",
          input.budget ? `Budget: $${input.budget}` : "",
          input.coreMessage ? `Core Message: ${input.coreMessage}` : "",
        ].filter(Boolean);

        if (briefParts.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Please fill in at least one field before improving.",
          });
        }

        const schema = z.object({
          name: z.string().describe("Improved campaign name, punchy and clear"),
          goal: z.string().describe("Refined campaign objective with metric if possible"),
          targetAudience: z.string().describe("Sharper target audience description"),
          platforms: z.string().describe("Recommended platforms as a comma-separated list"),
          budget: z.number().describe("Suggested estimated marketing spend in USD"),
          coreMessage: z.string().describe("Compelling core message or offer"),
        });

        const result = await generateObject({
          model: defaultModel,
          system:
            "You are a senior marketing strategist. Improve the campaign brief below. Keep the same language and tone. Be concise and actionable.",
          prompt: briefParts.join("\n"),
          schema,
        });

        return { success: true, suggestions: result.object };
      } catch (err: any) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err.message || "Failed to improve brief. Please try again.",
        });
      }
    }),

  update: authedQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        goal: z.string().optional(),
        status: z.enum(["draft", "active", "paused", "completed"]).optional(),
        targetAudience: z.string().optional(),
        coreMessage: z.string().optional(),
        platforms: z.string().optional(),
        budget: z.number().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        strategy: z.string().optional(),
        personas: z.any().optional(),
        contentCalendar: z.any().optional(),
        adConcepts: z.any().optional(),
        funnelStages: z.any().optional(),
        offers: z.any().optional(),
        ctaStrategy: z.string().optional(),
        workflowState: z.enum([
          "business_onboarding",
          "strategy_pending",
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
        ]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, ...rawData } = input;

      // Check if status is changing to completed
      if (rawData.status === "completed") {
        const [current] = await db
          .select()
          .from(campaigns)
          .where(and(eq(campaigns.id, id), eq(campaigns.userId, ctx.user.id)))
          .limit(1);

        if (current && current.status !== "completed") {
          // Check result limit before allowing completion
          const resultCheck = await checkLimit(ctx.user.id, "result");
          if (!resultCheck.allowed) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: resultCheck.reason!,
            });
          }
          await incrementResultUsage(ctx.user.id);
        }
      }

      const data: any = { ...rawData };
      if (input.startDate) data.startDate = new Date(input.startDate);
      if (input.endDate) data.endDate = new Date(input.endDate);
      await db
        .update(campaigns)
        .set(data)
        .where(
          and(eq(campaigns.id, id), eq(campaigns.userId, ctx.user.id))
        );
      return { success: true };
    }),

  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db
        .delete(campaigns)
        .where(
          and(
            eq(campaigns.id, input.id),
            eq(campaigns.userId, ctx.user.id)
          )
        );
      return { success: true };
    }),
});
