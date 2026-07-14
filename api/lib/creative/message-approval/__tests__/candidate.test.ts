import { describe, expect, it } from "vitest";
import { createMessagePackCandidate } from "../candidate";
import { computeCopyHashSha256 } from "../hash";

describe("createMessagePackCandidate", () => {
  it("creates immutable candidate and excludes canonicalCopyJson", () => {
    const candidate = createMessagePackCandidate({
      candidateId: "cand-1",
      campaignId: 30,
      createdAtIso: "2026-07-01T08:00:00.000Z",
      source: "ai_refined",
      copy: {
        copySchemaVersion: "v2.1",
        headline: "Headline",
        subheadline: "Sub",
        benefitBulletsOrdered: ["one", "two", "three"],
        cta: "Learn More",
        footer: null,
      },
      businessDnaSnapshotId: "biz-1",
      campaignStrategySnapshotId: "strat-1",
      qualityPolicyId: "policy-1",
      qualityPolicyVersion: 1,
      provenance: {
        adaptedFromLegacy: false,
        originSource: "ai_refined",
        modelName: "gpt",
        diagnostics: {
          legacyIsGeneric: null,
          legacyValidationPassed: null,
          legacyValidationScore: null,
          legacyValidationRejections: [],
        },
      },
    });

    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(candidate, "canonicalCopyJson")).toBe(false);
  });

  it("isolation prevents caller mutation from changing candidate copy", () => {
    const source = {
      copySchemaVersion: "v2.1",
      headline: "Headline",
      subheadline: "Sub",
      benefitBulletsOrdered: ["one", "two", "three"],
      cta: "Learn More",
      footer: { email: "a@test.com" },
    };

    const candidate = createMessagePackCandidate({
      candidateId: "cand-2",
      campaignId: 30,
      createdAtIso: "2026-07-01T08:00:00.000Z",
      source: "ai_refined",
      copy: source,
      businessDnaSnapshotId: "biz-1",
      campaignStrategySnapshotId: "strat-1",
      qualityPolicyId: "policy-1",
      qualityPolicyVersion: 1,
      provenance: {
        adaptedFromLegacy: false,
        originSource: "ai_refined",
        modelName: null,
        diagnostics: {
          legacyIsGeneric: null,
          legacyValidationPassed: null,
          legacyValidationScore: null,
          legacyValidationRejections: [],
        },
      },
    });

    source.headline = "Mutated";
    source.benefitBulletsOrdered[0] = "mutated";

    expect(candidate.copy.headline).toBe("Headline");
    expect(candidate.copy.benefitBulletsOrdered[0]).toBe("one");
  });

  it("isolates footer from caller mutation after candidate creation", () => {
    const source = {
      copySchemaVersion: "v2.1",
      headline: "Headline",
      subheadline: "Sub",
      benefitBulletsOrdered: ["one", "two", "three"],
      cta: "Learn More",
      footer: { email: "a@test.com", phone: "+1000" },
    };

    const candidate = createMessagePackCandidate({
      candidateId: "cand-3",
      campaignId: 30,
      createdAtIso: "2026-07-01T08:00:00.000Z",
      source: "ai_refined",
      copy: source,
      businessDnaSnapshotId: "biz-1",
      campaignStrategySnapshotId: "strat-1",
      qualityPolicyId: "policy-1",
      qualityPolicyVersion: 1,
      provenance: {
        adaptedFromLegacy: false,
        originSource: "ai_refined",
        modelName: null,
        diagnostics: {
          legacyIsGeneric: null,
          legacyValidationPassed: null,
          legacyValidationScore: null,
          legacyValidationRejections: [],
        },
      },
    });

    source.footer.email = "mutated@test.com";
    source.footer.phone = "+1999";

    expect(candidate.copy.footer?.email).toBe("a@test.com");
    expect(candidate.copy.footer?.phone).toBe("+1000");
  });

  it("prevents post-construction nested mutation and preserves hash", () => {
    const candidate = createMessagePackCandidate({
      candidateId: "cand-4",
      campaignId: 30,
      createdAtIso: "2026-07-01T08:00:00.000Z",
      source: "ai_refined",
      copy: {
        copySchemaVersion: "v2.1",
        headline: "Headline",
        subheadline: "Sub",
        benefitBulletsOrdered: ["one", "two", "three"],
        cta: "Learn More",
        footer: { email: "a@test.com", phone: "+1000" },
      },
      businessDnaSnapshotId: "biz-1",
      campaignStrategySnapshotId: "strat-1",
      qualityPolicyId: "policy-1",
      qualityPolicyVersion: 1,
      provenance: {
        adaptedFromLegacy: false,
        originSource: "ai_refined",
        modelName: null,
        diagnostics: {
          legacyIsGeneric: null,
          legacyValidationPassed: null,
          legacyValidationScore: null,
          legacyValidationRejections: [],
        },
      },
    });

    const beforeHash = computeCopyHashSha256(candidate.copy);
    const beforeBenefits = [...candidate.copy.benefitBulletsOrdered];
    const beforeFooterEmail = candidate.copy.footer?.email;

    expect(() => {
      (candidate.copy.benefitBulletsOrdered as string[])[0] = "mutated";
    }).toThrow();
    expect(() => {
      (candidate.copy.footer as { email?: string }).email = "mutated@test.com";
    }).toThrow();

    const afterHash = computeCopyHashSha256(candidate.copy);
    expect(candidate.copy.benefitBulletsOrdered).toEqual(beforeBenefits);
    expect(candidate.copy.footer?.email).toBe(beforeFooterEmail);
    expect(afterHash).toBe(beforeHash);
  });
});
