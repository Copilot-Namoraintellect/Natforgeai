/**
 * Premium Leaflet Hybrid Pipeline – Content Fidelity Gate.
 *
 * Ensures the hybrid renderer does not invent discounts, free offers, coupons,
 * or time-limited promotions when none were approved in the campaign/message pack.
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
  const offerSource = deriveOfferSource(campaign);
  const offerExpected = offerSource !== "none";
  const approvedOffer = campaign.offerDetails?.trim() || "";

  const offerLine = brief.offerLine?.trim() || "";
  const offerRendered = offerLine.length > 0 && renderedHtml.includes(offerLine);

  if (!offerExpected) {
    const renderedText = renderedHtml.replace(/<[^>]+>/g, " ");
    const promo = hasPromotionalLanguage(renderedText);
    if (promo.detected) {
      return {
        offerExpected: false,
        offerSource: "none",
        offerRendered: true,
        inventedOfferDetected: true,
        contentFidelityPassed: false,
        detectedOfferSnippet: promo.snippet,
      };
    }
    return {
      offerExpected: false,
      offerSource: "none",
      offerRendered: false,
      inventedOfferDetected: false,
      contentFidelityPassed: true,
      detectedOfferSnippet: null,
    };
  }

  // Offer is expected. It may be rendered either explicitly via offerLine or as part of copy.
  const approvedOfferRendered = approvedOffer.length > 0 && renderedHtml.includes(approvedOffer);
  const anyOfferRendered = offerRendered || approvedOfferRendered;

  if (!anyOfferRendered && offerLine.length > 0) {
    // The brief created an offer line that does not match the approved offer.
    const promo = hasPromotionalLanguage(offerLine);
    if (promo.detected) {
      return {
        offerExpected: true,
        offerSource,
        offerRendered: true,
        inventedOfferDetected: true,
        contentFidelityPassed: false,
        detectedOfferSnippet: promo.snippet,
      };
    }
  }

  // If rendered text contains stronger promotional language than approved offer, flag it.
  const renderedText = renderedHtml.replace(/<[^>]+>/g, " ");
  const approvedNormalized = normalize(approvedOffer);
  const promo = hasPromotionalLanguage(renderedText);
  if (promo.detected && !approvedNormalized.includes(normalize(promo.snippet || ""))) {
    return {
      offerExpected: true,
      offerSource,
      offerRendered: anyOfferRendered,
      inventedOfferDetected: true,
      contentFidelityPassed: false,
      detectedOfferSnippet: promo.snippet,
    };
  }

  return {
    offerExpected: true,
    offerSource,
    offerRendered: anyOfferRendered,
    inventedOfferDetected: false,
    contentFidelityPassed: true,
    detectedOfferSnippet: null,
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
