/**
 * Premium Leaflet Hybrid Pipeline – HTML/CSS Playwright Renderer.
 *
 * Composes the final 1080x1350 PNG from exact real text, the real logo and a
 * generated background. Uses Playwright to screenshot a deterministic HTML page.
 */

import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import type { HybridBrandKit, VisualDirection, HybridRenderMetrics } from "./pipeline-types";
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

export interface HybridRenderResult {
  buffer: Buffer;
  metrics: HybridRenderMetrics;
  html: string;
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
): Promise<HybridRenderResult> {
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

  console.log(`[HybridRenderer] realLogoExpected=${realLogoExpected}, renderRealLogo=${renderRealLogo}, logoBufferLength=${resolvedLogoBuffer?.length ?? 0}, logoSourceType=${brandAsset?.logoSourceType ?? "n/a"}, logoResolved=${brandAsset?.logoResolved ?? "n/a"}`);

  if (realLogoExpected && !renderRealLogo) {
    const diagnostics = {
      logoSourceType: brandAsset?.logoSourceType,
      logoResolved: brandAsset?.logoResolved,
      realLogoExpected: brandAsset?.realLogoExpected,
      logoBufferPresent: !!resolvedLogoBuffer,
      logoBufferLength: resolvedLogoBuffer?.length ?? 0,
      brandKitLogoUrl: brandKit.logoUrl,
      logoSourceUrl: brandAsset?.logoSourceUrl,
    };
    throw new Error(`[HybridRenderer] Real logo expected for ${brief.businessName} but not rendered; cannot proceed with fallback badge. Diagnostics: ${JSON.stringify(diagnostics)}`);
  }

  const html = buildHtml(brief, brandKit, visualDirection, backgroundBuffer, resolvedLogoBuffer, brandAsset, logoRenderPlan);

  const htmlContainsImgLogo = html.includes('class="logo-img');
  const htmlContainsFallbackBadge = html.includes('class="logo-fallback"');
  console.log(`[HybridRenderer] HTML contains img logo: ${htmlContainsImgLogo}, fallback badge: ${htmlContainsFallbackBadge}`);

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

    return { buffer: screenshot, metrics, html };
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
  return "grid-template-columns: 1fr 1fr; gap: 24px;";
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
    );

  const useFeatured =
    visualDirection.serviceLayout === "featured" && primaryCards.length >= 2 && visualDirection.density !== "dense";

  const servicesHtml = useFeatured
    ? `<div class="service-featured">${primaryCards[0]}</div><div class="service-supporting">${primaryCards.slice(1).join("")}</div>`
    : primaryCards.join("");

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
  const servicesWrapperClass = useFeatured ? "services services-featured" : "services services-grid";

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
        radial-gradient(circle at 25% 20%, ${toCssColour(brandKit.primary)}18 0%, transparent 42%),
        radial-gradient(circle at 80% 75%, ${toCssColour(brandKit.secondary)}12 0%, transparent 40%),
        radial-gradient(circle at 55% 50%, ${toCssColour(brandKit.accent)}0a 0%, transparent 32%);
      z-index: 0;
    }
    .bg-noise {
      position: absolute; inset: 0;
      opacity: 0.04;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
      z-index: 1;
      pointer-events: none;
    }
    .bg-overlay {
      position: absolute; inset: 0;
      background:
        radial-gradient(circle at 50% 30%, transparent 0%, rgba(8,16,30,0.25) 60%, rgba(8,16,30,0.70) 100%),
        linear-gradient(180deg, rgba(8,16,30,0.68) 0%, rgba(8,16,30,0.22) 35%, rgba(8,16,30,0.14) 60%, rgba(8,16,30,0.64) 100%);
      z-index: 1;
    }
    .bg-blob { position: absolute; border-radius: 50%; filter: blur(70px); z-index: 0; pointer-events: none; }
    .blob-1 { top: -180px; right: -140px; width: 640px; height: 640px; background: radial-gradient(circle at 35% 35%, ${toCssColour(brandKit.primary)}32 0%, transparent 70%); }
    .blob-2 { bottom: -160px; left: -180px; width: 680px; height: 680px; background: radial-gradient(circle at 65% 65%, ${toCssColour(brandKit.secondary)}28 0%, transparent 70%); }
    .bg-glow {
      position: absolute;
      top: -120px; left: -120px;
      width: 720px; height: 720px;
      background: radial-gradient(circle, ${toCssColour(brandKit.accent)}0d 0%, transparent 60%);
      z-index: 0;
      pointer-events: none;
    }
    .bg-diagonal {
      position: absolute; inset: 0;
      background:
        linear-gradient(135deg, transparent 36%, ${toCssColour(brandKit.accent)}0c 36%, ${toCssColour(brandKit.accent)}0c 41%, transparent 41%),
        linear-gradient(225deg, transparent 38%, ${toCssColour(brandKit.primary)}0a 38%, ${toCssColour(brandKit.primary)}0a 43%, transparent 43%);
      z-index: 0;
      pointer-events: none;
    }
    .brand-shape {
      position: absolute;
      bottom: 280px;
      left: -170px;
      width: 440px;
      height: 440px;
      border-radius: 50%;
      background: ${toCssColour(brandKit.accent)};
      opacity: 0.12;
      filter: blur(50px);
      z-index: 1;
    }
    .brand-arc {
      position: absolute;
      top: 220px;
      right: -180px;
      width: 420px;
      height: 420px;
      border-radius: 50%;
      border: 40px solid ${toCssColour(brandKit.secondary)};
      opacity: 0.08;
      z-index: 1;
      pointer-events: none;
    }
    .brand-stripe {
      position: absolute;
      top: -100px;
      right: 140px;
      width: 100px;
      height: 520px;
      background: ${toCssColour(brandKit.secondary)};
      opacity: 0.14;
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
      background: linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(255,255,255,0.92) 55%, rgba(255,255,255,0) 100%);
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
    .main {
      position: absolute;
      top: 170px; left: 0; right: 0;
      bottom: 250px;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      gap: 18px;
      padding: 32px 56px 38px;
      z-index: 3;
      overflow: hidden;
    }
    .hero {
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: flex-start;
      text-align: left;
      color: #ffffff;
      flex-shrink: 0;
    }
    .hero-panel {
      position: relative;
      background: rgba(8,16,30,0.58);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border-radius: 28px;
      padding: 36px 42px;
      border-left: 8px solid ${toCssColour(brandKit.accent)};
      box-shadow: 0 24px 60px rgba(0,0,0,0.28), inset 0 0 0 1px rgba(255,255,255,0.08);
      max-width: 920px;
      overflow: hidden;
    }
    .hero-panel::before {
      content: "";
      position: absolute;
      top: 0; right: 0; bottom: 0;
      width: 180px;
      background: linear-gradient(90deg, transparent, ${toCssColour(brandKit.accent)}0a);
      pointer-events: none;
    }
    .editorial-line { width: 72px; height: 6px; border-radius: 3px; background: ${toCssColour(brandKit.accent)}; margin-bottom: 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.18); }
    .hero-shape-accent {
      position: absolute;
      top: 50%;
      left: 58%;
      width: 400px;
      height: 400px;
      transform: translate(-50%, -50%) rotate(12deg);
      border: 18px solid ${toCssColour(brandKit.accent)};
      opacity: 0.15;
      border-radius: 40px;
      z-index: 0;
    }
    .headline { position: relative; z-index: 2; font-size: 70px; font-weight: 900; line-height: 1.0; margin-bottom: 14px; letter-spacing: -0.038em; text-shadow: 0 4px 18px rgba(0,0,0,0.30); }
    .subheadline { position: relative; z-index: 2; font-size: 28px; font-weight: 600; line-height: 1.45; opacity: 0.98; }
    .offer-badge { position: relative; z-index: 2; margin-top: 18px; padding: 14px 28px; border-radius: 14px; background: ${toCssColour(brandKit.accent)}; color: ${contrastColor(brandKit.accent)}; font-size: 26px; font-weight: 900; box-shadow: 0 8px 24px rgba(0,0,0,0.18); display: inline-block; }
    .services { position: relative; width: 100%; margin: 16px 0; }
    .services-grid { display: grid; ${serviceGridStyle(visualDirection)}; }
    .services-featured { display: flex; flex-direction: column; gap: 22px; }
    .service-card {
      position: relative;
      background: linear-gradient(145deg, rgba(255,255,255,0.98) 0%, rgba(248,250,252,0.96) 100%);
      border-radius: 22px;
      padding: 26px;
      box-shadow: 0 14px 36px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.04);
      min-height: 118px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      border: 1px solid rgba(255,255,255,0.7);
      border-top: 6px solid ${toCssColour(brandKit.accent)};
    }
    .service-card:first-child { background: linear-gradient(145deg, #ffffff 0%, rgba(255,255,255,0.98) 100%); box-shadow: 0 18px 44px rgba(0,0,0,0.12); border-left: 4px solid ${toCssColour(brandKit.accent)}; padding: 30px; }
    .service-card:nth-child(even) { transform: translateY(8px); }
    .service-card:nth-child(3n+1) { border-top-color: ${toCssColour(brandKit.accent)}; }
    .service-card:nth-child(3n+2) { border-top-color: ${toCssColour(brandKit.secondary)}; }
    .service-card:nth-child(3n+3) { border-top-color: ${toCssColour(brandKit.primary)}; }
    .card-number { position: absolute; top: 12px; right: 18px; font-size: 48px; font-weight: 900; color: ${toCssColour(brandKit.accent)}; opacity: 0.12; line-height: 1; }
    .service-card:nth-child(3n+2) .card-number { color: ${toCssColour(brandKit.secondary)}; }
    .service-card:nth-child(3n+3) .card-number { color: ${toCssColour(brandKit.primary)}; }
    .card-title { font-size: 26px; font-weight: 900; color: ${toCssColour(brandKit.text)}; margin-bottom: 8px; line-height: 1.25; letter-spacing: -0.01em; }
    .card-desc { font-size: 18px; color: ${toCssColour(brandKit.textMuted)}; line-height: 1.45; }
    .service-featured {
      background: linear-gradient(145deg, rgba(255,255,255,0.98) 0%, rgba(248,250,252,0.96) 100%);
      border-radius: 28px;
      padding: 34px;
      box-shadow: 0 22px 54px rgba(0,0,0,0.13), inset 0 0 0 1px rgba(255,255,255,0.6);
      border-left: 8px solid ${toCssColour(brandKit.accent)};
      display: flex;
      gap: 28px;
      align-items: center;
    }
    .service-featured .service-card { background: transparent; box-shadow: none; border: none; padding: 0; min-height: 0; flex: 1; }
    .service-featured .card-number { position: static; font-size: 84px; opacity: 0.16; align-self: flex-start; line-height: 0.9; }
    .service-featured .card-title { font-size: 34px; margin-bottom: 10px; }
    .service-featured .card-desc { font-size: 20px; }
    .service-supporting { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
    .service-supporting .service-card { min-height: 110px; padding: 22px; }
    .density-minimal .service-supporting { grid-template-columns: 1fr; }
    .secondary-strip { position: relative; padding: 16px 32px; border-radius: 16px; background: rgba(255,255,255,0.94); text-align: center; font-size: 21px; font-weight: 800; color: ${toCssColour(brandKit.text)}; z-index: 3; box-shadow: 0 6px 20px rgba(0,0,0,0.06); border: 1px solid rgba(255,255,255,0.6); margin: 10px 0; }
    .benefits-band { position: relative; padding: 20px 34px; border-radius: 18px; background: rgba(255,255,255,0.94); display: flex; justify-content: space-between; gap: 20px; z-index: 3; box-shadow: 0 8px 24px rgba(0,0,0,0.08); border: 1px solid rgba(255,255,255,0.6); margin: 12px 0; }
    .benefit-item { flex: 1; display: flex; align-items: flex-start; gap: 12px; font-size: 20px; font-weight: 800; line-height: 1.35; color: ${toCssColour(brandKit.text)}; }
    .bullet { width: 11px; height: 11px; border-radius: 50%; background: ${toCssColour(brandKit.accent)}; flex-shrink: 0; margin-top: 7px; }
    .cta {
      position: absolute;
      bottom: 130px;
      left: 0;
      right: 0;
      z-index: 5;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .cta-anchor {
      position: absolute;
      bottom: 130px;
      left: 0;
      right: 0;
      height: 8px;
      background: ${toCssColour(brandKit.accent)};
      opacity: 0.25;
      z-index: 2;
    }
    .cta-button {
      width: 100%;
      padding: 36px 56px;
      border-radius: 0;
      background: ${toCssColour(brandKit.accent)};
      color: ${contrastColor(brandKit.accent)};
      font-size: 50px;
      font-weight: 900;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      box-shadow: 0 0 0 8px rgba(255,255,255,0.45), 0 -10px 40px rgba(0,0,0,0.25);
      border: none;
      border-top: 6px solid rgba(255,255,255,0.35);
      border-bottom: 6px solid rgba(0,0,0,0.12);
      text-shadow: 0 2px 4px rgba(0,0,0,0.18);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 18px;
    }
    .cta-button::after { content: "→"; font-size: 0.85em; }
    .cta-block { width: 100%; border-radius: 0; }
    .cta-block::after { content: "→"; }
    .cta-pill { width: auto; border-radius: 80px; padding: 28px 72px; }
    .cta-outline { background: transparent; color: ${toCssColour(brandKit.accent)}; border: 5px solid ${toCssColour(brandKit.accent)}; box-shadow: 0 0 0 4px rgba(255,255,255,0.25); }
    .cta-outline::after { content: "→"; }
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

    /* Visual-direction aware hierarchy tuning */
    .hero-shape_accent .headline { font-size: 70px; }
    .hero-solid_brand_block .headline { font-size: 64px; }
    .hero-gradient_abstract .hero-panel { background: linear-gradient(135deg, rgba(15,23,42,0.66), rgba(15,23,42,0.36)); }
    .hero-photo_full_bleed .hero-panel { background: rgba(8,16,30,0.64); }
    .hero-minimal_centered .hero { align-items: center; text-align: center; }
    .hero-minimal_centered .hero-panel { border-left: none; border-top: 8px solid ${toCssColour(brandKit.accent)}; }

    .density-minimal .services-grid { max-width: 780px; }
    .density-minimal .service-card { min-height: 136px; }
    .density-dense .service-card { padding: 20px; }
    .density-dense .card-title { font-size: 24px; }
    .density-dense .card-desc { font-size: 16px; }

    /* Layout presets */
    .preset-premium_services_brand_panel .headline { font-size: 66px; }
    .preset-premium_local_service .headline { font-size: 64px; }
    .preset-premium_offer_hero .offer-badge { font-size: 30px; padding: 14px 30px; }
    .preset-premium_retail_promo .headline { font-size: 72px; }
    .preset-premium_food_offer .hero-panel { background: rgba(15,23,42,0.62); }
    .preset-premium_professional_clean .hero-panel { background: rgba(15,23,42,0.62); }
  </style>
</head>
<body>
  <div class="canvas preset-${primary} hero-${visualDirection.heroTreatment} density-${visualDirection.density} cta-${visualDirection.ctaTreatment} service-${visualDirection.serviceLayout}">
    <div class="bg-pattern"></div>
    <div class="bg-noise"></div>
    <div class="bg-overlay"></div>
    <div class="bg-blob blob-1"></div>
    <div class="bg-blob blob-2"></div>
    <div class="bg-glow"></div>
    <div class="bg-diagonal"></div>
    <div class="brand-shape"></div>
    <div class="brand-arc"></div>
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
    <main class="main">
      <div class="hero">
        <div class="hero-panel">
          <div class="editorial-line"></div>
          <div class="headline">${escapeHtml(brief.headline)}</div>
          <div class="subheadline">${escapeHtml(brief.subheadline)}</div>
          ${offerBadge}
        </div>
      </div>
      ${benefits}
      <div class="${servicesWrapperClass}">${servicesHtml}</div>
      ${secondaryStrip}
      <div class="cta"><div class="${ctaClasses(visualDirection)}">${escapeHtml(brief.cta)}</div></div>
    </main>
    <div class="cta-anchor"></div>
    <div class="footer">
      <div class="footer-name">${escapeHtml(brief.businessName)}</div>
      ${footer}
    </div>
  </div>
</body>
</html>`;
}
