import { z } from "zod";
import { runAgent } from "./runner";
import { getDb } from "../../queries/connection";
import { campaigns, contentPosts, campaignAssets } from "@db/schema";
import { eq, and } from "drizzle-orm";

// ─── Premium Content Schemas ───

const SceneSchema = z.object({
  sceneNumber: z.number(),
  durationSeconds: z.number(),
  visualDescription: z.string(),
  onScreenText: z.string().optional(),
  voiceoverScript: z.string().optional(),
  audioDirection: z.string().optional(),
  productShotInstruction: z.string().optional(),
});

const VideoConceptSchema = z.object({
  title: z.string(),
  platform: z.string(),
  duration: z.enum(["15s", "30s", "45s", "60s"]),
  hook: z.string(),
  openingHook3Sec: z.string(),
  scenes: z.array(SceneSchema),
  backgroundMusicMood: z.string(),
  cta: z.string(),
  visualStyle: z.string(),
  targetPersona: z.string(),
  funnelStage: z.enum(["awareness", "consideration", "conversion", "retention"]),
});

const CarouselSlideSchema = z.object({
  slideNumber: z.number(),
  headline: z.string(),
  visualDirection: z.string(),
  bodyText: z.string(),
  cta: z.string().optional(),
});

const CarouselAdSchema = z.object({
  title: z.string(),
  platform: z.string(),
  hook: z.string(),
  slides: z.array(CarouselSlideSchema),
  overallCta: z.string(),
  visualStyle: z.string(),
  targetPersona: z.string(),
  funnelStage: z.enum(["awareness", "consideration", "conversion", "retention"]),
  benefitSequence: z.string(),
});

const SocialPostSchema = z.object({
  platform: z.string(),
  type: z.enum(["social_post", "video_concept", "reel_script", "carousel_ad", "whatsapp_promo", "lead_gen_ad", "launch_pack"]),
  title: z.string(),
  hook: z.string(),
  caption: z.string(),
  cta: z.string(),
  hashtags: z.array(z.string()),
  visualPrompt: z.string(),
  bestTimeToPost: z.string(),
  salesAngle: z.string(),
  targetPersona: z.string(),
  funnelStage: z.enum(["awareness", "consideration", "conversion", "retention"]),
  painPoint: z.string().optional(),
  transformation: z.string().optional(),
  urgency: z.string().optional(),
});

const AdCopyVariationSchema = z.object({
  variantName: z.string(),
  angle: z.string(),
  headline: z.string(),
  primaryText: z.string(),
  cta: z.string(),
  platform: z.string(),
  funnelStage: z.enum(["awareness", "consideration", "conversion", "retention"]),
});

const WhatsAppPromoSchema = z.object({
  title: z.string(),
  message: z.string(),
  followUp: z.string().optional(),
  cta: z.string(),
  tone: z.string(),
});

const EmailCampaignSchema = z.object({
  subjectLine: z.string(),
  preheader: z.string(),
  body: z.string(),
  cta: z.string(),
  tone: z.string(),
  segment: z.string(),
});

const LaunchSequenceSchema = z.object({
  title: z.string(),
  sequenceSteps: z.array(z.object({
    stepNumber: z.number(),
    channel: z.string(),
    timing: z.string(),
    message: z.string(),
    cta: z.string(),
  })),
});

const PremiumCampaignPackSchema = z.object({
  videoConcepts: z.array(VideoConceptSchema).length(3),
  carouselAds: z.array(CarouselAdSchema).length(3),
  socialPosts: z.array(SocialPostSchema).length(5),
  adCopyVariations: z.array(AdCopyVariationSchema).length(3),
  whatsAppPromos: z.array(WhatsAppPromoSchema).length(2),
  emailCampaign: EmailCampaignSchema,
  launchSequence: LaunchSequenceSchema,
  packSummary: z.string(),
});

