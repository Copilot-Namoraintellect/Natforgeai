import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";

import {
  PUBLISH_PACKAGE_SCHEMA_VERSION,
  type PublishPackage,
} from "./publish-package-contract";
import {
  buildPublishPackage,
  type PublishPackageBuildInput,
} from "./publish-package-builder";
import { deriveCreativeArtifactLineageFingerprint } from "../creative/artifact-lineage";
import {
  PERSISTED_PUBLISH_PACKAGE_ENVELOPE_KIND,
  QUEUE_PUBLISH_PACKAGE_METADATA_KEY,
  QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY,
  assertQueuePublishPackageIntegrity,
  loadPersistedPublishPackage,
  persistedPublishPackageToCanonicalJson,
  resolveQueuePublishPackage,
  serializePublishPackageForQueue,
  type QueuePublishPackageMetadata,
} from "./publish-package-queue-store";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

const STRATEGY = {
  strategySnapshotId: "strategy_snapshot_1",
  strategyVersion: 3,
  businessDnaSnapshotId: "bdna_1",
  strategyHashSha256: HASH_A,
  strategyRunId: 55,
  approvalRequestId: 77,
  creativeBriefFingerprint: "brief_fp_1",
};

const APPROVED_COPY = {
  copyHashSha256: HASH_B,
  copySchemaVersion: "v2",
  approvedRevisionId: "rev-1",
  assessmentHashSha256: HASH_C,
  contextLockId: "ctx-1",
};

const MEDIA_URL = "https://cdn.example.com/img.png";
const PAYLOAD_TEXT = "Hook\n\nCaption\n\nCTA";

function captionLineage() {
  return {
    lineageSchemaVersion: 1,
    artifactKind: "caption_pack",
    artifactId: 501,
    lineageFingerprintSha256: deriveCreativeArtifactLineageFingerprint({
      artifactKind: "caption_pack",
      platform: null,
      parent: null,
      strategy: STRATEGY,
      approvedCopy: APPROVED_COPY,
    }),
    strategy: STRATEGY,
    approvedCopy: APPROVED_COPY,
  };
}

function governedInput(overrides: Record<string, unknown> = {}): PublishPackageBuildInput {
  return {
    campaignId: 7,
    userId: 9,
    businessId: 4,
    destination: { platform: "instagram", integrationId: 7 },
    intent: { mode: "immediate" },
    strategyAuthority: STRATEGY,
    approvedCopy: APPROVED_COPY,
    selectedContent: {
      contentPostId: 125,
      artifactKind: "content_post",
      lineage: {
        lineageSchemaVersion: 1,
        artifactKind: "content_post",
        artifactId: 125,
        lineageFingerprintSha256: HASH_D,
        strategy: STRATEGY,
        approvedCopy: APPROVED_COPY,
      },
    },
    captionArtifact: { artifactId: 501, artifactKind: "caption_pack", lineage: captionLineage() },
    visualArtifact: {
      mediaKind: "image",
      generatedAssetId: 909,
      mediaUrl: MEDIA_URL,
      renderLineage: {
        lineageFingerprintSha256: HASH_E,
        strategy: STRATEGY,
        approvedCopy: APPROVED_COPY,
      },
    },
    evidence: { launchApprovalRequestId: 1 },
    payload: { text: PAYLOAD_TEXT, mediaUrls: [MEDIA_URL], mediaType: "image" },
    ...overrides,
  } as PublishPackageBuildInput;
}

function buildGovernedPackage(): PublishPackage {
  return buildPublishPackage(governedInput());
}

function buildLegacyPackage(): PublishPackage {
  return buildPublishPackage(
    governedInput({
      strategyAuthority: null,
      approvedCopy: null,
      captionArtifact: null,
      visualArtifact: null,
      selectedContent: { contentPostId: 125, artifactKind: "content_post", lineage: null },
    })
  );
}

/** Simulate the database round trip: JSON serialize + parse the metadata. */
function dbRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Clone persisted metadata and mutate the clone (the original stays frozen). */
function tampered(
  metadata: QueuePublishPackageMetadata,
  mutate: (clone: any) => void
): unknown {
  const clone = dbRoundTrip(metadata);
  mutate(clone);
  return clone;
}

