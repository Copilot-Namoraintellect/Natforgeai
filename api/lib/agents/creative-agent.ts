import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { runAgent } from "./runner";
import { getDb } from "../../queries/connection";
import { campaigns, contentPosts, campaignAssets, businesses, agentRuns } from "@db/schema";
import { eq, and } from "drizzle-orm";
import { logInfo, logError, logWarn } from "../logger";
import { type CreativeGenerationClaimHeartbeatController } from "../creative/creative-generation-claim";
import { checkCredits, deductCredits } from "../billing/credit-engine";
import { getEstimatedAgentCost } from "../billing/cost-tracker";
import { enforceCostControl } from "../billing/cost-control";
import {
  ensureApprovedMessagePack,
  saveApprovedMessagePack,
  selectFunnelCta,
  validateCampaignCopy,
  type CampaignMessagePack,
  type ValidationContext,
} from "../creative/campaign-message-architect";
import {
  ctaMatchesSelectedStage,
  normalizeCtaText,
  normalizeFunnelStage,
} from "../creative/cta-utils";
import { buildGroundedCreativeBrief } from "../creative/brief-grounding";
import {
  extractApprovedStrategyLineage,
  observeIfEnabled,
  resolveExpectedApprovedStrategyFingerprint,
} from "../creative/contracts/observe-quality-authority";
import {
  InMemoryWorkflowOperationRegistry,
  type WorkflowOperationSource,
  type WorkflowOperationType,
} from "../workflow/workflow-operation";

// Valid content_posts.type enum values from db/schema.ts
const CONTENT_POST_TYPES = new Set([
  "social_post",
  "ad_copy",
  "email",
  "script",
  "blog",
  "story",
  "video_concept",
  "reel_script",
  "carousel_ad",
  "whatsapp_promo",
  "lead_gen_ad",
  "launch_pack",
]);

function sanitizeTitle(title: string): string {
  const trimmed = String(title ?? "").trim();
  if (trimmed.length === 0) return "Untitled";
  return trimmed.slice(0, 255);
}

function safeType(type: string, fallback: string): string {
  return CONTENT_POST_TYPES.has(type) ? type : fallback;
}

interface InsertError {
  type: string;
  title: string;
  error: string;
}

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
    videoConcepts: videoConcepts.length > 0 ? videoConcepts : [],
    carouselAds: carouselAds.length > 0 ? carouselAds : [],
    socialPosts: socialPosts.length > 0 ? socialPosts : [],
    adCopyVariations: adCopyVariations.length > 0 ? adCopyVariations : [],
    whatsAppPromos: whatsAppPromos.length > 0 ? whatsAppPromos : [],
    emailCampaign: normaliseEmail(raw.emailCampaign),
    launchSequence: normaliseLaunchSequence(raw.launchSequence),
    platformAdaptations: platformAdaptations.length > 0 ? platformAdaptations : [],
    hashtagSet,
    hooks: hooks.length > 0 ? hooks : [],
    ctaVariations: ctaVariations.length > 0 ? ctaVariations : [],
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

// ─── Quality Gate ───
const GENERIC_PHRASES = [
  "join the trading revolution",
  "explore unique experiences",
  "join our community",
  "trade smarter",
  "live greener",
  "unlock new possibilities",
  "transform your future",
  "discover treasures",
  "get 20% off",
  "get 50% off",
  "first month free",
  "limited spots",
  "limited time",
  "hurry",
  "act now",
  "don't miss out",
  "unlock your potential",
  "discover the best",
  "join thousands",
  "revolution",
];

const OFFER_PATTERNS = [
  /\b\d{1,2}%\s*off\b/i,
  /first\s+month\s+free/i,
  /free\s+trial/i,
  /limited\s+spots/i,
  /limited\s+time/i,
  /\bfree\b.*\bebook/i,
  /loyalty\s+program/i,
];

function buildValidationContextFromCampaign(
  campaign: any,
  business: any
): ValidationContext {
  const evidence = (business?.websiteEvidence || {}) as any;
  const firstFunnelStage = Array.isArray(campaign?.funnelStages) && campaign.funnelStages.length > 0
    ? String(campaign.funnelStages[0]?.stage || "")
    : "";
  return {
    businessName: String(business?.name ?? ""),
    campaignName: String(campaign?.name ?? ""),
    productOrService: String(campaign?.productOrService || business?.productOrService || ""),
    targetCustomer: String(campaign?.targetBuyer || business?.targetCustomer || business?.targetAudience || ""),
    mainPainPoint: String(campaign?.mainPainPoint || ""),
    offerDetails: String(campaign?.offerDetails || ""),
    excludedOffers: String(campaign?.excludedOffers || business?.avoidWords || ""),
    preferredCta: String(campaign?.preferredCta || campaign?.ctaStrategy || ""),
    campaignObjective: String(campaign?.goal || campaign?.primaryOutcome || ""),
    funnelStage: firstFunnelStage as ValidationContext["funnelStage"],
    location: String(campaign?.location || business?.location || evidence?.location || ""),
    industry: String(business?.industry || evidence?.businessCategory || ""),
    websiteEvidence: {
      businessCategory: evidence?.businessCategory,
      productsServices: evidence?.productsServices || [],
      targetCustomers: evidence?.targetCustomers || [],
      location: evidence?.location,
    },
  };
}

function validatePackAgainstArchitect(
  pack: any,
  ctx: ValidationContext
): { passed: boolean; issues: string[] } {
  const masterPost = pack.socialPosts?.[0];
  const platformCaptions = (pack.platformAdaptations || []).map((a: any) => ({
    platform: String(a.platform ?? ""),
    caption: String(a.adaptedCaption ?? ""),
    cta: String(a.adaptedCta ?? ""),
    hashtags: Array.isArray(a.adaptedHashtags) ? a.adaptedHashtags.map(String) : [],
  }));

  const messagePack: CampaignMessagePack = {
    headline: String(masterPost?.hook || masterPost?.title || ""),
    subheadline: String(masterPost?.caption || "").slice(0, 160),
    benefitBullets: [
      String(masterPost?.caption || "").slice(0, 120),
      String(masterPost?.salesAngle || ""),
      String(masterPost?.transformation || ""),
    ].filter(Boolean),
    cta: String(masterPost?.cta || ""),
    footerContact: {},
    proofPoints: [],
    platformCaptions,
    validation: { passed: false, score: 0, rejections: [], warnings: [] },
  };

  const result = validateCampaignCopy(messagePack, ctx);
  return {
    passed: result.passed,
    issues: [...result.rejections, ...result.warnings],
  };
}

