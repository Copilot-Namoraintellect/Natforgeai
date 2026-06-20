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
  creativeGuidance?: string;
  refinementInstruction?: string;
}

export interface LayoutHints {
  cleaner?: boolean;
  fewerServices?: boolean;
  noServiceBoxes?: boolean;
  largerText?: boolean;
  moreSpacing?: boolean;
  darkerBackground?: boolean;
  centered?: boolean;
}

function parseLayoutHints(text?: string): LayoutHints {
  if (!text) return {};
  const lower = text.toLowerCase();
  return {
    cleaner: /\b(clean|minimal|simpler|less clutter|tidier)\b/.test(lower),
    fewerServices: /\b(fewer|less)\b.*\b(services?|boxes|bullets?)\b|\bminimal\b/.test(lower),
    noServiceBoxes: /\b(no boxes|no cards|no service boxes|no icons?|list only|simple list|no bullet cards?)\b/.test(lower),
    largerText: /\b(larger text|bigger text|bigger font|larger font|more readable)\b/.test(lower),
    moreSpacing: /\b(more spacing|more whitespace|more space|spread out|room|airy)\b/.test(lower),
    darkerBackground: /\b(darker background|darker|deeper background)\b/.test(lower),
    centered: /\b(centered|centre|center align|centred)\b/.test(lower),
  };
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
 * Build a branded header bar. The business name is placed on the right at a
 * size that always fits next to the logo area. The real logo is composited
 * separately on the left.
 */
function buildHeaderSvg(
  width: number,
  height: number,
  businessName: string,
  palette: BrandPalette
): Buffer {
  const name = escapeXml(sanitize(businessName) || "Your Business");
  const textColor = contrastTextColor(palette.primary);
  const padX = 28;
  const maxTextWidth = Math.round(width * 0.48);
  const nameSize = Math.max(
    20,
    Math.min(
      Math.round(width / 24),
      Math.round(maxTextWidth / Math.max(name.length * 0.58, 1))
    )
  );

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${palette.primary}"/>
  <text x="${width - padX}" y="${height / 2 + nameSize / 3}" font-family="Arial, Helvetica, sans-serif" font-size="${nameSize}" font-weight="800" fill="${textColor}" text-anchor="end">${name}</text>
</svg>`;
  return Buffer.from(svg, "utf-8");
}

/**
 * Build a prominent, easy-to-read footer. The CTA is the hero element and
 * contact details sit beneath it. If height <= 0 the height is computed
 * dynamically from the content, so nothing is clipped.
 */
function buildFooterSvg(
  width: number,
  height: number,
  lines: string[],
  cta: string,
  palette: BrandPalette
): Buffer {
  const textColor = contrastTextColor(palette.primary);
  const padX = 32;
  const padY = 24;
  const rightReserve = 140; // reserve space for the footer logo mark
  const availableWidth = width - padX - rightReserve;

  const ctaBaseSize = Math.max(28, Math.round(width / 14));
  const lineBaseSize = Math.max(16, Math.round(width / 34));

  const safeCta = escapeXml(sanitize(cta) || "Contact us today");
  const safeLines = lines.filter(Boolean).map((l) => escapeXml(sanitize(l))).slice(0, 3);

  const ctaMaxChars = Math.max(12, Math.round(availableWidth / (ctaBaseSize * 0.55)));
  const ctaLines = wrapText(safeCta, ctaMaxChars);
  const ctaLineHeight = ctaBaseSize + 8;
  const ctaBlockHeight = ctaLines.length * ctaLineHeight;

  const lineMaxChars = Math.max(22, Math.round(availableWidth / (lineBaseSize * 0.55)));
  const lineBlocks: string[] = [];
  let currentY = padY + ctaBlockHeight + 40;
  for (const line of safeLines) {
    const wrapped = wrapText(line, lineMaxChars);
    for (const text of wrapped) {
      lineBlocks.push(
        `<text x="${padX}" y="${currentY + lineBaseSize}" font-family="Arial, Helvetica, sans-serif" font-size="${lineBaseSize}" font-weight="600" fill="${textColor}" opacity="0.95">${text}</text>`
      );
      currentY += lineBaseSize + 14;
    }
  }

  const contentHeight = currentY + padY;
  const finalHeight = height > 0 ? height : Math.max(Math.round(width * 0.12), contentHeight);

  const ctaBlocks = ctaLines
    .map(
      (line, i) =>
        `<text x="${padX}" y="${padY + (i + 1) * ctaLineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${ctaBaseSize}" font-weight="900" fill="${textColor}">${line}</text>`
    )
    .join("");

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${finalHeight}">
  <rect width="${width}" height="${finalHeight}" fill="${palette.primary}"/>
  ${ctaBlocks}
  ${lineBlocks.join("")}
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
  palette: BrandPalette,
  hints?: LayoutHints
): Buffer {
  const safeHeadline = escapeXml(sanitize(headline) || "");
  const safeSub = escapeXml(sanitize(subheadline) || "");
  if (!safeHeadline && !safeSub) {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1"></svg>`, "utf-8");
  }

  const scale = hints?.largerText ? 1.2 : 1;
  const padX = 32;
  const padY = 24;
  const accentBar = 10;
  const textLeft = padX + accentBar + 12;
  const usableWidth = width - textLeft - padX;

  const headlineSize = Math.max(26, Math.round((width / 18) * scale));
  const subSize = Math.max(18, Math.round((width / 30) * scale));

  const maxChars = Math.max(18, Math.round(usableWidth / (headlineSize * 0.55)));
  const subMaxChars = Math.max(28, Math.round(usableWidth / (subSize * 0.55)));

  const headlineLines = safeHeadline ? wrapText(safeHeadline, maxChars) : [];
  const subLines = safeSub ? wrapText(safeSub, subMaxChars) : [];

  const headlineLineHeight = headlineSize + 10;
  const subLineHeight = subSize + 8;

  const headlineBlocks = headlineLines
    .map(
      (line, i) =>
        `<text x="${textLeft}" y="${padY + headlineSize + i * headlineLineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineSize}" font-weight="900" fill="${palette.primary}">${line}</text>`
    )
    .join("");

  const subYOffset = padY + headlineSize + headlineLines.length * headlineLineHeight - 10 + (headlineLines.length && subLines.length ? 12 : 0);
  const subBlocks = subLines
    .map(
      (line, i) =>
        `<text x="${textLeft}" y="${subYOffset + subSize + i * subLineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${subSize}" font-weight="600" fill="#334155">${line}</text>`
    )
    .join("");

  const contentHeight = subYOffset + (subLines.length ? subLines.length * subLineHeight + 8 : 0);
  const height = Math.max(Math.round(width * 0.10), contentHeight + padY);

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect x="10" y="6" width="${width - 20}" height="${height - 12}" fill="#FFFFFF" opacity="0.97" rx="16" stroke="${palette.primary}" stroke-width="3"/>
  <rect x="10" y="6" width="${accentBar}" height="${height - 12}" fill="${palette.accent}" rx="4"/>
  ${headlineBlocks}
  ${subBlocks}
