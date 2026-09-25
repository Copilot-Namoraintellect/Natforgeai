import { describe, it, expect } from "vitest";
import {
  assertValidImageRenderLineage,
  buildPersistedImageRenderLineage,
  deriveImageRenderLineageFingerprint,
  imageRenderApprovedCopyLineageFromPack,
  imageRenderStrategyLineageFromAuthority,
  IMAGE_RENDER_LINEAGE_SCHEMA_VERSION,
  type ImageRenderLineageInput,
} from "./image-render-lineage";
import type { CreativeStrategyAuthority } from "./strategy-authority";

const HEX64 = /^[0-9a-f]{64}$/;
const STRATEGY_HASH_A = "ab".repeat(32);
const STRATEGY_HASH_B = "cd".repeat(32);
const COPY_HASH_A = "ef".repeat(32);
const COPY_HASH_B = "12".repeat(32);

function makeLineage(
  overrides: Record<string, unknown> = {}
): ImageRenderLineageInput {
  return {
    contentPostId: 13,
    strategy: {
      strategySnapshotId: "strategy_" + "a1".repeat(24),
      strategyVersion: 3,
      businessDnaSnapshotId: "dna_snapshot_0001",
      strategyHashSha256: STRATEGY_HASH_A,
      strategyRunId: 41,
      creativeBriefFingerprint: "brief-fingerprint-0001",
      approvalRequestId: 99,
    },
    approvedCopy: {
      copyHashSha256: COPY_HASH_A,
      copySchemaVersion: "v2.1",
      approvedRevisionId: "revision-0001",
    },
    ...overrides,
  } as ImageRenderLineageInput;
}

