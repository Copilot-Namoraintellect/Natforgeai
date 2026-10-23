import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { videoRenderJobs } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { env } from "./lib/env";
import {
  renderBasicDraftVideo,
  generatePremiumVideo,
  completePremiumVideo,
} from "./lib/creative/service";
import {
  isBasicVideoConfigured,
  isPremiumVideoConfigured,
} from "./lib/creative/registry";

export const videoRouter = createRouter({
  getConfigStatus: authedQuery.query(() => {
    return {
      basicConfigured: isBasicVideoConfigured(),
      premiumConfigured: isPremiumVideoConfigured(),
      provider: "creatify",
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

      // Only premium jobs need refresh; basic jobs are synchronous
      if (job.provider !== "creatify") {
        return {
          jobId: job.id,
          status: job.renderStatus,
          videoUrl: job.videoUrl,
          thumbnailUrl: job.thumbnailUrl,
          errorMessage: job.errorMessage,
        };
      }

      const result = await completePremiumVideo({
        userId: ctx.user.id,
        providerJobId: job.renderJobId,
      });

      return {
        jobId: job.id,
        status: result.status,
        videoUrl: result.videoUrl,
        thumbnailUrl: result.thumbnailUrl,
        errorMessage: result.errorMessage,
      };
    }),

  renderVideo: authedQuery
    .input(
      z.object({
        contentPostId: z.number(),
        mode: z.enum(["basic", "premium"]).default("basic"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Feature flags are enforced server-side, fail closed: the UI hides
      // these modes when the flags are off, but the API must not allow
      // callers to bypass that and trigger provider spend (premium spends
      // Creatify credits immediately) against a disabled feature.
      if (input.mode === "premium") {
        if (!env.enablePremiumVideo) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Premium video generation is not enabled on this deployment.",
          });
        }

        const result = await generatePremiumVideo({
          userId: ctx.user.id,
          contentPostId: input.contentPostId,
        });

        if (result.status === "failed") {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              result.errorMessage ||
              "Premium video generation failed. You can try Basic Draft Video instead.",
          });
        }

        return {
          success: true,
          mode: "premium",
          status: result.status,
          jobId: result.jobId,
          provider: result.provider,
          videoUrl: result.videoUrl,
          thumbnailUrl: result.thumbnailUrl,
          creditsRequired: result.creditsRequired,
        };
      }

      // Basic draft mode
      if (!env.enableBasicDraftVideo) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Basic draft video generation is not enabled on this deployment.",
        });
      }

      const result = await renderBasicDraftVideo({
        userId: ctx.user.id,
        contentPostId: input.contentPostId,
      });

      return {
        success: true,
        mode: "basic",
        status: result.status,
        jobId: result.jobId,
        provider: result.provider,
        videoUrl: result.videoUrl,
        thumbnailUrl: result.thumbnailUrl,
        durationSeconds: result.durationSeconds,
        aspectRatio: result.aspectRatio,
      };
    }),
});
