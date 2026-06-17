/**
 * Leaflet quality validation.
 *
 * Rejects generic icon-grid designs, irrelevant services, low-premium layouts,
 * and outputs that do not include the actual business category.
 */

import sharp from "sharp";

const UNSUPPORTED_SERVICE_WORDS = [
  "seo", "social media management", "content creation", "data analytics",
  "digital marketing", "restaurant services", "salon services", "consulting",
];

const GENERIC_ICON_MARKERS = [
  "icon grid", "icon tiles", "grid of icons", "tile layout", "clipart collage",
  "scattered icons", "flat icon set",
];

export interface LeafletQualityResult {
  passed: boolean;
  issues: string[];
}

function businessCategoryFrom(business: any): string {
  const evidence = (business?.websiteEvidence || {}) as {
    businessCategory?: string;
    productsServices?: string[];
  };
  return (
    evidence.businessCategory ||
    business?.industry ||
    business?.productOrService ||
    ""
  ).toLowerCase();
}

function isMarketingCategory(category: string): boolean {
  return (
    category.includes("marketing") ||
    category.includes("digital agency") ||
    category.includes("seo") ||
    category.includes("social media")
  );
}

function hasGenericIconLanguage(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return GENERIC_ICON_MARKERS.some((m) => lower.includes(m));
}

function hasUnsupportedServices(prompt: string, businessCategory: string): string[] {
  const lower = prompt.toLowerCase();
  if (isMarketingCategory(businessCategory)) return [];
  return UNSUPPORTED_SERVICE_WORDS.filter((word) => lower.includes(word));
}

function hasBusinessCategoryVisuals(prompt: string, businessCategory: string): boolean {
  const lower = prompt.toLowerCase();
  if (businessCategory.includes("art") || businessCategory.includes("décor") || businessCategory.includes("decor")) {
    return /\b(canvas|wall art|framed poster|art print|interior|gallery|home decor|office decor)\b/.test(lower);
  }
  if (businessCategory.includes("print") || businessCategory.includes("copy")) {
    return /\b(print|business card|flyer|poster|banner|courier|stationery)\b/.test(lower);
  }
  if (businessCategory.includes("food") || businessCategory.includes("restaurant")) {
    return /\b(food|restaurant|menu|dish|cafe|meal)\b/.test(lower);
  }
  if (businessCategory.includes("beauty") || businessCategory.includes("salon")) {
    return /\b(hair|nails|beauty|spa|salon|makeup|skincare)\b/.test(lower);
  }
  return true;
}

async function imageLayoutHeuristics(buffer: Buffer): Promise<string[]> {
  const issues: string[] = [];
  try {
    const { width = 1024, height = 1536, channels = 3 } = await sharp(buffer).metadata();
    if (!width || !height || !channels) return issues;

    // Edge-density heuristic: low edge density in the central area suggests a flat/icon-grid layout.
    const thumb = await sharp(buffer)
      .resize(200, Math.round(200 * (height / width)), { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const data = thumb.data;
    const w = thumb.info.width;
    const h = thumb.info.height;

    // Count strong horizontal/vertical edges using simple gradient magnitude
    let edgeCount = 0;
    const threshold = 18;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        const dx = Math.abs(data[idx] - data[idx + 1]);
        const dy = Math.abs(data[idx] - data[(y + 1) * w + x]);
        if (dx > threshold || dy > threshold) edgeCount++;
      }
    }

    const totalPixels = w * h;
    const edgeDensity = edgeCount / totalPixels;

    // Very low edge density often means flat colour blocks / icon grids.
    if (edgeDensity < 0.015) {
      issues.push("Layout appears too flat or blocky (possible icon grid).");
    }

    // Very high edge density may mean noisy/overcrowded low-premium layout.
    if (edgeDensity > 0.18) {
      issues.push("Layout appears overly busy or cluttered.");
    }
  } catch (err: any) {
    console.warn(`[LeafletQuality] image heuristic failed: ${err.message}`);
  }
  return issues;
}

export async function validateLeafletQuality(
  imageBuffer: Buffer,
  business: any,
  _campaign: any,
  prompt: string
): Promise<LeafletQualityResult> {
  const issues: string[] = [];
  const category = businessCategoryFrom(business);

  // 1. Prompt must not contain unsupported services for non-marketing businesses.
  const unsupportedServices = hasUnsupportedServices(prompt, category);
  if (unsupportedServices.length > 0) {
    issues.push(`Prompt references unsupported services: ${unsupportedServices.join(", ")}.`);
  }

  // 2. Prompt must not explicitly describe generic icon grids.
  if (hasGenericIconLanguage(prompt)) {
    issues.push("Prompt describes a generic icon-grid layout.");
  }

  // 3. Prompt must include visuals relevant to the business category.
  if (category && !hasBusinessCategoryVisuals(prompt, category)) {
    issues.push("Prompt does not include visuals relevant to the detected business category.");
  }

  // 4. Image layout heuristics.
  const layoutIssues = await imageLayoutHeuristics(imageBuffer);
  issues.push(...layoutIssues);

  return {
    passed: issues.length === 0,
    issues,
  };
}
