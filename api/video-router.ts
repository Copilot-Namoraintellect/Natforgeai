import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { videoRenderJobs, contentPosts, campaigns, businesses } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getVideoProvider, isVideoRenderingConfigured } from "./lib/video/provider";

export const videoRouter = createRouter({
  getConfigStatus: authedQuery.query(() => {
    return {
      configured: isVideoRenderingConfigured(),
      provider: getVideoProvider().name,
    };
  }),

  listForCampaign: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      return db
        .select()
        .from(videoRenderJobs)
        .where(
          and(
            eq(videoRenderJobs.userId, ctx.user.id),
            eq(videoRenderJobs.campaignId, input.campaignId)
          )
        )
        .orderBy(desc(videoRenderJobs.createdAt));
    }),

  getRenderJob: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const [job] = await db
        .select()
        .from(videoRenderJobs)
        .where(
          and(
            eq(videoRenderJobs.id, input.id),
            eq(videoRenderJobs.userId, ctx.user.id)
          )
        )
        .limit(1);
      return job ?? null;
    }),

  createRenderJob: authedQuery
    .input(
      z.object({
        contentPostId: z.number(),
        campaignId: z.number(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      if (!isVideoRenderingConfigured()) {
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: "Video rendering is not configured. Add a VIDEO_PROVIDER environment variable to enable automatic video generation.",
        });
      }

      const [post] = await db
        .select()
        .from(contentPosts)
        .where(
          and(
            eq(contentPosts.id, input.contentPostId),
            eq(contentPosts.userId, ctx.user.id),
            eq(contentPosts.campaignId, input.campaignId)
          )
        )
        .limit(1);

      if (!post) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Content post not found" });
      }

      const metadata = (post.metadata || {}) as any;
      const provider = getVideoProvider();

      const result = await provider.generateVideo({
        contentPostId: post.id,
        campaignId: input.campaignId,
        userId: ctx.user.id,
        script: post.body || post.caption || "",
        scenes: metadata.scenes || [],
        duration: metadata.duration,
        style: metadata.visualStyle,
        title: post.title,
        businessName: metadata.businessName,
        productName: metadata.productName,
        offer: metadata.offer,
        cta: post.cta || metadata.cta,
      });

      const [inserted] = await db.insert(videoRenderJobs).values({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        contentPostId: input.contentPostId,
        provider: provider.name,
        renderJobId: result.jobId,
        renderStatus: result.status,
        videoUrl: result.videoUrl || null,
        thumbnailUrl: result.thumbnailUrl || null,
        errorMessage: result.errorMessage || null,
        creditCost: 0,
        createdBy: ctx.user.id,
      });

      return { jobId: Number(inserted.insertId), status: result.status };
    }),

  refreshStatus: authedQuery
    .input(z.object({ jobId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [job] = await db
        .select()
        .from(videoRenderJobs)
        .where(
          and(
            eq(videoRenderJobs.id, input.jobId),
            eq(videoRenderJobs.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!job || !job.renderJobId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Render job not found" });
      }

      const provider = getVideoProvider();
      const result = await provider.getStatus(job.renderJobId);

      await db
        .update(videoRenderJobs)
        .set({
          renderStatus: result.status,
          videoUrl: result.videoUrl || null,
          thumbnailUrl: result.thumbnailUrl || null,
          errorMessage: result.errorMessage || null,
          completedAt: result.status === "completed" || result.status === "failed" ? new Date() : undefined,
        })
        .where(eq(videoRenderJobs.id, job.id));

      return result;
    }),

  renderVideo: authedQuery
    .input(z.object({ contentPostId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

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

      if (post.type !== "video_concept" && post.type !== "reel_script") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This content type does not support video rendering" });
      }

      const metadata = (post.metadata || {}) as any;
      const scenes = metadata.scenes || [];
      const script = post.caption || post.body || "";

      if (!scenes.length && !script) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No video script or scenes found for this content post" });
      }

      // Set videoStatus to rendering in content post metadata
      await db
        .update(contentPosts)
        .set({
          metadata: {
            ...metadata,
            videoStatus: "rendering",
            renderProvider: "local",
            renderStartedAt: new Date().toISOString(),
          },
        })
        .where(eq(contentPosts.id, post.id));

      try {
        const provider = getVideoProvider();
        console.log(`[VideoRouter] Render start | contentPostId=${post.id} | campaignId=${post.campaignId} | provider=${provider.name} | userId=${ctx.user.id}`);

        // Fetch campaign and business for context
        let businessName = "";
        let productName = "";
        let offer = "";
        if (post.campaignId) {
          const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, post.campaignId)).limit(1);
          if (campaign?.businessId) {
            const [biz] = await db.select().from(businesses).where(eq(businesses.id, campaign.businessId)).limit(1);
            if (biz) {
              businessName = biz.name;
              productName = biz.productOrService || "";
            }
          }
          if (campaign?.offers && Array.isArray(campaign.offers) && campaign.offers.length > 0) {
            offer = (campaign.offers as any[])[0]?.description || "";
          }
        }

        const result = await provider.generateVideo({
          contentPostId: post.id,
          campaignId: post.campaignId ?? 0,
          userId: ctx.user.id,
          script,
          scenes,
          duration: metadata.duration,
          style: metadata.visualStyle,
          title: post.title,
          businessName,
          productName,
          offer,
          cta: post.cta || metadata.cta,
        });

        if (result.status === "failed" || !result.videoUrl) {
          const friendlyError = result.errorMessage || "Video rendering failed";
          console.error(`[VideoRouter] Render failed | contentPostId=${post.id} | campaignId=${post.campaignId} | provider=${provider.name} | error="${friendlyError}"`);

          await db
            .update(contentPosts)
            .set({
              metadata: {
                ...metadata,
                videoStatus: "failed",
                renderError: friendlyError,
                renderProvider: provider.name,
              },
            })
            .where(eq(contentPosts.id, post.id));

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: friendlyError,
          });
        }

        // Save success
        await db
          .update(contentPosts)
          .set({
            metadata: {
              ...metadata,
              videoStatus: "ready",
              videoUrl: result.videoUrl,
              thumbnailUrl: result.thumbnailUrl,
              renderJobId: result.jobId,
              renderProvider: provider.name,
              durationSeconds: result.durationSeconds,
              aspectRatio: result.aspectRatio,
              renderError: null,
              renderCompletedAt: new Date().toISOString(),
            },
          })
          .where(eq(contentPosts.id, post.id));

        // Also insert a videoRenderJobs record for audit
        await db.insert(videoRenderJobs).values({
          userId: ctx.user.id,
          campaignId: post.campaignId ?? 0,
          contentPostId: post.id,
          provider: provider.name,
          renderJobId: result.jobId,
          renderStatus: "completed",
          videoUrl: result.videoUrl,
          thumbnailUrl: result.thumbnailUrl || null,
          errorMessage: null,
          creditCost: 0,
          createdBy: ctx.user.id,
        });

        return {
          success: true,
          videoUrl: result.videoUrl,
          thumbnailUrl: result.thumbnailUrl,
          durationSeconds: result.durationSeconds,
          aspectRatio: result.aspectRatio,
        };
      } catch (err: any) {
        console.error(`[VideoRouter] Render exception | contentPostId=${post.id} | campaignId=${post.campaignId} | error="${err.message || String(err)}"`);
        // Ensure failed status is set on unexpected errors
        const currentMeta = (post.metadata || {}) as any;
        await db
          .update(contentPosts)
          .set({
            metadata: {
              ...currentMeta,
              videoStatus: "failed",
              renderError: err.message || "Unexpected render error",
            },
          })
          .where(eq(contentPosts.id, post.id));

        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err.message || "Video rendering failed",
        });
      }
    }),
});
