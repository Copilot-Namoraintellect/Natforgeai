import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../billing/credit-engine", () => ({
  checkCredits: vi.fn(async () => ({ hasCredits: true, balance: 100 })),
  deductCredits: vi.fn(async () => ({ success: true, transactionId: "tx-123", newBalance: 95 })),
  recordAiUsage: vi.fn(async () => {}),
}));

const renderMock = vi.fn(async (req: any) => ({
  success: true,
  providerJobId: "job-123",
  imageUrl: undefined,
  imageBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  extension: "png",
  metadata: {},
}));

vi.mock("./registry", () => ({
  getTemplateRendererProvider: vi.fn(() => ({ name: "bannerbear", render: renderMock })),
  getInternalTemplateRenderer: vi.fn(() => ({ name: "internal", render: renderMock })),
  getOpenAiLeafletRenderer: vi.fn(() => ({ name: "openai", render: renderMock })),
  isOpenAiLeafletConfigured: vi.fn(() => false),
  getPremiumVideoProvider: vi.fn(),
  getBasicVideoProvider: vi.fn(),
}));

vi.mock("./storage", () => ({
  storeImageBuffer: vi.fn(async () => ({ publicUrl: "https://cdn.example.com/uploads/leaflet.png", localPath: "/tmp/leaflet.png" })),
  downloadAndStoreVideo: vi.fn(),
}));

vi.mock("./brand-palette", () => ({
  resolveBrandPalette: vi.fn(async () => ({
    primary: "#0F766E",
    secondary: "#99F6E4",
    accent: "#F59E0B",
    source: "mock",
  })),
  safeText: vi.fn((value: unknown) => (value == null ? "" : String(value).trim())),
}));

vi.mock("./campaign-message-architect", async () => {
  const actual = await vi.importActual<typeof import("./campaign-message-architect")>("./campaign-message-architect");
  return {
    ...actual,
    ensureApprovedMessagePack: vi.fn(),
    refineApprovedMessagePack: vi.fn(),
    saveApprovedMessagePack: vi.fn(),
    loadApprovedMessagePack: vi.fn(),
    validateCampaignCopy: vi.fn(() => ({ passed: true, score: 85, rejections: [], warnings: [] })),
    parseStructuredRefinementInstruction: vi.fn((instruction: string) => {
      // Return a simple structured pack when the instruction looks structured.
      if (!instruction.includes("Headline:")) return null;
      const lines = instruction.split("\n").map((l) => l.trim()).filter(Boolean);
      const get = (prefix: string) => {
        const line = lines.find((l) => l.toLowerCase().startsWith(prefix.toLowerCase()));
        return line ? line.split(":").slice(1).join(":").trim() : "";
      };
      const headline = get("Headline:") || "";
      const subheadline = get("Subheadline:") || "";
      const cta = get("CTA:") || "";
      const benefitsStart = lines.findIndex((l) => l.toLowerCase().startsWith("benefits:"));
      const benefitBullets: string[] = [];
      if (benefitsStart >= 0) {
        for (let i = benefitsStart + 1; i < lines.length; i++) {
          const l = lines[i];
          if (l.toLowerCase().startsWith("cta:")) break;
          if (l.startsWith("-")) benefitBullets.push(l.replace(/^-\s*/, ""));
        }
      }
      return {
        headline,
        subheadline,
        benefitBullets,
        cta,
        footerContact: { location: get("Footer:") || "" },
        platformCaptions: [],
      };
    }),
  };
});

import { generatePremiumLeaflet } from "./service";
import * as architect from "./campaign-message-architect";

interface BusinessFixture {
  id: string;
  name: string;
  industry: string;
  productOrService: string;
  targetBuyer: string;
  mainPainPoint: string;
  headline: string;
  subheadline: string;
  offer: string;
  cta: string;
  benefits: string[];
  forbidden: string[];
}

