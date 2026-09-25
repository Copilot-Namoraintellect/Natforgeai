import { describe, it, expect, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  getApprovedPromotionEnvelopes,
  getLearningPromotionProposal,
  listLearningPromotionProposals,
  proposeLearningPromotion,
} from "./promotion-service";
import { sealApprovedLearningPromotionEnvelope } from "./promotion-decision";
import {
  LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE,
  buildLearningPromotionProposalFingerprint,
} from "./promotion-contract";
import type { EvidenceItem, RecommendedAdjustment } from "../contracts/learning-derivation";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

const RECOMMENDATION: RecommendedAdjustment = {
  id: "rec_align_offer_conversion",
  targetEngine: "strategy",
  adjustmentType: "improve_offer_conversion_alignment",
  summary: "Re-examine offer, audience and post-click alignment to convert existing clicks.",
  rationale: "Conversion rate 0.80% is below the configured partial band (1.00%) on 60 clicks.",
  evidenceRefs: ["obs:1", "obs:2"],
  governance: { autoApply: false, requiresApproval: true },
};

const EVIDENCE: EvidenceItem[] = [
  { kind: "observation", ref: "obs:1", note: "clicks=60 on instagram at 2026-05-02 (analytics row 9)" },
  { kind: "observation", ref: "obs:2", note: "conversions=1 on instagram at 2026-05-02 (analytics row 10)" },
];

function learningRecordRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    userId: 22,
    campaignId: 7,
    evaluationVersion: "learning-v1",
    windowStart: new Date("2026-05-01T00:00:00.000Z"),
    windowEnd: new Date("2026-05-31T00:00:00.000Z"),
    idempotencyKey: "lr:7:learning-v1:2026-05-01:2026-05-31",
    objectiveSummary: "Objective assessed.",
    kpiAssessment: {},
    performanceFacts: [],
    positivePatterns: [],
    negativePatterns: [],
    confidence: "medium",
    evidence: EVIDENCE,
    recommendedAdjustments: [RECOMMENDATION],
    governance: { autoApply: false, requiresApproval: true, phase: 1 },
    sourceObservations: [],
    provenance: {
      engine: "learning-engine",
      engineVersion: "learning-v1",
      trigger: "manual",
      inputDigest: "digest-abc",
      evaluatedAt: "2026-06-01T00:00:00.000Z",
    },
    status: "recorded",
    evaluatedAt: new Date("2026-06-01T00:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

interface FakeState {
  approvals: Record<string, unknown>[];
  learningRecords: Record<string, unknown>[];
  audits: Record<string, unknown>[];
  insertTables: string[];
  updateCalls: string[];
  nextApprovalId: number;
  nextAuditId: number;
}

function deepScalars(value: unknown, acc: { strings: string[]; numbers: number[] }, depth = 0) {
  if (depth > 10 || value === null || value === undefined) return acc;
  if (typeof value === "string") {
    acc.strings.push(value);
    return acc;
  }
  if (typeof value === "number") {
    acc.numbers.push(value);
    return acc;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) deepScalars(v, acc, depth + 1);
  }
  return acc;
}

