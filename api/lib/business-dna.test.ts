import { describe, expect, it } from "vitest";
import {
  buildBusinessDNASnapshot,
  type BuildBusinessDNASnapshotInput,
} from "./business-dna";
import { buildLegacyShadowContextProjection } from "./creative/message-approval/integration/legacy-shadow-context";

const CAPTURED_AT = "2026-07-01T08:00:00.000Z";

const representativeBusiness = {
  id: 30,
  name: "NatForge Ops",
  industry: "Financial Operations",
  productOrService: "Payout automation",
  websiteEvidence: {
    productsServices: ["supplier disbursements", "reconciliation dashboard"],
    targetCustomers: ["operations managers"],
    location: "Johannesburg",
  },
  targetCustomer: "operations managers",
};

const representativeCampaign = {
  id: 30,
  name: "Campaign 30",
  goal: "Increase qualified demo demand",
  primaryOutcome: "consideration",
  targetBuyer: "operations managers",
  offerDetails: "Book a walkthrough",
  preferredCta: "Awareness: Learn More\nConversion: Get Started",
  productOrService: "Supplier disbursements",
  mainPainPoint: "Manual reconciliation",
  excludedOffers: ["guaranteed results"],
  keyOutcomes: ["faster settlements"],
};

const representativeValidation = {
  businessName: "NatForge Ops",
  industry: "Financial Operations",
  productOrService: "Payout automation",
  targetCustomer: "operations managers",
  mainPainPoint: "Manual reconciliation",
  campaignObjective: "consideration",
  funnelStage: "awareness",
  preferredCta: "Awareness: Learn More\nConversion: Get Started",
};

function buildRepresentativeSnapshot(capturedAtIso: string = CAPTURED_AT) {
  return buildBusinessDNASnapshot({
    business: representativeBusiness,
    campaignSignals: representativeCampaign,
    validationSignals: representativeValidation,
    capturedAtIso,
  });
}