const CreativeAssetsSchema = z.object({
  assets: z.array(
    z.object({
      assetType: z.enum([
        "image",
        "video_script",
        "carousel",
        "ad_copy",
        "caption",
        "hashtag_set",
        "cta_variant",
        "email_copy",
        "whatsapp_copy",
        "video_concept",
        "reel_script",
        "carousel_ad",
        "whatsapp_promo",
        "lead_gen_ad",
        "launch_pack",
      ]),
      title: z.string(),
      content: z.string(),
      prompt: z.string().nullable(),
      platform: z.string().nullable(),
      variations: z.array(z.string()).nullable(),
    })
  ),
});

export type PremiumCampaignPackOutput = z.infer<typeof PremiumCampaignPackSchema>;
export type CreativeAssetsOutput = z.infer<typeof CreativeAssetsSchema>;

export async function runCreativeAgent({
  userId,
  campaignId,
}: {
  userId: number;
  campaignId: number;
}) {
  const db = getDb();

  // Get campaign and business info
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  const strategyContext = campaign.workflowContext as any;
  const personas = campaign.personas as any[];
  const coreMessage = campaign.coreMessage;
  const ctaStrategy = campaign.ctaStrategy;
  const offers = campaign.offers as any[];
  const funnelStages = campaign.funnelStages as any[];

  // Step 1: Generate Premium Campaign Pack
  const packPrompt = `You are an elite creative director and performance marketer who builds premium, sales-focused campaign assets for small businesses. You do not create generic filler content. Every asset must be designed to drive revenue, capture attention in 3 seconds, and convert viewers into buyers.

CAMPAIGN DETAILS:
- Name: ${campaign.name}
- Goal: ${campaign.goal}
- Core Message: ${coreMessage || "Not specified"}
- CTA Strategy: ${ctaStrategy || "Not specified"}
- Target Audience: ${campaign.targetAudience || "Not specified"}
- Platforms: ${campaign.platforms || "Instagram, Facebook, TikTok, LinkedIn"}
- Personas: ${personas ? JSON.stringify(personas.map((p: any) => ({ name: p.name, painPoints: p.painPoints, goals: p.goals }))) : "General audience"}
${offers ? `- Offers: ${JSON.stringify(offers)}` : ""}
${funnelStages ? `- Funnel Stages: ${JSON.stringify(funnelStages.map((f: any) => f.stage))}` : ""}
${strategyContext?.campaignTheme ? `- Campaign Theme: ${strategyContext.campaignTheme}` : ""}
${strategyContext?.platformStrategy ? `- Platform Strategy: ${JSON.stringify(strategyContext.platformStrategy)}` : ""}

GENERATE A PREMIUM CAMPAIGN PACK WITH THE FOLLOWING:

A. 3 SHORT-FORM VIDEO/REEL CONCEPTS (Instagram Reels, TikTok, Facebook Reels, YouTube Shorts)
For each video concept provide:
- A scroll-stopping title
- Platform recommendation
- Duration (15s, 30s, or 45s)
- Hook (the first line that stops the scroll)
- Opening hook for the first 3 seconds (must be visceral, emotional, or provocative)
- Scene-by-scene breakdown (3-6 scenes) with: visual description, on-screen text, voiceover script, audio direction, product shot instruction
- Background music/mood suggestion
- Strong CTA with urgency
- Visual style description
- Target persona
- Funnel stage (awareness, consideration, conversion, retention)

B. 3 CAROUSEL AD CONCEPTS
For each carousel provide:
- Title
- Platform
- Hook
- 4-6 slides with: headline, visual direction, body text, optional CTA
- Overall CTA
- Visual style
- Target persona
- Funnel stage
- Benefit sequence explanation

C. 5 HIGH-CONVERTING SOCIAL POSTS
For each post provide:
- Platform
- Type (social_post)
- Title
- Hook (bold, emotional, or controversial — max 12 words)
- Caption (2-4 short paragraphs, line breaks, direct to reader, zero fluff)
- CTA (exact action + urgency: "Link in bio — only 20 spots", "DM 'YES' now")
- Hashtags (5-10 targeted, niche + trending mix)
- Visual generation prompt (detailed scene for AI image tools)
- Best time to post
- Sales angle (fear of missing out, social proof, direct benefit, transformation)
- Target persona
- Funnel stage
- Pain point addressed
- Transformation promised
- Urgency driver

D. 3 AD COPY VARIATIONS
- Awareness ad (problem agitation, curiosity)
- Retargeting ad (social proof, objection handling)
- Direct sales ad (offer, urgency, risk reversal)
Each with: variant name, angle, headline, primary text, CTA, platform, funnel stage

E. 2 WHATSAPP PROMO MESSAGES
- Short, persuasive promo message
- Follow-up message for non-responders
- CTA
- Casual but persuasive tone

F. 1 EMAIL CAMPAIGN
- Subject line (under 50 chars, curiosity-driven or benefit-led)
- Preheader text
- Body copy (under 200 words, single CTA focus)
- CTA
- Tone
- Target segment

G. 1 LAUNCH/ OFFER SEQUENCE
- Multi-step launch sequence (3-5 steps)
- Each step: channel, timing, message, CTA
- Progresses from teaser → announcement → urgency → last chance

CRITICAL RULES:
- EVERY asset must use strong hooks, pain points, transformation messaging, urgency, benefits over features, and clear CTAs.
- Use modern social-media style. No corporate blandness.
- Be platform-native: Instagram Reels feel different from LinkedIn posts.
- Speak directly to the reader. Use "you" and "your".
- Never use generic phrases like "unlock your potential" or "take your business to the next level".
- Every video concept must feel like it could go viral — specific, visual, emotional.
- Every carousel must tell a story that leads to a purchase decision.
- Respond with valid structured data only.`;

  const packResult = await runAgent({
    userId,
    campaignId,
    agentType: "creative",
    prompt: packPrompt,
    schema: PremiumCampaignPackSchema,
    system:
      "You are an elite creative director and performance marketer. You create premium, sales-focused campaign assets that drive revenue. You specialise in Instagram Reels, TikTok, Facebook ads, carousel ads, direct-response copywriting, and launch sequences. Every asset must be emotionally engaging, visually specific, platform-native, and conversion-focused. Always respond with valid structured data.",
  });

  const pack = packResult.output;

  // Save pack summary to campaign
  await db
    .update(campaigns)
    .set({
      contentCalendar: {
        packSummary: pack.packSummary,
        generatedAt: new Date().toISOString(),
        creativeRunId: packResult.runId,
      } as any,
      workflowContext: {
        ...(strategyContext || {}),
        creativeGeneratedAt: new Date().toISOString(),
        creativeRunId: packResult.runId,
        premiumPack: true,
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  // Prevent duplicate content posts on retry
  const existingDrafts = await db
    .select()
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.campaignId, campaignId),
        eq(contentPosts.aiGenerated, true),
        eq(contentPosts.status, "draft")
      )
    );

  for (const draft of existingDrafts) {
    await db.delete(contentPosts).where(eq(contentPosts.id, draft.id));
  }

  let savedPosts = 0;
  let failedInserts = 0;

  // Helper to insert content post with metadata
  async function insertPost(
    title: string,
    type: string,
    platform: string,
    hook: string,
    caption: string,
    cta: string,
    hashtags: string[],
    visualPrompt: string,
    metadata: any
  ) {
    try {
      await db.insert(contentPosts).values({
        userId,
        campaignId,
        title,
        type: type as any,
        platform,
        hook,
        caption,
        cta,
        hashtags: Array.isArray(hashtags) ? hashtags.join(" ") : hashtags,
        visualPrompt,
        status: "draft",
        aiGenerated: true,
        metadata,
      });
      savedPosts++;
    } catch (err: any) {
      failedInserts++;
      console.error(`[CreativeAgent] Failed to save content post:`, err.message);
    }
  }

  // Save video concepts as content posts with rich metadata
  for (const video of pack.videoConcepts) {
    const caption = `${video.hook}\n\n${video.openingHook3Sec}\n\n${video.scenes.map((s, i) => `Scene ${i + 1}: ${s.visualDescription}`).join("\n")}\n\n${video.cta}`;
    await insertPost(
      video.title,
      "video_concept",
      video.platform,
      video.hook,
      caption,
      video.cta,
      [],
      video.visualStyle,
      {
        duration: video.duration,
        openingHook3Sec: video.openingHook3Sec,
        scenes: video.scenes,
        backgroundMusicMood: video.backgroundMusicMood,
        targetPersona: video.targetPersona,
        funnelStage: video.funnelStage,
        assetKind: "video_blueprint",
        videoStatus: "draft_brief",
        message: "NatForgeAI has prepared a video-ready script and creative direction. Full video rendering will be available once video generation is enabled.",
      }
    );
  }

  // Save carousel ads
  for (const carousel of pack.carouselAds) {
    const caption = `${carousel.hook}\n\n${carousel.slides.map((s, i) => `Slide ${i + 1}: ${s.headline} — ${s.bodyText}`).join("\n")}\n\n${carousel.overallCta}`;
    await insertPost(
      carousel.title,
      "carousel_ad",
      carousel.platform,
      carousel.hook,
      caption,
      carousel.overallCta,
      [],
      carousel.visualStyle,
      {
        slides: carousel.slides,
        benefitSequence: carousel.benefitSequence,
        targetPersona: carousel.targetPersona,
        funnelStage: carousel.funnelStage,
        assetKind: "carousel_blueprint",
      }
    );
  }

  // Save social posts
  for (const post of pack.socialPosts) {
    await insertPost(
      post.title,
      post.type,
      post.platform,
      post.hook,
      post.caption,
      post.cta,
      post.hashtags,
      post.visualPrompt,
      {
        salesAngle: post.salesAngle,
        targetPersona: post.targetPersona,
        funnelStage: post.funnelStage,
        painPoint: post.painPoint,
        transformation: post.transformation,
        urgency: post.urgency,
        bestTimeToPost: post.bestTimeToPost,
        assetKind: "social_post_premium",
      }
    );
  }

  // Save ad copy variations
  for (const ad of pack.adCopyVariations) {
    const caption = `${ad.headline}\n\n${ad.primaryText}\n\n${ad.cta}`;
    await insertPost(
      ad.variantName,
      "lead_gen_ad",
      ad.platform,
      ad.headline,
      caption,
      ad.cta,
      [],
      "",
      {
        angle: ad.angle,
        funnelStage: ad.funnelStage,
        assetKind: "ad_copy_variation",
        variantType: ad.variantName,
      }
    );
  }

  // Save WhatsApp promos
  for (const wa of pack.whatsAppPromos) {
    await insertPost(
      wa.title,
      "whatsapp_promo",
      "whatsapp",
      wa.message.slice(0, 60),
      wa.message,
      wa.cta,
      [],
      "",
      {
        followUp: wa.followUp,
        tone: wa.tone,
        assetKind: "whatsapp_promo",
      }
    );
  }

  // Save email campaign
  await insertPost(
    pack.emailCampaign.subjectLine,
    "email",
    "email",
    pack.emailCampaign.subjectLine,
    `${pack.emailCampaign.preheader}\n\n${pack.emailCampaign.body}`,
    pack.emailCampaign.cta,
    [],
    "",
    {
      preheader: pack.emailCampaign.preheader,
      tone: pack.emailCampaign.tone,
      segment: pack.emailCampaign.segment,
      assetKind: "email_campaign",
    }
  );

  // Save launch sequence
  await insertPost(
    pack.launchSequence.title,
    "launch_pack",
    "multi",
    pack.launchSequence.sequenceSteps[0]?.message?.slice(0, 80) || pack.launchSequence.title,
    pack.launchSequence.sequenceSteps.map((s) => `Step ${s.stepNumber} (${s.channel}, ${s.timing}): ${s.message}`).join("\n\n"),
    pack.launchSequence.sequenceSteps[pack.launchSequence.sequenceSteps.length - 1]?.cta || "",
    [],
    "",
    {
      sequenceSteps: pack.launchSequence.sequenceSteps,
      assetKind: "launch_sequence",
    }
  );

  console.log(`[CreativeAgent] Premium pack saved: campaignId=${campaignId} savedPosts=${savedPosts} failedInserts=${failedInserts}`);

  if (savedPosts === 0) {
    console.error(`[CreativeAgent] CRITICAL: No posts saved for campaign ${campaignId}`);
    throw new Error("Content generation completed but no posts were saved.");
  }

  // Step 2: Generate additional creative assets (best-effort)
  const assetsPrompt = `You are a conversion-focused creative director. Generate supplementary high-performing sales assets for this campaign.

CAMPAIGN:
- Name: ${campaign.name}
- Goal: ${campaign.goal}
- Core Message: ${coreMessage || "Not specified"}
- CTA Strategy: ${ctaStrategy || "Not specified"}
- Target Audience: ${campaign.targetAudience || "Not specified"}
- Platforms: ${campaign.platforms || "Instagram, Facebook, TikTok"}

Generate:
1. 5 image generation prompts for conversion-focused hero visuals (exact scene, colours, text overlay, emotional trigger)
2. 3 CTA variations for different funnel stages (awareness, consideration, decision)
3. A hashtag strategy document (10 core + 10 trending + 10 niche per platform)
4. 2 testimonial frameworks (before/after structure)
5. A competitor response angle (how to counter common objections)

Respond with structured data. Always include prompt, platform, and variations keys. Use null when they do not apply.`;

  let assetsResult: { runId: number; output: z.infer<typeof CreativeAssetsSchema> } | undefined;
  let assetsError: string | undefined;
  try {
    assetsResult = await runAgent({
      userId,
      campaignId,
      agentType: "creative",
      prompt: assetsPrompt,
      schema: CreativeAssetsSchema,
      system:
        "You are an expert copywriter and creative director. You create high-converting marketing assets across all channels. Always respond with valid structured data. Always include prompt, platform, and variations keys. Use null when a field does not apply.",
    });
  } catch (err: any) {
    console.error("[CreativeAgent] Assets generation failed:", err.message);
    assetsError = err.message;
  }

  // Update campaign with final context
  await db
    .update(campaigns)
    .set({
      workflowContext: {
        ...(strategyContext || {}),
        creativeGeneratedAt: new Date().toISOString(),
        creativeRunId: packResult.runId,
        assetsRunId: assetsResult?.runId ?? null,
        assetsGenerationError: assetsError ?? null,
        savedPosts,
        failedInserts,
        premiumPack: true,
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  // Save campaign_assets records (best-effort)
  let savedAssets = 0;
  if (assetsResult) {
    for (const asset of assetsResult.output.assets) {
      try {
        await db.insert(campaignAssets).values({
          userId,
          campaignId,
          assetType: asset.assetType as any,
          title: asset.title,
          prompt: asset.prompt ?? null,
          status: "ready",
          metadata: {
            content: asset.content,
            platform: asset.platform,
            variations: asset.variations,
          } as any,
        });
        savedAssets++;
      } catch (err: any) {
        console.error(`[CreativeAgent] Failed to save campaign asset:`, err.message);
      }
    }
  }
  console.log(`[CreativeAgent] Saved ${savedAssets} supplementary assets for campaign ${campaignId}`);

  return {
    packRunId: packResult.runId,
    assetsRunId: assetsResult?.runId ?? null,
    pack,
    assets: assetsResult?.output ?? null,
    savedPosts,
    savedAssets,
  };
}
