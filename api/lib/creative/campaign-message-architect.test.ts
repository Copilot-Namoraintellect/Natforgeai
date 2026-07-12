import { describe, it, expect, vi } from "vitest";

vi.mock("../agents/runner", () => ({
  runAgent: vi.fn(),
  isTestMode: vi.fn(() => true),
}));

import {
  validateCampaignCopy,
  buildDeterministicMessagePack,
  detectBusinessCategory,
  expectedCtasForCategory,
  type CampaignMessagePack,
  type ValidationContext,
} from "./campaign-message-architect";

function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    businessName: "Test Business",
    campaignName: "Spring Campaign",
    productOrService: "General services",
    targetCustomer: "Local customers",
    mainPainPoint: "Wasting time",
    offerDetails: "",
    excludedOffers: "",
    preferredCta: "",
    location: "Johannesburg",
    industry: "service",
    websiteEvidence: {
      businessCategory: "service",
      productsServices: ["General services"],
      targetCustomers: ["Local customers"],
      location: "Johannesburg",
    },
    ...overrides,
  };
}

function pack(overrides: Partial<CampaignMessagePack> = {}): CampaignMessagePack {
  return {
    headline: "Reliable general services for local customers",
    subheadline: "We help local customers stop wasting time on unreliable providers.",
    benefitBullets: [
      "Fast turnaround that fits your schedule.",
      "Transparent pricing with no hidden fees.",
      "Local Johannesburg team you can call directly.",
    ],
    cta: "Request a Quote",
    footerContact: { phone: "011-123-4567", location: "Johannesburg" },
    proofPoints: ["5 years in Johannesburg"],
    platformCaptions: [
      {
        platform: "Instagram",
        caption: "Need general services in Johannesburg? We make it simple.",
        cta: "Request a Quote",
        hashtags: ["#Johannesburg", "#LocalBusiness"],
      },
    ],
    validation: { passed: false, score: 0, rejections: [], warnings: [] },
    ...overrides,
  };
}

// ─── Industry fixtures ───

const fintechPayouts = ctx({
  businessName: "ZutoHub",
  campaignName: "Staff Payouts Campaign",
  productOrService: "Automated tip, commission and staff payout platform",
  targetCustomer: "Restaurants, salons and delivery operators with commission-based staff",
  mainPainPoint: "Manual payout admin delays staff earnings and hurts retention",
  industry: "fintech",
  websiteEvidence: {
    businessCategory: "fintech payouts",
    productsServices: ["tip payouts", "commission payouts", "staff earnings payouts", "payout automation"],
    targetCustomers: ["restaurants", "salons", "barbershops", "delivery operators"],
    location: "South Africa",
  },
});

const restaurant = ctx({
  businessName: "Braai & Brew",
  campaignName: "Weekend Specials",
  productOrService: "Wood-fired braai platters and craft beer",
  targetCustomer: "Families and groups looking for weekend dining in Sandton",
  mainPainPoint: "Struggling to find generous, share-style platters for groups",
  industry: "restaurant",
  websiteEvidence: {
    businessCategory: "restaurant",
    productsServices: ["wood-fired braai", "craft beer", "share platters", "weekend dining"],
    targetCustomers: ["families", "groups", "Sandton diners"],
    location: "Sandton",
  },
});

const printCourier = ctx({
  businessName: "PrintFast Couriers",
  campaignName: "Business Printing & Delivery",
  productOrService: "Same-day printing, business cards, flyers and courier delivery",
  targetCustomer: "Small businesses needing branded print and reliable delivery",
  mainPainPoint: "Printers miss deadlines and couriers lose visibility",
  industry: "print and courier",
  websiteEvidence: {
    businessCategory: "print and courier",
    productsServices: ["business cards", "flyers", "posters", "courier delivery", "same-day printing"],
    targetCustomers: ["small businesses", "startups", "offices"],
    location: "Cape Town",
  },
});

