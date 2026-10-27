// WBS-R6-D — deterministic decision engine acceptance (contract §4–§7).
// Gate order: privacy → freshness → qualification decision → conversion stop
// → progression (handoff / nurture+channel+cadence).
import { describe, it, expect } from "vitest";
import { deriveNurtureDecision, isProgressionDecision, type NurtureDecisionInput } from "./nurture-decision";
import { buildDefaultNurturePolicyConfig, buildNurtureHandoffPolicy } from "./nurture-policy";
import { validateQualificationProjection, validatePrivacyEvidence, type QualificationHandoffProjection, type PrivacyEvidence } from "./nurture-upstream";
import { checkNurtureCadence, nextTouchSeq } from "./nurture-cadence";
import { validProjectionRaw } from "./nurture-upstream.test";

const NOW = new Date("2026-06-28T12:00:00.000Z");
const POLICY = buildNurtureHandoffPolicy(buildDefaultNurturePolicyConfig());

function qualified(): QualificationHandoffProjection {
  return validateQualificationProjection(validProjectionRaw());
}

function privacy(state = "ACTIVE", extra: Record<string, unknown> = {}): PrivacyEvidence {
  return validatePrivacyEvidence({
    available: true,
    state,
    explicit: state !== "ACTIVE",
    retentionDeadlineAt: null,
    previousState: null,
    source: null,
    actorUserId: null,
    updatedAt: state === "ACTIVE" ? null : "2026-06-28T00:00:00.000Z",
    ...extra,
  });
}

function baseInput(overrides: Partial<NurtureDecisionInput> = {}): NurtureDecisionInput {
  return {
    userId: 7,
    qualification: qualified(),
    privacy: privacy(),
    conversionStopped: false,
    handoffExists: false,
    policy: POLICY,
    channel: null,
    touches: [],
    now: NOW,
    ...overrides,
  };
}

describe("privacy override (contract §4)", () => {
  it.each(["SUPPRESSED", "RESTRICTED", "RETENTION_EXPIRED", "ARCHIVED"] as const)(
    "%s ⇒ BLOCKED with the matching reason",
    (state) => {
      const d = deriveNurtureDecision(baseInput({ privacy: privacy(state) }));
      expect(d.decision).toBe("BLOCKED");
      expect(d.reasonCodes[0]).toBe(
        state === "SUPPRESSED"
          ? "PRIVACY_SUPPRESSED"
          : state === "RESTRICTED"
            ? "PRIVACY_RESTRICTED"
            : state === "RETENTION_EXPIRED"
              ? "RETENTION_EXPIRED"
              : "PRIVACY_ARCHIVED"
      );
    }
  );

  it("unavailable privacy bridge fails closed even for QUALIFIED", () => {
    const d = deriveNurtureDecision(
      baseInput({ privacy: privacy("ACTIVE", { available: false, reason: "table absent" }) })
    );
    expect(d.decision).toBe("BLOCKED");
    expect(d.reasonCodes[0]).toBe("PRIVACY_STATE_UNAVAILABLE");
  });
});

