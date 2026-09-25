import { describe, expect, it } from "vitest";

import {
  assertCreativeArtifactLineageMatchesEnvelope,
  assertPersistedCreativeArtifactLineageIntact,
  buildPersistedCreativeArtifactLineage,
  creativeArtifactApprovedCopyLineageFromEnvelope,
  creativeArtifactStrategyLineageFromAuthority,
  creativeArtifactStrategyLineageFromEnvelope,
  deriveCreativeArtifactLineageFingerprint,
  normalizeCreativeArtifactLineage,
  CREATIVE_ARTIFACT_LINEAGE_SCHEMA_VERSION,
  type CreativeArtifactLineageInput,
} from "./artifact-lineage";
import type { V2ApprovalEnvelope } from "./message-approval/contracts";
import type { CreativeStrategyAuthority } from "./strategy-authority";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);

function buildEnvelope(
  overrides: Partial<V2ApprovalEnvelope> = {}
): V2ApprovalEnvelope {
  return {
    schemaVersion: "v2.1",
    approvalMode: "canary",
    contextLockId: "ctx-30-1",
    approvedRevisionId: "rev-30-1",
    candidateId: "cand-30-1",
    assessmentId: "assess-30-1",
    assessmentHashSha256: SHA_D,
    copyHashSha256: SHA_A,
    copySchemaVersion: "v2.1",
    businessDnaSnapshotId: "bizdna-30-v1",
    evidenceHashSha256: SHA_E,
    campaignStrategySnapshotId: "strategy-30-v1",
    strategyHashSha256: SHA_B,
    policyId: "policy-v2-default",
    policyVersion: 3,
    policyHashSha256: SHA_C,
    approvedAtIso: "2026-07-01T08:03:00.000Z",
    candidateSource: "ai_initial",
    sourceProvenance: {
      adaptedFromLegacy: false,
      originSource: "ai_refined_pack",
      modelName: null,
      diagnostics: {
        legacyIsGeneric: false,
        legacyValidationPassed: true,
        legacyValidationScore: 96,
        legacyValidationRejections: [],
      },
    },
    decision: "approved",
    score: 96,
    hardIssueCodes: [],
    warningCodes: [],
    ...overrides,
  };
}

function buildStrategyAuthority(): CreativeStrategyAuthority {
  return Object.freeze({
    strategySnapshotId: "strategy_abc123",
    strategyVersion: 4,
    businessDnaSnapshotId: "bizdna-30-v1",
    strategyHashSha256: SHA_B,
    strategyRunId: 913,
    approvalRequestId: 57,
    creativeBriefFingerprint: "brief-fingerprint-30",
  });
}

function buildLineageInput(
  overrides: Partial<CreativeArtifactLineageInput> = {}
): CreativeArtifactLineageInput {
  return {
    artifactKind: "platform_caption",
    platform: "instagram",
    parent: { artifactKind: "message_pack" },
    strategy: creativeArtifactStrategyLineageFromAuthority(buildStrategyAuthority()),
    approvedCopy: creativeArtifactApprovedCopyLineageFromEnvelope(buildEnvelope()),
    ...overrides,
  };
}

