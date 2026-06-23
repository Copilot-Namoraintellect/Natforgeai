import path from "path";
import fs from "fs";
import type {
  TemplateRendererProvider,
  TemplateRendererRequest,
  TemplateRendererResult,
} from "./template-renderer";
import { resolveBrandPalette } from "../brand-palette";
import { getBestTemplateForCampaign, getPremiumTemplate, type PremiumTemplateId } from "../template-catalogue";
import { getInternalTemplateLayout } from "../internal-templates/layouts";
import type { InternalTemplateRenderContext } from "../internal-templates/types";

function randomJobId(): string {
  return `nf-internal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveLocalPathFromPublicUrl(publicUrl: string): string | null {
  const baseUrl = "http://localhost:3000";
  let pathname = publicUrl;
  if (pathname.startsWith(baseUrl)) {
    pathname = pathname.slice(baseUrl.length);
  }
  if (pathname.startsWith("http://") || pathname.startsWith("https://")) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return null;
    }
  }
  if (!pathname.startsWith("/")) return null;

  const publicDir = path.resolve(process.cwd(), "public");
  const prodPublicDir = path.resolve(process.cwd(), "dist/public");
  const persistentUploadsDir = path.resolve(process.cwd(), "data/public/uploads");
  const relative = pathname.slice(1);
  const devPath = path.join(publicDir, relative);
  const prodPath = path.join(prodPublicDir, relative);
  const persistentRelative = relative.replace(/^uploads[\\/]/, "");
  const persistentPath = path.join(persistentUploadsDir, persistentRelative);
  if (fs.existsSync(devPath)) return devPath;
  if (fs.existsSync(prodPath)) return prodPath;
  if (fs.existsSync(persistentPath)) return persistentPath;
  return null;
}

async function loadLogoBuffer(logoUrl?: string): Promise<Buffer | null> {
  if (!logoUrl) return null;
  try {
    const localPath = resolveLocalPathFromPublicUrl(logoUrl);
    if (localPath) {
      return fs.readFileSync(localPath);
    }

    let fetchUrl = logoUrl;
    if (fetchUrl.startsWith("/")) {
      const backendPort = process.env.PORT || "3001";
      fetchUrl = `http://127.0.0.1:${backendPort}${fetchUrl}`;
    }
    const response = await fetch(fetchUrl);
    if (!response.ok) {
      console.warn(`[InternalTemplateRenderer] Logo fetch failed | status=${response.status} | url=${fetchUrl}`);
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (err: any) {
    console.warn(`[InternalTemplateRenderer] Could not load logo: ${err.message}`);
    return null;
  }
}

export class InternalTemplateRenderer implements TemplateRendererProvider {
  name = "internal-template";
  configured = true;

  async render(req: TemplateRendererRequest): Promise<TemplateRendererResult> {
    const jobId = randomJobId();
    console.log(`[InternalTemplateRenderer] Rendering | jobId=${jobId} | template=${req.providerTemplateId} | format=${req.format}`);

    try {
      const templateId = (req.providerTemplateId as PremiumTemplateId) || "service_business_promo";
      const layout = getInternalTemplateLayout(templateId);
      if (!layout) {
        return {
          success: false,
          error: `Unknown internal template: ${req.providerTemplateId}`,
          providerJobId: jobId,
        };
      }

      const template = getPremiumTemplate(templateId);
      const aspectRatio = req.aspectRatio || template?.aspectRatios[req.format] || "4:5";
      const [wRatio, hRatio] = aspectRatio.split(":").map((n) => parseInt(n, 10));
      const width = 1080;
      const height = Math.round((width / (wRatio || 4)) * (hRatio || 5));

      const brandPalette = await resolveBrandPalette({
        brandColors: req.brandColors,
        business: { name: req.businessName },
      });

      const logoBuffer = await loadLogoBuffer(req.logoUrl);

      const ctx: InternalTemplateRenderContext = {
        templateId,
        width,
        height,
        businessName: req.businessName,
        logoBuffer,
        brandPalette,
        headline: req.headline,
        offer: req.offer,
        subheadline: req.subheadline,
        cta: req.cta,
        services: req.services.slice(0, 4),
        contact: {
          phone: req.contact.phone,
          whatsapp: req.contact.whatsapp,
          website: req.contact.website,
          email: req.contact.email,
          location: req.contact.location,
        },
      };

      const buffer = await layout.render(ctx);

      console.log(`[InternalTemplateRenderer] Render succeeded | jobId=${jobId} | bytes=${buffer.length}`);

      return {
        success: true,
        imageBase64: buffer.toString("base64"),
        extension: "png",
        providerJobId: jobId,
        creditsUsed: 0,
        rawResponse: { templateId, width, height, aspectRatio },
      };
    } catch (err: any) {
      console.error(`[InternalTemplateRenderer] Render failed | jobId=${jobId} | error=${err.message}`);
      return {
        success: false,
        error: err.message || "Internal template render failed",
        providerJobId: jobId,
      };
    }
  }
}

export { getBestTemplateForCampaign };
