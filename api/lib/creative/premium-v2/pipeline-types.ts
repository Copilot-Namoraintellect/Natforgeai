/**
 * Premium Leaflet Hybrid Pipeline – shared types and Zod schemas.
 *
 * These types describe the strict inputs/outputs of the OpenAI-powered
 * BrandKit resolver, creative brief builder, visual direction planner and
 * vision QA critic. Every schema is designed for OpenAI Structured Outputs:
 * all properties are required (use .nullable() rather than .optional()).
 */

import { z } from "zod";

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

export const BrandKitSchema = z.object({
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
});

export type HybridBrandKit = z.infer<typeof BrandKitSchema>;

export const ServiceItemSchema = z.object({
  name: z.string().describe("Short customer-facing service name, max 4 words"),
  description: z.string().nullable().describe("One-line benefit description, max 12 words"),
  isPrimary: z.boolean().describe("True if this service should appear as a primary card"),
});

export const AICreativeBriefSchema = z.object({
  angle: z.string().describe("Campaign angle in one sentence, customer-facing and benefit-led"),
  headline: z.string().describe("Main leaflet headline, max 12 words, no weak generic phrases"),
  subheadline: z.string().describe("Supporting subheadline, max 25 words, positive outcome focused"),
  primaryServices: z.array(ServiceItemSchema).max(4).describe("Most important services to feature as cards"),
  secondaryServices: z.array(ServiceItemSchema).max(8).describe("Additional services to list in a secondary strip"),
  benefits: z.array(z.string().max(60)).max(3).describe("Three short benefit bullets"),
  cta: z.string().describe("Single clear call-to-action phrase"),
  offerLine: z.string().nullable().describe("Optional promotional offer line, or null"),
});

export type AICreativeBrief = z.infer<typeof AICreativeBriefSchema>;

export const VisualDirectionSchema = z.object({
  layoutPreset: LayoutPresetId.describe("Selected layout preset"),
  density: VisualDensity.describe("How much content to pack into the layout"),
  heroTreatment: HeroTreatment.describe("Hero area visual treatment"),
  backgroundDirection: BackgroundDirection.describe("Background direction for the AI image generator"),
  backgroundPrompt: z.string().describe("Detailed prompt for the text-free background generator"),
  ctaTreatment: CtaTreatment.describe("CTA button style"),
  colourUsageNote: z.string().describe("How to apply primary/secondary/accent colours in the layout"),
});

export type VisualDirection = z.infer<typeof VisualDirectionSchema>;

export const VisionScoreSchema = z.object({
  brandFidelity: z.number().min(0).max(100).describe("How well colours/logo match the brand"),
  readability: z.number().min(0).max(100).describe("Text size, contrast and legibility"),
  premiumFeel: z.number().min(0).max(100).describe("Whether the design feels premium vs cheap/template"),
  visualHierarchy: z.number().min(0).max(100).describe("Headline, services, CTA and footer are clearly ordered"),
  logoUsage: z.number().min(0).max(100).describe("Real logo is present, clear and not distorted"),
  CTAVisibility: z.number().min(0).max(100).describe("CTA is prominent and not clipped"),
  genericTemplateRisk: z.number().min(0).max(100).describe("Higher means more generic/template-looking"),
});

export const VisionCriticResultSchema = z.object({
  scores: VisionScoreSchema,
  passed: z.boolean().describe("True only if all critical checks pass"),
  criticalIssues: z.array(z.string()).describe("Reasons that must block publication"),
  improvementSuggestions: z.array(z.string()).describe("Specific improvements for the next revision"),
  unavailable: z.boolean().optional().describe("Set by the pipeline when the OpenAI vision critic fails"),
  quotaError: z.boolean().optional().describe("True when the critic failed because of an OpenAI quota error"),
});

export type VisionCriticResult = z.infer<typeof VisionCriticResultSchema>;

export type HybridFinalDecision =
  | "premium_ready"
  | "hybrid_review_required"
  | "fallback_used"
  | "failed";

export interface HybridPipelineMetadata {
  provider: string;
  layoutPreset: string;
  width: number;
  height: number;
  usedOpenAIBrandKit: boolean;
  usedOpenAIBrief: boolean;
  usedOpenAIVisualDirection: boolean;
  usedOpenAIBackground: boolean;
  usedOpenAIVisionCritic: boolean;
  usedDeterministicFallback: boolean;
  fallbackReason: string | null;
  quotaError: boolean;
  openAICallCount: number;
  revisionCount: number;
  finalDecision: HybridFinalDecision;
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
}

export interface HybridPipelineInput {
  business: any;
  campaign: any;
  post: any;
  approvedMessagePack?: any;
  refinementInstruction?: string;
  allowNoLogo?: boolean;
}

/** Helper returned by every AI stage so the orchestrator can track what ran. */
export interface WithFallback<T> {
  value: T;
  usedOpenAI: boolean;
  fallbackReason?: string;
}
