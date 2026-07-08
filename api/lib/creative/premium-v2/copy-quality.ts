/**
 * Premium Leaflet Hybrid Pipeline – Generic Copy Quality Gate.
 *
 * Checks customer-facing copy for broken grammar, duplicated words, missing
 * prepositions and overused generic filler phrases. Runs on the visible text
 * extracted from the rendered leaflet so it applies to every business/category.
 */

export interface CopyQualityResult {
  copyQualityPassed: boolean;
  copyQualityIssues: string[];
  cleanedVisibleText: string;
  copyQualityScore: number;
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (_match, entity) => HTML_ENTITY_MAP[entity.toLowerCase()] || _match)
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

interface GrammarRule {
  pattern: RegExp;
  message: string;
  fix: (text: string) => string;
}

const GRAMMAR_RULES: GrammarRule[] = [
  {
    pattern: /\bwith\s+for\b/gi,
    message: 'Awkward grammar: "with for"',
    fix: (text) => text.replace(/\bwith\s+for\b/gi, "for"),
  },
  {
    pattern: /\bdelivery\s+your\s+convenience\b/gi,
    message: 'Missing preposition: "delivery your convenience"',
    fix: (text) => text.replace(/\bdelivery\s+your\s+convenience\b/gi, "delivery for your convenience"),
  },
  {
    // duplicated consecutive word, e.g. "prints prints", "for for"
    pattern: /\b(\w+)\s+\1\b/gi,
    message: "Repeated consecutive word",
    fix: (text) => text.replace(/\b(\w+)\s+\1\b/gi, "$1"),
  },
  {
    pattern: /\bwhen\s+matters\b/gi,
    message: 'Missing word: "when matters"',
    fix: (text) => text.replace(/\bwhen\s+matters\b/gi, "when it matters"),
  },
  {
    pattern: /\bget\s+touch\b/gi,
    message: 'Broken CTA: "get touch"',
    fix: (text) => text.replace(/\bget\s+touch\b/gi, "Get in Touch"),
  },
  {
    // Missing connector between two product/service nouns, e.g.
    // "business cards canvas prints" -> "business cards to canvas prints"
    pattern: /\b(business cards|flyers|posters|banners|documents|copies|prints)\s+(canvas|digital|vinyl|paper|courier|delivery|prints|printing)\b/gi,
    message: "Missing connector between items",
    fix: (text) =>
      text.replace(
        /\b(business cards|flyers|posters|banners|documents|copies|prints)\s+(canvas|digital|vinyl|paper|courier|delivery|prints|printing)\b/gi,
        "$1 to $2"
      ),
  },
];

