import { describe, it, expect } from "vitest";
import { buildBusinessDescriptions, countWords } from "./business-description";

describe("business description quality", () => {
  it("generates a useful business profile between 80 and 150 words", () => {
    const result = buildBusinessDescriptions({
      businessName: "NatForge Foods",
      businessCategory: "Food & Beverage",
      productsServices: ["meal prep", "event catering", "corporate lunch delivery"],
      targetCustomers: ["busy professionals", "SME teams", "event organisers"],
      valueProposition: "fresh, reliable catering with predictable turnaround times",
      location: "Johannesburg",
      tone: "friendly and premium",
      evidenceSnippets: [
        "custom corporate lunch plans",
        "same-day catering for office events",
        "weekday delivery windows",
      ],
    });

    const words = countWords(result.businessDescription);
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(150);
    expect(result.shortDescription.length).toBeGreaterThan(20);
  });
});
