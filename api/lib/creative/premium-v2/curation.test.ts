import { describe, it, expect } from "vitest";
import {
  inferBusinessCategory,
  inferLayoutDensity,
  inferVisualStyle,
  curateServices,
  normalizeServices,
  buildContactLines,
  resolveBrandPaletteV2,
} from "./curation";
import type { BusinessEvidence, CampaignEvidence } from "./curation";

const business: BusinessEvidence = {
  name: "Print King",
  industry: "Print and courier",
  productOrService: "Printing, copying, scanning, laminating, binding",
  websiteEvidence: {
    businessCategory: "print courier",
    productsServices: ["Business cards", "Banners", "Flyers"],
  },
  brandColors: ["#0047AB", "#FFD700"],
};

const campaign: CampaignEvidence = {
  name: "Spring print promo",
  offerDetails: "10% off all printing",
};

describe("inferBusinessCategory", () => {
  it("detects print/courier from evidence", () => {
    expect(inferBusinessCategory(business, campaign)).toBe("print_courier");
  });

  it("detects food/restaurant", () => {
    const b = { industry: "Restaurant", productOrService: "Gourmet burgers and shakes", name: "Burger Barn" };
    expect(inferBusinessCategory(b, { name: "Campaign" })).toBe("food_restaurant");
  });

  it("falls back to general", () => {
    expect(inferBusinessCategory({ name: "Mystery Co" }, { name: "Campaign" })).toBe("general");
  });
});

describe("inferLayoutDensity", () => {
  it("chooses catalogue for explicit catalogue instruction", () => {
    expect(inferLayoutDensity(business, campaign, "catalogue_layout", 4)).toBe("catalogue_brochure");
  });

  it("chooses offer_focused for sale language", () => {
    const c = { ...campaign, offerDetails: "Mega sale this weekend" };
    expect(inferLayoutDensity(business, c, undefined, 4)).toBe("offer_focused");
  });

  it("defaults to premium_services", () => {
    expect(inferLayoutDensity(business, { name: "Spring campaign" }, undefined, 4)).toBe("premium_services");
  });
});

describe("inferVisualStyle", () => {
  it("detects luxury from brand voice", () => {
    const b = { ...business, brandVoiceNotes: "luxury and elegant" };
    expect(inferVisualStyle(b, campaign)).toBe("luxury");
  });

  it("defaults to modern", () => {
    expect(inferVisualStyle(business, campaign)).toBe("modern");
  });
});

describe("curateServices", () => {
  it("caps primary services at 5 for premium_services", () => {
    const services = Array.from({ length: 9 }, (_, i) => `Service ${i + 1}`);
    const { primaryServices, secondaryServices } = curateServices(services, "premium_services");
    expect(primaryServices.length).toBe(5);
    expect(secondaryServices.length).toBe(4);
    expect(primaryServices[0].isPrimary).toBe(true);
    expect(secondaryServices[0].isPrimary).toBe(false);
  });

  it("caps primary services at 3 for minimal mode", () => {
    const services = ["A", "B", "C", "D", "E"];
    const { primaryServices, secondaryServices } = curateServices(services, "premium_minimal");
    expect(primaryServices.length).toBe(3);
    expect(secondaryServices.length).toBe(2);
  });

  it("allows more primary services in catalogue mode", () => {
    const services = Array.from({ length: 12 }, (_, i) => `Service ${i + 1}`);
    const { primaryServices } = curateServices(services, "catalogue_brochure");
    expect(primaryServices.length).toBe(8);
  });
});

describe("normalizeServices", () => {
  it("trims, dedupes, and removes trailing punctuation", () => {
    expect(normalizeServices(["  Printing  ", "Printing.", "Copying", "", "Copying"])).toEqual([
      "Printing",
      "Copying",
    ]);
  });
});

describe("buildContactLines", () => {
  it("prefers approved pack location", () => {
    const b = { ...business, location: "Old Town" };
    const lines = buildContactLines(b, { footerContact: { location: "Newmarket" } });
    expect(lines.location).toBe("Newmarket");
  });
});

describe("resolveBrandPaletteV2", () => {
  it("uses supplied brand colours and defaults for missing values", () => {
    const palette = resolveBrandPaletteV2(business);
    expect(palette.primary).toBe("#0047AB");
    expect(palette.secondary).toBe("#FFD700");
    expect(palette.accent).toBeTruthy();
    expect(palette.background).toBe("#FFFFFF");
  });
});
