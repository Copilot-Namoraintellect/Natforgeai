import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { publishingQueue } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { publishDuePosts } from "./lib/workflow/publishing-runner";
import { schedulePublishingJob, isBullMQAvailable } from "./lib/queue/bullmq";

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

      if (!item) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Queue item not found" });
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
    .mutation(async () => {
      // Stub for Phase 4 (requires social integrations)
      return { success: false, message: "Publishing requires social integrations (Phase 4)" };
    }),

  publishDuePosts: authedQuery.mutation(async () => {
    const results = await publishDuePosts();
    return { success: true, results };
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
