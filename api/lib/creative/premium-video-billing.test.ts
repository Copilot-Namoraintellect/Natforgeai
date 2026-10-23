import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../billing/credit-engine", () => ({
  checkCredits: vi.fn(async () => ({ hasCredits: true, balance: 500 })),
  deductCredits: vi.fn(async () => ({
    success: true,
    transactionId: "tx-video-1",
    newBalance: 400,
  })),
  recordAiUsage: vi.fn(async () => {}),
}));

vi.mock("./registry", () => ({
  getPremiumVideoProvider: vi.fn(() => ({
    name: "creatify",
    getStatus: vi.fn(),
  })),
  getBasicVideoProvider: vi.fn(),
  getTemplateRendererProvider: vi.fn(),
  getInternalTemplateRenderer: vi.fn(),
  getOpenAiLeafletRenderer: vi.fn(),
  getPremiumV2Renderer: vi.fn(),
  isOpenAiLeafletConfigured: vi.fn(() => false),
}));

vi.mock("./storage", () => ({
  storeImageBuffer: vi.fn(),
  downloadAndStoreVideo: vi.fn(async () => ({
    publicUrl: "https://cdn.example.com/master-video/creatify-job-1.mp4",
    localPath: "/uploads/master-video/creatify-job-1.mp4",
  })),
}));

import { getDb } from "../../queries/connection";
import { deductCredits, recordAiUsage } from "../billing/credit-engine";
import { downloadAndStoreVideo } from "./storage";
import { completePremiumVideo } from "./service";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[
    Symbol.for("drizzle:Name") as symbol
  ] as string | undefined;
}

function createMockDb({
  job,
  post,
}: {
  job: Record<string, unknown>;
  post: Record<string, unknown>;
}) {
  const updateCalls: Array<{ table: string | undefined; set: Record<string, unknown> }> = [];
  const db: any = {
    updateCalls,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = getTableName(table);
        const rows = name === "video_render_jobs" ? [job] : name === "content_posts" ? [post] : [];
        return {
          where: vi.fn(() => ({
            limit: vi.fn(async () => rows),
          })),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((data: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          updateCalls.push({ table: getTableName(table), set: data });
          return [{ affectedRows: 1 }];
        }),
      })),
    })),
  };
  return db;
}

const completedJob = {
  id: 55,
  userId: 10,
  campaignId: 28,
  contentPostId: 100,
  provider: "creatify",
  renderJobId: "creatify-job-1",
  renderStatus: "rendering",
  videoUrl: null,
  thumbnailUrl: null,
  creditsCharged: 0,
  providerCostUsd: 0,
  metadata: {},
};

const masterVideoPost = {
  id: 100,
  userId: 10,
  campaignId: 28,
  metadata: {},
};

const providerDoneResult = {
  jobId: "creatify-job-1",
  provider: "creatify",
  status: "done" as const,
  videoUrl: "https://api.creatify.ai/videos/creatify-job-1.mp4",
  thumbnailUrl: "https://api.creatify.ai/videos/creatify-job-1-thumb.jpg",
  providerLinkId: "link-1",
  providerCreditsUsed: 5,
};

describe("completePremiumVideo billing hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deducts credits under the provider-job idempotency key premium-video:<providerJobId>", async () => {
    vi.mocked(getDb).mockReturnValue(
      createMockDb({ job: completedJob, post: masterVideoPost }) as any
    );

    const result = await completePremiumVideo({
      userId: 10,
      providerJobId: "creatify-job-1",
      resultOverride: providerDoneResult,
    });

    expect(result.status).toBe("completed");
    expect(result.videoUrl).toBe(
      "https://cdn.example.com/master-video/creatify-job-1.mp4"
    );

    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 10,
        type: "video_generation",
        description: "Premium Master Video Ad generation",
        idempotencyKey: "premium-video:creatify-job-1",
        metadata: expect.objectContaining({
          providerJobId: "creatify-job-1",
          contentPostId: 100,
          campaignId: 28,
        }),
      })
    );
    expect(recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: "video_generation",
        model: "creatify",
        creditsDeducted: expect.any(Number),
        metadata: expect.objectContaining({
          providerJobId: "creatify-job-1",
        }),
      })
    );

    const jobFinalise = vi
      .mocked(getDb)
      .mock.results[0].value.updateCalls.find(
        (call: { table: string | undefined; set: Record<string, unknown> }) =>
          call.table === "video_render_jobs" && "creditsCharged" in call.set
      );
    expect(jobFinalise?.set.creditsCharged).toBeGreaterThan(0);
    expect(downloadAndStoreVideo).toHaveBeenCalledTimes(1);
  });

  it("does not double-charge when the job row is already charged and completed", async () => {
    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        job: {
          ...completedJob,
          creditsCharged: 100,
          renderStatus: "completed",
          videoUrl: "https://cdn.example.com/master-video/creatify-job-1.mp4",
        },
        post: masterVideoPost,
      }) as any
    );

    const result = await completePremiumVideo({
      userId: 10,
      providerJobId: "creatify-job-1",
      resultOverride: providerDoneResult,
    });

    // Idempotent replay: collapses onto the existing charge, no provider call.
    expect(result.status).toBe("completed");
    expect(deductCredits).not.toHaveBeenCalled();
    expect(downloadAndStoreVideo).not.toHaveBeenCalled();
  });
});
