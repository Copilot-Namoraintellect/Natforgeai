import { z } from "zod";
import { createRouter, authedQuery, aiActionQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { generatedImages, contentPosts } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { checkCredits, deductCredits, recordAiUsage, adminAdjustCredits } from "./lib/billing/credit-engine";
import { calculateFixedCost } from "./lib/billing/cost-tracker";
import { generateBasicDraftLeaflet, generatePremiumLeaflet, generateCaptionPack } from "./lib/creative/service";
import { getPremiumImageCredits } from "./lib/creative/costs";
import { getPremiumTemplateStatus } from "./lib/creative/template-catalogue";
import { TRPCError } from "@trpc/server";

export const imageRouter = createRouter({
  premiumImageCost: authedQuery.query(async () => {
    return { cost: getPremiumImageCredits() };
  }),

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

      const [existing] = await db
        .select()
        .from(generatedImages)
        .where(
          and(
            eq(generatedImages.id, id),
            eq(generatedImages.userId, ctx.user.id)
          )
        )
        .limit(1);

      await db
        .update(generatedImages)
        .set(data)
        .where(
          and(
            eq(generatedImages.id, id),
            eq(generatedImages.userId, ctx.user.id)
          )
        );

      // Legacy image.create charges credits up-front. Refund if the worker marks the job as failed.
      if (data.status === "failed" && existing && existing.status === "pending" && existing.creditsCharged && existing.creditsCharged > 0) {
        try {
          await adminAdjustCredits({
            userId: ctx.user.id,
            amount: existing.creditsCharged,
            description: `Refund for failed image generation (image id ${id})`,
            adminUserId: 0,
          });
          console.log(`[image.update] Refunded ${existing.creditsCharged} credits to user ${ctx.user.id} for failed image ${id}`);
        } catch (refundErr: any) {
          console.error(`[image.update] Failed to refund credits for failed image ${id}:`, refundErr.message);
        }
      }

      return { success: true };
    }),

  premiumTemplateStatus: authedQuery.query(async () => {
    return getPremiumTemplateStatus();
  }),

  generateForPost: aiActionQuery
    .input(
      z.object({
        contentPostId: z.number(),
        brandColors: z.array(z.string()).optional(),
        creativeType: z.enum(["leaflet", "poster", "service_menu", "offer_advert", "event_announcement"]).default("leaflet"),
        templateId: z.enum(["service_business_promo", "retail_product_promo", "offer_discount_campaign"]).optional(),
        strongerBrandFit: z.boolean().default(false),
        creativeGuidance: z.string().optional(),
        refinementInstruction: z.string().optional(),
        allowNoLogo: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // generateForPost now explicitly generates a Basic Draft using the
      // internal deterministic template engine. It never charges premium
      // credits. Use generatePremiumLeaflet for the provider-backed premium
      // output.
      const result = await generateBasicDraftLeaflet({
        userId: ctx.user.id,
        contentPostId: input.contentPostId,
        brandColors: input.brandColors,
        creativeType: input.creativeType,
        templateId: input.templateId,
        creativeGuidance: input.creativeGuidance,
        refinementInstruction: input.refinementInstruction,
        allowNoLogo: input.allowNoLogo,
      });

      if (result.status === "failed") {
        const errorMessage = result.errorMessage || "Premium image generation failed";
        console.error(`[image.generateForPost] failed | userId=${ctx.user.id} | contentPostId=${input.contentPostId} | error="${errorMessage}"`);

        // Map provider/config failures to meaningful codes instead of always returning 500
        let code: "INTERNAL_SERVER_ERROR" | "PAYMENT_REQUIRED" | "NOT_IMPLEMENTED" | "BAD_REQUEST" = "INTERNAL_SERVER_ERROR";
        if (errorMessage.includes("not configured")) {
          code = "NOT_IMPLEMENTED";
        } else if (errorMessage.includes("Insufficient credits") || errorMessage.includes("spend limit")) {
          code = "PAYMENT_REQUIRED";
        } else if (errorMessage.includes("content policy") || errorMessage.includes("safety") || errorMessage.includes("400")) {
          code = "BAD_REQUEST";
        }

        throw new TRPCError({
          code,
          message: errorMessage,
        });
      }

      return {
        success: true,
        imageUrl: result.imageUrl,
        provider: result.provider,
        jobId: result.jobId,
        creditsCharged: result.creditsCharged,
        qualityTier: result.qualityTier,
        qualityLabel: result.qualityLabel,
        isDraft: result.isDraft,
      };
    }),

  generatePremiumLeaflet: aiActionQuery
    .input(
      z.object({
        contentPostId: z.number(),
        brandColors: z.array(z.string()).optional(),
        creativeType: z.enum(["leaflet", "poster", "service_menu", "offer_advert", "event_announcement"]).default("leaflet"),
        templateId: z.enum(["service_business_promo", "retail_product_promo", "offer_discount_campaign"]).optional(),
        strongerBrandFit: z.boolean().default(false),
        creativeGuidance: z.string().optional(),
        refinementInstruction: z.string().optional(),
        allowNoLogo: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await generatePremiumLeaflet({
        userId: ctx.user.id,
        contentPostId: input.contentPostId,
        brandColors: input.brandColors,
        creativeType: input.creativeType,
        templateId: input.templateId,
        strongerBrandFit: input.strongerBrandFit,
        creativeGuidance: input.creativeGuidance,
        refinementInstruction: input.refinementInstruction,
        allowNoLogo: input.allowNoLogo,
      });

      if (result.status === "failed") {
        const errorMessage = result.errorMessage || "Premium leaflet generation failed";
        console.error(`[image.generatePremiumLeaflet] failed | userId=${ctx.user.id} | contentPostId=${input.contentPostId} | error="${errorMessage}"`);

        let code: "INTERNAL_SERVER_ERROR" | "PAYMENT_REQUIRED" | "NOT_IMPLEMENTED" | "BAD_REQUEST" = "INTERNAL_SERVER_ERROR";
        if (errorMessage.includes("not configured")) {
          code = "NOT_IMPLEMENTED";
        } else if (errorMessage.includes("Insufficient credits") || errorMessage.includes("spend limit")) {
          code = "PAYMENT_REQUIRED";
        } else if (errorMessage.includes("content policy") || errorMessage.includes("safety") || errorMessage.includes("400")) {
          code = "BAD_REQUEST";
        }

        throw new TRPCError({
          code,
          message: errorMessage,
        });
      }

      return {
        success: true,
        imageUrl: result.imageUrl,
        provider: result.provider,
        jobId: result.jobId,
        creditsCharged: result.creditsCharged,
        qualityTier: result.qualityTier,
        qualityLabel: result.qualityLabel,
        isDraft: result.isDraft,
      };
    }),

  generateCaptionPack: aiActionQuery
    .input(z.object({ contentPostId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const pack = await generateCaptionPack({
        userId: ctx.user.id,
        contentPostId: input.contentPostId,
      });

      if (!pack) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Caption pack generation failed. Please try again.",
        });
      }

      return { success: true, pack };
    }),

  versionsForPost: authedQuery
    .input(z.object({ contentPostId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const images = await db
        .select({
          id: generatedImages.id,
          url: generatedImages.url,
          status: generatedImages.status,
          provider: generatedImages.provider,
          creditsCharged: generatedImages.creditsCharged,
          metadata: generatedImages.metadata,
          createdAt: generatedImages.createdAt,
        })
        .from(generatedImages)
        .where(
          and(
            eq(generatedImages.userId, ctx.user.id),
            eq(generatedImages.contentPostId, input.contentPostId)
          )
        )
        .orderBy(desc(generatedImages.createdAt));
      return images.map((img) => ({
        ...img,
        metadata: typeof img.metadata === "string" ? JSON.parse(img.metadata) : img.metadata,
      }));
    }),

  approveVersion: aiActionQuery
    .input(z.object({ contentPostId: z.number(), generatedImageId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [image] = await db
        .select()
        .from(generatedImages)
        .where(
          and(
            eq(generatedImages.id, input.generatedImageId),
            eq(generatedImages.userId, ctx.user.id)
          )
        )
        .limit(1);
      if (!image || image.status !== "completed") {
        throw new TRPCError({ code: "NOT_FOUND", message: "Image version not found or not completed." });
      }

      const [post] = await db
        .select({ metadata: contentPosts.metadata })
        .from(contentPosts)
        .where(and(eq(contentPosts.id, input.contentPostId), eq(contentPosts.userId, ctx.user.id)))
        .limit(1);
      if (!post) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Content post not found." });
      }

      const existingMeta = typeof post.metadata === "string" ? JSON.parse(post.metadata || "{}") : (post.metadata || {});
      const imageMeta = typeof image.metadata === "string" ? JSON.parse(image.metadata || "{}") : (image.metadata || {});

      await db
        .update(contentPosts)
        .set({
          metadata: JSON.stringify({
            ...existingMeta,
            imageUrl: image.url,
            imageStatus: "ready",
            currentVersionId: image.id,
            imageCurrentVersionId: image.id,
            versionApprovedAt: new Date().toISOString(),
            imageQualityScore: imageMeta.qualityScore ?? imageMeta.imageQualityScore ?? existingMeta.imageQualityScore,
          }),
          updatedAt: new Date(),
        })
        .where(and(eq(contentPosts.id, input.contentPostId), eq(contentPosts.userId, ctx.user.id)));
      return { success: true, imageUrl: image.url };
    }),
});
