import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { TRPCError } from "@trpc/server";
import * as observerModule from "./contracts/observe-quality-authority";

vi.mock("../agents/runner", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { runAgent } from "../agents/runner";
import { getDb } from "../../queries/connection";
import { buildApprovedMessagePack, saveApprovedMessagePack } from "./campaign-message-architect";

function createMockDb() {
  const campaign = {
    id: 30,
    businessId: 300,
    name: "Zuto Hub Payout Awareness",
    productOrService: "payout platform",
    targetBuyer: "restaurants, delivery platforms, service-based employers and frontline teams",
    mainPainPoint: "manual payout reconciliation",
    preferredCta:
      "Awareness: Learn More\nConsideration: Book a Demo\nConversion: Request a Walkthrough",
    goal: "awareness",
    funnelStages: [{ stage: "awareness" }],
    platforms: "Instagram, Facebook",
    offerDetails: "",
    excludedOffers: "",
    location: "South Africa",
  };

  const business = {
    id: 300,
    name: "Zuto Hub",
    industry: "Financial Services / Fintech",
    productOrService: "payout platform",
    targetCustomer:
      "restaurants, delivery platforms, service-based employers and frontline teams",
    location: "South Africa",
    websiteEvidence: {
      businessCategory: "fintech",
      location: "South Africa",
      productsServices: [
        "instant or streamlined staff tips and commissions",
        "mass disbursements",
        "restaurant and supplier payouts",
        "approved delivery-order settlement",
        "reduced manual payout reconciliation",
      ],
      targetCustomers: [
        "restaurants",
        "delivery platforms",
        "service-based employers",
        "frontline teams",
      ],
    },
  };

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => {
        const tableName = (table as Record<symbol, unknown>)[
          Symbol.for("drizzle:Name") as symbol
        ] as string;

        if (tableName === "campaigns") {
          return {
            where: vi.fn(() => ({
              limit: vi.fn(async () => [campaign]),
            })),
          };
        }

        if (tableName === "businesses") {
          return {
            where: vi.fn(() => ({
              limit: vi.fn(async () => [business]),
            })),
          };
        }

        return {
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => []),
            })),
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async () => [{ insertId: 1001 }]),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })),
  };
}