function assessPackQuality(
  pack: any,
  hasExplicitOffer: boolean,
  brief: {
    preferredCta?: string | null;
    excludedOffers?: string | null;
    productOrService?: string | null;
    mainPainPoint?: string | null;
    campaignObjective?: string | null;
    funnelStage?: string | null;
  }
): {
  passed: boolean;
  issues: string[];
  ctaDiagnostics: {
    generatedCta: string;
    selectedStageCta: string;
    normalizedGeneratedCta: string;
    normalizedSelectedStageCta: string;
    ctaMatches: boolean;
  };
} {
  const issues: string[] = [];
  const masterPost = pack.socialPosts?.[0];
  const video = pack.videoConcepts?.[0];

  const textToCheck = [
    masterPost?.hook || "",
    masterPost?.caption || "",
    masterPost?.cta || "",
    video?.hook || "",
    video?.openingHook3Sec || "",
    video?.cta || "",
  ]
    .join(" ")
    .toLowerCase();

  // Generic phrase check
  for (const phrase of GENERIC_PHRASES) {
    if (textToCheck.includes(phrase.toLowerCase())) {
      issues.push(`Generic phrase detected: "${phrase}"`);
    }
  }

  // Invented offer check
  if (!hasExplicitOffer) {
    for (const pattern of OFFER_PATTERNS) {
      if (pattern.test(textToCheck)) {
        issues.push(`Invented offer detected (no offer was provided): "${textToCheck.match(pattern)?.[0]}"`);
      }
    }
    if (/\bfree\b/i.test(textToCheck)) {
      issues.push("Invented 'free' offer detected (no offer was provided)");
    }
  }

  // Excluded offers check
  if (brief.excludedOffers) {
    const excluded = brief.excludedOffers.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const ex of excluded) {
      if (textToCheck.includes(ex)) {
        issues.push(`Excluded phrase used: "${ex}"`);
      }
    }
  }

  // Preferred CTA check (if provided and not an offer-based CTA)
  const generatedCta = String(masterPost?.cta || video?.cta || "");
  const selectedStageCta = selectFunnelCta(
    brief.preferredCta,
    brief.funnelStage || brief.campaignObjective
  );
  const normalizedGeneratedCta = normalizeCtaText(generatedCta);
  const normalizedSelectedStageCta = normalizeCtaText(selectedStageCta);
  const ctaMatches = ctaMatchesSelectedStage({
    cta: generatedCta,
    preferredCta: brief.preferredCta,
    objectiveOrStage: brief.funnelStage || brief.campaignObjective,
  });

  if (brief.preferredCta && !hasExplicitOffer) {
    if (!ctaMatches) {
      issues.push(`Preferred CTA "${brief.preferredCta}" was not used`);
      if (selectedStageCta) {
        issues.push(`Selected stage CTA "${selectedStageCta}" was not used`);
      }
    }
  }

  // Business grounding checks
  if (!brief.productOrService && !brief.mainPainPoint) {
    // If no brief provided, we can't enforce grounding strictly
  } else {
    const productTerms = (brief.productOrService || "").toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const painTerms = (brief.mainPainPoint || "").toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const hasProductTerm = productTerms.some((t) => textToCheck.includes(t));
    const hasPainTerm = painTerms.some((t) => textToCheck.includes(t));
    if (!hasProductTerm && productTerms.length > 0) {
      issues.push("Master copy is not grounded in the product/service being promoted");
    }
    if (!hasPainTerm && painTerms.length > 0) {
      issues.push("Master copy does not address the main pain point");
    }
  }

  // Empty / weak checks
  if (!masterPost?.caption || masterPost.caption.trim().length < 40) {
    issues.push("Master Campaign Post caption is too short or empty");
  }
  if (!masterPost?.hook || masterPost.hook.trim().length < 5) {
    issues.push("Master Campaign Post hook is missing or too short");
  }

  return {
    passed: issues.length === 0,
    issues,
    ctaDiagnostics: {
      generatedCta,
      selectedStageCta,
      normalizedGeneratedCta,
      normalizedSelectedStageCta,
      ctaMatches,
    },
  };
}

function applyApprovedMessagePackToCreativePack(pack: any, approved: CampaignMessagePack): any {
  const grounded = normalisePremiumPack(pack);
  const fallbackCaption = [
    approved.subheadline,
    ...approved.benefitBullets.map((b) => `- ${b}`),
  ]
    .filter(Boolean)
    .join("\n");

  if (grounded.socialPosts?.[0]) {
    grounded.socialPosts[0].title = approved.headline;
    grounded.socialPosts[0].hook = approved.headline;
    grounded.socialPosts[0].caption = fallbackCaption || grounded.socialPosts[0].caption;
    grounded.socialPosts[0].cta = approved.cta;
  }

  if (grounded.videoConcepts?.[0]) {
    grounded.videoConcepts[0].hook = approved.headline;
    grounded.videoConcepts[0].openingHook3Sec = approved.subheadline || grounded.videoConcepts[0].openingHook3Sec;
    grounded.videoConcepts[0].cta = approved.cta;
  }

  if (Array.isArray(grounded.platformAdaptations)) {
    for (const adaptation of grounded.platformAdaptations) {
      const platformMatch = (approved.platformCaptions || []).find(
        (c) => c.platform.toLowerCase() === String(adaptation.platform || "").toLowerCase()
      );
      adaptation.adaptedCaption = platformMatch?.caption || adaptation.adaptedCaption || fallbackCaption;
      adaptation.adaptedCta = approved.cta;
    }
  }

  if (Array.isArray(grounded.adCopyVariations)) {
    for (const ad of grounded.adCopyVariations) {
      ad.cta = approved.cta;
    }
  }

  if (Array.isArray(grounded.ctaVariations) && grounded.ctaVariations.length > 0) {
    grounded.ctaVariations[0].text = approved.cta;
  }

  return grounded;
}

async function assertCreativeCreditsAvailable(userId: number): Promise<number> {
  const estimatedCost = getEstimatedAgentCost("creative");

  const costControl = await enforceCostControl(userId, estimatedCost);
  if (!costControl.allowed) {
    throw new TRPCError({
      code: "PAYMENT_REQUIRED",
      message: costControl.reason || "Insufficient credits.",
    });
  }

  const preCheck = await checkCredits(userId, estimatedCost);
  if (!preCheck.hasCredits) {
    throw new TRPCError({
      code: "PAYMENT_REQUIRED",
      message: `Insufficient credits. You have ${preCheck.balance} credits. This operation requires ${estimatedCost} credits. Upgrade your plan or purchase more credits.`,
    });
  }

  return estimatedCost;
}

