import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/runner", () => ({
  runAgent: vi.fn(),
  isTestMode: vi.fn(() => true),
}));

vi.mock("../jobs/content-generation-job", () => ({
  processContentGenerationJob: vi.fn(),
}));

vi.mock("../queue/bullmq", () => ({
  isBullMQAvailable: vi.fn(() => false),
  getPublishingQueue: vi.fn(),
  getContentGenerationQueue: vi.fn(),
  toSafeBullMqJobId: vi.fn(),
  toContentGenerationBullMqJobId: vi.fn(),
  toPublishingBullMqJobId: vi.fn(),
  schedulePublishingJob: vi.fn(),
  removePublishingJob: vi.fn(),
  scheduleContentGenerationJob: vi.fn(),
  pausePublishingQueue: vi.fn(),
}));

vi.mock("../agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(),
}));

vi.mock("../agents/distribution-agent", () => ({
  runDistributionAgent: vi.fn(),
}));

vi.mock("./message-approval/shadow-runner", () => ({
  runShadowMessageApproval: vi.fn(() => null),
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import {
  loadAllApprovedMessagePacks,
  saveApprovedMessagePack,
  type CampaignMessagePack,
} from "./campaign-message-architect";
import { computeCreativeBriefFingerprint } from "./brief-grounding";
import { createMessagePackCandidate } from "./message-approval/candidate";
import { evaluateMessageCandidate } from "./message-approval/evaluator";
import { createApprovedMessagePack } from "./message-approval/approve";
import { adaptApprovedToCampaignMessagePack } from "./message-approval/compatibility-adapter";
import {
  campaign30BusinessDna,
  campaign30Policy,
  campaign30ReplayCases,
  campaign30Strategy,
} from "./message-approval/fixtures/campaign30";
import type {
  CanaryApprovalProof,
  MessageApprovalContextLock,
} from "./message-approval/contracts";
import {
  buildPersistedCreativeArtifactLineage,
  deriveCreativeArtifactLineageFingerprint,
} from "./artifact-lineage";
import { specificityScore } from "./campaign-message-architect";

const SHA_X = "0123456789abcdef".repeat(4);

function buildContextLock(): MessageApprovalContextLock {
  return {
    contextLockId: "ctx-lineage-1",
    mode: "canary",
    campaignId: 30,
    businessDna: campaign30BusinessDna,
    businessDnaSnapshotId: campaign30BusinessDna.snapshotId,
    evidenceHashSha256: campaign30BusinessDna.evidenceHashSha256,
    campaignStrategy: campaign30Strategy,
    campaignStrategySnapshotId: campaign30Strategy.snapshotId,
    strategyHashSha256: campaign30Strategy.strategyHashSha256,
    policy: campaign30Policy,
    policyId: campaign30Policy.policyId,
    policyVersion: campaign30Policy.policyVersion,
    policyHashSha256: campaign30Policy.policyHashSha256,
    diagnostics: {
      contextSource: "legacy_loaded_context",
      contextReadyForComparison: true,
      missingContextFields: [],
    },
  };
}

function buildApprovedCanaryPack(): {
  pack: CampaignMessagePack;
  proof: CanaryApprovalProof;
} {
  const replay = campaign30ReplayCases.find((item) => item.caseId === "C");
  if (!replay) throw new Error("Missing approved replay fixture");

  const lock = buildContextLock();
  const candidate = createMessagePackCandidate({
    candidateId: "cand-lineage-1",
    campaignId: 30,
    createdAtIso: "2026-07-01T08:01:00.000Z",
    source: "ai_initial",
    copy: {
      copySchemaVersion: campaign30Policy.copySchemaVersion,
      headline: replay.copy.headline,
      subheadline: replay.copy.subheadline,
      benefitBulletsOrdered: replay.copy.benefitBullets,
      cta: replay.copy.cta,
      footer: { ...replay.copy.footerContact },
      proofPointsOrdered: ["Built for operations managers who need faster settlements"],
      platformCaptionsOrdered: [
        {
          platform: "instagram",
          caption: "Reduce payout delays for operations managers.",
          cta: replay.copy.cta,
          hashtagsOrdered: ["#operations", "#payouts"],
        },
      ],
    },
    businessDnaSnapshotId: lock.businessDnaSnapshotId,
    evidenceHashSha256: lock.evidenceHashSha256,
    campaignStrategySnapshotId: lock.campaignStrategySnapshotId,
    strategyHashSha256: lock.strategyHashSha256,
    qualityPolicyId: lock.policyId,
    qualityPolicyVersion: lock.policyVersion,
    policyHashSha256: lock.policyHashSha256,
    provenance: {
      adaptedFromLegacy: true,
      originSource: "latest_message_pack",
      modelName: null,
      diagnostics: {
        legacyIsGeneric: false,
        legacyValidationPassed: true,
        legacyValidationScore: 95,
        legacyValidationRejections: [],
      },
    },
  });

  const assessment = evaluateMessageCandidate({
    assessmentId: "assess-lineage-1",
    evaluatedAtIso: "2026-07-01T08:02:00.000Z",
    candidate,
    businessDna: campaign30BusinessDna,
    campaignStrategy: campaign30Strategy,
    policy: campaign30Policy,
  });
  if (assessment.decision !== "approved") {
    throw new Error(
      `Fixture candidate must be approved, got ${assessment.decision}: ${JSON.stringify(assessment.hardIssues)}`
    );
  }

  const approved = createApprovedMessagePack({
    approvedRevisionId: "rev-lineage-1",
    approvedAtIso: "2026-07-01T08:03:00.000Z",
    candidate,
    assessment,
    policy: campaign30Policy,
  });

  const { pack, proof } = adaptApprovedToCampaignMessagePack({
    approved,
    assessment,
    contextLock: lock,
    candidateSource: "ai_initial",
    specificityScore,
  });

  return { pack, proof };
}

function createMockDb(options?: {
  campaignFields?: Record<string, unknown>;
  storedRowsRaw?: any[];
}) {
  const storedRows = options?.storedRowsRaw ?? [];

  const tableNameOf = (table: any) =>
    (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
  const insertCalls: Array<{ table: string; values: any }> = [];

  const campaignRow = {
    id: 30,
    userId: 10,
    businessId: 20,
    name: "Zuto Hub Payout Awareness",
    productOrService: "Payout platform",
    targetBuyer: "Restaurants, delivery platforms, and frontline teams",
    mainPainPoint: "manual payout reconciliation",
    offerDetails: "",
    excludedOffers: "",
    preferredCta: "Awareness: Learn More\nConsideration: Book a Demo\nConversion: Request a Walkthrough",
    platforms: "Instagram, Facebook",
    location: "South Africa",
    ...(options?.campaignFields || {}),
  };

  const mock = {
    insertCalls,
    campaignRow,
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => {
              const tableName = tableNameOf(table);
              if (tableName === "campaign_assets") return storedRows;
              return [];
            }),
          })),
          limit: vi.fn(async () => {
            const tableName = tableNameOf(table);
            if (tableName === "campaigns") return [campaignRow];
            if (tableName === "businesses") return [];
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn((table: any) => ({
      values: vi.fn(async (values: any) => {
        insertCalls.push({ table: tableNameOf(table), values });
        return [{ insertId: 501 }];
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((set: any) => ({
        where: vi.fn(async () => []),
      })),
    })),
  };

  return mock;
}

describe("message pack durable lineage (WBS12.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists lineage exactly matching the approval envelope on canary saves", async () => {
    const { pack, proof } = buildApprovedCanaryPack();
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    await saveApprovedMessagePack(10, 30, pack, { mode: "canary", proof });

    expect(db.insertCalls).toHaveLength(1);
    const metadata = db.insertCalls[0].values.metadata;
    const envelope = pack.v2ApprovalEnvelope!;
    const lineage = metadata.creativeArtifactLineage;

    expect(lineage).toBeDefined();
    expect(lineage.artifactKind).toBe("message_pack");
    expect(lineage.platform).toBeNull();
    expect(lineage.parent).toBeNull();

    expect(lineage.approvedCopy).toEqual({
      copyHashSha256: envelope.copyHashSha256,
      copySchemaVersion: envelope.copySchemaVersion,
      approvedRevisionId: envelope.approvedRevisionId,
      assessmentHashSha256: envelope.assessmentHashSha256,
      contextLockId: envelope.contextLockId,
    });
    expect(lineage.strategy.strategySnapshotId).toBe(envelope.campaignStrategySnapshotId);
    expect(lineage.strategy.strategyHashSha256).toBe(envelope.strategyHashSha256);
    expect(lineage.strategy.businessDnaSnapshotId).toBe(envelope.businessDnaSnapshotId);

    // Campaign carries no approved WBS11 lineage in this fixture: run-level
    // coordinates stay null rather than inventing authority.
    expect(lineage.strategy.strategyVersion).toBeNull();
    expect(lineage.strategy.strategyRunId).toBeNull();
    expect(lineage.strategy.approvalRequestId).toBeNull();
    expect(lineage.strategy.creativeBriefFingerprint).toBeNull();

    expect(lineage.lineageFingerprintSha256).toBe(
      deriveCreativeArtifactLineageFingerprint({
        artifactKind: "message_pack",
        platform: null,
        parent: null,
        strategy: lineage.strategy,
        approvedCopy: lineage.approvedCopy,
      })
    );

    // The pack itself carries the same record so every consumer of the
    // durable pack (asset metadata and campaign workflowContext) sees it.
    expect(metadata.approvedMessagePack.creativeArtifactLineage).toEqual(lineage);
  });

  it("attaches WBS11 run coordinates when the campaign carries an approved lineage for the same brief", async () => {
    const { pack, proof } = buildApprovedCanaryPack();
    const baseDb = createMockDb();
    const briefFingerprint = computeCreativeBriefFingerprint(baseDb.campaignRow);
    const db = createMockDb({
      campaignFields: {
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: briefFingerprint,
            strategyRunId: 913,
            strategySnapshotId: "strategy_run_913",
            strategyVersion: 4,
            businessDnaSnapshotId: campaign30BusinessDna.snapshotId,
            strategyHashSha256: campaign30Strategy.strategyHashSha256,
            approvalRequestId: 57,
            status: "approved",
          },
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    await saveApprovedMessagePack(10, 30, pack, { mode: "canary", proof });

    const lineage = db.insertCalls[0].values.metadata.creativeArtifactLineage;
    expect(lineage.strategy.strategyVersion).toBe(4);
    expect(lineage.strategy.strategyRunId).toBe(913);
    expect(lineage.strategy.approvalRequestId).toBe(57);
    expect(lineage.strategy.creativeBriefFingerprint).toBe(briefFingerprint);
    // Envelope-domain coordinates stay authoritative for the copy.
    expect(lineage.strategy.strategySnapshotId).toBe(
      pack.v2ApprovalEnvelope!.campaignStrategySnapshotId
    );
  });

  it("does not attach a stale WBS11 lineage approved for a different brief", async () => {
    const { pack, proof } = buildApprovedCanaryPack();
    const db = createMockDb({
      campaignFields: {
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: "older-brief-fingerprint",
            strategyRunId: 700,
            strategySnapshotId: "strategy_run_700",
            strategyVersion: 2,
            businessDnaSnapshotId: campaign30BusinessDna.snapshotId,
            strategyHashSha256: campaign30Strategy.strategyHashSha256,
            approvalRequestId: 41,
            status: "approved",
          },
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    await saveApprovedMessagePack(10, 30, pack, { mode: "canary", proof });

    const lineage = db.insertCalls[0].values.metadata.creativeArtifactLineage;
    expect(lineage.strategy.strategyRunId).toBeNull();
    expect(lineage.strategy.approvalRequestId).toBeNull();
  });

  it("fails closed when a supplied Strategy authority does not bind to the envelope", async () => {
    const { pack, proof } = buildApprovedCanaryPack();
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    await expect(
      saveApprovedMessagePack(10, 30, pack, {
        mode: "canary",
        proof,
        strategyAuthority: {
          strategySnapshotId: "strategy_UNRELATED",
          strategyVersion: 1,
          businessDnaSnapshotId: pack.v2ApprovalEnvelope!.businessDnaSnapshotId,
          strategyHashSha256: pack.v2ApprovalEnvelope!.strategyHashSha256,
          strategyRunId: 1,
          approvalRequestId: 1,
          creativeBriefFingerprint: "other-brief",
        },
      })
    ).rejects.toThrowError(/strategy binding/i);

    expect(db.insertCalls).toHaveLength(0);
  });

  it("persists full coordinates from a supplied Strategy authority that binds", async () => {
    const { pack, proof } = buildApprovedCanaryPack();
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    const strategyAuthority = {
      strategySnapshotId: pack.v2ApprovalEnvelope!.campaignStrategySnapshotId,
      strategyVersion: 9,
      businessDnaSnapshotId: pack.v2ApprovalEnvelope!.businessDnaSnapshotId,
      strategyHashSha256: pack.v2ApprovalEnvelope!.strategyHashSha256,
      strategyRunId: 913,
      approvalRequestId: 57,
      creativeBriefFingerprint: "bound-brief",
    };

    await saveApprovedMessagePack(10, 30, pack, {
      mode: "canary",
      proof,
      strategyAuthority,
    });

    const lineage = db.insertCalls[0].values.metadata.creativeArtifactLineage;
    expect(lineage.strategy).toEqual({
      strategySnapshotId: strategyAuthority.strategySnapshotId,
      strategyVersion: strategyAuthority.strategyVersion,
      businessDnaSnapshotId: strategyAuthority.businessDnaSnapshotId,
      strategyHashSha256: strategyAuthority.strategyHashSha256,
      strategyRunId: strategyAuthority.strategyRunId,
      approvalRequestId: strategyAuthority.approvalRequestId,
      creativeBriefFingerprint: strategyAuthority.creativeBriefFingerprint,
    });
  });

  it("persists lineage regardless of save mode for envelope-bearing packs", async () => {
    // The lineage decision is driven purely by envelope presence, not the
    // save mode: canary and legacy saves share the same WBS12C integrity
    // guard and the same lineage builder. Canary mode covers the save path
    // here because canary-approved fixture copy ("Learn More" CTA) is
    // intentionally rejected by the legacy genericity rule before save.
    const { pack, proof } = buildApprovedCanaryPack();
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    await saveApprovedMessagePack(10, 30, pack, { mode: "canary", proof });

    const metadata = db.insertCalls[0].values.metadata;
    expect(metadata.creativeArtifactLineage).toBeDefined();
    expect(metadata.creativeArtifactLineage.approvedCopy.copyHashSha256).toBe(
      pack.v2ApprovalEnvelope!.copyHashSha256
    );
  });

  it("keeps legacy envelope-less saves free of lineage metadata", async () => {
    const legacyPack: CampaignMessagePack = {
      headline: "Reduce payout delays for restaurants and delivery platforms",
      subheadline: "Zuto Hub payout platform helps frontline teams avoid manual payout reconciliation.",
      benefitBullets: [
        "Mass disbursements settle staff payouts faster for frontline teams.",
        "Tips and commissions payouts reduce manual payout reconciliation effort.",
        "Supplier payouts stay traceable for restaurants and delivery platforms.",
      ],
      cta: "Request a Walkthrough",
      footerContact: { location: "South Africa" },
      proofPoints: [],
      platformCaptions: [],
      validation: { passed: true, score: 100, rejections: [], warnings: [] },
    };
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    await saveApprovedMessagePack(10, 30, legacyPack);

    const metadata = db.insertCalls[0].values.metadata;
    expect(metadata.creativeArtifactLineage).toBeUndefined();
    expect(metadata.v2ApprovalEnvelope).toBeUndefined();
    expect(metadata.approvedMessagePack.creativeArtifactLineage).toBeUndefined();
  });

  it("rejects canary saves when rewritten copy would carry lineage for tampered approval", async () => {
    const { pack, proof } = buildApprovedCanaryPack();
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    const rewritten = {
      ...pack,
      headline: "Silently rewritten headline keeps the envelope",
      cta: "Claim your millions now",
    };

    await expect(
      saveApprovedMessagePack(10, 30, rewritten, { mode: "canary", proof })
    ).rejects.toThrowError();

    expect(db.insertCalls).toHaveLength(0);
  });

  it("produces identical lineage fingerprints on deterministic replay", async () => {
    const { pack, proof } = buildApprovedCanaryPack();
    const firstDb = createMockDb();
    vi.mocked(getDb).mockReturnValue(firstDb as unknown as ReturnType<typeof getDb>);
    await saveApprovedMessagePack(10, 30, pack, { mode: "canary", proof });
    const firstLineage =
      firstDb.insertCalls[0].values.metadata.creativeArtifactLineage;

    const secondDb = createMockDb();
    vi.mocked(getDb).mockReturnValue(secondDb as unknown as ReturnType<typeof getDb>);
    await saveApprovedMessagePack(10, 30, pack, { mode: "canary", proof });
    const secondLineage =
      secondDb.insertCalls[0].values.metadata.creativeArtifactLineage;

    expect(secondLineage).toEqual(firstLineage);
    expect(secondLineage.lineageFingerprintSha256).toBe(
      firstLineage.lineageFingerprintSha256
    );
  });
});

describe("message pack lineage verification on load", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns packs with intact lineage bound to their envelope", async () => {
    const { pack, proof } = buildApprovedCanaryPack();
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    await saveApprovedMessagePack(10, 30, pack, { mode: "canary", proof });
    const savedMetadata = db.insertCalls[0].values.metadata;

    const loadDb = createMockDb({
      storedRowsRaw: [
        {
          id: 501,
          status: "ready",
          metadata: savedMetadata,
          createdAt: new Date("2026-07-01T08:05:00.000Z"),
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(loadDb as unknown as ReturnType<typeof getDb>);

    const loaded = await loadAllApprovedMessagePacks(30);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].pack.creativeArtifactLineage).toEqual(
      savedMetadata.creativeArtifactLineage
    );
  });

  it("fails closed when a stored lineage fingerprint was tampered with", async () => {
    const { pack, proof } = buildApprovedCanaryPack();
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    await saveApprovedMessagePack(10, 30, pack, { mode: "canary", proof });
    const savedMetadata = db.insertCalls[0].values.metadata;

    const tamperedLineage = {
      ...savedMetadata.creativeArtifactLineage,
      approvedCopy: {
        ...savedMetadata.creativeArtifactLineage.approvedCopy,
        approvedRevisionId: "rev-tampered",
      },
    };

    const loadDb = createMockDb({
      storedRowsRaw: [
        {
          id: 501,
          status: "ready",
          metadata: {
            ...savedMetadata,
            approvedMessagePack: {
              ...savedMetadata.approvedMessagePack,
              creativeArtifactLineage: tamperedLineage,
            },
          },
          createdAt: new Date("2026-07-01T08:05:00.000Z"),
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(loadDb as unknown as ReturnType<typeof getDb>);

    await expect(loadAllApprovedMessagePacks(30)).rejects.toThrowError(
      /fingerprint mismatch/
    );
  });

  it("fails closed when stored lineage coordinates diverge from the envelope", async () => {
    const { pack, proof } = buildApprovedCanaryPack();
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    await saveApprovedMessagePack(10, 30, pack, { mode: "canary", proof });
    const savedMetadata = db.insertCalls[0].values.metadata;

    // Rebind the lineage to a different approved copy but keep the record
    // internally consistent (fingerprint recomputed) — the load-time
    // envelope binding check must still catch it.
    const reboundLineage = buildPersistedCreativeArtifactLineage({
      ...savedMetadata.creativeArtifactLineage,
      approvedCopy: {
        ...savedMetadata.creativeArtifactLineage.approvedCopy,
        copyHashSha256: SHA_X,
      },
    });

    const loadDb = createMockDb({
      storedRowsRaw: [
        {
          id: 501,
          status: "ready",
          metadata: {
            ...savedMetadata,
            approvedMessagePack: {
              ...savedMetadata.approvedMessagePack,
              creativeArtifactLineage: reboundLineage,
            },
          },
          createdAt: new Date("2026-07-01T08:05:00.000Z"),
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(loadDb as unknown as ReturnType<typeof getDb>);

    await expect(loadAllApprovedMessagePacks(30)).rejects.toThrowError(
      /approved-copy coordinates diverge/
    );
  });

  it("loads envelope-less legacy packs without lineage unchanged", async () => {
    const legacyPack: CampaignMessagePack = {
      headline: "Legacy headline",
      subheadline: "Legacy subheadline",
      benefitBullets: ["Legacy benefit"],
      cta: "Learn More",
      footerContact: {},
      proofPoints: [],
      platformCaptions: [],
      validation: { passed: true, score: 95, rejections: [], warnings: [] },
    };
    const loadDb = createMockDb({
      storedRowsRaw: [
        {
          id: 499,
          status: "ready",
          metadata: { approvedMessagePack: legacyPack },
          createdAt: new Date("2026-06-01T08:05:00.000Z"),
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(loadDb as unknown as ReturnType<typeof getDb>);

    const loaded = await loadAllApprovedMessagePacks(30);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].pack.creativeArtifactLineage).toBeUndefined();
    expect(loaded[0].pack.headline).toBe("Legacy headline");
  });
});
