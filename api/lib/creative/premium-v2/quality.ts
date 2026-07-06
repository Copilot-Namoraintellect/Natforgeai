/**
 * Premium Leaflet V2 – quality gate.
 *
 * Validates the V2 brief and rendered result against the universal premium
 * design rules. This is intentionally separate from the AI-background quality
 * checks so that deterministic internal layouts can also be graded.
 */

import type { PremiumLeafletV2Brief, PremiumV2QualityResult } from "./types";
import { isWeak, WEAK_PHRASES } from "./copy";

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  return "";
}

const GENERIC_PHRASES = [
  "your business",
  "your brand",
  "your company",
  "your service",
  "your product",
  "your needs",
  "we understand",
  "quality service",
  "professional team",
  "great results",
  "learn more",
  "contact us today",
  "best choice",
  "marketing campaign",
  "promotional material",
];

// Minimum font sizes that must be honoured by the renderer.
const MIN_FONT_SIZES = {
  headline: 44,
  subheadline: 22,
  cta: 26,
  service: 20,
  footer: 18,
  strip: 16,
};

interface LayoutMetrics {
  width: number;
  height: number;
  ctaBoundingBox: { x: number; y: number; w: number; h: number };
  footerY: number;
  footerHeight: number;
  minFontSizeUsed: number;
  primaryCardCount: number;
  secondaryCardCount: number;
  layoutDensity: PremiumLeafletV2Brief["layoutDensity"];
  didCrowd?: boolean;
  usedContentHeight?: number;
  availableContentHeight?: number;
  logoComposited?: boolean;
  primaryWithDescriptionCount?: number;
}

const PLACEHOLDER_CONTACT_PATTERNS = [
  /example\.com/i,
  /\.test$/i,
  /011 123 9999/,
  /info@example/i,
  /placeholder/i,
];

