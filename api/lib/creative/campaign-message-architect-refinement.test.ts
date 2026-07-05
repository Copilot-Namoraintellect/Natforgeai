import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../agents/runner", () => ({
  runAgent: vi.fn(),
  isTestMode: vi.fn(() => true),
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import {
  refineApprovedMessagePack,
  parseStructuredRefinementInstruction,
  isDesignOnlyRefinementInstruction,
  type CampaignMessagePack,
} from "./campaign-message-architect";

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
                  targetBuyer: "Homeowners",
                  mainPainPoint: "Electrical faults",
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

describe("parseStructuredRefinementInstruction", () => {
  it("extracts headline, subheadline, benefits, cta and footer", () => {
    const instruction = `
Headline: Fast electrical repairs for Centurion homes
Subheadline: We fix faults fast so homeowners avoid safety risks.
Benefits:
- Local electricians who arrive within the hour
- Upfront quotes with no hidden fees
- Safety inspections on every call-out
CTA: Request a Quote
Footer: Centurion
`;
    const parsed = parseStructuredRefinementInstruction(instruction, basePack);
    expect(parsed).not.toBeNull();
    expect(parsed?.headline).toBe("Fast electrical repairs for Centurion homes");
    expect(parsed?.subheadline).toBe("We fix faults fast so homeowners avoid safety risks.");
    expect(parsed?.benefitBullets).toHaveLength(3);
    expect(parsed?.cta).toBe("Request a Quote");
  });
});

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

  it("parses explicit structured copy from the refinement instruction and preserves it", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runAgent } = await import("../agents/runner");

    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    // The LLM tries to replace the user's explicit copy with generic wording.
    vi.mocked(runAgent).mockResolvedValue({
      runId: 125,
      output: {
        headline: "Transform your business today",
        subheadline: "Unlock success with our revolutionary service.",
        benefitBullets: ["Quality service", "Professional team", "Great results"],
        cta: "Learn more",
        footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "Centurion" },
        proofPoints: null,
        platformCaptions: [],
      },
    });

    const userInstruction = `
Headline: Fast electrical repairs for Centurion homes
Subheadline: We fix faults fast so homeowners avoid safety risks.
Benefits:
- Local electricians who arrive within the hour
- Upfront quotes with no hidden fees
- Safety inspections on every call-out
CTA: Request a Quote
Footer: Centurion
`;

    const refined = await refineApprovedMessagePack({
      userId: 10,
      campaignId: 1,
      existingPack: basePack,
      refinementInstruction: userInstruction,
      skipBilling: true,
      maxAttempts: 1,
    });

    // Because the AI output is generic and invalid, the fallback should use the
    // user-provided structured pack.
    expect(refined.validation.passed).toBe(true);
    expect(refined.headline).toBe("Fast electrical repairs for Centurion homes");
    expect(refined.benefitBullets).toContain("Local electricians who arrive within the hour");
    expect(refined.cta).toBe("Request a Quote");
    // The prompt should have included the structured copy block.
    const prompt = (runAgent as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("USER-PROVIDED STRUCTURED COPY");
    expect(prompt).toContain("Fast electrical repairs for Centurion homes");
  });

  it("preserves target customer and pain-point language from structured refinement", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runAgent } = await import("../agents/runner");

    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    vi.mocked(runAgent).mockResolvedValue({
      runId: 126,
      output: {
        headline: "Help your business avoid electrical downtime",
        subheadline: "We support your business with reliable electrical work.",
        benefitBullets: ["Fast service", "Clear pricing", "Local team"],
        cta: "Request a Quote",
        footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "Centurion" },
        proofPoints: null,
        platformCaptions: [],
      },
    });

    const userInstruction = `
Headline: Keep Centurion homeowners safe from electrical faults
Subheadline: Faulty wiring and tripped boards are electrical faults we fix fast.
Benefits:
- Fast electrical repairs for homeowners in Centurion
- Clear fault finding for electrical safety risks
- Upfront quotes before any electrical repairs start
CTA: Request a Quote
`;

    const refined = await refineApprovedMessagePack({
      userId: 10,
      campaignId: 1,
      existingPack: basePack,
      refinementInstruction: userInstruction,
      skipBilling: true,
      maxAttempts: 1,
    });

    // The AI drifted into generic "your business" language, so fallback to the
    // user pack which contains explicit target customer and pain-point language.
    expect(refined.validation.passed).toBe(true);
    expect(refined.headline.toLowerCase()).toContain("homeowners");
    expect(refined.subheadline.toLowerCase()).toContain("faulty wiring");
    expect(refined.subheadline.toLowerCase()).toContain("electrical faults");
  });

  it("auto-retries once when the first refined pack contains placeholder language", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runAgent } = await import("../agents/runner");

    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    vi.mocked(runAgent)
      .mockResolvedValueOnce({
        runId: 128,
        output: {
          headline: "The best choice for your business",
          subheadline: "We help your business grow and succeed.",
          benefitBullets: ["Quality service", "Professional team", "Great results"],
          cta: "Learn more",
          footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "Centurion" },
          proofPoints: null,
          platformCaptions: [],
        },
      })
      .mockResolvedValueOnce({
        runId: 129,
        output: {
          headline: "Centurion homeowners trust our electrical repairs",
          subheadline: "Faulty wiring and tripped boards fixed fast by local electricians.",
          benefitBullets: [
            "Fast electrical repairs for Centurion homes.",
            "Upfront quotes before any work starts.",
            "Safety-first workmanship on every call-out.",
          ],
          cta: "Request a Quote",
          footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "Centurion" },
          proofPoints: null,
          platformCaptions: [],
        },
      });

    const refined = await refineApprovedMessagePack({
      userId: 10,
      campaignId: 1,
      existingPack: basePack,
      refinementInstruction: "Make it more local and homeowner-focused",
      skipBilling: true,
      maxAttempts: 2,
    });

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(refined.validation.passed).toBe(true);
    expect(refined.headline.toLowerCase()).toContain("homeowners");
    expect(refined.subheadline.toLowerCase()).toContain("faulty wiring");
  });

  it("rejects placeholder wording such as 'your business' and falls back to valid user copy", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runAgent } = await import("../agents/runner");

    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    // The LLM returns generic placeholder copy that should be rejected.
    vi.mocked(runAgent).mockResolvedValue({
      runId: 127,
      output: {
        headline: "The best choice for your business",
        subheadline: "We help your business grow and succeed.",
        benefitBullets: ["Quality service", "Professional team", "Great results"],
        cta: "Learn more",
        footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "Centurion" },
        proofPoints: null,
        platformCaptions: [],
      },
    });

    const userInstruction = `
Headline: Centurion electrical repairs for busy homeowners
Subheadline: Faulty boards and tripped circuits are electrical faults we sort fast.
Benefits:
- Local electrical repairs in Centurion
- Upfront quotes for every repair
- Safety-first workmanship for homeowners
CTA: Request a Quote
`;

    const refined = await refineApprovedMessagePack({
      userId: 10,
      campaignId: 1,
      existingPack: basePack,
      refinementInstruction: userInstruction,
      skipBilling: true,
      maxAttempts: 1,
    });

    expect(refined.validation.passed).toBe(true);
    expect(refined.headline).toBe("Centurion electrical repairs for busy homeowners");
    expect(refined.cta).toBe("Request a Quote");
  });
});

