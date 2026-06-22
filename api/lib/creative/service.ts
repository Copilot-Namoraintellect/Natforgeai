import { TRPCError } from "@trpc/server";
import { eq, and, desc } from "drizzle-orm";
import { env } from "../env";
import { getDb } from "../../queries/connection";
import { contentPosts, campaigns, businesses, generatedImages, videoRenderJobs, campaignAssets } from "@db/schema";
import { checkCredits, deductCredits, recordAiUsage } from "../billing/credit-engine";
import { enforceCostControl } from "../billing/cost-control";
import { getImageProvider, getPremiumVideoProvider, getBasicVideoProvider, getTemplateRendererProvider } from "./registry";
import { storeImageBuffer, downloadAndStoreVideo } from "./storage";
import { generateFallbackLeafletImage, defaultServiceBullets, selectTemplate, type TemplateId } from "./composition";
import { renderOffer, offerToHeadline, normalizeCta } from "./text-formatter";
import { resolveBrandPalette } from "./brand-palette";
import {
  getPremiumImageCredits,
  getPremiumVideoCredits,
  creatifyCreditsToUsd,
  usdToMicroCents,
} from "./costs";
import { getImageAspectRatio } from "./prompts/image-prompt";
import type { CreativeType } from "./prompts/image-prompt";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import type {
  ImageResult,
  ImageQualityTier,
  VideoResult,
  VideoRequest,
  ProviderStatus,
} from "./types";
import type { TemplateRendererRequest } from "./providers/template-renderer";
import { resolveProviderTemplateId, getPremiumTemplateStatus, type PremiumTemplateId } from "./template-catalogue";

function toJobStatus(status: ProviderStatus): "queued" | "rendering" | "completed" | "failed" | "cancelled" {
  switch (status) {
    case "done":
      return "completed";
    case "running":
      return "rendering";
    case "pending":
      return "queued";
    case "queued":
      return "queued";
    case "rendering":
      return "rendering";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "queued";
  }
}


function buildVideoRequest(opts: {
  business: any;
  campaign: any;
  post: any;
}): VideoRequest {
  const { business, campaign, post } = opts;
  const meta = (post.metadata || {}) as any;

  const scenes = Array.isArray(meta.scenes)
    ? meta.scenes.map((s: any, idx: number) => ({
        sceneNumber: s.sceneNumber ?? idx + 1,
        visualDescription: s.visualDescription || "",
        onScreenText: s.onScreenText ?? null,
        voiceoverScript: s.voiceoverScript ?? null,
      }))
    : [];

  return {
    contentPostId: post.id,
    campaignId: campaign.id,
    userId: post.userId,
    script: meta.voiceoverScript || post.caption || post.body || "",
    scenes,
    duration: meta.duration,
    style: meta.visualStyle || campaign.contentStyle,
    title: post.title,
    businessName: business.name,
    productName: business.productOrService || campaign.productOrService,
    offer: campaign.offerDetails,
    cta: campaign.preferredCta || post.cta,
    websiteUrl: business.website || "",
    targetAudience: campaign.targetBuyer || campaign.targetAudience,
    painPoint: campaign.mainPainPoint,
    productOrService: campaign.productOrService || business.productOrService,
    visualStyle: business.visualStyle || meta.visualStyle,
    brandColors: (business.brandColors as string[] | undefined) || [],
  };
}

// ─── Credit pre-check helper ───
async function assertCanAfford(userId: number, cost: number, feature: string) {
  const costControl = await enforceCostControl(userId, cost);
  if (!costControl.allowed) {
    throw new TRPCError({
      code: "PAYMENT_REQUIRED",
      message: costControl.reason,
    });
  }

  const preCheck = await checkCredits(userId, cost);
  if (!preCheck.hasCredits) {
    throw new TRPCError({
      code: "PAYMENT_REQUIRED",
      message: `${feature} requires ${cost} credits. You currently have ${preCheck.balance} credits.`,
    });
  }
}

// ─── Shared campaign/business loader ───
async function loadPostCampaignBusiness({
  userId,
  contentPostId,
}: {
  userId: number;
  contentPostId: number;
}) {
  const db = getDb();

  const [post] = await db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.id, contentPostId), eq(contentPosts.userId, userId)))
    .limit(1);

  if (!post) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Content post not found" });
  }

  let campaign: any = null;
  let business: any = null;

  if (post.campaignId) {
    [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, post.campaignId)).limit(1);
    if (campaign?.businessId) {
      [business] = await db.select().from(businesses).where(eq(businesses.id, campaign.businessId)).limit(1);
    }
  }

  if (!business) {
    const [latestBiz] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.userId, userId))
      .orderBy(desc(businesses.createdAt))
      .limit(1);
    if (latestBiz) {
      business = latestBiz;
    } else {
      business = { name: campaign?.name || post.title || "Your Business" };
    }
  }

  if (!campaign) {
    campaign = {};
  }

  return { post, campaign, business };
}

interface NormalizedLeafletInputs {
  formattedOffer: string;
  leafletHeadline: string;
  leafletCta: string;
  selectedTemplate: TemplateId;
  brandPalette: any;
  hasLogo: boolean;
  aspectRatio: string;
}

async function normalizeLeafletInputs({
  business,
  campaign,
  post,
  brandColors,
  creativeType,
  templateId,
  creativeGuidance,
  refinementInstruction,
}: {
  business: any;
  campaign: any;
  post: any;
  brandColors?: string[];
  creativeType: CreativeType;
  templateId?: TemplateId;
  creativeGuidance?: string;
  refinementInstruction?: string;
}): Promise<NormalizedLeafletInputs> {
  const brandPalette = await resolveBrandPalette({ ...business, brandColors });
  const hasLogo = !!business?.logo;
  const formattedOffer = renderOffer(campaign.offerDetails, business.name);
  const leafletHeadline = offerToHeadline(campaign.offerDetails);
  const selectedTemplate = selectTemplate({ business, campaign, creativeType, templateId, creativeGuidance, refinementInstruction });
  const businessCategory = (
    business?.websiteEvidence?.businessCategory ||
    business?.industry ||
    business?.productOrService ||
    ""
  ).toString();
  const leafletCta = normalizeCta(campaign.preferredCta || post.cta, businessCategory);
  const aspectRatio = getImageAspectRatio(creativeType, post.platform || "Instagram");

  return {
    formattedOffer,
    leafletHeadline,
    leafletCta,
    selectedTemplate,
    brandPalette,
    hasLogo,
    aspectRatio,
  };
}

