/**
 * Marketing text formatting helpers for leaflets.
 *
 * Normalises offer wording, currency formatting and CTAs so the final overlay
 * always reads professionally and uses South African conventions.
 */

function sanitize(str?: string | null): string {
  if (!str) return "";
  return str.replace(/\n+/g, " ").trim();
}

/**
 * Format South African Rand currency in common informal patterns.
 * Converts "3000 rands", "3000 rand", "R3000", "R 3000" → "R3,000".
 */
function formatRandCurrency(text: string): string {
  return text
    // Normalise spaced Rand notation first: "R 3 000", "R3 000", "R 3000" → "R3000"
    .replace(/\bR\s*([\d\s]+)\b/gi, (_, digits) => `R${digits.replace(/\s+/g, "")}`)
    // "3000 rands" / "3000 rand" → "R3,000"
    .replace(/\b(\d{1,3}(?:,\d{3})+|\d+)\s*rands?\b/gi, (_, amount) => {
      const num = Number(amount.toString().replace(/,/g, ""));
      return `R${num.toLocaleString("en-ZA")}`;
    })
    // "R3000" / "R 3000" → "R3,000"
    .replace(/\bR\s*(\d{1,3}(?:,\d{3})+|\d+)\b/g, (_, amount) => {
      const num = Number(amount.toString().replace(/,/g, ""));
      return `R${num.toLocaleString("en-ZA")}`;
    });
}

/**
 * Normalise an offer string into clean, customer-facing wording.
 * - Fixes currency formatting.
 * - Removes redundant business name prefix.
 * - Tries to produce phrasing like "Enjoy 10% off orders above R3,000".
 */
export function formatOffer(offer: string, businessName?: string): string {
  let clean = sanitize(offer);
  if (!clean || clean.toLowerCase() === "none") return "";

  // Normalise non-breaking spaces and collapse whitespace.
  clean = clean.replace(/\u00A0/g, " ").replace(/\s+/g, " ");

  // Strip leading business name dash if present.
  if (businessName) {
    const escapedName = businessName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    clean = clean.replace(new RegExp(`^${escapedName}\\s*[-—]\\s*`, "i"), "");
  }

  // Fix common OCR-style typos (zero instead of letter O in "off").
  clean = clean.replace(/\b(\d+)%\s*0ff\b/gi, "$1% off");

  // Currency formatting.
  clean = formatRandCurrency(clean);

  // Normalise percentage wording.
  clean = clean.replace(/\b(\d+)%\s*off?\b/gi, "$1% off");

  // "any orders R3,000 and above" → "orders above R3,000"
  clean = clean.replace(/\bany\s+orders?\s+(R[\d,]+)\s+and\s+above\b/gi, "orders above $1");
  clean = clean.replace(/\borders?\s+(R[\d,]+)\s+and\s+above\b/gi, "orders above $1");

  // "orders of R3,000 or more" → keep
  clean = clean.replace(/\borders?\s+of\s+(R[\d,]+)\s+or\s+more\b/gi, "orders of $1 or more");

  // "orders above R3,000" → keep
  clean = clean.replace(/\borders?\s+above\s+(R[\d,]+)\b/gi, "orders above $1");

  // Trim and collapse whitespace.
  clean = clean.replace(/\s+/g, " ").trim();

  // Capitalise first letter.
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/**
 * Build a clean headline from an offer.
 * Prefers concise, action-oriented phrasing.
 */
export function offerToHeadline(offer: string): string {
  const clean = formatOffer(offer);
  if (!clean) return "";

  // If it contains a percentage discount, prefix with "Enjoy".
  if (/\d+%\s+off/i.test(clean)) {
    const body = clean.charAt(0).toLowerCase() + clean.slice(1);
    return `Enjoy ${body}`;
  }

  // If it already starts with an action verb, use it directly.
  if (/^(enjoy|get|save|claim|unlock|receive)\s+/i.test(clean)) {
    return clean;
  }

  return clean;
}

const STRONG_CTAS = [
  "Request a Quote Today",
  "Order Now",
  "Contact Us for Printing & Branding",
  "Get a Free Quote",
  "Shop Now",
];

const WEAK_CTA_PATTERNS = [
  /learn more/i,
  /click here/i,
  /read more/i,
  /find out more/i,
  /discover/i,
  /explore/i,
  /\.\.\.$/, // trailing ellipsis
];

/**
 * Normalise a CTA. If the provided CTA is vague, too long, or ends with an
 * ellipsis, replace it with a strong default.
 */
export function normalizeCta(cta?: string | null, businessCategory?: string): string {
  const clean = sanitize(cta);
  if (!clean) return "Request a Quote Today";

  const isWeak = WEAK_CTA_PATTERNS.some((p) => p.test(clean));
  const tooLong = clean.length > 35;

  if (!isWeak && !tooLong) return clean;

  if (businessCategory?.match(/print|copy|branding|courier/i)) {
    return "Request a Quote Today";
  }

  return STRONG_CTAS[0];
}

/**
 * Validate that marketing text meets premium leaflet standards.
 * Returns issues that should reduce the quality score.
 */
export function validateMarketingText(opts: {
  headline?: string;
  offer?: string;
  cta?: string;
  businessName?: string;
}): { scorePenalty: number; issues: string[] } {
  const issues: string[] = [];
  let scorePenalty = 0;

  const offerText = sanitize(opts.offer);
  const headlineText = sanitize(opts.headline);
  const ctaText = sanitize(opts.cta);

  // Currency formatting.
  if (offerText && /\b\d+\s*rands?\b/i.test(offerText)) {
    issues.push("Offer uses informal currency wording ('rands' instead of 'R').");
    scorePenalty += 15;
  }

  // CTA quality.
  if (ctaText) {
    if (WEAK_CTA_PATTERNS.some((p) => p.test(ctaText))) {
      issues.push("CTA is vague or ends with ellipsis.");
      scorePenalty += 15;
    }
    if (ctaText.length > 35) {
      issues.push("CTA is too long and may be cut off.");
      scorePenalty += 15;
    }
  }

  // Headline quality.
  if (headlineText) {
    if (opts.businessName && headlineText.toLowerCase().startsWith(opts.businessName.toLowerCase())) {
      issues.push("Headline repeats the business name unnecessarily.");
      scorePenalty += 10;
    }
    if (headlineText.length > 80) {
      issues.push("Headline is too long and may dominate the design.");
      scorePenalty += 10;
    }
  }

  return { scorePenalty, issues };
}
