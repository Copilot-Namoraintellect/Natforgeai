/**
 * Deterministic brand overlay for NatForgeAI premium images.
 * Composites the real business logo, name, contact details and CTA onto the
 * AI-generated leaflet/poster background so the output is always on-brand and
 * never contains invented phone numbers, URLs or distorted logos.
 */

import path from "path";
import fs from "fs";
import sharp from "sharp";
import { resolveBrandPalette, contrastTextColor, isLightColor, type BrandPalette } from "./brand-palette";

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
  palette?: BrandPalette;
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

function resolveLocalPathFromPublicUrl(publicUrl: string): string | null {
  const baseUrl = "http://localhost:3000";
  let pathname = publicUrl;
  if (pathname.startsWith(baseUrl)) {
    pathname = pathname.slice(baseUrl.length);
  }
  // Strip any absolute production origin so we can resolve locally.
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
  // Persistent media is served from data/public/uploads with the /uploads
  // prefix stripped, so the file lives directly under data/public/uploads.
  const persistentUploadsDir = path.resolve(process.cwd(), "data/public/uploads");
  const relative = pathname.slice(1); // e.g. "uploads/logo/14/..."
  const devPath = path.join(publicDir, relative);
  const prodPath = path.join(prodPublicDir, relative);
  // For persistent storage the path already includes the uploads prefix in
  // the request, but the root is data/public/uploads, so strip that prefix.
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
      console.log(`[LeafletBrand] resolvedLogoPath=${localPath}`);
      return fs.readFileSync(localPath);
    }

    console.warn(`[LeafletBrand] Logo file not found locally, attempting fetch | logoUrl=${logoUrl}`);
    // Node fetch needs an absolute URL.
    let fetchUrl = logoUrl;
    if (fetchUrl.startsWith("/")) {
      const backendPort = process.env.PORT || "3001";
      fetchUrl = `http://127.0.0.1:${backendPort}${fetchUrl}`;
    }
    const response = await fetch(fetchUrl);
    if (!response.ok) {
      console.warn(`[LeafletBrand] Logo fetch failed | status=${response.status} | url=${fetchUrl}`);
      return null;
    }
    console.log(`[LeafletBrand] Logo fetched successfully | url=${fetchUrl}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (err: any) {
    console.warn(`[LeafletBrand] Could not load logo: ${err.message}`);
    return null;
  }
}

async function resizeLogo(logoBuffer: Buffer, maxHeight: number): Promise<Buffer> {
  return sharp(logoBuffer)
    .resize({ height: maxHeight, fit: sharp.fit.inside, withoutEnlargement: true })
    .png()
    .toBuffer();
}

/**
 * Build a compact branded header bar. The business name is placed on the right;
 * the logo is composited separately on the left so aspect ratio and padding are
 * preserved.
 */
function buildHeaderSvg(
  width: number,
  height: number,
  businessName: string,
  palette: BrandPalette
): Buffer {
  const name = escapeXml(sanitize(businessName) || "Your Business");
  const textColor = contrastTextColor(palette.primary);
  const nameSize = Math.max(18, Math.round(width / 28));
  const padX = 24;

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${palette.primary}"/>
  <text x="${width - padX}" y="${height / 2 + nameSize / 3}" font-family="Arial, Helvetica, sans-serif" font-size="${nameSize}" font-weight="700" fill="${textColor}" text-anchor="end">${name}</text>
</svg>`;
  return Buffer.from(svg, "utf-8");
}

/**
 * Build a prominent, easy-to-read footer with the CTA as the hero element.
 * Contact details are smaller and sit beneath the CTA so nothing is cut off.
 */
