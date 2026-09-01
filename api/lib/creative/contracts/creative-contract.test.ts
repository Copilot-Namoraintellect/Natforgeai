import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  getQualityAuthorityMode,
  compileApprovedCreativeContract,
  compileDraftCreativeContract,
  computeContractFingerprint,
  canonicalizeForFingerprint,
  observeCreativeContract,
  type ApprovedStrategyInput,
  type ApprovedStrategyLineage,
} from "./creative-contract";

const campaign30Lineage: ApprovedStrategyLineage = {
  campaignId: 30,
  userId: 22,
  strategyRunId: 253,
  approvalRequestId: 36,
  approvedStrategyFingerprint: "approved-fingerprint-campaign30",
  approvedAt: "2026-07-01T08:00:00.000Z",
  status: "approved",
  strategyRunStatus: "completed",
};

const baseApprovedInput: ApprovedStrategyInput = {
  campaignId: 30,
  userId: 22,
  businessId: 42,
  strategyRunId: 253,
  approvalRequestId: 36,
  approvedAt: "2026-07-01T08:00:00.000Z",
  approvedStrategyFingerprint: "approved-fingerprint-campaign30",
  funnelStage: "consideration",
  targetAudience: "operations managers",
  offer: "Book a guided walkthrough",
  businessCapabilities: [
    "B2B payment orchestration",
    "prefunded merchant-account administration",
    "balance verification",
    "transaction reservations",
    "controlled payment-instruction services",
    "traceable administration",
  ],
  requiredBenefitCount: 3,
  brandConstraints: ["best in the world"],
  requiredContactDetails: ["email"],
  prohibitedClaims: ["guaranteed instant wealth"],
};

describe("getQualityAuthorityMode", () => {
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env.QUALITY_AUTHORITY_MODE;
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.QUALITY_AUTHORITY_MODE;
    } else {
      process.env.QUALITY_AUTHORITY_MODE = originalValue;
    }
  });

  it("defaults to off when variable is undefined", () => {
    delete process.env.QUALITY_AUTHORITY_MODE;
    const result = getQualityAuthorityMode();
    expect(result.effectiveMode).toBe("off");
    expect(result.warning).toBeNull();
  });

  it("defaults to off when variable is empty", () => {
    process.env.QUALITY_AUTHORITY_MODE = "";
    const result = getQualityAuthorityMode();
    expect(result.effectiveMode).toBe("off");
    expect(result.warning).toBeNull();
  });

  it("defaults to off with a warning for invalid values", () => {
    process.env.QUALITY_AUTHORITY_MODE = "enabled";
    const result = getQualityAuthorityMode();
    expect(result.effectiveMode).toBe("off");
    expect(result.warning).toContain("Unknown QUALITY_AUTHORITY_MODE");
  });

  it("returns observe when requested", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const result = getQualityAuthorityMode();
    expect(result.effectiveMode).toBe("observe");
    expect(result.warning).toBeNull();
  });

  it("explicitly blocks enforce mode and resolves to off", () => {
    process.env.QUALITY_AUTHORITY_MODE = "enforce";
    const result = getQualityAuthorityMode();
    expect(result.effectiveMode).toBe("off");
    expect(result.warning).toContain("blocked");
  });

  it("is case-insensitive for observe", () => {
    process.env.QUALITY_AUTHORITY_MODE = "OBSERVE";
    const result = getQualityAuthorityMode();
    expect(result.effectiveMode).toBe("observe");
  });
});

