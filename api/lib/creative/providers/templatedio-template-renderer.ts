import { env } from "../../env";
import type { TemplateRendererProvider, TemplateRendererRequest, TemplateRendererResult } from "./template-renderer";

export const TEMPLATED_IO_API_BASE = "https://api.templated.io/v1";

interface TemplatedIoLayer {
  text?: string;
  image_url?: string;
  color?: string;
  visible?: boolean;
}

function buildLayers(req: TemplateRendererRequest): Record<string, TemplatedIoLayer> {
  const layers: Record<string, TemplatedIoLayer> = {
    business_name: { text: req.businessName },
    headline: { text: req.headline },
    offer: { text: req.offer },
    cta: { text: req.cta },
    logo: { image_url: req.logoUrl },
  };

  if (req.brandColors[0]) layers.primary_color = { color: req.brandColors[0] };
  if (req.brandColors[1]) layers.secondary_color = { color: req.brandColors[1] };
  if (req.brandColors[2]) layers.accent_color = { color: req.brandColors[2] };

  req.services.slice(0, 6).forEach((service, idx) => {
    layers[`service_${idx + 1}`] = { text: service };
  });

  if (req.contact.website) layers.website = { text: req.contact.website };
  if (req.contact.phone) layers.phone = { text: req.contact.phone };
  if (req.contact.whatsapp) layers.whatsapp = { text: req.contact.whatsapp };
  if (req.contact.email) layers.email = { text: req.contact.email };
  if (req.contact.location) layers.location = { text: req.contact.location };
  if (req.campaignObjective) layers.objective = { text: req.campaignObjective };
  if (req.creativeGuidance) layers.creative_guidance = { text: req.creativeGuidance };
  if (req.backgroundImageUrl) layers.background_image = { image_url: req.backgroundImageUrl };

  return layers;
}

function mapOutputFormat(format?: TemplateRendererRequest["outputFormat"]): "jpg" | "png" | "pdf" {
  switch (format) {
    case "jpg":
      return "jpg";
    case "pdf":
      return "pdf";
    case "png":
    default:
      return "png";
  }
}

export class TemplatedIoTemplateRenderer implements TemplateRendererProvider {
  name = "templatedio";

  get configured(): boolean {
    return !!env.templatedIoApiKey;
  }

  async render(req: TemplateRendererRequest): Promise<TemplateRendererResult> {
    if (!this.configured) {
      return {
        success: false,
        error: "Templated.io is not configured. Add TEMPLATED_IO_API_KEY to enable premium template rendering.",
      };
    }

    const jobId = `tio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[TemplatedIoTemplateRenderer] Rendering | jobId=${jobId} | template=${req.providerTemplateId} | format=${req.format}`);

    try {
      const response = await fetch(`${TEMPLATED_IO_API_BASE}/render`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.templatedIoApiKey}`,
        },
        body: JSON.stringify({
          template: req.providerTemplateId,
          layers: buildLayers(req),
          format: mapOutputFormat(req.outputFormat),
        }),
      });

      const rawResponse = (await response.json().catch(async () => ({}))) as any;

      if (!response.ok) {
        const errorDetail = rawResponse?.message || rawResponse?.error?.message || JSON.stringify(rawResponse);
        console.error(`[TemplatedIoTemplateRenderer] Render failed | jobId=${jobId} | status=${response.status} | error="${errorDetail}"`);
        return {
          success: false,
          error: `Templated.io render failed (${response.status}): ${errorDetail}`,
          providerJobId: jobId,
          rawResponse,
        };
      }

      const imageUrl = rawResponse?.url as string | undefined;
      if (!imageUrl) {
        console.error(`[TemplatedIoTemplateRenderer] No output URL | jobId=${jobId} | keys=${Object.keys(rawResponse).join(",")}`);
        return {
          success: false,
          error: "Templated.io returned no image URL",
          providerJobId: jobId,
          rawResponse,
        };
      }

      console.log(`[TemplatedIoTemplateRenderer] Render succeeded | jobId=${jobId} | url=${imageUrl}`);

      return {
        success: true,
        imageUrl,
        extension: mapOutputFormat(req.outputFormat),
        costUsd: 0.029, // Templated.io ≈ $0.029 per render; update with actual plan pricing
        providerJobId: rawResponse?.id || jobId,
        rawResponse,
      };
    } catch (err: any) {
      console.error(`[TemplatedIoTemplateRenderer] Request exception | jobId=${jobId} | error="${err.message}"`);
      return {
        success: false,
        error: err.message || "Templated.io render request failed",
        providerJobId: jobId,
      };
    }
  }
}