describe("buildBusinessDNASnapshot", () => {
  it("produces a deterministic hash for semantically identical input", () => {
    const a = buildRepresentativeSnapshot();
    const b = buildBusinessDNASnapshot({
      business: { ...representativeBusiness },
      campaignSignals: { ...representativeCampaign },
      validationSignals: { ...representativeValidation },
      capturedAtIso: CAPTURED_AT,
    });

    expect(a.evidenceHashSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(a.evidenceHashSha256).toBe(b.evidenceHashSha256);
    expect(a).toEqual(b);
  });

  it("normalizes source fields before hashing", () => {
    const snapshot = buildRepresentativeSnapshot();
    expect(snapshot.businessName).toBe("NatForge Ops");
    expect(snapshot.productsAndServices).toEqual([
      "supplier disbursements",
      "reconciliation dashboard",
      "Payout automation",
    ]);
    expect(snapshot.targetCustomerSegments).toEqual(["operations managers"]);
    expect(snapshot.supportedOutcomes).toEqual([
      "faster settlements",
      "Increase qualified demo demand",
      "consideration",
    ]);

    const noisy = buildBusinessDNASnapshot({
      business: {
        id: 30,
        name: "  NatForge Ops  ",
        industry: "Financial Operations",
        productOrService: "  Payout automation ",
        websiteEvidence: {
          productsServices: [
            " supplier disbursements ",
            "",
            null,
            42,
            "reconciliation dashboard",
            "supplier disbursements",
          ],
          targetCustomers: [" operations managers ", "operations managers"],
          location: " Johannesburg ",
        },
        targetCustomer: "operations managers",
      },
      campaignSignals: {
        ...representativeCampaign,
        keyOutcomes: [" faster settlements ", ""],
      },
      validationSignals: representativeValidation,
      capturedAtIso: CAPTURED_AT,
    });

    expect(noisy).toEqual(snapshot);
    expect(noisy.evidenceHashSha256).toBe(snapshot.evidenceHashSha256);
  });

  it("derives the same snapshot identity from the same input", () => {
    const a = buildRepresentativeSnapshot();
    const b = buildRepresentativeSnapshot();

    expect(a.snapshotId).toBe(b.snapshotId);
    expect(a.snapshotId).toBe(`shadow-bdna-30-${a.evidenceHashSha256.slice(0, 16)}`);
    expect(a.snapshotId).toMatch(/^shadow-bdna-30-[a-f0-9]{16}$/);
  });

  it("changes hash and snapshot identity when material evidence changes", () => {
    const a = buildRepresentativeSnapshot();
    const b = buildBusinessDNASnapshot({
      business: {
        ...representativeBusiness,
        websiteEvidence: {
          ...representativeBusiness.websiteEvidence,
          productsServices: ["supplier disbursements", "collections workflow"],
        },
      },
      campaignSignals: representativeCampaign,
      validationSignals: representativeValidation,
      capturedAtIso: CAPTURED_AT,
    });

    expect(b.evidenceHashSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(b.evidenceHashSha256).not.toBe(a.evidenceHashSha256);
    expect(b.snapshotId).not.toBe(a.snapshotId);
  });

  it("does not invent unsupported or missing facts", () => {
    const snapshot = buildBusinessDNASnapshot({
      business: {},
      capturedAtIso: CAPTURED_AT,
    });

    expect(snapshot.businessId).toBe(0);
    expect(snapshot.businessName).toBe("");
    expect(snapshot.industry).toBe("");
    expect(snapshot.primaryOffering).toBe("");
    expect(snapshot.productsAndServices).toEqual([]);
    expect(snapshot.verifiedUseCases).toEqual([]);
    expect(snapshot.targetCustomerSegments).toEqual([]);
    expect(snapshot.customerPainPoints).toEqual([]);
    expect(snapshot.supportedOutcomes).toEqual([]);
    expect(snapshot.capabilities).toEqual([]);
    expect(snapshot.approvedClaims).toEqual([]);
    expect(snapshot.prohibitedClaims).toEqual([]);
    expect(snapshot.brandLanguageConstraints).toEqual([]);
    expect(snapshot.evidenceReferences).toEqual([]);
    expect(snapshot.evidenceHashSha256).toMatch(/^[a-f0-9]{64}$/);

    const serialized = JSON.stringify(snapshot).toLowerCase();
    expect(serialized).not.toContain("unknown");
    expect(serialized).not.toContain("placeholder");
    expect(serialized).not.toContain("shadow-observation");
  });

  it("keeps capturedAtIso out of the evidence hash and snapshot identity", () => {
    const a = buildRepresentativeSnapshot(CAPTURED_AT);
    const b = buildRepresentativeSnapshot("2027-01-15T12:30:00.000Z");

    expect(a.capturedAtIso).toBe(CAPTURED_AT);
    expect(b.capturedAtIso).toBe("2027-01-15T12:30:00.000Z");
    expect(a.evidenceHashSha256).toBe(b.evidenceHashSha256);
    expect(a.snapshotId).toBe(b.snapshotId);
  });

  it("requires an explicit valid capturedAtIso from the caller", () => {
    expect(() =>
      buildBusinessDNASnapshot({ business: {} } as BuildBusinessDNASnapshotInput)
    ).toThrow(/capturedAtIso/);
    expect(() =>
      buildBusinessDNASnapshot({ business: {}, capturedAtIso: "not-a-date" })
    ).toThrow(/capturedAtIso/);
  });

  it("matches the legacy Creative shadow projection for representative input", () => {
    const canonical = buildRepresentativeSnapshot("1970-01-01T00:00:00.000Z");
    const legacy = buildLegacyShadowContextProjection({
      campaignId: 30,
      business: representativeBusiness,
      campaign: representativeCampaign,
      validationContext: representativeValidation,
    });

    expect(canonical).toEqual(legacy.businessDna);
  });
});
