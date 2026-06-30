import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../agents/runner", () => ({
  runAgent: vi.fn(),
  isTestMode: vi.fn(() => true),
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { refineApprovedMessagePack, type CampaignMessagePack } from "./campaign-message-architect";

function createMockDb({ runAgentOutput }: { runAgentOutput?: any } = {}) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            const tableName = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
            if (tableName === "campaigns") {
              return [
                {
                  id: 1,
                  userId: 10,
                  businessId: 20,
                  name: "Spring Campaign",
                  productOrService: "Residential electrical repairs",
                  targetBuyer: "Homeowners in Centurion",
                  mainPainPoint: "Electrical faults cause safety risks",
                  offerDetails: "",
                  excludedOffers: "",
                  preferredCta: "Request a Quote",
                  platforms: "Instagram, Facebook",
                  location: "Centurion",
                },
              ];
            }
            if (tableName === "businesses") {
              return [
                {
                  id: 20,
                  userId: 10,
                  name: "Sparky Pros",
                  industry: "Electrical services",
                  location: "Centurion",
                  websiteEvidence: {
                    businessCategory: "local trades",
                    productsServices: ["electrical repairs", "safety inspections"],
                    targetCustomers: ["homeowners", "property managers"],
                  },
                },
              ];
            }
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => [{ insertId: 1 }]) })),
  };
}

const basePack: CampaignMessagePack = {
  headline: "Reliable electrical repairs for Centurion homes",
  subheadline: "We help homeowners fix faults fast and keep properties safe.",
  benefitBullets: [
    "Clear fault finding and upfront quotes.",
    "Safety-first inspections and repairs.",
    "Local Centurion team with quick response.",
  ],
  cta: "Request a Quote",
  footerContact: { location: "Centurion" },
  platformCaptions: [
    {
      platform: "Instagram",
      caption: "Electrical faults in Centurion? Get a reliable local electrician.",
      cta: "Request a Quote",
      hashtags: ["#centurion", "#electrician"],
    },
  ],
  validation: { passed: true, score: 100, rejections: [], warnings: [] },
};

describe("refineApprovedMessagePack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a refined pack that respects the user's instruction", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runAgent } = await import("../agents/runner");

    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    vi.mocked(runAgent).mockResolvedValue({
      runId: 123,
      output: {
        headline: "Centurion homeowners: fix electrical faults before they become hazards",
        subheadline: "Qualified electricians, upfront pricing and safety inspections for your home.",
        benefitBullets: [
          "Fast response across Centurion.",
          "Upfront quotes with no hidden costs.",
          "Safety inspections included with every repair.",
        ],
        cta: "Request a Quote",
        footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "Centurion" },
        proofPoints: null,
        platformCaptions: [
          {
            platform: "Instagram",
            caption: "Don't let electrical faults put your home at risk. Sparky Pros serves Centurion.",
            cta: "Request a Quote",
            hashtags: ["#centurion", "#electrician"],
          },
        ],
      },
    });

    const refined = await refineApprovedMessagePack({
      userId: 10,
      campaignId: 1,
      existingPack: basePack,
      refinementInstruction: "Make the headline more urgent about safety hazards",
      skipBilling: true,
    });

    expect(refined.validation.passed).toBe(true);
    expect(runAgent).toHaveBeenCalledTimes(1);
    const prompt = (runAgent as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("Make the headline more urgent about safety hazards");
    expect(prompt).toContain("EXISTING APPROVED MESSAGE PACK");
    expect(refined.headline.toLowerCase()).toContain("hazard");
  });

  it("fails when the refinement ignores the user's explicit instruction and invents generic copy", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runAgent } = await import("../agents/runner");

    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    // The LLM ignores the instruction and returns generic "Transform your business" copy.
    vi.mocked(runAgent).mockResolvedValue({
      runId: 124,
      output: {
        headline: "Transform your business today",
        subheadline: "Unlock success with our revolutionary service.",
        benefitBullets: [
          "Quality service",
          "Professional team",
          "Great results",
        ],
        cta: "Learn more",
        footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "Centurion" },
        proofPoints: null,
        platformCaptions: [],
      },
    });

    const refined = await refineApprovedMessagePack({
      userId: 10,
      campaignId: 1,
      existingPack: basePack,
      refinementInstruction: "Focus on electrical safety for Centurion homeowners",
      skipBilling: true,
      maxAttempts: 1,
    });

    expect(refined.validation.passed).toBe(false);
    const rejections = refined.validation.rejections.join("; ").toLowerCase();
    expect(rejections).toContain("generic");
  });

  it("returns the existing pack when the LLM fails and max attempts are exhausted", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runAgent } = await import("../agents/runner");

    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    vi.mocked(runAgent).mockRejectedValue(new Error("LLM timeout"));

    const refined = await refineApprovedMessagePack({
      userId: 10,
      campaignId: 1,
      existingPack: basePack,
      refinementInstruction: "Change the headline",
      skipBilling: true,
      maxAttempts: 1,
    });

    expect(refined.headline).toBe(basePack.headline);
    expect(refined.validation.passed).toBe(true);
  });
});
