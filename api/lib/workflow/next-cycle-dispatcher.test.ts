import { describe, it, expect } from "vitest";
import type { StrategyApprovalLineage } from "./strategy-approval";
import { dispatchNextCycleInstruction } from "./next-cycle-dispatcher";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

interface FakeRead {
  table: string;
  row: Record<string, unknown> | undefined;
}

interface FakeExecutorOptions {
  /**
   * Programmed scoped reads consumed in order, discriminated by drizzle
   * table name. `row: undefined` models a missing/wrong-owner row.
   */
  reads: FakeRead[];
  /** affectedRows for update call N (1-based); default 1. */
  updateAffectedRows?: Partial<Record<number, number>>;
}

function createFakeExecutor(options: FakeExecutorOptions) {
  const updateCalls: Array<{ set: unknown }> = [];
  const readLog: FakeRead[] = [];
  let pendingReads = [...options.reads];

  const nextRead = (table: string): Record<string, unknown> | undefined => {
    const index = pendingReads.findIndex(r => r.table === table);
    if (index < 0) return undefined;
    const [entry] = pendingReads.splice(index, 1);
    readLog.push(entry);
    return entry.row;
  };

  const executor = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async (_n: number) => {
            const row = nextRead(getTableName(table) ?? "");
            return row ? [row] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (setPayload: unknown) => ({
        where: async (_conds: unknown) => {
          updateCalls.push({ set: setPayload });
          const affected =
            options.updateAffectedRows?.[updateCalls.length] ?? 1;
          return [{ affectedRows: affected }];
        },
      }),
    }),
  } as never;

  return { executor, updateCalls };
}

function campaignRow(workflowContext: unknown): Record<string, unknown> {
  return {
    id: 7,
    userId: 22,
    name: "Summer Launch",
    businessId: 5,
    workflowContext,
  };
}

function businessRow(): Record<string, unknown> {
  return {
    id: 5,
    userId: 22,
    name: "Acme Corp",
    industry: "retail",
    location: "Cape Town",
    productOrService: "Handmade leather bags",
    targetCustomer: "Professionals 25-45",
    brandTone: "premium",
    mainGoal: "Increase walk-ins",
    monthlyBudget: 1000,
    preferredPlatforms: "instagram,facebook",
    website: "https://acme.example.com",
    websiteEvidence: null,
  };
}

function makeLineage(): StrategyApprovalLineage {
  return {
    creativeBriefFingerprint: "fp_abc",
    strategyRunId: 900,
    strategySnapshotId: "strategy_snapshot_1",
    strategyVersion: 3,
    businessDnaSnapshotId: "dna_1",
    strategyHashSha256: "ab".repeat(32),
    approvalRequestId: 55,
    status: "pending",
  };
}

const READY = { nextCycle: { instructionId: "nci_1", status: "ready" } };

