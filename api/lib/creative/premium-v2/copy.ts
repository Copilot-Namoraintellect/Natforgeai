/**
 * Premium Leaflet V2 – commercial copy helpers.
 *
 * Generates category-specific, benefit-led headline, subheadline, CTA and
 * benefit lines while rejecting weak or placeholder phrasing.
 */

import type { BusinessEvidence, CampaignEvidence } from "./curation";
import { asString, inferBusinessCategory } from "./curation";
import { getCategoryPreset } from "./presets";

export const WEAK_PHRASES = [
  "solves need",
  "need fast",
  "your business",
  "your brand",
  "your company",
  "your service",
  "your product",
  "your needs",
  "unlock success",
  "transform your business",
  "professional team",
  "quality service",
  "great results",
  "learn more",
  "contact us today",
  "best choice",
  "marketing campaign",
  "promotional material",
  "we understand",
  "seamless solutions",
];

function businessName(business: BusinessEvidence): string {
  return asString(business.displayName || business.name) || "";
}

function location(business: BusinessEvidence, campaign?: CampaignEvidence): string {
  return (
    asString(business.address || business.location) ||
    asString((business.websiteEvidence as any)?.location) ||
    asString(campaign?.name) ||
    ""
  );
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export { isWeak };
function isWeak(text?: string): boolean {
  if (!text) return true;
  const lower = text.toLowerCase();
  return WEAK_PHRASES.some((phrase) => lower.includes(phrase));
}

export function rejectWeakCopy(text: string, fallback: string): string {
  return isWeak(text) ? fallback : clean(text);
}

export function buildCommercialHeadline(business: BusinessEvidence, campaign?: CampaignEvidence): string {
  const category = inferBusinessCategory(business, campaign);
  const preset = getCategoryPreset(category);
  const name = businessName(business);
  const loc = location(business, campaign);

  // Campaign offer details can override when explicitly promotional.
  if (asString(campaign?.offerDetails) && category === "retail_product") {
    return clean(campaign!.offerDetails as string);
  }

  switch (category) {
    case "print_courier":
      return loc
        ? `Professional Printing, Courier & Business Services in ${loc}`
        : `Print, Courier & Business Services Made Simple`;
    case "food_restaurant":
      return loc ? `Fresh Food & Local Favourites in ${loc}` : `${name || "Delicious Food"} You’ll Love`;
    case "beauty_wellness":
      return loc ? `Look and Feel Your Best in ${loc}` : `${name || "Beauty & Wellness"} Treatments`;
    case "local_services":
      return loc ? `Fast, Reliable Service in ${loc}` : `${name || "Trusted"} Local Services`;
    case "retail_product":
      return loc ? `${name || "Your Local"} Shop – ${loc}` : `${name || "Your Local"} Shop`;
    case "professional_services":
      return `${name || "Expert"} Advice You Can Trust`;
    case "training_education":
      return `Learn with ${name || "the Experts"}`;
    case "logistics":
      return loc ? `Reliable Delivery in ${loc}` : `Reliable Delivery & Logistics`;
    case "healthcare_wellness":
      return loc ? `Care You Can Count On in ${loc}` : `Care You Can Count On`;
    default:
      return preset.headlineTemplate(business, campaign);
  }
}

export function buildCommercialSubheadline(business: BusinessEvidence, campaign?: CampaignEvidence): string {
  const category = inferBusinessCategory(business, campaign);
  const name = businessName(business);
  const loc = location(business, campaign);

  switch (category) {
    case "print_courier":
      return name
        ? `From flyers and business cards to canvas prints and courier support, get reliable local service from ${name}.`
        : `From flyers and business cards to canvas prints and courier support, get reliable local service.`;
    case "food_restaurant":
      return `Fresh ingredients, generous portions and easy ordering for dine-in, takeaway or delivery.`;
    case "beauty_wellness":
      return `Professional treatments in a calm, welcoming space${loc ? ` in ${loc}` : ""}.`;
    case "local_services":
      return `Professional help for homes and businesses${loc ? ` in ${loc}` : ""}.`;
    case "retail_product":
      return `Quality products, great prices${loc ? `, right here in ${loc}` : ""}.`;
    case "professional_services":
      return `Professional support for growing businesses${loc ? ` in ${loc}` : ""}.`;
    case "training_education":
      return `Practical courses and workshops${loc ? ` in ${loc}` : ""} to build real skills.`;
    case "logistics":
      return `Transport, freight and delivery services${loc ? ` across ${loc}` : ""}.`;
    case "healthcare_wellness":
      return `Compassionate, professional care for your health and wellbeing.`;
    default:
      return `Trusted support for customers${loc ? ` in ${loc}` : ""}.`;
  }
}

export function buildCommercialBenefits(business: BusinessEvidence, campaign?: CampaignEvidence): string[] {
  const category = inferBusinessCategory(business, campaign);

  switch (category) {
    case "print_courier":
      return [
        "Fast turnaround for urgent print and document needs",
        "Professional materials for promotions, events and daily business",
        "Convenient local support for printing, finishing and courier delivery",
      ];
    case "food_restaurant":
      return [
        "Fresh ingredients prepared daily",
        "Quick dine-in, takeaway or delivery options",
        "Great value meals for every appetite",
      ];
    case "beauty_wellness":
      return [
        "Qualified therapists and stylists",
        "Calm, hygienic treatment environment",
        "Flexible booking times that suit you",
      ];
    case "local_services":
      return [
        "Fast response for urgent jobs",
        "Licensed, experienced professionals",
        "Clear quotes before any work begins",
      ];
    case "retail_product":
      return [
        "Curated quality products in stock",
        "Friendly, knowledgeable staff",
        "Convenient local shopping experience",
      ];
    case "professional_services":
      return [
        "Clear, expert guidance tailored to you",
        "Proven processes that save time",
        "Transparent fees and honest advice",
      ];
    case "training_education":
      return [
        "Practical, real-world skills",
        "Experienced instructors",
        "Flexible learning options",
      ];
    case "logistics":
      return [
        "On-time collection and delivery",
        "Trackable shipments",
        "Competitive rates for regular bookings",
      ];
    case "healthcare_wellness":
      return [
        "Registered healthcare professionals",
        "Patient-centred care",
        "Convenient appointment times",
      ];
    default:
      return [
        "Reliable service you can count on",
        "Friendly, professional team",
        "Local support when you need it",
      ];
  }
}

export function getServiceMicrocopy(category: string, serviceName: string): string {
  const lower = serviceName.toLowerCase();

  const printCourierMap: Record<string, string> = {
    "business cards": "Professional cards that make a strong first impression.",
    "business cards & flyers": "Professional materials for promotions, events and daily business.",
    flyers: "Eye-catching flyers to promote events, offers and openings.",
    banners: "Bold banners for events, storefronts and trade shows.",
    posters: "High-impact posters that grab attention indoors or out.",
    "large format": "Big, vibrant prints for displays, signage and exhibitions.",
    "large format printing": "Bold posters, banners and displays that stand out.",
    "wall canvas prints": "Stretched canvas prints ready to hang at home or work.",
    canvas: "Stretched canvas prints ready to hang at home or work.",
    courier: "Reliable local collection and delivery when it matters.",
    "courier services": "Reliable local collection and delivery when it matters.",
    laminating: "Protect documents and prints for longer-lasting use.",
    binding: "Neat, professional binding for reports, booklets and manuals.",
    copying: "Fast, high-quality copies for business and personal needs.",
    copies: "Fast, high-quality copies for business and personal needs.",
    scanning: "Digitise documents quickly and accurately.",
    "custom printing": "Tailored print solutions for unique projects and branding.",
  };

  const foodMap: Record<string, string> = {
    burgers: "Juicy, flame-grilled burgers made to order.",
    pizza: "Fresh dough, quality toppings and fast baking.",
    pasta: "Hearty pasta dishes made with fresh ingredients.",
    meals: "Complete meals for lunch, dinner or a quick bite.",
    catering: "Catering options for offices, events and celebrations.",
    desserts: "Sweet treats to finish every meal on a high note.",
  };

  const beautyMap: Record<string, string> = {
    hair: "Cuts, styling and treatments by experienced professionals.",
    nails: "Manicures, pedicures and nail art in a relaxing space.",
    facial: "Refreshing facials tailored to your skin type.",
    massage: "Relaxing massages to ease tension and restore balance.",
    makeup: "Professional makeup for events, photoshoots and special days.",
    spa: "Calming spa treatments for total relaxation.",
  };

  const localServicesMap: Record<string, string> = {
    plumbing: "Fast leak repairs and professional installations.",
    electrician: "Safe, certified electrical repairs and fittings.",
    cleaning: "Thorough cleaning for homes and offices.",
    maintenance: "Reliable upkeep to keep everything running smoothly.",
    repairs: "Quick fixes for everyday problems around your property.",
    emergency: "Urgent call-outs when you need help fast.",
  };

  const retailMap: Record<string, string> = {
    clothing: "Trendy styles and wardrobe essentials.",
    shoes: "Comfortable, stylish footwear for every occasion.",
    accessories: "Finishing touches that complete your look.",
    gifts: "Thoughtful gifts for every occasion.",
    delivery: "Convenient delivery straight to your door.",
  };

  const professionalMap: Record<string, string> = {
    consulting: "Clear strategies tailored to your growth goals.",
    advisory: "Expert advice to reduce risk and drive growth.",
    strategy: "Practical plans that move your organisation forward.",
    audit: "Detailed reviews that protect and improve your finances.",
    planning: "Forward-thinking plans for long-term success.",
  };

  const trainingMap: Record<string, string> = {
    courses: "Structured courses that build job-ready skills.",
    training: "Hands-on training led by industry experts.",
    workshops: "Interactive workshops for teams and individuals.",
    certification: "Recognised certifications to boost your career.",
  };

  const mapByCategory: Record<string, Record<string, string>> = {
    print_courier: printCourierMap,
    food_restaurant: foodMap,
    beauty_wellness: beautyMap,
    local_services: localServicesMap,
    retail_product: retailMap,
    professional_services: professionalMap,
    training_education: trainingMap,
  };

  const map = mapByCategory[category] || {};
  for (const key of Object.keys(map)) {
    if (lower.includes(key)) return map[key];
  }

  const genericByCategory: Record<string, string> = {
    print_courier: "Quality print and document services for every need.",
    food_restaurant: "Delicious food made fresh and served with care.",
    beauty_wellness: "Professional treatment to help you look and feel great.",
    local_services: "Reliable help from experienced local professionals.",
    retail_product: "Quality products chosen for everyday value.",
    professional_services: "Expert support tailored to your situation.",
    training_education: "Practical learning that builds real confidence.",
    logistics: "Efficient transport and delivery you can depend on.",
    healthcare_wellness: "Professional care focused on your wellbeing.",
    general: "Reliable service from a team you can trust.",
  };

  return genericByCategory[category] || genericByCategory.general;
}

export function isWeakHeadline(headline: string, business: BusinessEvidence, _campaign?: CampaignEvidence): boolean {
  if (isWeak(headline)) return true;
  const name = businessName(business);
  // Reject "{Name} Printing in {Location}" style factual labels.
  const genericPattern = new RegExp(
    `^${escapeRegex(name)}\\s+(printing|services|shop|restaurant|salon|cleaning|plumbing|consulting|training|clinic)\\b`,
    "i"
  );
  if (name && genericPattern.test(headline)) return true;
  if (headline.length < 12) return true;
  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