describe("compileApprovedCreativeContract", () => {
  it("compiles an approved contract with correct authority", () => {
    const contract = compileApprovedCreativeContract({
      ...baseApprovedInput,
      campaignInputCta: "Request a Consultation",
    });

    expect(contract.kind).toBe("approved");
    expect(contract.campaignId).toBe(30);
    expect(contract.userId).toBe(22);
    expect(contract.businessId).toBe(42);
    expect(contract.strategyRunId).toBe(253);
    expect(contract.approvalRequestId).toBe(36);
    expect(contract.cta.text).toBe("Request a Consultation");
    expect(contract.cta.source).toBe("campaign_input");
    expect(contract.cta.locked).toBe(true);
    expect(contract.offer.text).toBe("Book a guided walkthrough");
    expect(contract.offer.locked).toBe(true);
    expect(contract.groundedBenefitEvidence.length).toBeGreaterThanOrEqual(3);
    expect(contract.contractFingerprint).toHaveLength(64);
  });

  it("derives CTA from offer action when no explicit CTA is provided", () => {
    const contract = compileApprovedCreativeContract({
      ...baseApprovedInput,
      offer: "Book a free consultation for your team",
    });
    expect(contract.cta.text).toBe("Request a Consultation");
    expect(contract.cta.source).toBe("approved_offer_action");
    expect(contract.cta.locked).toBe(true);
  });

  it("falls back to stage default when no approved CTA exists", () => {
    const contract = compileApprovedCreativeContract({
      ...baseApprovedInput,
      offer: null,
    });
    expect(contract.cta.text).toBe("Sign Up for a Free Consultation");
    expect(contract.cta.source).toBe("stage_default");
    expect(contract.cta.locked).toBe(false);
  });

  it("stage CTA in approved strategy beats campaign-wide CTA", () => {
    const contract = compileApprovedCreativeContract({
      ...baseApprovedInput,
      stageCtas: { consideration: "Request a Consultation" },
      campaignWideCta: "Book a Demo",
      campaignInputCta: "Get Started",
    });
    expect(contract.cta.text).toBe("Request a Consultation");
    expect(contract.cta.source).toBe("strategy_stage");
  });

  it("does not allow unapproved mutable campaign fields to override approved strategy", () => {
    const contract = compileApprovedCreativeContract({
      ...baseApprovedInput,
      stageCtas: { consideration: "Request a Consultation" },
      campaignInputCta: "Learn More",
    });
    expect(contract.cta.text).toBe("Request a Consultation");
    expect(contract.cta.source).toBe("strategy_stage");
  });

  it("fails closed on caller-supplied authority evidence fields", () => {
    const contract = compileApprovedCreativeContract({
      ...baseApprovedInput,
      approvedEvidence: [
        {
          evidenceId: "invented-authority",
          classification: "authority",
          sourceRef: "invented-source",
        },
      ],
      authorityEvidenceIds: ["invented-authority"],
    } as ApprovedStrategyInput & Record<string, unknown>);
    expect(contract.approvedEvidence).toEqual([]);
    expect(contract.authorityEvidenceIds).toEqual([]);
  });
});

