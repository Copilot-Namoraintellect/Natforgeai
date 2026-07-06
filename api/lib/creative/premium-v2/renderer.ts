/**
 * Premium Leaflet V2.1 – SVG renderer.
 *
 * Produces a 1080x1350 premium leaflet PNG from a PremiumLeafletV2Brief.
 * The renderer is now layout-preset aware, brand-fidelity first, and renders
 * service cards with descriptions, a stronger CTA block, and a branded footer.
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
const MIN_SERVICE_DESC = 14;
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

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const firstChars = words.map((w) => w[0]).filter(Boolean);
  if (firstChars.length === 0) return "?";
  if (firstChars.length === 1) return firstChars.slice(0, 2).join("").toUpperCase();
  return (firstChars[0] + firstChars[firstChars.length - 1]).toUpperCase();
}

async function drawTextLogo(background: Buffer, businessName: string, x: number, y: number, size: number, color: string): Promise<Buffer> {
  const text = initials(businessName);
  const fontSize = Math.round(size * 0.42);
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" rx="${size / 2}" fill="${color}"/>
      <text x="50%" y="55%" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900" fill="${contrastColor(color)}" text-anchor="middle" dominant-baseline="middle">${escapeXml(text)}</text>
    </svg>
  `;
  const buffer = await sharp(Buffer.from(svg, "utf-8")).png().toBuffer();
  const left = Math.round(x - size / 2);
  const top = Math.round(y - size / 2);
  return sharp(background).composite([{ input: buffer, left, top }]).png().toBuffer();
}

function contrastColor(hex: string): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16) || 0;
  const g = parseInt(clean.substring(2, 4), 16) || 0;
  const b = parseInt(clean.substring(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#0F172A" : "#FFFFFF";
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return null;
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return { r, g, b };
}

function lighten(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const r = Math.min(255, Math.round(rgb.r + (255 - rgb.r) * amount));
  const g = Math.min(255, Math.round(rgb.g + (255 - rgb.g) * amount));
  const b = Math.min(255, Math.round(rgb.b + (255 - rgb.b) * amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0").toUpperCase()}`;
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
      return { maxPrimary: 4, columns: 2, compact: false };
  }
}

type LayoutPreset =
  | "premium_services_brand_panel"
  | "premium_offer_hero"
  | "premium_local_service"
  | "premium_corporate_clean"
  | "premium_retail_promo"
  | "premium_food_offer"
  | "premium_beauty_booking";

function selectLayoutPreset(brief: PremiumLeafletV2Brief): LayoutPreset {
  const { layoutDensity, businessCategory } = brief;
  if (businessCategory === "food_restaurant") return "premium_food_offer";
  if (businessCategory === "beauty_wellness") return "premium_beauty_booking";
  if (businessCategory === "retail_product") return "premium_retail_promo";
  if (layoutDensity === "corporate_professional") return "premium_corporate_clean";
  if (layoutDensity === "local_promo") return "premium_local_service";
  if (layoutDensity === "offer_focused") return "premium_offer_hero";
  return "premium_services_brand_panel";
}

function buildBackground(brief: PremiumLeafletV2Brief): string {
  const { primary, secondary, background, accent } = brief.brandPalette;
  const preset = selectLayoutPreset(brief);

  const heroH = preset === "premium_food_offer" || preset === "premium_beauty_booking" ? 460 : 380;
  const curve = `<path d="M0,0 H${WIDTH} V${heroH} Q${WIDTH / 2},${heroH + 70} 0,${heroH - 20} Z" fill="${primary}"/>`;

  const diagonal = `<polygon points="0,0 ${WIDTH},0 ${WIDTH},${heroH - 60} 0,${heroH}" fill="${primary}"/>`;

  const shape = preset === "premium_corporate_clean" || preset === "premium_retail_promo" ? diagonal : curve;

  // Abstract brand shapes in low opacity.
  const shapes = `
    <circle cx="${WIDTH - 120}" cy="${heroH + 80}" r="90" fill="${accent}" opacity="0.06"/>
    <circle cx="${WIDTH - 60}" cy="${heroH + 180}" r="60" fill="${secondary}" opacity="0.05"/>
    <rect x="${MARGIN}" y="${heroH + 120}" width="70" height="70" rx="16" fill="${accent}" opacity="0.04" transform="rotate(12 ${MARGIN + 35} ${heroH + 155})"/>
  `;

  return `
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${background}"/>
    <defs>
      <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${lighten(primary, 0.92)}" stop-opacity="1"/>
        <stop offset="100%" stop-color="${background}" stop-opacity="1"/>
      </linearGradient>
    </defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bgGrad)"/>
    ${shape}
    ${shapes}
  `;
}

function buildHeader(brief: PremiumLeafletV2Brief): { svg: string; height: number; logoArea: { x: number; y: number; max: number } } {
  const { businessName, brandPalette, logoUrl } = brief;
  const height = 120;
  const logoMax = 110;
  const logoX = MARGIN + logoMax / 2;
  const logoY = height / 2;
  const nameX = logoUrl ? MARGIN + logoMax + 24 : MARGIN;
  const nameMaxWidth = WIDTH - nameX - MARGIN;
  const nameSize = Math.max(26, fitFontSize(businessName, nameMaxWidth, 44, 26));

  const nameLines = wrapText(businessName, Math.round(nameMaxWidth / (nameSize * 0.55)));
  const lineHeight = nameSize + 8;
  const blockHeight = nameLines.length * lineHeight;
  const startY = (height - blockHeight) / 2 + nameSize - 2;

  const nameSvg = nameLines
    .map(
      (line, i) =>
        `<text x="${nameX}" y="${startY + i * lineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${nameSize}" font-weight="900" fill="${contrastColor(brandPalette.primary)}">${escapeXml(line)}</text>`
    )
    .join("");

  // Logo backing circle when logo is present.
  const backingSvg = logoUrl
    ? `<circle cx="${logoX}" cy="${logoY}" r="${logoMax / 2 + 6}" fill="#FFFFFF" opacity="0.95"/>`
    : "";

  const svg = `
    ${backingSvg}
    ${nameSvg}
  `;
  return { svg, height, logoArea: { x: logoX, y: logoY, max: logoMax } };
}

function buildFooter(brief: PremiumLeafletV2Brief, y: number): { svg: string; height: number } {
  const { contact, brandPalette, businessName } = brief;
  const height = 112;

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

  const businessNameSize = Math.max(14, Math.min(20, fitFontSize(businessName, maxWidth, 20, 14)));
  const businessNameSvg = `<text x="${WIDTH / 2}" y="${y + 32}" font-family="Arial, Helvetica, sans-serif" font-size="${businessNameSize}" font-weight="800" fill="${contrastColor(brandPalette.primary)}" text-anchor="middle" opacity="0.95">${escapeXml(businessName)}</text>`;

  const svg = `
    <rect x="0" y="${y}" width="${WIDTH}" height="${height}" fill="${brandPalette.primary}"/>
    ${businessNameSvg}
    ${textSvg}
  `;
  return { svg, height };
}

function buildCta(brief: PremiumLeafletV2Brief, y: number): { svg: string; height: number; bounds: { x: number; y: number; w: number; h: number } } {
  const { cta, brandPalette } = brief;
  const height = 104;
  const buttonH = 72;
  const buttonW = Math.min(760, WIDTH - MARGIN * 2);
  const buttonX = (WIDTH - buttonW) / 2;
  const buttonY = y + (height - buttonH) / 2;
  const size = Math.max(MIN_CTA, fitFontSize(cta, buttonW - 72, 36, MIN_CTA));

  const svg = `
    <rect x="${buttonX}" y="${buttonY}" width="${buttonW}" height="${buttonH}" rx="16" fill="${brandPalette.accent}"/>
    <rect x="${buttonX}" y="${buttonY + 4}" width="${buttonW}" height="${buttonH}" rx="16" fill="#000000" opacity="0.08"/>
    <text x="${WIDTH / 2}" y="${buttonY + buttonH / 2 + size / 3}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="900" fill="${contrastColor(brandPalette.accent)}" text-anchor="middle">${escapeXml(cta)}</text>
  `;
  return { svg, height, bounds: { x: buttonX, y: buttonY, w: buttonW, h: buttonH } };
}

function buildHero(brief: PremiumLeafletV2Brief, y: number, maxWidth: number): { svg: string; height: number } {
  const { headline, subheadline, offer, brandPalette } = brief;
  let cursorY = y;

  // Hero text sits on the primary brand block; use contrasting text colour.
  const heroTextColor = contrastColor(brandPalette.primary);
  const heroMutedColor = contrastColor(brandPalette.primary) === "#FFFFFF" ? "rgba(255,255,255,0.85)" : brandPalette.textMuted;

  const headlineSize = Math.max(MIN_HEADLINE, fitFontSize(headline, maxWidth, 62, MIN_HEADLINE));
  const headlineLines = wrapText(headline, Math.round(maxWidth / (headlineSize * 0.55)));
  const headlineSvg = headlineLines
    .map(
      (line, i) =>
        `<text x="${WIDTH / 2}" y="${cursorY + (i + 1) * (headlineSize + 10)}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineSize}" font-weight="900" fill="${heroTextColor}" text-anchor="middle">${escapeXml(line)}</text>`
    )
    .join("");
  cursorY += headlineLines.length * (headlineSize + 10) + 18;

  let offerSvg = "";
  if (offer) {
    const offerSize = Math.max(26, fitFontSize(offer, maxWidth, 38, 26));
    const offerLines = wrapText(offer, Math.round(maxWidth / (offerSize * 0.55)));
    const offerH = offerLines.length * (offerSize + 8) + 36;
    offerSvg = `
      <rect x="${MARGIN}" y="${cursorY}" width="${maxWidth}" height="${offerH}" rx="14" fill="${brandPalette.accent}" opacity="0.20"/>
      ${offerLines
        .map(
          (line, i) =>
            `<text x="${WIDTH / 2}" y="${cursorY + 28 + (i + 1) * (offerSize + 8)}" font-family="Arial, Helvetica, sans-serif" font-size="${offerSize}" font-weight="800" fill="${brandPalette.accent}" text-anchor="middle">${escapeXml(line)}</text>`
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
          `<text x="${WIDTH / 2}" y="${cursorY + (i + 1) * (subSize + 8)}" font-family="Arial, Helvetica, sans-serif" font-size="${subSize}" font-weight="500" fill="${heroMutedColor}" text-anchor="middle">${escapeXml(line)}</text>`
      )
      .join("");
    cursorY += subLines.length * (subSize + 8) + 14;
  }

  return { svg: headlineSvg + offerSvg + subSvg, height: cursorY - y };
}

function buildServiceCards(
  brief: PremiumLeafletV2Brief,
  y: number,
  maxHeight: number
): { svg: string; height: number; didCrowd: boolean } {
  const { primaryServices, secondaryServices, brandPalette, layoutDensity } = brief;
  const { maxPrimary, columns, compact } = densityCards(layoutDensity);
  const services = primaryServices.slice(0, maxPrimary);
  if (services.length === 0) return { svg: "", height: 0, didCrowd: false };

  const gap = compact ? 14 : 20;
  const cardW = (WIDTH - MARGIN * 2 - gap * (columns - 1)) / columns;
  const rows = Math.ceil(services.length / columns);

  const maxCardH = compact ? 120 : 210;
  const minCardH = compact ? 86 : 116;
  const naturalMin = rows * minCardH + (rows - 1) * gap;

  // Estimate secondary strip/list height.
  let secondaryNatural = 0;
  if (layoutDensity === "catalogue_brochure" && secondaryServices.length > 0) {
    const perCol = Math.ceil((primaryServices.slice(maxPrimary).length + secondaryServices.length) / 2);
    secondaryNatural = perCol * 30 + 24;
  } else if (secondaryServices.length > 0) {
    const stripText = `${secondaryServices.map((s) => s.name).join(" · ")}`;
    const stripSize = Math.max(MIN_STRIP, fitFontSize(stripText, WIDTH - MARGIN * 2, 22, MIN_STRIP));
    const stripLines = wrapText(stripText, Math.round((WIDTH - MARGIN * 2) / (stripSize * 0.55)));
    secondaryNatural = stripLines.length * (stripSize + 6) + 28 + 18;
  }

  // Shrink cards to fit within maxHeight; if impossible, flag crowding.
  const fitCardH = Math.max(minCardH, Math.min(maxCardH, Math.floor((maxHeight - secondaryNatural - (rows - 1) * gap) / rows)));
  const cardH = fitCardH;
  const primaryHeight = rows * (cardH + gap) - gap;
  const didCrowd = maxHeight < naturalMin + secondaryNatural;

  let svg = "";
  services.forEach((svc, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = MARGIN + col * (cardW + gap);
    const cy = y + row * (cardH + gap);

    const hasDesc = !!svc.description;
    const nameSize = Math.max(MIN_SERVICE, fitFontSize(svc.name, cardW - 48, compact ? 26 : 30, MIN_SERVICE));
    const nameLines = wrapText(svc.name, Math.round((cardW - 48) / (nameSize * 0.55)));

    const descSize = Math.max(MIN_SERVICE_DESC, Math.min(16, fitFontSize(svc.description || "", cardW - 48, 16, MIN_SERVICE_DESC)));
    const descLines = hasDesc ? wrapText(svc.description!, Math.round((cardW - 48) / (descSize * 0.55))).slice(0, 2) : [];

    const nameBlockH = nameLines.length * (nameSize + 4);
    const descBlockH = descLines.length * (descSize + 4);
    const totalBlockH = nameBlockH + (hasDesc ? 8 + descBlockH : 0);
    const contentTop = cy + cardH / 2 - totalBlockH / 2;

    const nameTextSvg = nameLines
      .map(
        (line, idx) =>
          `<text x="${x + 20}" y="${contentTop + (idx + 1) * (nameSize + 4)}" font-family="Arial, Helvetica, sans-serif" font-size="${nameSize}" font-weight="800" fill="${brandPalette.text}">${escapeXml(line)}</text>`
      )
      .join("");

    const descTextSvg = descLines
      .map(
        (line, idx) =>
          `<text x="${x + 20}" y="${contentTop + nameBlockH + 8 + (idx + 1) * (descSize + 4)}" font-family="Arial, Helvetica, sans-serif" font-size="${descSize}" font-weight="500" fill="${brandPalette.textMuted}">${escapeXml(line)}</text>`
      )
      .join("");

    svg += `
      <defs>
        <filter id="cardShadow${i}" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000000" flood-opacity="0.08"/>
        </filter>
      </defs>
      <rect x="${x}" y="${cy}" width="${cardW}" height="${cardH}" rx="14" fill="${brandPalette.background}" filter="url(#cardShadow${i})"/>
      <rect x="${x}" y="${cy}" width="6" height="${cardH}" rx="3" fill="${brandPalette.accent}"/>
      ${nameTextSvg}
      ${descTextSvg}
    `;
  });

  let secondaryHeight = 0;

  if (secondaryServices.length > 0 && layoutDensity !== "catalogue_brochure") {
    const stripY = y + primaryHeight + 20;
    const stripText = `${secondaryServices.map((s) => s.name).join(" · ")}`;
    const stripSize = Math.max(MIN_STRIP, fitFontSize(stripText, WIDTH - MARGIN * 2, 22, MIN_STRIP));
    const stripLines = wrapText(stripText, Math.round((WIDTH - MARGIN * 2) / (stripSize * 0.55)));
    const stripH = stripLines.length * (stripSize + 6) + 24;

    svg += `
      <rect x="${MARGIN}" y="${stripY}" width="${WIDTH - MARGIN * 2}" height="${stripH}" rx="12" fill="${brandPalette.secondary}" opacity="0.10"/>
      ${stripLines
        .map(
          (line, i) =>
            `<text x="${WIDTH / 2}" y="${stripY + 16 + (i + 1) * (stripSize + 6)}" font-family="Arial, Helvetica, sans-serif" font-size="${stripSize}" font-weight="600" fill="${brandPalette.textMuted}" text-anchor="middle">${escapeXml(line)}</text>`
        )
        .join("")}
    `;
    secondaryHeight = stripH + 14;
  }

  if (layoutDensity === "catalogue_brochure" && secondaryServices.length > 0) {
    const listY = y + primaryHeight + 20;
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
  const bandH = 86;

  let contentSvg = "";
  items.forEach((benefit, i) => {
    const x = MARGIN + i * ((WIDTH - MARGIN * 2) / items.length) + (WIDTH - MARGIN * 2) / items.length / 2;
    const lines = wrapText(benefit, Math.round(maxW / (itemSize * 0.55)));
    const lineH = itemSize + 6;
    const blockH = lines.length * lineH;
    const startY = y + (bandH - blockH) / 2 + itemSize;
    const bulletX = x - Math.min(maxW, benefit.length * itemSize * 0.55) / 2 - 12;
    contentSvg += `<circle cx="${bulletX}" cy="${startY - itemSize / 2 + 4}" r="5" fill="${brandPalette.accent}"/>`;
    contentSvg += lines
      .map(
        (line, idx) =>
          `<text x="${x}" y="${startY + idx * lineH}" font-family="Arial, Helvetica, sans-serif" font-size="${itemSize}" font-weight="600" fill="${brandPalette.text}" text-anchor="middle">${escapeXml(line)}</text>`
      )
      .join("");
  });

  const svg = `
    <rect x="${MARGIN}" y="${y}" width="${WIDTH - MARGIN * 2}" height="${bandH}" rx="14" fill="${brandPalette.secondary}" opacity="0.08"/>
    ${contentSvg}
  `;
  return { svg, height: bandH };
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
  logoComposited: boolean;
  usedContentHeight: number;
  availableContentHeight: number;
  primaryWithDescriptionCount: number;
}

export async function renderV2FromBrief(brief: PremiumLeafletV2Brief): Promise<{ buffer: Buffer; metrics: V2RenderLayoutMetrics }> {
  const header = buildHeader(brief);
  const footerH = 112;

  // Reserve space from the bottom up so CTA and footer are never clipped.
  const cta = buildCta(brief, SAFE_BOTTOM - 80 - footerH);
  const footer = buildFooter(brief, SAFE_BOTTOM - footerH + MARGIN);

  // Content sits between the header and the CTA, with generous padding.
  const contentTop = header.height + 24;
  const contentBottom = cta.bounds.y - 32;
  const availableContentHeight = contentBottom - contentTop;

  const hero = buildHero(brief, contentTop, WIDTH - MARGIN * 2);
  const heroBottom = contentTop + hero.height;

  // Reserve space for benefits strip between services and CTA.
  const benefitsSection = buildBenefits(brief, 0);
  const benefitsHeight = benefitsSection.height > 0 ? benefitsSection.height + 20 : 0;
  const servicesSpace = contentBottom - heroBottom - benefitsHeight - 28;
  const services = buildServiceCards(brief, heroBottom + 24, servicesSpace);
  const servicesBottom = heroBottom + 24 + services.height;

  // Position benefits directly below the service section.
  const benefitsTop = servicesBottom + 32;
  const benefits = buildBenefits(brief, benefitsTop);

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

  // Composite logo if provided; fall back to a branded initial badge if fetching fails.
  const logoBuffer = await fetchLogoBuffer(brief.logoUrl);
  let finalBuffer = png;
  if (logoBuffer) {
    finalBuffer = await compositeLogo(png, logoBuffer, header.logoArea.x, header.logoArea.y, header.logoArea.max, header.logoArea.max);
  } else if (brief.logoUrl) {
    finalBuffer = await drawTextLogo(png, brief.businessName, header.logoArea.x, header.logoArea.y, header.logoArea.max, brief.brandPalette.primary);
  }

  const usedContentHeight = benefitsTop + (benefits.height > 0 ? benefits.height + 12 : 0) - contentTop;

  const metrics: V2RenderLayoutMetrics = {
    width: WIDTH,
    height: HEIGHT,
    ctaBoundingBox: cta.bounds,
    footerY: SAFE_BOTTOM - footerH + MARGIN,
    footerHeight: footerH,
    minFontSizeUsed: brief.primaryServices.length > 0 ? MIN_SERVICE : MIN_SERVICE_DESC,
    primaryCardCount: brief.primaryServices.length,
    secondaryCardCount: brief.secondaryServices.length,
    layoutDensity: brief.layoutDensity,
    didCrowd: services.didCrowd,
    logoComposited: !!logoBuffer || !!brief.logoUrl,
    usedContentHeight,
    availableContentHeight,
    primaryWithDescriptionCount: brief.primaryServices.filter((s) => !!s.description).length,
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
