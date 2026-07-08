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

  it("decodes HTML entities before checking copy", () => {
    const result = evaluateCopyQuality("Fast Prints &amp; Courier for all your needs");
    expect(result.copyQualityIssues.some((i) => i.includes("HTML entity"))).toBe(true);
    expect(result.copyQualityIssues.some((i) => i.includes("for all your needs"))).toBe(true);
    expect(result.cleanedVisibleText).toContain("Fast Prints & Courier");
    expect(result.cleanedVisibleText).not.toContain("&amp;");
  });

  it("catches missing connector between product nouns", () => {
    const result = evaluateCopyQuality(
      "From flyers and business cards canvas prints and courier support"
    );
    expect(result.copyQualityIssues.some((i) => i.includes("Missing connector"))).toBe(true);
    expect(result.copyQualityPassed).toBe(false);
    expect(result.cleanedVisibleText.toLowerCase()).toContain("business cards to canvas");
  });

  it("catches 'when matters' missing word", () => {
    const result = evaluateCopyQuality("Reliable local collection and delivery when matters");
    expect(result.copyQualityIssues.some((i) => i.includes('"when matters"'))).toBe(true);
    expect(result.copyQualityPassed).toBe(false);
    expect(result.cleanedVisibleText.toLowerCase()).toContain("when it matters");
  });

  it("catches broken CTA 'Get Touch'", () => {
    const result = evaluateCopyQuality("Quality service. Get Touch.");
    expect(result.copyQualityIssues.some((i) => i.includes('"get touch"'))).toBe(true);
    expect(result.copyQualityPassed).toBe(false);
    expect(result.cleanedVisibleText).toContain("Get in Touch");
  });

  it("catches orphaned lowercase fragments", () => {
    const result = evaluateCopyQuality(
      "Professional printing and marketing products branding courier services"
    );
    expect(result.copyQualityIssues.some((i) => /Orphaned (fragment|heading)/i.test(i))).toBe(true);
    expect(result.copyQualityPassed).toBe(false);
    expect(result.cleanedVisibleText).not.toMatch(/\band marketing products\b/i);
  });

  it("catches repeated service descriptions", () => {
    const result = evaluateCopyQuality(
      "Business Cards Quality print and document services for everyday business. Flyers Quality print and document services for everyday business."
    );
    expect(result.copyQualityIssues.some((i) => i.includes("Repeated description"))).toBe(true);
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
    expect(cleanCopy("and marketing products")).toBe("Marketing products.");
    expect(cleanCopy("Get Touch")).toBe("Get in Touch.");
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
