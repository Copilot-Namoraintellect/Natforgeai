/**
 * Premium Leaflet Hybrid Pipeline – HTML/CSS Playwright Renderer.
 *
 * Composes the final 1080x1350 PNG from exact real text, the real logo and a
 * generated background. Uses Playwright to screenshot a deterministic HTML page.
 */

import { chromium, type Browser } from "playwright";
import type { HybridBrandKit, VisualDirection } from "./pipeline-types";

const WIDTH = 1080;
const HEIGHT = 1350;

export interface HybridRenderBrief {
  businessName: string;
  headline: string;
  subheadline: string;
  primaryServices: { name: string; description: string | null }[];
  secondaryServices: { name: string }[];
  benefits: string[];
  cta: string;
  offerLine?: string | null;
  contact: { phone?: string; website?: string; location?: string };
}

export interface HybridRenderMetrics {
  width: number;
  height: number;
  layoutPreset: string;
}

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

export async function renderHybridLeaflet(
  brief: HybridRenderBrief,
  brandKit: HybridBrandKit,
  visualDirection: VisualDirection,
  backgroundBuffer: Buffer | null,
  logoBuffer: Buffer | null
): Promise<{ buffer: Buffer; metrics: HybridRenderMetrics }> {
  const html = buildHtml(brief, brandKit, visualDirection, backgroundBuffer, logoBuffer);

  const page = await (await getBrowser()).newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  try {
    await page.setContent(html, { waitUntil: "networkidle" });
    const screenshot = await page.screenshot({ type: "png", fullPage: false });
    return {
      buffer: screenshot,
      metrics: { width: WIDTH, height: HEIGHT, layoutPreset: visualDirection.layoutPreset },
    };
  } finally {
    await page.close();
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function toCssColour(hex: string): string {
  return hex.startsWith("#") ? hex : `#${hex}`;
}

function buildHtml(
  brief: HybridRenderBrief,
  brandKit: HybridBrandKit,
  visualDirection: VisualDirection,
  backgroundBuffer: Buffer | null,
  logoBuffer: Buffer | null
): string {
  const primary = visualDirection.layoutPreset;
  const bg = backgroundBuffer ? `data:image/png;base64,${backgroundBuffer.toString("base64")}` : undefined;
  const logo = logoBuffer ? `data:image/png;base64,${logoBuffer.toString("base64")}` : undefined;

  const primaryCards = brief.primaryServices
    .slice(0, 4)
    .map(
      (s) => `
      <div class="service-card">
        <div class="card-accent"></div>
        <div class="card-title">${escapeHtml(s.name)}</div>
        ${s.description ? `<div class="card-desc">${escapeHtml(s.description)}</div>` : ""}
      </div>
    `
    )
    .join("");

  const secondaryStrip = brief.secondaryServices.length
    ? `<div class="secondary-strip">${brief.secondaryServices.map((s) => escapeHtml(s.name)).join(" · ")}</div>`
    : "";

  const benefits = brief.benefits.length
    ? `<div class="benefits-band">${brief.benefits
        .map((b) => `<div class="benefit-item"><span class="bullet"></span><span>${escapeHtml(b)}</span></div>`)
        .join("")}</div>`
    : "";

  const offerBadge = brief.offerLine
    ? `<div class="offer-badge">${escapeHtml(brief.offerLine)}</div>`
    : "";

  const contactParts = [brief.contact.phone, brief.contact.website, brief.contact.location].filter((t): t is string => typeof t === "string" && t.length > 0);
  const footer = contactParts.length ? `<div class="footer-line">${contactParts.map(escapeHtml).join(" · ")}</div>` : "";

  const logoHtml = logo
    ? `<img class="logo-img" src="${logo}" alt="" />`
    : `<div class="logo-fallback"><span>${escapeHtml(brief.businessName.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase())}</span></div>`;

  const bgStyle = bg ? `background-image: url('${bg}'); background-size: cover; background-position: center;` : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', Arial, sans-serif; }
    .canvas {
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      position: relative;
      overflow: hidden;
      color: ${toCssColour(brandKit.text)};
      background: ${toCssColour(brandKit.background)};
      ${bgStyle}
    }
    .overlay { position: absolute; inset: 0; }
    .header {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 140px;
      display: flex;
      align-items: center;
      gap: 24px;
      padding: 0 56px;
      background: ${toCssColour(brandKit.primary)};
      color: #ffffff;
    }
    .logo-img { height: 96px; width: 96px; object-fit: contain; border-radius: 50%; background: #fff; padding: 6px; }
    .logo-fallback { height: 96px; width: 96px; border-radius: 50%; background: ${toCssColour(brandKit.accent)}; display: flex; align-items: center; justify-content: center; font-size: 36px; font-weight: 900; color: #fff; }
    .business-name { font-size: 44px; font-weight: 900; letter-spacing: -0.02em; }
    .hero {
      position: absolute;
      top: 140px; left: 0; right: 0;
      min-height: 320px;
      padding: 48px 56px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      background: ${toCssColour(brandKit.primary)};
      color: #ffffff;
    }
    .headline { font-size: 56px; font-weight: 900; line-height: 1.1; margin-bottom: 20px; }
    .subheadline { font-size: 28px; font-weight: 500; line-height: 1.35; opacity: 0.92; max-width: 900px; }
    .offer-badge { margin-top: 28px; padding: 16px 32px; border-radius: 14px; background: ${toCssColour(brandKit.accent)}; color: #0f172a; font-size: 30px; font-weight: 800; }
    .services { position: absolute; top: 500px; left: 56px; right: 56px; display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    .service-card { position: relative; background: #ffffff; border-radius: 18px; padding: 28px 28px 28px 34px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); min-height: 150px; display: flex; flex-direction: column; justify-content: center; }
    .card-accent { position: absolute; left: 0; top: 0; bottom: 0; width: 8px; background: ${toCssColour(brandKit.accent)}; border-radius: 18px 0 0 18px; }
    .card-title { font-size: 28px; font-weight: 800; color: ${toCssColour(brandKit.text)}; margin-bottom: 8px; }
    .card-desc { font-size: 19px; color: ${toCssColour(brandKit.textMuted)}; line-height: 1.4; }
    .secondary-strip { position: absolute; top: 920px; left: 56px; right: 56px; padding: 20px 32px; border-radius: 14px; background: ${toCssColour(brandKit.secondary)}15; text-align: center; font-size: 22px; font-weight: 600; color: ${toCssColour(brandKit.textMuted)}; }
    .benefits-band { position: absolute; top: 990px; left: 56px; right: 56px; padding: 24px 32px; border-radius: 16px; background: ${toCssColour(brandKit.secondary)}10; display: flex; justify-content: space-between; gap: 24px; }
    .benefit-item { flex: 1; display: flex; align-items: flex-start; gap: 12px; font-size: 21px; font-weight: 600; line-height: 1.35; color: ${toCssColour(brandKit.text)}; }
    .bullet { width: 10px; height: 10px; border-radius: 50%; background: ${toCssColour(brandKit.accent)}; flex-shrink: 0; margin-top: 8px; }
    .cta {
      position: absolute;
      bottom: 140px; left: 56px; right: 56px;
      height: 88px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .cta-button { padding: 22px 64px; border-radius: 18px; background: ${toCssColour(brandKit.accent)}; color: ${contrastColor(brandKit.accent)}; font-size: 32px; font-weight: 900; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
    .footer {
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: 120px;
      background: ${toCssColour(brandKit.primary)};
      color: #ffffff;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 0 56px;
    }
    .footer-name { font-size: 24px; font-weight: 800; margin-bottom: 6px; }
    .footer-line { font-size: 20px; opacity: 0.9; }

    /* Layout presets */
    .preset-premium_services_brand_panel .hero { min-height: 280px; }
    .preset-premium_local_service .hero { min-height: 300px; }
    .preset-premium_offer_hero .offer-badge { font-size: 34px; }
    .preset-premium_retail_promo .headline { font-size: 60px; }
    .preset-premium_food_offer .hero { background: linear-gradient(180deg, ${toCssColour(brandKit.primary)} 0%, ${toCssColour(brandKit.primary)}dd 100%); }
    .preset-premium_professional_clean .hero { background: ${toCssColour(brandKit.primary)}; }
  </style>
</head>
<body>
  <div class="canvas preset-${primary}">
    <div class="overlay"></div>
    <div class="header">
      ${logoHtml}
      <div class="business-name">${escapeHtml(brief.businessName)}</div>
    </div>
    <div class="hero">
      <div class="headline">${escapeHtml(brief.headline)}</div>
      <div class="subheadline">${escapeHtml(brief.subheadline)}</div>
      ${offerBadge}
    </div>
    <div class="services">${primaryCards}</div>
    ${secondaryStrip}
    ${benefits}
    <div class="cta"><div class="cta-button">${escapeHtml(brief.cta)}</div></div>
    <div class="footer">
      <div class="footer-name">${escapeHtml(brief.businessName)}</div>
      ${footer}
    </div>
  </div>
</body>
</html>`;
}

function contrastColor(hex: string): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16) || 0;
  const g = parseInt(clean.substring(2, 4), 16) || 0;
  const b = parseInt(clean.substring(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#0F172A" : "#FFFFFF";
}