describe("deriveImageRenderLineageFingerprint", () => {
  it("returns a 64-character lowercase SHA-256 hex digest", () => {
    expect(deriveImageRenderLineageFingerprint(makeLineage())).toMatch(HEX64);
  });

  it("is deterministic for identical inputs", () => {
    const a = deriveImageRenderLineageFingerprint(makeLineage());
    const b = deriveImageRenderLineageFingerprint(makeLineage());
    expect(a).toBe(b);
  });

  it("is independent of object key order", () => {
    const forward = makeLineage();
    const strategy = forward.strategy as unknown as Record<string, unknown>;
    const copy = forward.approvedCopy as unknown as Record<string, unknown>;
    const reversed = {
      approvedCopy: {
        approvedRevisionId: copy.approvedRevisionId,
        copyHashSha256: copy.copyHashSha256,
        copySchemaVersion: copy.copySchemaVersion,
      },
      contentPostId: forward.contentPostId,
      strategy: {
        approvalRequestId: strategy.approvalRequestId,
        businessDnaSnapshotId: strategy.businessDnaSnapshotId,
        creativeBriefFingerprint: strategy.creativeBriefFingerprint,
        strategyHashSha256: strategy.strategyHashSha256,
        strategyRunId: strategy.strategyRunId,
        strategySnapshotId: strategy.strategySnapshotId,
        strategyVersion: strategy.strategyVersion,
      },
    } as unknown as ImageRenderLineageInput;
    expect(deriveImageRenderLineageFingerprint(reversed)).toBe(
      deriveImageRenderLineageFingerprint(forward)
    );
  });

  it("normalizes hash casing before fingerprinting", () => {
    const upper = makeLineage({
      strategy: {
        ...makeLineage().strategy,
        strategyHashSha256: STRATEGY_HASH_A.toUpperCase(),
      },
      approvedCopy: {
        ...makeLineage().approvedCopy!,
        copyHashSha256: COPY_HASH_A.toUpperCase(),
      },
    });
    expect(deriveImageRenderLineageFingerprint(upper)).toBe(
      deriveImageRenderLineageFingerprint(makeLineage())
    );
  });

  it("changes the fingerprint when any authority coordinate changes", () => {
    const base = deriveImageRenderLineageFingerprint(makeLineage());
    const variants: ImageRenderLineageInput[] = [
      makeLineage({ contentPostId: 14 }),
      makeLineage({
        strategy: { ...makeLineage().strategy, strategySnapshotId: "strategy_x" },
      }),
      makeLineage({
        strategy: { ...makeLineage().strategy, strategyVersion: 4 },
      }),
      makeLineage({
        strategy: { ...makeLineage().strategy, businessDnaSnapshotId: "dna_2" },
      }),
      makeLineage({
        strategy: { ...makeLineage().strategy, strategyHashSha256: STRATEGY_HASH_B },
      }),
      makeLineage({
        strategy: { ...makeLineage().strategy, strategyRunId: 42 },
      }),
      makeLineage({
        strategy: {
          ...makeLineage().strategy,
          creativeBriefFingerprint: "brief-fingerprint-0002",
        },
      }),
      makeLineage({
        strategy: { ...makeLineage().strategy, approvalRequestId: 100 },
      }),
      makeLineage({
        approvedCopy: { ...makeLineage().approvedCopy!, copyHashSha256: COPY_HASH_B },
      }),
      makeLineage({
        approvedCopy: { ...makeLineage().approvedCopy!, copySchemaVersion: "v3" },
      }),
      makeLineage({
        approvedCopy: {
          ...makeLineage().approvedCopy!,
          approvedRevisionId: "revision-0002",
        },
      }),
      makeLineage({ approvedCopy: null }),
    ];
    for (const variant of variants) {
      expect(deriveImageRenderLineageFingerprint(variant)).not.toBe(base);
    }
  });

  it("treats absent and explicit-null approvedCopy identically", () => {
    const absent = makeLineage({ approvedCopy: undefined });
    const explicitNull = makeLineage({ approvedCopy: null });
    expect(deriveImageRenderLineageFingerprint(absent)).toBe(
      deriveImageRenderLineageFingerprint(explicitNull)
    );
  });

  it("fails closed on malformed lineage", () => {
    const bad: Array<() => ImageRenderLineageInput> = [
      () => makeLineage({ contentPostId: 0 }),
      () => makeLineage({ contentPostId: 1.5 }),
      () =>
        makeLineage({
          strategy: { ...makeLineage().strategy, strategySnapshotId: "  " },
        }),
      () =>
        makeLineage({ strategy: { ...makeLineage().strategy, strategyVersion: 0 } }),
      () =>
        makeLineage({
          strategy: { ...makeLineage().strategy, strategyHashSha256: "zz" },
        }),
      () =>
        makeLineage({
          strategy: { ...makeLineage().strategy, strategyRunId: -1 },
        }),
      () =>
        makeLineage({
          strategy: {
            ...makeLineage().strategy,
            creativeBriefFingerprint: "",
          },
        }),
      () =>
        makeLineage({
          strategy: { ...makeLineage().strategy, approvalRequestId: NaN },
        }),
      () =>
        makeLineage({
          approvedCopy: { ...makeLineage().approvedCopy!, copyHashSha256: "short" },
        }),
      () =>
        makeLineage({
          approvedCopy: { ...makeLineage().approvedCopy!, copySchemaVersion: "" },
        }),
      () =>
        makeLineage({
          approvedCopy: { ...makeLineage().approvedCopy!, approvedRevisionId: 7 },
        }) as unknown as ImageRenderLineageInput,
    ];
    for (const build of bad) {
      expect(() => deriveImageRenderLineageFingerprint(build())).toThrow(
        /Invalid lineage/
      );
    }
  });
});

describe("assertValidImageRenderLineage", () => {
  it("accepts a well-formed lineage", () => {
    expect(() => assertValidImageRenderLineage(makeLineage())).not.toThrow();
  });

  it("rejects malformed lineage", () => {
    expect(() =>
      assertValidImageRenderLineage(
        makeLineage({
          strategy: { ...makeLineage().strategy, strategyHashSha256: "x" },
        })
      )
    ).toThrow(/Invalid lineage strategyHashSha256/);
  });
});