function buildFooterSvg(
  width: number,
  height: number,
  lines: string[],
  cta: string,
  palette: BrandPalette
): Buffer {
  const textColor = contrastTextColor(palette.primary);
  const ctaSize = Math.max(24, Math.round(width / 16));
  const lineSize = Math.max(14, Math.round(width / 38));
  const padX = 28;
  const padY = 18;

  const safeCta = escapeXml(sanitize(cta) || "Contact us today");
  const safeLines = lines.filter(Boolean).map((l) => escapeXml(sanitize(l)));

  const lineBlocks = safeLines
    .map((line, idx) => {
      const y = padY + ctaSize + 28 + (idx + 1) * (lineSize + 10);
      return `<text x="${padX}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${lineSize}" font-weight="500" fill="${textColor}" opacity="0.92">${line}</text>`;
    })
    .join("");

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${palette.primary}"/>
  <text x="${padX}" y="${padY + ctaSize}" font-family="Arial, Helvetica, sans-serif" font-size="${ctaSize}" font-weight="800" fill="${textColor}">${safeCta}</text>
  ${lineBlocks}
</svg>`;
  return Buffer.from(svg, "utf-8");
}

/**
 * Build a clean offer badge — white card with a brand-colour accent so it
 * floats over the image without hiding the hero visual.
 */
function buildOfferBadgeSvg(
  width: number,
  headline: string,
  subheadline: string,
  palette: BrandPalette
): Buffer {
  const safeHeadline = escapeXml(sanitize(headline) || "");
  const safeSub = escapeXml(sanitize(subheadline) || "");
  if (!safeHeadline && !safeSub) {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1"></svg>`, "utf-8");
  }

  const headlineSize = Math.max(20, Math.round(width / 22));
  const subSize = Math.max(14, Math.round(width / 34));
  const padX = 28;
  const padY = 18;
  const maxChars = Math.max(26, Math.round((width - padX * 2 - 40) / (headlineSize * 0.55)));
  const subMaxChars = Math.max(36, Math.round((width - padX * 2 - 40) / (subSize * 0.55)));

  const headlineLines = safeHeadline ? wrapText(safeHeadline, maxChars) : [];
  const subLines = safeSub ? wrapText(safeSub, subMaxChars) : [];

  const headlineLineHeight = headlineSize + 8;
  const subLineHeight = subSize + 6;

  const headlineBlocks = headlineLines.map((line, i) =>
    `<text x="${padX + 8}" y="${padY + headlineSize + i * headlineLineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineSize}" font-weight="800" fill="${palette.primary}">${line}</text>`
  ).join("");

  const subYOffset = padY + headlineSize + (headlineLines.length * headlineLineHeight) + (headlineLines.length && subLines.length ? 8 : 0);
  const subBlocks = subLines.map((line, i) =>
    `<text x="${padX + 8}" y="${subYOffset + subSize + i * subLineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${subSize}" font-weight="500" fill="#334155">${line}</text>`
  ).join("");

  const contentHeight = subYOffset + (subLines.length * subLineHeight) + (subLines.length ? 4 : 0);
  const height = Math.max(Math.round(width * 0.09), contentHeight + padY);

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect x="8" y="4" width="${width - 16}" height="${height - 8}" fill="#FFFFFF" opacity="0.96" rx="14" stroke="${palette.primary}" stroke-width="3"/>
  <rect x="8" y="4" width="7" height="${height - 8}" fill="${palette.accent}" rx="3"/>
  ${headlineBlocks}
  ${subBlocks}
</svg>`;
  return Buffer.from(svg, "utf-8");
}

/**
 * Build a 2-column service cards grid. Large, readable text with brand-colour
 * icons instead of tiny bullets.
 */
function buildServicesGridSvg(
  width: number,
  bullets: string[],
  palette: BrandPalette
): Buffer {
  const padX = 20;
  const padY = 18;
  const gapX = 14;
  const gapY = 12;
  const cardRadius = 12;
  const iconSize = 9;
  const lineSize = Math.max(17, Math.round(width / 50));
  const lineHeight = lineSize + 8;

  const colCount = 2;
  const cardWidth = Math.floor((width - padX * 2 - gapX * (colCount - 1)) / colCount);

  const blocks: string[] = [];
  let currentY = padY;
  let currentX = padX;

  for (let i = 0; i < bullets.length; i++) {
    const bullet = escapeXml(sanitize(bullets[i]));
    const col = i % colCount;
    currentX = padX + col * (cardWidth + gapX);

    const textMaxChars = Math.max(16, Math.round((cardWidth - 36) / (lineSize * 0.55)));
    const lines = wrapText(bullet, textMaxChars);
    const cardHeight = Math.max(56, lines.length * lineHeight + 22);

    if (col === 0 && i > 0) currentY += cardHeight + gapY;

    const cardY = currentY;
    const textYOffset = cardY + 18 + (cardHeight - lines.length * lineHeight) / 2;

    const textBlocks = lines.map((line, li) =>
      `<text x="${currentX + 22}" y="${textYOffset + li * lineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${lineSize}" font-weight="700" fill="#0F172A">${line}</text>`
    ).join("");

    blocks.push(`<rect x="${currentX}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" fill="#FFFFFF" opacity="0.96" rx="${cardRadius}" stroke="${palette.primary}" stroke-width="2"/>`);
    blocks.push(`<circle cx="${currentX + 11}" cy="${cardY + cardHeight / 2}" r="${iconSize / 2}" fill="${palette.accent}"/>`);
    blocks.push(textBlocks);
  }

  // Compute final height from last row.
  const rows = Math.ceil(bullets.length / colCount);
  const lastIdx = bullets.length - 1;
  const lastTextMaxChars = Math.max(16, Math.round((cardWidth - 36) / (lineSize * 0.55)));
  const lastLines = rows > 0 ? wrapText(sanitize(bullets[lastIdx]) || "", lastTextMaxChars).length : 0;
  const lastRowHeight = rows > 0 ? Math.max(56, lastLines * lineHeight + 22) : 0;
  const finalHeight = rows > 0 ? currentY + lastRowHeight + padY : padY;

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${finalHeight}">
  ${blocks.join("\n")}
</svg>`;
  return Buffer.from(svg, "utf-8");
}

