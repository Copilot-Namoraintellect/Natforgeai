import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { campaigns } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";

export const campaignRouter = createRouter({
  list: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    return db
      .select()
      .from(campaigns)
      .where(eq(campaigns.userId, ctx.user.id))
      .orderBy(desc(campaigns.createdAt));
  }),

  get: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const [camp] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, input.id),
            eq(campaigns.userId, ctx.user.id)
          )
        );
      return camp ?? null;
    }),

  create: authedQuery
    .input(
      z.object({
        name: z.string().min(1),
        goal: z.string().min(1),
        businessId: z.number().optional(),
        targetAudience: z.string().optional(),
        coreMessage: z.string().optional(),
        platforms: z.string().optional(),
        budget: z.number().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        strategy: z.string().optional(),
        personas: z.any().optional(),
        contentCalendar: z.any().optional(),
        adConcepts: z.any().optional(),
        funnelStages: z.any().optional(),
        offers: z.any().optional(),
        ctaStrategy: z.string().optional(),
        aiGenerated: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const data: any = {
        userId: ctx.user.id,
        businessId: input.businessId,
        name: input.name,
        goal: input.goal,
        targetAudience: input.targetAudience,
        coreMessage: input.coreMessage,
        platforms: input.platforms,
        budget: input.budget,
        strategy: input.strategy,
        personas: input.personas,
        contentCalendar: input.contentCalendar,
        adConcepts: input.adConcepts,
        funnelStages: input.funnelStages,
        offers: input.offers,
        ctaStrategy: input.ctaStrategy,
        aiGenerated: input.aiGenerated ?? false,
      };
      if (input.startDate) data.startDate = new Date(input.startDate);
      if (input.endDate) data.endDate = new Date(input.endDate);
      const [camp] = await db.insert(campaigns).values(data);
      return { id: Number(camp.insertId), success: true };
    }),

  update: authedQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        goal: z.string().optional(),
        status: z.enum(["draft", "active", "paused", "completed"]).optional(),
        targetAudience: z.string().optional(),
        coreMessage: z.string().optional(),
        platforms: z.string().optional(),
        budget: z.number().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        strategy: z.string().optional(),
        personas: z.any().optional(),
        contentCalendar: z.any().optional(),
        adConcepts: z.any().optional(),
        funnelStages: z.any().optional(),
        offers: z.any().optional(),
        ctaStrategy: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, ...rawData } = input;
      const data: any = { ...rawData };
      if (input.startDate) data.startDate = new Date(input.startDate);
      if (input.endDate) data.endDate = new Date(input.endDate);
      await db
        .update(campaigns)
        .set(data)
        .where(
          and(eq(campaigns.id, id), eq(campaigns.userId, ctx.user.id))
        );
      return { success: true };
    }),

  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db
        .delete(campaigns)
        .where(
          and(
            eq(campaigns.id, input.id),
            eq(campaigns.userId, ctx.user.id)
          )
        );
      return { success: true };
    }),
});