</svg>`;
  return Buffer.from(svg, "utf-8");
}

/**
 * Build a 2-column service cards grid. Large, readable text with brand-colour
 * icons instead of tiny bullets. If hints.noServiceBoxes is set, render a
 * simple list without card backgrounds.
 */
function buildServicesGridSvg(
  width: number,
  bullets: string[],
  palette: BrandPalette,
  hints?: LayoutHints
): Buffer {
  const scale = hints?.largerText ? 1.15 : 1;
  const padX = 22;
  const padY = 20;
  const gapX = 16;
  const gapY = hints?.moreSpacing ? 18 : 14;
  const cardRadius = 14;
  const iconSize = 10;
  const lineSize = Math.max(20, Math.round((width / 45) * scale));
  const lineHeight = lineSize + 10;

  const colCount = hints?.noServiceBoxes ? 1 : 2;
  const cardWidth = colCount > 1
    ? Math.floor((width - padX * 2 - gapX * (colCount - 1)) / colCount)
    : width - padX * 2;

  const blocks: string[] = [];
  let currentY = padY;
  let currentX = padX;

  for (let i = 0; i < bullets.length; i++) {
    const bullet = escapeXml(sanitize(bullets[i]));
    const col = i % colCount;
    currentX = padX + col * (cardWidth + gapX);

    const textLeft = hints?.noServiceBoxes ? currentX + 26 : currentX + 26;
    const textMaxChars = Math.max(14, Math.round((cardWidth - 44) / (lineSize * 0.55)));
    const lines = wrapText(bullet, textMaxChars);
    const cardHeight = Math.max(64, lines.length * lineHeight + 26);

    if (col === 0 && i > 0) currentY += cardHeight + gapY;

    const cardY = currentY;
    const textYOffset = cardY + 20 + (cardHeight - lines.length * lineHeight) / 2;

    const textBlocks = lines
      .map(
        (line, li) =>
          `<text x="${textLeft}" y="${textYOffset + li * lineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${lineSize}" font-weight="800" fill="#0F172A">${line}</text>`
      )
      .join("");

    if (hints?.noServiceBoxes) {
      blocks.push(`<circle cx="${currentX + 9}" cy="${cardY + cardHeight / 2}" r="${iconSize / 2}" fill="${palette.accent}"/>`);
      blocks.push(textBlocks);
    } else {
      blocks.push(`<rect x="${currentX}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" fill="#FFFFFF" opacity="0.97" rx="${cardRadius}" stroke="${palette.primary}" stroke-width="2.5"/>`);
      blocks.push(`<circle cx="${currentX + 13}" cy="${cardY + cardHeight / 2}" r="${iconSize / 2}" fill="${palette.accent}"/>`);
      blocks.push(textBlocks);
    }
  }

  // Compute final height from last row.
  const rows = Math.ceil(bullets.length / colCount);
  const lastIdx = bullets.length - 1;
  const lastTextMaxChars = Math.max(14, Math.round((cardWidth - 44) / (lineSize * 0.55)));
  const lastLines = rows > 0 ? wrapText(sanitize(bullets[lastIdx]) || "", lastTextMaxChars).length : 0;
  const lastRowHeight = rows > 0 ? Math.max(64, lastLines * lineHeight + 26) : 0;
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
): Promise<{ buffer: Buffer; logoApplied: boolean; footerTop?: number; footerHeight?: number }> {
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
  const hints = parseLayoutHints(`${spec.creativeGuidance || ""} ${spec.refinementInstruction || ""}`);
  const headerHeight = Math.round(height * 0.085);
  const logoSafeHeight = headerHeight - 32;
  const logoPadX = 28;
  const logoPadY = 16;

  const headerSvg = buildHeaderSvg(width, headerHeight, businessName, palette);

  const contactLines: string[] = [];
  if (business?.whatsappNumber) contactLines.push(`WhatsApp: ${sanitize(business.whatsappNumber)}`);
  if (business?.location) contactLines.push(`Location: ${sanitize(business.location)}`);
  if (business?.website) contactLines.push(`Website: ${sanitize(business.website)}`);
  if (business?.email) contactLines.push(`Email: ${sanitize(business.email)}`);

  // Reserve the footer height first so body content can never overlap it.
  const footerSvg = buildFooterSvg(width, 0, contactLines.slice(0, 3), preferredCta, palette);
  const footerMeta = await sharp(footerSvg).metadata();
  const footerHeight = footerMeta.height || Math.round(height * 0.18);
  const footerTop = height - footerHeight;
  const bottomClearance = Math.round(height * 0.03);
  const bodyBottomLimit = footerTop - bottomClearance;
  const topMargin = Math.round(height * 0.025);
  const bodyTop = headerHeight + topMargin;

  const overlays: sharp.OverlayOptions[] = [
    { input: headerSvg, top: 0, left: 0 },
    { input: footerSvg, top: footerTop, left: 0 },
  ];

  // Logo: large, deterministic placement in the header with a contrasting
  // backdrop so the real uploaded logo is always clearly visible.
  let footerLogoWidth = 0;
  let footerLogoHeight = 0;
  if (logoBuffer) {
    const logoMeta = await sharp(logoBuffer).metadata();
    const logoAspect = (logoMeta.width || 1) / (logoMeta.height || 1);
    const logoHeight = logoSafeHeight;
    const logoWidth = Math.round(logoHeight * logoAspect);
    const maxLogoWidth = Math.round(width * 0.40);
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

    // Small logo mark in the footer, vertically centred on the right.
    footerLogoHeight = 56;
    const footerLogoPng = await sharp(logoBuffer)
      .resize({ height: footerLogoHeight, fit: sharp.fit.inside, withoutEnlargement: true })
      .png()
      .toBuffer();
    const footerLogoMeta = await sharp(footerLogoPng).metadata();
    footerLogoWidth = footerLogoMeta.width || footerLogoHeight;
    overlays.push({
      input: footerLogoPng,
      top: footerTop + Math.round((footerHeight - footerLogoHeight) / 2),
      left: width - footerLogoWidth - 32,
    });
  }

  // Single offer block — never render the offer twice.
  let offerBadgeHeight = 0;
  const offerText = headlineText || safeOffer;
  let contentTop = bodyTop;
  if (offerText) {
    const badgeWidth = Math.round(width * 0.92);
    const badgeLeft = Math.round((width - badgeWidth) / 2);
    const badgeSvg = buildOfferBadgeSvg(badgeWidth, offerText, subheadlineText, palette, hints);
    const badgeMeta = await sharp(badgeSvg).metadata();
    offerBadgeHeight = badgeMeta.height || Math.round(height * 0.12);
    overlays.push({ input: badgeSvg, top: bodyTop, left: badgeLeft });
    contentTop = bodyTop + offerBadgeHeight + Math.round(height * 0.04);
  }

  // Service cards grid between offer badge and footer.
  const rawBullets = spec.serviceBullets?.length
    ? spec.serviceBullets
    : defaultServiceBullets(business, campaign);
  const maxBullets = hints.fewerServices || hints.cleaner ? 2 : 4;
  let bullets = rawBullets.slice(0, maxBullets);

  if (bullets.length > 0) {
    const gridWidth = Math.round(width * 0.92);
    const gridLeft = Math.round((width - gridWidth) / 2);
    const minFooterClearance = Math.round(height * 0.02);

    // Drop bullets one at a time until the grid fits comfortably above the footer.
    while (bullets.length > 0) {
      const gridSvg = buildServicesGridSvg(gridWidth, bullets, palette, hints);
      const gridMeta = await sharp(gridSvg).metadata();
      const actualGridHeight = gridMeta.height || Math.round(height * 0.22);
      if (contentTop + actualGridHeight <= bodyBottomLimit - minFooterClearance) {
        overlays.push({ input: gridSvg, top: contentTop, left: gridLeft });
        break;
      }
      bullets = bullets.slice(0, -1);
    }
  }

  const buffer = await base.composite(overlays).toBuffer();
  console.log(`[LeafletBrand] logoOverlayApplied=${logoApplied} | paletteSource=${palette.source} | resolvedPalette=${JSON.stringify(palette)}`);
  return { buffer, logoApplied, footerTop, footerHeight };
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
  const palette = await resolveBrandPalette(business);

  const lines: string[] = [];
  if (business?.whatsappNumber) lines.push(`WhatsApp: ${sanitize(business.whatsappNumber)}`);
  if (business?.location) lines.push(`Location: ${sanitize(business.location)}`);
  if (business?.website) lines.push(`Website: ${sanitize(business.website)}`);
  if (business?.email) lines.push(`Email: ${sanitize(business.email)}`);
  if (lines.length === 0) lines.push("Contact us today");

  const footerSvg = buildFooterSvg(width, 0, lines.slice(0, 3), cta || "Contact us today", palette);
  const footerMeta = await sharp(footerSvg).metadata();
  const footerHeight = footerMeta.height || Math.round(height * 0.12);
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
  const bandY1 = Math.round(height * 0.12);
  const bandY2 = Math.round(height * 0.32);
  const panelY = Math.round(height * 0.28);
  const panelH = Math.round(height * 0.42);
  const bottomShapeY = height - 80;
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:${palette.primary};stop-opacity:0.22" />
      <stop offset="30%" style="stop-color:#FAFBFC;stop-opacity:1" />
      <stop offset="60%" style="stop-color:#F1F5F9;stop-opacity:1" />
      <stop offset="100%" style="stop-color:${palette.secondary};stop-opacity:0.16" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bgGrad)"/>
  <rect x="0" y="0" width="${width}" height="12" fill="${palette.accent}"/>
  <path d="M0,${bandY1} L${width},${bandY1 - Math.round(height * 0.10)} L${width},${bandY2} L0,${bandY2 + Math.round(height * 0.10)} Z" fill="${palette.primary}" opacity="0.12"/>
  <rect x="${Math.round(width * 0.05)}" y="${panelY}" width="${Math.round(width * 0.90)}" height="${panelH}" rx="24" fill="${palette.primary}" opacity="0.10" stroke="${palette.primary}" stroke-width="2" stroke-opacity="0.22"/>
  <ellipse cx="${Math.round(width * 0.85)}" cy="${Math.round(height * 0.20)}" rx="${Math.round(width * 0.35)}" ry="${Math.round(height * 0.18)}" fill="${palette.accent}" opacity="0.16"/>
  <ellipse cx="${Math.round(width * 0.12)}" cy="${Math.round(height * 0.78)}" rx="${Math.round(width * 0.30)}" ry="${Math.round(height * 0.20)}" fill="${palette.primary}" opacity="0.14"/>
  <path d="M0,${bottomShapeY} Q${Math.round(width / 2)},${bottomShapeY - 60} ${width},${bottomShapeY + 20} L${width},${height} L0,${height} Z" fill="${palette.primary}" opacity="0.10"/>
</svg>`;
  return Buffer.from(svg, "utf-8");
}

