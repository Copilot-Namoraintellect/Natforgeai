import { z } from "zod";
import { runAgent } from "./runner";
import { getDb } from "../../queries/connection";
import { campaigns, contentPosts, campaignAssets, businesses } from "@db/schema";
import { eq, and } from "drizzle-orm";

// ─── Schema Normalisation Helpers ───
// OpenAI structured output requires EVERY property to be in the `required` array.
// .optional() breaks the JSON schema. Use .nullable() instead.
// These helpers normalise AI output so missing/undefined nested fields become safe defaults.

function normaliseScene(scene: any): any {
  if (!scene || typeof scene !== "object") {
    return {
      sceneNumber: 1,
      durationSeconds: 5,
      visualDescription: "",
      onScreenText: null,
      voiceoverScript: null,
      audioDirection: null,
      productShotInstruction: null,
    };
  }
  return {
    sceneNumber: typeof scene.sceneNumber === "number" ? scene.sceneNumber : 1,
    durationSeconds: typeof scene.durationSeconds === "number" ? scene.durationSeconds : 5,
    visualDescription: String(scene.visualDescription ?? ""),
    onScreenText: scene.onScreenText != null ? String(scene.onScreenText) : null,
    voiceoverScript: scene.voiceoverScript != null ? String(scene.voiceoverScript) : null,
    audioDirection: scene.audioDirection != null ? String(scene.audioDirection) : null,
    productShotInstruction: scene.productShotInstruction != null ? String(scene.productShotInstruction) : null,
  };
}

function normaliseVideoConcept(v: any): any {
  if (!v || typeof v !== "object") return null;
  const scenes = Array.isArray(v.scenes) ? v.scenes.map(normaliseScene) : [];
  if (scenes.length === 0) {
    scenes.push(normaliseScene(null));
  }
  return {
    title: String(v.title ?? "Untitled Video Concept"),
    platform: String(v.platform ?? "instagram"),
    duration: ["15s", "30s", "45s", "60s"].includes(v.duration) ? v.duration : "30s",
    hook: String(v.hook ?? ""),
    openingHook3Sec: String(v.openingHook3Sec ?? ""),
    scenes,
    backgroundMusicMood: String(v.backgroundMusicMood ?? ""),
    cta: String(v.cta ?? ""),
    visualStyle: String(v.visualStyle ?? ""),
    targetPersona: String(v.targetPersona ?? ""),
    funnelStage: ["awareness", "consideration", "conversion", "retention"].includes(v.funnelStage)
      ? v.funnelStage
      : "awareness",
  };
}

function normaliseCarouselSlide(s: any): any {
  if (!s || typeof s !== "object") {
    return { slideNumber: 1, headline: "", visualDirection: "", bodyText: "", cta: null };
  }
  return {
    slideNumber: typeof s.slideNumber === "number" ? s.slideNumber : 1,
    headline: String(s.headline ?? ""),
    visualDirection: String(s.visualDirection ?? ""),
    bodyText: String(s.bodyText ?? ""),
    cta: s.cta != null ? String(s.cta) : null,
  };
}

function normaliseCarouselAd(c: any): any {
  if (!c || typeof c !== "object") return null;
  const slides = Array.isArray(c.slides) ? c.slides.map(normaliseCarouselSlide) : [];
  if (slides.length === 0) slides.push(normaliseCarouselSlide(null));
  return {
    title: String(c.title ?? "Untitled Carousel"),
    platform: String(c.platform ?? "instagram"),
    hook: String(c.hook ?? ""),
    slides,
    overallCta: String(c.overallCta ?? ""),
    visualStyle: String(c.visualStyle ?? ""),
    targetPersona: String(c.targetPersona ?? ""),
    funnelStage: ["awareness", "consideration", "conversion", "retention"].includes(c.funnelStage)
      ? c.funnelStage
      : "awareness",
    benefitSequence: String(c.benefitSequence ?? ""),
  };
}

