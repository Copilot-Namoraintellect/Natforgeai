import { describe, it, expect } from "vitest";
import { buildPremiumV2Brief, parseRefinementMode } from "./brief";
import type { ApprovedCopyPack } from "./curation";
import { computeCreativeBriefFingerprint } from "../brief-grounding";

const baseBusiness = {
  id: 1,
  name: "Acme Corp",
  displayName: "Acme Corp",
  logo: "https://example.com/logo.png",
  industry: "Professional services",
  location: "Johannesburg",
  phone: "011 123 4567",
  email: "hello@acme.test",
  website: "https://acme.test",
  productOrService: "Tax planning, Payroll, Business advisory, Audits",
  targetCustomer: "Small business owners",
  brandColors: ["#1E3A8A", "#F59E0B", "#FFFFFF"],
  visualStyle: "modern",
};

const baseCampaign = {
  id: 10,
  name: "Spring Campaign",
  goal: "Leads",
  primaryOutcome: "Book more consultations",
  targetBuyer: "Small business owners",
  mainPainPoint: "Tax compliance is overwhelming",
  productOrService: "Tax planning, Payroll, Business advisory, Audits",
  offerDetails: "Free 30-minute consultation",
  preferredCta: "Book Now",
};

const basePost = {
  id: 100,
  campaignId: 10,
  platform: "Instagram",
  title: "Spring Promo",
  headline: "Post headline",
  hook: "Post hook",
  cta: "Post CTA",
};

const approvedPack: ApprovedCopyPack = {
  headline: "Approved headline",
  subheadline: "Approved subheadline",
  benefitBullets: ["Benefit A", "Benefit B", "Benefit C"],
  cta: "Approved CTA",
  creativeBriefFingerprint: computeCreativeBriefFingerprint(baseCampaign),
};

describe("buildPremiumV2Brief", () => {
  it("infers professional services category and corporate density", async () => {
    const brief = await buildPremiumV2Brief({
      business: baseBusiness,
      campaign: baseCampaign,
      post: basePost,
      approvedMessagePack: approvedPack,
    });
    expect(brief.businessCategory).toBe("professional_services");
    expect(brief.layoutDensity).toBe("corporate_professional");
    expect(brief.primaryServices.length).toBeGreaterThan(0);
    expect(brief.headline).toBe("Approved headline");
  });

  it("curates 'all services' into primary + secondary strip, not a catalogue by default", async () => {
    const business = {
      ...baseBusiness,
      productOrService: "A, B, C, D, E, F, G",
      websiteEvidence: { productsServices: ["H", "I", "J"] },
    };
    const brief = await buildPremiumV2Brief({ business, campaign: baseCampaign, post: basePost });
    expect(brief.layoutDensity).not.toBe("catalogue_brochure");
    expect(brief.primaryServices.length).toBeLessThanOrEqual(5);
    expect(brief.secondaryServices.length).toBeGreaterThan(0);
  });

  it("switches to catalogue layout when many services are explicitly requested", async () => {
    const brief = await buildPremiumV2Brief({
      business: baseBusiness,
      campaign: baseCampaign,
      post: basePost,
      refinementInstruction: "Show a full catalogue brochure with all services",
    });
    expect(brief.layoutDensity).toBe("catalogue_brochure");
    expect(brief.primaryServices.length).toBeGreaterThan(0);
  });

  it("preserves approved copy on a design-only refinement", async () => {
    const brief = await buildPremiumV2Brief({
      business: baseBusiness,
      campaign: baseCampaign,
      post: basePost,
      approvedMessagePack: approvedPack,
      refinementInstruction: "Make the design more premium, darker background",
    });
    expect(brief.headline).toBe("Approved headline");
    expect(brief.subheadline).toBe("Approved subheadline");
    expect(brief.cta).toBe("Approved CTA");
    expect(brief.refinementMode).toBe("design_only");
  });

  it("uses structured copy fields from approved pack", async () => {
    const brief = await buildPremiumV2Brief({
      business: baseBusiness,
      campaign: baseCampaign,
      post: basePost,
      approvedMessagePack: approvedPack,
    });
    expect(brief.headline).toBe("Approved headline");
    expect(brief.cta).toBe("Approved CTA");
    expect(brief.benefits).toContain("Benefit A");
  });

  it("parses refinement modes from natural language", async () => {
    expect(parseRefinementMode("add more services")).toBe("add_services");
    expect(parseRefinementMode("full catalogue brochure")).toBe("catalogue_layout");
    expect(parseRefinementMode("make it cleaner with fewer services")).toBe("reduce_clutter");
    expect(parseRefinementMode("stronger call to action")).toBe("stronger_cta");
  });

  it("builds a 3@1 Newmarket fixture as a print/courier business", async () => {
    const business = {
      id: 2,
      name: "3@1 Newmarket",
      displayName: "3@1 Newmarket",
      logo: "https://example.com/3at1.png",
      industry: "Print and courier",
      location: "Newmarket",
      phone: "011 123 9999",
      website: "https://3at1newmarket.test",
      productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier, Business cards, Flyers, Banners, Canvas",
      targetCustomer: "Local businesses and students",
      brandColors: ["#0047AB", "#FFD700", "#FFFFFF"],
      visualStyle: "modern",
      websiteEvidence: {
        businessCategory: "print and courier",
        productsServices: ["Printing", "Copying", "Scanning", "Laminating", "Binding", "Courier", "Business cards", "Flyers", "Banners", "Canvas"],
      },
    };
    const campaign = {
      id: 20,
      name: "Newmarket Print Promo",
      goal: "Leads",
      primaryOutcome: "Get more print orders",
      targetBuyer: "Local businesses and students",
      mainPainPoint: "Need fast, affordable printing and delivery",
      productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier",
      preferredCta: "Get a Quote",
    };
    const brief = await buildPremiumV2Brief({ business, campaign, post: { id: 200, campaignId: 20, title: "Print promo" } });

    expect(brief.businessCategory).toBe("print_courier");
    expect(brief.primaryServices.map((s) => s.name)).toContain("Business Cards & Flyers");
    expect(brief.primaryServices.length).toBeLessThanOrEqual(5);
    expect(brief.headline).toBeTruthy();
    expect(brief.cta).toBe("Get a Quote");
  });

  it("uses authoritative business record name over derived display name", async () => {
    const brief = await buildPremiumV2Brief({
      business: {
        ...baseBusiness,
        name: "Zuto Hub",
        displayName: "zurohub",
      },
      campaign: baseCampaign,
      post: basePost,
    });

    expect(brief.businessName).toBe("Zuto Hub");
  });
});
