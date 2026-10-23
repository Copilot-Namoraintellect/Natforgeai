import { describe, expect, it } from "vitest";
import { evaluateStrategyEntryBusinessDnaReadiness } from "./strategy-entry-readiness";

function businessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    userId: 18,
    name: "Payout Co",
    industry: "Fintech",
    productOrService: "payout platform for restaurants",
    targetCustomer: "restaurant owners",
    targetAudience: null,
    websiteEvidence: {
      productsServices: ["same-day payouts"],
      targetCustomers: ["restaurant owners"],
      confidence: 0.9,
    },
    isActive: true,
    ...overrides,
  };
}

describe("evaluateStrategyEntryBusinessDnaReadiness", () => {
  it("is ready for a complete business profile", () => {
    const result = evaluateStrategyEntryBusinessDnaReadiness({
      campaign: { id: 42, businessId: 7 },
      business: businessRow(),
    });
    expect(result).toEqual({ ready: true });
  });

  it("is ready when website evidence fills the governed array fields", () => {
    // Mirrors materialization exactly: evidence.productsServices/targetCustomers
    // feed productsAndServices/targetCustomerSegments, while primaryOffering
    // still requires the profile's productOrService field.
    const result = evaluateStrategyEntryBusinessDnaReadiness({
      campaign: { id: 42, businessId: 7 },
      business: businessRow({
        targetCustomer: null,
        websiteEvidence: {
          businessCategory: "Fintech",
          productsServices: ["same-day payouts"],
          targetCustomers: ["restaurant owners"],
          confidence: 0.95,
        },
      }),
    });
    expect(result).toEqual({ ready: true });
  });

  it("matches materialization for an evidence-only profile: primaryOffering still gates", () => {
    const result = evaluateStrategyEntryBusinessDnaReadiness({
      campaign: { id: 42, businessId: 7 },
      business: businessRow({
        productOrService: null,
        targetCustomer: null,
        websiteEvidence: {
          businessCategory: "Fintech",
          productsServices: ["same-day payouts"],
          targetCustomers: ["restaurant owners"],
          confidence: 0.95,
        },
      }),
    });
    expect(result).toMatchObject({
      ready: false,
      missing: ["primaryOffering"],
    });
  });

  it("never gates on optional style fields", () => {
    const result = evaluateStrategyEntryBusinessDnaReadiness({
      campaign: { id: 42, businessId: 7 },
      business: businessRow({
        industry: null,
        targetAudience: null,
        tone: null,
        brandTone: null,
        brandVoiceNotes: null,
        avoidWords: null,
        websiteEvidence: null,
      }),
    });
    expect(result).toEqual({ ready: true });
  });

  it("reports an unready profile with the governed missing fields mapped", () => {
    const result = evaluateStrategyEntryBusinessDnaReadiness({
      campaign: { id: 42, businessId: 7 },
      business: businessRow({
        productOrService: null,
        targetCustomer: null,
        websiteEvidence: null,
      }),
    });

    expect(result).toMatchObject({
      ready: false,
      code: "BUSINESS_DNA_READINESS_FAILED",
      gate: "business_dna",
      missing: ["primaryOffering", "productsAndServices", "targetCustomerSegments"],
      action: { path: "/settings?tab=businesses", label: "Complete business profile" },
    });
    if (!result.ready) {
      expect(result.userMessage).toContain("primary product or service");
      expect(result.userMessage).toContain("target customer segment");
      expect(result.userMessage).toMatch(/website analysis/i);
      expect(result.userMessage).toContain("Settings → Businesses");
    }
  });

  it("flags a missing business name", () => {
    const result = evaluateStrategyEntryBusinessDnaReadiness({
      campaign: { id: 42, businessId: 7 },
      business: businessRow({ name: "   " }),
    });
    expect(result).toMatchObject({ ready: false, missing: ["businessName"] });
  });

  it("flags an invalid business id", () => {
    const result = evaluateStrategyEntryBusinessDnaReadiness({
      campaign: { id: 42, businessId: 0 },
      business: businessRow({ id: 0 }),
    });
    expect(result).toMatchObject({ ready: false, missing: ["businessId"] });
  });

  it("is deterministic across calls (no clock authority)", () => {
    const input = {
      campaign: { id: 42, businessId: 7 },
      business: businessRow({ productOrService: null, websiteEvidence: null }),
    };
    const first = evaluateStrategyEntryBusinessDnaReadiness(input);
    const second = evaluateStrategyEntryBusinessDnaReadiness(input);
    expect(second).toEqual(first);
  });
});
