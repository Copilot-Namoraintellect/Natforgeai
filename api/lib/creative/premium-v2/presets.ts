/**
 * Premium Leaflet V2 – reusable business-category presets.
 *
 * Each preset maps a detected business category to a recommended default
 * headline, subheadline, CTA, visual style, layout density, and service-order
 * hints. These are defaults; approved copy, campaign data, and explicit
 * refinement instructions always override them.
 */

import type { PremiumV2BusinessCategory, PremiumV2LayoutDensity, PremiumV2VisualStyle } from "./types";
import type { BusinessEvidence, CampaignEvidence } from "./curation";
import { asString } from "./curation";

export interface PremiumV2CategoryPreset {
  category: PremiumV2BusinessCategory;
  label: string;
  headlineTemplate: (business: BusinessEvidence, campaign?: CampaignEvidence) => string;
  subheadlineTemplate: (business: BusinessEvidence, campaign?: CampaignEvidence) => string;
  defaultCta: string;
  defaultDensity: PremiumV2LayoutDensity;
  defaultVisualStyle: PremiumV2VisualStyle;
  /** Service names that should float to the top of the primary list when present. */
  priorityServiceKeywords: string[];
  /** Keywords that signal a service should be treated as secondary/compact. */
  compactServiceKeywords: string[];
  proofPointLabels: string[];
}

function name(business: BusinessEvidence): string {
  return asString(business.displayName || business.name) || "";
}

function location(business: BusinessEvidence): string {
  return asString(business.address || business.location) || "";
}

const LOCAL_SERVICES: PremiumV2CategoryPreset = {
  category: "local_services",
  label: "Local services",
  headlineTemplate: (b) => {
    const loc = location(b);
    return loc ? `Fast, Reliable Service in ${loc}` : `${name(b) || "Trusted"} Local Services`;
  },
  subheadlineTemplate: (b, c) =>
    asString(c?.mainPainPoint)
      ? `We solve ${(c!.mainPainPoint as string).toLowerCase()} quickly and professionally.`
      : `Professional help for homes and businesses${location(b) ? ` in ${location(b)}` : ""}.`,
  defaultCta: "Request a Quote Today",
  defaultDensity: "premium_services",
  defaultVisualStyle: "bold",
  priorityServiceKeywords: ["repair", "installation", "maintenance", "emergency", "inspection"],
  compactServiceKeywords: ["consultation", "assessment", "quote", "advice"],
  proofPointLabels: ["Location", "Same-day service", "Licensed"],
};

const RETAIL_PRODUCT: PremiumV2CategoryPreset = {
  category: "retail_product",
  label: "Retail / product",
  headlineTemplate: (b, c) => {
    if (asString(c?.offerDetails)) return `${name(b) || "Your Local"} – ${c!.offerDetails as string}`;
    return `${name(b) || "Your Local"} Shop${location(b) ? ` – ${location(b)}` : ""}`;
  },
  subheadlineTemplate: (b, c) =>
    asString(c?.mainPainPoint)
      ? `Find exactly what you need without the hassle.`
      : `Quality products, great prices${location(b) ? `, right here in ${location(b)}` : ""}.`,
  defaultCta: "Shop Now",
  defaultDensity: "offer_focused",
  defaultVisualStyle: "bold",
  priorityServiceKeywords: ["sale", "new arrival", "best seller", "collection", "range"],
  compactServiceKeywords: ["gift wrap", "delivery", "warranty", "returns"],
  proofPointLabels: ["Location", "In stock", "Best price"],
};

const FOOD_RESTAURANT: PremiumV2CategoryPreset = {
  category: "food_restaurant",
  label: "Food / restaurant",
  headlineTemplate: (b, c) =>
    asString(c?.offerDetails) || `${name(b) || "Delicious Food"}${location(b) ? ` – ${location(b)}` : ""}`,
  subheadlineTemplate: (b, c) =>
    asString(c?.mainPainPoint)
      ? `Fresh, flavourful food made for busy people.`
      : `Order, dine in or takeaway${location(b) ? ` in ${location(b)}` : ""}.`,
  defaultCta: "Order Now",
  defaultDensity: "premium_services",
  defaultVisualStyle: "friendly",
  priorityServiceKeywords: ["burger", "pizza", "pasta", "meal", "special", "combo"],
  compactServiceKeywords: ["sides", "drinks", "dessert", "catering"],
  proofPointLabels: ["Location", "Fresh daily", "Delivery"],
};