async function setPostImageStatus(
  contentPostId: number,
  patch: { imageStatus: string; imageError?: string | null; [key: string]: any }
) {
  const db = getDb();
  const [post] = await db.select().from(contentPosts).where(eq(contentPosts.id, contentPostId)).limit(1);
  if (!post) return;
  const currentMeta = (post.metadata || {}) as any;
  await db
    .update(contentPosts)
    .set({
      metadata: {
        ...currentMeta,
        ...patch,
      },
    })
    .where(eq(contentPosts.id, contentPostId));
}

// ─── Basic Draft Leaflet generation ───
// Uses the internal deterministic template engine. Always 0 credits. Explicitly
// labelled as a draft/preview so it is never marketed or charged as premium.
export async function generateBasicDraftLeaflet({
  userId,
  contentPostId,
  brandColors,
  creativeType = "leaflet",
  templateId,
  creativeGuidance,
  refinementInstruction,
  allowNoLogo = false,
}: {
  userId: number;
  contentPostId: number;
  brandColors?: string[];
  creativeType?: CreativeType;
  templateId?: TemplateId;
  creativeGuidance?: string;
  refinementInstruction?: string;
  allowNoLogo?: boolean;
}): Promise<ImageResult> {
  const { post, campaign, business } = await loadPostCampaignBusiness({ userId, contentPostId });

  await setPostImageStatus(contentPostId, { imageStatus: "generating", imageError: null });

  try {
    const hasLogo = !!business?.logo;
    if (!hasLogo && !allowNoLogo) {
      const message = "Please upload your business logo in Settings before generating a leaflet, or generate a Basic Draft without a logo.";
      await setPostImageStatus(contentPostId, { imageStatus: "failed", imageError: message });
      return { status: "failed", jobId: "", errorMessage: message };
    }

    const {
      formattedOffer,
      leafletHeadline,
      leafletCta,
      selectedTemplate,
      brandPalette,
      aspectRatio,
    } = await normalizeLeafletInputs({ business, campaign, post, brandColors, creativeType, templateId, creativeGuidance, refinementInstruction });

    console.log(`[BasicDraftLeaflet] Generating draft | userId=${userId} | contentPostId=${contentPostId} | template=${selectedTemplate}`);

    const { buffer } = await generateFallbackLeafletImage({
      business,
      campaign,
      post,
      creativeType,
      templateId: selectedTemplate,
      aspectRatio,
      offer: formattedOffer,
      cta: leafletCta,
      headline: formattedOffer || leafletHeadline || campaign.primaryOutcome || post?.title || business.name,
      subheadline: campaign.mainPainPoint || campaign.coreMessage || post?.hook || "",
      palette: brandPalette,
      creativeGuidance,
      refinementInstruction,
    });

    const stored = await storeImageBuffer(buffer, {
      campaignId: post.campaignId ?? undefined,
      prefix: "basic-draft",
      extension: "png",
    });

    if (!stored.publicUrl || !stored.localPath) {
      throw new Error("Failed to store basic draft leaflet");
    }

    const qualityTier: ImageQualityTier = "draft";
    const qualityLabel = "Basic Draft";
    const score = 55;
    const warnings = ["Basic draft generated using the internal template engine. This is a preview only, not a premium leaflet."];

    const db = getDb();
    const currentMeta = (post.metadata || {}) as any;
    const previousVersions = Array.isArray(currentMeta?.imageVersions) ? currentMeta.imageVersions : [];
    const newVersion = {
      version: previousVersions.length + 1,
      url: stored.publicUrl,
      source: "draft",
      score,
      qualityTier,
      qualityLabel,
      promptUsed: "",
      strongerBrandFitUsed: false,
      creativeGuidance,
      refinementInstruction,
      brandPalette,
      hasLogo,
      templateId: selectedTemplate,
      generatedAt: new Date().toISOString(),
      approved: false,
    };
    const imageVersions = [...previousVersions, newVersion];

    await db.insert(generatedImages).values({
      userId,
      campaignId: post.campaignId,
      businessId: business.id,
      contentPostId: post.id,
      provider: "draft",
      providerJobId: "basic-draft",
      prompt: "",
      url: stored.publicUrl,
      aspectRatio,
      style: campaign.contentStyle || business.visualStyle,
      status: "completed",
      creditsCharged: 0,
      providerCostUsd: 0,
      metadata: {
        localPath: stored.localPath,
        source: "draft",
        qualityScore: score,
        qualityTier,
        qualityLabel,
        isDraft: true,
        validationIssues: warnings,
        warnings,
        templateId: selectedTemplate,
        versions: imageVersions,
      },
    });

    const [latestGenerated] = await db
      .select({ id: generatedImages.id })
      .from(generatedImages)
      .where(eq(generatedImages.contentPostId, post.id))
      .orderBy(desc(generatedImages.createdAt))
      .limit(1);
    const currentVersionId = latestGenerated?.id ?? null;

    await db
      .update(contentPosts)
      .set({
        metadata: {
          ...currentMeta,
          currentVersionId,
          imageCurrentVersionId: currentVersionId,
          imageUrl: stored.publicUrl,
          imageProvider: "draft",
          imageJobId: "basic-draft",
          imageStatus: "ready",
          imageGeneratedAt: new Date().toISOString(),
          imageError: null,
          imageCreditsCharged: 0,
          imageExtension: "png",
          imageSource: "draft",
          source: "draft",
          imageTemplateId: selectedTemplate,
          templateId: selectedTemplate,
          imageQualityScore: score,
          qualityScore: score,
          imageQualityTier: qualityTier,
          qualityTier,
          imageQualityLabel: qualityLabel,
          qualityLabel,
          imageIsDraft: true,
          isDraft: true,
          imageQualityWarnings: warnings,
          validationIssues: warnings,
          imageVersions,
          imageBrandPalette: brandPalette,
          imageHasLogo: hasLogo,
          imageCreativeGuidance: creativeGuidance,
          imageRefinementInstruction: refinementInstruction,
        },
      })
      .where(eq(contentPosts.id, post.id));

    console.log(`[BasicDraftLeaflet] Ready | userId=${userId} | contentPostId=${contentPostId} | url=${stored.publicUrl}`);

    return {
      jobId: "basic-draft",
      provider: "draft",
      status: "completed",
      imageUrl: stored.publicUrl,
      extension: "png",
      creditsCharged: 0,
      qualityTier,
      qualityLabel,
      isDraft: true,
      usingFallback: true,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[BasicDraftLeaflet] Failed | userId=${userId} | contentPostId=${contentPostId} | error="${errorMessage}"`, err);
    await setPostImageStatus(contentPostId, { imageStatus: "failed", imageError: errorMessage });
    return { status: "failed", jobId: "", errorMessage };
  }
}

// ─── Premium Marketing Leaflet generation ───
// Uses a provider-backed template renderer (Bannerbear first, Templated.io
// backup). Charges premium credits only after a successful provider render.
// OpenAI may generate an optional hero/background image or refine copy, but it
// must never control the final layout.
export async function generatePremiumLeaflet({
  userId,
  contentPostId,
  brandColors,
  creativeType = "leaflet",
  templateId,
  strongerBrandFit = false,
  creativeGuidance,
  refinementInstruction,
  allowNoLogo = false,
}: {
  userId: number;
  contentPostId: number;
  brandColors?: string[];
  creativeType?: CreativeType;
  templateId?: TemplateId;
  strongerBrandFit?: boolean;
  creativeGuidance?: string;
  refinementInstruction?: string;
  allowNoLogo?: boolean;
}): Promise<ImageResult> {
  const { post, campaign, business } = await loadPostCampaignBusiness({ userId, contentPostId });
  const db = getDb();
  const currentMeta = (post.metadata || {}) as any;

  const status = getPremiumTemplateStatus();
  if (!status.ready) {
    const message = "Premium templates are not configured yet. You can generate a Basic Draft for free.";
    console.warn(`[PremiumLeaflet] Blocked | userId=${userId} | contentPostId=${contentPostId} | missing=${status.missing?.join(",") || "feature flag/provider"}`);
    await setPostImageStatus(contentPostId, { imageStatus: "failed", imageError: message });
    return { status: "failed", jobId: "", errorMessage: message };
  }

  const templateRenderer = getTemplateRendererProvider();
  const cost = getPremiumImageCredits();
  await assertCanAfford(userId, cost, "Premium Marketing Leaflet");

  await setPostImageStatus(contentPostId, { imageStatus: "generating", imageError: null });

  try {
    const hasLogo = !!business?.logo;
    if (!hasLogo && !allowNoLogo) {
      const message = "Please upload your business logo in Settings before generating a Premium Marketing Leaflet. Premium leaflets require your logo and brand colours.";
      await setPostImageStatus(contentPostId, { imageStatus: "failed", imageError: message });
      return { status: "failed", jobId: "", errorMessage: message };
    }

    const {
      formattedOffer,
      leafletHeadline,
      leafletCta,
      selectedTemplate,
      brandPalette,
      aspectRatio,
    } = await normalizeLeafletInputs({ business, campaign, post, brandColors, creativeType, templateId, creativeGuidance, refinementInstruction });

    const premiumTemplateId: PremiumTemplateId = selectedTemplate as PremiumTemplateId;
    const providerTemplateId = resolveProviderTemplateId(templateRenderer.name, premiumTemplateId);

    if (!providerTemplateId) {
      const message = `Premium template "${premiumTemplateId}" is not configured for provider "${templateRenderer.name}". Contact admin to set the provider template ID.`;
      await setPostImageStatus(contentPostId, { imageStatus: "failed", imageError: message });
      return { status: "failed", jobId: "", errorMessage: message };
    }

    console.log(`[PremiumLeaflet] Rendering | userId=${userId} | contentPostId=${contentPostId} | provider=${templateRenderer.name} | template=${providerTemplateId}`);

    // Optional OpenAI hero/background generation. This is strictly an asset,
    // not the final layout. Failure here is non-blocking.
    let backgroundImageUrl: string | undefined;
    if (env.openaiApiKey && creativeGuidance?.toLowerCase().includes("background")) {
      try {
        const bgPrompt = `Professional marketing background for ${business.name}. ${creativeGuidance}. No text, no logos, no readable words, no brand marks. Clean, premium, photographic or illustrated background only.`;
        const imageProvider = getImageProvider();
        if (imageProvider.configured) {
          const bgResult = await imageProvider.generate({
            userId,
            campaignId: post.campaignId ?? undefined,
            businessId: business.id,
            contentPostId: post.id,
            prompt: bgPrompt,
            aspectRatio,
            style: campaign.contentStyle || business.visualStyle,
          });
          if (bgResult.status !== "failed" && (bgResult.imageUrl || bgResult.imageBase64)) {
            backgroundImageUrl = bgResult.imageUrl;
            if (!backgroundImageUrl && bgResult.imageBase64) {
              // Store base64 background locally so the provider can fetch it.
              const bgBuffer = Buffer.from(bgResult.imageBase64, "base64");
              const bgStored = await storeImageBuffer(bgBuffer, {
                campaignId: post.campaignId ?? undefined,
                prefix: "premium-bg",
                extension: bgResult.extension || "png",
              });
              backgroundImageUrl = bgStored.publicUrl;
            }
          }
        }
      } catch (bgErr: any) {
        console.warn(`[PremiumLeaflet] Optional background generation failed, continuing without it | error="${bgErr.message}"`);
      }
    }

    // Optional OpenAI copy refinement when stronger brand fit is requested.
    let headline = formattedOffer || leafletHeadline || campaign.primaryOutcome || post?.title || business.name;
    let offer = formattedOffer;
    let cta = leafletCta;
    let services = defaultServiceBullets(business, campaign);
    if (strongerBrandFit && env.openaiApiKey) {
      try {
        const refined = await refineLeafletCopy({
          business,
          campaign,
          headline,
          offer,
          cta,
          services,
          creativeGuidance,
          refinementInstruction,
        });
        headline = refined.headline;
        offer = refined.offer;
        cta = refined.cta;
        services = refined.services;
      } catch (refineErr: any) {
        console.warn(`[PremiumLeaflet] Copy refinement failed, using original copy | error="${refineErr.message}"`);
      }
    }

    const renderReq: TemplateRendererRequest = {
      providerTemplateId,
      format: "leaflet",
      outputFormat: "png",
      aspectRatio,
      businessName: business.name,
      logoUrl: business.logo,
      brandColors: [
        brandPalette.primary,
        brandPalette.secondary,
        brandPalette.accent,
        ...(brandColors || []),
      ].filter(Boolean),
      headline,
      offer,
      cta,
      services,
      contact: {
        phone: business.phone || undefined,
        whatsapp: business.whatsapp || undefined,
        website: business.website || undefined,
        email: business.email || undefined,
        location: business.address || business.location || undefined,
      },
      campaignObjective: campaign.primaryOutcome || campaign.goal || undefined,
      creativeGuidance,
      backgroundImageUrl,
    };

    const renderResult = await templateRenderer.render(renderReq);

    if (!renderResult.success || !renderResult.imageUrl) {
      const errorMessage = renderResult.error || "Premium template provider failed to render the leaflet.";
      console.error(`[PremiumLeaflet] Provider render failed | userId=${userId} | contentPostId=${contentPostId} | error="${errorMessage}"`);
      await setPostImageStatus(contentPostId, {
        imageStatus: "failed",
        imageError: `${errorMessage} You can generate a Basic Draft (0 credits) instead.`,
      });
      return {
        status: "failed",
        jobId: renderResult.providerJobId || "",
        errorMessage: `${errorMessage} You can generate a Basic Draft (0 credits) instead.`,
        provider: templateRenderer.name,
        providerJobId: renderResult.providerJobId,
      };
    }

    // Download provider image and store locally so we own the asset.
    let buffer: Buffer;
    try {
      const imgResponse = await fetch(renderResult.imageUrl);
      if (!imgResponse.ok) throw new Error(`Failed to download rendered image: ${imgResponse.status}`);
      buffer = Buffer.from(await imgResponse.arrayBuffer());
    } catch (downloadErr: any) {
      console.error(`[PremiumLeaflet] Failed to download provider image | url=${renderResult.imageUrl} | error="${downloadErr.message}"`);
      await setPostImageStatus(contentPostId, {
        imageStatus: "failed",
        imageError: `Downloaded rendered image failed: ${downloadErr.message}. You can generate a Basic Draft (0 credits) instead.`,
      });
      return {
        status: "failed",
        jobId: renderResult.providerJobId || "",
        errorMessage: `Downloaded rendered image failed: ${downloadErr.message}. You can generate a Basic Draft (0 credits) instead.`,
        provider: templateRenderer.name,
        providerJobId: renderResult.providerJobId,
      };
    }

    const stored = await storeImageBuffer(buffer, {
      campaignId: post.campaignId ?? undefined,
      prefix: "premium-leaflet",
      extension: renderResult.extension || "png",
    });

    if (!stored.publicUrl || !stored.localPath) {
      throw new Error("Failed to store premium leaflet");
    }

    // ─── Charge credits only after successful render + storage ───
    const deduction = await deductCredits({
      userId,
      amount: cost,
      type: "image_generation",
      description: `Premium Marketing Leaflet (${templateRenderer.name})`,
      metadata: {
        provider: templateRenderer.name,
        providerJobId: renderResult.providerJobId,
        providerTemplateId,
        contentPostId: post.id,
        campaignId: post.campaignId,
        cost,
        source: "premium",
      },
    });

    await recordAiUsage({
      userId,
      campaignId: post.campaignId ?? undefined,
      agentType: "image_generation",
      model: `${templateRenderer.name}-template`,
      promptTokens: 500,
      completionTokens: 100,
      actualCostUsdMicro: usdToMicroCents(renderResult.costUsd || 0),
      estimatedCostUsdMicro: usdToMicroCents(renderResult.costUsd || 0),
      creditsDeducted: cost,
      metadata: {
        provider: templateRenderer.name,
        providerJobId: renderResult.providerJobId,
        providerTemplateId,
        contentPostId: post.id,
        aspectRatio,
        outputUrl: stored.publicUrl,
        source: "premium",
      },
    });

    const qualityTier: ImageQualityTier = "premium";
    const qualityLabel = "Premium Marketing Leaflet";
    const score = 90;
    const warnings: string[] = [];

    const previousVersions = Array.isArray(currentMeta?.imageVersions) ? currentMeta.imageVersions : [];
    const newVersion = {
      version: previousVersions.length + 1,
      url: stored.publicUrl,
      source: templateRenderer.name,
      score,
      qualityTier,
      qualityLabel,
      promptUsed: renderReq.headline,
      strongerBrandFitUsed: strongerBrandFit,
      creativeGuidance,
      refinementInstruction,
      brandPalette,
      hasLogo,
      templateId: selectedTemplate,
      generatedAt: new Date().toISOString(),
      approved: false,
    };
    const imageVersions = [...previousVersions, newVersion];

    await db.insert(generatedImages).values({
      userId,
      campaignId: post.campaignId,
      businessId: business.id,
      contentPostId: post.id,
      provider: templateRenderer.name,
      providerJobId: renderResult.providerJobId,
      prompt: renderReq.headline,
      url: stored.publicUrl,
      aspectRatio,
      style: campaign.contentStyle || business.visualStyle,
      status: "completed",
      creditsCharged: cost,
      providerCostUsd: usdToMicroCents(renderResult.costUsd || 0),
      metadata: {
        originalUrl: renderResult.imageUrl,
        localPath: stored.localPath,
        balanceAfter: deduction.newBalance,
        source: "premium",
        providerTemplateId,
        qualityScore: score,
        qualityTier,
        qualityLabel,
        isDraft: false,
        templateId: selectedTemplate,
        versions: imageVersions,
        renderRequest: renderReq,
      },
    });

    const [latestGenerated] = await db
      .select({ id: generatedImages.id })
      .from(generatedImages)
      .where(eq(generatedImages.contentPostId, post.id))
      .orderBy(desc(generatedImages.createdAt))
      .limit(1);
    const currentVersionId = latestGenerated?.id ?? null;

    await db
      .update(contentPosts)
      .set({
        metadata: {
          ...currentMeta,
          currentVersionId,
          imageCurrentVersionId: currentVersionId,
          imageUrl: stored.publicUrl,
          imageProvider: templateRenderer.name,
          imageJobId: renderResult.providerJobId,
          imageStatus: "ready",
          imageGeneratedAt: new Date().toISOString(),
          imageError: null,
          imageCreditsCharged: cost,
          imageExtension: renderResult.extension || "png",
          imageSource: "premium",
          source: "premium",
          imageTemplateId: selectedTemplate,
          templateId: selectedTemplate,
          imageQualityScore: score,
          qualityScore: score,
          imageQualityTier: qualityTier,
          qualityTier,
          imageQualityLabel: qualityLabel,
          qualityLabel,
          imageIsDraft: false,
          isDraft: false,
          imageQualityWarnings: warnings,
          validationIssues: warnings,
          imageVersions,
          imageBrandPalette: brandPalette,
          imageHasLogo: hasLogo,
          imageCreativeGuidance: creativeGuidance,
          imageRefinementInstruction: refinementInstruction,
        },
      })
      .where(eq(contentPosts.id, post.id));

    // Caption pack is included with premium leaflet.
    generateCaptionPack({ userId, contentPostId: post.id }).catch((err) => {
      console.error(`[PremiumLeaflet] Caption pack async error | userId=${userId} | contentPostId=${post.id} | error="${err.message}"`);
    });

    console.log(`[PremiumLeaflet] Ready | userId=${userId} | contentPostId=${contentPostId} | url=${stored.publicUrl} | credits=${cost}`);

    return {
      jobId: renderResult.providerJobId || "premium",
      provider: templateRenderer.name,
      status: "completed",
      imageUrl: stored.publicUrl,
      extension: renderResult.extension || "png",
      creditsCharged: cost,
      qualityTier,
      qualityLabel,
      isDraft: false,
      usingFallback: false,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[PremiumLeaflet] Unexpected error | userId=${userId} | contentPostId=${contentPostId} | error="${errorMessage}"`, err);
    await setPostImageStatus(contentPostId, { imageStatus: "failed", imageError: errorMessage });
    return { status: "failed", jobId: "", errorMessage };
  }
}

