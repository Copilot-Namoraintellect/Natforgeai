/**
 * Premium Leaflet Hybrid Pipeline – shared types and Zod schemas.
 *
 * These types describe the strict inputs/outputs of the OpenAI-powered
 * BrandKit resolver, creative brief builder, visual direction planner and
 * vision QA critic. Every schema is designed for OpenAI Structured Outputs:
 * all properties are required (use .nullable() rather than .optional()).
 */

import { z } from "zod";
import type { BrandAssetResolution } from "../brand-asset-resolver";

export const LayoutPresetId = z.enum([
  "premium_services_brand_panel",
  "premium_local_service",
  "premium_offer_hero",
  "premium_retail_promo",
  "premium_food_offer",
  "premium_professional_clean",
]);

export const HeroTreatment = z.enum([
  "solid_brand_block",
  "gradient_abstract",
  "photo_left_split",
  "photo_full_bleed",
  "shape_accent",
  "minimal_centered",
]);

export const CtaTreatment = z.enum([
  "solid_button",
  "rounded_pill",
  "outline_button",
  "block_banner",
]);

export const BackgroundDirection = z.enum([
  "abstract_brand_gradient",
  "soft_noise_texture",
  "geometric_shapes",
  "photographic_hero",
  "clean_white",
  "dark_premium",
]);

export const VisualDensity = z.enum(["minimal", "balanced", "dense"]);

/**
 * OpenAI-compatible BrandKit schema.
 * Does NOT include `brandAsset`; that internal metadata is injected after the
 * structured-output call so OpenAI never has to emit an unconstrained object.
 */
export const BrandKitOpenAISchema = z
  .object({
    primary: z.string().describe("Primary brand colour as 6-digit hex, e.g. #0047AB"),
    secondary: z.string().describe("Secondary/support colour as 6-digit hex"),
    accent: z.string().describe("Accent/action colour as 6-digit hex, used for CTA and highlights"),
    background: z.string().describe("Page background colour as 6-digit hex"),
    text: z.string().describe("Primary text colour as 6-digit hex"),
    textMuted: z.string().describe("Muted/secondary text colour as 6-digit hex"),
    source: z.enum(["logo", "brandColors", "websiteEvidence", "default"]).describe("Where the palette came from"),
    logoUrl: z.string().nullable().describe("Validated logo URL or null if unavailable"),
    logoDescription: z.string().nullable().describe("Short description of the logo from vision analysis"),
    typographyNote: z.string().nullable().describe("Optional note on brand typography preference"),
  })
  .strict()
  .describe("Brand kit for the leaflet");

/** Runtime BrandKit including the internal brand-asset resolution object. */
export type HybridBrandKit = z.infer<typeof BrandKitOpenAISchema> & { brandAsset?: BrandAssetResolution };

export const ServiceItemSchema = z
  .object({
    name: z.string().describe("Short customer-facing service name, max 4 words"),
    description: z.string().nullable().describe("One-line benefit description, max 12 words"),
    isPrimary: z.boolean().describe("True if this service should appear as a primary card"),
  })
  .strict();

export const AICreativeBriefSchema = z
  .object({
    angle: z.string().describe("Campaign angle in one sentence, customer-facing and benefit-led"),
    headline: z.string().describe("Main leaflet headline, max 12 words, no weak generic phrases"),
    subheadline: z.string().describe("Supporting subheadline, max 25 words, positive outcome focused"),
    primaryServices: z.array(ServiceItemSchema).max(4).describe("Most important services to feature as cards"),
    secondaryServices: z.array(ServiceItemSchema).max(8).describe("Additional services to list in a secondary strip"),
    benefits: z.array(z.string().max(60)).max(3).describe("Three short benefit bullets"),
    cta: z.string().describe("Single clear call-to-action phrase"),
    offerLine: z.string().nullable().describe("Optional promotional offer line, or null"),
  })
  .strict()
  .describe("Customer-facing creative brief");

export type AICreativeBrief = z.infer<typeof AICreativeBriefSchema>;

export const VisualDirectionSchema = z
  .object({
    layoutPreset: LayoutPresetId.describe("Selected layout preset"),
    density: VisualDensity.describe("How much content to pack into the layout"),
    heroTreatment: HeroTreatment.describe("Hero area visual treatment"),
    backgroundDirection: BackgroundDirection.describe("Background direction for the AI image generator"),
    backgroundPrompt: z.string().describe("Detailed prompt for the text-free background generator"),
    ctaTreatment: CtaTreatment.describe("CTA button style"),
    colourUsageNote: z.string().describe("How to apply primary/secondary/accent colours in the layout"),
  })
  .strict()
  .describe("Visual direction for the leaflet");

export type VisualDirection = z.infer<typeof VisualDirectionSchema>;

