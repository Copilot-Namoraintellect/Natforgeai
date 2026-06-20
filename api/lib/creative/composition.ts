/**
 * Deterministic premium leaflet design system for NatForgeAI.
 *
 * OpenAI is only responsible for optional background/hero visuals.
 * NatForgeAI controls logo, business name, headline, offer, CTA, services,
 * contact details, footer, and final layout through reusable templates.
 */

import path from "path";
import fs from "fs";
import sharp from "sharp";
import { resolveBrandPalette, contrastTextColor, isLightColor, type BrandPalette } from "./brand-palette";

export type TemplateId = "service_business_promo" | "retail_product_promo" | "offer_discount_campaign";

export interface BrandOverlaySpec {
  business: any;
  campaign?: any;
  post?: any;
  creativeType?: string;
  templateId?: TemplateId;
  aspectRatio?: string;
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
  stretchLogo?: boolean;
  wideLogo?: boolean;
  removeSubheadline?: boolean;
  removeHeaderName?: boolean;
  stackVertical?: boolean;
  brighterColors?: boolean;
  centerOffer?: boolean;
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
    stretchLogo: /\b(stretch logo|wide logo|logo across header|full-width logo)\b/.test(lower),
    wideLogo: /\b(wide logo|logo across header|full-width logo)\b/.test(lower),
    removeSubheadline: /\b(remove sub[-]?headline|no sub[-]?headline|remove tagline|no tagline)\b/.test(lower),
    removeHeaderName: /\b(remove header name|no business name in header|hide business name)\b/.test(lower),
    stackVertical: /\b(stack vertical|vertical layout|single column|stacked)\b/.test(lower),
    brighterColors: /\b(brighter colours?|brighter colors?|more vibrant|vivid)\b/.test(lower),
    centerOffer: /\b(center offer|centre offer|offer in center|center the offer)\b/.test(lower),
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
      console.log(`[LeafletBrand] resolvedLogoPath=${localPath}`);
      return fs.readFileSync(localPath);
    }

    console.warn(`[LeafletBrand] Logo file not found locally, attempting fetch | logoUrl=${logoUrl}`);
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

