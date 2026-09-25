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
  StrategySnapshotConflictError,
  type PersistedStrategySnapshot,
  type StrategySnapshotPersistence,
} from "./strategy-snapshot-store";

import {
  materializeGovernedStrategySnapshot,
} from "./strategy-snapshot-materialization";

class FakePersistence
  implements StrategySnapshotPersistence {
  private readonly rows =
    new Map<
      number,
      PersistedStrategySnapshot
    >();

  insertCount = 0;

  seed(
    snapshot:
      PersistedStrategySnapshot
  ): void {
    this.rows.set(
      snapshot.strategyRunId,
      snapshot
    );
  }

  async findByStrategyRunId(
    strategyRunId: number
  ): Promise<PersistedStrategySnapshot | null> {
    return (
      this.rows.get(
        strategyRunId
      ) ??
      null
    );
  }

  async insert(
    snapshot: StrategySnapshot
  ): Promise<PersistedStrategySnapshot> {
    this.insertCount += 1;

    const persisted = {
      ...snapshot,
      id: this.insertCount,
      createdAt:
        new Date(
          "2026-09-22T12:05:00.000Z"
        ),
    };

    this.rows.set(
      snapshot.strategyRunId,
      persisted
    );

    return persisted;
  }
}

function existingAuthority(
  overrides: Partial<{
    userId: number;
    campaignId: number;
    businessId: number;
    strategyRunId: number;
    creativeBriefFingerprint: string;
  }> = {}
): PersistedStrategySnapshot {
  return {
    ...buildStrategySnapshot({
      userId:
        overrides.userId ??
        22,
      campaignId:
        overrides.campaignId ??
        30,
      businessId:
        overrides.businessId ??
        9,
      strategyRunId:
        overrides.strategyRunId ??
        501,
      businessDnaSnapshotId:
        "shadow-bdna-9-abc123",
      version: 2,
      creativeBriefFingerprint:
        overrides
          .creativeBriefFingerprint ??
        "brief-fingerprint-001",
      snapshot: {
        positioning:
          "Trusted specialist",
      },
      capturedAt:
        new Date(
          "2026-09-22T12:00:00.000Z"
        ),
    }),
    id: 41,
  };
}