function buildWatermarkSvg(width: number, businessName: string, palette: BrandPalette): Buffer {
  const height = 48;
  const name = escapeXml(sanitize(businessName) || "Your Business");
  const size = Math.max(12, Math.round(width / 40));
  const textColor = contrastTextColor(palette.primary);
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${palette.primary}" opacity="0.92"/>
  <text x="${width - 16}" y="${height / 2 + size / 3}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="600" fill="${textColor}" text-anchor="end">${name}</text>
</svg>`;
  return Buffer.from(svg, "utf-8");
}

export async function composeBrandedLeafletImage(
  baseImageBuffer: Buffer,
  spec: BrandOverlaySpec
): Promise<{ buffer: Buffer; logoApplied: boolean }> {
  const { business, campaign, post, creativeType = "leaflet", offer, cta, headline, subheadline } = spec;

  console.log(`[LeafletBrand] businessId=${business?.id ?? "none"} | business.logo=${business?.logo ?? "none"}`);
  const resolvedLogoPath = business?.logo ? resolveLocalPathFromPublicUrl(business.logo) : null;
  console.log(`[LeafletBrand] resolvedLogoPath=${resolvedLogoPath ?? "none"} | logoFileExists=${resolvedLogoPath ? fs.existsSync(resolvedLogoPath) : false}`);

  const base = sharp(baseImageBuffer);
  const meta = await base.metadata();
  const width = meta.width || 1024;
  const height = meta.height || 1536;

  const palette = spec.palette || await resolveBrandPalette(business);
  const businessName = sanitize(business?.name) || sanitize(post?.title) || "Your Business";
  const preferredCta = sanitize(cta || campaign?.preferredCta || post?.cta || "Contact us today");
  const safeOffer = sanitize(offer || campaign?.offerDetails || "");
  const headlineText = sanitize(headline || campaign?.primaryOutcome || post?.title || "");
  const subheadlineText = sanitize(subheadline || campaign?.mainPainPoint || campaign?.coreMessage || post?.hook || "");

  const logoBuffer = await loadLogoBuffer(business?.logo);
  const logoLoadSuccess = !!logoBuffer;
  console.log(`[LeafletBrand] logoLoadSuccess=${logoLoadSuccess}`);
  if (business?.logo && !logoBuffer) {
    console.warn(`[LeafletBrand] Could not load logo buffer | logo=${business.logo}`);
  }

  let logoApplied = false;

  if (creativeType !== "leaflet") {
    // Non-leaflet: just add a small branded watermark strip at the bottom.
    const watermarkHeight = 48;
    const watermarkSvg = buildWatermarkSvg(width, businessName, palette);
    const composite = await base
      .composite([
        { input: watermarkSvg, top: height - watermarkHeight, left: 0 },
      ])
      .toBuffer();

    if (!logoBuffer) return { buffer: composite, logoApplied: false };

    const logoPng = await resizeLogo(logoBuffer, 40);
    const buffer = await sharp(composite).composite([{ input: logoPng, top: 12, left: 12 }]).toBuffer();
    return { buffer, logoApplied: true };
  }

  // Leaflet layout.
  const headerHeight = Math.round(height * 0.10);
  const footerHeight = Math.round(height * 0.16);
  const logoSafeHeight = headerHeight - 32;
  const logoPadX = 28;
  const logoPadY = 16;

  const headerSvg = buildHeaderSvg(width, headerHeight, businessName, palette);

  const contactLines: string[] = [];
  if (business?.whatsappNumber) contactLines.push(`WhatsApp: ${sanitize(business.whatsappNumber)}`);
  if (business?.email) contactLines.push(`Email: ${sanitize(business.email)}`);
  if (business?.website) contactLines.push(`Website: ${sanitize(business.website)}`);
  if (business?.location) contactLines.push(`Location: ${sanitize(business.location)}`);

  const footerSvg = buildFooterSvg(width, footerHeight, contactLines, preferredCta, palette);

  const overlays: sharp.OverlayOptions[] = [
    { input: headerSvg, top: 0, left: 0 },
    { input: footerSvg, top: height - footerHeight, left: 0 },
  ];

  // Logo: large, deterministic placement in the header with a contrasting
  // backdrop so the real uploaded logo is always clearly visible.
  if (logoBuffer) {
    const logoMeta = await sharp(logoBuffer).metadata();
    const logoAspect = (logoMeta.width || 1) / (logoMeta.height || 1);
    const logoHeight = logoSafeHeight;
    const logoWidth = Math.round(logoHeight * logoAspect);
    const maxLogoWidth = Math.round(width * 0.45);
    let finalLogoHeight = logoHeight;
    let finalLogoWidth = logoWidth;
    if (logoWidth > maxLogoWidth) {
      finalLogoWidth = maxLogoWidth;
      finalLogoHeight = Math.round(finalLogoWidth / logoAspect);
    }

    const logoPng = await sharp(logoBuffer)
      .resize(finalLogoWidth, finalLogoHeight, { fit: "fill" })
      .png()
      .toBuffer();

    const logoTop = logoPadY + Math.round((headerHeight - 2 * logoPadY - finalLogoHeight) / 2);
    const backdropPadX = 16;
    const backdropPadY = 12;
    const backdropWidth = finalLogoWidth + backdropPadX * 2;
    const backdropHeight = finalLogoHeight + backdropPadY * 2;
    const backdropFill = isLightColor(palette.primary) ? "#0F172A" : "#FFFFFF";
    const backdropSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${backdropWidth}" height="${backdropHeight}">
  <rect width="${backdropWidth}" height="${backdropHeight}" rx="16" ry="16" fill="${backdropFill}"/>
</svg>`;

    overlays.push(
      { input: Buffer.from(backdropSvg, "utf-8"), top: logoTop - backdropPadY, left: logoPadX - backdropPadX },
      { input: logoPng, top: logoTop, left: logoPadX }
    );
    logoApplied = true;

    // Also place a small, clean logo mark in the footer so the brand is
    // visible in both the header and footer.
    const footerLogoHeight = 56;
    const footerLogoPng = await sharp(logoBuffer)
      .resize({ height: footerLogoHeight, fit: sharp.fit.inside, withoutEnlargement: true })
      .png()
      .toBuffer();
    const footerLogoMeta = await sharp(footerLogoPng).metadata();
    const footerLogoWidth = footerLogoMeta.width || footerLogoHeight;
    overlays.push({
      input: footerLogoPng,
      top: height - footerHeight + footerHeight - footerLogoHeight - 20,
      left: width - footerLogoWidth - 28,
    });
  }

  // Offer badge in upper area so the hero visual stays dominant in the centre.
  const offerBadgeTop = Math.round(height * 0.36);
  let offerBadgeHeight = 0;
  if (headlineText || safeOffer) {
    const offerText = headlineText || safeOffer;
    const badgeSvg = buildOfferBadgeSvg(width, offerText, subheadlineText, palette);
    const badgeMeta = await sharp(badgeSvg).metadata();
    offerBadgeHeight = badgeMeta.height || Math.round(height * 0.11);
    overlays.push({ input: badgeSvg, top: offerBadgeTop, left: 0 });
  }

  // Service cards grid between offer badge and footer.
  const bullets = spec.serviceBullets?.length
    ? spec.serviceBullets
    : defaultServiceBullets(business, campaign);
  if (bullets.length > 0) {
    const gridWidth = Math.round(width * 0.92);
    const gridLeft = Math.round((width - gridWidth) / 2);
    const gridTop = offerBadgeTop + offerBadgeHeight + Math.round(height * 0.04);
    const gridSvg = buildServicesGridSvg(gridWidth, bullets.slice(0, 6), palette);
    const gridMeta = await sharp(gridSvg).metadata();
    const actualGridHeight = gridMeta.height || Math.round(height * 0.22);
    if (gridTop + actualGridHeight <= height - footerHeight - Math.round(height * 0.02)) {
      overlays.push({ input: gridSvg, top: gridTop, left: gridLeft });
    }
  }

  const buffer = await base.composite(overlays).toBuffer();
  console.log(`[LeafletBrand] logoOverlayApplied=${logoApplied} | paletteSource=${palette.source} | resolvedPalette=${JSON.stringify(palette)}`);
  return { buffer, logoApplied };
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
  const palette = await resolveBrandPalette(business);

  const lines: string[] = [];
  if (business?.whatsappNumber) lines.push(`WhatsApp: ${sanitize(business.whatsappNumber)}`);
  if (business?.email) lines.push(`Email: ${sanitize(business.email)}`);
  if (business?.website) lines.push(`Website: ${sanitize(business.website)}`);
  if (business?.location) lines.push(`Location: ${sanitize(business.location)}`);
  if (lines.length === 0) lines.push("Contact us today");

  const footerSvg = buildFooterSvg(width, footerHeight, lines, cta || "Contact us today", palette);
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

