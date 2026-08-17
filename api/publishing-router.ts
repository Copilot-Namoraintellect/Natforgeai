import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { publishingQueue, contentPosts, socialIntegrations } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { publishDuePosts, publishSinglePost } from "./lib/workflow/publishing-runner";
import { isFacebookPublishingReady } from "./lib/integrations/platforms";
import { schedulePublishingJob, isBullMQAvailable } from "./lib/queue/bullmq";
import { env } from "./lib/env";
import { publishToFacebook } from "./lib/integrations/platforms";
import { decryptToken } from "./lib/crypto";
import { loadAndAssertCampaignPublicationReadiness } from "./lib/creative/publication-readiness-service";

export const publishingRouter = createRouter({
  createPublishingQueue: authedQuery
    .input(
      z.object({
        campaignId: z.number(),
        posts: z.array(
          z.object({
            contentPostId: z.number().optional(),
            platform: z.string(),
            scheduledAt: z.string().optional(),
            approvalRequired: z.boolean().default(false),
          })
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const createdIds: number[] = [];

      // Phase 2B: pre-flight readiness check for every selected post. No queue item
      // is inserted unless every selected campaign output is current and ready.
      for (const post of input.posts) {
        if (!post.contentPostId) continue;
        const [contentPost] = await db
          .select()
          .from(contentPosts)
          .where(and(eq(contentPosts.id, post.contentPostId), eq(contentPosts.userId, ctx.user.id)))
          .limit(1);
        if (!contentPost) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Content post ${post.contentPostId} not found` });
        }
        if (contentPost.campaignId && contentPost.campaignId !== input.campaignId) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Content post ${post.contentPostId} does not belong to this campaign` });
        }
        if (contentPost.campaignId) {
          await loadAndAssertCampaignPublicationReadiness({
            db,
            userId: ctx.user.id,
            campaignId: input.campaignId,
            selectedOutput: { record: contentPost, type: "content_post" },
            requireLaunchApproval: false,
          });
        }
      }

      for (const post of input.posts) {
        const [result] = await db.insert(publishingQueue).values({
          userId: ctx.user.id,
          campaignId: input.campaignId,
          contentPostId: post.contentPostId ?? null,
          platform: post.platform,
          scheduledAt: post.scheduledAt ? new Date(post.scheduledAt) : null,
          status: post.approvalRequired ? "pending_approval" : "approved",
          approvalRequired: post.approvalRequired,
        });
        const queueItemId = Number(result.insertId);
        createdIds.push(queueItemId);

        // Schedule BullMQ job for approved posts
        if (!post.approvalRequired && post.scheduledAt && isBullMQAvailable()) {
          try {
            await schedulePublishingJob(
              queueItemId,
              ctx.user.id,
              post.platform,
              new Date(post.scheduledAt)
            );
          } catch (err: any) {
            console.error(`[Publishing] Failed to schedule BullMQ job for ${queueItemId}:`, err.message);
          }
        }
      }

      return { success: true, ids: createdIds };
    }),

  approvePost: authedQuery
    .input(z.object({ queueId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [item] = await db
        .select()
        .from(publishingQueue)
        .where(
          and(
            eq(publishingQueue.id, input.queueId),
            eq(publishingQueue.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!item || item.userId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Queue item not found" });
      }

      // Phase 2B: guard approval of campaign-linked posts. No status mutation or
      // scheduling if the selected output is missing or stale.
      if (item.contentPostId) {
        const [contentPost] = await db
          .select()
          .from(contentPosts)
          .where(and(eq(contentPosts.id, item.contentPostId), eq(contentPosts.userId, ctx.user.id)))
          .limit(1);
        if (!contentPost) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Content post not found" });
        }
        if (contentPost.campaignId && contentPost.campaignId !== item.campaignId) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Content post does not belong to this campaign" });
        }
        if (contentPost?.campaignId) {
          await loadAndAssertCampaignPublicationReadiness({
            db,
            userId: ctx.user.id,
            campaignId: item.campaignId,
            selectedOutput: { record: contentPost, type: "content_post" },
            requireLaunchApproval: false,
          });
        }
      }

      await db
        .update(publishingQueue)
        .set({ status: "approved" })
        .where(eq(publishingQueue.id, input.queueId));

      // Schedule BullMQ job if scheduledAt is set
      if (item.scheduledAt && isBullMQAvailable()) {
        try {
          await schedulePublishingJob(
            item.id,
            item.userId,
            item.platform,
            new Date(item.scheduledAt)
          );
        } catch (err: any) {
          console.error(`[Publishing] Failed to schedule BullMQ job for ${item.id}:`, err.message);
        }
      }

      return { success: true };
    }),

  publishPost: authedQuery
    .input(z.object({ queueId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [item] = await db
        .select()
        .from(publishingQueue)
        .where(
          and(
            eq(publishingQueue.id, input.queueId),
            eq(publishingQueue.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!item || item.userId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Queue item not found" });
      }

      if (item.status !== "approved" && item.status !== "retrying") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Post cannot be published because it is ${item.status}. Approve it first.`,
        });
      }

      // Phase 2B: single-item readiness gate before the external platform call.
      if (item.contentPostId) {
        const [contentPost] = await db
          .select()
          .from(contentPosts)
          .where(and(eq(contentPosts.id, item.contentPostId), eq(contentPosts.userId, ctx.user.id)))
          .limit(1);
        if (!contentPost) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Content post not found" });
        }
        if (contentPost.campaignId && contentPost.campaignId !== item.campaignId) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Content post does not belong to this campaign" });
        }
        if (contentPost?.campaignId) {
          await loadAndAssertCampaignPublicationReadiness({
            db,
            userId: ctx.user.id,
            campaignId: item.campaignId,
            selectedOutput: { record: contentPost, type: "content_post" },
            requireLaunchApproval: true,
          });
        }
      }

      const result = await publishSinglePost(item.id);
      return {
        success: result.status === "published",
        status: result.status,
        platform: result.platform,
        postId: result.postId,
        error: result.error,
      };
    }),

  previewPost: authedQuery
    .input(z.object({ queueId: z.number().optional(), contentPostId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();

      let contentPost: any = null;
      let queueItem: any = null;

      if (input.queueId) {
        const [item] = await db
          .select()
          .from(publishingQueue)
          .where(
            and(
              eq(publishingQueue.id, input.queueId),
              eq(publishingQueue.userId, ctx.user.id)
            )
          )
          .limit(1);
        if (!item) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Queue item not found" });
        }
        queueItem = item;
        if (item.contentPostId) {
          const [post] = await db
            .select()
            .from(contentPosts)
            .where(eq(contentPosts.id, item.contentPostId))
            .limit(1);
          contentPost = post;
        }
      } else if (input.contentPostId) {
        const [post] = await db
          .select()
          .from(contentPosts)
          .where(
            and(
              eq(contentPosts.id, input.contentPostId),
              eq(contentPosts.userId, ctx.user.id)
            )
          )
          .limit(1);
        if (!post) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Content post not found" });
        }
        contentPost = post;
      } else {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Provide queueId or contentPostId" });
      }

      if (!contentPost) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Content post not found" });
      }

      const postMeta = (contentPost.metadata || {}) as any;
      const imageUrl = postMeta?.imageUrl || (contentPost as any).imageUrl || null;

      return {
        platform: queueItem?.platform || contentPost.platform || null,
        text: `${contentPost.hook || ""}\n\n${contentPost.caption || ""}\n\n${contentPost.cta || ""}`.trim(),
        imageUrl,
        caption: contentPost.caption || "",
        hook: contentPost.hook || "",
        cta: contentPost.cta || "",
        hashtags: contentPost.hashtags || [],
      };
    }),

  getPublishingReadiness: authedQuery
    .input(z.object({ platform: z.enum(["facebook", "instagram", "linkedin", "twitter", "tiktok"]) }))
    .query(async ({ ctx, input }) => {
      const db = getDb();

      // Check whether the platform is configured at the app/admin level.
      let adminConfigured = false;
      switch (input.platform) {
        case "facebook":
        case "instagram":
          adminConfigured = !!(env.metaAppId && env.metaAppSecret && env.metaRedirectUri);
          break;
        case "linkedin":
          adminConfigured = !!(env.linkedinClientId && env.linkedinClientSecret && env.linkedinRedirectUri);
          break;
        case "twitter":
          adminConfigured = !!(process.env.TWITTER_CLIENT_ID && process.env.TWITTER_CLIENT_SECRET);
          break;
        case "tiktok":
          adminConfigured = !!(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
          break;
      }

      // Check whether this user has a connected account for the platform.
      const [integration] = await db
        .select()
        .from(socialIntegrations)
        .where(
          and(
            eq(socialIntegrations.userId, ctx.user.id),
            eq(socialIntegrations.platform, input.platform),
            eq(socialIntegrations.status, "connected")
          )
        )
        .limit(1);

      const connected = !!integration;
      const publishingReady = connected
        ? input.platform === "facebook"
          ? isFacebookPublishingReady(integration)
          : true
        : false;
      const ready = adminConfigured && publishingReady;

      return {
        platform: input.platform,
        adminConfigured,
        connected,
        accountName: integration?.accountName || null,
        ready,
        message: !adminConfigured
          ? `Admin setup required: ${input.platform} OAuth credentials are not configured.`
          : !connected
          ? `Connect your ${input.platform} account in Settings > Integrations before publishing.`
          : !publishingReady
          ? `Your ${input.platform} account is connected but missing publishing permissions. Reconnect to grant pages_manage_posts.`
          : "Ready to publish.",
      };
    }),

  publishDuePosts: authedQuery.mutation(async () => {
    const results = await publishDuePosts();
    return { success: true, results };
  }),

  publishSmokeTest: authedQuery
    .input(
      z.object({
        platform: z.enum(["facebook"]).default("facebook"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.platform !== "facebook") {
        throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Smoke test only supports Facebook Pages" });
      }

      const db = getDb();
      const [integration] = await db
        .select()
        .from(socialIntegrations)
        .where(
          and(
            eq(socialIntegrations.userId, ctx.user.id),
            eq(socialIntegrations.platform, "facebook"),
            eq(socialIntegrations.status, "connected")
          )
        )
        .limit(1);

      if (!integration) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No connected Facebook Page found. Connect a Page first.",
        });
      }

      if (!isFacebookPublishingReady(integration)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Facebook integration is not publishing-ready. Reconnect to grant pages_manage_posts.",
        });
      }

      if (!integration.pageAccessTokenEncrypted || !integration.pageId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Selected Page token or Page ID is missing. Reconnect your Facebook Page.",
        });
      }

      const pageToken = decryptToken(integration.pageAccessTokenEncrypted);
      const result = await publishToFacebook(pageToken, integration.pageId, {
        text: `NatForgeAI smoke test: connection is healthy. Timestamp: ${new Date().toISOString()}`,
      });

      if (!result.success) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Smoke test failed: ${result.error || "Unknown error"}`,
        });
      }

      return {
        success: true,
        postId: result.postId,
        url: result.url,
        pageName: integration.accountName,
      };
    }),

  getPublishingQueue: authedQuery
    .input(
      z
        .object({
          campaignId: z.number().optional(),
          status: z
            .enum(["draft", "pending_approval", "approved", "published", "failed"])
            .optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const results = await db
        .select()
        .from(publishingQueue)
        .where(eq(publishingQueue.userId, ctx.user.id))
        .orderBy(desc(publishingQueue.createdAt));

      return results.filter((item) => {
        if (input?.campaignId && item.campaignId !== input.campaignId) return false;
        if (input?.status && item.status !== input.status) return false;
        return true;
      });
    }),
});
