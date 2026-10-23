import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import {
  canRunAutonomousWorkflow,
  pauseWorkflowForCostLimit,
} from "./cost-control";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

interface FakeCampaign {
  id: number;
  userId: number;
  status: string;
  workflowState: string;
  workflowContext?: unknown;
}

function createFakeDb(input: {
  campaign: FakeCampaign | null;
  walletBalance?: number;
  pendingBudgetApprovals?: Array<{ id: number }>;
}) {
  const updateCalls: Array<{ table: string; set: unknown }> = [];
  const insertCalls: Array<{ table: string; values: unknown }> = [];

  const wallet =
    input.walletBalance === undefined
      ? null
      : { id: 1, userId: 22, balance: input.walletBalance };

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async (_n: number) => {
            const name = getTableName(table) ?? "";
            if (name === "campaigns") return input.campaign ? [input.campaign] : [];
            if (name === "approval_requests") return input.pendingBudgetApprovals ?? [];
            if (name === "credit_wallets") return wallet ? [wallet] : [];
            return [];
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
        return [{ insertId: 9001 }];
      },
    }),
  } as never;

  return { db, updateCalls, insertCalls };
}

const PAUSED_CAMPAIGN: FakeCampaign = {
  id: 7,
  userId: 22,
  status: "paused",
  workflowState: "launch_approval_required",
  workflowContext: {
    costPause: {
      kind: "agent_run_complete",
      continuationId: 501,
      reason: "Insufficient credits for autonomous workflow",
      recordedAt: "2026-06-01T00:00:00.000Z",
      workflowState: "creatives_generating",
    },
  },
};

/** Active campaign with no recorded cost pause (fresh pause target). */
const ACTIVE_CAMPAIGN: FakeCampaign = {
  id: 7,
  userId: 22,
  status: "active",
  workflowState: "creatives_generating",
  workflowContext: { startedAt: "2026-06-01T00:00:00.000Z" },
};

describe("canRunAutonomousWorkflow paused-gate semantics (WBS-R4E budget resume)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows a bare affordability probe (no continuation) on a cost-paused campaign with sufficient balance", async () => {
    const fake = createFakeDb({ campaign: PAUSED_CAMPAIGN, walletBalance: 40 });
    vi.mocked(getDb).mockReturnValue(fake.db as any);

    const result = await canRunAutonomousWorkflow(22, 7);

    expect(result.allowed).toBe(true);
  });

  it("still rejects a forward-dispatch gate (continuation supplied) on a paused campaign", async () => {
    const fake = createFakeDb({ campaign: PAUSED_CAMPAIGN, walletBalance: 40 });
    vi.mocked(getDb).mockReturnValue(fake.db as any);

    const result = await canRunAutonomousWorkflow(22, 7, {
      kind: "agent_run_complete",
      continuationId: 501,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Campaign is paused");
  });

  it("keeps a paused workflow blocked when the affordability probe still fails", async () => {
    // The campaign is paused with its original cost pause and an already
    // pending budget approval: the re-pause must not duplicate the approval.
    const fake = createFakeDb({
      campaign: PAUSED_CAMPAIGN,
      walletBalance: 1,
      pendingBudgetApprovals: [{ id: 4242 }],
    });
    vi.mocked(getDb).mockReturnValue(fake.db as any);

    const result = await canRunAutonomousWorkflow(22, 7);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Insufficient credits. Workflow paused.");
    // The probe re-pauses without a continuation (legacy shape): only the
    // state clobber writes, and no duplicate budget approval is created.
    expect(fake.updateCalls).toHaveLength(1);
    const clobber = fake.updateCalls[0].set as { status: string };
    expect(clobber.status).toBe("paused");
    const approvalInserts = fake.insertCalls.filter((c) => c.table === "approval_requests");
    expect(approvalInserts).toHaveLength(0);
  });
});

describe("pauseWorkflowForCostLimit budget-approval dedup (WBS-R4E)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates exactly one budget_increase approval when none is pending", async () => {
    const fake = createFakeDb({ campaign: ACTIVE_CAMPAIGN, pendingBudgetApprovals: [] });
    vi.mocked(getDb).mockReturnValue(fake.db as any);

    await pauseWorkflowForCostLimit(22, 7, "Insufficient credits for autonomous workflow", {
      kind: "agent_run_complete",
      continuationId: 501,
    });

    const approvalInserts = fake.insertCalls.filter((c) => c.table === "approval_requests");
    expect(approvalInserts).toHaveLength(1);
    // Provenance is recorded before the state clobber.
    const provenanceWrite = fake.updateCalls[0].set as {
      workflowContext: Record<string, unknown>;
    };
    expect(provenanceWrite.workflowContext).toHaveProperty("costPause");
    const clobber = fake.updateCalls[1].set as { status: string };
    expect(clobber.status).toBe("paused");
  });

  it("does not create a duplicate budget approval when one is already pending", async () => {
    const fake = createFakeDb({
      campaign: ACTIVE_CAMPAIGN,
      pendingBudgetApprovals: [{ id: 4242 }],
    });
    vi.mocked(getDb).mockReturnValue(fake.db as any);

    await pauseWorkflowForCostLimit(22, 7, "Insufficient credits for autonomous workflow", {
      kind: "agent_run_complete",
      continuationId: 501,
    });

    const approvalInserts = fake.insertCalls.filter((c) => c.table === "approval_requests");
    expect(approvalInserts).toHaveLength(0);
    // The pause itself still lands (provenance + clobber).
    expect(fake.updateCalls).toHaveLength(2);
  });
});