export function defaultServiceBullets(business: any, campaign: any): string[] {
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

function buildFallbackBackgroundSvg(width: number, height: number, palette: BrandPalette): Buffer {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:${palette.primary};stop-opacity:0.12" />
      <stop offset="45%" style="stop-color:#FFFFFF;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#F1F5F9;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bgGrad)"/>
  <rect x="0" y="0" width="${width}" height="12" fill="${palette.accent}"/>
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

  const palette = spec.palette || await resolveBrandPalette(business);
  const businessName = sanitize(business?.name) || sanitize(post?.title) || "Your Business";
  const headlineText = sanitize(headline || campaign?.primaryOutcome || post?.title || businessName);
  const subheadlineText = sanitize(subheadline || campaign?.mainPainPoint || campaign?.coreMessage || post?.hook || "");
  const offerText = sanitize(offer || campaign?.offerDetails || "");
  const ctaText = sanitize(cta || campaign?.preferredCta || post?.cta || "Contact us today");
  const bullets = serviceBullets?.length ? serviceBullets : defaultServiceBullets(business, campaign);

  console.log(`[FallbackLeaflet] Rendering deterministic leaflet | business=${businessName} | creativeType=${creativeType} | size=${width}x${height}`);

  // Build background
  const backgroundSvg = buildFallbackBackgroundSvg(width, height, palette);
  let canvas = sharp(backgroundSvg).resize(width, height, { fit: "fill" });

  const overlays: sharp.OverlayOptions[] = [];

  // Header
  const headerHeight = Math.round(height * 0.095);
  const headerSvg = buildHeaderSvg(width, headerHeight, businessName, palette);
  overlays.push({ input: headerSvg, top: 0, left: 0 });

  // Logo with safe padding and aspect ratio preserved.
  const logoBuffer = await loadLogoBuffer(business?.logo);
  if (logoBuffer) {
    const logoMeta = await sharp(logoBuffer).metadata();
    const logoAspect = (logoMeta.width || 1) / (logoMeta.height || 1);
    const logoHeight = headerHeight - 26;
    const logoWidth = Math.round(logoHeight * logoAspect);
    const maxLogoWidth = Math.round(width * 0.32);
    let finalHeight = logoHeight;
    let finalWidth = logoWidth;
    if (logoWidth > maxLogoWidth) {
      finalWidth = maxLogoWidth;
      finalHeight = Math.round(finalWidth / logoAspect);
    }
    const logoPng = await sharp(logoBuffer)
      .resize(finalWidth, finalHeight, { fit: "fill" })
      .png()
      .toBuffer();
    const logoTop = 13 + Math.round((headerHeight - 26 - finalHeight) / 2);
    overlays.push({ input: logoPng, top: logoTop, left: 20 });
  }

  // Headline band
  const bandTop = Math.round(height * 0.16);
  const headlineSvg = buildOfferBadgeSvg(width, headlineText, subheadlineText, palette);
  const headlineMeta = await sharp(headlineSvg).metadata();
  const bandHeight = headlineMeta.height || Math.round(height * 0.18);
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
  <rect x="32" y="0" width="${width - 64}" height="${offerHeight}" fill="#FFFFFF" stroke="${palette.primary}" stroke-width="3" rx="14"/>
  ${offerBlocks}
</svg>`, "utf-8");
    overlays.push({ input: offerSvg, top: currentY, left: 0 });
    currentY += offerHeight + 24;
  }

  // Service bullets
  const bulletSvg = buildServicesGridSvg(width - 64, bullets, palette);
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

  const footerSvg = buildFooterSvg(width, footerHeight, contactLines, ctaText, palette);
  overlays.push({ input: footerSvg, top: footerTop, left: 0 });

  return canvas.composite(overlays).png().toBuffer();
}
