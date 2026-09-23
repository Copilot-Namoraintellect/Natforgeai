import {
  describe,
  expect,
  it,
} from "vitest";

import {
  buildStrategySnapshot,
  canonicalStrategyJson,
  hashStrategySnapshotPayload,
  type JsonValue,
} from "./strategy-snapshot";

describe(
  "Strategy snapshot contract",
  () => {
    it(
      "canonicalises object key ordering deterministically",
      () => {
        const left: JsonValue = {
          z: 3,
          nested: {
            b: true,
            a: "first",
          },
          a: 1,
        };

        const right: JsonValue = {
          a: 1,
          nested: {
            a: "first",
            b: true,
          },
          z: 3,
        };

        expect(
          canonicalStrategyJson(left)
        ).toBe(
          canonicalStrategyJson(right)
        );

        expect(
          hashStrategySnapshotPayload(left)
        ).toBe(
          hashStrategySnapshotPayload(right)
        );
      }
    );

    it(
      "builds deterministic immutable authority for the same Strategy evidence",
      () => {
        const capturedAt =
          new Date(
            "2026-09-22T10:00:00.000Z"
          );

        const first =
          buildStrategySnapshot({
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
              objective:
                "Generate qualified demand",
              channels: [
                "linkedin",
                "email",
              ],
            },
            capturedAt,
          });

        const second =
          buildStrategySnapshot({
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
              channels: [
                "linkedin",
                "email",
              ],
              objective:
                "Generate qualified demand",
            },
            capturedAt:
              new Date(
                "2026-09-22T10:05:00.000Z"
              ),
          });

        expect(
          first.snapshotId
        ).toBe(
          second.snapshotId
        );

        expect(
          first.strategyHashSha256
        ).toBe(
          second.strategyHashSha256
        );

        expect(
          Object.isFrozen(first)
        ).toBe(true);

        expect(
          Object.isFrozen(
            first.snapshot
          )
        ).toBe(true);
      }
    );

    it(
      "changes Strategy authority when grounded Strategy content changes",
      () => {
        const common = {
          userId: 22,
          campaignId: 30,
          businessId: 9,
          strategyRunId: 501,
          businessDnaSnapshotId:
            "bdna_snapshot_001",
          version: 1,
          creativeBriefFingerprint:
            "brief-fingerprint-001",
          capturedAt:
            new Date(
              "2026-09-22T10:00:00.000Z"
            ),
        };

        const first =
          buildStrategySnapshot({
            ...common,
            snapshot: {
              objective: "Demand",
            },
          });

        const second =
          buildStrategySnapshot({
            ...common,
            snapshot: {
              objective: "Retention",
            },
          });

        expect(
          first.strategyHashSha256
        ).not.toBe(
          second.strategyHashSha256
        );

        expect(
          first.snapshotId
        ).not.toBe(
          second.snapshotId
        );
      }
    );

    it(
      "rejects invalid campaign-scoped version numbers",
      () => {
        expect(() =>
          buildStrategySnapshot({
            userId: 22,
            campaignId: 30,
            businessId: 9,
            strategyRunId: 501,
            businessDnaSnapshotId:
              "bdna_snapshot_001",
            version: 0,
            creativeBriefFingerprint:
              "brief-fingerprint-001",
            snapshot: {},
            capturedAt:
              new Date(
                "2026-09-22T10:00:00.000Z"
              ),
          })
        ).toThrow(
          "version must be a positive integer"
        );
      }
    );
  }
);