import {
  describe,
  expect,
  it,
} from "vitest";

import {
  buildCreativeStrategyAuthority,
} from "./strategy-authority";

function approvedLineage(overrides: Record<string, unknown> = {}) {
  return {
    creativeBriefFingerprint: "brief-fingerprint-001",
    strategyRunId: 501,
    approvalRequestId: 77,
    status: "approved",
    strategySnapshotId: "strategy-snapshot-501",
    strategyVersion: 3,
    businessDnaSnapshotId: "bdna-snapshot-9",
    strategyHashSha256: "a".repeat(64),
    ...overrides,
  } as any;
}

describe("Creative Strategy authority", () => {
  it("captures every immutable WBS11 authority coordinate including Strategy version", () => {
    const authority =
      buildCreativeStrategyAuthority(
        approvedLineage()
      );

    expect(authority).toEqual({
      strategySnapshotId: "strategy-snapshot-501",
      strategyVersion: 3,
      businessDnaSnapshotId: "bdna-snapshot-9",
      strategyHashSha256: "a".repeat(64),
      strategyRunId: 501,
      approvalRequestId: 77,
      creativeBriefFingerprint: "brief-fingerprint-001",
    });

    expect(Object.isFrozen(authority)).toBe(true);
  });

  it("fails closed when Strategy version is missing or invalid", () => {
    expect(() =>
      buildCreativeStrategyAuthority(
        approvedLineage({
          strategyVersion: 0,
        })
      )
    ).toThrow(/strategyVersion/);
  });

  it("fails closed for non-approved or malformed immutable authority", () => {
    expect(() =>
      buildCreativeStrategyAuthority(
        approvedLineage({
          status: "pending",
        })
      )
    ).toThrow(/approved lineage/);

    expect(() =>
      buildCreativeStrategyAuthority(
        approvedLineage({
          strategyHashSha256: "not-a-sha256",
        })
      )
    ).toThrow(/strategyHashSha256/);
  });
});