function buildHeaderSvg(
  width: number,
  height: number,
  businessName: string,
  palette: BrandPalette,
  variant: "default" | "centered" | "wide-logo" = "default"
): Buffer {
  const name = escapeXml(sanitize(businessName) || "Your Business");
  const textColor = contrastTextColor(palette.primary);
  const padX = 28;

  if (variant === "centered") {
    const nameSize = Math.max(22, Math.min(Math.round(width / 20), Math.round((width - padX * 2) / Math.max(name.length * 0.58, 1))));
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${palette.primary}"/>
  <text x="${width / 2}" y="${height / 2 + nameSize / 3}" font-family="Arial, Helvetica, sans-serif" font-size="${nameSize}" font-weight="800" fill="${textColor}" text-anchor="middle">${name}</text>
</svg>`;
    return Buffer.from(svg, "utf-8");
  }

  // default / wide-logo: name right-aligned, logo area reserved on left.
  const maxTextWidth = variant === "wide-logo" ? Math.round(width * 0.38) : Math.round(width * 0.48);
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

function buildFooterSvg(
  width: number,
  height: number,
  lines: string[],
  cta: string,
  palette: BrandPalette,
  options: { centered?: boolean } = {}
): Buffer {
  const textColor = contrastTextColor(palette.primary);
  const padX = 32;
  const padY = 24;
  const rightReserve = 140;
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

  const ctaAnchor = options.centered ? "middle" : "start";
  const ctaX = options.centered ? width / 2 : padX;
  const ctaBlocks = ctaLines
    .map(
      (line, i) =>
        `<text x="${ctaX}" y="${padY + (i + 1) * ctaLineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${ctaBaseSize}" font-weight="900" fill="${textColor}" text-anchor="${ctaAnchor}">${line}</text>`
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

function buildOfferBadgeSvg(
  width: number,
  headline: string,
  subheadline: string,
  palette: BrandPalette,
  hints?: LayoutHints,
  variant: "default" | "centered" | "large" | "sticker" = "default"
): Buffer {
  const safeHeadline = escapeXml(sanitize(headline) || "");
  const safeSub = escapeXml(sanitize(subheadline) || "");
  if (!safeHeadline && !safeSub) {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1"></svg>`, "utf-8");
  }

  const scale = hints?.largerText || variant === "large" ? 1.25 : variant === "sticker" ? 1.15 : 1;
  const centered = variant === "centered" || variant === "sticker" || hints?.centered;
  const padX = 32;
  const padY = variant === "sticker" ? 28 : 24;
  const accentBar = 10;
  const textLeft = centered ? padX : padX + accentBar + 12;
  const usableWidth = width - textLeft - padX;

  const headlineSize = Math.max(26, Math.round((width / 18) * scale));
  const subSize = Math.max(18, Math.round((width / 30) * scale));

  const maxChars = Math.max(18, Math.round(usableWidth / (headlineSize * 0.55)));
  const subMaxChars = Math.max(28, Math.round(usableWidth / (subSize * 0.55)));

  const headlineLines = safeHeadline ? wrapText(safeHeadline, maxChars) : [];
  const subLines = safeSub ? wrapText(safeSub, subMaxChars) : [];

  const headlineLineHeight = headlineSize + 10;
  const subLineHeight = subSize + 8;

  const anchor = centered ? "middle" : "start";
  const xPos = centered ? width / 2 : textLeft;

  const headlineBlocks = headlineLines
    .map(
      (line, i) =>
        `<text x="${xPos}" y="${padY + headlineSize + i * headlineLineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineSize}" font-weight="900" fill="${palette.primary}" text-anchor="${anchor}">${line}</text>`
    )
    .join("");

  const subYOffset = padY + headlineSize + headlineLines.length * headlineLineHeight - 10 + (headlineLines.length && subLines.length ? 12 : 0);
  const subBlocks = subLines
    .map(
      (line, i) =>
        `<text x="${xPos}" y="${subYOffset + subSize + i * subLineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${subSize}" font-weight="600" fill="#334155" text-anchor="${anchor}">${line}</text>`
    )
    .join("");

  const contentHeight = subYOffset + (subLines.length ? subLines.length * subLineHeight + 8 : 0);
  const height = Math.max(Math.round(width * 0.10), contentHeight + padY);

  let cardFill = "#FFFFFF";
  let cardStroke = palette.primary;
  let cardOpacity = "0.97";
  let accentFill = palette.accent;
  let stickerRotation = 0;

  if (variant === "sticker") {
    cardFill = palette.accent;
    cardStroke = palette.primary;
    accentFill = palette.primary;
    stickerRotation = -2;
  }

  const stickerTransform = stickerRotation ? `transform="rotate(${stickerRotation}, ${width / 2}, ${height / 2})"` : "";

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect x="10" y="6" width="${width - 20}" height="${height - 12}" fill="${cardFill}" opacity="${cardOpacity}" rx="16" stroke="${cardStroke}" stroke-width="3" ${stickerTransform}/>
  ${centered ? "" : `<rect x="10" y="6" width="${accentBar}" height="${height - 12}" fill="${accentFill}" rx="4" ${stickerTransform}/>`}
  ${headlineBlocks}
  ${subBlocks}
