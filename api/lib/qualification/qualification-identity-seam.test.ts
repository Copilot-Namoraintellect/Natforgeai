import { describe, expect, it } from "vitest";
import {
  deriveIdentityProjectionReference,
  validateIdentityProjection,
} from "./qualification-identity-seam";
import { deriveIdentityReference, type NormalizedIdentityEvidence } from "./qualification-contract";

const H64 = "ab".repeat(32);
const G64 = "cd".repeat(32);
const LEAD_ID = `lid1:${H64}`;
const CANONICAL_LEAD_ID = `lid1:${G64}`;
const OPP_ID = `opp1:${"ef".repeat(32)}`;
const HANDOFF_ID = `oph1:${"12".repeat(32)}`;
const OBSERVED = "2026-06-27T10:00:00.000Z";
const LAST_OBSERVED = "2026-06-28T10:00:00.000Z";

function projection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    leadId: LEAD_ID,
    businessId: 3,
    leadIdentityVersion: "lead-identity/v1",
    identityStatus: "active",
    identityConfidence: "high",
    primaryIdentityType: "provider_actor",
    externalActorReferenceHash: null,
    provider: "meta",
    sourceOpportunityId: OPP_ID,
    sourceHandoffId: HANDOFF_ID,
    canonicalLeadId: null,
    firstObservedAt: OBSERVED,
    lastObservedAt: LAST_OBSERVED,
    provenance: [
      {
        kind: "opportunity_handoff",
        handoffId: HANDOFF_ID,
        opportunityId: OPP_ID,
        evidenceType: "handoff",
        occurredAt: OBSERVED,
      },
    ],
    ...overrides,
  };
}

describe("validateIdentityProjection — round trip", () => {
  it("accepts a valid projection and derives the C content binding", () => {
    const evidence = validateIdentityProjection(projection());
    expect(evidence.leadId).toBe(LEAD_ID);
    expect(evidence.businessId).toBe(3);
    expect(evidence.identityStatus).toBe("active");
    expect(evidence.lastObservedAt).toBe(LAST_OBSERVED);
    expect(evidence.canonicalLeadId).toBeNull();

    const expected = deriveIdentityReference({
      leadId: LEAD_ID,
      businessId: 3,
      leadIdentityVersion: "lead-identity/v1",
      identityStatus: "active",
      identityConfidence: "high",
      primaryIdentityType: "provider_actor",
      externalActorReferenceHash: null,
      provider: "meta",
      canonicalLeadId: null,
      firstObservedAt: OBSERVED,
      lastObservedAt: LAST_OBSERVED,
      provenance: [
        {
          kind: "opportunity_handoff",
          handoffId: HANDOFF_ID,
          opportunityId: OPP_ID,
          evidenceType: "handoff",
          occurredAt: OBSERVED,
        },
      ],
    });
    expect(evidence.identityReference).toBe(expected);
  });

  it("is deterministic: identical inputs produce deep-equal evidence", () => {
    const a = validateIdentityProjection(projection());
    const b = validateIdentityProjection(projection());
    expect(a).toEqual(b);
  });

  it("carries canonicalLeadId for merged identities and null otherwise", () => {
    const merged = validateIdentityProjection(
      projection({ identityStatus: "merged", canonicalLeadId: CANONICAL_LEAD_ID })
    );
    expect(merged.canonicalLeadId).toBe(CANONICAL_LEAD_ID);
    expect(merged.identityReference).toBe(
      deriveIdentityProjectionReference({
        leadId: LEAD_ID,
        businessId: 3,
        leadIdentityVersion: "lead-identity/v1",
        identityStatus: "merged",
        identityConfidence: "high",
        primaryIdentityType: "provider_actor",
        externalActorReferenceHash: null,
        provider: "meta",
        canonicalLeadId: CANONICAL_LEAD_ID,
        firstObservedAt: OBSERVED,
        lastObservedAt: LAST_OBSERVED,
        provenance: [
          {
            kind: "opportunity_handoff",
            handoffId: HANDOFF_ID,
            opportunityId: OPP_ID,
            evidenceType: "handoff",
            occurredAt: OBSERVED,
          },
        ],
      })
    );
  });

  it("accepts every closed identity status and confidence", () => {
    for (const status of [
      "active",
      "anonymous",
      "partially_identified",
      "resolved",
      "conflicting",
      "suppressed",
      "merged",
      "archived",
    ] as const) {
      expect(validateIdentityProjection(projection({ identityStatus: status })).identityStatus).toBe(status);
    }
    for (const confidence of ["unknown", "low", "medium", "high"] as const) {
      expect(
        validateIdentityProjection(projection({ identityConfidence: confidence })).identityConfidence
      ).toBe(confidence);
    }
  });

  it("accepts the seam identity version allow-list", () => {
    const seamVersion = `lead-identity-seam/v1:${G64}`;
    const evidence = validateIdentityProjection(
      projection({ leadIdentityVersion: seamVersion })
    );
    expect(evidence.leadIdentityVersion).toBe(seamVersion);
  });
});

