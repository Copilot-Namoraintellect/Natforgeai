import {
  describe,
  expect,
  it,
} from "vitest";

import {
  buildStrategySnapshot,
  type StrategySnapshot,
} from "./strategy-snapshot";

import {
  persistImmutableStrategySnapshot,
  StrategySnapshotConflictError,
  type PersistedStrategySnapshot,
  type StrategySnapshotPersistence,
} from "./strategy-snapshot-store";

class FakePersistence
  implements StrategySnapshotPersistence {
  private readonly records =
    new Map<
      number,
      PersistedStrategySnapshot
    >();

  insertCount = 0;

  duplicateOnInsert = false;

  duplicateReplacement:
    PersistedStrategySnapshot | null =
      null;

  seed(
    snapshot: PersistedStrategySnapshot
  ): void {
    this.records.set(
      snapshot.strategyRunId,
      snapshot
    );
  }

  async findByStrategyRunId(
    strategyRunId: number
  ): Promise<PersistedStrategySnapshot | null> {
    return (
      this.records.get(
        strategyRunId
      ) ??
      null
    );
  }

  async insert(
    snapshot: StrategySnapshot
  ): Promise<PersistedStrategySnapshot> {
    this.insertCount += 1;

    if (this.duplicateOnInsert) {
      if (this.duplicateReplacement) {
        this.records.set(
          snapshot.strategyRunId,
          this.duplicateReplacement
        );
      }

      const error =
        new Error(
          "duplicate key"
        ) as Error & {
          code: string;
        };

      error.code =
        "ER_DUP_ENTRY";

      throw error;
    }

    const persisted = {
      ...snapshot,
      id: this.insertCount,
      createdAt:
        new Date(
          "2026-09-22T10:10:00.000Z"
        ),
    };

    this.records.set(
      snapshot.strategyRunId,
      persisted
    );

    return persisted;
  }
}

function candidate(
  objective = "Demand"
): StrategySnapshot {
  return buildStrategySnapshot({
    userId: 22,
    campaignId: 30,
    businessId: 9,
    strategyRunId: 501,
    businessDnaSnapshotId:
      "bdna_snapshot_001",
    version: 1,
    creativeBriefFingerprint:
      "brief-fingerprint-001",
    snapshot: {
      objective,
      channels: [
        "linkedin",
        "email",
      ],
    },
    capturedAt:
      new Date(
        "2026-09-22T10:00:00.000Z"
      ),
  });
}

describe(
  "immutable Strategy snapshot store",
  () => {
    it(
      "inserts a new Strategy snapshot once",
      async () => {
        const persistence =
          new FakePersistence();

        const result =
          await persistImmutableStrategySnapshot(
            persistence,
            candidate()
          );

        expect(
          result.reused
        ).toBe(false);

        expect(
          persistence.insertCount
        ).toBe(1);

        expect(
          result.snapshot.strategyRunId
        ).toBe(501);
      }
    );

    it(
      "reuses an identical Strategy-run replay without inserting again",
      async () => {
        const persistence =
          new FakePersistence();

        const firstCandidate =
          candidate();

        persistence.seed({
          ...firstCandidate,
          id: 41,
        });

        const result =
          await persistImmutableStrategySnapshot(
            persistence,
            candidate()
          );

        expect(
          result.reused
        ).toBe(true);

        expect(
          result.snapshot.id
        ).toBe(41);

        expect(
          persistence.insertCount
        ).toBe(0);
      }
    );

    it(
      "fails closed when one Strategy run maps to different immutable content",
      async () => {
        const persistence =
          new FakePersistence();

        persistence.seed({
          ...candidate("Demand"),
          id: 41,
        });

        await expect(
          persistImmutableStrategySnapshot(
            persistence,
            candidate("Retention")
          )
        ).rejects.toBeInstanceOf(
          StrategySnapshotConflictError
        );

        expect(
          persistence.insertCount
        ).toBe(0);
      }
    );

    it(
      "recovers an identical duplicate-key race as an idempotent replay",
      async () => {
        const persistence =
          new FakePersistence();

        const same =
          candidate();

        persistence.duplicateOnInsert =
          true;

        persistence.duplicateReplacement = {
          ...same,
          id: 77,
        };

        const result =
          await persistImmutableStrategySnapshot(
            persistence,
            same
          );

        expect(
          result.reused
        ).toBe(true);

        expect(
          result.snapshot.id
        ).toBe(77);

        expect(
          persistence.insertCount
        ).toBe(1);
      }
    );

    it(
      "fails closed when a duplicate-key race resolves to conflicting authority",
      async () => {
        const persistence =
          new FakePersistence();

        persistence.duplicateOnInsert =
          true;

        persistence.duplicateReplacement = {
          ...candidate(
            "Retention"
          ),
          id: 88,
        };

        await expect(
          persistImmutableStrategySnapshot(
            persistence,
            candidate("Demand")
          )
        ).rejects.toBeInstanceOf(
          StrategySnapshotConflictError
        );

        expect(
          persistence.insertCount
        ).toBe(1);
      }
    );
  }
);