function createFakeDb() {
  const state: FakeState = {
    approvals: [],
    learningRecords: [learningRecordRow()],
    audits: [],
    insertTables: [],
    updateCalls: [],
    nextApprovalId: 1,
    nextAuditId: 1,
  };

  const matchRows = (name: string, conds: unknown[]) => {
    const { strings, numbers } = deepScalars(conds, { strings: [], numbers: [] });
    if (name === "learning_records") {
      return state.learningRecords.filter((r) => numbers.includes(r.id as number) && numbers.includes(r.userId as number));
    }
    if (name === "approval_requests") {
      const lpKey = strings.find((s) => s.startsWith("lp:"));
      if (lpKey) return state.approvals.filter((r) => r.idempotencyKey === lpKey);
      if (strings.includes(LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE)) {
        return state.approvals.filter(
          (r) => numbers.includes(r.userId as number) && numbers.includes(r.campaignId as number)
        );
      }
      if (numbers.length >= 2) {
        // id + userId ownership-scoped lookup.
        return state.approvals.filter(
          (r) => numbers.includes(r.id as number) && numbers.includes(r.userId as number)
        );
      }
      return state.approvals.filter((r) => numbers.includes(r.id as number));
    }
    if (name === "audit_events") {
      const fingerprint = strings.find((s) => /^[0-9a-f]{64}$/.test(s));
      if (fingerprint) return state.audits.filter((r) => r.eventFingerprint === fingerprint);
      return state.audits.filter(
        (r) => strings.includes(r.eventType as string) && numbers.includes(r.approvalRequestId as number)
      );
    }
    return [];
  };

  const chainFor = (name: string, conds: unknown[]) => ({
    limit: async (n: number) => matchRows(name, conds).slice(0, n),
    orderBy: async () => {
      const rows = matchRows(name, conds).slice();
      rows.sort((a, b) => {
        const bt = new Date(String(b.createdAt ?? b.occurredAt ?? 0)).getTime();
        const at = new Date(String(a.createdAt ?? a.occurredAt ?? 0)).getTime();
        return bt - at;
      });
      return rows.map((r) => ({ ...r }));
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(matchRows(name, conds).map((r) => ({ ...r }))).then(resolve, reject),
  });

  const db = {
    state,
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table);
        const chain: {
          where: (conds: unknown) => unknown;
          orderBy: () => Promise<unknown>;
          limit: (n: number) => Promise<unknown>;
        } = {
          where: (...conds: unknown[]) => chainFor(name ?? "", conds),
          orderBy: async () => {
            const source =
              name === "approval_requests" ? state.approvals : name === "audit_events" ? state.audits : [];
            return source.map((r) => ({ ...r }));
          },
          limit: async (n: number) => {
            const source =
              name === "approval_requests" ? state.approvals : name === "audit_events" ? state.audits : [];
            return source.slice(0, n).map((r) => ({ ...r }));
          },
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: async (row: Record<string, unknown>) => {
        const name = getTableName(table);
        state.insertTables.push(name ?? "unknown");
        if (name === "approval_requests") {
          const id = state.nextApprovalId++;
          state.approvals.push({ ...row, id });
          return [{ insertId: id, affectedRows: 1 }];
        }
        if (name === "audit_events") {
          const id = state.nextAuditId++;
          state.audits.push({ ...row, id });
          return [{ insertId: id, affectedRows: 1 }];
        }
        return [{ insertId: 0, affectedRows: 1 }];
      },
    }),
    update: (table: unknown) => {
      state.updateCalls.push(getTableName(table) ?? "unknown");
      return { set: () => ({ where: async () => [{ affectedRows: 0 }] }) };
    },
  };

  return { db, state };
}

const USER_ID = 22;

async function propose(db: unknown) {
  return proposeLearningPromotion({
    userId: USER_ID,
    learningRecordId: 501,
    recommendationId: "rec_align_offer_conversion",
    executor: db as never,
  });
}

