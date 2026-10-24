import { describe, expect, it } from "vitest";
import type { BusinessDNASnapshot } from "../business-dna";
import { assessRelevanceWithContext, assessRelevanceWithoutContext } from "./relevance";

const SNAPSHOT: BusinessDNASnapshot = {
  snapshotId: "shadow-bdna-7-abc123",
  businessId: 7,
  version: 1,
  evidenceHashSha256: "a".repeat(64),
  capturedAtIso: "2026-06-01T00:00:00Z",
  businessName: "Bean There Coffee Co",
  industry: "Food & Beverage",
  primaryOffering: "artisan coffee beans",
  productsAndServices: ["cold brew concentrate", "coffee subscription boxes"],
  verifiedUseCases: [],
  targetCustomerSegments: [],
  customerPainPoints: [],
  supportedOutcomes: [],
  capabilities: [],
  approvedClaims: [],
  prohibitedClaims: [],
  brandLanguageConstraints: [],
  evidenceReferences: [],
};

describe("assessRelevanceWithContext (Business DNA snapshot, §9)", () => {
  it("full candidate presence → relevant with high confidence and token evidence", () => {
    const result = assessRelevanceWithContext(
      "Where can I buy your artisan coffee beans online?",
      SNAPSHOT
    );
    expect(result.relevance).toBe("relevant");
    expect(result.relevanceConfidence).toBe("high");
    expect(result.businessDnaSnapshotId).toBe(SNAPSHOT.snapshotId);
    expect(result.evidence).not.toBeNull();
    expect(result.evidence?.kind).toBe("business_dna");
    expect(result.evidence?.ref).toContain(SNAPSHOT.snapshotId);
    expect(result.evidence?.excerpt).toContain("coffee");
    expect(result.evidence?.excerpt?.length).toBeLessThanOrEqual(160);
  });

  it("≥2 token hits on one candidate → relevant", () => {
    const result = assessRelevanceWithContext("coffee beans look great", SNAPSHOT);
    expect(result.relevance).toBe("relevant");
    expect(result.relevanceConfidence).toBe("high");
  });

  it("a single token hit → partially_relevant with medium confidence", () => {
    const result = assessRelevanceWithContext("I really love coffee", SNAPSHOT);
    expect(result.relevance).toBe("partially_relevant");
    expect(result.relevanceConfidence).toBe("medium");
    expect(result.businessDnaSnapshotId).toBe(SNAPSHOT.snapshotId);
  });

  it("no overlap → not_relevant with high confidence and no evidence", () => {
    const result = assessRelevanceWithContext("tennis racket restringing prices please", SNAPSHOT);
    expect(result.relevance).toBe("not_relevant");
    expect(result.relevanceConfidence).toBe("high");
    expect(result.evidence).toBeNull();
    expect(result.businessDnaSnapshotId).toBe(SNAPSHOT.snapshotId);
  });

  it("ignores stopwords and short tokens", () => {
    // "the", "and" are stopwords; "is"/"a" are below the 3-char minimum.
    const result = assessRelevanceWithContext("the and is a", SNAPSHOT);
    expect(result.relevance).toBe("not_relevant");
  });
});

describe("assessRelevanceWithoutContext (§9)", () => {
  it("maps a relevant hint at medium confidence", () => {
    const result = assessRelevanceWithoutContext("relevant");
    expect(result).toEqual({
      relevance: "relevant",
      relevanceConfidence: "medium",
      evidence: { kind: "model", ref: "model_relevance_hint" },
      businessDnaSnapshotId: null,
    });
  });

  it("maps a not_relevant hint at medium confidence", () => {
    const result = assessRelevanceWithoutContext("not_relevant");
    expect(result.relevance).toBe("not_relevant");
    expect(result.relevanceConfidence).toBe("medium");
    expect(result.businessDnaSnapshotId).toBeNull();
  });

  it("maps partially_relevant / unknown hints at low confidence", () => {
    const partial = assessRelevanceWithoutContext("partially_relevant");
    expect(partial.relevance).toBe("partially_relevant");
    expect(partial.relevanceConfidence).toBe("low");
    const unknown = assessRelevanceWithoutContext("unknown");
    expect(unknown.relevance).toBe("unknown");
    expect(unknown.relevanceConfidence).toBe("low");
    expect(unknown.evidence).toBeNull();
  });

  it("honestly reports unknown with low confidence when no hint exists", () => {
    for (const hint of [undefined, null, "invented_label", 42]) {
      const result = assessRelevanceWithoutContext(hint);
      expect(result.relevance).toBe("unknown");
      expect(result.relevanceConfidence).toBe("low");
      expect(result.evidence).toBeNull();
      expect(result.businessDnaSnapshotId).toBeNull();
    }
  });
});
