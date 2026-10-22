import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE,
  buildLearningPromotionContext,
  buildLearningPromotionProposalFingerprint,
  type LearningPromotionCoordinates,
} from "./promotion/promotion-contract";
import { buildApprovedPromotionEnvelope } from "./promotion/promotion-envelope";
import {
  buildApprovedLearningPromotionPromptSection,
  buildNextCycleIdentity,
  buildStrategyLearningPromotionLineage,
  NEXT_CYCLE_IDENTITY_PREFIX,
  NEXT_CYCLE_INSTRUCTION_STATUSES,
  parseNextCycleInstruction,
  resolveApprovedLearningPromotionsForStrategy,
  strategyLearningPromotionLineageToJson,
} from "./learning-strategy-consumption";
import type { EvidenceItem, RecommendedAdjustment } from "./contracts/learning-derivation";
import type { ApprovedPromotionEnvelope } from "./promotion/promotion-envelope";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

const RECORD_EVIDENCE: EvidenceItem[] = [
  { kind: "observation", ref: "ao:1", note: "clicks=60 on instagram at 2026-05-02 (analytics row 9)" },
];

function makeRecommendation(overrides: Partial<RecommendedAdjustment> = {}): RecommendedAdjustment {
  return {
    id: "rec_improve_hook_ctr",
    targetEngine: "creative",
    adjustmentType: "improve_hook_ctr",
    summary: "Strengthen hooks and primary creative to lift click-through.",
    rationale: "Weak click-through rate recorded in the evaluation window.",
    evidenceRefs: ["ao:1"],
    governance: { autoApply: false, requiresApproval: true },
    ...overrides,
  };
}

interface EnvelopeFixtureOptions {
  learningRecordId: number;
  campaignId: number;
  approvalRequestId: number;
  evaluationVersion?: string;
  engineVersion?: string;
  inputDigest?: string;
  recommendation?: RecommendedAdjustment;
}

interface EnvelopeFixture {
  coordinates: LearningPromotionCoordinates;
  context: ReturnType<typeof buildLearningPromotionContext>;
  proposalFingerprint: string;
  envelope: ApprovedPromotionEnvelope;
  approvalRow: Record<string, unknown>;
  learningRecordRow: Record<string, unknown>;
  auditRow: Record<string, unknown>;
}

function makeEnvelopeFixture(options: EnvelopeFixtureOptions): EnvelopeFixture {
  const evaluationVersion = options.evaluationVersion ?? "learning-v2";
  const engineVersion = options.engineVersion ?? evaluationVersion;
  const inputDigest = options.inputDigest ?? `digest-${options.learningRecordId}`;
  const recommendation = options.recommendation ?? makeRecommendation();

  const coordinates: LearningPromotionCoordinates = {
    learningRecordId: options.learningRecordId,
    campaignId: options.campaignId,
    evaluationVersion,
    learningEngine: "learning-engine",
    learningEngineVersion: engineVersion,
    learningInputDigest: inputDigest,
    recommendationId: recommendation.id,
    targetEngine: recommendation.targetEngine,
    adjustmentType: recommendation.adjustmentType,
    summary: recommendation.summary,
    rationale: recommendation.rationale,
    evidenceRefs: [...recommendation.evidenceRefs],
  };
  const proposalFingerprint = buildLearningPromotionProposalFingerprint(coordinates);
  const context = buildLearningPromotionContext({ coordinates, proposalFingerprint });
  const envelope = buildApprovedPromotionEnvelope({
    context,
    approvalRequestId: options.approvalRequestId,
    decidedAt: "2026-06-10T00:00:00.000Z",
    decidedByUserId: 22,
    recordEvidence: RECORD_EVIDENCE,
  });

  return {
    coordinates,
    context,
    proposalFingerprint,
    envelope,
    approvalRow: {
      id: options.approvalRequestId,
      userId: 22,
      campaignId: options.campaignId,
      approvalType: LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE,
      title: "Learning Promotion (creative): Strengthen hooks",
      description: null,
      aiRecommendation: null,
      riskLevel: "medium",
      status: "approved",
      approvedAt: new Date("2026-06-10T00:00:00.000Z"),
      rejectedAt: null,
      idempotencyKey: `lp:${proposalFingerprint}`,
      context,
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
    },
    learningRecordRow: {
      id: options.learningRecordId,
      userId: 22,
      campaignId: options.campaignId,
      evaluationVersion,
      provenance: {
        engine: "learning-engine",
        engineVersion,
        trigger: "api",
        inputDigest,
        evaluatedAt: "2026-06-01T00:00:00.000Z",
      },
      recommendedAdjustments: [recommendation],
      evidence: RECORD_EVIDENCE,
      status: "recorded",
    },
    auditRow: {
      id: 9000 + options.approvalRequestId,
      approvalRequestId: options.approvalRequestId,
      eventType: "learning_promotion_resolved",
      occurredAt: "2026-06-10T00:00:00.000Z",
      metadata: envelope,
    },
  };
}

