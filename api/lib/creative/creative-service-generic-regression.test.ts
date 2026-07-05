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
    refineApprovedMessagePack: vi.fn(() => {
      throw new Error("LLM copy rewrite must not be called for design-only refinement");
    }),
    saveApprovedMessagePack: vi.fn(async () => 999),
  };
});

import { generatePremiumLeaflet } from "./service";
import * as architect from "./campaign-message-architect";
import type { CampaignMessagePack } from "./campaign-message-architect";

const specificPack: CampaignMessagePack = {
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
  validation: { passed: true, score: 90, rejections: [], warnings: [] },
  messagePackSource: "user_structured_copy",
};

const genericPack: CampaignMessagePack = {
  headline: "Seamless Financial Solutions for Modern Businesses",
  subheadline: "Transform your business with our modern solutions.",
  benefitBullets: ["Quality service", "Professional team", "Great results"],
  cta: "Learn more",
  footerContact: { location: "South Africa" },
  platformCaptions: [],
  validation: { passed: true, score: 60, rejections: [], warnings: [] },
  messagePackSource: "ai_refined_pack",
};

function createMockDbWithNullRootFields(approvedPack: CampaignMessagePack) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => {
        const tableName = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
        const rowsByTable: Record<string, any[]> = {
          content_posts: [
            {
              id: 100,
              userId: 10,
              campaignId: 28,
              title: null,
              hook: null,
              cta: null,
              platform: "Instagram",
              metadata: {},
            },
          ],
          campaigns: [
            {
              id: 28,
              userId: 10,
              businessId: 24,
              name: "Zuto Campaign",
              productOrService: "Instant payouts",
              targetBuyer: "Restaurant and delivery platform owners",
              mainPainPoint: "Waiting; settlements",
              offerDetails: null,
              excludedOffers: null,
              preferredCta: null,
              platforms: "Instagram, Facebook",
              primaryOutcome: null,
              coreMessage: null,
              workflowContext: {},
            },
          ],
          businesses: [
            {
              id: 24,
              userId: 10,
              name: "Zuto",
              displayName: "Zuto Hub",
              logo: "https://example.com/logo.png",
              industry: "Fintech",
              location: null,
              websiteEvidence: {
                businessCategory: "Fintech",
                productsServices: ["Instant payouts"],
                targetCustomers: ["Restaurant and delivery platform owners"],
              },
            },
          ],
          generated_images: [],
          campaign_assets: [
            {
              id: 457,
              metadata: {
                approvedMessagePack: approvedPack,
                messagePackSource: approvedPack.messagePackSource,
                isGeneric: false,
                specificityScore: 104,
              },
              createdAt: new Date("2026-07-03T00:00:00Z"),
            },
          ],
        };
        const rows = rowsByTable[tableName] || [];
        return {
          where: vi.fn(() => ({
            then: (resolve: (value: any[]) => void) => resolve(rows),
            limit: vi.fn(async () => rows),
            orderBy: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => [{ insertId: 1 }]) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
  };
}

function createMockDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => {
        const tableName = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
        const rowsByTable: Record<string, any[]> = {
          content_posts: [
            {
              id: 100,
              userId: 10,
              campaignId: 28,
              title: "Fallback title",
              hook: "Fallback hook",
              cta: "Fallback CTA",
              platform: "Instagram",
              metadata: {},
            },
          ],
          campaigns: [
            {
              id: 28,
              userId: 10,
              businessId: 24,
              name: "Zuto Campaign",
              productOrService: "Instant payouts",
              targetBuyer: "Restaurants, delivery platforms and frontline teams",
              mainPainPoint: "Waiting; payouts",
              offerDetails: "Same-night settlement for restaurants and delivery platforms",
              excludedOffers: "",
              preferredCta: "Book a Zuto Hub Demo",
              platforms: "Instagram, Facebook",
              primaryOutcome: "Leads",
              coreMessage: "Fallback core message",
              workflowContext: {},
            },
          ],
          businesses: [
            {
              id: 24,
              userId: 10,
              name: "Zuto",
              displayName: "Zuto Hub",
              logo: "https://example.com/logo.png",
              industry: "Fintech",
              location: "South Africa",
              websiteEvidence: {
                businessCategory: "Fintech",
                productsServices: ["Instant payouts"],
                targetCustomers: ["Restaurants", "Delivery platforms", "Frontline teams"],
              },
            },
          ],
          generated_images: [],
          campaign_assets: [
            {
              id: 2,
              metadata: {
                approvedMessagePack: genericPack,
                messagePackSource: "ai_refined_pack",
                isGeneric: true,
                specificityScore: 10,
              },
              createdAt: new Date("2026-07-02T00:00:00Z"),
            },
            {
              id: 1,
              metadata: {
                approvedMessagePack: specificPack,
                messagePackSource: "user_structured_copy",
                isGeneric: false,
                specificityScore: 104,
              },
              createdAt: new Date("2026-07-01T00:00:00Z"),
            },
          ],
        };
        const rows = rowsByTable[tableName] || [];
        return {
          where: vi.fn(() => ({
            then: (resolve: (value: any[]) => void) => resolve(rows),
            limit: vi.fn(async () => rows),
            orderBy: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => [{ insertId: 1 }]) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
  };
}

describe("generatePremiumLeaflet generic regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderMock.mockClear();
  });

  it("design-only refinement uses the older specific pack and never mutates headline or CTA", async () => {
    const { getDb } = await import("../../queries/connection");
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "internal",
      refinementInstruction: "Make the design look more premium with a darker background",
    });

    expect(result.status).toBe("completed");
    expect(result.imageUrl).toBe("https://cdn.example.com/uploads/leaflet.png");

    // The LLM copy-refinement path must be skipped.
    expect(architect.refineApprovedMessagePack).not.toHaveBeenCalled();

    // The renderer must receive the specific user_structured_copy, not the generic latest pack.
    expect(renderMock).toHaveBeenCalledTimes(1);
    const renderReq = renderMock.mock.calls[0][0];
    expect(renderReq.headline).toBe(specificPack.headline);
    expect(renderReq.cta).toBe(specificPack.cta);
    expect(renderReq.subheadline).toBe(specificPack.subheadline);
    expect(renderReq.services).toEqual(specificPack.benefitBullets);

    // Business display name should be preferred over the raw business.name.
    expect(renderReq.businessName).toBe("Zuto Hub");

    // No generic placeholder language should leak into the rendered inputs.
    const inputs = JSON.stringify(renderReq).toLowerCase();
    expect(inputs).not.toContain("seamless financial solutions");
    expect(inputs).not.toContain("learn more");
    expect(inputs).not.toContain("your business");
    expect(inputs).not.toContain("transform your business");
  });

  it("design-only refinement uses approvedMessagePack fields when campaign/post root fields are null", async () => {
    const { getDb } = await import("../../queries/connection");
    const manualRestorePack: CampaignMessagePack = {
      ...specificPack,
      messagePackSource: "manual_restore",
    };
    const db = createMockDbWithNullRootFields(manualRestorePack);
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "internal",
      refinementInstruction: "Use a darker background and larger logo",
    });

    expect(result.status).toBe("completed");

    expect(renderMock).toHaveBeenCalledTimes(1);
    const renderReq = renderMock.mock.calls[0][0];
    expect(renderReq.headline).toBe(manualRestorePack.headline);
    expect(renderReq.subheadline).toBe(manualRestorePack.subheadline);
    expect(renderReq.cta).toBe(manualRestorePack.cta);
    expect(renderReq.services).toEqual(manualRestorePack.benefitBullets);
    expect(renderReq.contact.location).toBe(manualRestorePack.footerContact.location);

    // If the renderer had fallen back to stale root fields it would receive the
    // generic business name or empty strings instead of the approved pack.
    expect(renderReq.headline).not.toBe("Zuto");
    expect(renderReq.cta).not.toBe("");
  });

  it("selectBestApprovedMessagePack still ranks the specific pack highest when it is not the newest", () => {
    const items = [
      {
        pack: architect.enrichMessagePackMetadata(genericPack),
        assetId: 2,
        createdAt: new Date("2026-07-02T00:00:00Z"),
      },
      {
        pack: architect.enrichMessagePackMetadata(specificPack),
        assetId: 1,
        createdAt: new Date("2026-07-01T00:00:00Z"),
      },
    ];
    const best = architect.selectBestApprovedMessagePack(items);
    expect(best?.messagePackSource).toBe("user_structured_copy");
    expect(best?.isGeneric).toBe(false);
    expect(best?.headline).toBe(specificPack.headline);
  });
});