describe("buildPersistedImageRenderLineage", () => {
  it("embeds the matching fingerprint and normalized hashes", () => {
    const lineage = makeLineage();
    const persisted = buildPersistedImageRenderLineage(lineage);
    expect(persisted.lineageSchemaVersion).toBe(
      IMAGE_RENDER_LINEAGE_SCHEMA_VERSION
    );
    expect(persisted.contentPostId).toBe(13);
    expect(persisted.lineageFingerprintSha256).toBe(
      deriveImageRenderLineageFingerprint(lineage)
    );
    expect(persisted.strategy.strategyHashSha256).toBe(STRATEGY_HASH_A);
    expect(persisted.approvedCopy?.copyHashSha256).toBe(COPY_HASH_A);
  });

  it("normalizes uppercase hashes in the persisted record", () => {
    const lineage = makeLineage({
      strategy: {
        ...makeLineage().strategy,
        strategyHashSha256: STRATEGY_HASH_A.toUpperCase(),
      },
    });
    const persisted = buildPersistedImageRenderLineage(lineage);
    expect(persisted.strategy.strategyHashSha256).toBe(STRATEGY_HASH_A);
    expect(persisted.lineageFingerprintSha256).toBe(
      deriveImageRenderLineageFingerprint(makeLineage())
    );
  });

  it("records approvedCopy as null when absent", () => {
    const persisted = buildPersistedImageRenderLineage(
      makeLineage({ approvedCopy: undefined })
    );
    expect(persisted.approvedCopy).toBeNull();
  });

  it("returns a deeply frozen record", () => {
    const persisted = buildPersistedImageRenderLineage(makeLineage());
    expect(Object.isFrozen(persisted)).toBe(true);
    expect(Object.isFrozen(persisted.strategy)).toBe(true);
    expect(Object.isFrozen(persisted.approvedCopy)).toBe(true);
  });
});

describe("authority adapters (WBS12C dependency)", () => {
  it("projects CreativeStrategyAuthority onto strategy lineage", () => {
    const authority: CreativeStrategyAuthority = {
      strategySnapshotId: "strategy_" + "b2".repeat(24),
      strategyVersion: 5,
      businessDnaSnapshotId: "dna_snapshot_0009",
      strategyHashSha256: STRATEGY_HASH_B,
      strategyRunId: 77,
      approvalRequestId: 55,
      creativeBriefFingerprint: "brief-fingerprint-0009",
    };
    const lineage: ImageRenderLineageInput = {
      contentPostId: 21,
      strategy: imageRenderStrategyLineageFromAuthority(authority),
    };
    expect(lineage.strategy).toEqual({
      strategySnapshotId: authority.strategySnapshotId,
      strategyVersion: authority.strategyVersion,
      businessDnaSnapshotId: authority.businessDnaSnapshotId,
      strategyHashSha256: authority.strategyHashSha256,
      strategyRunId: authority.strategyRunId,
      creativeBriefFingerprint: authority.creativeBriefFingerprint,
      approvalRequestId: authority.approvalRequestId,
    });
    expect(deriveImageRenderLineageFingerprint(lineage)).toMatch(HEX64);
  });

  it("projects an approved message pack onto copy lineage", () => {
    const pack = {
      copyHashSha256: COPY_HASH_B,
      approvedRevisionId: "revision-0100",
      copy: { copySchemaVersion: "v2.1" },
    };
    const lineage = makeLineage({
      approvedCopy: imageRenderApprovedCopyLineageFromPack(pack),
    });
    expect(lineage.approvedCopy).toEqual({
      copyHashSha256: COPY_HASH_B,
      copySchemaVersion: "v2.1",
      approvedRevisionId: "revision-0100",
    });
    expect(deriveImageRenderLineageFingerprint(lineage)).toMatch(HEX64);
  });
});