export type CreativeGenerationSource = "job" | "agent" | "profile" | "approval";

export interface CreativeGenerationOperation {
  source: CreativeGenerationSource;
  id: number;
}

function validateCreativeGenerationOperation(
  generationOperation: CreativeGenerationOperation
): void {
  const validSources: CreativeGenerationSource[] = ["job", "agent", "profile", "approval"];
  if (!generationOperation || !validSources.includes(generationOperation.source)) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Invalid creative generation operation source: ${String(generationOperation?.source)}`,
    });
  }
  const { id } = generationOperation;
  if (
    typeof id !== "number" ||
    !Number.isFinite(id) ||
    !Number.isInteger(id) ||
    id <= 0 ||
    id > Number.MAX_SAFE_INTEGER
  ) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Invalid creative generation operation id: ${String(id)}`,
    });
  }
}

function buildCreativeIdempotencyKey(
  campaignId: number,
  generationOperation: CreativeGenerationOperation
): string {
  const key = `creative-success:${campaignId}:${generationOperation.source}:${generationOperation.id}`;
  if (key.length > 255) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Creative idempotency key exceeds database column limit",
    });
  }
  return key;
}

async function deductCreativeCreditsOnce({
  userId,
  campaignId,
  agentRunId,
  generationRunId,
  generationOperation,
  estimatedCost,
}: {
  userId: number;
  campaignId: number;
  agentRunId: number;
  generationRunId: string;
  generationOperation: CreativeGenerationOperation;
  estimatedCost: number;
}): Promise<void> {
  validateCreativeGenerationOperation(generationOperation);
  const idempotencyKey = buildCreativeIdempotencyKey(campaignId, generationOperation);

  const { alreadyDeducted } = await deductCredits({
    userId,
    amount: estimatedCost,
    type: "agent_deduction",
    description: "creative agent execution (post-success)",
    metadata: {
      campaignId,
      agentRunId,
      generationRunId,
      generationSource: generationOperation.source,
      generationOperationId: generationOperation.id,
      provider: "openai",
      billingStage: "post_success",
      estimatedCost,
      agentType: "creative",
      idempotencyKey,
    },
    idempotencyKey,
  });

  if (alreadyDeducted) {
    logInfo("[CreativeAgent] billing already deducted for operation", {
      userId,
      campaignId,
      generationOperation,
      idempotencyKey,
    });
  }
}

