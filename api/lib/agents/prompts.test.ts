import { describe, expect, it } from "vitest";
import { strategyAgentPrompt } from "./prompts";

const baseInput = {
  businessName: "Test Business",
  industry: "Fintech",
  location: "South Africa",
  productOrService: "Payout platform for small businesses",
  targetCustomer: "small businesses",
  brandTone: "professional",
  mainGoal: "Increase sign-ups",
  monthlyBudget: 5000,
  preferredPlatforms: "LinkedIn, Facebook",
  website: "https://example.com",
  websiteEvidence: {
    businessCategory: "Financial Services",
    productsServices: ["Payroll processing", "Employee payouts"],
    targetCustomers: ["small businesses"],
    location: "South Africa",
    confidence: 0.85,
    evidenceSnippets: ["Payroll made simple for small businesses."],
  },
};

describe("strategyAgentPrompt grounding precedence", () => {
  it("prefers current campaign brief over stale business/website classifications", () => {
    const prompt = strategyAgentPrompt({
      ...baseInput,
      campaignBrief: {
        name: "Restaurant Payouts Campaign",
        goal: "Increase restaurant sign-ups",
        targetBuyer: "restaurant owners",
        mainPainPoint: "Slow end-of-day cash-outs",
        productOrService: "payout platform for restaurants",
        preferredCta: "Book a Demo",
        offerDetails: "",
        excludedOffers: "payroll; employee payouts; mass disbursements",
      },
    });

    expect(prompt).toContain("Target Buyer: restaurant owners");
    expect(prompt).toContain("Main Pain Point: Slow end-of-day cash-outs");
    expect(prompt).toContain("Product/Service Being Promoted: payout platform for restaurants");
    expect(prompt).toContain("Preferred CTA: Book a Demo");
    expect(prompt).toContain("payout platform for restaurants");

    // The authoritative brief fields must use campaign values, not stale business/website values.
    expect(prompt).not.toMatch(/Target Customer:\s*small businesses/);
    expect(prompt).not.toMatch(/Target Buyer:\s*small businesses/);
    expect(prompt).not.toMatch(/Product\/Service:\s*Payout platform for small businesses/);
    expect(prompt).not.toMatch(/Product\/Service Being Promoted:\s*Payout platform for small businesses/);

    // Stale classifications are still listed in website evidence (supplementary) and excluded offers,
    // proving the prompt instructs the model not to use them as ground truth.
    expect(prompt).toContain("Payroll processing");
    expect(prompt).toContain("Employee payouts");
    expect(prompt).toContain("Do NOT use stale or conflicting audience classifications");
  });

  it("falls back to business profile only when campaign brief is missing optional context", () => {
    const prompt = strategyAgentPrompt({
      ...baseInput,
      campaignBrief: {
        name: "Generic Campaign",
        goal: "Grow awareness",
        targetBuyer: "",
        mainPainPoint: "",
        productOrService: "",
        preferredCta: "",
      },
    });

    expect(prompt).toContain("Target Buyer: small businesses");
    expect(prompt).toContain("Product/Service Being Promoted: Payout platform for small businesses");
  });

  it("states that website evidence is supplementary and cannot override the brief", () => {
    const prompt = strategyAgentPrompt({
      ...baseInput,
      campaignBrief: {
        name: "Campaign",
        goal: "Goal",
        targetBuyer: "restaurant owners",
        productOrService: "payout platform for restaurants",
      },
    });

    expect(prompt).toContain("WEBSITE EVIDENCE — USE ONLY AS SUPPLEMENTARY CONTEXT. IT MUST NEVER OVERRIDE THE CAMPAIGN BRIEF ABOVE");
    expect(prompt).toContain("THIS IS THE AUTHORITATIVE GROUND TRUTH");
    expect(prompt).toContain("Do NOT use stale or conflicting audience classifications");
  });

  it("excludes stale payroll, employee-credit and mass-disbursement context when not in the brief", () => {
    const prompt = strategyAgentPrompt({
      ...baseInput,
      campaignBrief: {
        name: "Restaurant Payouts Campaign",
        goal: "Increase restaurant sign-ups",
        targetBuyer: "restaurant owners",
        mainPainPoint: "Slow end-of-day cash-outs",
        productOrService: "payout platform for restaurants",
        preferredCta: "Book a Demo",
        excludedOffers: "payroll; employee payouts; credit access; mass disbursements",
      },
    });

    expect(prompt).toContain("payroll");
    expect(prompt).toContain("employee payouts");
    expect(prompt).toContain("credit access");
    expect(prompt).toContain("mass disbursements");
  });

  it("includes domain-independent grounding requirements that reference the brief's product/service", () => {
    const productOrService =
      "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services";
    const prompt = strategyAgentPrompt({
      ...baseInput,
      campaignBrief: {
        name: "B2B Payment Orchestration",
        goal: "Onboard qualified merchants",
        targetBuyer: "B2B finance teams and merchant operators",
        mainPainPoint: "manual balance verification and slow payment instructions",
        productOrService,
        preferredCta: "Book a Demo",
        offerDetails: "",
        excludedOffers: "free trial; discount; lending",
      },
    });

    expect(prompt).toContain("GROUNDING REQUIREMENTS");
    expect(prompt).toContain("Faithfully preserve every service-capability clause listed in the campaign brief's Product/Service Being Promoted");
    expect(prompt).toContain("offers array MUST be empty");
    expect(prompt).toContain("Use the Preferred CTA exactly");

    // The grounding block must reference the authoritative brief fields, not hard-code any business name.
    expect(prompt).toContain(`Product/Service Being Promoted: ${productOrService}`);
    expect(prompt).toContain("Target Buyer: B2B finance teams and merchant operators");
    expect(prompt).toContain("Main Pain Point: manual balance verification and slow payment instructions");
    expect(prompt).toContain("Offer (only if provided):");
    expect(prompt).toContain("What NOT to say / excluded offers: free trial; discount; lending");
    expect(prompt).not.toContain("Zuto Hub");
  });
});
