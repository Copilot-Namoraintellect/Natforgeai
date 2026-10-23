import { describe, it, expect } from "vitest";
import {
  persistNextCycleInstruction,
  retryFailedNextCycleInstruction,
} from "./next-cycle-persistence";

interface FakeCampaign {
  id: number;
  userId: number;
  workflowContext: unknown;
}

function createFakeExecutor(
  reads: Array<FakeCampaign | undefined>,
  updateAffectedRows = 1
) {
  const updateCalls: Array<{ set: unknown }> = [];
  let readIndex = 0;

  const executor = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async (_n: number) => {
            const row = reads[readIndex++];
            return row ? [{ id: row.id, workflowContext: row.workflowContext }] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (setPayload: unknown) => ({
        where: async (_conds: unknown) => {
          updateCalls.push({ set: setPayload });
          return [{ affectedRows: updateAffectedRows }];
        },
      }),
    }),
  } as never;

  return { executor, updateCalls };
}

function campaign(workflowContext: unknown): FakeCampaign {
  return { id: 7, userId: 22, workflowContext };
}

describe("persistNextCycleInstruction repeated-cycle semantics (WBS-R4 A4-2)", () => {
  it("still throws when a different instruction is ready (assertion not weakened)", async () => {
    const fake = createFakeExecutor([
      campaign({ nextCycle: { instructionId: "nci_old", status: "ready" } }),
    ]);

    await expect(
      persistNextCycleInstruction({
        userId: 22,
        campaignId: 7,
        instructionId: "nci_new",
        executor: fake.executor,
      })
    ).rejects.toThrow(/different next-cycle instruction/);
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("still replays an identical ready instruction idempotently", async () => {
    const fake = createFakeExecutor([
      campaign({ nextCycle: { instructionId: "nci_1", status: "ready" }, other: 1 }),
    ]);

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

  it("replaces a dispatched instruction with a different newly promoted instruction", async () => {
    const fake = createFakeExecutor([
      campaign({ nextCycle: { instructionId: "nci_old", status: "dispatched" } }),
    ]);

    const result = await persistNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_new",
      executor: fake.executor,
    });

    expect(result).toEqual({
      instruction: { instructionId: "nci_new", status: "ready" },
      persisted: true,
    });
    expect(fake.updateCalls).toHaveLength(1);
    const setPayload = fake.updateCalls[0].set as { workflowContext: Record<string, unknown> };
    expect(setPayload.workflowContext.nextCycle).toEqual({
      instructionId: "nci_new",
      status: "ready",
    });
  });

  it("replaces a failed instruction with a different newly promoted instruction", async () => {
    const fake = createFakeExecutor([
      campaign({ nextCycle: { instructionId: "nci_old", status: "failed" } }),
    ]);

    const result = await persistNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_new",
      executor: fake.executor,
    });

    expect(result).toEqual({
      instruction: { instructionId: "nci_new", status: "ready" },
      persisted: true,
    });
    expect(fake.updateCalls).toHaveLength(1);
  });

  it("resets an identical failed instruction to ready only with retry: true", async () => {
    const withoutRetry = createFakeExecutor([
      campaign({ nextCycle: { instructionId: "nci_1", status: "failed" } }),
    ]);
    const noRetryResult = await persistNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
      executor: withoutRetry.executor,
    });
    expect(noRetryResult).toEqual({
      instruction: { instructionId: "nci_1", status: "failed" },
      persisted: false,
    });
    expect(withoutRetry.updateCalls).toHaveLength(0);

    // retry: true performs the CAS reset (second read serves the retry).
    const withRetry = createFakeExecutor([
      campaign({ nextCycle: { instructionId: "nci_1", status: "failed" } }),
      campaign({ nextCycle: { instructionId: "nci_1", status: "failed" } }),
    ]);
    const retryResult = await persistNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
      retry: true,
      executor: withRetry.executor,
    });
    expect(retryResult).toEqual({
      instruction: { instructionId: "nci_1", status: "ready" },
      persisted: true,
    });
    expect(withRetry.updateCalls).toHaveLength(1);
    const setPayload = withRetry.updateCalls[0].set as {
      workflowContext: Record<string, unknown>;
    };
    expect(setPayload.workflowContext.nextCycle).toEqual({
      instructionId: "nci_1",
      status: "ready",
    });
  });
});

describe("retryFailedNextCycleInstruction (WBS-R4 A4-2)", () => {
  it("CAS-resets an identical failed instruction to ready", async () => {
    const fake = createFakeExecutor([
      campaign({ nextCycle: { instructionId: "nci_1", status: "failed" } }),
    ]);

    const result = await retryFailedNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
      executor: fake.executor,
    });

    expect(result).toEqual({ retried: true });
    expect(fake.updateCalls).toHaveLength(1);
    const setPayload = fake.updateCalls[0].set as { workflowContext: Record<string, unknown> };
    expect(setPayload.workflowContext.nextCycle).toEqual({
      instructionId: "nci_1",
      status: "ready",
    });
  });

  it("refuses to retry a non-failed instruction", async () => {
    for (const status of ["ready", "dispatched"] as const) {
      const fake = createFakeExecutor([
        campaign({ nextCycle: { instructionId: "nci_1", status } }),
      ]);
      const result = await retryFailedNextCycleInstruction({
        userId: 22,
        campaignId: 7,
        instructionId: "nci_1",
        executor: fake.executor,
      });
      expect(result).toEqual({ retried: false, reason: expect.stringContaining(status) });
      expect(fake.updateCalls).toHaveLength(0);
    }
  });

  it("refuses to retry a different instructionId and reports the reason", async () => {
    const fake = createFakeExecutor([
      campaign({ nextCycle: { instructionId: "nci_other", status: "failed" } }),
    ]);
    const result = await retryFailedNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
      executor: fake.executor,
    });
    expect(result).toEqual({ retried: false, reason: "different_instruction" });
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("reports when no next-cycle instruction exists", async () => {
    const fake = createFakeExecutor([campaign({})]);
    const result = await retryFailedNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
      executor: fake.executor,
    });
    expect(result).toEqual({ retried: false, reason: "no_next_cycle_instruction" });
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("returns null for a missing or wrong-owner campaign", async () => {
    const fake = createFakeExecutor([undefined]);
    const result = await retryFailedNextCycleInstruction({
      userId: 22,
      campaignId: 404,
      instructionId: "nci_1",
      executor: fake.executor,
    });
    expect(result).toBeNull();
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("accepts a zero-row UPDATE when a concurrent retrier already reset the same instruction", async () => {
    const fake = createFakeExecutor(
      [
        campaign({ nextCycle: { instructionId: "nci_1", status: "failed" } }),
        campaign({ nextCycle: { instructionId: "nci_1", status: "ready" } }),
      ],
      0
    );
    const result = await retryFailedNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
      executor: fake.executor,
    });
    expect(result).toEqual({ retried: false, reason: "already_retried" });
  });
});
