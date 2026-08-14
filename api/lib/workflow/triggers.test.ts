import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFailedCreativeMessage, groupCampaignActivity } from "../../../src/lib/agent-activity";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./engine", () => ({
  transitionCampaignState: vi.fn(async () => "creatives_ready"),
  createApprovalRequest: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("../agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(),
}));

vi.mock("../agents/distribution-agent", () => ({
  runDistributionAgent: vi.fn(),
}));

vi.mock("../agents/audience-agent", () => ({
  runAudienceAgent: vi.fn(),
}));

vi.mock("../agents/audience-intelligence-agent", () => ({
  runAudienceIntelligenceAgent: vi.fn(),
}));

vi.mock("../audience/access", () => ({
  checkAudienceAgentAccess: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../billing/cost-control", () => ({
  canRunAutonomousWorkflow: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../audience/ingest", () => ({
  ingestAudienceData: vi.fn(async () => {}),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function createWorkflowDbMock({
  initialRun,
  campaign,
  existingAudienceRun,
}: {
  initialRun?: Record<string, unknown>;
  campaign: Record<string, unknown>;
  existingAudienceRun?: Record<string, unknown>;
}) {
  const state = {
    campaign: { ...campaign },
    agentRunsSelectCount: 0,
    insertCalls: [] as Array<{ table: string; values: unknown }>,
  };

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => {
              const tableName = getTableName(table);
              if (tableName === "agent_runs") {
                state.agentRunsSelectCount += 1;
                if (state.agentRunsSelectCount === 1) {
                  return initialRun ? [initialRun] : [];
                }
                return existingAudienceRun ? [existingAudienceRun] : [];
              }
              if (tableName === "campaigns") {
                return [state.campaign];
              }
              return [];
            }),
          })),
          limit: vi.fn(async () => {
            const tableName = getTableName(table);
            if (tableName === "agent_runs") {
              state.agentRunsSelectCount += 1;
              if (state.agentRunsSelectCount === 1) {
                return initialRun ? [initialRun] : [];
              }
              return existingAudienceRun ? [existingAudienceRun] : [];
            }
            if (tableName === "campaigns") {
              return [state.campaign];
            }
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        state.insertCalls.push({ table: getTableName(table) || "unknown", values });
        return [{ insertId: 999 }];
      }),
    })),
  };

  return { db, state };
}