function normaliseSocialPost(p: any): any {
  if (!p || typeof p !== "object") return null;
  return {
    platform: String(p.platform ?? "instagram"),
    type: String(p.type ?? "social_post"),
    title: String(p.title ?? ""),
    hook: String(p.hook ?? ""),
    caption: String(p.caption ?? ""),
    cta: String(p.cta ?? ""),
    hashtags: Array.isArray(p.hashtags) ? p.hashtags.map(String) : [],
    visualPrompt: String(p.visualPrompt ?? ""),
    bestTimeToPost: String(p.bestTimeToPost ?? ""),
    salesAngle: String(p.salesAngle ?? ""),
    targetPersona: String(p.targetPersona ?? ""),
    funnelStage: ["awareness", "consideration", "conversion", "retention"].includes(p.funnelStage)
      ? p.funnelStage
      : "awareness",
    painPoint: p.painPoint != null ? String(p.painPoint) : null,
    transformation: p.transformation != null ? String(p.transformation) : null,
    urgency: p.urgency != null ? String(p.urgency) : null,
  };
}

function normaliseAdCopy(a: any): any {
  if (!a || typeof a !== "object") return null;
  return {
    variantName: String(a.variantName ?? ""),
    angle: String(a.angle ?? ""),
    headline: String(a.headline ?? ""),
    primaryText: String(a.primaryText ?? ""),
    cta: String(a.cta ?? ""),
    platform: String(a.platform ?? ""),
    funnelStage: ["awareness", "consideration", "conversion", "retention"].includes(a.funnelStage)
      ? a.funnelStage
      : "awareness",
  };
}

function normaliseWhatsApp(w: any): any {
  if (!w || typeof w !== "object") return null;
  return {
    title: String(w.title ?? ""),
    message: String(w.message ?? ""),
    followUp: w.followUp != null ? String(w.followUp) : null,
    cta: String(w.cta ?? ""),
    tone: String(w.tone ?? "friendly"),
  };
}

function normaliseEmail(e: any): any {
  if (!e || typeof e !== "object") return null;
  return {
    subjectLine: String(e.subjectLine ?? ""),
    preheader: String(e.preheader ?? ""),
    body: String(e.body ?? ""),
    cta: String(e.cta ?? ""),
    tone: String(e.tone ?? "professional"),
    segment: String(e.segment ?? ""),
  };
}

function normaliseLaunchStep(s: any): any {
  if (!s || typeof s !== "object") {
    return { stepNumber: 1, channel: "", timing: "", message: "", cta: "" };
  }
  return {
    stepNumber: typeof s.stepNumber === "number" ? s.stepNumber : 1,
    channel: String(s.channel ?? ""),
    timing: String(s.timing ?? ""),
    message: String(s.message ?? ""),
    cta: String(s.cta ?? ""),
  };
}

function normaliseLaunchSequence(l: any): any {
  if (!l || typeof l !== "object") return null;
  const steps = Array.isArray(l.sequenceSteps) ? l.sequenceSteps.map(normaliseLaunchStep) : [];
  if (steps.length === 0) steps.push(normaliseLaunchStep(null));
  return { title: String(l.title ?? ""), sequenceSteps: steps };
}

function normalisePlatformAdaptation(p: any): any {
  if (!p || typeof p !== "object") return null;
  return {
    platform: String(p.platform ?? ""),
    adaptedCaption: String(p.adaptedCaption ?? ""),
    adaptedCta: String(p.adaptedCta ?? ""),
    adaptedHashtags: Array.isArray(p.adaptedHashtags) ? p.adaptedHashtags.map(String) : [],
    bestTimeToPost: String(p.bestTimeToPost ?? ""),
    formatNotes: p.formatNotes != null ? String(p.formatNotes) : null,
  };
}

function normalisePlatformHashtag(p: any): any {
  if (!p || typeof p !== "object") return null;
  return {
    platform: String(p.platform ?? ""),
    hashtags: Array.isArray(p.hashtags) ? p.hashtags.map(String) : [],
  };
}

function normaliseHashtagSet(h: any): any {
  if (!h || typeof h !== "object") {
    return { core: [], trending: [], niche: [], platformSpecific: [] };
  }
  const platformSpecific = Array.isArray(h.platformSpecific)
    ? h.platformSpecific.map(normalisePlatformHashtag).filter(Boolean)
    : [];
  return {
    core: Array.isArray(h.core) ? h.core.map(String) : [],
    trending: Array.isArray(h.trending) ? h.trending.map(String) : [],
    niche: Array.isArray(h.niche) ? h.niche.map(String) : [],
    platformSpecific,
  };
}