describe("Campaign Message Architect recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
  });

  it("builds deterministic grounded fallback after two generic AI failures", async () => {
    const genericOutput = {
      headline: "Streamlined Financial Solutions for Small Businesses",
      subheadline: "Transform your business with comprehensive solutions.",
      benefitBullets: [
        "Grow and succeed with confidence.",
        "Comprehensive solutions for your business.",
        "Transform your business operations.",
      ],
      cta: "Learn More",
      footerContact: {
        phone: null,
        whatsapp: null,
        email: null,
        website: null,
        location: "South Africa",
      },
      proofPoints: [],
      platformCaptions: [
        {
          platform: "Instagram",
          caption: "Transform your business with streamlined financial solutions.",
          cta: "Learn More",
          hashtags: ["#business"],
        },
      ],
    };

    vi.mocked(runAgent)
      .mockResolvedValueOnce({ runId: 501, output: genericOutput } as any)
      .mockResolvedValueOnce({ runId: 502, output: genericOutput } as any);

    const result = await buildApprovedMessagePack({
      userId: 7,
      campaignId: 30,
      skipBilling: true,
      maxAttempts: 2,
    });

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(result.messagePackSource).toBe("fallback_deterministic");
    expect(result.validation.passed).toBe(true);
    expect(result.cta).toBe("Learn More");

    const joinedCopy = [result.headline, result.subheadline, ...result.benefitBullets]
      .join(" ")
      .toLowerCase();

    expect(
      [
        "tips and commissions",
        "restaurant and supplier payouts",
        "approved delivery-order settlement",
        "manual payout reconciliation",
        "mass disbursements",
      ].some((term) => joinedCopy.includes(term))
    ).toBe(true);
  });

  it("uses campaign product/service when present, falling back to the business record only when the campaign value is missing", async () => {
    const { getDb } = await import("../../queries/connection");

    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn((table: any) => {
          const tableName = (table as Record<symbol, unknown>)[
            Symbol.for("drizzle:Name") as symbol
          ] as string;

          if (tableName === "campaigns") {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(async () => [{
                  id: 30,
                  businessId: 300,
                  name: "zurohub",
                  productOrService: "Payout platform",
                  targetBuyer: "frontline teams",
                  mainPainPoint: "manual payout reconciliation",
                  preferredCta: "Awareness: Learn More",
                  goal: "awareness",
                  funnelStages: [{ stage: "awareness" }],
                  platforms: "Instagram",
                  offerDetails: "",
                  excludedOffers: "",
                }]),
              })),
            };
          }

          if (tableName === "businesses") {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(async () => [{
                  id: 300,
                  name: "Zuto Hub",
                  industry: "Fintech",
                  productOrService: "Payout platform",
                  websiteEvidence: {
                    businessCategory: "fintech",
                    productsServices: [
                      "Comprehensive Financial Solutions",
                      "Transform Your Business",
                      "mass disbursements",
                    ],
                    targetCustomers: ["frontline teams"],
                  },
                }]),
              })),
            };
          }

          return {
            where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
          };
        }),
      })),
    } as any);

    vi.mocked(runAgent)
      .mockRejectedValueOnce(new Error("LLM down"))
      .mockRejectedValueOnce(new Error("LLM down"));

    const result = await buildApprovedMessagePack({
      userId: 7,
      campaignId: 30,
      skipBilling: true,
      maxAttempts: 2,
    });

    const joined = [result.headline, result.subheadline, ...result.benefitBullets].join(" ");
    expect(joined).toContain("Zuto Hub");
    expect(joined.toLowerCase()).toContain("payout platform");
    expect(joined.toLowerCase()).not.toContain("comprehensive financial solutions");
    expect(joined.toLowerCase()).not.toContain("transform your business");
  });

  it("persists accepted deterministic fallback with fresh fallback metadata after two failed AI attempts", async () => {
    const db = createMockDb() as any;
    vi.mocked(getDb).mockReturnValue(db);

    vi.mocked(runAgent)
      .mockRejectedValueOnce(new Error("LLM down"))
      .mockRejectedValueOnce(new Error("LLM down"));

    const fallback = await buildApprovedMessagePack({
      userId: 7,
      campaignId: 30,
      skipBilling: true,
      maxAttempts: 2,
    });

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(fallback.messagePackSource).toBe("fallback_deterministic");
    expect(fallback.validation.score).toBe(100);
    expect(fallback.validation.rejections).toEqual([]);

    await expect(saveApprovedMessagePack(7, 30, fallback)).resolves.toBe(1001);

    const insertCallIndex = (db.insert as any).mock.calls.findIndex((call: any[]) => {
      const tableName = (call[0] as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
      return tableName === "campaign_assets";
    });

    expect(insertCallIndex).toBeGreaterThanOrEqual(0);
    const insertValues = (db.insert as any).mock.results[insertCallIndex].value.values.mock.calls[0][0];
    expect(insertValues.metadata.messagePackSource).toBe("fallback_deterministic");
    expect(insertValues.metadata.isGeneric).toBe(false);
    expect(insertValues.metadata.passed).toBe(true);
    expect(insertValues.metadata.score).toBe(100);
    expect(insertValues.metadata.approvedMessagePack.validation.rejections).toEqual([]);
  });

  it("does not approve deterministic fallback when validation has rejections", async () => {
    const db = createMockDb() as any;
    vi.mocked(getDb).mockReturnValue(db);

    const invalidFallback = {
      headline: "Seamless Financial Solutions for Modern Businesses",
      subheadline: "Transform your business with modern solutions.",
      benefitBullets: ["Quality service", "Professional team", "Great results"],
      cta: "Learn More",
      footerContact: { location: "South Africa" },
      platformCaptions: [],
      validation: {
        passed: false,
        score: 55,
        rejections: ["Copy must mention at least one real service or use case from business evidence."],
        warnings: [],
      },
      messagePackSource: "fallback_deterministic",
    } as any;

    await expect(saveApprovedMessagePack(7, 30, invalidFallback)).rejects.toBeInstanceOf(TRPCError);
  });
});

