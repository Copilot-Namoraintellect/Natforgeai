import { describe, it, expect } from "vitest";
import {
  buildStrategyApprovalLineage,
  getStrategyApprovalStatus,
  isStrategySnapshotAuthorityMatch,
  type StrategyApprovalSnapshotAuthority,
} from "./strategy-approval";
import { materializeGovernedStrategySnapshot } from "../strategy/strategy-snapshot-materialization";
import type {
  PersistedStrategySnapshot,
  StrategySnapshotPersistence,
} from "../strategy/strategy-snapshot-store";
import type { StrategySnapshot } from "../strategy/strategy-snapshot";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

class FakePersistence implements StrategySnapshotPersistence {
  rows = new Map<number, PersistedStrategySnapshot>();
  insertCount = 0;

  async findByStrategyRunId(strategyRunId: number) {
    return this.rows.get(strategyRunId) ?? null;
  }

  async insert(snapshot: StrategySnapshot) {
    this.insertCount += 1;
    const row: PersistedStrategySnapshot = {
      id: this.insertCount,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      ...snapshot,
      snapshot: snapshot.snapshot,
    };
    this.rows.set(snapshot.strategyRunId, row);
    return row;
  }
}

const SNAPSHOT_PAYLOAD = {
  personas: [
    {
      name: "Rita",
      demographics: "Restaurant owner",
      painPoints: ["slow payouts"],
      goals: ["same-day money"],
      platforms: ["Facebook"],
    },
  ],
  positioning: "Same-day payouts.",
  valueProposition: "Money the same day.",
  coreMessage: "A payout platform for restaurants.",
  campaignTheme: "Same-day payouts",
  platformStrategy: [
    {
      platform: "Facebook",
      purpose: "Reach owners",
      contentTypes: ["ads"],
      postingFrequency: "3x per week",
    },
  ],
  funnelStages: [
    { stage: "awareness", goal: "Reach", tactics: ["ads"], metrics: ["impressions"] },
  ],
  offers: [],
  ctas: [{ stage: "awareness", cta: "Book a Demo", placement: "headline" }],
  budgetRecommendation: { total: 5000, allocation: [{ channel: "Facebook", amount: 5000, percentage: 100 }] },
};

function v1Authority(): StrategyApprovalSnapshotAuthority {
  return {
    strategySnapshotId: "strategy_v1",
    strategyVersion: 1,
    businessDnaSnapshotId: "bdna_1",
    strategyHashSha256: HASH_A,
  };
}

describe("strategy approval invalidation across a Learning-consumption strategy version", () => {
  it("a v1 approval lineage never matches the v2 snapshot authority", () => {
    const lineage = buildStrategyApprovalLineage("fp-brief", 11, 33, "approved", v1Authority());

    // The exact v1 snapshot authority still matches...
    expect(
      isStrategySnapshotAuthorityMatch(
        lineage,
        {
          snapshotId: "strategy_v1",
          userId: 22,
          campaignId: 7,
          businessId: 5,
          strategyRunId: 11,
          businessDnaSnapshotId: "bdna_1",
          version: 1,
          creativeBriefFingerprint: "fp-brief",
          strategyHashSha256: HASH_A,
        },
        22,
        7,
        5
      )
    ).toBe(true);

    // ...but the new version produced by a future cycle (new run, new version,
    // new payload hash — e.g. because it consumed approved Learning
    // promotions) fails every coordinate.
    expect(
      isStrategySnapshotAuthorityMatch(
        lineage,
        {
          snapshotId: "strategy_v2",
          userId: 22,
          campaignId: 7,
          businessId: 5,
          strategyRunId: 12,
          businessDnaSnapshotId: "bdna_1",
          version: 2,
          creativeBriefFingerprint: "fp-brief",
          strategyHashSha256: HASH_B,
        },
        22,
        7,
        5
      )
    ).toBe(false);
  });

  it("a new envelope-consuming cycle creates a new immutable version without touching history", async () => {
    const persistence = new FakePersistence();
    const materializeBusinessDna = async () => ({ snapshot: { snapshotId: "bdna_1" } });
    const resolveVersion = async (campaignId: number) => persistence.insertCount + 1;

    const v1 = await materializeGovernedStrategySnapshot(
      {
        userId: 22,
        campaignId: 7,
        businessId: 5,
        strategyRunId: 11,
        creativeBriefFingerprint: "fp-brief",
        snapshot: SNAPSHOT_PAYLOAD,
      },
      {
        persistence,
        materializeBusinessDna,
        resolveNextVersion: resolveVersion,
        persistAudit: async () => undefined,
      }
    );
    expect(v1.status).toBe("inserted");
    expect(v1.snapshot.version).toBe(1);

    // The future cycle consumed approved Learning: the payload carries the
    // explicit lineage block and therefore a different strategy hash.
    const v2 = await materializeGovernedStrategySnapshot(
      {
        userId: 22,
        campaignId: 7,
        businessId: 5,
        strategyRunId: 12,
        creativeBriefFingerprint: "fp-brief",
        snapshot: {
          ...SNAPSHOT_PAYLOAD,
          learningPromotionInputs: [
            {
              approvalRequestId: 71,
              proposalFingerprint: "f".repeat(64),
              learningRecordId: 501,
              campaignId: 7,
              evaluationVersion: "learning-v2",
              learningEngineVersion: "learning-v2",
              recommendationId: "rec_improve_hook_ctr",
              targetEngine: "creative",
              adjustmentType: "improve_hook_ctr",
              promotedProvenanceClass: "approved_recommendation",
            },
          ],
        },
      },
      {
        persistence,
        materializeBusinessDna,
        resolveNextVersion: resolveVersion,
        persistAudit: async () => undefined,
      }
    );
    expect(v2.status).toBe("inserted");
    expect(v2.snapshot.version).toBe(2);
    expect(v2.snapshot.strategyHashSha256).not.toBe(v1.snapshot.strategyHashSha256);

    // The historical v1 row is untouched: both runs resolve, and v1 keeps
    // its original hash/version/snapshotId.
    const replayV1 = await persistence.findByStrategyRunId(11);
    expect(replayV1?.strategyHashSha256).toBe(v1.snapshot.strategyHashSha256);
    expect(replayV1?.version).toBe(1);
    expect(replayV1?.snapshot).toEqual(v1.snapshot.snapshot);

    // The v1 approval lineage remains bound to v1 and is NOT reusable for v2.
    const lineage = buildStrategyApprovalLineage("fp-brief", 11, 33, "approved", v1Authority());
    expect(
      isStrategySnapshotAuthorityMatch(lineage, v2.snapshot as never, 22, 7, 5)
    ).toBe(false);
  });

  it("approval status fails closed when lineage and current brief diverge", () => {
    // Campaign still advertising the v1 approval while the brief moved on
    // (fingerprint mismatch) must never read as current/approved.
    const campaign = {
      id: 7,
      userId: 22,
      businessId: 5,
      goal: "Drive bookings",
      primaryOutcome: "drive bookings",
      workflowContext: {
        approvedStrategyFingerprint: "fp-OLD",
        strategyFingerprint: "fp-OLD",
        strategyApprovalLineage: {
          ...buildStrategyApprovalLineage("fp-OLD", 11, 33, "approved", v1Authority()),
        },
      },
    };
    const status = getStrategyApprovalStatus(campaign, {
      name: "Business",
      productOrService: "payout platform",
    });
    expect(status.hasApprovedStrategy).toBe(false);
    expect(status.isCurrent).toBe(false);
    expect(status.lineage?.status).toBe("approved");
  });
});
