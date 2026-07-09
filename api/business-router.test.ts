import { describe, it, expect, vi, beforeEach } from "vitest";
import { businessRouter } from "./business-router";

const mockGenerateObject = vi.fn();
const mockCrawlWebsitePages = vi.fn();

vi.mock("ai", () => ({
  generateObject: (...args: any[]) => mockGenerateObject(...args),
}));

vi.mock("./lib/website-analyser", async () => {
  const actual = await vi.importActual<typeof import("./lib/website-analyser")>(
    "./lib/website-analyser"
  );
  return {
    ...actual,
    crawlWebsitePages: (...args: any[]) => mockCrawlWebsitePages(...args),
  };
});

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/rate-limiter", () => ({
  rateLimitUser: vi.fn().mockResolvedValue(undefined),
  rateLimitPublic: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, limit: 100, remaining: 99, resetAt: Date.now() + 60 * 60 * 1000 }),
  TIER_RATE_LIMITS: { free: { aiPerDay: 20, apiPerHour: 100, publishPerHour: 10 } },
  clearRateLimitStateForTests: vi.fn(),
}));

vi.mock("./lib/alerts", () => ({
  createAlert: vi.fn().mockResolvedValue({ id: 1 }),
}));

vi.mock("./lib/creative/storage", () => ({
  storeUploadedAsset: vi.fn().mockResolvedValue({ publicUrl: "https://example.com/logo.png", localPath: "/tmp/logo.png" }),
}));

const { getDb } = await import("./queries/connection");

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[
    Symbol.for("drizzle:Name") as symbol
  ] as string | undefined;
}

function createMockDb(businessRows: any[] = []) {
  const updated: any[] = [];
  let currentTable: string | undefined;

  function getResult() {
    if (currentTable === "businesses") return businessRows.slice(0, 1);
    return [];
  }

  const chain = {
    from: vi.fn((table: unknown) => {
      currentTable = getTableName(table);
      return chain;
    }),
    where: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    then: vi.fn((resolve: any) => resolve(getResult())),
  };

  return {
    _updated: updated,
    select: vi.fn(() => chain),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((data: any) => ({
        where: vi.fn(async () => {
          updated.push({ tableName: getTableName(table), data });
          return [];
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async () => [{ insertId: 99 }]),
    })),
  };
}

function buildCtx(user: any) {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user,
    session: { userId: user.id, type: "local" as const, verified: true },
  };
}

function zutoHubEvidence(): any {
  return {
    businessCategory: "Financial Services / Fintech",
    productsServices: ["Tip payouts", "Earnings-based credit", "Smart HubSaver", "Bulk payouts", "Salary payouts"],
    targetCustomers: ["Service-based employers", "Employees", "Tip earners", "Small businesses"],
    contactDetails: { email: "info@zutohub.co.za" },
    location: "Randburg",
    repeatedKeywords: [{ keyword: "payouts", count: 12 }],
    evidenceSnippets: [
      "[ / ] ZutoHub improves financial inclusion for service-based employers and employees.",
      "[ /services ] Tip payouts, real-time payout tracking and earnings-based credit.",
    ],
    confidence: 0.9,
    assumptions: [],
  };
}

function newmarketEvidence(): any {
  return {
    businessCategory: "Print, Copy & Courier Services",
    productsServices: ["Digital printing", "Large format printing", "Courier services", "Fujifilm photos", "ID photos", "Branding", "Laminating", "Binding"],
    targetCustomers: ["Small businesses", "Individuals"],
    contactDetails: {},
    location: "Newmarket Park, Alberton",
    repeatedKeywords: [{ keyword: "printing", count: 15 }],
    evidenceSnippets: [
      "[ / ] 3@1 Newmarket offers printing, copying and courier services.",
      "[ /services ] Digital printing, large format printing, domestic and international courier.",
    ],
    confidence: 0.85,
    assumptions: [],
  };
}

function lowConfidenceEvidence(): any {
  return {
    businessCategory: "General Business",
    productsServices: [],
    targetCustomers: [],
    contactDetails: {},
    location: "",
    repeatedKeywords: [],
    evidenceSnippets: [],
    confidence: 0.25,
    assumptions: ["Could not extract website evidence."],
  };
}

