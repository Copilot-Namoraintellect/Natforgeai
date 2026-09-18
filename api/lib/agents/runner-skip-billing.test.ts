import { beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  deductCredits,
  recordAiUsage,
  checkCredits,
  adminAdjustCredits,
} from "../billing/credit-engine";
import { enforceCostControl } from "../billing/cost-control";
import { runAgent } from "./runner";

function createMockDb() {
  const agentRunRows: Array<{ id: number; status: string }> = [];
  return {
    agentRunRows,
    insert: vi.fn((table: any) => ({
      values: vi.fn(async (values: any) => {
        const tableName = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
        expect(tableName).toBe("agent_runs");
        const id = agentRunRows.length + 1;
        agentRunRows.push({ id, status: values.status });
        return [{ insertId: id }];
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((set: any) => ({
        where: vi.fn(async () => {
          const tableName = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
          expect(tableName).toBe("agent_runs");
          return [];
        }),
      })),
    })),
  };
}

const schema = z.object({ text: z.string() });

describe("runAgent skipBilling containment (WBS 4E.3 TEST H runner boundary)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    vi.mocked(generateObject).mockResolvedValue({
      object: { text: "hello" },
      usage: { promptTokens: 11, completionTokens: 7 },
    } as any);
  });

  it("skipBilling=true deducts no credits and writes no ai_usage record by this agent path", async () => {
    await runAgent({ userId: 10, campaignId: 1, agentType: "creative", prompt: "p", schema, skipBilling: true });

    expect(enforceCostControl).not.toHaveBeenCalled();
    expect(checkCredits).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(recordAiUsage).not.toHaveBeenCalled();

    // agent_runs rows ARE still written by the underlying agent execution.
    // They are execution telemetry, not billing records — this is the expected
    // distinction for the skipBilling containment claim.
    const db = vi.mocked(getDb).mock.results[0].value as any;
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.agentRunRows).toEqual([{ id: 1, status: "running" }]);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("explicit skipBilling=false performs normal billing (contrast control proving the spies are wired)", async () => {
    await runAgent({ userId: 10, campaignId: 1, agentType: "creative", prompt: "p", schema, skipBilling: false });

    expect(enforceCostControl).toHaveBeenCalledTimes(1);
    expect(checkCredits).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 10, amount: 7, type: "agent_deduction" })
    );
    expect(recordAiUsage).toHaveBeenCalledTimes(1);
  });

  it("a failed generation with skipBilling=true never deducts or refunds credits", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("model returned malformed payload"));

    await expect(
      runAgent({ userId: 10, campaignId: 1, agentType: "creative", prompt: "p", schema, skipBilling: true })
    ).rejects.toThrow("model returned malformed payload");

    expect(deductCredits).not.toHaveBeenCalled();
    expect(adminAdjustCredits).not.toHaveBeenCalled();
    expect(recordAiUsage).not.toHaveBeenCalled();
    const db = vi.mocked(getDb).mock.results[0].value as any;
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});
