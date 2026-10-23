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

// WBS-R3.1 / GAP18: the keyed forward path is now realised by the governed
// reservation authority instead of a direct keyed deduction.
vi.mock("../billing/credit-reservation-engine", () => ({
  reserveWalletCredits: vi.fn(async (input: any) => ({
    reservation: {
      reservationId: `res:${input.externalIdempotencyKey}`,
      idempotencyKey: input.externalIdempotencyKey,
      state: "reserved",
      amount: input.amount,
      settledAmount: null,
      releasedAmount: null,
      attribution: { userId: input.userId, campaignId: input.campaignId ?? null },
      reason: input.reason,
      createdAt: null,
      settledAt: null,
      releasedAt: null,
    },
    duplicateClassification: "none",
    walletBalance: 100,
    reservedAmount: input.amount,
    availableBalance: 93,
  })),
  settleWalletCredits: vi.fn(async () => ({
    reservation: {
      reservationId: "res:x",
      idempotencyKey: "x",
      state: "settled",
      amount: 7,
      settledAmount: 7,
      releasedAmount: null,
      attribution: { userId: 10, campaignId: 1 },
      reason: "audience agent execution",
      createdAt: null,
      settledAt: null,
      releasedAt: null,
    },
    duplicateClassification: "none",
    newBalance: 93,
  })),
  releaseWalletCredits: vi.fn(),
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
import {
  releaseWalletCredits,
  reserveWalletCredits,
  settleWalletCredits,
} from "../billing/credit-reservation-engine";
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

describe("runAgent caller-stable billing identity (WBS-R1.3 via WBS-R3.1 reservation authority)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    vi.mocked(generateObject).mockResolvedValue({
      object: { text: "hello" },
      usage: { promptTokens: 11, completionTokens: 7 },
    } as any);
  });

  it("anchors the charge to the caller-provided identity through reserve -> settle", async () => {
    await runAgent({
      userId: 10,
      campaignId: 1,
      agentType: "audience",
      prompt: "p",
      schema,
      skipBilling: false,
      billingIdempotencyKey: "agent-audience-abc123",
    });

    expect(reserveWalletCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 10,
        campaignId: 1,
        amount: 7,
        reservationReference: "agent-audience-abc123",
        externalIdempotencyKey: "agent-audience-abc123",
        agentType: "audience",
      })
    );
    expect(settleWalletCredits).toHaveBeenCalledTimes(1);
    expect(settleWalletCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "res:agent-audience-abc123",
        settleKey: "agent-audience-abc123:settle",
      })
    );
    // The legacy up-front deduction is fully replaced on the keyed path.
    expect(deductCredits).not.toHaveBeenCalled();
    expect(releaseWalletCredits).not.toHaveBeenCalled();
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
    expect(reserveWalletCredits).not.toHaveBeenCalled();
    expect(settleWalletCredits).not.toHaveBeenCalled();
  });

  it("never reserves or deducts under a key when billing is skipped", async () => {
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
    expect(reserveWalletCredits).not.toHaveBeenCalled();
    expect(settleWalletCredits).not.toHaveBeenCalled();
  });
});
