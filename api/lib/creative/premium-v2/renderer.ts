/**
 * Premium Leaflet V2 – SVG renderer.
 *
 * Produces a 1080x1350 premium leaflet PNG from a PremiumLeafletV2Brief.
 * The layout adapts to the brief's category, density, and visual style while
 * enforcing universal premium rules: safe margins, readable type, clear CTA,
 * strong hierarchy, and no clipped elements.
 */

import sharp from "sharp";
import type { TemplateRendererProvider, TemplateRendererRequest, TemplateRendererResult } from "../providers/template-renderer";
import type { PremiumLeafletV2Brief, PremiumV2LayoutDensity } from "./types";
import { validatePremiumV2Quality } from "./quality";

const WIDTH = 1080;
const HEIGHT = 1350;
const MARGIN = 56;
const SAFE_BOTTOM = HEIGHT - MARGIN;

// Minimum readable font sizes (px).
const MIN_HEADLINE = 44;
const MIN_SUBHEADLINE = 22;
const MIN_CTA = 26;
const MIN_SERVICE = 20;
const MIN_FOOTER = 18;
const MIN_STRIP = 16;

function safeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function escapeXml(unsafe: string): string {
  return safeText(unsafe)
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

function fitFontSize(text: string, availableWidth: number, maxSize: number, minSize: number): number {
  for (let size = maxSize; size >= minSize; size -= 2) {
    const approxWidth = text.length * size * 0.55;
    if (approxWidth <= availableWidth) return size;
  }
  return minSize;
}

async function svgToPng(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg, "utf-8")).png().toBuffer();
}