export async function runCreativeAgent({
  userId,
  campaignId,
  deleteExistingDrafts = true,
  generationOperation,
  claimContext,
  registry: inputRegistry,
  operationType: inputOperationType,
}: {
  userId: number;
  campaignId: number;
  deleteExistingDrafts?: boolean;
  generationOperation: CreativeGenerationOperation;
  claimContext?: CreativeGenerationClaimHeartbeatController;
  registry?: InMemoryWorkflowOperationRegistry;
  operationType?: WorkflowOperationType;
}) {
  validateCreativeGenerationOperation(generationOperation);
  const db = getDb();

  const workflowOperationSource: WorkflowOperationSource =
    generationOperation.source === "approval"
      ? "approval"
      : generationOperation.source === "agent"
      ? "manual"
      : generationOperation.source === "profile"
      ? "automatic"
      : "automatic";
  const workflowOperationType: WorkflowOperationType = inputOperationType ?? "creative_generation";
  const workflowRegistry = inputRegistry ?? new InMemoryWorkflowOperationRegistry();
  const totalStartedAt = Date.now();
  const timing = {
    messageArchitectDurationMs: 0,
    creativeGenerationDurationMs: 0,
    qualityRetryDurationMs: 0,
    fallbackDurationMs: 0,
    totalDurationMs: 0,
  };

  // Defensive ownership checkpoint. These checks reduce the risk of a zombie
  // worker continuing after its claim has expired, but they are not a complete
  // transactional fence. Phase 3A deliberately does not perform automatic
  // stale-claim takeover.
  async function assertOwnershipCheckpoint(stage: string): Promise<void> {
    if (!claimContext) return;
    try {
      await claimContext.assertStillOwned();
    } catch (err) {
      logError("[CreativeAgent] ownership checkpoint failed", {
        campaignId,
        userId,
        stage,
      });
      throw err;
    }
  }

  logInfo("[CreativeAgent] started", {
    campaignId,
    userId,
    stage: "start",
    provider: "openai",
    deleteExistingDrafts,
  });

  // Get campaign and business info
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  if (!campaign) {
    logError("[CreativeAgent] campaign not found", { campaignId, userId, stage: "load" });
    throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
  }

  const estimatedCreativeCost = await assertCreativeCreditsAvailable(userId);

  const existingDraftIdsToDelete = deleteExistingDrafts
    ? (
        await db
          .select({ id: contentPosts.id })
          .from(contentPosts)
          .where(
            and(
              eq(contentPosts.campaignId, campaignId),
              eq(contentPosts.aiGenerated, true),
              eq(contentPosts.status, "draft")
            )
          )
      ).map((row) => row.id)
    : [];

  logInfo("[CreativeAgent] campaign loaded", {
    campaignId,
    userId,
    stage: "load",
    workflowState: campaign.workflowState,
    businessId: campaign.businessId,
    estimatedCreativeCost,
    existingDraftsQueuedForCleanup: existingDraftIdsToDelete.length,
  });

  const strategyContext = campaign.workflowContext as any;
  const personas = campaign.personas as any[];
  const coreMessage = campaign.coreMessage;
  const ctaStrategy = campaign.ctaStrategy;
  const offers = campaign.offers as any[];
  const funnelStages = campaign.funnelStages as any[];

  // Load linked business profile for optional fallback and evidence.
  let business: any = null;
  if (campaign.businessId) {
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, campaign.businessId)).limit(1);
    business = biz;
  }

  // Use the shared resolver so the current campaign brief is the source of truth
  // and historical workflowContext values cannot override it.
  const brief = buildGroundedCreativeBrief({ campaign, business });
  const hasExplicitOffer = !!(brief.offerDetails && brief.offerDetails.trim().length > 0) || (offers && offers.length > 0);

  // Location/industry: current business profile first, historical workflowContext only as safe fallback.
  let location = business?.location || strategyContext?.location || null;
  let industry = business?.industry || strategyContext?.industry || null;
  const businessEvidence: {
    businessCategory?: string;
    productsServices?: string[];
    targetCustomers?: string[];
    location?: string;
  } | null = (business?.websiteEvidence || null) as any;

  logInfo("[CreativeAgent] business evidence loaded", {
    campaignId,
    userId,
    stage: "context",
    location: location || "none",
    industry: industry || "none",
  });

  // Step 0: Build / reuse approved campaign message pack
  let approvedMessagePack: CampaignMessagePack | null = null;
  let messagePackAttemptOrdinal = 0;
  const nextMessagePackOrdinal = () => {
    messagePackAttemptOrdinal += 1;
    return messagePackAttemptOrdinal;
  };
  const architectStartedAt = Date.now();
  try {
    approvedMessagePack = await ensureApprovedMessagePack({
      userId,
      campaignId,
      skipBilling: true,
      maxAttempts: 2,
      registry: workflowRegistry,
      operationType: workflowOperationType,
      operationSource: workflowOperationSource,
      operationReferenceId: generationOperation.id,
      attemptOrdinal: nextMessagePackOrdinal(),
    });

    if (!approvedMessagePack.validation.passed) {
      logError("[CreativeAgent] approved message pack failed validation", {
        campaignId,
        userId,
        stage: "message_architect",
        rejections: approvedMessagePack.validation.rejections,
        warnings: approvedMessagePack.validation.warnings,
      });
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "We could not produce sufficiently business-specific campaign copy. No credits were charged. Your previous content was preserved.",
      });
    }

    timing.messageArchitectDurationMs = Date.now() - architectStartedAt;
    if (approvedMessagePack.messagePackSource === "fallback_deterministic") {
      timing.fallbackDurationMs += timing.messageArchitectDurationMs;
    }

    // Slice 1 observation: compare legacy-selected CTA with the new CreativeContract authority.
    // This block must not change the returned pack or any persisted state.
    if (approvedMessagePack) {
      const workflowContext = (campaign?.workflowContext || {}) as Record<string, unknown>;
      const lineage = extractApprovedStrategyLineage(workflowContext, campaignId, userId);
      const businessName = String(business?.name ?? "");
      observeIfEnabled("creative agent observation", {
        campaignId,
        userId,
        businessId: Number.isFinite(Number(campaign.businessId))
          ? Number(campaign.businessId)
          : 0,
        businessName,
        lineage,
        expectedApprovedStrategyFingerprint: resolveExpectedApprovedStrategyFingerprint(workflowContext),
        funnelStage: normalizeFunnelStage(brief.primaryOutcome),
        campaignInputCta:
          (brief.preferredCta || ctaStrategy || approvedMessagePack.cta) || null,
        offerActionCta: null,
        targetAudience: brief.targetBuyer || campaign.targetAudience || "",
        offer: brief.offerDetails || null,
        businessCapabilities: businessEvidence?.productsServices || [],
        legacySelectedCta: approvedMessagePack.cta || "",
        operationType: workflowOperationType,
        operationSource: workflowOperationSource,
        operationReferenceId: generationOperation.id,
        attemptType: "creative_generation",
        attemptOrdinal: 1,
        registry: workflowRegistry,
        proposedContent: {
          headline: approvedMessagePack.headline,
          primaryText: approvedMessagePack.subheadline || approvedMessagePack.headline,
          benefits: approvedMessagePack.benefitBullets?.slice(0, 5) || [],
          cta: approvedMessagePack.cta || "Learn More",
          funnelStage: normalizeFunnelStage(brief.primaryOutcome),
          targetAudience: brief.targetBuyer || campaign.targetAudience || "",
          offer: brief.offerDetails || null,
          businessName,
          protectedFields: {
            businessName,
          },
        },
      });
    }

    await assertOwnershipCheckpoint("message_architect");

    logInfo("[CreativeAgent] approved message pack loaded", {
      campaignId,
      userId,
      stage: "message_architect",
      headline: approvedMessagePack.headline,
      score: approvedMessagePack.validation.score,
    });
  } catch (architectErr: any) {
    timing.messageArchitectDurationMs = Date.now() - architectStartedAt;
    logError("[CreativeAgent] message architect failed", {
      campaignId,
      userId,
      stage: "message_architect",
      error: architectErr.message,
    });
    if (architectErr instanceof TRPCError) throw architectErr;
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "We could not produce sufficiently business-specific campaign copy. No credits were charged. Your previous content was preserved.",
    });
  }

  // Step 1: Generate Hero Campaign Pack (seeded with approved message pack)
  const packPrompt = `You are an elite creative director for a premium marketing agency. You build tight, high-performing Hero Campaign Packs — not content factories. Approved strategy becomes one strong campaign idea, then platform adaptations and supporting assets.

APPROVED CAMPAIGN MESSAGE PACK — USE THIS AS THE SOURCE OF TRUTH FOR ALL COPY:
- Headline: ${approvedMessagePack.headline}
- Subheadline: ${approvedMessagePack.subheadline}
- Benefit Bullets: ${approvedMessagePack.benefitBullets.join(" | ")}
- CTA: ${approvedMessagePack.cta}
- Footer/Contact: ${JSON.stringify(approvedMessagePack.footerContact)}
- Proof Points: ${(approvedMessagePack.proofPoints || []).join(" | ") || "None"}
- Platform Captions: ${approvedMessagePack.platformCaptions.map((c) => `${c.platform}: ${c.caption}`).join(" | ")}

CRITICAL: The Master Campaign Post headline, hook and CTA must derive from the Approved Message Pack above. Do not invent a different headline or CTA. Do not use the campaign name as the headline.

CAMPAIGN DETAILS:
- Name: ${campaign.name}
- Goal: ${campaign.goal}
- Primary Outcome: ${brief.primaryOutcome || "Not specified"}
- Target Buyer: ${brief.targetBuyer || campaign.targetAudience || "Not specified"}
- Main Pain Point: ${brief.mainPainPoint || "Not specified"}
- Product/Service Being Promoted: ${brief.productOrService || coreMessage || "Not specified"}
- Explicit Offer (only use this): ${brief.offerDetails || (offers && offers.length > 0 ? JSON.stringify(offers) : "None — do not invent offers")}
- Preferred CTA: ${brief.preferredCta || ctaStrategy || approvedMessagePack.cta}
- What NOT to say / excluded offers: ${brief.excludedOffers || "None specified"}
- Reference Style / Example: ${brief.referenceStyle || "Not specified"}
- Preferred Content Style: ${brief.contentStyle || "Not specified"}
- Core Message: ${coreMessage || "Not specified"}
- CTA Strategy: ${ctaStrategy || "Not specified"}
- Target Audience: ${brief.targetAudience || "Not specified"}
- Platforms: ${campaign.platforms || "Instagram, Facebook, TikTok, LinkedIn"}
- Location: ${location || "Not specified"}
- Industry: ${industry || "Not specified"}
- Website Evidence (ground truth):
  - Business Category: ${businessEvidence?.businessCategory || industry || "Not specified"}
  - Products/Services Mentioned: ${(businessEvidence?.productsServices || []).join(", ") || "Not specified"}
  - Target Customers Mentioned: ${(businessEvidence?.targetCustomers || []).join(", ") || "Not specified"}
- Personas: ${personas ? JSON.stringify(personas.map((p: any) => ({ name: p.name, painPoints: p.painPoints, goals: p.goals }))) : "General audience"}
${funnelStages ? `- Funnel Stages: ${JSON.stringify(funnelStages.map((f: any) => f.stage))}` : ""}
${strategyContext?.campaignTheme ? `- Campaign Theme: ${strategyContext.campaignTheme}` : ""}
${strategyContext?.platformStrategy ? `- Platform Strategy: ${JSON.stringify(strategyContext.platformStrategy)}` : ""}

PRODUCT EXPERIENCE RULES — YOU MUST FOLLOW THESE EXACTLY:
- Output exactly ONE Master Campaign Post and ONE Master Video Ad as the primary assets.
- Personas guide the message, tone and angle. DO NOT create a separate post for each persona by default.
- DO NOT invent offers, discounts, free trials, limited spots, loyalty programmes, free e-books or lead magnets unless they are explicitly listed in the approved strategy above.
- If the user did not provide an offer, use the CTA from the Approved Message Pack: "${approvedMessagePack.cta}".
- Ground every claim in the approved strategy. Do not invent statistics, testimonials, prices or locations.

COPY QUALITY RULES — YOU MUST FOLLOW THESE EXACTLY:
- NEVER use weak, generic lines like "Join the Trading Revolution", "Explore Unique Experiences", "Join Our Community", "Trade smarter, live greener", "Unlock new possibilities", "Transform your future", "Discover treasures", "Get 20% off", "Limited Spots for Financial Wellness!", "First Month FREE! Make the Switch Now!", "Watch Your Team Flourish Here!", "Hundreds of Businesses Trust Our Solutions!", "Transform your employees' financial futures today!", "Financial health means employee happiness!", "Discover the best", "Unlock your potential" or "Join thousands of satisfied customers".
- Write like a premium agency: specific, grounded, human, confident. Every word must earn its place.
- The Master Campaign Post must lead with ONE clear business-specific idea: the target buyer, their pain point, the product/service solution, and the transformation.
- Front-load the benefit. One clear idea per asset. No vague motivational filler.
- NEVER use placeholders like [Your Business], YourBrandName, [Company], or [Product].
- NEVER use USD, "$100", or dollar amounts unless the campaign explicitly targets the US.
- If the location is in South Africa, use South African Rand (R) only if an offer price exists. Do not invent prices.
- WhatsApp copy must be short and action-focused (under 160 chars if possible).
- LinkedIn copy must be business/professional with clear value proposition.
- TikTok/Reels copy must be punchy, visual, and trend-aware.
- Instagram copy can be slightly longer but must front-load the hook.
- Facebook copy should be conversational and community-oriented.

QUALITY GATE — IF THE OUTPUT CONTAINS ANY OF THE FOLLOWING, IT FAILS:
- Invented discounts or percentages (e.g. "20% off", "50% off", "first month free").
- Generic motivational phrases without business-specific meaning.
- A CTA that does not match the preferred CTA or neutral options above.
- No clear customer pain point addressed.
- No clear transformation promised.
- No connection to the product/service being promoted.
- If the output fails, regenerate until it meets the premium standard.

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
For EACH platform in the campaign (${campaign.platforms || "Instagram, Facebook, TikTok, LinkedIn"}), provide a complete, ready-to-post adaptation. Do not write one-liners. Each adaptation must be a full caption/ message the user can copy and publish.

CRITICAL: Generate an adaptation for EVERY platform listed above. Do not skip any platform. Do not introduce SEO, digital marketing, social media management, data analytics, restaurant services, salon services, or consulting services unless they are explicitly listed in the Website Evidence.

For every platform include:
- Platform name
- Adapted caption (full rewrite for that platform's tone and format)
- Adapted CTA (platform-native, action-driven)
- Adapted hashtags (platform-specific strategy)
- Best time to post for that platform
- Format notes (e.g. character limit, formatting, native features) — use null if not needed

Platform-specific requirements:
- LinkedIn: professional, business-focused. Lead with the buyer's problem or opportunity, include a clear value proposition, keep tone credible. 2-4 short paragraphs.
- Facebook: community and offer-driven. Conversational, warm, easy to read. Lead with the benefit or offer, invite engagement.
- Instagram: visual, short and engaging. Front-load the hook, use line breaks, keep it scannable. Include relevant hashtags.
- WhatsApp: direct and action-focused. Short message (under 160 characters if possible), clear CTA, easy to forward.
- Email: write a real subject line (under 50 chars) plus a short email body (under 120 words) with a clear CTA. Include preheader if useful.
- TikTok: short hook (first line stops the scroll) + caption + CTA. Trend-aware, casual, punchy. Keep caption under 100 characters where possible.

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
  const generationStartedAt = Date.now();

  await assertOwnershipCheckpoint("pre_generation");

  try {
    packResult = await runAgent({
      userId,
      campaignId,
      agentType: "creative",
      prompt: packPrompt,
      schema: PremiumCampaignPackSchema,
      skipBilling: true,
      abortSignal: claimContext?.abortSignal,
      system:
        "You are an elite creative director for a premium marketing agency. You create Hero Campaign Packs: one strong campaign idea expressed as one Master Campaign Post and one Master Video Ad, plus platform adaptations and collapsed supporting assets. You specialise in Instagram Reels, TikTok, Facebook ads, carousel ads, direct-response copywriting, and launch sequences. Every asset must be emotionally engaging, visually specific, platform-native, and conversion-focused. You do not create separate cards for each persona; personas guide tone only. You do not invent offers, discounts, free trials, limited spots or free e-books. If no offer is provided, use neutral CTAs like 'Book a demo' or 'See how it works'. CRITICAL: You must include EVERY key in every object. Use null for fields that do not apply. Never omit a key.",
    });
  } catch (err: any) {
    packError = err.message || String(err);
    logError("[CreativeAgent] schema/generation failure", {
      campaignId,
      userId,
      stage: "generation",
      provider: "openai",
      error: packError,
    });
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The AI provider returned content we could not use. Please retry in a moment.",
    });
  }

  if (!packResult) {
    logError("[CreativeAgent] pack result missing", { campaignId, userId, stage: "generation" });
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Content generation did not return any results. Please retry.",
    });
  }

  timing.creativeGenerationDurationMs = Date.now() - generationStartedAt;
  let activePackRunId = packResult.runId;

  logInfo("[CreativeAgent] pack generated", {
    campaignId,
    userId,
    stage: "generation",
    provider: "openai",
    runId: activePackRunId,
  });

  // Normalise the AI output so missing/undefined fields become safe defaults
  let pack = normalisePremiumPack(packResult.output);

  // Quality gate: check for invented offers and generic copy
  const quality = assessPackQuality(pack, hasExplicitOffer, brief);
  logInfo("[CreativeAgent] cta validation diagnostics", {
    campaignId,
    userId,
    stage: "quality_gate",
    generatedCta: quality.ctaDiagnostics.generatedCta,
    selectedStageCta: quality.ctaDiagnostics.selectedStageCta,
    normalizedGeneratedCta: quality.ctaDiagnostics.normalizedGeneratedCta,
    normalizedSelectedStageCta: quality.ctaDiagnostics.normalizedSelectedStageCta,
    ctaMatches: quality.ctaDiagnostics.ctaMatches,
  });
  const architectQuality = validatePackAgainstArchitect(pack, buildValidationContextFromCampaign(campaign, business));
  const combinedIssues = quality.passed ? architectQuality.issues : [...quality.issues, ...architectQuality.issues];
  const combinedPassed = quality.passed && architectQuality.passed;

  if (!combinedPassed) {
    logWarn("[CreativeAgent] quality gate failed", {
      campaignId,
      userId,
      stage: "quality_gate",
      provider: "openai",
      issues: combinedIssues,
    });
    // One regeneration attempt with stricter instructions and a forced architect rebuild.
    const retryStartedAt = Date.now();
    try {
      approvedMessagePack = await ensureApprovedMessagePack({
        userId,
        campaignId,
        skipBilling: true,
        maxAttempts: 2,
        forceRebuild: true,
        qualityIssues: combinedIssues,
        registry: workflowRegistry,
        operationType: workflowOperationType,
        operationSource: workflowOperationSource,
        operationReferenceId: generationOperation.id,
        attemptOrdinal: nextMessagePackOrdinal(),
      });

      logInfo("[CreativeAgent] recovery pack evaluated", {
        campaignId,
        userId,
        stage: "quality_gate",
        recoveryPackSource: approvedMessagePack.messagePackSource || "unknown",
        fallbackAccepted:
          approvedMessagePack.validation.passed && approvedMessagePack.messagePackSource === "fallback_deterministic",
        fallbackValidationScore: approvedMessagePack.validation.score,
        fallbackValidationRejections: approvedMessagePack.validation.rejections,
      });

      if (!approvedMessagePack.validation.passed) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Recovery message pack failed validation.",
        });
      }

      await saveApprovedMessagePack(userId, campaignId, approvedMessagePack);

      if (approvedMessagePack.messagePackSource === "fallback_deterministic") {
        timing.fallbackDurationMs += Date.now() - retryStartedAt;
      }

      const retryPrompt = `${packPrompt}\n\nUPDATED APPROVED CAMPAIGN MESSAGE PACK (REPLACES PRIOR COPY SOURCE):\n- Headline: ${approvedMessagePack.headline}\n- Subheadline: ${approvedMessagePack.subheadline}\n- Benefit Bullets: ${approvedMessagePack.benefitBullets.join(" | ")}\n- CTA: ${approvedMessagePack.cta}\n- Footer/Contact: ${JSON.stringify(approvedMessagePack.footerContact)}\n- Proof Points: ${(approvedMessagePack.proofPoints || []).join(" | ") || "None"}\n- Platform Captions: ${approvedMessagePack.platformCaptions.map((c) => `${c.platform}: ${c.caption}`).join(" | ")}\n\nPREVIOUS ATTEMPT FAILED QUALITY CHECK. FIX THESE ISSUES AND REGENERATE:\n${combinedIssues.map((i) => `- ${i}`).join("\n")}\n\nDo not invent offers. Do not use generic motivational language. Ground every line in the campaign brief above. The Master Campaign Post must use the UPDATED Approved Message Pack headline and CTA.`;
      logInfo("[CreativeAgent] recovery creative regeneration", {
        campaignId,
        userId,
        stage: "quality_gate",
        creativeRegenerationStarted: true,
        recoveryPackSource: approvedMessagePack.messagePackSource || "unknown",
      });

      await assertOwnershipCheckpoint("pre_recovery_generation");

      const retryResult = await runAgent({
        userId,
        campaignId,
        agentType: "creative",
        prompt: retryPrompt,
        schema: PremiumCampaignPackSchema,
        skipBilling: true,
        abortSignal: claimContext?.abortSignal,
        system:
          "You are an elite creative director. Your previous output was rejected for being generic or inventing offers. Regenerate a tight, premium Hero Campaign Pack that is specific to the business and campaign brief. Do not invent discounts or offers. Use the approved headline and CTA. Every word must earn its place.",
      });
      activePackRunId = retryResult.runId;
      packResult = retryResult;
      logInfo("[CreativeAgent] recovery creative regeneration run", {
        campaignId,
        userId,
        stage: "quality_gate",
        creativeRegenerationRunId: activePackRunId,
      });
      pack = applyApprovedMessagePackToCreativePack(retryResult.output, approvedMessagePack);
      const retryQuality = assessPackQuality(pack, hasExplicitOffer, brief);
      logInfo("[CreativeAgent] cta validation diagnostics", {
        campaignId,
        userId,
        stage: "quality_gate",
        generatedCta: retryQuality.ctaDiagnostics.generatedCta,
        selectedStageCta: retryQuality.ctaDiagnostics.selectedStageCta,
        normalizedGeneratedCta: retryQuality.ctaDiagnostics.normalizedGeneratedCta,
        normalizedSelectedStageCta: retryQuality.ctaDiagnostics.normalizedSelectedStageCta,
        ctaMatches: retryQuality.ctaDiagnostics.ctaMatches,
      });
      const retryArchitectQuality = validatePackAgainstArchitect(pack, buildValidationContextFromCampaign(campaign, business));
      logInfo("[CreativeAgent] recovery creative regeneration validation", {
        campaignId,
        userId,
        stage: "quality_gate",
        creativeRegenerationValidation: {
          passed: retryQuality.passed && retryArchitectQuality.passed,
          issues: [...retryQuality.issues, ...retryArchitectQuality.issues],
        },
      });
      if (!retryQuality.passed || !retryArchitectQuality.passed) {
        const retryIssues = [...retryQuality.issues, ...retryArchitectQuality.issues];
        logError("[CreativeAgent] quality gate failed after retry", {
          campaignId,
          userId,
          stage: "quality_gate",
          provider: "openai",
          issues: retryIssues,
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Generated content did not meet quality standards: ${retryIssues.join("; ")}`,
        });
      }
      timing.qualityRetryDurationMs = Date.now() - retryStartedAt;
    } catch (err: any) {
      timing.qualityRetryDurationMs = Date.now() - retryStartedAt;
      const failMsg = err.message?.includes("Generated content did not meet quality standards")
        ? err.message
        : `Content generation needs to be retried. The first draft did not meet quality standards: ${err.message}`;
      logError("[CreativeAgent] retry generation failed", {
        campaignId,
        userId,
        stage: "quality_gate",
        provider: "openai",
        error: failMsg,
      });
      await markPackRunFailed(failMsg);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: failMsg,
      });
    }
  }

  logInfo("[CreativeAgent] quality gate passed", {
    campaignId,
    userId,
    stage: "quality_gate",
    provider: "openai",
    runId: activePackRunId,
  });

  // Helper to mark the creative run as failed when post-save fails
  async function markPackRunFailed(error: string) {
    try {
      await db
        .update(agentRuns)
        .set({
          status: "failed",
          error,
          completedAt: new Date(),
        })
        .where(eq(agentRuns.id, activePackRunId));
      logInfo("[CreativeAgent] marked run as failed", {
        campaignId,
        userId,
        stage: "post_save",
        runId: activePackRunId,
        error,
      });
    } catch (markErr: any) {
      logError("[CreativeAgent] could not mark run as failed", {
        campaignId,
        userId,
        stage: "post_save",
        runId: activePackRunId,
        error: markErr.message,
      });
    }
  }

  await assertOwnershipCheckpoint("pre_campaign_update");

  // Save pack summary to campaign
  await db
    .update(campaigns)
    .set({
      contentCalendar: {
        packSummary: pack.packSummary,
        generatedAt: new Date().toISOString(),
        creativeRunId: activePackRunId,
      } as any,
      workflowContext: {
        ...(strategyContext || {}),
        creativeGeneratedAt: new Date().toISOString(),
        creativeRunId: activePackRunId,
        premiumPack: true,
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  logInfo("[CreativeAgent] saving pack summary", {
    campaignId,
    userId,
    stage: "post_save",
    provider: "openai",
    runId: activePackRunId,
  });

  // Determine the next campaign iteration number before any deletions occur.
  const existingPostsForIteration = await db
    .select({ metadata: contentPosts.metadata })
    .from(contentPosts)
    .where(eq(contentPosts.campaignId, campaignId));
  const existingAssetsForIteration = await db
    .select({ metadata: campaignAssets.metadata })
    .from(campaignAssets)
    .where(eq(campaignAssets.campaignId, campaignId));
  const allExistingIterations = [
    ...existingPostsForIteration.map((r) => (r.metadata as any)?.iterationNumber),
    ...existingAssetsForIteration.map((r) => (r.metadata as any)?.iterationNumber),
  ].filter((n) => typeof n === "number") as number[];
  const nextIterationNumber = allExistingIterations.length > 0 ? Math.max(...allExistingIterations) + 1 : 1;

  // We intentionally defer old-draft cleanup until new content is safely saved.

  let savedPosts = 0;
  let failedInserts = 0;
  let savedAssets = 0;
  const insertErrors: InsertError[] = [];

  logInfo("[CreativeAgent] inserting posts and assets", {
    campaignId,
    userId,
    stage: "post_save",
    provider: "openai",
    runId: activePackRunId,
  });

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
    metadata: any,
    assetType: string
  ) {
    const safeTitle = sanitizeTitle(title);
    const resolvedType = safeType(type, "social_post");

    try {
      await db.insert(contentPosts).values({
        userId,
        campaignId,
        businessId: campaign.businessId ?? null,
        title: safeTitle,
        type: resolvedType as any,
        platform,
        hook,
        caption,
        cta,
        hashtags: Array.isArray(hashtags) ? hashtags.join(" ") : hashtags,
        visualPrompt,
        status: "draft",
        aiGenerated: true,
        metadata: {
          ...metadata,
          generationRunId: `pack-${activePackRunId}`,
          iterationNumber: nextIterationNumber,
          assetType,
          assetTier: "standard",
          creativeBriefFingerprint: brief.fingerprint,
        },
      });
      savedPosts++;
      logInfo("[CreativeAgent] content post saved", {
        campaignId,
        userId,
        stage: "post_save",
        type: resolvedType,
        title: safeTitle,
      });
    } catch (err: any) {
      failedInserts++;
      const errorDetail = err.message || String(err);
      insertErrors.push({ type: resolvedType, title: safeTitle, error: errorDetail });
      logError("[CreativeAgent] failed to save content post", {
        campaignId,
        userId,
        stage: "post_save",
        type: resolvedType,
        title: safeTitle,
        error: errorDetail,
      });
    }
  }

  await assertOwnershipCheckpoint("pre_post_persistence");

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
      },
      "video_concept"
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
      },
      "leaflet"
    );
  }

  await assertOwnershipCheckpoint("pre_asset_persistence");

  // Save supporting assets as campaign assets (collapsed in the UI), not as primary content posts
  async function insertAsset(title: string, assetType: string, metadata: any) {
    const safeTitle = sanitizeTitle(title);
    try {
      await db.insert(campaignAssets).values({
        userId,
        campaignId,
        assetType: assetType as any,
        title: safeTitle,
        status: "ready",
        metadata: {
          ...metadata,
          generationRunId: `pack-${activePackRunId}`,
          iterationNumber: nextIterationNumber,
          assetType,
          assetTier: "standard",
          creativeBriefFingerprint: brief.fingerprint,
        } as any,
      });
      savedAssets++;
    } catch (err: any) {
      const errorDetail = err.message || String(err);
      insertErrors.push({ type: assetType, title: safeTitle, error: errorDetail });
      logError("[CreativeAgent] failed to save supporting asset", {
        campaignId,
        userId,
        stage: "asset_save",
        assetType,
        title: safeTitle,
        error: errorDetail,
      });
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
          creativeBriefFingerprint: brief.fingerprint,
        } as any,
      });
      savedAssets++;
    } catch (err: any) {
      const errorDetail = err.message || String(err);
      insertErrors.push({ type: "hook_bank", title: "Hook Bank", error: errorDetail });
      logError("[CreativeAgent] failed to save hook bank", {
        campaignId,
        userId,
        stage: "asset_save",
        error: errorDetail,
      });
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
          creativeBriefFingerprint: brief.fingerprint,
        } as any,
      });
      savedAssets++;
    } catch (err: any) {
      const errorDetail = err.message || String(err);
      insertErrors.push({ type: "cta_variation_bank", title: "CTA Variation Bank", error: errorDetail });
      logError("[CreativeAgent] failed to save CTA variation bank", {
        campaignId,
        userId,
        stage: "asset_save",
        error: errorDetail,
      });
    }
  }

  // Ensure every selected campaign platform has an adaptation
  const selectedPlatforms = (campaign.platforms || "Instagram, Facebook, TikTok, LinkedIn")
    .split(/[,;]+/)
    .map((p: string) => p.trim())
    .filter(Boolean);

  const adaptationsByPlatform = new Map<string, any>();
  for (const adaptation of pack.platformAdaptations || []) {
    if (adaptation.platform) {
      adaptationsByPlatform.set(adaptation.platform.toLowerCase(), adaptation);
    }
  }

  const masterPost = pack.socialPosts[0];
  const fallbackCaption = masterPost
    ? `${masterPost.hook}\n\n${masterPost.caption}`
    : "";
  const fallbackCta = masterPost?.cta || campaign.preferredCta || "Contact us";

  for (const platform of selectedPlatforms) {
    const existing = adaptationsByPlatform.get(platform.toLowerCase());
    const adaptation = existing || {
      platform,
      adaptedCaption: fallbackCaption,
      adaptedCta: fallbackCta,
      adaptedHashtags: masterPost?.hashtags || [],
      bestTimeToPost: "",
      formatNotes: `Fallback adaptation for ${platform}.`,
    };

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
          creativeBriefFingerprint: brief.fingerprint,
        } as any,
      });
      savedAssets++;
    } catch (err: any) {
      const errorDetail = err.message || String(err);
      insertErrors.push({ type: "caption_adaptation", title: `${adaptation.platform} Adaptation`, error: errorDetail });
      logError("[CreativeAgent] failed to save platform adaptation", {
        campaignId,
        userId,
        stage: "asset_save",
        platform: adaptation.platform,
        error: errorDetail,
      });
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
          creativeBriefFingerprint: brief.fingerprint,
        } as any,
      });
      savedAssets++;
    } catch (err: any) {
      const errorDetail = err.message || String(err);
      insertErrors.push({ type: "hashtag_set", title: "Master Hashtag Set", error: errorDetail });
      logError("[CreativeAgent] failed to save hashtag set", {
        campaignId,
        userId,
        stage: "asset_save",
        error: errorDetail,
      });
    }
  }

  logInfo("[CreativeAgent] premium pack saved", {
    campaignId,
    userId,
    stage: "post_save",
    savedPosts,
    failedInserts,
    savedAssets,
    insertErrorCount: insertErrors.length,
    recoveryPostsSaved: savedPosts,
  });

  if (savedPosts === 0) {
    const errMsg = `Content generation completed but no posts were saved. failedInserts=${failedInserts}`;
    logError("[CreativeAgent] critical: no posts saved", {
      campaignId,
      userId,
      stage: "post_save",
      savedPosts,
      failedInserts,
      savedAssets,
      insertErrors: insertErrors.slice(0, 10),
    });
    await markPackRunFailed(errMsg);
    const detail = insertErrors.length > 0
      ? `Database save failed: ${insertErrors.map((e) => `[${e.type}] ${e.error}`).join("; ")}`
      : "The AI returned a pack with no usable posts.";
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `The Creative Agent ran but no posts were saved. ${detail}`,
    });
  }

  await assertOwnershipCheckpoint("pre_draft_cleanup");

  if (existingDraftIdsToDelete.length > 0) {
    for (const draftId of existingDraftIdsToDelete) {
      await db.delete(contentPosts).where(eq(contentPosts.id, draftId));
    }

    logInfo("[CreativeAgent] previous drafts cleaned after successful save", {
      campaignId,
      userId,
      stage: "post_save",
      deletedCount: existingDraftIdsToDelete.length,
    });
  }

  await assertOwnershipCheckpoint("pre_billing");

  try {
    await deductCreativeCreditsOnce({
      userId,
      campaignId,
      agentRunId: activePackRunId,
      generationRunId: `pack-${activePackRunId}`,
      generationOperation,
      estimatedCost: estimatedCreativeCost,
    });
  } catch (billingErr: any) {
    const errorMessage = billingErr?.message || "Post-success credit deduction failed.";
    await markPackRunFailed(errorMessage);
    throw new TRPCError({
      code: "PAYMENT_REQUIRED",
      message: errorMessage,
    });
  }

  logInfo("[CreativeAgent] posts and assets inserted", {
    campaignId,
    userId,
    stage: "post_save",
    savedPosts,
    savedAssets,
    failedInserts,
  });

  // Step 2 intentionally disabled to avoid creating duplicate "creative" agent runs
  // that confuse campaign timelines. The primary Hero Campaign Pack already contains
  // the assets required for Content Studio.

  await assertOwnershipCheckpoint("pre_final_campaign_update");

  // Update campaign with final context
  await db
    .update(campaigns)
    .set({
      workflowContext: {
        ...(strategyContext || {}),
        creativeGeneratedAt: new Date().toISOString(),
        creativeRunId: activePackRunId,
        assetsRunId: null,
        assetsGenerationError: null,
        savedPosts,
        failedInserts,
        premiumPack: true,
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  logInfo("[CreativeAgent] supplementary assets saved", {
    campaignId,
    userId,
    stage: "complete",
    savedAssets,
  });

  logInfo("[CreativeAgent] completed", {
    campaignId,
    userId,
    stage: "complete",
    provider: "openai",
    runId: activePackRunId,
    savedPosts,
    savedAssets,
  });

  timing.totalDurationMs = Date.now() - totalStartedAt;

  return {
    packRunId: activePackRunId,
    assetsRunId: null,
    pack,
    assets: null,
    savedPosts,
    savedAssets,
    metrics: timing,
  };
}