const PROFESSIONAL_SERVICES: PremiumV2CategoryPreset = {
  category: "professional_services",
  label: "Professional services",
  headlineTemplate: (b, c) => {
    if (asString(c?.offerDetails)) return asString(c!.offerDetails as string) as string;
    const loc = location(b);
    return loc ? `Expert Advice & Professional Services in ${loc}` : `Expert Advice You Can Trust`;
  },
  subheadlineTemplate: (b, c) =>
    asString(c?.mainPainPoint)
      ? `Helping you ${(c!.mainPainPoint as string).toLowerCase()} with clear, expert guidance.`
      : `Professional support for growing businesses${location(b) ? ` in ${location(b)}` : ""}.`,
  defaultCta: "Book a Consultation",
  defaultDensity: "corporate_professional",
  defaultVisualStyle: "modern",
  priorityServiceKeywords: ["consulting", "advisory", "strategy", "audit", "planning"],
  compactServiceKeywords: ["report", "review", "assessment", "follow-up"],
  proofPointLabels: ["Location", "Experienced", "Consultation"],
};

const PRINT_COURIER: PremiumV2CategoryPreset = {
  category: "print_courier",
  label: "Print / courier / business services",
  headlineTemplate: (b, c) => {
    const loc = location(b);
    if (asString(c?.offerDetails)) return asString(c!.offerDetails as string) as string;
    return loc
      ? `Professional Printing, Courier & Business Services in ${loc}`
      : `Print, Courier & Business Services Made Simple`;
  },
  subheadlineTemplate: (b, c) =>
    asString(c?.mainPainPoint)
      ? `Fast, reliable print and courier support when you need it most.`
      : `Business cards, flyers, large format prints and courier services${location(b) ? ` in ${location(b)}` : ""}.`,
  defaultCta: "Request a Quote Today",
  defaultDensity: "premium_services",
  defaultVisualStyle: "modern",
  priorityServiceKeywords: [
    "business card",
    "flyer",
    "large format",
    "canvas",
    "courier",
    "banner",
    "poster",
    "custom printing",
  ],
  compactServiceKeywords: ["laminating", "binding", "copy", "scan", "custom"],
  proofPointLabels: ["Location", "Fast turnaround", "Local delivery"],
};

const BEAUTY_WELLNESS: PremiumV2CategoryPreset = {
  category: "beauty_wellness",
  label: "Beauty / wellness",
  headlineTemplate: (b, c) =>
    asString(c?.offerDetails) || `Look and Feel Your Best${location(b) ? ` in ${location(b)}` : ""}`,
  subheadlineTemplate: (b, c) =>
    asString(c?.mainPainPoint)
      ? `Relax, refresh and leave confident.`
      : `Professional treatments in a calm, welcoming space${location(b) ? ` in ${location(b)}` : ""}.`,
  defaultCta: "Book Your Appointment",
  defaultDensity: "premium_minimal",
  defaultVisualStyle: "luxury",
  priorityServiceKeywords: ["hair", "nail", "facial", "massage", "makeup", "spa", "package"],
  compactServiceKeywords: ["wax", "tint", "brow", "lash", "consultation"],
  proofPointLabels: ["Location", "Qualified therapists", "Booking"],
};

const HEALTHCARE_WELLNESS: PremiumV2CategoryPreset = {
  category: "healthcare_wellness",
  label: "Healthcare / wellness",
  headlineTemplate: (b, c) =>
    asString(c?.offerDetails) || `Care You Can Count On${location(b) ? ` in ${location(b)}` : ""}`,
  subheadlineTemplate: (b, c) =>
    asString(c?.mainPainPoint)
      ? `Compassionate, professional care for your health and wellbeing.`
      : `Trusted healthcare services${location(b) ? ` in ${location(b)}` : ""}.`,
  defaultCta: "Book an Appointment",
  defaultDensity: "corporate_professional",
  defaultVisualStyle: "classic",
  priorityServiceKeywords: ["consultation", "check-up", "therapy", "treatment", "care"],
  compactServiceKeywords: ["follow-up", "prescription", "referral"],
  proofPointLabels: ["Location", "Registered", "Appointment"],
};

