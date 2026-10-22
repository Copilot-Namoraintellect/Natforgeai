import { describe, it, expect } from "vitest";
import { persistNextCycleInstruction } from "./next-cycle-persistence";

interface FakeCampaign {
  id: number;
  userId: number;
  workflowContext: unknown;
}

interface FakeExecutorOptions {
  /**
   * Programmed result per scoped campaign read, consumed in order. The first
   * entry answers the authority read; a second entry answers the
   * zero-row-UPDATE reconciliation reread. `undefined` models a
   * missing/wrong-owner campaign.
   */
  reads: Array<FakeCampaign | undefined>;
  /** affectedRows returned by the conditional UPDATE (default 1). */
  updateAffectedRows?: number;
}

function createFakeExecutor(options: FakeExecutorOptions) {
  const updateCalls: Array<{ set: unknown }> = [];
  let readIndex = 0;

  const executor = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async (_n: number) => {
            const row = options.reads[readIndex++];
            return row ? [{ id: row.id, workflowContext: row.workflowContext }] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (setPayload: unknown) => ({
        where: async (_conds: unknown) => {
          updateCalls.push({ set: setPayload });
          return [{ affectedRows: options.updateAffectedRows ?? 1 }];
        },
      }),
    }),
  } as never;

  return { executor, updateCalls };
}

function campaign(workflowContext: unknown): FakeCampaign {
  return { id: 7, userId: 22, workflowContext };
}

describe("persistNextCycleInstruction", () => {
  it("writes the ready instruction on first write", async () => {
    const fake = createFakeExecutor({
      reads: [campaign({ campaignLiveAt: "2026-06-01T00:00:00.000Z" })],
    });

    const result = await persistNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
      executor: fake.executor,
    });

    expect(result).toEqual({
      instruction: { instructionId: "nci_1", status: "ready" },
      persisted: true,
    });
    expect(fake.updateCalls).toHaveLength(1);
  });

  it("preserves every other workflowContext field", async () => {
    const existing = {
      campaignLiveAt: "2026-06-01T00:00:00.000Z",
      lastTransition: { from: "a", to: "b", action: "go_live", at: "2026-06-01T00:00:00.000Z" },
      notes: "keep-me",
    };
    const fake = createFakeExecutor({ reads: [campaign(existing)] });

    await persistNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
      executor: fake.executor,
    });

    const setPayload = fake.updateCalls[0].set as {
      workflowContext: Record<string, unknown>;
    };
    expect(setPayload.workflowContext).toEqual({
      ...existing,
      nextCycle: { instructionId: "nci_1", status: "ready" },
    });
  });

  it("returns idempotently when the same instructionId already exists", async () => {
    const fake = createFakeExecutor({
      reads: [campaign({ nextCycle: { instructionId: "nci_1", status: "ready" }, other: 1 })],
    });

    const result = await persistNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
      executor: fake.executor,
    });

    expect(result).toEqual({
      instruction: { instructionId: "nci_1", status: "ready" },
      persisted: false,
    });
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("fails closed when a different instructionId already exists", async () => {
    const fake = createFakeExecutor({
      reads: [campaign({ nextCycle: { instructionId: "nci_other", status: "ready" } })],
    });

    await expect(
      persistNextCycleInstruction({
        userId: 22,
        campaignId: 7,
        instructionId: "nci_1",
        executor: fake.executor,
      })
    ).rejects.toThrow(/different next-cycle instruction/);
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("fails closed when the existing nextCycle is malformed", async () => {
    for (const nextCycle of [
      { instructionId: "", status: "ready" },
      { instructionId: "nci_1" },
      "garbage",
    ]) {
      const fake = createFakeExecutor({ reads: [campaign({ nextCycle })] });

      await expect(
        persistNextCycleInstruction({
          userId: 22,
          campaignId: 7,
          instructionId: "nci_1",
          executor: fake.executor,
        })
      ).rejects.toThrow(/next-cycle instruction/);
      expect(fake.updateCalls).toHaveLength(0);
    }
  });

  it("accepts a zero-row UPDATE when the concurrent winner has the same instructionId", async () => {
    const fake = createFakeExecutor({
      reads: [
        campaign({ campaignLiveAt: "2026-06-01T00:00:00.000Z" }),
        campaign({ nextCycle: { instructionId: "nci_1", status: "ready" } }),
      ],
      updateAffectedRows: 0,
    });

    const result = await persistNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
      executor: fake.executor,
    });

    expect(result).toEqual({
      instruction: { instructionId: "nci_1", status: "ready" },
      persisted: false,
    });
    expect(fake.updateCalls).toHaveLength(1);
  });

  it("fails closed on a zero-row UPDATE when the concurrent winner has a different instructionId", async () => {
    const fake = createFakeExecutor({
      reads: [
        campaign({}),
        campaign({ nextCycle: { instructionId: "nci_other", status: "ready" } }),
      ],
      updateAffectedRows: 0,
    });

    await expect(
      persistNextCycleInstruction({
        userId: 22,
        campaignId: 7,
        instructionId: "nci_1",
        executor: fake.executor,
      })
    ).rejects.toThrow(/different next-cycle instruction/);
  });

  it("returns null for a missing or wrong-owner campaign without writing", async () => {
    const fake = createFakeExecutor({ reads: [undefined] });

    const result = await persistNextCycleInstruction({
      userId: 22,
      campaignId: 404,
      instructionId: "nci_1",
      executor: fake.executor,
    });

    expect(result).toBeNull();
    expect(fake.updateCalls).toHaveLength(0);
  });
});
