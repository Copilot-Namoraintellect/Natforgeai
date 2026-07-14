import { describe, expect, it } from "vitest";
import { ctaMatchesSelectedStage, extractFunnelCtaMap } from "./cta-utils";

describe("cta-utils", () => {
  it("matches Learn More regardless of punctuation and case", () => {
    const matches = ctaMatchesSelectedStage({
      cta: " Learn   More!! ",
      preferredCta: "Awareness: learn more\nConsideration: Get Pricing\nConversion: Book a Demo",
      objectiveOrStage: "awareness",
    });

    expect(matches).toBe(true);
  });

  it("parses staged CTA lines using colon or hyphen", () => {
    const map = extractFunnelCtaMap(
      "Awareness - Learn More\nConsideration: Get Pricing\nConversion - Book a Demo"
    );

    expect(map.awareness).toBe("Learn More");
    expect(map.consideration).toBe("Get Pricing");
    expect(map.conversion).toBe("Book a Demo");
  });
});
