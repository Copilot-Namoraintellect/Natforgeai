import { TRPCError } from "@trpc/server";
import { eq, and } from "drizzle-orm";
import { env } from "../env";
import { getDb } from "../../queries/connection";
import { contentPosts, campaigns, businesses, generatedImages, videoRenderJobs, campaignAssets } from "@db/schema";
import { checkCredits, deductCredits, recordAiUsage } from "../billing/credit-engine";
import { enforceCostControl } from "../billing/cost-control";
import { getImageProvider, getPremiumVideoProvider, getBasicVideoProvider } from "./registry";
import { downloadAndStoreImage, storeBase64Image, downloadAndStoreVideo } from "./storage";
import {
  getPremiumImageCredits,
  getPremiumVideoCredits,
  creatifyCreditsToUsd,
  usdToMicroCents,
} from "./costs";
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

function mapPlatformToAspectRatio(platform?: string): string {
  if (!platform) return "1:1";
  const p = platform.toLowerCase();
  if (p.includes("instagram")) return "1:1";
  if (p.includes("facebook")) return "4:5";
  if (p.includes("linkedin")) return "1.91:1";
  if (p.includes("tiktok") || p.includes("reel")) return "9:16";
  if (p.includes("twitter") || p.includes("x")) return "16:9";
  return "1:1";
}

// ─── Prompt assembly ───
function buildImagePrompt(opts: {
  business: any;
  campaign: any;
  post: any;
  brandColors?: string[];
}): string {
  const { business, campaign, post } = opts;
  const meta = (post.metadata || {}) as any;

  const brandColors = opts.brandColors?.length
    ? opts.brandColors
    : (business.brandColors as string[] | undefined) || [];

  const lines = [
    `Create a premium, conversion-focused social media image for ${business.name}.`,
    `Business: ${business.name}`,
    business.industry ? `Industry: ${business.industry}` : "",
    business.location ? `Location: ${business.location}` : "",
    business.website ? `Website: ${business.website}` : "",
    business.brandTone ? `Brand tone: ${business.brandTone}` : "",
    brandColors.length ? `Brand colours: ${brandColors.join(", ")}` : "",
    business.visualStyle ? `Visual style: ${business.visualStyle}` : "",
    campaign.primaryOutcome ? `Primary outcome: ${campaign.primaryOutcome}` : "",
    campaign.targetBuyer || campaign.targetAudience
      ? `Target buyer: ${campaign.targetBuyer || campaign.targetAudience}`
      : "",
    campaign.mainPainPoint ? `Main pain point: ${campaign.mainPainPoint}` : "",
    campaign.productOrService ? `Product/service: ${campaign.productOrService}` : "",
    campaign.offerDetails ? `Offer: ${campaign.offerDetails}` : "",
    campaign.preferredCta || post.cta ? `CTA: ${campaign.preferredCta || post.cta}` : "",
    campaign.excludedOffers ? `Do NOT include: ${campaign.excludedOffers}` : "",
    campaign.referenceStyle ? `Reference style: ${campaign.referenceStyle}` : "",
    campaign.contentStyle ? `Content style: ${campaign.contentStyle}` : "",
    post.title ? `Campaign post title: ${post.title}` : "",
    post.hook ? `Hook: ${post.hook}` : "",
    post.caption ? `Caption idea: ${post.caption}` : "",
    meta.visualPrompt ? `Visual direction: ${meta.visualPrompt}` : "",
    "Design rules: clean layout, readable typography, no invented discounts or fake promotions, consistent brand colours if provided, single clear CTA, professional marketing-ad quality.",
  ];

  return lines.filter(Boolean).join("\n");
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
      message: `Insufficient credits. You have ${preCheck.balance} credits. ${feature} requires ${cost} credits.`,
    });
  }
}

