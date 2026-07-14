import { describe, expect, it, vi } from "vitest";

vi.mock("../jobs/content-generation-job", () => ({
  processContentGenerationJob: vi.fn(async () => undefined),
}));

import { processQueuedContentGenerationJob } from "./content-generation-worker";

describe("content generation worker", () => {
  it("worker receives queued job data and forwards it to the job processor", async () => {
    const { processContentGenerationJob } = await import("../jobs/content-generation-job");

    const fakeJob = {
      data: {
        jobId: 333,
        userId: 18,
        campaignId: 30,
        regenerate: false,
      },
    } as any;

    await processQueuedContentGenerationJob(fakeJob);

    expect(processContentGenerationJob).toHaveBeenCalledTimes(1);
    expect(processContentGenerationJob).toHaveBeenCalledWith(fakeJob.data);
  });
});
