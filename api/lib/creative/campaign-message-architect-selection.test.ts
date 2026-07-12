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
