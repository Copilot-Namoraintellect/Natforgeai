/**
 * Build premium, brand-safe prompts for the OpenAI hybrid leaflet background.
 *
 * OpenAI only generates the visual composition/background. The real logo,
 * text, CTA and contact details are overlaid deterministically by NatForgeAI.
 * The prompt therefore must be extremely explicit about excluding text,
 * logos, faces, UI elements and frames so the final composite looks polished.
 */

import type { TemplateFormat } from "./template-renderer";

export interface LeafletPromptInput {
  businessName: string;
  businessCategory?: string;
  industry?: string;
  productOrService?: string;
  location?: string;
  visualStyle?: string;
  offer?: string;
  headline?: string;
  campaignObjective?: string;
  campaignAudience?: string;
  campaignPrimaryService?: string;
  captionPackSummary?: string;
  brandColors: string[];
  format: TemplateFormat;
  aspectRatio?: string;
  creativeGuidance?: string;
  refinementInstruction?: string;
  isRetry?: boolean;
}

const NEGATIVE_INSTRUCTIONS = `
CRITICAL CONSTRAINTS — the image MUST obey all of these:
- NO text, NO letters, NO numbers, NO words, NO typography, NO slogans.
- NO logos, NO brand marks, NO monograms, NO signatures, NO watermarks.
- NO business name, NO product labels, NO price tags, NO signage, NO menu boards.
- NO QR codes, NO barcodes, NO icons, NO UI elements, NO buttons, NO frames, NO borders.
- NO people, NO faces, NO hands, NO crowds.
- Leave generous clean, low-detail space at the top and centre so the business logo and marketing text can be overlaid later without competing with the visuals.
`.trim();

const RETRY_NEGATIVE_BOOST = `
RETRY NOTE: The previous attempt still contained readable text, logos, labels, signage, people, faces, or cluttered UI elements. This version must be a pure, unbranded visual scene only. Absolutely no words, marks, or human figures anywhere in the frame.
`.trim();

function visualSceneFrom(input: LeafletPromptInput): string {
  const category = (input.businessCategory || input.industry || "").toLowerCase();
  const product = input.productOrService || input.campaignPrimaryService || "";
  const offer = input.offer || "";
  const headline = input.headline || "";
  const summary = input.captionPackSummary?.toLowerCase() || "";
  const combined = `${category} ${product} ${offer} ${headline} ${summary}`;

  // Prioritise explicit product cues over broad business category.
  if (combined.includes("canvas") || combined.includes("wall art") || combined.includes("framed print") || combined.includes("poster")) {
    return `an elegant interior scene showing framed wall art, canvas prints, and tasteful home décor textures with warm, gallery-style lighting`;
  }

  if (category.includes("print") || category.includes("copy") || product.toLowerCase().includes("print")) {
    return `a premium workspace still-life for a print and copy shop: crisp paper stacks, colourful flyers, business cards, a sleek printer, and premium packaging materials arranged with depth and soft shadows`;
  }

  if (category.includes("food") || category.includes("restaurant") || category.includes("cafe") || product.toLowerCase().includes("food")) {
    return `a premium food flat-lay or table scene with fresh ingredients, elegant plating, and appetising textures, shot from above at a slight angle`;
  }

  if (category.includes("beauty") || category.includes("salon") || category.includes("hair") || category.includes("nail")) {
    return `a premium beauty product flat-lay with skincare bottles, salon tools, fresh botanicals, and soft pastel tones`;
  }

  if (category.includes("retail") || category.includes("shop") || category.includes("store") || product.toLowerCase().includes("product")) {
    return `a premium retail product display with clean surfaces, elegant packaging, and a subtle lifestyle setting`;
  }

  if (category.includes("service") || category.includes("professional") || category.includes("consulting") || category.includes("agency")) {
    return `a premium professional service scene: a modern workspace, abstract architectural detail, or clean B2B texture that conveys trust and expertise`;
  }

  // Fallback: derive from product/headline/offer.
  return `a premium marketing photograph of ${product || headline || offer || input.businessName}, styled as a clean, aspirational visual`;
}

function styleAndMoodFrom(input: LeafletPromptInput): string {
  const visualStyle = input.visualStyle?.toLowerCase() || "";
  if (visualStyle.includes("modern") || visualStyle.includes("minimal")) {
    return "modern, minimal, lots of negative space, refined typography-safe layout";
  }
  if (visualStyle.includes("bold") || visualStyle.includes("vibrant")) {
    return "bold, vibrant, energetic, with rich colour contrast and clean focal points";
  }
  if (visualStyle.includes("luxury") || visualStyle.includes("premium")) {
    return "luxury editorial photography, soft cinematic lighting, sophisticated depth";
  }
  if (visualStyle.includes("friendly") || visualStyle.includes("warm")) {
    return "warm, friendly, approachable lifestyle photography with natural light";
  }
  return "premium editorial photography with soft cinematic lighting and a clean, customer-ready finish";
}

function paletteHint(colors: string[]): string {
  const clean = colors
    .map((c) => c.trim())
    .filter((c) => c.startsWith("#") && c.length >= 4)
    .slice(0, 3);
  if (clean.length === 0) return "a subtle, neutral palette that works with any brand overlay";
  return `the brand colours ${clean.join(", ")} subtly woven into the scene as accents only — never as text or logos`;
}

export function buildOpenAiLeafletPrompt(input: LeafletPromptInput): {
  prompt: string;
  negativePrompt: string;
  visualDescription: string;
} {
  const scene = visualSceneFrom(input);
  const style = styleAndMoodFrom(input);
  const palette = paletteHint(input.brandColors);
  const locationClause = input.location ? ` in ${input.location}` : "";
  const guidanceClause = input.creativeGuidance ? ` Creative direction: ${input.creativeGuidance}.` : "";
  const refinementClause = input.refinementInstruction ? ` Refinement: ${input.refinementInstruction}.` : "";
  const offerClause = input.offer ? ` The image should subtly evoke the offer "${input.offer}" without showing text.` : "";
  const objectiveClause = input.campaignObjective ? ` Campaign goal: ${input.campaignObjective}.` : "";
  const audienceClause = input.campaignAudience ? ` Target audience: ${input.campaignAudience}.` : "";
  const primaryServiceClause = input.campaignPrimaryService ? ` Primary service: ${input.campaignPrimaryService}.` : "";
  const captionPackClause = input.captionPackSummary
    ? ` Copy and messaging to align with (do not render text): ${input.captionPackSummary}.`
    : "";

  const visualDescription = `${scene}${locationClause}`;

  const prompt = `Create a premium, unbranded marketing background image for ${input.businessName}.

Visual scene: ${visualDescription}.${guidanceClause}${refinementClause}${offerClause}${objectiveClause}${audienceClause}${primaryServiceClause}${captionPackClause}

Style: ${style}.
Colour palette: ${palette}.

The composition should be vertically oriented, leaving clear empty space at the top and centre for the business logo, headline, offer, call-to-action button and contact details to be overlaid later.

${NEGATIVE_INSTRUCTIONS}${input.isRetry ? "\n\n" + RETRY_NEGATIVE_BOOST : ""}`;

  return {
    prompt: prompt.replace(/\n{3,}/g, "\n\n").trim(),
    negativePrompt: NEGATIVE_INSTRUCTIONS,
    visualDescription,
  };
}
