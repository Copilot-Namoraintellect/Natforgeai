import type { BusinessEvidence } from "./website-analyser";

export interface BusinessDescriptionInput {
  businessName?: string;
  businessCategory?: string;
  productsServices?: string[];
  targetCustomers?: string[];
  valueProposition?: string;
  location?: string;
  tone?: string;
  evidenceSnippets?: string[];
}

export interface BusinessDescriptions {
  shortDescription: string;
  businessDescription: string;
}

export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const cleaned = String(value ?? "").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

function firstN(values: string[] | undefined, count: number): string[] {
  return (values || []).map((v) => v.trim()).filter(Boolean).slice(0, count);
}

function toSentence(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function ensureWordRange(text: string, minWords: number, maxWords: number, fallbackExpander: string[]): string {
  let result = text.trim().replace(/\s+/g, " ");
  if (!result) result = fallbackExpander.join(" ");

  while (countWords(result) < minWords && fallbackExpander.length > 0) {
    result = `${result} ${fallbackExpander.shift()}`.trim();
  }

  const words = result.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    result = words.slice(0, maxWords).join(" ");
    if (!/[.!?]$/.test(result)) {
      result += ".";
    }
  }

  return result;
}

export function buildBusinessDescriptions(input: BusinessDescriptionInput): BusinessDescriptions {
  const businessName = input.businessName?.trim() || "This business";
  const category = input.businessCategory?.trim() || "local business";
  const products = uniqueNonEmpty(firstN(input.productsServices, 4));
  const customers = uniqueNonEmpty(firstN(input.targetCustomers, 3));
  const evidenceBits = uniqueNonEmpty(firstN(input.evidenceSnippets, 4));
  const location = input.location?.trim();
  const tone = input.tone?.trim() || "professional and trustworthy";
  const valueProposition = input.valueProposition?.trim();

  const shortDescription = `${businessName} is a ${category.toLowerCase()} focused on ${products[0] || "serving customer needs"}.`;

  const sentenceBlocks: string[] = [];
  sentenceBlocks.push(
    toSentence(
      `${businessName} is a ${category.toLowerCase()} that helps ${
        customers[0] || "its customers"
      } through ${products.length > 0 ? products.join(", ") : "reliable products and services"}`
    )
  );

  sentenceBlocks.push(
    toSentence(
      `${businessName} is designed for ${
        customers.length > 0 ? customers.join(", ") : "customers looking for clear, dependable outcomes"
      }, and the offer is positioned with a ${tone} tone to build confidence and clarity`
    )
  );

  if (valueProposition) {
    sentenceBlocks.push(toSentence(`Its core value proposition is ${valueProposition}`));
  } else {
    sentenceBlocks.push(
      toSentence(
        `Its value proposition centers on practical results, clear communication, and delivering consistent quality instead of generic promises`
      )
    );
  }

  if (location) {
    sentenceBlocks.push(
      toSentence(
        `The business serves ${location} and nearby areas where relevant, and messaging should stay grounded in that local context`
      )
    );
  }

  if (evidenceBits.length > 0) {
    sentenceBlocks.push(
      toSentence(
        `Website evidence highlights ${evidenceBits.join("; ")}, which should guide campaign language and proof points`
      )
    );
  }

  const fallbackExpander = [
    "Campaign messaging should clearly explain what the business does, who it serves, and why customers should trust it.",
    "Content should prioritize specific products or services, strong customer outcomes, and a clear next action.",
    "The tone should remain consistent across strategy, approvals, creative generation, and publishing.",
  ];

  const businessDescription = ensureWordRange(
    sentenceBlocks.filter(Boolean).join(" "),
    80,
    150,
    fallbackExpander
  );

  return { shortDescription, businessDescription };
}

export function buildBusinessDescriptionsFromEvidence(
  evidence: BusinessEvidence,
  overrides: Partial<BusinessDescriptionInput> = {}
): BusinessDescriptions {
  return buildBusinessDescriptions({
    businessCategory: evidence.businessCategory,
    productsServices: evidence.productsServices,
    targetCustomers: evidence.targetCustomers,
    location: evidence.location,
    evidenceSnippets: evidence.evidenceSnippets,
    ...overrides,
  });
}
