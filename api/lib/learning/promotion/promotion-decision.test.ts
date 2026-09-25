import { describe, it, expect, beforeEach } from "vitest";
import {
  isLearningPromotionApproval,
  sealApprovedLearningPromotionEnvelope,
  validateLearningPromotionApprovalBinding,
} from "./promotion-decision";
import {
  buildLearningPromotionContext,
  buildLearningPromotionProposalFingerprint,
  type LearningPromotionCoordinates,
} from "./promotion-contract";
import type { RecommendedAdjustment } from "../contracts/learning-derivation";

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

const COORDINATES: LearningPromotionCoordinates = {
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
};

function buildRequest(context: unknown) {
  return {
    id: 77,
    userId: 22,
    approvalType: "high_value_proposal" as const,
    context,
  };
}

function validContext() {
  return buildLearningPromotionContext({
    coordinates: COORDINATES,
    proposalFingerprint: buildLearningPromotionProposalFingerprint(COORDINATES),
  });
}

interface FakeState {
  learningRecords: Record<string, unknown>[];
  audits: Record<string, unknown>[];
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

function createFakeDb(recordOverrides: Record<string, unknown> = {}) {
  const state: FakeState = {
    learningRecords: [
      {
        id: 501,
        userId: 22,
        campaignId: 7,
        evaluationVersion: "learning-v1",
        evidence: [
          { kind: "observation", ref: "obs:1", note: "n1" },
          { kind: "rule", ref: "obs:2", note: "n2" },
        ],
        recommendedAdjustments: [RECOMMENDATION],
        provenance: {
          engine: "learning-engine",
          engineVersion: "learning-v1",
          inputDigest: "digest-abc",
        },
        ...recordOverrides,
      },
    ],
    audits: [],
  };

  const matchRows = (name: string, conds: unknown[]) => {
    const { strings, numbers } = deepScalars(conds, { strings: [], numbers: [] });
    if (name === "learning_records") {
      return state.learningRecords.filter((r) => numbers.includes(r.id as number) && numbers.includes(r.userId as number));
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

  return {
    state,
    executor: {
      select: () => ({
        from: (table: unknown) => ({
          where: (...conds: unknown[]) => ({
            limit: async (n: number) => matchRows(getTableName(table) ?? "", conds).slice(0, n),
            orderBy: async () => matchRows(getTableName(table) ?? "", conds).map((r) => ({ ...r })),
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: async (row: Record<string, unknown>) => {
          const name = getTableName(table);
          if (name === "audit_events") {
            state.audits.push({ ...row, id: state.audits.length + 1 });
          }
          return [{ insertId: state.audits.length, affectedRows: 1 }];
        },
      }),
    },
  };
}

describe("isLearningPromotionApproval", () => {
  it("requires the carrier type AND the learning_promotion discriminator", () => {
    expect(isLearningPromotionApproval({ approvalType: "high_value_proposal", context: validContext() })).toBe(true);
    expect(isLearningPromotionApproval({ approvalType: "budget_increase", context: validContext() })).toBe(false);
    expect(isLearningPromotionApproval({ approvalType: "high_value_proposal", context: null })).toBe(false);
    expect(isLearningPromotionApproval({ approvalType: "high_value_proposal", context: { source: "other" } })).toBe(false);
  });

  it("still detects a promotion row whose context fingerprint was tampered with", () => {
    const tampered = JSON.parse(JSON.stringify(validContext()));
    tampered.coordinates.summary = "altered";
    expect(isLearningPromotionApproval({ approvalType: "high_value_proposal", context: tampered })).toBe(true);
  });
});

describe("validateLearningPromotionApprovalBinding", () => {
  let fake: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    fake = createFakeDb();
  });

  const validate = (context: unknown, decisionKind: "approve" | "reject" | "edit" = "approve") =>
    validateLearningPromotionApprovalBinding({
      request: buildRequest(context),
      decisionKind,
      executor: fake.executor as never,
    });

  it("passes when the live learning record exactly matches the bound proposal", async () => {
    await expect(validate(validContext())).resolves.toBeUndefined();
  });

  it("rejects edited approvals (edits would break the exact proposal fingerprint binding)", async () => {
    await expect(validate(validContext(), "edit")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("fails closed when the immutable proposal context is missing or invalid", async () => {
    await expect(validate(null)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const tampered = JSON.parse(JSON.stringify(validContext()));
    tampered.proposalFingerprint = "0".repeat(64);
    await expect(validate(tampered)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the bound learning record is missing (mismatched learning record)", async () => {
    fake.state.learningRecords = [];
    await expect(validate(validContext())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the record's campaign no longer matches the proposal", async () => {
    fake.state.learningRecords[0].campaignId = 8;
    await expect(validate(validContext())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the evaluation version drifts", async () => {
    fake.state.learningRecords[0].evaluationVersion = "learning-v2";
    await expect(validate(validContext())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the learning authority (engine/version/digest) drifts", async () => {
    fake.state.learningRecords[0].provenance = {
      engine: "learning-engine",
      engineVersion: "learning-v1",
      inputDigest: "different-digest",
    };
    await expect(validate(validContext())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the bound recommendation disappears (mismatched recommendation)", async () => {
    fake.state.learningRecords[0].recommendedAdjustments = [];
    await expect(validate(validContext())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the recommendation content drifts from the proposal", async () => {
    fake.state.learningRecords[0].recommendedAdjustments = [
      { ...RECOMMENDATION, summary: "drifted" },
    ];
    await expect(validate(validContext())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    fake.state.learningRecords[0].recommendedAdjustments = [
      { ...RECOMMENDATION, evidenceRefs: ["obs:1", "obs:3"] },
    ];
    await expect(validate(validContext())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("sealApprovedLearningPromotionEnvelope", () => {
  it("seals the exact envelope as an immutable learning_promotion_resolved audit event", async () => {
    const fake = createFakeDb();
    const context = validContext();

    const envelope = await sealApprovedLearningPromotionEnvelope({
      request: { id: 77, userId: 22, campaignId: 7, context },
      decidedAt: new Date("2026-07-01T12:00:00.000Z"),
      decidedByUserId: 22,
      executor: fake.executor as never,
    });

    expect(envelope.proposalFingerprint).toBe(context.proposalFingerprint);
    expect(envelope.decision).toBe("approved");
    expect(envelope.promoted.recommendationId).toBe("rec_align_offer_conversion");

    expect(fake.state.audits).toHaveLength(1);
    const sealed = fake.state.audits[0];
    expect(sealed.eventType).toBe("learning_promotion_resolved");
    expect(sealed.eventFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.approvalRequestId).toBe(77);
    expect(sealed.occurredAt).toBe("2026-07-01T12:00:00.000Z");
    expect(sealed.userId).toBe(22);
    expect(sealed.campaignId).toBe(7);
    const metadata = sealed.metadata as Record<string, unknown>;
    expect(metadata.proposalFingerprint).toBe(context.proposalFingerprint);
    expect((metadata.promoted as Record<string, unknown>).provenanceClass).toBe("approved_recommendation");
  });

  it("refuses to seal when the proposal context is invalid or the record is gone", async () => {
    const fake = createFakeDb();
    await expect(
      sealApprovedLearningPromotionEnvelope({
        request: { id: 77, userId: 22, campaignId: 7, context: null },
        decidedAt: new Date("2026-07-01T12:00:00.000Z"),
        decidedByUserId: 22,
        executor: fake.executor as never,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    fake.state.learningRecords = [];
    await expect(
      sealApprovedLearningPromotionEnvelope({
        request: { id: 77, userId: 22, campaignId: 7, context: validContext() },
        decidedAt: new Date("2026-07-01T12:00:00.000Z"),
        decidedByUserId: 22,
        executor: fake.executor as never,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(fake.state.audits).toHaveLength(0);
  });
});
