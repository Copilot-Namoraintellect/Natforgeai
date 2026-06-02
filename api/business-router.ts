import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { businesses } from "@db/schema";
import { eq, and } from "drizzle-orm";

export const businessRouter = createRouter({
  list: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    return db
      .select()
      .from(businesses)
      .where(eq(businesses.userId, ctx.user.id))
      .orderBy(businesses.createdAt);
  }),

  get: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const [biz] = await db
        .select()
        .from(businesses)
        .where(
          and(
            eq(businesses.id, input.id),
            eq(businesses.userId, ctx.user.id)
          )
        );
      return biz ?? null;
    }),

  create: authedQuery
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        industry: z.string().optional(),
        location: z.string().optional(),
        targetAudience: z.string().optional(),
        tone: z.string().optional(),
        website: z.string().optional(),
        productOrService: z.string().optional(),
        targetCustomer: z.string().optional(),
        monthlyBudget: z.number().optional(),
        brandTone: z.string().optional(),
        mainGoal: z.string().optional(),
        socialLinks: z.any().optional(),
        whatsappNumber: z.string().optional(),
        preferredPlatforms: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [biz] = await db.insert(businesses).values({
        userId: ctx.user.id,
        name: input.name,
        description: input.description,
        industry: input.industry,
        location: input.location,
        targetAudience: input.targetAudience,
        tone: input.tone ?? "professional",
        website: input.website,
        productOrService: input.productOrService,
        targetCustomer: input.targetCustomer,
        monthlyBudget: input.monthlyBudget,
        brandTone: input.brandTone,
        mainGoal: input.mainGoal,
        socialLinks: input.socialLinks,
        whatsappNumber: input.whatsappNumber,
        preferredPlatforms: input.preferredPlatforms,
        onboardingComplete: true,
      });
      return { id: Number(biz.insertId), success: true };
    }),

  update: authedQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        industry: z.string().optional(),
        location: z.string().optional(),
        targetAudience: z.string().optional(),
        tone: z.string().optional(),
        website: z.string().optional(),
        productOrService: z.string().optional(),
        targetCustomer: z.string().optional(),
        monthlyBudget: z.number().optional(),
        brandTone: z.string().optional(),
        mainGoal: z.string().optional(),
        socialLinks: z.any().optional(),
        whatsappNumber: z.string().optional(),
        preferredPlatforms: z.string().optional(),
        onboardingComplete: z.boolean().optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db
        .update(businesses)
        .set(data)
        .where(
          and(eq(businesses.id, id), eq(businesses.userId, ctx.user.id))
        );
      return { success: true };
    }),

  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db
        .delete(businesses)
        .where(
          and(
            eq(businesses.id, input.id),
            eq(businesses.userId, ctx.user.id)
          )
        );
      return { success: true };
    }),
});
