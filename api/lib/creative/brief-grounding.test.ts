import { describe, expect, it } from "vitest";
import {
  computeCreativeBriefFingerprint,
  classifyBusinessType,
  buildGroundedCreativeBrief,
  isApprovedMessagePackCompatible,
  safeJoinClauses,
  buildGroundingContract,
  validateProvenance,
} from "./brief-grounding";

const campaign30Campaign = {
  id: 30,
  name: "Campaign #30",
  goal: "Increase qualified demo demand",
  productOrService: "Payout automation platform for operations teams",
  targetBuyer: "Operations managers and finance leads",
  mainPainPoint: "Manual reconciliation and payout delays",
  preferredCta: "Book a guided walkthrough",
  primaryOutcome: "More qualified demo bookings",
  targetAudience: "Operations managers, finance leads",
  coreMessage: "Reduce payout admin while improving settlement clarity",
  offerDetails: "Book a guided walkthrough",
  excludedOffers: "",
  referenceStyle: "",
  contentStyle: "professional",
};

const campaign30Business = {
  name: "NatForge Ops",
  industry: "Financial Operations",
  productOrService: "Staff and supplier payout automation",
  targetCustomer: "operations managers, finance leads",
  location: "Johannesburg",
  websiteEvidence: {
    businessCategory: "Financial Operations",
    productsServices: ["payout automation", "supplier disbursements", "reconciliation dashboard"],
    targetCustomers: ["operations managers", "finance leads"],
    location: "Johannesburg",
  },
};

const consumerCampaign = {
  id: 31,
  name: "Family Photo Shoot Promo",
  goal: "Book more weekend sessions",
  productOrService: "Family portrait photography",
  targetBuyer: "Parents and families",
  mainPainPoint: "No recent family photos",
  preferredCta: "Book a session",
  primaryOutcome: "More bookings",
  targetAudience: "Parents with young children",
  coreMessage: "Capture memories that last a lifetime",
  offerDetails: "",
  excludedOffers: "",
  referenceStyle: "",
  contentStyle: "warm",
};

const ambiguousCampaign = {
  id: 32,
  name: "Spring Campaign",
  goal: "Increase awareness",
  productOrService: "",
  targetBuyer: "",
  mainPainPoint: "",
  preferredCta: "",
  primaryOutcome: "",
  targetAudience: "",
  coreMessage: "",
  offerDetails: "",
  excludedOffers: "",
  referenceStyle: "",
  contentStyle: "",
};

