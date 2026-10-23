import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashStrategySnapshotPayload } from "../strategy/strategy-snapshot";

const engineState = vi.hoisted(() => ({
  nextId: 6001,
  created: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./engine", () => ({
  transitionCampaignState: vi.fn(async () => "strategy_generated"),
  createApprovalRequest: vi.fn(async (input: Record<string, unknown>) => {
    const id = engineState.nextId++;
    engineState.created.push({ id, ...input, status: "pending" });
    return { id };
  }),
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
  checkAudienceAgentAccess: vi.fn(async () => ({ allowed: false })),
}));

vi.mock("../billing/cost-control", () => ({
  canRunAutonomousWorkflow: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../queue/bullmq", () => ({
  isBullMQAvailable: vi.fn(() => false),
  schedulePublishingJob: vi.fn(async () => ({ id: "publish-test-job" })),
  removePublishingJob: vi.fn(async () => {}),
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

vi.mock("../strategy/strategy-snapshot-db-store", () => ({
  getStrategySnapshotByStrategyRunId: vi.fn(),
  getNextStrategySnapshotVersion: vi.fn(),
}));

vi.mock("./budget-resume", () => ({
  resumeWorkflowAfterApprovedCostIncrease: vi.fn(async () => ({ outcome: "resumed" })),
}));

const approvedStrategyHash = hashStrategySnapshotPayload({
  coreMessage: "Immutable core message",
});

function snapshotAuthority(strategyRunId: number) {
  return {
    id: 1,
    snapshotId: "strategy-snapshot-10",
    userId: 42,
    campaignId: 29,
    businessId: 7,
    strategyRunId,
    businessDnaSnapshotId: "bdna-snapshot-7",
    version: 1,
    creativeBriefFingerprint: "test-fingerprint",
    strategyHashSha256: approvedStrategyHash,
    snapshot: {},
    capturedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function flattenSqlChunks(sql: any): any[] {
  if (!sql || typeof sql !== "object" || !Array.isArray(sql.queryChunks)) return [];
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

interface HarnessInput {
  campaign: Record<string, unknown>;
  approvalRequests?: Record<string, unknown>[];
  strategyRunId?: number;
}

function createHarness({ campaign, approvalRequests = [], strategyRunId = 650 }: HarnessInput) {
  const state = {
    campaign: { ...campaign },
    approvalRequests: approvalRequests.map((r) => ({ ...r })),
    campaignUpdates: [] as any[],
  };

  const agentRuns = [
    {
      id: strategyRunId,
      userId: 42,
      campaignId: 29,
      agentType: "strategy",
      status: "completed",
      error: null,
      createdAt: new Date().toISOString(),
    },
  ];

  const db = {
    state,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((condition: unknown) => {
          const name = getTableName(table);
          const base =
            name === "campaigns"
              ? [state.campaign]
              : name === "approval_requests"
                ? filterRows(state.approvalRequests, condition)
                : name === "agent_runs"
                  ? filterRows(agentRuns, condition)
                  : [];
          return {
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => base),
              then: (resolve: (value: unknown[]) => unknown) =>
                Promise.resolve(base).then(resolve),
            })),
            limit: vi.fn(async () => base),
            then: (resolve: (value: unknown[]) => unknown) =>
              Promise.resolve(base).then(resolve),
          };
        }),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => [{ insertId: 1 }]) })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((payload: any) => ({
        where: vi.fn(async (condition: unknown) => {
          const name = getTableName(table);
          if (name === "campaigns") {
            state.campaignUpdates.push(payload);
            state.campaign = { ...state.campaign, ...payload };
            return [];
          }
          if (name === "approval_requests" || name === "agent_runs") {
            const rows = name === "approval_requests" ? state.approvalRequests : agentRuns;
            const filters = getColumnFilters(condition);
            for (const row of rows as Array<Record<string, unknown>>) {
              if (filters.every((f) => row[f.name] === f.value)) {
                Object.assign(row, payload);
              }
            }
            return [];
          }
          return [];
        }),
      })),
    })),
  };

  return { db, state };
}

function strategyPendingCampaign(workflowContext: Record<string, unknown>) {
  return {
    id: 29,
    userId: 42,
    name: "Campaign #29",
    workflowState: "strategy_pending",
    workflowContext,
    approvalMode: "assisted",
  };
}

