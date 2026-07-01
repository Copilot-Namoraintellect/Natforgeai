import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../billing/credit-engine", () => ({
  checkCredits: vi.fn(async () => ({ hasCredits: true, balance: 100 })),
  deductCredits: vi.fn(async () => ({ success: true, newBalance: 95 })),
  recordAiUsage: vi.fn(async () => {}),
}));

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const openAiRenderMock = vi.fn(async (req: any) => ({
  success: true,
  providerJobId: "openai-job-refined",
  imageBase64: tinyPngBase64,
  extension: "png",
  costUsd: 0.05,
  rawResponse: {
    prompt: req.headline,
    backgroundBase64: tinyPngBase64,
  },
}));

const internalRenderMock = vi.fn(async (req: any) => ({
  success: true,
  providerJobId: "internal-job-refined",
  imageBase64: tinyPngBase64,
  extension: "png",
  costUsd: 0,
  rawResponse: { templateId: req.providerTemplateId },
}));

vi.mock("./registry", () => ({
  getOpenAiLeafletRenderer: vi.fn(() => ({ name: "openai-leaflet", render: openAiRenderMock })),
  getInternalTemplateRenderer: vi.fn(() => ({ name: "internal-template", render: internalRenderMock })),
  getTemplateRendererProvider: vi.fn(),
  isOpenAiLeafletConfigured: vi.fn(() => true),
  getPremiumVideoProvider: vi.fn(),
  getBasicVideoProvider: vi.fn(),
}));

