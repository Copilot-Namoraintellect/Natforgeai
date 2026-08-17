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

vi.mock("../creative/brief-grounding", () => ({
  buildGroundedCreativeBrief: vi.fn(() => ({
    fingerprint: "test-fingerprint",
    productOrService: "service",
    targetBuyer: "buyer",
    mainPainPoint: "pain",
    preferredCta: "cta",
    primaryOutcome: "outcome",
    targetAudience: "audience",
    coreMessage: "message",
    offerDetails: "",
    excludedOffers: "",
    referenceStyle: "",
    contentStyle: "",
    businessType: "B2B",
  })),
}));

vi.mock("../creative/creative-generation-claim", () => ({
  generateOwnerToken: vi.fn(() => "test-owner-token"),
  acquireCreativeGenerationClaim: vi.fn(async () => ({
    acquired: true,
    claim: { id: 1001, ownerToken: "test-owner-token" },
  })),
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

function flattenSqlChunks(sql: any): any[] {
  if (!sql || typeof sql !== "object" || !Array.isArray(sql.queryChunks)) {
    return [];
  }
  const out: any[] = [];
  for (const chunk of sql.queryChunks) {
    if (chunk && typeof chunk === "object" && Array.isArray(chunk.queryChunks)) {
      out.push(...flattenSqlChunks(chunk));
    } else {
      out.push(chunk);
    }
  }
  return out;
}

function getColumnFilter(condition: unknown, columnName: string): unknown | null {
  const chunks = flattenSqlChunks(condition);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk && typeof chunk === "object" && chunk.name === columnName) {
      // Find the next parameter chunk after this column (skip string chunks).
      for (let j = i + 1; j < chunks.length; j++) {
        const candidate = chunks[j];
        if (
          candidate &&
          typeof candidate === "object" &&
          !("name" in candidate) &&
          "value" in candidate &&
          !Array.isArray(candidate.value)
        ) {
          return candidate.value;
        }
      }
      return null;
    }
  }
  return null;
}

function createWorkflowDbMock({
  initialRun,
  campaign,
  existingAudienceRun,
  agentRunsRows,
}: {
  initialRun?: Record<string, unknown>;
  campaign: Record<string, unknown>;
  existingAudienceRun?: Record<string, unknown>;
  agentRunsRows?: Record<string, unknown>[];
}) {
  const runs =
    agentRunsRows ??
    ([
      initialRun ? { ...initialRun } : null,
      existingAudienceRun ? { ...existingAudienceRun } : null,
    ].filter(Boolean) as Record<string, unknown>[]);

  const state = {
    campaign: { ...campaign },
    insertCalls: [] as Array<{ table: string; values: unknown }>,
  };

  function filterRows(rows: unknown[], condition: unknown) {
    let result = rows;
    const typeFilter = getColumnFilter(condition, "agentType");
    if (typeFilter !== null) {
      result = result.filter((r) => (r as any).agentType === typeFilter);
    }
    const idFilter = getColumnFilter(condition, "id");
    if (idFilter !== null) {
      result = result.filter((r) => (r as any).id === idFilter);
    }
    return result;
  }

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((condition: unknown) => {
          const tableName = getTableName(table);
          let baseRows: unknown[] = [];
          if (tableName === "agent_runs") {
            baseRows = runs;
          } else if (tableName === "campaigns") {
            baseRows = [state.campaign];
          }
          const filtered = tableName === "agent_runs" ? filterRows(baseRows, condition) : baseRows;
          return {
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => filtered),
            })),
            limit: vi.fn(async () => filtered),
            then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(filtered).then(resolve),
          };
        }),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        state.insertCalls.push({ table: getTableName(table) || "unknown", values });
        return [{ insertId: 999 }];
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((payload: any) => ({
        where: vi.fn(async () => {
          const tableName = getTableName(table);
          if (tableName === "campaigns") {
            state.campaign = { ...state.campaign, ...payload };
          }
          return [];
        }),
      })),
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
      agentRunsRows: [
        creativeCompletedRun,
        {
          id: 610,
          userId: 42,
          campaignId: 29,
          agentType: "audience",
          status: "running",
        },
      ],
      campaign,
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
      agentRunsRows: [failedRun],
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
    expect(paymentMessage.creditsImpact?.toLowerCase()).toContain("no credits were deducted");

    const providerMessage = buildFailedCreativeMessage("OpenAI timeout");
    expect(providerMessage.creditsImpact?.toLowerCase()).toContain("automatically refunded");
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
      agentRunsRows: [
        {
          id: 10,
          userId: 42,
          campaignId: 29,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "test-fingerprint" },
        },
        {
          id: 610,
          userId: 42,
          campaignId: 29,
          agentType: "audience",
          status: "running",
        },
      ],
      campaign: {
        id: 29,
        userId: 42,
        businessId: 7,
        workflowState: "strategy_approved",
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: "test-fingerprint",
            strategyRunId: 10,
            approvalRequestId: 555,
            status: "pending",
          },
        },
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
      agentRunsRows: [
        {
          id: 10,
          userId: 42,
          campaignId: 29,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "test-fingerprint" },
        },
        {
          id: 500,
          userId: 42,
          campaignId: 29,
          agentType: "creative",
          status: "running",
        },
      ],
      campaign: {
        id: 29,
        userId: 42,
        businessId: 7,
        workflowState: "strategy_approved",
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: "test-fingerprint",
            strategyRunId: 10,
            approvalRequestId: 556,
            status: "pending",
          },
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    await onStrategyApproved(29, 42, 556);

    expect(runCreativeAgent).not.toHaveBeenCalled();
  });
});
