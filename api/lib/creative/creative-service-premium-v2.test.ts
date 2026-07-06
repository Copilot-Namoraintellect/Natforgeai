import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../billing/credit-engine", () => ({
  checkCredits: vi.fn(async () => ({ hasCredits: true, balance: 100 })),
  deductCredits: vi.fn(async () => ({ success: true, transactionId: "tx-123", newBalance: 90 })),
  recordAiUsage: vi.fn(async () => {}),
}));

vi.mock("./storage", () => ({
  storeImageBuffer: vi.fn(async () => ({ publicUrl: "https://example.com/v2-image.png", localPath: "/tmp/v2-image.png" })),
  downloadAndStoreVideo: vi.fn(),
}));

vi.mock("./brand-palette", () => ({
  resolveBrandPalette: vi.fn(async () => ({
    primary: "#1E3A8A",
    secondary: "#F59E0B",
    accent: "#10B981",
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
              return [{ id: 100, userId: 10, campaignId: 28, title: "V2 Post", hook: "Hook", cta: "Post CTA", platform: "Instagram", metadata: {} }];
            }
            if (tableName === "campaigns") {
              return [{
                id: 28,
                userId: 10,
                businessId: 24,
                name: "Print Campaign",
                productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier",
                targetBuyer: "Local businesses",
                mainPainPoint: "Slow turnaround on print jobs",
                offerDetails: "10% off first order",
                excludedOffers: "",
                preferredCta: "Get a Quote",
                platforms: "Instagram, Facebook",
                primaryOutcome: "Leads",
                coreMessage: "Fast local printing",
              }];
            }
            if (tableName === "businesses") {
              return [{
                id: 24,
                userId: 10,
                name: "3@1 Newmarket",
                displayName: "3@1 Newmarket",
                logo: "https://example.com/logo.png",
                industry: "Print and courier",
                location: "Newmarket",
                phone: "011 123 9999",
                website: "https://3at1newmarket.test",
                productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier, Business cards, Banners, Canvas",
                targetCustomer: "Local businesses and students",
                brandColors: ["#0047AB", "#FFD700", "#FFFFFF"],
                visualStyle: "modern",
                websiteEvidence: {
                  businessCategory: "print and courier",
                  productsServices: ["Printing", "Copying", "Scanning", "Laminating", "Binding", "Courier", "Business cards", "Banners", "Canvas"],
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

const validPack: architect.CampaignMessagePack = {
  headline: "Fast printing for Newmarket businesses",
  subheadline: "Same-day quotes and reliable delivery for local businesses struggling with slow turnaround.",
  benefitBullets: ["Business cards", "Flyers", "Banners", "Courier"],
  cta: "Get a Quote",
  footerContact: { location: "Newmarket" },
  platformCaptions: [],
  messagePackSource: "user_structured_copy",
  validation: { passed: true, score: 90, rejections: [], warnings: [] },
};

describe("generatePremiumLeaflet V2 provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a V2 premium leaflet for the 3@1 Newmarket fixture", async () => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack);
    vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(validPack);

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "v2",
    });

    expect(result.status).toBe("completed");
    expect(result.imageUrl).toBe("https://example.com/v2-image.png");
    expect(result.provider).toBe("premium-v2");
    expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
  });

  it("preserves approved copy on a design-only V2 refinement", async () => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack);
    vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(validPack);

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "v2",
      refinementInstruction: "Make the design darker and more premium",
    });

    expect(result.status).toBe("completed");
    expect(result.imageUrl).toBe("https://example.com/v2-image.png");
  });

  it("fails before charging credits when the V2 brief quality gate rejects bad copy", async () => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);

    const badPack: architect.CampaignMessagePack = {
      headline: "Hi",
      subheadline: "",
      benefitBullets: [],
      cta: "",
      footerContact: { location: "Newmarket" },
      platformCaptions: [],
      messagePackSource: "user_structured_copy",
      validation: { passed: true, score: 20, rejections: [], warnings: [] },
    };
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(badPack);

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "v2",
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/quality gate/i);
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
  });
});
