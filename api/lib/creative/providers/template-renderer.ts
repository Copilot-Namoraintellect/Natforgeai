/**
 * Provider-backed template renderer abstraction for premium marketing assets.
 *
 * This adapter deliberately separates final layout responsibility from OpenAI.
 * OpenAI may generate hero/background images or refine copy, but the provider
 * template renderer controls the final composed layout.
 */

export type TemplateFormat = "leaflet" | "social_square" | "social_story" | "social_reel";
export type TemplateOutputFormat = "png" | "jpg" | "pdf";

export interface TemplateRendererContact {
  phone?: string;
  whatsapp?: string;
  website?: string;
  email?: string;
  location?: string;
}

export interface TemplateRendererRequest {
  /** Provider-specific template UID (e.g. Bannerbear template_id). */
  providerTemplateId: string;
  /** NatForgeAI template category. */
  format: TemplateFormat;
  /** Desired export format. */
  outputFormat?: TemplateOutputFormat;
  /** Optional aspect ratio hint (e.g. "4:5", "1:1", "9:16"). */
  aspectRatio?: string;
  /** Business / brand name. */
  businessName: string;
  /** Public URL of the uploaded logo. */
  logoUrl: string;
  /** Brand colour hex codes (primary first). */
  brandColors: string[];
  /** Main headline. */
  headline: string;
  /** Offer text. */
  offer: string;
  /** Call to action text. */
  cta: string;
  /** List of services or products. */
  services: string[];
  /** Contact details. */
  contact: TemplateRendererContact;
  /** High-level campaign objective (e.g. "drive foot traffic"). */
  campaignObjective?: string;
  /** Optional creative direction passed through to the provider if supported. */
  creativeGuidance?: string;
  /** Optional OpenAI-generated background/hero image URL. */
  backgroundImageUrl?: string;
}

export interface TemplateRendererResult {
  success: boolean;
  imageUrl?: string;
  imageBase64?: string;
  extension?: string;
  costUsd?: number;
  creditsUsed?: number;
  error?: string;
  providerJobId?: string;
  rawResponse?: any;
}

export interface TemplateRendererProvider {
  name: string;
  configured: boolean;
  render(req: TemplateRendererRequest): Promise<TemplateRendererResult>;
}
