import { TRPCError } from "@trpc/server";
import { eq, and } from "drizzle-orm";
import fs from "fs";
import { env } from "../env";
import { getDb } from "../../queries/connection";
import { contentPosts, campaigns, businesses, generatedImages, videoRenderJobs, campaignAssets } from "@db/schema";
import { checkCredits, deductCredits, recordAiUsage } from "../billing/credit-engine";
import { enforceCostControl } from "../billing/cost-control";
import { getImageProvider, getPremiumVideoProvider, getBasicVideoProvider } from "./registry";
import { storeImageBuffer, downloadAndStoreVideo } from "./storage";
import { composeBrandedLeafletImage, generateFallbackLeafletImage } from "./composition";
import { validateLeafletPrompt, validateLeafletQuality, sanitizePromptForValidator } from "./quality";
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
}: {
  userId: number;
  contentPostId: number;
  brandColors?: string[];
  creativeType?: CreativeType;
  strongerBrandFit?: boolean;
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

    if (!business) {
      business = { name: campaign?.name || post.title || "Your Business" };
    }
    if (!campaign) {
      campaign = {};
    }

    const aspectRatio = getImageAspectRatio(creativeType, post.platform || "Instagram");

    // ─── Prompt helpers ───
    const buildPrompt = (stronger: boolean) =>
      buildPremiumImagePrompt({ business, campaign, post, brandColors, creativeType, strongerBrandFit: stronger });

    const preparePrompt = (rawPrompt: string) => {
      const firstCheck = validateLeafletPrompt(rawPrompt, business);
      if (firstCheck.passed) return { prompt: rawPrompt, valid: true, issues: [] as string[] };
      const sanitized = sanitizePromptForValidator(rawPrompt);
      const secondCheck = validateLeafletPrompt(sanitized, business);
      if (secondCheck.passed) {
        console.log(`[CreativeService] Prompt sanitized before generation | userId=${userId} | contentPostId=${contentPostId} | originalIssues=${JSON.stringify(firstCheck.issues)}`);
        return { prompt: sanitized, valid: true, issues: [] as string[] };
      }
      return { prompt: sanitized, valid: false, issues: secondCheck.issues };
    };

    // ─── Single generation attempt: generate + decode + quality check ───
    async function attemptGeneration(prompt: string): Promise<
      | { status: "success"; buffer: Buffer; result: ImageResult }
      | { status: "failed"; errorMessage: string; issues?: string[] }
    > {
      console.log(`[CreativeService] Requesting OpenAI image | userId=${userId} | contentPostId=${contentPostId} | model=${env.openaiImageModel || "gpt-image-1"} | aspectRatio=${aspectRatio}`);

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
        console.error(`[CreativeService] Image generation failed | userId=${userId} | contentPostId=${contentPostId} | error="${errorMessage}"`);
        return { status: "failed", errorMessage };
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
        console.error(`[CreativeService] Failed to decode generated image | userId=${userId} | error="${message}"`);
        return { status: "failed", errorMessage: `Generated image could not be decoded: ${message}` };
      }

      const quality = await validateLeafletQuality(buffer, business, campaign, prompt);
      if (!quality.passed) {
        console.warn(`[CreativeService] Leaflet quality check failed | userId=${userId} | contentPostId=${contentPostId} | issues=${JSON.stringify(quality.issues)}`);
        return { status: "failed", errorMessage: `Leaflet did not meet quality standards: ${quality.issues.join("; ")}`, issues: quality.issues };
      }

      return { status: "success", buffer, result: generationResult };
    }

    // ─── First attempt ───
    const promptPrep = preparePrompt(buildPrompt(strongerBrandFit));
    let finalPrompt = promptPrep.prompt;
    let finalResult: ImageResult | null = null;
    let rawBuffer: Buffer | null = null;

    if (promptPrep.valid) {
      const attempt = await attemptGeneration(finalPrompt);
      if (attempt.status === "success") {
        rawBuffer = attempt.buffer;
        finalResult = attempt.result;
      }
    } else {
      console.warn(`[CreativeService] Prompt invalid even after sanitisation; skipping first OpenAI call | userId=${userId} | contentPostId=${contentPostId} | issues=${JSON.stringify(promptPrep.issues)}`);
    }

    // ─── Retry with rebuilt, stronger prompt ───
    if (!rawBuffer) {
      const retryPrep = preparePrompt(buildPrompt(true));
      if (retryPrep.valid) {
        console.log(`[CreativeService] Retrying with rebuilt prompt | userId=${userId} | contentPostId=${contentPostId}`);
        finalPrompt = retryPrep.prompt;
        const retryAttempt = await attemptGeneration(finalPrompt);
        if (retryAttempt.status === "success") {
          rawBuffer = retryAttempt.buffer;
          finalResult = retryAttempt.result;
        } else {
          console.warn(`[CreativeService] Retry failed; rendering deterministic fallback leaflet | userId=${userId} | contentPostId=${contentPostId} | reason=${retryAttempt.errorMessage}`);
        }
      } else {
        console.warn(`[CreativeService] Retry prompt invalid; rendering deterministic fallback leaflet | userId=${userId} | contentPostId=${contentPostId} | issues=${JSON.stringify(retryPrep.issues)}`);
      }
    }

    // ─── Deterministic fallback if both attempts failed ───
    let usingFallback = false;
    if (!rawBuffer) {
      usingFallback = true;
      rawBuffer = await generateFallbackLeafletImage({
        business,
        campaign,
        post,
        creativeType,
        offer: campaign.offerDetails,
        cta: campaign.preferredCta || post.cta,
        headline: campaign.offerDetails && !campaign.offerDetails.toLowerCase().includes("none")
          ? `${business.name} — ${campaign.offerDetails}`
          : campaign.primaryOutcome || post?.title || business.name,
        subheadline: campaign.mainPainPoint || campaign.coreMessage || post?.hook || "",
      });
      console.log(`[CreativeService] Fallback leaflet rendered | userId=${userId} | contentPostId=${contentPostId} | size=${rawBuffer.length}`);
    }

    // ─── Brand overlay (only for AI images; fallback is already branded) ───
    let composedBuffer = rawBuffer;
    if (!usingFallback) {
      try {
        composedBuffer = await composeBrandedLeafletImage(rawBuffer, {
          business,
          campaign,
          post,
          creativeType,
          offer: campaign.offerDetails,
          cta: campaign.preferredCta || post.cta,
          headline: campaign.offerDetails && !campaign.offerDetails.toLowerCase().includes("none")
            ? `${business.name} — ${campaign.offerDetails}`
            : campaign.primaryOutcome || post?.title || business.name,
          subheadline: campaign.mainPainPoint || campaign.coreMessage || post?.hook || "",
        });
        console.log(`[CreativeService] Sharp composition completed | userId=${userId} | contentPostId=${contentPostId} | size=${composedBuffer.length}`);
      } catch (composeErr) {
        const message = composeErr instanceof Error ? composeErr.message : String(composeErr);
        console.warn(`[CreativeService] Brand overlay failed, using raw image | userId=${userId} | error="${message}"`);
      }
    }

    // ─── Store locally ───
    let stored;
    try {
      stored = await storeImageBuffer(composedBuffer, {
        campaignId: post.campaignId ?? undefined,
        prefix: usingFallback ? "master-post-fallback" : "master-post",
        extension: finalResult?.extension || "png",
      });
      console.log(`[CreativeService] Image stored | userId=${userId} | contentPostId=${contentPostId} | publicUrl=${stored.publicUrl} | localPath=${stored.localPath} | size=${composedBuffer.length}`);
    } catch (storageErr) {
      const message = storageErr instanceof Error ? storageErr.message : String(storageErr);
      console.error(`[CreativeService] Failed to store image | userId=${userId} | error="${message}"`);
      return { status: "failed", jobId: finalResult?.providerJobId || "fallback", errorMessage: `Generated image could not be stored: ${message}` };
    }

    // ─── Validate stored file and URL ───
    try {
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
      console.log(`[CreativeService] Image URL validation passed | userId=${userId} | contentPostId=${contentPostId} | publicUrl=${stored.publicUrl}`);
    } catch (validationErr) {
      const message = validationErr instanceof Error ? validationErr.message : String(validationErr);
      console.error(`[CreativeService] Image URL validation failed | userId=${userId} | contentPostId=${contentPostId} | error="${message}"`);
      await db
        .update(contentPosts)
        .set({
          metadata: {
            ...currentMeta,
            imageStatus: "failed",
            imageError: `Generated image could not be validated: ${message}`,
          },
        })
        .where(eq(contentPosts.id, post.id));
      return { status: "failed", jobId: finalResult?.providerJobId || "fallback", errorMessage: `Generated image could not be validated: ${message}` };
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
      },
    });

    // ─── Update master post metadata ───
    await db
      .update(contentPosts)
      .set({
        metadata: {
          ...currentMeta,
          imageUrl: stored.publicUrl,
          imageProvider: provider.name,
          imageJobId: finalResult?.providerJobId || "fallback",
          imageStatus: "ready",
          imageGeneratedAt: new Date().toISOString(),
          imageError: null,
          imageCreditsCharged: cost,
          imageExtension: finalResult?.extension || "png",
          imageQualityIssues: undefined,
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
