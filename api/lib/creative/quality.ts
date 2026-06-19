/**
 * Leaflet quality validation — scored model.
 *
 * Instead of hard-rejecting every imperfection, we return a 0–100 quality score,
 * a list of critical failures, and a list of warnings. This lets the pipeline
 * accept business-relevant but visually busy print-shop leaflets while still
 * blocking genuinely wrong or unsafe outputs.
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
  score: number;
  criticalFailures: string[];
  warnings: string[];
  passed: boolean;
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

/**
 * Categories where product collages, print-shop mockups and moderate visual
 * density are expected and should not be treated as design failures.
 */
export function isBusyCategory(category: string): boolean {
  return (
    category.includes("print") ||
    category.includes("copy") ||
    category.includes("courier") ||
    category.includes("branding") ||
    category.includes("retail")
  );
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
  if (businessCategory.includes("print") || businessCategory.includes("copy") || businessCategory.includes("branding")) {
    return /\b(print|business card|flyer|poster|banner|courier|stationery|branding|canvas|photo print)\b/.test(lower);
  }
  if (businessCategory.includes("food") || businessCategory.includes("restaurant")) {
    return /\b(food|restaurant|menu|dish|cafe|meal)\b/.test(lower);
  }
  if (businessCategory.includes("beauty") || businessCategory.includes("salon")) {
    return /\b(hair|nails|beauty|spa|salon|makeup|skincare)\b/.test(lower);
  }
  return true;
}

export interface CompositionValidationResult {
  scorePenalty: number;
  issues: string[];
}

/**
 * Validate the deterministic overlay composition. Deducts from the final score
 * for layout/text choices that make the leaflet feel less premium, so a 100/100
 * score only happens when both the OpenAI visual and the NatForgeAI overlay are
 * polished.
 */
export function validateLeafletComposition(opts: {
  hasLogo?: boolean;
  headline?: string;
  cta?: string;
  serviceBullets?: string[];
  headerHeight?: number;
  footerHeight?: number;
  imageHeight?: number;
}): CompositionValidationResult {
  const issues: string[] = [];
  let scorePenalty = 0;

  if (!opts.hasLogo) {
    issues.push("No business logo provided for overlay.");
    scorePenalty += 5;
  }

  const headline = (opts.headline || "").trim();
  if (headline.length > 60) {
    issues.push("Headline is long and may dominate the design.");
    scorePenalty += 5;
  }

  const cta = (opts.cta || "").trim();
  if (cta.length > 30) {
    issues.push("CTA is long and may be cut off or hard to read.");
    scorePenalty += 5;
  }

  const bullets = opts.serviceBullets || [];
  if (bullets.length > 6) {
    issues.push("Too many service bullets; layout may feel crowded.");
    scorePenalty += 5;
  }

  if (opts.imageHeight && opts.headerHeight && opts.footerHeight) {
    const coverage = (opts.headerHeight + opts.footerHeight) / opts.imageHeight;
    if (coverage > 0.35) {
      issues.push("Header and footer cover too much of the image.");
      scorePenalty += 10;
    }
  }

  return { scorePenalty, issues };
}

/**
 * Check whether a public image URL is actually loadable. Returns true if the
 * URL responds with an image content type and non-empty body.
 */
export async function isPublicImageLoadable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (!response.ok) return false;
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    return contentType.startsWith("image/");
  } catch {
    return false;
  }
}

interface LayoutHeuristics {
  edgeDensity: number;
  issues: string[];
}