const TRAINING_EDUCATION: PremiumV2CategoryPreset = {
  category: "training_education",
  label: "Training / education",
  headlineTemplate: (b, c) => {
    if (asString(c?.offerDetails)) return asString(c!.offerDetails as string) as string;
    const loc = location(b);
    return loc ? `Practical Courses & Workshops in ${loc}` : `Build Skills with Industry Experts`;
  },
  subheadlineTemplate: (b, c) =>
    asString(c?.mainPainPoint)
      ? `Practical training that helps you move forward faster.`
      : `Courses and workshops${location(b) ? ` in ${location(b)}` : ""} to build real skills.`,
  defaultCta: "Enrol Today",
  defaultDensity: "premium_services",
  defaultVisualStyle: "friendly",
  priorityServiceKeywords: ["course", "training", "workshop", "certification", "class"],
  compactServiceKeywords: ["materials", "online", "group", "corporate"],
  proofPointLabels: ["Location", "Certified", "Enrolment"],
};

const LOGISTICS: PremiumV2CategoryPreset = {
  category: "logistics",
  label: "Logistics / delivery",
  headlineTemplate: (b, c) =>
    asString(c?.offerDetails) || `Reliable Delivery${location(b) ? ` in ${location(b)}` : ""}`,
  subheadlineTemplate: (b, c) =>
    asString(c?.mainPainPoint)
      ? `On-time logistics you can trust.`
      : `Transport, freight and delivery services${location(b) ? ` across ${location(b)}` : ""}.`,
  defaultCta: "Get a Quote",
  defaultDensity: "premium_services",
  defaultVisualStyle: "bold",
  priorityServiceKeywords: ["delivery", "freight", "transport", "warehouse", "storage"],
  compactServiceKeywords: ["tracking", "insurance", "packaging"],
  proofPointLabels: ["Location", "On-time", "Quote"],
};

const GENERAL: PremiumV2CategoryPreset = {
  category: "general",
  label: "General",
  headlineTemplate: (b, c) =>
    asString(c?.offerDetails) || `${name(b) || "Quality"} Services${location(b) ? ` in ${location(b)}` : ""}`,
  subheadlineTemplate: (b, c) =>
    asString(c?.mainPainPoint)
      ? `Helping you ${(c!.mainPainPoint as string).toLowerCase()}.`
      : `Trusted support for customers${location(b) ? ` in ${location(b)}` : ""}.`,
  defaultCta: "Get in Touch Today",
  defaultDensity: "premium_services",
  defaultVisualStyle: "modern",
  priorityServiceKeywords: [],
  compactServiceKeywords: [],
  proofPointLabels: ["Location", "Trusted"],
};

const PRESETS: Record<PremiumV2BusinessCategory, PremiumV2CategoryPreset> = {
  local_services: LOCAL_SERVICES,
  retail_product: RETAIL_PRODUCT,
  food_restaurant: FOOD_RESTAURANT,
  professional_services: PROFESSIONAL_SERVICES,
  print_courier: PRINT_COURIER,
  beauty_wellness: BEAUTY_WELLNESS,
  healthcare_wellness: HEALTHCARE_WELLNESS,
  training_education: TRAINING_EDUCATION,
  logistics: LOGISTICS,
  general: GENERAL,
};

export function getCategoryPreset(category: PremiumV2BusinessCategory): PremiumV2CategoryPreset {
  return PRESETS[category] || GENERAL;
}

export function sortServicesByPreset(
  services: string[],
  preset: PremiumV2CategoryPreset
): string[] {
  const priority = preset.priorityServiceKeywords;
  const compact = preset.compactServiceKeywords;

  const score = (svc: string): number => {
    const lower = svc.toLowerCase();
    let s = 0;
    for (let i = 0; i < priority.length; i++) {
      if (lower.includes(priority[i].toLowerCase())) s += priority.length - i + 10;
    }
    for (let i = 0; i < compact.length; i++) {
      if (lower.includes(compact[i].toLowerCase())) s -= compact.length - i + 5;
    }
    return s;
  };

  return [...services].sort((a, b) => score(b) - score(a));
}