</svg>`;
  return Buffer.from(svg, "utf-8");
}

function buildServicesGridSvg(
  width: number,
  bullets: string[],
  palette: BrandPalette,
  hints?: LayoutHints,
  colCountOverride?: 1 | 2
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

  const colCount = colCountOverride ?? (hints?.noServiceBoxes ? 1 : 2);
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

    const textLeft = currentX + 26;
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

// ─── Template backgrounds ───

function buildServiceBusinessBackground(width: number, height: number, palette: BrandPalette): Buffer {
  const bandY1 = Math.round(height * 0.12);
  const bandY2 = Math.round(height * 0.32);
  const panelY = Math.round(height * 0.30);
  const panelH = Math.round(height * 0.38);
  const bottomShapeY = height - 80;
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:${palette.primary};stop-opacity:0.22" />
      <stop offset="30%" style="stop-color:#FAFBFC;stop-opacity:1" />
      <stop offset="60%" style="stop-color:#F1F5F9;stop-opacity:1" />
      <stop offset="100%" style="stop-color:${palette.secondary};stop-opacity:0.18" />
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

function buildRetailProductBackground(width: number, height: number, palette: BrandPalette): Buffer {
  const heroY = Math.round(height * 0.18);
  const heroH = Math.round(height * 0.42);
  const bottomShapeY = height - 60;
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:${palette.primary};stop-opacity:0.18" />
      <stop offset="25%" style="stop-color:#FFFFFF;stop-opacity:1" />
      <stop offset="75%" style="stop-color:#F8FAFC;stop-opacity:1" />
      <stop offset="100%" style="stop-color:${palette.secondary};stop-opacity:0.14" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bgGrad)"/>
  <rect x="0" y="0" width="${width}" height="12" fill="${palette.accent}"/>
  <rect x="${Math.round(width * 0.08)}" y="${heroY}" width="${Math.round(width * 0.84)}" height="${heroH}" rx="32" fill="${palette.primary}" opacity="0.08" stroke="${palette.primary}" stroke-width="3" stroke-opacity="0.18"/>
  <circle cx="${Math.round(width * 0.18)}" cy="${Math.round(height * 0.68)}" r="${Math.round(width * 0.22)}" fill="${palette.accent}" opacity="0.12"/>
  <circle cx="${Math.round(width * 0.88)}" cy="${Math.round(height * 0.80)}" r="${Math.round(width * 0.28)}" fill="${palette.primary}" opacity="0.10"/>
  <path d="M0,${bottomShapeY} Q${Math.round(width / 2)},${bottomShapeY - 40} ${width},${bottomShapeY + 10} L${width},${height} L0,${height} Z" fill="${palette.primary}" opacity="0.08"/>
</svg>`;
  return Buffer.from(svg, "utf-8");
}

function buildOfferCampaignBackground(width: number, height: number, palette: BrandPalette): Buffer {
  const stripeW = Math.round(width * 0.25);
  const centerY = Math.round(height * 0.46);
  const centerH = Math.round(height * 0.34);
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${palette.primary};stop-opacity:0.28" />
      <stop offset="50%" style="stop-color:#FFFFFF;stop-opacity:1" />
      <stop offset="100%" style="stop-color:${palette.accent};stop-opacity:0.18" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bgGrad)"/>
  <rect x="0" y="0" width="${width}" height="12" fill="${palette.accent}"/>
  <polygon points="0,${Math.round(height * 0.15)} ${stripeW},0 0,0" fill="${palette.primary}" opacity="0.16"/>
  <polygon points="${width},${Math.round(height * 0.20)} ${width - stripeW},0 ${width},0" fill="${palette.accent}" opacity="0.14"/>
  <polygon points="${width},${Math.round(height * 0.85)} ${width - Math.round(stripeW * 1.2)},${height} ${width},${height}" fill="${palette.primary}" opacity="0.14"/>
  <rect x="${Math.round(width * 0.06)}" y="${centerY}" width="${Math.round(width * 0.88)}" height="${centerH}" rx="28" fill="#FFFFFF" opacity="0.90" stroke="${palette.primary}" stroke-width="3" stroke-opacity="0.20"/>
