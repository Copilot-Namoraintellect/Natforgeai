import { describe, expect, it, vi } from "vitest";

import {
  VISUAL_QUALITY_GATE_MODE_ENV_VAR,
  getConfiguredVisualQualityGateMode,
} from "./visual-quality-gate-mode";

describe("getConfiguredVisualQualityGateMode", () => {
  it("defaults to observe when the env var is unset", () => {
    expect(getConfiguredVisualQualityGateMode({ rawMode: null })).toBe("observe");
    expect(getConfiguredVisualQualityGateMode({ rawMode: "" })).toBe("observe");
    expect(getConfiguredVisualQualityGateMode({ rawMode: "   " })).toBe("observe");
  });

  it("accepts observe and enforce case-insensitively with whitespace trimmed", () => {
    expect(getConfiguredVisualQualityGateMode({ rawMode: "observe" })).toBe("observe");
    expect(getConfiguredVisualQualityGateMode({ rawMode: "enforce" })).toBe("enforce");
    expect(getConfiguredVisualQualityGateMode({ rawMode: " ENFORCE " })).toBe("enforce");
    expect(getConfiguredVisualQualityGateMode({ rawMode: "Observe" })).toBe("observe");
  });

  it("fails closed to observe for invalid values and emits a sanitized warning", () => {
    const warn = vi.fn();
    expect(getConfiguredVisualQualityGateMode({ rawMode: "shadow", warn })).toBe("observe");
    expect(getConfiguredVisualQualityGateMode({ rawMode: "on", warn })).toBe("observe");
    expect(getConfiguredVisualQualityGateMode({ rawMode: "enforce!", warn })).toBe("observe");
    expect(warn).toHaveBeenCalledTimes(3);
    for (const [message] of warn.mock.calls) {
      expect(message).toMatch(/Invalid VISUAL_QUALITY_GATE_MODE/);
      expect(message).not.toContain("shadow");
      expect(message).not.toContain("enforce!");
    }
  });

  it("never changes the outcome when the warn sink throws", () => {
    const warn = vi.fn(() => {
      throw new Error("warn sink failure");
    });
    expect(getConfiguredVisualQualityGateMode({ rawMode: "bogus", warn })).toBe("observe");
    expect(getConfiguredVisualQualityGateMode({ rawMode: "enforce", warn })).toBe("enforce");
  });

  it("reads process.env at call time when rawMode is omitted", () => {
    const original = process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR];
    try {
      delete process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR];
      expect(getConfiguredVisualQualityGateMode()).toBe("observe");
      process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR] = "enforce";
      expect(getConfiguredVisualQualityGateMode()).toBe("enforce");
    } finally {
      if (original === undefined) {
        delete process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR];
      } else {
        process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR] = original;
      }
    }
  });
});