describe("dispatchNextCycleInstruction", () => {
  it("dispatches a ready instruction exactly once through the strategy pathway", async () => {
    const fake = createFakeExecutor({
      reads: [
        { table: "campaigns", row: campaignRow(READY) },
        { table: "campaigns", row: campaignRow(READY) },
        { table: "businesses", row: businessRow() },
        { table: "campaigns", row: campaignRow({ strategyGeneratedAt: "2026-06-12T00:00:00.000Z" }) },
      ],
    });
    const lineage = makeLineage();
    const runCalls: unknown[] = [];
    const reviewCalls: unknown[] = [];

    const result = await dispatchNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
      deps: {
        executor: fake.executor,
        runStrategy: async (input) => {
          runCalls.push(input);
          return { runId: 900 };
        },
        createStrategyReview: async (input) => {
          reviewCalls.push(input);
          return { approvalRequestId: 55, lineage };
        },
      },
    });

    expect(result).toEqual({
      outcome: "dispatched",
      instructionId: "nci_1",
      strategyRunId: 900,
      approvalRequestId: 55,
    });
    expect(runCalls).toHaveLength(1);
    expect(reviewCalls).toHaveLength(1);
    expect((runCalls[0] as { business: { name: string } }).business.name).toBe("Acme Corp");

    // Claim CAS + terminal merge = exactly two writes.
    expect(fake.updateCalls).toHaveLength(2);
    const terminal = fake.updateCalls[1].set as { workflowContext: Record<string, unknown> };
    expect(terminal.workflowContext).toEqual({
      strategyGeneratedAt: "2026-06-12T00:00:00.000Z",
      nextCycle: { instructionId: "nci_1", status: "dispatched" },
      strategyApprovalLineage: lineage,
    });
  });

  it("returns already_dispatched without re-running when a concurrent dispatcher won", async () => {
    const fake = createFakeExecutor({
      reads: [
        { table: "campaigns", row: campaignRow(READY) },
        { table: "campaigns", row: campaignRow({ nextCycle: { instructionId: "nci_1", status: "dispatched" } }) },
      ],
      updateAffectedRows: { 1: 0 },
    });
    let ran = 0;

    const result = await dispatchNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
      deps: {
        executor: fake.executor,
        runStrategy: async () => {
          ran += 1;
          return { runId: 900 };
        },
      },
    });

    expect(result).toEqual({ outcome: "already_dispatched", instructionId: "nci_1" });
    expect(ran).toBe(0);
  });

  it("does not re-run when the instruction is already dispatched", async () => {
    const fake = createFakeExecutor({
      reads: [
        { table: "campaigns", row: campaignRow({ nextCycle: { instructionId: "nci_1", status: "dispatched" } }) },
      ],
    });
    let ran = 0;

    const result = await dispatchNextCycleInstruction({
      userId: 22,
      campaignId: 7,
      instructionId: "nci_1",
      deps: {
        executor: fake.executor,
        runStrategy: async () => {
          ran += 1;
          return { runId: 900 };
        },
      },
    });

    expect(result).toEqual({ outcome: "already_dispatched", instructionId: "nci_1" });
    expect(ran).toBe(0);
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("fails closed without running when the instruction failed", async () => {
    const fake = createFakeExecutor({
      reads: [
        { table: "campaigns", row: campaignRow({ nextCycle: { instructionId: "nci_1", status: "failed" } }) },
      ],
    });
    let ran = 0;

    await expect(
      dispatchNextCycleInstruction({
        userId: 22,
        campaignId: 7,
        instructionId: "nci_1",
        deps: {
          executor: fake.executor,
          runStrategy: async () => {
            ran += 1;
            return { runId: 900 };
          },
        },
      })
    ).rejects.toThrow(/cannot transition to dispatched/);
    expect(ran).toBe(0);
  });

  it("fails closed without running when the instructionId conflicts", async () => {
    const fake = createFakeExecutor({
      reads: [
        { table: "campaigns", row: campaignRow({ nextCycle: { instructionId: "nci_other", status: "ready" } }) },
      ],
    });
    let ran = 0;

    await expect(
      dispatchNextCycleInstruction({
        userId: 22,
        campaignId: 7,
        instructionId: "nci_1",
        deps: {
          executor: fake.executor,
          runStrategy: async () => {
            ran += 1;
            return { runId: 900 };
          },
        },
      })
    ).rejects.toThrow(/different next-cycle instruction/);
    expect(ran).toBe(0);
  });

  it("fails closed without running when no instruction exists", async () => {
    const fake = createFakeExecutor({
      reads: [{ table: "campaigns", row: campaignRow({ campaignLiveAt: "2026-06-01T00:00:00.000Z" }) }],
    });
    let ran = 0;

    await expect(
      dispatchNextCycleInstruction({
        userId: 22,
        campaignId: 7,
        instructionId: "nci_1",
        deps: {
          executor: fake.executor,
          runStrategy: async () => {
            ran += 1;
            return { runId: 900 };
          },
        },
      })
    ).rejects.toThrow(/no next-cycle instruction/);
    expect(ran).toBe(0);
  });

  it("fails closed without running when the campaign is missing", async () => {
    const fake = createFakeExecutor({ reads: [{ table: "campaigns", row: undefined }] });
    let ran = 0;

    await expect(
      dispatchNextCycleInstruction({
        userId: 22,
        campaignId: 404,
        instructionId: "nci_1",
        deps: {
          executor: fake.executor,
          runStrategy: async () => {
            ran += 1;
            return { runId: 900 };
          },
        },
      })
    ).rejects.toThrow(/not found/);
    expect(ran).toBe(0);
  });

  it("records failed and rethrows when the strategy run throws", async () => {
    const fake = createFakeExecutor({
      reads: [
        { table: "campaigns", row: campaignRow(READY) },
        { table: "campaigns", row: campaignRow(READY) },
        { table: "businesses", row: businessRow() },
        { table: "campaigns", row: campaignRow({ nextCycle: { instructionId: "nci_1", status: "dispatched" } }) },
      ],
    });
    const boom = new Error("provider down");

    await expect(
      dispatchNextCycleInstruction({
        userId: 22,
        campaignId: 7,
        instructionId: "nci_1",
        deps: {
          executor: fake.executor,
          runStrategy: async () => {
            throw boom;
          },
        },
      })
    ).rejects.toBe(boom);

    // Claim CAS + failure transition = two writes; the second records failed.
    expect(fake.updateCalls).toHaveLength(2);
    const failure = fake.updateCalls[1].set as { workflowContext: Record<string, unknown> };
    expect(failure.workflowContext).toEqual({
      nextCycle: { instructionId: "nci_1", status: "failed" },
    });
  });

  it("records failed when the campaign has no durable business authority", async () => {
    const orphan = { ...campaignRow(READY), businessId: null };
    const fake = createFakeExecutor({
      reads: [
        { table: "campaigns", row: orphan },
        { table: "campaigns", row: orphan },
        { table: "campaigns", row: campaignRow({ nextCycle: { instructionId: "nci_1", status: "dispatched" } }) },
      ],
    });
    let ran = 0;

    await expect(
      dispatchNextCycleInstruction({
        userId: 22,
        campaignId: 7,
        instructionId: "nci_1",
        deps: {
          executor: fake.executor,
          runStrategy: async () => {
            ran += 1;
            return { runId: 900 };
          },
        },
      })
    ).rejects.toThrow(/no durable business authority/);
    expect(ran).toBe(0);

    const failure = fake.updateCalls[1].set as { workflowContext: Record<string, unknown> };
    expect(failure.workflowContext).toEqual({
      nextCycle: { instructionId: "nci_1", status: "failed" },
    });
  });
});