function mockCrawlResult(evidence: any, overrides: any = {}) {
  return {
    pages: [{ fetched: true }],
    evidence,
    log: {
      rawWebsiteInput: overrides.rawWebsiteInput ?? "https://example.com",
      normalizedUrl: overrides.normalizedUrl ?? "https://example.com",
      redirectUrl: overrides.redirectUrl,
      fetchAttemptedUrls: overrides.fetchAttemptedUrls ?? [],
      statusCode: overrides.statusCode ?? 200,
      contentLength: overrides.contentLength ?? 1000,
      pagesCrawled: overrides.pagesCrawled ?? 3,
      pagesFetched: overrides.pagesFetched ?? 3,
      confidence: evidence.confidence,
      failureReason: overrides.failureReason,
      ...overrides,
    },
  };
}

describe("businessRouter.analyseWebsite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateObject.mockReset();
    mockCrawlWebsitePages.mockReset();
  });

  it("returns a fintech profile for ZutoHub evidence", async () => {
    mockCrawlWebsitePages.mockResolvedValueOnce(
      mockCrawlResult(zutoHubEvidence(), { rawWebsiteInput: "www.zutohub.co.za", normalizedUrl: "https://zutohub.co.za" })
    );
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        businessCategory: "Financial Services / Fintech",
        productOrService: "Tip payouts, earnings-based credit, Smart HubSaver, bulk and salary payouts",
        targetCustomer: "Service-based employers and employees in South Africa",
        productDescription: "South African fintech platform improving financial inclusion.",
        uniqueSellingPoint: "Real-time payout tracking",
        pricePointOffer: null,
        primaryGoal: "Build brand awareness",
        secondaryGoal: null,
        successMetric: "Sign-ups",
        targetRevenue: null,
        brandTone: "trustworthy",
        visualStyle: "modern",
        colorPalette: "blue",
        brandVoiceNotes: "Empowering and professional",
        wordsToAvoid: "",
        preferredPlatforms: ["linkedin", "facebook"],
        recommendedAssetTypes: ["logo"],
        confidence: 0.9,
        assumptions: [],
      },
    });

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    const caller = businessRouter.createCaller(buildCtx({ id: 1, role: "user" }));

    const result = await caller.analyseWebsite({ websiteUrl: "www.zutohub.co.za", businessId: 5 });

    expect(result.success).toBe(true);
    expect(result.suggestions?.businessCategory).toContain("Fintech");
    expect(result.suggestions?.productOrService).toContain("payouts");
    expect(result.suggestions?.productDescription).toContain("financial inclusion");
    expect(result.warnings).toHaveLength(0);

    // websiteEvidence must be raw evidence, not completed profile fields.
    const evidenceUpdate = db._updated.find((u: any) => u.data?.websiteEvidence);
    expect(evidenceUpdate).toBeTruthy();
    expect(evidenceUpdate.data.websiteEvidence.businessCategory).toBe("Financial Services / Fintech");
    expect(evidenceUpdate.data.websiteEvidence.productOrService).toBeUndefined();
  });

  it("blanks generic/NatForgeAI fallback copy and adds warnings", async () => {
    mockCrawlWebsitePages.mockResolvedValueOnce(
      mockCrawlResult(zutoHubEvidence(), { rawWebsiteInput: "www.zutohub.co.za" })
    );
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        businessCategory: "Marketing / Digital Agency",
        productOrService: "Marketing automation tools, analytics, content creation services, and social media management solutions.",
        productDescription: "A dynamic marketing platform that connects businesses with innovative marketing solutions and tools.",
        targetCustomer: "Businesses",
        uniqueSellingPoint: "Dynamic marketing platform",
        pricePointOffer: null,
        primaryGoal: "Build brand awareness",
        secondaryGoal: null,
        successMetric: "Engagement rate",
        targetRevenue: null,
        brandTone: "professional",
        visualStyle: "modern",
        colorPalette: "neutral",
        brandVoiceNotes: "",
        wordsToAvoid: "",
        preferredPlatforms: ["facebook", "instagram", "linkedin"],
        recommendedAssetTypes: ["logo"],
        confidence: 0.9,
        assumptions: [],
      },
    });

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    const caller = businessRouter.createCaller(buildCtx({ id: 1, role: "user" }));

    const result = await caller.analyseWebsite({ websiteUrl: "www.zutohub.co.za" });

    expect(result.success).toBe(true);
    expect(result.warnings?.length).toBeGreaterThan(0);
    expect(result.suggestions?.productOrService).toBe("");
    expect(result.suggestions?.productDescription).toBe("");
  });

  it("does not populate generic fields for low-confidence websites", async () => {
    mockCrawlWebsitePages.mockResolvedValueOnce(
      mockCrawlResult(lowConfidenceEvidence(), { rawWebsiteInput: "https://empty.example.com" })
    );
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        businessCategory: "General Business",
        productOrService: "Marketing automation tools",
        productDescription: "A dynamic marketing platform",
        targetCustomer: "Businesses",
        uniqueSellingPoint: "",
        pricePointOffer: null,
        primaryGoal: "Build brand awareness",
        secondaryGoal: null,
        successMetric: "Engagement rate",
        targetRevenue: null,
        brandTone: "professional",
        visualStyle: "modern",
        colorPalette: "neutral",
        brandVoiceNotes: "",
        wordsToAvoid: "",
        preferredPlatforms: ["facebook"],
        recommendedAssetTypes: ["logo"],
        confidence: 0.3,
        assumptions: [],
      },
    });

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    const caller = businessRouter.createCaller(buildCtx({ id: 1, role: "user" }));

    const result = await caller.analyseWebsite({ websiteUrl: "https://empty.example.com" });

    expect(result.success).toBe(true);
    expect(result.warnings?.some((w: string) => w.includes("low"))).toBe(true);
    expect(result.suggestions?.productOrService).toBe("");
    expect(result.suggestions?.productDescription).toBe("");
  });

  it("returns a printing/courier profile for 3@1 Newmarket evidence", async () => {
    mockCrawlWebsitePages.mockResolvedValueOnce(
      mockCrawlResult(newmarketEvidence(), {
        rawWebsiteInput: "www.3at1newmarket.co.za",
        normalizedUrl: "https://3at1newmarket.co.za",
        redirectUrl: "https://3at1newmarket.co.za",
      })
    );
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        businessCategory: "Print, Copy & Courier Services",
        productOrService: "Digital printing, large format printing, courier services, ID and passport photos, laminating and binding",
        targetCustomer: "Small businesses and individuals in Alberton",
        productDescription: "One-stop document and delivery shop in Newmarket Park, Alberton.",
        uniqueSellingPoint: "Printing and courier under one roof",
        pricePointOffer: null,
        primaryGoal: "Drive local foot traffic",
        secondaryGoal: null,
        successMetric: "Orders",
        targetRevenue: null,
        brandTone: "professional",
        visualStyle: "modern",
        colorPalette: "blue",
        brandVoiceNotes: "",
        wordsToAvoid: "",
        preferredPlatforms: ["facebook", "linkedin"],
        recommendedAssetTypes: ["logo"],
        confidence: 0.85,
        assumptions: [],
      },
    });

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    const caller = businessRouter.createCaller(buildCtx({ id: 1, role: "user" }));

    const result = await caller.analyseWebsite({ websiteUrl: "www.3at1newmarket.co.za" });

    expect(result.success).toBe(true);
    expect(result.suggestions?.businessCategory).toContain("Print");
    expect(result.suggestions?.productOrService).toContain("printing");
    expect(result.log?.normalizedUrl).toBe("https://3at1newmarket.co.za");
  });
});