describe("brief-grounding", () => {
  describe("computeCreativeBriefFingerprint", () => {
    it("produces a stable fingerprint for identical briefs", () => {
      const fp1 = computeCreativeBriefFingerprint(campaign30Campaign);
      const fp2 = computeCreativeBriefFingerprint({ ...campaign30Campaign });
      expect(fp1).toBe(fp2);
      expect(fp1).toMatch(/^[a-f0-9]{64}$/);
    });

    it("is invariant to whitespace-only changes", () => {
      const base = {
        productOrService: "Payout automation",
        targetBuyer: "Operations managers",
        mainPainPoint: "Manual reconciliation",
        preferredCta: "Book a demo",
      };
      const variant = {
        productOrService: "  Payout automation  ",
        targetBuyer: "Operations   managers",
        mainPainPoint: "Manual  reconciliation",
        preferredCta: "Book a demo",
      };
      expect(computeCreativeBriefFingerprint(base)).toBe(
        computeCreativeBriefFingerprint(variant)
      );
    });

    it("normalizes null, undefined and empty consistently", () => {
      const withNull = computeCreativeBriefFingerprint({
        productOrService: null,
        targetBuyer: "Operations managers",
      } as any);
      const withUndefined = computeCreativeBriefFingerprint({
        productOrService: undefined,
        targetBuyer: "Operations managers",
      } as any);
      const withEmpty = computeCreativeBriefFingerprint({
        productOrService: "",
        targetBuyer: "Operations managers",
      });
      expect(withNull).toBe(withUndefined);
      expect(withNull).toBe(withEmpty);
    });

    it("alters the fingerprint when punctuation changes", () => {
      const base = computeCreativeBriefFingerprint({
        ...campaign30Campaign,
        productOrService: "Payout automation",
      });
      const changed = computeCreativeBriefFingerprint({
        ...campaign30Campaign,
        productOrService: "Payout automation!",
      });
      expect(base).not.toBe(changed);
    });

    it("alters the fingerprint when case changes", () => {
      const base = computeCreativeBriefFingerprint({
        ...campaign30Campaign,
        productOrService: "Payout Automation",
      });
      const changed = computeCreativeBriefFingerprint({
        ...campaign30Campaign,
        productOrService: "payout automation",
      });
      expect(base).not.toBe(changed);
    });

    it("alters the fingerprint when wording or negation changes", () => {
      const base = computeCreativeBriefFingerprint({
        ...campaign30Campaign,
        coreMessage: "Reduce payout admin",
      });
      const negated = computeCreativeBriefFingerprint({
        ...campaign30Campaign,
        coreMessage: "Do not reduce payout admin",
      });
      const reworded = computeCreativeBriefFingerprint({
        ...campaign30Campaign,
        coreMessage: "Cut payout admin",
      });
      expect(base).not.toBe(negated);
      expect(base).not.toBe(reworded);
      expect(negated).not.toBe(reworded);
    });

    it("changes when a brief field changes", () => {
      const base = computeCreativeBriefFingerprint(campaign30Campaign);
      const changed = computeCreativeBriefFingerprint({
        ...campaign30Campaign,
        targetBuyer: "Small business owners",
      });
      expect(base).not.toBe(changed);
    });

    it("uses deterministic field order regardless of input order", () => {
      const ordered = computeCreativeBriefFingerprint({
        productOrService: "A",
        targetBuyer: "B",
        mainPainPoint: "C",
      });
      const shuffled = computeCreativeBriefFingerprint({
        mainPainPoint: "C",
        productOrService: "A",
        targetBuyer: "B",
      });
      expect(ordered).toBe(shuffled);
    });

    it("changes the fingerprint when fallback preferredPlatforms changes", () => {
      const campaignOnly = {
        ...campaign30Campaign,
        platforms: "",
      };
      const withLinkedIn = computeCreativeBriefFingerprint({
        ...campaignOnly,
        resolvedPlatforms: "LinkedIn",
      });
      const withEmail = computeCreativeBriefFingerprint({
        ...campaignOnly,
        resolvedPlatforms: "Email",
      });
      expect(withLinkedIn).not.toBe(withEmail);
    });

    it("keeps explicit campaigns.platforms precedence over fallback channels", () => {
      const brief1 = buildGroundedCreativeBrief({
        campaign: { ...campaign30Campaign, platforms: "LinkedIn" },
        business: { preferredPlatforms: "Email, WhatsApp" },
      });
      const brief2 = buildGroundedCreativeBrief({
        campaign: { ...campaign30Campaign, platforms: "LinkedIn" },
        business: { preferredPlatforms: "LinkedIn" },
      });
      // When the campaign provides explicit platforms, resolvedPlatforms is empty
      // and the fingerprint isolates the campaign brief from business-profile drift.
      expect(brief1.resolvedPlatforms).toBe("");
      expect(brief2.resolvedPlatforms).toBe("");
      expect(brief1.fingerprint).toBe(brief2.fingerprint);
    });

  });

  describe("isApprovedMessagePackCompatible", () => {
    it("rejects legacy packs without a fingerprint", () => {
      const pack = { headline: "Hello", cta: "Learn more" };
      const currentFp = computeCreativeBriefFingerprint(campaign30Campaign);
      expect(isApprovedMessagePackCompatible(pack, currentFp)).toBe(false);
    });

    it("rejects packs whose fingerprint no longer matches", () => {
      const currentFp = computeCreativeBriefFingerprint(campaign30Campaign);
      const staleFp = computeCreativeBriefFingerprint({
        ...campaign30Campaign,
        targetBuyer: "Small businesses",
      });
      const pack = { headline: "Hello", creativeBriefFingerprint: staleFp };
      expect(isApprovedMessagePackCompatible(pack, currentFp)).toBe(false);
    });

    it("accepts packs whose fingerprint matches the current brief", () => {
      const currentFp = computeCreativeBriefFingerprint(campaign30Campaign);
      const pack = { headline: "Hello", creativeBriefFingerprint: currentFp };
      expect(isApprovedMessagePackCompatible(pack, currentFp)).toBe(true);
    });
  });

  describe("classifyBusinessType", () => {
    it("Campaign #30-shaped data resolves to B2B", () => {
      const result = classifyBusinessType({
        targetBuyer: campaign30Campaign.targetBuyer,
        productOrService: campaign30Campaign.productOrService,
        businessIndustry: campaign30Business.industry,
        websiteTargetCustomers: campaign30Business.websiteEvidence.targetCustomers,
      });
      expect(result).toBe("B2B");
    });

    it("explicit classification wins over inferred evidence", () => {
      expect(
        classifyBusinessType({
          explicit: "B2C",
          targetBuyer: "Operations managers",
          productOrService: "Enterprise platform",
        })
      ).toBe("B2C");
    });

    it("consumer evidence resolves to B2C", () => {
      const result = classifyBusinessType({
        targetBuyer: consumerCampaign.targetBuyer,
        productOrService: consumerCampaign.productOrService,
      });
      expect(result).toBe("B2C");
    });

    it("does not silently default to B2C for ambiguous evidence", () => {
      const result = classifyBusinessType({
        targetBuyer: ambiguousCampaign.targetBuyer,
        productOrService: ambiguousCampaign.productOrService,
      });
      expect(result).toBe("not_specified");
    });

    it("returns mixed when B2B and B2C evidence conflict", () => {
      const result = classifyBusinessType({
        targetBuyer: "Small business owners and parents",
        productOrService: "Payroll software",
      });
      expect(result).toBe("mixed");
    });
  });

  describe("buildGroundedCreativeBrief", () => {
    it("uses current campaign values as the source of truth", () => {
      const brief = buildGroundedCreativeBrief({
        campaign: campaign30Campaign,
        business: {
          productOrService: "Stale legacy service",
          targetBuyer: "Small businesses",
        },
      });
      expect(brief.productOrService).toBe(campaign30Campaign.productOrService);
      expect(brief.targetBuyer).toBe(campaign30Campaign.targetBuyer);
      expect(brief.mainPainPoint).toBe(campaign30Campaign.mainPainPoint);
    });

    it("does not allow stale workflowContext to override the current brief", () => {
      const brief = buildGroundedCreativeBrief({
        campaign: {
          ...campaign30Campaign,
          workflowContext: {
            valueProposition: "Old small-business value proposition",
            campaignTheme: "Old theme",
          },
        },
        business: campaign30Business,
      });
      expect(brief.productOrService).toBe(campaign30Campaign.productOrService);
      expect(brief.coreMessage).toBe(campaign30Campaign.coreMessage);
      expect(brief.businessType).toBe("B2B");
    });

    it("falls back to the business profile only for missing optional context", () => {
      const brief = buildGroundedCreativeBrief({
        campaign: {
          ...campaign30Campaign,
          targetAudience: "",
          excludedOffers: "",
          contentStyle: "",
        },
        business: {
          targetAudience: "Finance teams",
          targetCustomer: "Finance leads",
          avoidWords: "guaranteed, risk-free",
          brandTone: "authoritative",
        },
      });
      expect(brief.targetAudience).toBe("Finance teams");
      expect(brief.excludedOffers).toBe("guaranteed, risk-free");
      expect(brief.contentStyle).toBe("authoritative");
      // Required campaign fields must not be overwritten by business values.
      expect(brief.productOrService).toBe(campaign30Campaign.productOrService);
      expect(brief.targetBuyer).toBe(campaign30Campaign.targetBuyer);
    });

    it("does not change the fingerprint when only business fallback changes", () => {
      const brief1 = buildGroundedCreativeBrief({
        campaign: { ...campaign30Campaign, targetAudience: "" },
        business: { targetAudience: "Finance teams" },
      });
      const brief2 = buildGroundedCreativeBrief({
        campaign: { ...campaign30Campaign, targetAudience: "" },
        business: { targetAudience: "Operations teams" },
      });
      expect(brief1.fingerprint).toBe(brief2.fingerprint);
    });

    it("campaign #30 resolves to B2B", () => {
      const brief = buildGroundedCreativeBrief({
        campaign: campaign30Campaign,
        business: campaign30Business,
      });
      expect(brief.businessType).toBe("B2B");
    });

    it("consumer evidence resolves to B2C", () => {
      const brief = buildGroundedCreativeBrief({ campaign: consumerCampaign });
      expect(brief.businessType).toBe("B2C");
    });

    it("ambiguous evidence does not default to B2C", () => {
      const brief = buildGroundedCreativeBrief({ campaign: ambiguousCampaign });
      expect(brief.businessType).toBe("not_specified");
    });

    it("never falls through to workflowContext for brief fields", () => {
      const brief = buildGroundedCreativeBrief({
        campaign: {
          ...campaign30Campaign,
          workflowContext: {
            productOrService: "Old workflowContext product",
            targetBuyer: "Old workflowContext buyer",
            mainPainPoint: "Old workflowContext pain point",
            coreMessage: "Old workflowContext message",
          },
        },
        business: {
          productOrService: "Old business product",
          targetBuyer: "Old business buyer",
        },
      });
      expect(brief.productOrService).toBe(campaign30Campaign.productOrService);
      expect(brief.targetBuyer).toBe(campaign30Campaign.targetBuyer);
      expect(brief.mainPainPoint).toBe(campaign30Campaign.mainPainPoint);
      expect(brief.coreMessage).toBe(campaign30Campaign.coreMessage);
    });

    it("non-empty campaign fields override business profile across all brief fields", () => {
      const business = {
        productOrService: "Business product",
        targetBuyer: "Business buyer",
        mainPainPoint: "Business pain",
        preferredCta: "Business CTA",
        primaryOutcome: "Business outcome",
        targetAudience: "Business audience",
        coreMessage: "Business message",
        offerDetails: "Business offer",
        excludedOffers: "Business excluded",
        referenceStyle: "Business reference",
        contentStyle: "Business style",
      };
      const brief = buildGroundedCreativeBrief({
        campaign: campaign30Campaign,
        business,
      });
      expect(brief.productOrService).toBe(campaign30Campaign.productOrService);
      expect(brief.targetBuyer).toBe(campaign30Campaign.targetBuyer);
      expect(brief.mainPainPoint).toBe(campaign30Campaign.mainPainPoint);
      expect(brief.preferredCta).toBe(campaign30Campaign.preferredCta);
      expect(brief.primaryOutcome).toBe(campaign30Campaign.primaryOutcome);
      expect(brief.targetAudience).toBe(campaign30Campaign.targetAudience);
      expect(brief.coreMessage).toBe(campaign30Campaign.coreMessage);
      expect(brief.offerDetails).toBe(campaign30Campaign.offerDetails);
      expect(brief.excludedOffers).toBe(campaign30Campaign.excludedOffers);
      expect(brief.referenceStyle).toBe(campaign30Campaign.referenceStyle);
      expect(brief.contentStyle).toBe(campaign30Campaign.contentStyle);
    });

    it("falls back to business.preferredPlatforms when campaign.platforms is empty", () => {
      const brief = buildGroundedCreativeBrief({
        campaign: { ...campaign30Campaign, platforms: "" },
        business: { preferredPlatforms: "LinkedIn, Email" },
      });
      expect(brief.platforms).toBe("LinkedIn, Email");
      expect(brief.authorisedChannels).toEqual(["linkedin", "email"]);
    });

    it("prefers campaign.platforms over business.preferredPlatforms and deduplicates", () => {
      const brief = buildGroundedCreativeBrief({
        campaign: { ...campaign30Campaign, platforms: "Email, WhatsApp" },
        business: { preferredPlatforms: "LinkedIn, email" },
      });
      expect(brief.authorisedChannels).toEqual(["email", "whatsapp"]);
    });

    it("changes the fingerprint when the business channel fallback changes", () => {
      const brief1 = buildGroundedCreativeBrief({
        campaign: { ...campaign30Campaign, platforms: "" },
        business: { preferredPlatforms: "LinkedIn" },
      });
      const brief2 = buildGroundedCreativeBrief({
        campaign: { ...campaign30Campaign, platforms: "" },
        business: { preferredPlatforms: "Email" },
      });
      expect(brief1.fingerprint).not.toBe(brief2.fingerprint);
      expect(brief1.resolvedPlatforms).toBe("LinkedIn");
      expect(brief2.resolvedPlatforms).toBe("Email");
    });

    it("keeps the fingerprint stable when unrelated business-profile fields change", () => {
      const brief1 = buildGroundedCreativeBrief({
        campaign: { ...campaign30Campaign, platforms: "" },
        business: { preferredPlatforms: "LinkedIn", industry: "Finance", location: "Johannesburg" },
      });
      const brief2 = buildGroundedCreativeBrief({
        campaign: { ...campaign30Campaign, platforms: "" },
        business: { preferredPlatforms: "LinkedIn", industry: "Technology", location: "Cape Town" },
      });
      expect(brief1.fingerprint).toBe(brief2.fingerprint);
    });
  });

  describe("safeJoinClauses", () => {
    it("joins two independent clauses without duplicating terminal punctuation", () => {
      expect(safeJoinClauses(["B2B payment orchestration for small businesses", "Intended outcome: growth"])).toBe(
        "B2B payment orchestration for small businesses. Intended outcome: growth."
      );
    });

    it("strips existing terminal punctuation before joining", () => {
      expect(safeJoinClauses(["B2B payment orchestration for small businesses.", "Intended outcome: growth."])).toBe(
        "B2B payment orchestration for small businesses. Intended outcome: growth."
      );
    });

    it("does not produce '..', '. for' or duplicate spaces inside a single clause", () => {
      expect(safeJoinClauses(["B2B payment orchestration services. for small businesses"])).toBe(
        "B2B payment orchestration services for small businesses."
      );
      expect(safeJoinClauses(["administration.."])).toBe("administration.");
    });

    it("handles semicolon, colon, multiple periods and surrounding whitespace", () => {
      expect(safeJoinClauses(["  administration;;  ", " controlled payments... "])).toBe(
        "administration. controlled payments."
      );
    });

    it("preserves internal punctuation such as colons", () => {
      expect(safeJoinClauses(["Intended outcome: Qualified merchant onboarding"])).toBe(
        "Intended outcome: Qualified merchant onboarding."
      );
    });

    it("returns empty string for empty input", () => {
      expect(safeJoinClauses([])).toBe("");
      expect(safeJoinClauses(["", "  "])).toBe("");
    });
  });

  describe("validateProvenance context-aware programme detection", () => {
    const baseBrief = buildGroundedCreativeBrief({
      campaign: {
        ...campaign30Campaign,
        platforms: "LinkedIn",
        primaryOutcome: "More qualified merchant enquiries",
        mainPainPoint:
          "Fragmented manual processes make it difficult to verify prefunded balances, reserve transaction amounts, maintain audit trails and issue controlled payment instructions.",
      },
    });

    it("does not flag 'audit trails' in the authoritative main pain point as a programme", () => {
      const contract = buildGroundingContract(baseBrief);
      const output = {
        personas: [
          {
            name: contract.targetBuyer,
            demographics: contract.targetBuyer,
            painPoints: [contract.mainPainPoint],
            goals: ["Intended outcome: more qualified merchant enquiries"],
            platforms: ["LinkedIn"],
          },
        ],
        positioning: contract.productOrService,
        valueProposition: contract.productOrService,
        coreMessage: contract.productOrService,
        campaignTheme: contract.productOrService,
        platformStrategy: [
          {
            platform: "LinkedIn",
            purpose: "Reach the authorised buyer",
            contentTypes: ["Authorised message"],
            postingFrequency: "3x per week",
          },
        ],
        funnelStages: [
          {
            stage: "awareness",
            goal: "Reach the authorised buyer",
            tactics: ["Publish the authorised message"],
            metrics: ["impressions"],
          },
        ],
        offers: [],
        ctas: [{ stage: "awareness", cta: "Book a guided walkthrough", placement: "LinkedIn" }],
        budgetRecommendation: { total: 5000, allocation: [{ channel: "LinkedIn", amount: 5000, percentage: 100 }] },
      };
      const result = validateProvenance(output as any, contract);
      expect(result.valid).toBe(true);
    });

    it("flags unauthorised 'Book an audit' as a programme", () => {
      const contract = buildGroundingContract(baseBrief);
      const result = validateProvenance(
        { cta: "Book an audit to see how we can help" } as any,
        contract
      );
      expect(result.valid).toBe(false);
      expect(result.diagnostics.some((d) => d.classification === "unauthorised_programme")).toBe(true);
    });

    it("flags unauthorised 'Free audit' as a programme", () => {
      const contract = buildGroundingContract(baseBrief);
      const result = validateProvenance({ cta: "Start your free audit" } as any, contract);
      expect(result.valid).toBe(false);
      expect(result.diagnostics.some((d) => d.classification === "unauthorised_programme")).toBe(true);
    });

    it("allows explicitly authorised audit service", () => {
      const brief = buildGroundedCreativeBrief({
        campaign: {
          ...campaign30Campaign,
          platforms: "LinkedIn",
          offerDetails: "Free audit service",
        },
      });
      const contract = buildGroundingContract(brief);
      const result = validateProvenance({ cta: "Free audit service" } as any, contract);
      expect(result.valid).toBe(true);
    });

    it("flags unauthorised newsletter subscription as a programme", () => {
      const contract = buildGroundingContract(baseBrief);
      const result = validateProvenance(
        { cta: "Subscribe to our newsletter for updates" } as any,
        contract
      );
      expect(result.valid).toBe(false);
      expect(result.diagnostics.some((d) => d.classification === "unauthorised_programme")).toBe(true);
    });

    it("allows explicitly authorised newsletter", () => {
      const brief = buildGroundedCreativeBrief({
        campaign: {
          ...campaign30Campaign,
          platforms: "Email",
          offerDetails: "Monthly newsletter subscription",
        },
      });
      const contract = buildGroundingContract(brief);
      const result = validateProvenance({ cta: "Monthly newsletter subscription" } as any, contract);
      expect(result.valid).toBe(true);
    });

    it("does not treat 'email channel' as a newsletter programme", () => {
      const brief = buildGroundedCreativeBrief({
        campaign: { ...campaign30Campaign, platforms: "Email" },
      });
      const contract = buildGroundingContract(brief);
      const result = validateProvenance({ platform: "Use the email channel" } as any, contract);
      expect(result.valid).toBe(true);
    });
  });
});
