import { z } from "zod";
import { generateObject } from "ai";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { campaigns, businesses, agentRuns, contentPosts, campaignAssets, approvalRequests } from "@db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { checkLimit, incrementCampaignUsage, incrementResultUsage } from "./lib/subscription";
import { TRPCError } from "@trpc/server";
import { defaultModel } from "./lib/agents/openai";
import {
  runStrategyAgent,
  chargeForStrategyRun,
  validateStrategyOutputAgainstCampaign,
  isSuccessfulStrategyOutput,
  type StrategyAgentRunResult,
} from "./lib/agents/strategy-agent";
import { runCreativeAgent } from "./lib/agents/creative-agent";
import { onAgentRunComplete } from "./lib/workflow/triggers";
import { transitionCampaignState, createApprovalRequest } from "./lib/workflow/engine";
import {
  getStrategyApprovalStatus,
  buildStrategyApprovalLineage,
  validateStrategyRunForCampaign,
  assertApprovedStrategySemanticallyValid,
} from "./lib/workflow/strategy-approval";
import {
  acquireCreativeGenerationClaim,
  attachCreativeGenerationOperationReference,
  generateOwnerToken,
  releaseClaimWithResult,
  calculateLeaseExpiresAt,
  createClaimHeartbeatController,
  type CreativeGenerationClaim,
  type CreativeGenerationClaimHeartbeatController,
} from "./lib/creative/creative-generation-claim";
import { env } from "./lib/env";
import { refundCredits } from "./lib/billing/credit-engine";
import { getEstimatedAgentCost } from "./lib/billing/cost-tracker";

