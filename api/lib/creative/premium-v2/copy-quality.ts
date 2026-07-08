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

const GRAMMAR_PATTERNS: { pattern: RegExp; message: string; fix: (text: string) => string }[] = [
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
    // common missing preposition pattern: "<noun> your convenience" without for
    pattern: /\b(for|at|by)\s+your\s+convenience\b/gi,
    message: "Generic phrase: 'your convenience' without context",
    fix: (text) => text,
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

function fixGrammar(text: string): { cleaned: string; issues: string[] } {
  let cleaned = text;
  const issues: string[] = [];
  for (const rule of GRAMMAR_PATTERNS) {
    if (rule.pattern.test(cleaned)) {
      const matches = cleaned.match(rule.pattern);
      const label = matches && matches.length ? `${rule.message} (${matches[0]})` : rule.message;
      issues.push(label);
      cleaned = rule.fix(cleaned);
    }
  }
  return { cleaned, issues };
}

function fixGenericPhrases(text: string): { cleaned: string; issues: string[] } {
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

function calculateScore(grammarIssues: number, genericIssues: number, _fragmentIssues: number): number {
  let score = 100;
  score -= grammarIssues * 15;
  score -= genericIssues * 10;
  return Math.max(0, Math.min(100, score));
}

/**
 * Evaluate the copy quality of visible rendered text.
 * Returns the original issues plus a cleaned version of the text.
 * copyQualityPassed is determined by whether the cleaned text still has issues.
 */
export function evaluateCopyQuality(visibleText: string): CopyQualityResult {
  const raw = (visibleText || "").replace(/\s+/g, " ").trim();

  const grammar = fixGrammar(raw);
  const generic = fixGenericPhrases(grammar.cleaned);

  const allIssues = [...grammar.issues, ...generic.issues];

  const score = calculateScore(grammar.issues.length, generic.issues.length, 0);

  // copyQualityPassed reflects the original visible text. cleanedVisibleText is
  // provided so callers can fix the copy before rendering if needed.
  return {
    copyQualityPassed: allIssues.length === 0,
    copyQualityIssues: allIssues,
    cleanedVisibleText: generic.cleaned.trim(),
    copyQualityScore: score,
  };
}

/**
 * Clean a single piece of copy (service description, headline, benefit, etc.)
 * without scoring. Useful for polishing copy before it reaches the renderer.
 */
export function cleanCopy(text: string): string {
  let cleaned = (text || "").replace(/\s+/g, " ").trim();
  cleaned = fixGrammar(cleaned).cleaned;
  cleaned = fixGenericPhrases(cleaned).cleaned;
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
