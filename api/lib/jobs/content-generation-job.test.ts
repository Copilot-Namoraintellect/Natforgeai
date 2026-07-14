import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(),
}));

vi.mock("../workflow/triggers", () => ({
  onAgentRunComplete: vi.fn(async () => undefined),
}));

vi.mock("../creative/campaign-message-architect", () => ({
  ensureApprovedMessagePack: vi.fn(),
  saveApprovedMessagePack: vi.fn(),
}));

vi.mock("../logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../billing/credit-engine", () => ({
  deductCredits: vi.fn(async () => ({ newBalance: 100 })),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string | undefined;
}

function makeChainable(rows: unknown[]) {
  return {
    limit: vi.fn(async () => rows),
    orderBy: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
}

function createMockDb() {
  const agentRunUpdates: any[] = [];
  return {
    agentRunUpdates,
    select: vi.fn((selection?: any) => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          const name = getTableName(table);
          if (name === "campaigns") {
            return makeChainable([
              {
                id: 30,
                userId: 18,
                businessId: 24,
                workflowState: "creatives_generating",
                workflowContext: { coreMessage: "Core" },
                personas: [{ name: "Owner" }],
                coreMessage: "Core",
              },
            ]);
          }
          if (name === "content_posts" && selection?.value) {
            return makeChainable([{ value: 0 }]);
          }
          if (name === "campaign_assets") {
            return makeChainable([]);
          }
          return makeChainable([]);
        }),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((payload: any) => {
        if (getTableName(table) === "agent_runs") {
          agentRunUpdates.push(payload);
        }
        return { where: vi.fn(async () => []) };
      }),
    })),
  } as any;
}

describe("processContentGenerationJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("successful processing marks completed once", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runCreativeAgent } = await import("../agents/creative-agent");
    const { logInfo } = await import("../logger");
    const { processContentGenerationJob } = await import("./content-generation-job");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 901,
      savedPosts: 2,
      savedAssets: 1,
      metrics: {
        messageArchitectDurationMs: 10,
        creativeGenerationDurationMs: 20,
        qualityRetryDurationMs: 0,
        fallbackDurationMs: 0,
      },
    } as any);

    await processContentGenerationJob({ jobId: 189, userId: 18, campaignId: 30 });

    const completed = db.agentRunUpdates.filter((u: any) => u.status === "completed");
    const failed = db.agentRunUpdates.filter((u: any) => u.status === "failed");
    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(0);
    expect(vi.mocked(logInfo).mock.calls.some((c) => c[0] === "[content.job] completed")).toBe(true);
  });

  it("failed Creative Agent processing marks failed, rejects, and does not log completed or charge credits", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runCreativeAgent } = await import("../agents/creative-agent");
    const { logInfo } = await import("../logger");
    const { deductCredits } = await import("../billing/credit-engine");
    const { processContentGenerationJob } = await import("./content-generation-job");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockRejectedValue(new Error("creative failed"));

    await expect(processContentGenerationJob({ jobId: 189, userId: 18, campaignId: 30 })).rejects.toThrow("creative failed");

    const completed = db.agentRunUpdates.filter((u: any) => u.status === "completed");
    const failed = db.agentRunUpdates.filter((u: any) => u.status === "failed");
    expect(completed).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(vi.mocked(logInfo).mock.calls.some((c) => c[0] === "[content.job] completed")).toBe(false);
    expect(vi.mocked(deductCredits)).not.toHaveBeenCalled();
  });
});
