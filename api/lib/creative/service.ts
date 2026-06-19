import { TRPCError } from "@trpc/server";
import { eq, and, desc } from "drizzle-orm";
import fs from "fs";
import { env } from "../env";
import { getDb } from "../../queries/connection";
import { contentPosts, campaigns, businesses, generatedImages, videoRenderJobs, campaignAssets } from "@db/schema";
import { checkCredits, deductCredits, recordAiUsage } from "../billing/credit-engine";
import { enforceCostControl } from "../billing/cost-control";
import { getImageProvider, getPremiumVideoProvider, getBasicVideoProvider } from "./registry";
import { storeImageBuffer, downloadAndStoreVideo } from "./storage";
import { composeBrandedLeafletImage, generateFallbackLeafletImage, defaultServiceBullets } from "./composition";
import sharp from "sharp";
import { validateLeafletPrompt, validateLeafletQuality, sanitizePromptForValidator, isPublicImageLoadable, validateLeafletComposition, validateBrandFidelity } from "./quality";
import { formatOffer, offerToHeadline, normalizeCta, validateMarketingText } from "./text-formatter";
import { resolveBrandPalette } from "./brand-palette";
import {
  getPremiumImageCredits,
  getPremiumVideoCredits,
  creatifyCreditsToUsd,
  usdToMicroCents,
} from "./costs";
import { buildPremiumImagePrompt, getImageAspectRatio } from "./prompts/image-prompt";
import type { CreativeType } from "./prompts/image-prompt";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import type {
  ImageResult,
  VideoResult,
  VideoRequest,
  ProviderStatus,
} from "./types";

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

// ─── OpenAI DALL-E 3 actual cost (USD) by size ───
function openAiImageActualCostUsd(size: string): number {
  if (size === "1024x1024") return 0.04;
  return 0.08; // 1024x1792 or 1792x1024
}

