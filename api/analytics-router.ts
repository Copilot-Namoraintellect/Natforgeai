import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { analytics, campaigns, leads, contentPosts } from "@db/schema";
import { eq, desc } from "drizzle-orm";

export const analyticsRouter = createRouter({
  summary: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const userId = ctx.user.id;

    // Campaign counts by status
    const campaignData = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.userId, userId));

    // Lead counts
    const leadData = await db
      .select()
      .from(leads)
      .where(eq(leads.userId, userId));

    // Content counts
    const contentData = await db
      .select()
      .from(contentPosts)
      .where(eq(contentPosts.userId, userId));

    // Recent analytics metrics
    const recentMetrics = await db
      .select()
      .from(analytics)
      .where(eq(analytics.userId, userId))
      .orderBy(desc(analytics.date))
      .limit(30);

    return {
      campaigns: campaignData,
      leads: leadData,
      content: contentData,
      metrics: recentMetrics,
    };
  }),

  metrics: authedQuery
    .input(
      z
        .object({
          campaignId: z.number().optional(),
          metricType: z
            .enum([
              "impressions",
              "clicks",
              "conversions",
              "leads",
              "revenue",
              "engagement",
              "followers",
              "reach",
            ])
            .optional(),
          startDate: z.string().optional(),
          endDate: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const results = await db
        .select()
        .from(analytics)
        .where(eq(analytics.userId, ctx.user.id))
        .orderBy(desc(analytics.date));

      return results.filter((m) => {
        if (input?.campaignId && m.campaignId !== input.campaignId)
          return false;
        if (input?.metricType && m.metricType !== input.metricType)
          return false;
        if (input?.startDate && m.date) {
          const dateStr = m.date instanceof Date ? m.date.toISOString() : String(m.date);
          if (dateStr < input.startDate) return false;
        }
        if (input?.endDate && m.date) {
          const dateStr = m.date instanceof Date ? m.date.toISOString() : String(m.date);
          if (dateStr > input.endDate) return false;
        }
        return true;
      });
    }),

  record: authedQuery
    .input(
      z.object({
        metricType: z.enum([
          "impressions",
          "clicks",
          "conversions",
          "leads",
          "revenue",
          "engagement",
          "followers",
          "reach",
        ]),
        value: z.number(),
        date: z.string(),
        platform: z.string().optional(),
        campaignId: z.number().optional(),
        businessId: z.number().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db.insert(analytics).values({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        businessId: input.businessId,
        metricType: input.metricType,
        value: input.value,
        date: new Date(input.date),
        platform: input.platform,
      });
      return { success: true };
    }),
});
