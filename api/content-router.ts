import { z } from "zod";
import { createRouter, authedQuery, aiActionQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { contentPosts, campaigns, campaignAssets, publishingQueue, socialIntegrations, approvalRequests } from "@db/schema";
import { eq, and, or, desc, count, inArray, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { runCreativeAgent } from "./lib/agents/creative-agent";
import {
  ensureApprovedMessagePack,
  saveApprovedMessagePack,
} from "./lib/creative/campaign-message-architect";
import { env } from "./lib/env";
import { onAgentRunComplete } from "./lib/workflow/triggers";
import { createApprovalRequest } from "./lib/workflow/engine";
import { logInfo, logError } from "./lib/logger";
import { publishSinglePost } from "./lib/workflow/publishing-runner";
import { isFacebookPublishingReady, isInstagramPublishingReady } from "./lib/integrations/platforms";

type PlatformPublishStatus = "connected" | "not_connected" | "manual" | "not_supported";

const AUTO_PUBLISH_PLATFORMS = new Set([
  "facebook",
  "instagram",
  "linkedin",
  "twitter",
  "tiktok",
  "email",
]);

function toDisplayPlatformName(platform: string): string {
  if (!platform) return platform;
  return platform.charAt(0).toUpperCase() + platform.slice(1).toLowerCase();
}

function buildPlatformStatusesFromIntegrations(
  integrations: any[]
): { platform: string; status: PlatformPublishStatus }[] {
  const seen = new Set<string>();
  const statuses: { platform: string; status: PlatformPublishStatus }[] = [];

  for (const integration of integrations) {
    const normalized = String(integration.platform || "").trim().toLowerCase();
    if (!normalized || !AUTO_PUBLISH_PLATFORMS.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    statuses.push({ platform: toDisplayPlatformName(normalized), status: "connected" });
  }

  return statuses;
}

export const contentRouter = createRouter({
  list: authedQuery
    .input(
      z
        .object({
          type: z
            .enum(["social_post", "ad_copy", "email", "script", "blog", "story", "video_concept", "reel_script", "carousel_ad", "whatsapp_promo", "lead_gen_ad", "launch_pack"])
            .optional(),
          status: z
            .enum(["draft", "scheduled", "published", "archived"])
            .optional(),
          campaignId: z.number().optional(),
          aiGenerated: z.boolean().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      try {
        let query = db
          .select()
          .from(contentPosts)
          .where(eq(contentPosts.userId, ctx.user.id))
          .orderBy(desc(contentPosts.createdAt));

        const results = await query;

        return results.filter((post) => {
          if (input?.type && post.type !== input.type) return false;
          if (input?.status && post.status !== input.status) return false;
          if (input?.campaignId && post.campaignId !== input.campaignId)
            return false;
          if (input?.aiGenerated !== undefined && post.aiGenerated !== input.aiGenerated)
            return false;
          return true;
        });
      } catch (err: any) {
        console.error("[content.list] Query failed:", err.message);
        return [];
      }
    }),

  countForCampaign: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      try {
        const [result] = await db
          .select({ value: count() })
          .from(contentPosts)
          .where(
            and(
              eq(contentPosts.userId, ctx.user.id),
              eq(contentPosts.campaignId, input.campaignId)
            )
          );
        return result?.value ?? 0;
      } catch {
        return 0;
      }
    }),

  campaignAssets: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      try {
        const results = await db
          .select()
          .from(campaignAssets)
          .where(
            and(
              eq(campaignAssets.userId, ctx.user.id),
              eq(campaignAssets.campaignId, input.campaignId)
            )
          )
          .orderBy(desc(campaignAssets.createdAt));
        return results;
      } catch (err: any) {
        console.error("[content.campaignAssets] Query failed:", err.message);
        return [];
      }
    }),

  generateForCampaign: aiActionQuery
    .input(z.object({ campaignId: z.number(), regenerate: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { campaignId } = input;
      const { id: userId } = ctx.user;

      logInfo("[content.generateForCampaign] started", {
        campaignId,
        userId,
        stage: "validation",
        provider: "openai",
      });

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, campaignId),
            eq(campaigns.userId, userId)
          )
        )
        .limit(1);

      if (!campaign) {
        logError("[content.generateForCampaign] campaign not found", {
          campaignId,
          userId,
          stage: "validation",
        });
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Campaign not found or you do not have access to it.",
        });
      }

      // Validate prerequisites for creative generation
      const eligibleStates = [
        "strategy_approved",
        "creatives_generating",
        "creatives_ready",
      ];
      if (!eligibleStates.includes(campaign.workflowState)) {
        logError("[content.generateForCampaign] invalid workflow state", {
          campaignId,
          userId,
          stage: "validation",
          workflowState: campaign.workflowState,
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot generate content while campaign is in "${campaign.workflowState}" state. Approve the strategy first.`,
        });
      }

      if (!campaign.businessId) {
        logError("[content.generateForCampaign] missing business", {
          campaignId,
          userId,
          stage: "validation",
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Campaign is not linked to a business. Complete business onboarding first.",
        });
      }

      const personas = campaign.personas as any[] | null | undefined;
      const hasCreativeContext =
        campaign.coreMessage ||
        (campaign.workflowContext as any)?.coreMessage ||
        (campaign.workflowContext as any)?.valueProposition ||
        (personas && Array.isArray(personas) && personas.length > 0);

      if (!hasCreativeContext) {
        logError("[content.generateForCampaign] missing creative context", {
          campaignId,
          userId,
          stage: "validation",
          hasCoreMessage: !!campaign.coreMessage,
          hasWorkflowContext: !!campaign.workflowContext,
          hasPersonas: !!(personas && personas.length > 0),
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Campaign is missing creative context (core message, personas, or approved strategy). Generate and approve a strategy first.",
        });
      }

      logInfo("[content.generateForCampaign] prerequisites validated", {
        campaignId,
        userId,
        stage: "agent_run",
        provider: "openai",
        businessId: campaign.businessId,
        workflowState: campaign.workflowState,
      });

      // Idempotency + repair guard: if the campaign already has saved posts and a
      // valid approved message pack, do not charge credits or rerun unless regenerate
      // is explicitly requested.
      const [existingPostCountResult] = await db
        .select({ value: count() })
        .from(contentPosts)
        .where(
          and(
            eq(contentPosts.userId, userId),
            eq(contentPosts.campaignId, campaignId)
          )
        );
      const existingPostCount = existingPostCountResult?.value ?? 0;

      const [existingMessagePack] = existingPostCount > 0
        ? await db
            .select({ metadata: campaignAssets.metadata })
            .from(campaignAssets)
            .where(
              and(
                eq(campaignAssets.userId, userId),
                eq(campaignAssets.campaignId, campaignId),
                eq(campaignAssets.assetType, "message_pack" as any)
              )
            )
            .orderBy(desc(campaignAssets.createdAt))
            .limit(1)
        : [null];
      const hasValidMessagePack =
        existingMessagePack?.metadata &&
        (existingMessagePack.metadata as any)?.passed === true;

      if (existingPostCount > 0 && !input.regenerate) {
        if (campaign.workflowState === "creatives_generating") {
          await db
            .update(campaigns)
            .set({
              workflowState: "creatives_ready",
              workflowContext: {
                ...(campaign.workflowContext || {}),
                repairedAt: new Date().toISOString(),
                repairedReason: "existing_content_posts_found",
              } as any,
              updatedAt: new Date(),
            })
            .where(eq(campaigns.id, campaignId));
          logInfo("[content.generateForCampaign] repaired stuck workflow state", {
            campaignId,
            userId,
            stage: "idempotency_guard",
            fromState: "creatives_generating",
            toState: "creatives_ready",
            postCount: existingPostCount,
          });
        } else {
          logInfo("[content.generateForCampaign] idempotent skip: posts already exist", {
            campaignId,
            userId,
            stage: "idempotency_guard",
            postCount: existingPostCount,
            hasValidMessagePack,
          });
        }
        return { success: true, postCount: existingPostCount, idempotent: true };
      }

      // If regenerating, ensure the message pack is also rebuilt.
      if (input.regenerate && campaign.businessId) {
        try {
          const freshPack = await ensureApprovedMessagePack({
            userId,
            campaignId,
            skipBilling: true,
            maxAttempts: 2,
          });
          if (freshPack.validation.passed) {
            await saveApprovedMessagePack(userId, campaignId, freshPack);
          }
        } catch (regenErr: any) {
          logError("[content.generateForCampaign] failed to regenerate message pack", {
            campaignId,
            userId,
            error: regenErr.message,
          });
        }
      }

      let result: Awaited<ReturnType<typeof runCreativeAgent>>;
      try {
        result = await runCreativeAgent({
          userId,
          campaignId,
        });
      } catch (err: any) {
        const errorMessage = err instanceof TRPCError ? err.message : err.message || String(err);
        logError("[content.generateForCampaign] creative agent failed", {
          campaignId,
          userId,
          stage: "agent_run",
          provider: "openai",
          error: errorMessage,
          trpcCode: err instanceof TRPCError ? err.code : undefined,
        });
        throw new TRPCError({
          code: err instanceof TRPCError ? err.code : "INTERNAL_SERVER_ERROR",
          message: errorMessage,
        });
      }

      logInfo("[content.generateForCampaign] creative agent completed", {
        campaignId,
        userId,
        stage: "workflow_trigger",
        provider: "openai",
        packRunId: result.packRunId,
        savedPosts: result.savedPosts,
        savedAssets: result.savedAssets,
      });

      // Ensure the campaign advances to creatives_ready as soon as posts were saved.
      // Do not rely solely on the fire-and-forget onAgentRunComplete handler.
      if (result.savedPosts > 0 && campaign.workflowState !== "creatives_ready") {
        try {
          await db
            .update(campaigns)
            .set({
              workflowState: "creatives_ready",
              workflowContext: {
                ...(campaign.workflowContext || {}),
                creativeGeneratedAt: new Date().toISOString(),
                creativeRunId: result.packRunId,
                savedPosts: result.savedPosts,
                savedAssets: result.savedAssets,
              } as any,
              updatedAt: new Date(),
            })
            .where(eq(campaigns.id, campaignId));
          logInfo("[content.generateForCampaign] advanced workflow state", {
            campaignId,
            userId,
            stage: "state_transition",
            fromState: campaign.workflowState,
            toState: "creatives_ready",
            savedPosts: result.savedPosts,
          });
        } catch (stateErr: any) {
          logError("[content.generateForCampaign] failed to advance workflow state", {
            campaignId,
            userId,
            stage: "state_transition",
            error: stateErr.message || String(stateErr),
          });
        }
      }

      try {
        await onAgentRunComplete(result.packRunId);
      } catch (err: any) {
        logError("[content.generateForCampaign] workflow trigger failed", {
          campaignId,
          userId,
          stage: "workflow_trigger",
          provider: "openai",
          packRunId: result.packRunId,
          error: err.message || String(err),
        });
        // Non-fatal: posts were saved even if workflow transition failed
      }

      if (result.savedPosts === 0) {
        logError("[content.generateForCampaign] no posts saved", {
          campaignId,
          userId,
          stage: "post_save",
          provider: "openai",
          savedAssets: result.savedAssets,
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The Creative Agent ran but no posts were saved. Please retry or contact support if the issue persists.",
        });
      }

      logInfo("[content.generateForCampaign] completed", {
        campaignId,
        userId,
        stage: "complete",
        provider: "openai",
        savedPosts: result.savedPosts,
        savedAssets: result.savedAssets,
      });

      return { success: true, postCount: result.savedPosts };
    }),

  get: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const [post] = await db
        .select()
        .from(contentPosts)
        .where(
          and(
            eq(contentPosts.id, input.id),
            eq(contentPosts.userId, ctx.user.id)
          )
        );
      return post ?? null;
    }),

  create: authedQuery
    .input(
      z.object({
        title: z.string().min(1),
        type: z.enum(["social_post", "ad_copy", "email", "script", "blog", "story", "video_concept", "reel_script", "carousel_ad", "whatsapp_promo", "lead_gen_ad", "launch_pack"]),
        campaignId: z.number().optional(),
        businessId: z.number().optional(),
        platform: z.string().optional(),
        hook: z.string().optional(),
        caption: z.string().optional(),
        cta: z.string().optional(),
        headline: z.string().optional(),
        body: z.string().optional(),
        hashtags: z.string().optional(),
        visualPrompt: z.string().optional(),
        aiGenerated: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [post] = await db.insert(contentPosts).values({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        businessId: input.businessId,
        title: input.title,
        type: input.type,
        platform: input.platform,
        hook: input.hook,
        caption: input.caption,
        cta: input.cta,
        headline: input.headline,
        body: input.body,
        hashtags: input.hashtags,
        visualPrompt: input.visualPrompt,
        aiGenerated: input.aiGenerated ?? true,
      });
      return { id: Number(post.insertId), success: true };
    }),

  update: authedQuery
    .input(
      z.object({
        id: z.number(),
        title: z.string().min(1).optional(),
        platform: z.string().optional(),
        hook: z.string().optional(),
        caption: z.string().optional(),
        cta: z.string().optional(),
        headline: z.string().optional(),
        body: z.string().optional(),
        hashtags: z.string().optional(),
        visualPrompt: z.string().optional(),
        status: z.enum(["draft", "scheduled", "published", "archived"]).optional(),
        scheduledFor: z.string().optional(),
        metadata: z.record(z.string(), z.any()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, scheduledFor, metadata, ...data } = input;
      const updateData: any = { ...data };
      if (scheduledFor) updateData.scheduledFor = new Date(scheduledFor);
      if (metadata !== undefined) updateData.metadata = metadata;
      await db
        .update(contentPosts)
        .set(updateData)
        .where(
          and(eq(contentPosts.id, id), eq(contentPosts.userId, ctx.user.id))
        );
      return { success: true };
    }),

  approve: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [post] = await db
        .select()
        .from(contentPosts)
        .where(
          and(
            eq(contentPosts.id, input.id),
            eq(contentPosts.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!post) {
        throw new Error("Content post not found");
      }

      const currentMetadata = (post.metadata || {}) as any;
      await db
        .update(contentPosts)
        .set({
          metadata: {
            ...currentMetadata,
            approved: true,
            approvedAt: new Date().toISOString(),
          },
        })
        .where(
          and(eq(contentPosts.id, input.id), eq(contentPosts.userId, ctx.user.id))
        );

      return { success: true };
    }),

  markAsManuallyPosted: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [post] = await db
        .select()
        .from(contentPosts)
        .where(
          and(
            eq(contentPosts.id, input.id),
            eq(contentPosts.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!post) {
        throw new Error("Content post not found");
      }

      const currentMetadata = (post.metadata || {}) as any;
      await db
        .update(contentPosts)
        .set({
          status: "published",
          publishedAt: new Date(),
          metadata: {
            ...currentMetadata,
            publishMode: "manual",
            manuallyPostedAt: new Date().toISOString(),
          },
        })
        .where(
          and(eq(contentPosts.id, input.id), eq(contentPosts.userId, ctx.user.id))
        );

      return { success: true };
    }),

  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db
        .delete(contentPosts)
        .where(
          and(
            eq(contentPosts.id, input.id),
            eq(contentPosts.userId, ctx.user.id)
          )
        );
      return { success: true };
    }),

  ensurePublishEligibility: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.userId, ctx.user.id), eq(campaigns.id, input.campaignId)))
        .limit(1);

      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      const campaignBusinessId = campaign.businessId ?? null;

      // Load connected integrations scoped to this user and, when known, this business.
      const businessFilter =
        campaignBusinessId == null
          ? isNull(socialIntegrations.businessId)
          : or(isNull(socialIntegrations.businessId), eq(socialIntegrations.businessId, campaignBusinessId));

      const integrations = await db
        .select()
        .from(socialIntegrations)
        .where(and(eq(socialIntegrations.userId, ctx.user.id), eq(socialIntegrations.status, "connected"), businessFilter));

      // Build platform statuses directly from the actual connected integrations returned for
      // this campaign/business/user. This must never be empty when integrations were found.
      const platformStatuses = buildPlatformStatusesFromIntegrations(integrations);
      const hasConnectedPlatformStatus = platformStatuses.some((p) => p.status === "connected");

      // Load posts and approvals
      const posts = await db
        .select()
        .from(contentPosts)
        .where(and(eq(contentPosts.userId, ctx.user.id), eq(contentPosts.campaignId, input.campaignId)));

      const approvals = await db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.userId, ctx.user.id), eq(approvalRequests.campaignId, input.campaignId)));

      const socialPosts = posts.filter((p) => p.type === "social_post");
      // A generated social_post is publishable when it is not already published or archived.
      // publishCampaignPack will auto-approve draft/scheduled posts before queueing them.
      const publishablePostCount = socialPosts.filter(
        (p) => p.status !== "published" && p.status !== "archived"
      ).length;

      const postStrategyStates = new Set([
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

      const strategyApproved =
        postStrategyStates.has(campaign.workflowState) ||
        approvals.some(
          (a) => a.approvalType === "strategy_review" && (a.status === "approved" || a.status === "edited")
        );

      const launchApproved = approvals.some(
        (a) => a.approvalType === "campaign_launch" && (a.status === "approved" || a.status === "edited")
      );
      const pendingApprovalCount = approvals.filter(
        (a) => a.approvalType === "campaign_launch" && a.status === "pending"
      ).length;

      let unavailableReason:
        | "ready"
        | "no_publishable_content"
        | "no_connected_platforms"
        | "strategy_approval_required"
        | "launch_approval_required" = "ready";

      if (integrations.length > 0 && platformStatuses.length === 0) {
        // Defensive guard: integrations were found but we could not build any usable platform
        // status. This is the production failure mode we must never report as "ready".
        unavailableReason = "no_connected_platforms";
      } else if (!hasConnectedPlatformStatus) {
        unavailableReason = "no_connected_platforms";
      } else if (!strategyApproved) {
        unavailableReason = "strategy_approval_required";
      } else if (!launchApproved) {
        unavailableReason = "launch_approval_required";
        const existingLaunchRequest = approvals.some(
          (a) => a.approvalType === "campaign_launch" && ["pending", "approved", "edited"].includes(a.status)
        );
        if (!existingLaunchRequest) {
          try {
            await createApprovalRequest({
              userId: ctx.user.id,
              campaignId: input.campaignId,
              approvalType: "campaign_launch",
              title: `Approve Launch: ${campaign.name}`,
              description: `The campaign "${campaign.name}" is ready to launch. Review and approve the launch to publish to connected channels.`,
              aiRecommendation: "All strategy and creative assets are ready. Approve the launch to go live.",
              riskLevel: "low",
            });
          } catch (err: any) {
            logError("[PublishEligibility] Failed to create launch approval request", {
              campaignId: input.campaignId,
              userId: ctx.user.id,
              error: err.message,
            });
          }
        }
      } else if (publishablePostCount === 0) {
        unavailableReason = "no_publishable_content";
      }

      const response = {
        canPublish: unavailableReason === "ready",
        campaignId: input.campaignId,
        ctxUserId: ctx.user.id,
        campaignUserId: campaign.userId,
        businessId: campaignBusinessId,
        connectedIntegrationsFound: integrations.length,
        strategyApproved,
        launchApproved,
        pendingApprovalCount,
        publishablePostCount,
        unavailableReason,
        platformStatuses,
      };

      logInfo("[PublishEligibility] Computed publish eligibility", response);

      return response;
    }),

  publishCampaignPack: authedQuery
    .input(z.object({ campaignId: z.number(), allowRepublish: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.userId, ctx.user.id), eq(campaigns.id, input.campaignId)))
        .limit(1);

      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      const isAlreadyLive = campaign.status === "active" && campaign.workflowState === "campaign_live";
      if (isAlreadyLive && !input.allowRepublish) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This campaign is already live. Use Publish again if you want to republish.",
        });
      }

      const posts = await db
        .select()
        .from(contentPosts)
        .where(
          and(
            eq(contentPosts.userId, ctx.user.id),
            eq(contentPosts.campaignId, input.campaignId)
          )
        );

      // Guard: at least one publishable social post must exist. Draft/scheduled posts are
      // publishable because publishCampaignPack auto-approves them before queueing.
      const socialPosts = posts.filter((p) => p.type === "social_post");
      const publishableSocial = socialPosts.filter(
        (p) => p.status !== "published" && p.status !== "archived"
      );
      if (socialPosts.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "At least one social post must exist before publishing the campaign pack.",
        });
      }
      if (publishableSocial.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "All social posts are already published or archived.",
        });
      }

      // Guard: platform-specific captions or caption pack must exist
      const adaptations = await db
        .select()
        .from(campaignAssets)
        .where(
          and(
            eq(campaignAssets.userId, ctx.user.id),
            eq(campaignAssets.campaignId, input.campaignId),
            eq(campaignAssets.assetType, "caption_adaptation")
          )
        );
      const captionPacks = await db
        .select()
        .from(campaignAssets)
        .where(
          and(
            eq(campaignAssets.userId, ctx.user.id),
            eq(campaignAssets.campaignId, input.campaignId),
            eq(campaignAssets.assetType, "caption_pack")
          )
        );
      if (adaptations.length === 0 && captionPacks.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Platform captions are missing. Generate content first.",
        });
      }

      // Guard: if video exists, it must be ready with a videoUrl — but only when video features are enabled
      if (env.enablePremiumVideo || env.enableBasicDraftVideo) {
        const videos = posts.filter((p) => p.type === "video_concept" || p.type === "reel_script");
        for (const video of videos) {
          const meta = (video.metadata || {}) as any;
          if (meta.videoStatus === "concept" || meta.videoStatus === "rendering") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "This campaign contains a video concept only. Render the video before publishing.",
            });
          }
          if (meta.videoStatus === "ready" && !meta.videoUrl) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "This campaign contains a video concept only. Render the video before publishing.",
            });
          }
          if (meta.videoStatus === "failed") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Video rendering failed. Retry rendering or remove the video before publishing.",
            });
          }
        }
      }

      // Approve all unapproved, non-published posts
      for (const post of posts) {
        const meta = (post.metadata || {}) as any;
        if (!meta.approved && post.status !== "published" && post.status !== "archived") {
          await db
            .update(contentPosts)
            .set({
              metadata: {
                ...meta,
                approved: true,
                approvedAt: new Date().toISOString(),
              },
            })
            .where(and(eq(contentPosts.id, post.id), eq(contentPosts.userId, ctx.user.id)));
        }
      }

      // Determine target platforms from campaign settings
      const campaignPlatforms = (campaign.platforms || "")
        .split(/[,;]+/)
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);

      const campaignBusinessId = campaign.businessId ?? null;

      // Load connected integrations scoped to this user and, when known, this business.
      // Integrations with no businessId are treated as legacy/global connections and remain
      // valid for all businesses, but newly-connected accounts should be tied to a business.
      const businessFilter =
        campaignBusinessId == null
          ? isNull(socialIntegrations.businessId)
          : or(
              isNull(socialIntegrations.businessId),
              eq(socialIntegrations.businessId, campaignBusinessId)
            );

      const integrations = await db
        .select()
        .from(socialIntegrations)
        .where(
          and(
            eq(socialIntegrations.userId, ctx.user.id),
            eq(socialIntegrations.status, "connected"),
            businessFilter
          )
        );

      // Derive publishable platforms directly from the connected integrations returned for this
      // campaign/business/user. This must match the source of truth used by ensurePublishEligibility.
      const platformStatuses = buildPlatformStatusesFromIntegrations(integrations);
      const publishablePlatforms: string[] = [];
      const excludedPlatforms: Array<{ platform: string; reason: string }> = [];
      const seenPlatforms = new Set<string>();

      for (const integration of integrations) {
        const normalized = String(integration.platform || "").trim().toLowerCase();
        if (!normalized) {
          excludedPlatforms.push({ platform: integration.platform, reason: "missing platform value" });
          continue;
        }
        if (!AUTO_PUBLISH_PLATFORMS.has(normalized)) {
          excludedPlatforms.push({
            platform: integration.platform,
            reason: "platform not supported for auto-publish",
          });
          continue;
        }
        if (seenPlatforms.has(normalized)) continue;
        seenPlatforms.add(normalized);
        publishablePlatforms.push(normalized);
      }

      logInfo("[PublishCampaignPack] Starting publish", {
        campaignId: input.campaignId,
        userId: ctx.user.id,
        businessId: campaignBusinessId,
        campaignPlatforms,
        connectedIntegrations: integrations.map((i) => ({
          platform: i.platform,
          id: i.id,
          businessId: i.businessId,
        })),
        platformStatuses,
        derivedPublishablePlatforms: publishablePlatforms,
        excludedPlatforms,
      });

      // Refresh approved social posts after updates
      const publishablePosts = posts.filter((p) => {
        if (p.type !== "social_post") return false;
        const meta = (p.metadata || {}) as any;
        return meta.approved === true || p.status === "published";
      });

      // Defensive contract check: if connected integrations exist and eligibility returned ready,
      // every supported connected platform must appear in publishablePlatforms. Otherwise we have a
      // platform-mapping bug and must fail loudly instead of silently falling back to manual posting.
      const supportedConnectedPlatforms = integrations
        .map((i) => String(i.platform || "").trim().toLowerCase())
        .filter((p) => AUTO_PUBLISH_PLATFORMS.has(p));
      const missingFromPublishable = supportedConnectedPlatforms.filter(
        (p) => !publishablePlatforms.includes(p)
      );
      if (missingFromPublishable.length > 0) {
        const message = `[PublishCampaignPack] Contract error: supported connected platforms [${missingFromPublishable.join(
          ", "
        )}] missing from publishablePlatforms`;
        logError(message, {
          campaignId: input.campaignId,
          userId: ctx.user.id,
          businessId: campaignBusinessId,
          connectedIntegrations: integrations.map((i) => ({
            platform: i.platform,
            id: i.id,
            businessId: i.businessId,
          })),
          platformStatuses,
          publishablePlatforms,
          missingFromPublishable,
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Publishing platform mapping failed. Please contact support.",
        });
      }

      // No eligible connected platform for this campaign/business: mark content as ready for
      // manual posting instead of pretending it was published successfully. This path must NOT be
      // reached when connected integrations exist and ensurePublishEligibility returned ready.
      if (publishablePlatforms.length === 0) {
        let manualCount = 0;
        for (const post of posts) {
          if (post.type !== "social_post") continue;
          if (post.status === "published" || post.status === "archived") continue;
          const meta = (post.metadata || {}) as any;
          await db
            .update(contentPosts)
            .set({
              status: "published",
              publishedAt: new Date(),
              metadata: {
                ...meta,
                publishMode: "manual",
                manuallyPostedAt: new Date().toISOString(),
              },
            })
            .where(and(eq(contentPosts.id, post.id), eq(contentPosts.userId, ctx.user.id)));
          manualCount++;
        }

        logInfo("[PublishCampaignPack] No connected platforms for campaign; marked as manual posting", {
          campaignId: input.campaignId,
          manualCount,
        });

        return {
          success: true,
          manualPosting: true,
          manualCount,
          approvedCount: posts.filter((p) => p.status !== "published" && p.status !== "archived").length,
          publishedCount: 0,
          failedCount: 0,
          skippedCount: 0,
          results: [],
        };
      }

      const results: Array<{
        platform: string;
        queueItemId: number;
        status: string;
        postId?: string;
        error?: string;
      }> = [];

      for (const platform of publishablePlatforms) {
        const integration = integrations.find((i) => i.platform === platform);
        if (!integration) continue;

        // Find best content post for this platform
        let post = publishablePosts.find((p) => p.platform?.toLowerCase() === platform);
        if (!post) post = publishablePosts[0];

        if (!post) {
          console.log("[PublishCampaignPack] No approved social post for platform", {
            campaignId: input.campaignId,
            platform,
          });
          continue;
        }

        // Reuse an existing pending/retrying queue item for this post/platform if present
        let queueItemId: number;
        const [existingQueue] = await db
          .select()
          .from(publishingQueue)
          .where(
            and(
              eq(publishingQueue.userId, ctx.user.id),
              eq(publishingQueue.campaignId, input.campaignId),
              eq(publishingQueue.contentPostId, post.id),
              eq(publishingQueue.platform, platform),
              inArray(publishingQueue.status, ["approved", "retrying", "pending_approval"])
            )
          )
          .limit(1);

        if (existingQueue) {
          queueItemId = existingQueue.id;
          console.log("[PublishCampaignPack] Reusing existing queue item", {
            campaignId: input.campaignId,
            platform,
            contentPostId: post.id,
            queueItemId,
            integrationId: integration.id,
            pageId: platform === "facebook" ? integration.pageId : undefined,
          });
        } else {
          // Publishing readiness checks determine the initial queue status: a connected but
          // not-yet-ready account gets a queue row so the UI never says "published successfully"
          // when nothing was actually queued, but it is marked failed rather than attempted.
          let queueStatus: "approved" | "failed" = "approved";
          let queueError: string | undefined;

          if (platform === "facebook" && !isFacebookPublishingReady(integration)) {
            queueStatus = "failed";
            queueError =
              "Facebook integration is not publishing-ready. Reconnect to grant pages_manage_posts.";
          } else if (platform === "instagram" && !isInstagramPublishingReady(integration)) {
            queueStatus = "failed";
            queueError =
              "Instagram publishing is not ready. Ensure your Facebook Page has a linked Instagram professional account and that the Instagram content publishing permission is granted.";
          }

          // Create publishing queue item for every publishable content post / platform.
          const [queueResult] = await db.insert(publishingQueue).values({
            userId: ctx.user.id,
            campaignId: input.campaignId,
            contentPostId: post.id,
            integrationId: integration.id,
            platform,
            status: queueStatus,
            lastError: queueError ?? null,
            approvalRequired: false,
            scheduledAt: null,
          });
          queueItemId = Number(queueResult.insertId);

          console.log("[PublishCampaignPack] Created queue item", {
            campaignId: input.campaignId,
            platform,
            contentPostId: post.id,
            queueItemId,
            integrationId: integration.id,
            status: queueStatus,
            pageId: platform === "facebook" ? integration.pageId : undefined,
          });

          if (queueStatus === "failed") {
            results.push({
              platform,
              queueItemId,
              status: "failed",
              error: queueError,
            });
            continue;
          }
        }

        // Attempt immediate publish
        const publishResult = await publishSinglePost(queueItemId);

        console.log("[PublishCampaignPack] Publish attempt completed", {
          campaignId: input.campaignId,
          platform,
          queueItemId,
          integrationId: integration.id,
          pageId: platform === "facebook" ? integration.pageId : undefined,
          status: publishResult.status,
          success: publishResult.status === "published",
          error: publishResult.error,
          postId: publishResult.postId,
        });

        results.push({
          platform,
          queueItemId,
          status: publishResult.status,
          postId: publishResult.postId,
          error: publishResult.error,
        });
      }

      // Update campaign state based on publish results
      const anyPublished = results.some((r) => r.status === "published");
      const allPublished = results.length > 0 && results.every((r) => r.status === "published");

      console.log("[PublishCampaignPack] Campaign state update", {
        campaignId: input.campaignId,
        anyPublished,
        allPublished,
        resultCount: results.length,
      });

      await db
        .update(campaigns)
        .set({
          status: anyPublished ? "active" : campaign.status,
          workflowState: allPublished ? "campaign_live" : "launch_approval_required",
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, input.campaignId));

      return {
        success: true,
        approvedCount: posts.filter((p) => p.status !== "published" && p.status !== "archived").length,
        publishedCount: results.filter((r) => r.status === "published").length,
        failedCount: results.filter((r) => r.status === "failed").length,
        skippedCount: results.filter((r) => r.status === "skipped").length,
        results,
      };
    }),
});
