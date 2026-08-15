import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(),
}));

vi.mock("./lib/workflow/engine", () => ({
  transitionCampaignState: vi.fn(async () => "creatives_generating"),
  createApprovalRequest: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("./lib/workflow/triggers", () => ({
  onAgentRunComplete: vi.fn(async () => undefined),
}));

vi.mock("./lib/creative/creative-generation-claim", () => ({
  generateOwnerToken: vi.fn(() => "test-owner-token"),
  acquireCreativeGenerationClaim: vi.fn(async () => ({
    acquired: true,
    claim: { id: 1001, ownerToken: "test-owner-token" },
  })),
  attachCreativeGenerationOperationReference: vi.fn(async () => ({ attached: true })),
  releaseClaimSafely: vi.fn(),
  releaseClaimWithResult: vi.fn(async () => ({ released: true })),
  calculateLeaseExpiresAt: vi.fn(() => new Date(Date.now() + 300_000)),
  createClaimHeartbeatController: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    assertStillOwned: vi.fn(async () => undefined),
    abortSignal: undefined,
    lostOwnership: false,
  })),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

interface MockDbState {
  agentRunsRows: any[];
  insertedRows: any[];
  updatedRows: any[];
}

function createMockDb({ existingCreativeRun }: { existingCreativeRun?: any } = {}) {
  const state: MockDbState = {
    agentRunsRows: existingCreativeRun ? [existingCreativeRun] : [],
    insertedRows: [],
    updatedRows: [],
  };

  const db = {
    state,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => {
              const name = getTableName(table);
              if (name === "campaigns") {
                return [
                  {
                    id: 28,
                    userId: 18,
                    businessId: 24,
                    workflowState: "strategy_approved",
                    workflowContext: {},
                  },
                ];
              }
              if (name === "agent_runs") {
                return existingCreativeRun ? [existingCreativeRun] : [];
              }
              return [];
            }),
          })),
          limit: vi.fn(async () => {
            const name = getTableName(table);
            if (name === "campaigns") {
              return [
                {
                  id: 28,
                  userId: 18,
                  businessId: 24,
                  workflowState: "strategy_approved",
                  workflowContext: {},
                },
              ];
            }
            if (name === "agent_runs") {
              return existingCreativeRun ? [existingCreativeRun] : [];
            }
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        const name = getTableName(table);
        const row = {
          ...(values as any),
          id: 1000 + state.insertedRows.length,
        };
        state.insertedRows.push({ table: name, row });
        if (name === "agent_runs") {
          state.agentRunsRows.push(row);
        }
        return [{ insertId: row.id }];
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((payload: any) => ({
        where: vi.fn(async () => {
          const name = getTableName(table);
          state.updatedRows.push({ table: name, payload });
          return [];
        }),
      })),
    })),
  };

  return db;
}

function buildCtx() {
  return {
    resHeaders: new Headers(),
    user: { id: 18, tierSlug: "free" },
    session: { verified: true },
  } as any;
}

describe("agentRouter.runCreativeAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an outer operation row, passes source=agent, and completes it on success", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 501,
      savedPosts: 2,
      savedAssets: 1,
      pack: null,
      assets: null,
      metrics: {},
    } as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runCreativeAgent({ campaignId: 28 });

    expect(result.success).toBe(true);
    expect(result.packRunId).toBe(501);

    expect(runCreativeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 18,
        campaignId: 28,
        generationOperation: { source: "agent", id: 1000 },
      })
    );

    const operationInsert = db.state.insertedRows.find((r) => r.table === "agent_runs");
    expect(operationInsert).toBeTruthy();
    expect(operationInsert.row.agentType).toBe("creative");
    expect(operationInsert.row.status).toBe("running");
    expect(operationInsert.row.input).toMatchObject({
      jobType: "content_generation_job",
      source: "agent_router",
    });

    const completedUpdate = db.state.updatedRows.find(
      (u) => u.table === "agent_runs" && u.payload.status === "completed"
    );
    expect(completedUpdate).toBeTruthy();
    expect(completedUpdate.payload.output).toMatchObject({
      success: true,
      packRunId: 501,
      savedPosts: 2,
      savedAssets: 1,
    });
  });

  it("marks the operation row failed when runCreativeAgent throws", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockRejectedValue(new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "generation failed" }));

    const caller = agentRouter.createCaller(buildCtx());
    await expect(caller.runCreativeAgent({ campaignId: 28 })).rejects.toBeInstanceOf(TRPCError);

    const operationInsert = db.state.insertedRows.find((r) => r.table === "agent_runs");
    expect(operationInsert).toBeTruthy();

    const failedUpdate = db.state.updatedRows.find(
      (u) => u.table === "agent_runs" && u.payload.status === "failed"
    );
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate.payload.error).toContain("generation failed");
  });

  it("does not create an operation row when the dedup guard skips", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb({
      existingCreativeRun: {
        id: 777,
        userId: 18,
        campaignId: 28,
        agentType: "creative",
        status: "running",
        createdAt: new Date(),
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runCreativeAgent({ campaignId: 28 });

    expect(result.skipped).toBe(true);
    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(db.state.insertedRows.length).toBe(0);
  });
});