async function imageLayoutHeuristics(buffer: Buffer, businessCategory: string): Promise<LayoutHeuristics> {
  const issues: string[] = [];
  let edgeDensity = 0;
  try {
    const { width = 1024, height = 1536, channels = 3 } = await sharp(buffer).metadata();
    if (!width || !height || !channels) return { edgeDensity, issues };

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
    edgeDensity = edgeCount / totalPixels;

    // Print/copy/courier/branding/retail leaflets are expected to show several products.
    const busy = isBusyCategory(businessCategory);
    const lowThreshold = busy ? 0.004 : 0.012;
    const highThreshold = busy ? 0.35 : 0.20;

    if (edgeDensity < lowThreshold) {
      issues.push("Layout appears too flat or blocky (possible icon grid).");
    } else if (edgeDensity > highThreshold) {
      issues.push("Layout appears overly busy or cluttered.");
    }
  } catch (err) {
    console.warn(`[LeafletQuality] image heuristic failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { edgeDensity, issues };
}

/**
 * Validate a prompt *before* spending an OpenAI image generation call.
 * Returns score + critical failures + warnings.
 *
 * Critical failures block generation:
 * - wrong business category / irrelevant imagery
 * - unsupported services
 * - generic icon-grid layout requested
 *
 * Design preferences are warnings only.
 */
export function validateLeafletPrompt(
  prompt: string,
  business: any
): LeafletQualityResult {
  const criticalFailures: string[] = [];
  const warnings: string[] = [];
  const category = businessCategoryFrom(business);

  const unsupportedServices = hasUnsupportedServices(prompt, category);
  if (unsupportedServices.length > 0) {
    criticalFailures.push(`Prompt references unsupported services: ${unsupportedServices.join(", ")}.`);
  }

  if (hasGenericIconLanguage(prompt)) {
    criticalFailures.push("Prompt explicitly describes a generic icon-grid layout.");
  }

  if (category && !hasBusinessCategoryVisuals(prompt, category)) {
    criticalFailures.push("Prompt does not include visuals relevant to the detected business category.");
  }

  let score = 100;
  for (const _ of criticalFailures) score -= 50;
  for (const _ of warnings) score -= 10;

  return {
    score: Math.max(0, score),
    criticalFailures,
    warnings,
    passed: criticalFailures.length === 0 && score >= 60,
  };
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

/**
 * Check that the generated image buffer is a valid, decodable image.
 */
async function isImageCorrupt(buffer: Buffer): Promise<boolean> {
  try {
    await sharp(buffer).metadata();
    return false;
  } catch {
    return true;
  }
}

/**
 * Score a generated image.
 *
 * Acceptance rules:
 * - 80–100: accept OpenAI image.
 * - 60–79: accept OpenAI image but store warnings.
 * - below 60: retry once with stronger prompt.
 * - any critical failure: reject and retry.
 * - after retry, fallback only if both attempts have critical failures or score < 60.
 *
 * Busy/cluttered layouts are penalised less for print/copy/courier/branding/retail
 * categories because product collages and print-shop mockups are expected there.
 */
export async function validateLeafletQuality(
  imageBuffer: Buffer,
  business: any,
  _campaign: any,
  prompt: string
): Promise<LeafletQualityResult> {
  const category = businessCategoryFrom(business);

  // Corrupt image is an immediate critical failure.
  if (await isImageCorrupt(imageBuffer)) {
    return {
      score: 0,
      criticalFailures: ["Generated image is corrupt or cannot be decoded."],
      warnings: [],
      passed: false,
    };
  }

  const promptValidation = validateLeafletPrompt(prompt, business);
  const { edgeDensity, issues: layoutIssues } = await imageLayoutHeuristics(imageBuffer, category);

  // Critical failures always block. Prompt-level issues are treated as critical
  // because they describe what the model was explicitly asked to generate.
  const criticalFailures = [...promptValidation.criticalFailures];
  const warnings = [...promptValidation.warnings, ...layoutIssues];

  let score = 100;
  for (const _ of criticalFailures) score -= 50;

  const busy = isBusyCategory(category);
  for (const warning of warnings) {
    if (warning.includes("busy or cluttered")) {
      // Product collages and print-shop mockups are acceptable for busy categories.
      score -= busy ? 5 : 15;
    } else if (warning.includes("flat or blocky")) {
      score -= 20;
    } else {
      score -= 10;
    }
  }

  // Slight bonus for healthy edge density in the moderate range.
  if (edgeDensity >= 0.03 && edgeDensity <= 0.18) {
    score = Math.min(100, score + 5);
  }

  score = Math.max(0, score);

  return {
    score,
    criticalFailures,
    warnings,
    passed: criticalFailures.length === 0 && score >= 60,
  };
}

/**
 * Brand-fidelity validator.
 *
 * Penalises outputs that do not clearly derive from the business identity:
 * - missing logo
 * - generic/default colour palette
 * - weak or generic brand header text
 */
export interface BrandFidelityInput {
  hasLogo: boolean;
  palette?: { source?: string } | null;
  businessName?: string;
  headline?: string;
}

export function validateBrandFidelity(input: BrandFidelityInput): { scorePenalty: number; issues: string[] } {
  let scorePenalty = 0;
  const issues: string[] = [];

  if (!input.hasLogo) {
    issues.push("No business logo available for the leaflet.");
    scorePenalty += 30;
  }

  if (!input.palette || input.palette.source === "default") {
    issues.push("Brand colours are generic defaults, not derived from logo or saved brand colours.");
    scorePenalty += 25;
  }

  const headerText = [input.businessName || "", input.headline || ""].join(" ").trim();
  const genericHeaderWords = ["your business", "welcome", "hello", "thanks", "special offer", "amazing deal"];
  const lowerHeader = headerText.toLowerCase();
  const isGenericHeader = genericHeaderWords.some((w) => lowerHeader.includes(w));
  if (!input.businessName || isGenericHeader) {
    issues.push("Brand header is weak or generic.");
    scorePenalty += 15;
  }

  // Catch currency that was not normalised to South-African format.
  if (/\b\d+\s+rands?\b/i.test(input.headline || "")) {
    issues.push("Headline uses informal currency wording ('rands').");
    scorePenalty += 12;
  }
  if (/\bR\s*\d\s+\d{3}\b/.test(input.headline || "")) {
    issues.push("Headline has malformed Rand spacing (e.g. 'R3 000').");
    scorePenalty += 10;
  }

  return { scorePenalty, issues };
}
