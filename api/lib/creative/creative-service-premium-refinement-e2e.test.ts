import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../billing/credit-engine", () => ({
  checkCredits: vi.fn(async () => ({ hasCredits: true, balance: 100 })),
  deductCredits: vi.fn(async () => ({ success: true, transactionId: "tx-123" })),
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

const structuredRefinementInstruction = `
Headline: Instant payouts for restaurants, delivery platforms and frontline teams
Subheadline: Stop waiting for weekly settlement and reconciliation. Pay tips, commissions and supplier orders in minutes.
Benefits:
- Payouts for restaurants, delivery platforms and frontline teams
- Automated tips, commissions and supplier payouts
- Approved delivery orders settled without manual reconciliation
CTA: Book a Zuto Hub Demo
Footer: South Africa
`;

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
                  campaignId: 28,
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
                  id: 28,
                  userId: 10,
                  businessId: 24,
                  name: "Zutohub Marketing Campaign",
                  productOrService: "Payout platform",
                  targetBuyer: "Small business owner",
                  mainPainPoint: "Manual payouts",
                  offerDetails: "",
                  excludedOffers: "",
                  preferredCta: "Book a demo",
                  platforms: "Instagram, Facebook",
                  primaryOutcome: "Leads",
                  coreMessage: "Empower your workforce",
                  workflowContext: {},
                },
              ];
            }
            if (tableName === "businesses") {
              return [
                {
                  id: 24,
                  userId: 10,
                  name: "Zutohub",
                  logo: "https://example.com/logo.png",
                  industry: "Fintech",
                  location: "Randburg",
                  websiteEvidence: {
                    businessCategory: "Financial services",
                    productsServices: ["Payouts"],
                    targetCustomers: ["Small businesses"],
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

describe("generatePremiumLeaflet structured refinement end-to-end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderMock.mockClear();
  });

  it("uses parsed structured copy directly, renders it, and does not deduct credits on validation failure", async () => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);

    // The base pack fails validation — this is the production scenario.
    const failedBasePack: architect.CampaignMessagePack = {
      headline: "Zutohub Marketing Campaign",
      subheadline: "Transform your business with our solution.",
      benefitBullets: ["Quality service", "Professional team", "Great results"],
      cta: "Learn more",
      footerContact: { location: "Randburg" },
      platformCaptions: [],
      validation: {
        passed: false,
        score: 25,
        rejections: ["Placeholder language detected: \"your business\"", "Generic phrase detected"],
        warnings: [],
      },
    };

    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(failedBasePack);
    // LLM refinement is NOT expected to be called when structured copy validates.
    vi.mocked(architect.refineApprovedMessagePack).mockRejectedValue(new Error("should not be called"));

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      refinementInstruction: structuredRefinementInstruction,
      provider: "internal",
    });

    expect(result.status).toBe("completed");
    expect(result.imageUrl).toBe("https://example.com/image.png");

    // LLM refinement should have been skipped because structured copy validated.
    expect(architect.refineApprovedMessagePack).not.toHaveBeenCalled();

    // The renderer should have received the user's exact approved headline.
    expect(renderMock).toHaveBeenCalledTimes(1);
    const renderReq = renderMock.mock.calls[0][0];
    expect(renderReq.headline).toBe("Instant payouts for restaurants, delivery platforms and frontline teams");
    expect(renderReq.cta).toBe("Book a Zuto Hub Demo");
    expect(renderReq.services).toContain("Payouts for restaurants, delivery platforms and frontline teams");

    // No "your business" should appear anywhere in the render inputs.
    const renderInputs = JSON.stringify(renderReq).toLowerCase();
    expect(renderInputs).not.toContain("your business");

    // Credits should be deducted only after successful render, not before.
    expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
    const deductCall = (creditEngine.deductCredits as any).mock.calls[0][0];
    expect(deductCall.userId).toBe(10);
    expect(deductCall.type).toBe("image_generation");
  });

  it("does not deduct credits when refinementInstruction exists but neither structured copy nor AI refinement passes validation", async () => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);

    const failedBasePack: architect.CampaignMessagePack = {
      headline: "Zutohub Marketing Campaign",
      subheadline: "Transform your business with our solution.",
      benefitBullets: ["Quality service", "Professional team", "Great results"],
      cta: "Learn more",
      footerContact: { location: "Randburg" },
      platformCaptions: [],
      validation: {
        passed: false,
        score: 25,
        rejections: ["Placeholder language detected: \"your business\""],
        warnings: [],
      },
    };

    const failedRefinedPack: architect.CampaignMessagePack = {
      headline: "The best choice for your business",
      subheadline: "We help your business grow and succeed.",
      benefitBullets: ["Quality service", "Professional team", "Great results"],
      cta: "Learn more",
      footerContact: { location: "Randburg" },
      platformCaptions: [],
      validation: {
        passed: false,
        score: 20,
        rejections: ["Placeholder language detected: \"your business\""],
        warnings: [],
      },
    };

    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(failedBasePack);
    vi.mocked(architect.refineApprovedMessagePack).mockResolvedValue(failedRefinedPack);

    // The refinement instruction is free-form text without structured sections.
    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      refinementInstruction: "Make it more generic and vague",
      provider: "internal",
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("Refined copy failed quality validation");
    expect(result.errorMessage).toContain("The best choice for your business");
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
  });
});
