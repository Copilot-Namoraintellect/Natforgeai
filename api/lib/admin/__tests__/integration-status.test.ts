import { describe, it, expect } from "vitest";
import { aggregateIntegrationStatuses } from "../integration-status";

describe("aggregateIntegrationStatuses", () => {
  it("counts connected Instagram rows as connected", () => {
    const rows = [
      { platform: "instagram" as const, status: "connected" as const },
      { platform: "facebook" as const, status: "connected" as const },
      { platform: "instagram" as const, status: "expired" as const },
    ];

    const result = aggregateIntegrationStatuses(rows);

    expect(result.instagram).toEqual({ connected: 1, expired: 1 });
    expect(result.facebook).toEqual({ connected: 1 });
  });

  it("handles null platform/status as unknown", () => {
    const rows = [{ platform: null, status: null }];
    const result = aggregateIntegrationStatuses(rows);
    expect(result.unknown).toEqual({ unknown: 1 });
  });
});