describe("serializePublishPackageForQueue", () => {
  it("stores the governed marker and a self-authenticating envelope", () => {
    const pkg = buildGovernedPackage();
    const metadata = serializePublishPackageForQueue(pkg);

    expect(metadata[QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY]).toBe(true);
    const envelope = metadata[QUEUE_PUBLISH_PACKAGE_METADATA_KEY];
    expect(envelope.kind).toBe(PERSISTED_PUBLISH_PACKAGE_ENVELOPE_KIND);
    expect(envelope.schemaVersion).toBe(PUBLISH_PACKAGE_SCHEMA_VERSION);
    expect(envelope.publishPackage).toBe(pkg);
    expect(envelope.payloadDigestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is pure and idempotent — no duplicate persistence, input never mutated", () => {
    const pkg = buildGovernedPackage();
    const before = persistedPublishPackageToCanonicalJson(pkg);

    const a = serializePublishPackageForQueue(pkg);
    const b = serializePublishPackageForQueue(pkg);

    expect(a).toEqual(b);
    expect(a).not.toBe(b); // fresh frozen fragment each call, deeply equal
    expect(a[QUEUE_PUBLISH_PACKAGE_METADATA_KEY]).not.toBe(
      b[QUEUE_PUBLISH_PACKAGE_METADATA_KEY]
    );
    expect(persistedPublishPackageToCanonicalJson(pkg)).toBe(before);
    expect(Object.isFrozen(pkg)).toBe(true);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a[QUEUE_PUBLISH_PACKAGE_METADATA_KEY])).toBe(true);
  });

  it("refuses to persist a package that fails integrity verification", () => {
    const pkg = buildGovernedPackage();
    const tamperedPkg: any = dbRoundTrip(pkg);
    tamperedPkg.identity.campaignId = 999;

    expect(() =>
      serializePublishPackageForQueue(tamperedPkg as PublishPackage)
    ).toThrowError(TRPCError);
  });
});

