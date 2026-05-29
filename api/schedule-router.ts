import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { schedules } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";

export const scheduleRouter = createRouter({
  list: authedQuery
    .input(
      z
        .object({
          month: z.string().optional(),
          platform: z.string().optional(),
          status: z.enum(["draft", "scheduled", "posted", "failed"]).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const results = await db
        .select()
        .from(schedules)
        .where(eq(schedules.userId, ctx.user.id))
        .orderBy(desc(schedules.scheduledDate));

      return results.filter((s) => {
        if (input?.month && s.scheduledDate) {
          const dateStr = s.scheduledDate instanceof Date
            ? s.scheduledDate.toISOString().slice(0, 7)
            : String(s.scheduledDate).slice(0, 7);
          if (!dateStr.startsWith(input.month)) return false;
        }
        if (input?.platform && s.platform !== input.platform) return false;
        if (input?.status && s.status !== input.status) return false;
        return true;
      });
    }),

  get: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const [s] = await db
        .select()
        .from(schedules)
        .where(
          and(eq(schedules.id, input.id), eq(schedules.userId, ctx.user.id))
        );
      return s ?? null;
    }),

  create: authedQuery
    .input(
      z.object({
        title: z.string().min(1),
        platform: z.string().min(1),
        scheduledDate: z.string(),
        scheduledTime: z.string().optional(),
        contentPostId: z.number().optional(),
        campaignId: z.number().optional(),
        businessId: z.number().optional(),
        contentType: z
          .enum([
            "educational",
            "promotional",
            "engagement",
            "awareness",
            "conversion",
          ])
          .optional(),
        notes: z.string().optional(),
        timezone: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [s] = await db.insert(schedules).values({
        userId: ctx.user.id,
        contentPostId: input.contentPostId,
        campaignId: input.campaignId,
        businessId: input.businessId,
        title: input.title,
        platform: input.platform,
        scheduledDate: new Date(input.scheduledDate),
        scheduledTime: input.scheduledTime,
        contentType: input.contentType ?? "educational",
        notes: input.notes,
        timezone: input.timezone ?? "UTC",
      });
      return { id: Number(s.insertId), success: true };
    }),

  update: authedQuery
    .input(
      z.object({
        id: z.number(),
        title: z.string().min(1).optional(),
        platform: z.string().optional(),
        scheduledDate: z.string().optional(),
        scheduledTime: z.string().optional(),
        status: z.enum(["draft", "scheduled", "posted", "failed"]).optional(),
        contentType: z
          .enum([
            "educational",
            "promotional",
            "engagement",
            "awareness",
            "conversion",
          ])
          .optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, scheduledDate, ...data } = input;
      const updateData: any = { ...data };
      if (scheduledDate) updateData.scheduledDate = new Date(scheduledDate);
      await db
        .update(schedules)
        .set(updateData)
        .where(and(eq(schedules.id, id), eq(schedules.userId, ctx.user.id)));
      return { success: true };
    }),

  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db
        .delete(schedules)
        .where(
          and(eq(schedules.id, input.id), eq(schedules.userId, ctx.user.id))
        );
      return { success: true };
    }),
});