function campaignSuggestionSchema() {
  return z.object({
    name: z.string().nullable().describe("Improved campaign name, punchy and clear"),
    goal: z.string().nullable().describe("Refined campaign objective with metric if possible"),
    targetAudience: z.string().nullable().describe("Sharper target audience description"),
    platforms: z.string().nullable().describe("Recommended platforms as a comma-separated list"),
    budget: z.number().nullable().describe("Suggested estimated marketing spend in USD"),
    coreMessage: z.string().nullable().describe("Compelling core message or offer"),
    primaryOutcome: z.string().nullable().describe("Single primary outcome"),
    targetBuyer: z.string().nullable().describe("Sharper target buyer description"),
    mainPainPoint: z.string().nullable().describe("Specific main pain point"),
    productOrService: z.string().nullable().describe("Product/service being promoted"),
    offerDetails: z.string().nullable().describe("Offer if any; null if none"),
    preferredCta: z.string().nullable().describe("Recommended CTA"),
    excludedOffers: z.string().nullable().describe("Phrases or offers to avoid"),
    referenceStyle: z.string().nullable().describe("Reference style or example"),
    contentStyle: z.string().nullable().describe("Preferred content style"),
  });
}

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

  strategyApprovalStatus: authedQuery
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
        )
        .limit(1);

      if (!camp) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      const status = getStrategyApprovalStatus(camp);
      let isApprovedStrategyCurrent = status.isCurrent;
      let isStale = false;
      let reason: string | undefined;

      // A fingerprint match is not enough: the lineage-linked strategy output
      // must also be semantically grounded in the current brief. If it is not,
      // report the strategy as stale so the UI offers regeneration instead of
      // generation from an unsafe approved strategy.
      if (status.lineage) {
        const semantic = await validateStrategyRunForCampaign(camp, ctx.user.id);
        if (!semantic.valid) {
          isApprovedStrategyCurrent = false;
          isStale = true;
          reason = semantic.reason;
        }
      }

      // Derive authoritative client flags from the validated status. The server
      // decides whether content generation is safe and whether regeneration is
      // required; the client must not infer semantic validity itself.
      const current = isApprovedStrategyCurrent;
      const approved = status.lineage?.status === "approved" && !isStale;
      const canGenerateContent = current && approved;
      const canRegenerateStrategy = isStale || (!current && status.lineage != null);

      return {
        isApprovedStrategyCurrent,
        hasApprovedStrategy: status.hasApprovedStrategy,
        currentFingerprint: status.currentFingerprint,
        approvedStrategyFingerprint: status.approvedStrategyFingerprint,
        strategyFingerprint: status.strategyFingerprint,
        isStale,
        reason,
        current,
        approved,
        stale: isStale,
        canGenerateContent,
        canRegenerateStrategy,
      };
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
        // Campaign brief precision
        primaryOutcome: z.string().optional(),
        targetBuyer: z.string().optional(),
        mainPainPoint: z.string().optional(),
        productOrService: z.string().optional(),
        offerDetails: z.string().optional(),
        preferredCta: z.string().optional(),
        excludedOffers: z.string().optional(),
        referenceStyle: z.string().optional(),
        contentStyle: z.string().optional(),
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
        primaryOutcome: input.primaryOutcome,
        targetBuyer: input.targetBuyer,
        mainPainPoint: input.mainPainPoint,
        productOrService: input.productOrService,
        offerDetails: input.offerDetails,
        preferredCta: input.preferredCta,
        excludedOffers: input.excludedOffers,
        referenceStyle: input.referenceStyle,
        contentStyle: input.contentStyle,
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

            // Confidence / evidence gate before auto-starting strategy
            const evidence = (business.websiteEvidence || null) as {
              businessCategory?: string;
              productsServices?: string[];
              confidence?: number;
            } | null;
            if (evidence && (evidence.confidence ?? 0) < 0.6) {
              console.log(`[CampaignCreate] Strategy auto-start blocked: low website confidence for campaign ${campaignId}`);
              return;
            }

            // Fingerprint-aware deduplication: reuse a completed strategy run whose
            // brief fingerprint matches the current campaign brief. Historical runs
            // are preserved.
            const currentFingerprint = getStrategyApprovalStatus({ ...input, id: campaignId }).currentFingerprint;
            const previousRuns = await db
              .select()
              .from(agentRuns)
              .where(
                and(
                  eq(agentRuns.campaignId, campaignId),
                  eq(agentRuns.agentType, "strategy")
                )
              )
              .orderBy(desc(agentRuns.createdAt));

            const reusableRun = previousRuns.find((run) => {
              if (run.status !== "completed") return false;
              if (!isSuccessfulStrategyOutput(run.output)) return false;
              return run.output.creativeBriefFingerprint === currentFingerprint;
            });

            if (reusableRun) {
              console.log(`[CampaignCreate] Reusing completed strategy run ${reusableRun.id} with matching fingerprint for campaign ${campaignId}`);
              await onAgentRunComplete(reusableRun.id);
              return;
            }

            const activeRun = previousRuns.find((run) => run.status === "running");
            if (activeRun) {
              console.log(`[CampaignCreate] Strategy agent already running for campaign ${campaignId}`);
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
                websiteEvidence: business.websiteEvidence,
              },
              campaignBrief: {
                name: input.name,
                goal: input.goal,
                targetAudience: input.targetAudience,
                coreMessage: input.coreMessage,
                platforms: input.platforms,
                budget: input.budget,
                primaryOutcome: input.primaryOutcome,
                targetBuyer: input.targetBuyer,
                mainPainPoint: input.mainPainPoint,
                productOrService: input.productOrService,
                offerDetails: input.offerDetails,
                preferredCta: input.preferredCta,
                excludedOffers: input.excludedOffers,
                referenceStyle: input.referenceStyle,
                contentStyle: input.contentStyle,
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

  parseIntent: authedQuery
    .input(
      z.object({
        intent: z.string().min(1, "Describe what you want to promote or achieve."),
        targetAudience: z.string().optional(),
        offer: z.string().optional(),
        platforms: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const db = getDb();
        const [business] = await db
          .select()
          .from(businesses)
          .where(eq(businesses.userId, ctx.user.id))
          .orderBy(desc(businesses.createdAt))
          .limit(1);

        const evidence = business?.websiteEvidence as {
          businessCategory?: string;
          productsServices?: string[];
          targetCustomers?: string[];
          location?: string;
        } | undefined;

        const promptParts = [
          `Campaign intent: ${input.intent}`,
          input.targetAudience ? `Target audience hint: ${input.targetAudience}` : "",
          input.offer ? `Offer hint: ${input.offer}` : "",
          input.platforms ? `Preferred platforms hint (preserve these): ${input.platforms}` : "",
          business
            ? `Business context:\n- Name: ${business.name}\n- Industry: ${business.industry || "N/A"}\n- Location: ${business.location || evidence?.location || "N/A"}\n- Product/Service: ${business.productOrService || "N/A"}\n- Target customer: ${business.targetCustomer || "N/A"}\n- Brand tone: ${business.brandTone || "N/A"}\n- Monthly budget: ${business.monthlyBudget || "N/A"}`
            : "",
          evidence
            ? `Website evidence (ground truth):\n- Category: ${evidence.businessCategory || "N/A"}\n- Products/Services: ${(evidence.productsServices || []).join(", ") || "N/A"}\n- Target Customers: ${(evidence.targetCustomers || []).join(", ") || "N/A"}\n- CRITICAL: Only suggest products/services and platforms that match this evidence. Do not introduce SEO, digital marketing, social media management, data analytics, restaurant, salon, or consulting services unless they are explicitly listed.`
            : "",
        ].filter(Boolean);

        const schema = campaignSuggestionSchema();

        const result = await generateObject({
          model: defaultModel,
          system:
            "You are a senior marketing strategist. Turn the user's free-form campaign intent into a complete, concise campaign brief. Keep the same language and tone as the user. If no offer is provided, do not invent discounts, free trials or limited-time offers. Use neutral CTAs. Return null for any field you cannot infer confidently. Only suggest products/services and platforms grounded in the website evidence. Preserve the user's preferred platforms if provided.",
          prompt: promptParts.join("\n"),
          schema,
        });

        return { success: true, suggestions: result.object };
      } catch (err: any) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err.message || "Failed to build campaign brief. Please try again.",
        });
      }
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
        primaryOutcome: z.string().optional(),
        targetBuyer: z.string().optional(),
        mainPainPoint: z.string().optional(),
        productOrService: z.string().optional(),
        offerDetails: z.string().optional(),
        preferredCta: z.string().optional(),
        excludedOffers: z.string().optional(),
        referenceStyle: z.string().optional(),
        contentStyle: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const db = getDb();
        const [business] = await db
          .select()
          .from(businesses)
          .where(eq(businesses.userId, ctx.user.id))
          .orderBy(desc(businesses.createdAt))
          .limit(1);

        const evidence = business?.websiteEvidence as {
          businessCategory?: string;
          productsServices?: string[];
          targetCustomers?: string[];
          location?: string;
        } | undefined;

        const briefParts = [
          input.name ? `Campaign Name: ${input.name}` : "",
          input.goal ? `Objective: ${input.goal}` : "",
          input.primaryOutcome ? `Primary Outcome: ${input.primaryOutcome}` : "",
          input.targetBuyer ? `Target Buyer: ${input.targetBuyer}` : (input.targetAudience ? `Target Audience: ${input.targetAudience}` : ""),
          input.mainPainPoint ? `Main Pain Point: ${input.mainPainPoint}` : "",
          input.productOrService ? `Product/Service: ${input.productOrService}` : "",
          input.platforms ? `Platforms (preserve these): ${input.platforms}` : "",
          evidence
            ? `Website evidence (ground truth):\n- Category: ${evidence.businessCategory || "N/A"}\n- Products/Services: ${(evidence.productsServices || []).join(", ") || "N/A"}\n- Target Customers: ${(evidence.targetCustomers || []).join(", ") || "N/A"}\n- CRITICAL: Only suggest products/services and platforms that match this evidence. Do not introduce unsupported services.`
            : "",
          input.budget ? `Budget: $${input.budget}` : "",
          input.coreMessage ? `Core Message: ${input.coreMessage}` : "",
          input.offerDetails ? `Offer: ${input.offerDetails}` : "",
          input.preferredCta ? `Preferred CTA: ${input.preferredCta}` : "",
          input.excludedOffers ? `Do NOT say: ${input.excludedOffers}` : "",
          input.referenceStyle ? `Reference Style: ${input.referenceStyle}` : "",
          input.contentStyle ? `Preferred Content Style: ${input.contentStyle}` : "",
        ].filter(Boolean);

        if (briefParts.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Please fill in at least one field before improving.",
          });
        }

        const schema = campaignSuggestionSchema();

        const result = await generateObject({
          model: defaultModel,
          system:
            "You are a senior marketing strategist. Improve the campaign brief below. Keep the same language and tone. Be concise and actionable. If no offer is provided, do not invent discounts, free trials or limited-time offers. Use neutral CTAs. Return null for any field you cannot improve confidently. Preserve the user's selected platforms. Only suggest products/services grounded in the website evidence.",
          prompt: briefParts.join("\n"),
          schema,
        });

        // Fallback: preserve existing user-entered values when AI returns null or missing fields
        const suggestions: Record<string, any> = {};
        const raw = result.object as Record<string, any>;
        for (const [key, value] of Object.entries(input)) {
          const aiValue = raw[key];
          if (aiValue === null || aiValue === undefined || aiValue === "") {
            suggestions[key] = value ?? null;
          } else {
            suggestions[key] = aiValue;
          }
        }

        return { success: true, suggestions };
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
        primaryOutcome: z.string().optional(),
        targetBuyer: z.string().optional(),
        mainPainPoint: z.string().optional(),
        productOrService: z.string().optional(),
        offerDetails: z.string().optional(),
        preferredCta: z.string().optional(),
        excludedOffers: z.string().optional(),
        referenceStyle: z.string().optional(),
        contentStyle: z.string().optional(),
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

  regenerateFromProfile: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { campaignId } = input;
      const { id: userId } = ctx.user;

      console.log(`[regenerateFromProfile] route entered | campaignId=${campaignId} | userId=${userId}`);

      let strategyRunId: number | null = null;
      let creativeRunId: number | null = null;
      let claim: CreativeGenerationClaim | null = null;
      let ownerToken: string | null = null;
      let released = false;
      let heartbeatController: CreativeGenerationClaimHeartbeatController | undefined;

      const releaseClaimOnce = async (status: "completed" | "failed") => {
        if (released || !claim || !ownerToken) return { released: true } as const;
        released = true;
        if (heartbeatController) {
          await heartbeatController.stop();
        }
        return releaseClaimWithResult({
          claimId: claim.id,
          ownerToken,
          status,
          context: "campaignRouter.regenerateFromProfile",
        });
      };

      try {
        // 1. Load campaign
        const [campaign] = await db
          .select()
          .from(campaigns)
          .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
          .limit(1);

        if (!campaign) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
        }
        console.log(`[regenerateFromProfile] campaign loaded | campaignId=${campaignId} | businessId=${campaign.businessId}`);

        if (!campaign.businessId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Campaign is not linked to a business" });
        }

        // 2. Load business
        const [business] = await db
          .select()
          .from(businesses)
          .where(and(eq(businesses.id, campaign.businessId), eq(businesses.userId, userId)))
          .limit(1);

        if (!business) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Business not found" });
        }
        console.log(`[regenerateFromProfile] business loaded | businessId=${business.id} | name=${business.name}`);

        // Authoritative atomic claim: only one regeneration can proceed.
        ownerToken = generateOwnerToken();
        const claimResult = await acquireCreativeGenerationClaim({
          userId,
          campaignId,
          operationSource: "profile",
          ownerToken,
          leaseExpiresAt: calculateLeaseExpiresAt(env.creativeGenerationRunningLeaseSeconds),
        });

        if (!claimResult.acquired) {
          const existingRunId = claimResult.existingClaim.operationReferenceId;
          if (existingRunId) {
            return {
              success: true,
              reused: true,
              strategyRunId: existingRunId,
              creativeRunId: null,
            };
          }
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Regeneration is already being prepared for this campaign.",
          });
        }

        claim = claimResult.claim;

        // Keep the claim alive during the long-running regeneration.
        heartbeatController = createClaimHeartbeatController({
          claimId: claim.id,
          ownerToken,
          leaseSeconds: env.creativeGenerationRunningLeaseSeconds,
          heartbeatIntervalSeconds: env.creativeGenerationHeartbeatIntervalSeconds,
        });

        // 3. Parse website evidence
        const evidence = (business.websiteEvidence || {}) as {
          businessCategory?: string;
          productsServices?: string[];
          targetCustomers?: string[];
          location?: string;
        };
        console.log(`[regenerateFromProfile] websiteEvidence parsed | businessId=${business.id} | category=${evidence.businessCategory || "none"}`);

        // 4. Update campaign brief from latest business evidence
        await db
          .update(campaigns)
          .set({
            productOrService: business.productOrService || evidence.productsServices?.join(", ") || campaign.productOrService,
            targetBuyer: business.targetCustomer || evidence.targetCustomers?.join(", ") || campaign.targetBuyer,
            mainPainPoint: campaign.mainPainPoint,
            workflowState: "strategy_pending",
            updatedAt: new Date(),
          } as any)
          .where(eq(campaigns.id, campaignId));
        console.log(`[regenerateFromProfile] campaign brief updated | campaignId=${campaignId}`);

        // 5. Historical agent runs are preserved. Strategy deduplication is now
        // fingerprint-aware, so a changed brief naturally produces a new run.

        // Snapshot existing AI-generated content so we can delete ONLY the old items after new content is created
        const oldContentPosts = await db
          .select({ id: contentPosts.id })
          .from(contentPosts)
          .where(
            and(
              eq(contentPosts.campaignId, campaignId),
              eq(contentPosts.userId, userId),
              eq(contentPosts.aiGenerated, true)
            )
          );
        const oldPostIds = oldContentPosts.map((p) => p.id);
        console.log(`[regenerateFromProfile] old content posts snapshot | campaignId=${campaignId} | count=${oldPostIds.length}`);

        const oldGeneratedAssets = await db
          .select({ id: campaignAssets.id })
          .from(campaignAssets)
          .where(
            and(
              eq(campaignAssets.campaignId, campaignId),
              eq(campaignAssets.userId, userId),
              inArray(campaignAssets.assetType, [
                "caption_pack",
                "caption_adaptation",
                "carousel_ad",
                "ad_copy",
                "whatsapp_promo",
                "email_copy",
                "launch_pack",
                "hashtag_set",
                "cta_variant",
              ])
            )
          );
        const oldAssetIds = oldGeneratedAssets.map((a) => a.id);
        console.log(`[regenerateFromProfile] old generated assets snapshot | campaignId=${campaignId} | count=${oldAssetIds.length}`);

        // 6. Regenerate strategy
        console.log(`[regenerateFromProfile] strategy regeneration started | campaignId=${campaignId}`);
        const strategyResult = await runStrategyAgent({
          userId,
          campaignId,
          business: {
            name: business.name,
            industry: business.industry,
            location: business.location || evidence.location,
            productOrService: business.productOrService,
            targetCustomer: business.targetCustomer,
            brandTone: business.brandTone,
            mainGoal: business.mainGoal,
            monthlyBudget: business.monthlyBudget,
            preferredPlatforms: business.preferredPlatforms,
            website: business.website,
            websiteEvidence: business.websiteEvidence,
          },
          onRunCreated: async (runId, tx) => {
            strategyRunId = runId;
            const attachResult = await attachCreativeGenerationOperationReference({
              claimId: claim!.id,
              ownerToken: ownerToken!,
              operationReferenceId: runId,
              db: tx,
            });
            if (!attachResult.attached) {
              console.error(`[regenerateFromProfile] claim attachment collision | campaignId=${campaignId} | runId=${runId}`);
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "Regeneration operation already exists for this strategy run.",
              });
            }
          },
        });
        strategyRunId = strategyResult.runId;
        console.log(`[regenerateFromProfile] strategy regenerated | campaignId=${campaignId} | strategyRunId=${strategyRunId}`);

        // Charge only after the validated strategy run has been produced.
        await chargeForStrategyRun(userId, campaignId, strategyResult);

        // Advance workflow to strategy_generated and then strategy_approved so creative can run
        await transitionCampaignState(campaignId, userId, "generate_strategy");
        console.log(`[regenerateFromProfile] campaign state transitioned to strategy_generated | campaignId=${campaignId}`);
        await transitionCampaignState(campaignId, userId, "approve_strategy");
        console.log(`[regenerateFromProfile] campaign state transitioned to strategy_approved | campaignId=${campaignId}`);

        // Record the authorised brief fingerprint and lineage so creative
        // generation can verify it is grounded in the current brief.
        const [regeneratedCampaign] = await db
          .select()
          .from(campaigns)
          .where(eq(campaigns.id, campaignId))
          .limit(1);
        if (regeneratedCampaign) {
          const { currentFingerprint } = getStrategyApprovalStatus(regeneratedCampaign);
          await db
            .update(campaigns)
            .set({
              workflowContext: {
                ...(regeneratedCampaign.workflowContext || {}),
                approvedStrategyFingerprint: currentFingerprint,
                strategyApprovalLineage: buildStrategyApprovalLineage(
                  currentFingerprint,
                  strategyRunId!,
                  0, // auto-approved via full regeneration, no approval request
                  "approved"
                ),
              } as any,
            })
            .where(eq(campaigns.id, campaignId));
        }

        // 7. Move to creatives_generating so the UI shows a loading/progress state
        await transitionCampaignState(campaignId, userId, "generate_creatives");
        console.log(`[regenerateFromProfile] campaign state transitioned to creatives_generating | campaignId=${campaignId}`);

        // 8. Validate the freshly approved strategy semantically before creative
        // generation. This keeps regenerateFromProfile from bypassing the same
        // semantic gate used by every other creative entry point.
        if (regeneratedCampaign) {
          await assertApprovedStrategySemanticallyValid(regeneratedCampaign, userId);
        }

        // 9. Regenerate creative pack (do NOT delete old drafts yet; we keep them as a fallback)
        console.log(`[regenerateFromProfile] creative pack generation started | campaignId=${campaignId}`);
        const creativeResult = await runCreativeAgent({
          userId,
          campaignId,
          deleteExistingDrafts: false,
          generationOperation: { source: "profile", id: strategyRunId! },
          claimContext: heartbeatController,
        });
        creativeRunId = creativeResult.packRunId;
        console.log(`[regenerateFromProfile] creative pack generated | campaignId=${campaignId} | creativeRunId=${creativeRunId} | savedPosts=${creativeResult.savedPosts} | savedAssets=${creativeResult.savedAssets}`);

        if (creativeResult.savedPosts === 0) {
          throw new Error("Creative Agent completed but no posts were saved.");
        }

        console.log(`[regenerateFromProfile] posts inserted | campaignId=${campaignId} | count=${creativeResult.savedPosts}`);
        console.log(`[regenerateFromProfile] assets inserted | campaignId=${campaignId} | count=${creativeResult.savedAssets}`);

        // 9. Only now that new content exists, delete the OLD AI-generated content posts
        if (oldPostIds.length > 0) {
          await db
            .delete(contentPosts)
            .where(
              and(
                eq(contentPosts.campaignId, campaignId),
                eq(contentPosts.userId, userId),
                inArray(contentPosts.id, oldPostIds)
              )
            );
          console.log(`[regenerateFromProfile] old AI-generated content posts deleted | campaignId=${campaignId} | count=${oldPostIds.length}`);
        } else {
          console.log(`[regenerateFromProfile] no old content posts to delete | campaignId=${campaignId}`);
        }

        // 10. Delete the OLD generated campaign assets
        if (oldAssetIds.length > 0) {
          await db
            .delete(campaignAssets)
            .where(
              and(
                eq(campaignAssets.campaignId, campaignId),
                eq(campaignAssets.userId, userId),
                inArray(campaignAssets.id, oldAssetIds)
              )
            );
          console.log(`[regenerateFromProfile] old generated campaign assets deleted | campaignId=${campaignId} | count=${oldAssetIds.length}`);
        } else {
          console.log(`[regenerateFromProfile] no old generated assets to delete | campaignId=${campaignId}`);
        }

        // 11. Advance campaign state now that content is safely created
        await onAgentRunComplete(creativeRunId);
        console.log(`[regenerateFromProfile] campaign state updated | campaignId=${campaignId} | creativeRunId=${creativeRunId}`);

        console.log(`[regenerateFromProfile] route completed | campaignId=${campaignId} | strategyRunId=${strategyRunId} | creativeRunId=${creativeRunId}`);

        const releaseResult = await releaseClaimOnce("completed");
        if (!releaseResult.released) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "Regeneration completed, but the operation could not be closed cleanly. Please retry.",
          });
        }

        return {
          success: true,
          strategyRunId,
          creativeRunId,
        };
      } catch (err: any) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[regenerateFromProfile] step failed | campaignId=${campaignId} | userId=${userId} | error="${errorMessage}"`, err);

        // Release the authoritative claim so later regeneration attempts can proceed.
        // Release failure is logged without ownerToken; preserve the original error.
        await releaseClaimOnce("failed");

        // Mark any runs we created as failed so the UI does not show them as completed.
        // Only touch rows that are still running; runStrategyAgent already persists
        // failure evidence, so overwriting it would erase raw/grounded output and
        // diagnostics.
        if (strategyRunId) {
          await db
            .update(agentRuns)
            .set({ status: "failed", error: errorMessage, completedAt: new Date() })
            .where(and(eq(agentRuns.id, strategyRunId), eq(agentRuns.status, "running")))
            .catch((e) => console.error(`[regenerateFromProfile] could not mark strategy run ${strategyRunId} failed:`, e.message));
        }
        if (creativeRunId) {
          await db
            .update(agentRuns)
            .set({ status: "failed", error: errorMessage, completedAt: new Date() })
            .where(and(eq(agentRuns.id, creativeRunId), eq(agentRuns.status, "running")))
            .catch((e) => console.error(`[regenerateFromProfile] could not mark creative run ${creativeRunId} failed:`, e.message));
        }

        if (err instanceof TRPCError) {
          throw err;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: errorMessage || "Failed to regenerate campaign from profile. Please try again.",
        });
      }
    }),

  regenerateStrategyForApproval: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { campaignId } = input;
      const { id: userId } = ctx.user;

      console.log(`[regenerateStrategyForApproval] route entered | campaignId=${campaignId} | userId=${userId}`);

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
        .limit(1);

      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      if (!campaign.businessId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Campaign is not linked to a business. Complete business onboarding first.",
        });
      }

      const [business] = await db
        .select()
        .from(businesses)
        .where(and(eq(businesses.id, campaign.businessId), eq(businesses.userId, userId)))
        .limit(1);

      if (!business) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Business not found" });
      }

      const currentFingerprint = getStrategyApprovalStatus(campaign).currentFingerprint;

      // Authoritative atomic claim: only one strategy-regeneration operation at a time.
      const ownerToken = generateOwnerToken();
      const claimResult = await acquireCreativeGenerationClaim({
        userId,
        campaignId,
        operationSource: "strategy_regeneration",
        ownerToken,
        leaseExpiresAt: calculateLeaseExpiresAt(env.creativeGenerationRunningLeaseSeconds),
      });

      if (!claimResult.acquired) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Strategy regeneration is already in progress for this campaign. Please wait for it to complete.",
        });
      }

      const claim = claimResult.claim;
      let released = false;

      const releaseClaimOnce = async (status: "completed" | "failed") => {
        if (released) return { released: true } as const;
        released = true;
        return releaseClaimWithResult({
          claimId: claim.id,
          ownerToken,
          status,
          context: "campaignRouter.regenerateStrategyForApproval",
        });
      };

      let strategyResult: StrategyAgentRunResult | undefined;
      let strategyRunCharged = false;

      const refundStrategyCharge = async () => {
        if (!strategyRunCharged || !strategyResult) return;
        const amount = getEstimatedAgentCost("strategy");
        try {
          await refundCredits({
            userId,
            amount,
            description: "Refund for failed strategy regeneration approval",
            idempotencyKey: `refund-strategy-run-${strategyResult.runId}`,
            metadata: { campaignId, runId: strategyResult.runId },
          });
          console.log(`[regenerateStrategyForApproval] refunded ${amount} credits for failed approval | campaignId=${campaignId} | runId=${strategyResult.runId}`);
        } catch (refundErr: any) {
          console.error(`[regenerateStrategyForApproval] refund failed | campaignId=${campaignId} | runId=${strategyResult.runId} | error="${refundErr.message}"`, refundErr);
        }
      };

      try {
        // Look for an existing completed strategy run whose stored brief fingerprint
        // matches the current brief AND whose output is semantically valid for the
        // current brief. Historical runs are preserved; we reuse only when the
        // lineage would be identical and the output passes the validation gate.
        const previousStrategyRuns = await db
          .select()
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.campaignId, campaignId),
              eq(agentRuns.userId, userId),
              eq(agentRuns.agentType, "strategy"),
              eq(agentRuns.status, "completed")
            )
          )
          .orderBy(desc(agentRuns.createdAt));

        let reusableRun: (typeof previousStrategyRuns)[number] | undefined;
        for (const run of previousStrategyRuns) {
          // Reject failure envelopes (generated_candidate, failed_validation,
          // failed_generation, failed_schema). Only a flat, successful strategy
          // output can be reused.
          if (!isSuccessfulStrategyOutput(run.output)) {
            console.log(`[regenerateStrategyForApproval] rejecting run ${run.id}: not a successful strategy output | campaignId=${campaignId}`);
            continue;
          }
          if (run.output.creativeBriefFingerprint !== currentFingerprint) continue;
          // A matching fingerprint is not enough: the run output must be
          // semantically grounded in the current brief. We do not require an
          // existing lineage here because this path creates a new one.
          const validation = validateStrategyOutputAgainstCampaign(run.output, campaign);
          if (validation.valid) {
            reusableRun = run;
            console.log(`[regenerateStrategyForApproval] reusing completed strategy run ${run.id} with matching fingerprint and valid grounding | campaignId=${campaignId}`);
            break;
          }
          console.log(`[regenerateStrategyForApproval] rejecting reusable run ${run.id}: ${validation.reason} | campaignId=${campaignId}`);
        }

        // If we have a reusable completed strategy for this exact brief, do not run
        // a new strategy agent. We still need a pending strategy_review request for it.
        let strategyRunId: number;
        let strategyRunIsReused = false;
        if (reusableRun) {
          strategyRunId = reusableRun.id;
          strategyRunIsReused = true;
          console.log(`[regenerateStrategyForApproval] reusing completed strategy run ${strategyRunId} with matching fingerprint | campaignId=${campaignId}`);
        } else {
          // Clear any approved-strategy fingerprint so the UI and backend treat the
          // strategy as stale until the new request is approved.
          await db
            .update(campaigns)
            .set({
              workflowContext: {
                ...(campaign.workflowContext || {}),
                approvedStrategyFingerprint: null,
              } as any,
            })
            .where(eq(campaigns.id, campaignId));

          // Regenerate strategy from the current persisted brief. The run and its
          // claim reference are inserted atomically in one transaction, before any
          // AI generation or semantic validation, so a committed run is never
          // reachable without the claim retaining its operationReferenceId.
          strategyResult = await runStrategyAgent({
            userId,
            campaignId,
            business: {
              name: business.name,
              industry: business.industry,
              location: business.location || (business.websiteEvidence as any)?.location,
              productOrService: business.productOrService,
              targetCustomer: business.targetCustomer,
              brandTone: business.brandTone,
              mainGoal: business.mainGoal,
              monthlyBudget: business.monthlyBudget,
              preferredPlatforms: business.preferredPlatforms,
              website: business.website,
              websiteEvidence: business.websiteEvidence,
            },
            onRunCreated: async (runId, tx) => {
              strategyRunId = runId;
              const attachResult = await attachCreativeGenerationOperationReference({
                claimId: claim.id,
                ownerToken,
                operationReferenceId: runId,
                db: tx,
              });
              if (!attachResult.attached) {
                console.error(`[regenerateStrategyForApproval] claim attachment collision | campaignId=${campaignId} | runId=${runId}`);
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: "Strategy regeneration is already in progress for this strategy run. Please wait for it to complete.",
                });
              }
            },
          });
          strategyRunId = strategyResult.runId;
        }

        // For reused runs the row already exists, so attach it now that the run
        // ID is known. A completed regeneration claim must never have a null
        // operationReferenceId.
        if (strategyRunIsReused) {
          const attachResult = await attachCreativeGenerationOperationReference({
            claimId: claim.id,
            ownerToken,
            operationReferenceId: strategyRunId,
          });

          if (!attachResult.attached) {
            console.error(`[regenerateStrategyForApproval] claim attachment collision | campaignId=${campaignId} | runId=${strategyRunId}`);
            const releaseResult = await releaseClaimOnce("failed");
            if (!releaseResult.released) {
              console.error(`[regenerateStrategyForApproval] failed-release failed after attachment collision | campaignId=${campaignId} | claimId=${claim.id} | releaseError=${releaseResult.error.message}`);
            }
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Strategy regeneration is already in progress for this strategy run. Please wait for it to complete.",
            });
          }
        }

        // Charge exactly 3 credits only after the strategy output has passed
        // validation and the claim has been bound to the run.
        if (!strategyRunIsReused && strategyResult) {
          await chargeForStrategyRun(userId, campaignId, strategyResult);
          strategyRunCharged = true;
        }

        // Reconcile pending strategy_review requests. Only reuse a pending request
        // when it is durably linked to the same fingerprint, run and approval ID.
        const lineage = buildStrategyApprovalLineage(
          currentFingerprint,
          strategyRunId,
          0, // placeholder until we create/find the request
          "pending"
        );

        const existingPendingRequests = await db
          .select()
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.campaignId, campaignId),
              eq(approvalRequests.userId, userId),
              eq(approvalRequests.approvalType, "strategy_review"),
              eq(approvalRequests.status, "pending")
            )
          )
          .orderBy(desc(approvalRequests.createdAt));

        let approvalRequestId: number;
        let matchingRequest: (typeof existingPendingRequests)[number] | undefined;
        for (const req of existingPendingRequests) {
          const campaignCtx = (campaign.workflowContext || {}) as Record<string, unknown>;
          const existingLineage = campaignCtx.strategyApprovalLineage as Record<string, unknown> | undefined;
          if (
            !existingLineage ||
            existingLineage.creativeBriefFingerprint !== currentFingerprint ||
            existingLineage.strategyRunId !== strategyRunId ||
            existingLineage.approvalRequestId !== req.id
          ) {
            continue;
          }
          // Only reuse a pending request when its linked run exists, is completed,
          // and still passes semantic validation against the current brief.
          const linkedRun = previousStrategyRuns.find((r) => r.id === strategyRunId);
          if (!linkedRun) continue;
          const validation = await validateStrategyRunForCampaign(campaign, userId, linkedRun);
          if (!validation.valid) {
            console.log(`[regenerateStrategyForApproval] rejecting reusable pending request ${req.id}: linked run ${strategyRunId} failed semantic validation | campaignId=${campaignId}`);
            continue;
          }
          matchingRequest = req;
          break;
        }

        if (matchingRequest) {
          approvalRequestId = matchingRequest.id;
          lineage.approvalRequestId = approvalRequestId;
          console.log(`[regenerateStrategyForApproval] reusing pending strategy_review ${approvalRequestId} with matching lineage | campaignId=${campaignId}`);
        } else {
          // Any older pending request is for a different brief/run and must be
          // preserved as historical evidence, not approved.
          for (const oldRequest of existingPendingRequests) {
            await db
              .update(approvalRequests)
              .set({
                status: "rejected",
                rejectedAt: new Date(),
                description: `${oldRequest.description || ""}\n\nSuperseded: a new strategy was generated for the current campaign brief.`.trim(),
              })
              .where(eq(approvalRequests.id, oldRequest.id));
            console.log(`[regenerateStrategyForApproval] superseded old pending strategy_review ${oldRequest.id} | campaignId=${campaignId}`);
          }

          // Create exactly one pending strategy_review request for the current lineage.
          const { id: newApprovalRequestId } = await createApprovalRequest({
            userId,
            campaignId,
            approvalType: "strategy_review",
            title: `Approve Strategy: ${campaign.name}`,
            description: strategyRunIsReused
              ? `The strategy for "${campaign.name}" matches the current campaign brief. Review and approve to continue to creative content generation.`
              : `The strategy for "${campaign.name}" has been regenerated from the current campaign brief. Review and approve to continue to creative content generation.`,
            aiRecommendation: "Based on the updated campaign brief and business profile, this strategy aligns with the current goal and target audience.",
            riskLevel: "low",
          });
          approvalRequestId = newApprovalRequestId;
          lineage.approvalRequestId = approvalRequestId;
        }

        // Move the campaign back to strategy review and persist the lineage.
        const currentWorkflowState = campaign.workflowState;
        await db
          .update(campaigns)
          .set({
            workflowState: "strategy_generated",
            workflowContext: {
              ...(campaign.workflowContext || {}),
              strategyFingerprint: currentFingerprint,
              strategyRunId,
              strategyApprovalLineage: lineage,
              lastTransition: {
                from: currentWorkflowState,
                to: "strategy_generated",
                action: "regenerate_strategy_for_approval",
                at: new Date().toISOString(),
              },
            } as any,
            updatedAt: new Date(),
          })
          .where(eq(campaigns.id, campaignId));

        await releaseClaimOnce("completed");

        console.log(`[regenerateStrategyForApproval] completed | campaignId=${campaignId} | strategyRunId=${strategyRunId} | approvalRequestId=${approvalRequestId} | reused=${strategyRunIsReused}`);

        return {
          success: true,
          strategyRunId,
          approvalRequestId,
          reused: strategyRunIsReused,
        };
      } catch (err: any) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[regenerateStrategyForApproval] step failed | campaignId=${campaignId} | userId=${userId} | error="${errorMessage}"`, err);
        await refundStrategyCharge();
        await releaseClaimOnce("failed");
        if (err instanceof TRPCError) {
          throw err;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: errorMessage || "Failed to regenerate strategy for approval. Please try again.",
        });
      }
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