// Generic filler phrases and a polished replacement for each.
const GENERIC_PHRASES: { phrase: string; replacement: string }[] = [
  { phrase: "for all your needs", replacement: "for everyday business needs" },
  { phrase: "for all of your needs", replacement: "for everyday business needs" },
  { phrase: "tailored for you", replacement: "made to fit your project" },
  { phrase: "tailored to you", replacement: "made to fit your project" },
  { phrase: "enhance your brand visibility effectively", replacement: "help your brand get noticed" },
  { phrase: "boost visibility", replacement: "help you stand out" },
  { phrase: "boost your visibility", replacement: "help you stand out" },
  { phrase: "expert support every step", replacement: "support from start to finish" },
  { phrase: "expert support at every step", replacement: "support from start to finish" },
  { phrase: "professional service you can trust", replacement: "professional support you can rely on" },
  { phrase: "all your printing needs", replacement: "everyday printing needs" },
  { phrase: "all your business needs", replacement: "everyday business needs" },
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyGrammarRules(text: string): { cleaned: string; issues: string[] } {
  let cleaned = text;
  const issues: string[] = [];
  for (const rule of GRAMMAR_RULES) {
    if (rule.pattern.test(cleaned)) {
      const matches = cleaned.match(rule.pattern);
      const label = matches && matches.length ? `${rule.message} (${matches[0]})` : rule.message;
      issues.push(label);
      cleaned = rule.fix(cleaned);
    }
  }
  return { cleaned, issues };
}

function applyGenericPhraseFixes(text: string): { cleaned: string; issues: string[] } {
  let cleaned = text;
  const issues: string[] = [];
  for (const { phrase, replacement } of GENERIC_PHRASES) {
    const pattern = new RegExp(`\\b${escapeRegex(phrase)}\\b`, "gi");
    if (pattern.test(cleaned)) {
      issues.push(`Generic phrase: "${phrase}"`);
      cleaned = cleaned.replace(pattern, replacement);
    }
  }
  return { cleaned, issues };
}

/**
 * Remove leading conjunctions and capitalise the remainder. This fixes
 * orphaned fragments such as "and marketing products" that the model sometimes
 * emits at the start of a service description.
 */
function stripLeadingConjunctions(text: string): string {
  return text
    .replace(/^\s*(and|or)\s+/i, (match) => match.replace(/and\s+|or\s+/i, ""))
    .replace(/\s+(and|or)\s*$/i, "")
    .replace(/^([a-z])/, (c) => c.toUpperCase());
}

const HEADING_NOUNS = new Set([
  "printing", "marketing", "products", "branding", "courier", "services", "delivery", "copies", "copying",
  "binding", "laminating", "scanning", "flyers", "banners", "posters", "canvas", "design", "documents",
  "parcels", "packages", "shipments", "signs", "labels", "stationery", "promotional", "materials",
]);

function looksLikeHeading(words: string[]): boolean {
  if (words.length < 2 || words.length > 5) return false;
  if (words.some((w) => /^[A-Z]/.test(w))) return false;
  const nounCount = words.filter((w) => HEADING_NOUNS.has(w.toLowerCase())).length;
  return nounCount >= Math.max(1, words.length - 1);
}

function fixOrphanFragments(text: string): { cleaned: string; issues: string[] } {
  let cleaned = text;
  const issues: string[] = [];

  // 1. Remove leading/trailing conjunctions and capitalise the remainder.
  const leadingAndPattern = /(^|[.!?]\s+)and\s+([a-z]+(?:\s+[a-z]+){0,3})(?=[.!?]|$|\s+(and|or|with|for))/gi;
  cleaned = cleaned.replace(leadingAndPattern, (_match, boundary, fragment) => {
    const fixed = stripLeadingConjunctions(fragment);
    issues.push(`Orphaned fragment: "and ${fragment}"`);
    return (boundary || "") + fixed;
  });

  // 2. Detect runs of lower-case heading nouns that are not a real sentence.
  const runPattern = /\b([a-z]+(?:\s+[a-z]+){1,3})\b/g;
  cleaned = cleaned.replace(runPattern, (match) => {
    const words = match.split(/\s+/);
    if (looksLikeHeading(words)) {
      issues.push(`Orphaned heading: "${match}"`);
      return words.map((w) => (w === "and" || w === "or" ? "" : w.charAt(0).toUpperCase() + w.slice(1))).filter(Boolean).join(" ");
    }
    return match;
  });

  return { cleaned: normalizeWhitespace(cleaned), issues };
}

function findRepeatedPhrases(text: string): { cleaned: string; issues: string[] } {
  const issues: string[] = [];
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const minGram = 6;

  let cleaned = text;

  // Look for repeated n-grams of at least 6 tokens and remove duplicates.
  for (let len = Math.min(20, tokens.length); len >= minGram; len--) {
    const seen = new Map<string, number>();
    for (let i = 0; i <= tokens.length - len; i++) {
      const gram = tokens.slice(i, i + len).join(" ");
      const first = seen.get(gram);
      if (first === undefined) {
        seen.set(gram, i);
      } else {
        issues.push(`Repeated description: "${gram}"`);
        // Remove the duplicate occurrence from the original text. Because we
        // are operating on token sequences, approximate the span by matching
        // the gram as a phrase in the current cleaned text.
        const pattern = new RegExp(`\\s*${escapeRegex(gram).replace(/\\s+/g, "\\s+")}`, "i");
        cleaned = cleaned.replace(pattern, "");
      }
    }
  }

  return { cleaned: normalizeWhitespace(cleaned), issues };
}

function calculateScore(grammarIssues: number, genericIssues: number, fragmentIssues: number): number {
  let score = 100;
  score -= grammarIssues * 15;
  score -= genericIssues * 10;
  score -= fragmentIssues * 10;
  return Math.max(0, Math.min(100, score));
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sanitiseCopy(text: string): { cleaned: string; issues: string[] } {
  let cleaned = normalizeWhitespace(text);
  const allIssues: string[] = [];

  // 1. Decode HTML entities so &amp; does not hide broken words.
  const decoded = decodeHtmlEntities(cleaned);
  if (decoded !== cleaned) {
    allIssues.push("HTML entity in visible text");
    cleaned = decoded;
  }

  // 2. Grammar fixes.
  const grammar = applyGrammarRules(cleaned);
  cleaned = grammar.cleaned;
  allIssues.push(...grammar.issues);

  // 3. Strip leading conjunctions from fragments.
  cleaned = stripLeadingConjunctions(cleaned);

  // 4. Generic filler replacements.
  const generic = applyGenericPhraseFixes(cleaned);
  cleaned = generic.cleaned;
  allIssues.push(...generic.issues);

  // 5. Orphaned fragments/headings.
  const fragments = fixOrphanFragments(cleaned);
  cleaned = fragments.cleaned;
  allIssues.push(...fragments.issues);

  // 6. Repeated descriptions across cards.
  const repeated = findRepeatedPhrases(cleaned);
  cleaned = repeated.cleaned;
  allIssues.push(...repeated.issues);

  return { cleaned: normalizeWhitespace(cleaned), issues: allIssues };
}

/**
 * Evaluate the copy quality of visible rendered text.
 * Returns the original issues plus a cleaned version of the text.
 */
export function evaluateCopyQuality(visibleText: string): CopyQualityResult {
  const raw = normalizeWhitespace(visibleText || "");
  const result = sanitiseCopy(raw);

  return {
    copyQualityPassed: result.issues.length === 0,
    copyQualityIssues: result.issues,
    cleanedVisibleText: result.cleaned,
    copyQualityScore: calculateScore(
      result.issues.filter((i) => /awkward|missing word|broken CTA|missing connector|repeated consecutive/i.test(i)).length,
      result.issues.filter((i) => i.startsWith("Generic phrase:")).length,
      result.issues.filter((i) => /HTML entity|Orphaned fragment|Repeated description/i.test(i)).length
    ),
  };
}

/**
 * Clean a single piece of copy (service description, headline, benefit, etc.)
 * without scoring. Useful for polishing copy before it reaches the renderer.
 */
export function cleanCopy(text: string): string {
  let cleaned = normalizeWhitespace(text || "");
  cleaned = decodeHtmlEntities(cleaned);
  cleaned = applyGrammarRules(cleaned).cleaned;
  cleaned = stripLeadingConjunctions(cleaned);
  cleaned = applyGenericPhraseFixes(cleaned).cleaned;
  cleaned = fixOrphanFragments(cleaned).cleaned;
  cleaned = normalizeWhitespace(cleaned);
  if (cleaned && !/[.!?]$/.test(cleaned)) cleaned += ".";
  return cleaned;
}

/**
 * Build visible text from an AICreativeBrief for offline copy-quality checks.
 */
export function visibleTextFromBrief(brief: {
  headline: string;
  subheadline: string;
  primaryServices: { name: string; description: string | null }[];
  secondaryServices: { name: string }[];
  benefits: string[];
  cta: string;
  offerLine?: string | null;
}): string {
  const parts: string[] = [brief.headline, brief.subheadline];
  if (brief.offerLine) parts.push(brief.offerLine);
  for (const s of brief.primaryServices) {
    parts.push(s.name);
    if (s.description) parts.push(s.description);
  }
  for (const s of brief.secondaryServices) parts.push(s.name);
  parts.push(...brief.benefits, brief.cta);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
