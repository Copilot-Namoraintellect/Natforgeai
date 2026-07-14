import { describe, expect, it } from "vitest";
import { canonicalizeMessagePackCopy } from "../canonical-copy";

describe("canonicalizeMessagePackCopy", () => {
  it("applies NFC normalization", () => {
    const decomposed = "Cafe\u0301";
    const canonical = canonicalizeMessagePackCopy({
      copySchemaVersion: "v2.1",
      headline: decomposed,
      subheadline: "ok",
      benefitBulletsOrdered: ["one", "two", "three"],
      cta: "Learn More",
      footer: null,
    });

    expect(canonical.headline).toBe("Caf\u00e9");
  });

  it("normalizes CRLF and CR to LF and trims boundaries", () => {
    const canonical = canonicalizeMessagePackCopy({
      copySchemaVersion: " v2.1\r\n",
      headline: "\r\n Hello\r\nWorld \r",
      subheadline: "\rLine\r\nTwo\r",
      benefitBulletsOrdered: ["  A\r\nB  ", " C\rD "],
      cta: " Learn More ",
      footer: { location: " Joburg\r\n " },
    });

    expect(canonical.copySchemaVersion).toBe("v2.1");
    expect(canonical.headline).toBe("Hello\nWorld");
    expect(canonical.subheadline).toBe("Line\nTwo");
    expect(canonical.benefitBulletsOrdered).toEqual(["A\nB", "C\nD"]);
    expect(canonical.cta).toBe("Learn More");
    expect(canonical.footer?.location).toBe("Joburg");
  });

  it("preserves internal whitespace, punctuation, capitalization, and null footer", () => {
    const canonical = canonicalizeMessagePackCopy({
      copySchemaVersion: "v2.1",
      headline: "Fast, Reliable Payouts!",
      subheadline: "For  operations   managers.",
      benefitBulletsOrdered: ["Save  2 hours/day.", "Audit-ready records.", "No surprises."],
      cta: "Learn More",
    });

    expect(canonical.headline).toBe("Fast, Reliable Payouts!");
    expect(canonical.subheadline).toBe("For  operations   managers.");
    expect(canonical.footer).toBeNull();
  });

  it("isolates from caller object mutation", () => {
    const input = {
      copySchemaVersion: "v2.1",
      headline: "Hello",
      subheadline: "Sub",
      benefitBulletsOrdered: ["one", "two", "three"],
      cta: "Learn More",
      footer: { email: "a@test.com" },
    };

    const canonical = canonicalizeMessagePackCopy(input);
    input.headline = "Mutated";
    input.benefitBulletsOrdered[0] = "mutated";

    expect(canonical.headline).toBe("Hello");
    expect(canonical.benefitBulletsOrdered[0]).toBe("one");
  });
});