const beautySalon = ctx({
  businessName: "Luxe Locks",
  campaignName: "New Season Styles",
  productOrService: "Braids, dreadlock maintenance and natural hair treatments",
  targetCustomer: "Women with natural hair in Pretoria",
  mainPainPoint: "Hard to find stylists who protect natural hair while styling",
  industry: "beauty salon",
  websiteEvidence: {
    businessCategory: "beauty salon",
    productsServices: ["braids", "dreadlock maintenance", "natural hair treatments", "hair styling"],
    targetCustomers: ["women with natural hair", "Pretoria clients"],
    location: "Pretoria",
  },
});

const cleaningService = ctx({
  businessName: "Sparkle Clean",
  campaignName: "Office Cleaning Drive",
  productOrService: "Weekly office and domestic cleaning",
  targetCustomer: "Small offices and busy households in Durban",
  mainPainPoint: "Inconsistent cleaners who skip details and reschedule",
  industry: "cleaning",
  websiteEvidence: {
    businessCategory: "cleaning service",
    productsServices: ["office cleaning", "domestic cleaning", "weekly cleaning"],
    targetCustomers: ["small offices", "busy households"],
    location: "Durban",
  },
});

const ecommerceRetail = ctx({
  businessName: "Urban Kicks",
  campaignName: "Sneaker Drop",
  productOrService: "Limited-edition sneakers and streetwear",
  targetCustomer: "Sneaker enthusiasts aged 18-35 in South Africa",
  mainPainPoint: "Local buyers pay import duties and wait weeks for international drops",
  industry: "retail",
  websiteEvidence: {
    businessCategory: "e-commerce retail",
    productsServices: ["limited-edition sneakers", "streetwear", "local sneaker drops"],
    targetCustomers: ["sneaker enthusiasts", "streetwear fans"],
    location: "South Africa",
  },
});

const consulting = ctx({
  businessName: "GrowthPath Advisory",
  campaignName: "Scale-Up Strategy",
  productOrService: "Financial forecasting and growth strategy consulting",
  targetCustomer: "Founders of scaling SMEs",
  mainPainPoint: "Unclear cash flow forecasts block fundraising and hiring decisions",
  industry: "consulting",
  websiteEvidence: {
    businessCategory: "professional consulting",
    productsServices: ["financial forecasting", "growth strategy", "fundraising support"],
    targetCustomers: ["founders", "scaling SMEs"],
    location: "Johannesburg",
  },
});

const trades = ctx({
  businessName: "Sparky Pros",
  campaignName: "Electrical Safety Month",
  productOrService: "Residential and commercial electrical repairs and inspections",
  targetCustomer: "Homeowners and property managers in Centurion",
  mainPainPoint: "Electrical faults that go unfixed cause safety risks and tenant complaints",
  industry: "electrical services",
  websiteEvidence: {
    businessCategory: "local trades",
    productsServices: ["electrical repairs", "safety inspections", "fault finding", "rewiring"],
    targetCustomers: ["homeowners", "property managers"],
    location: "Centurion",
  },
});

const education = ctx({
  businessName: "CodeLift Academy",
  campaignName: "Part-Time Coding Bootcamp",
  productOrService: "Part-time full-stack coding bootcamp for working professionals",
  targetCustomer: "Working professionals switching to tech careers",
  mainPainPoint: "Evening and weekend courses lack practical portfolio projects",
  industry: "education",
  websiteEvidence: {
    businessCategory: "education and training",
    productsServices: ["coding bootcamp", "web development course", "portfolio projects", "career coaching"],
    targetCustomers: ["working professionals", "career switchers"],
    location: "Cape Town",
  },
});

const healthcare = ctx({
  businessName: "Stillpoint Wellness",
  campaignName: "Stress Relief Sessions",
  productOrService: "Massage therapy and guided relaxation sessions",
  targetCustomer: "Professionals dealing with chronic tension and stress",
  mainPainPoint: "Long work hours create neck, shoulder and back tension that affects sleep",
  industry: "wellness",
  websiteEvidence: {
    businessCategory: "health and wellness",
    productsServices: ["massage therapy", "relaxation sessions", "stress relief", "guided relaxation"],
    targetCustomers: ["professionals", "stressed clients"],
    location: "Durban",
  },
});

