/**
 * Brand palette extraction and resolution.
 *
 * Priority order for the final leaflet palette:
 * 1. Colours extracted from the uploaded business logo.
 * 2. Explicit brandColours saved on the business profile.
 * 3. Business profile visual style defaults.
 */

import sharp from "sharp";

export interface BrandPalette {
  primary: string;
  secondary: string;
  accent: string;
  source: "logo" | "brandColors" | "default";
}

function sanitizeHex(hex: string): string | null {
  const clean = hex.trim().replace("#", "");
  if (/^[0-9A-Fa-f]{3}$/.test(clean)) {
    return `#${clean.split("").map((c) => c + c).join("")}`;
  }
  if (/^[0-9A-Fa-f]{6}$/.test(clean)) {
    return `#${clean.toUpperCase()}`;
  }
  return null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = sanitizeHex(hex);
  if (!normalized) return null;
  const num = parseInt(normalized.replace("#", ""), 16);
  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0").toUpperCase()}`;
}

function isNearWhiteOrBlack(c: { r: number; g: number; b: number }, alpha: number): boolean {
  if (alpha < 0.5) return true;
  const luminance = (c.r * 299 + c.g * 587 + c.b * 114) / 1000;
  return luminance > 245 || luminance < 15;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const l = (max + min) / 2;
  let s = 0;
  let h = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rNorm:
        h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0);
        break;
      case gNorm:
        h = (bNorm - rNorm) / d + 2;
        break;
      case bNorm:
        h = (rNorm - gNorm) / d + 4;
        break;
    }
    h /= 6;
  }
  return { h: h * 360, s, l };
}

/**
 * True for colours that are too dark, too light, or too grey to be useful
 * brand accents.
 */
function isMutedOrNeutral(r: number, g: number, b: number): boolean {
  const luminance = (r * 299 + g * 587 + b * 114) / 1000;
  if (luminance > 245 || luminance < 25) return true;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min < 30;
}

/**
 * Cluster non-neutral pixels by hue bucket and return the most common
 * representative colours. This is much more robust than raw RGB counting
 * because it ignores background/neutral tones and picks real brand hues.
 */
function extractHueClusters(
  pixels: { r: number; g: number; b: number }[],
  maxColors: number
): { r: number; g: number; b: number }[] {
  const hueBuckets = new Map<number, { count: number; sumR: number; sumG: number; sumB: number; samples: { r: number; g: number; b: number }[] }>();

  for (const p of pixels) {
    if (isMutedOrNeutral(p.r, p.g, p.b)) continue;
    const hsl = rgbToHsl(p.r, p.g, p.b);
    if (hsl.s < 0.2 || hsl.l < 0.08 || hsl.l > 0.95) continue;
    const hueBucket = Math.round(hsl.h / 30) % 12; // 12 x 30° hue slices
    const existing = hueBuckets.get(hueBucket);
    if (existing) {
      existing.count++;
      existing.sumR += p.r;
      existing.sumG += p.g;
      existing.sumB += p.b;
      existing.samples.push(p);
    } else {
      hueBuckets.set(hueBucket, { count: 1, sumR: p.r, sumG: p.g, sumB: p.b, samples: [p] });
    }
  }

  const sorted = Array.from(hueBuckets.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, maxColors);

  return sorted.map((bucket) => {
    // Use the most saturated sample in the bucket as the representative so
    // brand colours stay vivid rather than muddy averages.
    const representative = bucket.samples.reduce((best, sample) => {
      const bestHsl = rgbToHsl(best.r, best.g, best.b);
      const sampleHsl = rgbToHsl(sample.r, sample.g, sample.b);
      return sampleHsl.s > bestHsl.s ? sample : best;
    }, bucket.samples[0]);
    return {
      r: representative.r,
      g: representative.g,
      b: representative.b,
    };
  });
}

/**
 * Quantize raw pixels into a small set of dominant colours using a simple
 * median-cut style bucketing approach.
 */
