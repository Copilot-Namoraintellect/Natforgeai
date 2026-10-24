import { describe, expect, it } from "vitest";
import { toCanonicalSignal, type SanitizedSocialSignal } from "./canonical-signal";
import { sanitizeSignalText } from "./input-safety";
import {
  buildInterpretationBillingIdentity,
  canonicalJson,
  computeInterpretationFingerprint,
  computeInterpretationId,
  computeSignalContentHash,
  hashCanonical,
  sha256Hex,
} from "./interpretation-identity";
import {
  CLASSIFIER_VERSION,
  SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
  type SocialInterpretation,
} from "./interpretation-contract";

function sanitized(overrides: Record<string, unknown> = {}): SanitizedSocialSignal {
  return sanitizeSignalText(
    toCanonicalSignal({
      signalId: "sig-id-1",
      signalVersion: 3,
      signalType: "comment",
      platform: "instagram",
      actorHandle: "@someone",
      text: "Hello there, quick question about pricing",
      occurredAt: "2026-06-01T09:30:00Z",
      metadata: { provider: "fixture", lang: "en" },
      ...overrides,
    })
  );
}

describe("canonicalJson", () => {
  it("is independent of object key order at every depth", () => {
    const a = canonicalJson({ b: 2, a: { d: 4, c: 3 }, list: [{ y: 1, x: 0 }] });
    const b = canonicalJson({ list: [{ x: 0, y: 1 }], a: { c: 3, d: 4 }, b: 2 });
    expect(a).toBe(b);
  });

  it("trims strings and omits undefined object values", () => {
    expect(canonicalJson({ s: "  padded  ", missing: undefined })).toBe('{"s":"padded"}');
  });
});

describe("sha256Hex / hashCanonical", () => {
  it("produces stable 64-char lowercase hex", () => {
    const hex = sha256Hex("deterministic");
    expect(hex).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256Hex("deterministic")).toBe(hex);
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 2 }));
  });
});

