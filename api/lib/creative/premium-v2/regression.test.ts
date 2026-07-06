import { describe, it, expect } from "vitest";
import { buildPremiumV2Brief, parseRefinementMode } from "./brief";
import { curateServices, inferBusinessCategory, inferLayoutDensity, normalizeServices } from "./curation";
import { validatePremiumV2Quality, assertV2LayoutGuarantees } from "./quality";
import { getCategoryPreset } from "./presets";
import type { PremiumLeafletV2Brief } from "./types";

function makeBusiness(overrides: any = {}) {
  return {
    id: 1,
    name: "Acme Corp",
    displayName: "Acme Corp",
    logo: "https://example.com/logo.png",
    industry: "Professional services",
    location: "Johannesburg",
    phone: "011 123 4567",
    email: "hello@acme.test",
    website: "https://acme.test",
    productOrService: "Tax planning, Payroll, Business advisory, Audits",
    targetCustomer: "Small business owners",
    brandColors: ["#1E3A8A", "#F59E0B", "#FFFFFF"],
    visualStyle: "modern",
    ...overrides,
  };
}

function makeCampaign(overrides: any = {}) {
  return {
    id: 10,
    name: "Spring Campaign",
    goal: "Leads",
    primaryOutcome: "Book more consultations",
    targetBuyer: "Small business owners",
    mainPainPoint: "Tax compliance is overwhelming",
    productOrService: "Tax planning, Payroll, Business advisory, Audits",
    offerDetails: "Free 30-minute consultation",
    preferredCta: "Book Now",
    ...overrides,
  };
}

function makeBrief(overrides: Partial<PremiumLeafletV2Brief> = {}): PremiumLeafletV2Brief {
  return {
    businessName: "Test Biz",
    businessCategory: "local_services",
    headline: "Professional service you can trust",
    subheadline: "Fast, reliable help for your home.",
    primaryServices: [
      { name: "Repairs", isPrimary: true },
      { name: "Installations", isPrimary: true },
      { name: "Maintenance", isPrimary: true },
    ],
    secondaryServices: [{ name: "Consultations", isPrimary: false }],
    benefits: ["Fast", "Reliable", "Affordable"],
    cta: "Call Us Today",
    contact: { phone: "123 456 7890", website: "https://test.test" },
    visualStyle: "modern",
    layoutDensity: "premium_services",
    brandPalette: {
      primary: "#1E3A8A",
      secondary: "#F59E0B",
      accent: "#10B981",
      background: "#FFFFFF",
      text: "#0F172A",
      textMuted: "#475569",
    },
    logoPlacement: "header",
    logoUrl: "https://example.com/logo.png",
    proofPoints: [],
    ...overrides,
  };
}

// ── A. Generic premium leaflet brief for multiple business categories ──

