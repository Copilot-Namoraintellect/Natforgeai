import { z } from "zod";
import { createRouter, authedQuery, aiActionQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { contentPosts, campaigns, campaignAssets, publishingQueue, socialIntegrations, approvalRequests, agentRuns } from "@db/schema";
import { eq, and, or, desc, count, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { env } from "./lib/env";
import { createApprovalRequest } from "./lib/workflow/engine";
import { logInfo, logError } from "./lib/logger";
import { publishSinglePost, finalizeCampaignPublishState } from "./lib/workflow/publishing-runner";
import { checkContentSafety } from "./lib/safety/checker";
import { isFacebookPublishingReady, isInstagramPublishingReady } from "./lib/integrations/platforms";
import { scheduleContentGenerationJob, isBullMQAvailable } from "./lib/queue/bullmq";
import { processContentGenerationJob } from "./lib/jobs/content-generation-job";
import {
  acquireCreativeGenerationClaim,
  attachCreativeGenerationOperationReference,
  generateOwnerToken,
  releaseClaimWithResult,
} from "./lib/creative/creative-generation-claim";

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

function isApprovedImageReadySocialPost(post: any): boolean {
  if (post.type !== "social_post") return false;
  if (post.status === "published" || post.status === "archived") return false;
  const meta = (post.metadata || {}) as any;
  if (!meta.approved) return false;
  if (meta.imageStatus !== "ready") return false;
  if (!meta.imageUrl) return false;
  return true;
}

function mapGenerationStatus(status: string | null | undefined): "queued" | "processing" | "completed" | "failed" | "preparing" {
  if (status === "preparing") return "preparing";
  if (status === "pending") return "queued";
  if (status === "running") return "processing";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "failed";
}

function isContentGenerationJobRun(run: any): boolean {
  const meta = (run?.input || {}) as any;
  return meta.jobType === "content_generation_job";
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
        stage: "job_enqueue",
        provider: "openai",
        businessId: campaign.businessId,
        workflowState: campaign.workflowState,
      });

      // Authoritative claim: at most one active creative-generation operation
      // per (userId, campaignId). The database unique key is the source of truth.
      const ownerToken = generateOwnerToken();
      const claimResult = await acquireCreativeGenerationClaim({
        userId,
        campaignId,
        operationSource: "job",
        ownerToken,
      });

      if (!claimResult.acquired) {
        const existing = claimResult.existingClaim;
        return {
          jobId: existing.operationReferenceId ?? null,
          campaignId,
          status: existing.operationReferenceId ? "queued" : "preparing",
          reused: true,
        };
      }

      const claim = claimResult.claim;
      let jobId!: number;

      try {
        // Advisory dedup: a pre-existing job row from before the claim table
        // existed (or a race that completed before attachment) can be reused.
        const recentCreativeRuns = await db
          .select()
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.userId, userId),
              eq(agentRuns.campaignId, campaignId),
              eq(agentRuns.agentType, "creative")
            )
          )
          .orderBy(desc(agentRuns.createdAt))
          .limit(25);

        const activeJob = recentCreativeRuns.find((run) => {
          return (
            isContentGenerationJobRun(run) &&
            (run.status === "pending" || run.status === "running")
          );
        });

        if (activeJob) {
          const releaseResult = await releaseClaimWithResult({
            claimId: claim.id,
            ownerToken,
            status: "completed",
            context: "contentRouter.generateForCampaign advisory dedup",
          });
          if (!releaseResult.released) {
            logError("[content.generateForCampaign] completed-release failed for advisory dedup", {
              campaignId,
              userId,
              claimId: claim.id,
              releaseError: releaseResult.error.message,
            });
          }
          return {
            jobId: activeJob.id,
            campaignId,
            status: mapGenerationStatus(activeJob.status),
            reused: true,
          };
        }

        const [jobInsert] = await db
          .insert(agentRuns)
          .values({
            userId,
            campaignId,
            agentType: "creative",
            status: "pending",
            input: {
              jobType: "content_generation_job",
              regenerate: !!input.regenerate,
            } as any,
          });

        jobId = Number((jobInsert as any).insertId);

        const attachResult = await attachCreativeGenerationOperationReference({
          claimId: claim.id,
          ownerToken,
          operationReferenceId: jobId,
        });

        if (!attachResult.attached) {
          // The job id collided with an existing operation reference. This is
          // pathological, but we must release our claim and reuse the winner.
          await db
            .update(agentRuns)
            .set({ status: "failed", error: "operation reference collision", completedAt: new Date() })
            .where(eq(agentRuns.id, jobId));
          const releaseResult = await releaseClaimWithResult({
            claimId: claim.id,
            ownerToken,
            status: "failed",
            context: "contentRouter.generateForCampaign reference collision",
          });
          if (!releaseResult.released) {
            logError("[content.generateForCampaign] failed-release failed after reference collision", {
              campaignId,
              userId,
              claimId: claim.id,
              releaseError: releaseResult.error.message,
            });
          }
          return {
            jobId: attachResult.existingClaim.operationReferenceId ?? null,
            campaignId,
            status: attachResult.existingClaim.operationReferenceId ? "queued" : "preparing",
            reused: true,
          };
        }

        if (isBullMQAvailable()) {
          await scheduleContentGenerationJob({
            jobId,
            userId,
            campaignId,
            regenerate: !!input.regenerate,
            claimId: claim.id,
            ownerToken,
          });
        } else {
          setTimeout(() => {
            void processContentGenerationJob({
              jobId,
              userId,
              campaignId,
              regenerate: !!input.regenerate,
              claimId: claim.id,
              ownerToken,
            });
          }, 0);
        }

        return {
          jobId,
          campaignId,
          status: "queued",
        };
      } catch (err: any) {
        if (jobId !== undefined) {
          await db
            .update(agentRuns)
            .set({
              status: "failed",
              error: err?.message || "Failed to enqueue content generation job.",
              completedAt: new Date(),
            })
            .where(eq(agentRuns.id, jobId))
            .catch((cleanupErr: any) => {
              logError("[content.generateForCampaign] failed to mark job row failed", {
                campaignId,
                userId,
                jobId,
                error: cleanupErr?.message || String(cleanupErr),
              });
            });
        }

        const releaseResult = await releaseClaimWithResult({
          claimId: claim.id,
          ownerToken,
          status: "failed",
          context: "contentRouter.generateForCampaign enqueue failure",
        });
        if (!releaseResult.released) {
          // Release failure is already logged by releaseClaimWithResult without
          // ownerToken. Preserve the original enqueue/validation error as the
          // primary failure surfaced to the caller.
          logError("[content.generateForCampaign] claim release failed after error", {
            campaignId,
            userId,
            claimId: claim.id,
            releaseError: releaseResult.error.message,
          });
        }

        if (err instanceof TRPCError) {
          throw err;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            err?.message ||
            "Content generation could not be queued. No credits were charged. Please try again after the service issue is resolved.",
        });
      }
    }),

  getGenerationJobStatus: authedQuery
    .input(z.object({ campaignId: z.number(), jobId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();

      let selected: any | null = null;
      if (input.jobId) {
        const rows = await db
          .select()
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.id, input.jobId),
              eq(agentRuns.userId, ctx.user.id),
              eq(agentRuns.campaignId, input.campaignId),
              eq(agentRuns.agentType, "creative")
            )
          )
          .limit(1);
        const first = rows[0] || null;
        selected = first && isContentGenerationJobRun(first) ? first : null;
      } else {
        const rows = await db
          .select()
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.userId, ctx.user.id),
              eq(agentRuns.campaignId, input.campaignId),
              eq(agentRuns.agentType, "creative")
            )
          )
          .orderBy(desc(agentRuns.createdAt))
          .limit(50);
        selected = rows.find((row) => isContentGenerationJobRun(row)) || null;
      }

      if (!selected) {
        return null;
      }

      const output = (selected.output || {}) as any;
      const durations = (output.durations || {}) as any;
      return {
        jobId: selected.id,
        campaignId: Number(selected.campaignId || input.campaignId),
        status: mapGenerationStatus(selected.status),
        error: selected.error || null,
        startedAt: selected.startedAt,
        completedAt: selected.completedAt,
        postCount: Number(output.postCount || 0),
        messageArchitectDurationMs: Number(durations.messageArchitectDurationMs || 0),
        creativeGenerationDurationMs: Number(durations.creativeGenerationDurationMs || 0),
        qualityRetryDurationMs: Number(durations.qualityRetryDurationMs || 0),
        fallbackDurationMs: Number(durations.fallbackDurationMs || 0),
        totalDurationMs: Number(durations.totalDurationMs || 0),
      };
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
        | "launch_approval_required"
        | "safety_blocked" = "ready";

      // Preflight content safety on the first approved image-ready social post so the
      // user sees any approval gate before clicking Confirm Publish.
      const eligiblePost = posts.find(isApprovedImageReadySocialPost);
      const platformSafety: Array<{
        platform: string;
        riskLevel: "low" | "medium" | "high";
        requiresApproval: boolean;
      }> = [];
      let safetyRiskLevel: "low" | "medium" | "high" = "low";
      if (eligiblePost) {
        const content = `${eligiblePost.hook || ""}\n${eligiblePost.caption || ""}\n${eligiblePost.cta || ""}`.trim();
        const safety = await checkContentSafety(content, {}, {
          userId: ctx.user.id,
          campaignId: input.campaignId,
          skipDeduction: true,
        });
        safetyRiskLevel = safety.riskLevel;
        for (const status of platformStatuses) {
          platformSafety.push({
            platform: status.platform,
            riskLevel: safety.riskLevel,
            requiresApproval: safety.riskLevel !== "low",
          });
        }
        logInfo("[PublishEligibility] Safety preflight", {
          campaignId: input.campaignId,
          riskLevel: safety.riskLevel,
          reasons: safety.reasons,
        });
      }

      if (safetyRiskLevel === "high") {
        unavailableReason = "safety_blocked";
      } else if (integrations.length > 0 && platformStatuses.length === 0) {
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
        platformSafety,
        safetyRiskLevel,
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

      // Select approved, image-ready social posts. We do not rely on an approvalStatus column
      // or a status="approved" enum value; the schema only supports draft/scheduled/published/archived.
      const approvedPosts = posts.filter(isApprovedImageReadySocialPost);

      if (approvedPosts.length === 0) {
        const candidatePosts = posts
          .filter((p) => p.type === "social_post")
          .map((p) => {
            const meta = (p.metadata || {}) as any;
            return {
              id: p.id,
              platform: p.platform,
              status: p.status,
              approved: !!meta.approved,
              assetKind: meta.assetKind,
              imageStatus: meta.imageStatus,
              hasImageUrl: !!meta.imageUrl,
            };
          });
        const message =
          "[PublishCampaignPack] Contract error: eligibility returned ready and publishable platforms exist, but no approved image-ready social post was found";
        logError(message, {
          campaignId: input.campaignId,
          userId: ctx.user.id,
          businessId: campaignBusinessId,
          publishablePlatforms,
          candidatePosts,
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No approved image-ready social post found for publishing.",
        });
      }

      logInfo("[PublishCampaignPack] Selecting posts for platforms", {
        campaignId: input.campaignId,
        publishablePlatforms,
        candidatePostIds: approvedPosts.map((p) => {
          const meta = (p.metadata || {}) as any;
          return {
            id: p.id,
            platform: p.platform,
            approved: !!meta.approved,
            assetKind: meta.assetKind,
            imageStatus: meta.imageStatus,
            hasImageUrl: !!meta.imageUrl,
          };
        }),
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

        // Find best content post for this platform:
        // 1. Platform-specific post whose platform matches (case-insensitive).
        // 2. A master_campaign_post that can be reused across platforms.
        // 3. Any other approved image-ready social post as final fallback.
        let selectionReason = "platform-specific";
        let post = approvedPosts.find((p) => p.platform?.toLowerCase() === platform);
        if (!post) {
          const masterPost = approvedPosts.find(
            (p) => (p.metadata as any)?.assetKind === "master_campaign_post"
          );
          if (masterPost) {
            post = masterPost;
            selectionReason = "master_campaign_post fallback";
          } else {
            post = approvedPosts[0];
            selectionReason = "first approved post fallback";
          }
        }

        if (!post) {
          const message = `[PublishCampaignPack] Contract error: no approved social post could be selected for platform ${platform}`;
          logError(message, {
            campaignId: input.campaignId,
            platform,
            approvedPostIds: approvedPosts.map((p) => p.id),
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Publishing post selection failed. Please contact support.",
          });
        }

        const postMeta = (post.metadata || {}) as any;
        logInfo("[PublishCampaignPack] Selected post for platform", {
          campaignId: input.campaignId,
          platform,
          selectedPostId: post.id,
          selectedPostPlatform: post.platform,
          selectedPostStatus: post.status,
          selectedPostApproved: !!postMeta.approved,
          selectedPostAssetKind: postMeta.assetKind,
          selectedPostImageStatus: postMeta.imageStatus,
          selectedPostHasImageUrl: !!postMeta.imageUrl,
          selectionReason,
        });

        // Preflight content safety per platform. We skip billing here so the preflight
        // does not consume credits and cannot cause a later platform to fail due to
        // insufficient credits after a sibling platform has already published.
        const content = `${post.hook || ""}\n${post.caption || ""}\n${post.cta || ""}`.trim();
        const safety = await checkContentSafety(content, {}, {
          userId: ctx.user.id,
          campaignId: input.campaignId,
          skipDeduction: true,
        });
        const isLowRisk = safety.riskLevel === "low";
        const safetyMessage = isLowRisk
          ? undefined
          : `Content safety check flagged ${safety.riskLevel} risk; awaiting approval`;

        logInfo("[PublishCampaignPack] Safety preflight for platform", {
          campaignId: input.campaignId,
          platform,
          riskLevel: safety.riskLevel,
          reasons: safety.reasons,
        });

        // Idempotency: look for any existing queue item for this post/platform, regardless
        // of status, so we never duplicate a platform that is already published or pending.
        let queueItemId: number;
        const [existingQueue] = await db
          .select()
          .from(publishingQueue)
          .where(
            and(
              eq(publishingQueue.userId, ctx.user.id),
              eq(publishingQueue.campaignId, input.campaignId),
              eq(publishingQueue.contentPostId, post.id),
              eq(publishingQueue.platform, platform)
            )
          )
          .limit(1);

        if (existingQueue) {
          queueItemId = existingQueue.id;
          logInfo("[PublishCampaignPack] Reusing existing queue item", {
            campaignId: input.campaignId,
            platform,
            contentPostId: post.id,
            queueItemId,
            queueStatus: existingQueue.status,
            integrationId: integration.id,
            pageId: platform === "facebook" ? integration.pageId : undefined,
          });

          if (existingQueue.status === "published") {
            results.push({
              platform,
              queueItemId,
              status: "published",
              postId: existingQueue.externalPostId || undefined,
            });
            continue;
          }

          if (existingQueue.status === "pending_approval" || existingQueue.status === "safety_blocked") {
            results.push({
              platform,
              queueItemId,
              status: existingQueue.status,
              error: existingQueue.lastError || undefined,
            });
            continue;
          }

          // Existing item is approved/retrying/failed. If current preflight is non-low,
          // move it back to pending approval rather than publishing.
          if (!isLowRisk) {
            await db
              .update(publishingQueue)
              .set({
                status: "pending_approval",
                approvalRequired: true,
                lastError: safetyMessage,
                safetyStatus: safety.riskLevel,
              })
              .where(eq(publishingQueue.id, queueItemId));
            results.push({
              platform,
              queueItemId,
              status: "pending_approval",
              error: safetyMessage,
            });
            continue;
          }
        } else {
          // Determine initial queue status from safety + integration readiness.
          let initialStatus: "approved" | "pending_approval" | "failed" = "approved";
          let queueError: string | undefined;

          if (!isLowRisk) {
            initialStatus = "pending_approval";
            queueError = safetyMessage;
          } else if (platform === "facebook" && !isFacebookPublishingReady(integration)) {
            initialStatus = "failed";
            queueError =
              "Facebook integration is not publishing-ready. Reconnect to grant pages_manage_posts.";
          } else if (platform === "instagram" && !isInstagramPublishingReady(integration)) {
            initialStatus = "failed";
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
            status: initialStatus,
            lastError: queueError ?? null,
            approvalRequired: initialStatus === "pending_approval",
            scheduledAt: null,
          });
          queueItemId = Number(queueResult.insertId);

          logInfo("[PublishCampaignPack] Created queue item", {
            campaignId: input.campaignId,
            platform,
            contentPostId: post.id,
            queueItemId,
            integrationId: integration.id,
            status: initialStatus,
            pageId: platform === "facebook" ? integration.pageId : undefined,
          });

          if (initialStatus === "failed") {
            results.push({
              platform,
              queueItemId,
              status: "failed",
              error: queueError,
            });
            continue;
          }

          if (initialStatus === "pending_approval") {
            results.push({
              platform,
              queueItemId,
              status: "pending_approval",
              error: queueError,
            });
            continue;
          }
        }

        // Attempt immediate publish for low-risk, ready items
        const publishResult = await publishSinglePost(queueItemId);

        logInfo("[PublishCampaignPack] Publish attempt completed", {
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

      // Finalize campaign/content-post state from the authoritative publishing_queue
      // rows. This also handles the case where the user later approves a pending
      // platform via the per-platform approval flow.
      const allPublished = results.length > 0 && results.every((r) => r.status === "published");
      logInfo("[PublishCampaignPack] Campaign state update", {
        campaignId: input.campaignId,
        allPublished,
        resultCount: results.length,
        results: results.map((r) => ({ platform: r.platform, status: r.status })),
      });

      await finalizeCampaignPublishState(input.campaignId).catch((err: any) => {
        logError("[PublishCampaignPack] finalizeCampaignPublishState failed", {
          campaignId: input.campaignId,
          error: err.message,
        });
      });

      return {
        success: true,
        approvedCount: posts.filter((p) => p.status !== "published" && p.status !== "archived").length,
        publishedCount: results.filter((r) => r.status === "published").length,
        failedCount: results.filter((r) => r.status === "failed" || r.status === "safety_blocked").length,
        skippedCount: results.filter((r) => r.status === "skipped").length,
        pendingApprovalCount: results.filter((r) => r.status === "pending_approval").length,
        results,
      };
    }),
});