describe("creative artifact lineage", () => {
  it("derives a deterministic fingerprint regardless of key order", () => {
    const fingerprintA = deriveCreativeArtifactLineageFingerprint(buildLineageInput());
    const reordered = {
      approvedCopy: {
        contextLockId: "ctx-30-1",
        approvedRevisionId: "rev-30-1",
        copySchemaVersion: "v2.1",
        copyHashSha256: SHA_A.toUpperCase(),
        assessmentHashSha256: SHA_D,
      },
      parent: { artifactKind: "message_pack" },
      strategy: {
        creativeBriefFingerprint: "brief-fingerprint-30",
        approvalRequestId: 57,
        strategyRunId: 913,
        strategyHashSha256: SHA_B.toUpperCase(),
        businessDnaSnapshotId: "bizdna-30-v1",
        strategyVersion: 4,
        strategySnapshotId: "strategy_abc123",
      },
      artifactKind: "platform_caption",
      platform: "instagram",
    } as unknown as CreativeArtifactLineageInput;

    expect(deriveCreativeArtifactLineageFingerprint(reordered)).toBe(fingerprintA);
    expect(fingerprintA).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes the fingerprint when any authority coordinate changes", () => {
    const base = deriveCreativeArtifactLineageFingerprint(buildLineageInput());

    const copyChanged = buildLineageInput({
      approvedCopy: {
        ...creativeArtifactApprovedCopyLineageFromEnvelope(buildEnvelope()),
        copyHashSha256: SHA_C,
      },
    });
    expect(deriveCreativeArtifactLineageFingerprint(copyChanged)).not.toBe(base);

    const strategyChanged = buildLineageInput({
      strategy: {
        ...creativeArtifactStrategyLineageFromAuthority(buildStrategyAuthority()),
        strategyRunId: 914,
      },
    });
    expect(deriveCreativeArtifactLineageFingerprint(strategyChanged)).not.toBe(base);

    const platformChanged = buildLineageInput({ platform: "tiktok" });
    expect(deriveCreativeArtifactLineageFingerprint(platformChanged)).not.toBe(base);
  });

  it("keeps one semantic authority for formatting-only caption changes", () => {
    // The lineage fingerprint covers authority coordinates only — never raw
    // caption text — so reformatting a platform caption cannot mint a new
    // semantic authority.
    const lineage = buildLineageInput();
    const persisted = buildPersistedCreativeArtifactLineage(lineage);

    const replayed = buildPersistedCreativeArtifactLineage({
      ...lineage,
      platform: "instagram",
    });

    expect(replayed).toEqual(persisted);
    expect(replayed.lineageFingerprintSha256).toBe(
      deriveCreativeArtifactLineageFingerprint(lineage)
    );
  });

  it("builds a deep-frozen persisted record carrying the fingerprint", () => {
    const persisted = buildPersistedCreativeArtifactLineage(buildLineageInput());

    expect(persisted.lineageSchemaVersion).toBe(
      CREATIVE_ARTIFACT_LINEAGE_SCHEMA_VERSION
    );
    expect(persisted.lineageFingerprintSha256).toBe(
      deriveCreativeArtifactLineageFingerprint(buildLineageInput())
    );
    expect(persisted.artifactKind).toBe("platform_caption");
    expect(persisted.platform).toBe("instagram");
    expect(persisted.parent).toEqual({ artifactKind: "message_pack", artifactId: null });
    expect(Object.isFrozen(persisted)).toBe(true);
    expect(Object.isFrozen(persisted.strategy)).toBe(true);
    expect(Object.isFrozen(persisted.approvedCopy)).toBe(true);
  });

  it("fails closed on malformed lineage input", () => {
    expect(() =>
      normalizeCreativeArtifactLineage({
        ...buildLineageInput(),
        artifactKind: "banner" as any,
      })
    ).toThrowError(/artifactKind/);

    expect(() =>
      normalizeCreativeArtifactLineage({
        ...buildLineageInput(),
        approvedCopy: {
          ...creativeArtifactApprovedCopyLineageFromEnvelope(buildEnvelope()),
          copyHashSha256: "not-a-hash",
        },
      })
    ).toThrowError(/copyHashSha256/);

    expect(() =>
      normalizeCreativeArtifactLineage({
        ...buildLineageInput(),
        strategy: {
          ...creativeArtifactStrategyLineageFromAuthority(buildStrategyAuthority()),
          strategySnapshotId: "",
        },
      })
    ).toThrowError(/strategySnapshotId/);

    expect(() =>
      normalizeCreativeArtifactLineage({
        ...buildLineageInput(),
        parent: { artifactKind: "message_pack", artifactId: -1 },
      })
    ).toThrowError(/artifactId/);

    expect(() =>
      normalizeCreativeArtifactLineage(null as any)
    ).toThrowError(/expected an object/);
  });

  it("accepts the WBS12.5/WBS12.6 video/script and non-social format kinds", () => {
    const kinds = [
      "video_script",
      "email_copy",
      "whatsapp_copy",
      "ad_copy",
      "carousel_ad",
      "launch_pack",
    ] as const;

    for (const artifactKind of kinds) {
      const normalized = normalizeCreativeArtifactLineage({
        artifactKind,
        platform: null,
        parent: { artifactKind: "message_pack" },
        strategy: creativeArtifactStrategyLineageFromAuthority(buildStrategyAuthority()),
        approvedCopy: creativeArtifactApprovedCopyLineageFromEnvelope(buildEnvelope()),
      });
      expect(normalized.artifactKind).toBe(artifactKind);
      expect(() =>
        assertPersistedCreativeArtifactLineageIntact(
          buildPersistedCreativeArtifactLineage({
            artifactKind,
            platform: null,
            parent: { artifactKind: "message_pack" },
            strategy: creativeArtifactStrategyLineageFromAuthority(buildStrategyAuthority()),
            approvedCopy: creativeArtifactApprovedCopyLineageFromEnvelope(buildEnvelope()),
          })
        )
      ).not.toThrow();
    }
  });

  it("allows null strategy/approvedCopy for envelope-less legacy artifacts", () => {
    const normalized = normalizeCreativeArtifactLineage({
      artifactKind: "message_pack",
      platform: null,
      parent: null,
      strategy: null,
      approvedCopy: null,
    });

    expect(normalized.strategy).toBeNull();
    expect(normalized.approvedCopy).toBeNull();
  });

  it("passes the tamper check for an honest persisted record", () => {
    const persisted = buildPersistedCreativeArtifactLineage(buildLineageInput());
    expect(() =>
      assertPersistedCreativeArtifactLineageIntact(persisted)
    ).not.toThrow();
  });

  it("fails closed when a persisted lineage coordinate was tampered with", () => {
    const persisted = buildPersistedCreativeArtifactLineage(buildLineageInput());

    const tamperedCopy = {
      ...persisted,
      approvedCopy: {
        ...persisted.approvedCopy!,
        approvedRevisionId: "rev-attacker",
      },
    };
    expect(() =>
      assertPersistedCreativeArtifactLineageIntact(tamperedCopy as any)
    ).toThrowError(/fingerprint mismatch/);

    const tamperedSchema = { ...persisted, lineageSchemaVersion: 99 as any };
    expect(() =>
      assertPersistedCreativeArtifactLineageIntact(tamperedSchema)
    ).toThrowError(/schema version/);

    expect(() =>
      assertPersistedCreativeArtifactLineageIntact(null as any)
    ).toThrowError(/missing or malformed/);
  });

  it("binds a persisted lineage to its approval envelope and fails on divergence", () => {
    const envelope = buildEnvelope();
    const persisted = buildPersistedCreativeArtifactLineage({
      artifactKind: "message_pack",
      platform: null,
      parent: null,
      strategy: creativeArtifactStrategyLineageFromEnvelope(envelope),
      approvedCopy: creativeArtifactApprovedCopyLineageFromEnvelope(envelope),
    });

    expect(() =>
      assertCreativeArtifactLineageMatchesEnvelope(persisted, envelope)
    ).not.toThrow();

    const swappedEnvelope = buildEnvelope({ copyHashSha256: SHA_C });
    expect(() =>
      assertCreativeArtifactLineageMatchesEnvelope(persisted, swappedEnvelope)
    ).toThrowError(/approved-copy coordinates diverge/);

    const movedStrategy = buildEnvelope({ campaignStrategySnapshotId: "strategy-OTHER" });
    expect(() =>
      assertCreativeArtifactLineageMatchesEnvelope(persisted, movedStrategy)
    ).toThrowError(/Strategy coordinates diverge/);

    const noCopy = buildPersistedCreativeArtifactLineage({
      artifactKind: "hashtag_set",
      platform: null,
      parent: null,
      strategy: creativeArtifactStrategyLineageFromEnvelope(envelope),
      approvedCopy: null,
    });
    expect(() =>
      assertCreativeArtifactLineageMatchesEnvelope(noCopy, envelope)
    ).toThrowError(/no approved-copy coordinates/);
  });

  it("maps Creative Strategy authority onto full lineage coordinates", () => {
    const authority = buildStrategyAuthority();
    const strategy = creativeArtifactStrategyLineageFromAuthority(authority);

    expect(strategy).toEqual({
      strategySnapshotId: authority.strategySnapshotId,
      strategyVersion: authority.strategyVersion,
      businessDnaSnapshotId: authority.businessDnaSnapshotId,
      strategyHashSha256: authority.strategyHashSha256,
      strategyRunId: authority.strategyRunId,
      approvalRequestId: authority.approvalRequestId,
      creativeBriefFingerprint: authority.creativeBriefFingerprint,
    });
  });

  it("maps an envelope onto envelope-domain strategy coordinates with null run coordinates", () => {
    const envelope = buildEnvelope();
    const strategy = creativeArtifactStrategyLineageFromEnvelope(envelope);

    expect(strategy).toEqual({
      strategySnapshotId: envelope.campaignStrategySnapshotId,
      strategyVersion: null,
      businessDnaSnapshotId: envelope.businessDnaSnapshotId,
      strategyHashSha256: envelope.strategyHashSha256,
      strategyRunId: null,
      approvalRequestId: null,
      creativeBriefFingerprint: null,
    });
  });

  it("maps an envelope onto approved-copy lineage coordinates", () => {
    const envelope = buildEnvelope();
    expect(creativeArtifactApprovedCopyLineageFromEnvelope(envelope)).toEqual({
      copyHashSha256: envelope.copyHashSha256,
      copySchemaVersion: envelope.copySchemaVersion,
      approvedRevisionId: envelope.approvedRevisionId,
      assessmentHashSha256: envelope.assessmentHashSha256,
      contextLockId: envelope.contextLockId,
    });
  });
});
