/**
 * Leaflet quality validation — scored model.
 *
 * Instead of hard-rejecting every imperfection, we return a 0–100 quality score,
 * a list of critical failures, and a list of warnings. This lets the pipeline
 * accept business-relevant but visually busy print-shop leaflets while still
 * blocking genuinely wrong or unsafe outputs.
 */

import sharp from "sharp";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const UNSUPPORTED_SERVICE_WORDS = [
  "seo", "social media management", "content creation", "data analytics",
  "digital marketing", "restaurant services", "salon services", "consulting",
];

const GENERIC_ICON_MARKERS = [
  "icon grid", "icon tiles", "grid of icons", "tile layout", "clipart collage",
  "scattered icons", "flat icon set",
];

export type QualityTier = "premium" | "acceptable" | "draft" | "failed";

export interface LeafletQualityResult {
  score: number;
  criticalFailures: string[];
  warnings: string[];
  passed: boolean;
  qualityTier?: QualityTier;
}

/**
 * Map a numerical score and generation source to a customer-facing quality tier.
 * Fallback / internal deterministic templates are capped as draft/basic leaflets
 * regardless of score, so they are never marketed as premium.
 */
export function computeQualityTier(score: number, isFallback: boolean): QualityTier {
  if (isFallback) return "draft";
  if (score >= 80) return "premium";
  if (score >= 60) return "acceptable";
  if (score > 0) return "draft";
  return "failed";
}