</svg>`;
  return Buffer.from(svg, "utf-8");
}

// ─── Template registry ───

interface TemplateLayout {
  id: TemplateId;
  label: string;
  categoryAffinity: string[];
  headerVariant: "default" | "centered" | "wide-logo";
  headerHeightRatio: number;
  logoBackdrop: boolean;
  logoMaxWidthRatio: number;
  showHeaderName: boolean;
  offerVariant: "default" | "centered" | "large" | "sticker";
  offerTopRatio: number;
  offerWidthRatio: number;
  offerAlign: "left" | "center";
  servicesEnabled: boolean;
  servicesTopRatio: number;
  servicesWidthRatio: number;
  servicesMaxBullets: number;
  servicesColCount: 1 | 2;
  footerAnchored: boolean;
  footerMaxBottomOffset: number;
  buildBackground: (width: number, height: number, palette: BrandPalette) => Buffer;
}

const TEMPLATES: Record<TemplateId, TemplateLayout> = {
  service_business_promo: {
    id: "service_business_promo",
    label: "Service Business Promo",
    categoryAffinity: ["print_shop", "beauty", "fitness_health", "real_estate", "education", "general", "auto", "tech"],
    headerVariant: "default",
    headerHeightRatio: 0.095,
    logoBackdrop: true,
    logoMaxWidthRatio: 0.40,
    showHeaderName: true,
    offerVariant: "default",
    offerTopRatio: 0.16,
    offerWidthRatio: 0.92,
    offerAlign: "left",
    servicesEnabled: true,
    servicesTopRatio: 0.34,
    servicesWidthRatio: 0.92,
    servicesMaxBullets: 4,
    servicesColCount: 2,
    footerAnchored: true,
    footerMaxBottomOffset: 0,
    buildBackground: buildServiceBusinessBackground,
  },
  retail_product_promo: {
    id: "retail_product_promo",
    label: "Retail / Product Promo",
    categoryAffinity: ["food", "retail", "art_decor"],
    headerVariant: "default",
    headerHeightRatio: 0.075,
    logoBackdrop: false,
    logoMaxWidthRatio: 0.32,
    showHeaderName: true,
    offerVariant: "large",
    offerTopRatio: 0.62,
    offerWidthRatio: 0.88,
    offerAlign: "center",
    servicesEnabled: true,
    servicesTopRatio: 0.78,
    servicesWidthRatio: 0.88,
    servicesMaxBullets: 2,
    servicesColCount: 2,
    footerAnchored: true,
    footerMaxBottomOffset: 0,
    buildBackground: buildRetailProductBackground,
  },
  offer_discount_campaign: {
    id: "offer_discount_campaign",
    label: "Offer / Discount Campaign",
    categoryAffinity: ["events", "general"],
    headerVariant: "centered",
    headerHeightRatio: 0.085,
    logoBackdrop: false,
    logoMaxWidthRatio: 0.45,
    showHeaderName: true,
    offerVariant: "sticker",
    offerTopRatio: 0.22,
    offerWidthRatio: 0.94,
    offerAlign: "center",
    servicesEnabled: true,
    servicesTopRatio: 0.48,
    servicesWidthRatio: 0.90,
    servicesMaxBullets: 3,
    servicesColCount: 1,
    footerAnchored: true,
    footerMaxBottomOffset: 0,
    buildBackground: buildOfferCampaignBackground,
  },
};

export function getTemplateLayout(templateId: TemplateId): TemplateLayout {
  return TEMPLATES[templateId];
}

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
  if (combined.includes("food") || combined.includes("restaurant") || combined.includes("cafe") || combined.includes("catering") || combined.includes("bakery")) {
    return "food";
  }
  if (combined.includes("beauty") || combined.includes("salon") || combined.includes("barber") || combined.includes("spa") || combined.includes("makeup") || combined.includes("hair") || combined.includes("nail")) {
    return "beauty";
  }
  if (combined.includes("real estate") || combined.includes("property") || combined.includes("housing") || combined.includes("rental")) {
    return "real_estate";
  }
  if (combined.includes("fitness") || combined.includes("gym") || combined.includes("health") || combined.includes("wellness") || combined.includes("yoga") || combined.includes("personal train")) {
    return "fitness_health";
  }
  if (combined.includes("event") || combined.includes("wedding") || combined.includes("party") || combined.includes("venue") || combined.includes("conference")) {
    return "events";
  }
  if (combined.includes("retail") || combined.includes("shop") || combined.includes("boutique") || combined.includes("store")) {
    return "retail";
  }
  if (combined.includes("education") || combined.includes("training") || combined.includes("course") || combined.includes("tutor")) {
    return "education";
  }
  if (combined.includes("auto") || combined.includes("car") || combined.includes("vehicle") || combined.includes("mechanic") || combined.includes("detailing")) {
    return "auto";
  }
  if (combined.includes("tech") || combined.includes("software") || combined.includes("it ") || combined.includes("app") || combined.includes("web design") || combined.includes("computer")) {
    return "tech";
  }
  return "general";
}

export function selectTemplate(spec: BrandOverlaySpec): TemplateId {
  if (spec.templateId && TEMPLATES[spec.templateId]) {
    return spec.templateId;
  }

  const category = inferServiceCategory(spec.business, spec.campaign);
  const creativeType = (spec.creativeType || "leaflet").toLowerCase();

  if (creativeType === "offer_advert" || category === "events") {
    return "offer_discount_campaign";
  }

  if (TEMPLATES.retail_product_promo.categoryAffinity.includes(category)) {
    return "retail_product_promo";
  }

  return "service_business_promo";
}

export function defaultServiceBullets(business: any, campaign: any): string[] {
  const category = inferServiceCategory(business, campaign);
  switch (category) {
    case "print_shop":
      return [
        "Business Cards & Stationery",
        "Flyers, Posters & Banners",
        "Canvas & Photo Prints",
        "Document Copying & Binding",
        "Courier & Delivery",
        "Branding & Design Support",
      ];
    case "art_decor":
      return [
        "Custom Canvas Prints",
        "Framed Posters",
        "Afrocentric Wall Art",
        "Home & Office Décor",
        "Premium Quality Materials",
        "Ready to Hang",
      ];
    case "food":
      return [
        "Fresh Quality Ingredients",
        "Dine-in, Takeaway & Delivery",
        "Catering for Events",
        "Daily Specials",
        "Family Meals",
      ];
    case "beauty":
      return [
        "Hair Styling & Treatments",
        "Nails, Makeup & Beauty",
        "Spa & Relaxation",
        "Skincare",
        "Walk-ins Welcome",
      ];
    case "real_estate":
      return [
        "Homes for Sale",
        "Rental Properties",
        "Property Valuations",
        "Buyer & Seller Advice",
      ];
    case "fitness_health":
      return [
        "Personal Training",
        "Group Classes",
        "Nutrition Coaching",
        "Gym Memberships",
      ];
    case "events":
      return [
        "Venue Hire",
        "Event Planning",
        "Decor & Styling",
        "Catering & Photography",
      ];
    case "retail":
      return [
        "In-Store Shopping",
        "Delivery Available",
        "Gift Cards",
        "New Arrivals",
      ];
    case "education":
      return [
        "Courses & Training",
        "Private Tutoring",
        "Workshops",
        "Certifications",
      ];
    case "auto":
      return [
        "Vehicle Repairs",
        "Servicing & Diagnostics",
        "Detailing",
        "Parts & Tyres",
      ];
    case "tech":
      return [
        "Web & App Development",
        "IT Support",
        "Cloud Solutions",
        "Custom Software",
      ];
    default:
      return [
        "Professional Quality",
        "Fast Turnaround",
        "Easy to Order",
        "Customer Support",
      ];
  }
}

// ─── Core template renderer ───

interface RenderTemplateOptions {
  baseImageBuffer?: Buffer;
  width: number;
  height: number;
  business: any;
  campaign?: any;
  post?: any;
  template: TemplateLayout;
  palette: BrandPalette;
  logoBuffer: Buffer | null;
  businessName: string;
  offerText: string;
  subheadlineText: string;
  ctaText: string;
  bullets: string[];
  hints: LayoutHints;
}

async function renderTemplate(opts: RenderTemplateOptions): Promise<{ buffer: Buffer; logoApplied: boolean; footerTop: number; footerHeight: number }> {
  const { baseImageBuffer, width, height, business, template, palette, logoBuffer, businessName, offerText, subheadlineText, ctaText, bullets, hints } = opts;

  const headerHeight = Math.round(height * template.headerHeightRatio);
  const headerVariant = hints.stretchLogo || hints.wideLogo ? "wide-logo" : template.headerVariant;
  const showHeaderName = template.showHeaderName && !hints.removeHeaderName;
  const headerSvg = buildHeaderSvg(width, headerHeight, showHeaderName ? businessName : "", palette, headerVariant);

  const contactLines: string[] = [];
  if (business?.whatsappNumber) contactLines.push(`WhatsApp: ${sanitize(business.whatsappNumber)}`);
  if (business?.location) contactLines.push(`Location: ${sanitize(business.location)}`);
  if (business?.website) contactLines.push(`Website: ${sanitize(business.website)}`);
  if (business?.email) contactLines.push(`Email: ${sanitize(business.email)}`);

  const footerSvg = buildFooterSvg(width, 0, contactLines.slice(0, 3), ctaText, palette, { centered: template.id === "offer_discount_campaign" });
  const footerMeta = await sharp(footerSvg).metadata();
  const footerHeight = footerMeta.height || Math.round(height * 0.18);

  let footerTop: number;
  if (template.footerAnchored) {
    footerTop = height - footerHeight;
  } else {
    footerTop = Math.max(height - footerHeight - template.footerMaxBottomOffset, headerHeight);
  }

  const overlays: sharp.OverlayOptions[] = [
    { input: headerSvg, top: 0, left: 0 },
    { input: footerSvg, top: footerTop, left: 0 },
  ];

  let logoApplied = false;
  let footerLogoWidth = 0;
  let footerLogoHeight = 0;

  if (logoBuffer) {
    const logoMeta = await sharp(logoBuffer).metadata();
    const logoAspect = (logoMeta.width || 1) / (logoMeta.height || 1);
    const logoHeight = headerHeight - 26;
    const logoWidth = Math.round(logoHeight * logoAspect);
    const maxLogoWidth = Math.round(width * (headerVariant === "wide-logo" ? 0.55 : template.logoMaxWidthRatio));
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

    let logoLeft: number;
    let logoTop: number;
    if (headerVariant === "wide-logo") {
      logoLeft = 24;
      logoTop = 13 + Math.round((headerHeight - 26 - finalHeight) / 2);
    } else if (template.headerVariant === "centered") {
      logoLeft = 24;
      logoTop = 13 + Math.round((headerHeight - 26 - finalHeight) / 2);
    } else {
      logoLeft = 24;
      logoTop = 13 + Math.round((headerHeight - 26 - finalHeight) / 2);
    }

    if (template.logoBackdrop) {
      const backdropPadX = 14;
      const backdropPadY = 10;
      const backdropWidth = finalWidth + backdropPadX * 2;
      const backdropHeight = finalHeight + backdropPadY * 2;
      const backdropFill = isLightColor(palette.primary) ? "#0F172A" : "#FFFFFF";
      const backdropSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${backdropWidth}" height="${backdropHeight}">
  <rect width="${backdropWidth}" height="${backdropHeight}" rx="14" ry="14" fill="${backdropFill}"/>
</svg>`;
      overlays.push(
        { input: Buffer.from(backdropSvg, "utf-8"), top: logoTop - backdropPadY, left: logoLeft - backdropPadX },
        { input: logoPng, top: logoTop, left: logoLeft }
      );
    } else {
      overlays.push({ input: logoPng, top: logoTop, left: logoLeft });
    }
    logoApplied = true;

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

  // Offer badge
  const offerTop = Math.round(height * template.offerTopRatio);
  const offerWidth = Math.round(width * template.offerWidthRatio);
  const offerLeft = template.offerAlign === "center" || hints.centerOffer
    ? Math.round((width - offerWidth) / 2)
    : Math.round((width - offerWidth) / 2);

  const badgeSubheadline = hints.removeSubheadline ? "" : subheadlineText;
  const badgeSvg = buildOfferBadgeSvg(
    offerWidth,
    offerText,
    badgeSubheadline,
    palette,
    hints,
    template.offerVariant
  );
  overlays.push({ input: badgeSvg, top: offerTop, left: offerLeft });

  // Service grid
  if (template.servicesEnabled && bullets.length > 0) {
    const gridTop = Math.round(height * template.servicesTopRatio);
    const gridWidth = Math.round(width * template.servicesWidthRatio);
    const gridLeft = Math.round((width - gridWidth) / 2);
    const maxBullets = hints.fewerServices || hints.cleaner
      ? Math.min(2, template.servicesMaxBullets)
      : template.servicesMaxBullets;
    const colCount = hints.stackVertical ? 1 : template.servicesColCount;
    let gridBullets = bullets.slice(0, maxBullets);

    while (gridBullets.length > 0) {
      const gridSvg = buildServicesGridSvg(gridWidth, gridBullets, palette, hints, colCount);
      const gridMeta = await sharp(gridSvg).metadata();
      const actualGridHeight = gridMeta.height || Math.round(height * 0.22);
      if (gridTop + actualGridHeight <= footerTop - Math.round(height * 0.02)) {
        overlays.push({ input: gridSvg, top: gridTop, left: gridLeft });
        break;
      }
      gridBullets = gridBullets.slice(0, -1);
    }
  }

  // Compose on background
  let canvas: sharp.Sharp;
  if (baseImageBuffer) {
    canvas = sharp(baseImageBuffer);
  } else {
    const backgroundSvg = template.buildBackground(width, height, palette);
    canvas = sharp(backgroundSvg).resize(width, height, { fit: "fill" });
  }

  const buffer = await canvas.composite(overlays).png().toBuffer();
  console.log(`[LeafletBrand] template=${template.id} | logoApplied=${logoApplied} | paletteSource=${palette.source}`);
  return { buffer, logoApplied, footerTop, footerHeight };
}

