import { z } from "zod";
import { createRouter, authedQuery, aiActionQuery } from "./middleware";
import { getDb } from "./queries/connection";
import {
  agentRuns,
  campaigns,
  businesses,
  socialProfiles,
  campaignInterestSignals,
  leadScores,
  outreachRecommendations,
  leads,
  leadActivities,
} from "@db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { runStrategyAgent } from "./lib/agents/strategy-agent";
import { runCreativeAgent } from "./lib/agents/creative-agent";
import { runDistributionAgent } from "./lib/agents/distribution-agent";
import { runAudienceAgent } from "./lib/agents/audience-agent";
import { runAudienceIntelligenceAgent } from "./lib/agents/audience-intelligence-agent";
import { ingestAudienceData } from "./lib/audience/ingest";
import { checkAudienceAgentAccess } from "./lib/audience/access";
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

      // Confidence / evidence gate: do not generate strategy from unvalidated website data.
      const evidence = (business.websiteEvidence || null) as {
        businessCategory?: string;
        productsServices?: string[];
        confidence?: number;
      } | null;
      const confidence = evidence?.confidence ?? 0;
      if (evidence && confidence < 0.6) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Website understanding is not confident enough to generate strategy. " +
            "Please confirm your business category and products/services in the business profile.",
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
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      if (existingRun.length > 0 && ["running", "completed"].includes(existingRun[0].status)) {
        // If completed but workflow wasn't advanced (e.g. onAgentRunComplete missed), trigger it now
        if (existingRun[0].status === "completed") {
          await onAgentRunComplete(existingRun[0].id);
        }
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
          websiteEvidence: business.websiteEvidence,
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

      // Deduplication guard — don't run if a creative agent is already running or genuinely completed
      const existingCreative = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, input.campaignId),
            eq(agentRuns.agentType, "creative"),
            eq(agentRuns.userId, ctx.user.id)
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      const workflowContext = (campaign.workflowContext || {}) as { savedPosts?: number } | undefined;
      const savedPosts = typeof workflowContext?.savedPosts === "number" ? workflowContext.savedPosts : null;
      const existingRun = existingCreative[0];
      const hasNoContent = savedPosts === 0;

      if (
        existingRun &&
        ((existingRun.status === "running") ||
          (existingRun.status === "completed" && !hasNoContent))
      ) {
        return {
          success: true,
          skipped: true,
          reason: `A creative agent run already exists with status "${existingRun.status}".`,
          packRunId: existingRun.id,
          assetsRunId: null,
          pack: null,
          assets: null,
          savedPosts: 0,
          savedAssets: 0,
        };
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

      // Trigger workflow advancement asynchronously so the HTTP response is fast
      Promise.resolve().then(() =>
        onAgentRunComplete(result.packRunId).catch((err) => {
          console.error("[AgentRouter] onAgentRunComplete failed:", err.message);
        })
      );

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

      // Deduplication guard
      const existingAudience = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, input.campaignId),
            eq(agentRuns.agentType, "audience"),
            eq(agentRuns.userId, ctx.user.id)
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      if (existingAudience.length > 0 && ["running", "completed"].includes(existingAudience[0].status)) {
        return {
          success: true,
          skipped: true,
          reason: `An audience agent run already exists with status "${existingAudience[0].status}".`,
          runId: existingAudience[0].id,
          output: existingAudience[0].output as any,
        };
      }

      const result = await runAudienceAgent({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        isB2B: input.isB2B,
      });

      // Trigger workflow advancement asynchronously
      Promise.resolve().then(() =>
        onAgentRunComplete(result.runId).catch((err) => {
          console.error("[AgentRouter] onAgentRunComplete failed:", err.message);
        })
      );

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

      // Deduplication guard
      const existingDist = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, input.campaignId),
            eq(agentRuns.agentType, "distribution"),
            eq(agentRuns.userId, ctx.user.id)
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      if (existingDist.length > 0 && ["running", "completed"].includes(existingDist[0].status)) {
        return {
          success: true,
          skipped: true,
          reason: `A distribution agent run already exists with status "${existingDist[0].status}".`,
          runId: existingDist[0].id,
          output: existingDist[0].output as any,
        };
      }

      const result = await runDistributionAgent({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        approvalMode: campaign.approvalMode as "assisted" | "autonomous",
      });

      // Trigger workflow advancement asynchronously
      Promise.resolve().then(() =>
        onAgentRunComplete(result.runId).catch((err) => {
          console.error("[AgentRouter] onAgentRunComplete failed:", err.message);
        })
      );

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

  runAudienceIntelligence: aiActionQuery
    .input(
      z.object({
        campaignId: z.number(),
        ingest: z.boolean().default(true),
        autoCreateLeads: z.boolean().default(false),
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

      // Tier / admin gate
      const access = await checkAudienceAgentAccess(ctx.user.id, ctx.user.role);
      if (!access.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: access.reason || "Audience Intelligence is not available on your plan.",
        });
      }

      // Deduplication guard
      const existingRun = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, input.campaignId),
            eq(agentRuns.agentType, "audience"),
            eq(agentRuns.userId, ctx.user.id),
            eq(agentRuns.status, "running")
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      if (existingRun.length > 0) {
        return {
          success: true,
          skipped: true,
          reason: "An audience intelligence run is already in progress.",
          runId: existingRun[0].id,
        };
      }

      // Ingest permissioned data
      let ingestionSummary: {
        profilesSynced: number;
        eventsSynced: number;
        signalsGenerated: number;
        warnings: string[];
      } = { profilesSynced: 0, eventsSynced: 0, signalsGenerated: 0, warnings: [] };

      if (input.ingest) {
        ingestionSummary = await ingestAudienceData({
          userId: ctx.user.id,
          businessId: campaign.businessId,
          campaignId: input.campaignId,
        });
      }

      // Run the agent
      const result = await runAudienceIntelligenceAgent({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        autoCreateLeads: input.autoCreateLeads,
      });

      return {
        success: true,
        runId: result.runId,
        output: result.output,
        createdLeadIds: result.createdLeadIds,
        ingestionSummary,
      };
    }),

  getAudienceIntelligence: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
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

      // Tier / admin gate: return locked state instead of crashing
      const access = await checkAudienceAgentAccess(ctx.user.id, ctx.user.role);
      if (!access.allowed) {
        return {
          campaign,
          latestRun: null,
          profiles: [],
          signals: [],
          scores: [],
          recommendations: [],
          createdLeads: [],
          locked: true,
          reason: access.reason || "Audience Intelligence is not available on your plan.",
        };
      }

      const [latestRun] = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, input.campaignId),
            eq(agentRuns.agentType, "audience"),
            eq(agentRuns.userId, ctx.user.id)
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      const profiles = await db
        .select()
        .from(socialProfiles)
        .where(
          and(
            eq(socialProfiles.userId, ctx.user.id),
            eq(socialProfiles.campaignId, input.campaignId)
          )
        );

      const signals = await db
        .select()
        .from(campaignInterestSignals)
        .where(
          and(
            eq(campaignInterestSignals.userId, ctx.user.id),
            eq(campaignInterestSignals.campaignId, input.campaignId)
          )
        )
        .orderBy(campaignInterestSignals.strength);

      const scores = await db
        .select()
        .from(leadScores)
        .where(
          and(
            eq(leadScores.userId, ctx.user.id),
            eq(leadScores.campaignId, input.campaignId)
          )
        )
        .orderBy(leadScores.score);

      const recommendations = await db
        .select()
        .from(outreachRecommendations)
        .where(
          and(
            eq(outreachRecommendations.userId, ctx.user.id),
            eq(outreachRecommendations.campaignId, input.campaignId)
          )
        )
        .orderBy(outreachRecommendations.priority);

      const createdLeadIds = scores.map((s) => s.leadId).filter(Boolean) as number[];
      const createdLeads = createdLeadIds.length
        ? await db
            .select()
            .from(leads)
            .where(
              and(
                eq(leads.userId, ctx.user.id),
                inArray(leads.id, createdLeadIds)
              )
            )
        : [];

      return {
        campaign,
        latestRun,
        profiles,
        signals,
        scores,
        recommendations,
        createdLeads,
      };
    }),

  acceptRecommendation: aiActionQuery
    .input(z.object({ recommendationId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [recommendation] = await db
        .select()
        .from(outreachRecommendations)
        .where(
          and(
            eq(outreachRecommendations.id, input.recommendationId),
            eq(outreachRecommendations.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!recommendation) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Recommendation not found" });
      }

      if (recommendation.acceptedAt) {
        return { success: true, leadId: recommendation.leadId };
      }

      const [score] = await db
        .select()
        .from(leadScores)
        .where(
          and(
            eq(leadScores.id, recommendation.leadScoreId),
            eq(leadScores.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!score) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Lead score not found" });
      }

      let leadId = recommendation.leadId;

      if (!leadId) {
        // Check for existing lead by external identifier
        const existing = await db
          .select()
          .from(leads)
          .where(
            and(
              eq(leads.userId, ctx.user.id),
              eq(leads.campaignId, recommendation.campaignId)
            )
          );

        const matched = existing.find(
          (l) =>
            (l.customFields as Record<string, unknown> | null)?.externalIdentifier ===
            score.externalIdentifier
        );

        if (matched) {
          leadId = matched.id;
        } else {
          const [insertResult] = await db.insert(leads).values({
            userId: ctx.user.id,
            businessId: recommendation.businessId,
            campaignId: recommendation.campaignId,
            name: score.displayName || score.handle || `Lead from ${score.platform}`,
            source: score.platform,
            score: score.score,
            status: "new",
            notes: score.explanation,
            customFields: {
              externalIdentifier: score.externalIdentifier,
              handle: score.handle,
              platform: score.platform,
              discoveredBy: "audience_intelligence_agent",
            },
          });
          leadId = Number(insertResult.insertId);

          await db.insert(leadActivities).values({
            leadId,
            type: "note",
            description: `Accepted from Audience Intelligence recommendation (score ${score.score}, confidence ${score.confidence}). ${score.explanation}`,
          });
        }
      }

      await db
        .update(outreachRecommendations)
        .set({ acceptedAt: new Date(), leadId })
        .where(eq(outreachRecommendations.id, recommendation.id));

      await db
        .update(leadScores)
        .set({ leadId })
        .where(eq(leadScores.id, score.id));

      return { success: true, leadId };
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