describe("computeSignalContentHash", () => {
  it("is deterministic across calls for identical sanitized signals", () => {
    const h1 = computeSignalContentHash(sanitized());
    const h2 = computeSignalContentHash(sanitized());
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("distinguishes tiny content changes, including metadata", () => {
    const base = computeSignalContentHash(sanitized());
    expect(computeSignalContentHash(sanitized({ text: "Hello there, quick question about pricing!" }))).not.toBe(base);
    expect(computeSignalContentHash(sanitized({ signalVersion: 4 }))).not.toBe(base);
    expect(computeSignalContentHash(sanitized({ actorHandle: "@someone_else" }))).not.toBe(base);
    expect(computeSignalContentHash(sanitized({ metadata: { provider: "fixture", lang: "en-US" } }))).not.toBe(base);
  });

  it("ignores signalId, since the hash binds content to one logical signal", () => {
    const a = sanitized({ signalId: "sig-a" });
    const b = sanitized({ signalId: "sig-b" });
    expect(computeSignalContentHash(a)).toBe(computeSignalContentHash(b));
  });
});

describe("computeInterpretationId", () => {
  const args = {
    schemaVersion: SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
    businessId: 9,
    signalId: "sig-id-1",
    signalVersion: 3,
    signalContentHash: computeSignalContentHash(sanitized()),
    classifierVersion: CLASSIFIER_VERSION,
  };

  it("is deterministic and order-independent", () => {
    const id1 = computeInterpretationId(args);
    expect(computeInterpretationId({ ...args })).toBe(id1);
    expect(id1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when any identity participant changes", () => {
    const base = computeInterpretationId(args);
    expect(computeInterpretationId({ ...args, businessId: 10 })).not.toBe(base);
    expect(computeInterpretationId({ ...args, signalVersion: 4 })).not.toBe(base);
    expect(computeInterpretationId({ ...args, classifierVersion: "intent-sentiment-classifier/v2" })).not.toBe(base);
    expect(
      computeInterpretationId({ ...args, signalContentHash: "f".repeat(64) })
    ).not.toBe(base);
  });

  it("rejects empty identity fields", () => {
    expect(() => computeInterpretationId({ ...args, signalId: "  " })).toThrowError(
      expect.objectContaining({ code: "INVALID_IDENTITY_INPUT" })
    );
    expect(() => computeInterpretationId({ ...args, businessId: 0 })).toThrowError(
      expect.objectContaining({ code: "INVALID_IDENTITY_INPUT" })
    );
  });
});

describe("buildInterpretationBillingIdentity", () => {
  it('produces the canonical "interpretation:" prefix followed by 64 hex chars', () => {
    const identity = buildInterpretationBillingIdentity({
      businessId: 9,
      signalId: "sig-id-1",
      signalVersion: 3,
      signalContentHash: computeSignalContentHash(sanitized()),
      classifierVersion: CLASSIFIER_VERSION,
    });
    expect(identity.startsWith("interpretation:")).toBe(true);
    expect(identity.slice("interpretation:".length)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic and distinct per signal version", () => {
    const args = {
      businessId: 9,
      signalId: "sig-id-1",
      signalVersion: 3,
      signalContentHash: computeSignalContentHash(sanitized()),
      classifierVersion: CLASSIFIER_VERSION,
    };
    expect(buildInterpretationBillingIdentity(args)).toBe(buildInterpretationBillingIdentity({ ...args }));
    expect(buildInterpretationBillingIdentity({ ...args, signalVersion: 4 })).not.toBe(
      buildInterpretationBillingIdentity(args)
    );
  });
});

describe("computeInterpretationFingerprint", () => {
  function record(overrides: Record<string, unknown> = {}): SocialInterpretation {
    const signal = sanitized();
    const signalContentHash = computeSignalContentHash(signal);
    const base = {
      interpretationId: computeInterpretationId({
        schemaVersion: SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
        businessId: 9,
        signalId: signal.signalId,
        signalVersion: signal.signalVersion,
        signalContentHash,
        classifierVersion: CLASSIFIER_VERSION,
      }),
      schemaVersion: SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
      classifierVersion: CLASSIFIER_VERSION,
      userId: 5,
      businessId: 9,
      signalId: signal.signalId,
      signalVersion: signal.signalVersion,
      signalContentHash,
      signalType: signal.signalType,
      source: "MODEL" as const,
      intent: "purchase_interest" as const,
      intentConfidence: "medium" as const,
      sentiment: "positive" as const,
      sentimentConfidence: "medium" as const,
      urgency: "normal" as const,
      relevance: "relevant" as const,
      relevanceConfidence: "low" as const,
      overallConfidence: "low" as const,
      confidenceBasis: "model_self_assessed" as const,
      topics: ["pricing"],
      riskFlags: [],
      opportunityIndicators: [
        { indicator: "purchase_intent_detected" as const, evidence: "model_hint" },
      ],
      recommendedHandling: "human_review" as const,
      businessDnaSnapshotId: "snap-xyz",
      evidenceReferences: [{ kind: "model" as const, ref: "run-1" }],
      explanation: "Model interpretation fixture record.",
      billingIdentity: buildInterpretationBillingIdentity({
        businessId: 9,
        signalId: signal.signalId,
        signalVersion: signal.signalVersion,
        signalContentHash,
        classifierVersion: CLASSIFIER_VERSION,
      }),
      interpretationFingerprint: "",
      createdAt: "2026-06-01T10:00:00Z",
      status: "accepted" as const,
    };
    const fingerprint = computeInterpretationFingerprint(base as unknown as SocialInterpretation);
    return { ...base, interpretationFingerprint: fingerprint, ...overrides } as SocialInterpretation;
  }

  it("is stable across repeated computation (replay stability)", () => {
    const rec = record();
    expect(computeInterpretationFingerprint(rec)).toBe(rec.interpretationFingerprint);
    expect(computeInterpretationFingerprint(rec)).toBe(computeInterpretationFingerprint({ ...rec }));
  });

  it("excludes the fingerprint field itself from the hashed material", () => {
    const rec = record();
    const tampered = { ...rec, interpretationFingerprint: "0".repeat(64) };
    expect(computeInterpretationFingerprint(tampered)).toBe(computeInterpretationFingerprint(rec));
  });

  it("changes when any record field changes", () => {
    const rec = record();
    const base = computeInterpretationFingerprint(rec);
    expect(computeInterpretationFingerprint({ ...rec, intent: "praise" })).not.toBe(base);
    expect(computeInterpretationFingerprint({ ...rec, explanation: "Changed." })).not.toBe(base);
    expect(computeInterpretationFingerprint({ ...rec, billingIdentity: null })).not.toBe(base);
    expect(computeInterpretationFingerprint({ ...rec, createdAt: "2026-06-02T10:00:00Z" })).not.toBe(base);
  });
});
