import { z } from "zod";
import { createRouter, authedQuery, aiActionQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { contentPosts, campaigns, campaignAssets } from "@db/schema";
import { eq, and, desc, count } from "drizzle-orm";
import { runCreativeAgent } from "./lib/agents/creative-agent";
import { onAgentRunComplete } from "./lib/workflow/triggers";

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
        throw new Error("Campaign not found");
      }

      const result = await runCreativeAgent({
        userId: ctx.user.id,
        campaignId: input.campaignId,
      });

      try {
        await onAgentRunComplete(result.packRunId);
      } catch (err: any) {
        console.error("[content.generateForCampaign] onAgentRunComplete failed:", err.message);
      }

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

  publishCampaignPack: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const posts = await db
        .select()
        .from(contentPosts)
        .where(
          and(
            eq(contentPosts.userId, ctx.user.id),
            eq(contentPosts.campaignId, input.campaignId)
          )
        );

      // Guard: at least one approved social post must exist
      const socialPosts = posts.filter((p) => p.type === "social_post");
      const approvedSocial = socialPosts.filter((p) => {
        const meta = (p.metadata || {}) as any;
        return meta.approved === true || p.status === "published";
      });
      if (approvedSocial.length === 0 && socialPosts.length > 0) {
        throw new Error("At least one social post must be approved before publishing the campaign pack.");
      }

      // Guard: platform-specific captions must exist
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
      if (adaptations.length === 0) {
        throw new Error("Platform-specific captions are missing. Generate content first.");
      }

      // Guard: if video exists, it must be ready with a videoUrl
      const videos = posts.filter((p) => p.type === "video_concept" || p.type === "reel_script");
      for (const video of videos) {
        const meta = (video.metadata || {}) as any;
        if (meta.videoStatus === "concept" || meta.videoStatus === "rendering") {
          throw new Error("This campaign contains a video concept only. Render the video before publishing.");
        }
        if (meta.videoStatus === "ready" && !meta.videoUrl) {
          throw new Error("This campaign contains a video concept only. Render the video before publishing.");
        }
        if (meta.videoStatus === "failed") {
          throw new Error("Video rendering failed. Retry rendering or remove the video before publishing.");
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

      return { success: true, approvedCount: posts.filter((p) => p.status !== "published" && p.status !== "archived").length };
    }),
});
