import { describe, it, expect, vi } from "vitest";
import { scrollToTop, shouldScrollToTop } from "./onboarding-navigation";

describe("onboarding step scroll behavior", () => {
  it("returns true when step changes", () => {
    expect(shouldScrollToTop(1, 2)).toBe(true);
    expect(shouldScrollToTop(3, 1)).toBe(true);
  });

  it("returns false when step does not change", () => {
    expect(shouldScrollToTop(2, 2)).toBe(false);
  });

  it("calls scroller with top position", () => {
    const scroller = vi.fn();
    scrollToTop(scroller);
    expect(scroller).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });
});