// ─── Industry-specific tests ───

describe("Campaign Message Architect — industry fixtures", () => {
  it.each([
    { name: "fintech payouts", ctx: fintechPayouts, expectedCta: "Book a Demo" },
    { name: "restaurant", ctx: restaurant, expectedCta: "Order Now" },
    { name: "print/courier", ctx: printCourier, expectedCta: "Request a Quote" },
    { name: "beauty salon", ctx: beautySalon, expectedCta: "Book Now" },
    { name: "cleaning service", ctx: cleaningService, expectedCta: "Get a Quote" },
    { name: "e-commerce/retail", ctx: ecommerceRetail, expectedCta: "Shop Now" },
    { name: "consulting", ctx: consulting, expectedCta: "Book a Consultation" },
    { name: "trades/electrician", ctx: trades, expectedCta: "Request a Quote" },
    { name: "education/bootcamp", ctx: education, expectedCta: "Enrol Now" },
    { name: "healthcare/wellness", ctx: healthcare, expectedCta: "Book a Session" },
  ])("generates specific, non-generic copy for $name", ({ ctx, expectedCta }) => {
    const messagePack = buildDeterministicMessagePack(ctx);

    expect(messagePack.validation.passed).toBe(true);
    expect(messagePack.headline.toLowerCase()).not.toContain("marketing campaign");
    expect(messagePack.headline.toLowerCase()).not.toBe(ctx.campaignName.toLowerCase());
    expect(messagePack.headline.toLowerCase()).not.toBe(ctx.businessName.toLowerCase());

    const allCopy = [
      messagePack.headline,
      messagePack.subheadline,
      ...messagePack.benefitBullets,
      messagePack.cta,
    ]
      .join(" ")
      .toLowerCase();

    const productTerms = [
      ...(ctx.websiteEvidence?.productsServices || []),
      ctx.productOrService,
    ]
      .flatMap((p) => p.split(/\s+/))
      .map((t) => t.toLowerCase())
      .filter((t) => t.length > 3);
    const hasProduct = productTerms.some((t) => allCopy.includes(t));
    expect(hasProduct).toBe(true);

    const customerTerms = [
      ...(ctx.websiteEvidence?.targetCustomers || []),
      ctx.targetCustomer || "",
    ]
      .flatMap((p) => p.split(/\s+/))
      .map((t) => t.toLowerCase())
      .filter((t) => t.length > 3);
    const painTerms = (ctx.mainPainPoint || "").split(/\s+/).map((t) => t.toLowerCase()).filter((t) => t.length > 3);
    const hasAudience = customerTerms.some((t) => allCopy.includes(t)) || painTerms.some((t) => allCopy.includes(t));
    expect(hasAudience).toBe(true);

    const genericPhrases = ["transform your business", "revolutionise", "unlock success", "marketing campaign"];
    for (const phrase of genericPhrases) {
      expect(allCopy).not.toContain(phrase);
    }

    expect(messagePack.cta.toLowerCase()).toContain(expectedCta.toLowerCase().split(" ")[0]);
    expect(messagePack.benefitBullets.length).toBeGreaterThanOrEqual(3);
  });

  it("selects the conversion CTA from multi-stage preferred CTA mapping", () => {
    const messagePack = buildDeterministicMessagePack(
      ctx({
        preferredCta: "Awareness: Learn More\nConsideration: Get Pricing\nConversion: Book a Demo",
        campaignObjective: "conversion",
        funnelStage: "conversion",
      })
    );

    expect(messagePack.cta).toBe("Book a Demo");
    expect(messagePack.validation.passed).toBe(true);
  });
});

// ─── Validation rules ───

