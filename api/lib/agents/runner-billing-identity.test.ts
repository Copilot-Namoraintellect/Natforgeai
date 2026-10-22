import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

vi.mock("../billing/credit-engine", () => ({
  deductCredits: vi.fn(async () => ({ newBalance: 100 })),
  recordAiUsage: vi.fn(),
  checkCredits: vi.fn(async () => ({ hasCredits: true, balance: 1000 })),
  adminAdjustCredits: vi.fn(),
}));

vi.mock("../billing/cost-control", () => ({
  enforceCostControl: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../billing/cost-tracker", () => ({
  getEstimatedAgentCost: vi.fn(() => 7),
  calculateTokenCost: vi.fn(() => ({ actualCostUsdMicro: 150, estimatedCostUsdMicro: 150 })),
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { generateObject } from "ai";
import { getDb } from "../../queries/connection";
import { deductCredits } from "../billing/credit-engine";
import { runAgent } from "./runner";

function createMockDb() {
  return {
    insert: vi.fn((_table: any) => ({
      values: vi.fn(async () => [{ insertId: 1 }]),
    })),
    update: vi.fn((_table: any) => ({
      set: vi.fn((_set: any) => ({
        where: vi.fn(async () => []),
      })),
    })),
  };
}

const schema = z.object({ text: z.string() });

describe("runAgent caller-stable billing identity (WBS-R1.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    vi.mocked(generateObject).mockResolvedValue({
      object: { text: "hello" },
      usage: { promptTokens: 11, completionTokens: 7 },
    } as any);
  });

  it("records the deduction under the caller-provided idempotency key", async () => {
    await runAgent({
      userId: 10,
      campaignId: 1,
      agentType: "audience",
      prompt: "p",
      schema,
      skipBilling: false,
      billingIdempotencyKey: "agent-audience-abc123",
    });

    expect(deductCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 10,
        amount: 7,
        type: "agent_deduction",
        idempotencyKey: "agent-audience-abc123",
      })
    );
  });

  it("preserves the legacy unkeyed deduction when no identity is provided", async () => {
    await runAgent({
      userId: 10,
      campaignId: 1,
      agentType: "audience",
      prompt: "p",
      schema,
      skipBilling: false,
    });

    expect(deductCredits).toHaveBeenCalledTimes(1);
    const call = vi.mocked(deductCredits).mock.calls[0][0] as Record<string, unknown>;
    expect("idempotencyKey" in call).toBe(false);
  });

  it("never deducts under a key when billing is skipped", async () => {
    await runAgent({
      userId: 10,
      campaignId: 1,
      agentType: "audience",
      prompt: "p",
      schema,
      skipBilling: true,
      billingIdempotencyKey: "agent-audience-abc123",
    });

    expect(deductCredits).not.toHaveBeenCalled();
  });
});
