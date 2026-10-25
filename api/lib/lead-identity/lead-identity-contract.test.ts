// R6-A — contract tests: strict envelope validation (untrusted-data seam),
// deterministic tamper verification, and identity coordinate derivation.

import { describe, it, expect } from "vitest";
import {
  validateHandoffEnvelope,
  verifyHandoffEnvelopeIntegrity,
  deriveEnvelopeHash,
  buildIdentityCoordinates,
  deriveIdentityKey,
  deriveLeadId,
  LEAD_ID_PREFIX,
  canonicalJson,
  sha256Hex,
  LeadIdentityValidationError,
  LeadIdentityTamperError,
} from "./lead-identity-contract";
import { HANDOFF_ID_PREFIX } from "../opportunity/opportunity-identity";

const EVIDENCE = [
  { interpretationId: "int-1", signalId: "sig-1", signalVersion: 1, occurredAt: "2026-10-20T10:00:00.000Z" },
];

function envelopeContent(overrides: Record<string, unknown> = {}) {
  return {
    handoffEnvelopeVersion: "opportunity-to-lead-autonomy/v1",
    handoffId: "placeholder",
    opportunityId: `${"opp1:"}${"a".repeat(64)}`,
    opportunityKey: "b".repeat(64),
    userId: 1,
    businessId: 1,
    opportunityType: "purchase_interest",
    opportunityStatusAtHandoff: "candidate",
    confidenceClass: "MEDIUM",
    evidenceStrength: "MEDIUM",
    urgency: "normal",
    topic: "pricing",
    topicKey: "c".repeat(64),
    actorKey: "d".repeat(64),
    threadKey: "e".repeat(64),
    campaignId: 1,
    publicationId: null,
    provider: "meta",
    externalActorReference: null,
    evidenceCount: 1,
    contradictionCount: 0,
    firstObservedAt: "2026-10-20T09:00:00.000Z",
    lastObservedAt: "2026-10-20T10:00:00.000Z",
    detectorRulesVersion: "opportunity-detector/v1",
    classifierVersions: ["intent-sentiment-classifier/v1"],
    evidence: EVIDENCE,
    evidenceSnapshotHash: sha256Hex(canonicalJson(EVIDENCE)),
    handedOffAt: "2026-10-20T12:00:00.000Z",
    ...overrides,
  };
}

export function buildValidEnvelope(overrides: Record<string, unknown> = {}) {
  const content = envelopeContent(overrides);
  const { handoffId: _omit, ...rest } = content;
  void _omit;
  const handoffId = `${HANDOFF_ID_PREFIX}${sha256Hex(canonicalJson(rest))}`;
  return { ...rest, handoffId };
}

describe("validateHandoffEnvelope", () => {
  it("accepts a well-formed envelope", () => {
    const envelope = buildValidEnvelope();
    expect(() => validateHandoffEnvelope(envelope)).not.toThrow();
    const parsed = validateHandoffEnvelope(envelope);
    expect(parsed.handoffId).toBe(envelope.handoffId);
  });

  it("rejects unknown/injected fields (strict schema)", () => {
    expect(() => validateHandoffEnvelope({ ...buildValidEnvelope(), leadId: "lid1:" + "f".repeat(64) })).toThrow(
      LeadIdentityValidationError
    );
    expect(() => validateHandoffEnvelope({ ...buildValidEnvelope(), score: 99 })).toThrow(
      LeadIdentityValidationError
    );
  });

  it("rejects wrong envelope version and stale upstream versions", () => {
    expect(() => validateHandoffEnvelope(buildValidEnvelope({ handoffEnvelopeVersion: "opportunity-to-lead-autonomy/v2" }))).toThrow(
      LeadIdentityValidationError
    );
  });

  it("rejects a non-null externalActorReference (tamper/injection attempt)", () => {
    expect(() => validateHandoffEnvelope(buildValidEnvelope({ externalActorReference: "@handle" }))).toThrow(
      LeadIdentityValidationError
    );
  });

  it("rejects malformed actor references", () => {
    expect(() => validateHandoffEnvelope(buildValidEnvelope({ actorKey: "not-a-hash" }))).toThrow(
      LeadIdentityValidationError
    );
    expect(() => validateHandoffEnvelope(buildValidEnvelope({ actorKey: "D".repeat(64) }))).toThrow(
      LeadIdentityValidationError
    ); // uppercase hex not allowed
  });

  it("rejects oversized identity inputs", () => {
    expect(() => validateHandoffEnvelope(buildValidEnvelope({ topic: "x".repeat(49) }))).toThrow(
      LeadIdentityValidationError
    );
    expect(() =>
      validateHandoffEnvelope(buildValidEnvelope({ evidence: Array(257).fill(EVIDENCE[0]) }))
    ).toThrow(LeadIdentityValidationError);
  });

  it("rejects closed-vocabulary violations", () => {
    expect(() => validateHandoffEnvelope(buildValidEnvelope({ provider: "myspace" }))).toThrow(
      LeadIdentityValidationError
    );
    expect(() => validateHandoffEnvelope(buildValidEnvelope({ opportunityType: "qualified" }))).toThrow(
      LeadIdentityValidationError
    );
  });
});