async function refineLeafletCopy({
  business,
  campaign,
  headline,
  offer,
  cta,
  services,
  creativeGuidance,
  refinementInstruction,
}: {
  business: any;
  campaign: any;
  headline: string;
  offer: string;
  cta: string;
  services: string[];
  creativeGuidance?: string;
  refinementInstruction?: string;
}): Promise<{ headline: string; offer: string; cta: string; services: string[] }> {
  const system = "You are a senior copywriter refining marketing leaflet copy. Return concise, punchy copy suitable for a small-business promotional leaflet.";
  const prompt = `Refine the following leaflet copy for ${business.name} (${business.productOrService || campaign.productOrService || "local business"}).

Headline: ${headline}
Offer: ${offer}
CTA: ${cta}
Services/products: ${services.join(", ")}
${creativeGuidance ? `Creative direction: ${creativeGuidance}` : ""}
${refinementInstruction ? `Refinement request: ${refinementInstruction}` : ""}

Return a JSON object with keys: headline, offer, cta, services (array of up to 4 short strings). Keep each field short and customer-facing.`;

  const result = await generateText({
    model: openai("gpt-4o-mini"),
    system,
    prompt,
  });

  try {
    const parsed = JSON.parse(result.text);
    return {
      headline: parsed.headline || headline,
      offer: parsed.offer || offer,
      cta: parsed.cta || cta,
      services: Array.isArray(parsed.services) && parsed.services.length > 0 ? parsed.services.slice(0, 6) : services,
    };
  } catch {
    // If parsing fails, return original copy.
    return { headline, offer, cta, services };
  }
}

