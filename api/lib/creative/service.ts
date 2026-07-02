import { TRPCError } from "@trpc/server";
import { eq, and, desc } from "drizzle-orm";
import { env } from "../env";
import { getDb } from "../../queries/connection";
import { contentPosts, campaigns, businesses, generatedImages, videoRenderJobs, campaignAssets } from "@db/schema";
import { checkCredits, deductCredits, recordAiUsage } from "../billing/credit-engine";
import { enforceCostControl } from "../billing/cost-control";
import { logInfo, logError } from "../logger";
import {
  getPremiumVideoProvider,
  getBasicVideoProvider,
  getTemplateRendererProvider,
  getInternalTemplateRenderer,
  getOpenAiLeafletRenderer,
  isOpenAiLeafletConfigured,
} from "./registry";
import { storeImageBuffer, downloadAndStoreVideo } from "./storage";
import { generateFallbackLeafletImage, defaultServiceBullets, selectTemplate, type TemplateId } from "./composition";
import { renderOffer, offerToHeadline, normalizeCta, normaliseOfferInText } from "./text-formatter";
import { resolveBrandPalette } from "./brand-palette";
import {
  getPremiumImageInternalCredits,
  getPremiumImageExternalCredits,
  getPremiumImageAiCredits,
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
import { validateAiLeafletQuality, qualityTierLabel, type LeafletQualityResult } from "./quality";
import {
  ensureApprovedMessagePack,
  loadApprovedMessagePack,
  saveApprovedMessagePack,
  validateCampaignCopy,
  parseStructuredRefinementInstruction,
  isDesignOnlyRefinementInstruction,
  type CampaignMessagePack,
  type MessagePackSource,
} from "./campaign-message-architect";
import type { TemplateRendererProvider, TemplateRendererRequest, TemplateRendererResult } from "./providers/template-renderer";
import {
  resolveProviderTemplateId,
  getPremiumTemplateStatus,
  type PremiumTemplateId,
} from "./template-catalogue";

function newGenerationRunId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getNextIterationNumber(postMeta: any, existingImages: any[]): number {
  const fromPost = typeof postMeta?.iterationNumber === "number" ? postMeta.iterationNumber : 0;
  const fromImages = existingImages
    .map((img) => (img.metadata as any)?.iterationNumber)
    .filter((n) => typeof n === "number");
  const maxExisting = Math.max(fromPost, ...fromImages, 0);
  return maxExisting + 1;
}

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
    businessName: (business.displayName as string) || business.name,
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

async function loadCaptionPackSummary(campaignId: number | null | undefined): Promise<string | undefined> {
  if (!campaignId) return undefined;
  const db = getDb();
  const [pack] = await db
    .select({ metadata: campaignAssets.metadata })
    .from(campaignAssets)
    .where(and(eq(campaignAssets.campaignId, campaignId), eq(campaignAssets.assetType, "caption_pack")))
    .orderBy(desc(campaignAssets.createdAt))
    .limit(1);
  if (!pack?.metadata) return undefined;
  const meta = pack.metadata as any;
  const parts: string[] = [];
  const add = (label: string, value?: string | null) => {
    if (typeof value === "string" && value.trim().length > 0) parts.push(`${label}: ${value.trim()}`);
  };
  add("Master caption", meta.masterCaption);
  add("Instagram", meta.instagramCaption);
  add("Facebook", meta.facebookCaption);
  add("LinkedIn", meta.linkedinCaption);
  add("WhatsApp", meta.whatsappCaption);
  add("Email subject", meta.emailSubject);
  add("Email body", meta.emailBody);
  add("CTA", meta.cta || meta.callToAction);
  add("Hashtags", Array.isArray(meta.hashtags) ? meta.hashtags.join(" ") : meta.hashtags);
  if (parts.length === 0) return undefined;
  return parts.join(" | ").slice(0, 1200);
}

interface NormalizedLeafletInputs {
  formattedOffer: string;
  leafletHeadline: string;
  leafletSubheadline: string;
  leafletCta: string;
  serviceBullets: string[];
  selectedTemplate: TemplateId;
  brandPalette: any;
  hasLogo: boolean;
  aspectRatio: string;
  approvedMessagePack?: CampaignMessagePack;
}

export async function normalizeLeafletInputs({
  business,
  campaign,
  post,
  brandColors,
  creativeType,
  templateId,
  creativeGuidance,
  refinementInstruction,
  approvedMessagePack: providedMessagePack,
}: {
  business: any;
  campaign: any;
  post: any;
  brandColors?: string[];
  creativeType: CreativeType;
  templateId?: TemplateId;
  creativeGuidance?: string;
  refinementInstruction?: string;
  approvedMessagePack?: CampaignMessagePack;
}): Promise<NormalizedLeafletInputs> {
  const brandPalette = await resolveBrandPalette({ ...business, brandColors });
  const hasLogo = !!business?.logo;
  const formattedOffer = renderOffer(campaign.offerDetails, business.name);
  const selectedTemplate = selectTemplate({ business, campaign, creativeType, templateId, creativeGuidance, refinementInstruction });
  const businessCategory = (
    business?.websiteEvidence?.businessCategory ||
    business?.industry ||
    business?.productOrService ||
    ""
  ).toString();

  // Prefer the approved Campaign Message Architect pack for headline/subheadline/CTA.
  // A caller may pass a refined pack so we do not reload stale copy.
  let approvedMessagePack: CampaignMessagePack | undefined = providedMessagePack;
  if (!approvedMessagePack && campaign?.id) {
    approvedMessagePack = (await loadApprovedMessagePack(campaign.id)) || undefined;
  }

  const leafletHeadline = approvedMessagePack?.headline || offerToHeadline(campaign.offerDetails) || campaign.primaryOutcome || post?.title || business.name;
  const leafletSubheadline = approvedMessagePack?.subheadline || campaign.mainPainPoint || campaign.coreMessage || post?.hook || "";
  const leafletCta = approvedMessagePack?.cta || normalizeCta(campaign.preferredCta || post.cta, businessCategory);
  const serviceBullets = approvedMessagePack?.benefitBullets?.length
    ? approvedMessagePack.benefitBullets
    : defaultServiceBullets(business, campaign);
  const aspectRatio = getImageAspectRatio(creativeType, post.platform || "Instagram");

  return {
    formattedOffer,
    leafletHeadline,
    leafletSubheadline,
    leafletCta,
    serviceBullets,
    selectedTemplate,
    brandPalette,
    hasLogo,
    aspectRatio,
    approvedMessagePack,
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
      leafletSubheadline,
      leafletCta,
      serviceBullets,
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
      subheadline: leafletSubheadline,
      serviceBullets,
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
    const allPreviousImages = await db
      .select({ id: generatedImages.id, metadata: generatedImages.metadata })
      .from(generatedImages)
      .where(eq(generatedImages.contentPostId, post.id));
    const generationRunId = newGenerationRunId("basic");
    const iterationNumber = getNextIterationNumber(currentMeta, allPreviousImages);
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
        generationRunId,
        iterationNumber,
        assetType: "leaflet",
        assetTier: "basic",
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
          generationRunId,
          iterationNumber,
          assetType: "leaflet",
          assetTier: "basic",
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
// Provider-backed premium leaflet renderer. Supports:
//   - "ai": OpenAI generates the visual background, NatForgeAI overlays logo/text.
//   - "internal": deterministic internal premium templates (fallback).
//   - "external": Bannerbear / Templated.io (admin-configured).
// Credits are deducted only after successful render, storage and quality validation.
export async function generatePremiumLeaflet({
  userId,
  contentPostId,
  brandColors,
  creativeType = "leaflet",
  templateId,
  provider = "internal",
  strongerBrandFit = false,
  creativeGuidance,
  refinementInstruction,
  allowNoLogo = false,
  regenerate = false,
  forceRegenerate = false,
}: {
  userId: number;
  contentPostId: number;
  brandColors?: string[];
  creativeType?: CreativeType;
  templateId?: TemplateId;
  provider?: "internal" | "external" | "ai";
  strongerBrandFit?: boolean;
  creativeGuidance?: string;
  refinementInstruction?: string;
  allowNoLogo?: boolean;
  regenerate?: boolean;
  forceRegenerate?: boolean;
}): Promise<ImageResult> {
  const { post, campaign, business } = await loadPostCampaignBusiness({ userId, contentPostId });
  const db = getDb();
  const currentMeta = (post.metadata || {}) as any;
  const allPreviousImages = await db
    .select({
      id: generatedImages.id,
      url: generatedImages.url,
      provider: generatedImages.provider,
      providerJobId: generatedImages.providerJobId,
      metadata: generatedImages.metadata,
      createdAt: generatedImages.createdAt,
    })
    .from(generatedImages)
    .where(eq(generatedImages.contentPostId, post.id));
  const generationRunId = newGenerationRunId("premium");
  const iterationNumber = getNextIterationNumber(currentMeta, allPreviousImages);

  // ─── Idempotency: reuse existing valid premium leaflet only when no explicit new attempt is requested ───
  const hasRefinementInstruction = !!refinementInstruction?.trim();
  const isExplicitRegenerate = regenerate || forceRegenerate;

  if (post.campaignId) {
    const existingPack = await loadApprovedMessagePack(post.campaignId);
    const existingImage = allPreviousImages
      .filter((img) => img.metadata && (img.metadata as any).assetTier === "premium")
      .sort((a, b) => Number(new Date(b.createdAt || 0)) - Number(new Date(a.createdAt || 0)))[0];

    logInfo("[PremiumLeaflet] idempotency check", {
      userId,
      contentPostId,
      campaignId: post.campaignId,
      existingAssetFound: !!existingImage,
      existingPackValid: !!existingPack?.validation?.passed,
      hasRefinementInstruction,
      strongerBrandFit,
      regenerate,
      forceRegenerate,
      generationRunId,
      iterationNumber,
    });

    const canReuseExisting =
      !isExplicitRegenerate &&
      !hasRefinementInstruction &&
      !strongerBrandFit;

    if (canReuseExisting && existingPack?.validation?.passed && existingImage) {
      const meta = existingImage.metadata as any;
      logInfo("[PremiumLeaflet] reusing existing valid asset", {
        userId,
        contentPostId,
        campaignId: post.campaignId,
        existingImageId: existingImage.id,
        provider: existingImage.provider,
        generationRunId: meta?.generationRunId,
        iterationNumber: meta?.iterationNumber,
      });

      // Ensure the content post reflects the reused asset as ready so the UI
      // does not stay stuck in a previous failed/generating state.
      await db
        .update(contentPosts)
        .set({
          metadata: {
            ...currentMeta,
            currentVersionId: existingImage.id,
            imageCurrentVersionId: existingImage.id,
            imageUrl: existingImage.url,
            imageProvider: existingImage.provider || "premium",
            imageJobId: existingImage.providerJobId || "premium",
            imageStatus: "ready",
            imageError: null,
            imageCreditsCharged: 0,
            imageExtension: "png",
            imageSource: "premium",
            source: "premium",
            imageQualityScore: meta?.qualityScore ?? null,
            qualityScore: meta?.qualityScore ?? null,
            imageQualityTier: meta?.qualityTier ?? null,
            qualityTier: meta?.qualityTier ?? null,
            imageQualityLabel: meta?.qualityLabel ?? null,
            qualityLabel: meta?.qualityLabel ?? null,
            imageIsDraft: false,
            isDraft: false,
          },
        })
        .where(eq(contentPosts.id, post.id));

      return {
        jobId: meta?.renderRequest?.providerJobId || existingImage.providerJobId || "premium",
        provider: existingImage.provider || "premium",
        status: "completed",
        imageUrl: existingImage.url,
        extension: "png",
        creditsCharged: 0,
        qualityTier: meta?.qualityTier || "premium",
        qualityLabel: meta?.qualityLabel || "Premium Marketing Leaflet",
        isDraft: false,
        usingFallback: false,
      };
    }

    if (existingImage) {
      let reuseSkippedReason: string;
      if (hasRefinementInstruction) reuseSkippedReason = "refinement_instruction_present";
      else if (strongerBrandFit) reuseSkippedReason = "stronger_brand_fit";
      else if (isExplicitRegenerate) reuseSkippedReason = "force_regenerate";
      else reuseSkippedReason = "template_or_settings_changed";

      logInfo("[PremiumLeaflet] skipping existing asset reuse", {
        userId,
        contentPostId,
        campaignId: post.campaignId,
        existingImageId: existingImage.id,
        reuseSkippedReason,
        generationRunId,
        iterationNumber,
      });
    }
  }

  let isAiProvider = provider === "ai";
  const isExternalProvider = provider === "external";
  let storageProvider = provider;

  if (isAiProvider) {
    if (!isOpenAiLeafletConfigured()) {
      const message = "Premium AI leaflet generation is not configured. Add an OpenAI API key or generate a Basic Draft / Internal Premium Leaflet instead.";
      console.warn(`[PremiumLeaflet] Blocked AI | userId=${userId} | contentPostId=${contentPostId} | missing=OPENAI_API_KEY`);
      await setPostImageStatus(contentPostId, { imageStatus: "failed", imageError: message });
      return { status: "failed", jobId: "", errorMessage: message };
    }
  }

  if (isExternalProvider) {
    const status = getPremiumTemplateStatus();
    if (!status.ready) {
      const message = "External premium template provider is not configured yet. You can generate a Premium AI Leaflet, Internal Premium Leaflet or Basic Draft instead.";
      console.warn(`[PremiumLeaflet] Blocked external | userId=${userId} | contentPostId=${contentPostId} | missing=${status.missing?.join(",") || "feature flag/provider"}`);
      await setPostImageStatus(contentPostId, { imageStatus: "failed", imageError: message });
      return { status: "failed", jobId: "", errorMessage: message };
    }
  }

  let templateRenderer = isAiProvider
    ? getOpenAiLeafletRenderer()
    : isExternalProvider
    ? getTemplateRendererProvider()
    : getInternalTemplateRenderer();
  let cost = isAiProvider
    ? getPremiumImageAiCredits()
    : isExternalProvider
    ? getPremiumImageExternalCredits()
    : getPremiumImageInternalCredits();

  // Pre-flight credit check only — no deduction until copy + image are validated.
  await assertCanAfford(userId, cost, "Premium Marketing Leaflet");

  await setPostImageStatus(contentPostId, { imageStatus: "generating", imageError: null });

  try {
    const hasLogo = !!business?.logo;
    if (!hasLogo && !allowNoLogo) {
      const message = "Please upload your business logo in Settings before generating a Premium Marketing Leaflet. Premium leaflets require your logo and brand colours.";
      await setPostImageStatus(contentPostId, { imageStatus: "failed", imageError: message });
      return { status: "failed", jobId: "", errorMessage: message };
    }

    // ─── Resolve approved message pack before rendering ───
    let approvedMessagePack: CampaignMessagePack | undefined;
    let refinementInstructionType: "none" | "design_only" | "structured_copy" | "mixed" = "none";
    let messagePackSource: MessagePackSource = "latest_message_pack";
    let copyRewriteSkippedReason: string | undefined;
    let visualInstructionPassedToRenderer = false;

    if (post.campaignId) {
      const trimmedInstruction = refinementInstruction?.trim();
      const isDesignOnly =
        !!trimmedInstruction &&
        isDesignOnlyRefinementInstruction(trimmedInstruction);
      const parsedStructured = trimmedInstruction
        ? parseStructuredRefinementInstruction(trimmedInstruction, {
            headline: "",
            subheadline: "",
            benefitBullets: [],
            cta: "",
            footerContact: {},
            platformCaptions: [],
            validation: { passed: false, score: 0, rejections: [], warnings: [] },
          })
        : null;

      if (!trimmedInstruction) refinementInstructionType = "none";
      else if (parsedStructured) refinementInstructionType = "structured_copy";
      else if (isDesignOnly) refinementInstructionType = "design_only";
      else refinementInstructionType = "mixed";

      logInfo("[PremiumLeaflet] resolving message pack", {
        userId,
        contentPostId,
        campaignId: post.campaignId,
        hasRefinementInstruction: !!trimmedInstruction,
        refinementInstructionLength: trimmedInstruction?.length ?? 0,
        refinementInstructionType,
        selectedInputFieldName: "refinementInstruction",
      });

      // Always start from the latest approved / generated base pack. If it fails
      // validation, a valid user-provided refinement may still rescue the render.
      const basePack = await ensureApprovedMessagePack({
        userId,
        campaignId: post.campaignId,
        skipBilling: true,
        maxAttempts: 2,
      });

      // Design-only refinements must preserve the approved copy. We still bypass
      // old image reuse above, so a new visual is generated using the same pack.
      if (refinementInstructionType === "design_only" && basePack.validation?.passed) {
        logInfo("[PremiumLeaflet] design-only refinement detected; preserving approved copy", {
          userId,
          contentPostId,
          campaignId: post.campaignId,
          instructionLength: trimmedInstruction!.length,
          usedApprovedMessagePack: true,
          copyRewriteSkippedReason: "design_only_refinement",
          visualInstructionPassedToRenderer: true,
        });
        approvedMessagePack = basePack;
        copyRewriteSkippedReason = "design_only_refinement";
        visualInstructionPassedToRenderer = true;
        messagePackSource = basePack.messagePackSource || "latest_message_pack";
      }

      // 1. If the user supplied explicit structured copy, parse and validate it
      // first. When it passes, use it directly and skip the LLM rewrite.
      let userStructuredPack: CampaignMessagePack | undefined;
      if (!approvedMessagePack && trimmedInstruction) {
        const parsed = parseStructuredRefinementInstruction(trimmedInstruction, basePack);
        const parsedFields = {
          parsedStructuredCopy: !!parsed,
          parsedHeadlinePresent: !!parsed?.headline,
          parsedSubheadlinePresent: !!parsed?.subheadline,
          parsedBenefitsCount: parsed?.benefitBullets?.length ?? 0,
          parsedCtaPresent: !!parsed?.cta,
          parsedFooterPresent: !!parsed?.footerContact,
        };
        logInfo("[PremiumLeaflet] parsed refinement instruction", {
          userId,
          contentPostId,
          campaignId: post.campaignId,
          ...parsedFields,
        });

        if (parsed) {
          const validationCtx = {
            businessName: (business.displayName as string) || business.name,
            campaignName: campaign.name,
            productOrService: campaign.productOrService || business.productOrService,
            targetCustomer: campaign.targetBuyer || business.targetCustomer,
            mainPainPoint: campaign.mainPainPoint,
            offerDetails: campaign.offerDetails,
            excludedOffers: campaign.excludedOffers || business.avoidWords,
            preferredCta: campaign.preferredCta,
            location: business.location,
            industry: business.industry,
            websiteEvidence: business.websiteEvidence,
            refinementInstruction: trimmedInstruction,
          };
          // The parser fills missing required fields from the existing base pack,
          // so the parsed object is complete enough to treat as a CampaignMessagePack.
          const completePack = parsed as CampaignMessagePack;
          const validation = validateCampaignCopy(completePack, validationCtx);
          const candidatePack: CampaignMessagePack = { ...completePack, validation };
          userStructuredPack = candidatePack;

          if (candidatePack.validation.passed) {
            logInfo("[PremiumLeaflet] using user-provided structured pack directly", {
              userId,
              contentPostId,
              campaignId: post.campaignId,
              source: "user_structured_copy",
            });
            await saveApprovedMessagePack(userId, post.campaignId, candidatePack);
            approvedMessagePack = candidatePack;
            messagePackSource = "user_structured_copy";
          }
        }
      }

      // 2. If no valid user structured pack, try to refine the base pack.
      // A refinement instruction may rescue even a failed base pack, so we
      // attempt refinement whenever the user provided guidance.
      if (!approvedMessagePack) {
        if (!basePack.validation.passed && !trimmedInstruction) {
          const message = `Campaign copy did not pass quality validation: ${basePack.validation.rejections.join("; ")}`;
          logError("[PremiumLeaflet] Copy validation failed", { userId, contentPostId, error: message });
          await setPostImageStatus(contentPostId, { imageStatus: "failed", imageError: message });
          return { status: "failed", jobId: "", errorMessage: message };
        }

        if (trimmedInstruction) {
          const { refineApprovedMessagePack } = await import("./campaign-message-architect");
          const refinedPack = await refineApprovedMessagePack({
            userId,
            campaignId: post.campaignId,
            existingPack: basePack,
            refinementInstruction: trimmedInstruction,
            skipBilling: true,
            maxAttempts: 2,
          });

          logInfo("[PremiumLeaflet] refinement result", {
            userId,
            contentPostId,
            campaignId: post.campaignId,
            source: refinedPack.validation.passed
              ? "ai_refined_pack"
              : userStructuredPack
              ? "fallback_user_pack"
              : "stale_metadata",
            passed: refinedPack.validation.passed,
          });

          // Fallback: if the AI-refined pack failed but the user-provided
          // structured pack validated, prefer the user pack.
          if (!refinedPack.validation.passed && userStructuredPack?.validation.passed) {
            approvedMessagePack = userStructuredPack;
            messagePackSource = "user_structured_copy";
          } else if (!refinedPack.validation.passed) {
            const failedCopy = JSON.stringify(
              {
                headline: refinedPack.headline,
                subheadline: refinedPack.subheadline,
                benefitBullets: refinedPack.benefitBullets,
                cta: refinedPack.cta,
              },
              null,
              2
            );
            const message = `Refined copy failed quality validation:\n${refinedPack.validation.rejections.join("; ")}\n\nGenerated copy that failed:\n${failedCopy}`;
            logError("[PremiumLeaflet] Refinement validation failed", { userId, contentPostId, error: message });
            await setPostImageStatus(contentPostId, { imageStatus: "failed", imageError: message });
            return { status: "failed", jobId: "", errorMessage: message };
          } else {
            approvedMessagePack = refinedPack;
            messagePackSource = "ai_refined_pack";
          }

          // Persist the approved pack so future renders use the latest copy.
          if (approvedMessagePack.validation.passed) {
            await saveApprovedMessagePack(userId, post.campaignId, approvedMessagePack);
          }
        } else {
          approvedMessagePack = basePack;
          messagePackSource = "latest_message_pack";
        }
      }
    }

    const {
      formattedOffer,
      leafletHeadline,
      leafletSubheadline,
      leafletCta,
      serviceBullets,
      selectedTemplate,
      brandPalette,
      aspectRatio,
    } = await normalizeLeafletInputs({ business, campaign, post, brandColors, creativeType, templateId, creativeGuidance, refinementInstruction, approvedMessagePack });

    const premiumTemplateId: PremiumTemplateId = selectedTemplate as PremiumTemplateId;
    const providerTemplateId = isExternalProvider
      ? resolveProviderTemplateId(templateRenderer.name, premiumTemplateId)
      : isAiProvider
      ? `openai-hybrid-${premiumTemplateId}`
      : premiumTemplateId;

    if (isExternalProvider && !providerTemplateId) {
      const message = `Premium template "${premiumTemplateId}" is not configured for provider "${templateRenderer.name}". Contact admin to set the provider template ID.`;
      await setPostImageStatus(contentPostId, { imageStatus: "failed", imageError: message });
      return { status: "failed", jobId: "", errorMessage: message };
    }

    let resolvedProviderTemplateId = providerTemplateId as string;

    console.log(`[PremiumLeaflet] Rendering | userId=${userId} | contentPostId=${contentPostId} | provider=${templateRenderer.name} | template=${resolvedProviderTemplateId}`);

    const captionPackSummary = await loadCaptionPackSummary(post.campaignId);

    // Rendering must consume the approved structured copy. It may only refine
    // wording; it may not invent a new headline or CTA.
    let headline = leafletHeadline || formattedOffer || campaign.primaryOutcome || post?.title || business.name;
    let offer = formattedOffer;
    let subheadline = leafletSubheadline || campaign.mainPainPoint || campaign.coreMessage || post?.hook || "";
    let cta = leafletCta;
    let services = serviceBullets;

    // Once an approved message pack is selected, the renderer MUST consume the
    // exact approved copy. Normalized fallback variables must not override it.
    if (approvedMessagePack) {
      headline = approvedMessagePack.headline || headline;
      subheadline = approvedMessagePack.subheadline || subheadline;
      services = approvedMessagePack.benefitBullets?.length ? approvedMessagePack.benefitBullets : services;
      cta = approvedMessagePack.cta || cta;
    }

    if (strongerBrandFit && env.openaiApiKey && refinementInstructionType !== "design_only") {
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

    // Validate the render inputs against the architect rules one more time.
    // This must happen AFTER any refinement so stale or invented copy is caught
    // before credits are spent.
    if (approvedMessagePack) {
      const validationCtx = {
        businessName: (business.displayName as string) || business.name,
        campaignName: campaign.name,
        productOrService: campaign.productOrService || business.productOrService,
        targetCustomer: campaign.targetBuyer || business.targetCustomer,
        mainPainPoint: campaign.mainPainPoint,
        offerDetails: campaign.offerDetails,
        excludedOffers: campaign.excludedOffers || business.avoidWords,
        preferredCta: campaign.preferredCta,
        location: business.location,
        industry: business.industry,
        websiteEvidence: business.websiteEvidence,
        refinementInstruction,
      };

      logInfo("[PremiumLeaflet] render copy validation inputs", {
        userId,
        contentPostId,
        campaignId: post.campaignId,
        headline,
        subheadline,
        services,
        cta,
        messagePackSource: approvedMessagePack.messagePackSource,
        approvedValidation: approvedMessagePack.validation,
        productOrService: validationCtx.productOrService,
        targetCustomer: validationCtx.targetCustomer,
        mainPainPoint: validationCtx.mainPainPoint,
        websiteEvidenceTargetCustomers: validationCtx.websiteEvidence?.targetCustomers,
        websiteEvidenceProductsServices: validationCtx.websiteEvidence?.productsServices,
      });

      const renderCopyValidation = validateCampaignCopy(
        {
          headline,
          subheadline,
          benefitBullets: services,
          cta,
          footerContact: approvedMessagePack.footerContact,
          platformCaptions: approvedMessagePack.platformCaptions,
          validation: { passed: false, score: 0, rejections: [], warnings: [] },
        },
        validationCtx
      );

      const trustedApprovedSources: MessagePackSource[] = [
        "manual_restore",
        "user_structured_copy",
        "fallback_user_pack",
      ];
      const isTrustedApprovedSource =
        approvedMessagePack.validation?.passed === true &&
        trustedApprovedSources.includes(approvedMessagePack.messagePackSource || "ai_refined_pack");

      const isContextSensitiveRejection = (rejection: string) =>
        /does not reference the specific product\/service/i.test(rejection) ||
        /does not reference the target customer or their pain point/i.test(rejection);

      const contextSensitiveRejections = renderCopyValidation.rejections.filter(isContextSensitiveRejection);
      const hardRejections = renderCopyValidation.rejections.filter((r) => !isContextSensitiveRejection(r));

      if (hardRejections.length > 0 || (!isTrustedApprovedSource && renderCopyValidation.rejections.length > 0)) {
        const message = `Rendered copy failed quality validation: ${renderCopyValidation.rejections.join("; ")}`;
        console.error(`[PremiumLeaflet] Render copy validation failed | userId=${userId} | contentPostId=${contentPostId} | error="${message}"`);
        await setPostImageStatus(contentPostId, { imageStatus: "failed", imageError: message });
        return { status: "failed", jobId: "", errorMessage: message };
      }

      if (contextSensitiveRejections.length > 0) {
        logInfo("[PremiumLeaflet] ignoring context-sensitive rejection for trusted approved pack", {
          userId,
          contentPostId,
          campaignId: post.campaignId,
          messagePackSource: approvedMessagePack.messagePackSource,
          ignoredRejections: contextSensitiveRejections,
        });
      }
    }

    const renderReq: TemplateRendererRequest = {
      providerTemplateId: resolvedProviderTemplateId,
      format: "leaflet",
      outputFormat: "png",
      aspectRatio,
      businessName: (business.displayName as string) || business.name,
      logoUrl: business.logo,
      brandColors: [
        brandPalette.primary,
        brandPalette.secondary,
        brandPalette.accent,
        ...(brandColors || []),
      ].filter(Boolean),
      headline,
      offer,
      subheadline,
      cta,
      services,
      contact: {
        phone: business.phone || undefined,
        whatsapp: business.whatsapp || undefined,
        website: business.website || undefined,
        email: business.email || undefined,
        location:
          approvedMessagePack?.footerContact?.location ||
          business.address ||
          business.location ||
          undefined,
      },
      campaignObjective: campaign.primaryOutcome || campaign.goal || undefined,
      campaignProduct: campaign.productOrService || undefined,
      campaignOffer: campaign.offerDetails || undefined,
      campaignHeadline: campaign.coreMessage || campaign.name || campaign.primaryOutcome || undefined,
      campaignAudience: campaign.targetAudience || campaign.targetBuyer || undefined,
      campaignPrimaryService: campaign.productOrService || undefined,
      captionPackSummary,
      creativeGuidance,
      visualStyle: business.visualStyle || undefined,
      refinementInstruction:
        refinementInstructionType === "design_only" ? refinementInstruction : undefined,
    };

    let renderResult: TemplateRendererResult;
    let buffer: Buffer;
    let aiQualityResult: LeafletQualityResult | undefined;
    let aiAttempts: any[] | undefined;

    let fallbackMeta: {
      provider: "internal-premium-fallback";
      fallbackReason: "openai_background_quality_failed";
      originalAiQualityScore: number;
      criticalFailures: string[];
      attempts: any[];
      creditsReason?: "admin_test_fallback";
    } | undefined;

    if (isAiProvider) {
      const aiRender = await renderAiLeafletWithQuality(templateRenderer, renderReq, {
        business,
        campaign,
        hasLogo,
        brandPalette,
      });
      if (!aiRender.success) {
        const lastAttempt = aiRender.attempts[aiRender.attempts.length - 1];
        const originalAiQualityScore = lastAttempt?.score ?? 0;
        const criticalFailures = lastAttempt?.criticalFailures ?? [];

        console.warn(
          `[PremiumLeaflet] OpenAI background quality failed after ${aiRender.attempts.length} attempt(s), falling back to internal premium renderer | userId=${userId} | contentPostId=${contentPostId} | score=${originalAiQualityScore} | critical=${criticalFailures.join(", ")}`
        );

        const isFreeFallback = env.freeAiLeafletFallback;
        const fallbackCost = isFreeFallback ? 0 : getPremiumImageInternalCredits();
        const internalRenderer = getInternalTemplateRenderer();
        const fallbackRenderReq: TemplateRendererRequest = {
          ...renderReq,
          providerTemplateId: selectedTemplate,
          isRetry: false,
        };
        const fallbackResult = await internalRenderer.render(fallbackRenderReq);

        if (!fallbackResult.success || (!fallbackResult.imageUrl && !fallbackResult.imageBase64)) {
          const fallbackError = fallbackResult.error || "Internal premium fallback renderer failed.";
          const message = `${aiRender.errorMessage} Fallback also failed: ${fallbackError} You can generate a Basic Draft (0 credits) instead.`;
          await setPostImageStatus(contentPostId, {
            imageStatus: "failed",
            imageError: message,
            imageAttempts: aiRender.attempts,
          });
          return {
            status: "failed",
            jobId: "",
            errorMessage: message,
            provider: templateRenderer.name,
          };
        }

        // Use the deterministic fallback image and metadata.
        templateRenderer = internalRenderer;
        resolvedProviderTemplateId = selectedTemplate;
        renderResult = fallbackResult;
        if (fallbackResult.imageBase64) {
          buffer = Buffer.from(fallbackResult.imageBase64, "base64");
        } else if (fallbackResult.imageUrl) {
          const imgResponse = await fetch(fallbackResult.imageUrl);
          if (!imgResponse.ok) throw new Error(`Failed to download fallback image: ${imgResponse.status}`);
          buffer = Buffer.from(await imgResponse.arrayBuffer());
        } else {
          throw new Error("No image data returned from fallback renderer");
        }
        aiAttempts = aiRender.attempts;
        cost = fallbackCost;
        storageProvider = "internal";
        isAiProvider = false;
        fallbackMeta = {
          provider: "internal-premium-fallback",
          fallbackReason: "openai_background_quality_failed",
          originalAiQualityScore,
          criticalFailures,
          attempts: aiRender.attempts,
          ...(isFreeFallback ? { creditsReason: "admin_test_fallback" } : {}),
        };
      } else {
        renderResult = aiRender.result;
        buffer = aiRender.finalBuffer;
        aiQualityResult = aiRender.qualityResult;
        aiAttempts = aiRender.attempts;
      }
    } else {
      renderResult = await templateRenderer.render(renderReq);

      if (!renderResult.success || (!renderResult.imageUrl && !renderResult.imageBase64)) {
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

      try {
        if (renderResult.imageBase64) {
          buffer = Buffer.from(renderResult.imageBase64, "base64");
        } else if (renderResult.imageUrl) {
          const imgResponse = await fetch(renderResult.imageUrl);
          if (!imgResponse.ok) throw new Error(`Failed to download rendered image: ${imgResponse.status}`);
          buffer = Buffer.from(await imgResponse.arrayBuffer());
        } else {
          throw new Error("No image data returned from provider");
        }
      } catch (downloadErr: any) {
        console.error(`[PremiumLeaflet] Failed to obtain rendered image | url=${renderResult.imageUrl} | error="${downloadErr.message}"`);
        await setPostImageStatus(contentPostId, {
          imageStatus: "failed",
          imageError: `Obtaining rendered image failed: ${downloadErr.message}. You can generate a Basic Draft (0 credits) instead.`,
        });
        return {
          status: "failed",
          jobId: renderResult.providerJobId || "",
          errorMessage: `Obtaining rendered image failed: ${downloadErr.message}. You can generate a Basic Draft (0 credits) instead.`,
          provider: templateRenderer.name,
          providerJobId: renderResult.providerJobId,
        };
      }
    }

    const storagePrefix = {
      ai: "premium-leaflet-ai",
      external: "premium-leaflet",
      internal: "premium-leaflet-internal",
    }[storageProvider];

    const stored = await storeImageBuffer(buffer, {
      campaignId: post.campaignId ?? undefined,
      prefix: storagePrefix,
      extension: renderResult.extension || "png",
    });

    if (!stored.publicUrl || !stored.localPath) {
      throw new Error("Failed to store premium leaflet");
    }

    const finalProviderName = fallbackMeta?.provider ?? templateRenderer.name;
    const finalProviderTemplateId = fallbackMeta ? selectedTemplate : resolvedProviderTemplateId;
    const fallbackMessage = fallbackMeta
      ? "OpenAI background included readable text, so NatForgeAI generated a clean premium fallback layout instead."
      : undefined;

    // ─── Charge credits only after successful render + storage + quality validation ───
    let deduction: { newBalance?: number | null } = {
      newBalance: null,
    };
    if (cost > 0) {
      deduction = await deductCredits({
        userId,
        amount: cost,
        type: "image_generation",
        description: `Premium Marketing Leaflet (${finalProviderName})`,
        metadata: {
          provider: finalProviderName,
          providerJobId: renderResult.providerJobId,
          providerTemplateId: finalProviderTemplateId,
          contentPostId: post.id,
          campaignId: post.campaignId,
          cost,
          source: "premium",
          ...(fallbackMeta?.creditsReason ? { creditsReason: fallbackMeta.creditsReason } : {}),
        },
      });

      await recordAiUsage({
        userId,
        campaignId: post.campaignId ?? undefined,
        agentType: "image_generation",
        model: `${finalProviderName}-template`,
        promptTokens: 500,
        completionTokens: 100,
        actualCostUsdMicro: usdToMicroCents(renderResult.costUsd || 0),
        estimatedCostUsdMicro: usdToMicroCents(renderResult.costUsd || 0),
        creditsDeducted: cost,
        metadata: {
          provider: finalProviderName,
          providerJobId: renderResult.providerJobId,
          providerTemplateId: finalProviderTemplateId,
          contentPostId: post.id,
          aspectRatio,
          outputUrl: stored.publicUrl,
          source: "premium",
          ...(fallbackMeta?.creditsReason ? { creditsReason: fallbackMeta.creditsReason } : {}),
        },
      });
    } else if (fallbackMeta) {
      console.log(`[PremiumLeaflet] Fallback rendered at 0 credits (admin testing) | userId=${userId} | contentPostId=${contentPostId}`);
    }

    const qualityTier: ImageQualityTier = isAiProvider
      ? ((aiQualityResult?.qualityTier as ImageQualityTier) ?? "premium")
      : "premium";
    const qualityLabel = isAiProvider ? qualityTierLabel(aiQualityResult?.qualityTier ?? "premium") : "Premium Marketing Leaflet";
    const score = isAiProvider ? (aiQualityResult?.score ?? 80) : 90;
    const warnings = isAiProvider ? aiQualityResult?.warnings ?? [] : [];

    const previousVersions = Array.isArray(currentMeta?.imageVersions) ? currentMeta.imageVersions : [];
    const newVersion = {
      version: previousVersions.length + 1,
      url: stored.publicUrl,
      source: finalProviderName,
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
      provider: finalProviderName,
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
        providerTemplateId: finalProviderTemplateId,
        qualityScore: score,
        qualityTier,
        qualityLabel,
        isDraft: false,
        templateId: selectedTemplate,
        versions: imageVersions,
        renderRequest: renderReq,
        generationRunId,
        iterationNumber,
        assetType: "leaflet",
        assetTier: "premium",
        ...(aiAttempts ? { attempts: aiAttempts } : {}),
        ...(fallbackMeta ? { fallback: fallbackMeta } : {}),
        ...(fallbackMessage ? { fallbackMessage } : {}),
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
          imageProvider: finalProviderName,
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
          imageFallbackMessage: fallbackMessage,
          imageFallback: fallbackMeta,
          imageBrandPalette: brandPalette,
          imageHasLogo: hasLogo,
          imageCreativeGuidance: creativeGuidance,
          imageRefinementInstruction: refinementInstruction,
          generationRunId,
          iterationNumber,
          assetType: "leaflet",
          assetTier: "premium",
          ...(aiAttempts ? { imageAttempts: aiAttempts } : {}),
        },
      })
      .where(eq(contentPosts.id, post.id));

    // Caption pack is included with premium leaflet.
    generateCaptionPack({
      userId,
      contentPostId: post.id,
      generationRunId,
      iterationNumber,
      assetTier: "premium",
    }).catch((err) => {
      console.error(`[PremiumLeaflet] Caption pack async error | userId=${userId} | contentPostId=${post.id} | error="${err.message}"`);
    });

    logInfo("[PremiumLeaflet] completed", {
      userId,
      contentPostId,
      provider: finalProviderName,
      providerTemplateId: finalProviderTemplateId,
      url: stored.publicUrl,
      finalApiStatus: "completed",
      creditsDeducted: cost,
      creditsReason: fallbackMeta?.creditsReason,
      fallbackProviderUsed: fallbackMeta?.provider,
      fallbackReason: fallbackMeta?.fallbackReason,
      refinementInstructionType,
      messagePackSource,
      copyRewriteSkippedReason,
      visualInstructionPassedToRenderer,
      usingFallback: !!fallbackMeta,
    });

    return {
      jobId: renderResult.providerJobId || "premium",
      provider: finalProviderName,
      status: "completed",
      imageUrl: stored.publicUrl,
      extension: renderResult.extension || "png",
      creditsCharged: cost,
      qualityTier,
      qualityLabel,
      isDraft: false,
      usingFallback: !!fallbackMeta,
      fallbackMessage,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[PremiumLeaflet] Unexpected error | userId=${userId} | contentPostId=${contentPostId} | error="${errorMessage}"`, err);
    await setPostImageStatus(contentPostId, { imageStatus: "failed", imageError: errorMessage });
    return { status: "failed", jobId: "", errorMessage };
  }
}

async function renderAiLeafletWithQuality(
  renderer: TemplateRendererProvider,
  renderReq: TemplateRendererRequest,
  opts: {
    business: any;
    campaign: any;
    hasLogo: boolean;
    brandPalette: any;
    maxAttempts?: number;
  }
): Promise<
  | { success: true; result: TemplateRendererResult; finalBuffer: Buffer; qualityResult: LeafletQualityResult; attempts: any[] }
  | { success: false; errorMessage: string; attempts: any[] }
> {
  const attempts: any[] = [];
  const maxAttempts = opts.maxAttempts ?? 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const req = { ...renderReq, isRetry: attempt > 1 };
    const result: TemplateRendererResult = await renderer.render(req);

    if (!result.success || (!result.imageUrl && !result.imageBase64)) {
      const error = result.error || "AI leaflet render failed.";
      attempts.push({
        number: attempt,
        source: "openai",
        passed: false,
        score: 0,
        criticalFailures: [error],
        warnings: [],
      });
      return { success: false, errorMessage: error, attempts };
    }

    const finalBuffer = result.imageBase64
      ? Buffer.from(result.imageBase64, "base64")
      : Buffer.from(await (await fetch(result.imageUrl!)).arrayBuffer());

    const raw = (result.rawResponse || {}) as any;
    const backgroundBuffer = raw.backgroundBase64 ? Buffer.from(raw.backgroundBase64, "base64") : undefined;

    const validation = await validateAiLeafletQuality({
      backgroundBuffer,
      finalBuffer,
      business: opts.business,
      campaign: opts.campaign,
      prompt: raw.prompt || renderReq.headline,
      hasLogo: opts.hasLogo,
      logoOverlayApplied: opts.hasLogo,
      palette: opts.brandPalette,
      headline: renderReq.headline,
      cta: renderReq.cta,
      serviceBullets: renderReq.services,
    });

    attempts.push({
      number: attempt,
      source: "openai",
      passed: validation.passed,
      score: validation.score,
      qualityTier: validation.qualityTier,
      criticalFailures: validation.criticalFailures,
      warnings: validation.warnings,
    });

    if (validation.passed) {
      return { success: true, result, finalBuffer, qualityResult: validation, attempts };
    }

    console.warn(
      `[PremiumLeaflet] AI leaflet quality check failed on attempt ${attempt} | score=${validation.score} | critical=${validation.criticalFailures.join(", ")} | warnings=${validation.warnings.join(", ")}`
    );
  }

  return {
    success: false,
    errorMessage: `AI leaflet did not pass quality validation after ${maxAttempts} attempts.`,
    attempts,
  };
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
  regenerate = false,
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
  regenerate?: boolean;
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
      regenerate,
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
  generationRunId,
  iterationNumber,
  assetTier,
}: {
  userId: number;
  contentPostId: number;
  generationRunId?: string;
  iterationNumber?: number;
  assetTier?: "premium" | "basic" | "standard";
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

  const postMeta = (post.metadata || {}) as any;
  const imageSource = postMeta?.imageSource || "draft";
  const imageQualityTier = postMeta?.imageQualityTier || "draft";
  const imageCreditsCharged = typeof postMeta?.imageCreditsCharged === "number" ? postMeta.imageCreditsCharged : null;
  const isDraftAsset = imageSource === "draft" || imageCreditsCharged === 0 || imageQualityTier === "draft";
  const assetTierLabel = isDraftAsset ? "Basic Draft" : "Premium Marketing Leaflet";
  const resolvedAssetTier = assetTier || postMeta?.assetTier || (isDraftAsset ? "basic" : "premium");
  const resolvedGenerationRunId = generationRunId || postMeta?.generationRunId;
  const resolvedIterationNumber = iterationNumber ?? postMeta?.iterationNumber ?? 1;

  const formattedOffer = renderOffer(campaign.offerDetails, business.name);
  const leafletHeadline = offerToHeadline(campaign.offerDetails);
  const normalizedCta = normalizeCta(campaign.preferredCta || post.cta);

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
    ? isDraftAsset
      ? "Custom Canvas Art, Custom Canvas Prints, Framed Posters, Wall Art, Home & Office Décor, Turn Photos into Art"
      : "Bespoke Afrocentric Canvas Art, Custom Canvas Prints, Framed Posters, Premium Wall Art, Home & Office Décor, Turn Photos into Art"
    : (campaign.productOrService || business.productOrService || "your core service");

  const selectedPlatforms = (campaign.platforms || "Instagram, Facebook")
    .split(/[,;]+/)
    .map((p: string) => p.trim())
    .filter(Boolean);

  const prompt = `You are a senior conversion copywriter for a local marketing agency. Write a commercially specific, ready-to-post "Caption Pack" that matches the ${assetTierLabel} image just generated for this campaign. The copy must support the same message as the image and sound like it was written for THIS exact business.

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

GENERATED ASSET CONTEXT:
- Asset tier: ${assetTierLabel}
- Image source: ${imageSource}
${isDraftAsset ? "- This is a draft/preview image, NOT a premium provider-rendered leaflet. Do NOT use words like premium, luxury, high-end, exclusive, bespoke, or elite. Keep the copy practical and grounded." : "- This is a premium provider-rendered leaflet. The copy can reflect a polished, customer-ready presentation."}

CAMPAIGN BRIEF:
- Primary outcome: ${campaign.primaryOutcome || "N/A"}
- Target buyer: ${campaign.targetBuyer || campaign.targetAudience || "N/A"}
- Main pain point: ${campaign.mainPainPoint || "N/A"}
- Product/service being promoted: ${campaign.productOrService || business.productOrService || "N/A"}
- Offer (use EXACTLY this wording and formatting): ${formattedOffer || campaign.offerDetails || "None — do not invent offers or discounts"}
- Headline (use EXACTLY this wording): ${leafletHeadline || post.title || "N/A"}
- Preferred CTA: ${normalizedCta || "Request a Quote Today"}
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
5. If an offer is provided, state it EXACTLY as formatted above (e.g. "Enjoy 10% off orders above R3,000"). Do not reformat numbers (e.g. do not change "R3,000" to "R3000" or "R3 000"). If no offer is provided, do NOT invent discounts, free trials, limited spots, free e-books, loyalty programmes or fake promotions.
6. CTA must be clear and action-based: "Order on WhatsApp", "Request a quote", "Shop online", "Book a demo", "Speak to us" or similar. Match it to the preferred CTA if one is supplied.
7. Each caption must match the platform's tone and format and be usable straight away.
8. Hashtags should be a focused mix of core, local and niche tags (8–12 total). Include location-based tags if a location is provided.
9. CTA variations must be distinct and platform-appropriate.
10. Outreach DM should be short, warm and direct — one sentence of context plus a clear ask.
11. The caption pack must NOT contradict the image offer/CTA or invent a different promotion.
12. The caption pack must NOT describe the image as a premium provider-rendered leaflet when the asset tier is Basic Draft.
13. Generate captions for ALL of the selected platforms listed above.

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
        linkedinCaption: normaliseOfferInText(parsed.linkedinCaption || post.caption || "", campaign.offerDetails),
        facebookCaption: normaliseOfferInText(parsed.facebookCaption || post.caption || "", campaign.offerDetails),
        instagramCaption: normaliseOfferInText(parsed.instagramCaption || post.caption || "", campaign.offerDetails),
        whatsappCaption: normaliseOfferInText(parsed.whatsappCaption || post.cta || "", campaign.offerDetails),
        emailSubject: normaliseOfferInText(parsed.emailSubject || post.title || "", campaign.offerDetails),
        emailPreheader: normaliseOfferInText(parsed.emailPreheader || post.hook || "", campaign.offerDetails),
        emailBody: normaliseOfferInText(parsed.emailBody || post.caption || "", campaign.offerDetails),
        hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
        ctaVariations: Array.isArray(parsed.ctaVariations) ? parsed.ctaVariations.map((c) => normaliseOfferInText(c, campaign.offerDetails)) : [],
        outreachDm: normaliseOfferInText(parsed.outreachDm || "", campaign.offerDetails),
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
        imageSource,
        imageQualityTier,
        imageCreditsCharged,
        isDraft: isDraftAsset,
        assetTierLabel,
        generationRunId: resolvedGenerationRunId,
        iterationNumber: resolvedIterationNumber,
        assetType: "caption_pack",
        assetTier: resolvedAssetTier,
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
    businessName: (business.displayName as string) || business.name,
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