describe("onAgentRunComplete integration path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transitions strategy_approved campaign with successful creative output to creatives_ready without duplicate creative waiting activity", async () => {
    const creativeCompletedRun = {
      id: 501,
      userId: 42,
      campaignId: 29,
      agentType: "creative",
      status: "completed",
      error: null,
      createdAt: new Date().toISOString(),
    };

    const existingAudienceRun = {
      id: 610,
      userId: 42,
      campaignId: 29,
      agentType: "audience",
      status: "running",
      error: null,
      createdAt: new Date().toISOString(),
    };

    const campaign = {
      id: 29,
      userId: 42,
      name: "Campaign #29",
      workflowState: "strategy_approved",
      workflowContext: { savedPosts: 4 },
      approvalMode: "assisted",
    };

    const { getDb } = await import("../../queries/connection");
    const { transitionCampaignState } = await import("./engine");
    const { runAudienceAgent } = await import("../agents/audience-agent");
    const { runCreativeAgent } = await import("../agents/creative-agent");
    const { onAgentRunComplete } = await import("./triggers");

    const { db } = createWorkflowDbMock({
      initialRun: creativeCompletedRun,
      campaign,
      existingAudienceRun,
    });

    vi.mocked(getDb).mockReturnValue(db as any);

    await onAgentRunComplete(501);

    expect(transitionCampaignState).toHaveBeenCalledWith(29, 42, "generate_creatives");
    expect(transitionCampaignState).toHaveBeenCalledWith(29, 42, "creatives_complete");
    expect(runAudienceAgent).not.toHaveBeenCalled();
    expect(runCreativeAgent).not.toHaveBeenCalled();

    const grouped = groupCampaignActivity([
      creativeCompletedRun as any,
      { ...creativeCompletedRun, id: 500, status: "failed", error: "old failed run" } as any,
    ]);
    const timeline = grouped.find((t) => t.campaignId === 29);

    expect(timeline).toBeTruthy();
    expect(timeline?.currentStatus).toBe("completed");
    expect(timeline?.creativeRun?.id).toBe(501);
    expect(timeline?.creativeRunHistory.length).toBe(1);
  });

  it("keeps one clear failed creative activity with retry guidance and credit-impact messaging", async () => {
    const failedRun = {
      id: 701,
      userId: 42,
      campaignId: 29,
      agentType: "creative",
      status: "failed",
      error: "PAYMENT_REQUIRED: insufficient credits",
      createdAt: new Date().toISOString(),
    };

    const campaign = {
      id: 29,
      userId: 42,
      name: "Campaign #29",
      workflowState: "creatives_generating",
      workflowContext: { savedPosts: 0 },
      approvalMode: "assisted",
    };

    const { getDb } = await import("../../queries/connection");
    const { transitionCampaignState } = await import("./engine");
    const { onAgentRunComplete } = await import("./triggers");

    const { db } = createWorkflowDbMock({
      initialRun: failedRun,
      campaign,
    });

    vi.mocked(getDb).mockReturnValue(db as any);

    await onAgentRunComplete(701);

    expect(transitionCampaignState).not.toHaveBeenCalled();

    const grouped = groupCampaignActivity([
      { ...failedRun, id: 699, error: "network timeout" } as any,
      failedRun as any,
      { id: 650, userId: 42, campaignId: 29, agentType: "strategy", status: "completed", error: null } as any,
    ]);

    const timeline = grouped.find((t) => t.campaignId === 29);
    expect(timeline).toBeTruthy();
    expect(timeline?.currentStatus).toBe("failed");
    expect(timeline?.creativeRun?.id).toBe(701);
    expect(timeline?.creativeRunHistory.length).toBe(1);
    expect(timeline?.nextAction.toLowerCase()).toContain("retry");

    const paymentMessage = buildFailedCreativeMessage("PAYMENT_REQUIRED: insufficient credits");
    expect(paymentMessage.creditsImpact.toLowerCase()).toContain("no credits were deducted");

    const providerMessage = buildFailedCreativeMessage("OpenAI timeout");
    expect(providerMessage.creditsImpact.toLowerCase()).toContain("automatically refunded");
  });
});

describe("onStrategyApproved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the approval request id as the generation operation identity", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runCreativeAgent } = await import("../agents/creative-agent");
    const { onStrategyApproved } = await import("./triggers");

    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 701,
      savedPosts: 2,
      savedAssets: 1,
      pack: null,
      assets: null,
      metrics: {},
    } as any);

    const { db } = createWorkflowDbMock({
      initialRun: undefined,
      campaign: {
        id: 29,
        userId: 42,
        businessId: 7,
        workflowState: "strategy_approved",
        workflowContext: {},
        platforms: "Instagram, Facebook",
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    await onStrategyApproved(29, 42, 555);

    expect(runCreativeAgent).toHaveBeenCalledTimes(1);
    expect(runCreativeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        campaignId: 29,
        generationOperation: { source: "approval", id: 555 },
      })
    );
  });

  it("skips creative generation when an existing creative run is already active", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runCreativeAgent } = await import("../agents/creative-agent");
    const { onStrategyApproved } = await import("./triggers");

    const { db } = createWorkflowDbMock({
      initialRun: {
        id: 500,
        userId: 42,
        campaignId: 29,
        agentType: "creative",
        status: "running",
      },
      campaign: {
        id: 29,
        userId: 42,
        businessId: 7,
        workflowState: "strategy_approved",
        workflowContext: {},
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    await onStrategyApproved(29, 42, 556);

    expect(runCreativeAgent).not.toHaveBeenCalled();
  });
});