// ─── Master Campaign Post image generation ───
// Backwards-compatible wrapper. New code should call generateBasicDraftLeaflet
// or generatePremiumLeaflet directly. When the premium template provider flag
// is enabled, this routes to the provider-based premium path; otherwise it
// generates a free Basic Draft.
export async function generateMasterImage({
  userId,
  contentPostId,
  brandColors,
  creativeType = "leaflet",
  templateId,
  strongerBrandFit = false,
  creativeGuidance,
  refinementInstruction,
  allowNoLogo = false,
}: {
  userId: number;
  contentPostId: number;
  brandColors?: string[];
  creativeType?: CreativeType;
  templateId?: TemplateId;
  strongerBrandFit?: boolean;
  creativeGuidance?: string;
  refinementInstruction?: string;
  allowNoLogo?: boolean;
}): Promise<ImageResult> {
  if (env.enablePremiumTemplateProvider) {
    return generatePremiumLeaflet({
      userId,
      contentPostId,
      brandColors,
      creativeType,
      templateId,
      strongerBrandFit,
      creativeGuidance,
      refinementInstruction,
      allowNoLogo,
    });
  }

  return generateBasicDraftLeaflet({
    userId,
    contentPostId,
    brandColors,
    creativeType,
    templateId,
    creativeGuidance,
    refinementInstruction,
    allowNoLogo,
  });
}

