import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import { pauseWorkflowForCostLimit } from "./cost-control";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function createFakeDb() {
  const updateCalls: Array<{ table: string; set: unknown }> = [];
  const insertCalls: Array<{ table: string; values: unknown }> = [];
  const selectCalls: string[] = [];

  const campaignRow = {
    id: 7,
    userId: 22,
    workflowState: "creatives_generating",
    workflowContext: { startedAt: "2026-06-01T00:00:00.000Z" },
  };

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async (_n: number) => {
            const name = getTableName(table) ?? "";
            selectCalls.push(name);
            return name === "campaigns" ? [campaignRow] : [];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (setPayload: unknown) => ({
        where: async (_conds: unknown) => {
          updateCalls.push({ table: getTableName(table) ?? "unknown", set: setPayload });
          return [{ affectedRows: 1 }];
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        insertCalls.push({ table: getTableName(table) ?? "unknown", values });
        return [{ insertId: 5001 }];
      },
    }),
  } as never;

  return { db, updateCalls, insertCalls, selectCalls };
}

describe("pauseWorkflowForCostLimit continuation provenance (WBS-R1.4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pauses, requests budget approval and records pre-pause resume provenance", async () => {
    const fake = createFakeDb();
    vi.mocked(getDb).mockReturnValue(fake.db as any);

    await pauseWorkflowForCostLimit(
      22,
      7,
      "Insufficient credits for autonomous workflow",
      { kind: "agent_run_complete", continuationId: 501 }
    );

    // Budget-increase governance artifact.
    expect(fake.insertCalls).toHaveLength(1);
    expect(fake.insertCalls[0].table).toBe("approval_requests");
    const approval = fake.insertCalls[0].values as { approvalType: string; status: string };
    expect(approval.approvalType).toBe("budget_increase");
    expect(approval.status).toBe("pending");

    // Write order: durable provenance FIRST, THEN the state clobber. A crash
    // after the provenance write leaves a restorable pause; a crash between a
    // clobber and a later provenance write would strand the campaign paused
    // with no continuation coordinates.
    expect(fake.updateCalls).toHaveLength(2);
    const provenanceWrite = fake.updateCalls[0].set as {
      workflowContext: Record<string, unknown>;
    };
    expect(provenanceWrite.workflowContext).toEqual({
      startedAt: "2026-06-01T00:00:00.000Z",
      costPause: {
        kind: "agent_run_complete",
        continuationId: 501,
        reason: "Insufficient credits for autonomous workflow",
        recordedAt: expect.any(String),
        workflowState: "creatives_generating",
        // WBS-R4 A3-3: the pause is bound to the approval created for it.
        budgetIncreaseApprovalId: 5001,
      },
    });

    const clobber = fake.updateCalls[1].set as { workflowState: string; status: string };
    expect(clobber.workflowState).toBe("launch_approval_required");
    expect(clobber.status).toBe("paused");
    expect("workflowContext" in clobber).toBe(false);
  });

  it("records no provenance when no continuation is supplied (legacy callers)", async () => {
    const fake = createFakeDb();
    vi.mocked(getDb).mockReturnValue(fake.db as any);

    await pauseWorkflowForCostLimit(22, 7, "Insufficient credits for autonomous workflow");

    expect(fake.updateCalls).toHaveLength(1);
    const setPayload = fake.updateCalls[0].set as Record<string, unknown>;
    expect("workflowContext" in setPayload).toBe(false);
  });
});