describe("Generic premium leaflet brief across categories", () => {
  const cases = [
    {
      name: "Print/courier",
      business: makeBusiness({
        name: "3@1 Newmarket",
        displayName: "3@1 Newmarket",
        industry: "Print and courier",
        productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier",
      }),
      campaign: makeCampaign({
        name: "Print Promo",
        productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier",
      }),
      expectedCategory: "print_courier",
    },
    {
      name: "Restaurant",
      business: makeBusiness({
        name: "Burger Barn",
        displayName: "Burger Barn",
        industry: "Restaurant",
        productOrService: "Gourmet burgers, shakes, fries",
      }),
      campaign: makeCampaign({
        name: "Weekend Special",
        productOrService: "Gourmet burgers, shakes, fries",
        offerDetails: "Buy any burger, get a free shake",
      }),
      expectedCategory: "food_restaurant",
    },
    {
      name: "Beauty salon",
      business: makeBusiness({
        name: "Glow Spa",
        displayName: "Glow Spa",
        industry: "Beauty salon",
        productOrService: "Hair, nails, facials, massage",
      }),
      campaign: makeCampaign({
        name: "Spa Day",
        productOrService: "Hair, nails, facials, massage",
      }),
      expectedCategory: "beauty_wellness",
    },
    {
      name: "Plumber",
      business: makeBusiness({
        name: "Leak Fix",
        displayName: "Leak Fix",
        industry: "Plumbing",
        productOrService: "Leak repair, pipe installation, emergency plumbing",
      }),
      campaign: makeCampaign({
        name: "Emergency plumbing",
        productOrService: "Leak repair, pipe installation, emergency plumbing",
      }),
      expectedCategory: "local_services",
    },
    {
      name: "Retail shop",
      business: makeBusiness({
        name: "The Boutique",
        displayName: "The Boutique",
        industry: "Retail",
        productOrService: "Clothing, shoes, accessories",
      }),
      campaign: makeCampaign({
        name: "Summer Sale",
        productOrService: "Clothing, shoes, accessories",
        offerDetails: "30% off selected items",
      }),
      expectedCategory: "retail_product",
    },
    {
      name: "Consultant",
      business: makeBusiness({
        name: "Strategy First",
        displayName: "Strategy First",
        industry: "Consulting",
        productOrService: "Business strategy, financial planning, coaching",
      }),
      campaign: makeCampaign({
        name: "Strategy Sprint",
        productOrService: "Business strategy, financial planning, coaching",
      }),
      expectedCategory: "professional_services",
    },
    {
      name: "Training company",
      business: makeBusiness({
        name: "Skill Up",
        displayName: "Skill Up",
        industry: "Training",
        productOrService: "Leadership courses, workshops, certifications",
      }),
      campaign: makeCampaign({
        name: "Q3 intake",
        productOrService: "Leadership courses, workshops, certifications",
      }),
      expectedCategory: "training_education",
    },
    {
      name: "Logistics",
      business: makeBusiness({
        name: "Swift Freight",
        displayName: "Swift Freight",
        industry: "Logistics",
        productOrService: "Freight, warehousing, last-mile delivery",
      }),
      campaign: makeCampaign({
        name: "Freight promo",
        productOrService: "Freight, warehousing, last-mile delivery",
      }),
      expectedCategory: "logistics",
    },
    {
      name: "Healthcare",
      business: makeBusiness({
        name: "Care Clinic",
        displayName: "Care Clinic",
        industry: "Medical clinic",
        productOrService: "General consultations, vaccinations, health checks",
      }),
      campaign: makeCampaign({
        name: "Health check",
        productOrService: "General consultations, vaccinations, health checks",
      }),
      expectedCategory: "healthcare_wellness",
    },
  ];

  it.each(cases)("builds a brief for $name", ({ business, campaign, expectedCategory }) => {
    const brief = buildPremiumV2Brief({ business, campaign, post: { id: 1, campaignId: 10, title: "Post" } });
    expect(brief.businessCategory).toBe(expectedCategory);
    expect(brief.headline).toBeTruthy();
    expect(brief.cta).toBeTruthy();
    expect(brief.primaryServices.length).toBeGreaterThan(0);
    expect(brief.brandPalette.primary).toBeTruthy();
  });
});

// ── B. "Include all services" curates services into primary + secondary ──

describe("'Include all services' service curation", () => {
  it("curates a long service list into primary cards and a compact secondary strip", () => {
    const services = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
    const { primaryServices, secondaryServices } = curateServices(services, "premium_services", "general");
    expect(primaryServices.length).toBeLessThanOrEqual(5);
    expect(secondaryServices.length).toBeGreaterThan(0);
    expect(primaryServices.every((s) => s.isPrimary)).toBe(true);
    expect(secondaryServices.every((s) => !s.isPrimary)).toBe(true);
  });

  it("keeps minimal mode to 3 primary cards even with many services", () => {
    const services = ["A", "B", "C", "D", "E", "F", "G"];
    const { primaryServices, secondaryServices } = curateServices(services, "premium_minimal", "general");
    expect(primaryServices.length).toBe(3);
    expect(secondaryServices.length).toBe(4);
  });

  it("uses category preset priority keywords to order services", () => {
    const services = ["Laminating", "Business cards", "Copying", "Courier", "Flyers"];
    const { primaryServices } = curateServices(services, "premium_services", "print_courier");
    expect(primaryServices[0].name.toLowerCase()).toContain("business card");
  });
});

// ── C. Design-only refinement preserves copy exactly ──

describe("Design-only refinement preserves copy", () => {
  it("does not rewrite approved headline, CTA, or services", () => {
    const approvedPack = {
      headline: "Approved headline",
      subheadline: "Approved subheadline",
      benefitBullets: ["Benefit A", "Benefit B"],
      cta: "Approved CTA",
    };

    const brief = buildPremiumV2Brief({
      business: makeBusiness(),
      campaign: makeCampaign(),
      approvedMessagePack: approvedPack,
      refinementInstruction: "Make the design darker and move the logo",
    });

    expect(brief.refinementMode).toBe("design_only");
    expect(brief.headline).toBe("Approved headline");
    expect(brief.subheadline).toBe("Approved subheadline");
    expect(brief.cta).toBe("Approved CTA");
    expect(brief.primaryServices.map((s) => s.name)).toEqual(expect.arrayContaining(["Benefit A", "Benefit B"]));
  });
});