describe("verifyHandoffEnvelopeIntegrity", () => {
  it("accepts the canonical content-hash id", () => {
    const envelope = buildValidEnvelope();
    expect(() => verifyHandoffEnvelopeIntegrity(envelope)).not.toThrow();
  });

  it("rejects a tampered actor reference (id no longer matches content)", () => {
    const envelope = buildValidEnvelope();
    const tampered = { ...envelope, actorKey: "f".repeat(64) };
    expect(() => verifyHandoffEnvelopeIntegrity(tampered)).toThrow(LeadIdentityTamperError);
  });

  it("rejects a tampered opportunity id bound to another envelope", () => {
    const envelope = buildValidEnvelope();
    const foreign = buildValidEnvelope({
      actorKey: "f".repeat(64),
      opportunityId: `opp1:${"b".repeat(64)}`,
      opportunityKey: "f".repeat(64),
    });
    const swapped = { ...envelope, opportunityId: foreign.opportunityId };
    expect(() => verifyHandoffEnvelopeIntegrity(swapped)).toThrow(LeadIdentityTamperError);
  });

  it("rejects evidence manifest drift", () => {
    const envelope = buildValidEnvelope();
    const drifted = {
      ...envelope,
      evidence: [{ ...EVIDENCE[0], signalVersion: 2 }],
    };
    expect(() => verifyHandoffEnvelopeIntegrity(drifted)).toThrow(LeadIdentityTamperError);
  });

  it("deriveEnvelopeHash is deterministic and content-bound", () => {
    const a = buildValidEnvelope();
    const b = buildValidEnvelope({ contradictionCount: 1 });
    expect(deriveEnvelopeHash(a)).toBe(deriveEnvelopeHash(a));
    expect(deriveEnvelopeHash(a)).not.toBe(deriveEnvelopeHash(b));
    expect(deriveEnvelopeHash(a)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("identity coordinate derivation", () => {
  it("actor-present coordinates key on actorKey; anonymous coordinates key on threadKey", () => {
    const actorEnvelope = validateHandoffEnvelope(buildValidEnvelope());
    const coords = buildIdentityCoordinates(actorEnvelope);
    expect(coords.actorKey).toBe("d".repeat(64));
    expect(coords.threadKey).toBeNull();

    const anonEnvelope = validateHandoffEnvelope(buildValidEnvelope({ actorKey: "no-actor" }));
    const anonCoords = buildIdentityCoordinates(anonEnvelope);
    expect(anonCoords.actorKey).toBeNull();
    expect(anonCoords.threadKey).toBe("e".repeat(64));
  });

  it("same actor across tenants never shares an identityKey", () => {
    const e1 = validateHandoffEnvelope(buildValidEnvelope({ userId: 1, businessId: 1 }));
    const e2 = validateHandoffEnvelope(buildValidEnvelope({ userId: 2, businessId: 2 }));
    expect(deriveIdentityKey(buildIdentityCoordinates(e1))).not.toBe(
      deriveIdentityKey(buildIdentityCoordinates(e2))
    );
  });

  it("same actor across business scopes never shares an identityKey", () => {
    const e1 = validateHandoffEnvelope(buildValidEnvelope({ userId: 1, businessId: 1 }));
    const e3 = validateHandoffEnvelope(buildValidEnvelope({ userId: 1, businessId: 3 }));
    expect(deriveIdentityKey(buildIdentityCoordinates(e1))).not.toBe(
      deriveIdentityKey(buildIdentityCoordinates(e3))
    );
  });

  it("same actor across providers never shares an identityKey (provider is inside actorKey)", () => {
    const keyA = deriveIdentityKey({ userId: 1, businessId: 1, actorKey: "a".repeat(64), threadKey: null });
    const keyB = deriveIdentityKey({ userId: 1, businessId: 1, actorKey: "b".repeat(64), threadKey: null });
    expect(keyA).not.toBe(keyB);
  });

  it("leadId is the lid1-prefixed identityKey", () => {
    const key = deriveIdentityKey({ userId: 1, businessId: 1, actorKey: "a".repeat(64), threadKey: null });
    expect(deriveLeadId(key)).toBe(`${LEAD_ID_PREFIX}${key}`);
  });
});