interface FakeSeed {
  targetCampaign: Record<string, unknown>;
  siblingCampaigns: Record<string, unknown>[];
  learningRecords: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
  audits: Record<string, unknown>[];
}

function createFake(seed: FakeSeed) {
  const chainFor = (name: string, conds: unknown[]) => {
    const numbers: number[] = [];
    const strings: string[] = [];
    const walk = (value: unknown, depth: number) => {
      if (depth > 10 || value === null || value === undefined) return;
      if (typeof value === "string") {
        strings.push(value);
        return;
      }
      if (typeof value === "number") {
        numbers.push(value);
        return;
      }
      if (typeof value === "object") {
        for (const v of Object.values(value)) walk(v, depth + 1);
      }
    };
    walk(conds, 0);

    const matchRows = (): Record<string, unknown>[] => {
      if (name === "campaigns") return [seed.targetCampaign];
      if (name === "learning_records") {
        return seed.learningRecords.filter(
          (r) => numbers.includes(r.id as number) && numbers.includes(r.userId as number)
        );
      }
      if (name === "approval_requests") {
        return seed.approvals.filter(
          (r) => numbers.includes(r.userId as number) && numbers.includes(r.campaignId as number)
        );
      }
      if (name === "audit_events") {
        return seed.audits.filter(
          (r) =>
            strings.includes(r.eventType as string) &&
            numbers.includes(r.approvalRequestId as number)
        );
      }
      return [];
    };

    return {
      limit: async (n: number) => matchRows().slice(0, n).map((r) => ({ ...r })),
      orderBy: async () =>
        matchRows()
          .slice()
          .sort(
            (a, b) =>
              new Date(String(b.createdAt ?? b.occurredAt ?? 0)).getTime() -
              new Date(String(a.createdAt ?? a.occurredAt ?? 0)).getTime()
          )
          .map((r) => ({ ...r })),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(matchRows().map((r) => ({ ...r }))).then(resolve, reject),
    };
  };

  return {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table) ?? "";
        if (name === "campaigns") {
          return {
            where: () => ({
              limit: async (n: number) => [seed.targetCampaign].slice(0, n).map((r) => ({ ...r })),
              orderBy: async () => seed.siblingCampaigns.map((r) => ({ ...r })),
            }),
            orderBy: async () => seed.siblingCampaigns.map((r) => ({ ...r })),
            limit: async (n: number) => [seed.targetCampaign].slice(0, n).map((r) => ({ ...r })),
          };
        }
        return {
          where: (...conds: unknown[]) => chainFor(name, conds),
          orderBy: async () => [] as Record<string, unknown>[],
          limit: async () => [] as Record<string, unknown>[],
        };
      },
    }),
  } as never;
}

function baseSeed() {
  const approved7 = makeEnvelopeFixture({
    learningRecordId: 501,
    campaignId: 7,
    approvalRequestId: 71,
  });
  const approved43 = makeEnvelopeFixture({
    learningRecordId: 601,
    campaignId: 43,
    approvalRequestId: 72,
    recommendation: makeRecommendation({
      id: "rec_rebalance_platform_mix",
      targetEngine: "distribution",
      adjustmentType: "rebalance_platform_mix",
      summary: "Broaden distribution across additional platforms.",
      rationale: "Single-platform concentration recorded.",
      evidenceRefs: ["ao:9"],
    }),
  });
  // Cross-business campaign: owned by the same user, different business.
  const crossBusiness = makeEnvelopeFixture({
    learningRecordId: 701,
    campaignId: 44,
    approvalRequestId: 73,
  });
  return { approved7, approved43, crossBusiness };
}

