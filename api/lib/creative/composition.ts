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
  serviceBullets?: string[];
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

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [text];
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
  const persistentUploadsDir = path.resolve(process.cwd(), "data/public/uploads");
  const relative = pathname.slice(1);
  const devPath = path.join(publicDir, relative);
  const prodPath = path.join(prodPublicDir, relative);
  const persistentPath = path.join(persistentUploadsDir, relative);
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
  const padY = 22;
  const maxChars = Math.max(20, Math.round((width - padX * 2) / (headlineSize * 0.55)));
  const subMaxChars = Math.max(30, Math.round((width - padX * 2) / (subSize * 0.55)));

  const headlineLines = safeHeadline ? wrapText(safeHeadline, maxChars) : [];
  const subLines = safeSub ? wrapText(safeSub, subMaxChars) : [];

  const headlineLineHeight = headlineSize + 8;
  const subLineHeight = subSize + 8;
  const headlineBlocks = headlineLines.map((line, i) =>
    `<text x="${padX}" y="${padY + headlineSize + i * headlineLineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineSize}" font-weight="800" fill="#FFFFFF">${line}</text>`
  ).join("");

  const subYOffset = padY + headlineSize + (headlineLines.length * headlineLineHeight) + (headlineLines.length ? 10 : 0);
  const subBlocks = subLines.map((line, i) =>
    `<text x="${padX}" y="${subYOffset + subSize + i * subLineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${subSize}" font-weight="500" fill="#FFFFFF" opacity="0.95">${line}</text>`
  ).join("");

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${brandColor}" opacity="0.82" rx="12"/>
  ${headlineBlocks}
  ${subBlocks}
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

// ─── Deterministic fallback leaflet renderer ───

function inferServiceCategory(business: any, campaign: any): string {
  const combined = `${business?.name || ""} ${business?.industry || ""} ${business?.productOrService || ""} ${campaign?.productOrService || ""} ${JSON.stringify(business?.websiteEvidence || {})}`.toLowerCase();
  if (combined.includes("print") || combined.includes("copy") || combined.includes("courier") || combined.includes("business card") || combined.includes("flyer") || combined.includes("poster") || combined.includes("banner")) {
    return "print_shop";
  }
  if (
    combined.includes("canvas") ||
    combined.includes("framed poster") ||
    combined.includes("wall art") ||
    combined.includes("art print") ||
    combined.includes("afrocentric") ||
    combined.includes("home decor") ||
    combined.includes("office decor") ||
    combined.includes("interior decor")
  ) {
    return "art_decor";
  }
  return "general";
}

function defaultServiceBullets(business: any, campaign: any): string[] {
  const category = inferServiceCategory(business, campaign);
  if (category === "print_shop") {
    return [
      "Business Cards & Stationery",
      "Flyers, Posters & Banners",
      "Canvas & Photo Prints",
      "Document Copying & Binding",
      "Courier & Delivery",
      "Branding & Design Support",
    ];
  }
  if (category === "art_decor") {
    return [
      "Custom Canvas Prints",
      "Framed Posters",
      "Afrocentric Wall Art",
      "Home & Office Décor",
      "Premium Quality Materials",
      "Ready to Hang",
    ];
  }
  return [
    "Professional Quality",
    "Fast Turnaround",
    "Easy to Order",
    "Customer Support",
  ];
}

function buildBulletSvg(width: number, bullets: string[], brandColor: string): Buffer {
  const padX = 32;
  const padY = 28;
  const bulletSize = 14;
  const lineSize = Math.max(18, Math.round(width / 46));
  const lineHeight = lineSize + 18;
  const maxChars = Math.max(30, Math.round((width - padX * 2 - 32) / (lineSize * 0.55)));

  let y = padY + lineSize;
  const blocks: string[] = [];
  for (const bullet of bullets) {
    const safeBullet = escapeXml(sanitize(bullet));
    const lines = wrapText(safeBullet, maxChars);
    blocks.push(`<circle cx="${padX + 6}" cy="${y - lineSize / 3}" r="${bulletSize / 2}" fill="${brandColor}"/>`);
    for (let i = 0; i < lines.length; i++) {
      blocks.push(`<text x="${padX + 24}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${lineSize}" font-weight="600" fill="#0F172A">${lines[i]}</text>`);
      y += lineHeight;
    }
    y += 8;
  }

  const height = y + padY - lineHeight;
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="#FFFFFF" opacity="0.92" rx="14"/>
  ${blocks.join("\n")}
</svg>`;
  return Buffer.from(svg, "utf-8");
}

function buildFallbackBackgroundSvg(width: number, height: number, brandColor: string): Buffer {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:${brandColor};stop-opacity:0.12" />
      <stop offset="45%" style="stop-color:#FFFFFF;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#F1F5F9;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bgGrad)"/>
  <rect x="0" y="0" width="${width}" height="12" fill="${brandColor}"/>
</svg>`;
  return Buffer.from(svg, "utf-8");
}

