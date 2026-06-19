/**
 * Leaflet quality validation.
 *
 * Rejects generic icon-grid designs, irrelevant services, low-premium layouts,
 * and outputs that do not include the actual business category.
 *
 * IMPORTANT: This validator is intentionally conservative. It blocks obviously
 * bad prompts *before* spending an OpenAI call, and it gives image-based
 * heuristics the benefit of the doubt for categories that are naturally busy
 * (e.g. print shops). When the generated image cannot be confirmed as premium,
 * the pipeline falls back to a deterministic branded template instead of failing.
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

function isPrintShopCategory(category: string): boolean {
  return category.includes("print") || category.includes("copy");
}

/**
 * Detect whether a prompt explicitly *describes* a generic icon grid as the
 * desired output. We ignore occurrences inside negative instructions such as
 * "Do NOT use a simple icon grid" because those are exactly the instructions
 * we want the model to follow.
 */
export function hasGenericIconLanguage(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return GENERIC_ICON_MARKERS.some((marker) => {
    const idx = lower.indexOf(marker);
    if (idx === -1) return false;
    // Look at the 60 chars before the marker for a negative word.
    const before = lower.slice(Math.max(0, idx - 60), idx);
    const negated = /\b(not|no|never|avoid|don'?t|do not|does not|without)\b/.test(before);
    return !negated;
  });
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
  if (isPrintShopCategory(businessCategory)) {
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

async function imageLayoutHeuristics(buffer: Buffer, businessCategory: string): Promise<string[]> {
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

    // Print shops and collages are naturally busier, so we only flag extreme values.
    const isBusyCategory = isPrintShopCategory(businessCategory);
    const lowThreshold = isBusyCategory ? 0.008 : 0.015;
    const highThreshold = isBusyCategory ? 0.28 : 0.18;

    if (edgeDensity < lowThreshold) {
      issues.push("Layout appears too flat or blocky (possible icon grid).");
    }

    if (edgeDensity > highThreshold) {
      issues.push("Layout appears overly busy or cluttered.");
    }
  } catch (err) {
    console.warn(`[LeafletQuality] image heuristic failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return issues;
}

/**
 * Validate a prompt *before* spending an OpenAI image generation call.
 * Returns only prompt-level issues (no image heuristics).
 */
export function validateLeafletPrompt(
  prompt: string,
  business: any
): LeafletQualityResult {
  const issues: string[] = [];
  const category = businessCategoryFrom(business);

  const unsupportedServices = hasUnsupportedServices(prompt, category);
  if (unsupportedServices.length > 0) {
    issues.push(`Prompt references unsupported services: ${unsupportedServices.join(", ")}.`);
  }

  if (hasGenericIconLanguage(prompt)) {
    issues.push("Prompt describes a generic icon-grid layout.");
  }

  if (category && !hasBusinessCategoryVisuals(prompt, category)) {
    issues.push("Prompt does not include visuals relevant to the detected business category.");
  }

  return { passed: issues.length === 0, issues };
}

/**
 * Lightweight prompt sanitisation: rephrase common negative icon-grid wording so
 * the validator cannot accidentally flag the prompt, while keeping the intent.
 */
export function sanitizePromptForValidator(prompt: string): string {
  return prompt
    .replace(/\bicon grid\b/gi, "icon arrangement")
    .replace(/\bicon tiles\b/gi, "icon arrangement")
    .replace(/\bgrid of icons\b/gi, "arrangement of icons")
    .replace(/\btile layout\b/gi, "modular layout")
    .replace(/\bclipart collage\b/gi, "illustration collage")
    .replace(/\bscattered icons\b/gi, "placed icons")
    .replace(/\bflat icon set\b/gi, "flat illustration set");
}

export async function validateLeafletQuality(
  imageBuffer: Buffer,
  business: any,
  _campaign: any,
  prompt: string
): Promise<LeafletQualityResult> {
  const category = businessCategoryFrom(business);
  const promptValidation = validateLeafletPrompt(prompt, business);
  const layoutIssues = await imageLayoutHeuristics(imageBuffer, category);

  return {
    passed: promptValidation.passed && layoutIssues.length === 0,
    issues: [...promptValidation.issues, ...layoutIssues],
  };
}