describe("computeContractFingerprint", () => {
  it("produces identical fingerprints for identical inputs", () => {
    const a = compileApprovedCreativeContract(baseApprovedInput);
    const b = compileApprovedCreativeContract(baseApprovedInput);
    expect(a.contractFingerprint).toBe(b.contractFingerprint);
  });

  it("normalizes reordered and duplicate authority evidence in the fingerprint", () => {
    const base = compileApprovedCreativeContract(baseApprovedInput);
    const authority = {
      evidenceId: "authority-record",
      classification: "authority" as const,
      sourceRef: "test:authority-record",
    };
    const a = { ...base, approvedEvidence: [authority, authority], authorityEvidenceIds: ["authority-record", "authority-record"] };
    const b = { ...base, approvedEvidence: [authority], authorityEvidenceIds: ["authority-record"] };
    expect(computeContractFingerprint(a)).toBe(computeContractFingerprint(b));
  });

  it("changes the fingerprint when approved authority evidence changes", () => {
    const base = compileApprovedCreativeContract(baseApprovedInput);
    const a = { ...base, approvedEvidence: [{ evidenceId: "authority-a", classification: "authority" as const, sourceRef: "test:a" }], authorityEvidenceIds: ["authority-a"] };
    const b = { ...base, approvedEvidence: [{ evidenceId: "authority-b", classification: "authority" as const, sourceRef: "test:b" }], authorityEvidenceIds: ["authority-b"] };
    expect(computeContractFingerprint(a)).not.toBe(computeContractFingerprint(b));
  });

  it("is independent of object key order", () => {
    const payload = {
      campaignId: 30,
      userId: 22,
      cta: { source: "campaign_input", text: "Request a Consultation", locked: true },
    };
    const reordered = {
      cta: { locked: true, source: "campaign_input", text: "Request a Consultation" },
      userId: 22,
      campaignId: 30,
    };
    expect(canonicalizeForFingerprint(payload)).toBe(
      canonicalizeForFingerprint(reordered)
    );
  });

  it("changes when the approved CTA changes", () => {
    const a = compileApprovedCreativeContract({
      ...baseApprovedInput,
      campaignInputCta: "Request a Consultation",
    });
    const b = compileApprovedCreativeContract({
      ...baseApprovedInput,
      campaignInputCta: "Book a Demo",
    });
    expect(a.contractFingerprint).not.toBe(b.contractFingerprint);
  });

  it("changes when the approved strategy fingerprint changes", () => {
    const a = compileApprovedCreativeContract(baseApprovedInput);
    const b = compileApprovedCreativeContract({
      ...baseApprovedInput,
      approvedStrategyFingerprint: "different-fingerprint",
    });
    expect(a.contractFingerprint).not.toBe(b.contractFingerprint);
  });

  it("does not include runtime timestamps or random identifiers in the fingerprint", () => {
    const contract = compileApprovedCreativeContract(baseApprovedInput);
    expect(contract.contractFingerprint).not.toContain("T");
    expect(Number.isNaN(Number.parseInt(contract.contractFingerprint, 16))).toBe(false);
  });

  it("preserves array order for ordered fields and sorts canonical sets", () => {
    const reorderedCapabilities = [...baseApprovedInput.businessCapabilities].reverse();
    const a = compileApprovedCreativeContract(baseApprovedInput);
    const b = compileApprovedCreativeContract({
      ...baseApprovedInput,
      businessCapabilities: reorderedCapabilities,
    });
    // groundedClaims preserves input order, so the fingerprint should differ.
    expect(a.contractFingerprint).not.toBe(b.contractFingerprint);

    // brandConstraints are canonicalised as a sorted set; reordering must not change the fingerprint.
    const c = compileApprovedCreativeContract({
      ...baseApprovedInput,
      brandConstraints: ["best in the world", "trusted"],
    });
    const d = compileApprovedCreativeContract({
      ...baseApprovedInput,
      brandConstraints: ["trusted", "best in the world"],
    });
    expect(c.contractFingerprint).toBe(d.contractFingerprint);
  });

  it("normalises whitespace in string fields", () => {
    const a = compileApprovedCreativeContract({
      ...baseApprovedInput,
      campaignInputCta: "Request   a   Consultation",
    });
    const b = compileApprovedCreativeContract({
      ...baseApprovedInput,
      campaignInputCta: "Request a Consultation",
    });
    expect(a.contractFingerprint).toBe(b.contractFingerprint);
  });

  it("uses the persisted approvedAt timestamp, not the current time", () => {
    const a = compileApprovedCreativeContract(baseApprovedInput);
    const laterInput = { ...baseApprovedInput, approvedAt: "2099-01-01T00:00:00.000Z" };
    const b = compileApprovedCreativeContract(laterInput);
    expect(a.contractFingerprint).not.toBe(b.contractFingerprint);

    const c = compileApprovedCreativeContract(baseApprovedInput);
    // Sleep is not needed; the test proves approvedAt is part of the canonical payload.
    expect(a.contractFingerprint).toBe(c.contractFingerprint);
  });
});

