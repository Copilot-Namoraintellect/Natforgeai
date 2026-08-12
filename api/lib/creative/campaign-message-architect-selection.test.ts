import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import {
  selectBestApprovedMessagePack,
  loadApprovedMessagePack,
  loadAllApprovedMessagePacks,
  saveApprovedMessagePack,
  isGenericHeadline,
  isGenericCta,
  isGenericPack,
  specificityScore,
  enrichMessagePackMetadata,
} from "./campaign-message-architect";
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

function createMockDb(rows: Array<{ id: number; pack: CampaignMessagePack; createdAt?: Date }>) {
  const allRows = rows.map((r) => ({
    id: r.id,
    metadata: {
      approvedMessagePack: r.pack,
      messagePackSource: r.pack.messagePackSource,
      isGeneric: r.pack.isGeneric,
      specificityScore: r.pack.specificityScore,
    },
    createdAt: r.createdAt || new Date(),
  }));
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => allRows),
          })),
          limit: vi.fn(async () => {
            const tableName = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
            if (tableName === "campaign_assets") return allRows;
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => [{ insertId: 999 }]) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
  };
}

describe("message pack selection and generic detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flags generic headlines and CTAs", () => {
    expect(isGenericHeadline("Seamless Financial Solutions for Modern Businesses")).toBe(true);
    expect(isGenericHeadline("Transform your business")).toBe(true);
    expect(isGenericHeadline("Instant payouts for restaurants")).toBe(false);
    expect(isGenericCta("Learn more")).toBe(true);
    expect(isGenericCta("Book a Zuto Hub Demo")).toBe(false);
  });

  it("flags generic placeholder language anywhere in the pack, not just headline or CTA", () => {
    const pack: CampaignMessagePack = {
      ...specificPack,
      headline: "Instant payouts for restaurants",
      cta: "Book a Demo",
      subheadline: "Solutions built for your business.",
      benefitBullets: [
        "Reduce payout delays for your business.",
        "Automated disbursements for restaurant teams",
        "Clear reconciliation for finance leads",
      ],
    };
    expect(isGenericPack(pack)).toBe(true);
    const enriched = enrichMessagePackMetadata(pack);
    expect(enriched.isGeneric).toBe(true);
  });

  it("detects placeholder phrases in every customer-facing field", () => {
    const base: CampaignMessagePack = {
      ...specificPack,
      headline: "Instant payouts for restaurants",
      cta: "Book a Demo",
    };

    expect(isGenericPack({ ...base, subheadline: "Built for your business." })).toBe(true);
    expect(isGenericPack({ ...base, benefitBullets: ["Great outcomes for your business", "Fast setup", "Local support"] })).toBe(true);
    expect(isGenericPack({ ...base, proofPoints: ["Trusted by your business community"] })).toBe(true);
    expect(isGenericPack({
      ...base,
      platformCaptions: [{ platform: "LinkedIn", caption: "For your business needs", cta: "Book a Demo", hashtags: [] }],
    })).toBe(true);
  });

  it("detects placeholder phrases regardless of case and surrounding punctuation", () => {
    const pack: CampaignMessagePack = {
      ...specificPack,
      headline: "Instant payouts for restaurants",
      cta: "Book a Demo",
      subheadline: "Built for YOUR BUSINESS!",
      benefitBullets: ["Great outcomes for [Your Business].", "Fast setup", "Local support"],
    };
    expect(isGenericPack(pack)).toBe(true);
  });

  it("detects placeholder phrases with irregular whitespace", () => {
    const base: CampaignMessagePack = {
      ...specificPack,
      headline: "Instant payouts for restaurants",
      cta: "Book a Demo",
    };

    expect(isGenericPack({ ...base, subheadline: "Built for your   business." })).toBe(true);
    expect(isGenericPack({ ...base, subheadline: "Built for your\tbusiness." })).toBe(true);
    expect(isGenericPack({ ...base, subheadline: "Built for your\nbusiness." })).toBe(true);
    expect(isGenericPack({ ...base, subheadline: "Built for YOUR\t  BUSINESS!" })).toBe(true);
  });

  it("does not treat legitimate business names as generic placeholders", () => {
    const pack: CampaignMessagePack = {
      ...specificPack,
      headline: "Instant payouts for restaurants",
      cta: "Book a Demo",
      subheadline: "Business Services Limited handles your payouts.",
      benefitBullets: ["Company disbursements settle faster", "Fast setup", "Local support"],
    };
    expect(isGenericPack(pack)).toBe(false);
  });

  it("does not throw when optional fields are missing or malformed", () => {
    const pack: CampaignMessagePack = {
      ...specificPack,
      headline: "Instant payouts for restaurants",
      cta: "Book a Demo",
      benefitBullets: undefined as any,
      platformCaptions: [{ platform: "LinkedIn", caption: "caption", cta: "cta", hashtags: undefined as any }],
      proofPoints: undefined as any,
    };
    expect(() => isGenericPack(pack)).not.toThrow();
    expect(isGenericPack(pack)).toBe(false);
  });

  it("does not throw when platformCaptions contains null or undefined entries", () => {
    const packs: CampaignMessagePack[] = [
      {
        ...specificPack,
        headline: "Instant payouts for restaurants",
        cta: "Book a Demo",
        platformCaptions: [null as any],
      },
      {
        ...specificPack,
        headline: "Instant payouts for restaurants",
        cta: "Book a Demo",
        platformCaptions: [undefined as any],
      },
    ];
    for (const pack of packs) {
      expect(() => isGenericPack(pack)).not.toThrow();
      expect(isGenericPack(pack)).toBe(false);
    }
  });

  it("detects a generic platform caption mixed with malformed entries", () => {
    const pack: CampaignMessagePack = {
      ...specificPack,
      headline: "Instant payouts for restaurants",
      cta: "Book a Demo",
      platformCaptions: [
        null as any,
        { platform: "LinkedIn", caption: "For your business needs", cta: "Book a Demo", hashtags: [] },
        undefined as any,
      ],
    };
    expect(() => isGenericPack(pack)).not.toThrow();
    expect(isGenericPack(pack)).toBe(true);
  });

  it("does not treat clean platform captions as generic when mixed with malformed entries", () => {
    const pack: CampaignMessagePack = {
      ...specificPack,
      headline: "Instant payouts for restaurants",
      cta: "Book a Demo",
      platformCaptions: [
        null as any,
        { platform: "LinkedIn", caption: "Instant payouts for restaurants", cta: "Book a Demo", hashtags: [] },
        undefined as any,
      ],
    };
    expect(() => isGenericPack(pack)).not.toThrow();
    expect(isGenericPack(pack)).toBe(false);
  });

  it("ignores stale legacy metadata and derives genericity from the actual copy", () => {
    const pack: CampaignMessagePack = {
      ...specificPack,
      headline: "Instant payouts for restaurants",
      cta: "Book a Demo",
      subheadline: "Solutions built for your business.",
      validation: { passed: true, score: 100, rejections: [], warnings: [] },
      isGeneric: false,
    };
    const enriched = enrichMessagePackMetadata(pack);
    expect(enriched.isGeneric).toBe(true);
    expect(enriched.validation.passed).toBe(true); // metadata preserved; genericity is separate
  });

  it("scores specific copy higher than generic copy", () => {
    const specific = enrichMessagePackMetadata(specificPack);
    const generic = enrichMessagePackMetadata(genericPack);
    expect(specific.specificityScore).toBeGreaterThan(generic.specificityScore || 0);
    expect(generic.isGeneric).toBe(true);
    expect(specific.isGeneric).toBe(false);
  });

  it("selects the older user_structured_copy over a newer generic AI-refined pack", () => {
    const items = [
      { pack: enrichMessagePackMetadata(genericPack), assetId: 2, createdAt: new Date("2026-07-02T00:00:00Z") },
      { pack: enrichMessagePackMetadata(specificPack), assetId: 1, createdAt: new Date("2026-07-01T00:00:00Z") },
    ];
    const best = selectBestApprovedMessagePack(items);
    expect(best?.headline).toBe(specificPack.headline);
    expect(best?.messagePackSource).toBe("user_structured_copy");
    expect(best?.isGeneric).toBe(false);
  });

  it("selects a specific fallback_user_pack over a generic ai_refined_pack", () => {
    const fallbackSpecific: CampaignMessagePack = {
      ...specificPack,
      messagePackSource: "fallback_user_pack",
    };
    const items = [
      { pack: genericPack, assetId: 2, createdAt: new Date("2026-07-02T00:00:00Z") },
      { pack: fallbackSpecific, assetId: 1, createdAt: new Date("2026-07-01T00:00:00Z") },
    ];
    const best = selectBestApprovedMessagePack(items);
    expect(best?.headline).toBe(specificPack.headline);
    expect(best?.messagePackSource).toBe("fallback_user_pack");
  });

  it("never selects invalidated packs", () => {
    const invalidatedSpecific: CampaignMessagePack = {
      ...specificPack,
      invalidatedAt: new Date("2026-07-10T00:00:00Z").toISOString(),
      invalidationReason: "generic_pack_blocked",
    };

    const items = [
      { pack: invalidatedSpecific, assetId: 2, createdAt: new Date("2026-07-11T00:00:00Z") },
      { pack: genericPack, assetId: 1, createdAt: new Date("2026-07-09T00:00:00Z") },
    ];

    const best = selectBestApprovedMessagePack(items);
    expect(best?.headline).toBe(genericPack.headline);
    expect(best?.invalidatedAt).toBeUndefined();
  });

  it("loadApprovedMessagePack ranks multiple saved packs and returns the best", async () => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(
      createMockDb([
        { id: 2, pack: genericPack, createdAt: new Date("2026-07-02T00:00:00Z") },
        { id: 1, pack: specificPack, createdAt: new Date("2026-07-01T00:00:00Z") },
      ]) as any
    );

    const best = await loadApprovedMessagePack(28);
    expect(best?.headline).toBe(specificPack.headline);
    expect(best?.isGeneric).toBe(false);
    expect(best?.messagePackSource).toBe("user_structured_copy");
  });

  it("loadAllApprovedMessagePacks enriches every pack with isGeneric and specificityScore", async () => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(
      createMockDb([
        { id: 2, pack: genericPack },
        { id: 1, pack: specificPack },
      ]) as any
    );

    const all = await loadAllApprovedMessagePacks(28);
    expect(all).toHaveLength(2);
    const generic = all.find((a) => a.assetId === 2)!;
    const specific = all.find((a) => a.assetId === 1)!;
    expect(generic.pack.isGeneric).toBe(true);
    expect(specific.pack.isGeneric).toBe(false);
    expect(typeof specific.pack.specificityScore).toBe("number");
  });

  it("saveApprovedMessagePack stores messagePackSource, isGeneric and specificityScore", async () => {
    const { getDb } = await import("../../queries/connection");
    const db = createMockDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);

    await saveApprovedMessagePack(10, 28, specificPack);

    const valuesFn = (db.insert as any).mock.results[0].value.values;
    const values = valuesFn.mock.calls[0][0];
    expect(values.metadata.messagePackSource).toBe("user_structured_copy");
    expect(values.metadata.isGeneric).toBe(false);
    expect(typeof values.metadata.specificityScore).toBe("number");
    expect(values.metadata.approvedMessagePack.isGeneric).toBe(false);
  });

  it("saveApprovedMessagePack rejects generic copy", async () => {
    const { getDb } = await import("../../queries/connection");
    const db = createMockDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);

    await expect(saveApprovedMessagePack(10, 28, genericPack)).rejects.toBeInstanceOf(TRPCError);
  });
});
