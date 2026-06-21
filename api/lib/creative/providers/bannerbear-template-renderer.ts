import { env } from "../../env";
import type { TemplateRendererProvider, TemplateRendererRequest, TemplateRendererResult } from "./template-renderer";

export const BANNERBEAR_API_BASE = "https://api.bannerbear.com/v2";

interface BannerbearModification {
  name: string;
  text?: string;
  image_url?: string;
  color?: string;
  visible?: "true" | "false";
}

/**
 * Map NatForgeAI copy fields to sensible Bannerbear layer names.
 *
 * Templates created in Bannerbear should use these layer names for automatic
 * population. Additional layers with matching names will also be populated if
 * present; unknown layers are ignored by Bannerbear by default.
 */
function buildModifications(req: TemplateRendererRequest): BannerbearModification[] {
  const modifications: BannerbearModification[] = [
    { name: "business_name", text: req.businessName },
    { name: "headline", text: req.headline },
    { name: "offer", text: req.offer },
    { name: "cta", text: req.cta },
    { name: "logo", image_url: req.logoUrl },
  ];

  if (req.brandColors[0]) {
    modifications.push({ name: "primary_color", color: req.brandColors[0] });
  }
  if (req.brandColors[1]) {
    modifications.push({ name: "secondary_color", color: req.brandColors[1] });
  }
  if (req.brandColors[2]) {
    modifications.push({ name: "accent_color", color: req.brandColors[2] });
  }

  // Services / products are mapped to individually named layers. Providers that
  // support dynamic arrays can extend this later; for Bannerbear we target a
  // fixed set of service layers.
  req.services.slice(0, 6).forEach((service, idx) => {
    modifications.push({ name: `service_${idx + 1}`, text: service });
  });

  if (req.contact.website) {
    modifications.push({ name: "website", text: req.contact.website });
  }
  if (req.contact.phone) {
    modifications.push({ name: "phone", text: req.contact.phone });
  }
  if (req.contact.whatsapp) {
    modifications.push({ name: "whatsapp", text: req.contact.whatsapp });
  }
  if (req.contact.email) {
    modifications.push({ name: "email", text: req.contact.email });
  }
  if (req.contact.location) {
    modifications.push({ name: "location", text: req.contact.location });
  }
  if (req.campaignObjective) {
    modifications.push({ name: "objective", text: req.campaignObjective });
  }
  if (req.creativeGuidance) {
    modifications.push({ name: "creative_guidance", text: req.creativeGuidance });
  }
  if (req.backgroundImageUrl) {
    modifications.push({ name: "background_image", image_url: req.backgroundImageUrl });
  }

  return modifications.filter((m) => m.text !== undefined || m.image_url !== undefined || m.color !== undefined);
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

export class BannerbearTemplateRenderer implements TemplateRendererProvider {
  name = "bannerbear";

  get configured(): boolean {
    return !!env.bannerbearApiKey;
  }

  async render(req: TemplateRendererRequest): Promise<TemplateRendererResult> {
    if (!this.configured) {
      return {
        success: false,
        error: "Bannerbear is not configured. Add BANNERBEAR_API_KEY to enable premium template rendering.",
      };
    }

    const jobId = `bb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[BannerbearTemplateRenderer] Rendering | jobId=${jobId} | template=${req.providerTemplateId} | format=${req.format}`);

    try {
      const response = await fetch(`${BANNERBEAR_API_BASE}/images`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.bannerbearApiKey}`,
        },
        body: JSON.stringify({
          template: req.providerTemplateId,
          modifications: buildModifications(req),
          transparent: false,
          render_pdf: req.outputFormat === "pdf",
          // Bannerbear's webhook URL can be configured later for async renders.
          // For the pilot we poll synchronously via the response.
        }),
      });

      const rawResponse = (await response.json().catch(async () => ({}))) as any;

      if (!response.ok) {
        const errorDetail = rawResponse?.message || rawResponse?.error?.message || JSON.stringify(rawResponse);
        console.error(`[BannerbearTemplateRenderer] Render failed | jobId=${jobId} | status=${response.status} | error="${errorDetail}"`);
        return {
          success: false,
          error: `Bannerbear render failed (${response.status}): ${errorDetail}`,
          providerJobId: jobId,
          rawResponse,
        };
      }

      const imageUrl = rawResponse?.image_url as string | undefined;
      const imageUrlPng = rawResponse?.image_url_png as string | undefined;
      const pdfUrl = rawResponse?.pdf_url as string | undefined;
      const finalUrl = pdfUrl || imageUrlPng || imageUrl;

      if (!finalUrl) {
        console.error(`[BannerbearTemplateRenderer] No output URL | jobId=${jobId} | keys=${Object.keys(rawResponse).join(",")}`);
        return {
          success: false,
          error: "Bannerbear returned no image URL",
          providerJobId: jobId,
          rawResponse,
        };
      }

      console.log(`[BannerbearTemplateRenderer] Render succeeded | jobId=${jobId} | url=${finalUrl}`);

      return {
        success: true,
        imageUrl: finalUrl,
        extension: req.outputFormat === "pdf" ? "pdf" : mapOutputFormat(req.outputFormat),
        costUsd: 0.049, // Bannerbear Automate plan ≈ $0.049 per image; update when actual usage data is available
        providerJobId: rawResponse?.uid || jobId,
        rawResponse,
      };
    } catch (err: any) {
      console.error(`[BannerbearTemplateRenderer] Request exception | jobId=${jobId} | error="${err.message}"`);
      return {
        success: false,
        error: err.message || "Bannerbear render request failed",
        providerJobId: jobId,
      };
    }
  }
}
