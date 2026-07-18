import { describe, expect, it } from "vitest";
import { resolveCanarySelection } from "../canary-selector";

describe("resolveCanarySelection", () => {
  const scope = { campaignId: 30, businessId: 300, userId: 7 };

  it("fails closed when enabled flag is missing", () => {
    const result = resolveCanarySelection(scope, {
      CREATIVE_PIPELINE_V2_MODE: "canary",
    } as NodeJS.ProcessEnv);
    expect(result.selected).toBe(false);
    expect(result.reason).toBe("canary_disabled");
  });

  it("treats active as reserved off", () => {
    const result = resolveCanarySelection(scope, {
      CREATIVE_PIPELINE_V2_MODE: "active",
      CREATIVE_PIPELINE_V2_CANARY_ENABLED: "true",
    } as NodeJS.ProcessEnv);
    expect(result.mode).toBe("off");
    expect(result.selected).toBe(false);
  });

  it("ignores malformed allowlist entries", () => {
    const result = resolveCanarySelection(scope, {
      CREATIVE_PIPELINE_V2_MODE: "canary",
      CREATIVE_PIPELINE_V2_CANARY_ENABLED: "true",
      CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS: "bad,30,also_bad",
    } as NodeJS.ProcessEnv);
    expect(result.selected).toBe(true);
    expect(result.reason).toBe("campaign_allowlist");
  });

  it("uses deterministic percent bucket only when salt is present", () => {
    const noSalt = resolveCanarySelection(scope, {
      CREATIVE_PIPELINE_V2_MODE: "canary",
      CREATIVE_PIPELINE_V2_CANARY_ENABLED: "true",
      CREATIVE_PIPELINE_V2_CANARY_PERCENT: "100",
    } as NodeJS.ProcessEnv);
    expect(noSalt.selected).toBe(false);
    expect(noSalt.reason).toBe("salt_missing");

    const withSalt = resolveCanarySelection(scope, {
      CREATIVE_PIPELINE_V2_MODE: "canary",
      CREATIVE_PIPELINE_V2_CANARY_ENABLED: "true",
      CREATIVE_PIPELINE_V2_CANARY_PERCENT: "100",
      CREATIVE_PIPELINE_V2_CANARY_SALT: "slice2",
    } as NodeJS.ProcessEnv);
    expect(withSalt.selected).toBe(true);
    expect(withSalt.reason).toBe("percent_bucket");
  });

  it("bounds invalid percentage to zero", () => {
    const result = resolveCanarySelection(scope, {
      CREATIVE_PIPELINE_V2_MODE: "canary",
      CREATIVE_PIPELINE_V2_CANARY_ENABLED: "true",
      CREATIVE_PIPELINE_V2_CANARY_PERCENT: "not-a-number",
      CREATIVE_PIPELINE_V2_CANARY_SALT: "slice2",
    } as NodeJS.ProcessEnv);
    expect(result.percent).toBe(0);
    expect(result.selected).toBe(false);
  });
});
