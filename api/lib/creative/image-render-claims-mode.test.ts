import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getConfiguredImageRenderClaimsMode,
  resolveEffectiveImageRenderClaimsMode,
  IMAGE_RENDER_CLAIMS_MODE_ENV_VAR,
  type ImageRenderClaimsMode,
} from "./image-render-claims-mode";

// ─── Deterministic pure-mode tests ───
//
// No database, timers, environment mutation beyond scoped process.env
// adjustments restored in afterEach, and no global state.

const VALID_ON = { ready: true } as const;

function expectMode(result: ImageRenderClaimsMode, expected: ImageRenderClaimsMode) {
  expect(result).toBe(expected);
}

afterEach(() => {
  delete process.env[IMAGE_RENDER_CLAIMS_MODE_ENV_VAR];
  delete process.env.QUALITY_AUTHORITY_MODE;
  vi.restoreAllMocks();
});

describe("getConfiguredImageRenderClaimsMode — fail-closed parsing", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace-only", "   "],
    ["tab/newline only", "\t\n "],
  ])("missing-like value (%s) resolves to off without warning", (_label, rawMode) => {
    const warn = vi.fn();
    expectMode(getConfiguredImageRenderClaimsMode({ rawMode, warn }), "off");
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads process.env at call time when rawMode is omitted", () => {
    process.env[IMAGE_RENDER_CLAIMS_MODE_ENV_VAR] = "on";
    expectMode(getConfiguredImageRenderClaimsMode(), "on");
    process.env[IMAGE_RENDER_CLAIMS_MODE_ENV_VAR] = "invalid-thing";
    expectMode(getConfiguredImageRenderClaimsMode(), "off");
  });

  it("missing environment variable resolves to off", () => {
    expectMode(getConfiguredImageRenderClaimsMode(), "off");
  });

  it.each([
    ["off", "off"],
    ["on", "on"],
  ])("exact value %s resolves to %s", (raw, expected) => {
    expectMode(getConfiguredImageRenderClaimsMode({ rawMode: raw }), expected as ImageRenderClaimsMode);
  });

  it.each([
    ["leading/trailing whitespace", "  on  ", "on"],
    ["tab/newline-padded on", "\ton\n", "on"],
    ["whitespace around off", " off ", "off"],
  ])("surrounding whitespace is trimmed (%s)", (_label, raw, expected) => {
    expectMode(getConfiguredImageRenderClaimsMode({ rawMode: raw }), expected as ImageRenderClaimsMode);
  });

  it.each([
    ["uppercase ON", "ON"],
    ["mixed On", "On"],
    ["uppercase OFF", "OFF"],
    ["mixed Off", "oFf"],
  ])("value is case-insensitive (%s)", (_label, raw) => {
    const expected = raw.trim().toLowerCase() as ImageRenderClaimsMode;
    expectMode(getConfiguredImageRenderClaimsMode({ rawMode: raw }), expected);
  });

  it.each([
    ["observe", "observe"],
    ["enforce", "enforce"],
    ["yes", "yes"],
    ["numeric", "1"],
    ["near-miss", "onn"],
    ["symbols", "on!"],
  ])("invalid value %s resolves to off with one sanitized warning", (_label, raw) => {
    const warn = vi.fn();
    expectMode(getConfiguredImageRenderClaimsMode({ rawMode: raw, warn }), "off");
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).not.toContain(raw);
    expect(message).toContain("IMAGE_RENDER_CLAIMS_MODE");
  });

  it("invalid value without a warn sink still resolves to off", () => {
    expectMode(getConfiguredImageRenderClaimsMode({ rawMode: "nope" }), "off");
  });

  it.each([
    ["raw connection string", "on mysql://user:secret@host/db"],
    ["secret-like value", "off hunter2"],
  ])("warning for invalid value never echoes the raw value (%s)", (_label, raw) => {
    const warn = vi.fn();
    getConfiguredImageRenderClaimsMode({ rawMode: raw, warn });
    const message = warn.mock.calls[0][0] as string;
    expect(message).not.toContain(raw);
    expect(message).not.toContain("mysql://");
    expect(message).not.toContain("hunter2");
  });

  it("a throwing warn sink cannot change the fail-closed outcome", () => {
    const warn = vi.fn(() => {
      throw new Error("logger exploded");
    });
    expectMode(getConfiguredImageRenderClaimsMode({ rawMode: "invalid", warn }), "off");
  });

  it("QUALITY_AUTHORITY_MODE has no effect on the claims mode", () => {
    for (const qaMode of ["enforce", "observe", "garbage"]) {
      process.env.QUALITY_AUTHORITY_MODE = qaMode;
      expectMode(getConfiguredImageRenderClaimsMode({ rawMode: "on" }), "on");
      expectMode(getConfiguredImageRenderClaimsMode({ rawMode: "invalid", warn: vi.fn() }), "off");
    }
  });

  it("explicit rawMode takes precedence over the environment variable", () => {
    process.env[IMAGE_RENDER_CLAIMS_MODE_ENV_VAR] = "on";
    expectMode(getConfiguredImageRenderClaimsMode({ rawMode: "off" }), "off");
    process.env[IMAGE_RENDER_CLAIMS_MODE_ENV_VAR] = "off";
    expectMode(getConfiguredImageRenderClaimsMode({ rawMode: "on" }), "on");
  });
});

describe("resolveEffectiveImageRenderClaimsMode — effective-mode invariant", () => {
  it("configured off stays off even with ready readiness", () => {
    expectMode(resolveEffectiveImageRenderClaimsMode({ configuredMode: "off", readiness: VALID_ON }), "off");
  });

  it("configured on + ready=true resolves to on", () => {
    expectMode(resolveEffectiveImageRenderClaimsMode({ configuredMode: "on", readiness: VALID_ON }), "on");
  });

  it.each([
    ["not_ready", { ready: false, reason: "claim_table_missing" }],
    ["unavailable", { ready: false, reason: "claim_database_unavailable" }],
    ["malformed empty object", {}],
    ["malformed boolean", true],
    ["malformed string", "ready"],
    ["malformed ready false literal", { ready: false }],
    ["null", null],
    ["undefined", undefined],
    ["array", [{ ready: true }]],
  ])("configured on + %s resolves to off", (_label, readiness) => {
    expectMode(
      resolveEffectiveImageRenderClaimsMode({ configuredMode: "on", readiness }),
      "off"
    );
  });
});
