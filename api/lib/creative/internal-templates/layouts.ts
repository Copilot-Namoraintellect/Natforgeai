import sharp from "sharp";
import { contrastTextColor, safeText } from "../brand-palette";
import type { InternalTemplateRenderContext, InternalTemplateLayout } from "./types";
import type { PremiumTemplateId } from "../template-catalogue";

function sanitize(value: unknown): string {
  return safeText(value);
}

function escapeXml(unsafe: string): string {
  return sanitize(unsafe)
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

async function resizeLogo(logoBuffer: Buffer, maxWidth: number, maxHeight: number): Promise<Buffer> {
  return sharp(logoBuffer)
    .resize({ width: maxWidth, height: maxHeight, fit: sharp.fit.inside, withoutEnlargement: true })
    .png()
    .toBuffer();
}

async function compositeLogo(
  background: Buffer,
  logoBuffer: Buffer | null,
  options: { x: number; y: number; maxWidth: number; maxHeight: number }
): Promise<Buffer> {
  if (!logoBuffer) return background;

  const resized = await resizeLogo(logoBuffer, options.maxWidth, options.maxHeight);
  const { width = options.maxWidth, height = options.maxHeight } = await sharp(resized).metadata();

  const left = Math.round(options.x - (width || options.maxWidth) / 2);
  const top = Math.round(options.y - (height || options.maxHeight) / 2);

  return sharp(background)
    .composite([{ input: resized, left, top }])
    .png()
    .toBuffer();
}

function buildContactLines(contact: InternalTemplateRenderContext["contact"]): string[] {
  const lines: string[] = [];
  if (contact.whatsapp) lines.push(`WhatsApp ${contact.whatsapp}`);
  if (contact.phone && contact.phone !== contact.whatsapp) lines.push(contact.phone);
  if (contact.email) lines.push(contact.email);
  if (contact.website) lines.push(contact.website);
  if (contact.location) lines.push(contact.location);
  return lines;
}

function contactIconAndText(contact: InternalTemplateRenderContext["contact"]): { icon: string; text: string }[] {
  const items: { icon: string; text: string }[] = [];
  if (contact.whatsapp) items.push({ icon: "💬", text: contact.whatsapp });
  else if (contact.phone) items.push({ icon: "📞", text: contact.phone });
  if (contact.email) items.push({ icon: "✉", text: contact.email });
  if (contact.website) items.push({ icon: "🌐", text: contact.website });
  if (contact.location) items.push({ icon: "📍", text: contact.location });
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Service Business Promo
// ─────────────────────────────────────────────────────────────────────────────
async function renderServiceBusinessPromo(ctx: InternalTemplateRenderContext): Promise<Buffer> {
  const { width, height, businessName, brandPalette, headline, offer, subheadline, cta, services, contact } = ctx;
  const primary = brandPalette.primary;
  const secondary = brandPalette.secondary;
  const accent = brandPalette.accent;
  const headerTextColor = contrastTextColor(primary);

  const safeName = escapeXml(businessName);
  const safeHeadline = escapeXml(headline);
  const safeOffer = escapeXml(offer);
  const safeSub = escapeXml(subheadline || "");
  const safeCta = escapeXml(cta);
  const safeServices = services.slice(0, 4).map(escapeXml);

  // ── Layout grid: fixed header/footer, CTA above footer, content flows between ──
  const headerH = Math.round(height * 0.14);
  const footerH = 90;
  const footerY = height - footerH;
  const ctaH = 68;
  const ctaMargin = 28;
  const ctaY = footerY - ctaH - ctaMargin;
  const contentBottomMax = ctaY - ctaMargin;

  // ── CTA slot (defined early so font sizing can fit to it) ──
  const ctaRectX = Math.round(width * 0.12);
  const ctaRectW = Math.round(width * 0.76);

  // ── Logo: larger but still contained in the header ──
  const logoAreaW = Math.round(width * 0.34);
  const logoMax = Math.min(logoAreaW - 16, headerH - 16);

  // ── Font sizes ──
  const nameSize = fitFontSize(safeName, width - logoAreaW - 56, Math.max(22, Math.round(width / 28)), 20);
  const headlineSize = fitFontSize(safeHeadline, Math.round(width * 0.82), Math.round(width / 13), 34);
  const offerSize = fitFontSize(safeOffer, Math.round(width * 0.78), Math.round(width / 14), 28);
  const subSize = Math.max(22, Math.round(width / 32));
  const ctaSize = fitFontSize(safeCta, ctaRectW - 48, Math.round(width / 18), 26);
  const serviceSize = Math.max(20, Math.round(width / 44));
  const contactSize = Math.max(16, Math.round(width / 52));

  const headlineLines = wrapText(safeHeadline, Math.round((width * 0.82) / (headlineSize * 0.55)));
  const offerLines = wrapText(safeOffer, Math.round((width * 0.78) / (offerSize * 0.55)));
  const subLines = safeSub ? wrapText(safeSub, Math.round((width * 0.82) / (subSize * 0.55))) : [];

  // ── Build content top-to-bottom, then center it vertically in the safe area ──
  const contentTopBase = headerH + 24;
  let cursorY = contentTopBase;

  const headlineBlocks = headlineLines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${cursorY + (i + 1) * (headlineSize + 10)}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineSize}" font-weight="900" fill="#0F172A" text-anchor="middle">${line}</text>`
    )
    .join("");
  cursorY += headlineLines.length * (headlineSize + 10) + 14;

  const offerCardY = cursorY - 10;
  const offerCardH =
    30 +
    offerLines.length * (offerSize + 8) +
    (subLines.length ? subLines.length * (subSize + 8) + 20 : 0);

  const offerBlocks = offerLines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${cursorY + 16 + (i + 1) * (offerSize + 8)}" font-family="Arial, Helvetica, sans-serif" font-size="${offerSize}" font-weight="900" fill="${primary}" text-anchor="middle">${line}</text>`
    )
    .join("");
  cursorY += offerLines.length * (offerSize + 8) + 8;

  const subBlocks = subLines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${cursorY + (i + 1) * (subSize + 8)}" font-family="Arial, Helvetica, sans-serif" font-size="${subSize}" font-weight="600" fill="#475569" text-anchor="middle">${line}</text>`
    )
    .join("");
  cursorY += subLines.length ? subLines.length * (subSize + 8) + 24 : 12;

  // ── Services: shrink slightly if they would collide with the CTA ──
  let serviceCardW = Math.round((width - 80) / 2);
  let serviceCardH = 100;
  let serviceGap = 14;
  let serviceStartY = cursorY;
  let rows = Math.ceil(safeServices.length / 2);
  let servicesEndY = safeServices.length
    ? serviceStartY + rows * (serviceCardH + serviceGap) - serviceGap
    : serviceStartY;

  // If content is too tall, compact the service cards so the CTA/footer stay safe.
  if (servicesEndY > contentBottomMax && safeServices.length > 0) {
    const available = contentBottomMax - serviceStartY;
    const minCardH = 64;
    const targetRowH = Math.max(minCardH, Math.floor(available / rows));
    serviceCardH = Math.min(serviceCardH, targetRowH - serviceGap);
    servicesEndY = serviceStartY + rows * (serviceCardH + serviceGap) - serviceGap;
  }

  const serviceBlocks: string[] = [];
  safeServices.forEach((svc, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 32 + col * (serviceCardW + serviceGap);
    const y = serviceStartY + row * (serviceCardH + serviceGap);
    const lines = wrapText(svc, Math.round((serviceCardW - 36) / (serviceSize * 0.55)));
    serviceBlocks.push(
      `<rect x="${x}" y="${y}" width="${serviceCardW}" height="${serviceCardH}" rx="14" fill="#FFFFFF" stroke="${primary}" stroke-width="2" stroke-opacity="0.18"/>`
    );
    lines.forEach((line, li) => {
      serviceBlocks.push(
        `<text x="${x + 18}" y="${y + 32 + li * (serviceSize + 8)}" font-family="Arial, Helvetica, sans-serif" font-size="${serviceSize}" font-weight="700" fill="#0F172A">${line}</text>`
      );
    });
  });

  // Center the whole content block vertically between header and CTA for better balance.
  const contentHeight = servicesEndY - contentTopBase;
  const availableContentHeight = contentBottomMax - contentTopBase;
  const verticalOffset =
    contentHeight > 0 && availableContentHeight > contentHeight
      ? Math.round((availableContentHeight - contentHeight) / 2)
      : 0;

  function shiftY(svgFragment: string, dy: number): string {
    return svgFragment.replace(/y="(-?\d+(?:\.\d+)?)"/g, (_, y) => `y="${Math.round(Number(y) + dy)}"`);
  }

  const contentBlocks = [
    headlineBlocks,
    `<rect x="${Math.round(width * 0.05)}" y="${offerCardY}" width="${Math.round(width * 0.9)}" height="${offerCardH}" rx="18" fill="#FFFFFF" stroke="${accent}" stroke-width="3" stroke-opacity="0.35"/>`,
    offerBlocks,
    subBlocks,
    serviceBlocks.join(""),
  ].join("");
  const shiftedContentBlocks = verticalOffset > 0 ? shiftY(contentBlocks, verticalOffset) : contentBlocks;

  // ── CTA: fixed slot above footer, fully inside canvas ──
  const ctaTextY = ctaY + ctaH / 2 + Math.round(ctaSize * 0.35);

  // ── Footer: compact band with up to 2 contact lines ──
  const contactItems = contactIconAndText(contact).slice(0, 2);
  const contactStartY = footerY + (footerH - contactItems.length * (contactSize + 10)) / 2 + contactSize;
  const contactBlocks = contactItems
    .map(
      (item, i) =>
        `<text x="${width / 2}" y="${contactStartY + i * (contactSize + 10)}" font-family="Arial, Helvetica, sans-serif" font-size="${contactSize}" font-weight="600" fill="${headerTextColor}" text-anchor="middle">${item.icon} ${escapeXml(item.text)}</text>`
    )
    .join("");

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="svcBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:${primary};stop-opacity:0.10" />
      <stop offset="35%" style="stop-color:#F8FAFC;stop-opacity:1" />
      <stop offset="100%" style="stop-color:${secondary};stop-opacity:0.12" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#svcBg)"/>
  <rect x="0" y="0" width="${width}" height="${headerH}" fill="${primary}"/>
  <rect x="0" y="${headerH}" width="${width}" height="8" fill="${accent}"/>

  <!-- logo placeholder area (logo composited via Sharp) -->
  <rect x="20" y="12" width="${logoAreaW}" height="${headerH - 24}" rx="14" fill="${primary}" opacity="0.0"/>

  <!-- business name -->
  <text x="${logoAreaW + 32}" y="${headerH / 2 + 8}" font-family="Arial, Helvetica, sans-serif" font-size="${nameSize}" font-weight="800" fill="${headerTextColor}">${safeName}</text>

  <!-- content (headline, offer card, services) -->
  ${shiftedContentBlocks}

  <!-- CTA button (above footer) -->
  <rect x="${ctaRectX}" y="${ctaY}" width="${ctaRectW}" height="${ctaH}" rx="${Math.round(ctaH / 2)}" fill="${accent}"/>
  <text x="${width / 2}" y="${ctaTextY}" font-family="Arial, Helvetica, sans-serif" font-size="${ctaSize}" font-weight="900" fill="${contrastTextColor(accent)}" text-anchor="middle">${safeCta}</text>

  <!-- footer -->
  <rect x="0" y="${footerY}" width="${width}" height="${footerH}" fill="${primary}"/>
  ${contactBlocks}
