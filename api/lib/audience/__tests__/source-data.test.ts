import { describe, it, expect } from "vitest";
import { hasAudienceSourceData } from "../source-data";

describe("hasAudienceSourceData", () => {
  it("returns false when all source data counts are zero", () => {
    expect(
      hasAudienceSourceData({ integrations: 0, profiles: 0, events: 0, signals: 0 })
    ).toBe(false);
  });

  it("returns false when only integrations are missing", () => {
    expect(
      hasAudienceSourceData({ integrations: 0, profiles: 0, events: 0, signals: 0 })
    ).toBe(false);
  });

  it("returns true when connected integrations exist", () => {
    expect(
      hasAudienceSourceData({ integrations: 1, profiles: 0, events: 0, signals: 0 })
    ).toBe(true);
  });

  it("returns true when synced profiles exist", () => {
    expect(
      hasAudienceSourceData({ integrations: 0, profiles: 3, events: 0, signals: 0 })
    ).toBe(true);
  });

  it("returns true when engagement events exist", () => {
    expect(
      hasAudienceSourceData({ integrations: 0, profiles: 0, events: 5, signals: 0 })
    ).toBe(true);
  });

  it("returns true when campaign interest signals exist", () => {
    expect(
      hasAudienceSourceData({ integrations: 0, profiles: 0, events: 0, signals: 2 })
    ).toBe(true);
  });
});
