import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/runner", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { runAgent } from "../agents/runner";
import { getDb } from "../../queries/connection";
import { buildApprovedMessagePack } from "./campaign-message-architect";

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
          })),
        };
      }),
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

  it("uses authoritative business record name and product/service, filtering generic website headings", async () => {
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
                  productOrService: "Comprehensive Financial Solutions, Streamlined Mass Disbursements",
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
});
