import { describe, it, expect, vi, beforeEach } from "vitest";
import { imageRouter } from "./image-router";
import { getDb } from "./queries/connection";
import { enforceCostControl } from "./lib/billing/cost-control";
import {
  deductCredits,
  adminAdjustCredits,
  recordAiUsage,
} from "./lib/billing/credit-engine";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/rate-limiter", () => ({
  rateLimitUser: vi.fn().mockResolvedValue(undefined),
  rateLimitPublic: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn(async () => ({ allowed: true, limit: 100, remaining: 99, resetAt: Date.now() + 60 * 60 * 1000 })),
  clearRateLimitStateForTests: vi.fn(),
}));

vi.mock("./lib/billing/cost-control", () => ({
  enforceCostControl: vi.fn(async () => ({ allowed: true, daily: 0, monthly: 0, balance: 100 })),
}));

vi.mock("./lib/billing/credit-engine", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    deductCredits: vi.fn(async () => ({ newBalance: 98 })),
    adminAdjustCredits: vi.fn(async () => ({ newBalance: 100 })),
    recordAiUsage: vi.fn(),
  };
});

vi.mock("./lib/creative/service", () => ({
  generatePremiumLeaflet: vi.fn(),
  generateBasicDraftLeaflet: vi.fn(),
  generateCaptionPack: vi.fn(),
}));

function buildCtx(userId = 18) {
  return {
    resHeaders: new Headers(),
    user: { id: userId, tierSlug: "pro" },
    session: { verified: true },
  } as any;
}

interface CapturedInsert {
  table: string;
  values: Record<string, unknown>;
}

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function createFakeDb(input: {
  generatedImageRows?: Array<Record<string, unknown>>;
  onInsert?: (call: CapturedInsert) => void;
}) {
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async (_n: number) => {
            const name = getTableName(table) ?? "";
            if (name === "generated_images") return input.generatedImageRows ?? [];
            return [];
          },
          orderBy: () => ({
            limit: async (_n: number) => input.generatedImageRows ?? [],
          }),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        input.onInsert?.({ table: getTableName(table) ?? "unknown", values: values as Record<string, unknown> });
        return [{ insertId: 777 }];
      },
    }),
    update: (table: unknown) => ({
      set: (_set: unknown) => ({
        where: async (_conds: unknown) => {
          void table;
          return [{ affectedRows: 1 }];
        },
      }),
    }),
  } as never;
  return db;
}

describe("imageRouter.create billing (WBS-R4E)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("charges 2 credits up front and persists creditsCharged on the job row", async () => {
    const inserts: CapturedInsert[] = [];
    vi.mocked(getDb).mockReturnValue(createFakeDb({ onInsert: (c) => inserts.push(c) }) as any);

    const result = await imageRouter
      .createCaller(buildCtx())
      .create({ prompt: "a skyline at dusk", campaignId: 42 });

    expect(result).toEqual({ id: 777, success: true });
    expect(deductCredits).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 18, amount: 2, type: "image_generation" })
    );
    const imageInsert = inserts.find((c) => c.table === "generated_images");
    expect(imageInsert?.values).toEqual(
      expect.objectContaining({ status: "pending", creditsCharged: 2 })
    );
    expect(recordAiUsage).toHaveBeenCalledTimes(1);
  });

  it("fails closed before any charge or insert when the budget gate rejects", async () => {
    vi.mocked(enforceCostControl).mockResolvedValueOnce({
      allowed: false,
      reason: "System AI generation limit reached. Daily limit: 10.",
      daily: 10,
      monthly: 10,
      balance: 100,
    });
    const inserts: CapturedInsert[] = [];
    vi.mocked(getDb).mockReturnValue(createFakeDb({ onInsert: (c) => inserts.push(c) }) as any);

    await expect(
      imageRouter.createCaller(buildCtx()).create({ prompt: "a skyline at dusk" })
    ).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });

    expect(deductCredits).not.toHaveBeenCalled();
    expect(inserts.filter((c) => c.table === "generated_images")).toHaveLength(0);
  });

  it("image.update worker-failure refund is live: refunds the persisted charge", async () => {
    vi.mocked(getDb).mockReturnValue(
      createFakeDb({
        generatedImageRows: [
          { id: 777, userId: 18, status: "pending", contentPostId: null, creditsCharged: 2 },
        ],
      }) as any
    );

    const result = await imageRouter
      .createCaller(buildCtx())
      .update({ id: 777, status: "failed" });

    expect(result).toEqual({ success: true });
    expect(adminAdjustCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 18,
        amount: 2,
        description: expect.stringContaining("Refund for failed image generation"),
      })
    );
  });

  it("image.update does not refund rows that never carried a charge", async () => {
    vi.mocked(getDb).mockReturnValue(
      createFakeDb({
        generatedImageRows: [
          { id: 778, userId: 18, status: "pending", contentPostId: null, creditsCharged: 0 },
        ],
      }) as any
    );

    await imageRouter.createCaller(buildCtx()).update({ id: 778, status: "failed" });

    expect(adminAdjustCredits).not.toHaveBeenCalled();
  });
});
