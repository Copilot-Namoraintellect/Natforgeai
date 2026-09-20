import { describe, expect, it } from "vitest";

import {
  formatSystemHealthCheckValue,
} from "./system-health-check-display";

describe("system health check display", () => {
  it("shows the operational message for a healthy post-live lifecycle check", () => {
    expect(
      formatSystemHealthCheckValue(
        "postLiveLifecycle",
        {
          status: "ok",
          latencyMs: 0,
          message:
            "Post-live lifecycle scheduler disabled by configuration",
        }
      )
    ).toBe(
      "Post-live lifecycle scheduler disabled by configuration"
    );
  });

  it("preserves latency display for ordinary healthy checks", () => {
    expect(
      formatSystemHealthCheckValue(
        "database",
        {
          status: "ok",
          latencyMs: 12,
          message: "Connected",
        }
      )
    ).toBe("12ms");
  });

  it("preserves error-message display", () => {
    expect(
      formatSystemHealthCheckValue(
        "postLiveLifecycle",
        {
          status: "error",
          latencyMs: 0,
          message:
            "Post-live lifecycle scheduler is enabled but not started",
        }
      )
    ).toBe(
      "Post-live lifecycle scheduler is enabled but not started"
    );
  });
});
