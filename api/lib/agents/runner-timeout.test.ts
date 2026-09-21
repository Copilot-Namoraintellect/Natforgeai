import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

vi.mock("../billing/credit-engine", () => ({
  deductCredits: vi.fn(),
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
import { deductCredits, adminAdjustCredits } from "../billing/credit-engine";
import { runAgent } from "./runner";
import { ProviderTimeoutError, isProviderTimeoutError } from "../reliability/provider-timeout";

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

/** Simulates a provider call that hangs until its abortSignal fires. */
function mockHungProvider() {
  vi.mocked(generateObject).mockImplementation(
    (args: any) =>
      new Promise((_resolve, reject) => {
        if (args.abortSignal?.aborted) return reject(abortError());
        args.abortSignal?.addEventListener("abort", () => reject(abortError()), { once: true });
      })
  );
}

function createMockDb() {
  const updateSets: any[] = [];
  return {
    updateSets,
    insert: vi.fn((table: any) => ({
      values: vi.fn(async (values: any) => [{ insertId: 1 }]),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((set: any) => ({
        where: vi.fn(async () => {
          updateSets.push(set);
          return [];
        }),
      })),
    })),
  };
}

const schema = z.object({ text: z.string() });

describe("runAgent provider timeout authority (WBS 4F WBS9B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a governed signal (not the caller's raw signal) to generateObject", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { text: "hello" },
      usage: { promptTokens: 11, completionTokens: 7 },
    } as any);
    const caller = new AbortController();

    const result = await runAgent({
      userId: 10,
      campaignId: 1,
      agentType: "creative",
      prompt: "p",
      schema,
      abortSignal: caller.signal,
      skipBilling: true,
    });

    const callArgs = vi.mocked(generateObject).mock.calls[0][0] as any;
    expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal);
    expect(callArgs.abortSignal).not.toBe(caller.signal);
    expect(result.output).toEqual({ text: "hello" });
  });

  it("provider exceeding the timeout fails the agent run with a typed timeout error", async () => {
    vi.useFakeTimers();
    mockHungProvider();

    const promise = runAgent({
      userId: 10,
      campaignId: 1,
      agentType: "creative",
      prompt: "p",
      schema,
      skipBilling: true,
    });
    const handled = promise.catch((e) => e);

    await vi.advanceTimersByTimeAsync(120_000);
    const error = await handled;

    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect(isProviderTimeoutError(error)).toBe(true);
    // Run record must be marked failed.
    const db = vi.mocked(getDb).mock.results[0].value as any;
    expect(db.updateSets).toHaveLength(1);
    expect(db.updateSets[0].status).toBe("failed");
    expect(String(db.updateSets[0].error)).toContain("timeout");
  });

  it("caller abort still aborts the provider call and wins over the timeout", async () => {
    vi.useFakeTimers();
    mockHungProvider();
    const caller = new AbortController();

    const promise = runAgent({
      userId: 10,
      campaignId: 1,
      agentType: "creative",
      prompt: "p",
      schema,
      abortSignal: caller.signal,
      skipBilling: true,
    });

    // Let the run reach generateObject, then abort from the caller side.
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();

    const error = await promise.catch((e) => e);
    expect(error).not.toBeInstanceOf(ProviderTimeoutError);
    expect(isProviderTimeoutError(error)).toBe(false);
    expect(error.name).toBe("AbortError");
  });

  it("timeout preserves existing billing refund semantics (provider fault => refund)", async () => {
    vi.useFakeTimers();
    mockHungProvider();

    const promise = runAgent({
      userId: 10,
      campaignId: 1,
      agentType: "creative",
      prompt: "p",
      schema,
      skipBilling: false,
    });
    const handled = promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(120_000);
    await handled;

    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(adminAdjustCredits).toHaveBeenCalledTimes(1);
    expect(adminAdjustCredits).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 10, amount: 7 })
    );
  });
});