export interface CaptionPack {
  linkedinCaption: string;
  facebookCaption: string;
  instagramCaption: string;
  whatsappCaption: string;
  emailSubject: string;
  emailPreheader: string;
  emailBody: string;
  hashtags: string[];
  ctaVariations: string[];
  outreachDm: string;
}

// ─── Caption Pack generation (included with premium image) ───
export async function generateCaptionPack({
  userId,
  contentPostId,
}: {
  userId: number;
  contentPostId: number;
}): Promise<CaptionPack | null> {
  const db = getDb();

  const [post] = await db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.id, contentPostId), eq(contentPosts.userId, userId)))
    .limit(1);

  if (!post) return null;

  let campaign: any = null;
  let business: any = null;

  if (post.campaignId) {
    [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, post.campaignId)).limit(1);
    if (campaign?.businessId) {
      [business] = await db
        .select()
        .from(businesses)
        .where(eq(businesses.id, campaign.businessId))
        .limit(1);
    }
  }

  if (!business) business = {};
  if (!campaign) campaign = {};

  const brandColors = (business.brandColors as string[] | undefined) || [];

  const evidence = (business.websiteEvidence || {}) as {
    businessCategory?: string;
    productsServices?: string[];
    targetCustomers?: string[];
    location?: string;
  };

  const isPrintShop =
    `${business.name || ""} ${business.industry || ""} ${business.productOrService || ""} ${campaign.productOrService || ""}`.toLowerCase()
      .includes("print") ||
    `${business.productOrService || ""} ${campaign.productOrService || ""}`.toLowerCase()
      .match(/print|copy|courier|business card|flyer|poster|banner/);

  const isArtDecor =
    `${business.name || ""} ${business.industry || ""} ${business.productOrService || ""} ${campaign.productOrService || ""} ${evidence.businessCategory || ""}`.toLowerCase()
      .match(/canvas|wall art|framed poster|art print|afrocentric|d[eé]cor|interior/);

  const serviceCallouts = isPrintShop
    ? "Printing & Copying, Business Cards & Flyers, Posters & Banners, Courier Services, Graduation Gifts, Document Support, Photo Prints, Branding & Stationery"
    : isArtDecor
    ? "Bespoke Afrocentric Canvas Art, Custom Canvas Prints, Framed Posters, Premium Wall Art, Home & Office Décor, Turn Photos into Art"
    : (campaign.productOrService || business.productOrService || "your core service");

  const selectedPlatforms = (campaign.platforms || "Instagram, Facebook")
    .split(/[,;]+/)
    .map((p: string) => p.trim())
    .filter(Boolean);

  const prompt = `You are a senior conversion copywriter for a local marketing agency. Write a commercially specific, ready-to-post "Caption Pack" that matches the premium leaflet/poster image just generated for this campaign. The copy must support the same message as the image and sound like it was written for THIS exact business.

BUSINESS (from validated website evidence):
- Name: ${business.name || "N/A"}
- Industry: ${business.industry || "N/A"}
- Detected Category: ${evidence.businessCategory || business.industry || "N/A"}
- Products/Services Mentioned on Website: ${(evidence.productsServices || [business.productOrService || "N/A"]).join(", ")}
- Target Customers Mentioned on Website: ${(evidence.targetCustomers || [business.targetCustomer || "N/A"]).join(", ")}
- Location: ${business.location || evidence.location || "N/A"}
- Website: ${business.website || "N/A"}
- WhatsApp: ${business.whatsappNumber || "N/A"}
- Email: ${business.email || "N/A"}
- Brand tone: ${business.brandTone || business.tone || "professional"}
- Brand colours: ${brandColors.join(", ") || "not specified"}
- Visual style: ${business.visualStyle || "not specified"}
- Brand voice notes: ${business.brandVoiceNotes || "not specified"}
- Words to avoid: ${business.avoidWords || "None specified"}

CAMPAIGN BRIEF:
- Primary outcome: ${campaign.primaryOutcome || "N/A"}
- Target buyer: ${campaign.targetBuyer || campaign.targetAudience || "N/A"}
- Main pain point: ${campaign.mainPainPoint || "N/A"}
- Product/service being promoted: ${campaign.productOrService || business.productOrService || "N/A"}
- Offer: ${campaign.offerDetails || "None — do not invent offers or discounts"}
- Preferred CTA: ${campaign.preferredCta || post.cta || "Request a Quote Today"}
- Exclusions (NEVER use): ${campaign.excludedOffers || business.avoidWords || "None specified"}
- Reference style: ${campaign.referenceStyle || "N/A"}
- Content style: ${campaign.contentStyle || "N/A"}
- Selected Platforms: ${selectedPlatforms.join(", ")}

MASTER POST:
- Title: ${post.title || "N/A"}
- Hook: ${post.hook || "N/A"}
- Caption: ${post.caption || "N/A"}
- CTA: ${post.cta || "N/A"}

SERVICE CALLOUTS TO SUPPORT (use where relevant):
${serviceCallouts}

COPY RULES:
1. NEVER use generic motivational phrases like "Unleash creativity this winter", "Winter vibes are here", "Join the revolution", "Unlock your potential", "Discover the best" or "Transform your future".
2. Ground every caption in the validated business products/services above. Do NOT mention SEO, social media management, data analytics, digital marketing, restaurant services, salon services, or consulting unless they are explicitly listed in the business evidence.
3. Lead with a concrete business outcome: what the buyer gets, how they save time, what they avoid, or what the offer gives them.
4. Mention specific products/services from the website evidence where relevant.
5. If an offer is provided, state it exactly as given (e.g. "10% off orders above R1000"). If no offer is provided, do NOT invent discounts, free trials, limited spots, free e-books, loyalty programmes or fake promotions.
6. CTA must be clear and action-based: "Order on WhatsApp", "Request a quote", "Shop online", "Book a demo", "Speak to us" or similar. Match it to the preferred CTA if one is supplied.
7. Each caption must match the platform's tone and format and be usable straight away.
8. Hashtags should be a focused mix of core, local and niche tags (8–12 total). Include location-based tags if a location is provided.
9. CTA variations must be distinct and platform-appropriate.
10. Outreach DM should be short, warm and direct — one sentence of context plus a clear ask.
11. The caption pack must NOT contradict the image offer/CTA or invent a different promotion.
12. Generate captions for ALL of the selected platforms listed above.

OUTPUT FORMAT — return ONLY a single JSON object with these exact keys:
{
  "linkedinCaption": "string",
  "facebookCaption": "string",
  "instagramCaption": "string",
  "whatsappCaption": "string",
  "emailSubject": "string",
  "emailPreheader": "string",
  "emailBody": "string",
  "hashtags": ["string"],
  "ctaVariations": ["string"],
  "outreachDm": "string"
}`;

  function validateCaptionPack(pack: CaptionPack): { valid: boolean; issues: string[] } {
    const issues: string[] = [];
    const combined = Object.values(pack).join(" ").toLowerCase();
    const category = (evidence.businessCategory || business.industry || "").toLowerCase();
    const isMarketing = category.includes("marketing") || category.includes("agency") || category.includes("digital");

    if (!isMarketing) {
      const badWords = ["seo", "social media management", "data analytics", "digital marketing"];
      for (const word of badWords) {
        if (combined.includes(word)) issues.push(`Caption pack mentions unsupported service: ${word}`);
      }
    }

    const products = evidence.productsServices || [business.productOrService || ""];
    const productTerms = products.map((p) => p.toLowerCase()).filter(Boolean);
    const hasProductReference = productTerms.some((term) => term.length > 3 && combined.includes(term));
    if (!hasProductReference && products[0]) {
      issues.push("Caption pack does not reference the business's actual products/services.");
    }

    return { valid: issues.length === 0, issues };
  }

  try {
    console.log(`[CreativeService] Generating caption pack | userId=${userId} | contentPostId=${contentPostId}`);

    let pack: CaptionPack | null = null;
    let finalPrompt = prompt;
    let attempt = 0;
    const maxAttempts = 2;

    while (attempt < maxAttempts) {
      const { text } = await generateText({
        model: openai("gpt-4o-mini"),
        prompt: finalPrompt,
        temperature: 0.7,
        maxOutputTokens: 2500,
      });

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed: CaptionPack = jsonMatch
        ? JSON.parse(jsonMatch[0])
        : JSON.parse(text);

      const safePack: CaptionPack = {
        linkedinCaption: parsed.linkedinCaption || post.caption || "",
        facebookCaption: parsed.facebookCaption || post.caption || "",
        instagramCaption: parsed.instagramCaption || post.caption || "",
        whatsappCaption: parsed.whatsappCaption || post.cta || "",
        emailSubject: parsed.emailSubject || post.title || "",
        emailPreheader: parsed.emailPreheader || post.hook || "",
        emailBody: parsed.emailBody || post.caption || "",
        hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
        ctaVariations: Array.isArray(parsed.ctaVariations) ? parsed.ctaVariations : [],
        outreachDm: parsed.outreachDm || "",
      };

      const validation = validateCaptionPack(safePack);
      if (validation.valid) {
        pack = safePack;
        break;
      }

      if (attempt === 0) {
        console.warn(`[CreativeService] Caption pack validation failed, retrying | issues=${JSON.stringify(validation.issues)}`);
        finalPrompt = `${prompt}\n\nPREVIOUS ATTEMPT FAILED VALIDATION. FIX THESE ISSUES AND REGENERATE:\n${validation.issues.map((i) => `- ${i}`).join("\n")}\n\nNever mention unsupported services. Always reference the actual products/services from the website evidence.`;
      } else {
        // On final attempt, use the pack but log issues.
        console.error(`[CreativeService] Caption pack validation failed after retry | issues=${JSON.stringify(validation.issues)}`);
        pack = safePack;
      }
      attempt++;
    }

    if (!pack) {
      throw new Error("Caption pack generation failed validation.");
    }

    if (!post.campaignId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Caption pack requires content post to belong to a campaign" });
    }

    await db.insert(campaignAssets).values({
      userId,
      campaignId: post.campaignId,
      assetType: "caption_pack",
      title: "Caption Pack",
      status: "ready",
      metadata: {
        ...pack,
        contentPostId: post.id,
        generatedAt: new Date().toISOString(),
        businessCategory: evidence.businessCategory,
        evidenceVersion: (business.websiteEvidence as any)?.updatedAt || new Date().toISOString(),
      },
    });

    console.log(`[CreativeService] Caption pack stored | userId=${userId} | contentPostId=${contentPostId}`);
    return pack;
  } catch (err: any) {
    console.error(`[CreativeService] Caption pack failed | userId=${userId} | contentPostId=${contentPostId} | error="${err.message}"`);
    return null;
  }
}