vi.mock("./storage", () => ({
  storeImageBuffer: vi.fn(async () => ({
    publicUrl: "https://example.com/refined-fallback-image.png",
    localPath: "/tmp/refined-fallback-image.png",
  })),
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

vi.mock("./costs", () => ({
  getPremiumImageAiCredits: vi.fn(() => 10),
  getPremiumImageInternalCredits: vi.fn(() => 5),
  getPremiumImageExternalCredits: vi.fn(() => 10),
  getPremiumVideoCredits: vi.fn(() => 100),
  getPremiumHeroPackCredits: vi.fn(() => 120),
  creatifyCreditsToUsd: vi.fn(),
  usdToMicroCents: vi.fn((usd: number) => Math.round(usd * 1_000_000)),
}));

vi.mock("./campaign-message-architect", async () => {
  const actual = await vi.importActual<typeof import("./campaign-message-architect")>(
    "./campaign-message-architect"
  );
  return {
    ...actual,
    ensureApprovedMessagePack: vi.fn(),
    refineApprovedMessagePack: vi.fn(),
    saveApprovedMessagePack: vi.fn(),
    loadApprovedMessagePack: vi.fn(),
    validateCampaignCopy: vi.fn(() => ({ passed: true, score: 80, rejections: [], warnings: [] })),
  };
});

vi.mock("./quality", async () => {
  const actual = await vi.importActual<typeof import("./quality")>("./quality");
  return {
    ...actual,
    validateAiLeafletQuality: vi.fn(),
  };
});

import { generatePremiumLeaflet } from "./service";
import * as architect from "./campaign-message-architect";
import * as creditEngine from "../billing/credit-engine";
import * as quality from "./quality";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string | undefined;
}

const existingPremiumImage = {
  id: 999,
  url: "https://example.com/old-premium-image.png",
  provider: "openai-leaflet",
  providerJobId: "openai-job-old",
  metadata: {
    assetTier: "premium",
    qualityScore: 80,
    qualityTier: "premium",
    qualityLabel: "Premium Marketing Leaflet",
    generationRunId: "premium-old-run",
    iterationNumber: 1,
  },
  createdAt: new Date(Date.now() - 60_000).toISOString(),
};

const refinedPack: architect.CampaignMessagePack = {
  headline: "Refined: Instant payouts for restaurants and frontline teams",
  subheadline: "Stop waiting for weekly settlement.",
  benefitBullets: [
    "Instant staff tips and commissions",
    "Approved delivery orders settled automatically",
    "Track payouts in one place",
  ],
  cta: "Book a Zuto Hub Demo",
  footerContact: { location: "South Africa" },
  platformCaptions: [],
  validation: { passed: true, score: 82, rejections: [], warnings: [] },
};

function createMockDb(existingImages: any[] = [existingPremiumImage]) {
  const insertedRecords: Array<{ tableName: string | undefined; data: any }> = [];
  const updatedRecords: Array<{ tableName: string | undefined; data: any }> = [];

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          then: (resolve: (value: any[]) => void) => resolve([]),
          limit: vi.fn(async () => {
            const tableName = getTableName(table);
            if (tableName === "content_posts") {
              return [
                {
                  id: 125,
                  userId: 18,
                  campaignId: 28,
                  title: "Marketing Leaflet",
                  hook: "Old hook",
                  cta: "Old CTA",
                  platform: "Instagram",
                  metadata: { imageStatus: "failed", imageError: "Previous attempt failed" },
                },
              ];
            }
            if (tableName === "campaigns") {
              return [
                {
                  id: 28,
                  userId: 18,
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
                  userId: 18,
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
              return existingImages;
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
    insert: vi.fn((table: any) => ({
      values: vi.fn((data: any) => {
        insertedRecords.push({ tableName: getTableName(table), data });
        return Promise.resolve([{ insertId: 1 }]);
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((data: any) => {
        updatedRecords.push({ tableName: getTableName(table), data });
        return { where: vi.fn(async () => []) };
      }),
    })),
    _inserted: insertedRecords,
    _updated: updatedRecords,
  };
}

describe("generatePremiumLeaflet refinement bypasses existing asset reuse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openAiRenderMock.mockClear();
    internalRenderMock.mockClear();

    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(refinedPack);
    vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(refinedPack);
    vi.mocked(architect.saveApprovedMessagePack).mockResolvedValue(undefined);
    vi.mocked(architect.refineApprovedMessagePack).mockResolvedValue(refinedPack);

    // AI quality fails twice due to readable text.
    vi.mocked(quality.validateAiLeafletQuality).mockResolvedValue({
      passed: false,
      score: 45,
      criticalFailures: ["AI background contains readable text."],
      warnings: [],
      qualityTier: "failed",
    });
  });

  it("does not reuse an existing premium asset when a refinementInstruction is present", async () => {
    const { getDb } = await import("../../queries/connection");
    const mockDb = createMockDb();
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    const refinementInstruction = `
Headline: Refined: Instant payouts for restaurants and frontline teams
Subheadline: Stop waiting for weekly settlement.
Benefits:
- Instant staff tips and commissions
- Approved delivery orders settled automatically
- Track payouts in one place
CTA: Book a Zuto Hub Demo
Footer: South Africa
    `;

    const result = await generatePremiumLeaflet({
      userId: 18,
      contentPostId: 125,
      provider: "ai",
      refinementInstruction,
    });

    // Should NOT return the old existing asset.
    expect(result.imageUrl).not.toBe(existingPremiumImage.url);
    expect(result.status).toBe("completed");
    expect(result.provider).toBe("internal-premium-fallback");
    expect(result.usingFallback).toBe(true);

    // New render attempts should have happened.
    expect(openAiRenderMock).toHaveBeenCalledTimes(2);
    expect(internalRenderMock).toHaveBeenCalledTimes(1);

    // The fallback should use the refined structured copy.
    const fallbackReq = internalRenderMock.mock.calls[0][0];
    expect(fallbackReq.headline).toContain("Refined:");
    expect(fallbackReq.cta).toBe("Book a Zuto Hub Demo");

    // No OpenAI credits deducted; only fallback credits charged.
    const deductCalls = (creditEngine.deductCredits as any).mock.calls;
    expect(deductCalls).toHaveLength(1);
    expect(deductCalls[0][0].amount).toBe(5);

    // A new generated_images row should be created.
    const generatedRecords = mockDb._inserted.filter((r) => r.tableName === "generated_images");
    expect(generatedRecords.length).toBe(1);
    expect(generatedRecords[0].data.provider).toBe("internal-premium-fallback");
    expect(generatedRecords[0].data.metadata.fallback.fallbackReason).toBe(
      "openai_background_quality_failed"
    );

    // The content post must be marked ready (not left in the old failed state).
    const contentPostUpdates = mockDb._updated.filter((r) => r.tableName === "content_posts");
    const finalUpdate = contentPostUpdates[contentPostUpdates.length - 1];
    expect(finalUpdate.data.metadata.imageStatus).toBe("ready");
    expect(finalUpdate.data.metadata.imageError).toBeNull();
    expect(finalUpdate.data.metadata.imageUrl).toBe("https://example.com/refined-fallback-image.png");
    expect(finalUpdate.data.metadata.imageFallbackMessage).toBe(
      "OpenAI background included readable text, so NatForgeAI generated a clean premium fallback layout instead."
    );
  });
});