// ─── Public API ───

export async function composeBrandedLeafletImage(
  baseImageBuffer: Buffer,
  spec: BrandOverlaySpec
): Promise<{ buffer: Buffer; logoApplied: boolean; footerTop?: number; footerHeight?: number }> {
  console.log(`[LeafletBrand] businessId=${spec.business?.id ?? "none"} | business.logo=${spec.business?.logo ?? "none"}`);
  const resolvedLogoPath = spec.business?.logo ? resolveLocalPathFromPublicUrl(spec.business.logo) : null;
  console.log(`[LeafletBrand] resolvedLogoPath=${resolvedLogoPath ?? "none"} | logoFileExists=${resolvedLogoPath ? fs.existsSync(resolvedLogoPath) : false}`);

  const base = sharp(baseImageBuffer);
  const meta = await base.metadata();
  const width = meta.width || 1024;
  const height = meta.height || 1536;

  const palette = spec.palette || await resolveBrandPalette(spec.business);
  const businessName = sanitize(spec.business?.name) || sanitize(spec.post?.title) || "Your Business";
  const ctaText = sanitize(spec.cta || spec.campaign?.preferredCta || spec.post?.cta || "Contact us today");
  const offerText = sanitize(spec.offer || "");
  const subheadlineText = sanitize(spec.subheadline || spec.campaign?.mainPainPoint || spec.campaign?.coreMessage || spec.post?.hook || "");

  const logoBuffer = await loadLogoBuffer(spec.business?.logo);
  console.log(`[LeafletBrand] logoLoadSuccess=${!!logoBuffer}`);
  if (spec.business?.logo && !logoBuffer) {
    console.warn(`[LeafletBrand] Could not load logo buffer | logo=${spec.business.logo}`);
  }

  if (spec.creativeType && spec.creativeType !== "leaflet") {
    const watermarkHeight = 48;
    const watermarkSvg = buildWatermarkSvg(width, businessName, palette);
    const composite = await base
      .composite([{ input: watermarkSvg, top: height - watermarkHeight, left: 0 }])
      .toBuffer();

    if (!logoBuffer) return { buffer: composite, logoApplied: false };
    const logoPng = await resizeLogo(logoBuffer, 40);
    const buffer = await sharp(composite).composite([{ input: logoPng, top: 12, left: 12 }]).toBuffer();
    return { buffer, logoApplied: true };
  }

  const templateId = selectTemplate(spec);
  const template = getTemplateLayout(templateId);
  const hints = parseLayoutHints(`${spec.creativeGuidance || ""} ${spec.refinementInstruction || ""}`);
  const bullets = spec.serviceBullets?.length ? spec.serviceBullets : defaultServiceBullets(spec.business, spec.campaign);

  const result = await renderTemplate({
    baseImageBuffer,
    width,
    height,
    business: spec.business,
    campaign: spec.campaign,
    post: spec.post,
    template,
    palette,
    logoBuffer,
    businessName,
    offerText,
    subheadlineText,
    ctaText,
    bullets,
    hints,
  });

  return result;
}