// ─── Premium video generation (async) ───
export async function generatePremiumVideo({
  userId,
  contentPostId,
}: {
  userId: number;
  contentPostId: number;
}): Promise<VideoResult & { canUseBasicDraft?: boolean; creditsRequired?: number }> {
  const db = getDb();

  const [post] = await db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.id, contentPostId), eq(contentPosts.userId, userId)))
    .limit(1);

  if (!post) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Content post not found" });
  }

  if (post.type !== "video_concept" && post.type !== "reel_script") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This content type does not support video generation" });
  }

  const provider = getPremiumVideoProvider();
  if (!provider.configured) {
    return {
      jobId: "",
      status: "failed",
      provider: provider.name,
      errorMessage: "Premium video provider is not configured. Use Basic Draft Video or contact your admin.",
      canUseBasicDraft: true,
    };
  }

  const cost = getPremiumVideoCredits();
  await assertCanAfford(userId, cost, "Premium video generation");

  let campaign: any = null;
  let business: any = null;

  if (post.campaignId) {
    [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, post.campaignId)).limit(1);
    if (campaign?.businessId) {
      [business] = await db
        .select()
        .from(businesses)
        .where(eq(businesses.id, campaign.businessId))
        .limit(1);
    }
  }

  if (!business) {
    business = { name: campaign?.name || post.title || "Your Business" };
  }
  if (!campaign) {
    campaign = {};
  }

  const videoReq = buildVideoRequest({ business, campaign, post });

  console.log(`[CreativeService] Starting premium video | userId=${userId} | contentPostId=${contentPostId} | provider=${provider.name}`);

  const result = await provider.generateVideo(videoReq);

  if (result.status === "failed" || !result.jobId) {
    const errorMessage = result.errorMessage || "Premium video generation failed";
    console.error(`[CreativeService] Premium video start failed | userId=${userId} | contentPostId=${contentPostId} | error="${errorMessage}"`);
    return { ...result, errorMessage, canUseBasicDraft: true, creditsRequired: cost };
  }

  // Persist pending job (no credit deduction yet)
  const currentMeta = (post.metadata || {}) as any;
  await db
    .update(contentPosts)
    .set({
      metadata: {
        ...currentMeta,
        videoStatus: "rendering",
        isPremiumVideo: true,
        videoProvider: provider.name,
        renderJobId: result.jobId,
        renderError: null,
        renderStartedAt: new Date().toISOString(),
      },
    })
    .where(eq(contentPosts.id, post.id));

  await db.insert(videoRenderJobs).values({
    userId,
    campaignId: post.campaignId ?? 0,
    contentPostId: post.id,
    provider: provider.name,
    renderJobId: result.jobId,
    providerLinkId: result.providerLinkId,
    renderStatus: toJobStatus(result.status),
    videoUrl: result.videoUrl || null,
    thumbnailUrl: result.thumbnailUrl || null,
    errorMessage: result.errorMessage || null,
    creditCost: 0,
    creditsCharged: 0,
    providerCostUsd: 0,
    createdBy: userId,
    metadata: {
      rawResponse: result.rawResponse,
      provider: provider.name,
      providerJobId: result.jobId,
      providerLinkId: result.providerLinkId,
      isPremium: true,
      creditsRequired: cost,
    },
  });

  // If the provider returned a completed result synchronously, complete immediately
  if (result.status === "done" && result.videoUrl) {
    return completePremiumVideo({ userId, providerJobId: result.jobId });
  }

  return {
    ...result,
    creditsRequired: cost,
  };
}