export function validatePremiumV2Quality(
  brief: PremiumLeafletV2Brief,
  layoutMetrics?: Partial<LayoutMetrics>,
  options: { production?: boolean } = {}
): PremiumV2QualityResult {
  const criticalFailures: string[] = [];
  const warnings: string[] = [];
  let score = 100;

  // ── Service crowding rules ──
  const maxPrimary: Record<PremiumLeafletV2Brief["layoutDensity"], number> = {
    premium_minimal: 3,
    premium_services: 4,
    offer_focused: 4,
    corporate_professional: 4,
    local_promo: 4,
    catalogue_brochure: Infinity,
  };
  const limit = maxPrimary[brief.layoutDensity] ?? 4;
  if (brief.layoutDensity !== "catalogue_brochure" && brief.primaryServices.length > limit) {
    criticalFailures.push(`Too many primary services (${brief.primaryServices.length}) for ${brief.layoutDensity} layout`);
    score -= 25;
  }
  if (brief.layoutDensity !== "catalogue_brochure" && brief.primaryServices.length + brief.secondaryServices.length > 12) {
    warnings.push("Large total service count may look crowded");
    score -= 10;
  }

  // ── Duplicate services ──
  const serviceNames = [...brief.primaryServices, ...brief.secondaryServices].map((s) => s.name.toLowerCase());
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const name of serviceNames) {
    if (seen.has(name)) {
      duplicates.push(name);
    } else {
      seen.add(name);
    }
  }
  if (duplicates.length > 0) {
    criticalFailures.push(`Duplicate services detected: ${Array.from(new Set(duplicates)).join(", ")}`);
    score -= 15;
  }

  // ── Copy quality ──
  const allCopy = [
    brief.headline,
    brief.subheadline,
    brief.cta,
    ...brief.benefits,
    ...brief.primaryServices.map((s) => `${s.name} ${s.description || ""}`),
    ...brief.secondaryServices.map((s) => s.name),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const genericMatches = GENERIC_PHRASES.filter((p) => allCopy.includes(p));
  if (genericMatches.length) {
    warnings.push(`Generic phrases detected: ${genericMatches.join(", ")}`);
    score -= 10;
  }

  const weakMatches = WEAK_PHRASES.filter((p) => allCopy.includes(p));
  if (weakMatches.length) {
    warnings.push(`Weak copy detected: ${weakMatches.join(", ")}`);
    score -= 10;
  }

  if (!brief.headline || brief.headline.length < 12 || isWeak(brief.headline)) {
    criticalFailures.push("Headline is missing, too short, or weak");
    score -= 20;
  }

  if (brief.subheadline && isWeak(brief.subheadline)) {
    warnings.push("Subheadline uses weak phrasing");
    score -= 8;
  }

  if (!brief.cta || brief.cta.length < 3) {
    criticalFailures.push("CTA missing or too short");
    score -= 20;
  }

  if (!brief.primaryServices.length && !brief.offer) {
    criticalFailures.push("No primary services or offer to display");
    score -= 20;
  }

  // ── Pain-point guard ──
  const customerPainPoint = asString(brief.customerPainPoint);
  if (customerPainPoint && brief.subheadline && customerPainPoint.toLowerCase().trim() === brief.subheadline.toLowerCase().trim()) {
    criticalFailures.push("Subheadline uses raw customer pain point as customer-facing copy");
    score -= 30;
  }

  // ── Service card value ──
  const describedCards = brief.primaryServices.filter((s) => !!s.description).length;
  if (brief.primaryServices.length > 0 && describedCards < brief.primaryServices.length) {
    warnings.push("Some primary service cards lack a benefit description");
    score -= 8;
  }

  // ── Brand/contact ──
  if (!brief.logoUrl) {
    warnings.push("No logo provided");
    score -= 5;
  }

  const contact = brief.contact || {};
  const contactValues = [contact.phone, contact.whatsapp, contact.email, contact.website].filter(Boolean).join(" ");
  if (!contact.phone && !contact.whatsapp && !contact.email && !contact.website) {
    warnings.push("No contact details available");
    score -= 5;
  } else if (options.production && PLACEHOLDER_CONTACT_PATTERNS.some((p) => p.test(contactValues))) {
    criticalFailures.push("Placeholder contact details detected in production mode");
    score -= 20;
  }

  // ── Layout metrics (when supplied by the renderer) ──
  if (layoutMetrics) {
    const { ctaBoundingBox, footerY, footerHeight, width = 1080, height = 1350, minFontSizeUsed } = layoutMetrics;

    if (ctaBoundingBox) {
      const ctaClipped =
        ctaBoundingBox.x < 0 ||
        ctaBoundingBox.y < 0 ||
        ctaBoundingBox.x + ctaBoundingBox.w > width ||
        ctaBoundingBox.y + ctaBoundingBox.h > height;
      if (ctaClipped) {
        criticalFailures.push("CTA is clipped by the canvas");
        score -= 30;
      }
    }

    if (typeof footerY === "number" && typeof footerHeight === "number") {
      const footerClipped = footerY + footerHeight > height;
      if (footerClipped) {
        criticalFailures.push("Footer is clipped by the canvas");
        score -= 30;
      }
    }

    if (typeof minFontSizeUsed === "number" && minFontSizeUsed < MIN_FONT_SIZES.service) {
      warnings.push("Text size may be too small to read");
      score -= 15;
    }

    // Generic layout / too much empty space.
    const used = layoutMetrics.usedContentHeight || 0;
    const available = layoutMetrics.availableContentHeight || 1;
    if (used > 0 && available / used > 1.45 && brief.layoutDensity !== "catalogue_brochure") {
      warnings.push("Layout has excessive empty space");
      score -= 8;
    }

    // Missing logo when one was expected. We downgrade rather than fail so
    // that temporary logo fetch issues do not block an otherwise valid render.
    if (brief.logoUrl && layoutMetrics.logoComposited === false) {
      warnings.push("Logo was provided but could not be composited");
      score -= 15;
    }
  }

  // ── Determine label ──
  let label: PremiumV2QualityResult["label"] = "Premium Ready";

  if (layoutMetrics?.ctaBoundingBox) {
    const { ctaBoundingBox, width = 1080, height = 1350 } = layoutMetrics;
    const ctaClipped =
      ctaBoundingBox.x < 0 ||
      ctaBoundingBox.y < 0 ||
      ctaBoundingBox.x + ctaBoundingBox.w > width ||
      ctaBoundingBox.y + ctaBoundingBox.h > height;
    if (ctaClipped) label = "CTA Clipped";
  }

  if (label === "Premium Ready" && layoutMetrics?.minFontSizeUsed && layoutMetrics.minFontSizeUsed < MIN_FONT_SIZES.service) {
    label = "Text Too Small";
  }

  if (label === "Premium Ready" && duplicates.length > 0) {
    label = "Duplicate Services";
  }

  if (label === "Premium Ready" && weakMatches.length > 0) {
    label = "Weak Copy";
  }

  if (label === "Premium Ready" && criticalFailures.length > 0) {
    label = "Failed Premium Standard";
  }

  if (label === "Premium Ready" && genericMatches.length) {
    label = "Generic Copy";
  }

  if (label === "Premium Ready" && brief.primaryServices.length > 4 && brief.layoutDensity !== "catalogue_brochure") {
    label = "Too Crowded";
  }

  if (label === "Premium Ready" && (!brief.logoUrl || layoutMetrics?.logoComposited === false)) {
    label = "Missing Logo";
  }

  if (label === "Premium Ready" && customerPainPoint && brief.subheadline && customerPainPoint.toLowerCase().trim() === brief.subheadline.toLowerCase().trim()) {
    label = "Raw Pain Point Used As Copy";
  }

  if (label === "Premium Ready" && score < 70) {
    label = "Failed Premium Standard";
  } else if (label === "Premium Ready" && score < 85) {
    label = "Needs Design Review";
  }

  return {
    passed: criticalFailures.length === 0 && score >= 70,
    score: Math.max(0, score),
    label,
    criticalFailures,
    warnings,
  };
}

/**
 * Layout-level assertions used after a V2 image is rendered.
 * In the SVG renderer these are structural guarantees, but we keep the checks
 * so callers can fail fast if a future renderer regresses them.
 */
export function assertV2LayoutGuarantees(
  width: number,
  height: number,
  ctaBoundingBox: { x: number; y: number; w: number; h: number },
  footerY: number,
  footerHeight = 104
): { ctaClipped: boolean; footerClipped: boolean } {
  const ctaClipped =
    ctaBoundingBox.x < 0 ||
    ctaBoundingBox.y < 0 ||
    ctaBoundingBox.x + ctaBoundingBox.w > width ||
    ctaBoundingBox.y + ctaBoundingBox.h > height;

  const footerClipped = footerY + footerHeight > height;
  return { ctaClipped, footerClipped };
}

export { MIN_FONT_SIZES };