describe(
  "governed Strategy snapshot materialisation",
  () => {
    it(
      "binds successful Strategy output to exact Business DNA authority and campaign version",
      async () => {
        const persistence =
          new FakePersistence();

        let businessDnaCalls = 0;
        let versionCalls = 0;

        const result =
          await materializeGovernedStrategySnapshot(
            {
              userId: 22,
              campaignId: 30,
              businessId: 9,
              strategyRunId: 501,
              creativeBriefFingerprint:
                "brief-fingerprint-001",
              snapshot: {
                positioning:
                  "Trusted specialist",
                optionalUndefined:
                  undefined,
              },
            },
            {
              persistence,
              persistAudit: async () => {},

              materializeBusinessDna:
                async () => {
                  businessDnaCalls += 1;

                  return {
                    snapshot: {
                      snapshotId:
                        "shadow-bdna-9-abc123",
                    },
                  };
                },

              resolveNextVersion:
                async (
                  campaignId
                ) => {
                  versionCalls += 1;

                  expect(
                    campaignId
                  ).toBe(30);

                  return 3;
                },

              now:
                () =>
                  new Date(
                    "2026-09-22T12:00:00.000Z"
                  ),
            }
          );

        expect(
          result.status
        ).toBe("inserted");

        expect(
          result.snapshot.businessDnaSnapshotId
        ).toBe(
          "shadow-bdna-9-abc123"
        );

        expect(
          result.snapshot.version
        ).toBe(3);

        expect(
          result.snapshot.strategyRunId
        ).toBe(501);

        expect(
          result.snapshot.creativeBriefFingerprint
        ).toBe(
          "brief-fingerprint-001"
        );

        expect(
          businessDnaCalls
        ).toBe(1);

        expect(
          versionCalls
        ).toBe(1);

        expect(
          persistence.insertCount
        ).toBe(1);
      }
    );

    it(
      "reuses the original immutable authority for an already materialised Strategy run",
      async () => {
        const persistence =
          new FakePersistence();

        const existing =
          existingAuthority();

        persistence.seed(
          existing
        );

        let businessDnaCalled =
          false;

        let versionCalled =
          false;

        const result =
          await materializeGovernedStrategySnapshot(
            {
              userId: 22,
              campaignId: 30,
              businessId: 9,
              strategyRunId: 501,
              creativeBriefFingerprint:
                "brief-fingerprint-001",
              snapshot: {
                positioning:
                  "Trusted specialist",
              },
            },
            {
              persistence,
              persistAudit: async () => {},

              materializeBusinessDna:
                async () => {
                  businessDnaCalled =
                    true;

                  throw new Error(
                    "must not rematerialise Business DNA on replay"
                  );
                },

              resolveNextVersion:
                async () => {
                  versionCalled =
                    true;

                  throw new Error(
                    "must not allocate a new version on replay"
                  );
                },
            }
          );

        expect(
          result.status
        ).toBe("reused");

        expect(
          result.snapshot.snapshotId
        ).toBe(
          existing.snapshotId
        );

        expect(
          businessDnaCalled
        ).toBe(false);

        expect(
          versionCalled
        ).toBe(false);

        expect(
          persistence.insertCount
        ).toBe(0);
      }
    );

    it(
      "fails closed when an existing run is replayed with a conflicting Strategy payload",
      async () => {
        const persistence =
          new FakePersistence();

        persistence.seed(
          existingAuthority()
        );

        await expect(
          materializeGovernedStrategySnapshot(
            {
              userId: 22,
              campaignId: 30,
              businessId: 9,
              strategyRunId: 501,
              creativeBriefFingerprint:
                "brief-fingerprint-001",
              snapshot: {
                positioning:
                  "Changed on replay",
              },
            },
            {
              persistence,
              persistAudit: async () => {},
            }
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
      "fails closed when an existing run is requested under conflicting authority context",
      async () => {
        const persistence =
          new FakePersistence();

        persistence.seed(
          existingAuthority({
            campaignId: 30,
          })
        );

        await expect(
          materializeGovernedStrategySnapshot(
            {
              userId: 22,
              campaignId: 31,
              businessId: 9,
              strategyRunId: 501,
              creativeBriefFingerprint:
                "brief-fingerprint-001",
              snapshot: {
                positioning:
                  "Conflict",
              },
            },
            {
              persistence,
              persistAudit: async () => {},
            }
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
      "emits the canonical strategy_snapshot_materialized audit with immutable lineage",
      async () => {
        const persistence =
          new FakePersistence();

        const audits: any[] = [];

        const result =
          await materializeGovernedStrategySnapshot(
            {
              userId: 22,
              campaignId: 30,
              businessId: 9,
              strategyRunId: 701,
              creativeBriefFingerprint:
                "brief-fingerprint-audit",
              snapshot: {
                positioning:
                  "Trusted specialist",
              },
            },
            {
              persistence,

              materializeBusinessDna:
                async () => ({
                  snapshot: {
                    snapshotId:
                      "shadow-bdna-9-audit",
                  },
                }),

              resolveNextVersion:
                async () => 4,

              now:
                () =>
                  new Date(
                    "2026-09-22T13:00:00.000Z"
                  ),

              persistAudit:
                async (event) => {
                  audits.push(
                    event
                  );
                },
            }
          );

        expect(
          result.status
        ).toBe("inserted");

        expect(
          audits
        ).toHaveLength(1);

        expect(
          audits[0]
        ).toMatchObject({
          eventType:
            "strategy_snapshot_materialized",
          occurredAt:
            "2026-09-22T13:00:00.000Z",
          userId: 22,
          campaignId: 30,
          businessId: 9,
          artifactId:
            result.snapshot.snapshotId,
          source:
            "strategy",
          outcome:
            "succeeded",
          metadata: {
            strategyRunId: 701,
            strategyVersion: 4,
            businessDnaSnapshotId:
              "shadow-bdna-9-audit",
            creativeBriefFingerprint:
              "brief-fingerprint-audit",
            strategyHashSha256:
              result.snapshot
                .strategyHashSha256,
          },
        });
      }
    );

    it(
      "emits identical materialisation audit evidence when immutable Strategy authority is replayed",
      async () => {
        const persistence =
          new FakePersistence();

        const existing =
          existingAuthority();

        persistence.seed(
          existing
        );

        const audits: any[] = [];

        const input = {
          userId: 22,
          campaignId: 30,
          businessId: 9,
          strategyRunId: 501,
          creativeBriefFingerprint:
            "brief-fingerprint-001",
          snapshot: {
            positioning:
              "Trusted specialist",
          },
        };

        const dependencies = {
          persistence,

          materializeBusinessDna:
            async () => {
              throw new Error(
                "Business DNA must not rematerialise on audit replay"
              );
            },

          resolveNextVersion:
            async () => {
              throw new Error(
                "Strategy version must not advance on audit replay"
              );
            },

          persistAudit:
            async (event: any) => {
              audits.push(
                event
              );
            },
        };

        const first =
          await materializeGovernedStrategySnapshot(
            input,
            dependencies
          );

        const second =
          await materializeGovernedStrategySnapshot(
            input,
            dependencies
          );

        expect(
          first.status
        ).toBe("reused");

        expect(
          second.status
        ).toBe("reused");

        expect(
          audits
        ).toHaveLength(2);

        expect(
          audits[1]
        ).toEqual(
          audits[0]
        );

        expect(
          audits[0].artifactId
        ).toBe(
          existing.snapshotId
        );

        expect(
          audits[0].occurredAt
        ).toBe(
          existing.capturedAt.toISOString()
        );
      }
    );

    it(
      "recovers a missing materialisation audit on replay without rematerialising Strategy authority",
      async () => {
        const persistence =
          new FakePersistence();

        const input = {
          userId: 22,
          campaignId: 30,
          businessId: 9,
          strategyRunId: 702,
          creativeBriefFingerprint:
            "brief-fingerprint-recovery",
          snapshot: {
            positioning:
              "Trusted specialist",
          },
        };

        await expect(
          materializeGovernedStrategySnapshot(
            input,
            {
              persistence,

              materializeBusinessDna:
                async () => ({
                  snapshot: {
                    snapshotId:
                      "shadow-bdna-9-recovery",
                  },
                }),

              resolveNextVersion:
                async () => 5,

              now:
                () =>
                  new Date(
                    "2026-09-22T14:00:00.000Z"
                  ),

              persistAudit:
                async () => {
                  throw new Error(
                    "audit persistence failed"
                  );
                },
            }
          )
        ).rejects.toThrow(
          "audit persistence failed"
        );

        expect(
          persistence.insertCount
        ).toBe(1);

        let businessDnaCalled =
          false;

        let versionCalled =
          false;

        const recoveredAudits:
          any[] = [];

        const recovered =
          await materializeGovernedStrategySnapshot(
            input,
            {
              persistence,

              materializeBusinessDna:
                async () => {
                  businessDnaCalled =
                    true;

                  throw new Error(
                    "Business DNA must not rematerialise during audit recovery"
                  );
                },

              resolveNextVersion:
                async () => {
                  versionCalled =
                    true;

                  throw new Error(
                    "Strategy version must not advance during audit recovery"
                  );
                },

              persistAudit:
                async (event) => {
                  recoveredAudits.push(
                    event
                  );
                },
            }
          );

        expect(
          recovered.status
        ).toBe("reused");

        expect(
          persistence.insertCount
        ).toBe(1);

        expect(
          businessDnaCalled
        ).toBe(false);

        expect(
          versionCalled
        ).toBe(false);

        expect(
          recoveredAudits
        ).toHaveLength(1);

        expect(
          recoveredAudits[0]
            .eventType
        ).toBe(
          "strategy_snapshot_materialized"
        );
      }
    );
  }
);