const fixtures: BusinessFixture[] = [
  {
    id: "fintech",
    name: "SwiftPay",
    industry: "Fintech",
    productOrService: "Instant payout platform",
    targetBuyer: "Restaurant and delivery owners",
    mainPainPoint: "Waiting days for card payouts",
    headline: "Get tomorrow’s card sales paid into your account tonight",
    subheadline: "SwiftPay settles approved card takings before you close the till.",
    offer: "Same-night settlement for restaurants and delivery platforms",
    cta: "Open a SwiftPay Account",
    benefits: ["Same-night card settlements", "No manual reconciliation", "Real-time payout tracking"],
    forbidden: ["your business", "transform your business", "seamless solutions"],
  },
  {
    id: "restaurant",
    name: "Burger Barn",
    industry: "Restaurant / Takeaway",
    productOrService: "Gourmet burgers and loaded fries",
    targetBuyer: "Local families and office workers",
    mainPainPoint: "Boring fast-food options",
    headline: "Flame-grilled burgers delivered hot in 25 minutes",
    subheadline: "Fresh patties, local buns and triple-cooked fries made to order.",
    offer: "Free delivery on orders over R150",
    cta: "Order Now",
    benefits: ["100% fresh beef patties", "25-minute delivery radius", "Free delivery over R150"],
    forbidden: ["your business", "transform your business"],
  },
  {
    id: "print_courier",
    name: "PrintFly",
    industry: "Print / Courier",
    productOrService: "Same-day printing and courier delivery",
    targetBuyer: "Small business marketers",
    mainPainPoint: "Missed deadlines from slow print shops",
    headline: "Flyers printed and delivered across Gauteng today",
    subheadline: "Upload your artwork by 10am and have printed flyers in hand by 4pm.",
    offer: "500 A5 flyers printed and delivered for R399",
    cta: "Get a Same-Day Quote",
    benefits: ["Same-day print turnaround", "Door-to-door courier delivery", "Proof sent before print"],
    forbidden: ["your business"],
  },
  {
    id: "beauty_barber",
    name: "The Groom Room",
    industry: "Beauty / Barber",
    productOrService: "Mobile barber and grooming services",
    targetBuyer: "Busy professionals",
    mainPainPoint: "No time to visit a barbershop",
    headline: "A sharp cut at your office or home in Sandton",
    subheadline: "Our mobile barbers bring the chair, tools and hot towels to you.",
    offer: "Book 3 cuts and get the 4th free",
    cta: "Book a Mobile Cut",
    benefits: ["Cuts at your location", "Hot-towel finish included", "Evening and weekend slots"],
    forbidden: ["your business"],
  },
  {
    id: "cleaning",
    name: "Sparkle Cleaners",
    industry: "Cleaning",
    productOrService: "Office and home deep-cleaning",
    targetBuyer: "Office managers",
    mainPainPoint: "Inconsistent cleaning staff",
    headline: "Spotless offices every morning, guaranteed",
    subheadline: "Background-checked teams, eco products and a same-day re-clean promise.",
    offer: "First deep clean 20% off",
    cta: "Book a Deep Clean",
    benefits: ["Background-checked cleaners", "Eco-friendly products", "Same-day re-clean guarantee"],
    forbidden: ["your business"],
  },
  {
    id: "consulting",
    name: "NorthStar Consulting",
    industry: "Consulting",
    productOrService: "Cash-flow advisory for construction firms",
    targetBuyer: "Construction company owners",
    mainPainPoint: "Project cash-flow gaps",
    headline: "Keep every construction project in the black",
    subheadline: "NorthStar maps milestone billing, supplier payments and retentions.",
    offer: "Free 90-minute cash-flow diagnostic",
    cta: "Book a Diagnostic",
    benefits: ["Milestone billing plans", "Supplier payment scheduling", "Retention tracking"],
    forbidden: ["your business"],
  },
  {
    id: "retail_ecommerce",
    name: "Kidswear Co.",
    industry: "Retail / E-commerce",
    productOrService: "Organic cotton baby clothes",
    targetBuyer: "New parents",
    mainPainPoint: "Sensitive skin reactions from synthetic fabrics",
    headline: "GOTS-certified organic babygrows, delivered free",
    subheadline: "Zero harsh dyes, 100% soft organic cotton and free returns within 30 days.",
    offer: "Buy any 3 babygrows and save 20%",
    cta: "Shop Organic Babygrows",
    benefits: ["GOTS-certified cotton", "Free delivery nationwide", "30-day free returns"],
    forbidden: ["your business"],
  },
  {
    id: "education",
    name: "CodeStart",
    industry: "Education / Training",
    productOrService: "Part-time coding bootcamp",
    targetBuyer: "Working professionals switching careers",
    mainPainPoint: "Full-time courses are unaffordable",
    headline: "Become a junior developer without quitting your job",
    subheadline: "Two evenings a week, live instruction and real portfolio projects.",
    offer: "First module free – no credit card required",
    cta: "Start Free Module",
    benefits: ["Part-time evening classes", "Live instructor support", "Portfolio projects"],
    forbidden: ["your business"],
  },
  {
    id: "local_trades",
    name: "LeakProof Plumbers",
    industry: "Local Trades",
    productOrService: "Emergency leak detection and repair",
    targetBuyer: "Homeowners in Pretoria",
    mainPainPoint: "Hidden water leaks causing damage",
    headline: "Find and fix leaks before they flood your home",
    subheadline: "Thermal leak detection, fixed pricing and a 12-month workmanship guarantee.",
    offer: "R199 leak inspection this week",
    cta: "Book an Inspection",
    benefits: ["Thermal leak detection", "Fixed upfront pricing", "12-month guarantee"],
    forbidden: ["your business"],
  },
  {
    id: "healthcare",
    name: "Revive Physio",
    industry: "Healthcare / Wellness",
    productOrService: "Sports physiotherapy and rehab",
    targetBuyer: "Weekend athletes and runners",
    mainPainPoint: "Recurring injuries stopping training",
    headline: "Run stronger with targeted sports physiotherapy",
    subheadline: "Biomechanical screening, hands-on treatment and a return-to-run plan.",
    offer: "Initial assessment and first treatment for R450",
    cta: "Book an Assessment",
    benefits: ["Biomechanical screening", "Hands-on treatment", "Return-to-run plan"],
    forbidden: ["your business"],
  },
];