describe("validateIdentityProjection — corruption classes", () => {
  it("rejects non-objects", () => {
    for (const bad of [null, undefined, "lead", 42, ["leadId"]]) {
      expect(() => validateIdentityProjection(bad)).toThrowError(
        expect.objectContaining({ name: "QualificationValidationError", code: "INVALID_IDENTITY_PROJECTION" })
      );
    }
  });

  it("rejects an extra key", () => {
    expect(() => validateIdentityProjection({ ...projection(), forgedDecision: "QUALIFIED" })).toThrowError(
      expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" })
    );
  });

  it("rejects a missing key", () => {
    const { lastObservedAt: _omitted, ...incomplete } = projection();
    expect(() => validateIdentityProjection(incomplete)).toThrowError(
      expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" })
    );
  });

  it("rejects malformed anchors", () => {
    expect(() => validateIdentityProjection(projection({ leadId: "lead-42" }))).toThrowError(
      expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" })
    );
    expect(() =>
      validateIdentityProjection(projection({ sourceOpportunityId: "opp:xyz" }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" }));
    expect(() =>
      validateIdentityProjection(projection({ sourceHandoffId: null }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" }));
    expect(() =>
      validateIdentityProjection(projection({ canonicalLeadId: "lid1:not-hex" }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" }));
    expect(() =>
      validateIdentityProjection(projection({ externalActorReferenceHash: "zz".repeat(32) }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" }));
  });

  it("rejects out-of-vocabulary closed values", () => {
    expect(() =>
      validateIdentityProjection(projection({ identityStatus: "qualified" }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" }));
    expect(() =>
      validateIdentityProjection(projection({ identityConfidence: "VERY_HIGH" }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" }));
    expect(() =>
      validateIdentityProjection(projection({ primaryIdentityType: "cookie_id" }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" }));
    expect(() =>
      validateIdentityProjection(projection({ provider: "snapchat" }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" }));
  });

  it("rejects an unknown identity version with IDENTITY_VERSION_UNKNOWN", () => {
    expect(() =>
      validateIdentityProjection(projection({ leadIdentityVersion: "lead-identity/v2" }))
    ).toThrowError(
      expect.objectContaining({ name: "QualificationInputError", code: "IDENTITY_VERSION_UNKNOWN" })
    );
  });

  it("rejects bad businessId shapes", () => {
    for (const businessId of [0, -1, 2.5, "3", {}]) {
      expect(() => validateIdentityProjection(projection({ businessId }))).toThrowError(
        expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" })
      );
    }
    expect(validateIdentityProjection(projection({ businessId: null })).businessId).toBeNull();
  });

  it("rejects non-strict-UTC timestamps", () => {
    for (const lastObservedAt of ["yesterday", "2026-06-28T10:00:00+02:00", 1234567890]) {
      expect(() => validateIdentityProjection(projection({ lastObservedAt }))).toThrowError(
        expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" })
      );
    }
    expect(() =>
      validateIdentityProjection(projection({ firstObservedAt: "2026-06-28 10:00:00" }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" }));
  });

  it("rejects malformed provenance", () => {
    expect(() => validateIdentityProjection(projection({ provenance: "none" }))).toThrowError(
      expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" })
    );
    expect(() =>
      validateIdentityProjection(projection({ provenance: [{ kind: "merge", occurredAt: OBSERVED }] }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" }));
    expect(() =>
      validateIdentityProjection(
        projection({
          provenance: [
            { kind: "merge", handoffId: null, opportunityId: null, evidenceType: "x", occurredAt: OBSERVED, extra: 1 },
          ],
        })
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" }));
    expect(() =>
      validateIdentityProjection(
        projection({
          provenance: [
            { kind: "mystery", handoffId: null, opportunityId: null, evidenceType: "x", occurredAt: OBSERVED },
          ],
        })
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" }));
    expect(() =>
      validateIdentityProjection(
        projection({
          provenance: [
            { kind: "merge", handoffId: "oph1:nope", opportunityId: null, evidenceType: "x", occurredAt: OBSERVED },
          ],
        })
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" }));
    expect(() =>
      validateIdentityProjection(
        projection({
          provenance: [
            { kind: "merge", handoffId: null, opportunityId: null, evidenceType: "x", occurredAt: "later" },
          ],
        })
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY_PROJECTION" }));
  });

  it("accepts nullable provenance ids and empty provenance", () => {
    const evidence = validateIdentityProjection(
      projection({
        provenance: [
          { kind: "identity_evidence", handoffId: null, opportunityId: null, evidenceType: "enrichment", occurredAt: OBSERVED },
        ],
      })
    );
    expect(evidence.identityReference).toHaveLength(64);
    const empty = validateIdentityProjection(projection({ provenance: [] }));
    expect((empty as NormalizedIdentityEvidence).leadId).toBe(LEAD_ID);
  });
});