describe("isDesignOnlyRefinementInstruction", () => {
  it("returns true for layout-only instructions", () => {
    expect(isDesignOnlyRefinementInstruction("Move logo to top-right and make text bigger")).toBe(true);
    expect(isDesignOnlyRefinementInstruction("Use a darker background and cleaner layout")).toBe(true);
    expect(isDesignOnlyRefinementInstruction("Add more spacing")).toBe(true);
  });

  it("treats service labels and compact services sections as design-only", () => {
    expect(
      isDesignOnlyRefinementInstruction("Add a compact services section with service labels")
    ).toBe(true);
    expect(isDesignOnlyRefinementInstruction("Show services as labels only")).toBe(true);
  });

  it("treats copy-preservation + layout changes as design-only", () => {
    const instruction =
      "Keep the approved campaign copy and CTA. Remove the title, move the logo to the top-right, add a compact services section.";
    expect(isDesignOnlyRefinementInstruction(instruction)).toBe(true);
  });

  it("returns false when the user explicitly asks to rewrite copy", () => {
    expect(isDesignOnlyRefinementInstruction("Change the headline to something punchier")).toBe(false);
    expect(isDesignOnlyRefinementInstruction("Rewrite the CTA")).toBe(false);
    expect(isDesignOnlyRefinementInstruction("Update the benefits")).toBe(false);
  });

  it("returns false for unstructured copy-only requests", () => {
    expect(isDesignOnlyRefinementInstruction("Make the copy more urgent")).toBe(false);
    expect(isDesignOnlyRefinementInstruction("Improve the wording")).toBe(false);
  });
});
