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

describe("Distribution temporal-grounding source contract", () => {
  it("uses one authoritative scheduling reference for prompt grounding and canonical validation", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("./distribution-agent.ts", import.meta.url),
      "utf8"
    );

    expect(
      source.match(/const\s+schedulingReference\s*=\s*new\s+Date\s*\(\s*\)/g)
        ?.length ?? 0
    ).toBe(1);

    expect(source).toContain(
      "Authoritative scheduling reference instant: ${schedulingReferenceIso}."
    );

    expect(source).toMatch(
      /system:\s*`[\s\S]*Authoritative scheduling reference instant: \$\{schedulingReferenceIso\}\./
    );
    expect(source).toContain(
      "Every scheduledAt value MUST represent an instant at or after this reference instant."
    );
    expect(source).toContain(
      "{ now: schedulingReference }"
    );
  });
});