function mapAspectRatioToOpenAiSize(ratio?: string): "1024x1024" | "1024x1792" | "1792x1024" {
  switch (ratio) {
    case "16:9":
    case "3:2":
    case "4:3":
      return "1792x1024";
    case "9:16":
    case "2:3":
    case "4:5":
      return "1024x1792";
    case "1:1":
    default:
      return "1024x1024";
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

// ─── Master Campaign Post image generation ───
export async function generateMasterImage({
  userId,
  contentPostId,
  brandColors,
  creativeType = "leaflet",
  strongerBrandFit = false,
  creativeGuidance,
  refinementInstruction,
  allowNoLogo = false,
}: {
  userId: number;
  contentPostId: number;
  brandColors?: string[];
  creativeType?: CreativeType;
  strongerBrandFit?: boolean;
  creativeGuidance?: string;
  refinementInstruction?: string;
  allowNoLogo?: boolean;
}): Promise<ImageResult & { imageUrl?: string; creditsCharged?: number }> {
  const db = getDb();

  const [post] = await db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.id, contentPostId), eq(contentPosts.userId, userId)))
    .limit(1);

  if (!post) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Content post not found" });
  }

  const provider = getImageProvider();
  if (!provider.configured) {
    throw new TRPCError({
      code: "NOT_IMPLEMENTED",
      message: "Premium image generation is not configured. Add OPENAI_API_KEY to enable it.",
    });
  }

  const cost = getPremiumImageCredits();
  await assertCanAfford(userId, cost, "Premium image generation");

  const currentMeta = (post.metadata || {}) as any;
  await db
    .update(contentPosts)
    .set({
      metadata: {
        ...currentMeta,
        imageStatus: "generating",
        imageError: null,
      },
    })
    .where(eq(contentPosts.id, post.id));

  try {
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

    // Fallback to the user's most recent business if the campaign is not
    // linked, so a logo/brand identity is still available.
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

    console.log(`[CreativeService] Resolved business for generation | contentPostId=${contentPostId} | businessId=${business?.id ?? "none"} | name=${business?.name ?? "none"} | logo=${business?.logo ?? "none"}`);

    // ─── Brand palette resolution ───
    const brandPalette = await resolveBrandPalette({ ...business, brandColors });
    const hasLogo = !!business?.logo;
    if (!hasLogo && !allowNoLogo) {
      console.warn(`[CreativeService] Premium leaflet blocked: no business logo | userId=${userId} | contentPostId=${contentPostId}`);
      await db
        .update(contentPosts)
        .set({
          metadata: {
            ...currentMeta,
            imageStatus: "failed",
            imageError: "Please upload your business logo in Settings before generating a premium leaflet. Premium leaflets use your logo and brand colours for best results.",
          },
        })
        .where(eq(contentPosts.id, post.id));
      return {
        status: "failed",
        jobId: "",
        errorMessage: "Please upload your business logo in Settings before generating a premium leaflet. Premium leaflets use your logo and brand colours for best results.",
      };
    }

    // ─── Normalised customer-facing text ───
    const formattedOffer = formatOffer(campaign.offerDetails, business.name);
    const leafletHeadline = offerToHeadline(campaign.offerDetails);
    console.log(`[LeafletCopy] rawOffer="${campaign.offerDetails ?? ""}" | formattedOffer="${formattedOffer}" | headline="${leafletHeadline}"`);
    const businessCategory = (
      business?.websiteEvidence?.businessCategory ||
      business?.industry ||
      business?.productOrService ||
      ""
    ).toString();
    const leafletCta = normalizeCta(campaign.preferredCta || post.cta, businessCategory);

    const aspectRatio = getImageAspectRatio(creativeType, post.platform || "Instagram");

    // ─── Prompt helpers ───
    const buildPrompt = (stronger: boolean) =>
      buildPremiumImagePrompt({
        business,
        campaign,
        post,
        brandColors,
        creativeType,
        strongerBrandFit: stronger,
        palette: brandPalette,
        creativeGuidance,
        refinementInstruction,
      });

    const preparePrompt = (rawPrompt: string) => {
      const firstCheck = validateLeafletPrompt(rawPrompt, business);
      if (firstCheck.passed) return { prompt: rawPrompt, valid: true, reasons: [] as string[] };
      const sanitized = sanitizePromptForValidator(rawPrompt);
      const secondCheck = validateLeafletPrompt(sanitized, business);
      if (secondCheck.passed) {
        console.log(`[CreativeService] Prompt sanitized before generation | userId=${userId} | contentPostId=${contentPostId} | originalFailures=${JSON.stringify(firstCheck.criticalFailures)} | originalWarnings=${JSON.stringify(firstCheck.warnings)}`);
        return { prompt: sanitized, valid: true, reasons: [] as string[] };
      }
      return { prompt: sanitized, valid: false, reasons: [...secondCheck.criticalFailures, ...secondCheck.warnings] };
    };

    // ─── Single OpenAI attempt: generate + decode + score + store raw attempt ───
    interface AttemptRecord {
      number: number;
      source: "openai" | "fallback";
      prompt: string;
      strongerBrandFit: boolean;
      buffer: Buffer;
      result?: ImageResult;
      score: number;
      criticalFailures: string[];
      warnings: string[];
      passed: boolean;
      storedUrl?: string;
      storedLocalPath?: string;
    }

    async function runOpenAiAttempt(prompt: string, stronger: boolean, attemptNumber: number): Promise<AttemptRecord | null> {
      console.log(`[CreativeService] Requesting OpenAI image | userId=${userId} | contentPostId=${contentPostId} | attempt=${attemptNumber} | model=${env.openaiImageModel || "gpt-image-1"} | aspectRatio=${aspectRatio}`);

      const generationResult = await provider.generate({
        userId,
        campaignId: post.campaignId ?? undefined,
        businessId: business.id,
        contentPostId: post.id,
        prompt,
        aspectRatio,
        style: campaign.contentStyle || business.visualStyle,
        negativePrompt: campaign.excludedOffers || undefined,
      });

      if (generationResult.status === "failed" || (!generationResult.imageUrl && !generationResult.imageBase64)) {
        const errorMessage = generationResult.errorMessage || "Image generation failed";
        console.error(`[CreativeService] Image generation failed | userId=${userId} | contentPostId=${contentPostId} | attempt=${attemptNumber} | error="${errorMessage}"`);
        return null;
      }

      let buffer: Buffer;
      try {
        if (generationResult.imageBase64) {
          buffer = Buffer.from(generationResult.imageBase64, "base64");
        } else if (generationResult.imageUrl) {
          const imgResponse = await fetch(generationResult.imageUrl);
          if (!imgResponse.ok) throw new Error(`Failed to download generated image: ${imgResponse.status}`);
          buffer = Buffer.from(await imgResponse.arrayBuffer());
        } else {
          throw new Error("No image URL or base64 data received");
        }
      } catch (decodeErr) {
        const message = decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
        console.error(`[CreativeService] Failed to decode generated image | userId=${userId} | attempt=${attemptNumber} | error="${message}"`);
        return null;
      }

      const quality = await validateLeafletQuality(buffer, business, campaign, prompt);
      console.log(`[CreativeService] Quality score | userId=${userId} | contentPostId=${contentPostId} | attempt=${attemptNumber} | score=${quality.score} | critical=${JSON.stringify(quality.criticalFailures)} | warnings=${JSON.stringify(quality.warnings)}`);

      // Store the raw OpenAI attempt so admin/testing can inspect it even if not selected.
      let storedUrl: string | undefined;
      let storedLocalPath: string | undefined;
      try {
        const stored = await storeImageBuffer(buffer, {
          campaignId: post.campaignId ?? undefined,
          prefix: `master-post-attempt-${attemptNumber}`,
          extension: generationResult.extension || "png",
        });
        storedUrl = stored.publicUrl;
        storedLocalPath = stored.localPath;
        console.log(`[CreativeService] Stored attempt ${attemptNumber} | url=${stored.publicUrl}`);
      } catch (storeErr) {
        const message = storeErr instanceof Error ? storeErr.message : String(storeErr);
        console.warn(`[CreativeService] Failed to store attempt ${attemptNumber} | error="${message}"`);
      }

      return {
        number: attemptNumber,
        source: "openai",
        prompt,
        strongerBrandFit: stronger,
        buffer,
        result: generationResult,
        score: quality.score,
        criticalFailures: quality.criticalFailures,
        warnings: quality.warnings,
        passed: quality.passed,
        storedUrl,
        storedLocalPath,
      };
    }

    async function createFallbackAttempt(): Promise<AttemptRecord> {
      const fallbackPrompt = buildPrompt(true);
      const buffer = await generateFallbackLeafletImage({
        business,
        campaign,
        post,
        creativeType,
        offer: formattedOffer,
        cta: leafletCta,
        headline: leafletHeadline || campaign.primaryOutcome || post?.title || business.name,
        subheadline: campaign.mainPainPoint || campaign.coreMessage || post?.hook || "",
        palette: brandPalette,
      });
      return {
        number: 0,
        source: "fallback",
        prompt: fallbackPrompt,
        strongerBrandFit: true,
        buffer,
        score: 100,
        criticalFailures: [],
        warnings: ["Fallback template used because OpenAI attempts did not meet acceptance criteria."],
        passed: true,
      };
    }

    function isAcceptable(attempt: AttemptRecord | null): boolean {
      return !!attempt && attempt.criticalFailures.length === 0 && attempt.score >= 60;
    }

    function shouldRetry(attempt: AttemptRecord | null): boolean {
      // Retry if the attempt is missing, has a critical failure, or scores below
      // the usable threshold. Score 60–79 is accepted with warnings; 80+ is ideal.
      if (!attempt) return true;
      return attempt.criticalFailures.length > 0 || attempt.score < 60;
    }

    function pickBestAttempt(a: AttemptRecord | null, b: AttemptRecord | null): AttemptRecord | null {
      if (!a) return b;
      if (!b) return a;
      // Prefer an attempt with no critical failures.
      if (a.criticalFailures.length === 0 && b.criticalFailures.length > 0) return a;
      if (b.criticalFailures.length === 0 && a.criticalFailures.length > 0) return b;
      return a.score >= b.score ? a : b;
    }

    const allAttempts: AttemptRecord[] = [];

    // ─── Attempt 1 ───
    const promptPrep = preparePrompt(buildPrompt(strongerBrandFit));
    let bestAttempt: AttemptRecord | null = null;

    if (promptPrep.valid) {
      const firstAttempt = await runOpenAiAttempt(promptPrep.prompt, strongerBrandFit, 1);
      if (firstAttempt) {
        allAttempts.push(firstAttempt);
        bestAttempt = firstAttempt;
      }
    } else {
      console.warn(`[CreativeService] Prompt invalid even after sanitisation; skipping first OpenAI call | userId=${userId} | contentPostId=${contentPostId} | reasons=${JSON.stringify(promptPrep.reasons)}`);
    }

    // ─── Attempt 2 if first attempt needs improvement ───
    if (shouldRetry(bestAttempt)) {
      const retryPrep = preparePrompt(buildPrompt(true));
      if (retryPrep.valid) {
        console.log(`[CreativeService] Retrying with stronger prompt | userId=${userId} | contentPostId=${contentPostId} | firstScore=${bestAttempt?.score ?? "null"} | firstCritical=${JSON.stringify(bestAttempt?.criticalFailures ?? [])}`);
        const retryAttempt = await runOpenAiAttempt(retryPrep.prompt, true, 2);
        if (retryAttempt) {
          allAttempts.push(retryAttempt);
          bestAttempt = pickBestAttempt(bestAttempt, retryAttempt);
        }
      } else {
        console.warn(`[CreativeService] Retry prompt invalid after sanitisation | userId=${userId} | contentPostId=${contentPostId} | reasons=${JSON.stringify(retryPrep.reasons)}`);
      }
    }

    // ─── Fallback only if no acceptable OpenAI attempt ───
    let usingFallback = false;
    if (!isAcceptable(bestAttempt)) {
      usingFallback = true;
      bestAttempt = await createFallbackAttempt();
      allAttempts.push(bestAttempt);
      console.log(`[CreativeService] Fallback leaflet rendered | userId=${userId} | contentPostId=${contentPostId} | size=${bestAttempt.buffer.length}`);
    }

    let finalAttempt = bestAttempt!;
    let finalPrompt = finalAttempt.prompt;
    let finalResult: ImageResult | undefined = finalAttempt.result;
    let rawBuffer: Buffer = finalAttempt.buffer;

    // ─── Brand overlay for OpenAI images (fallback is already branded) ───
    let composedBuffer = rawBuffer;
    let logoOverlayApplied = false;
    if (finalAttempt.source === "openai") {
      try {
        const composed = await composeBrandedLeafletImage(rawBuffer, {
          business,
          campaign,
          post,
          creativeType,
          offer: formattedOffer,
          cta: leafletCta,
          headline: leafletHeadline || campaign.primaryOutcome || post?.title || business.name,
          subheadline: campaign.mainPainPoint || campaign.coreMessage || post?.hook || "",
          palette: brandPalette,
        });
        composedBuffer = composed.buffer;
        logoOverlayApplied = composed.logoApplied;
        console.log(`[CreativeService] Sharp composition completed | userId=${userId} | contentPostId=${contentPostId} | size=${composedBuffer.length} | logoOverlayApplied=${logoOverlayApplied}`);
      } catch (composeErr) {
        const message = composeErr instanceof Error ? composeErr.message : String(composeErr);
        console.warn(`[CreativeService] Brand overlay failed, using raw image | userId=${userId} | error="${message}"`);
      }
    } else {
      // Fallback renderer always applies the logo if available.
      logoOverlayApplied = !!business?.logo;
    }

    if (hasLogo && !logoOverlayApplied) {
      throw new Error(`Business logo exists but could not be applied to the leaflet: ${business.logo}`);
    }

    // ─── Final overlay quality checks (text + composition) ───
    const imageMeta = await sharp(composedBuffer).metadata();
    const imageHeight = imageMeta.height || 1536;

    const marketingTextCheck = validateMarketingText({
      headline: leafletHeadline,
      offer: formattedOffer,
      cta: leafletCta,
      businessName: business.name,
    });
    const compositionCheck = validateLeafletComposition({
      hasLogo: !!business?.logo,
      headline: leafletHeadline,
      cta: leafletCta,
      serviceBullets: defaultServiceBullets(business, campaign),
      headerHeight: Math.round(imageHeight * 0.075),
      footerHeight: Math.round(imageHeight * 0.16),
      imageHeight,
    });

    // Brand fidelity check.
    const brandFidelityCheck = validateBrandFidelity({
      hasLogo,
      logoOverlayApplied: hasLogo ? logoOverlayApplied : undefined,
      palette: brandPalette,
      businessName: business.name,
      headline: leafletHeadline,
    });

    const totalPenalty = marketingTextCheck.scorePenalty + compositionCheck.scorePenalty + brandFidelityCheck.scorePenalty;
    const allTextIssues = [...marketingTextCheck.issues, ...compositionCheck.issues, ...brandFidelityCheck.issues];
    if (allTextIssues.length > 0) {
      finalAttempt.score = Math.max(0, finalAttempt.score - totalPenalty);
      finalAttempt.warnings = [...finalAttempt.warnings, ...allTextIssues];
      console.log(`[CreativeService] Overlay quality penalty | userId=${userId} | contentPostId=${contentPostId} | penalty=${totalPenalty} | newScore=${finalAttempt.score} | issues=${JSON.stringify(allTextIssues)}`);
    }

    // ─── Store locally with fallback on storage/URL failure ───
    async function validateStoredImage(stored: { publicUrl: string; localPath: string }) {
      if (!stored.publicUrl || typeof stored.publicUrl !== "string") {
        throw new Error("Stored image returned an invalid public URL");
      }
      if (!stored.publicUrl.startsWith("/") && !stored.publicUrl.startsWith("http")) {
        throw new Error(`Stored image returned a malformed public URL: ${stored.publicUrl}`);
      }
      const stats = fs.statSync(stored.localPath);
      if (!stats.isFile() || stats.size === 0) {
        throw new Error(`Stored image file is missing or empty: ${stored.localPath}`);
      }
      // For absolute public URLs, confirm they are actually reachable.
      if (stored.publicUrl.startsWith("http") && !(await isPublicImageLoadable(stored.publicUrl))) {
        throw new Error(`Stored image public URL is not loadable: ${stored.publicUrl}`);
      }
    }

    let stored;
    try {
      stored = await storeImageBuffer(composedBuffer, {
        campaignId: post.campaignId ?? undefined,
        prefix: usingFallback ? "master-post-fallback" : "master-post",
        extension: finalResult?.extension || "png",
      });
      await validateStoredImage(stored);
      console.log(`[CreativeService] Image stored and validated | userId=${userId} | contentPostId=${contentPostId} | publicUrl=${stored.publicUrl} | localPath=${stored.localPath} | size=${composedBuffer.length}`);
    } catch (storeOrValidateErr) {
      const message = storeOrValidateErr instanceof Error ? storeOrValidateErr.message : String(storeOrValidateErr);
      console.error(`[CreativeService] Failed to store or validate image | userId=${userId} | contentPostId=${contentPostId} | error="${message}"`);

      // If the OpenAI image cannot be stored or served, render the deterministic
      // fallback instead of returning a hard failure.
      if (finalAttempt.source === "openai") {
        console.log(`[CreativeService] Rendering fallback because OpenAI image could not be stored/served | userId=${userId} | contentPostId=${contentPostId}`);
        usingFallback = true;
        bestAttempt = await createFallbackAttempt();
        allAttempts.push(bestAttempt);
        finalAttempt = bestAttempt;
        finalPrompt = finalAttempt.prompt;
        finalResult = finalAttempt.result;
        rawBuffer = finalAttempt.buffer;
        composedBuffer = rawBuffer;
        stored = await storeImageBuffer(composedBuffer, {
          campaignId: post.campaignId ?? undefined,
          prefix: "master-post-fallback",
          extension: "png",
        });
        await validateStoredImage(stored);
        console.log(`[CreativeService] Fallback image stored and validated | userId=${userId} | contentPostId=${contentPostId} | publicUrl=${stored.publicUrl}`);
      } else {
        await db
          .update(contentPosts)
          .set({
            metadata: {
              ...currentMeta,
              imageStatus: "failed",
              imageError: `Generated image could not be stored or validated: ${message}`,
            },
          })
          .where(eq(contentPosts.id, post.id));
        return { status: "failed", jobId: finalResult?.providerJobId || "fallback", errorMessage: `Generated image could not be stored or validated: ${message}` };
      }
    }

    // ─── Deduct credits only on success ───
    const deduction = await deductCredits({
      userId,
      amount: cost,
      type: "image_generation",
      description: usingFallback
        ? "Premium Master Campaign Post image generation (fallback template)"
        : "Premium Master Campaign Post image generation",
      metadata: {
        provider: provider.name,
        providerJobId: finalResult?.providerJobId || "fallback",
        contentPostId: post.id,
        campaignId: post.campaignId,
        cost,
        usingFallback,
      },
    });

    // ─── Record AI usage / provider cost ───
    const openAiSize = mapAspectRatioToOpenAiSize(aspectRatio);
    const actualCostUsd = usingFallback ? 0 : openAiImageActualCostUsd(openAiSize);
    await recordAiUsage({
      userId,
      campaignId: post.campaignId ?? undefined,
      agentType: "image_generation",
      model: env.openaiImageModel || "gpt-image-1",
      promptTokens: 500,
      completionTokens: 100,
      actualCostUsdMicro: usdToMicroCents(actualCostUsd),
      estimatedCostUsdMicro: usdToMicroCents(actualCostUsd),
      creditsDeducted: cost,
      metadata: {
        provider: provider.name,
        providerJobId: finalResult?.providerJobId || "fallback",
        contentPostId: post.id,
        aspectRatio,
        outputUrl: stored.publicUrl,
        usingFallback,
      },
    });

    const attemptsSummary = allAttempts.map((a) => ({
      number: a.number,
      source: a.source,
      score: a.score,
      passed: a.passed,
      criticalFailures: a.criticalFailures,
      warnings: a.warnings,
      validationIssues: a.warnings,
      storedUrl: a.storedUrl,
      promptUsed: a.prompt,
      strongerBrandFitUsed: a.strongerBrandFit,
    }));

    // ─── Version history ───
    const previousVersions = Array.isArray(currentMeta?.imageVersions) ? currentMeta.imageVersions : [];
    const newVersion = {
      version: previousVersions.length + 1,
      url: stored.publicUrl,
      source: usingFallback ? "fallback" : "openai",
      score: finalAttempt.score,
      promptUsed: finalPrompt,
      strongerBrandFitUsed: finalAttempt.strongerBrandFit,
      creativeGuidance,
      refinementInstruction,
      brandPalette,
      hasLogo,
      generatedAt: new Date().toISOString(),
      approved: false,
    };
    const imageVersions = [...previousVersions, newVersion];

    // ─── Persist audit row ───
    await db.insert(generatedImages).values({
      userId,
      campaignId: post.campaignId,
      businessId: business.id,
      contentPostId: post.id,
      provider: provider.name,
      providerJobId: finalResult?.providerJobId || "fallback",
      prompt: finalPrompt,
      url: stored.publicUrl,
      aspectRatio,
      style: campaign.contentStyle || business.visualStyle,
      status: "completed",
      creditsCharged: cost,
      providerCostUsd: usdToMicroCents(actualCostUsd),
      metadata: {
        originalUrl: finalResult?.imageUrl,
        localPath: stored.localPath,
        balanceAfter: deduction.newBalance,
        usingFallback,
        source: usingFallback ? "fallback" : "openai",
        qualityScore: finalAttempt.score,
        validationIssues: finalAttempt.warnings,
        criticalFailures: finalAttempt.criticalFailures,
        qualityWarnings: finalAttempt.warnings,
        qualityCriticalFailures: finalAttempt.criticalFailures,
        fallbackUsed: usingFallback,
        promptUsed: finalPrompt,
        strongerBrandFitUsed: finalAttempt.strongerBrandFit,
        creativeGuidance,
        refinementInstruction,
        brandPalette,
        hasLogo,
        attempts: attemptsSummary,
        versions: imageVersions,
      },
    });

    // ─── Update master post metadata ───
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
          imageProvider: provider.name,
          imageJobId: finalResult?.providerJobId || "fallback",
          imageStatus: "ready",
          imageGeneratedAt: new Date().toISOString(),
          imageError: null,
          imageCreditsCharged: cost,
          imageExtension: finalResult?.extension || "png",
          imageSource: usingFallback ? "fallback" : "openai",
          source: usingFallback ? "fallback" : "openai",
          imageQualityScore: finalAttempt.score,
          qualityScore: finalAttempt.score,
          imageQualityWarnings: finalAttempt.warnings,
          validationIssues: finalAttempt.warnings,
          imageQualityCriticalFailures: finalAttempt.criticalFailures,
          criticalFailures: finalAttempt.criticalFailures,
          imageFallbackUsed: usingFallback,
          fallbackUsed: usingFallback,
          imagePromptUsed: finalPrompt,
          promptUsed: finalPrompt,
          imageStrongerBrandFitUsed: finalAttempt.strongerBrandFit,
          strongerBrandFitUsed: finalAttempt.strongerBrandFit,
          imageAttempts: attemptsSummary,
          imageVersions,
          imageBrandPalette: brandPalette,
          imageHasLogo: hasLogo,
          imageLogoOverlayApplied: logoOverlayApplied,
          imageCreativeGuidance: creativeGuidance,
          imageRefinementInstruction: refinementInstruction,
          imageApprovedVersion: currentMeta?.imageApprovedVersion,
        },
      })
      .where(eq(contentPosts.id, post.id));

    // ─── Generate included Caption Pack (non-blocking) ───
    generateCaptionPack({ userId, contentPostId: post.id }).catch((err) => {
      console.error(`[CreativeService] Caption pack async error | userId=${userId} | contentPostId=${post.id} | error="${err.message}"`);
    });

    console.log(`[CreativeService] Premium image ready | userId=${userId} | contentPostId=${contentPostId} | url=${stored.publicUrl} | credits=${cost} | fallback=${usingFallback}`);

    return {
      jobId: finalResult?.providerJobId || "fallback",
      providerJobId: finalResult?.providerJobId || "fallback",
      provider: provider.name,
      status: "completed",
      imageUrl: stored.publicUrl,
      imageBase64: finalResult?.imageBase64,
      extension: finalResult?.extension || "png",
      creditsCharged: cost,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[CreativeService] Unexpected error generating premium image | userId=${userId} | contentPostId=${contentPostId} | error="${errorMessage}"`, err);
    try {
      await db
        .update(contentPosts)
        .set({
          metadata: {
            ...currentMeta,
            imageStatus: "failed",
            imageError: errorMessage,
          },
        })
        .where(eq(contentPosts.id, post.id));
    } catch (metadataErr) {
      const metadataErrorMessage = metadataErr instanceof Error ? metadataErr.message : String(metadataErr);
      console.error(`[CreativeService] Failed to update failure metadata | error="${metadataErrorMessage}"`);
    }
    return { status: "failed", jobId: "", errorMessage };
  }
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
