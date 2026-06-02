import { z } from "zod";
import { createRouter, authedQuery, aiActionQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { generatedImages } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { checkCredits, deductCredits, recordAiUsage } from "./lib/billing/credit-engine";
import { calculateFixedCost } from "./lib/billing/cost-tracker";
import { TRPCError } from "@trpc/server";

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

  create: aiActionQuery
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

      // Pre-flight credit check
      const IMAGE_COST = 2; // 2 credits per image generation
      const preCheck = await checkCredits(ctx.user.id, IMAGE_COST);
      if (!preCheck.hasCredits) {
        throw new TRPCError({
          code: "PAYMENT_REQUIRED",
          message: `Insufficient credits. You have ${preCheck.balance} credits. Image generation requires ${IMAGE_COST} credits.`,
        });
      }

      // Deduct credits
      await deductCredits({
        userId: ctx.user.id,
        amount: IMAGE_COST,
        type: "image_generation",
        description: "AI image generation",
        metadata: { prompt: input.prompt, campaignId: input.campaignId },
      });

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

      const imageId = Number(img.insertId);

      // Record AI usage for cost tracking
      const { actualCostUsdMicro, estimatedCostUsdMicro } = calculateFixedCost("estimated-image", 1);
      await recordAiUsage({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        agentType: "image_generation",
        model: "dall-e-3",
        promptTokens: 500,
        completionTokens: 100,
        actualCostUsdMicro,
        estimatedCostUsdMicro,
        creditsDeducted: IMAGE_COST,
        metadata: { imageId, prompt: input.prompt },
      });

      return { id: imageId, success: true };
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
