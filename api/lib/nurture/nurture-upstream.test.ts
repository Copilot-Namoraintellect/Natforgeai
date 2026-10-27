// WBS-R6-D — upstream port validation acceptance (contract §2–§4, §13).
// Cross-agent trust: malformed / tampered / stale-contract payloads fail closed.
import { describe, it, expect } from "vitest";
import {
  validateQualificationProjection,
  validateLeadIdentityRef,
  validatePrivacyEvidence,
  validateConversionEvidence,
  isPrivacyActionable,
  privacyBlockReason,
  selectAuthoritativeConversions,
  SUPPORTED_QUALIFICATION_CONTRACT_PREFIX,
} from "./nurture-upstream";
import { NurtureError } from "./nurture-contract";

const HEX = (c: string) => c.repeat(64);

export function validProjectionRaw(overrides: Record<string, unknown> = {}) {
  return {
    qualificationId: `lqu1:${HEX("a")}`,
    businessId: 42,
    leadId: `lid1:${HEX("b")}`,
    decision: "QUALIFIED",
    reasonCodes: ["SCORE_BAND_HIGH"],
    scoreReference: {
      leadScoreId: `lsc1:${HEX("c")}`,
      scoringVersion: "lead-scoring/v1",
      scoreContentHash: HEX("d"),
    },
    evidenceSnapshotReference: { evidenceSnapshotHash: HEX("e") },
    qualificationPolicyVersion: "lead-qualification-policy/v1",
    engineVersion: "lead-qualification/v1",
    evaluatedAt: "2026-06-27T00:00:00.000Z",
    validUntil: "2026-07-04T00:00:00.000Z",
    review: null,
    privacy: { state: "ACTIVE", actionable: true },
    mayProgress: true,
    progressBlockedReason: null,
    ...overrides,
  };
}

describe("qualification projection validation", () => {
  it("accepts a frozen-shape projection", () => {
    const p = validateQualificationProjection(validProjectionRaw());
    expect(p.decision).toBe("QUALIFIED");
    expect(p.mayProgress).toBe(true);
  });

  it("rejects structural drift (extra/missing keys, wrong shapes)", () => {
    expect(() => validateQualificationProjection({ ...validProjectionRaw(), evil: 1 })).toThrow(NurtureError);
    expect(() => validateQualificationProjection({ ...validProjectionRaw(), mayProgress: "yes" })).toThrow(NurtureError);
    const { review, ...noReview } = validProjectionRaw();
    void review;
    expect(() => validateQualificationProjection(noReview)).toThrow(NurtureError);
  });

  it("rejects unknown decisions and forged id shapes", () => {
    expect(() => validateQualificationProjection(validProjectionRaw({ decision: "SALES_READY" }))).toThrow(NurtureError);
    expect(() => validateQualificationProjection(validProjectionRaw({ leadId: "lid1:zzz" }))).toThrow(NurtureError);
    expect(() => validateQualificationProjection(validProjectionRaw({ qualificationId: "lqu1:short" }))).toThrow(NurtureError);
  });

  it("rejects unsupported engine contract versions (stale/upstream drift)", () => {
    expect(SUPPORTED_QUALIFICATION_CONTRACT_PREFIX).toBe("lead-qualification/v1");
    expect(() =>
      validateQualificationProjection(validProjectionRaw({ engineVersion: "lead-qualification/v2" }))
    ).toThrow(/unsupported qualification engineVersion/);
    expect(() =>
      validateQualificationProjection(validProjectionRaw({ engineVersion: "rogue-agent/v9" }))
    ).toThrow(NurtureError);
  });

  it("rejects the contractually impossible mayProgress=true + non-QUALIFIED (tamper)", () => {
    expect(() =>
      validateQualificationProjection(
        validProjectionRaw({ decision: "NOT_QUALIFIED", mayProgress: true, progressBlockedReason: null })
      )
    ).toThrow(/contractually impossible/);
  });
});

describe("identity ref validation", () => {
  it("accepts frozen A shape; rejects drift", () => {
    const ok = validateLeadIdentityRef({
      leadId: `lid1:${HEX("b")}`,
      businessId: 42,
      identityStatus: "resolved",
      canonicalLeadId: null,
    });
    expect(ok.identityStatus).toBe("resolved");
    expect(() =>
      validateLeadIdentityRef({ leadId: `lid1:${HEX("b")}`, businessId: 42, identityStatus: "sales_ready" })
    ).toThrow(NurtureError);
  });
});

