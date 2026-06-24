/**
 * Hybrid leaflet composer: OpenAI generates the premium background, NatForgeAI
 * deterministically overlays the real logo, text, CTA and contact details.
 *
 * Output is a 1080x1350 PNG (4:5 portrait) suitable for Instagram/Facebook feeds
 * and general marketing use.
 */

import path from "path";
import fs from "fs";
import sharp from "sharp";
import type { TemplateRendererContact } from "./template-renderer";

export interface HybridComposerContext {
  width: number;
  height: number;
  businessName: string;
  logoUrl: string;
  brandColors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
  };
  headline: string;
  offer: string;
  subheadline?: string;
  cta: string;
  services: string[];
  contact: TemplateRendererContact;
}

const TARGET_WIDTH = 1080;
const TARGET_HEIGHT = 1350;
const SAFE_LEFT = 70;
const SAFE_RIGHT = 70;
const LOGO_MAX_W = 380;
const LOGO_MAX_H = 170;
const LOGO_BACKING_PADDING = 18;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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

export async function loadLogoBuffer(logoUrl?: string): Promise<Buffer | null> {
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
      console.warn(`[HybridComposer] Logo fetch failed | status=${response.status} | url=${fetchUrl}`);
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (err: any) {
    console.warn(`[HybridComposer] Could not load logo: ${err.message}`);
    return null;
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

function dropAlpha(rgba: string): string {
  // Convert "rgba(r,g,b,a)" -> "rgba(r,g,b,0)".
  const lastComma = rgba.lastIndexOf(",");
  if (lastComma === -1) return rgba;
  return `${rgba.slice(0, lastComma + 1)}0)`;
}

function isLightColor(hex: string): boolean {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55;
}

/**
 * Estimate text width in em units using a simple per-character heuristic.
 */
function estimateWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (char === " ") width += 0.25;
    else if (char >= "A" && char <= "Z") width += 0.7;
    else if (char >= "a" && char <= "z") width += 0.55;
    else if (char >= "0" && char <= "9") width += 0.58;
    else width += 0.6;
  }
  return width;
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length + word.length + 1 > maxChars && current.length > 0) {
      lines.push(current.trim());
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current.trim());
  return lines.length ? lines : [""];
}

function headlineFontSize(text: string): number {
  const len = text.length;
  if (len <= 24) return 76;
  if (len <= 40) return 68;
  if (len <= 60) return 58;
  if (len <= 80) return 50;
  return 44;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, " ");
}

function isOfferRedundant(headline: string, offer: string): boolean {
  if (!headline || !offer) return false;
  const h = normalizeText(headline);
  const o = normalizeText(offer);
  return h.includes(o) || o.includes(h);
}

