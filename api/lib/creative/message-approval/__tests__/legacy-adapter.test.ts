import { describe, expect, it } from "vitest";
import { adaptLegacyMessagePack } from "../legacy-adapter";
import type { CampaignMessagePack } from "../../campaign-message-architect";

function buildLegacy(overrides?: Partial<CampaignMessagePack>): CampaignMessagePack {
  return {
    headline: "Reduce payout delays for operations managers",
    subheadline: "Automate supplier disbursements and manual reconciliation workflows.",
    benefitBullets: [
      "Payout automation cuts manual reconciliation by 2 hours per day.",
      "Supplier settlement tracking keeps audit records clear.",
      "Restaurant team payouts process faster with automated disbursements.",
    ],
    cta: "Learn More",
    footerContact: {
      phone: null as any,
      whatsapp: null as any,
      email: "team@natforgeops.test",
      website: "natforgeops.test",
      location: "Johannesburg",
    },
    proofPoints: [],
    platformCaptions: [],
    validation: {
      passed: true,
      score: 100,
      rejections: [],
      warnings: [],
    },
    ...overrides,
  };
}

describe("adaptLegacyMessagePack", () => {
  it("ignores stale generic/validation diagnostics for approval semantics and preserves diagnostics", () => {
    const legacy = buildLegacy({
      messagePackSource: "ai_refined_pack",
      isGeneric: true,
      validation: {
        passed: false,
        score: 5,
        rejections: ["generic"],
        warnings: [],
      },
    });

    const candidate = adaptLegacyMessagePack({
      campaignId: 30,
      candidateId: "cand-legacy-1",
      createdAtIso: "2026-07-01T08:00:00.000Z",
      businessDnaSnapshotId: "biz-1",
      campaignStrategySnapshotId: "strat-1",
      qualityPolicyId: "policy-1",
      qualityPolicyVersion: 1,
      legacyPack: legacy,
    });

    expect(candidate.source).toBe("ai_refined");
    expect(candidate.provenance.diagnostics.legacyIsGeneric).toBe(true);
    expect(candidate.provenance.diagnostics.legacyValidationPassed).toBe(false);
    expect(candidate.provenance.diagnostics.legacyValidationScore).toBe(5);
    expect(candidate.provenance.adaptedFromLegacy).toBe(true);
  });

  it("preserves source mapping and does not mutate input pack", () => {
    const legacy = buildLegacy({ messagePackSource: "fallback_deterministic" });
    const originalHeadline = legacy.headline;

    const candidate = adaptLegacyMessagePack({
      campaignId: 30,
      candidateId: "cand-legacy-2",
      createdAtIso: "2026-07-01T08:00:00.000Z",
      businessDnaSnapshotId: "biz-1",
      campaignStrategySnapshotId: "strat-1",
      qualityPolicyId: "policy-1",
      qualityPolicyVersion: 1,
      legacyPack: legacy,
    });

    expect(candidate.source).toBe("deterministic_fallback");
    expect(legacy.headline).toBe(originalHeadline);
  });

  it("orders known platform map entries by canonical platform order", () => {
    const legacy = buildLegacy({
      platformCaptions: {
        LinkedIn: { caption: "B", cta: "Learn More", hashtags: ["#b"] },
        Instagram: { caption: "A", cta: "Learn More", hashtags: ["#a"] },
      } as any,
    });

    const candidate = adaptLegacyMessagePack({
      campaignId: 30,
      candidateId: "cand-legacy-map-1",
      createdAtIso: "2026-07-01T08:00:00.000Z",
      businessDnaSnapshotId: "biz-1",
      campaignStrategySnapshotId: "strat-1",
      qualityPolicyId: "policy-1",
      qualityPolicyVersion: 1,
      legacyPack: legacy,
    });

    expect(candidate.copy.platformCaptionsOrdered.map((item) => item.platform)).toEqual(["Instagram", "LinkedIn"]);
  });

  it("orders unknown platforms lexically after known platforms", () => {
    const legacy = buildLegacy({
      platformCaptions: {
        ZebraNet: { caption: "Z", cta: "Learn More", hashtags: ["#z"] },
        LinkedIn: { caption: "L", cta: "Learn More", hashtags: ["#l"] },
        AlphaWire: { caption: "A", cta: "Learn More", hashtags: ["#a"] },
      } as any,
    });

    const candidate = adaptLegacyMessagePack({
      campaignId: 30,
      candidateId: "cand-legacy-map-2",
      createdAtIso: "2026-07-01T08:00:00.000Z",
      businessDnaSnapshotId: "biz-1",
      campaignStrategySnapshotId: "strat-1",
      qualityPolicyId: "policy-1",
      qualityPolicyVersion: 1,
      legacyPack: legacy,
    });

    expect(candidate.copy.platformCaptionsOrdered.map((item) => item.platform)).toEqual([
      "LinkedIn",
      "AlphaWire",
      "ZebraNet",
    ]);
  });
});