describe("privacy evidence + F gate semantics", () => {
  const NOW = new Date("2026-06-28T12:00:00.000Z");
  const active = validatePrivacyEvidence({
    available: true,
    state: "ACTIVE",
    explicit: false,
    retentionDeadlineAt: null,
    previousState: null,
    source: null,
    actorUserId: null,
    updatedAt: null,
  });

  it("ACTIVE actionable; suppressed/restricted/expired/archived not", () => {
    expect(isPrivacyActionable(active, NOW)).toBe(true);
    for (const state of ["SUPPRESSED", "RESTRICTED", "RETENTION_EXPIRED", "ARCHIVED"]) {
      const ev = validatePrivacyEvidence({ ...active, state, explicit: true, updatedAt: "2026-06-28T00:00:00.000Z" });
      expect(isPrivacyActionable(ev, NOW)).toBe(false);
    }
  });

  it("RETENTION_PENDING actionable only inside the deadline", () => {
    const pending = validatePrivacyEvidence({
      ...active,
      state: "RETENTION_PENDING",
      retentionDeadlineAt: "2026-06-29T00:00:00.000Z",
    });
    expect(isPrivacyActionable(pending, NOW)).toBe(true);
    expect(isPrivacyActionable(pending, new Date("2026-06-30T00:00:00.000Z"))).toBe(false);
  });

  it("unavailable bridge is never actionable and maps to the unavailable reason", () => {
    const unavailable = validatePrivacyEvidence({ ...active, available: false, reason: "table absent" });
    expect(isPrivacyActionable(unavailable, NOW)).toBe(false);
    expect(privacyBlockReason(unavailable)).toBe("PRIVACY_STATE_UNAVAILABLE");
  });

  it("block reason mapping is closed and exact", () => {
    const mk = (state: string) => validatePrivacyEvidence({ ...active, state, explicit: true });
    expect(privacyBlockReason(mk("SUPPRESSED"))).toBe("PRIVACY_SUPPRESSED");
    expect(privacyBlockReason(mk("RESTRICTED"))).toBe("PRIVACY_RESTRICTED");
    expect(privacyBlockReason(mk("RETENTION_EXPIRED"))).toBe("RETENTION_EXPIRED");
    expect(privacyBlockReason(mk("ARCHIVED"))).toBe("PRIVACY_ARCHIVED");
  });
});

describe("conversion evidence selection (contract §13)", () => {
  it("keeps only authoritative, non-reversed conversions", () => {
    const rows = validateConversionEvidence([
      { conversionId: "cnv1:x", businessId: 42, outcomeStatus: "CONFIRMED", sourceTrustClass: "VERIFIED_PAYMENT", occurredAt: "2026-06-27T00:00:00.000Z" },
      { conversionId: "cnv1:y", businessId: 42, outcomeStatus: "PENDING", sourceTrustClass: "UNVERIFIED_EXTERNAL", occurredAt: "2026-06-27T00:00:00.000Z" },
      { conversionId: "cnv1:z", businessId: 42, outcomeStatus: "REFUNDED", sourceTrustClass: "VERIFIED_INTERNAL", occurredAt: "2026-06-27T00:00:00.000Z" },
      { conversionId: "cnv1:w", businessId: 42, outcomeStatus: "CONFIRMED", sourceTrustClass: "USER_REPORTED", occurredAt: "2026-06-27T00:00:00.000Z" },
      { conversionId: "cnv1:v", businessId: 42, outcomeStatus: "CONFIRMED", sourceTrustClass: "VERIFIED_CRM", occurredAt: "2026-06-27T00:00:00.000Z" },
    ]);
    const authoritative = selectAuthoritativeConversions(rows).map((r) => r.conversionId);
    expect(authoritative).toEqual(["cnv1:x", "cnv1:w", "cnv1:v"]);
  });

  it("rejects malformed conversion rows", () => {
    expect(() => validateConversionEvidence([{ conversionId: 5 }])).toThrow(NurtureError);
  });
});
