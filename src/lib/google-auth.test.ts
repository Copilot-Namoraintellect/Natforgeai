import { describe, expect, it } from "vitest";
import { getGooglePopupOutcome, shouldShowGoogleErrorBanner } from "./google-auth";

describe("google popup error handling", () => {
  it("treats popup cancellation as neutral and hides red error banner", () => {
    const outcome = getGooglePopupOutcome({ code: "auth/popup-closed-by-user" });
    expect(outcome.kind).toBe("cancelled");
    expect(outcome.message).toContain("cancelled");
    expect(shouldShowGoogleErrorBanner(outcome)).toBe(false);
  });

  it("returns popup blocked helper message", () => {
    const outcome = getGooglePopupOutcome({ code: "auth/popup-blocked" });
    expect(outcome.kind).toBe("blocked");
    expect(outcome.message.toLowerCase()).toContain("allow popups");
  });
});
