import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/workflow/triggers", () => ({
  onApprovalResolved: vi.fn(async () => {}),
}));

import { getDb } from "./queries/connection";
import { onApprovalResolved } from "./lib/workflow/triggers";
import { approvalRouter } from "./approval-router";
import { learningPromotionRouter } from "./learning-promotion-router";
import { LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE } from "./lib/learning/promotion/promotion-contract";
import type { RecommendedAdjustment } from "./lib/learning/contracts/learning-derivation";

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

function learningRecordRow() {
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
    evidence: [
      { kind: "observation", ref: "obs:1", note: "clicks=60 on instagram at 2026-05-02 (analytics row 9)" },
      { kind: "observation", ref: "obs:2", note: "conversions=1 on instagram at 2026-05-02 (analytics row 10)" },
    ],
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
  };
}

interface IntegrationState {
  approvals: Record<string, unknown>[];
  learningRecords: Record<string, unknown>[];
  campaigns: Record<string, unknown>[];
  audits: Record<string, unknown>[];
  insertTables: string[];
  updateTables: string[];
  nextApprovalId: number;
  nextAuditId: number;
  transactions: number;
  committed: boolean;
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

function createIntegrationDb() {
  const state: IntegrationState = {
    approvals: [],
    learningRecords: [learningRecordRow()],
    campaigns: [{ id: 7, userId: 22, businessId: null, workflowState: "active", workflowContext: {} }],
    audits: [],
    insertTables: [],
    updateTables: [],
    nextApprovalId: 1,
    nextAuditId: 1,
    transactions: 0,
    committed: false,
  };

  const matchRows = (name: string, conds: unknown[]) => {
    const { strings, numbers } = deepScalars(conds, { strings: [], numbers: [] });
    if (name === "learning_records") {
      return state.learningRecords.filter((r) => numbers.includes(r.id as number) && numbers.includes(r.userId as number));
    }
    if (name === "campaigns") {
      return state.campaigns.filter((r) => numbers.includes(r.id as number) && numbers.includes(r.userId as number));
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
    limit: async (n: number) => matchRows(name, conds).slice(0, n).map((r) => ({ ...r })),
    orderBy: async () => {
      const rows = matchRows(name, conds).slice();
      rows.sort((a, b) => {
        const bt = new Date(String(b.createdAt ?? b.occurredAt ?? 0)).getTime();
        const at = new Date(String(a.createdAt ?? a.occurredAt ?? 0)).getTime();
        return bt - at;
      });
      return rows.map((r) => ({ ...r }));
    },
  });

  const buildClient = () => ({
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table);
        return {
          where: (...conds: unknown[]) => chainFor(name ?? "", conds),
          orderBy: async () => {
            const source =
              name === "approval_requests"
                ? state.approvals
                : name === "audit_events"
                  ? state.audits
                  : name === "learning_records"
                    ? state.learningRecords
                    : [];
            return source.map((r) => ({ ...r }));
          },
        };
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
      const name = getTableName(table);
      state.updateTables.push(name ?? "unknown");
      return {
        set: (payload: Record<string, unknown>) => ({
          where: async (...conds: unknown[]) => {
            const { numbers } = deepScalars(conds, { strings: [], numbers: [] });
            if (name === "approval_requests") {
              const affected = state.approvals.filter(
                (r) =>
                  numbers.includes(r.id as number) &&
                  numbers.includes(r.userId as number) &&
                  r.status === "pending"
              );
              for (const row of affected) Object.assign(row, payload);
              return [{ affectedRows: affected.length }];
            }
            return [{ affectedRows: 0 }];
          },
        }),
      };
    },
  });

  const outer = buildClient();
  const db = {
    ...outer,
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      state.transactions += 1;
      const result = await cb(buildClient());
      state.committed = true;
      return result;
    },
  };

  return { db, state };
}

