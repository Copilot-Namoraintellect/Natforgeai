/**
 * Premium Leaflet Hybrid Pipeline – HTML/CSS Playwright Renderer.
 *
 * Composes the final 1080x1350 PNG from exact real text, the real logo and a
 * generated background. Uses Playwright to screenshot a deterministic HTML page.
 */

import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import type { HybridBrandKit, VisualDirection } from "./pipeline-types";
import type { BrandAssetResolution } from "../brand-asset-resolver";

const WIDTH = 1080;
const HEIGHT = 1350;

export type LogoTreatment = "horizontal" | "compact";

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
  // Brand-asset render diagnostics
  realLogoExpected?: boolean;
  realLogoRendered?: boolean;
  logoNaturalWidth?: number;
  logoNaturalHeight?: number;
  logoRenderedWidth?: number;
  logoRenderedHeight?: number;
  logoVisibleArea?: number;
  logoRenderMode?: "image" | "fallback_badge";
  fallbackBadgeRendered?: boolean;
  logoMaskedOrCropped?: boolean;
  logoDataUriUsed?: boolean;
  logoFetchUsed?: boolean;
}

export interface LogoRenderPlan {
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  treatment: LogoTreatment;
  aspectRatio: number;
}

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function fetchLogoBuffer(logoUrl: string): Promise<Buffer | null> {
  try {
    const res = await fetch(logoUrl);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

function inferContentType(buffer: Buffer): string {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return "image/webp";
  return "image/png";
}

export async function computeLogoRenderPlan(buffer: Buffer): Promise<LogoRenderPlan> {
  const meta = await sharp(buffer).metadata();
  const naturalWidth = meta.width || 1;
  const naturalHeight = meta.height || 1;
  const aspectRatio = naturalWidth / naturalHeight;

  // Wide logos (>2.2:1) are treated as horizontal brand marks and given a
  // long, clear panel. Compact/square logos use a taller panel.
  const treatment: LogoTreatment = aspectRatio > 2.2 ? "horizontal" : "compact";
  const maxWidth = treatment === "horizontal" ? 340 : 220;
  const maxHeight = treatment === "horizontal" ? 110 : 120;

  // Scale to fit inside the panel while preserving aspect ratio.
  let scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight);
  let renderedWidth = Math.round(naturalWidth * scale);
  let renderedHeight = Math.round(naturalHeight * scale);

  // Enforce a readable minimum height (normally at least 55px) without
  // exceeding the chosen panel size.
  if (renderedHeight < 55) {
    scale = Math.min(maxWidth / naturalWidth, 55 / naturalHeight);
    renderedWidth = Math.round(naturalWidth * scale);
    renderedHeight = Math.round(naturalHeight * scale);
  }

  return { naturalWidth, naturalHeight, renderedWidth, renderedHeight, treatment, aspectRatio };
}

export async function renderHybridLeaflet(
  brief: HybridRenderBrief,
  brandKit: HybridBrandKit,
  visualDirection: VisualDirection,
  backgroundBuffer: Buffer | null,
  logoBuffer: Buffer | null,
  brandAsset?: BrandAssetResolution
): Promise<{ buffer: Buffer; metrics: HybridRenderMetrics }> {
  const realLogoExpected = !!brandAsset && brandAsset.realLogoExpected;
  let resolvedLogoBuffer = logoBuffer;
  let logoFetchUsed = false;

  if (!resolvedLogoBuffer && brandAsset?.logoBuffer) {
    resolvedLogoBuffer = brandAsset.logoBuffer;
  }

  if (!resolvedLogoBuffer && brandAsset?.logoResolved && realLogoExpected) {
    const logoUrl = brandAsset.logoSourceUrl || brandKit.logoUrl || null;
    if (logoUrl) {
      logoFetchUsed = true;
      resolvedLogoBuffer = await fetchLogoBuffer(logoUrl);
      if (!resolvedLogoBuffer) {
        console.warn(`[HybridRenderer] Failed to fetch real logo from ${logoUrl}; will fall back to badge.`);
      }
    }
  }

  const renderRealLogo = !!resolvedLogoBuffer && (brandAsset ? brandAsset.logoResolved && brandAsset.realLogoExpected : true);
  const logoRenderPlan = renderRealLogo && resolvedLogoBuffer ? await computeLogoRenderPlan(resolvedLogoBuffer) : null;

  if (realLogoExpected && !renderRealLogo) {
    console.warn(`[HybridRenderer] Real logo expected for ${brief.businessName} but not rendered; using fallback badge. Source=${brandAsset?.logoSourceType}, resolved=${brandAsset?.logoResolved}, hasBuffer=${!!logoBuffer}.`);
  }

  const html = buildHtml(brief, brandKit, visualDirection, backgroundBuffer, resolvedLogoBuffer, brandAsset, logoRenderPlan);

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
    await page.setContent(html, { waitUntil: "load" });
    const screenshot = await page.screenshot({ type: "png", fullPage: false });

    const metrics: HybridRenderMetrics = {
      width: WIDTH,
      height: HEIGHT,
      layoutPreset: visualDirection.layoutPreset,
      logoImageErrors: consoleErrors,
      realLogoExpected,
      realLogoRendered: renderRealLogo,
      logoNaturalWidth: logoRenderPlan?.naturalWidth,
      logoNaturalHeight: logoRenderPlan?.naturalHeight,
      logoRenderedWidth: logoRenderPlan?.renderedWidth,
      logoRenderedHeight: logoRenderPlan?.renderedHeight,
      logoVisibleArea: logoRenderPlan ? logoRenderPlan.renderedWidth * logoRenderPlan.renderedHeight : undefined,
      logoRenderMode: renderRealLogo ? "image" : "fallback_badge",
      fallbackBadgeRendered: !renderRealLogo,
      logoMaskedOrCropped: false,
      logoDataUriUsed: renderRealLogo,
      logoFetchUsed,
    };

    return { buffer: screenshot, metrics };
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
  brandAsset?: BrandAssetResolution,
  logoRenderPlan?: LogoRenderPlan | null
): string {
  const primary = visualDirection.layoutPreset;
  const bg = backgroundBuffer ? `data:image/png;base64,${backgroundBuffer.toString("base64")}` : undefined;
  const logo = logoBuffer ? `data:${inferContentType(logoBuffer)};base64,${logoBuffer.toString("base64")}` : undefined;

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
  let logoHtml = "";
  if (renderRealLogo && logo && logoRenderPlan) {
    const treatmentClass = logoRenderPlan.treatment === "horizontal" ? "logo-horizontal" : "logo-compact";
    logoHtml = `
      <div class="logo-panel">
        <img class="logo-img ${treatmentClass}" src="${logo}" alt="" width="${logoRenderPlan.renderedWidth}" height="${logoRenderPlan.renderedHeight}" onerror="console.error('[HybridRenderer] Logo image failed to load:', this.src)" />
      </div>`;
  } else {
    const initials = escapeHtml(brief.businessName.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase());
    logoHtml = `<div class="logo-fallback"><span>${initials}</span></div>`;
  }

  const bgStyle = bg ? `background-image: url('${bg}'); background-size: cover; background-position: center;` : "";
  const hasShapeAccent = visualDirection.heroTreatment === "shape_accent";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    .canvas {
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      position: relative;
      overflow: hidden;
      color: ${toCssColour(brandKit.text)};
      background: ${toCssColour(brandKit.background)};
      ${bgStyle}
    }
    .bg-pattern {
      position: absolute; inset: 0;
      background-image:
        radial-gradient(circle at 20% 15%, ${toCssColour(brandKit.primary)}18 0%, transparent 40%),
        radial-gradient(circle at 85% 80%, ${toCssColour(brandKit.secondary)}14 0%, transparent 38%),
        radial-gradient(circle at 60% 55%, ${toCssColour(brandKit.accent)}0c 0%, transparent 30%);
      z-index: 0;
    }
    .bg-noise {
      position: absolute; inset: 0;
      opacity: 0.035;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
      z-index: 1;
      pointer-events: none;
    }
    .bg-overlay { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(15,23,42,0.62) 0%, rgba(15,23,42,0.18) 30%, rgba(15,23,42,0.10) 60%, rgba(15,23,42,0.50) 100%); z-index: 1; }
    .brand-shape {
      position: absolute;
      bottom: 220px;
      left: -120px;
      width: 320px;
      height: 320px;
      border-radius: 50%;
      background: ${toCssColour(brandKit.accent)};
      opacity: 0.10;
      z-index: 1;
    }
    .brand-stripe {
      position: absolute;
      top: -60px;
      right: 180px;
      width: 70px;
      height: 420px;
      background: ${toCssColour(brandKit.secondary)};
      opacity: 0.10;
      transform: rotate(20deg);
      border-radius: 50px;
      z-index: 1;
    }
    .header {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 170px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 56px;
      background: linear-gradient(180deg, rgba(255,255,255,0.97) 0%, rgba(255,255,255,0.92) 55%, rgba(255,255,255,0) 100%);
      border-bottom: 1px solid rgba(255,255,255,0.35);
      z-index: 4;
    }
    .brand-lockup { display: flex; align-items: center; gap: 22px; max-width: 920px; }
    .logo-panel {
      background: #ffffff;
      border-radius: 16px;
      padding: 12px 18px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.14);
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(0,0,0,0.06);
      flex-shrink: 0;
    }
    .logo-img { display: block; object-fit: contain; }
    .logo-horizontal { max-width: 340px; max-height: 110px; min-height: 55px; }
    .logo-compact { max-width: 220px; max-height: 120px; min-height: 55px; }
    .logo-fallback { height: 100px; width: 100px; border-radius: 18px; background: ${toCssColour(brandKit.accent)}; display: flex; align-items: center; justify-content: center; font-size: 38px; font-weight: 900; color: #fff; box-shadow: 0 10px 30px rgba(0,0,0,0.14); flex-shrink: 0; }
    .brand-wordmark { display: flex; flex-direction: column; }
    .business-name { font-size: 20px; font-weight: 900; letter-spacing: -0.01em; line-height: 1.15; color: ${toCssColour(brandKit.text)}; }
    .business-label { font-size: 12px; font-weight: 700; opacity: 0.58; margin-top: 3px; text-transform: uppercase; letter-spacing: 0.06em; color: ${toCssColour(brandKit.textMuted)}; }
    .hero {
      position: absolute;
      top: 170px; left: 0; right: 0;
      min-height: 300px;
      padding: 44px 56px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: flex-start;
      text-align: left;
      color: #ffffff;
      z-index: 3;
    }
    .hero-panel {
      background: rgba(15,23,42,0.46);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border-radius: 24px;
      padding: 26px 32px;
      border-left: 6px solid ${toCssColour(brandKit.accent)};
      box-shadow: 0 16px 40px rgba(0,0,0,0.18);
      max-width: 920px;
    }
    .hero-shape-accent {
      position: absolute;
      top: 50%;
      left: 58%;
      width: 380px;
      height: 380px;
      transform: translate(-50%, -50%) rotate(12deg);
      border: 16px solid ${toCssColour(brandKit.accent)};
      opacity: 0.14;
      border-radius: 36px;
      z-index: 0;
    }
    .headline { position: relative; z-index: 2; font-size: 56px; font-weight: 900; line-height: 1.05; margin-bottom: 12px; letter-spacing: -0.03em; text-shadow: 0 3px 12px rgba(0,0,0,0.25); }
    .subheadline { position: relative; z-index: 2; font-size: 24px; font-weight: 500; line-height: 1.4; opacity: 0.96; }
    .offer-badge { position: relative; z-index: 2; margin-top: 14px; padding: 10px 22px; border-radius: 12px; background: ${toCssColour(brandKit.accent)}; color: ${contrastColor(brandKit.accent)}; font-size: 24px; font-weight: 900; box-shadow: 0 6px 18px rgba(0,0,0,0.15); display: inline-block; }
    .services { position: absolute; top: 610px; left: 56px; right: 56px; display: grid; ${serviceGridStyle(visualDirection)}; z-index: 3; }
    .service-card {
      position: relative;
      background: linear-gradient(145deg, rgba(255,255,255,0.98) 0%, rgba(248,250,252,0.96) 100%);
      border-radius: 20px;
      padding: 24px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04);
      min-height: 120px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      border: 1px solid rgba(255,255,255,0.7);
      border-top: 5px solid ${toCssColour(brandKit.accent)};
    }
    .card-number { position: absolute; top: 10px; right: 16px; font-size: 44px; font-weight: 900; color: ${toCssColour(brandKit.accent)}; opacity: 0.10; line-height: 1; }
    .card-title { font-size: 25px; font-weight: 900; color: ${toCssColour(brandKit.text)}; margin-bottom: 7px; line-height: 1.25; letter-spacing: -0.01em; }
    .card-desc { font-size: 17px; color: ${toCssColour(brandKit.textMuted)}; line-height: 1.45; }
    .secondary-strip { position: absolute; top: 900px; left: 56px; right: 56px; padding: 16px 32px; border-radius: 14px; background: rgba(255,255,255,0.94); text-align: center; font-size: 22px; font-weight: 800; color: ${toCssColour(brandKit.text)}; z-index: 3; box-shadow: 0 6px 20px rgba(0,0,0,0.06); border: 1px solid rgba(255,255,255,0.6); }
    .benefits-band { position: absolute; top: 980px; left: 56px; right: 56px; padding: 22px 34px; border-radius: 18px; background: rgba(255,255,255,0.94); display: flex; justify-content: space-between; gap: 20px; z-index: 3; box-shadow: 0 6px 20px rgba(0,0,0,0.06); border: 1px solid rgba(255,255,255,0.6); }
    .benefit-item { flex: 1; display: flex; align-items: flex-start; gap: 12px; font-size: 21px; font-weight: 800; line-height: 1.35; color: ${toCssColour(brandKit.text)}; }
    .bullet { width: 11px; height: 11px; border-radius: 50%; background: ${toCssColour(brandKit.accent)}; flex-shrink: 0; margin-top: 7px; }
    .cta {
      position: absolute;
      bottom: 150px;
      left: 56px;
      right: 56px;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 3;
    }
    .cta-button { padding: 24px 64px; border-radius: 16px; background: ${toCssColour(brandKit.accent)}; color: ${contrastColor(brandKit.accent)}; font-size: 38px; font-weight: 900; text-align: center; box-shadow: 0 10px 28px rgba(0,0,0,0.20), 0 0 0 4px rgba(255,255,255,0.25); border: 3px solid rgba(255,255,255,0.35); text-shadow: 0 1px 2px rgba(0,0,0,0.12); }
    .cta-block { width: 100%; border-radius: 0; }
    .cta-pill { border-radius: 80px; }
    .cta-outline { background: transparent; color: ${toCssColour(brandKit.accent)}; border: 4px solid ${toCssColour(brandKit.accent)}; }
    .footer {
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: 130px;
      background: linear-gradient(90deg, rgba(15,23,42,0.94) 0%, rgba(15,23,42,0.88) 75%, rgba(15,23,42,0.72) 100%);
      color: #ffffff;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      justify-content: center;
      text-align: left;
      padding: 0 56px;
      z-index: 3;
    }
    .footer-name { font-size: 28px; font-weight: 900; margin-bottom: 8px; text-shadow: 0 2px 8px rgba(0,0,0,0.25); }
    .footer-line { font-size: 24px; font-weight: 600; opacity: 0.95; letter-spacing: 0.01em; }

    /* Layout presets */
    .preset-premium_services_brand_panel .hero { min-height: 320px; }
    .preset-premium_local_service .hero { min-height: 340px; }
    .preset-premium_offer_hero .offer-badge { font-size: 30px; padding: 14px 30px; }
    .preset-premium_retail_promo .headline { font-size: 64px; }
    .preset-premium_food_offer .hero-panel { background: rgba(15,23,42,0.52); }
    .preset-premium_professional_clean .hero-panel { background: rgba(15,23,42,0.52); }
  </style>
</head>
<body>
  <div class="canvas preset-${primary}">
    <div class="bg-pattern"></div>
    <div class="bg-noise"></div>
    <div class="bg-overlay"></div>
    <div class="brand-shape"></div>
    <div class="brand-stripe"></div>
    ${hasShapeAccent ? '<div class="hero-shape-accent"></div>' : ""}

    <div class="header">
      <div class="brand-lockup">
        ${logoHtml}
        <div class="brand-wordmark">
          <div class="business-name">${escapeHtml(brief.businessName)}</div>
          <div class="business-label">${escapeHtml(visualDirection.density === "minimal" ? "Premium Service" : "Trusted Local Business")}</div>
        </div>
      </div>
    </div>
    <div class="hero">
      <div class="hero-panel">
        <div class="headline">${escapeHtml(brief.headline)}</div>
        <div class="subheadline">${escapeHtml(brief.subheadline)}</div>
        ${offerBadge}
      </div>
    </div>
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
