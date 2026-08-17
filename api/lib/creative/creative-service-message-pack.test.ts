import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeCreativeBriefFingerprint } from "./brief-grounding";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
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

import { normalizeLeafletInputs } from "./service";
import type { CampaignMessagePack } from "./campaign-message-architect";

function createMockDb({ messagePack }: { messagePack?: any } = {}) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => {
              const tableName = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
              if (tableName === "campaign_assets" && messagePack) {
                return [{ metadata: { approvedMessagePack: messagePack } }];
              }
              return [];
            }),
          })),
          limit: vi.fn(async () => []),
        })),
      })),
    })),
  };
}

const stalePack: CampaignMessagePack = {
  headline: "Old stale headline",
  subheadline: "Old stale subheadline",
  benefitBullets: ["Old benefit 1", "Old benefit 2", "Old benefit 3"],
  cta: "Old CTA",
  footerContact: { location: "Old Town" },
  platformCaptions: [],
  validation: { passed: true, score: 100, rejections: [], warnings: [] },
};

const business = {
  id: 20,
  name: "Sparky Pros",
  logo: "https://example.com/logo.png",
  industry: "Electrical services",
  location: "Centurion",
  websiteEvidence: {
    businessCategory: "local trades",
    productsServices: ["electrical repairs"],
    targetCustomers: ["homeowners"],
  },
};

const campaign = {
  id: 1,
  name: "Spring Campaign",
  productOrService: "Residential electrical repairs",
  targetBuyer: "Homeowners in Centurion",
  mainPainPoint: "Electrical faults cause safety risks",
  offerDetails: "",
  excludedOffers: "",
  preferredCta: "Request a Quote",
  platforms: "Instagram, Facebook",
  primaryOutcome: "Leads",
  coreMessage: "Safe homes",
};

const currentFingerprint = computeCreativeBriefFingerprint(campaign);

const newPack: CampaignMessagePack = {
  headline: "New refined headline for Centurion homeowners",
  subheadline: "New refined subheadline about electrical safety.",
  benefitBullets: ["New benefit 1", "New benefit 2", "New benefit 3"],
  cta: "Request a Quote",
  footerContact: { location: "Centurion" },
  platformCaptions: [],
  validation: { passed: true, score: 100, rejections: [], warnings: [] },
  creativeBriefFingerprint: currentFingerprint,
};

const post = {
  id: 100,
  campaignId: 1,
  platform: "Instagram",
  title: "Old post title",
  hook: "Old post hook",
  cta: "Old post CTA",
};

describe("normalizeLeafletInputs uses approved message pack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the provided refined message pack instead of stale DB metadata", async () => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb({ messagePack: stalePack }) as any);

    const result = await normalizeLeafletInputs({
      business,
      campaign,
      post,
      creativeType: "leaflet",
      approvedMessagePack: newPack,
    });

    expect(result.leafletHeadline).toBe(newPack.headline);
    expect(result.leafletSubheadline).toBe(newPack.subheadline);
    expect(result.leafletCta).toBe(newPack.cta);
    expect(result.serviceBullets).toEqual(newPack.benefitBullets);
    expect(result.approvedMessagePack).toBe(newPack);
  });

  it("ignores stale DB metadata that lacks a matching fingerprint", async () => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb({ messagePack: stalePack }) as any);

    const result = await normalizeLeafletInputs({
      business,
      campaign,
      post,
      creativeType: "leaflet",
    });

    expect(result.approvedMessagePack).toBeUndefined();
    expect(result.leafletHeadline).not.toBe(stalePack.headline);
  });
});
