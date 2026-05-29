import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { generatedImages } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";

export const imageRouter = createRouter({
  list: authedQuery
    .input(
      z
        .object({
          campaignId: z.number().optional(),
          status: z.enum(["pending", "completed", "failed"]).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const results = await db
        .select()
        .from(generatedImages)
        .where(eq(generatedImages.userId, ctx.user.id))
        .orderBy(desc(generatedImages.createdAt));

      return results.filter((img) => {
        if (input?.campaignId && img.campaignId !== input.campaignId)
          return false;
        if (input?.status && img.status !== input.status) return false;
        return true;
      });
    }),

  create: authedQuery
    .input(
      z.object({
        prompt: z.string().min(1),
        aspectRatio: z.string().optional(),
        style: z.string().optional(),
        campaignId: z.number().optional(),
        businessId: z.number().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [img] = await db.insert(generatedImages).values({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        businessId: input.businessId,
        prompt: input.prompt,
        url: "",
        aspectRatio: input.aspectRatio ?? "1:1",
        style: input.style,
        status: "pending",
      });
      return { id: Number(img.insertId), success: true };
    }),

  update: authedQuery
    .input(
      z.object({
        id: z.number(),
        url: z.string().optional(),
        status: z.enum(["pending", "completed", "failed"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db
        .update(generatedImages)
        .set(data)
        .where(
          and(
            eq(generatedImages.id, id),
            eq(generatedImages.userId, ctx.user.id)
          )
        );
      return { success: true };
    }),

  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db
        .delete(generatedImages)
        .where(
          and(
            eq(generatedImages.id, input.id),
            eq(generatedImages.userId, ctx.user.id)
          )
        );
      return { success: true };
    }),
});
