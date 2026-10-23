import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/workflow/next-cycle-persistence", () => ({
  retryFailedNextCycleInstruction: vi.fn(),
}));

vi.mock("./lib/workflow/next-cycle-dispatcher", () => ({
  dispatchNextCycleInstruction: vi.fn(),
}));

import { getDb } from "./queries/connection";
import { retryFailedNextCycleInstruction } from "./lib/workflow/next-cycle-persistence";
import { dispatchNextCycleInstruction } from "./lib/workflow/next-cycle-dispatcher";
import { autonomousWorkflowRouter } from "./autonomous-workflow-router";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function installCampaign(nextCycle: unknown) {
  const campaign = {
    id: 7,
    userId: 22,
    workflowContext: nextCycle === undefined ? {} : { nextCycle },
  };
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => (getTableName(table) === "campaigns" ? [campaign] : []),
        }),
      }),
    }),
  } as never;
  vi.mocked(getDb).mockReturnValue(db as never);
  return campaign;
}

function caller() {
  return autonomousWorkflowRouter.createCaller({
    resHeaders: new Headers(),
    user: { id: 22, tierSlug: "free" },
    session: { verified: true },
  } as never);
}

describe("autonomousWorkflow.retryNextCycleDispatch (WBS-R4 A4-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries a failed instruction and dispatches it", async () => {
    installCampaign({ instructionId: "nci_1", status: "failed" });
    vi.mocked(retryFailedNextCycleInstruction).mockResolvedValue({ retried: true });
    vi.mocked(dispatchNextCycleInstruction).mockResolvedValue({
      outcome: "dispatched",
      instructionId: "nci_1",
      strategyRunId: 601,
      approvalRequestId: 9001,
    });

    const result = await caller().retryNextCycleDispatch({ campaignId: 7 });

    expect(result.outcome).toBe("retried_and_dispatched");
    expect(retryFailedNextCycleInstruction).toHaveBeenCalledWith({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
    });
    expect(dispatchNextCycleInstruction).toHaveBeenCalledWith({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
    });
  });

  it("no-ops when the failed instruction cannot be retried", async () => {
    installCampaign({ instructionId: "nci_1", status: "failed" });
    vi.mocked(retryFailedNextCycleInstruction).mockResolvedValue({
      retried: false,
      reason: "different_instruction",
    });

    const result = await caller().retryNextCycleDispatch({ campaignId: 7 });

    expect(result).toEqual({
      outcome: "noop",
      status: "failed",
      reason: "different_instruction",
    });
    expect(dispatchNextCycleInstruction).not.toHaveBeenCalled();
  });

  it("reports retried_dispatch_failed when the dispatch throws and stays retryable", async () => {
    installCampaign({ instructionId: "nci_1", status: "failed" });
    vi.mocked(retryFailedNextCycleInstruction).mockResolvedValue({ retried: true });
    vi.mocked(dispatchNextCycleInstruction).mockRejectedValue(new Error("strategy run failed"));

    const result = await caller().retryNextCycleDispatch({ campaignId: 7 });

    expect(result).toEqual({
      outcome: "retried_dispatch_failed",
      status: "ready",
      error: "strategy run failed",
    });
  });

  it("dispatches a ready instruction directly", async () => {
    installCampaign({ instructionId: "nci_1", status: "ready" });
    vi.mocked(dispatchNextCycleInstruction).mockResolvedValue({
      outcome: "dispatched",
      instructionId: "nci_1",
      strategyRunId: 602,
      approvalRequestId: 9002,
    });

    const result = await caller().retryNextCycleDispatch({ campaignId: 7 });

    expect(result).toMatchObject({
      outcome: "dispatched",
      instructionId: "nci_1",
      strategyRunId: 602,
      approvalRequestId: 9002,
    });
    expect(retryFailedNextCycleInstruction).not.toHaveBeenCalled();
  });

  it("no-ops when a concurrent caller already dispatched the ready instruction", async () => {
    installCampaign({ instructionId: "nci_1", status: "ready" });
    vi.mocked(dispatchNextCycleInstruction).mockResolvedValue({
      outcome: "already_dispatched",
      instructionId: "nci_1",
    });

    const result = await caller().retryNextCycleDispatch({ campaignId: 7 });

    expect(result).toEqual({ outcome: "noop", status: "dispatched" });
  });

  it("no-ops on a dispatched instruction without touching the boundaries", async () => {
    installCampaign({ instructionId: "nci_1", status: "dispatched" });

    const result = await caller().retryNextCycleDispatch({ campaignId: 7 });

    expect(result).toEqual({ outcome: "noop", status: "dispatched" });
    expect(retryFailedNextCycleInstruction).not.toHaveBeenCalled();
    expect(dispatchNextCycleInstruction).not.toHaveBeenCalled();
  });

  it("no-ops when no next-cycle instruction exists", async () => {
    installCampaign(undefined);

    const result = await caller().retryNextCycleDispatch({ campaignId: 7 });

    expect(result).toEqual({ outcome: "noop", status: null });
    expect(dispatchNextCycleInstruction).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed instruction", async () => {
    installCampaign({ instructionId: "nci_1", status: "pending" });

    await expect(caller().retryNextCycleDispatch({ campaignId: 7 })).rejects.toThrow(
      /malformed next-cycle instruction/
    );
    expect(dispatchNextCycleInstruction).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for a missing or wrong-owner campaign", async () => {
    installCampaign(undefined);
    vi.mocked(getDb).mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    } as never);

    await expect(caller().retryNextCycleDispatch({ campaignId: 404 })).rejects.toThrow(
      /Campaign not found/
    );
  });
});
