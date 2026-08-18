import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

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

vi.mock("../creative/creative-generation-claim", () => ({
  releaseClaimSafely: vi.fn(),
  releaseClaimWithResult: vi.fn(async () => ({ released: true })),
  createClaimHeartbeatController: vi.fn(() => ({
    lostOwnership: false,
    abortSignal: new AbortController().signal,
    assertStillOwned: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  })),
}));

vi.mock("../workflow/strategy-approval", () => ({
  isApprovedStrategyCurrent: vi.fn(() => true),
  assertApprovedStrategySemanticallyValid: vi.fn(async () => undefined),
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

function createMockDb({ postCount = 0 }: { postCount?: number } = {}) {
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
            return makeChainable([{ value: postCount }]);
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

    await processContentGenerationJob({ jobId: 189, userId: 18, campaignId: 30, claimId: 2001, ownerToken: "test-owner-token" });

    const completed = db.agentRunUpdates.filter((u: any) => u.status === "completed");
    const failed = db.agentRunUpdates.filter((u: any) => u.status === "failed");
    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(0);
    expect(vi.mocked(logInfo).mock.calls.some((c) => c[0] === "[content.job] completed")).toBe(true);
    expect(runCreativeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        generationOperation: { source: "job", id: 189 },
      })
    );
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

    await expect(processContentGenerationJob({ jobId: 189, userId: 18, campaignId: 30, claimId: 2002, ownerToken: "test-owner-token" })).rejects.toThrow("creative failed");

    const completed = db.agentRunUpdates.filter((u: any) => u.status === "completed");
    const failed = db.agentRunUpdates.filter((u: any) => u.status === "failed");
    expect(completed).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(vi.mocked(logInfo).mock.calls.some((c) => c[0] === "[content.job] completed")).toBe(false);
    expect(vi.mocked(deductCredits)).not.toHaveBeenCalled();
  });

  it("short-circuits when existing posts are found and does not call runCreativeAgent", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runCreativeAgent } = await import("../agents/creative-agent");
    const { processContentGenerationJob } = await import("./content-generation-job");

    const db = createMockDb({ postCount: 3 });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 901,
      savedPosts: 2,
      savedAssets: 1,
      metrics: {},
    } as any);

    await processContentGenerationJob({ jobId: 189, userId: 18, campaignId: 30, claimId: 2003, ownerToken: "test-owner-token" });

    expect(runCreativeAgent).not.toHaveBeenCalled();
    const completed = db.agentRunUpdates.filter((u: any) => u.status === "completed");
    expect(completed).toHaveLength(1);
  });

  it("rejects stale approved strategy with PRECONDITION_FAILED before creative work or credit claims", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runCreativeAgent } = await import("../agents/creative-agent");
    const { deductCredits } = await import("../billing/credit-engine");
    const { assertApprovedStrategySemanticallyValid } = await import("../workflow/strategy-approval");
    const { processContentGenerationJob } = await import("./content-generation-job");

    vi.mocked(assertApprovedStrategySemanticallyValid).mockRejectedValueOnce(
      new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "The approved strategy is stale or missing. Regenerate the strategy for approval before creating content.",
      })
    );

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    await expect(
      processContentGenerationJob({ jobId: 189, userId: 18, campaignId: 30, claimId: 2004, ownerToken: "test-owner-token" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // Validation runs before any creative work, credit charge, or claim lifecycle.
    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(db.agentRunUpdates).toHaveLength(0);
  });

  it("rejects a fingerprint-matching but semantically invalid strategy before job status, claim, queue, output or billing mutation", async () => {
    const { getDb } = await import("../../queries/connection");
    const { runCreativeAgent } = await import("../agents/creative-agent");
    const { deductCredits } = await import("../billing/credit-engine");
    const { assertApprovedStrategySemanticallyValid } = await import("../workflow/strategy-approval");
    const { processContentGenerationJob } = await import("./content-generation-job");

    vi.mocked(assertApprovedStrategySemanticallyValid).mockRejectedValueOnce(
      new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "The approved strategy no longer matches the current campaign brief: stale audience classification.",
      })
    );

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    await expect(
      processContentGenerationJob({ jobId: 189, userId: 18, campaignId: 30, claimId: 2005, ownerToken: "test-owner-token" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // No job status update to running, no creative work, no credit charge.
    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(db.agentRunUpdates).toHaveLength(0);
  });
});