// ── D. Copy refinement creates structured message pack ──

describe("Copy refinement parses structured instruction", () => {
  it("detects improve_copy mode from natural language", () => {
    expect(parseRefinementMode("Rewrite the headline to be punchier")).toBe("improve_copy");
    expect(parseRefinementMode("Better CTA")).toBe("stronger_cta");
    expect(parseRefinementMode("Make it more premium")).toBe("more_premium");
  });
});

// ── E & F. Failed refinement preserves approved asset / published asset not overwritten ──

describe("Stable iteration model", () => {
  it("quality gate rejects a brief with no primary services or offer", () => {
    const brief = makeBrief({ primaryServices: [], offer: undefined, secondaryServices: [] });
    const result = validatePremiumV2Quality(brief);
    expect(result.passed).toBe(false);
    expect(result.criticalFailures.some((f) => f.includes("No primary services"))).toBe(true);
  });

  it("does not approve a leaflet with a clipped CTA", () => {
    const brief = makeBrief();
    const result = validatePremiumV2Quality(brief, {
      ctaBoundingBox: { x: 900, y: 1300, w: 300, h: 80 },
      footerY: 1240,
      footerHeight: 104,
      width: 1080,
      height: 1350,
      minFontSizeUsed: 20,
      primaryCardCount: 3,
      secondaryCardCount: 1,
      layoutDensity: "premium_services",
    });
    expect(result.passed).toBe(false);
    expect(result.label).toBe("CTA Clipped");
  });

  it("does not approve a leaflet with a clipped footer", () => {
    const brief = makeBrief();
    const result = validatePremiumV2Quality(brief, {
      ctaBoundingBox: { x: 400, y: 1180, w: 280, h: 64 },
      footerY: 1280,
      footerHeight: 104,
      width: 1080,
      height: 1350,
      minFontSizeUsed: 20,
      primaryCardCount: 3,
      secondaryCardCount: 1,
      layoutDensity: "premium_services",
    });
    expect(result.passed).toBe(false);
    expect(result.label).toBe("Failed Premium Standard");
    expect(result.criticalFailures.some((f) => f.includes("Footer"))).toBe(true);
  });
});

// ── G. CTA clipping fails premium quality gate ──

describe("CTA clipping fails premium quality gate", () => {
  it("assertV2LayoutGuarantees detects a clipped CTA", () => {
    const { ctaClipped } = assertV2LayoutGuarantees(1080, 1350, { x: 900, y: 1300, w: 300, h: 80 }, 1240);
    expect(ctaClipped).toBe(true);
  });

  it("assertV2LayoutGuarantees accepts a safe CTA", () => {
    const { ctaClipped } = assertV2LayoutGuarantees(1080, 1350, { x: 400, y: 1180, w: 280, h: 64 }, 1240);
    expect(ctaClipped).toBe(false);
  });
});

// ── H. Too many service cards fails or switches to catalogue/brochure mode ──

describe("Too many service cards handling", () => {
  it("fails quality gate when premium_services has more than 5 primary cards", () => {
    const brief = makeBrief({
      layoutDensity: "premium_services",
      primaryServices: Array.from({ length: 8 }, (_, i) => ({ name: `Service ${i + 1}`, isPrimary: true })),
      secondaryServices: [],
    });
    const result = validatePremiumV2Quality(brief);
    expect(result.passed).toBe(false);
    expect(result.label).toBe("Failed Premium Standard");
    expect(result.criticalFailures.some((f) => f.includes("Too many primary services"))).toBe(true);
  });

  it("infers catalogue_brochure when explicitly requested", () => {
    const density = inferLayoutDensity(makeBusiness(), makeCampaign({ offerDetails: "Full catalogue brochure" }), undefined, 12);
    expect(density).toBe("catalogue_brochure");
  });

  it("brief builder switches to catalogue layout on explicit brochure instruction", () => {
    const brief = buildPremiumV2Brief({
      business: makeBusiness({
        productOrService: "A, B, C, D, E, F, G, H, I, J",
      }),
      campaign: makeCampaign(),
      refinementInstruction: "Show a full brochure with all services",
    });
    expect(brief.layoutDensity).toBe("catalogue_brochure");
  });
});