describe("businessRouter.completeProfileWithAi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not reuse saved business profile fields from another user/business", async () => {
    // Simulate User B's business row (same website as User A) without User A's saved fields.
    const userBBusiness = {
      id: 20,
      userId: 2,
      name: "ZutoHub",
      website: "www.zutohub.co.za",
      email: "info@zutohub.co.za",
      description: null,
      industry: null,
      productOrService: null,
      location: "Randburg",
    };

    mockCrawlWebsitePages.mockResolvedValueOnce(
      mockCrawlResult(zutoHubEvidence(), { rawWebsiteInput: "www.zutohub.co.za" })
    );
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        description: "South African fintech platform.",
        industry: "Fintech",
        targetAudience: "Service-based employers",
        brandTone: "trustworthy",
        productOrService: "Tip payouts",
        brandColors: ["#0047AB"],
        visualStyle: "modern",
        brandVoiceNotes: "",
        avoidWords: "",
        mainGoal: "Build awareness",
        premiumContentPreferences: "",
        warnings: [],
      },
    });

    const db = createMockDb([userBBusiness]);
    vi.mocked(getDb).mockReturnValue(db as any);
    const caller = businessRouter.createCaller(buildCtx({ id: 2, role: "user" }));

    const result = await caller.completeProfileWithAi({ id: 20 });

    expect(result.success).toBe(true);
    const prompt = mockGenerateObject.mock.calls[0][0].prompt;
    expect(prompt).toContain("WEBSITE EVIDENCE");
    expect(prompt).not.toContain("User A's marketing description");
    expect(prompt).not.toContain("User A's industry");
  });
});
