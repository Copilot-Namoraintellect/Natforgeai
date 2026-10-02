import { describe, expect, it } from "vitest";
import { PublishingScheduleSchema } from "./distribution-agent";

describe("Distribution publishing schedule structured-output contract", () => {
  it("requires a scheduling reason for every generated schedule item", () => {
    const valid = PublishingScheduleSchema.safeParse({
      schedule: [
        {
          contentPostId: 1,
          platform: "linkedin",
          scheduledAt: "2026-10-02T08:00:00.000Z",
          reason: "Scheduled for the intended professional audience.",
        },
      ],
    });

    const missingReason = PublishingScheduleSchema.safeParse({
      schedule: [
        {
          contentPostId: 1,
          platform: "linkedin",
          scheduledAt: "2026-10-02T08:00:00.000Z",
        },
      ],
    });

    expect(valid.success).toBe(true);
    expect(missingReason.success).toBe(false);
  });
});