const campaign23SpecificPack: CampaignMessagePack = {
  headline: "Printing, Courier and Business Services in Alberton",
  subheadline:
    "Get wall canvas prints, large format printing, courier services, flyers, banners, posters, business cards and custom printing from 3@1 Newmarket.",
  benefitBullets: [
    "Print marketing material, posters, banners and business cards for your next promotion.",
    "Create wall canvas prints, photo prints and large format displays for home or business use.",
    "Send documents and parcels with convenient courier services from 3@1 Newmarket.",
  ],
  cta: "Request a Quote from 3@1 Newmarket",
  footerContact: { location: "Alberton" },
  platformCaptions: [],
  validation: { passed: true, score: 95, rejections: [], warnings: [] },
  messagePackSource: "manual_restore",
};

const campaign23GenericPack: CampaignMessagePack = {
  headline: "Elevate Your Brand with Tailored Printing and Courier Solutions",
  subheadline: "Transform your brand with our revolutionary service.",
  benefitBullets: ["Quality service", "Professional team", "Great results"],
  cta: "Learn more",
  footerContact: { location: "Alberton" },
  platformCaptions: [],
  validation: { passed: true, score: 60, rejections: [], warnings: [] },
  messagePackSource: "ai_refined_pack",
};

function createMockDbForCampaign23() {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => {
        const tableName = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
        const rowsByTable: Record<string, any[]> = {
          content_posts: [
            {
              id: 100,
              userId: 10,
              campaignId: 23,
              title: "3@1 Leaflet",
              hook: "Fast printing and courier services in Alberton",
              cta: "Request a Quote",
              platform: "Instagram",
              metadata: {},
            },
          ],
          campaigns: [
            {
              id: 23,
              userId: 10,
              businessId: 31,
              name: "3@1 Newmarket Campaign",
              productOrService: "Printing, courier and business services",
              targetBuyer: "Small businesses and households in Alberton",
              mainPainPoint: "Finding reliable printing and courier services locally",
              offerDetails: null,
              excludedOffers: null,
              preferredCta: "Request a Quote",
              platforms: "Instagram, Facebook",
              primaryOutcome: null,
              coreMessage: null,
              workflowContext: {},
            },
          ],
          businesses: [
            {
              id: 31,
              userId: 10,
              name: "3@1 Newmarket",
              displayName: "3@1 Newmarket",
              logo: "https://example.com/3at1-logo.png",
              industry: "Print and courier services",
              location: "Alberton",
              websiteEvidence: {
                businessCategory: "Print, Copy & Courier Services",
                productsServices: [
                  "Wall canvas prints",
                  "Large format printing",
                  "Courier services",
                  "Flyers",
                  "Banners",
                  "Posters",
                  "Business cards",
                  "Custom printing",
                ],
                targetCustomers: ["Small businesses", "Households in Alberton"],
              },
            },
          ],
          generated_images: [],
          campaign_assets: [
            {
              id: 3,
              metadata: {
                approvedMessagePack: campaign23GenericPack,
                messagePackSource: campaign23GenericPack.messagePackSource,
                isGeneric: true,
                specificityScore: 15,
              },
              createdAt: new Date("2026-07-02T00:00:00Z"),
            },
            {
              id: 2,
              metadata: {
                approvedMessagePack: campaign23SpecificPack,
                messagePackSource: campaign23SpecificPack.messagePackSource,
                isGeneric: false,
                specificityScore: 110,
              },
              createdAt: new Date("2026-07-01T00:00:00Z"),
            },
          ],
        };
        const rows = rowsByTable[tableName] || [];
        return {
          where: vi.fn(() => ({
            then: (resolve: (value: any[]) => void) => resolve(rows),
            limit: vi.fn(async () => rows),
            orderBy: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => [{ insertId: 1 }]) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
  };
}

describe("Campaign #23 regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderMock.mockClear();
  });

  it("design-only instruction mentioning service labels preserves the 3@1 approved pack", async () => {
    const { getDb } = await import("../../queries/connection");
    const db = createMockDbForCampaign23();
    vi.mocked(getDb).mockReturnValue(db as any);

    const instruction =
      "Keep the approved campaign copy and CTA. Remove the title, move the logo to the top-right, add a compact services section.";

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "internal",
      refinementInstruction: instruction,
    });

    expect(result.status).toBe("completed");

    // LLM copy refinement must not be invoked.
    expect(architect.refineApprovedMessagePack).not.toHaveBeenCalled();

    const renderReq = renderMock.mock.calls[0][0];
    expect(renderReq.headline).toBe(campaign23SpecificPack.headline);
    expect(renderReq.subheadline).toBe(campaign23SpecificPack.subheadline);
    expect(renderReq.cta).toBe(campaign23SpecificPack.cta);
    expect(renderReq.services).toEqual(campaign23SpecificPack.benefitBullets);

    const inputs = JSON.stringify(renderReq).toLowerCase();
    expect(inputs).not.toContain("your brand");
    expect(inputs).not.toContain("your business");
    expect(inputs).not.toContain("transform your brand");
    expect(inputs).not.toContain("elevate your brand");
  });

  it("selects the specific 3@1 approved pack over a newer generic AI-refined pack", async () => {
    const { getDb } = await import("../../queries/connection");
    const db = createMockDbForCampaign23();
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "internal",
    });

    expect(result.status).toBe("completed");

    const renderReq = renderMock.mock.calls[0][0];
    expect(renderReq.headline).toBe(campaign23SpecificPack.headline);
    expect(renderReq.cta).toBe(campaign23SpecificPack.cta);
    expect(renderReq.services).toEqual(campaign23SpecificPack.benefitBullets);
  });
});