describe("loadPersistedPublishPackage round trip", () => {
  it("reloads the exact governed package after a database JSON round trip", () => {
    const pkg = buildGovernedPackage();
    const metadata = dbRoundTrip(serializePublishPackageForQueue(pkg));

    const loaded = loadPersistedPublishPackage(metadata);

    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(pkg);
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  it("preserves packageId, fingerprint, classification, and destination", () => {
    const pkg = buildGovernedPackage();
    const metadata = dbRoundTrip(serializePublishPackageForQueue(pkg));
    const loaded = loadPersistedPublishPackage(metadata)!;

    expect(loaded.packageId).toBe(pkg.packageId);
    expect(loaded.packageFingerprintSha256).toBe(pkg.packageFingerprintSha256);
    expect(loaded.classification).toBe("governed");
    expect(loaded.legacyReasons).toEqual([]);
    expect(loaded.identity.destination).toEqual(pkg.identity.destination);
    expect(loaded.identity.campaignId).toBe(pkg.identity.campaignId);
    expect(loaded.identity.userId).toBe(pkg.identity.userId);
    expect(loaded.identity.selectedContent).toEqual(pkg.identity.selectedContent);
    expect(loaded.identity.strategyAuthority).toEqual(pkg.identity.strategyAuthority);
    expect(loaded.identity.approvedCopy).toEqual(pkg.identity.approvedCopy);
  });

  it("preserves the payload byte-for-byte", () => {
    const pkg = buildGovernedPackage();
    const metadata = dbRoundTrip(serializePublishPackageForQueue(pkg));
    const loaded = loadPersistedPublishPackage(metadata)!;

    expect(loaded.payload.text).toBe(PAYLOAD_TEXT);
    expect(loaded.payload.text).toBe(pkg.payload.text);
    expect(JSON.stringify(loaded.payload)).toBe(JSON.stringify(pkg.payload));
  });

  it("reloads a legacy-classified package with its explicit reasons intact", () => {
    const pkg = buildLegacyPackage();
    expect(pkg.classification).toBe("legacy");
    expect(pkg.legacyReasons.length).toBeGreaterThan(0);

    const metadata = dbRoundTrip(serializePublishPackageForQueue(pkg));
    const loaded = loadPersistedPublishPackage(metadata)!;

    expect(loaded.classification).toBe("legacy");
    expect(loaded.legacyReasons).toEqual(pkg.legacyReasons);
    expect(loaded).toEqual(pkg);
  });

  it("reloads the same package identity on every retry", () => {
    const pkg = buildGovernedPackage();
    // Persisted once at queue creation; every later attempt loads these same bytes.
    const persistedBytes = dbRoundTrip(serializePublishPackageForQueue(pkg));

    const firstAttempt = loadPersistedPublishPackage(persistedBytes)!;
    const retryAttempt = loadPersistedPublishPackage(persistedBytes)!;

    expect(firstAttempt.packageId).toBe(pkg.packageId);
    expect(retryAttempt.packageId).toBe(pkg.packageId);
    expect(retryAttempt.packageFingerprintSha256).toBe(pkg.packageFingerprintSha256);
    expect(retryAttempt).toEqual(firstAttempt);
  });
});

describe("load-time integrity (tamper rejection)", () => {
  it("rejects a tampered identity coordinate", () => {
    const metadata = serializePublishPackageForQueue(buildGovernedPackage());
    const tamperedIdentity = tampered(metadata, (clone) => {
      clone[QUEUE_PUBLISH_PACKAGE_METADATA_KEY].publishPackage.identity.campaignId = 999;
    });

    expect(() => loadPersistedPublishPackage(tamperedIdentity)).toThrowError(TRPCError);
    expect(resolveQueuePublishPackage(tamperedIdentity)).toEqual({
      kind: "invalid",
      reason: expect.stringContaining("fingerprint"),
    });
  });

  it("rejects a tampered fingerprint field", () => {
    const metadata = serializePublishPackageForQueue(buildGovernedPackage());
    const tamperedFingerprint = tampered(metadata, (clone) => {
      clone[QUEUE_PUBLISH_PACKAGE_METADATA_KEY].publishPackage.packageFingerprintSha256 =
        "f".repeat(64);
    });

    expect(() => loadPersistedPublishPackage(tamperedFingerprint)).toThrowError(
      /fingerprint mismatch/i
    );
  });

  it("rejects a tampered packageId", () => {
    const metadata = serializePublishPackageForQueue(buildGovernedPackage());
    const tamperedId = tampered(metadata, (clone) => {
      clone[QUEUE_PUBLISH_PACKAGE_METADATA_KEY].publishPackage.packageId = "ppv1-forged";
    });

    expect(() => loadPersistedPublishPackage(tamperedId)).toThrowError(
      /package id does not match/i
    );
  });

  it("rejects a tampered frozen payload even though the payload never feeds the identity fingerprint", () => {
    const metadata = serializePublishPackageForQueue(buildGovernedPackage());
    const tamperedPayload = tampered(metadata, (clone) => {
      clone[QUEUE_PUBLISH_PACKAGE_METADATA_KEY].publishPackage.payload.text =
        "silently swapped caption";
    });

    expect(() => loadPersistedPublishPackage(tamperedPayload)).toThrowError(
      /payload digest mismatch/i
    );
  });

  it("rejects a tampered media url list", () => {
    const metadata = serializePublishPackageForQueue(buildGovernedPackage());
    const tamperedMedia = tampered(metadata, (clone) => {
      clone[QUEUE_PUBLISH_PACKAGE_METADATA_KEY].publishPackage.payload.mediaUrls = [
        "https://evil.example.com/swap.png",
      ];
    });

    expect(resolveQueuePublishPackage(tamperedMedia).kind).toBe("invalid");
  });

  it("rejects envelope shape tampering", () => {
    const metadata = serializePublishPackageForQueue(buildGovernedPackage());
    const wrongKind = tampered(metadata, (clone) => {
      clone[QUEUE_PUBLISH_PACKAGE_METADATA_KEY].kind = "not_a_package";
    });
    const wrongVersion = tampered(metadata, (clone) => {
      clone[QUEUE_PUBLISH_PACKAGE_METADATA_KEY].schemaVersion = 999;
    });
    const missingDigest = tampered(metadata, (clone) => {
      delete clone[QUEUE_PUBLISH_PACKAGE_METADATA_KEY].payloadDigestSha256;
    });

    for (const tamperedEnvelope of [wrongKind, wrongVersion, missingDigest]) {
      expect(() => loadPersistedPublishPackage(tamperedEnvelope)).toThrowError(TRPCError);
      expect(resolveQueuePublishPackage(tamperedEnvelope).kind).toBe("invalid");
    }
  });

  it("rejects a non-object envelope", () => {
    expect(() =>
      loadPersistedPublishPackage({ [QUEUE_PUBLISH_PACKAGE_METADATA_KEY]: "not-an-object" })
    ).toThrowError(/envelope is missing or malformed/i);
  });
});

describe("fail-closed governed marking", () => {
  it("fails closed when a governed-marked row has no persisted package", () => {
    const governedWithoutPackage = { [QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY]: true };

    const resolution = resolveQueuePublishPackage(governedWithoutPackage);
    expect(resolution.kind).toBe("invalid");
    expect(() => loadPersistedPublishPackage(governedWithoutPackage)).toThrowError(
      /marked governed but has no persisted publish package/i
    );
  });

  it("fails closed when the envelope was stripped but the governed marker remains", () => {
    const metadata = dbRoundTrip(serializePublishPackageForQueue(buildGovernedPackage()));
    delete (metadata as any)[QUEUE_PUBLISH_PACKAGE_METADATA_KEY];

    expect(resolveQueuePublishPackage(metadata).kind).toBe("invalid");
    expect(() => loadPersistedPublishPackage(metadata)).toThrowError(TRPCError);
  });
});

describe("legacy compatibility", () => {
  it.each([
    ["null metadata", null],
    ["undefined metadata", undefined],
    ["empty object", {}],
    ["unrelated metadata keys", { lastSyncNote: "something" }],
    ["metadata array", []],
    ["metadata scalar", "legacy"],
  ])("treats %s as a legacy row and never fabricates a package", (_label, metadata) => {
    expect(loadPersistedPublishPackage(metadata)).toBeNull();
    expect(resolveQueuePublishPackage(metadata)).toEqual({ kind: "legacy" });
  });
});

describe("assertQueuePublishPackageIntegrity", () => {
  it("returns the deep-frozen package for a valid envelope", () => {
    const pkg = buildGovernedPackage();
    const envelope = serializePublishPackageForQueue(pkg)[QUEUE_PUBLISH_PACKAGE_METADATA_KEY];

    const verified = assertQueuePublishPackageIntegrity(dbRoundTrip(envelope));

    expect(verified).toEqual(pkg);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(verified.packageId).toBe(pkg.packageId);
  });

  it("rejects a bare package that was never persisted through the envelope", () => {
    expect(() => assertQueuePublishPackageIntegrity(buildGovernedPackage())).toThrowError(
      TRPCError
    );
    expect(() => assertQueuePublishPackageIntegrity(buildGovernedPackage())).toThrowError(
      /envelope/i
    );
  });
});

describe("canonical serialization", () => {
  it("produces identical bytes regardless of object key order", () => {
    const pkg = buildGovernedPackage();
    const reordered = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reordered);
      if (value && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        return Object.fromEntries(
          Object.keys(obj)
            .reverse()
            .map((key) => [key, reordered(obj[key])])
        );
      }
      return value;
    };

    expect(persistedPublishPackageToCanonicalJson(reordered(pkg) as PublishPackage)).toBe(
      persistedPublishPackageToCanonicalJson(pkg)
    );
  });

  it("refuses canonical serialization of an invalid package", () => {
    const pkg: any = dbRoundTrip(buildGovernedPackage());
    pkg.identity.destination.platform = "changed-after-assembly";
    expect(() => persistedPublishPackageToCanonicalJson(pkg as PublishPackage)).toThrowError(
      TRPCError
    );
  });
});
