import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  buildAudienceBillingIdentity,
  buildDistributionBillingIdentity,
} from "./agent-billing-identity";

describe("agent billing identities", () => {
  it("builds the audience identity in the contracted format", () => {
    const identity = buildAudienceBillingIdentity({ campaignId: 7, creativeRunId: 501 });
    const expectedDigest = createHash("sha256")
      .update("workflow/agent-billing@v1:audience:7:501", "utf8")
      .digest("hex");
    expect(identity).toBe(`agent-audience-${expectedDigest}`);
    expect(identity).toMatch(/^agent-audience-[0-9a-f]{64}$/);
  });

  it("builds the distribution identity in the contracted format", () => {
    const identity = buildDistributionBillingIdentity({ campaignId: 7, audienceRunId: 610 });
    const expectedDigest = createHash("sha256")
      .update("workflow/agent-billing@v1:distribution:7:610", "utf8")
      .digest("hex");
    expect(identity).toBe(`agent-distribution-${expectedDigest}`);
    expect(identity).toMatch(/^agent-distribution-[0-9a-f]{64}$/);
  });

  it("is stable across retries of the same logical step", () => {
    const first = buildAudienceBillingIdentity({ campaignId: 7, creativeRunId: 501 });
    const retry = buildAudienceBillingIdentity({ campaignId: 7, creativeRunId: 501 });
    expect(retry).toBe(first);
  });

  it("changes when any material coordinate changes", () => {
    const base = buildAudienceBillingIdentity({ campaignId: 7, creativeRunId: 501 });
    expect(buildAudienceBillingIdentity({ campaignId: 8, creativeRunId: 501 })).not.toBe(base);
    expect(buildAudienceBillingIdentity({ campaignId: 7, creativeRunId: 502 })).not.toBe(base);
  });

  it("rejects invalid coordinates", () => {
    expect(() => buildAudienceBillingIdentity({ campaignId: 0, creativeRunId: 501 })).toThrow(
      /campaignId/
    );
    expect(() => buildAudienceBillingIdentity({ campaignId: 7, creativeRunId: -1 })).toThrow(
      /creativeRunId/
    );
    expect(() => buildDistributionBillingIdentity({ campaignId: 7, audienceRunId: 1.5 })).toThrow(
      /audienceRunId/
    );
  });
});