// ─── Master Campaign Post image generation ───
export async function generateMasterImage({
  userId,
  contentPostId,
  brandColors,
}: {
  userId: number;
  contentPostId: number;
  brandColors?: string[];
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

  const aspectRatio = mapPlatformToAspectRatio(post.platform || "Instagram");
  const prompt = buildImagePrompt({ business, campaign, post, brandColors });

  console.log(`[CreativeService] Generating premium image | userId=${userId} | contentPostId=${contentPostId} | provider=${provider.name}`);

  const result = await provider.generate({
    userId,
    campaignId: post.campaignId ?? undefined,
    businessId: business.id,
    contentPostId: post.id,
    prompt,
    aspectRatio,
    style: campaign.contentStyle || business.visualStyle,
    negativePrompt: campaign.excludedOffers || undefined,
  });

  if (result.status === "failed" || (!result.imageUrl && !result.imageBase64)) {
    const errorMessage = result.errorMessage || "Image generation failed";
    console.error(`[CreativeService] Image generation failed | userId=${userId} | contentPostId=${contentPostId} | error="${errorMessage}"`);

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

    // Log failed provider call for debugging; no credits deducted
    try {
      await recordAiUsage({
        userId,
        campaignId: post.campaignId ?? undefined,
        agentType: "image_generation",
        model: env.openaiImageModel || "gpt-image-1",
        promptTokens: 500,
        completionTokens: 0,
        actualCostUsdMicro: 0,
        estimatedCostUsdMicro: 0,
        creditsDeducted: 0,
        metadata: {
          provider: provider.name,
          providerJobId: result.providerJobId,
          contentPostId: post.id,
          aspectRatio,
          error: errorMessage,
          rawResponse: result.rawResponse,
        },
      });
    } catch (logErr: any) {
      console.error(`[CreativeService] Failed to log image error usage | error="${logErr.message}"`);
    }

    return { ...result, errorMessage };
  }

  // Store locally from base64 or URL
  let stored;
  try {
    if (result.imageBase64) {
      stored = await storeBase64Image(result.imageBase64, {
        campaignId: post.campaignId ?? undefined,
        prefix: "master-post",
      });
    } else if (result.imageUrl) {
      stored = await downloadAndStoreImage(result.imageUrl, {
        campaignId: post.campaignId ?? undefined,
        prefix: "master-post",
      });
    } else {
      throw new Error("No image URL or base64 data received");
    }
  } catch (storageErr: any) {
    console.error(`[CreativeService] Failed to store image | userId=${userId} | error="${storageErr.message}"`);
    return { ...result, status: "failed", errorMessage: `Generated image could not be stored: ${storageErr.message}` };
  }

  // Deduct credits only on success
  const deduction = await deductCredits({
    userId,
    amount: cost,
    type: "image_generation",
    description: "Premium Master Campaign Post image generation",
    metadata: {
      provider: provider.name,
      providerJobId: result.providerJobId,
      contentPostId: post.id,
      campaignId: post.campaignId,
      cost,
    },
  });

  // Record AI usage / provider cost
  const openAiSize = mapAspectRatioToOpenAiSize(aspectRatio);
  const actualCostUsd = openAiImageActualCostUsd(openAiSize);
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
      providerJobId: result.providerJobId,
      contentPostId: post.id,
      aspectRatio,
      outputUrl: stored.publicUrl,
    },
  });

  // Persist audit row
  await db.insert(generatedImages).values({
    userId,
    campaignId: post.campaignId,
    businessId: business.id,
    contentPostId: post.id,
    provider: provider.name,
    providerJobId: result.providerJobId,
    prompt,
    url: stored.publicUrl,
    aspectRatio,
    style: campaign.contentStyle || business.visualStyle,
    status: "completed",
    creditsCharged: cost,
    providerCostUsd: usdToMicroCents(actualCostUsd),
    metadata: {
      originalUrl: result.imageUrl,
      localPath: stored.localPath,
      balanceAfter: deduction.newBalance,
    },
  });

  // Update master post metadata (currentMeta already declared above)
  await db
    .update(contentPosts)
    .set({
      metadata: {
        ...currentMeta,
        imageUrl: stored.publicUrl,
        imageProvider: provider.name,
        imageJobId: result.providerJobId,
        imageStatus: "ready",
        imageGeneratedAt: new Date().toISOString(),
        imageError: null,
        imageCreditsCharged: cost,
      },
    })
    .where(eq(contentPosts.id, post.id));

  // Generate included Caption Pack (non-blocking; failure is logged but image still returned)
  generateCaptionPack({ userId, contentPostId: post.id }).catch((err) => {
    console.error(`[CreativeService] Caption pack async error | userId=${userId} | contentPostId=${post.id} | error="${err.message}"`);
  });

  console.log(`[CreativeService] Premium image ready | userId=${userId} | contentPostId=${contentPostId} | url=${stored.publicUrl} | credits=${cost}`);

  return {
    ...result,
    imageUrl: stored.publicUrl,
    creditsCharged: cost,
    status: "completed",
  };
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
  const prompt = `You are a senior conversion copywriter for a local marketing agency. Write a commercially specific, ready-to-post "Caption Pack" for the campaign below. The copy must sound like it was written for THIS exact business, not a generic template.

BUSINESS:
- Name: ${business.name || "N/A"}
- Industry: ${business.industry || "N/A"}
- Location: ${business.location || "N/A"}
- Website: ${business.website || "N/A"}
- Brand tone: ${business.brandTone || business.tone || "professional"}
- Brand colours: ${brandColors.join(", ") || "not specified"}
- Visual style: ${business.visualStyle || "not specified"}
- Brand voice notes: ${business.brandVoiceNotes || "not specified"}
- Words to avoid: ${business.avoidWords || "None specified"}

CAMPAIGN BRIEF:
- Primary outcome: ${campaign.primaryOutcome || "N/A"}
- Target buyer: ${campaign.targetBuyer || campaign.targetAudience || "N/A"}
- Main pain point: ${campaign.mainPainPoint || "N/A"}
- Product/service: ${campaign.productOrService || business.productOrService || "N/A"}
- Offer: ${campaign.offerDetails || "None — do not invent offers or discounts"}
- Preferred CTA: ${campaign.preferredCta || post.cta || "N/A"}
- Exclusions (NEVER use): ${campaign.excludedOffers || business.avoidWords || "None specified"}
- Reference style: ${campaign.referenceStyle || "N/A"}
- Content style: ${campaign.contentStyle || "N/A"}

MASTER POST:
- Title: ${post.title || "N/A"}
- Hook: ${post.hook || "N/A"}
- Caption: ${post.caption || "N/A"}
- CTA: ${post.cta || "N/A"}

COPY RULES:
1. NEVER use generic motivational phrases like "Unleash creativity this winter", "Winter vibes are here", "Join the revolution", "Unlock your potential", "Discover the best" or "Transform your future".
2. Lead with a concrete business outcome: what the buyer gets, how they save time, what they avoid, or what the offer gives them.
3. Mention specific products/services from the brief (e.g. printing, branding, craft supplies, courier support) where relevant.
4. If an offer is provided, state it exactly as given (e.g. "10% off orders above R1000"). If no offer is provided, do NOT invent discounts, free trials, limited spots, free e-books, loyalty programmes or fake promotions.
5. CTA must be clear and action-based: "Order on WhatsApp", "Request a quote", "Shop online", "Book a demo", "Speak to us" or similar. Match it to the preferred CTA if one is supplied.
6. Highlight practical benefits like ordering without visiting the store, saving time, delivery/courier support, or local availability where they apply.
7. Each caption must match the platform's tone and format and be usable straight away.
8. Hashtags should be a focused mix of core, local and niche tags (8–12 total). Include location-based tags if a location is provided.
9. CTA variations must be distinct and platform-appropriate.
10. Outreach DM should be short, warm and direct — one sentence of context plus a clear ask.

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

  try {
    console.log(`[CreativeService] Generating caption pack | userId=${userId} | contentPostId=${contentPostId}`);
    const { text } = await generateText({
      model: openai("gpt-4o-mini"),
      prompt,
      temperature: 0.7,
      maxOutputTokens: 2500,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const pack: CaptionPack = jsonMatch
      ? JSON.parse(jsonMatch[0])
      : JSON.parse(text);

    // Validate shape with safe defaults
    const safePack: CaptionPack = {
      linkedinCaption: pack.linkedinCaption || post.caption || "",
      facebookCaption: pack.facebookCaption || post.caption || "",
      instagramCaption: pack.instagramCaption || post.caption || "",
      whatsappCaption: pack.whatsappCaption || post.cta || "",
      emailSubject: pack.emailSubject || post.title || "",
      emailPreheader: pack.emailPreheader || post.hook || "",
      emailBody: pack.emailBody || post.caption || "",
      hashtags: Array.isArray(pack.hashtags) ? pack.hashtags : [],
      ctaVariations: Array.isArray(pack.ctaVariations) ? pack.ctaVariations : [],
      outreachDm: pack.outreachDm || "",
    };

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
        ...safePack,
        contentPostId: post.id,
        generatedAt: new Date().toISOString(),
      },
    });

    console.log(`[CreativeService] Caption pack stored | userId=${userId} | contentPostId=${contentPostId}`);
    return safePack;
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