function buildOverlaySvg(ctx: HybridComposerContext): string {
  const W = ctx.width;
  const H = ctx.height;
  const primary = ctx.brandColors.primary || "#00D4FF";
  const accent = ctx.brandColors.accent || primary;
  const darkOverlay = isLightColor(ctx.brandColors.background) ? "rgba(10,15,25,0.78)" : "rgba(0,0,0,0.58)";
  const footerOverlay = isLightColor(ctx.brandColors.background) ? "rgba(10,15,25,0.88)" : "rgba(0,0,0,0.72)";

  const headlineSize = headlineFontSize(ctx.headline);
  const headlineMaxChars = Math.floor((W - SAFE_LEFT - SAFE_RIGHT) / (headlineSize * 0.52));
  const headlineLines = wrapText(ctx.headline, headlineMaxChars).slice(0, 2);

  const subheadlineLines = ctx.subheadline
    ? wrapText(ctx.subheadline, Math.floor((W - SAFE_LEFT - SAFE_RIGHT) / 24)).slice(0, 2)
    : [];

  const showOffer = ctx.offer && !isOfferRedundant(ctx.headline, ctx.offer);
  const offerLines = showOffer
    ? wrapText(ctx.offer, Math.floor((W - SAFE_LEFT - SAFE_RIGHT) / 22)).slice(0, 2)
    : [];
  const ctaLines = wrapText(ctx.cta || "", Math.floor(460 / 30)).slice(0, 2);

  // Start from the bottom and stack upward for a fixed footer feel.
  const footerH = 90;
  let cursorY = H - footerH - 42;

  // Contact strip sits inside the footer strip (rendered separately).
  const contactParts: string[] = [];
  if (ctx.contact.whatsapp) contactParts.push(`WhatsApp ${ctx.contact.whatsapp}`);
  else if (ctx.contact.phone) contactParts.push(ctx.contact.phone);
  if (ctx.contact.website) contactParts.push(ctx.contact.website);
  if (ctx.contact.email) contactParts.push(ctx.contact.email);
  if (ctx.contact.location) contactParts.push(ctx.contact.location);
  const contactText = contactParts.join("  ·  ");

  // CTA button — larger and more prominent.
  const ctaH = 48 + ctaLines.length * 38;
  const ctaW = Math.min(W - SAFE_LEFT - SAFE_RIGHT, Math.max(300, estimateWidth(ctx.cta || "") * 38));
  const ctaY = cursorY - ctaH;
  cursorY = ctaY - 42;

  // Offer pill.
  const offerH = showOffer ? 38 + offerLines.length * 32 : 0;
  const offerW = showOffer
    ? Math.min(W - SAFE_LEFT - SAFE_RIGHT, Math.max(240, estimateWidth(ctx.offer || "") * 32))
    : 0;
  const offerY = cursorY - offerH;
  if (showOffer) cursorY = offerY - 32;

  // Subheadline.
  const subheadlineY = cursorY - subheadlineLines.length * 42;
  if (subheadlineLines.length) cursorY = subheadlineY - 24;

  // Headline.
  const headlineLineHeight = headlineSize * 1.12;
  const headlineY = cursorY - headlineLines.length * headlineLineHeight;

  // Footer strip for contact readability.
  const footerY = H - footerH;

  // Top gradient for logo legibility.
  const defs = `
    <defs>
      <linearGradient id="topGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${darkOverlay}" />
        <stop offset="100%" stop-color="${dropAlpha(darkOverlay)}" />
      </linearGradient>
      <linearGradient id="bottomGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${dropAlpha(darkOverlay)}" />
        <stop offset="50%" stop-color="${darkOverlay}" />
        <stop offset="100%" stop-color="${footerOverlay}" />
      </linearGradient>
      <filter id="ctaShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="rgba(0,0,0,0.35)" />
      </filter>
    </defs>
  `;

  const topGradient = `<rect x="0" y="0" width="${W}" height="280" fill="url(#topGrad)" />`;
  const bottomGradient = `<rect x="0" y="${H - 820}" width="${W}" height="820" fill="url(#bottomGrad)" />`;
  const footerStrip = `<rect x="0" y="${footerY}" width="${W}" height="${footerH}" fill="${footerOverlay}" />`;

  function renderLines(lines: string[], x: number, y: number, size: number, weight: string, fill: string, lineHeightRatio = 1.18): string {
    const lineHeight = size * lineHeightRatio;
    return lines
      .map((line, idx) => {
        const yy = y + idx * lineHeight;
        return `<text x="${x}" y="${yy}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" dominant-baseline="hanging">${escapeXml(line)}</text>`;
      })
      .join("");
  }

  const offerSvg = showOffer
    ? `
    <rect x="${SAFE_LEFT}" y="${offerY}" width="${offerW}" height="${offerH}" rx="30" fill="${hexToRgba(accent, 0.94)}" />
    ${renderLines(offerLines, SAFE_LEFT + 28, offerY + 18, 28, "700", "#ffffff")}
  `
    : "";

  const ctaFill = isLightColor(primary) ? "#0a0a0a" : "#ffffff";
  const ctaSvg = ctx.cta
    ? `
    <g filter="url(#ctaShadow)">
      <rect x="${SAFE_LEFT}" y="${ctaY}" width="${ctaW}" height="${ctaH}" rx="32" fill="${primary}" stroke="rgba(255,255,255,0.35)" stroke-width="2" />
    </g>
    ${renderLines(ctaLines, SAFE_LEFT + 34, ctaY + 16, 32, "700", ctaFill)}
    <text x="${SAFE_LEFT + ctaW - 34}" y="${ctaY + ctaH / 2 + 6}" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700" fill="${ctaFill}" text-anchor="end" dominant-baseline="middle">›</text>
  `
    : "";

  const contactSvg = contactText
    ? `<text x="${SAFE_LEFT}" y="${footerY + 34}" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="600" fill="rgba(255,255,255,0.95)" dominant-baseline="hanging">${escapeXml(contactText)}</text>`
    : "";

  // Constrain headline so it doesn't run into the logo backing area.
  const minHeadlineY = 420;
  const finalHeadlineY = Math.max(headlineY, minHeadlineY);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${defs}
    ${topGradient}
    ${bottomGradient}
    ${footerStrip}
    ${renderLines(headlineLines, SAFE_LEFT, finalHeadlineY, headlineSize, "800", "#ffffff", 1.12)}
    ${subheadlineLines.length ? renderLines(subheadlineLines, SAFE_LEFT, Math.max(subheadlineY, finalHeadlineY + headlineLines.length * headlineLineHeight + 16), 30, "500", "rgba(255,255,255,0.93)", 1.2) : ""}
    ${offerSvg}
    ${ctaSvg}
    ${contactSvg}
  </svg>`;
}

export async function composeHybridLeaflet(
  backgroundBuffer: Buffer,
  ctx: HybridComposerContext
): Promise<Buffer> {
  const [background, logoRaw] = await Promise.all([
    sharp(backgroundBuffer)
      .resize(TARGET_WIDTH, TARGET_HEIGHT, { fit: "cover", position: "centre" })
      .png()
      .toBuffer(),
    loadLogoBuffer(ctx.logoUrl),
  ]);

  // Render the text overlay.
  const overlaySvg = buildOverlaySvg(ctx);
  const overlayBuffer = await sharp(Buffer.from(overlaySvg, "utf-8"))
    .resize(TARGET_WIDTH, TARGET_HEIGHT)
    .png()
    .toBuffer();

  const composites: sharp.OverlayOptions[] = [{ input: overlayBuffer, blend: "over" }];

  if (logoRaw) {
    const logoResized = await sharp(logoRaw)
      .resize(LOGO_MAX_W, LOGO_MAX_H, { fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .png()
      .toBuffer();

    const logoMeta = await sharp(logoResized).metadata();
    const logoW = logoMeta.width || LOGO_MAX_W;
    const logoH = logoMeta.height || LOGO_MAX_H;
    const backingW = logoW + LOGO_BACKING_PADDING * 2;
    const backingH = logoH + LOGO_BACKING_PADDING * 2;
    const backingX = SAFE_LEFT - LOGO_BACKING_PADDING;
    const backingY = 50 - LOGO_BACKING_PADDING;

    // Subtle rounded backing behind logo for legibility on busy backgrounds.
    const logoBackingSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${backingW}" height="${backingH}">
        <rect x="0" y="0" width="${backingW}" height="${backingH}" rx="20" fill="rgba(255,255,255,0.92)" />
      </svg>
    `;
    const logoBackingBuffer = await sharp(Buffer.from(logoBackingSvg, "utf-8"))
      .resize(backingW, backingH)
      .png()
      .toBuffer();

    composites.push({ input: logoBackingBuffer, blend: "over", left: backingX, top: backingY });
    composites.push({ input: logoResized, blend: "over", left: SAFE_LEFT, top: 50 });
  }

  return sharp(background).composite(composites).png().toBuffer();
}