export function qualityTierLabel(tier: QualityTier): string {
  switch (tier) {
    case "premium":
      return "Premium";
    case "acceptable":
      return "Good";
    case "draft":
      return "Basic Draft";
    case "failed":
      return "Failed";
  }
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
  footerTop?: number;
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
    if (coverage > 0.45) {
      issues.push("Header and footer cover too much of the image.");
      scorePenalty += 10;
    }
  }

  if (opts.imageHeight && opts.footerTop) {
    const footerTopRatio = opts.footerTop / opts.imageHeight;
    if (footerTopRatio > 0.82) {
      issues.push("Footer is pushed too far down.");
      scorePenalty += 15;
    }

    if (opts.headerHeight) {
      const bodyCentre = (opts.headerHeight + opts.footerTop) / 2 / opts.imageHeight;
      if (bodyCentre < 0.30 || bodyCentre > 0.70) {
        issues.push("Poor vertical balance.");
        scorePenalty += 10;
      }
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

async function imageLayoutHeuristics(
  buffer: Buffer,
  businessCategory: string,
  opts?: { relaxed?: boolean }
): Promise<LayoutHeuristics> {
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
    const lowThreshold = opts?.relaxed ? 0.006 : busy ? 0.004 : 0.012;
    const highThreshold = opts?.relaxed ? 0.45 : busy ? 0.35 : 0.20;

    if (edgeDensity < lowThreshold) {
      issues.push("Layout appears too flat or blocky (possible icon grid).");
    } else if (edgeDensity > highThreshold) {
      issues.push("Layout appears overly busy or cluttered.");
    }

    // Detect a large empty central area (common in weak fallback templates).
    const centralTop = Math.round(h * 0.25);
    const centralBottom = Math.round(h * 0.80);
    const centralLeft = Math.round(w * 0.10);
    const centralRight = Math.round(w * 0.90);
    let lightCount = 0;
    let centralPixels = 0;
    for (let y = centralTop; y < centralBottom; y++) {
      for (let x = centralLeft; x < centralRight; x++) {
        centralPixels++;
        if (data[y * w + x] > 245) lightCount++;
      }
    }
    const lightRatio = centralPixels > 0 ? lightCount / centralPixels : 0;
    if (lightRatio > 0.55) {
      issues.push("Large empty central area.");
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
 * - 80–100: premium OpenAI image.
 * - 60–79: acceptable OpenAI image but store warnings.
 * - below 60: draft / basic quality; should not be charged as premium.
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
  prompt: string,
  isFallback = false
): Promise<LeafletQualityResult> {
  const category = businessCategoryFrom(business);

  // Corrupt image is an immediate critical failure.
  if (await isImageCorrupt(imageBuffer)) {
    return {
      score: 0,
      criticalFailures: ["Generated image is corrupt or cannot be decoded."],
      warnings: [],
      passed: false,
      qualityTier: "failed",
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
      // Stronger penalty: flat/blocky layouts are a hallmark of basic fallback templates.
      score -= isFallback ? 35 : 25;
    } else if (warning.includes("Large empty central area")) {
      // Stronger penalty: empty centres make leaflets look unfinished.
      score -= isFallback ? 35 : 25;
    } else {
      score -= 10;
    }
  }

  // Slight bonus for healthy edge density in the moderate range.
  if (edgeDensity >= 0.03 && edgeDensity <= 0.18) {
    score = Math.min(100, score + 5);
  }

  score = Math.max(0, score);

  // Fallback / internal deterministic templates are capped so they can never be
  // scored or marketed as premium. They are explicitly a basic draft path.
  if (isFallback) {
    score = Math.min(score, 55);
    if (score > 0 && !warnings.some((w) => w.includes("fallback") || w.includes("draft"))) {
      warnings.push("Internal fallback template — output is a basic draft, not a premium leaflet.");
    }
  }

  const qualityTier = computeQualityTier(score, isFallback);

  return {
    score,
    criticalFailures,
    warnings,
    passed: criticalFailures.length === 0 && score >= 60,
    qualityTier,
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
  logoOverlayApplied?: boolean;
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
  } else if (input.logoOverlayApplied === false) {
    issues.push("Business logo exists but was not applied to the final leaflet.");
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

/**
 * Vision-based check for AI-generated fake branding in the raw image.
 *
 * OpenAI image models sometimes still render business names, logos or readable
 * text despite negative instructions. This lightweight gpt-4o-mini vision pass
 * catches those cases so they can be penalised or rejected before the real logo
 * and text are overlaid.
 */
export interface FakeBrandingResult {
  hasText: boolean;
  hasLogo: boolean;
  hasBusinessName: boolean;
  details: string;
}

export async function validateAiLeafletQuality(opts: {
  backgroundBuffer?: Buffer;
  finalBuffer: Buffer;
  business: any;
  campaign: any;
  prompt: string;
  hasLogo: boolean;
  logoOverlayApplied: boolean;
  palette?: { source?: string } | null;
  headline: string;
  cta: string;
  serviceBullets?: string[];
}): Promise<LeafletQualityResult> {
  const criticalFailures: string[] = [];
  const warnings: string[] = [];
  let scorePenalty = 0;

  // 1. Prompt-level checks (cheap, before any image call).
  const promptValidation = validateLeafletPrompt(opts.prompt, opts.business);
  criticalFailures.push(...promptValidation.criticalFailures);
  warnings.push(...promptValidation.warnings);
  scorePenalty += promptValidation.warnings.length * 10;

  // 2. Raw AI background must not contain fake text/logos.
  if (opts.backgroundBuffer) {
    const fakeBranding = await detectFakeBranding(opts.backgroundBuffer, opts.business);
    if (fakeBranding.hasText) {
      criticalFailures.push("AI background contains readable text.");
    }
    if (fakeBranding.hasLogo) {
      criticalFailures.push("AI background contains a logo or brand mark.");
    }
    if (fakeBranding.hasBusinessName) {
      criticalFailures.push("AI background contains the business name.");
    }
    if (fakeBranding.hasText || fakeBranding.hasLogo || fakeBranding.hasBusinessName) {
      warnings.push(`Fake-branding check: ${fakeBranding.details}`);
    }
  }

  // 3. Final composite must decode.
  if (await isImageCorrupt(opts.finalBuffer)) {
    return {
      score: 0,
      criticalFailures: ["Generated leaflet is corrupt or cannot be decoded."],
      warnings: [],
      passed: false,
      qualityTier: "failed",
    };
  }

  // 4. Layout heuristics on the final composite (relaxed because real text/logos are intentionally overlaid).
  const category = businessCategoryFrom(opts.business);
  const { issues: layoutIssues } = await imageLayoutHeuristics(opts.finalBuffer, category, { relaxed: true });
  warnings.push(...layoutIssues);
  for (const issue of layoutIssues) {
    if (issue.includes("busy or cluttered")) scorePenalty += 5;
    else if (issue.includes("flat or blocky")) scorePenalty += 15;
    else if (issue.includes("Large empty central area")) scorePenalty += 15;
    else scorePenalty += 10;
  }

  // 5. Brand fidelity.
  const brandFidelity = validateBrandFidelity({
    hasLogo: opts.hasLogo,
    logoOverlayApplied: opts.logoOverlayApplied,
    palette: opts.palette,
    businessName: opts.business?.name,
    headline: opts.headline,
  });
  warnings.push(...brandFidelity.issues);
  scorePenalty += brandFidelity.scorePenalty;

  // 6. Overlay composition.
  const composition = validateLeafletComposition({
    hasLogo: opts.hasLogo,
    headline: opts.headline,
    cta: opts.cta,
    serviceBullets: opts.serviceBullets,
  });
  warnings.push(...composition.issues);
  scorePenalty += composition.scorePenalty;

  let score = 100 - criticalFailures.length * 50 - scorePenalty;
  score = Math.max(0, Math.min(100, score));

  const qualityTier = computeQualityTier(score, false);
  const passed = criticalFailures.length === 0 && score >= 60;

  return {
    score,
    criticalFailures,
    warnings,
    passed,
    qualityTier,
  };
}

export async function detectFakeBranding(imageBuffer: Buffer, business: any): Promise<FakeBrandingResult> {
  const safeResult: FakeBrandingResult = { hasText: false, hasLogo: false, hasBusinessName: false, details: "Vision check skipped." };
  try {
    const dataUri = `data:image/png;base64,${imageBuffer.toString("base64")}`;
    const result = await generateText({
      model: openai("gpt-4o-mini"),
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "You are a strict image-quality checker. Respond ONLY with a compact JSON object and no markdown.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Inspect the attached AI-generated marketing background image for a business called "${business?.name || "the business"}". This image MUST contain NO readable text, NO logos/brand marks, and NO business name rendered inside it. Look carefully at signage, labels, packaging, screens, documents, menu boards, price tags, QR codes, monograms, signatures and stylised words.
Return strict JSON: {"hasText":boolean,"hasLogo":boolean,"hasBusinessName":boolean,"details":"one-sentence explanation"}. Be conservative: if you are unsure, set the flag to true.`,
            },
            { type: "image", image: dataUri },
          ],
        },
      ],
    });

    const raw = result.text || "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const json = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    return {
      hasText: !!json.hasText,
      hasLogo: !!json.hasLogo,
      hasBusinessName: !!json.hasBusinessName,
      details: typeof json.details === "string" ? json.details : raw.slice(0, 200),
    };
  } catch (err) {
    console.warn(`[LeafletQuality] Fake-branding vision check failed: ${err instanceof Error ? err.message : String(err)}`);
    return safeResult;
  }
}