// ─── Complete a premium video after provider reports done ───
export async function completePremiumVideo({
  userId,
  providerJobId,
  resultOverride,
}: {
  userId: number;
  providerJobId: string;
  resultOverride?: VideoResult;
}): Promise<VideoResult> {
  const db = getDb();

  const [job] = await db
    .select()
    .from(videoRenderJobs)
    .where(and(eq(videoRenderJobs.renderJobId, providerJobId), eq(videoRenderJobs.userId, userId)))
    .limit(1);

  if (!job) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Video render job not found" });
  }

  // Idempotency: already charged/completed
  if ((job.creditsCharged ?? 0) > 0 && job.renderStatus === "completed") {
    return {
      jobId: providerJobId,
      provider: job.provider,
      status: "completed",
      videoUrl: job.videoUrl || undefined,
      thumbnailUrl: job.thumbnailUrl || undefined,
    };
  }

  const provider = getPremiumVideoProvider();
  let result = resultOverride;
  if (!result) {
    result = await provider.getStatus(providerJobId);
  }

  if (!result) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not fetch video status" });
  }

  const status = toJobStatus(result.status);

  // Update job row with latest status
  await db
    .update(videoRenderJobs)
    .set({
      renderStatus: status,
      videoUrl: result.videoUrl || null,
      thumbnailUrl: result.thumbnailUrl || null,
      errorMessage: result.errorMessage || null,
      completedAt: status === "completed" || status === "failed" ? new Date() : undefined,
      metadata: {
        ...((job.metadata as any) || {}),
        rawResponse: result.rawResponse,
        providerCreditsUsed: result.providerCreditsUsed,
      },
    })
    .where(eq(videoRenderJobs.id, job.id));

  if (status !== "completed" || !result.videoUrl) {
    // Failed or still pending: update post metadata with error
    if (status === "failed") {
      const [post] = await db.select().from(contentPosts).where(eq(contentPosts.id, job.contentPostId ?? 0)).limit(1);
      if (post) {
        const meta = (post.metadata || {}) as any;
        await db
          .update(contentPosts)
          .set({
            metadata: {
              ...meta,
              videoStatus: "failed",
              renderError: result.errorMessage || "Premium video generation failed",
            },
          })
          .where(eq(contentPosts.id, post.id));
      }
    }
    return result;
  }

  // Download and store video locally
  let stored;
  try {
    stored = await downloadAndStoreVideo(result.videoUrl, {
      campaignId: job.campaignId || undefined,
      prefix: "master-video",
    });
  } catch (storageErr: any) {
    console.error(`[CreativeService] Failed to store premium video | jobId=${providerJobId} | error="${storageErr.message}"`);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Premium video generated but could not be stored: ${storageErr.message}`,
    });
  }

  // Deduct credits on success
  const cost = getPremiumVideoCredits();
  const deduction = await deductCredits({
    userId,
    amount: cost,
    type: "video_generation",
    description: "Premium Master Video Ad generation",
    metadata: {
      provider: provider.name,
      providerJobId,
      providerLinkId: result.providerLinkId,
      contentPostId: job.contentPostId,
      campaignId: job.campaignId,
      cost,
    },
  });

  const providerCostUsdMicro = result.providerCreditsUsed
    ? creatifyCreditsToUsd(result.providerCreditsUsed)
    : 0;

  await recordAiUsage({
    userId,
    campaignId: job.campaignId || undefined,
    agentType: "video_generation",
    model: "creatify",
    promptTokens: 1000,
    completionTokens: 500,
    actualCostUsdMicro: providerCostUsdMicro,
    estimatedCostUsdMicro: usdToMicroCents(cost / 100), // rough estimate: 100 credits ≈ $1
    creditsDeducted: cost,
    metadata: {
      provider: provider.name,
      providerJobId,
      providerLinkId: result.providerLinkId,
      providerCreditsUsed: result.providerCreditsUsed,
      contentPostId: job.contentPostId,
      outputUrl: stored.publicUrl,
      rawResponse: result.rawResponse,
    },
  });

  // Finalise job row
  await db
    .update(videoRenderJobs)
    .set({
      renderStatus: "completed",
      videoUrl: stored.publicUrl,
      thumbnailUrl: result.thumbnailUrl || null,
      creditsCharged: cost,
      providerCostUsd: providerCostUsdMicro,
      completedAt: new Date(),
      metadata: {
        ...((job.metadata as any) || {}),
        rawResponse: result.rawResponse,
        providerCreditsUsed: result.providerCreditsUsed,
        outputUrl: stored.publicUrl,
        balanceAfter: deduction.newBalance,
      },
    })
    .where(eq(videoRenderJobs.id, job.id));

  // Update master video post
  const [post] = await db.select().from(contentPosts).where(eq(contentPosts.id, job.contentPostId ?? 0)).limit(1);
  if (post) {
    const meta = (post.metadata || {}) as any;
    await db
      .update(contentPosts)
      .set({
        metadata: {
          ...meta,
          videoStatus: "ready",
          videoUrl: stored.publicUrl,
          thumbnailUrl: result.thumbnailUrl || null,
          renderJobId: providerJobId,
          videoProvider: provider.name,
          isPremiumVideo: true,
          durationSeconds: result.durationSeconds,
          aspectRatio: result.aspectRatio || "9:16",
          renderError: null,
          renderCompletedAt: new Date().toISOString(),
          videoCreditsCharged: cost,
        },
      })
      .where(eq(contentPosts.id, post.id));
  }

  console.log(`[CreativeService] Premium video ready | userId=${userId} | jobId=${providerJobId} | url=${stored.publicUrl} | credits=${cost}`);

  return {
    ...result,
    videoUrl: stored.publicUrl,
    status: "completed",
  };
}

// ─── Basic Draft Video (local renderer, no credits) ───
export async function renderBasicDraftVideo({
  userId,
  contentPostId,
}: {
  userId: number;
  contentPostId: number;
}): Promise<VideoResult> {
  const db = getDb();

  const [post] = await db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.id, contentPostId), eq(contentPosts.userId, userId)))
    .limit(1);

  if (!post) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Content post not found" });
  }

  if (post.type !== "video_concept" && post.type !== "reel_script") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This content type does not support video rendering" });
  }

  let campaign: any = null;
  let business: any = null;

  if (post.campaignId) {
    [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, post.campaignId)).limit(1);
    if (campaign?.businessId) {
      [business] = await db
        .select()
        .from(businesses)
        .where(eq(businesses.id, campaign.businessId))
        .limit(1);
    }
  }

  if (!business) {
    business = { name: campaign?.name || post.title || "Your Business" };
  }
  if (!campaign) {
    campaign = {};
  }

  const meta = (post.metadata || {}) as any;
  const provider = getBasicVideoProvider();

  console.log(`[CreativeService] Rendering basic draft video | userId=${userId} | contentPostId=${contentPostId}`);

  const result = await provider.generateVideo({
    contentPostId: post.id,
    campaignId: post.campaignId ?? 0,
    userId,
    script: post.caption || post.body || "",
    scenes: meta.scenes || [],
    duration: meta.duration,
    style: meta.visualStyle,
    title: post.title,
    businessName: business.name,
    productName: business.productOrService || campaign.productOrService,
    offer: campaign.offerDetails,
    cta: campaign.preferredCta || post.cta,
  });

  if (result.status === "failed" || !result.videoUrl) {
    const errorMessage = result.errorMessage || "Basic draft video rendering failed";
    const currentMeta = (post.metadata || {}) as any;
    await db
      .update(contentPosts)
      .set({
        metadata: {
          ...currentMeta,
          videoStatus: "failed",
          renderError: errorMessage,
          isPremiumVideo: false,
          videoProvider: provider.name,
        },
      })
      .where(eq(contentPosts.id, post.id));
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: errorMessage });
  }

  const currentMeta = (post.metadata || {}) as any;
  await db
    .update(contentPosts)
    .set({
      metadata: {
        ...currentMeta,
        videoStatus: "ready",
        videoUrl: result.videoUrl,
        thumbnailUrl: result.thumbnailUrl,
        renderJobId: result.jobId,
        videoProvider: provider.name,
        isPremiumVideo: false,
        durationSeconds: result.durationSeconds,
        aspectRatio: result.aspectRatio,
        renderError: null,
        renderCompletedAt: new Date().toISOString(),
      },
    })
    .where(eq(contentPosts.id, post.id));

  await db.insert(videoRenderJobs).values({
    userId,
    campaignId: post.campaignId ?? 0,
    contentPostId: post.id,
    provider: provider.name,
    renderJobId: result.jobId,
    renderStatus: "completed",
    videoUrl: result.videoUrl,
    thumbnailUrl: result.thumbnailUrl || null,
    errorMessage: null,
    creditCost: 0,
    creditsCharged: 0,
    providerCostUsd: 0,
    createdBy: userId,
    metadata: { isPremium: false, mode: "basic_draft" },
  });

  return result;
}
