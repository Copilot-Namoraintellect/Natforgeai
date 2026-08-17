import { describe, it, expect, vi, beforeEach } from "vitest";
import { UnrecoverableError } from "bullmq";
import { processPublishingJob } from "./publishing-worker";

vi.mock("../workflow/publishing-runner", () => ({
  publishSinglePost: vi.fn(),
}));

vi.mock("../../alerts", () => ({
  createAlert: vi.fn(async () => {}),
}));

function makeJob(overrides: any = {}) {
  return {
    id: "job-1",
    data: {
      queueItemId: 1,
      userId: 18,
      platform: "Instagram",
      ...overrides,
    },
  } as any;
}

describe("publishing-worker permanent vs transient failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls publishSinglePost exactly once and throws UnrecoverableError for permanent readiness rejection", async () => {
    const { publishSinglePost } = await import("../workflow/publishing-runner");
    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 1,
      status: "precondition_failed",
      platform: "Instagram",
      error: "Campaign launch approval is pending",
    });

    await expect(processPublishingJob(makeJob())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(publishSinglePost).toHaveBeenCalledTimes(1);
    expect(publishSinglePost).toHaveBeenCalledWith(1);
  });

  it("throws a normal Error for transient publish failures so BullMQ can retry", async () => {
    const { publishSinglePost } = await import("../workflow/publishing-runner");
    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 1,
      status: "failed",
      platform: "Instagram",
      error: "Network timeout",
    });

    await expect(processPublishingJob(makeJob())).rejects.toThrow("Network timeout");
    await expect(processPublishingJob(makeJob())).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(publishSinglePost).toHaveBeenCalledTimes(2); // one call per processPublishingJob invocation
  });

  it("throws a normal Error for safety-blocked content so BullMQ can retry", async () => {
    const { publishSinglePost } = await import("../workflow/publishing-runner");
    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 1,
      status: "safety_blocked",
      platform: "Instagram",
      error: "Safety check blocked",
    });

    await expect(processPublishingJob(makeJob())).rejects.toThrow("Safety check blocked");
    await expect(processPublishingJob(makeJob())).rejects.not.toBeInstanceOf(UnrecoverableError);
  });
});
