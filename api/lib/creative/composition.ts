/**
 * Deterministic brand overlay for NatForgeAI premium images.
 * Composites the real business logo, name, contact details and CTA onto the
 * AI-generated leaflet/poster background so the output is always on-brand and
 * never contains invented phone numbers, URLs or distorted logos.
 */

import path from "path";
import fs from "fs";
import sharp from "sharp";

export interface BrandOverlaySpec {
  business: any;
  campaign?: any;
  post?: any;
  creativeType?: string;
  offer?: string;
  cta?: string;
  headline?: string;
  subheadline?: string;
}

function sanitize(str?: string | null): string {
  if (!str) return "";
  return str.replace(/\n+/g, " ").trim();
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function pickBrandColor(business: any): string {
  const colors = (business?.brandColors as string[] | undefined) || [];
  const first = colors[0];
  if (first && /^#?[0-9A-Fa-f]{3,8}$/.test(first.trim())) {
    return first.trim().startsWith("#") ? first.trim() : `#${first.trim()}`;
  }
  return "#0F172A"; // slate-900 fallback
}

function resolveLocalPathFromPublicUrl(publicUrl: string): string | null {
  const baseUrl = "http://localhost:3000";
  let pathname = publicUrl;
  if (pathname.startsWith(baseUrl)) {
    pathname = pathname.slice(baseUrl.length);
  }
  if (!pathname.startsWith("/")) return null;

  const publicDir = path.resolve(process.cwd(), "public");
  const prodPublicDir = path.resolve(process.cwd(), "dist/public");
  const relative = pathname.slice(1);
  const devPath = path.join(publicDir, relative);
  const prodPath = path.join(prodPublicDir, relative);
  if (fs.existsSync(devPath)) return devPath;
  if (fs.existsSync(prodPath)) return prodPath;
  return null;
}

async function loadLogoBuffer(logoUrl?: string): Promise<Buffer | null> {
  if (!logoUrl) return null;
  try {
    const localPath = resolveLocalPathFromPublicUrl(logoUrl);
    if (localPath) {
      return fs.readFileSync(localPath);
    }
    const response = await fetch(logoUrl);
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch (err: any) {
    console.warn(`[BrandOverlay] Could not load logo: ${err.message}`);
    return null;
  }
}

function buildHeaderSvg(
  width: number,
  height: number,
  businessName: string,
  brandColor: string
): Buffer {
  const name = escapeXml(sanitize(businessName) || "Your Business");
  const barColor = "#FFFFFF";
  const textColor = "#0F172A";
  const nameSize = Math.max(22, Math.round(width / 20));
  const padX = 24;

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="headerGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:${barColor};stop-opacity:1" />
      <stop offset="85%" style="stop-color:${barColor};stop-opacity:0.98" />
      <stop offset="100%" style="stop-color:${barColor};stop-opacity:0" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#headerGrad)"/>
  <rect x="0" y="${height - 5}" width="${width}" height="5" fill="${brandColor}"/>
  <text x="${width - padX}" y="${height / 2 + nameSize / 3}" font-family="Arial, Helvetica, sans-serif" font-size="${nameSize}" font-weight="700" fill="${textColor}" text-anchor="end">${name}</text>
</svg>`;
  return Buffer.from(svg, "utf-8");
}

function buildFooterSvg(
  width: number,
  height: number,
  lines: string[],
  cta: string,
  brandColor: string
): Buffer {
  const textColor = "#FFFFFF";
  const ctaSize = Math.max(22, Math.round(width / 18));
  const lineSize = Math.max(14, Math.round(width / 34));
  const padX = 28;
  const padY = 20;

  const safeCta = escapeXml(sanitize(cta) || "Contact us today");
  const safeLines = lines.filter(Boolean).map((l) => escapeXml(sanitize(l)));

  const lineBlocks = safeLines
    .map((line, idx) => {
      const y = padY + ctaSize + 22 + (idx + 1) * (lineSize + 9);
      return `<text x="${padX}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${lineSize}" font-weight="400" fill="${textColor}" opacity="0.95">${line}</text>`;
    })
    .join("");

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${brandColor}"/>
  <text x="${padX}" y="${padY + ctaSize}" font-family="Arial, Helvetica, sans-serif" font-size="${ctaSize}" font-weight="800" fill="${textColor}">${safeCta}</text>
  ${lineBlocks}
</svg>`;
  return Buffer.from(svg, "utf-8");
}

function buildHeadlineOverlaySvg(
  width: number,
  height: number,
  headline: string,
  subheadline: string,
  brandColor: string
): Buffer {
  const safeHeadline = escapeXml(sanitize(headline) || "");
  const safeSub = escapeXml(sanitize(subheadline) || "");
  if (!safeHeadline && !safeSub) {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`, "utf-8");
  }

  const headlineSize = Math.max(26, Math.round(width / 14));
  const subSize = Math.max(15, Math.round(width / 26));
  const padX = 28;
  const padY = 24;

  const headlineBlock = safeHeadline
    ? `<text x="${padX}" y="${padY + headlineSize}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineSize}" font-weight="800" fill="#FFFFFF">${safeHeadline}</text>`
    : "";

  const subBlock = safeSub
    ? `<text x="${padX}" y="${padY + headlineSize + (safeHeadline ? 14 : 0) + subSize}" font-family="Arial, Helvetica, sans-serif" font-size="${subSize}" font-weight="500" fill="#FFFFFF" opacity="0.95">${safeSub}</text>`
    : "";

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${brandColor}" opacity="0.82" rx="12"/>
  ${headlineBlock}
  ${subBlock}
</svg>`;
  return Buffer.from(svg, "utf-8");
}

function buildWatermarkSvg(width: number, businessName: string): Buffer {
  const height = 48;
  const name = escapeXml(sanitize(businessName) || "Your Business");
  const size = Math.max(12, Math.round(width / 40));
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="#000000" opacity="0.55"/>
  <text x="${width - 16}" y="${height / 2 + size / 3}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="600" fill="#FFFFFF" text-anchor="end">${name}</text>
</svg>`;
  return Buffer.from(svg, "utf-8");
}

async function resizeLogo(logoBuffer: Buffer, maxHeight: number): Promise<Buffer> {
  return sharp(logoBuffer)
    .resize({ height: maxHeight, fit: sharp.fit.inside, withoutEnlargement: true })
    .png()
    .toBuffer();
}

export async function composeBrandedLeafletImage(
  baseImageBuffer: Buffer,
  spec: BrandOverlaySpec
): Promise<Buffer> {
  const { business, campaign, post, creativeType = "leaflet", offer, cta, headline, subheadline } = spec;

  console.log(`[BrandOverlay] Starting composition | business=${business?.name || "none"} | creativeType=${creativeType} | hasLogo=${!!business?.logo}`);

  const base = sharp(baseImageBuffer);
  const meta = await base.metadata();
  const width = meta.width || 1024;
  const height = meta.height || 1536;

  const brandColor = pickBrandColor(business);
  const businessName = sanitize(business?.name) || sanitize(post?.title) || "Your Business";
  const preferredCta = sanitize(cta || campaign?.preferredCta || post?.cta || "Contact us today");
  const safeOffer = sanitize(offer || campaign?.offerDetails || "");

  const logoBuffer = await loadLogoBuffer(business?.logo);

  if (creativeType !== "leaflet") {
    // Non-leaflet: just add a small branded watermark strip at the bottom.
    const watermarkHeight = 48;
    const watermarkSvg = buildWatermarkSvg(width, businessName);
    const composite = await base
      .composite([
        { input: watermarkSvg, top: height - watermarkHeight, left: 0 },
      ])
      .toBuffer();

    if (!logoBuffer) return composite;

    const logoPng = await resizeLogo(logoBuffer, 40);
    return sharp(composite).composite([{ input: logoPng, top: 12, left: 12 }]).toBuffer();
  }

  // Leaflet layout.
  const headerHeight = Math.round(height * 0.095);
  const footerHeight = Math.round(height * 0.15);
  const logoAreaHeight = headerHeight - 20;

  const headerSvg = buildHeaderSvg(width, headerHeight, businessName, brandColor);

  const contactLines: string[] = [];
  if (business?.whatsappNumber) contactLines.push(`WhatsApp: ${sanitize(business.whatsappNumber)}`);
  if (business?.email) contactLines.push(`Email: ${sanitize(business.email)}`);
  if (business?.website) contactLines.push(`Website: ${sanitize(business.website)}`);
  if (business?.location) contactLines.push(`Location: ${sanitize(business.location)}`);
  if (contactLines.length === 0) contactLines.push("Contact us today");

  const footerLines = safeOffer && !safeOffer.toLowerCase().includes("none")
    ? [`Offer: ${safeOffer}`, ...contactLines]
    : contactLines;

  const footerSvg = buildFooterSvg(width, footerHeight, footerLines, preferredCta, brandColor);

  const overlays: sharp.OverlayOptions[] = [
    { input: headerSvg, top: 0, left: 0 },
    { input: footerSvg, top: height - footerHeight, left: 0 },
  ];

  if (logoBuffer) {
    const logoPng = await resizeLogo(logoBuffer, logoAreaHeight);
    overlays.push({ input: logoPng, top: 14, left: 22 });
  }

  // Optional premium headline band in lower-middle if headline is provided
  const headlineText = sanitize(headline || campaign?.primaryOutcome || post?.title || "");
  const subheadlineText = sanitize(subheadline || campaign?.mainPainPoint || campaign?.coreMessage || post?.hook || "");
  if (headlineText) {
    const bandHeight = Math.round(height * 0.16);
    const bandTop = Math.round(height * 0.56);
    const headlineSvg = buildHeadlineOverlaySvg(width, bandHeight, headlineText, subheadlineText, brandColor);
    overlays.push({ input: headlineSvg, top: bandTop, left: 0 });
  }

  return base.composite(overlays).toBuffer();
}

export async function overlayBusinessLogo(
  baseImageBuffer: Buffer,
  logoUrl: string,
  options: { maxHeight?: number; gravity?: sharp.Gravity } = {}
): Promise<Buffer> {
  const logoBuffer = await loadLogoBuffer(logoUrl);
  if (!logoBuffer) return baseImageBuffer;

  const meta = await sharp(baseImageBuffer).metadata();
  const width = meta.width || 1024;
  const maxHeight = options.maxHeight || Math.round((meta.height || width) * 0.08);

  const logoPng = await resizeLogo(logoBuffer, maxHeight);
  return sharp(baseImageBuffer)
    .composite([{ input: logoPng, gravity: options.gravity || "northwest", top: 16, left: 16 }])
    .toBuffer();
}

export async function overlayContactFooter(
  baseImageBuffer: Buffer,
  business: any,
  cta?: string
): Promise<Buffer> {
  const meta = await sharp(baseImageBuffer).metadata();
  const width = meta.width || 1024;
  const height = meta.height || 1024;
  const footerHeight = Math.round(height * 0.12);
  const brandColor = pickBrandColor(business);

  const lines: string[] = [];
  if (business?.whatsappNumber) lines.push(`WhatsApp: ${sanitize(business.whatsappNumber)}`);
  if (business?.email) lines.push(`Email: ${sanitize(business.email)}`);
  if (business?.website) lines.push(`Website: ${sanitize(business.website)}`);
  if (business?.location) lines.push(`Location: ${sanitize(business.location)}`);
  if (lines.length === 0) lines.push("Contact us today");

  const footerSvg = buildFooterSvg(width, footerHeight, lines, cta || "Contact us today", brandColor);
  return sharp(baseImageBuffer)
    .composite([{ input: footerSvg, top: height - footerHeight, left: 0 }])
    .toBuffer();
}
