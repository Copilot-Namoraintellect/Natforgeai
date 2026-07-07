/**
 * Premium Leaflet Hybrid Pipeline – HTML/CSS Playwright Renderer.
 *
 * Composes the final 1080x1350 PNG from exact real text, the real logo and a
 * generated background. Uses Playwright to screenshot a deterministic HTML page.
 */

import { chromium, type Browser } from "playwright";
import type { HybridBrandKit, VisualDirection } from "./pipeline-types";
import type { BrandAssetResolution } from "../brand-asset-resolver";

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
  brandAsset?: BrandAssetResolution;
}

export interface HybridRenderMetrics {
  width: number;
  height: number;
  layoutPreset: string;
  logoImageErrors?: string[];
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
  logoBuffer: Buffer | null,
  brandAsset?: BrandAssetResolution
): Promise<{ buffer: Buffer; metrics: HybridRenderMetrics }> {
  const html = buildHtml(brief, brandKit, visualDirection, backgroundBuffer, logoBuffer, brandAsset);

  const page = await (await getBrowser()).newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      consoleErrors.push(text);
      console.warn(`[HybridRenderer] page console error: ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    const text = err.message || String(err);
    consoleErrors.push(text);
    console.warn(`[HybridRenderer] page error: ${text}`);
  });

  try {
    await page.setContent(html, { waitUntil: "networkidle" });
    const screenshot = await page.screenshot({ type: "png", fullPage: false });
    return {
      buffer: screenshot,
      metrics: { width: WIDTH, height: HEIGHT, layoutPreset: visualDirection.layoutPreset, logoImageErrors: consoleErrors },
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

function contrastColor(hex: string): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16) || 0;
  const g = parseInt(clean.substring(2, 4), 16) || 0;
  const b = parseInt(clean.substring(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#0F172A" : "#FFFFFF";
}

function ctaClasses(visualDirection: VisualDirection): string {
  const classes = ["cta-button"];
  if (visualDirection.ctaTreatment === "block_banner") classes.push("cta-block");
  if (visualDirection.ctaTreatment === "rounded_pill") classes.push("cta-pill");
  if (visualDirection.ctaTreatment === "outline_button") classes.push("cta-outline");
  return classes.join(" ");
}

function serviceGridStyle(visualDirection: VisualDirection): string {
  if (visualDirection.density === "minimal") return "grid-template-columns: 1fr;";
  if (visualDirection.density === "dense") return "grid-template-columns: 1fr 1fr 1fr; gap: 16px;";
  return "grid-template-columns: 1fr 1fr; gap: 22px;";
}

function buildHtml(
  brief: HybridRenderBrief,
  brandKit: HybridBrandKit,
  visualDirection: VisualDirection,
  backgroundBuffer: Buffer | null,
  logoBuffer: Buffer | null,
  brandAsset?: BrandAssetResolution
): string {
  const primary = visualDirection.layoutPreset;
  const bg = backgroundBuffer ? `data:image/png;base64,${backgroundBuffer.toString("base64")}` : undefined;
  const logo = logoBuffer ? `data:image/png;base64,${logoBuffer.toString("base64")}` : undefined;

  const primaryCards = brief.primaryServices
    .slice(0, visualDirection.density === "dense" ? 6 : 4)
    .map(
      (s, i) => `
      <div class="service-card service-card-${i}">
        <div class="card-number">0${i + 1}</div>
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

  const renderRealLogo = !!logoBuffer && (brandAsset ? brandAsset.logoResolved && brandAsset.realLogoExpected : true);
  const logoHtml = renderRealLogo && logo
    ? `<img class="logo-img" src="${logo}" alt="" onerror="console.error('[HybridRenderer] Logo image failed to load:', this.src)" />`
    : `<div class="logo-fallback"><span>${escapeHtml(brief.businessName.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase())}</span></div>`;
  if (brandAsset?.realLogoExpected && !renderRealLogo) {
    console.warn(`[HybridRenderer] Real logo expected for ${brief.businessName} but not rendered; using fallback badge. Source=${brandAsset.logoSourceType}, resolved=${brandAsset.logoResolved}, hasBuffer=${!!logoBuffer}.`);
  }

  const bgStyle = bg ? `background-image: url('${bg}'); background-size: cover; background-position: center;` : "";
  const hasShapeAccent = visualDirection.heroTreatment === "shape_accent";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&display=swap');
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
    .bg-overlay { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0.12) 0%, rgba(0,0,0,0.02) 35%, rgba(0,0,0,0.06) 70%, rgba(0,0,0,0.22) 100%); }
    .brand-shape {
      position: absolute;
      top: -120px;
      right: -80px;
      width: 460px;
      height: 460px;
      border-radius: 50%;
      background: ${toCssColour(brandKit.accent)};
      opacity: 0.20;
      z-index: 1;
    }
    .brand-shape-2 {
      position: absolute;
      bottom: 260px;
      left: -100px;
      width: 280px;
      height: 280px;
      border-radius: 50%;
      background: ${toCssColour(brandKit.secondary)};
      opacity: 0.14;
      z-index: 1;
    }
    .brand-stripe {
      position: absolute;
      top: -80px;
      right: 220px;
      width: 90px;
      height: 500px;
      background: ${toCssColour(brandKit.accent)};
      opacity: 0.16;
      transform: rotate(18deg);
      border-radius: 50px;
      z-index: 1;
    }
    .header {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 130px;
      display: flex;
      align-items: center;
      gap: 22px;
      padding: 0 56px;
      background: ${toCssColour(brandKit.primary)};
      color: #ffffff;
      z-index: 3;
      border-bottom: 6px solid ${toCssColour(brandKit.accent)};
    }
    .logo-img { max-height: 84px; max-width: 220px; width: auto; height: auto; object-fit: contain; border-radius: 12px; background: #fff; padding: 5px; box-shadow: 0 6px 18px rgba(0,0,0,0.18); }
    .logo-fallback { height: 84px; width: 84px; border-radius: 50%; background: ${toCssColour(brandKit.accent)}; display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 900; color: #fff; box-shadow: 0 6px 18px rgba(0,0,0,0.18); }
    .business-name { font-size: 42px; font-weight: 900; letter-spacing: -0.02em; }
    .hero {
      position: absolute;
      top: 130px; left: 0; right: 0;
      min-height: 360px;
      padding: 56px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: flex-start;
      text-align: left;
      background: ${toCssColour(brandKit.primary)};
      color: #ffffff;
      z-index: 3;
    }
    .hero-shape-accent {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 420px;
      height: 420px;
      transform: translate(-50%, -50%) rotate(12deg);
      border: 18px solid ${toCssColour(brandKit.accent)};
      opacity: 0.22;
      border-radius: 40px;
      z-index: 0;
    }
    .headline { position: relative; z-index: 2; font-size: 72px; font-weight: 900; line-height: 1.0; margin-bottom: 18px; letter-spacing: -0.03em; text-shadow: 0 4px 14px rgba(0,0,0,0.25); max-width: 960px; }
    .subheadline { position: relative; z-index: 2; font-size: 28px; font-weight: 500; line-height: 1.45; opacity: 0.95; max-width: 880px; }
    .offer-badge { position: relative; z-index: 2; margin-top: 24px; padding: 14px 30px; border-radius: 12px; background: ${toCssColour(brandKit.accent)}; color: ${contrastColor(brandKit.accent)}; font-size: 28px; font-weight: 900; box-shadow: 0 6px 18px rgba(0,0,0,0.15); display: inline-block; }
    .section-rule { position: absolute; top: 490px; left: 56px; right: 56px; height: 5px; background: ${toCssColour(brandKit.accent)}; border-radius: 3px; z-index: 3; opacity: 0.9; }
    .services { position: absolute; top: 520px; left: 56px; right: 56px; display: grid; ${serviceGridStyle(visualDirection)}; z-index: 3; }
    .service-card { position: relative; background: rgba(255,255,255,0.96); border-radius: 16px; padding: 24px 24px 24px 32px; box-shadow: 0 10px 28px rgba(0,0,0,0.10); min-height: 130px; display: flex; flex-direction: column; justify-content: center; border-left: 7px solid ${toCssColour(brandKit.accent)}; }
    .card-number { position: absolute; top: 8px; right: 14px; font-size: 42px; font-weight: 900; color: ${toCssColour(brandKit.accent)}; opacity: 0.20; line-height: 1; }
    .card-title { font-size: 28px; font-weight: 900; color: ${toCssColour(brandKit.text)}; margin-bottom: 6px; line-height: 1.2; }
    .card-desc { font-size: 19px; color: ${toCssColour(brandKit.textMuted)}; line-height: 1.45; }
    .secondary-strip { position: absolute; top: 900px; left: 56px; right: 56px; padding: 16px 30px; border-radius: 12px; background: ${toCssColour(brandKit.secondary)}26; text-align: center; font-size: 21px; font-weight: 800; color: ${toCssColour(brandKit.text)}; z-index: 3; border: 2px solid ${toCssColour(brandKit.secondary)}40; }
    .benefits-band { position: absolute; top: 970px; left: 56px; right: 56px; padding: 20px 30px; border-radius: 14px; background: ${toCssColour(brandKit.secondary)}14; display: flex; justify-content: space-between; gap: 20px; z-index: 3; }
    .benefit-item { flex: 1; display: flex; align-items: flex-start; gap: 10px; font-size: 20px; font-weight: 800; line-height: 1.35; color: ${toCssColour(brandKit.text)}; }
    .bullet { width: 10px; height: 10px; border-radius: 50%; background: ${toCssColour(brandKit.accent)}; flex-shrink: 0; margin-top: 6px; }
    .cta {
      position: absolute;
      bottom: 140px;
      left: 56px;
      right: 56px;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 3;
    }
    .cta-button { padding: 24px 64px; border-radius: 16px; background: ${toCssColour(brandKit.accent)}; color: ${contrastColor(brandKit.accent)}; font-size: 38px; font-weight: 900; text-align: center; box-shadow: 0 10px 28px rgba(0,0,0,0.20); border: 3px solid rgba(255,255,255,0.30); text-shadow: 0 1px 2px rgba(0,0,0,0.12); }
    .cta-block { width: 100%; border-radius: 0; }
    .cta-pill { border-radius: 80px; }
    .cta-outline { background: transparent; color: ${toCssColour(brandKit.accent)}; border: 4px solid ${toCssColour(brandKit.accent)}; }
    .footer {
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: 110px;
      background: ${toCssColour(brandKit.primary)};
      color: #ffffff;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 0 56px;
      z-index: 3;
    }
    .footer-name { font-size: 24px; font-weight: 900; margin-bottom: 6px; }
    .footer-line { font-size: 20px; opacity: 0.93; }

    /* Layout presets */
    .preset-premium_services_brand_panel .hero { min-height: 340px; }
    .preset-premium_local_service .hero { min-height: 360px; }
    .preset-premium_offer_hero .offer-badge { font-size: 32px; padding: 16px 34px; }
    .preset-premium_retail_promo .headline { font-size: 76px; }
    .preset-premium_food_offer .hero { background: linear-gradient(180deg, ${toCssColour(brandKit.primary)} 0%, ${toCssColour(brandKit.primary)}dd 100%); }
    .preset-premium_professional_clean .hero { background: ${toCssColour(brandKit.primary)}; }
  </style>
</head>
<body>
  <div class="canvas preset-${primary}">
    <div class="bg-overlay"></div>
    <div class="brand-shape"></div>
    <div class="brand-shape-2"></div>
    <div class="brand-stripe"></div>
    ${hasShapeAccent ? '<div class="hero-shape-accent"></div>' : ""}
    <div class="header">
      ${logoHtml}
      <div class="business-name">${escapeHtml(brief.businessName)}</div>
    </div>
    <div class="hero">
      <div class="headline">${escapeHtml(brief.headline)}</div>
      <div class="subheadline">${escapeHtml(brief.subheadline)}</div>
      ${offerBadge}
    </div>
    <div class="section-rule"></div>
    <div class="services">${primaryCards}</div>
    ${secondaryStrip}
    ${benefits}
    <div class="cta"><div class="${ctaClasses(visualDirection)}">${escapeHtml(brief.cta)}</div></div>
    <div class="footer">
      <div class="footer-name">${escapeHtml(brief.businessName)}</div>
      ${footer}
    </div>
  </div>
</body>
</html>`;
}
