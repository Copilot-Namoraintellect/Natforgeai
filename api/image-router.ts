import { z } from "zod";
import { createRouter, authedQuery, aiActionQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { generatedImages, contentPosts, businesses, campaigns } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { checkCredits, deductCredits, recordAiUsage, adminAdjustCredits } from "./lib/billing/credit-engine";
import { calculateFixedCost } from "./lib/billing/cost-tracker";
import { generateBasicDraftLeaflet, generatePremiumLeaflet, generateCaptionPack } from "./lib/creative/service";
import {
  getPremiumImageCredits,
  getPremiumImageInternalCredits,
  getPremiumImageExternalCredits,
  getPremiumImageAiCredits,
} from "./lib/creative/costs";
import {
  getPremiumTemplateStatus,
  listPremiumTemplates,
  getBestTemplateForCampaign,
} from "./lib/creative/template-catalogue";
import { isOpenAiLeafletConfigured } from "./lib/creative/registry";
import { getQualityAuthorityMode } from "./lib/creative/contracts/creative-contract";
import type { RenderedQualityObservationAuthority } from "./lib/creative/contracts/rendered-quality-observation-scope";
import {
  InMemoryWorkflowOperationRegistry,
} from "./lib/workflow/workflow-operation";
import { TRPCError } from "@trpc/server";

/**
 * Router-owned Slice 5E workflow authority for a user-initiated premium leaflet
 * render. Constructed only when QUALITY_AUTHORITY_MODE=observe; any failure
 * falls back to null so the legacy request behavior is preserved. The service,
 * renderer, scope and observer never create registry or operation authority.
 */
async function buildImageRenderWorkflowObservation(
  userId: number,
  contentPostId: number
): Promise<RenderedQualityObservationAuthority | null> {
  if (getQualityAuthorityMode().effectiveMode !== "observe") return null;
  try {
    const db = getDb();
    const [post] = await db
      .select({ campaignId: contentPosts.campaignId })
      .from(contentPosts)
      .where(and(eq(contentPosts.id, contentPostId), eq(contentPosts.userId, userId)))
      .limit(1);
    // Unknown post: the service will fail the request authoritatively; no
    // orphan operation is created here.
    if (!post) return null;
    // A one-off post without a campaign has no approved campaign lineage, so
    // Slice 5 observation has no authoritative campaign identity to bind.
    // Fail closed: no registry, no operation — and never substitute an
    // invented sentinel (0, post id, user id) for campaign identity.
    if (post.campaignId == null) return null;
    const identity = {
      operationType: "creative_generation" as const,
      operationSource: "manual" as const,
      operationReferenceId: String(contentPostId),
      campaignId: post.campaignId,
      userId,
    };
    const registry = new InMemoryWorkflowOperationRegistry();
    const registration = registry.registerOperation(identity);
    registry.transitionOperation(registration.operation.workflowOperationId, "running");
    return {
      registry,
      workflowOperationId: registration.operation.workflowOperationId,
    };
  } catch (err: any) {
    console.error(
      `[image.generatePremiumLeaflet] workflow observation setup failed; continuing without observation | userId=${userId} | contentPostId=${contentPostId} | error="${err?.message ?? String(err)}"`
    );
    return null;
  }
}

const ALL_TEMPLATE_IDS = [
  "service_business_promo",
  "retail_product_promo",
  "offer_discount_campaign",
  "corporate_professional",
  "local_store_promo",
] as const;

export const imageRouter = createRouter({
  premiumImageCost: authedQuery.query(async () => {
    return { cost: getPremiumImageCredits() };
  }),

  premiumImageCosts: authedQuery.query(async () => {
    return {
      internal: getPremiumImageInternalCredits(),
      external: getPremiumImageExternalCredits(),
      ai: getPremiumImageAiCredits(),
    };
  }),

  listInternalTemplates: authedQuery
    .input(
      z.object({
        businessId: z.number().optional(),
        campaignId: z.number().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const templates = listPremiumTemplates();

      let business: any;
      let campaign: any;

      if (input?.businessId) {
        const [b] = await db.select().from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
        business = b;
      }
      if (input?.campaignId) {
        const [c] = await db.select().from(campaigns).where(eq(campaigns.id, input.campaignId)).limit(1);
        campaign = c;
      }

      const autoSelectedId = getBestTemplateForCampaign(business, campaign);

      return templates.map((t) => ({
        ...t,
        autoSelected: t.id === autoSelectedId,
      }));
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

  openAiLeafletStatus: authedQuery.query(async () => {
    return { configured: isOpenAiLeafletConfigured() };
  }),

  generateForPost: aiActionQuery
    .input(
      z.object({
        contentPostId: z.number(),
        brandColors: z.array(z.string()).optional(),
        creativeType: z.enum(["leaflet", "poster", "service_menu", "offer_advert", "event_announcement"]).default("leaflet"),
        templateId: z.enum(ALL_TEMPLATE_IDS).optional(),
        strongerBrandFit: z.boolean().default(false),
        creativeGuidance: z.string().optional(),
        refinementInstruction: z.string().optional(),
        allowNoLogo: z.boolean().optional(),
        regenerate: z.boolean().default(false),
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
        templateId: z.enum(ALL_TEMPLATE_IDS).optional(),
        provider: z.enum(["internal", "external", "ai", "v2"]).default("v2"),
        strongerBrandFit: z.boolean().default(false),
        creativeGuidance: z.string().optional(),
        refinementInstruction: z.string().optional(),
        allowNoLogo: z.boolean().optional(),
        regenerate: z.boolean().default(false),
        forceRegenerate: z.boolean().default(false),
        // Dormant B2A client adoption: accepted and validated only. It is not
        // forwarded to the creative service, persisted, logged, or returned;
        // it will only be consumed when B2B claim activation is separately
        // authorized.
        clientAttemptId: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,64}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const workflowObservation = await buildImageRenderWorkflowObservation(
        ctx.user.id,
        input.contentPostId
      );
      const result = await generatePremiumLeaflet({
        userId: ctx.user.id,
        contentPostId: input.contentPostId,
        brandColors: input.brandColors,
        creativeType: input.creativeType,
        templateId: input.templateId,
        provider: input.provider,
        strongerBrandFit: input.strongerBrandFit,
        creativeGuidance: input.creativeGuidance,
        refinementInstruction: input.refinementInstruction,
        allowNoLogo: input.allowNoLogo,
        regenerate: input.regenerate,
        forceRegenerate: input.forceRegenerate,
        workflowObservation,
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