</svg>`;

  const background = await svgToPng(svg);
  return compositeLogo(background, ctx.logoBuffer, {
    x: 20 + logoAreaW / 2,
    y: headerH / 2,
    maxWidth: logoMax,
    maxHeight: logoMax,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Retail Product Promo
// ─────────────────────────────────────────────────────────────────────────────
async function renderRetailProductPromo(ctx: InternalTemplateRenderContext): Promise<Buffer> {
  const { width, height, businessName, brandPalette, headline, offer, subheadline, cta, contact } = ctx;
  const primary = brandPalette.primary;
  const secondary = brandPalette.secondary;
  const accent = brandPalette.accent;

  const safeName = escapeXml(businessName);
  const safeHeadline = escapeXml(headline);
  const safeOffer = escapeXml(offer);
  const safeSub = escapeXml(subheadline || "");
  const safeCta = escapeXml(cta);

  const headlineSize = fitFontSize(safeHeadline, Math.round(width * 0.86), Math.round(width / 12), 38);
  const offerSize = fitFontSize(safeOffer, Math.round(width * 0.7), Math.round(width / 10), 40);
  const subSize = Math.max(22, Math.round(width / 28));
  const ctaSize = Math.max(28, Math.round(width / 16));

  const headlineLines = wrapText(safeHeadline, Math.round((width * 0.86) / (headlineSize * 0.55)));
  const offerLines = wrapText(safeOffer, Math.round((width * 0.7) / (offerSize * 0.55)));
  const subLines = safeSub ? wrapText(safeSub, Math.round((width * 0.86) / (subSize * 0.55))) : [];

  const headerH = 130;
  const logoMax = 90;

  const headlineBlocks = headlineLines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${headerH + 80 + (i + 1) * (headlineSize + 10)}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineSize}" font-weight="900" fill="#0F172A" text-anchor="middle">${line}</text>`
    )
    .join("");

  const offerY = headerH + 100 + headlineLines.length * (headlineSize + 10);
  const offerBlocks = offerLines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${offerY + 60 + (i + 1) * (offerSize + 8)}" font-family="Arial, Helvetica, sans-serif" font-size="${offerSize}" font-weight="900" fill="#FFFFFF" text-anchor="middle">${line}</text>`
    )
    .join("");

  const subY = offerY + 80 + offerLines.length * (offerSize + 8);
  const subBlocks = subLines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${subY + 30 + (i + 1) * (subSize + 8)}" font-family="Arial, Helvetica, sans-serif" font-size="${subSize}" font-weight="600" fill="#475569" text-anchor="middle">${line}</text>`
    )
    .join("");

  const contactLines = buildContactLines(contact).slice(0, 3);
  const contactSize = Math.max(16, Math.round(width / 48));
  const contactBlocks = contactLines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${height - 120 + (i + 1) * (contactSize + 12)}" font-family="Arial, Helvetica, sans-serif" font-size="${contactSize}" font-weight="600" fill="#334155" text-anchor="middle">${escapeXml(line)}</text>`
    )
    .join("");

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="retailBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#FFFFFF;stop-opacity:1" />
      <stop offset="60%" style="stop-color:${secondary};stop-opacity:0.12" />
      <stop offset="100%" style="stop-color:${primary};stop-opacity:0.16" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#retailBg)"/>
  <rect x="0" y="0" width="${width}" height="${headerH}" fill="${primary}"/>
  <text x="${width - 28}" y="${headerH / 2 + 10}" font-family="Arial, Helvetica, sans-serif" font-size="${Math.max(
    24,
    Math.round(width / 30)
  )}" font-weight="800" fill="${contrastTextColor(primary)}" text-anchor="end">${safeName}</text>

  ${headlineBlocks}

  <circle cx="${width / 2}" cy="${offerY + 50}" r="${Math.round(width * 0.32)}" fill="${accent}" opacity="0.95"/>
  ${offerBlocks}

  ${subBlocks}

  <rect x="${Math.round(width * 0.18)}" y="${subY + (subLines.length ? subLines.length * (subSize + 8) + 50 : 50)}" width="${Math.round(
    width * 0.64
  )}" height="64" rx="32" fill="${primary}"/>
  <text x="${width / 2}" y="${subY + (subLines.length ? subLines.length * (subSize + 8) + 50 : 50) + 42}" font-family="Arial, Helvetica, sans-serif" font-size="${ctaSize}" font-weight="900" fill="${contrastTextColor(
    primary
  )}" text-anchor="middle">${safeCta}</text>

  ${contactBlocks}
