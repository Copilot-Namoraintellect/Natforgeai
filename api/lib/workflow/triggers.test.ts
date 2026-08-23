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

vi.mock("../agents/strategy-agent", () => ({
  validateStrategyOutputAgainstCampaign: vi.fn(() => ({ valid: true })),
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

function getColumnFilters(condition: unknown): Array<{ name: string; value: unknown }> {
  const chunks = flattenSqlChunks(condition);
  const filters: Array<{ name: string; value: unknown }> = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk && typeof chunk === "object" && "name" in chunk && typeof chunk.name === "string") {
      for (let j = i + 1; j < chunks.length; j++) {
        const candidate = chunks[j];
        if (
          candidate &&
          typeof candidate === "object" &&
          !("name" in candidate) &&
          "value" in candidate &&
          !Array.isArray(candidate.value)
        ) {
          filters.push({ name: chunk.name, value: candidate.value });
          break;
        }
      }
    }
  }
  return filters;
}

function filterRows(rows: unknown[], condition: unknown) {
  const filters = getColumnFilters(condition);
  return rows.filter((row) => {
    const r = row as Record<string, unknown>;
    return filters.every((f) => r[f.name] === f.value);
  });
}

function createWorkflowDbMock({
  initialRun,
  campaign,
  existingAudienceRun,
  agentRunsRows,
  creativeClaimsRows,
  creditTransactionsRows,
  contentPostsRows,
}: {
  initialRun?: Record<string, unknown>;
  campaign: Record<string, unknown>;
  existingAudienceRun?: Record<string, unknown>;
  agentRunsRows?: Record<string, unknown>[];
  creativeClaimsRows?: Record<string, unknown>[];
  creditTransactionsRows?: Record<string, unknown>[];
  contentPostsRows?: Record<string, unknown>[];
}) {
  const runs =
    agentRunsRows ??
    ([
      initialRun ? { ...initialRun } : null,
      existingAudienceRun ? { ...existingAudienceRun } : null,
    ].filter(Boolean) as Record<string, unknown>[]);

  const state = {
    campaign: { ...campaign },
    agentRuns: runs.map((r) => ({ ...r })),
    creativeClaims: (creativeClaimsRows ?? []).map((r) => ({ ...r })),
    creditTransactions: (creditTransactionsRows ?? []).map((r) => ({ ...r })),
    contentPosts: (contentPostsRows ?? []).map((r) => ({ ...r })),
    nextId: {
      agent_runs: 1000,
      creative_generation_claims: 2000,
      credit_transactions: 3000,
      content_posts: 4000,
    },
    insertCalls: [] as Array<{ table: string; values: unknown }>,
  };

  const tableStateKey: Record<string, keyof typeof state | ""> = {
    agent_runs: "agentRuns",
    campaigns: "",
    creative_generation_claims: "creativeClaims",
    credit_transactions: "creditTransactions",
    content_posts: "contentPosts",
  };

  function getTableRows(tableName: string | undefined): unknown[] {
    if (tableName === "campaigns") return [state.campaign];
    const key = tableName ? tableStateKey[tableName] : undefined;
    if (key) {
      return state[key] as unknown[];
    }
    return [];
  }

  function getNextId(tableName: string | undefined): number {
    if (!tableName || !(tableName in state.nextId)) return 9999;
    const key = tableName as keyof typeof state.nextId;
    const id = state.nextId[key];
    state.nextId[key] = id + 1;
    return id;
  }

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((condition: unknown) => {
          const tableName = getTableName(table);
          const baseRows = getTableRows(tableName);
          const filtered = tableName === "campaigns" ? baseRows : filterRows(baseRows, condition);
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
        const tableName = getTableName(table) || "unknown";
        state.insertCalls.push({ table: tableName, values });
        const id = getNextId(tableName);
        const row = { id, ...(values as Record<string, unknown>) };
        const key = tableStateKey[tableName];
        if (key) {
          (state[key] as unknown[]).push(row);
        } else if (tableName === "campaigns") {
          state.campaign = { ...state.campaign, ...row };
        }
        return [{ insertId: id }];
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((payload: any) => ({
        where: vi.fn(async (condition: unknown) => {
          const tableName = getTableName(table);
          if (tableName === "campaigns") {
            state.campaign = { ...state.campaign, ...payload };
            return [];
          }
          const key = tableStateKey[tableName ?? ""];
          if (!key) return [];
          const filters = getColumnFilters(condition);
          const rows = state[key] as Array<Record<string, unknown>>;
          const index = rows.findIndex((row) => filters.every((f) => row[f.name] === f.value));
          if (index !== -1) {
            rows[index] = { ...rows[index], ...payload };
          }
          return [];
        }),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => []),
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
  beforeEach(async () => {
    vi.clearAllMocks();

    const { transitionCampaignState } = await import("./engine");
    vi.mocked(transitionCampaignState).mockImplementation(async () => "creatives_ready" as any);

    const {
      acquireCreativeGenerationClaim,
      releaseClaimWithResult,
    } = await import("../creative/creative-generation-claim");
    vi.mocked(acquireCreativeGenerationClaim).mockImplementation(
      async () =>
        ({
          acquired: true,
          claim: { id: 1001, ownerToken: "test-owner-token" },
        } as any)
    );
    vi.mocked(releaseClaimWithResult).mockImplementation(
      async () => ({ released: true } as any)
    );

    const { canRunAutonomousWorkflow } = await import("../billing/cost-control");
    vi.mocked(canRunAutonomousWorkflow).mockResolvedValue({ allowed: true } as any);

    const { runCreativeAgent } = await import("../agents/creative-agent");
    vi.mocked(runCreativeAgent).mockReset();
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

  it("recovers the production Phase 5 state and is idempotent on retry", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runCreativeAgent } = await import("../agents/creative-agent");
    const {
      acquireCreativeGenerationClaim,
      releaseClaimWithResult,
    } = await import("../creative/creative-generation-claim");
    const { transitionCampaignState } = await import("./engine");
    const { onStrategyApproved } = await import("./triggers");

    const { db, state } = createWorkflowDbMock({
      agentRunsRows: [
        {
          id: 10,
          userId: 22,
          campaignId: 30,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "test-fingerprint" },
        },
        {
          id: 243,
          userId: 22,
          campaignId: 30,
          agentType: "creative",
          status: "completed",
          output: { creativeBriefFingerprint: "unrelated-old-fingerprint" },
        },
        {
          id: 611,
          userId: 22,
          campaignId: 30,
          agentType: "audience",
          status: "completed",
        },
      ],
      creativeClaimsRows: [
        {
          id: 15,
          userId: 22,
          campaignId: 30,
          operationSource: "approval",
          operationReferenceId: null,
          status: "completed",
          activeClaimKey: null,
          ownerToken: "old-token",
        },
      ],
      campaign: {
        id: 30,
        userId: 22,
        businessId: null,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: "test-fingerprint",
            strategyRunId: 10,
            approvalRequestId: 36,
            status: "pending",
          },
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const transitions: Record<string, Record<string, string>> = {
      strategy_generated: { approve_strategy: "strategy_approved" },
      strategy_approved: { generate_creatives: "creatives_generating" },
      creatives_generating: { creatives_complete: "creatives_ready" },
    };

    vi.mocked(transitionCampaignState).mockImplementation(async (_cid, _uid, action) => {
      const currentState = state.campaign.workflowState as string;
      const nextState = transitions[currentState]?.[action];
      if (!nextState) {
        throw new Error(`Invalid transition: ${action} from ${currentState}`);
      }
      state.campaign = { ...state.campaign, workflowState: nextState };
      return nextState as any;
    });

    vi.mocked(acquireCreativeGenerationClaim).mockImplementation(async (args: any) => {
      const id = state.nextId.creative_generation_claims++;
      const claim = {
        id,
        userId: args.userId,
        campaignId: args.campaignId,
        operationSource: args.operationSource,
        operationReferenceId: args.operationReferenceId ?? null,
        activeClaimKey: `active:${args.userId}:${args.campaignId}:creative`,
        ownerToken: args.ownerToken || "test-owner-token",
        status: "running" as const,
        leaseExpiresAt: args.leaseExpiresAt ?? null,
        heartbeatAt: null,
        releasedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      state.creativeClaims.push(claim as any);
      return { acquired: true, claim };
    });

    vi.mocked(releaseClaimWithResult).mockImplementation(async ({ claimId, ownerToken, status }: any) => {
      const claim = state.creativeClaims.find(
        (c: any) => c.id === claimId && c.ownerToken === ownerToken
      );
      if (claim) {
        (claim as any).status = status;
        (claim as any).activeClaimKey = null;
        (claim as any).releasedAt = new Date();
      }
      return { released: true };
    });

    vi.mocked(runCreativeAgent).mockImplementation(async ({ userId, campaignId, generationOperation }: any) => {
      const approvalId = generationOperation.id;
      const runId = state.nextId.agent_runs++;
      state.agentRuns.push({
        id: runId,
        userId,
        campaignId,
        agentType: "creative",
        status: "completed",
        output: { savedPosts: 2 },
        createdAt: new Date().toISOString(),
      });
      state.contentPosts.push({
        id: state.nextId.content_posts++,
        userId,
        campaignId,
        title: `Post ${runId}`,
        type: "social_post",
        status: "draft",
        metadata: {
          generationRunId: `pack-${runId}`,
          creativeBriefFingerprint: (state.campaign.workflowContext as any)?.strategyApprovalLineage?.creativeBriefFingerprint,
        },
      });
      state.creditTransactions.push({
        id: state.nextId.credit_transactions++,
        userId,
        walletId: 1,
        type: "agent_deduction",
        amount: -5,
        balanceAfter: 95,
        description: "creative agent execution (post-success)",
        idempotencyKey: `creative-success:${campaignId}:approval:${approvalId}`,
        metadata: {
          campaignId,
          agentRunId: runId,
          agentType: "creative",
          generationSource: "approval",
          generationOperationId: approvalId,
        },
      });
      state.campaign = {
        ...state.campaign,
        workflowContext: {
          ...(state.campaign.workflowContext as any),
          savedPosts: 2,
        },
      };
      return {
        packRunId: runId,
        assetsRunId: null,
        savedPosts: 2,
        savedAssets: 1,
        pack: null,
        assets: null,
        metrics: {
          messageArchitectDurationMs: 0,
          creativeGenerationDurationMs: 0,
          qualityRetryDurationMs: 0,
          fallbackDurationMs: 0,
          totalDurationMs: 0,
        },
      };
    });

    await onStrategyApproved(30, 22, 36);

    // Approved lineage and fingerprint are persisted first.
    const ctxAfterFirstCall = state.campaign.workflowContext as any;
    expect(ctxAfterFirstCall.strategyApprovalLineage.status).toBe("approved");
    expect(ctxAfterFirstCall.approvedStrategyFingerprint).toBe("test-fingerprint");

    // State transitions happened in the right order.
    expect(transitionCampaignState).toHaveBeenCalledWith(30, 22, "approve_strategy");
    expect(transitionCampaignState).toHaveBeenCalledWith(30, 22, "generate_creatives");

    // A new claim correlated to approval 36 was acquired and released as completed.
    expect(acquireCreativeGenerationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 22,
        campaignId: 30,
        operationSource: "approval",
        operationReferenceId: 36,
      })
    );
    const newClaims = state.creativeClaims.filter(
      (c: any) => c.operationSource === "approval" && c.operationReferenceId === 36
    );
    expect(newClaims).toHaveLength(1);
    expect(newClaims[0].status).toBe("completed");
    expect(newClaims[0].activeClaimKey).toBeNull();

    // One new creative run was produced; the unrelated old run 243 is still present.
    const newCreativeRuns = state.agentRuns.filter(
      (r: any) => r.agentType === "creative" && r.status === "completed" && r.id !== 243
    );
    expect(newCreativeRuns).toHaveLength(1);

    const charges = state.creditTransactions.filter(
      (t: any) => t.type === "agent_deduction" && t.amount === -5
    );
    expect(charges).toHaveLength(1);
    expect(charges[0].idempotencyKey).toBe("creative-success:30:approval:36");

    expect(releaseClaimWithResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" })
    );

    // Retry the same approval: it must be a no-op.
    const runCallsBeforeRetry = vi.mocked(runCreativeAgent).mock.calls.length;
    const chargeCountBeforeRetry = state.creditTransactions.length;
    const creativeRunCountBeforeRetry = state.agentRuns.filter(
      (r: any) => r.agentType === "creative"
    ).length;

    await onStrategyApproved(30, 22, 36);

    expect(vi.mocked(runCreativeAgent).mock.calls.length).toBe(runCallsBeforeRetry);
    expect(state.creditTransactions.length).toBe(chargeCountBeforeRetry);
    expect(
      state.agentRuns.filter((r: any) => r.agentType === "creative").length
    ).toBe(creativeRunCountBeforeRetry);
  });

  it("does not acquire a claim or run creative generation when cost control blocks", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runCreativeAgent } = await import("../agents/creative-agent");
    const { acquireCreativeGenerationClaim } = await import("../creative/creative-generation-claim");
    const { canRunAutonomousWorkflow } = await import("../billing/cost-control");
    const { onStrategyApproved } = await import("./triggers");

    const { db, state } = createWorkflowDbMock({
      agentRunsRows: [
        {
          id: 10,
          userId: 22,
          campaignId: 30,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "test-fingerprint" },
        },
      ],
      campaign: {
        id: 30,
        userId: 22,
        businessId: null,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: "test-fingerprint",
            strategyRunId: 10,
            approvalRequestId: 36,
            status: "pending",
          },
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(canRunAutonomousWorkflow).mockResolvedValue({ allowed: false, reason: "insufficient credits" });

    await onStrategyApproved(30, 22, 36);

    // Lineage is still persisted before the cost-control gate.
    const ctx = state.campaign.workflowContext as any;
    expect(ctx.strategyApprovalLineage.status).toBe("approved");
    expect(ctx.approvedStrategyFingerprint).toBe("test-fingerprint");

    expect(acquireCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(state.creditTransactions).toHaveLength(0);
    expect(state.agentRuns.filter((r: any) => r.agentType === "creative")).toHaveLength(0);
  });

  it("releases the claim as failed when creative generation fails", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runCreativeAgent } = await import("../agents/creative-agent");
    const {
      acquireCreativeGenerationClaim,
      releaseClaimWithResult,
    } = await import("../creative/creative-generation-claim");
    const { transitionCampaignState } = await import("./engine");
    const { onStrategyApproved } = await import("./triggers");

    const { db, state } = createWorkflowDbMock({
      agentRunsRows: [
        {
          id: 10,
          userId: 22,
          campaignId: 30,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "test-fingerprint" },
        },
      ],
      campaign: {
        id: 30,
        userId: 22,
        businessId: null,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: "test-fingerprint",
            strategyRunId: 10,
            approvalRequestId: 36,
            status: "pending",
          },
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    vi.mocked(acquireCreativeGenerationClaim).mockImplementation(async (args: any) => {
      const id = state.nextId.creative_generation_claims++;
      const claim = {
        id,
        userId: args.userId,
        campaignId: args.campaignId,
        operationSource: args.operationSource,
        operationReferenceId: args.operationReferenceId ?? null,
        activeClaimKey: `active:${args.userId}:${args.campaignId}:creative`,
        ownerToken: args.ownerToken || "test-owner-token",
        status: "running" as const,
        leaseExpiresAt: args.leaseExpiresAt ?? null,
        heartbeatAt: null,
        releasedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      state.creativeClaims.push(claim as any);
      return { acquired: true, claim };
    });

    vi.mocked(releaseClaimWithResult).mockImplementation(async ({ claimId, ownerToken, status }: any) => {
      const claim = state.creativeClaims.find(
        (c: any) => c.id === claimId && c.ownerToken === ownerToken
      );
      if (claim) {
        (claim as any).status = status;
        (claim as any).activeClaimKey = null;
        (claim as any).releasedAt = new Date();
      }
      return { released: true };
    });

    vi.mocked(runCreativeAgent).mockRejectedValue(new Error("generation failed"));

    const transitions: Record<string, Record<string, string>> = {
      strategy_generated: { approve_strategy: "strategy_approved" },
      strategy_approved: { generate_creatives: "creatives_generating" },
    };

    vi.mocked(transitionCampaignState).mockImplementation(async (_cid, _uid, action) => {
      const currentState = state.campaign.workflowState as string;
      const nextState = transitions[currentState]?.[action];
      if (!nextState) {
        throw new Error(`Invalid transition: ${action} from ${currentState}`);
      }
      state.campaign = { ...state.campaign, workflowState: nextState };
      return nextState as any;
    });

    await onStrategyApproved(30, 22, 36);

    expect(acquireCreativeGenerationClaim).toHaveBeenCalledTimes(1);
    expect(runCreativeAgent).toHaveBeenCalledTimes(1);
    expect(releaseClaimWithResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );

    const claims = state.creativeClaims.filter(
      (c: any) => c.operationSource === "approval" && c.operationReferenceId === 36
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].status).toBe("failed");
    expect(claims[0].activeClaimKey).toBeNull();

    expect(state.creditTransactions).toHaveLength(0);
    expect(state.agentRuns.filter((r: any) => r.agentType === "creative")).toHaveLength(0);
  });

  it("does not let an unrelated prior creative run block approval-driven generation", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runCreativeAgent } = await import("../agents/creative-agent");
    const { onStrategyApproved } = await import("./triggers");

    const { db, state } = createWorkflowDbMock({
      agentRunsRows: [
        {
          id: 10,
          userId: 22,
          campaignId: 30,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "test-fingerprint" },
        },
        {
          id: 243,
          userId: 22,
          campaignId: 30,
          agentType: "creative",
          status: "completed",
          output: { creativeBriefFingerprint: "unrelated-old-fingerprint" },
        },
      ],
      campaign: {
        id: 30,
        userId: 22,
        businessId: null,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: "test-fingerprint",
            strategyRunId: 10,
            approvalRequestId: 36,
            status: "pending",
          },
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 701,
      savedPosts: 2,
      savedAssets: 1,
      pack: null,
      assets: null,
      metrics: {},
    } as any);

    await onStrategyApproved(30, 22, 36);

    expect(runCreativeAgent).toHaveBeenCalledTimes(1);
    expect(runCreativeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 22,
        campaignId: 30,
        generationOperation: { source: "approval", id: 36 },
      })
    );
  });
});
