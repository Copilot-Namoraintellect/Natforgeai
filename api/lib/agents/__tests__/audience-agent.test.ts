import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../runner", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../../../queries/connection", () => ({
  getDb: vi.fn(),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string | undefined;
}

function createMockDb({
  campaign,
  business,
}: {
  campaign: Record<string, unknown>;
  business?: Record<string, unknown> | null;
}) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            const tableName = getTableName(table);
            if (tableName === "campaigns") return [campaign];
            if (tableName === "businesses") return business ? [business] : [];
            return [];
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })),
  };
}

describe("runAudienceAgent prompt grounding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves campaign #30-shaped data to B2B and keeps stale workflowContext out of the prompt", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runAudienceAgent } = await import("../audience-agent");

    const campaign = {
      id: 30,
      userId: 18,
      businessId: 24,
      name: "Controlled payout orchestration",
      goal: "Increase qualified demo bookings",
      productOrService: "B2B payment orchestration and controlled payment instructions",
      targetBuyer: "operations managers, finance managers and business owners",
      mainPainPoint: "Manual reconciliation and payout delays",
      preferredCta: "Book a guided walkthrough",
      primaryOutcome: "More qualified demo bookings",
      targetAudience: "delivery platforms, restaurants, marketplaces, fintech businesses and service organisations",
      coreMessage: "Reduce payout admin while improving settlement clarity",
      offerDetails: "Book a guided walkthrough",
      excludedOffers: "",
      referenceStyle: "",
      contentStyle: "professional",
      platforms: "LinkedIn",
      workflowContext: {
        valueProposition: "Old small-business payroll and mass-disbursement value proposition",
        campaignTheme: "Old cash-flow and payroll theme",
      },
    };

    const business = {
      id: 24,
      name: "NatForge Ops",
      industry: "Financial Operations",
      productOrService: "Staff and supplier payout automation",
      targetCustomer: "small businesses needing payroll and mass disbursements",
      location: "Johannesburg",
      websiteEvidence: {
        businessCategory: "Financial Operations",
        productsServices: ["payroll automation", "mass disbursements", "reconciliation dashboard"],
        targetCustomers: ["small businesses", "payroll managers"],
        location: "Johannesburg",
      },
    };

    vi.mocked(getDb).mockReturnValue(createMockDb({ campaign, business }) as any);
    vi.mocked(runAgent).mockResolvedValue({
      output: {
        audienceProfiles: [],
        targetingCriteria: { interests: [], behaviours: [], demographics: [], customAudiences: [], lookalikes: [] },
        hashtagStrategy: { primary: [], secondary: [], trending: [], branded: [] },
        competitorInsights: [],
        outreachAngles: [],
      },
      runId: 1,
    });

    await runAudienceAgent({ userId: 18, campaignId: 30 });

    expect(runAgent).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(runAgent).mock.calls[0][0].prompt as string;

    expect(prompt).toContain("Business Type: B2B");
    expect(prompt).not.toContain("Business Type: B2C");
    expect(prompt).toContain("B2B payment orchestration and controlled payment instructions");
    expect(prompt).toContain("operations managers, finance managers and business owners");
    expect(prompt).not.toContain("small-business");
    expect(prompt).not.toContain("mass-disbursement");
    expect(prompt).not.toContain("mass disbursement");
    expect(prompt).not.toContain("payroll");
    expect(prompt).not.toContain("cash-flow");
  });

  it("preserves an explicit B2C classification for a consumer-shaped campaign", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runAudienceAgent } = await import("../audience-agent");

    const campaign = {
      id: 31,
      userId: 18,
      businessId: 25,
      name: "Family Photo Shoot Promo",
      goal: "Book more weekend sessions",
      productOrService: "Family portrait photography",
      targetBuyer: "Parents and families",
      mainPainPoint: "No recent family photos",
      preferredCta: "Book a session",
      primaryOutcome: "More bookings",
      targetAudience: "Parents with young children",
      coreMessage: "Capture memories that last a lifetime",
      offerDetails: "",
      excludedOffers: "",
      referenceStyle: "",
      contentStyle: "warm",
      platforms: "Instagram, Facebook",
      workflowContext: {},
    };

    vi.mocked(getDb).mockReturnValue(createMockDb({ campaign, business: null }) as any);
    vi.mocked(runAgent).mockResolvedValue({
      output: {
        audienceProfiles: [],
        targetingCriteria: { interests: [], behaviours: [], demographics: [], customAudiences: [], lookalikes: [] },
        hashtagStrategy: { primary: [], secondary: [], trending: [], branded: [] },
        competitorInsights: [],
        outreachAngles: [],
      },
      runId: 2,
    });

    await runAudienceAgent({ userId: 18, campaignId: 31, isB2B: false });

    expect(runAgent).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(runAgent).mock.calls[0][0].prompt as string;

    expect(prompt).toContain("Business Type: B2C");
    expect(prompt).not.toContain("Business Type: B2B");
  });
});