</svg>`;

  const background = await svgToPng(svg);
  return compositeLogo(background, ctx.logoBuffer, {
    x: 28 + logoMax / 2,
    y: headerH / 2,
    maxWidth: logoMax,
    maxHeight: logoMax,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Offer / Discount Campaign
// ─────────────────────────────────────────────────────────────────────────────
async function renderOfferDiscountCampaign(ctx: InternalTemplateRenderContext): Promise<Buffer> {
  const { width, height, businessName, brandPalette, headline, offer, subheadline, cta, contact } = ctx;
  const primary = brandPalette.primary;
  const secondary = brandPalette.secondary;
  const accent = brandPalette.accent;

  const safeName = escapeXml(businessName);
  const safeHeadline = escapeXml(headline);
  const safeOffer = escapeXml(offer);
  const safeSub = escapeXml(subheadline || "");
  const safeCta = escapeXml(cta);

  const headlineSize = fitFontSize(safeHeadline, Math.round(width * 0.86), Math.round(width / 14), 32);
  const offerSize = fitFontSize(safeOffer, Math.round(width * 0.82), Math.round(width / 8), 52);
  const subSize = Math.max(22, Math.round(width / 28));
  const ctaSize = Math.max(28, Math.round(width / 16));

  const headlineLines = wrapText(safeHeadline, Math.round((width * 0.86) / (headlineSize * 0.55)));
  const offerLines = wrapText(safeOffer, Math.round((width * 0.82) / (offerSize * 0.55)));
  const subLines = safeSub ? wrapText(safeSub, Math.round((width * 0.86) / (subSize * 0.55))) : [];

  const logoY = 90;
  const logoMax = 110;

  const centerY = height * 0.5;

  const headlineBlocks = headlineLines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${centerY - 160 + (i + 1) * (headlineSize + 10)}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineSize}" font-weight="900" fill="#0F172A" text-anchor="middle">${line}</text>`
    )
    .join("");

  const offerBlocks = offerLines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${centerY - 60 + (i + 1) * (offerSize + 10)}" font-family="Arial, Helvetica, sans-serif" font-size="${offerSize}" font-weight="900" fill="#FFFFFF" text-anchor="middle">${line}</text>`
    )
    .join("");

  const subBlocks = subLines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${centerY + 60 + offerLines.length * (offerSize + 10) + (i + 1) * (subSize + 8)}" font-family="Arial, Helvetica, sans-serif" font-size="${subSize}" font-weight="700" fill="#0F172A" text-anchor="middle">${line}</text>`
    )
    .join("");

  const contactItems = contactIconAndText(contact).slice(0, 4);
  const contactSize = Math.max(16, Math.round(width / 48));
  const contactBlocks = contactItems
    .map(
      (item, i) =>
        `<text x="${width / 2}" y="${height - 130 + (i + 1) * (contactSize + 12)}" font-family="Arial, Helvetica, sans-serif" font-size="${contactSize}" font-weight="600" fill="#FFFFFF" text-anchor="middle">${item.icon} ${escapeXml(item.text)}</text>`
    )
    .join("");

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="offerBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${primary};stop-opacity:0.22" />
      <stop offset="50%" style="stop-color:#FFFFFF;stop-opacity:1" />
      <stop offset="100%" style="stop-color:${secondary};stop-opacity:0.20" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#offerBg)"/>
  <polygon points="0,0 ${width},0 ${width},${Math.round(height * 0.35)} 0,${Math.round(height * 0.45)}" fill="${primary}" opacity="0.95"/>
  <polygon points="0,${height} ${width},${height} ${width},${Math.round(height * 0.68)} 0,${Math.round(height * 0.58)}" fill="${accent}" opacity="0.95"/>

  <!-- business name top -->
  <text x="${width / 2}" y="${logoY + 80}" font-family="Arial, Helvetica, sans-serif" font-size="${Math.max(
    22,
    Math.round(width / 28)
  )}" font-weight="800" fill="${contrastTextColor(primary)}" text-anchor="middle">${safeName}</text>

  ${headlineBlocks}

  <rect x="${Math.round(width * 0.06)}" y="${centerY - 100}" width="${Math.round(
    width * 0.88
  )}" height="${120 + offerLines.length * (offerSize + 10)}" rx="24" fill="${accent}" transform="rotate(-2, ${width / 2}, ${centerY})"/>
  ${offerBlocks}

  ${subBlocks}

  <rect x="${Math.round(width * 0.22)}" y="${centerY + 90 + offerLines.length * (offerSize + 10) + (subLines.length ? subLines.length * (subSize + 8) + 20 : 0)}" width="${Math.round(
    width * 0.56
  )}" height="60" rx="30" fill="${primary}"/>
  <text x="${width / 2}" y="${centerY + 130 + offerLines.length * (offerSize + 10) + (subLines.length ? subLines.length * (subSize + 8) + 20 : 0)}" font-family="Arial, Helvetica, sans-serif" font-size="${ctaSize}" font-weight="900" fill="${contrastTextColor(
    primary
  )}" text-anchor="middle">${safeCta}</text>

  ${contactBlocks}
