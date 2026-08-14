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

  it("selects canary by business allowlist", () => {
    const result = resolveCanarySelection(scope, {
      CREATIVE_PIPELINE_V2_MODE: "canary",
      CREATIVE_PIPELINE_V2_CANARY_ENABLED: "true",
      CREATIVE_PIPELINE_V2_CANARY_BUSINESS_IDS: "300",
    } as NodeJS.ProcessEnv);
    expect(result.selected).toBe(true);
    expect(result.reason).toBe("business_allowlist");
  });

  it("selects canary by user allowlist", () => {
    const result = resolveCanarySelection(scope, {
      CREATIVE_PIPELINE_V2_MODE: "canary",
      CREATIVE_PIPELINE_V2_CANARY_ENABLED: "true",
      CREATIVE_PIPELINE_V2_CANARY_USER_IDS: "7",
    } as NodeJS.ProcessEnv);
    expect(result.selected).toBe(true);
    expect(result.reason).toBe("user_allowlist");
  });

  it("remains unselected when no allowlist matches", () => {
    const result = resolveCanarySelection(scope, {
      CREATIVE_PIPELINE_V2_MODE: "canary",
      CREATIVE_PIPELINE_V2_CANARY_ENABLED: "true",
      CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS: "999",
      CREATIVE_PIPELINE_V2_CANARY_BUSINESS_IDS: "999",
      CREATIVE_PIPELINE_V2_CANARY_USER_IDS: "999",
      CREATIVE_PIPELINE_V2_CANARY_SALT: "slice2",
    } as NodeJS.ProcessEnv);
    expect(result.selected).toBe(false);
    expect(result.reason).toBe("percent_not_selected");
  });

  it("returns percent_not_selected for a valid identity outside the configured percentage", () => {
    const result = resolveCanarySelection(scope, {
      CREATIVE_PIPELINE_V2_MODE: "canary",
      CREATIVE_PIPELINE_V2_CANARY_ENABLED: "true",
      CREATIVE_PIPELINE_V2_CANARY_PERCENT: "0",
      CREATIVE_PIPELINE_V2_CANARY_SALT: "slice2",
    } as NodeJS.ProcessEnv);
    expect(result.selected).toBe(false);
    expect(result.reason).toBe("percent_not_selected");
    expect(result.bucket).not.toBeNull();
    expect(result.percent).toBe(0);
  });

  it("is deterministic for the same identity and salt", () => {
    const env = {
      CREATIVE_PIPELINE_V2_MODE: "canary",
      CREATIVE_PIPELINE_V2_CANARY_ENABLED: "true",
      CREATIVE_PIPELINE_V2_CANARY_PERCENT: "50",
      CREATIVE_PIPELINE_V2_CANARY_SALT: "slice2",
    } as NodeJS.ProcessEnv;

    const first = resolveCanarySelection(scope, env);
    const second = resolveCanarySelection(scope, env);

    expect(first.selected).toBe(second.selected);
    expect(first.reason).toBe(second.reason);
    expect(first.bucket).toBe(second.bucket);
    expect(first.percent).toBe(second.percent);
  });

  it.each(["false", "0", "no", "maybe", ""])("remains disabled when CANARY_ENABLED is '%s'", (value) => {
    const result = resolveCanarySelection(scope, {
      CREATIVE_PIPELINE_V2_MODE: "canary",
      CREATIVE_PIPELINE_V2_CANARY_ENABLED: value,
      CREATIVE_PIPELINE_V2_CANARY_PERCENT: "100",
      CREATIVE_PIPELINE_V2_CANARY_SALT: "slice2",
    } as NodeJS.ProcessEnv);
    expect(result.selected).toBe(false);
    expect(result.reason).toBe("canary_disabled");
  });

  it("treats unknown mode as fail-closed off", () => {
    const result = resolveCanarySelection(scope, {
      CREATIVE_PIPELINE_V2_MODE: "unknown_mode",
      CREATIVE_PIPELINE_V2_CANARY_ENABLED: "true",
      CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS: "30",
    } as NodeJS.ProcessEnv);
    expect(result.mode).toBe("off");
    expect(result.selected).toBe(false);
    expect(result.reason).toBe("mode_unknown");
  });
});
