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
const SAFE_LEFT = 60;
const SAFE_RIGHT = 60;
const LOGO_MAX_W = 260;
const LOGO_MAX_H = 120;

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
  if (len <= 28) return 68;
  if (len <= 45) return 60;
  if (len <= 70) return 52;
  return 46;
}

function buildOverlaySvg(ctx: HybridComposerContext): string {
  const W = ctx.width;
  const H = ctx.height;
  const primary = ctx.brandColors.primary || "#00D4FF";
  const accent = ctx.brandColors.accent || primary;
  const darkOverlay = isLightColor(ctx.brandColors.background) ? "rgba(10,15,25,0.72)" : "rgba(0,0,0,0.55)";

  const headlineSize = headlineFontSize(ctx.headline);
  const headlineMaxChars = Math.floor((W - SAFE_LEFT - SAFE_RIGHT) / (headlineSize * 0.55));
  const headlineLines = wrapText(ctx.headline, headlineMaxChars).slice(0, 2);

  const subheadlineLines = ctx.subheadline
    ? wrapText(ctx.subheadline, Math.floor((W - SAFE_LEFT - SAFE_RIGHT) / 26)).slice(0, 2)
    : [];

  const offerLines = wrapText(ctx.offer || "", Math.floor((W - SAFE_LEFT - SAFE_RIGHT) / 24)).slice(0, 2);
  const ctaLines = wrapText(ctx.cta || "", Math.floor(420 / 28)).slice(0, 2);

  let cursorY = H - 110;

  // Contact strip (bottom-most).
  const contactParts: string[] = [];
  if (ctx.contact.whatsapp) contactParts.push(`WhatsApp ${ctx.contact.whatsapp}`);
  else if (ctx.contact.phone) contactParts.push(ctx.contact.phone);
  if (ctx.contact.website) contactParts.push(ctx.contact.website);
  if (ctx.contact.location) contactParts.push(ctx.contact.location);
  const contactText = contactParts.join("  ·  ");

  const contactY = cursorY;
  cursorY -= 60;

  // CTA button.
  const ctaH = 36 + ctaLines.length * 32;
  const ctaW = Math.min(520, Math.max(260, estimateWidth(ctx.cta || "") * 34));
  const ctaY = cursorY - ctaH;
  cursorY = ctaY - 30;

  // Offer pill.
  const offerH = 34 + offerLines.length * 30;
  const offerW = Math.min(W - SAFE_LEFT - SAFE_RIGHT, Math.max(220, estimateWidth(ctx.offer || "") * 30));
  const offerY = cursorY - offerH;
  if (ctx.offer) cursorY = offerY - 26;

  // Subheadline.
  const subheadlineY = cursorY - subheadlineLines.length * 38;
  if (subheadlineLines.length) cursorY = subheadlineY - 18;

  // Headline.
  const headlineY = cursorY - headlineLines.length * (headlineSize * 1.15);

  // Top gradient for logo legibility.
  const topGradient = `
    <defs>
      <linearGradient id="topGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${darkOverlay}" />
        <stop offset="100%" stop-color="${dropAlpha(darkOverlay)}" />
      </linearGradient>
      <linearGradient id="bottomGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${dropAlpha(darkOverlay)}" />
        <stop offset="55%" stop-color="${darkOverlay}" />
        <stop offset="100%" stop-color="${darkOverlay}" />
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${W}" height="240" fill="url(#topGrad)" />
    <rect x="0" y="${H - 720}" width="${W}" height="720" fill="url(#bottomGrad)" />
  `;

  function renderLines(lines: string[], x: number, y: number, size: number, weight: string, fill: string): string {
    const lineHeight = size * 1.18;
    return lines
      .map((line, idx) => {
        const yy = y + idx * lineHeight;
        return `<text x="${x}" y="${yy}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" dominant-baseline="hanging">${escapeXml(line)}</text>`;
      })
      .join("");
  }

  const offerSvg = ctx.offer
    ? `
    <rect x="${SAFE_LEFT}" y="${offerY}" width="${offerW}" height="${offerH}" rx="26" fill="${hexToRgba(accent, 0.92)}" />
    ${renderLines(offerLines, SAFE_LEFT + 26, offerY + 16, 26, "700", "#ffffff")}
  `
    : "";

  const ctaSvg = ctx.cta
    ? `
    <rect x="${SAFE_LEFT}" y="${ctaY}" width="${ctaW}" height="${ctaH}" rx="28" fill="${primary}" stroke="rgba(255,255,255,0.25)" stroke-width="2" />
    ${renderLines(ctaLines, SAFE_LEFT + 28, ctaY + 14, 28, "700", isLightColor(primary) ? "#0a0a0a" : "#ffffff")}
  `
    : "";

  const contactSvg = contactText
    ? `<text x="${SAFE_LEFT}" y="${contactY}" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="500" fill="rgba(255,255,255,0.85)" dominant-baseline="hanging">${escapeXml(contactText)}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${topGradient}
    ${renderLines(headlineLines, SAFE_LEFT, Math.max(headlineY, 720), headlineSize, "800", "#ffffff")}
    ${subheadlineLines.length ? renderLines(subheadlineLines, SAFE_LEFT, Math.max(subheadlineY, headlineY + headlineLines.length * headlineSize * 1.2 + 10), 28, "500", "rgba(255,255,255,0.92)") : ""}
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
    composites.push({ input: logoResized, blend: "over", left: SAFE_LEFT, top: 50 });
  }

  return sharp(background).composite(composites).png().toBuffer();
}
