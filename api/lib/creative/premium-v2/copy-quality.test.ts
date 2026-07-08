import { describe, it, expect } from "vitest";
import { evaluateCopyQuality, cleanCopy, visibleTextFromBrief } from "./copy-quality";

describe("copy-quality gate", () => {
  it("catches 'with for' as broken grammar", () => {
    const result = evaluateCopyQuality("We print with for all your business needs");
    expect(result.copyQualityIssues.some((i) => i.includes("with for"))).toBe(true);
    expect(result.copyQualityPassed).toBe(false);
    expect(result.cleanedVisibleText).not.toMatch(/with for/i);
  });

  it("catches 'delivery your convenience' as missing preposition", () => {
    const result = evaluateCopyQuality("Courier Services Reliable delivery your convenience");
    expect(result.copyQualityIssues.some((i) => i.includes("delivery your convenience"))).toBe(true);
    expect(result.copyQualityPassed).toBe(false);
    expect(result.cleanedVisibleText.toLowerCase()).toContain("delivery for your convenience");
  });

  it("catches the 3@1-style weak service description", () => {
    const result = evaluateCopyQuality("Printing Solutions prints for all your needs");
    expect(result.copyQualityIssues.some((i) => i.includes("for all your needs"))).toBe(true);
    expect(result.copyQualityPassed).toBe(false);
    expect(result.cleanedVisibleText.toLowerCase()).toContain("for everyday business needs");
  });

  it("catches duplicated consecutive words", () => {
    const result = evaluateCopyQuality("Fast fast printing for everyday use");
    expect(result.copyQualityIssues.some((i) => i.includes("Repeated consecutive word"))).toBe(true);
    expect(result.copyQualityPassed).toBe(false);
  });

  it("rejects generic filler phrases", () => {
    const result = evaluateCopyQuality(
      "Tailored for you with expert support every step to boost visibility"
    );
    expect(result.copyQualityIssues.length).toBeGreaterThanOrEqual(3);
    expect(result.copyQualityPassed).toBe(false);
  });

  it("passes safe non-promotional CTAs", () => {
    const result = evaluateCopyQuality("Contact Today Request a Quote Visit Us Today Get Started");
    expect(result.copyQualityPassed).toBe(true);
    expect(result.copyQualityScore).toBe(100);
  });

  it("cleanCopy removes generic filler and fixes grammar", () => {
    expect(cleanCopy("Printing Solutions prints for all your needs")).toBe(
      "Printing Solutions prints for everyday business needs."
    );
    expect(cleanCopy("Courier Services delivery your convenience")).toBe(
      "Courier Services delivery for your convenience."
    );
    expect(cleanCopy("A service tailored for you")).toBe("A service made to fit your project.");
  });

  it("visibleTextFromBrief joins all customer-facing copy", () => {
    const text = visibleTextFromBrief({
      headline: "Fast Prints",
      subheadline: "Reliable local printing",
      primaryServices: [
        { name: "Business Cards", description: "Professional first impressions." },
      ],
      secondaryServices: [{ name: "Courier" }],
      benefits: ["Same-day turnaround"],
      cta: "Request a Quote",
    });
    expect(text).toContain("Fast Prints");
    expect(text).toContain("Business Cards");
    expect(text).toContain("Professional first impressions.");
    expect(text).toContain("Courier");
    expect(text).toContain("Same-day turnaround");
    expect(text).toContain("Request a Quote");
  });
});
