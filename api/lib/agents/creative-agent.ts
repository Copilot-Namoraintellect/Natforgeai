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

  // Step 1: Generate Hero Campaign Pack
  const packPrompt = `You are an elite creative director for a premium marketing agency. You build tight, high-performing Hero Campaign Packs — not content factories. Approved strategy becomes one strong campaign idea, then platform adaptations and supporting assets.

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

PRODUCT EXPERIENCE RULES — YOU MUST FOLLOW THESE EXACTLY:
- Output exactly ONE Master Campaign Post and ONE Master Video Ad as the primary assets.
- Personas guide the message, tone and angle. DO NOT create a separate post for each persona by default.
- DO NOT invent offers, discounts, free trials, limited spots, loyalty programmes, free e-books or lead magnets unless they are explicitly listed in the approved strategy above.
- If the user did not provide an offer, use neutral CTAs only: "Book a demo", "Speak to us", "See how it works", "Request a payout workflow assessment", or "Let us show you the payout flow".
- Ground every claim in the approved strategy. Do not invent statistics, testimonials, prices or locations.

COPY QUALITY RULES — YOU MUST FOLLOW THESE EXACTLY:
- NEVER use weak, generic lines like "Limited Spots for Financial Wellness!", "First Month FREE! Make the Switch Now!", "Watch Your Team Flourish Here!", "Hundreds of Businesses Trust Our Solutions!", "Transform your employees' financial futures today!", "Financial health means employee happiness!", "Discover the best", "Unlock your potential" or "Join thousands of satisfied customers".
- Write like a premium agency: specific, grounded, human, confident. Every word must earn its place.
- Front-load the benefit. One clear idea per asset.
- NEVER use placeholders like [Your Business], YourBrandName, [Company], or [Product].
- NEVER use USD, "$100", or dollar amounts unless the campaign explicitly targets the US.
- If the location is in South Africa, use South African Rand (R) only if an offer price exists. Do not invent prices.
- WhatsApp copy must be short and action-focused (under 160 chars if possible).
- LinkedIn copy must be business/professional with clear value proposition.
- TikTok/Reels copy must be punchy, visual, and trend-aware.
- Instagram copy can be slightly longer but must front-load the hook.
- Facebook copy should be conversational and community-oriented.

ZUTOHUB / STAFF PAYOUT FOCUS (apply when the campaign is about staff earnings, tips, commissions or payouts):
- Focus on: tips payouts, commission payouts, staff earnings payouts, faster access to earned money, reducing manual payout admin, improving staff retention, helping merchants support staff without increasing salaries, helping restaurants, salons, barbershops, delivery operators and commission-based businesses manage payouts.
- Core idea: "What if you could improve staff retention without increasing salaries?"
- Example tone: "Your team works hard for every tip, commission and earned payout. ZutoHub helps businesses move those earnings faster, cleaner and with less admin, so staff feel supported and owners stay in control."
- Avoid discount language. Avoid "free". Lead with operational relief and staff retention.

GENERATE THE FOLLOWING STRUCTURE:

A. 1 MASTER CAMPAIGN POST (social_post) — the hero visual post
This is the single primary social asset for the entire campaign. Provide:
- Platform (primary)
- Type: social_post
- Title
- Hook (bold, emotional, or provocative — max 12 words)
- Caption (2-4 short paragraphs, line breaks, direct to reader, zero fluff)
- CTA (neutral if no offer is provided; otherwise grounded in the approved offer)
- Hashtags (5-10 targeted, niche + trending mix)
- Visual generation prompt (detailed scene for AI image tools)
- Best time to post
- Sales angle
- Target persona (this persona guides tone; it does NOT create a separate card)
- Funnel stage
- Pain point addressed (use null if not applicable)
- Transformation promised (use null if not applicable)
- Urgency driver (use null if not applicable)

B. 1 MASTER SHORT-FORM VIDEO AD (video_concept)
This is the single hero video blueprint. Provide:
- A scroll-stopping title
- Platform recommendation (primary platform)
- Duration (15s, 30s, or 45s)
- Hook (the first line that stops the scroll)
- Opening hook for the first 3 seconds (visceral, emotional, or provocative)
- Scene-by-scene breakdown (3-6 scenes) with: visual description, on-screen text, voiceover script, audio direction, product shot instruction
- Background music/mood suggestion
- CTA (neutral if no offer; otherwise grounded in approved offer)
- Visual style description
- Target persona
- Funnel stage
- Voiceover script (full script read aloud)
- Thumbnail generation prompt

C. PLATFORM CAPTION ADAPTATIONS
For EACH platform in the campaign (${campaign.platforms || "Instagram, Facebook, TikTok, LinkedIn"}), provide a adapted version of the master post:
- Platform name
- Adapted caption (rewritten for that platform's tone and character limits)
- Adapted CTA (platform-native, neutral if no offer)
- Adapted hashtags (platform-specific hashtag strategy)
- Best time to post for that platform
- Format notes (e.g. "TikTok: keep under 150 chars, use trending audio reference", "LinkedIn: professional tone, longer form accepted") — use null if not needed

D. 1 CAROUSEL AD CONCEPT (supporting asset)
One premium carousel. Provide title, primary platform, hook, 5-7 slides, overall CTA, visual style, target persona, funnel stage, benefit sequence.

E. AD COPY VARIATIONS (supporting assets)
Generate 3-5 distinct static ad variations. Each with: variant name, angle, headline, primary text, CTA, platform, funnel stage. Do not default to scarcity/limited spots unless the approved strategy includes them.

F. 1 WHATSAPP PROMO MESSAGE (supporting asset)
Short, persuasive promo message (under 160 characters), optional follow-up, CTA, tone.

G. 1 EMAIL CAMPAIGN (supporting asset)
Subject line (under 50 chars), preheader, body copy (under 200 words), CTA, tone, target segment.

H. 1 LAUNCH / OFFER SEQUENCE (supporting asset)
Multi-step launch sequence (3-5 steps). Each step: channel, timing, message, CTA. Progress from teaser → announcement → urgency → last chance. Do not invent offers.

I. HOOK BANK
At least 3 strong hook variations under 12 words. Different angles.

J. CTA VARIATION BANK
At least 3 distinct CTA variations. Neutral CTAs only if no approved offer.

K. HASHTAG SET
Core, trending, niche and platform-specific hashtags.

LOCATION RULE — YOU MUST FOLLOW THIS EXACTLY:
- The business location is: ${location || "Not specified"}.
- If a location is specified above, you MUST reflect that location in the content context where relevant. Do NOT invent a different city, province, state, or country.
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
        "You are an elite creative director for a premium marketing agency. You create Hero Campaign Packs: one strong campaign idea expressed as one Master Campaign Post and one Master Video Ad, plus platform adaptations and collapsed supporting assets. You specialise in Instagram Reels, TikTok, Facebook ads, carousel ads, direct-response copywriting, and launch sequences. Every asset must be emotionally engaging, visually specific, platform-native, and conversion-focused. You do not create separate cards for each persona; personas guide tone only. You do not invent offers, discounts, free trials, limited spots or free e-books. If no offer is provided, use neutral CTAs like 'Book a demo' or 'See how it works'. CRITICAL: You must include EVERY key in every object. Use null for fields that do not apply. Never omit a key.",
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

  // Save ONLY the master video ad as a content post
  if (pack.videoConcepts.length > 0) {
    const video = pack.videoConcepts[0];
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
        assetKind: "master_video_ad",
        videoStatus: "concept",
        voiceoverScript: video.voiceoverScript,
        thumbnailPrompt: video.thumbnailPrompt,
        message: "Master Video Ad — Render to generate a playable MP4.",
      }
    );
  }

  // Save ONLY the master campaign post as a content post
  if (pack.socialPosts.length > 0) {
    const post = pack.socialPosts[0];
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
        assetKind: "master_campaign_post",
      }
    );
  }

  // Save supporting assets as campaign assets (collapsed in the UI), not as primary content posts
  async function insertAsset(title: string, assetType: string, metadata: any) {
    try {
      await db.insert(campaignAssets).values({
        userId,
        campaignId,
        assetType: assetType as any,
        title,
        status: "ready",
        metadata: metadata as any,
      });
      savedAssets++;
    } catch (err: any) {
      console.error(`[CreativeAgent] Failed to save supporting asset | campaignId=${campaignId} | type=${assetType} | error="${err.message}"`);
    }
  }

  // Carousel ad
  if (pack.carouselAds.length > 0) {
    const carousel = pack.carouselAds[0];
    await insertAsset(
      carousel.title,
      "carousel_ad",
      {
        hook: carousel.hook,
        platform: carousel.platform,
        slides: carousel.slides,
        overallCta: carousel.overallCta,
        visualStyle: carousel.visualStyle,
        targetPersona: carousel.targetPersona,
        funnelStage: carousel.funnelStage,
        benefitSequence: carousel.benefitSequence,
      }
    );
  }

  // Ad copy variations (grouped into one supporting asset)
  if (pack.adCopyVariations.length > 0) {
    await insertAsset(
      "Ad Variations",
      "ad_copy",
      {
        variations: pack.adCopyVariations.map((ad: any) => ({
          variantName: ad.variantName,
          angle: ad.angle,
          headline: ad.headline,
          primaryText: ad.primaryText,
          cta: ad.cta,
          platform: ad.platform,
          funnelStage: ad.funnelStage,
        })),
      }
    );
  }

  // WhatsApp promo
  if (pack.whatsAppPromos.length > 0) {
    const wa = pack.whatsAppPromos[0];
    await insertAsset(
      wa.title,
      "whatsapp_promo",
      {
        message: wa.message,
        followUp: wa.followUp,
        cta: wa.cta,
        tone: wa.tone,
      }
    );
  }

  // Email campaign
  if (pack.emailCampaign) {
    await insertAsset(
      pack.emailCampaign.subjectLine,
      "email_copy",
      {
        subjectLine: pack.emailCampaign.subjectLine,
        preheader: pack.emailCampaign.preheader,
        body: pack.emailCampaign.body,
        cta: pack.emailCampaign.cta,
        tone: pack.emailCampaign.tone,
        segment: pack.emailCampaign.segment,
      }
    );
  }

  // Launch sequence
  if (pack.launchSequence) {
    await insertAsset(
      pack.launchSequence.title,
      "launch_pack",
      {
        sequenceSteps: pack.launchSequence.sequenceSteps,
      }
    );
  }

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