describe("validateCampaignCopy", () => {
  it("passes for specific, grounded copy", () => {
    const result = validateCampaignCopy(pack(), ctx());
    expect(result.passed).toBe(true);
    expect(result.rejections).toHaveLength(0);
  });

  it("rejects when headline is the campaign name only", () => {
    const bad = pack({ headline: "Spring Campaign" });
    const result = validateCampaignCopy(bad, ctx({ campaignName: "Spring Campaign" }));
    expect(result.passed).toBe(false);
    expect(result.rejections.some((r) => r.includes("campaign or business name only"))).toBe(true);
  });

  it("rejects when headline is the business name + 'Marketing Campaign'", () => {
    const bad = pack({
      headline: "Test Business Marketing Campaign",
      platformCaptions: [],
    });
    const result = validateCampaignCopy(bad, ctx());
    expect(result.passed).toBe(false);
    expect(result.rejections.some((r) => r.includes("campaign or business name only"))).toBe(true);
  });

  it("rejects when no specific product/service appears", () => {
    const bad = pack({
      headline: "The best choice for your business",
      subheadline: "We help businesses grow and succeed.",
      benefitBullets: ["Quality service", "Professional team", "Great results"],
      platformCaptions: [],
    });
    const result = validateCampaignCopy(bad, ctx({ productOrService: "automated payroll software" }));
    expect(result.passed).toBe(false);
    expect(result.rejections.some((r) => r.includes("product/service"))).toBe(true);
  });

  it("rejects when no target customer or pain point appears", () => {
    const bad = pack({
      headline: "Automated payroll software",
      subheadline: "Powerful features for growing companies.",
      benefitBullets: ["Cloud based", "Easy setup", "Reliable support"],
      platformCaptions: [],
    });
    const result = validateCampaignCopy(
      bad,
      ctx({
        productOrService: "automated payroll software",
        targetCustomer: "small HR teams",
        mainPainPoint: "manual spreadsheet errors",
      })
    );
    expect(result.passed).toBe(false);
    expect(result.rejections.some((r) => r.includes("target customer or their pain point"))).toBe(true);
  });

  it("rejects generic CTAs", () => {
    const bad = pack({ cta: "Learn more" });
    const result = validateCampaignCopy(bad, ctx());
    expect(result.passed).toBe(false);
    expect(result.rejections.some((r) => r.includes("CTA") && r.includes("generic"))).toBe(true);
  });

  it("rejects invented offers when no offer is provided", () => {
    const bad = pack({
      headline: "Get 20% off your first order",
      subheadline: "Limited time only.",
      benefitBullets: ["Save money", "Great value", "Fast delivery"],
    });
    const result = validateCampaignCopy(bad, ctx({ offerDetails: "" }));
    expect(result.passed).toBe(false);
    expect(result.rejections.some((r) => r.includes("Invented offer"))).toBe(true);
  });

  it("rejects invented 'free assessment' when offer does not mention free", () => {
    const bad = pack({ cta: "Get a Free Assessment" });
    const result = validateCampaignCopy(bad, ctx({ offerDetails: "15% off first clean" }));
    expect(result.passed).toBe(false);
    expect(result.rejections.some((r) => r.includes("Free assessment"))).toBe(true);
  });

  it("allows 'free' only when explicitly provided in the offer", () => {
    const good = pack({ cta: "Get a Free Assessment" });
    const result = validateCampaignCopy(good, ctx({ offerDetails: "Free assessment for new clients" }));
    expect(result.rejections.some((r) => r.includes("Free assessment"))).toBe(false);
  });

  it("rejects generic placeholder language", () => {
    const bad = pack({
      headline: "[Your Business] Marketing Campaign",
      subheadline: "Transform your business today.",
    });
    const result = validateCampaignCopy(bad, ctx());
    expect(result.passed).toBe(false);
    expect(result.rejections.some((r) => r.includes("Placeholder"))).toBe(true);
  });

  it("warns when copy could apply to any business", () => {
    const vague = pack({
      headline: "Quality service for your business",
      subheadline: "Trusted by local customers.",
      benefitBullets: ["Professional team", "Great quality", "Reliable service"],
      platformCaptions: [],
    });
    const result = validateCampaignCopy(
      vague,
      ctx({
        productOrService: "custom software development",
        websiteEvidence: {
          productsServices: ["custom software development"],
          targetCustomers: ["scaling startups"],
        },
      })
    );
    expect(result.warnings.some((w) => w.includes("any business"))).toBe(true);
  });

  it("allows grounded benefits even without numeric claims", () => {
    const vague = pack({
      benefitBullets: ["We care", "We are professional", "We are local"],
    });
    const result = validateCampaignCopy(
      vague,
      ctx({
        productOrService: "Automated payroll software",
        targetCustomer: "HR managers",
        mainPainPoint: "manual spreadsheet errors",
      })
    );
    expect(result.passed).toBe(true);
  });

  it("rejects invented loan/BNPL claim", () => {
    const bad = pack({
      headline: "Get a business loan today",
      subheadline: "Easy BNPL for small businesses.",
    });
    const result = validateCampaignCopy(bad, ctx({ offerDetails: "" }));
    expect(result.passed).toBe(false);
    expect(result.rejections.some((r) => /\b(loan|BNPL)\b/i.test(r))).toBe(true);
  });

  it("rejects invented guarantee claim", () => {
    const bad = pack({
      headline: "Money-back guarantee on every service",
      subheadline: "We guarantee results or your money back.",
    });
    const result = validateCampaignCopy(bad, ctx({ offerDetails: "" }));
    expect(result.passed).toBe(false);
    expect(result.rejections.some((r) => r.toLowerCase().includes("guarantee"))).toBe(true);
  });

  it("rejects invented same-day claim", () => {
    const bad = pack({
      headline: "Same-day service for local customers",
      subheadline: "We arrive the same day you call.",
    });
    const result = validateCampaignCopy(bad, ctx({ offerDetails: "" }));
    expect(result.passed).toBe(false);
    expect(result.rejections.some((r) => r.toLowerCase().includes("same-day"))).toBe(true);
  });

  it("rejects copy that could apply to any business", () => {
    const vague = pack({
      headline: "Quality service for your business",
      subheadline: "Trusted professional local company serving customers.",
      benefitBullets: ["Professional team", "Great quality", "Reliable service"],
      platformCaptions: [],
    });
    const result = validateCampaignCopy(
      vague,
      ctx({
        productOrService: "custom software development",
        websiteEvidence: {
          productsServices: ["custom software development"],
          targetCustomers: ["scaling startups"],
        },
      })
    );
    expect(result.warnings.some((w) => w.includes("any business"))).toBe(true);
  });

  it.each([
    { headline: "The best choice for your brand", phrase: "your brand" },
    { headline: "We help your business grow", phrase: "your business" },
    { headline: "Transform your brand today", phrase: "transform your brand" },
  ])("rejects placeholder language: $phrase", ({ headline, phrase }) => {
    const bad = pack({
      headline,
      subheadline: "Unlock success with our revolutionary service.",
      benefitBullets: ["Quality service", "Professional team", "Great results"],
      cta: "Learn more",
    });
    const result = validateCampaignCopy(bad, ctx());
    expect(result.passed).toBe(false);
    expect(
      result.rejections.some(
        (r) =>
          r.toLowerCase().includes(phrase.toLowerCase()) ||
          r.toLowerCase().includes("placeholder")
      )
    ).toBe(true);
  });
});

// ─── CTA expectations ───

describe("detectBusinessCategory / expectedCtasForCategory", () => {
  it.each([
    { industry: "fintech payouts", category: "fintech" },
    { industry: "restaurant", category: "restaurant" },
    { industry: "print and copy", category: "print" },
    { industry: "beauty salon", category: "beauty" },
    { industry: "cleaning service", category: "cleaning" },
    { industry: "online retail store", category: "retail" },
    { industry: "business consulting", category: "consulting" },
    { industry: "electrical repairs", category: "trades" },
    { industry: "coding bootcamp", category: "education" },
    { industry: "massage therapy", category: "healthcare" },
  ])("maps '$industry' to $category", ({ industry, category }) => {
    const detected = detectBusinessCategory({
      businessName: "X",
      campaignName: "Y",
      productOrService: industry,
      industry,
    });
    expect(detected).toBe(category);
    expect(expectedCtasForCategory(detected).length).toBeGreaterThan(0);
  });
});