function normaliseHook(h: any): any {
  if (!h || typeof h !== "object") return { text: "", angle: "" };
  return { text: String(h.text ?? ""), angle: String(h.angle ?? "") };
}

function normaliseCtaVariation(c: any): any {
  if (!c || typeof c !== "object") return { text: "", angle: "" };
  return { text: String(c.text ?? ""), angle: String(c.angle ?? "") };
}

function normalisePremiumPack(raw: any): any {
  if (!raw || typeof raw !== "object") {
    return {
      videoConcepts: [normaliseVideoConcept(null)],
      carouselAds: [normaliseCarouselAd(null)],
      socialPosts: [normaliseSocialPost(null)],
      adCopyVariations: [normaliseAdCopy(null)],
      whatsAppPromos: [normaliseWhatsApp(null)],
      emailCampaign: normaliseEmail(null),
      launchSequence: normaliseLaunchSequence(null),
      hooks: [normaliseHook(null)],
      ctaVariations: [normaliseCtaVariation(null)],
      packSummary: "",
    };
  }

  const videoConcepts = Array.isArray(raw.videoConcepts)
    ? raw.videoConcepts.map(normaliseVideoConcept).filter(Boolean)
    : [];
  const carouselAds = Array.isArray(raw.carouselAds)
    ? raw.carouselAds.map(normaliseCarouselAd).filter(Boolean)
    : [];
  const socialPosts = Array.isArray(raw.socialPosts)
    ? raw.socialPosts.map(normaliseSocialPost).filter(Boolean)
    : [];
  const adCopyVariations = Array.isArray(raw.adCopyVariations)
    ? raw.adCopyVariations.map(normaliseAdCopy).filter(Boolean)
    : [];
  const whatsAppPromos = Array.isArray(raw.whatsAppPromos)
    ? raw.whatsAppPromos.map(normaliseWhatsApp).filter(Boolean)
    : [];
  const platformAdaptations = Array.isArray(raw.platformAdaptations)
    ? raw.platformAdaptations.map(normalisePlatformAdaptation).filter(Boolean)
    : [];
  const hashtagSet = normaliseHashtagSet(raw.hashtagSet);
  const hooks = Array.isArray(raw.hooks)
    ? raw.hooks.map(normaliseHook).filter((h: any) => h.text)
    : [];
  const ctaVariations = Array.isArray(raw.ctaVariations)
    ? raw.ctaVariations.map(normaliseCtaVariation).filter((c: any) => c.text)
    : [];

  return {
    videoConcepts: videoConcepts.length > 0 ? videoConcepts : [normaliseVideoConcept(null)],
    carouselAds: carouselAds.length > 0 ? carouselAds : [normaliseCarouselAd(null)],
    socialPosts: socialPosts.length > 0 ? socialPosts : [normaliseSocialPost(null)],
    adCopyVariations: adCopyVariations.length > 0 ? adCopyVariations : [normaliseAdCopy(null)],
    whatsAppPromos: whatsAppPromos.length > 0 ? whatsAppPromos : [normaliseWhatsApp(null)],
    emailCampaign: normaliseEmail(raw.emailCampaign),
    launchSequence: normaliseLaunchSequence(raw.launchSequence),
    platformAdaptations: platformAdaptations.length > 0 ? platformAdaptations : [],
    hashtagSet,
    hooks: hooks.length > 0 ? hooks : [normaliseHook(null)],
    ctaVariations: ctaVariations.length > 0 ? ctaVariations : [normaliseCtaVariation(null)],
    packSummary: String(raw.packSummary ?? ""),
  };
}

// ─── Premium Content Schemas (strict — no .optional(), only .nullable()) ───

const SceneSchema = z.object({
  sceneNumber: z.number(),
  durationSeconds: z.number(),
  visualDescription: z.string(),
  onScreenText: z.string().nullable(),
  voiceoverScript: z.string().nullable(),
  audioDirection: z.string().nullable(),
  productShotInstruction: z.string().nullable(),
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
  voiceoverScript: z.string().nullable(),
  thumbnailPrompt: z.string().nullable(),
});