async function fetchLogoBuffer(logoUrl: string | undefined): Promise<Buffer | null> {
  if (!logoUrl) return null;
  try {
    const res = await fetch(logoUrl);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function compositeLogo(background: Buffer, logoBuffer: Buffer, x: number, y: number, maxWidth: number, maxHeight: number): Promise<Buffer> {
  const resized = await sharp(logoBuffer)
    .resize({ width: maxWidth, height: maxHeight, fit: sharp.fit.inside, withoutEnlargement: true })
    .png()
    .toBuffer();
  const meta = await sharp(resized).metadata();
  const left = Math.round(x - (meta.width || maxWidth) / 2);
  const top = Math.round(y - (meta.height || maxHeight) / 2);
  return sharp(background).composite([{ input: resized, left, top }]).png().toBuffer();
}

function contrastColor(hex: string): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16) || 0;
  const g = parseInt(clean.substring(2, 4), 16) || 0;
  const b = parseInt(clean.substring(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#0F172A" : "#FFFFFF";
}

function densityCards(density: PremiumV2LayoutDensity): { maxPrimary: number; columns: number; compact: boolean } {
  switch (density) {
    case "premium_minimal":
      return { maxPrimary: 3, columns: 1, compact: false };
    case "offer_focused":
      return { maxPrimary: 4, columns: 2, compact: false };
    case "corporate_professional":
      return { maxPrimary: 4, columns: 2, compact: true };
    case "local_promo":
      return { maxPrimary: 4, columns: 2, compact: false };
    case "catalogue_brochure":
      return { maxPrimary: 10, columns: 2, compact: true };
    case "premium_services":
    default:
      return { maxPrimary: 5, columns: 2, compact: false };
  }
}

function buildBackground(brief: PremiumLeafletV2Brief): string {
  const { primary, secondary, background } = brief.brandPalette;
  const category = brief.businessCategory;

  // Subtle top-to-bottom gradient using brand colours at very low opacity.
  const top = brief.visualStyle === "bold" || brief.layoutDensity === "local_promo" ? primary : background;
  const bottom = brief.visualStyle === "luxury" || brief.visualStyle === "modern" ? secondary : background;

  // Category accent block near the top for visual interest.
  const accentH = category === "food_restaurant" || category === "beauty_wellness" ? 420 : 320;
  const accentPath =
    category === "retail_product"
      ? `<polygon points="0,0 ${WIDTH},0 ${WIDTH},${accentH - 80} 0,${accentH}" fill="${primary}" opacity="0.9"/>`
      : `<path d="M0,0 H${WIDTH} V${accentH} Q${WIDTH / 2},${accentH + 60} 0,${accentH - 40} Z" fill="${primary}" opacity="0.92"/>`;

  return `
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${background}"/>
    <defs>
      <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${top}" stop-opacity="0.05"/>
        <stop offset="100%" stop-color="${bottom}" stop-opacity="0.03"/>
      </linearGradient>
    </defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bgGrad)"/>
    ${accentPath}
  `;
}

function buildHeader(brief: PremiumLeafletV2Brief): { svg: string; height: number; logoArea: { x: number; y: number; max: number } } {
  const { businessName, brandPalette } = brief;
  const height = 120;
  const logoMax = 84;
  const logoX = MARGIN + logoMax / 2;
  const logoY = height / 2;
  const nameX = MARGIN + logoMax + 18;
  const nameMaxWidth = WIDTH - nameX - MARGIN;
  const nameSize = Math.max(24, fitFontSize(businessName, nameMaxWidth, 40, 24));

  const nameLines = wrapText(businessName, Math.round(nameMaxWidth / (nameSize * 0.55)));
  const lineHeight = nameSize + 6;
  const blockHeight = nameLines.length * lineHeight;
  const startY = (height - blockHeight) / 2 + nameSize - 4;

  const nameSvg = nameLines
    .map(
      (line, i) =>
        `<text x="${nameX}" y="${startY + i * lineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${nameSize}" font-weight="800" fill="${contrastColor(brandPalette.primary)}">${escapeXml(line)}</text>`
    )
    .join("");

  const svg = nameSvg;
  return { svg, height, logoArea: { x: logoX, y: logoY, max: logoMax } };
}

function buildFooter(brief: PremiumLeafletV2Brief, y: number): { svg: string; height: number } {
  const { contact, brandPalette, businessName } = brief;
  const height = 104;

  const items: string[] = [];
  if (contact.phone) items.push(`${contact.phone}`);
  else if (contact.whatsapp) items.push(`${contact.whatsapp}`);
  if (contact.email) items.push(`${contact.email}`);
  if (contact.website) items.push(`${contact.website}`);
  if (contact.location) items.push(`${contact.location}`);

  const line = items.join("   ·   ");
  const maxWidth = WIDTH - MARGIN * 2;
  const size = Math.max(MIN_FOOTER, fitFontSize(line, maxWidth, 22, MIN_FOOTER));
  const lines = wrapText(line, Math.round(maxWidth / (size * 0.55)));
  const lineHeight = size + 6;

  const textY = y + height / 2 + size / 2 - ((lines.length - 1) * lineHeight) / 2;
  const textSvg = lines
    .map(
      (l, i) =>
        `<text x="${WIDTH / 2}" y="${textY + i * lineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="600" fill="${contrastColor(brandPalette.primary)}" text-anchor="middle">${escapeXml(l)}</text>`
    )
    .join("");

  const businessNameSize = Math.max(14, Math.min(18, fitFontSize(businessName, maxWidth, 18, 14)));
  const businessNameSvg = `<text x="${WIDTH / 2}" y="${y + 28}" font-family="Arial, Helvetica, sans-serif" font-size="${businessNameSize}" font-weight="700" fill="${contrastColor(brandPalette.primary)}" text-anchor="middle" opacity="0.9">${escapeXml(businessName)}</text>`;

  const svg = `
    <rect x="0" y="${y}" width="${WIDTH}" height="${height}" fill="${brandPalette.primary}"/>
    ${businessNameSvg}
    ${textSvg}
  `;
  return { svg, height };
}

function buildCta(brief: PremiumLeafletV2Brief, y: number): { svg: string; height: number; bounds: { x: number; y: number; w: number; h: number } } {
  const { cta, brandPalette } = brief;
  const height = 96;
  const buttonH = 68;
  const buttonW = Math.min(720, WIDTH - MARGIN * 2);
  const buttonX = (WIDTH - buttonW) / 2;
  const buttonY = y + (height - buttonH) / 2;
  const size = Math.max(MIN_CTA, fitFontSize(cta, buttonW - 64, 34, MIN_CTA));

  const svg = `
    <rect x="${buttonX}" y="${buttonY}" width="${buttonW}" height="${buttonH}" rx="14" fill="${brandPalette.accent}"/>
    <text x="${WIDTH / 2}" y="${buttonY + buttonH / 2 + size / 3}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="800" fill="${contrastColor(brandPalette.accent)}" text-anchor="middle">${escapeXml(cta)}</text>
  `;
  return { svg, height, bounds: { x: buttonX, y: buttonY, w: buttonW, h: buttonH } };
}

function buildHero(brief: PremiumLeafletV2Brief, y: number, maxWidth: number): { svg: string; height: number } {
  const { headline, subheadline, offer, brandPalette } = brief;
  let cursorY = y;

  const headlineSize = Math.max(MIN_HEADLINE, fitFontSize(headline, maxWidth, 62, MIN_HEADLINE));
  const headlineLines = wrapText(headline, Math.round(maxWidth / (headlineSize * 0.55)));
  const headlineSvg = headlineLines
    .map(
      (line, i) =>
        `<text x="${WIDTH / 2}" y="${cursorY + (i + 1) * (headlineSize + 10)}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineSize}" font-weight="900" fill="${contrastColor(brandPalette.primary)}" text-anchor="middle">${escapeXml(line)}</text>`
    )
    .join("");
  cursorY += headlineLines.length * (headlineSize + 10) + 18;

  let offerSvg = "";
  if (offer) {
    const offerSize = Math.max(26, fitFontSize(offer, maxWidth, 38, 26));
    const offerLines = wrapText(offer, Math.round(maxWidth / (offerSize * 0.55)));
    const offerH = offerLines.length * (offerSize + 8) + 32;
    offerSvg = `
      <rect x="${MARGIN}" y="${cursorY}" width="${maxWidth}" height="${offerH}" rx="12" fill="${brandPalette.accent}" opacity="0.14"/>
      ${offerLines
        .map(
          (line, i) =>
            `<text x="${WIDTH / 2}" y="${cursorY + 26 + (i + 1) * (offerSize + 8)}" font-family="Arial, Helvetica, sans-serif" font-size="${offerSize}" font-weight="800" fill="${brandPalette.accent}" text-anchor="middle">${escapeXml(line)}</text>`
        )
        .join("")}
    `;
    cursorY += offerH + 22;
  }

  let subSvg = "";
  if (subheadline) {
    const subSize = Math.max(MIN_SUBHEADLINE, Math.round(WIDTH / 38));
    const subLines = wrapText(subheadline, Math.round(maxWidth / (subSize * 0.55)));
    subSvg = subLines
      .map(
        (line, i) =>
          `<text x="${WIDTH / 2}" y="${cursorY + (i + 1) * (subSize + 8)}" font-family="Arial, Helvetica, sans-serif" font-size="${subSize}" font-weight="500" fill="${contrastColor(brandPalette.primary)}" opacity="0.92" text-anchor="middle">${escapeXml(line)}</text>`
      )
      .join("");
    cursorY += subLines.length * (subSize + 8) + 14;
  }

  return { svg: headlineSvg + offerSvg + subSvg, height: cursorY - y };
}

function buildServiceCards(brief: PremiumLeafletV2Brief, y: number, availableHeight: number): { svg: string; height: number; didCrowd: boolean } {
  const { primaryServices, secondaryServices, brandPalette, layoutDensity } = brief;
  const { maxPrimary, columns, compact } = densityCards(layoutDensity);
  const services = primaryServices.slice(0, maxPrimary);
  if (services.length === 0) return { svg: "", height: 0, didCrowd: false };

  const gap = compact ? 14 : 20;
  const cardW = (WIDTH - MARGIN * 2 - gap * (columns - 1)) / columns;
  const rows = Math.ceil(services.length / columns);

  // Determine card height from available space, but never let cards get too small.
  const maxCardH = compact ? 110 : 142;
  const minCardH = compact ? 72 : 96;
  const idealCardH = Math.max(minCardH, Math.min(maxCardH, Math.floor((availableHeight - (rows - 1) * gap) / rows)));
  const cardH = idealCardH;

  // Detect crowding when available space is too small for the requested number of cards.
  const requiredMin = rows * minCardH + (rows - 1) * gap;
  const didCrowd = availableHeight < requiredMin;

  let svg = "";
  services.forEach((svc, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = MARGIN + col * (cardW + gap);
    const cy = y + row * (cardH + gap);
    const nameSize = Math.max(MIN_SERVICE, fitFontSize(svc.name, cardW - 36, compact ? 26 : 30, MIN_SERVICE));
    const lines = wrapText(svc.name, Math.round((cardW - 36) / (nameSize * 0.55)));

    svg += `
      <rect x="${x}" y="${cy}" width="${cardW}" height="${cardH}" rx="12" fill="${brandPalette.background}" stroke="${brandPalette.secondary}" stroke-width="2" stroke-opacity="0.18"/>
      ${lines
        .map(
          (line, idx) =>
            `<text x="${x + cardW / 2}" y="${cy + cardH / 2 + (idx - (lines.length - 1) / 2) * (nameSize + 6) + nameSize / 3}" font-family="Arial, Helvetica, sans-serif" font-size="${nameSize}" font-weight="700" fill="${brandPalette.text}" text-anchor="middle">${escapeXml(line)}</text>`
        )
        .join("")}
    `;
  });

  const primaryHeight = rows * (cardH + gap) - gap;
  let secondaryHeight = 0;

  if (secondaryServices.length > 0 && layoutDensity !== "catalogue_brochure") {
    const stripY = y + primaryHeight + 32;
    const stripText = `Also available: ${secondaryServices.map((s) => s.name).join(" · ")}`;
    const stripSize = Math.max(MIN_STRIP, fitFontSize(stripText, WIDTH - MARGIN * 2, 22, MIN_STRIP));
    const stripLines = wrapText(stripText, Math.round((WIDTH - MARGIN * 2) / (stripSize * 0.55)));
    const stripH = stripLines.length * (stripSize + 6) + 24;

    svg += `
      <rect x="${MARGIN}" y="${stripY}" width="${WIDTH - MARGIN * 2}" height="${stripH}" rx="10" fill="${brandPalette.secondary}" opacity="0.08"/>
      ${stripLines
        .map(
          (line, i) =>
            `<text x="${WIDTH / 2}" y="${stripY + 18 + (i + 1) * (stripSize + 6)}" font-family="Arial, Helvetica, sans-serif" font-size="${stripSize}" font-weight="600" fill="${brandPalette.textMuted}" text-anchor="middle">${escapeXml(line)}</text>`
        )
        .join("")}
    `;
    secondaryHeight = stripH + 18;
  }

  // For catalogue mode, render remaining services as a compact two-column list.
  if (layoutDensity === "catalogue_brochure" && secondaryServices.length > 0) {
    const listY = y + primaryHeight + 28;
    const itemSize = Math.max(MIN_STRIP, 20);
    const all = [...primaryServices.slice(maxPrimary), ...secondaryServices];
    const colCount = 2;
    const perCol = Math.ceil(all.length / colCount);
    let listSvg = "";
    all.forEach((svc, i) => {
      const col = i % colCount;
      const row = Math.floor(i / colCount);
      const ix = MARGIN + col * ((WIDTH - MARGIN * 2) / colCount + 12);
      const iy = listY + row * (itemSize + 10);
      listSvg += `<text x="${ix}" y="${iy}" font-family="Arial, Helvetica, sans-serif" font-size="${itemSize}" font-weight="500" fill="${brandPalette.text}">• ${escapeXml(svc.name)}</text>`;
    });
    svg += listSvg;
    secondaryHeight = perCol * (itemSize + 10) + 24;
  }

  return { svg, height: primaryHeight + secondaryHeight, didCrowd };
}

function buildBenefits(brief: PremiumLeafletV2Brief, y: number): { svg: string; height: number } {
  const { benefits, brandPalette } = brief;
  if (!benefits.length) return { svg: "", height: 0 };

  const items = benefits.slice(0, 3);
  const itemSize = Math.max(MIN_SUBHEADLINE, 22);
  const maxW = (WIDTH - MARGIN * 2) / items.length - 16;

  let svg = "";
  items.forEach((benefit, i) => {
    const x = MARGIN + i * ((WIDTH - MARGIN * 2) / items.length) + (WIDTH - MARGIN * 2) / items.length / 2;
    const lines = wrapText(benefit, Math.round(maxW / (itemSize * 0.55)));
    const lineH = itemSize + 6;
    const blockH = lines.length * lineH;
    const startY = y + (60 - blockH) / 2 + itemSize;
    svg += `<circle cx="${x - Math.min(maxW, benefit.length * itemSize * 0.55) / 2 - 10}" cy="${startY - itemSize / 2}" r="4" fill="${brandPalette.accent}"/>`;
    svg += lines
      .map(
        (line, idx) =>
          `<text x="${x}" y="${startY + idx * lineH}" font-family="Arial, Helvetica, sans-serif" font-size="${itemSize}" font-weight="600" fill="${brandPalette.text}" text-anchor="middle">${escapeXml(line)}</text>`
      )
      .join("");
  });

  return { svg, height: 72 };
}

export interface V2RenderLayoutMetrics {
  width: number;
  height: number;
  ctaBoundingBox: { x: number; y: number; w: number; h: number };
  footerY: number;
  footerHeight: number;
  minFontSizeUsed: number;
  primaryCardCount: number;
  secondaryCardCount: number;
  layoutDensity: PremiumLeafletV2Brief["layoutDensity"];
  didCrowd: boolean;
}

export async function renderV2FromBrief(brief: PremiumLeafletV2Brief): Promise<{ buffer: Buffer; metrics: V2RenderLayoutMetrics }> {
  const header = buildHeader(brief);
  const footerH = 104;

  // Reserve space from the bottom up so CTA and footer are never clipped.
  const cta = buildCta(brief, SAFE_BOTTOM - 80 - footerH);
  const footer = buildFooter(brief, SAFE_BOTTOM - footerH + MARGIN);

  // Content sits between the header and the CTA, with generous padding.
  const contentTop = header.height + 24;
  const contentBottom = cta.bounds.y - 32;

  const hero = buildHero(brief, contentTop, WIDTH - MARGIN * 2);
  const heroBottom = contentTop + hero.height;

  // Reserve space for benefits strip between services and CTA.
  const benefitsSection = buildBenefits(brief, 0);
  const benefitsHeight = benefitsSection.height > 0 ? benefitsSection.height + 20 : 0;
  const servicesSpace = contentBottom - heroBottom - benefitsHeight - 28;
  const services = buildServiceCards(brief, heroBottom + 28, servicesSpace);
  const servicesBottom = heroBottom + 28 + services.height;

  const benefits = buildBenefits(brief, servicesBottom + 16);

  const svgParts: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    buildBackground(brief),
    header.svg,
    hero.svg,
    services.svg,
    benefits.svg,
    cta.svg,
    footer.svg,
    `</svg>`,
  ];

  const png = await svgToPng(svgParts.join(""));

  // Composite logo if provided.
  const logoBuffer = await fetchLogoBuffer(brief.logoUrl);
  const finalBuffer = logoBuffer
    ? await compositeLogo(png, logoBuffer, header.logoArea.x, header.logoArea.y, header.logoArea.max, header.logoArea.max)
    : png;

  const metrics: V2RenderLayoutMetrics = {
    width: WIDTH,
    height: HEIGHT,
    ctaBoundingBox: cta.bounds,
    footerY: SAFE_BOTTOM - footerH + MARGIN,
    footerHeight: footerH,
    minFontSizeUsed: MIN_SERVICE,
    primaryCardCount: brief.primaryServices.length,
    secondaryCardCount: brief.secondaryServices.length,
    layoutDensity: brief.layoutDensity,
    didCrowd: services.didCrowd,
  };

  return { buffer: finalBuffer, metrics };
}

export class PremiumV2Renderer implements TemplateRendererProvider {
  name = "premium-v2";

  get configured(): boolean {
    return true;
  }

  async render(req: TemplateRendererRequest): Promise<TemplateRendererResult> {
    const brief = (req as any).v2Brief as PremiumLeafletV2Brief | undefined;
    if (!brief) {
      return {
        success: false,
        error: "Premium V2 renderer requires a v2Brief on the render request.",
      };
    }

    try {
      const { buffer, metrics } = await renderV2FromBrief(brief);
      return {
        success: true,
        imageBase64: buffer.toString("base64"),
        extension: "png",
        providerJobId: `premium-v2-${Date.now()}`,
        costUsd: 0,
        metadata: { v2LayoutMetrics: metrics },
      };
    } catch (err: any) {
      return {
        success: false,
        error: `Premium V2 render failed: ${err.message || String(err)}`,
      };
    }
  }
}

export { validatePremiumV2Quality };
