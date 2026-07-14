import { describe, expect, it } from "vitest";
import {
  toSafeBullMqJobId,
  toContentGenerationBullMqJobId,
  toPublishingBullMqJobId,
} from "./bullmq";

describe("BullMQ job ID sanitization", () => {
  it("generated job IDs contain no colon", () => {
    const id = toSafeBullMqJobId("content-generation:18:30");
    expect(id.includes(":")).toBe(false);
  });

  it("user ID, campaign ID and run ID inputs produce valid IDs", () => {
    const userCampaign = toSafeBullMqJobId("content-generation-18-30");
    const runId = toContentGenerationBullMqJobId(456);
    const publishId = toPublishingBullMqJobId(99);

    expect(userCampaign).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(runId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(publishId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(runId).toContain("456");
  });
});