</svg>`;

  const background = await svgToPng(svg);
  return compositeLogo(background, ctx.logoBuffer, {
    x: width / 2,
    y: logoY,
    maxWidth: logoMax,
    maxHeight: logoMax,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Corporate Professional
// ─────────────────────────────────────────────────────────────────────────────
async function renderCorporateProfessional(ctx: InternalTemplateRenderContext): Promise<Buffer> {
  const { width, height, businessName, brandPalette, headline, offer, subheadline, cta, services, contact } = ctx;
  const primary = brandPalette.primary;
  const accent = brandPalette.accent;

  const safeName = escapeXml(businessName);
  const safeHeadline = escapeXml(headline);
  const safeOffer = escapeXml(offer);
  const safeSub = escapeXml(subheadline || "");
  const safeCta = escapeXml(cta);
  const safeServices = services.slice(0, 3).map(escapeXml);

  const headlineSize = fitFontSize(safeHeadline, Math.round(width * 0.82), Math.round(width / 14), 34);
  const offerSize = fitFontSize(safeOffer, Math.round(width * 0.7), Math.round(width / 16), 28);
  const subSize = Math.max(22, Math.round(width / 30));
  // CTA button is 240px wide in the footer; keep the text inside it.
  const ctaSize = fitFontSize(safeCta, 220, Math.round(width / 18), 22);
  const serviceSize = Math.max(20, Math.round(width / 44));
  const contactSize = Math.max(16, Math.round(width / 52));

  const headlineLines = wrapText(safeHeadline, Math.round((width * 0.82) / (headlineSize * 0.55)));
  const offerLines = wrapText(safeOffer, Math.round((width * 0.7) / (offerSize * 0.55)));
  const subLines = safeSub ? wrapText(safeSub, Math.round((width * 0.82) / (subSize * 0.55))) : [];

  const headerH = 120;
  const logoMax = 90;

  const contentStart = headerH + 70;
  const headlineBlocks = headlineLines
    .map(
      (line, i) =>
        `<text x="60" y="${contentStart + (i + 1) * (headlineSize + 10)}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineSize}" font-weight="900" fill="#0F172A">${line}</text>`
    )
    .join("");

  const offerY = contentStart + headlineLines.length * (headlineSize + 10) + 30;
  const offerBlocks = offerLines
    .map(
      (line, i) =>
        `<text x="60" y="${offerY + (i + 1) * (offerSize + 8)}" font-family="Arial, Helvetica, sans-serif" font-size="${offerSize}" font-weight="800" fill="${primary}">${line}</text>`
    )
    .join("");

  const subY = offerY + offerLines.length * (offerSize + 8) + 20;
  const subBlocks = subLines
    .map(
      (line, i) =>
        `<text x="60" y="${subY + (i + 1) * (subSize + 8)}" font-family="Arial, Helvetica, sans-serif" font-size="${subSize}" font-weight="500" fill="#475569">${line}</text>`
    )
    .join("");

  const serviceY = subY + (subLines.length ? subLines.length * (subSize + 8) + 40 : 20);
  const serviceBlocks: string[] = [];
  safeServices.forEach((svc, i) => {
    const y = serviceY + i * 56;
    serviceBlocks.push(`<rect x="60" y="${y}" width="12" height="12" rx="6" fill="${accent}"/>`);
    serviceBlocks.push(
      `<text x="88" y="${y + 12}" font-family="Arial, Helvetica, sans-serif" font-size="${serviceSize}" font-weight="700" fill="#0F172A">${svc}</text>`
    );
  });

  const footerY = height - 130;
  const contactLines = buildContactLines(contact).slice(0, 3);
  const contactBlocks = contactLines
    .map(
      (line, i) =>
        `<text x="60" y="${footerY + 30 + i * (contactSize + 14)}" font-family="Arial, Helvetica, sans-serif" font-size="${contactSize}" font-weight="600" fill="${contrastTextColor(
          primary
        )}">${escapeXml(line)}</text>`
    )
    .join("");

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="#FAFBFC"/>
  <rect x="0" y="0" width="${width}" height="${headerH}" fill="#FFFFFF"/>
  <rect x="0" y="${headerH}" width="${width}" height="6" fill="${accent}"/>
  <rect x="0" y="${footerY}" width="${width}" height="${height - footerY}" fill="${primary}"/>

  <!-- business name -->
  <text x="${width - 40}" y="${headerH / 2 + 10}" font-family="Arial, Helvetica, sans-serif" font-size="${Math.max(
    22,
    Math.round(width / 28)
  )}" font-weight="800" fill="#0F172A" text-anchor="end">${safeName}</text>

  ${headlineBlocks}
  ${offerBlocks}
  ${subBlocks}
  ${serviceBlocks.join("")}

  ${contactBlocks}
  <rect x="${width - 280}" y="${footerY + 26}" width="240" height="60" rx="30" fill="${accent}"/>
  <text x="${width - 160}" y="${footerY + 64}" font-family="Arial, Helvetica, sans-serif" font-size="${ctaSize}" font-weight="900" fill="${contrastTextColor(
    accent
  )}" text-anchor="middle">${safeCta}</text>