/**
 * Render a clean, deterministic branded leaflet when AI generation or quality
 * validation cannot produce a usable image. The output is always on-brand and
 * never contains invented contact details.
 */
export async function generateFallbackLeafletImage(spec: BrandOverlaySpec): Promise<Buffer> {
  const { business, campaign, post, creativeType = "leaflet", offer, cta, headline, subheadline, serviceBullets } = spec;

  const width = 1080;
  const isSquare = creativeType === "poster" || creativeType === "offer_advert" || creativeType === "event_announcement";
  const height = isSquare ? 1080 : 1350;

  const brandColor = pickBrandColor(business);
  const businessName = sanitize(business?.name) || sanitize(post?.title) || "Your Business";
  const headlineText = sanitize(headline || campaign?.primaryOutcome || post?.title || businessName);
  const subheadlineText = sanitize(subheadline || campaign?.mainPainPoint || campaign?.coreMessage || post?.hook || "");
  const offerText = sanitize(offer || campaign?.offerDetails || "");
  const ctaText = sanitize(cta || campaign?.preferredCta || post?.cta || "Contact us today");
  const bullets = serviceBullets?.length ? serviceBullets : defaultServiceBullets(business, campaign);

  console.log(`[FallbackLeaflet] Rendering deterministic leaflet | business=${businessName} | creativeType=${creativeType} | size=${width}x${height}`);

  // Build background
  const backgroundSvg = buildFallbackBackgroundSvg(width, height, brandColor);
  let canvas = sharp(backgroundSvg).resize(width, height, { fit: "fill" });

  const overlays: sharp.OverlayOptions[] = [];

  // Header
  const headerHeight = Math.round(height * 0.095);
  const headerSvg = buildHeaderSvg(width, headerHeight, businessName, brandColor);
  overlays.push({ input: headerSvg, top: 0, left: 0 });

  // Logo
  const logoBuffer = await loadLogoBuffer(business?.logo);
  let logoPng: Buffer | null = null;
  if (logoBuffer) {
    logoPng = await resizeLogo(logoBuffer, headerHeight - 24);
    overlays.push({ input: logoPng, top: 14, left: 22 });
  }

  // Headline band
  const bandHeight = Math.round(height * 0.18);
  const bandTop = Math.round(height * 0.16);
  const headlineSvg = buildHeadlineOverlaySvg(width, bandHeight, headlineText, subheadlineText, brandColor);
  overlays.push({ input: headlineSvg, top: bandTop, left: 0 });

  // Offer badge (if provided)
  let currentY = bandTop + bandHeight + 24;
  if (offerText && !offerText.toLowerCase().includes("none")) {
    const offerLines = wrapText(escapeXml(offerText), Math.max(30, Math.round((width - 80) / 18)));
    const offerFontSize = Math.max(20, Math.round(width / 42));
    const offerLineHeight = offerFontSize + 10;
    const offerHeight = offerLines.length * offerLineHeight + 40;
    const offerBlocks = offerLines.map((line, i) =>
      `<text x="${width / 2}" y="${28 + offerFontSize + i * offerLineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${offerFontSize}" font-weight="700" fill="#0F172A" text-anchor="middle">${line}</text>`
    ).join("");
    const offerSvg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${offerHeight}">
  <rect x="32" y="0" width="${width - 64}" height="${offerHeight}" fill="#FEF3C7" stroke="#F59E0B" stroke-width="3" rx="14"/>
  ${offerBlocks}
</svg>`, "utf-8");
    overlays.push({ input: offerSvg, top: currentY, left: 0 });
    currentY += offerHeight + 24;
  }

  // Service bullets
  const bulletSvg = buildBulletSvg(width - 64, bullets, brandColor);
  const bulletMeta = await sharp(bulletSvg).metadata();
  const bulletHeight = bulletMeta.height || 260;
  overlays.push({ input: bulletSvg, top: currentY, left: 32 });
  currentY += bulletHeight + 24;

  // Footer + CTA
  const footerHeight = Math.round(height * 0.18);
  const footerTop = height - footerHeight;

  const contactLines: string[] = [];
  if (business?.whatsappNumber) contactLines.push(`WhatsApp: ${sanitize(business.whatsappNumber)}`);
  if (business?.email) contactLines.push(`Email: ${sanitize(business.email)}`);
  if (business?.website) contactLines.push(`Website: ${sanitize(business.website)}`);
  if (business?.location) contactLines.push(`Location: ${sanitize(business.location)}`);
  if (contactLines.length === 0) contactLines.push("Contact us today");

  const footerSvg = buildFooterSvg(width, footerHeight, contactLines, ctaText, brandColor);
  overlays.push({ input: footerSvg, top: footerTop, left: 0 });

  return canvas.composite(overlays).png().toBuffer();
}