async function mockSnapshotAuthority() {
  const { getStrategySnapshotByStrategyRunId } = await import(
    "../strategy/strategy-snapshot-db-store"
  );
  vi.mocked(getStrategySnapshotByStrategyRunId).mockImplementation(
    async (runId: number) => snapshotAuthority(runId) as any
  );
}

describe("onAgentRunComplete strategy_review dedup (WBS-R4 A2-2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engineState.nextId = 6001;
    engineState.created = [];
  });

  it("replays the same run with state still strategy_pending exactly once", async () => {
    await mockSnapshotAuthority();
    const { getDb } = await import("../../queries/connection");
    const { createApprovalRequest } = await import("./engine");
    const { onAgentRunComplete } = await import("./triggers");

    const { db, state } = createHarness({
      campaign: strategyPendingCampaign({
        strategyApprovalLineage: {
          creativeBriefFingerprint: "test-fingerprint",
          strategyRunId: 650,
          strategySnapshotId: "strategy-snapshot-10",
          strategyVersion: 1,
          businessDnaSnapshotId: "bdna-snapshot-7",
          strategyHashSha256: approvedStrategyHash,
          approvalRequestId: 5001,
          status: "pending",
        },
      }),
      approvalRequests: [
        {
          id: 5001,
          userId: 42,
          campaignId: 29,
          approvalType: "strategy_review",
          status: "pending",
          description: "Review the generated strategy",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    // Replay the same run completion twice, as after a crash with the state
    // rolled back to strategy_pending.
    await onAgentRunComplete(650);
    await onAgentRunComplete(650);

    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(engineState.created).toHaveLength(0);
    const pending = state.approvalRequests.filter(
      (r) => r.approvalType === "strategy_review" && r.status === "pending"
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(5001);
    // The lineage was already bound; no duplicate lineage write occurred.
    expect(state.campaignUpdates).toHaveLength(0);
    expect((state.campaign.workflowContext as any).strategyApprovalLineage).toMatchObject({
      strategyRunId: 650,
      approvalRequestId: 5001,
      status: "pending",
    });
  });

  it("creates and binds exactly one review + lineage on the first pass (no existing requests)", async () => {
    await mockSnapshotAuthority();
    const { getDb } = await import("../../queries/connection");
    const { createApprovalRequest } = await import("./engine");
    const { onAgentRunComplete } = await import("./triggers");

    const { db, state } = createHarness({
      campaign: strategyPendingCampaign({}),
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    await onAgentRunComplete(650);

    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        campaignId: 29,
        approvalType: "strategy_review",
      })
    );
    expect(engineState.created).toHaveLength(1);
    expect(state.campaignUpdates).toHaveLength(1);
    expect((state.campaign.workflowContext as any).strategyApprovalLineage).toMatchObject({
      strategyRunId: 650,
      approvalRequestId: 6001,
      status: "pending",
      creativeBriefFingerprint: "test-fingerprint",
      strategySnapshotId: "strategy-snapshot-10",
    });
  });

  it("supersedes a pending review bound to a different run using dispatcher semantics", async () => {
    await mockSnapshotAuthority();
    const { getDb } = await import("../../queries/connection");
    const { createApprovalRequest } = await import("./engine");
    const { onAgentRunComplete } = await import("./triggers");

    const { db, state } = createHarness({
      campaign: strategyPendingCampaign({}),
      approvalRequests: [
        {
          id: 5001,
          userId: 42,
          campaignId: 29,
          approvalType: "strategy_review",
          status: "pending",
          description: "Review the older strategy",
          context: { strategyRunId: 649 },
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    await onAgentRunComplete(650);

    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(engineState.created).toHaveLength(1);

    // The older pending review is superseded exactly the way the next-cycle
    // dispatcher supersedes: rejected with an explicit note.
    const oldRequest = state.approvalRequests.find((r) => r.id === 5001);
    expect(oldRequest).toMatchObject({
      status: "rejected",
      rejectedAt: expect.any(Date),
    });
    expect(String(oldRequest?.description)).toContain(
      "Superseded: a new strategy was generated for the next governed cycle."
    );

    // The new lineage is bound to the newly created request id.
    expect((state.campaign.workflowContext as any).strategyApprovalLineage).toMatchObject({
      strategyRunId: 650,
      approvalRequestId: 6001,
      status: "pending",
    });
  });
});
