import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../billing/credit-engine", () => ({
  checkCredits: vi.fn(async () => ({ hasCredits: true, balance: 100 })),
  deductCredits: vi.fn(async () => ({ success: true, transactionId: "tx-123" })),
  recordAiUsage: vi.fn(async () => {}),
}));

vi.mock("./registry", () => ({
  getTemplateRendererProvider: vi.fn(() => ({ name: "bannerbear", render: vi.fn() })),
  getInternalTemplateRenderer: vi.fn(() => ({ name: "internal", render: vi.fn() })),
  getOpenAiLeafletRenderer: vi.fn(() => ({ name: "openai", render: vi.fn() })),
  isOpenAiLeafletConfigured: vi.fn(() => false),
  getPremiumVideoProvider: vi.fn(),
  getBasicVideoProvider: vi.fn(),
}));

vi.mock("./storage", () => ({
  storeImageBuffer: vi.fn(async () => ({ publicUrl: "https://example.com/image.png", localPath: "/tmp/image.png" })),
  downloadAndStoreVideo: vi.fn(),
}));

vi.mock("./brand-palette", () => ({
  resolveBrandPalette: vi.fn(async () => ({
    primary: "#000000",
    secondary: "#ffffff",
    accent: "#ff0000",
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
  };
});

import { generatePremiumLeaflet } from "./service";
import * as architect from "./campaign-message-architect";
import * as creditEngine from "../billing/credit-engine";

function createMockDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          then: (resolve: (value: any[]) => void) => resolve([]),
          limit: vi.fn(async () => {
            const tableName = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
            if (tableName === "content_posts") {
              return [
                {
                  id: 100,
                  userId: 10,
                  campaignId: 1,
                  title: "Master Post",
                  hook: "Old hook",
                  cta: "Old CTA",
                  platform: "Instagram",
                  metadata: {},
                },
              ];
            }
            if (tableName === "campaigns") {
              return [
                {
                  id: 1,
                  userId: 10,
                  businessId: 20,
                  name: "Spring Campaign",
                  productOrService: "Residential electrical repairs",
                  targetBuyer: "Homeowners",
                  mainPainPoint: "Electrical faults",
                  offerDetails: "",
                  excludedOffers: "",
                  preferredCta: "Request a Quote",
                  platforms: "Instagram, Facebook",
                  primaryOutcome: "Leads",
                  coreMessage: "Safe homes",
                  workflowContext: {},
                },
              ];
            }
            if (tableName === "businesses") {
              return [
                {
                  id: 20,
                  userId: 10,
                  name: "Sparky Pros",
                  logo: "https://example.com/logo.png",
                  industry: "Electrical services",
                  location: "Centurion",
                  websiteEvidence: {
                    businessCategory: "local trades",
                    productsServices: ["electrical repairs"],
                    targetCustomers: ["homeowners"],
                  },
                },
              ];
            }
            if (tableName === "generated_images") {
              return [];
            }
            if (tableName === "campaign_assets") {
              return [];
            }
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

describe("generatePremiumLeaflet credit protection on refinement validation failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not deduct credits when refineApprovedMessagePack returns an invalid pack", async () => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);

    const validPack: architect.CampaignMessagePack = {
      headline: "Reliable electrical repairs for Centurion homes",
      subheadline: "We help homeowners fix faults fast and keep properties safe.",
      benefitBullets: [
        "Clear fault finding and upfront quotes.",
        "Safety-first inspections and repairs.",
        "Local Centurion team with quick response.",
      ],
      cta: "Request a Quote",
      footerContact: { location: "Centurion" },
      platformCaptions: [],
      validation: { passed: true, score: 100, rejections: [], warnings: [] },
    };

    const invalidRefinedPack: architect.CampaignMessagePack = {
      headline: "The best choice for your business",
      subheadline: "We help your business grow and succeed.",
      benefitBullets: ["Quality service", "Professional team", "Great results"],
      cta: "Learn more",
      footerContact: { location: "Centurion" },
      platformCaptions: [],
      validation: {
        passed: false,
        score: 30,
        rejections: ["Placeholder language detected: \"your business\"", "CTA is too generic"],
        warnings: [],
      },
    };

    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack);
    vi.mocked(architect.refineApprovedMessagePack).mockResolvedValue(invalidRefinedPack);

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      refinementInstruction: "Make it more generic",
      provider: "internal",
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("Refined copy failed quality validation");
    expect(result.errorMessage).toContain("The best choice for your business");
    expect(result.errorMessage).toContain("Learn more");
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    expect(creditEngine.recordAiUsage).not.toHaveBeenCalled();
  });
});