describe("resolveApprovedLearningPromotionsForStrategy", () => {
  it("consumes same-business promotions and rejects cross-business contamination", async () => {
    const { approved7, approved43, crossBusiness } = baseSeed();
    const fake = createFake({
      targetCampaign: { id: 7, businessId: 5 },
      siblingCampaigns: [{ id: 7 }, { id: 43 }],
      learningRecords: [
        approved7.learningRecordRow,
        approved43.learningRecordRow,
        crossBusiness.learningRecordRow,
      ],
      approvals: [approved7.approvalRow, approved43.approvalRow, crossBusiness.approvalRow],
      audits: [approved7.auditRow, approved43.auditRow, crossBusiness.auditRow],
    });

    const input = await resolveApprovedLearningPromotionsForStrategy({
      userId: 22,
      campaignId: 7,
      executor: fake,
    });

    expect(input.scope).toBe("same-business");
    expect(input.businessId).toBe(5);
    // Same-business sibling (43) is eligible; business-6 campaign (44) is not.
    expect(input.promotions.map((p) => p.sourceCampaignId).sort((a, b) => a - b)).toEqual([7, 43]);
    expect(input.promotions.every((p) => p.promotedProvenanceClass === "approved_recommendation")).toBe(
      true
    );
    const from43 = input.promotions.find((p) => p.sourceCampaignId === 43)!;
    expect(from43.recommendationId).toBe("rec_rebalance_platform_mix");
    expect(from43.evaluationVersion).toBe("learning-v2");
    expect(from43.proposalFingerprint).toBe(approved43.proposalFingerprint);
  });

  it("fails closed to same-campaign reuse when the campaign has no durable business scope", async () => {
    const { approved7, approved43 } = baseSeed();
    const fake = createFake({
      targetCampaign: { id: 7, businessId: null },
      siblingCampaigns: [],
      learningRecords: [approved7.learningRecordRow, approved43.learningRecordRow],
      approvals: [approved7.approvalRow, approved43.approvalRow],
      audits: [approved7.auditRow, approved43.auditRow],
    });

    const input = await resolveApprovedLearningPromotionsForStrategy({
      userId: 22,
      campaignId: 7,
      executor: fake,
    });

    expect(input.scope).toBe("same-campaign");
    expect(input.businessId).toBeNull();
    expect(input.promotions.map((p) => p.sourceCampaignId)).toEqual([7]);
  });

  it("never consumes pending or rejected proposals", async () => {
    const { approved7 } = baseSeed();
    const pending = {
      ...approved7.approvalRow,
      id: 81,
      status: "pending",
      idempotencyKey: "lp:pending",
      context: approved7.context,
    };
    const rejected = {
      ...approved7.approvalRow,
      id: 82,
      status: "rejected",
      rejectedAt: new Date("2026-06-11T00:00:00.000Z"),
      idempotencyKey: "lp:rejected",
      context: approved7.context,
    };
    const fake = createFake({
      targetCampaign: { id: 7, businessId: null },
      siblingCampaigns: [],
      learningRecords: [approved7.learningRecordRow],
      approvals: [approved7.approvalRow, pending, rejected],
      audits: [approved7.auditRow],
    });

    const input = await resolveApprovedLearningPromotionsForStrategy({
      userId: 22,
      campaignId: 7,
      executor: fake,
    });

    expect(input.promotions.map((p) => p.approvalRequestId)).toEqual([71]);
  });

  it("never consumes an approved request whose envelope was never sealed", async () => {
    const { approved7 } = baseSeed();
    const fake = createFake({
      targetCampaign: { id: 7, businessId: null },
      siblingCampaigns: [],
      learningRecords: [approved7.learningRecordRow],
      approvals: [approved7.approvalRow],
      audits: [],
    });

    const input = await resolveApprovedLearningPromotionsForStrategy({
      userId: 22,
      campaignId: 7,
      executor: fake,
    });
    expect(input.promotions).toEqual([]);
  });

  it("never consumes an envelope whose bound learning authority drifted", async () => {
    const { approved7 } = baseSeed();
    const driftedRecord = {
      ...approved7.learningRecordRow,
      recommendedAdjustments: [
        makeRecommendation({ summary: "Tampered summary after sealing" }),
      ],
    };
    const fake = createFake({
      targetCampaign: { id: 7, businessId: null },
      siblingCampaigns: [],
      learningRecords: [driftedRecord],
      approvals: [approved7.approvalRow],
      audits: [approved7.auditRow],
    });

    const input = await resolveApprovedLearningPromotionsForStrategy({
      userId: 22,
      campaignId: 7,
      executor: fake,
    });
    expect(input.promotions).toEqual([]);
  });

  it("returns empty input when the campaign does not exist", async () => {
    const fake = createFake({
      targetCampaign: undefined as never,
      siblingCampaigns: [],
      learningRecords: [],
      approvals: [],
      audits: [],
    });
    const input = await resolveApprovedLearningPromotionsForStrategy({
      userId: 22,
      campaignId: 404,
      executor: fake,
    });
    expect(input).toEqual({ scope: "same-campaign", businessId: null, promotions: [] });
  });
});

