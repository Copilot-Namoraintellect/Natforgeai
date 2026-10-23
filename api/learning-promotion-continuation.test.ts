import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/workflow/next-cycle-trigger", () => ({
  triggerNextCycleAfterLearningPromotion: vi.fn(),
}));

vi.mock("./lib/workflow/next-cycle-dispatcher", () => ({
  dispatchNextCycleInstruction: vi.fn(),
}));

import { getDb } from "./queries/connection";
import { triggerNextCycleAfterLearningPromotion } from "./lib/workflow/next-cycle-trigger";
import { dispatchNextCycleInstruction } from "./lib/workflow/next-cycle-dispatcher";
import { onApprovalResolved } from "./lib/workflow/triggers";

interface HarnessState {
  approval: Record<string, unknown>;
  campaign: { id: number; userId: number; workflowContext: Record<string, unknown> };
  triggerCalls: number;
  dispatchCalls: Array<{ userId: number; campaignId: number; instructionId: string }>;
}

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function createState(approvalStatus: "approved" | "rejected"): HarnessState {
  return {
    approval: {
      id: 31,
      userId: 22,
      campaignId: 7,
      approvalType: "high_value_proposal",
      status: approvalStatus,
      context: { source: "learning_promotion" },
    },
    campaign: { id: 7, userId: 22, workflowContext: {} },
    triggerCalls: 0,
    dispatchCalls: [],
  };
}

function installHarness(state: HarnessState) {
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const name = getTableName(table);
          const rows =
            name === "approval_requests" ? [state.approval] : name === "campaigns" ? [state.campaign] : [];
          const chainable: Record<string, unknown> = {};
          chainable.orderBy = () => chainable;
          chainable.limit = async () => rows;
          chainable.then = (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve(rows).then(resolve);
          return chainable;
        },
      }),
    }),
  } as never;
  vi.mocked(getDb).mockReturnValue(db as never);

  // Stateful fake trigger: persists the ready instruction the real trigger
  // would persist, then reports already_present on replays.
  vi.mocked(triggerNextCycleAfterLearningPromotion).mockImplementation(async () => {
    state.triggerCalls += 1;
    const nextCycle = state.campaign.workflowContext.nextCycle as
      | { instructionId: string; status: string }
      | undefined;
    if (!nextCycle) {
      state.campaign.workflowContext = {
        ...state.campaign.workflowContext,
        nextCycle: { instructionId: "nci_1", status: "ready" },
      };
      return { outcome: "created", instructionId: "nci_1" };
    }
    return { outcome: "already_present", instructionId: nextCycle.instructionId };
  });

  // Stateful fake dispatcher: claims the instruction (ready → dispatched),
  // exactly like the governed dispatcher's CAS.
  vi.mocked(dispatchNextCycleInstruction).mockImplementation(
    async (input: { userId: number; campaignId: number; instructionId: string }) => {
      state.dispatchCalls.push(input);
      state.campaign.workflowContext = {
        ...state.campaign.workflowContext,
        nextCycle: { instructionId: input.instructionId, status: "dispatched" },
      };
      return {
        outcome: "dispatched",
        instructionId: input.instructionId,
        strategyRunId: 601,
        approvalRequestId: 9001,
      };
    }
  );
}

describe("onApprovalResolved learning-promotion next cycle (WBS-R4 A4-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers then dispatches exactly one next cycle for an approved promotion", async () => {
    const state = createState("approved");
    installHarness(state);

    await onApprovalResolved(31, "approved", 22);

    expect(state.triggerCalls).toBe(1);
    expect(triggerNextCycleAfterLearningPromotion).toHaveBeenCalledWith({
      userId: 22,
      campaignId: 7,
    });
    expect(state.dispatchCalls).toEqual([{ userId: 22, campaignId: 7, instructionId: "nci_1" }]);
  });

  it("does not double-dispatch a duplicate resolution", async () => {
    const state = createState("approved");
    installHarness(state);

    await onApprovalResolved(31, "approved", 22);
    await onApprovalResolved(31, "approved", 22);

    // The idempotent trigger runs again, but the consumed (dispatched)
    // instruction is not re-dispatched.
    expect(state.triggerCalls).toBe(2);
    expect(state.dispatchCalls).toHaveLength(1);
  });

  it("does nothing for a rejected promotion decision", async () => {
    const state = createState("rejected");
    installHarness(state);

    await onApprovalResolved(31, "rejected", 22);

    expect(state.triggerCalls).toBe(0);
    expect(state.dispatchCalls).toHaveLength(0);
    expect(triggerNextCycleAfterLearningPromotion).not.toHaveBeenCalled();
    expect(dispatchNextCycleInstruction).not.toHaveBeenCalled();
  });

  it("never rejects the resolution when the trigger boundary fails", async () => {
    const state = createState("approved");
    installHarness(state);
    vi.mocked(triggerNextCycleAfterLearningPromotion).mockRejectedValue(
      new Error("strategy authority missing")
    );

    await expect(onApprovalResolved(31, "approved", 22)).resolves.toBeUndefined();
    expect(dispatchNextCycleInstruction).not.toHaveBeenCalled();
  });
});