function buildCtx() {
  return {
    resHeaders: new Headers(),
    user: { id: 22, tierSlug: "free" },
    session: { verified: true },
  } as never;
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

const promotionCaller = () => learningPromotionRouter.createCaller(buildCtx());
const approvalCaller = () => approvalRouter.createCaller(buildCtx());

async function proposePromotion() {
  return promotionCaller().propose({
    learningRecordId: 501,
    recommendationId: "rec_align_offer_conversion",
  });
}

describe("learning promotion governed boundary (WBS15.6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propose → approval-centre approve seals the envelope; full audit lineage retained", async () => {
    const { db, state } = createIntegrationDb();
    vi.mocked(getDb).mockReturnValue(db as never);

    const { proposal } = await proposePromotion();
    expect(proposal.status).toBe("pending");

    // No autonomous promotion: pending alone creates no consumable authority.
    const pendingEnvelopes = await promotionCaller().approvedEnvelopes({ campaignId: 7 });
    expect(pendingEnvelopes).toEqual([]);

    const decision = await approvalCaller().approveAction({ approvalId: proposal.approvalRequestId });
    expect(decision).toEqual({
      success: true,
      campaignId: 7,
      approvalType: LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE,
    });
    await flushMicrotasks();

    const row = state.approvals[0];
    expect(row.status).toBe("approved");
    expect(row.approvedAt).toBeInstanceOf(Date);

    // The decision triggered no workflow side effects for promotion rows.
    expect(onApprovalResolved).toHaveBeenCalledTimes(1);

    // Full audit lineage: ask → human decision → sealed envelope.
    const eventTypes = state.audits.map((a) => a.eventType);
    expect(eventTypes).toEqual([
      "approval_requested",
      "approval_resolved",
      "learning_promotion_resolved",
    ]);
    const resolved = state.audits[1];
    expect((resolved.metadata as Record<string, unknown>).decision).toBe("approved");
    const sealed = state.audits[2];
    expect(sealed.approvalRequestId).toBe(proposal.approvalRequestId);
    expect(sealed.occurredAt).toBe((row.approvedAt as Date).toISOString());
    const sealedMetadata = sealed.metadata as Record<string, unknown>;
    expect(sealedMetadata.proposalFingerprint).toBe(proposal.proposalFingerprint);
    expect(sealedMetadata.campaignId).toBe(7);
    expect(sealedMetadata.learningRecordId).toBe(501);

    // Future-consumption envelope is available with provenance preserved.
    const envelopes = await promotionCaller().approvedEnvelopes({ campaignId: 7 });
    expect(envelopes).toHaveLength(1);
    const envelope = envelopes[0];
    expect(envelope.proposalFingerprint).toBe(proposal.proposalFingerprint);
    expect(envelope.decision).toBe("approved");
    expect(envelope.decidedByUserId).toBe(22);
    expect(envelope.targetEngine).toBe("strategy");
    expect(envelope.promoted.provenanceClass).toBe("approved_recommendation");
    expect(envelope.promoted.summary).toBe(RECOMMENDATION.summary);
    expect(
      envelope.evidence.every((e) => e.provenanceClass !== "approved_recommendation")
    ).toBe(true);
    expect(envelope.evidence.map((e) => e.ref)).toEqual(["obs:1", "obs:2"]);

    // No BI/Strategy mutation: the only table ever updated is the approval
    // row itself (the guarded terminal decision).
    expect(state.updateTables).toEqual(["approval_requests"]);
    expect(state.insertTables).toEqual([
      "approval_requests", // the proposal
      "audit_events", // approval_requested
      "audit_events", // approval_resolved
      "audit_events", // learning_promotion_resolved (sealed envelope)
    ]);

    // No historical learning mutation.
    expect(state.learningRecords[0].recommendedAdjustments).toEqual([RECOMMENDATION]);
    expect(state.learningRecords[0].status).toBe("recorded");
  });

  it("mismatched learning record fails closed at decision time", async () => {
    const { db, state } = createIntegrationDb();
    vi.mocked(getDb).mockReturnValue(db as never);

    const { proposal } = await proposePromotion();
    // The source learning changes after the proposal was bound.
    (state.learningRecords[0].recommendedAdjustments as RecommendedAdjustment[])[0] = {
      ...RECOMMENDATION,
      summary: "the recommendation drifted",
    };

    await expect(
      approvalCaller().approveAction({ approvalId: proposal.approvalRequestId })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(state.approvals[0].status).toBe("pending");
    expect(state.audits.map((a) => a.eventType)).toEqual(["approval_requested"]);
    expect(state.transactions).toBe(1);
    expect(state.committed).toBe(false);
    await flushMicrotasks();
    expect(onApprovalResolved).not.toHaveBeenCalled();
  });

  it("mismatched proposal coordinates (tampered context) fail closed", async () => {
    const { db, state } = createIntegrationDb();
    vi.mocked(getDb).mockReturnValue(db as never);

    const { proposal } = await proposePromotion();
    const context = state.approvals[0].context as Record<string, unknown>;
    (context.coordinates as Record<string, unknown>).learningRecordId = 999;

    await expect(
      approvalCaller().approveAction({ approvalId: proposal.approvalRequestId })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(state.approvals[0].status).toBe("pending");
  });

  it("edited approvals are refused for promotion rows", async () => {
    const { db, state } = createIntegrationDb();
    vi.mocked(getDb).mockReturnValue(db as never);

    const { proposal } = await proposePromotion();
    await expect(
      approvalCaller().editAndApproveAction({
        approvalId: proposal.approvalRequestId,
        editedPayload: { summary: "changed by editor" },
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(state.approvals[0].status).toBe("pending");
  });

  it("rejected proposals change no authority, remain auditable, and are never consumable", async () => {
    const { db, state } = createIntegrationDb();
    vi.mocked(getDb).mockReturnValue(db as never);

    const { proposal } = await proposePromotion();
    await approvalCaller().rejectAction({
      approvalId: proposal.approvalRequestId,
      notes: "not enough evidence to promote",
    });
    await flushMicrotasks();

    expect(state.approvals[0].status).toBe("rejected");
    // The rejection stays visible as evidence.
    const proposals = await promotionCaller().proposals({ campaignId: 7 });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("rejected");

    const envelopes = await promotionCaller().approvedEnvelopes({ campaignId: 7 });
    expect(envelopes).toEqual([]);

    const eventTypes = state.audits.map((a) => a.eventType);
    expect(eventTypes).toEqual(["approval_requested", "approval_resolved"]);
    expect(
      (state.audits[1].metadata as Record<string, unknown>).decision
    ).toBe("rejected");
  });

  it("double decision on the same proposal does not create duplicate authority", async () => {
    const { db, state } = createIntegrationDb();
    vi.mocked(getDb).mockReturnValue(db as never);

    const { proposal } = await proposePromotion();
    await approvalCaller().approveAction({ approvalId: proposal.approvalRequestId });
    await expect(
      approvalCaller().approveAction({ approvalId: proposal.approvalRequestId })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const envelopes = await promotionCaller().approvedEnvelopes({ campaignId: 7 });
    expect(envelopes).toHaveLength(1);
    const sealCount = state.audits.filter((a) => a.eventType === "learning_promotion_resolved").length;
    expect(sealCount).toBe(1);
  });

  it("proposing the same recommendation twice yields one proposal and one envelope after approval", async () => {
    const { db, state } = createIntegrationDb();
    vi.mocked(getDb).mockReturnValue(db as never);

    const first = await proposePromotion();
    const second = await proposePromotion();
    expect(second.outcome).toBe("reused");
    expect(state.approvals).toHaveLength(1);

    await approvalCaller().approveAction({ approvalId: first.proposal.approvalRequestId });
    const envelopes = await promotionCaller().approvedEnvelopes({ campaignId: 7 });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].proposalFingerprint).toBe(first.proposal.proposalFingerprint);
    expect(second.proposal.approvalRequestId).toBe(first.proposal.approvalRequestId);
  });

  it("ownership is enforced across the whole surface", async () => {
    const { db } = createIntegrationDb();
    vi.mocked(getDb).mockReturnValue(db as never);

    const otherCtx = {
      resHeaders: new Headers(),
      user: { id: 999, tierSlug: "free" },
      session: { verified: true },
    } as never;

    await expect(
      learningPromotionRouter
        .createCaller(otherCtx)
        .propose({ learningRecordId: 501, recommendationId: "rec_align_offer_conversion" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      learningPromotionRouter.createCaller(otherCtx).approvedEnvelopes({ campaignId: 7 })
    ).resolves.toEqual([]);
  });
});
