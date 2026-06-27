import { describe, it, expect } from "vitest";
import { formatOffer, renderOffer, normaliseOfferInText } from "./text-formatter";

describe("text-formatter", () => {
  describe("formatOffer / renderOffer", () => {
    it("formats raw Rand values", () => {
      expect(renderOffer("10% off orders above R3000")).toBe("Enjoy 10% off orders above R3,000");
      expect(renderOffer("10% off orders above R 3 000")).toBe("Enjoy 10% off orders above R3,000");
      expect(renderOffer("10% off any orders R3000 and above")).toBe("Enjoy 10% off orders above R3,000");
      expect(renderOffer("10% off orders above 3000 R")).toBe("Enjoy 10% off orders above R3,000");
      expect(renderOffer("10% off orders above 3000R")).toBe("Enjoy 10% off orders above R3,000");
      expect(renderOffer("10% off orders above 3000 rands")).toBe("Enjoy 10% off orders above R3,000");
    });

    it("preserves already-formatted offers", () => {
      expect(renderOffer("Enjoy 10% off orders above R3,000")).toBe("Enjoy 10% off orders above R3,000");
    });

    it("returns empty for missing offers", () => {
      expect(renderOffer("")).toBe("");
      expect(renderOffer("None")).toBe("");
    });
  });

  describe("normaliseOfferInText", () => {
    const rawOffer = "10% off orders above R3000";

    it("normalises offer phrases inside captions", () => {
      expect(normaliseOfferInText("Enjoy 10% off any orders R3 000 and above", rawOffer)).toBe("Enjoy 10% off orders above R3,000");
      expect(normaliseOfferInText("Enjoy 10% off any orders R3000 and above", rawOffer)).toBe("Enjoy 10% off orders above R3,000");
      expect(normaliseOfferInText("Enjoy 10% off orders over R3000", rawOffer)).toBe("Enjoy 10% off orders above R3,000");
      expect(normaliseOfferInText("Enjoy 10% off orders above R3000", rawOffer)).toBe("Enjoy 10% off orders above R3,000");
    });

    it("leaves non-offer text untouched", () => {
      expect(normaliseOfferInText("Contact us for a quote today.")).toBe("Contact us for a quote today.");
    });
  });
});