function fallbackHeightForAspectRatio(aspectRatio?: string): number {
  if (!aspectRatio) return 1350;
  const ratio = aspectRatio.toLowerCase();
  if (ratio === "1:1") return 1080;
  if (ratio === "4:5") return 1350;
  if (ratio === "9:16" || ratio === "2:3") return 1920;
  if (ratio === "16:9" || ratio === "3:2" || ratio === "4:3") return 608;
  if (ratio === "1.91:1") return 565;
  return 1350;
}

export async function generateFallbackLeafletImage(spec: BrandOverlaySpec): Promise<{ buffer: Buffer; footerTop?: number; footerHeight?: number }> {
  const width = 1080;
  const height = fallbackHeightForAspectRatio(spec.aspectRatio);

  const palette = spec.palette || await resolveBrandPalette(spec.business);
  const businessName = sanitize(spec.business?.name) || sanitize(spec.post?.title) || "Your Business";
  const ctaText = sanitize(spec.cta || spec.campaign?.preferredCta || spec.post?.cta || "Contact us today");
  const offerText = sanitize(spec.headline || spec.offer || "");
  const subheadlineText = sanitize(spec.subheadline || spec.campaign?.mainPainPoint || spec.campaign?.coreMessage || spec.post?.hook || "");

  const logoBuffer = await loadLogoBuffer(spec.business?.logo);
  const hints = parseLayoutHints(`${spec.creativeGuidance || ""} ${spec.refinementInstruction || ""}`);
  const bullets = spec.serviceBullets?.length ? spec.serviceBullets : defaultServiceBullets(spec.business, spec.campaign);

  const templateId = selectTemplate(spec);
  const template = getTemplateLayout(templateId);

  console.log(`[FallbackLeaflet] template=${templateId} | business=${businessName} | size=${width}x${height}`);

  const result = await renderTemplate({
    width,
    height,
    business: spec.business,
    campaign: spec.campaign,
    post: spec.post,
    template,
    palette,
    logoBuffer,
    businessName,
    offerText,
    subheadlineText,
    ctaText,
    bullets,
    hints,
  });

  return result;
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