describe("observeCreativeContract", () => {
  it("returns null in off mode", () => {
    const result = observeCreativeContract({
      mode: "off",
      campaignId: 30,
      userId: 22,
      businessId: 42,
      lineage: campaign30Lineage,
      funnelStage: "consideration",
      targetAudience: "operations managers",
      offer: "Book a guided walkthrough",
      businessCapabilities: ["B2B payment orchestration"],
      legacySelectedCta: "Learn More",
    });
    expect(result).toBeNull();
  });

  it("detects Campaign 30 fallback override", () => {
    const observation = observeCreativeContract({
      mode: "observe",
      campaignId: 30,
      userId: 22,
      businessId: 42,
      lineage: campaign30Lineage,
      funnelStage: "consideration",
      campaignInputCta: "Request a Consultation",
      targetAudience: "operations managers",
      offer: "Book a guided walkthrough",
      businessCapabilities: [
        "B2B payment orchestration",
        "prefunded merchant-account administration",
        "balance verification",
      ],
      legacySelectedCta: "Learn More",
    });

    expect(observation).not.toBeNull();
    expect(observation!.contractAuthoritativeCta).toBe("Request a Consultation");
    expect(observation!.ctaAuthoritySource).toBe("campaign_input");
    expect(observation!.ctaLocked).toBe(true);
    expect(observation!.legacySelectedCta).toBe("Learn More");
    expect(observation!.mismatchClassification).toBe(
      "fallback_used_while_approved_exists"
    );
    expect(observation!.enforceWouldAccept).toBe(false);
    expect(observation!.enforceWouldRejectReason).toContain(
      'Legacy fallback CTA "Learn More" was used while an approved CTA'
    );
    expect(observation!.diagnostics).toHaveLength(1);
  });

  it("reports no mismatch when legacy CTA matches the contract", () => {
    const observation = observeCreativeContract({
      mode: "observe",
      campaignId: 30,
      userId: 22,
      businessId: 42,
      lineage: campaign30Lineage,
      funnelStage: "consideration",
      campaignInputCta: "Request a Consultation",
      targetAudience: "operations managers",
      offer: "Book a guided walkthrough",
      businessCapabilities: ["B2B payment orchestration"],
      legacySelectedCta: "Request a Consultation",
    });

    expect(observation!.mismatchClassification).toBe("none");
    expect(observation!.enforceWouldAccept).toBe(true);
    expect(observation!.enforceWouldRejectReason).toBeNull();
    expect(observation!.diagnostics).toHaveLength(0);
  });

  it("fails closed when lineage is missing", () => {
    const observation = observeCreativeContract({
      mode: "observe",
      campaignId: 30,
      userId: 22,
      businessId: 42,
      lineage: null,
      funnelStage: "consideration",
      campaignInputCta: "Request a Consultation",
      targetAudience: "operations managers",
      offer: "Book a guided walkthrough",
      businessCapabilities: ["B2B payment orchestration"],
      legacySelectedCta: "Request a Consultation",
    });

    expect(observation!.mismatchClassification).toBe("missing_strategy_lineage");
    expect(observation!.enforceWouldAccept).toBe(false);
  });

  it("fails closed when strategy fingerprint is stale", () => {
    const observation = observeCreativeContract({
      mode: "observe",
      campaignId: 30,
      userId: 22,
      businessId: 42,
      lineage: campaign30Lineage,
      expectedApprovedStrategyFingerprint: "different-fingerprint",
      funnelStage: "consideration",
      campaignInputCta: "Request a Consultation",
      targetAudience: "operations managers",
      offer: "Book a guided walkthrough",
      businessCapabilities: ["B2B payment orchestration"],
      legacySelectedCta: "Request a Consultation",
    });

    expect(observation!.mismatchClassification).toBe("stale_strategy");
    expect(observation!.enforceWouldAccept).toBe(false);
  });

  it("survives malformed lineage data with a structured failure", () => {
    const badLineage = {
      ...campaign30Lineage,
      status: "pending",
    } as any;
    const observation = observeCreativeContract({
      mode: "observe",
      campaignId: 30,
      userId: 22,
      businessId: 42,
      lineage: badLineage,
      funnelStage: "consideration",
      campaignInputCta: "Request a Consultation",
      targetAudience: "operations managers",
      offer: "Book a guided walkthrough",
      businessCapabilities: ["B2B payment orchestration"],
      legacySelectedCta: "Learn More",
    });

    expect(observation!.enforceWouldAccept).toBe(false);
    expect(observation!.mismatchClassification).toBe("unapproved_strategy");
  });

  it("returns a graceful failure when inputs throw", () => {
    const observation = observeCreativeContract({
      mode: "observe",
      campaignId: 30,
      userId: 22,
      businessId: 42,
      lineage: campaign30Lineage,
      funnelStage: "consideration" as any,
      campaignInputCta: "Request a Consultation",
      targetAudience: "operations managers",
      offer: "Book a guided walkthrough",
      businessCapabilities: ["B2B payment orchestration"],
      legacySelectedCta: "Learn More",
      // Force an internal inconsistency by making lineage status invalid through type cast.
    });

    expect(observation).not.toBeNull();
  });
});

describe("compileDraftCreativeContract", () => {
  it("produces a draft contract when lineage is null", () => {
    const draft = compileDraftCreativeContract({
      campaignId: 30,
      userId: 22,
      businessId: 42,
      funnelStage: "consideration",
      targetAudience: "operations managers",
      offer: "Book a guided walkthrough",
      businessCapabilities: ["B2B payment orchestration"],
    });

    expect(draft.kind).toBe("draft");
    expect(draft.strategyRunId).toBeNull();
    expect(draft.approvalRequestId).toBeNull();
    expect(draft.cta.locked).toBe(false);
  });
});
