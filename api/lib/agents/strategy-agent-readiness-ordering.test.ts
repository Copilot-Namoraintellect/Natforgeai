import { describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { agentRuns } from "@db/schema";

vi.mock("../billing/credit-engine", () => ({
  deductCredits: vi.fn(async () => ({ newBalance: 97 })),
  recordAiUsage: vi.fn(async () => undefined),
}));

vi.mock("ai", () => ({
  generateObject: vi.fn(),
  NoObjectGeneratedError: class MockNoObjectGeneratedError extends Error {
    static isInstance(error: unknown): error is MockNoObjectGeneratedError {
      return error instanceof MockNoObjectGeneratedError;
    }
  },
  TypeValidationError: class MockTypeValidationError extends Error {
    static isInstance(error: unknown): error is MockTypeValidationError {
      return error instanceof MockTypeValidationError;
    }
  },
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./openai", () => ({
  defaultModel: { modelId: "gpt-4o-mini" },
}));

vi.mock("../billing/cost-control", () => ({
  enforceCostControl: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../billing/cost-tracker", () => ({
  getEstimatedAgentCost: vi.fn(() => 3),
  calculateTokenCost: vi.fn(() => ({
    actualCostUsdMicro: 0,
    estimatedCostUsdMicro: 0,
  })),
}));

vi.mock("../alerts", () => ({
  createAlert: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("./provider-error", () => ({
  emitAgentProviderAlert: vi.fn(async () => undefined),
}));

describe("runStrategyAgent defence-in-depth readiness ordering", () => {
  const baseBusiness = {
    name: "Test Business",
    industry: "Food & Beverage",
    location: "Johannesburg",
    productOrService: "payout platform for restaurants",
    targetCustomer: "restaurant owners",
    brandTone: "professional",
    mainGoal: "increase sign-ups",
    monthlyBudget: 5000,
    preferredPlatforms: "",
    website: "https://example.com",
    websiteEvidence: {},
  };

  function createMockDb(overrides: { insertId?: number } = {}) {
    const { insertId = 9001 } = overrides;
    const db = {
      transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => callback({
        insert: vi.fn((table: any) => ({
          values: vi.fn(async () => [{ insertId }] as any),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({ where: vi.fn(async () => [{ affectedRows: 1 }]) })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => [{ affectedRows: 1 }]) })),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
            orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
          })),
        })),
      })),
    };
    return { db };
  }

  it("fails readiness before run insertion, onRunCreated, generateObject, billing or approval", async () => {
    const { runStrategyAgent } = await import("./strategy-agent");
    const { getDb } = await import("../../queries/connection");
    const { generateObject } = await import("ai");
    const { deductCredits } = await import("../billing/credit-engine");
    const mock = createMockDb();
    vi.mocked(getDb).mockReturnValue(mock.db as any);
    vi.mocked(generateObject).mockRejectedValue(new Error("generateObject should not be called"));

    const onRunCreated = vi.fn(async () => {
      throw new Error("onRunCreated should not be called");
    });

    await expect(
      runStrategyAgent({
        userId: 18,
        campaignId: 42,
        business: baseBusiness,
        campaignBrief: {
          name: "Test",
          productOrService: "Payout platform",
          targetBuyer: "Operations managers",
          mainPainPoint: "Manual payouts",
          preferredCta: "Book a demo",
          // platforms intentionally omitted -> no authorised channel
        },
        onRunCreated,
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: /campaign channel/i,
    });

    expect(mock.db.transaction).not.toHaveBeenCalled();
    expect(onRunCreated).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });
});
