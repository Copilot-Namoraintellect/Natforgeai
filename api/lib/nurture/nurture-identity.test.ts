// WBS-R6-D — deterministic identity acceptance (contract §1, §8, §11).
import { describe, it, expect } from "vitest";
import {
  canonicalJson,
  sha256Hex,
  deriveDecisionKey,
  deriveNurtureDecisionId,
  deriveHandoffKey,
  deriveHandoffId,
  deriveExecutionIdentity,
  deriveTouchIdentity,
  fingerprintQualificationProjection,
  hashContentSnapshot,
  IDENTITY_ID_PATTERN,
  NURTURE_DECISION_ID_PREFIX,
  HANDOFF_ID_PREFIX,
  EXECUTION_ID_PREFIX,
  TOUCH_ID_PREFIX,
} from "./nurture-identity";

const BASE = {
  userId: 7,
  businessId: 42,
  leadId: "lid1:" + "a".repeat(64),
  qualificationId: "lqu1:" + "b".repeat(64),
  qualificationFingerprint: "f".repeat(64),
  privacyState: "ACTIVE",
  privacyStateUpdatedAt: null,
  conversionStopped: false,
  handoffExists: false,
  policyVersion: "nurture-handoff-policy/v1",
  channel: null as string | null,
  cadenceBlocked: null as boolean | null,
};

describe("canonicalJson / sha256Hex", () => {
  it("is key-order independent and stable", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(
      canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 })
    );
    expect(sha256Hex("x")).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("decision identity", () => {
  it("same world-state ⇒ same decisionKey and id (replay-safe)", () => {
    const k1 = deriveDecisionKey(BASE);
    const k2 = deriveDecisionKey({ ...BASE });
    expect(k1).toBe(k2);
    expect(deriveNurtureDecisionId(k1)).toBe(`${NURTURE_DECISION_ID_PREFIX}${k1}`);
    expect(deriveNurtureDecisionId(k1)).toMatch(IDENTITY_ID_PATTERN);
  });

  it("tenant anchor inside the hash: different userId ⇒ different identity", () => {
    expect(deriveDecisionKey(BASE)).not.toBe(deriveDecisionKey({ ...BASE, userId: 8 }));
  });

  it("any world-state field change changes the identity", () => {
    const variants = [
      { ...BASE, businessId: 43 },
      { ...BASE, privacyState: "SUPPRESSED" },
      { ...BASE, privacyStateUpdatedAt: "2026-06-28T00:00:00.000Z" },
      { ...BASE, conversionStopped: true },
      { ...BASE, handoffExists: true },
      { ...BASE, policyVersion: "nurture-handoff-policy/v1+abcd" },
      { ...BASE, channel: "email" },
      { ...BASE, cadenceBlocked: true },
      { ...BASE, qualificationFingerprint: "e".repeat(64) },
    ];
    const base = deriveDecisionKey(BASE);
    for (const v of variants) expect(deriveDecisionKey(v)).not.toBe(base);
  });

  it("null and absent-equivalent channel/cadence handling is canonical", () => {
    expect(deriveDecisionKey(BASE)).toBe(
      deriveDecisionKey({ ...BASE, channel: null, cadenceBlocked: null })
    );
  });
});

describe("handoff identity (exact-once, contract §8)", () => {
  const HANDOFF_BASE = {
    userId: 7,
    businessId: 42,
    leadId: "lid1:" + "a".repeat(64),
    qualificationId: "lqu1:" + "b".repeat(64),
    handoffPolicyVersion: "nurture-handoff-policy/v1",
  };

  it("same inputs converge; any drift changes identity", () => {
    const k = deriveHandoffKey(HANDOFF_BASE);
    expect(deriveHandoffKey({ ...HANDOFF_BASE })).toBe(k);
    expect(deriveHandoffId(k)).toBe(`${HANDOFF_ID_PREFIX}${k}`);
    expect(deriveHandoffId(k)).toMatch(IDENTITY_ID_PATTERN);
    expect(deriveHandoffKey({ ...HANDOFF_BASE, leadId: "lid1:" + "c".repeat(64) })).not.toBe(k);
    expect(deriveHandoffKey({ ...HANDOFF_BASE, userId: 9 })).not.toBe(k);
    expect(deriveHandoffKey({ ...HANDOFF_BASE, qualificationId: "lqu1:" + "d".repeat(64) })).not.toBe(k);
  });
});

describe("execution + touch identities (contract §11, §7)", () => {
  it("attempt sequencing produces distinct stable identities", () => {
    const h = deriveHandoffId(deriveHandoffKey({ ...BASE, handoffPolicyVersion: "nurture-handoff-policy/v1" }));
    const e1 = deriveExecutionIdentity(h, 1);
    const e1b = deriveExecutionIdentity(h, 1);
    const e2 = deriveExecutionIdentity(h, 2);
    expect(e1).toBe(e1b);
    expect(e1).not.toBe(e2);
    expect(e1).toMatch(new RegExp(`^${EXECUTION_ID_PREFIX}[a-f0-9]{64}$`));

    const t1 = deriveTouchIdentity({
      userId: 7,
      leadId: BASE.leadId,
      nurtureDecisionId: deriveNurtureDecisionId(deriveDecisionKey(BASE)),
      touchSeq: 1,
    });
    expect(t1).toMatch(new RegExp(`^${TOUCH_ID_PREFIX}[a-f0-9]{64}$`));
  });
});

describe("fingerprints", () => {
  it("qualification fingerprint binds exact projection content", () => {
    const p = { a: 1, b: [2, 3] };
    expect(fingerprintQualificationProjection(p)).toBe(fingerprintQualificationProjection({ b: [2, 3], a: 1 }));
    expect(fingerprintQualificationProjection(p)).not.toBe(fingerprintQualificationProjection({ a: 1, b: [2, 4] }));
  });

  it("content snapshot hash is deterministic", () => {
    expect(hashContentSnapshot({ body: "hello" })).toBe(hashContentSnapshot({ body: "hello" }));
    expect(hashContentSnapshot({ body: "hello" })).not.toBe(hashContentSnapshot({ body: "bye" }));
  });
});