function quantizeColors(pixels: { r: number; g: number; b: number }[], maxColors: number): { r: number; g: number; b: number }[] {
  if (pixels.length === 0) return [];

  // Bucket pixels by coarse RGB values to find clusters.
  const buckets = new Map<string, { color: { r: number; g: number; b: number }; count: number }>();
  for (const p of pixels) {
    // Reduce precision to cluster similar colours.
    const key = `${Math.round(p.r / 16)},${Math.round(p.g / 16)},${Math.round(p.b / 16)}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.color.r = (existing.color.r * existing.count + p.r) / (existing.count + 1);
      existing.color.g = (existing.color.g * existing.count + p.g) / (existing.count + 1);
      existing.color.b = (existing.color.b * existing.count + p.b) / (existing.count + 1);
      existing.count++;
    } else {
      buckets.set(key, { color: { ...p }, count: 1 });
    }
  }

  const sorted = Array.from(buckets.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, maxColors)
    .map((b) => ({
      r: Math.round(b.color.r),
      g: Math.round(b.color.g),
      b: Math.round(b.color.b),
    }));

  return sorted;
}

/**
 * Extract a brand palette from a logo image URL or local path.
 * Uses hue clustering to ignore background/neutral pixels and pick the real
 * brand colours. Returns null if the logo cannot be loaded.
 */
export async function extractLogoPalette(logoUrl: string): Promise<BrandPalette | null> {
  try {
    let buffer: Buffer;
    if (logoUrl.startsWith("http")) {
      // If it points at the local dev server, load the file directly so we
      // do not depend on the dev server being up in production.
      const localBaseUrl = "http://localhost:3000";
      if (logoUrl.startsWith(localBaseUrl)) {
        const fs = await import("fs");
        const path = await import("path");
        const pathname = logoUrl.slice(localBaseUrl.length);
        const publicDir = path.resolve(process.cwd(), "public");
        const prodPublicDir = path.resolve(process.cwd(), "dist/public");
        const persistentDir = path.resolve(process.cwd(), "data/public/uploads");
        const relative = pathname.startsWith("/") ? pathname.slice(1) : pathname;
        const persistentRelative = relative.replace(/^uploads[\\/]/, "");
        const candidates = [
          path.join(publicDir, relative),
          path.join(prodPublicDir, relative),
          path.join(persistentDir, persistentRelative),
        ];
        const found = candidates.find((c) => fs.existsSync(c));
        if (found) {
          buffer = fs.readFileSync(found);
        } else {
          const response = await fetch(logoUrl);
          if (!response.ok) return null;
          buffer = Buffer.from(await response.arrayBuffer());
        }
      } else {
        const response = await fetch(logoUrl);
        if (!response.ok) return null;
        buffer = Buffer.from(await response.arrayBuffer());
      }
    } else {
      // Resolve local path. The caller typically already resolves this.
      const fs = await import("fs");
      const path = await import("path");
      const publicDir = path.resolve(process.cwd(), "public");
      const prodPublicDir = path.resolve(process.cwd(), "dist/public");
      const persistentDir = path.resolve(process.cwd(), "data/public/uploads");
      const relative = logoUrl.startsWith("/") ? logoUrl.slice(1) : logoUrl;
      const persistentRelative = relative.replace(/^uploads[\\/]/, "");
      const candidates = [
        path.join(publicDir, relative),
        path.join(prodPublicDir, relative),
        path.join(persistentDir, persistentRelative),
      ];
      const found = candidates.find((c) => fs.existsSync(c));
      if (!found) return null;
      buffer = fs.readFileSync(found);
    }

    const { data, info } = await sharp(buffer)
      .resize(200, 200, { fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels: { r: number; g: number; b: number }[] = [];
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = info.channels > 3 ? data[i + 3] / 255 : 1;
      if (!isNearWhiteOrBlack({ r, g, b }, a)) {
        pixels.push({ r, g, b });
      }
    }

    if (pixels.length === 0) return null;

    // Prefer hue clustering so background greys/beiges do not dominate.
    let colors = extractHueClusters(pixels, 5);

    // Fallback to plain quantisation for very neutral / greyscale logos.
    if (colors.length < 3) {
      const fallback = quantizeColors(pixels, 5);
      colors = [...colors, ...fallback].slice(0, 5);
    }

    if (colors.length === 0) return null;

    return {
      primary: rgbToHex(colors[0].r, colors[0].g, colors[0].b),
      secondary: colors[1] ? rgbToHex(colors[1].r, colors[1].g, colors[1].b) : rgbToHex(colors[0].r, colors[0].g, colors[0].b),
      accent: colors[2] ? rgbToHex(colors[2].r, colors[2].g, colors[2].b) : colors[1] ? rgbToHex(colors[1].r, colors[1].g, colors[1].b) : rgbToHex(colors[0].r, colors[0].g, colors[0].b),
      source: "logo",
    };
  } catch (err: any) {
    console.warn(`[BrandPalette] Could not extract logo palette: ${err.message}`);
    return null;
  }
}

/**
 * Resolve the brand palette for a business.
 * 1. Extract from logo if available.
 * 2. Fall back to explicit brandColours.
 * 3. Fall back to a default professional palette.
 */
export async function resolveBrandPalette(business: any): Promise<BrandPalette> {
  // Explicit saved brand colours take precedence so users can correct or
  // override automatic logo extraction.
  const colors = (business?.brandColors as string[] | undefined) || [];
  const validColors = colors.map(sanitizeHex).filter(Boolean) as string[];
  if (validColors.length > 0) {
    console.log(`[BrandPalette] Resolved from saved brand colours | colors=${validColors.join(", ")}`);
    return {
      primary: validColors[0],
      secondary: validColors[1] || validColors[0],
      accent: validColors[2] || validColors[1] || validColors[0],
      source: "brandColors",
    };
  }

  if (business?.logo) {
    const fromLogo = await extractLogoPalette(business.logo);
    if (fromLogo) {
      console.log(`[BrandPalette] Resolved from logo | logo=${business.logo} | primary=${fromLogo.primary} | secondary=${fromLogo.secondary} | accent=${fromLogo.accent}`);
      return fromLogo;
    }
    console.warn(`[BrandPalette] Logo present but extraction failed; falling back | logo=${business.logo}`);
  }

  console.warn(`[BrandPalette] No saved colours or usable logo; using generic default palette`);
  return {
    primary: "#0F172A",
    secondary: "#334155",
    accent: "#64748B",
    source: "default",
  };
}

export function isLightColor(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  const yiq = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
  return yiq >= 160;
}

/**
 * Choose a text colour (white or dark slate) that contrasts well with a
 * background colour.
 */
export function contrastTextColor(hex: string): string {
  return isLightColor(hex) ? "#0F172A" : "#FFFFFF";
}

/**
 * Returns true if the resolved palette came from the real brand identity
 * (logo or explicit brand colours).
 */
export function isBrandDerived(palette: BrandPalette): boolean {
  return palette.source === "logo" || palette.source === "brandColors";
}