describe("approved Learning Strategy input builders", () => {
  it("labels the prompt section as approved recommendations, not facts", () => {
    const { approved7, approved43 } = baseSeed();
    const section = buildApprovedLearningPromotionPromptSection({
      scope: "same-business",
      businessId: 5,
      promotions: [
        {
          sourceCampaignId: 7,
          learningRecordId: 501,
          evaluationVersion: "learning-v2",
          learningEngineVersion: "learning-v2",
          recommendationId: "rec_improve_hook_ctr",
          targetEngine: "creative",
          adjustmentType: "improve_hook_ctr",
          summary: "Strengthen hooks and primary creative to lift click-through.",
          rationale: "Weak click-through rate recorded in the evaluation window.",
          evidenceRefs: ["ao:1"],
          approvalRequestId: 71,
          proposalFingerprint: approved7.proposalFingerprint,
          decidedAt: "2026-06-10T00:00:00.000Z",
          promotedProvenanceClass: "approved_recommendation",
        },
        {
          sourceCampaignId: 43,
          learningRecordId: 601,
          evaluationVersion: "learning-v2",
          learningEngineVersion: "learning-v2",
          recommendationId: "rec_rebalance_platform_mix",
          targetEngine: "distribution",
          adjustmentType: "rebalance_platform_mix",
          summary: "Broaden distribution across additional platforms.",
          rationale: "Single-platform concentration recorded.",
          evidenceRefs: ["ao:9"],
          approvalRequestId: 72,
          proposalFingerprint: approved43.proposalFingerprint,
          decidedAt: "2026-06-10T00:00:00.000Z",
          promotedProvenanceClass: "approved_recommendation",
        },
      ],
    })!;

    expect(section).toContain("APPROVED LEARNING PROMOTIONS");
    expect(section).toContain("provenanceClass: approved_recommendation");
    expect(section).toContain("NOT OBSERVED FACTS");
    expect(section).toContain(approved7.proposalFingerprint);
    expect(section).toContain(approved43.proposalFingerprint);
    expect(buildApprovedLearningPromotionPromptSection({ scope: "same-campaign", businessId: null, promotions: [] })).toBeNull();
  });

  it("persists explicit lineage for a future Strategy version (reconstructable snapshot input)", () => {
    const { approved7 } = baseSeed();
    const lineage = buildStrategyLearningPromotionLineage({
      scope: "same-campaign",
      businessId: null,
      promotions: [
        {
          sourceCampaignId: 7,
          learningRecordId: 501,
          evaluationVersion: "learning-v2",
          learningEngineVersion: "learning-v2",
          recommendationId: "rec_improve_hook_ctr",
          targetEngine: "creative",
          adjustmentType: "improve_hook_ctr",
          summary: "Strengthen hooks",
          rationale: "Weak CTR",
          evidenceRefs: ["ao:1"],
          approvalRequestId: 71,
          proposalFingerprint: approved7.proposalFingerprint,
          decidedAt: "2026-06-10T00:00:00.000Z",
          promotedProvenanceClass: "approved_recommendation",
        },
      ],
    });

    expect(lineage).toEqual([
      {
        approvalRequestId: 71,
        proposalFingerprint: approved7.proposalFingerprint,
        learningRecordId: 501,
        campaignId: 7,
        evaluationVersion: "learning-v2",
        learningEngineVersion: "learning-v2",
        recommendationId: "rec_improve_hook_ctr",
        targetEngine: "creative",
        adjustmentType: "improve_hook_ctr",
        promotedProvenanceClass: "approved_recommendation",
      },
    ]);

    const json = strategyLearningPromotionLineageToJson(lineage);
    expect(JSON.parse(JSON.stringify(json))).toEqual(lineage);
  });
});

