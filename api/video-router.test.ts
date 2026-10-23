import { describe, it, expect, vi, beforeEach } from "vitest";
import { videoRouter } from "./video-router";
import * as service from "./lib/creative/service";

const envFlags = vi.hoisted(() => ({
  enablePremiumVideo: false,
  enableBasicDraftVideo: false,
}));

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/env", async () => {
  const actual = await vi.importActual<typeof import("./lib/env")>("./lib/env");
  return {
    ...actual,
    env: {
      ...actual.env,
      get enablePremiumVideo() {
        return envFlags.enablePremiumVideo;
      },
      get enableBasicDraftVideo() {
        return envFlags.enableBasicDraftVideo;
      },
    },
  };
});

vi.mock("./lib/rate-limiter", () => ({
  rateLimitUser: vi.fn(async () => {}),
  rateLimitPublic: vi.fn(async () => {}),
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    limit: 100,
    remaining: 99,
    resetAt: Date.now() + 60 * 60 * 1000,
  })),
  clearRateLimitStateForTests: vi.fn(),
}));

vi.mock("./lib/creative/service", () => ({
  renderBasicDraftVideo: vi.fn(async () => ({
    jobId: "basic-render-1",
    provider: "internal",
    status: "done",
    videoUrl: "https://cdn.example.com/draft.mp4",
    thumbnailUrl: "https://cdn.example.com/draft-thumb.jpg",
    durationSeconds: 15,
    aspectRatio: "9:16",
  })),
  generatePremiumVideo: vi.fn(async () => ({
    jobId: "creatify-render-1",
    provider: "creatify",
    status: "rendering",
    videoUrl: undefined,
    creditsRequired: 100,
  })),
  completePremiumVideo: vi.fn(),
}));

vi.mock("./lib/creative/registry", () => ({
  isBasicVideoConfigured: vi.fn(() => true),
  isPremiumVideoConfigured: vi.fn(() => true),
}));

function buildCtx(userId = 18) {
  return {
    resHeaders: new Headers(),
    user: { id: userId },
    session: { verified: true },
  } as any;
}

describe("videoRouter.renderVideo feature-flag gates (fail closed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envFlags.enablePremiumVideo = false;
    envFlags.enableBasicDraftVideo = false;
  });

  it("rejects premium mode with PRECONDITION_FAILED when enablePremiumVideo is off, without touching the provider", async () => {
    await expect(
      videoRouter
        .createCaller(buildCtx())
        .renderVideo({ contentPostId: 100, mode: "premium" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(service.generatePremiumVideo).not.toHaveBeenCalled();
    expect(service.renderBasicDraftVideo).not.toHaveBeenCalled();
  });

  it("rejects basic mode with PRECONDITION_FAILED when enableBasicDraftVideo is off, without touching the renderer", async () => {
    await expect(
      videoRouter
        .createCaller(buildCtx())
        .renderVideo({ contentPostId: 100, mode: "basic" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(service.renderBasicDraftVideo).not.toHaveBeenCalled();
    expect(service.generatePremiumVideo).not.toHaveBeenCalled();
  });

  it("defaults to basic mode and rejects when enableBasicDraftVideo is off", async () => {
    await expect(
      videoRouter.createCaller(buildCtx()).renderVideo({ contentPostId: 100 })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(service.renderBasicDraftVideo).not.toHaveBeenCalled();
  });

  it("dispatches premium mode to the service when enablePremiumVideo is on", async () => {
    envFlags.enablePremiumVideo = true;

    const result = await videoRouter
      .createCaller(buildCtx(18))
      .renderVideo({ contentPostId: 100, mode: "premium" });

    expect(service.generatePremiumVideo).toHaveBeenCalledTimes(1);
    expect(service.generatePremiumVideo).toHaveBeenCalledWith({
      userId: 18,
      contentPostId: 100,
    });
    expect(result).toEqual({
      success: true,
      mode: "premium",
      status: "rendering",
      jobId: "creatify-render-1",
      provider: "creatify",
      videoUrl: undefined,
      thumbnailUrl: undefined,
      creditsRequired: 100,
    });
    expect(service.renderBasicDraftVideo).not.toHaveBeenCalled();
  });

  it("dispatches basic mode to the service when enableBasicDraftVideo is on", async () => {
    envFlags.enableBasicDraftVideo = true;

    const result = await videoRouter
      .createCaller(buildCtx(18))
      .renderVideo({ contentPostId: 100, mode: "basic" });

    expect(service.renderBasicDraftVideo).toHaveBeenCalledTimes(1);
    expect(service.renderBasicDraftVideo).toHaveBeenCalledWith({
      userId: 18,
      contentPostId: 100,
    });
    expect(result).toEqual({
      success: true,
      mode: "basic",
      status: "done",
      jobId: "basic-render-1",
      provider: "internal",
      videoUrl: "https://cdn.example.com/draft.mp4",
      thumbnailUrl: "https://cdn.example.com/draft-thumb.jpg",
      durationSeconds: 15,
      aspectRatio: "9:16",
    });
    expect(service.generatePremiumVideo).not.toHaveBeenCalled();
  });
});