describe("proposeLearningPromotion", () => {
  let fake: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    fake = createFakeDb();
  });

  it("binds the exact learning record and recommendation into a fingerprinted pending approval", async () => {
    const result = await propose(fake.db);

    expect(result.outcome).toBe("created");
    const proposal = result.proposal;
    expect(proposal.status).toBe("pending");
    expect(proposal.approvalRequestId).toBe(1);
    expect(proposal.coordinates).toEqual({
      learningRecordId: 501,
      campaignId: 7,
      evaluationVersion: "learning-v1",
      learningEngine: "learning-engine",
      learningEngineVersion: "learning-v1",
      learningInputDigest: "digest-abc",
      recommendationId: "rec_align_offer_conversion",
      targetEngine: "strategy",
      adjustmentType: "improve_offer_conversion_alignment",
      summary: RECOMMENDATION.summary,
      rationale: RECOMMENDATION.rationale,
      evidenceRefs: ["obs:1", "obs:2"],
    });
    expect(proposal.proposalFingerprint).toBe(
      buildLearningPromotionProposalFingerprint(proposal.coordinates)
    );
    expect(proposal.idempotencyKey).toBe(`lp:${proposal.proposalFingerprint}`);

    const row = fake.state.approvals[0];
    expect(row.approvalType).toBe(LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE);
    expect(row.userId).toBe(USER_ID);
    expect(row.campaignId).toBe(7);
    expect(row.status).toBe("pending");
    expect(row.riskLevel).toBe("medium");
    const context = row.context as Record<string, unknown>;
    expect(context.source).toBe("learning_promotion");
    expect(context.proposalFingerprint).toBe(proposal.proposalFingerprint);

    // One canonical approval_requested audit event, linked to the request.
    const audit = fake.state.audits[0];
    expect(audit.eventType).toBe("approval_requested");
    expect(audit.approvalRequestId).toBe(1);
    expect(audit.userId).toBe(USER_ID);
    expect(audit.campaignId).toBe(7);
    const metadata = audit.metadata as Record<string, unknown>;
    expect(metadata.promotionSource).toBe("learning_promotion");
    expect(metadata.proposalFingerprint).toBe(proposal.proposalFingerprint);
    expect(metadata.learningRecordId).toBe(501);
    expect(metadata.recommendationId).toBe("rec_align_offer_conversion");
  });

  it("duplicate proposal of the same exact recommendation is idempotent", async () => {
    const first = await propose(fake.db);
    const second = await propose(fake.db);

    expect(second.outcome).toBe("reused");
    expect(second.proposal.approvalRequestId).toBe(first.proposal.approvalRequestId);
    expect(fake.state.approvals).toHaveLength(1);
    expect(fake.state.audits).toHaveLength(1);
  });

  it("fails closed when the same key exists with drifted material", async () => {
    const first = await propose(fake.db);
    // Tamper with the durable proposal (simulates overwrite of the immutable
    // context): the stored fingerprint no longer rebinds.
    (fake.state.approvals[0].context as Record<string, unknown>).coordinates = {
      ...(fake.state.approvals[0].context as Record<string, unknown>).coordinates as object,
      summary: "silently altered",
    };

    await expect(propose(fake.db)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fake.state.approvals).toHaveLength(1);
    expect(first.proposal.status).toBe("pending");
  });

  it("rejects unknown learning records, unknown recommendations and non-governed recommendations", async () => {
    await expect(
      proposeLearningPromotion({
        userId: USER_ID,
        learningRecordId: 999,
        recommendationId: "rec_align_offer_conversion",
        executor: fake.db as never,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      proposeLearningPromotion({
        userId: USER_ID,
        learningRecordId: 501,
        recommendationId: "rec_missing",
        executor: fake.db as never,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      proposeLearningPromotion({
        userId: USER_ID,
        learningRecordId: 501,
        recommendationId: "  ",
        executor: fake.db as never,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    fake.state.learningRecords[0].recommendedAdjustments = [
      { ...RECOMMENDATION, governance: { autoApply: true, requiresApproval: false } },
    ];
    await expect(propose(fake.db)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("enforces record ownership", async () => {
    await expect(
      proposeLearningPromotion({
        userId: 999,
        learningRecordId: 501,
        recommendationId: "rec_align_offer_conversion",
        executor: fake.db as never,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("mutates no BI/Strategy state and no historical learning state", async () => {
    const recordBefore = JSON.parse(JSON.stringify(fake.state.learningRecords[0]));
    await propose(fake.db);

    expect(fake.state.updateCalls).toEqual([]);
    expect(JSON.parse(JSON.stringify(fake.state.learningRecords[0]))).toEqual(recordBefore);
    // The only insert targets are the approval ask and the audit event.
    expect(fake.state.insertTables).toEqual(["approval_requests", "audit_events"]);
  });
});

describe("promotion proposal queries", () => {
  it("lists proposals for a campaign and hides non-promotion carrier rows", async () => {
    const fake = createFakeDb();
    await propose(fake.db);
    // A legacy/generic carrier-type row without the discriminator.
    fake.state.approvals.push({
      id: 99,
      userId: USER_ID,
      campaignId: 7,
      approvalType: LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE,
      title: "Generic carrier row",
      description: null,
      aiRecommendation: null,
      riskLevel: "low",
      status: "pending",
      idempotencyKey: null,
      context: null,
      createdAt: new Date("2026-06-02T00:00:00.000Z"),
    });

    const proposals = await listLearningPromotionProposals({
      userId: USER_ID,
      campaignId: 7,
      executor: fake.db as never,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].learningRecordId).toBe(501);

    const one = await getLearningPromotionProposal({
      userId: USER_ID,
      approvalRequestId: proposals[0].approvalRequestId,
      executor: fake.db as never,
    });
    expect(one.proposalFingerprint).toBe(proposals[0].proposalFingerprint);

    await expect(
      getLearningPromotionProposal({
        userId: USER_ID,
        approvalRequestId: 99,
        executor: fake.db as never,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      getLearningPromotionProposal({
        userId: 999,
        approvalRequestId: proposals[0].approvalRequestId,
        executor: fake.db as never,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("getApprovedPromotionEnvelopes (WBS15.7 consumption seam)", () => {
  it("returns nothing while the proposal is only pending — no autonomous promotion", async () => {
    const fake = createFakeDb();
    await propose(fake.db);

    const envelopes = await getApprovedPromotionEnvelopes({
      userId: USER_ID,
      campaignId: 7,
      executor: fake.db as never,
    });
    expect(envelopes).toEqual([]);
  });

  it("returns nothing for an approved row whose envelope was never sealed", async () => {
    const fake = createFakeDb();
    await propose(fake.db);
    fake.state.approvals[0].status = "approved";
    fake.state.approvals[0].approvedAt = new Date("2026-07-01T12:00:00.000Z");

    const envelopes = await getApprovedPromotionEnvelopes({
      userId: USER_ID,
      campaignId: 7,
      executor: fake.db as never,
    });
    expect(envelopes).toEqual([]);
  });

  it("returns nothing for rejected proposals (rejected stays auditable but never consumable)", async () => {
    const fake = createFakeDb();
    await propose(fake.db);
    fake.state.approvals[0].status = "rejected";
    fake.state.approvals[0].rejectedAt = new Date("2026-07-01T12:00:00.000Z");

    const envelopes = await getApprovedPromotionEnvelopes({
      userId: USER_ID,
      campaignId: 7,
      executor: fake.db as never,
    });
    expect(envelopes).toEqual([]);
    // The proposal itself remains visible as auditable evidence.
    const proposals = await listLearningPromotionProposals({
      userId: USER_ID,
      campaignId: 7,
      executor: fake.db as never,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("rejected");
  });

  it("exposes the durable envelope after approval sealing, with provenance preserved", async () => {
    const fake = createFakeDb();
    const { proposal } = await propose(fake.db);

    const envelope = await sealApprovedLearningPromotionEnvelope({
      request: {
        id: proposal.approvalRequestId,
        userId: USER_ID,
        campaignId: 7,
        context: fake.state.approvals[0].context,
      },
      decidedAt: new Date("2026-07-01T12:00:00.000Z"),
      decidedByUserId: USER_ID,
      executor: fake.db as never,
    });
    fake.state.approvals[0].status = "approved";
    fake.state.approvals[0].approvedAt = new Date("2026-07-01T12:00:00.000Z");

    const sealedAudit = fake.state.audits.find((a) => a.eventType === "learning_promotion_resolved");
    expect(sealedAudit).toBeDefined();
    expect(sealedAudit!.approvalRequestId).toBe(proposal.approvalRequestId);

    const envelopes = await getApprovedPromotionEnvelopes({
      userId: USER_ID,
      campaignId: 7,
      executor: fake.db as never,
    });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toEqual(envelope);
    expect(envelopes[0].decision).toBe("approved");
    expect(envelopes[0].decidedAt).toBe("2026-07-01T12:00:00.000Z");
    expect(envelopes[0].promoted.provenanceClass).toBe("approved_recommendation");
    expect(
      envelopes[0].evidence.every((e) => e.provenanceClass !== "approved_recommendation")
    ).toBe(true);
  });

  it("fails closed when the learning authority drifts after sealing", async () => {
    const fake = createFakeDb();
    const { proposal } = await propose(fake.db);
    await sealApprovedLearningPromotionEnvelope({
      request: {
        id: proposal.approvalRequestId,
        userId: USER_ID,
        campaignId: 7,
        context: fake.state.approvals[0].context,
      },
      decidedAt: new Date("2026-07-01T12:00:00.000Z"),
      decidedByUserId: USER_ID,
      executor: fake.db as never,
    });
    fake.state.approvals[0].status = "approved";

    // The historical learning record is never mutated by this stream; simulate
    // external drift to prove consumption fails closed anyway.
    (fake.state.learningRecords[0].recommendedAdjustments as RecommendedAdjustment[])[0] = {
      ...RECOMMENDATION,
      summary: "drifted summary",
    };

    const envelopes = await getApprovedPromotionEnvelopes({
      userId: USER_ID,
      campaignId: 7,
      executor: fake.db as never,
    });
    expect(envelopes).toEqual([]);
  });
});
