/**
 * Premium Leaflet Hybrid Pipeline – Content Fidelity Gate.
 *
 * Ensures the hybrid renderer does not invent discounts, free offers, coupons,
 * or time-limited promotions when none were approved in the campaign/message pack.
 *
 * This gate inspects only user-visible rendered text. Raw HTML markup, CSS,
 * data URIs, base64 image data, file paths, random IDs, hashes and generated
 * class names are stripped before offer detection runs.
 */

import { INVENTED_OFFER_PATTERNS } from "../campaign-message-architect";
import type { BusinessEvidence, CampaignEvidence } from "./curation";
import type { AICreativeBrief } from "./pipeline-types";

export interface ContentFidelityResult {
  offerExpected: boolean;
  offerSource: "campaign" | "message_pack" | "none";
  offerRendered: boolean;
  inventedOfferDetected: boolean;
  contentFidelityPassed: boolean;
  detectedOfferSnippet: string | null;
  visibleRenderedText: string;
}

const PROMOTIONAL_PATTERNS = [
  ...INVENTED_OFFER_PATTERNS,
  /\bexclusive\s+offer(s?)\b/i,
  /\bspecial\s+discount\b/i,
  /\blimited[- ]?time\s+deal\b/i,
  /\bfree\b/i,
  /\b\d{1,2}%\b/i,
  /\b\$\d+\b/i,
  /\bR\d+\b/i,
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9%$\s]/g, " ").replace(/\s+/g, " ").trim();
}

function looksLikeNoise(fragment: string): boolean {
  const trimmed = fragment.trim();
  if (trimmed.length < 3) return true;
  // Random IDs / hashes / base64 fragments are long alphanumeric strings that also contain digits or base64/special chars.
  if (/^[a-z0-9+/=_-]{8,}$/i.test(trimmed) && /[0-9+/=_-]/.test(trimmed)) return true;
  // CSS class names / generated identifiers often contain numbers and dashes only.
  if (/^[a-z]+[-_][a-z0-9_-]+$/i.test(trimmed) && /[0-9_-]/.test(trimmed)) return true;
  return false;
}

export function extractVisibleText(renderedHtml: string): string {
  let html = renderedHtml;

  // Remove style/script/svg blocks entirely.
  html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  html = html.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");

  // Remove HTML comments.
  html = html.replace(/<!--[\s\S]*?-->/g, " ");

  // Remove data URIs.
  html = html.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, " ");

  // Remove http(s) URLs and file paths.
  html = html.replace(/https?:\/\/[^\s"'<>]+/g, " ");
  html = html.replace(/\/[A-Za-z0-9_/.-]+\.[A-Za-z0-9]+/g, " ");

  // Extract text nodes: content between > and <.
  const textNodes: string[] = [];
  const nodePattern = />([^<]*?)</g;
  let match: RegExpExecArray | null;
  while ((match = nodePattern.exec(html)) !== null) {
    const text = match[1].trim();
    if (text) textNodes.push(text);
  }

  // Join and clean.
  let visible = textNodes.join(" ").replace(/\s+/g, " ").trim();

  // Strip remaining numeric/hash-looking noise tokens.
  visible = visible
    .split(/\s+/)
    .filter((token) => !looksLikeNoise(token))
    .join(" ");

  return visible;
}

function hasPromotionalLanguage(text: string): { detected: boolean; snippet: string | null } {
  const lower = text.toLowerCase();
  for (const pattern of PROMOTIONAL_PATTERNS) {
    const match = lower.match(pattern);
    if (match) {
      return { detected: true, snippet: match[0] };
    }
  }
  return { detected: false, snippet: null };
}

function deriveOfferSource(campaign: CampaignEvidence): ContentFidelityResult["offerSource"] {
  const offer = campaign.offerDetails?.trim();
  if (offer && offer.toLowerCase() !== "none") return "campaign";
  return "none";
}

export function evaluateContentFidelity(
  _business: BusinessEvidence,
  campaign: CampaignEvidence,
  brief: AICreativeBrief,
  renderedHtml: string
): ContentFidelityResult {
  const visibleRenderedText = extractVisibleText(renderedHtml);
  const offerSource = deriveOfferSource(campaign);
  const offerExpected = offerSource !== "none";
  const approvedOffer = campaign.offerDetails?.trim() || "";

  const offerLine = brief.offerLine?.trim() || "";
  const offerRendered = offerLine.length > 0 && visibleRenderedText.includes(offerLine);

  function validateSnippet(snippet: string | null): string | null {
    if (!snippet) return null;
    const lowerVisible = visibleRenderedText.toLowerCase();
    const lowerSnippet = snippet.toLowerCase();
    // Require the snippet to actually appear in visible text, with enough context (at least one word boundary around it).
    if (lowerVisible.includes(lowerSnippet) && !looksLikeNoise(snippet)) return snippet;
    return null;
  }

  if (!offerExpected) {
    const promo = hasPromotionalLanguage(visibleRenderedText);
    const validatedSnippet = validateSnippet(promo.snippet);
    if (promo.detected && validatedSnippet) {
      return {
        offerExpected: false,
        offerSource: "none",
        offerRendered: true,
        inventedOfferDetected: true,
        contentFidelityPassed: false,
        detectedOfferSnippet: validatedSnippet,
        visibleRenderedText,
      };
    }
    return {
      offerExpected: false,
      offerSource: "none",
      offerRendered: false,
      inventedOfferDetected: false,
      contentFidelityPassed: true,
      detectedOfferSnippet: null,
      visibleRenderedText,
    };
  }

  // Offer is expected. It may be rendered either explicitly via offerLine or as part of copy.
  const approvedOfferRendered = approvedOffer.length > 0 && visibleRenderedText.includes(approvedOffer);
  const anyOfferRendered = offerRendered || approvedOfferRendered;

  if (!anyOfferRendered && offerLine.length > 0) {
    const promo = hasPromotionalLanguage(offerLine);
    const validatedSnippet = validateSnippet(promo.snippet);
    if (validatedSnippet) {
      return {
        offerExpected: true,
        offerSource,
        offerRendered: true,
        inventedOfferDetected: true,
        contentFidelityPassed: false,
        detectedOfferSnippet: validatedSnippet,
        visibleRenderedText,
      };
    }
  }

  // If rendered text contains stronger promotional language than approved offer, flag it.
  const approvedNormalized = normalize(approvedOffer);
  const promo = hasPromotionalLanguage(visibleRenderedText);
  const validatedSnippet = validateSnippet(promo.snippet);
  if (promo.detected && validatedSnippet && !approvedNormalized.includes(normalize(validatedSnippet))) {
    return {
      offerExpected: true,
      offerSource,
      offerRendered: anyOfferRendered,
      inventedOfferDetected: true,
      contentFidelityPassed: false,
      detectedOfferSnippet: validatedSnippet,
      visibleRenderedText,
    };
  }

  return {
    offerExpected: true,
    offerSource,
    offerRendered: anyOfferRendered,
    inventedOfferDetected: false,
    contentFidelityPassed: true,
    detectedOfferSnippet: null,
    visibleRenderedText,
  };
}

export function safeNonPromotionalCtas(): string[] {
  return [
    "Request a Quote Today",
    "Visit Us Today",
    "Contact Us Today",
    "Get Printing Support",
    "Book a Consultation",
    "Get in Touch",
    "Learn More",
  ];
}
