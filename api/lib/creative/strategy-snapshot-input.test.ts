import {
  describe,
  expect,
  it,
} from "vitest";

import {
  hashStrategySnapshotPayload,
  type JsonValue,
} from "../strategy/strategy-snapshot";
import type {
  PersistedStrategySnapshot,
} from "../strategy/strategy-snapshot-store";
import type {
  CreativeStrategyAuthority,
} from "./strategy-authority";
import {
  resolveImmutableCreativeStrategyInput,
} from "./strategy-snapshot-input";

function buildFixture() {
  const payload: JsonValue = {
    positioning:
      "Immutable positioning",
    valueProposition:
      "Immutable value proposition",
    coreMessage:
      "Immutable core message",
    campaignTheme:
      "Immutable campaign theme",
    personas: [
      {
        name:
          "Immutable buyer",
        painPoints: [
          "manual work",
        ],
      },
    ],
    creativeBriefFingerprint:
      "brief-fingerprint-001",
  };

  const strategyHashSha256 =
    hashStrategySnapshotPayload(
      payload
    );

  const authority: CreativeStrategyAuthority = {
    strategySnapshotId:
      "strategy-snapshot-501",
    strategyVersion: 3,
    businessDnaSnapshotId:
      "bdna-snapshot-9",
    strategyHashSha256,
    strategyRunId: 501,
    approvalRequestId: 77,
    creativeBriefFingerprint:
      "brief-fingerprint-001",
  };

  const persisted: PersistedStrategySnapshot = {
    id: 1,
    snapshotId:
      authority.strategySnapshotId,
    userId: 18,
    campaignId: 30,
    businessId: 24,
    strategyRunId:
      authority.strategyRunId,
    businessDnaSnapshotId:
      authority.businessDnaSnapshotId,
    version:
      authority.strategyVersion,
    creativeBriefFingerprint:
      authority.creativeBriefFingerprint,
    strategyHashSha256,
    snapshot: payload,
    capturedAt:
      new Date(
        "2026-09-23T00:00:00.000Z"
      ),
    createdAt:
      new Date(
        "2026-09-23T00:00:00.000Z"
      ),
  };

  return {
    authority,
    persisted,
  };
}

describe(
  "immutable Creative Strategy snapshot input",
  () => {
    it(
      "loads the exact WBS11 snapshot and derives Creative context only from its immutable payload",
      async () => {
        const {
          authority,
          persisted,
        } =
          buildFixture();

        const result =
          await resolveImmutableCreativeStrategyInput(
            {
              authority,
              userId: 18,
              campaignId: 30,
              businessId: 24,
            },
            {
              loadByStrategyRunId:
                async () =>
                  persisted,
            }
          );

        expect(
          result.authority
        ).toBe(
          authority
        );

        expect(
          result.snapshot
        ).toBe(
          persisted.snapshot
        );

        expect(
          result.creativeContext
        ).toEqual({
          coreMessage:
            "Immutable core message",
          valueProposition:
            "Immutable value proposition",
          positioning:
            "Immutable positioning",
          campaignTheme:
            "Immutable campaign theme",
          personas: [
            {
              name:
                "Immutable buyer",
              painPoints: [
                "manual work",
              ],
            },
          ],
        });

        expect(
          Object.isFrozen(
            result.creativeContext
          )
        ).toBe(true);
      }
    );

    it(
      "fails closed when approved Strategy version does not match the persisted snapshot",
      async () => {
        const {
          authority,
          persisted,
        } =
          buildFixture();

        await expect(
          resolveImmutableCreativeStrategyInput(
            {
              authority,
              userId: 18,
              campaignId: 30,
              businessId: 24,
            },
            {
              loadByStrategyRunId:
                async () => ({
                  ...persisted,
                  version: 4,
                }),
            }
          )
        ).rejects.toThrow(
          /strategyVersion/
        );
      }
    );

    it(
      "fails closed when snapshot ownership differs from the Creative job",
      async () => {
        const {
          authority,
          persisted,
        } =
          buildFixture();

        await expect(
          resolveImmutableCreativeStrategyInput(
            {
              authority,
              userId: 18,
              campaignId: 30,
              businessId: 24,
            },
            {
              loadByStrategyRunId:
                async () => ({
                  ...persisted,
                  campaignId: 31,
                }),
            }
          )
        ).rejects.toThrow(
          /ownership/
        );
      }
    );

    it(
      "recomputes the payload hash and rejects tampered Strategy content",
      async () => {
        const {
          authority,
          persisted,
        } =
          buildFixture();

        await expect(
          resolveImmutableCreativeStrategyInput(
            {
              authority,
              userId: 18,
              campaignId: 30,
              businessId: 24,
            },
            {
              loadByStrategyRunId:
                async () => ({
                  ...persisted,
                  snapshot: {
                    ...(persisted.snapshot as Record<
                      string,
                      JsonValue
                    >),
                    coreMessage:
                      "Tampered mutable message",
                  },
                }),
            }
          )
        ).rejects.toThrow(
          /strategyHashSha256/
        );
      }
    );
  }
);
