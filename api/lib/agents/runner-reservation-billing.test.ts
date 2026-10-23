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

// Stateful governed-reservation fake: deterministic identity from the caller
// billing key, exact-once settle/release per key, idempotent replay on retry.
const reservationState = vi.hoisted(() => {
  const reservations = new Map<
    string,
    { reservationId: string; state: "reserved" | "settled" | "released"; amount: number; settledAmount: number | null }
  >();
  const settleKeys = new Map<string, string>();
  const releaseKeys = new Map<string, string>();
  return { reservations, settleKeys, releaseKeys };
});

vi.mock("../billing/credit-reservation-engine", () => ({
  reserveWalletCredits: vi.fn(async (input: any) => {
    const key = input.externalIdempotencyKey as string;
    const existing = reservationState.reservations.get(key);
    if (existing) {
      return {
        reservation: {
          reservationId: existing.reservationId,
          idempotencyKey: key,
          state: existing.state,
          amount: existing.amount,
          settledAmount: existing.settledAmount,
          releasedAmount: existing.state === "released" ? existing.amount : null,
          attribution: { userId: input.userId, campaignId: input.campaignId ?? null },
          reason: input.reason,
          createdAt: null,
          settledAt: null,
          releasedAt: null,
        },
        duplicateClassification: "idempotent_replay",
        walletBalance: 100,
        reservedAmount: existing.amount,
        availableBalance: 100,
      };
    }
    reservationState.reservations.set(key, {
      reservationId: `res:${key}`,
      state: "reserved",
      amount: input.amount,
      settledAmount: null,
    });
    return {
      reservation: {
        reservationId: `res:${key}`,
        idempotencyKey: key,
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
      availableBalance: 100 - input.amount,
    };
  }),
  settleWalletCredits: vi.fn(async (input: any) => {
    const held = [...reservationState.reservations.values()].find(
      (r) => r.reservationId === input.reservationId
    );
    if (!held) throw new Error("reservation not found in fake");
    const boundKey = reservationState.settleKeys.get(held.reservationId);
    if (boundKey) {
      if (boundKey !== input.settleKey) throw new Error("different settle key");
      return {
        reservation: {
          reservationId: held.reservationId,
          idempotencyKey: "",
          state: held.state,
          amount: held.amount,
          settledAmount: held.settledAmount,
          releasedAmount: null,
          attribution: { userId: 10, campaignId: 1 },
          reason: "",
          createdAt: null,
          settledAt: null,
          releasedAt: null,
        },
        duplicateClassification: "idempotent_replay",
        newBalance: 93,
        alreadyDeducted: true,
      };
    }
    held.state = "settled";
    held.settledAmount = held.amount;
    reservationState.settleKeys.set(held.reservationId, input.settleKey);
    return {
      reservation: {
        reservationId: held.reservationId,
        idempotencyKey: "",
        state: "settled",
        amount: held.amount,
        settledAmount: held.settledAmount,
        releasedAmount: null,
        attribution: { userId: 10, campaignId: 1 },
        reason: "",
        createdAt: null,
        settledAt: null,
        releasedAt: null,
      },
      duplicateClassification: "none",
      newBalance: 93,
    };
  }),
  releaseWalletCredits: vi.fn(async (input: any) => {
    const held = [...reservationState.reservations.values()].find(
      (r) => r.reservationId === input.reservationId
    );
    if (!held) throw new Error("reservation not found in fake");
    const boundKey = reservationState.releaseKeys.get(held.reservationId);
    if (boundKey) {
      if (boundKey !== input.releaseKey) throw new Error("different release key");
      return {
        reservation: {
          reservationId: held.reservationId,
          idempotencyKey: "",
          state: held.state,
          amount: held.amount,
          settledAmount: held.settledAmount,
          releasedAmount: held.amount,
          attribution: { userId: 10, campaignId: 1 },
          reason: "",
          createdAt: null,
          settledAt: null,
          releasedAt: null,
        },
        duplicateClassification: "idempotent_replay",
      };
    }
    held.state = "released";
    reservationState.releaseKeys.set(held.reservationId, input.releaseKey);
    return {
      reservation: {
        reservationId: held.reservationId,
        idempotencyKey: "",
        state: "released",
        amount: held.amount,
        settledAmount: held.settledAmount,
        releasedAmount: held.amount,
        attribution: { userId: 10, campaignId: 1 },
        reason: "",
        createdAt: null,
        settledAt: null,
        releasedAt: null,
      },
      duplicateClassification: "none",
    };
  }),
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
import {
  releaseWalletCredits,
  reserveWalletCredits,
  settleWalletCredits,
} from "../billing/credit-reservation-engine";
import {
  buildAgentRunBillingReleaseKey,
  buildAgentRunBillingSettleKey,
  runAgent,
} from "./runner";

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
const IDENTITY = "agent-audience-abc123";

function successfulGeneration() {
  vi.mocked(generateObject).mockResolvedValue({
    object: { text: "hello" },
    usage: { promptTokens: 11, completionTokens: 7 },
  } as any);
}

async function runKeyed() {
  return runAgent({
    userId: 10,
    campaignId: 1,
    agentType: "audience",
    prompt: "p",
    schema,
    skipBilling: false,
    billingIdempotencyKey: IDENTITY,
  });
}

describe("runAgent governed reservation billing (WBS-R3.1 / GAP18)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reservationState.reservations.clear();
    reservationState.settleKeys.clear();
    reservationState.releaseKeys.clear();
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    successfulGeneration();
  });

  it("exposes deterministic settle/release keys derived from the billing identity", () => {
    expect(buildAgentRunBillingSettleKey(IDENTITY)).toBe(`${IDENTITY}:settle`);
    expect(buildAgentRunBillingReleaseKey(IDENTITY)).toBe(`${IDENTITY}:release`);
  });

  it("settles exactly once on success, even when the step is retried", async () => {
    await runKeyed();
    await runKeyed(); // idempotent retry of the same logical step

    expect(reserveWalletCredits).toHaveBeenCalledTimes(2);
    expect(settleWalletCredits).toHaveBeenCalledTimes(2);
    // Both settles used the same deterministic key, so the second was an
    // idempotent replay: exactly one terminal settlement effect exists.
    const settleCalls = vi.mocked(settleWalletCredits).mock.calls.map(
      (call) => (call[0] as { settleKey: string }).settleKey
    );
    expect(settleCalls).toEqual([`${IDENTITY}:settle`, `${IDENTITY}:settle`]);
    expect(reservationState.settleKeys.size).toBe(1);
    const settled = [...reservationState.reservations.values()].filter((r) => r.state === "settled");
    expect(settled).toHaveLength(1);
    expect(settled[0].settledAmount).toBe(7);
  });

  it("releases the hold on schema/provider failure without charging", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("Invalid schema: missing required field"));

    await expect(runKeyed()).rejects.toThrow("Invalid schema");

    expect(releaseWalletCredits).toHaveBeenCalledTimes(1);
    expect(releaseWalletCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: `res:${IDENTITY}`,
        releaseKey: `${IDENTITY}:release`,
        reason: "schema_error",
      })
    );
    expect(settleWalletCredits).not.toHaveBeenCalled();
    const held = [...reservationState.reservations.values()][0];
    expect(held.state).toBe("released");
  });

  it("settles (charge retained) on non-provider failure, mirroring the legacy policy", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("aborted by caller"));

    await expect(runKeyed()).rejects.toThrow("aborted by caller");

    expect(settleWalletCredits).toHaveBeenCalledTimes(1);
    expect(releaseWalletCredits).not.toHaveBeenCalled();
    const held = [...reservationState.reservations.values()][0];
    expect(held.state).toBe("settled");
  });

  it("maps reservation capacity failure to PAYMENT_REQUIRED before any run is created", async () => {
    const { CreditReservationError } = await import("../billing/credit-reservation");
    vi.mocked(reserveWalletCredits).mockRejectedValueOnce(
      new CreditReservationError(
        "INSUFFICIENT_CREDIT_CAPACITY",
        "Insufficient available credit capacity. Balance: 3. Reserved: 7. Available: 0."
      )
    );

    await expect(runKeyed()).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });

    const db = vi.mocked(getDb).mock.results[0].value as any;
    expect(db.insert).not.toHaveBeenCalled();
    expect(settleWalletCredits).not.toHaveBeenCalled();
  });

  it("recovers a stale reserved hold when the same step is retried after a crash window", async () => {
    // Crash window: reservation committed, process died before settle.
    reservationState.reservations.set(IDENTITY, {
      reservationId: `res:${IDENTITY}`,
      state: "reserved",
      amount: 7,
      settledAmount: null,
    });

    await runKeyed();

    const firstReserve = vi.mocked(reserveWalletCredits).mock.calls[0][0] as {
      externalIdempotencyKey: string;
    };
    expect(firstReserve.externalIdempotencyKey).toBe(IDENTITY);
    expect(settleWalletCredits).toHaveBeenCalledTimes(1);
    const held = [...reservationState.reservations.values()][0];
    expect(held.state).toBe("settled");
  });

  it("never touches the legacy deduction or refund on the keyed path", async () => {
    const { deductCredits, adminAdjustCredits } = await import("../billing/credit-engine");
    vi.mocked(generateObject).mockRejectedValue(new Error("Invalid schema: broken"));

    await expect(runKeyed()).rejects.toThrow("Invalid schema");

    expect(deductCredits).not.toHaveBeenCalled();
    expect(adminAdjustCredits).not.toHaveBeenCalled();
  });
});
