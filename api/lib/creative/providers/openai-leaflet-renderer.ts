/**
 * OpenAI-powered premium leaflet renderer.
 *
 * Uses OpenAI to generate a premium, text-free visual background, then
 * deterministically overlays the business logo, headline, offer, CTA and contact
 * details using Sharp. This gives NatForgeAI full control over branding while
 * benefiting from OpenAI's visual composition quality.
 */

import { env } from "../../env";
import { OpenAIImageProvider } from "./openai-image-provider";
import { buildOpenAiLeafletPrompt } from "./openai-leaflet-prompt";
import { composeHybridLeaflet, loadLogoBuffer, type HybridComposerContext } from "./hybrid-leaflet-composer";
import type {
  TemplateRendererProvider,
  TemplateRendererRequest,
  TemplateRendererResult,
} from "./template-renderer";

function randomJobId(): string {
  return `nf-openai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeHex(hex?: string): string {
  if (!hex) return "#111827";
  const trimmed = hex.trim();
  if (trimmed.startsWith("#")) return trimmed;
  return `#${trimmed}`;
}

function pickBrandPalette(brandColors: string[]) {
  const [primaryRaw, secondaryRaw, accentRaw] = brandColors;
  return {
    primary: normalizeHex(primaryRaw),
    secondary: normalizeHex(secondaryRaw || primaryRaw),
    accent: normalizeHex(accentRaw || primaryRaw),
    background: "#0a0f19",
    text: "#ffffff",
  };
}

export class OpenAiLeafletRenderer implements TemplateRendererProvider {
  name = "openai-leaflet";

  get configured(): boolean {
    return !!env.openaiApiKey;
  }

  async render(req: TemplateRendererRequest): Promise<TemplateRendererResult> {
    const jobId = randomJobId();
    console.log(`[OpenAiLeafletRenderer] Rendering | jobId=${jobId} | business=${req.businessName}`);

    if (!this.configured) {
      return {
        success: false,
        error: "OpenAI API key is not configured.",
        providerJobId: jobId,
      };
    }

    const openai = new OpenAIImageProvider();
    const palette = pickBrandPalette(req.brandColors);

    const promptInput = {
      businessName: req.businessName,
      businessCategory: req.campaignObjective,
      productOrService: req.campaignProduct || req.services[0],
      offer: req.campaignOffer || req.offer,
      headline: req.campaignHeadline || req.headline,
      campaignObjective: req.campaignObjective,
      campaignAudience: req.campaignAudience,
      campaignPrimaryService: req.campaignPrimaryService,
      captionPackSummary: req.captionPackSummary,
      brandColors: req.brandColors,
      format: req.format,
      aspectRatio: req.aspectRatio,
      creativeGuidance: req.creativeGuidance,
      visualStyle: req.visualStyle,
      refinementInstruction: req.refinementInstruction,
      isRetry: req.isRetry,
    };

    const { prompt } = buildOpenAiLeafletPrompt(promptInput);

    const imageResult = await openai.generate({
      userId: 0,
      campaignId: undefined,
      businessId: undefined,
      contentPostId: undefined,
      prompt,
      aspectRatio: req.aspectRatio,
      style: req.creativeGuidance,
    });

    if (imageResult.status === "failed" || (!imageResult.imageBase64 && !imageResult.imageUrl)) {
      const errorMessage = imageResult.errorMessage || "OpenAI failed to generate the leaflet background.";
      console.error(`[OpenAiLeafletRenderer] OpenAI generation failed | jobId=${jobId} | error="${errorMessage}"`);
      return {
        success: false,
        error: errorMessage,
        providerJobId: jobId,
        rawResponse: imageResult.rawResponse,
      };
    }

    try {
      const backgroundBuffer = imageResult.imageBase64
        ? Buffer.from(imageResult.imageBase64, "base64")
        : Buffer.from(await (await fetch(imageResult.imageUrl!)).arrayBuffer());

      const hasLogo = !!(await loadLogoBuffer(req.logoUrl));

      const composerCtx: HybridComposerContext = {
        width: 1080,
        height: 1350,
        businessName: req.businessName,
        logoUrl: req.logoUrl,
        brandColors: palette,
        headline: req.campaignHeadline || req.headline,
        offer: req.campaignOffer || req.offer,
        subheadline: req.subheadline,
        cta: req.cta,
        services: req.services.slice(0, 4),
        contact: req.contact,
        campaignProduct: req.campaignProduct,
        campaignOffer: req.campaignOffer,
        campaignHeadline: req.campaignHeadline,
        campaignAudience: req.campaignAudience,
        campaignPrimaryService: req.campaignPrimaryService,
        captionPackSummary: req.captionPackSummary,
      };

      const finalBuffer = await composeHybridLeaflet(backgroundBuffer, composerCtx);

      // Best-effort cost extraction from OpenAI response.
      const raw = imageResult.rawResponse || {};
      const costUsd =
        typeof raw.cost?.total === "number"
          ? raw.cost.total
          : typeof raw.usage?.total_tokens === "number"
          ? raw.usage.total_tokens * 0.00001
          : 0;

      console.log(`[OpenAiLeafletRenderer] Render succeeded | jobId=${jobId} | bytes=${finalBuffer.length} | hasLogo=${hasLogo}`);

      return {
        success: true,
        imageBase64: finalBuffer.toString("base64"),
        extension: "png",
        providerJobId: imageResult.providerJobId || jobId,
        creditsUsed: 0,
        costUsd,
        rawResponse: { prompt, backgroundBase64: backgroundBuffer.toString("base64"), imageResultRaw: raw },
      };
    } catch (err: any) {
      console.error(`[OpenAiLeafletRenderer] Composition failed | jobId=${jobId} | error="${err.message}"`);
      return {
        success: false,
        error: err.message || "Failed to compose the final leaflet.",
        providerJobId: jobId,
      };
    }
  }
}
