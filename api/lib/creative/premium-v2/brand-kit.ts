/**
 * Premium Leaflet V2 – BrandKit resolution.
 *
 * Resolves the brand palette and logo for a business using, in order:
 *   1. Explicit saved brand colours.
 *   2. Colours extracted from the uploaded logo.
 *   3. Website evidence brand colours.
 *   4. Category-appropriate deterministic defaults.
 */

import { extractLogoPalette, normaliseHex } from "../brand-palette";
import type { BusinessEvidence } from "./curation";
import { inferBusinessCategory, asArray, asString } from "./curation";
import type { PremiumV2BrandKit, PremiumV2BrandPalette } from "./types";

const DEFAULT_PALETTES: Record<string, PremiumV2BrandPalette> = {
  print_courier: {
    primary: "#0047AB",
    secondary: "#DC2626",
    accent: "#F59E0B",
    background: "#FFFFFF",
    text: "#0F172A",
    textMuted: "#475569",
  },
  food_restaurant: {
    primary: "#B91C1C",
    secondary: "#F97316",
    accent: "#FACC15",
    background: "#FFFFFF",
    text: "#0F172A",
    textMuted: "#475569",
  },
  beauty_wellness: {
    primary: "#831843",
    secondary: "#DB2777",
    accent: "#F472B6",
    background: "#FFFFFF",
    text: "#0F172A",
    textMuted: "#475569",
  },
  local_services: {
    primary: "#0F766E",
    secondary: "#14B8A6",
    accent: "#F59E0B",
    background: "#FFFFFF",
    text: "#0F172A",
    textMuted: "#475569",
  },
  retail_product: {
    primary: "#4338CA",
    secondary: "#6366F1",
    accent: "#EC4899",
    background: "#FFFFFF",
    text: "#0F172A",
    textMuted: "#475569",
  },
  professional_services: {
    primary: "#1E3A8A",
    secondary: "#334155",
    accent: "#F59E0B",
    background: "#FFFFFF",
    text: "#0F172A",
    textMuted: "#475569",
  },
  training_education: {
    primary: "#065F46",
    secondary: "#10B981",
    accent: "#F59E0B",
    background: "#FFFFFF",
    text: "#0F172A",
    textMuted: "#475569",
  },
  logistics: {
    primary: "#1D4ED8",
    secondary: "#3B82F6",
    accent: "#F59E0B",
    background: "#FFFFFF",
    text: "#0F172A",
    textMuted: "#475569",
  },
  healthcare_wellness: {
    primary: "#0E7490",
    secondary: "#06B6D4",
    accent: "#10B981",
    background: "#FFFFFF",
    text: "#0F172A",
    textMuted: "#475569",
  },
  general: {
    primary: "#0F172A",
    secondary: "#334155",
    accent: "#3B82F6",
    background: "#FFFFFF",
    text: "#0F172A",
    textMuted: "#475569",
  },
};

function paletteFromHexes(colors: string[]): PremiumV2BrandPalette {
  const valid = colors.map((c) => normaliseHex(c)).filter((c): c is string => !!c);
  const primary = valid[0] || "#0F172A";
  // Use the second colour as the action accent; third as secondary/support.
  const accent = valid[1] || primary;
  const secondary = valid[2] || accent;
  return {
    primary,
    secondary,
    accent,
    background: "#FFFFFF",
    text: "#0F172A",
    textMuted: "#475569",
  };
}

function withBackgroundTint(palette: PremiumV2BrandPalette): PremiumV2BrandPalette {
  // If the primary is very dark or very light, keep a white background.
  // Otherwise derive a very subtle tint so the canvas does not look empty.
  return { ...palette };
}

const logoPaletteCache = new Map<string, Awaited<ReturnType<typeof extractLogoPalette>>>();
const LOGO_FETCH_TIMEOUT_MS = 5000;

async function fetchLogoPaletteWithTimeout(logoUrl: string): Promise<ReturnType<typeof extractLogoPalette>> {
  const cached = logoPaletteCache.get(logoUrl);
  if (cached) return cached;

  const timeout = new Promise<null>((_, reject) =>
    setTimeout(() => reject(new Error("Logo palette extraction timed out")), LOGO_FETCH_TIMEOUT_MS)
  );

  try {
    const result = (await Promise.race([extractLogoPalette(logoUrl), timeout])) as Awaited<ReturnType<typeof extractLogoPalette>>;
    logoPaletteCache.set(logoUrl, result);
    return result;
  } catch (err: any) {
    console.warn(`[BrandKit] Logo palette extraction failed or timed out for ${logoUrl}: ${err.message}`);
    logoPaletteCache.set(logoUrl, null);
    return null;
  }
}

export async function resolveBrandKit(business: BusinessEvidence): Promise<PremiumV2BrandKit> {
  const category = inferBusinessCategory(business);

  // 1. Explicit saved brand colours take precedence.
  const savedColors = asArray(business.brandColors);
  if (savedColors.length > 0) {
    return {
      palette: withBackgroundTint(paletteFromHexes(savedColors)),
      source: "brandColors",
      logoUrl: asString(business.logo),
    };
  }

  // 2. Extract from logo when available.
  const logoUrl = asString(business.logo);
  if (logoUrl) {
    const fromLogo = await fetchLogoPaletteWithTimeout(logoUrl);
    if (fromLogo) {
      return {
        palette: withBackgroundTint({
          primary: fromLogo.primary,
          secondary: fromLogo.secondary,
          accent: fromLogo.accent,
          background: "#FFFFFF",
          text: "#0F172A",
          textMuted: "#475569",
        }),
        source: "logo",
        logoUrl,
      };
    }
  }

  // 3. Website evidence brand colours.
  const websiteColors = asArray((business.websiteEvidence as any)?.brandColours);
  if (websiteColors.length > 0) {
    return {
      palette: withBackgroundTint(paletteFromHexes(websiteColors)),
      source: "websiteEvidence",
      logoUrl,
    };
  }

  // 4. Deterministic category default.
  return {
    palette: withBackgroundTint(DEFAULT_PALETTES[category] || DEFAULT_PALETTES.general),
    source: "default",
    logoUrl,
  };
}

export function resolveBrandKitSync(business: BusinessEvidence, fallbackKit?: PremiumV2BrandKit): PremiumV2BrandKit {
  if (fallbackKit) return fallbackKit;

  const savedColors = asArray(business.brandColors);
  const websiteColors = asArray((business.websiteEvidence as any)?.brandColours);
  const category = inferBusinessCategory(business);

  if (savedColors.length > 0) {
    return {
      palette: withBackgroundTint(paletteFromHexes(savedColors)),
      source: "brandColors",
      logoUrl: asString(business.logo),
    };
  }

  if (websiteColors.length > 0) {
    return {
      palette: withBackgroundTint(paletteFromHexes(websiteColors)),
      source: "websiteEvidence",
      logoUrl: asString(business.logo),
    };
  }

  return {
    palette: withBackgroundTint(DEFAULT_PALETTES[category] || DEFAULT_PALETTES.general),
    source: "default",
    logoUrl: asString(business.logo),
  };
}