describe("Campaign Message Architect quality authority observation side effects", () => {
  let originalMode: string | undefined;
  let observeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalMode = process.env.QUALITY_AUTHORITY_MODE;
    observeSpy = vi.spyOn(observerModule, "observeIfEnabled");
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.QUALITY_AUTHORITY_MODE;
    } else {
      process.env.QUALITY_AUTHORITY_MODE = originalMode;
    }
    observeSpy.mockRestore();
  });

  it("produces identical message packs and DB side effects in off and observe modes", async () => {
    const genericOutput = {
      headline: "Streamlined Financial Solutions for Small Businesses",
      subheadline: "Transform your business with comprehensive solutions.",
      benefitBullets: [
        "Grow and succeed with confidence.",
        "Comprehensive solutions for your business.",
        "Transform your business operations.",
      ],
      cta: "Learn More",
      footerContact: {
        phone: null,
        whatsapp: null,
        email: null,
        website: null,
        location: "South Africa",
      },
      proofPoints: [],
      platformCaptions: [
        {
          platform: "Instagram",
          caption: "Transform your business with streamlined financial solutions.",
          cta: "Learn More",
          hashtags: ["#business"],
        },
      ],
    };

    vi.mocked(runAgent)
      .mockResolvedValueOnce({ runId: 601, output: genericOutput } as any)
      .mockResolvedValueOnce({ runId: 602, output: genericOutput } as any);

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    delete process.env.QUALITY_AUTHORITY_MODE;
    const offResult = await buildApprovedMessagePack({
      userId: 7,
      campaignId: 30,
      skipBilling: true,
      maxAttempts: 2,
    });
    const offInsertCount = (db.insert as ReturnType<typeof vi.fn>).mock.calls.length;
    const offUpdateCount = (db.update as ReturnType<typeof vi.fn>).mock.calls.length;

    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const observeResult = await buildApprovedMessagePack({
      userId: 7,
      campaignId: 30,
      skipBilling: true,
      maxAttempts: 2,
    });
    const observeInsertDelta =
      (db.insert as ReturnType<typeof vi.fn>).mock.calls.length - offInsertCount;
    const observeUpdateDelta =
      (db.update as ReturnType<typeof vi.fn>).mock.calls.length - offUpdateCount;

    expect(observeResult.cta).toBe(offResult.cta);
    expect(observeResult.headline).toBe(offResult.headline);
    expect(observeResult.messagePackSource).toBe(offResult.messagePackSource);
    expect(runAgent).toHaveBeenCalledTimes(4);
    expect(observeInsertDelta).toBe(offInsertCount);
    expect(observeUpdateDelta).toBe(offUpdateCount);
  });

  it("calls the observer exactly once in observe mode", async () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";

    const genericOutput = {
      headline: "Streamlined Financial Solutions for Small Businesses",
      subheadline: "Transform your business with comprehensive solutions.",
      benefitBullets: [
        "Grow and succeed with confidence.",
        "Comprehensive solutions for your business.",
        "Transform your business operations.",
      ],
      cta: "Learn More",
      footerContact: {
        phone: null,
        whatsapp: null,
        email: null,
        website: null,
        location: "South Africa",
      },
      proofPoints: [],
      platformCaptions: [],
    };

    vi.mocked(runAgent)
      .mockResolvedValueOnce({ runId: 603, output: genericOutput } as any)
      .mockResolvedValueOnce({ runId: 604, output: genericOutput } as any);

    await buildApprovedMessagePack({
      userId: 7,
      campaignId: 30,
      skipBilling: true,
      maxAttempts: 2,
    });

    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(observeSpy.mock.calls[0][0]).toBe("campaign message architect observation");
    expect((observeSpy.mock.calls[0][1] as any).attemptType).toBe("message_pack");
  });

  it("returns null from the observer in off mode", async () => {
    delete process.env.QUALITY_AUTHORITY_MODE;

    const genericOutput = {
      headline: "Streamlined Financial Solutions for Small Businesses",
      subheadline: "Transform your business with comprehensive solutions.",
      benefitBullets: [
        "Grow and succeed with confidence.",
        "Comprehensive solutions for your business.",
        "Transform your business operations.",
      ],
      cta: "Learn More",
      footerContact: {
        phone: null,
        whatsapp: null,
        email: null,
        website: null,
        location: "South Africa",
      },
      proofPoints: [],
      platformCaptions: [],
    };

    vi.mocked(runAgent)
      .mockResolvedValueOnce({ runId: 605, output: genericOutput } as any)
      .mockResolvedValueOnce({ runId: 606, output: genericOutput } as any);

    await buildApprovedMessagePack({
      userId: 7,
      campaignId: 30,
      skipBilling: true,
      maxAttempts: 2,
    });

    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(observeSpy.mock.results[0].value).toBeNull();
  });
});