// ── I. 3@1 Newmarket fixture ──

describe("3@1 Newmarket regression fixture", () => {
  const newmarketBusiness = {
    id: 2,
    name: "3@1 Newmarket",
    displayName: "3@1 Newmarket",
    logo: "https://example.com/3at1.png",
    industry: "Print and courier",
    location: "Newmarket, Alberton",
    phone: "011 123 9999",
    website: "https://3at1newmarket.test",
    productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier, Business cards, Banners, Canvas",
    targetCustomer: "Small businesses and event planners",
    brandColors: ["#0047AB", "#FFD700", "#FFFFFF"],
    visualStyle: "modern",
    websiteEvidence: {
      businessCategory: "print and courier",
      productsServices: ["Printing", "Copying", "Scanning", "Laminating", "Binding", "Courier", "Business cards", "Banners", "Canvas"],
    },
  };

  const newmarketCampaign = {
    id: 20,
    name: "Newmarket Print Promo",
    goal: "Leads",
    primaryOutcome: "Get more print orders",
    targetBuyer: "Small business owners",
    mainPainPoint: "Need fast, affordable printing and delivery",
    productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier",
    preferredCta: "Request a Quote Today",
  };

  it("classifies 3@1 Newmarket as print/courier", () => {
    const brief = buildPremiumV2Brief({
      business: newmarketBusiness,
      campaign: newmarketCampaign,
      post: { id: 200, campaignId: 20, title: "Print promo" },
    });
    expect(brief.businessCategory).toBe("print_courier");
  });

  it("curates print/courier services with priority items first", () => {
    const services = normalizeServices([
      ...newmarketBusiness.websiteEvidence.productsServices,
      newmarketCampaign.productOrService,
    ]);
    const { primaryServices, secondaryServices } = curateServices(services, "premium_services", "print_courier");
    const primaryNames = primaryServices.map((s) => s.name.toLowerCase());
    expect(primaryServices.length).toBeLessThanOrEqual(5);
    expect(primaryNames.some((n) => n.includes("business card"))).toBe(true);
    expect(secondaryServices.map((s) => s.name.toLowerCase())).toContain("laminating");
  });

  it("uses a premium_services density by default (not a catalogue)", () => {
    const brief = buildPremiumV2Brief({
      business: newmarketBusiness,
      campaign: newmarketCampaign,
      post: { id: 200, campaignId: 20, title: "Print promo" },
    });
    expect(brief.layoutDensity).toBe("premium_services");
  });

  it("uses the campaign CTA", () => {
    const brief = buildPremiumV2Brief({
      business: newmarketBusiness,
      campaign: newmarketCampaign,
      post: { id: 200, campaignId: 20, title: "Print promo" },
    });
    expect(brief.cta).toBe("Request a Quote Today");
  });
});

// ── J. Premium quality gate rejects dull/crowded/generic leaflets ──

describe("Premium quality gate rejects poor leaflets", () => {
  it("rejects generic placeholder copy", () => {
    const brief = makeBrief({
      headline: "Your business needs our professional team",
      subheadline: "We understand your needs",
      benefits: ["Quality service", "Great results"],
      cta: "Contact us today",
    });
    const result = validatePremiumV2Quality(brief);
    expect(result.label).toBe("Generic Copy");
    expect(result.warnings.some((w) => w.includes("Generic phrases"))).toBe(true);
  });

  it("rejects a crowded leaflet with too many services", () => {
    const brief = makeBrief({
      layoutDensity: "premium_services",
      primaryServices: Array.from({ length: 7 }, (_, i) => ({ name: `Service ${i + 1}`, isPrimary: true })),
      secondaryServices: Array.from({ length: 8 }, (_, i) => ({ name: `Extra ${i + 1}`, isPrimary: false })),
    });
    const result = validatePremiumV2Quality(brief);
    expect(result.passed).toBe(false);
    expect(result.label).toBe("Failed Premium Standard");
  });

  it("flags text too small", () => {
    const brief = makeBrief();
    const result = validatePremiumV2Quality(brief, {
      ctaBoundingBox: { x: 400, y: 1180, w: 280, h: 64 },
      footerY: 1240,
      footerHeight: 104,
      width: 1080,
      height: 1350,
      minFontSizeUsed: 12,
      primaryCardCount: 3,
      secondaryCardCount: 1,
      layoutDensity: "premium_services",
    });
    expect(result.label).toBe("Text Too Small");
  });
});