/**
 * Render a clean, deterministic branded leaflet when AI generation or quality
 * validation cannot produce a usable image. The output is always on-brand and
 * never contains invented contact details.
 */
export async function generateFallbackLeafletImage(spec: BrandOverlaySpec): Promise<{ buffer: Buffer; footerTop?: number; footerHeight?: number }> {
  const { business, campaign, post, creativeType = "leaflet", offer, cta, headline, subheadline, serviceBullets } = spec;

  const width = 1080;
  const isSquare = creativeType === "poster" || creativeType === "offer_advert" || creativeType === "event_announcement";
  const height = isSquare ? 1080 : 1350;

  const palette = spec.palette || await resolveBrandPalette(business);
  const businessName = sanitize(business?.name) || sanitize(post?.title) || "Your Business";
  // The offer headline is the single offer block; never render it twice.
  const headlineText = sanitize(headline || offer || campaign?.primaryOutcome || post?.title || businessName);
  const subheadlineText = sanitize(subheadline || campaign?.mainPainPoint || campaign?.coreMessage || post?.hook || "");
  const ctaText = sanitize(cta || campaign?.preferredCta || post?.cta || "Contact us today");
  const bullets = serviceBullets?.length ? serviceBullets : defaultServiceBullets(business, campaign);
  const hints = parseLayoutHints(`${spec.creativeGuidance || ""} ${spec.refinementInstruction || ""}`);

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

  // Single headline/offer block just below the header.
  const bodyTop = headerHeight + 28;
  const bandTop = bodyTop;
  const headlineSvg = buildOfferBadgeSvg(width, headlineText, subheadlineText, palette, hints);
  const headlineMeta = await sharp(headlineSvg).metadata();
  const bandHeight = headlineMeta.height || Math.round(height * 0.18);
  overlays.push({ input: headlineSvg, top: bandTop, left: 0 });

  // Service bullets between the headline band and the footer.
  const bulletGap = 28;
  const bulletTop = bandTop + bandHeight + bulletGap;
  const bulletMaxWidth = width - 64;
  const maxBulletCount = hints.fewerServices || hints.cleaner ? 2 : 4;
  let bulletsToRender = bullets.slice(0, maxBulletCount);
  let bulletHeight = 0;

  while (bulletsToRender.length > 0) {
    const bulletSvg = buildServicesGridSvg(bulletMaxWidth, bulletsToRender, palette, hints);
    const bulletMeta = await sharp(bulletSvg).metadata();
    bulletHeight = bulletMeta.height || 260;
    if (bulletTop + bulletHeight <= height - 24) {
      overlays.push({ input: bulletSvg, top: bulletTop, left: 32 });
      break;
    }
    bulletsToRender = bulletsToRender.slice(0, -1);
  }

  const contentBottom = bulletsToRender.length > 0 ? bulletTop + bulletHeight : bandTop + bandHeight;

  // Footer + CTA (dynamic height). Keep it close to content so it is not pushed too far down.
  const contactLines: string[] = [];
  if (business?.whatsappNumber) contactLines.push(`WhatsApp: ${sanitize(business.whatsappNumber)}`);
  if (business?.location) contactLines.push(`Location: ${sanitize(business.location)}`);
  if (business?.website) contactLines.push(`Website: ${sanitize(business.website)}`);
  if (business?.email) contactLines.push(`Email: ${sanitize(business.email)}`);
  if (contactLines.length === 0) contactLines.push("Contact us today");

  const footerSvg = buildFooterSvg(width, 0, contactLines.slice(0, 3), ctaText, palette);
  const footerMeta = await sharp(footerSvg).metadata();
  const footerHeight = footerMeta.height || Math.round(height * 0.18);
  const footerGap = 36;
  const maxBottomOffset = 80;
  const footerTop = Math.max(height - footerHeight - maxBottomOffset, contentBottom + footerGap);
  overlays.push({ input: footerSvg, top: footerTop, left: 0 });

  const buffer = await canvas.composite(overlays).png().toBuffer();
  return { buffer, footerTop, footerHeight };
}