describe("qualification gate (contract §2, §5)", () => {
  it("stale (expired) qualification ⇒ BLOCKED STALE_DECISION", () => {
    const stale = validateQualificationProjection(
      validProjectionRaw({ validUntil: "2026-06-27T00:00:00.000Z", mayProgress: false, progressBlockedReason: "STALE_DECISION" })
    );
    const d = deriveNurtureDecision(baseInput({ qualification: stale }));
    expect(d.decision).toBe("BLOCKED");
    expect(d.reasonCodes).toEqual(["STALE_DECISION"]);
  });

  it("NOT_QUALIFIED ⇒ NO_ACTION; INSUFFICIENT_EVIDENCE ⇒ WAIT", () => {
    const nq = validateQualificationProjection(
      validProjectionRaw({ decision: "NOT_QUALIFIED", mayProgress: false, progressBlockedReason: "DECISION_NOT_QUALIFIED" })
    );
    expect(deriveNurtureDecision(baseInput({ qualification: nq })).decision).toBe("NO_ACTION");

    const ie = validateQualificationProjection(
      validProjectionRaw({ decision: "INSUFFICIENT_EVIDENCE", mayProgress: false, progressBlockedReason: "DECISION_NOT_QUALIFIED" })
    );
    const d = deriveNurtureDecision(baseInput({ qualification: ie }));
    expect(d.decision).toBe("WAIT");
    expect(d.reasonCodes).toEqual(["INSUFFICIENT_EVIDENCE"]);
  });

  it("REVIEW_REQUIRED ⇒ REVIEW_REQUIRED decision; rejected review pins REJECTED", () => {
    const rr = validateQualificationProjection(
      validProjectionRaw({
        decision: "REVIEW_REQUIRED",
        mayProgress: false,
        progressBlockedReason: "REVIEW_REQUIRED_PENDING",
        review: { reviewId: "rev1:x", status: "pending", outcome: null, reviewedAt: null },
      })
    );
    expect(deriveNurtureDecision(baseInput({ qualification: rr })).reasonCodes).toEqual(["REVIEW_REQUIRED_PENDING"]);

    const rejected = validateQualificationProjection({
      ...validProjectionRaw({
        decision: "REVIEW_REQUIRED",
        mayProgress: false,
        progressBlockedReason: "REVIEW_REJECTED",
      }),
      review: { reviewId: "rev1:y", status: "progression_rejected", outcome: "progression_rejected", reviewedAt: "2026-06-28T01:00:00.000Z" },
    });
    expect(deriveNurtureDecision(baseInput({ qualification: rejected })).reasonCodes).toEqual(["REVIEW_REJECTED"]);
  });

  it("BLOCKED qualification ⇒ BLOCKED", () => {
    const b = validateQualificationProjection(
      validProjectionRaw({ decision: "BLOCKED", mayProgress: false, progressBlockedReason: "DECISION_NOT_QUALIFIED" })
    );
    expect(deriveNurtureDecision(baseInput({ qualification: b })).reasonCodes).toEqual(["DECISION_BLOCKED"]);
  });
});

describe("conversion stop (contract §13)", () => {
  it("authoritative conversion stops progression; policy can disable the stop", () => {
    const d = deriveNurtureDecision(baseInput({ conversionStopped: true }));
    expect(d.decision).toBe("NO_ACTION");
    expect(d.reasonCodes).toEqual(["CONVERSION_STOP"]);

    const permissive = buildNurtureHandoffPolicy({
      ...buildDefaultNurturePolicyConfig(),
      stopOnAuthoritativeConversion: false,
    });
    const d2 = deriveNurtureDecision(baseInput({ conversionStopped: true, policy: permissive }));
    expect(isProgressionDecision(d2.decision)).toBe(true);
  });
});

describe("progression paths", () => {
  it("QUALIFIED + no channel ⇒ SALES_HANDOFF, approval required by default policy", () => {
    const d = deriveNurtureDecision(baseInput());
    expect(d.decision).toBe("SALES_HANDOFF");
    expect(d.approvalRequired).toBe(true);
    expect(d.reasonCodes).toEqual(["APPROVAL_REQUIRED_BY_POLICY"]);
    expect(d.validUntil).toBe("2026-06-29T12:00:00.000Z");
  });

  it("handoff policy version participates in the decision identity", () => {
    const d1 = deriveNurtureDecision(baseInput());
    const d2 = deriveNurtureDecision(baseInput({ handoffExists: true }));
    expect(d1.nurtureDecisionId).not.toBe(d2.nurtureDecisionId);
    expect(d2.decision).toBe("SALES_HANDOFF");
  });

  it("QUALIFIED + channel ⇒ NURTURE when cadence clean", () => {
    const d = deriveNurtureDecision(baseInput({ channel: "email" }));
    expect(d.decision).toBe("NURTURE");
    expect(d.approvalRequired).toBe(false);
  });

  it("policy-prohibited channel ⇒ BLOCKED CAPABILITY_BLOCKED", () => {
    const restricted = buildNurtureHandoffPolicy({
      ...buildDefaultNurturePolicyConfig(),
      allowedChannels: ["email"],
    });
    const d = deriveNurtureDecision(baseInput({ channel: "sms", policy: restricted }));
    expect(d.decision).toBe("BLOCKED");
    expect(d.reasonCodes).toEqual(["CAPABILITY_BLOCKED"]);
  });

  it("channel requiring approval marks the decision approvalRequired", () => {
    const d = deriveNurtureDecision(baseInput({ channel: "sms" }));
    expect(d.decision).toBe("NURTURE");
    expect(d.approvalRequired).toBe(true);
  });
});

