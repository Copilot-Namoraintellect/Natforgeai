import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/agents/strategy-agent", () => ({
  runStrategyAgent: vi.fn(),
}));

vi.mock("./lib/agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(),
}));

vi.mock("./lib/workflow/engine", () => ({
  transitionCampaignState: vi.fn(async () => "strategy_approved"),
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
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function createMockDb() {
  const state = {
    updatedCampaignState: null as any,
    deletedRows: [] as any[],
  };

  function baseResultFor(table: unknown) {
    const name = getTableName(table);
    if (name === "campaigns") {
      return [
        {
          id: 42,
          userId: 18,
          businessId: 7,
          workflowState: "strategy_approved",
          workflowContext: {},
        },
      ];
    }
    if (name === "businesses") {
      return [
        {
          id: 7,
          name: "Test Business",
          websiteEvidence: {},
        },
      ];
    }
    if (name === "content_posts" || name === "campaign_assets") {
      return [];
    }
    return [];
  }

  const db = {
    state,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const result = baseResultFor(table);
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => result),
            })),
            limit: vi.fn(async () => result),
            then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
          })),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((payload: any) => ({
        where: vi.fn(async () => {
          const name = getTableName(table);
          if (name === "campaigns") {
            state.updatedCampaignState = payload;
          }
          return [];
        }),
      })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async () => {
        const name = getTableName(table);
        state.deletedRows.push({ table: name });
        return [];
      }),
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

describe("campaignRouter.regenerateFromProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes source=profile with the strategy run id to runCreativeAgent", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockResolvedValue({
      runId: 456,
      output: { strategy: "test" },
    } as any);
    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 789,
      savedPosts: 3,
      savedAssets: 1,
      pack: null,
      assets: null,
      metrics: {},
    } as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateFromProfile({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.strategyRunId).toBe(456);
    expect(result.creativeRunId).toBe(789);

    expect(runCreativeAgent).toHaveBeenCalledTimes(1);
    expect(runCreativeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 18,
        campaignId: 42,
        deleteExistingDrafts: false,
        generationOperation: { source: "profile", id: 456 },
      })
    );
  });

  it("returns TRPCError when campaign is not linked to a business", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    // Override the campaigns select to return a campaign with no businessId
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn((table: unknown) => {
        const result =
          getTableName(table) === "campaigns"
            ? [{ id: 42, userId: 18, businessId: null, workflowState: "strategy_approved" }]
            : [];
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => result),
            })),
            limit: vi.fn(async () => result),
            then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
          })),
        };
      }),
    }) as any);

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateFromProfile({ campaignId: 42 })).rejects.toBeInstanceOf(TRPCError);
    expect(runCreativeAgent).not.toHaveBeenCalled();
  });
});
