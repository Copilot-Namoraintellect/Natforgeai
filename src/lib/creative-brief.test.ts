import { describe, it, expect } from "vitest";
import {
  isCreativeBriefComplete,
  validateCreativeBrief,
  trimCreativeBrief,
  prefillBriefFromCampaign,
  applyBusinessProfileToBrief,
  buildCampaignUpdatePayload,
  EMPTY_CREATIVE_BRIEF,
  CONTENT_STYLE_NONE_SENTINEL,
} from "./creative-brief";

describe("creative brief readiness", () => {
  it("returns false when any required field is missing", () => {
    expect(
      isCreativeBriefComplete({
        productOrService: "Payments",
        targetBuyer: "SMBs",
        mainPainPoint: "Manual reconciliation",
      })
    ).toBe(false);
  });

  it("returns false for whitespace-only required fields", () => {
    expect(
      isCreativeBriefComplete({
        productOrService: "Payments",
        targetBuyer: "SMBs",
        mainPainPoint: "Manual reconciliation",
        preferredCta: "   ",
      })
    ).toBe(false);
  });

  it("returns false for placeholder required fields", () => {
    expect(
      isCreativeBriefComplete({
        productOrService: "Payments",
        targetBuyer: "SMBs",
        mainPainPoint: "Manual reconciliation",
        preferredCta: "your business",
      })
    ).toBe(false);
  });

  it("returns true when all required fields are populated and not placeholders", () => {
    expect(
      isCreativeBriefComplete({
        productOrService: "B2B payment orchestration",
        targetBuyer: "delivery platforms",
        mainPainPoint: "Manual payout reconciliation",
        preferredCta: "Book a Demo",
      })
    ).toBe(true);
  });
});

describe("creative brief validation", () => {
  it("rejects empty required fields", () => {
    const { valid, errors } = validateCreativeBrief({
      productOrService: "",
      targetBuyer: "  ",
      mainPainPoint: "",
      preferredCta: "",
    });
    expect(valid).toBe(false);
    expect(errors.productOrService).toBeDefined();
    expect(errors.targetBuyer).toBeDefined();
    expect(errors.mainPainPoint).toBeDefined();
    expect(errors.preferredCta).toBeDefined();
  });

  it("rejects placeholder required fields", () => {
    const { valid, errors } = validateCreativeBrief({
      productOrService: "[your company]",
      targetBuyer: "your business",
      mainPainPoint: "N/A",
      preferredCta: "TBD",
    });
    expect(valid).toBe(false);
    expect(errors.productOrService).toContain("placeholder");
    expect(errors.targetBuyer).toContain("placeholder");
    expect(errors.mainPainPoint).toContain("placeholder");
    expect(errors.preferredCta).toContain("placeholder");
  });

  it("accepts valid required fields", () => {
    const { valid, errors } = validateCreativeBrief({
      productOrService: "B2B payment orchestration",
      targetBuyer: "delivery platforms",
      mainPainPoint: "Manual payout reconciliation",
      preferredCta: "Book a Demo",
    });
    expect(valid).toBe(true);
    expect(Object.keys(errors).length).toBe(0);
  });
});

describe("creative brief trimming", () => {
  it("trims every string field", () => {
    const trimmed = trimCreativeBrief({
      productOrService: "  Payments  ",
      targetBuyer: " SMBs ",
      preferredCta: "Book a Demo",
    });
    expect(trimmed.productOrService).toBe("Payments");
    expect(trimmed.targetBuyer).toBe("SMBs");
    expect(trimmed.preferredCta).toBe("Book a Demo");
  });
});

describe("prefillBriefFromCampaign", () => {
  it("returns empty strings for null/undefined campaign values", () => {
    const form = prefillBriefFromCampaign({
      productOrService: null,
      targetBuyer: undefined,
      preferredCta: "Book a Demo",
    });
    expect(form.productOrService).toBe("");
    expect(form.targetBuyer).toBe("");
    expect(form.preferredCta).toBe("Book a Demo");
  });

  it("returns empty form when no campaign is provided", () => {
    expect(prefillBriefFromCampaign(null)).toEqual(EMPTY_CREATIVE_BRIEF);
    expect(prefillBriefFromCampaign(undefined)).toEqual(EMPTY_CREATIVE_BRIEF);
  });
});

describe("applyBusinessProfileToBrief", () => {
  it("fills only empty campaign fields from the linked business", () => {
    const form = applyBusinessProfileToBrief(
      {
        ...EMPTY_CREATIVE_BRIEF,
        productOrService: "",
        targetBuyer: "",
        targetAudience: "existing audience",
      },
      {
        productOrService: "B2B payments",
        targetCustomer: "delivery platforms",
        targetAudience: "business audience",
      }
    );
    expect(form.productOrService).toBe("B2B payments");
    expect(form.targetBuyer).toBe("delivery platforms");
    expect(form.targetAudience).toBe("existing audience");
  });

  it("does not overwrite existing campaign values", () => {
    const form = applyBusinessProfileToBrief(
      {
        ...EMPTY_CREATIVE_BRIEF,
        productOrService: "My product",
        targetBuyer: "My buyer",
      },
      {
        productOrService: "Business product",
        targetCustomer: "Business buyer",
      }
    );
    expect(form.productOrService).toBe("My product");
    expect(form.targetBuyer).toBe("My buyer");
  });

  it("returns the original form when no business is provided", () => {
    const form = { ...EMPTY_CREATIVE_BRIEF, productOrService: "My product" };
    expect(applyBusinessProfileToBrief(form, null)).toEqual(form);
  });
});

describe("buildCampaignUpdatePayload", () => {
  it("trims all values before returning the payload", () => {
    const payload = buildCampaignUpdatePayload({
      name: " Campaign 30 ",
      productOrService: "  B2B payments  ",
      preferredCta: "Book a Demo",
    });
    expect(payload.name).toBe("Campaign 30");
    expect(payload.productOrService).toBe("B2B payments");
    expect(payload.preferredCta).toBe("Book a Demo");
  });

  it("maps the content style sentinel to an empty string", () => {
    const payload = buildCampaignUpdatePayload({
      contentStyle: CONTENT_STYLE_NONE_SENTINEL,
    });
    expect(payload.contentStyle).toBe("");
  });
});

describe("contentStyle sentinel handling", () => {
  it("initialises an empty persisted contentStyle without throwing", () => {
    const form = prefillBriefFromCampaign({ contentStyle: null });
    expect(form.contentStyle).toBe("");
  });

  it("does not treat the sentinel as a required field", () => {
    expect(
      isCreativeBriefComplete({
        productOrService: "B2B payments",
        targetBuyer: "delivery platforms",
        mainPainPoint: "Manual reconciliation",
        preferredCta: "Book a Demo",
        contentStyle: CONTENT_STYLE_NONE_SENTINEL,
      })
    ).toBe(true);
  });
});