describe("cadence gate (contract §7, D3)", () => {
  it("over-cadence ⇒ WAIT NURTURE_CADENCE_LIMITED; recovery yields a new identity", () => {
    const recent = [{ touchedAt: "2026-06-27T00:00:00.000Z" }]; // 36h ago < 72h minInterval
    const d1 = deriveNurtureDecision(baseInput({ channel: "email", touches: recent }));
    expect(d1.decision).toBe("WAIT");
    expect(d1.reasonCodes).toEqual(["NURTURE_CADENCE_LIMITED"]);

    const later = new Date("2026-06-30T00:00:00.000Z"); // 96h after the touch
    const d2 = deriveNurtureDecision(baseInput({ channel: "email", touches: recent, now: later }));
    expect(d2.decision).toBe("NURTURE");
    expect(d2.nurtureDecisionId).not.toBe(d1.nurtureDecisionId);
  });

  it("window cap blocks the next touch", () => {
    const touches = [
      { touchedAt: "2026-06-26T12:00:00.000Z" },
      { touchedAt: "2026-06-27T12:00:00.000Z" },
      { touchedAt: "2026-06-28T08:00:00.000Z" },
      { touchedAt: "2026-06-28T11:00:00.000Z" },
    ];
    // last touch 1h ago ⇒ interval gate fires first
    const v = checkNurtureCadence({ policy: POLICY, touches, now: NOW });
    expect(v.allowed).toBe(false);
    expect(v.nextEligibleAt).toBe("2026-07-01T11:00:00.000Z");

    // interval-clean but cap-full: last touch 73h ago (>72h interval),
    // 4 touches inside the 30-day rolling window
    const capped = [
      { touchedAt: "2026-06-20T12:00:00.000Z" },
      { touchedAt: "2026-06-21T12:00:00.000Z" },
      { touchedAt: "2026-06-22T12:00:00.000Z" },
      { touchedAt: "2026-06-25T11:00:00.000Z" },
    ];
    const v2 = checkNurtureCadence({ policy: POLICY, touches: capped, now: NOW });
    expect(v2.allowed).toBe(false);
    expect(v2.touchesInWindow).toBe(4);
    expect(v2.nextEligibleAt).toBeNull();
    expect(v2.windowNextEligibleAt).toBe("2026-07-20T12:00:00.000Z");

    // clean history ⇒ allowed
    expect(checkNurtureCadence({ policy: POLICY, touches: [], now: NOW }).allowed).toBe(true);
    expect(nextTouchSeq(0)).toBe(1);
    expect(nextTouchSeq(4)).toBe(5);
  });

  it("decision identity pins the cadence outcome (no same-key material drift)", () => {
    const blocked = deriveNurtureDecision(baseInput({ channel: "email", touches: [{ touchedAt: "2026-06-27T00:00:00.000Z" }] }));
    const blockedAgain = deriveNurtureDecision(baseInput({ channel: "email", touches: [{ touchedAt: "2026-06-27T00:00:00.000Z" }] }));
    expect(blocked.nurtureDecisionId).toBe(blockedAgain.nurtureDecisionId);

    const allowed = deriveNurtureDecision(baseInput({ channel: "email", touches: [{ touchedAt: "2026-06-20T00:00:00.000Z" }] }));
    expect(allowed.decision).toBe("NURTURE");
    expect(allowed.nurtureDecisionId).not.toBe(blocked.nurtureDecisionId);
  });
});

describe("determinism", () => {
  it("same inputs ⇒ identical derivation; any drift ⇒ different identity", () => {
    const a = deriveNurtureDecision(baseInput({ channel: "email" }));
    const b = deriveNurtureDecision(baseInput({ channel: "email" }));
    expect(a).toEqual(b);
  });
});
