import { describe, expect, it } from "vitest";
import {
  resolveCtaAuthority,
  detectCtaAmbiguity,
  ctasMatch,
  type ResolveCtaAuthorityInput,
} from "./cta-authority";

describe("cta-authority", () => {
  const baseInput: ResolveCtaAuthorityInput = {
    funnelStage: "consideration",
  };

  it("uses the applicable stage CTA from the approved strategy first", () => {
    const result = resolveCtaAuthority({
      ...baseInput,
      stageCtas: { consideration: "Request a Consultation" },
      campaignWideCta: "Get Started",
      campaignInputCta: "Book a Demo",
      offerActionCta: "Start Your Trial",
    });
    expect(result.text).toBe("Request a Consultation");
    expect(result.source).toBe("strategy_stage");
    expect(result.locked).toBe(true);
  });

  it("falls back to campaign-wide CTA when no stage CTA exists", () => {
    const result = resolveCtaAuthority({
      ...baseInput,
      stageCtas: { awareness: "Learn More" },
      campaignWideCta: "Request a Consultation",
      campaignInputCta: "Book a Demo",
    });
    expect(result.text).toBe("Request a Consultation");
    expect(result.source).toBe("strategy_campaign_wide");
    expect(result.locked).toBe(true);
  });

  it("falls back to campaign-input CTA when no strategy CTA exists", () => {
    const result = resolveCtaAuthority({
      ...baseInput,
      campaignInputCta: "Request a Quote",
      offerActionCta: "Start Your Trial",
    });
    expect(result.text).toBe("Request a Quote");
    expect(result.source).toBe("campaign_input");
    expect(result.locked).toBe(true);
  });

  it("falls back to approved offer action when no explicit CTA exists", () => {
    const result = resolveCtaAuthority({
      ...baseInput,
      offerActionCta: "Book a Consultation",
    });
    expect(result.text).toBe("Book a Consultation");
    expect(result.source).toBe("approved_offer_action");
    expect(result.locked).toBe(true);
  });

  it("uses deterministic stage default when no approved CTA exists", () => {
    const result = resolveCtaAuthority({ ...baseInput });
    expect(result.text).toBe("Sign Up for a Free Consultation");
    expect(result.source).toBe("stage_default");
    expect(result.locked).toBe(false);
  });

  it("uses AI-delegated default only when explicitly delegated", () => {
    const result = resolveCtaAuthority({
      ...baseInput,
      aiDelegated: true,
    });
    expect(result.text).toBe("Sign Up for a Free Consultation");
    expect(result.source).toBe("ai_delegated");
    expect(result.locked).toBe(false);
  });

  it("stage CTA wins over AI delegation", () => {
    const result = resolveCtaAuthority({
      ...baseInput,
      stageCtas: { consideration: "Request a Consultation" },
      aiDelegated: true,
    });
    expect(result.source).toBe("strategy_stage");
    expect(result.locked).toBe(true);
  });

  it("ignores whitespace-only CTAs", () => {
    const result = resolveCtaAuthority({
      ...baseInput,
      stageCtas: { consideration: "   " },
      campaignWideCta: "",
      campaignInputCta: "Request a Consultation",
    });
    expect(result.text).toBe("Request a Consultation");
    expect(result.source).toBe("campaign_input");
  });

  it("normalises ctasMatch comparisons", () => {
    expect(ctasMatch("Request a Consultation", "request a consultation")).toBe(true);
    expect(ctasMatch("Request a Consultation", "Book a Demo")).toBe(false);
  });

  it("detects ambiguous CTA authority between stage and campaign-input", () => {
    const warning = detectCtaAmbiguity({
      ...baseInput,
      stageCtas: { consideration: "Request a Consultation" },
      campaignInputCta: "Book a Demo",
    });
    expect(warning).toContain("Ambiguous CTA authority");
  });

  it("detects ambiguity between campaign-wide and offer-action", () => {
    const warning = detectCtaAmbiguity({
      ...baseInput,
      campaignWideCta: "Request a Consultation",
      offerActionCta: "Book a Demo",
    });
    expect(warning).toContain("Ambiguous CTA authority");
  });

  it("allows stage CTA to coexist with campaign-wide CTA", () => {
    const warning = detectCtaAmbiguity({
      ...baseInput,
      stageCtas: { consideration: "Request a Consultation" },
      campaignWideCta: "Get Started",
    });
    expect(warning).toBeNull();
  });

  it("allows matching stage and offer-action CTAs", () => {
    const warning = detectCtaAmbiguity({
      ...baseInput,
      stageCtas: { consideration: "Request a Consultation" },
      offerActionCta: "Request a Consultation",
    });
    expect(warning).toBeNull();
  });

  describe("six-level precedence", () => {
    it("1. applicable stage CTA beats every lower source", () => {
      const result = resolveCtaAuthority({
        funnelStage: "consideration",
        stageCtas: { consideration: "Stage CTA" },
        campaignWideCta: "Campaign Wide",
        campaignInputCta: "Campaign Input",
        offerActionCta: "Offer Action",
        aiDelegated: true,
      });
      expect(result.text).toBe("Stage CTA");
      expect(result.source).toBe("strategy_stage");
      expect(result.locked).toBe(true);
    });

    it("2. campaign-wide CTA used only when no stage CTA exists", () => {
      const result = resolveCtaAuthority({
        funnelStage: "consideration",
        stageCtas: { awareness: "Learn More" },
        campaignWideCta: "Campaign Wide",
        campaignInputCta: "Campaign Input",
        offerActionCta: "Offer Action",
      });
      expect(result.text).toBe("Campaign Wide");
      expect(result.source).toBe("strategy_campaign_wide");
      expect(result.locked).toBe(true);
    });

    it("3. campaign-input CTA used only when no strategy CTA exists", () => {
      const result = resolveCtaAuthority({
        funnelStage: "consideration",
        campaignInputCta: "Campaign Input",
        offerActionCta: "Offer Action",
      });
      expect(result.text).toBe("Campaign Input");
      expect(result.source).toBe("campaign_input");
      expect(result.locked).toBe(true);
    });

    it("4. offer-action CTA used only when no higher approved CTA exists", () => {
      const result = resolveCtaAuthority({
        funnelStage: "consideration",
        offerActionCta: "Offer Action",
      });
      expect(result.text).toBe("Offer Action");
      expect(result.source).toBe("approved_offer_action");
      expect(result.locked).toBe(true);
    });

    it("5. deterministic stage default used only when no approved CTA exists", () => {
      const result = resolveCtaAuthority({
        funnelStage: "consideration",
      });
      expect(result.text).toBe("Sign Up for a Free Consultation");
      expect(result.source).toBe("stage_default");
      expect(result.locked).toBe(false);
    });

    it("6. AI-delegated default used only when delegation is explicit", () => {
      const noDelegation = resolveCtaAuthority({
        funnelStage: "consideration",
      });
      expect(noDelegation.source).toBe("stage_default");

      const delegated = resolveCtaAuthority({
        funnelStage: "consideration",
        aiDelegated: true,
      });
      expect(delegated.source).toBe("ai_delegated");
      expect(delegated.locked).toBe(false);
    });

    it("conflicting CTAs at the same authority level are reported as ambiguous", () => {
      expect(
        detectCtaAmbiguity({
          funnelStage: "consideration",
          stageCtas: { consideration: "Stage A" },
          campaignInputCta: "Input B",
        })
      ).toContain("Ambiguous");

      expect(
        detectCtaAmbiguity({
          funnelStage: "consideration",
          campaignWideCta: "Wide A",
          offerActionCta: "Offer B",
        })
      ).toContain("Ambiguous");
    });
  });
});
