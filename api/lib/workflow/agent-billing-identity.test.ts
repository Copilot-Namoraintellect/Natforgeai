import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  buildAudienceBillingIdentity,
  buildAudienceIntelligenceBillingIdentity,
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

  it("builds the audience-intelligence identity in the Stream E frozen format (C0.2)", () => {
    // docs/contracts/financial-reliability-contract.md §2:
    // agent-audience-intel-${sha256("workflow/agent-billing@v1:audience-intel:{campaignId}:{continuationId}")}
    const identity = buildAudienceIntelligenceBillingIdentity({
      campaignId: 7,
      continuationId: 9001,
    });
    const expectedDigest = createHash("sha256")
      .update("workflow/agent-billing@v1:audience-intel:7:9001", "utf8")
      .digest("hex");
    expect(identity).toBe(`agent-audience-intel-${expectedDigest}`);
    expect(identity).toMatch(/^agent-audience-intel-[0-9a-f]{64}$/);
    expect(identity.length).toBeLessThanOrEqual(255);
  });

  it("keeps the audience-intelligence identity stable across retry/restart of one logical operation", () => {
    const first = buildAudienceIntelligenceBillingIdentity({
      campaignId: 7,
      continuationId: 9001,
    });
    const retry = buildAudienceIntelligenceBillingIdentity({
      campaignId: 7,
      continuationId: 9001,
    });
    expect(retry).toBe(first);
  });

  it("mints a new audience-intelligence identity for a new continuation", () => {
    const base = buildAudienceIntelligenceBillingIdentity({
      campaignId: 7,
      continuationId: 9001,
    });
    expect(buildAudienceIntelligenceBillingIdentity({ campaignId: 7, continuationId: 9002 })).not.toBe(
      base
    );
    expect(buildAudienceIntelligenceBillingIdentity({ campaignId: 8, continuationId: 9001 })).not.toBe(
      base
    );
  });

  it("rejects invalid audience-intelligence coordinates", () => {
    expect(() =>
      buildAudienceIntelligenceBillingIdentity({ campaignId: 0, continuationId: 9001 })
    ).toThrow(/campaignId/);
    expect(() =>
      buildAudienceIntelligenceBillingIdentity({ campaignId: 7, continuationId: -1 })
    ).toThrow(/continuationId/);
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