export const CreativePlanOpenAISchema = z
  .object({
    brandKit: BrandKitOpenAISchema,
    brief: AICreativeBriefSchema,
    visualDirection: VisualDirectionSchema,
  })
  .strict()
  .describe("Complete creative plan for the leaflet");

export type CreativePlan = z.infer<typeof CreativePlanOpenAISchema> & {
  brandKit: { brandAsset?: BrandAssetResolution };
};

export const VisionScoreSchema = z
  .object({
    brandFidelity: z.number().min(0).max(100).describe("How well colours/logo match the brand"),
    readability: z.number().min(0).max(100).describe("Text size, contrast and legibility"),
    premiumFeel: z.number().min(0).max(100).describe("Whether the design feels premium vs cheap/template"),
    visualHierarchy: z.number().min(0).max(100).describe("Headline, services, CTA and footer are clearly ordered"),
    logoUsage: z.number().min(0).max(100).describe("Real logo is present, clear and not distorted"),
    CTAVisibility: z.number().min(0).max(100).describe("CTA is prominent and not clipped"),
    genericTemplateRisk: z.number().min(0).max(100).describe("Higher means more generic/template-looking"),
  })
  .strict();

export const VisionCriticResultSchema = z
  .object({
    scores: VisionScoreSchema,
    passed: z.boolean().describe("True only if all critical checks pass"),
    criticalIssues: z.array(z.string()).describe("Reasons that must block publication"),
    improvementSuggestions: z.array(z.string()).describe("Specific improvements for the next revision"),
    unavailable: z.boolean().describe("Always false for a real critic result; pipeline sets true when OpenAI fails"),
    quotaError: z.boolean().describe("Always false for a real critic result; pipeline sets true when OpenAI quota is exceeded"),
    realLogoPresent: z.boolean().describe("Whether the rendered leaflet shows a real logo (not a fallback badge)"),
    logoMatchesBrand: z.boolean().describe("Whether the logo appears to match the expected business/brand"),
    fallbackBadgeUsed: z.boolean().describe("Whether a fallback monogram/badge is used instead of the real logo"),
    logoDistortedOrCropped: z.boolean().describe("Whether the logo is distorted, cropped, or too small to read"),
    brandFidelityPassed: z.boolean().describe("Whether brand fidelity should pass overall"),
  })
  .strict()
  .describe("Vision critic scorecard");

export type VisionCriticResult = z.infer<typeof VisionCriticResultSchema>;

export type HybridFinalDecision =
  | "premium_ready"
  | "hybrid_review_required"
  | "fallback_used"
  | "failed";

export interface HybridPipelineAttempt {
  buffer: Buffer;
  critic: VisionCriticResult;
  visualDirection: VisualDirection;
}

export interface HybridPipelineMetadata {
  provider: string;
  layoutPreset: string;
  width: number;
  height: number;
  attemptedOpenAIBrandKit: boolean;
  succeededOpenAIBrandKit: boolean;
  attemptedOpenAIBrief: boolean;
  succeededOpenAIBrief: boolean;
  attemptedOpenAIVisualDirection: boolean;
  succeededOpenAIVisualDirection: boolean;
  attemptedOpenAIBackground: boolean;
  succeededOpenAIBackground: boolean;
  finalUsedOpenAIBackground: boolean;
  attemptedOpenAIVisionCritic: boolean;
  succeededOpenAIVisionCritic: boolean;
  finalUsedOpenAIVisionCritic: boolean;
  usedDeterministicFallback: boolean;
  fallbackReason: string | null;
  quotaError: boolean;
  openAICallCount: number;
  revisionCount: number;
  finalDecision: HybridFinalDecision;
  rejectionCritic: VisionCriticResult | null;
  // Brand-asset render diagnostics
  realLogoExpected?: boolean;
  realLogoRendered?: boolean;
  logoNaturalWidth?: number;
  logoNaturalHeight?: number;
  logoRenderedWidth?: number;
  logoRenderedHeight?: number;
  logoVisibleArea?: number;
  logoRenderMode?: "image" | "fallback_badge";
  fallbackBadgeRendered?: boolean;
  logoMaskedOrCropped?: boolean;
  logoDataUriUsed?: boolean;
  logoFetchUsed?: boolean;
}

export interface HybridPipelineResult {
  buffer: Buffer;
  brandKit: HybridBrandKit;
  brief: AICreativeBrief;
  visualDirection: VisualDirection;
  critic: VisionCriticResult;
  revisionCount: number;
  usedFallback: boolean;
  metadata: HybridPipelineMetadata;
  attempts?: HybridPipelineAttempt[];
}

export interface HybridPipelineInput {
  business: any;
  campaign: any;
  post: any;
  approvedMessagePack?: any;
  refinementInstruction?: string;
  allowNoLogo?: boolean;
  sampleMode?: boolean;
}

/** Helper returned by every AI stage so the orchestrator can track what ran. */
export interface WithFallback<T> {
  value: T;
  usedOpenAI: boolean;
  fallbackReason?: string;
}