describe("buildNextCycleIdentity", () => {
  const STRATEGY_HASH = createHash("sha256").update("strategy-material").digest("hex");
  const OTHER_STRATEGY_HASH = createHash("sha256")
    .update("other-strategy-material")
    .digest("hex");
  const FP_A = createHash("sha256").update("proposal-a").digest("hex");
  const FP_B = createHash("sha256").update("proposal-b").digest("hex");
  const FP_C = createHash("sha256").update("proposal-c").digest("hex");

  function build(overrides: Partial<Parameters<typeof buildNextCycleIdentity>[0]> = {}) {
    return buildNextCycleIdentity({
      campaignId: 7,
      strategyHashSha256: STRATEGY_HASH,
      proposalFingerprints: [FP_A, FP_B],
      ...overrides,
    });
  }

  it("produces a deterministic next-cycle:v1 identity", () => {
    const identity = build();
    expect(identity.startsWith(NEXT_CYCLE_IDENTITY_PREFIX)).toBe(true);
    expect(identity).toMatch(/^next-cycle:v1:[0-9a-f]{64}$/);
    expect(build()).toBe(identity);
  });

  it("canonicalises fingerprint order so equivalent orders produce identical identities", () => {
    const forward = build({ proposalFingerprints: [FP_A, FP_B, FP_C] });
    const reversed = build({ proposalFingerprints: [FP_C, FP_B, FP_A] });
    expect(reversed).toBe(forward);
  });

  it("changes identity when any material input changes", () => {
    const base = build();
    expect(build({ campaignId: 8 })).not.toBe(base);
    expect(build({ strategyHashSha256: OTHER_STRATEGY_HASH })).not.toBe(base);
    expect(build({ proposalFingerprints: [FP_A, FP_C] })).not.toBe(base);
    expect(build({ proposalFingerprints: [FP_A] })).not.toBe(base);
  });

  it("rejects empty or invalid campaignId", () => {
    for (const campaignId of [0, -1, 1.5, NaN, "7" as unknown as number]) {
      expect(() => build({ campaignId })).toThrow(/campaignId/);
    }
  });

  it("rejects empty or invalid strategy hash", () => {
    for (const strategyHashSha256 of [
      "",
      "   ",
      "not-a-hash",
      "abc123",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      42 as unknown as string,
    ]) {
      expect(() => build({ strategyHashSha256 })).toThrow(/strategyHashSha256/);
    }
  });

  it("rejects an empty fingerprint set", () => {
    expect(() => build({ proposalFingerprints: [] })).toThrow(/non-empty/);
  });

  it("rejects blank fingerprints", () => {
    for (const proposalFingerprints of [["", FP_B], ["   ", FP_B], [FP_A, null as unknown as string]]) {
      expect(() => build({ proposalFingerprints })).toThrow(/non-blank/);
    }
  });

  it("rejects duplicate fingerprints", () => {
    expect(() => build({ proposalFingerprints: [FP_A, FP_A] })).toThrow(/duplicates/);
    expect(() =>
      build({ proposalFingerprints: [FP_B, FP_A, FP_B] })
    ).toThrow(/duplicates/);
  });
});

describe("parseNextCycleInstruction", () => {
  it("parses each supported status", () => {
    for (const status of NEXT_CYCLE_INSTRUCTION_STATUSES) {
      expect(parseNextCycleInstruction({ instructionId: "nci_1", status })).toEqual({
        instructionId: "nci_1",
        status,
      });
    }
  });

  it("rejects malformed objects", () => {
    for (const value of [
      null,
      undefined,
      "instruction",
      42,
      true,
      ["ready"],
      [{ instructionId: "nci_1", status: "ready" }],
    ]) {
      expect(() => parseNextCycleInstruction(value)).toThrow(/plain object/);
    }
  });

  it("rejects unknown fields", () => {
    expect(() =>
      parseNextCycleInstruction({ instructionId: "nci_1", status: "ready", extra: 1 })
    ).toThrow(/unknown field/);
  });

  it("rejects missing, invalid or blank instructionId", () => {
    for (const instructionId of [undefined, null, "", "   ", 7, {}]) {
      expect(() => parseNextCycleInstruction({ instructionId, status: "ready" })).toThrow(
        /instructionId/
      );
    }
  });

  it("rejects missing or unsupported status", () => {
    for (const status of [undefined, null, "", "pending", "READY", 7]) {
      expect(() => parseNextCycleInstruction({ instructionId: "nci_1", status })).toThrow(
        /status/
      );
    }
  });
});