const CarouselSlideSchema = z.object({
  slideNumber: z.number(),
  headline: z.string(),
  visualDirection: z.string(),
  bodyText: z.string(),
  cta: z.string().nullable(),
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
  painPoint: z.string().nullable(),
  transformation: z.string().nullable(),
  urgency: z.string().nullable(),
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
  followUp: z.string().nullable(),
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

const PlatformAdaptationSchema = z.object({
  platform: z.string(),
  adaptedCaption: z.string(),
  adaptedCta: z.string(),
  adaptedHashtags: z.array(z.string()),
  bestTimeToPost: z.string(),
  formatNotes: z.string().nullable(),
});

const PlatformHashtagSchema = z.object({
  platform: z.string(),
  hashtags: z.array(z.string()),
});

const HashtagSetSchema = z.object({
  core: z.array(z.string()),
  trending: z.array(z.string()),
  niche: z.array(z.string()),
  platformSpecific: z.array(PlatformHashtagSchema),
});

const HookSchema = z.object({
  text: z.string(),
  angle: z.string().nullable(),
});

const CtaVariationSchema = z.object({
  text: z.string(),
  angle: z.string().nullable(),
});

const PremiumCampaignPackSchema = z.object({
  videoConcepts: z.array(VideoConceptSchema),
  carouselAds: z.array(CarouselAdSchema),
  socialPosts: z.array(SocialPostSchema),
  adCopyVariations: z.array(AdCopyVariationSchema),
  whatsAppPromos: z.array(WhatsAppPromoSchema),
  emailCampaign: EmailCampaignSchema,
  launchSequence: LaunchSequenceSchema,
  platformAdaptations: z.array(PlatformAdaptationSchema),
  hashtagSet: HashtagSetSchema,
  hooks: z.array(HookSchema).nullable(),
  ctaVariations: z.array(CtaVariationSchema).nullable(),
  packSummary: z.string(),
});

const CreativeAssetsSchema = z.object({
  assets: z.array(
    z.object({
      assetType: z.enum([
        "image", "video_script", "carousel", "ad_copy", "caption",
        "hashtag_set", "cta_variant", "email_copy", "whatsapp_copy",
        "video_concept", "reel_script", "carousel_ad", "whatsapp_promo",
        "lead_gen_ad", "launch_pack",
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

  // Fallback: get location from workflowContext or business
  let location = strategyContext?.location || null;
  let industry = strategyContext?.industry || null;
  if (!location && campaign.businessId) {
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, campaign.businessId)).limit(1);
    if (biz) {
      location = biz.location || null;
      industry = industry || biz.industry || null;
    }
  }

  // Step 1: Generate Premium Campaign Pack
  const packPrompt = `You are an elite creative director and performance marketer who builds premium, sales-focused campaign assets for small businesses. You do not create generic filler content. Every asset must be designed to drive revenue, capture attention in 3 seconds, and convert viewers into buyers.

CAMPAIGN DETAILS:
- Name: ${campaign.name}
- Goal: ${campaign.goal}
- Core Message: ${coreMessage || "Not specified"}
- CTA Strategy: ${ctaStrategy || "Not specified"}
- Target Audience: ${campaign.targetAudience || "Not specified"}
- Platforms: ${campaign.platforms || "Instagram, Facebook, TikTok, LinkedIn"}
- Location: ${location || "Not specified"}
- Industry: ${industry || "Not specified"}
- Personas: ${personas ? JSON.stringify(personas.map((p: any) => ({ name: p.name, painPoints: p.painPoints, goals: p.goals }))) : "General audience"}
${offers ? `- Offers: ${JSON.stringify(offers)}` : ""}
${funnelStages ? `- Funnel Stages: ${JSON.stringify(funnelStages.map((f: any) => f.stage))}` : ""}
${strategyContext?.campaignTheme ? `- Campaign Theme: ${strategyContext.campaignTheme}` : ""}
${strategyContext?.platformStrategy ? `- Platform Strategy: ${JSON.stringify(strategyContext.platformStrategy)}` : ""}

GENERATE A MASTER CAMPAIGN PACK — think "Canva Premium Pack" or "Zuto Hub" quality: one hero asset per format, then platform adaptations. Do NOT generate many separate mediocre pieces. Generate ONE outstanding asset per category, then adapt it.

COPY QUALITY RULES — YOU MUST FOLLOW THESE EXACTLY:
- NEVER use generic filler like "Discover the best" or "Unlock your potential".
- NEVER use placeholders like [Your Business], YourBrandName, [Company], or [Product].
- NEVER use USD, "$100", or dollar amounts unless the campaign explicitly targets the US.
- If the location is in South Africa, use South African Rand (R) or generic terms like "from only R299" only if an offer exists. Do not invent prices.
- Use strong hooks, clear offers, and direct CTAs. Every word must earn its place.
- WhatsApp copy must be short and action-focused (under 160 chars if possible).
- LinkedIn copy must be business/professional with clear value proposition.
- TikTok/Reels copy must be punchy, visual, and trend-aware.
- Instagram copy can be slightly longer but must front-load the hook.
- Facebook copy should be conversational and community-oriented.

A. 1 MASTER SHORT-FORM VIDEO CONCEPT (use for Instagram Reels, TikTok, Facebook Reels, YouTube Shorts)
This is the single hero video blueprint for the entire campaign. Provide:
- A scroll-stopping title
- Platform recommendation (primary platform)
- Duration (15s, 30s, or 45s)
- Hook (the first line that stops the scroll)
- Opening hook for the first 3 seconds (must be visceral, emotional, or provocative)
- Scene-by-scene breakdown (3-6 scenes) with: visual description, on-screen text, voiceover script, audio direction, product shot instruction
- Background music/mood suggestion
- Strong CTA with urgency
- Visual style description
- Target persona
- Funnel stage (awareness, consideration, conversion, retention)
- Voiceover script (full script read aloud, not just scene notes)
- Thumbnail generation prompt (detailed visual description for a static thumbnail)

B. 1 CAROUSEL AD CONCEPT
One premium carousel that can be adapted across platforms. Provide:
- Title
- Platform (primary)
- Hook
- 5-7 slides with: headline, visual direction, body text, optional CTA (use null if no CTA on that slide)
- Overall CTA
- Visual style
- Target persona
- Funnel stage
- Benefit sequence explanation

C. 1 MASTER SOCIAL POST (the hero visual post)
One high-converting visual post that becomes the template. Provide:
- Platform (primary)
- Type: social_post
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
- Pain point addressed (use null if not applicable)
- Transformation promised (use null if not applicable)
- Urgency driver (use null if not applicable)

D. PLATFORM CAPTION ADAPTATIONS
For EACH platform in the campaign (${campaign.platforms || "Instagram, Facebook, TikTok, LinkedIn"}), provide a adapted version of the master post:
- Platform name
- Adapted caption (rewritten for that platform's tone and character limits)
- Adapted CTA (platform-native call to action)
- Adapted hashtags (platform-specific hashtag strategy)
- Best time to post for that platform
- Format notes (e.g. "TikTok: keep under 150 chars, use trending audio reference", "LinkedIn: professional tone, longer form accepted") — use null if not needed

E. 6 AD COPY VARIATIONS
Generate 6 distinct static ad variations covering these angles:
1. Awareness ad (problem agitation, curiosity)
2. Retargeting ad (social proof, objection handling)
3. Direct sales ad (offer, urgency, risk reversal)
4. Local relevance ad (ties to location if applicable)
5. Transformation ad (before/after, dream outcome)
6. Scarcity ad (limited time, limited spots, exclusive)
Each with: variant name, angle, headline, primary text, CTA, platform, funnel stage

F. 1 WHATSAPP PROMO MESSAGE
- Short, persuasive promo message (under 160 characters, action-focused)
- Follow-up message for non-responders (use null if not needed)
- CTA
- Casual but persuasive tone

G. 1 EMAIL CAMPAIGN
- Subject line (under 50 chars, curiosity-driven or benefit-led)
- Preheader text
- Body copy (under 200 words, single CTA focus)
- CTA
- Tone
- Target segment

H. 1 LAUNCH / OFFER SEQUENCE
- Multi-step launch sequence (3-5 steps)
- Each step: channel, timing, message, CTA
- Progresses from teaser → announcement → urgency → last chance

I. HOOK BANK
Provide at least 3 strong hook variations for this campaign:
- Each hook should be under 12 words
- Different angles: curiosity, pain point, bold claim, story opener

J. CTA VARIATION BANK
Provide at least 3 distinct CTA variations:
- Different angles: urgency, low friction, social proof, direct command

K. HASHTAG SET
Provide a structured hashtag strategy:
- Core hashtags (5-10 evergreen, brand-relevant)
- Trending hashtags (5-10 currently popular in this niche)
- Niche hashtags (5-10 highly specific to the target audience)
- Platform-specific hashtags (array of objects, each with "platform" name and "hashtags" array of 3-5 hashtags optimized for that platform)

LOCATION RULE — YOU MUST FOLLOW THIS EXACTLY:
- The business location is: ${location || "Not specified"}.
- If a location is specified above, you MUST reflect that location in the content context, offers, and CTA where relevant. Do NOT invent a different city, province, state, or country.
- If the location is Johannesburg, South Africa, the content should feel locally relevant to South Africa (currency, cultural references, local slang where appropriate).
- Only use international references if the user has explicitly selected international targeting.

CRITICAL SCHEMA RULES — YOU MUST FOLLOW THESE EXACTLY:
- Every object in the response MUST include EVERY key declared in its schema.
- If you do not have a value for a field, return null. Do NOT omit the key.
- Example: if a scene has no on-screen text, return "onScreenText": null.
- Example: if a WhatsApp promo has no follow-up, return "followUp": null.
- Example: if a social post has no pain point, return "painPoint": null.
- Example: if platform adaptation has no format notes, return "formatNotes": null.
- Never leave out any nested field. The schema is strict and every key is required.
- Respond with valid structured data only.`;

  let packResult: { runId: number; output: any } | undefined;
  let packError: string | undefined;

  try {
    packResult = await runAgent({
      userId,
      campaignId,
      agentType: "creative",
      prompt: packPrompt,
      schema: PremiumCampaignPackSchema,
      system:
        "You are an elite creative director and performance marketer. You create premium, sales-focused campaign assets that drive revenue. You specialise in Instagram Reels, TikTok, Facebook ads, carousel ads, direct-response copywriting, and launch sequences. Every asset must be emotionally engaging, visually specific, platform-native, and conversion-focused. You generate ONE master asset per format, then provide platform adaptations — like a Canva Premium Pack or Zuto Hub. CRITICAL: You must include EVERY key in every object. Use null for fields that do not apply. Never omit a key.",
    });
  } catch (err: any) {
    packError = err.message || String(err);
    console.error(`[CreativeAgent] Schema/generation failure | campaignId=${campaignId} | userId=${userId} | error="${packError}"`);
    throw new Error("Content generation needs to be retried. No content was published.");
  }

  if (!packResult) {
    throw new Error("Content generation needs to be retried. No content was published.");
  }

  // Normalise the AI output so missing/undefined fields become safe defaults
  const pack = normalisePremiumPack(packResult.output);

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
  let savedAssets = 0;

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
      console.error(`[CreativeAgent] Failed to save content post | campaignId=${campaignId} | type=${type} | error="${err.message}"`);
    }
  }

  // Save video concepts as content posts with rich metadata
  for (const video of pack.videoConcepts) {
    const caption = `${video.hook}\n\n${video.openingHook3Sec}\n\n${video.scenes.map((s: any, i: number) => `Scene ${i + 1}: ${s.visualDescription}`).join("\n")}\n\n${video.cta}`;
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
        videoStatus: "concept",
        voiceoverScript: video.voiceoverScript,
        thumbnailPrompt: video.thumbnailPrompt,
        message: "Video Concept Only — Render the video to generate a playable MP4.",
      }
    );
  }

  // Save carousel ads
  for (const carousel of pack.carouselAds) {
    const caption = `${carousel.hook}\n\n${carousel.slides.map((s: any, i: number) => `Slide ${i + 1}: ${s.headline} — ${s.bodyText}`).join("\n")}\n\n${carousel.overallCta}`;
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
    pack.launchSequence.sequenceSteps.map((s: any) => `Step ${s.stepNumber} (${s.channel}, ${s.timing}): ${s.message}`).join("\n\n"),
    pack.launchSequence.sequenceSteps[pack.launchSequence.sequenceSteps.length - 1]?.cta || "",
    [],
    "",
    {
      sequenceSteps: pack.launchSequence.sequenceSteps,
      assetKind: "launch_sequence",
    }
  );

  // Save hooks bank as campaign asset
  if (pack.hooks && pack.hooks.length > 0) {
    try {
      await db.insert(campaignAssets).values({
        userId,
        campaignId,
        assetType: "cta_variant" as any,
        title: "Hook Bank",
        status: "ready",
        metadata: {
          hooks: pack.hooks.map((h: any) => ({ text: h.text, angle: h.angle })),
        } as any,
      });
      savedAssets++;
    } catch (err: any) {
      console.error(`[CreativeAgent] Failed to save hook bank | campaignId=${campaignId} | error="${err.message}"`);
    }
  }

  // Save CTA variations as campaign asset
  if (pack.ctaVariations && pack.ctaVariations.length > 0) {
    try {
      await db.insert(campaignAssets).values({
        userId,
        campaignId,
        assetType: "cta_variant" as any,
        title: "CTA Variation Bank",
        status: "ready",
        metadata: {
          ctaVariations: pack.ctaVariations.map((c: any) => ({ text: c.text, angle: c.angle })),
        } as any,
      });
      savedAssets++;
    } catch (err: any) {
      console.error(`[CreativeAgent] Failed to save CTA variation bank | campaignId=${campaignId} | error="${err.message}"`);
    }
  }

  // Save platform adaptations as campaign assets
  if (pack.platformAdaptations && pack.platformAdaptations.length > 0) {
    for (const adaptation of pack.platformAdaptations) {
      try {
        await db.insert(campaignAssets).values({
          userId,
          campaignId,
          assetType: "caption_adaptation",
          title: `${adaptation.platform} Adaptation`,
          status: "ready",
          metadata: {
            platform: adaptation.platform,
            adaptedCaption: adaptation.adaptedCaption,
            adaptedCta: adaptation.adaptedCta,
            adaptedHashtags: adaptation.adaptedHashtags,
            bestTimeToPost: adaptation.bestTimeToPost,
            formatNotes: adaptation.formatNotes,
          } as any,
        });
        savedAssets++;
      } catch (err: any) {
        console.error(`[CreativeAgent] Failed to save platform adaptation | campaignId=${campaignId} | platform=${adaptation.platform} | error="${err.message}"`);
      }
    }
  }

  // Save hashtag set as campaign asset
  if (pack.hashtagSet) {
    try {
      await db.insert(campaignAssets).values({
        userId,
        campaignId,
        assetType: "hashtag_set" as any,
        title: "Master Hashtag Set",
        status: "ready",
        metadata: {
          core: pack.hashtagSet.core,
          trending: pack.hashtagSet.trending,
          niche: pack.hashtagSet.niche,
          platformSpecific: pack.hashtagSet.platformSpecific.map((p: any) => ({
            platform: p.platform,
            hashtags: p.hashtags,
          })),
        } as any,
      });
      savedAssets++;
    } catch (err: any) {
      console.error(`[CreativeAgent] Failed to save hashtag set | campaignId=${campaignId} | error="${err.message}"`);
    }
  }

  console.log(`[CreativeAgent] Premium pack saved: campaignId=${campaignId} savedPosts=${savedPosts} failedInserts=${failedInserts}`);

  if (savedPosts === 0) {
    const errMsg = `Content generation completed but no posts were saved. failedInserts=${failedInserts}`;
    console.error(`[CreativeAgent] CRITICAL: ${errMsg} | campaignId=${campaignId} | userId=${userId}`);
    throw new Error("Content generation needs to be retried. No content was published.");
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

CRITICAL: Every object must include EVERY key. Use null when a field does not apply. Never omit a key.
Respond with structured data.`;

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
        "You are an expert copywriter and creative director. You create high-converting marketing assets across all channels. Always respond with valid structured data. CRITICAL: Every object must include EVERY key. Use null when a field does not apply. Never omit a key.",
    });
  } catch (err: any) {
    assetsError = err.message || String(err);
    console.error(`[CreativeAgent] Assets generation failed | campaignId=${campaignId} | userId=${userId} | error="${assetsError}"`);
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

  // Save campaign_assets records from Step 2 (best-effort)
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
        console.error(`[CreativeAgent] Failed to save campaign asset | campaignId=${campaignId} | error="${err.message}"`);
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