</svg>`;

  const background = await svgToPng(svg);
  return compositeLogo(background, ctx.logoBuffer, {
    x: 40 + logoMax / 2,
    y: headerH / 2,
    maxWidth: logoMax,
    maxHeight: logoMax,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Local Store Promo
// ─────────────────────────────────────────────────────────────────────────────
async function renderLocalStorePromo(ctx: InternalTemplateRenderContext): Promise<Buffer> {
  const { width, height, businessName, brandPalette, headline, offer, subheadline, cta, services, contact } = ctx;
  const primary = brandPalette.primary;
  const secondary = brandPalette.secondary;
  const accent = brandPalette.accent;

  const safeName = escapeXml(businessName);
  const safeHeadline = escapeXml(headline);
  const safeOffer = escapeXml(offer);
  const safeSub = escapeXml(subheadline || "");
  const safeCta = escapeXml(cta);
  const safeServices = services.slice(0, 3).map(escapeXml);

  const headlineSize = fitFontSize(safeHeadline, Math.round(width * 0.86), Math.round(width / 14), 34);
  const offerSize = fitFontSize(safeOffer, Math.round(width * 0.76), Math.round(width / 12), 34);
  const subSize = Math.max(22, Math.round(width / 30));
  const ctaSize = Math.max(28, Math.round(width / 18));
  const serviceSize = Math.max(20, Math.round(width / 44));

  const headlineLines = wrapText(safeHeadline, Math.round((width * 0.86) / (headlineSize * 0.55)));
  const offerLines = wrapText(safeOffer, Math.round((width * 0.76) / (offerSize * 0.55)));
  const subLines = safeSub ? wrapText(safeSub, Math.round((width * 0.86) / (subSize * 0.55))) : [];

  const headerH = 170;
  const logoMax = 120;

  const headlineBlocks = headlineLines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${headerH + 60 + (i + 1) * (headlineSize + 10)}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineSize}" font-weight="900" fill="#0F172A" text-anchor="middle">${line}</text>`
    )
    .join("");

  const offerY = headerH + 80 + headlineLines.length * (headlineSize + 10);
  const offerBlocks = offerLines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${offerY + 50 + (i + 1) * (offerSize + 8)}" font-family="Arial, Helvetica, sans-serif" font-size="${offerSize}" font-weight="900" fill="${primary}" text-anchor="middle">${line}</text>`
    )
    .join("");

  const subY = offerY + 70 + offerLines.length * (offerSize + 8);
  const subBlocks = subLines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${subY + (i + 1) * (subSize + 8)}" font-family="Arial, Helvetica, sans-serif" font-size="${subSize}" font-weight="600" fill="#475569" text-anchor="middle">${line}</text>`
    )
    .join("");

  const serviceY = subY + (subLines.length ? subLines.length * (subSize + 8) + 30 : 10);
  const serviceBoxH = 96;
  const serviceBlocks: string[] = [];
  safeServices.forEach((svc, i) => {
    const x = 60 + i * Math.round((width - 120) / Math.max(safeServices.length, 1));
    const w = Math.round((width - 120) / Math.max(safeServices.length, 1)) - 16;
    serviceBlocks.push(`<rect x="${x}" y="${serviceY}" width="${w}" height="${serviceBoxH}" rx="16" fill="${secondary}" opacity="0.18" stroke="${primary}" stroke-width="2" stroke-opacity="0.20"/>`);
    const lines = wrapText(svc, Math.round((w - 24) / (serviceSize * 0.55))).slice(0, 3);
    const textBlockH = lines.length * (serviceSize + 6);
    const startTy = serviceY + (serviceBoxH - textBlockH) / 2 + serviceSize;
    lines.forEach((line, li) => {
      serviceBlocks.push(
        `<text x="${x + w / 2}" y="${startTy + li * (serviceSize + 6)}" font-family="Arial, Helvetica, sans-serif" font-size="${serviceSize}" font-weight="700" fill="#0F172A" text-anchor="middle">${line}</text>`
      );
    });
  });

  const location = contact.location || contact.website || "";
  const locationBlock = location
    ? `<text x="${width / 2}" y="${height - 130}" font-family="Arial, Helvetica, sans-serif" font-size="${Math.max(
        18,
        Math.round(width / 44)
      )}" font-weight="700" fill="${contrastTextColor(primary)}" text-anchor="middle">📍 ${escapeXml(location)}</text>`
    : "";

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="localBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:${secondary};stop-opacity:0.18" />
      <stop offset="40%" style="stop-color:#FFFFFF;stop-opacity:1" />
      <stop offset="100%" style="stop-color:${primary};stop-opacity:0.12" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#localBg)"/>
  <rect x="0" y="0" width="${width}" height="${headerH}" fill="${primary}" opacity="0.95"/>
  <text x="${width / 2}" y="${headerH - 20}" font-family="Arial, Helvetica, sans-serif" font-size="${Math.max(
    24,
    Math.round(width / 28)
  )}" font-weight="800" fill="${contrastTextColor(primary)}" text-anchor="middle">${safeName}</text>

  ${headlineBlocks}

  <rect x="${Math.round(width * 0.08)}" y="${offerY}" width="${Math.round(
    width * 0.84
  )}" height="${70 + offerLines.length * (offerSize + 8)}" rx="24" fill="#FFFFFF" stroke="${accent}" stroke-width="3" stroke-opacity="0.40"/>
  ${offerBlocks}

  ${subBlocks}
  ${serviceBlocks.join("")}

  <rect x="0" y="${height - 160}" width="${width}" height="160" fill="${primary}"/>
  ${locationBlock}
  <rect x="${Math.round(width * 0.2)}" y="${height - 90}" width="${Math.round(
    width * 0.6
  )}" height="60" rx="30" fill="${accent}"/>
  <text x="${width / 2}" y="${height - 52}" font-family="Arial, Helvetica, sans-serif" font-size="${ctaSize}" font-weight="900" fill="${contrastTextColor(
    accent
  )}" text-anchor="middle">${safeCta}</text>
</svg>`;

  const background = await svgToPng(svg);
  return compositeLogo(background, ctx.logoBuffer, {
    x: width / 2,
    y: headerH / 2 - 10,
    maxWidth: logoMax,
    maxHeight: logoMax,
  });
}

export const INTERNAL_TEMPLATE_LAYOUTS: Record<PremiumTemplateId, InternalTemplateLayout> = {
  service_business_promo: { id: "service_business_promo", render: renderServiceBusinessPromo },
  retail_product_promo: { id: "retail_product_promo", render: renderRetailProductPromo },
  offer_discount_campaign: { id: "offer_discount_campaign", render: renderOfferDiscountCampaign },
  corporate_professional: { id: "corporate_professional", render: renderCorporateProfessional },
  local_store_promo: { id: "local_store_promo", render: renderLocalStorePromo },
};

export function getInternalTemplateLayout(id: PremiumTemplateId): InternalTemplateLayout {
  return INTERNAL_TEMPLATE_LAYOUTS[id];
}