function basePack(fixture: BusinessFixture): architect.CampaignMessagePack {
  return {
    headline: fixture.headline,
    subheadline: fixture.subheadline,
    benefitBullets: fixture.benefits,
    cta: fixture.cta,
    footerContact: { location: "South Africa" },
    platformCaptions: [],
    validation: { passed: true, score: 90, rejections: [], warnings: [] },
  };
}

function createMockDb(fixture: BusinessFixture) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          then: (resolve: (value: any[]) => void) => resolve([]),
          limit: vi.fn(async () => {
            const tableName = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
            if (tableName === "content_posts") {
              return [{ id: 100, userId: 10, campaignId: 28, title: fixture.headline, hook: fixture.subheadline, cta: fixture.cta, platform: "Instagram", metadata: {} }];
            }
            if (tableName === "campaigns") {
              return [{
                id: 28, userId: 10, businessId: 24, name: `${fixture.name} Campaign`,
                productOrService: fixture.productOrService,
                targetBuyer: fixture.targetBuyer,
                mainPainPoint: fixture.mainPainPoint,
                offerDetails: fixture.offer,
                excludedOffers: "",
                preferredCta: fixture.cta,
                platforms: "Instagram, Facebook",
                primaryOutcome: "Leads",
                coreMessage: fixture.headline,
                workflowContext: {},
              }];
            }
            if (tableName === "businesses") {
              return [{
                id: 24, userId: 10, name: fixture.name, logo: "https://example.com/logo.png",
                industry: fixture.industry,
                location: "South Africa",
                websiteEvidence: {
                  businessCategory: fixture.industry,
                  productsServices: [fixture.productOrService],
                  targetCustomers: [fixture.targetBuyer],
                },
              }];
            }
            if (tableName === "generated_images") return [];
            if (tableName === "campaign_assets") return [];
            return [];
          }),
          orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => [{ insertId: 1 }]) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
  };
}

describe("generatePremiumLeaflet across 10 business types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderMock.mockClear();
  });

  it.each(fixtures)("design-only refinement preserves approved copy for $id", async (fixture) => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb(fixture) as any);

    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(basePack(fixture));
    vi.mocked(architect.refineApprovedMessagePack).mockRejectedValue(new Error("LLM should not be called for design-only refinement"));

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "internal",
      refinementInstruction: "Make the design look more premium with a darker background",
    });

    expect(result.status).toBe("completed");
    expect(result.imageUrl).toBe("https://cdn.example.com/uploads/leaflet.png");

    // LLM copy rewrite must be skipped.
    expect(architect.refineApprovedMessagePack).not.toHaveBeenCalled();

    // Renderer must receive the approved business-specific copy.
    expect(renderMock).toHaveBeenCalledTimes(1);
    const renderReq = renderMock.mock.calls[0][0];
    expect(renderReq.headline).toBe(fixture.headline);
    expect(renderReq.cta).toBe(fixture.cta);
    expect(renderReq.refinementInstruction).toBe("Make the design look more premium with a darker background");

    const inputs = JSON.stringify(renderReq).toLowerCase();
    for (const phrase of fixture.forbidden) {
      expect(inputs).not.toContain(phrase);
    }
  });

  it.each(fixtures)("structured copy update replaces approved copy for $id", async (fixture) => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb(fixture) as any);

    const initialPack = basePack(fixture);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(initialPack);

    const newHeadline = `${fixture.headline} – now live`;
    const newCta = "Reserve Your Spot";
    const instruction = `
Headline: ${newHeadline}
Subheadline: Updated subheadline for the campaign.
Benefits:
- ${fixture.benefits[0]}
- ${fixture.benefits[1]}
CTA: ${newCta}
Footer: South Africa
`;

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "internal",
      refinementInstruction: instruction,
    });

    expect(result.status).toBe("completed");
    expect(result.imageUrl).toBe("https://cdn.example.com/uploads/leaflet.png");

    const renderReq = renderMock.mock.calls[0][0];
    expect(renderReq.headline).toBe(newHeadline);
    expect(renderReq.cta).toBe(newCta);

    const inputs = JSON.stringify(renderReq).toLowerCase();
    for (const phrase of fixture.forbidden) {
      expect(inputs).not.toContain(phrase);
    }
  });

  it.each(fixtures)("latest metadata and download URL are stored for $id", async (fixture) => {
    const { getDb } = await import("../../queries/connection");
    const db = createMockDb(fixture);
    vi.mocked(getDb).mockReturnValue(db as any);

    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(basePack(fixture));

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "internal",
    });

    expect(result.status).toBe("completed");
    expect(result.imageUrl).toMatch(/^https:\/\//);
    expect(result.extension).toBe("png");

    // A generatedImages row should be inserted.
    expect(db.insert).toHaveBeenCalled();
    const generatedImagesInsert = (db.insert as any).mock.calls.find((call: any[]) => {
      const tableName = call[0]?.[Symbol.for("drizzle:Name")] as string;
      return tableName === "generated_images";
    });
    expect(generatedImagesInsert).toBeDefined();

    // contentPosts metadata should be updated to ready.
    expect(db.update).toHaveBeenCalled();
  });
});
