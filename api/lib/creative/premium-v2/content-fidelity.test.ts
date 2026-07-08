import { describe, it, expect } from "vitest";
import { evaluateContentFidelity, extractVisibleText } from "./content-fidelity";
import type { BusinessEvidence, CampaignEvidence } from "./curation";
import type { AICreativeBrief } from "./pipeline-types";

function makeBrief(offerLine: string | null): AICreativeBrief {
  return {
    angle: "Fresh clean home",
    headline: "Spotless Home, Zero Stress",
    subheadline: "Professional cleaning you can trust.",
    primaryServices: [{ name: "Home Cleaning", description: "Top to bottom", isPrimary: true }],
    secondaryServices: [],
    benefits: ["Reliable", "Affordable"],
    cta: "Book Now",
    offerLine,
  };
}

const business: BusinessEvidence = {
  displayName: "Test Business",
  name: "Test Business",
  industry: "Services",
  productOrService: "Cleaning",
};

describe("evaluateContentFidelity", () => {
  it("returns contentFidelityPassed=true when no offer is expected and no promo language is rendered", () => {
    const campaign: CampaignEvidence = {};
    const html = "<div>Spotless Home, Zero Stress</div><div>Book Now</div>";
    const result = evaluateContentFidelity(business, campaign, makeBrief(null), html);
    expect(result.offerExpected).toBe(false);
    expect(result.offerRendered).toBe(false);
    expect(result.inventedOfferDetected).toBe(false);
    expect(result.contentFidelityPassed).toBe(true);
  });

  it("flags invented 10% off when no offer is provided", () => {
    const campaign: CampaignEvidence = {};
    const html = "<div>Get 10% off your first order!</div><div>Book Now</div>";
    const result = evaluateContentFidelity(business, campaign, makeBrief("Get 10% off your first order!"), html);
    expect(result.offerExpected).toBe(false);
    expect(result.inventedOfferDetected).toBe(true);
    expect(result.contentFidelityPassed).toBe(false);
    expect(result.detectedOfferSnippet).toMatch(/10% off/i);
  });

  it("flags invented 'exclusive offers' when no offer is provided", () => {
    const campaign: CampaignEvidence = {};
    const html = "<div>Join us for exclusive offers</div><div>Book Now</div>";
    const result = evaluateContentFidelity(business, campaign, makeBrief("exclusive offers"), html);
    expect(result.inventedOfferDetected).toBe(true);
    expect(result.contentFidelityPassed).toBe(false);
  });

  it("flags invented 'free' when no offer is provided", () => {
    const campaign: CampaignEvidence = {};
    const html = "<div>Get a free consultation</div><div>Book Now</div>";
    const result = evaluateContentFidelity(business, campaign, makeBrief("free consultation"), html);
    expect(result.inventedOfferDetected).toBe(true);
    expect(result.contentFidelityPassed).toBe(false);
  });

  it("flags invented 'special discount' when no offer is provided", () => {
    const campaign: CampaignEvidence = {};
    const html = "<div>Special discount available</div><div>Book Now</div>";
    const result = evaluateContentFidelity(business, campaign, makeBrief("special discount"), html);
    expect(result.inventedOfferDetected).toBe(true);
    expect(result.contentFidelityPassed).toBe(false);
  });

  it("does not flag base64, CSS, or random alphanumeric fragments as invented offers", () => {
    const campaign: CampaignEvidence = {};
    const html = `
      <style>.cls-r43 { color: red; }</style>
      <div style="background: url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)">
        Professional cleaning you can trust.
      </div>
      <div>Contact Us Today</div>
    `;
    const result = evaluateContentFidelity(business, campaign, makeBrief(null), html);
    expect(result.inventedOfferDetected).toBe(false);
    expect(result.contentFidelityPassed).toBe(true);
    expect(result.visibleRenderedText).toContain("Professional cleaning you can trust");
    expect(result.visibleRenderedText).not.toContain("r43");
    expect(result.detectedOfferSnippet).toBeNull();
  });

  it("does not flag an approved campaign offer that matches the rendered text", () => {
    const campaign: CampaignEvidence = { offerDetails: "10% off your first order" };
    const html = "<div>10% off your first order</div><div>Book Now</div>";
    const result = evaluateContentFidelity(business, campaign, makeBrief("10% off your first order"), html);
    expect(result.offerExpected).toBe(true);
    expect(result.offerSource).toBe("campaign");
    expect(result.offerRendered).toBe(true);
    expect(result.inventedOfferDetected).toBe(false);
    expect(result.contentFidelityPassed).toBe(true);
  });

  it("flags stronger promotional language than the approved offer", () => {
    const campaign: CampaignEvidence = { offerDetails: "10% off your first order" };
    const html = "<div>20% off plus free delivery</div><div>Book Now</div>";
    const result = evaluateContentFidelity(business, campaign, makeBrief("20% off plus free delivery"), html);
    expect(result.offerExpected).toBe(true);
    expect(result.inventedOfferDetected).toBe(true);
    expect(result.contentFidelityPassed).toBe(false);
  });

  it("ignores non-promotional percentages like '100%'", () => {
    const campaign: CampaignEvidence = {};
    const html = "<div>100% reliable service</div><div>Book Now</div>";
    const result = evaluateContentFidelity(business, campaign, makeBrief(null), html);
    expect(result.inventedOfferDetected).toBe(false);
    expect(result.contentFidelityPassed).toBe(true);
  });

  it.each([
    { category: "restaurant", productOrService: "Burgers and shakes", cta: "Order Now" },
    { category: "retail", productOrService: "Handmade jewellery", cta: "Shop Now" },
    { category: "beauty", productOrService: "Hair styling", cta: "Book Now" },
    { category: "professional_services", productOrService: "Legal consulting", cta: "Request a Quote" },
    { category: "print_courier", productOrService: "Business cards and flyers", cta: "Get a Quote" },
  ])("flags invented offers for $category businesses", ({ category, productOrService, cta }) => {
    const categoryBusiness: BusinessEvidence = {
      displayName: `${category} Business`,
      name: `${category} Business`,
      industry: category,
      productOrService,
    };
    const categoryBrief = { ...makeBrief(null), cta, primaryServices: [{ name: productOrService, description: "Great service", isPrimary: true }] };
    const html = `<div>${productOrService}</div><div>Get 15% off today only!</div><div>${cta}</div>`;
    const result = evaluateContentFidelity(categoryBusiness, {}, categoryBrief, html);
    expect(result.inventedOfferDetected).toBe(true);
    expect(result.contentFidelityPassed).toBe(false);
  });

  it.each([
    { category: "restaurant", productOrService: "Burgers and shakes", cta: "Order Now" },
    { category: "retail", productOrService: "Handmade jewellery", cta: "Shop Now" },
    { category: "beauty", productOrService: "Hair styling", cta: "Book Now" },
    { category: "professional_services", productOrService: "Legal consulting", cta: "Request a Quote" },
    { category: "print_courier", productOrService: "Business cards and flyers", cta: "Get a Quote" },
  ])("passes content fidelity for $category businesses with no offer and generic CTA", ({ category, productOrService, cta }) => {
    const categoryBusiness: BusinessEvidence = {
      displayName: `${category} Business`,
      name: `${category} Business`,
      industry: category,
      productOrService,
    };
    const categoryBrief = { ...makeBrief(null), cta, primaryServices: [{ name: productOrService, description: "Great service", isPrimary: true }] };
    const html = `<div>${productOrService}</div><div>${cta}</div>`;
    const result = evaluateContentFidelity(categoryBusiness, {}, categoryBrief, html);
    expect(result.inventedOfferDetected).toBe(false);
    expect(result.contentFidelityPassed).toBe(true);
  });
});
