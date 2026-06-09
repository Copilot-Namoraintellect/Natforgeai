import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { videoRenderJobs, contentPosts } from "@db/schema";
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
});
