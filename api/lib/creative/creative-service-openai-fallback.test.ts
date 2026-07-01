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
  providerJobId: "openai-job-123",
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
  providerJobId: "internal-job-456",
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
    publicUrl: "https://example.com/fallback-image.png",
    localPath: "/tmp/fallback-image.png",
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
import { env } from "../env";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string | undefined;
}

function createMockDb() {
  const insertedRecords: Array<{ tableName: string | undefined; data: any }> = [];
  const updatedRecords: Array<{ tableName: string | undefined; data: any }> = [];

  const mockDb = {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          then: (resolve: (value: any[]) => void) => resolve([]),
          limit: vi.fn(async () => {
            const tableName = getTableName(table);
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

  return mockDb;
}

const approvedPack: architect.CampaignMessagePack = {
  headline: "Instant payouts for restaurants, delivery platforms and frontline teams",
  subheadline: "Stop waiting for weekly settlement and reconciliation.",
  benefitBullets: [
    "Payouts for restaurants, delivery platforms and frontline teams",
    "Automated tips, commissions and supplier payouts",
    "Approved delivery orders settled without manual reconciliation",
  ],
  cta: "Book a Zuto Hub Demo",
  footerContact: { location: "South Africa" },
  platformCaptions: [],
  validation: { passed: true, score: 80, rejections: [], warnings: [] },
};

describe("generatePremiumLeaflet OpenAI fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openAiRenderMock.mockClear();
    internalRenderMock.mockClear();
    env.freeAiLeafletFallback = false;

    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(approvedPack);
    vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(approvedPack);
    vi.mocked(architect.saveApprovedMessagePack).mockResolvedValue(1);
    vi.mocked(architect.refineApprovedMessagePack).mockResolvedValue(approvedPack);
  });

  it("falls back to internal premium renderer when OpenAI background quality fails twice", async () => {
    const { getDb } = await import("../../queries/connection");
    const mockDb = createMockDb();
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    // AI quality fails on both attempts due to readable text in the background.
    vi.mocked(quality.validateAiLeafletQuality).mockResolvedValue({
      passed: false,
      score: 45,
      criticalFailures: ["AI background contains readable text."],
      warnings: ["Fake-branding check: readable text detected in background."],
      qualityTier: "failed",
    });

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "ai",
    });

    expect(result.status).toBe("completed");
    expect(result.provider).toBe("internal-premium-fallback");
    expect(result.usingFallback).toBe(true);
    expect(result.imageUrl).toBe("https://example.com/fallback-image.png");
    expect(result.fallbackMessage).toBe(
      "OpenAI background included readable text, so NatForgeAI generated a clean premium fallback layout instead."
    );

    // OpenAI renderer should have been called for each attempt.
    expect(openAiRenderMock).toHaveBeenCalledTimes(2);
    // Internal fallback renderer should have been called once.
    expect(internalRenderMock).toHaveBeenCalledTimes(1);

    // The fallback renderer must receive the approved structured copy.
    const fallbackReq = internalRenderMock.mock.calls[0][0];
    expect(fallbackReq.headline).toBe(approvedPack.headline);
    expect(fallbackReq.subheadline).toBe(approvedPack.subheadline);
    expect(fallbackReq.cta).toBe(approvedPack.cta);
    expect(fallbackReq.services).toEqual(approvedPack.benefitBullets);

    // No OpenAI credits deducted; only internal fallback credits charged.
    const deductCalls = (creditEngine.deductCredits as any).mock.calls;
    expect(deductCalls).toHaveLength(1);
    expect(deductCalls[0][0].amount).toBe(5);
    expect(deductCalls[0][0].metadata.provider).toBe("internal-premium-fallback");

    // Generated image row should be marked as the fallback provider.
    const generatedRecord = mockDb._inserted.find((r) => r.tableName === "generated_images");
    expect(generatedRecord).toBeTruthy();
    expect(generatedRecord!.data.provider).toBe("internal-premium-fallback");
    expect(generatedRecord!.data.metadata.fallback.provider).toBe("internal-premium-fallback");
    expect(generatedRecord!.data.metadata.fallback.fallbackReason).toBe("openai_background_quality_failed");
    expect(generatedRecord!.data.metadata.fallback.originalAiQualityScore).toBe(45);
    expect(generatedRecord!.data.metadata.fallback.criticalFailures).toContain(
      "AI background contains readable text."
    );
    expect(generatedRecord!.data.metadata.fallbackMessage).toBe(result.fallbackMessage);

    // Content post should be ready and carry the user-facing fallback message.
    const contentPostUpdates = mockDb._updated.filter((r) => r.tableName === "content_posts");
    expect(contentPostUpdates.length).toBeGreaterThan(0);
    const contentPostUpdate = contentPostUpdates[contentPostUpdates.length - 1];
    expect(contentPostUpdate.data.metadata.imageStatus).toBe("ready");
    expect(contentPostUpdate.data.metadata.imageProvider).toBe("internal-premium-fallback");
    expect(contentPostUpdate.data.metadata.imageFallbackMessage).toBe(result.fallbackMessage);
    expect(contentPostUpdate.data.metadata.imageCreditsCharged).toBe(5);
  });

  it("charges 0 credits and records admin_test_fallback when free fallback is enabled", async () => {
    env.freeAiLeafletFallback = true;
    const { getDb } = await import("../../queries/connection");
    const mockDb = createMockDb();
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    vi.mocked(quality.validateAiLeafletQuality).mockResolvedValue({
      passed: false,
      score: 45,
      criticalFailures: ["AI background contains readable text."],
      warnings: [],
      qualityTier: "failed",
    });

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "ai",
    });

    expect(result.status).toBe("completed");
    expect(result.creditsCharged).toBe(0);
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();

    const generatedRecord = mockDb._inserted.find((r) => r.tableName === "generated_images");
    expect(generatedRecord!.data.creditsCharged).toBe(0);
    expect(generatedRecord!.data.metadata.fallback.creditsReason).toBe("admin_test_fallback");
  });
});
