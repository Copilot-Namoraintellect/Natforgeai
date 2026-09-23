import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

const affordabilityState = vi.hoisted(() => ({ allowed: true }));

vi.mock("../billing/cost-control", () => ({
  enforceCostControl: vi.fn(async () =>
    affordabilityState.allowed
      ? { allowed: true, daily: 0, monthly: 0, balance: 100 }
      : { allowed: false, reason: "AI spend limit reached. Daily limit: 10. Spent today: 10.", daily: 10, monthly: 10, balance: 100 }
  ),
}));

vi.mock("../billing/credit-engine", () => ({
  checkCredits: vi.fn(async () => ({ hasCredits: true, balance: 100 })),
  deductCredits: vi.fn(async () => ({ newBalance: 88 })),
  recordAiUsage: vi.fn(async () => {}),
}));

vi.mock("./storage", () => ({
  storeImageBuffer: vi.fn(async () => ({ publicUrl: "https://example.com/v2-image.png", localPath: "/tmp/v2-image.png" })),
  downloadAndStoreVideo: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn(async () => ({ text: "{}" })) };
});

vi.mock("./brand-palette", () => ({
  resolveBrandPalette: vi.fn(async () => ({ primary: "#1E3A8A", secondary: "#F59E0B", accent: "#10B981", source: "mock" })),
  extractLogoPalette: vi.fn(async () => null),
  contrastTextColor: vi.fn(() => "#FFFFFF"),
  normaliseHex: vi.fn((value: unknown) => {
    const clean = String(value ?? "").replace("#", "").trim();
    if (!clean) return undefined;
    if (/^[0-9A-Fa-f]{3}$/.test(clean)) return `#${clean.split("").map((c) => c + c).join("").toUpperCase()}`;
    if (/^[0-9A-Fa-f]{6}$/.test(clean)) return `#${clean.toUpperCase()}`;
    return undefined;
  }),
  safeText: vi.fn((value: unknown) => (value == null ? "" : String(value).trim())),
}));

vi.mock("./campaign-message-architect", async () => {
  const actual = await vi.importActual<typeof import("./campaign-message-architect")>("./campaign-message-architect");
  return {
    ...actual,
    ensureApprovedMessagePack: vi.fn(),
    refineApprovedMessagePack: vi.fn(),
    saveApprovedMessagePack: vi.fn(),
    loadApprovedMessagePack: vi.fn(),
  };
});

const hybridState = vi.hoisted(() => ({ enabled: false }));
const freeFallbackState = vi.hoisted(() => ({ enabled: false }));

vi.mock("../env", async () => {
  const actual = await vi.importActual<typeof import("../env")>("../env");
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableHybridLeafletPipeline() {
        return hybridState.enabled;
      },
      get freeAiLeafletFallback() {
        return freeFallbackState.enabled;
      },
    },
  };
});

vi.mock("./premium-v2/hybrid-pipeline", () => ({
  runHybridPipeline: vi.fn(),
}));

vi.mock("./registry", async () => {
  const actual = await vi.importActual<typeof import("./registry")>("./registry");
  return {
    ...actual,
    isOpenAiLeafletConfigured: vi.fn(() => false),
    getOpenAiLeafletRenderer: vi.fn(() => ({ name: "openai-hybrid", configured: true, render: vi.fn(async () => ({ success: false, error: "ai quality failed" })) })),
  };
});

import { generateText } from "ai";
import {
  generatePremiumLeaflet,
  __setImageRenderClaimOrchestrationForTests,
  __setImageRenderClaimHeartbeatFactoryForTests,
  type ImageRenderClaimOrchestration,
} from "./service";
import * as architect from "./campaign-message-architect";
import * as creditEngine from "../billing/credit-engine";
import { storeImageBuffer } from "./storage";
import { computeCampaignMessagePackCopyHash } from "./approved-copy-authority";
import { computeCreativeBriefFingerprint } from "./brief-grounding";
import { evaluateImageRenderClaimGate } from "./image-render-claim-gate";
import { deriveImageRenderAttemptIdentity } from "./image-render-claim";
import type { ImageRenderCoordinatorIntent } from "./image-render-claim-coordinator";
import { deriveImageRenderLineageFingerprint, type ImageRenderLineageInput } from "./image-render-lineage";
import { ensureFixtureLogos, resolveFixtureLogoPath } from "./premium-v2/fixture-logos";

const OWNER = Object.freeze({
  claimId: 778,
  ownerToken: "owner-secret-lineage-token",
  requestAttemptKey: "a".repeat(64),
  intentFingerprint: "b".repeat(64),
  deductionKey: `img-deduction:${"a".repeat(64)}`,
});

const REPLAY_RESULT = {
  generatedImageId: 4242,
  imageUrl: "https://cdn.example.com/stored-lineage-replay.png",
  provider: "premium-v2",
  providerJobId: "job-lineage-replay",
  creditsCharged: 12,
  qualityTier: "premium",
  qualityLabel: "Premium Marketing Leaflet",
  isDraft: false,
  completedAt: new Date("2026-08-02T00:00:00.000Z"),
};

// Full WBS11 approved Strategy lineage coordinates (readLineage requires every
// field to parse; buildCreativeStrategyAuthority additionally requires the
// strategy hash to be 64-char lowercase SHA-256 hex).
const STRATEGY_COORDS = {
  strategySnapshotId: "snap-print-v3",
  strategyVersion: 3,
  businessDnaSnapshotId: "dna-print-v2",
  strategyHashSha256: "c3".repeat(32),
  strategyRunId: 91,
  approvalRequestId: 92,
};

const baseCampaignFixture = {
  id: 28,
  userId: 10,
  businessId: 24,
  name: "Print Campaign",
  productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier",
  targetBuyer: "Local businesses",
  mainPainPoint: "Slow turnaround on print jobs",
  offerDetails: "10% off first order",
  excludedOffers: "",
  preferredCta: "Get a Quote",
  platforms: "Instagram, Facebook",
  primaryOutcome: "Leads",
  coreMessage: "Fast local printing",
  contentStyle: null,
  workflowContext: {
    approvedStrategyFingerprint: "approved-print-strategy",
    strategyFingerprint: "approved-print-strategy",
    strategyApprovalLineage: {
      ...STRATEGY_COORDS,
      creativeBriefFingerprint: "approved-print-strategy",
      status: "approved",
      approvedAt: "2026-08-01T00:00:00.000Z",
    },
  },
};

// Same campaign with NO approved Strategy lineage (readLineage returns null).
const ungovernedCampaignFixture = {
  ...baseCampaignFixture,
  workflowContext: {
    approvedStrategyFingerprint: "approved-print-strategy",
    strategyApprovalLineage: {
      strategyRunId: 91,
      approvalRequestId: 92,
      approvedAt: "2026-08-01T00:00:00.000Z",
      status: "approved",
      creativeBriefFingerprint: "approved-print-strategy",
    },
  },
};

const basePack = {
  headline: "Fast printing for Newmarket businesses",
  subheadline: "Same-day quotes and reliable delivery for local businesses struggling with slow turnaround.",
  benefitBullets: ["Business cards", "Flyers", "Banners", "Courier"],
  cta: "Get a Quote",
  footerContact: { location: "Newmarket" },
  platformCaptions: [],
  messagePackSource: "user_structured_copy",
  validation: { passed: true, score: 90, rejections: [], warnings: [] },
  creativeBriefFingerprint: computeCreativeBriefFingerprint(baseCampaignFixture),
} as const;

function makeEnvelope(copyHashSha256: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "v2-envelope-1",
    approvalMode: "canary",
    contextLockId: "ctx-lock-1",
    approvedRevisionId: "rev-approved-1",
    candidateId: "cand-1",
    assessmentId: "assess-1",
    assessmentHashSha256: "a1".repeat(32),
    copyHashSha256,
    copySchemaVersion: "copy-schema-1",
    businessDnaSnapshotId: STRATEGY_COORDS.businessDnaSnapshotId,
    evidenceHashSha256: "e7".repeat(32),
    campaignStrategySnapshotId: STRATEGY_COORDS.strategySnapshotId,
    strategyHashSha256: STRATEGY_COORDS.strategyHashSha256,
    policyId: "policy-cta-1",
    policyVersion: 2,
    policyHashSha256: "d4".repeat(32),
    approvedAtIso: "2026-08-01T00:00:00.000Z",
    candidateSource: "ai_initial",
    sourceProvenance: {
      adaptedFromLegacy: false,
      originSource: "canary_approval",
      modelName: null,
      diagnostics: {
        legacyIsGeneric: null,
        legacyValidationPassed: null,
        legacyValidationScore: null,
        legacyValidationRejections: [],
      },
    },
    ...overrides,
  };
}

/**
 * Builds a pack whose envelope copyHashSha256 actually matches the pack copy
 * (mirrors the canary approval flow, which hashes the canonical copy).
 */
function makeEnvelopedPack(
  envelopeOverrides: Record<string, unknown> = {},
  packOverrides: Record<string, unknown> = {}
) {
  const packBase = { ...basePack, ...packOverrides };
  const provisional = { ...packBase, v2ApprovalEnvelope: makeEnvelope("0".repeat(64), envelopeOverrides) };
  const copyHashSha256 = computeCampaignMessagePackCopyHash(provisional as never);
  return {
    ...provisional,
    v2ApprovalEnvelope: { ...provisional.v2ApprovalEnvelope, copyHashSha256 },
  };
}

interface DbLog {
  inserts: { table: string; values: Record<string, unknown> }[];
  updates: { table: string; patch: Record<string, unknown> }[];
}

function tableNameOf(table: unknown): string {
  return String((table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] ?? "unknown");
}

function createMockDb(campaignRow: unknown, options: { previousImages?: unknown[] } = {}) {
  const log: DbLog = { inserts: [], updates: [] };
  const businessRow = {
    id: 24,
    userId: 10,
    name: "3@1 Newmarket",
    displayName: "3@1 Newmarket",
    logo: resolveFixtureLogoPath("3at1"),
    industry: "Print and courier",
    location: "Newmarket",
    phone: "011 123 9999",
    website: "https://3at1newmarket.test",
    productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier, Business cards, Banners, Canvas",
    targetCustomer: "Local businesses and students",
    brandColors: ["#0047AB", "#FFD700", "#FFFFFF"],
    visualStyle: "modern",
    websiteEvidence: {
      businessCategory: "print and courier",
      productsServices: ["Printing", "Copying", "Scanning", "Laminating", "Binding", "Courier", "Business cards", "Banners", "Canvas"],
    },
    contentStyle: null,
  };
  const postRow = { id: 100, userId: 10, campaignId: 28, title: "V2 Post", hook: "Hook", cta: "Post CTA", platform: "Instagram", metadata: {} };
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          const rowsFor = async () => {
            const name = tableNameOf(table);
            if (name === "content_posts") return [postRow];
            if (name === "campaigns") return [campaignRow];
            if (name === "businesses") return [businessRow];
            if (name === "generated_images") return options.previousImages ?? [];
            return [];
          };
          return {
            then: (resolve: (value: unknown[]) => void) => {
              void rowsFor().then(resolve);
            },
            orderBy: vi.fn(() => ({ limit: vi.fn(rowsFor) })),
            limit: vi.fn(rowsFor),
          };
        }),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: Record<string, unknown>) => {
        log.inserts.push({ table: tableNameOf(table), values });
        return [{ insertId: 1 }];
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          log.updates.push({ table: tableNameOf(table), patch });
          return [];
        }),
      })),
    })),
  };
  return { db, log };
}

function makeOrchestration(config: {
  mode?: "off" | "on";
  gate?: ImageRenderClaimOrchestration["evaluateGate"];
  finalize?: ImageRenderClaimOrchestration["finalize"];
} = {}) {
  const orchestration: ImageRenderClaimOrchestration = {
    getEffectiveMode: vi.fn(async () => config.mode ?? "on"),
    evaluateGate: vi.fn(
      config.gate
        ? async (input: unknown, deps: unknown) => {
            (orchestration as { lastGateInput?: unknown }).lastGateInput = input;
            return (config.gate as (i: unknown, d: unknown) => Promise<unknown>)(input, deps);
          }
        : async (input: unknown) => {
            (orchestration as { lastGateInput?: unknown }).lastGateInput = input;
            return { status: "proceed" as const, owner: OWNER };
          }
    ) as ImageRenderClaimOrchestration["evaluateGate"],
    createFinalizationDeps: vi.fn(() => ({}) as never) as ImageRenderClaimOrchestration["createFinalizationDeps"],
    finalize: vi.fn(
      config.finalize ??
        (async (input) => {
          (orchestration as { lastFinalizeInput?: unknown }).lastFinalizeInput = input;
          return { status: "finalized" as const, generatedImageId: 4242, creditsCharged: input.charge.amount, newBalance: 88 };
        })
    ) as ImageRenderClaimOrchestration["finalize"],
    failClaim: vi.fn(async () => ({ transitioned: true, claim: {} as never })) as ImageRenderClaimOrchestration["failClaim"],
  };
  return orchestration as ImageRenderClaimOrchestration & {
    lastGateInput?: any;
    lastFinalizeInput?: any;
  };
}

/**
 * Harness that runs the REAL claim gate against fake coordinator/replay deps.
 *
 * acquire-mode simulates a fresh claim acquisition and captures the attempt
 * identity (intentFingerprint) the gate derived — which binds the lineage
 * fingerprint. replay-mode simulates an existing completed claim for this
 * attempt key; the fake replay lookup replays only when the request's
 * intentFingerprint equals the stored one — exactly the production contract
 * that a result produced under identical authority replays and one produced
 * under different authority is rejected as intent_conflict.
 */
function makeRealGateOrchestration(
  mode: "acquire" | "replay",
  stored: { intentFingerprint: string | null }
) {
  const orchestration = makeOrchestration({
    mode: "on",
    gate: (async (input) =>
      evaluateImageRenderClaimGate(input, {
        coordinateImageRenderAttempt: (async (coordinatorInput: {
          userId: number;
          contentPostId: number;
          clientAttemptId: string;
          intent: ImageRenderCoordinatorIntent;
          lineage?: ImageRenderLineageInput | null;
        }) => {
          const identity = deriveImageRenderAttemptIdentity({
            userId: coordinatorInput.userId,
            contentPostId: coordinatorInput.contentPostId,
            attempt: {
              ...coordinatorInput.intent,
              clientAttemptId: coordinatorInput.clientAttemptId,
              lineage: coordinatorInput.lineage,
            },
          });
          if (mode === "acquire") {
            stored.intentFingerprint = identity.intentFingerprint;
            return {
              outcome: "acquired",
              owner: {
                ...OWNER,
                requestAttemptKey: identity.requestAttemptKey,
                intentFingerprint: identity.intentFingerprint,
                deductionKey: identity.deductionKey,
              },
            };
          }
          return { outcome: "completed_replay_required" };
        }) as never,
        coordinatorDeps: {} as never,
        getCompletedImageRenderResult: (async ({ intentFingerprint }: { intentFingerprint: string }) =>
          mode === "replay" &&
          stored.intentFingerprint !== null &&
          intentFingerprint === stored.intentFingerprint
            ? { replayable: true as const, result: REPLAY_RESULT }
            : { replayable: false as const, reason: "intent_conflict" as const }) as never,
      })) as ImageRenderClaimOrchestration["evaluateGate"],
  });
  return orchestration;
}

function flushAsyncWork() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

beforeAll(async () => {
  await ensureFixtureLogos();
});

beforeEach(() => {
  vi.clearAllMocks();
  affordabilityState.allowed = true;
  __setImageRenderClaimHeartbeatFactoryForTests(() => ({
    lostOwnership: false,
    assertStillOwned: async () => {},
    stop: async () => {},
  }));
});

afterEach(() => {
  __setImageRenderClaimOrchestrationForTests(null);
  __setImageRenderClaimHeartbeatFactoryForTests(null);
  if (process.env.IMAGE_RENDER_CLAIMS_MODE !== undefined) {
    delete process.env.IMAGE_RENDER_CLAIMS_MODE;
  }
});

async function runService(
  orchestration: ImageRenderClaimOrchestration,
  options: {
    clientAttemptId: string;
    campaign: unknown;
    pack: unknown;
    db?: ReturnType<typeof createMockDb>;
  }
) {
  __setImageRenderClaimOrchestrationForTests(orchestration);
  const { getDb } = await import("../../queries/connection");
  const mock = options.db ?? createMockDb(options.campaign);
  vi.mocked(getDb).mockReturnValue(mock.db as never);
  vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(options.pack as never);
  vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(options.pack as never);
  let result: Awaited<ReturnType<typeof generatePremiumLeaflet>> | null = null;
  let caught: unknown = null;
  try {
    result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "v2",
      clientAttemptId: options.clientAttemptId,
    });
  } catch (err) {
    caught = err;
  }
  return { result, caught, mock };
}

describe("generatePremiumLeaflet — WBS12D2 image-render lineage activation", () => {
  it("passes the exact approved Strategy lineage coordinates to the claim gate", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    const pack = makeEnvelopedPack();
    const { result } = await runService(orchestration, {
      clientAttemptId: "attempt-lineage-strategy",
      campaign: baseCampaignFixture,
      pack,
    });

    expect(result?.status).toBe("completed");
    expect(orchestration.evaluateGate).toHaveBeenCalledTimes(1);
    const lineage = orchestration.lastGateInput.lineage;
    expect(lineage.contentPostId).toBe(100);
    expect(lineage.strategy).toEqual({
      strategySnapshotId: STRATEGY_COORDS.strategySnapshotId,
      strategyVersion: STRATEGY_COORDS.strategyVersion,
      businessDnaSnapshotId: STRATEGY_COORDS.businessDnaSnapshotId,
      strategyHashSha256: STRATEGY_COORDS.strategyHashSha256,
      strategyRunId: STRATEGY_COORDS.strategyRunId,
      creativeBriefFingerprint: "approved-print-strategy",
      approvalRequestId: STRATEGY_COORDS.approvalRequestId,
    });
  });

  it("passes the exact approved-copy lineage coordinates to the claim gate", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    const pack = makeEnvelopedPack();
    const { result } = await runService(orchestration, {
      clientAttemptId: "attempt-lineage-copy",
      campaign: baseCampaignFixture,
      pack,
    });

    expect(result?.status).toBe("completed");
    const lineage = orchestration.lastGateInput.lineage;
    expect(lineage.approvedCopy).toEqual({
      copyHashSha256: pack.v2ApprovalEnvelope.copyHashSha256,
      copySchemaVersion: "copy-schema-1",
      approvedRevisionId: "rev-approved-1",
    });
    // The lineage fingerprint binds both authorities.
    expect(deriveImageRenderLineageFingerprint(lineage)).toBe(
      deriveImageRenderLineageFingerprint({
        contentPostId: 100,
        strategy: {
          strategySnapshotId: STRATEGY_COORDS.strategySnapshotId,
          strategyVersion: STRATEGY_COORDS.strategyVersion,
          businessDnaSnapshotId: STRATEGY_COORDS.businessDnaSnapshotId,
          strategyHashSha256: STRATEGY_COORDS.strategyHashSha256,
          strategyRunId: STRATEGY_COORDS.strategyRunId,
          creativeBriefFingerprint: "approved-print-strategy",
          approvalRequestId: STRATEGY_COORDS.approvalRequestId,
        },
        approvedCopy: {
          copyHashSha256: pack.v2ApprovalEnvelope.copyHashSha256,
          copySchemaVersion: "copy-schema-1",
          approvedRevisionId: "rev-approved-1",
        },
      })
    );
  });

  it("passes the same canonical lineage object to gate acquisition and finalization", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    const pack = makeEnvelopedPack();
    const { result } = await runService(orchestration, {
      clientAttemptId: "attempt-lineage-same-object",
      campaign: baseCampaignFixture,
      pack,
    });

    expect(result?.status).toBe("completed");
    const gateLineage = orchestration.lastGateInput.lineage;
    const finalizeLineage = orchestration.lastFinalizeInput.lineage;
    // Canonically (and referentially) identical: one lineage authority from
    // acquisition through finalization.
    expect(finalizeLineage).toEqual(gateLineage);
    expect(deriveImageRenderLineageFingerprint(finalizeLineage)).toBe(
      deriveImageRenderLineageFingerprint(gateLineage)
    );
    expect(finalizeLineage.contentPostId).toBe(orchestration.lastFinalizeInput.claim.contentPostId);
  });

  it("changed Strategy hash/version blocks stale image reuse through the real gate", async () => {
    const stored = { intentFingerprint: null as string | null };

    // Attempt 1: fresh render under the original Strategy authority. The real
    // gate derives the lineage-bound attempt identity at acquisition.
    const orchestration1 = makeRealGateOrchestration("acquire", stored);
    const pack = makeEnvelopedPack();
    const run1 = await runService(orchestration1, {
      clientAttemptId: "attempt-replay-strategy",
      campaign: baseCampaignFixture,
      pack,
    });
    expect(run1.result?.status).toBe("completed");
    expect(orchestration1.finalize).toHaveBeenCalledTimes(1);
    expect(stored.intentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    vi.mocked(storeImageBuffer).mockClear();
    vi.mocked(creditEngine.deductCredits).mockClear();
    vi.mocked(creditEngine.recordAiUsage).mockClear();

    // The Strategy authority changes (new hash + version): re-approval of a
    // changed brief produces different lineage coordinates.
    const changedCampaign = {
      ...baseCampaignFixture,
      workflowContext: {
        ...baseCampaignFixture.workflowContext,
        strategyApprovalLineage: {
          ...baseCampaignFixture.workflowContext.strategyApprovalLineage,
          strategyVersion: 4,
          strategyHashSha256: "b2".repeat(32),
        },
      },
    };

    const orchestration2 = makeRealGateOrchestration("replay", stored);
    const run2 = await runService(orchestration2, {
      clientAttemptId: "attempt-replay-strategy",
      campaign: changedCampaign,
      pack,
    });

    expect(run2.caught).toMatchObject({ code: "CONFLICT", message: "INTENT_CONFLICT" });
    // The gate received the changed Strategy coordinates, so the derived
    // attempt identity differs from the stored one — the completed image is
    // never reused.
    const lineage2 = orchestration2.lastGateInput.lineage;
    expect(lineage2.strategy.strategyVersion).toBe(4);
    expect(lineage2.strategy.strategyHashSha256).toBe("b2".repeat(32));
    expect(deriveImageRenderLineageFingerprint(lineage2)).not.toBe(
      deriveImageRenderLineageFingerprint(orchestration1.lastGateInput.lineage)
    );
    // Zero new render/storage/finalization/billing.
    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(orchestration2.lastFinalizeInput).toBeUndefined();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    expect(creditEngine.recordAiUsage).not.toHaveBeenCalled();
  });

  it("changed approved-copy authority blocks stale image reuse through the real gate", async () => {
    const stored = { intentFingerprint: null as string | null };

    const orchestration1 = makeRealGateOrchestration("acquire", stored);
    const packV1 = makeEnvelopedPack();
    const run1 = await runService(orchestration1, {
      clientAttemptId: "attempt-replay-copy",
      campaign: baseCampaignFixture,
      pack: packV1,
    });
    expect(run1.result?.status).toBe("completed");
    expect(stored.intentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    vi.mocked(storeImageBuffer).mockClear();
    vi.mocked(creditEngine.deductCredits).mockClear();
    vi.mocked(creditEngine.recordAiUsage).mockClear();

    // The approved copy changes: a re-approved revision over changed copy
    // (new headline → new canonical copy hash, new revision id).
    const packV2 = makeEnvelopedPack({ approvedRevisionId: "rev-approved-2" }, {
      headline: "Same-day printing for Newmarket businesses",
    });
    expect(packV2.v2ApprovalEnvelope.copyHashSha256).not.toBe(packV1.v2ApprovalEnvelope.copyHashSha256);

    const orchestration2 = makeRealGateOrchestration("replay", stored);
    const run2 = await runService(orchestration2, {
      clientAttemptId: "attempt-replay-copy",
      campaign: baseCampaignFixture,
      pack: packV2,
    });

    expect(run2.caught).toMatchObject({ code: "CONFLICT", message: "INTENT_CONFLICT" });
    const lineage2 = orchestration2.lastGateInput.lineage;
    expect(lineage2.approvedCopy.approvedRevisionId).toBe("rev-approved-2");
    expect(deriveImageRenderLineageFingerprint(lineage2)).not.toBe(
      deriveImageRenderLineageFingerprint(orchestration1.lastGateInput.lineage)
    );
    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(orchestration2.lastFinalizeInput).toBeUndefined();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
  });

  it("exact replay under identical authority returns the stored result with no duplicate charge or image", async () => {
    const stored = { intentFingerprint: null as string | null };

    const orchestration1 = makeRealGateOrchestration("acquire", stored);
    const pack = makeEnvelopedPack();
    const run1 = await runService(orchestration1, {
      clientAttemptId: "attempt-replay-identical",
      campaign: baseCampaignFixture,
      pack,
    });
    expect(run1.result?.status).toBe("completed");
    expect(orchestration1.finalize).toHaveBeenCalledTimes(1);
    expect(stored.intentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Let run 1's fire-and-forget caption work settle, then reset counters so
    // run 2 is observed in isolation.
    await flushAsyncWork();
    vi.mocked(storeImageBuffer).mockClear();
    vi.mocked(generateText).mockClear();
    vi.mocked(creditEngine.deductCredits).mockClear();
    vi.mocked(creditEngine.recordAiUsage).mockClear();

    const orchestration2 = makeRealGateOrchestration("replay", stored);
    const run2 = await runService(orchestration2, {
      clientAttemptId: "attempt-replay-identical",
      campaign: baseCampaignFixture,
      pack,
    });
    await flushAsyncWork();

    expect(run2.caught).toBeNull();
    expect(run2.result).toMatchObject({
      status: "completed",
      imageUrl: REPLAY_RESULT.imageUrl,
      creditsCharged: REPLAY_RESULT.creditsCharged,
    });
    // Identical lineage → identical attempt identity → verified replay only:
    // no second render, image insert, finalization, charge, or caption.
    expect(deriveImageRenderLineageFingerprint(orchestration2.lastGateInput.lineage)).toBe(
      deriveImageRenderLineageFingerprint(orchestration1.lastGateInput.lineage)
    );
    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(orchestration2.lastFinalizeInput).toBeUndefined();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    expect(creditEngine.recordAiUsage).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(run2.mock.log.inserts).toHaveLength(0);
  });

  it("legacy no-authority path passes no lineage and stays fully compatible", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    const { result } = await runService(orchestration, {
      clientAttemptId: "attempt-lineage-legacy",
      campaign: ungovernedCampaignFixture,
      pack: basePack,
    });

    expect(result?.status).toBe("completed");
    expect(orchestration.lastGateInput.lineage).toBeNull();
    expect(orchestration.lastFinalizeInput.lineage).toBeNull();
    expect(orchestration.finalize).toHaveBeenCalledTimes(1);
  });

  it("claims-off legacy path performs no lineage work at all", async () => {
    const orchestration = makeOrchestration({ mode: "off" });
    const { result, mock } = await runService(orchestration, {
      clientAttemptId: "attempt-lineage-off",
      campaign: baseCampaignFixture,
      pack: makeEnvelopedPack(),
    });
    await flushAsyncWork();

    expect(result?.status).toBe("completed");
    expect(orchestration.evaluateGate).not.toHaveBeenCalled();
    expect(orchestration.finalize).not.toHaveBeenCalled();
    // The legacy idempotency block loads the approved pack itself; the
    // lineage-specific gate/finalization path added no extra pack read (the
    // only call is that pre-existing one).
    expect(architect.loadApprovedMessagePack).toHaveBeenCalledTimes(1);
    // Legacy billing/persistence ran unchanged.
    expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
    expect(mock.log.inserts.some((entry) => entry.table === "generated_images")).toBe(true);
  });

  it("fails closed when an approved-copy envelope exists without approved Strategy authority", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    const { caught } = await runService(orchestration, {
      clientAttemptId: "attempt-lineage-orphan-envelope",
      campaign: ungovernedCampaignFixture,
      pack: makeEnvelopedPack(),
    });

    expect(caught).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(String((caught as { message?: string })?.message)).toMatch(/Strategy authority/);
    expect(orchestration.evaluateGate).not.toHaveBeenCalled();
    expect(orchestration.finalize).not.toHaveBeenCalled();
    expect(storeImageBuffer).not.toHaveBeenCalled();
  });

  it("fails closed with INTENT_CONFLICT when the render-time pack diverges from the acquired copy authority", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    // Gate-time load returns the v1-enveloped pack; the render-time resolution
    // returns a differently approved pack (copy authority changed mid-flight).
    const packV1 = makeEnvelopedPack();
    const packV2 = makeEnvelopedPack({ approvedRevisionId: "rev-approved-2" }, {
      headline: "Same-day printing for Newmarket businesses",
    });
    __setImageRenderClaimOrchestrationForTests(orchestration);
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb(baseCampaignFixture).db as never);
    vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(packV1 as never);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(packV2 as never);

    let caught: unknown = null;
    try {
      await generatePremiumLeaflet({
        userId: 10,
        contentPostId: 100,
        provider: "v2",
        clientAttemptId: "attempt-lineage-copy-drift",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ code: "CONFLICT", message: "INTENT_CONFLICT" });
    // The owned claim was failed exactly once; nothing rendered or finalized.
    expect(orchestration.failClaim).toHaveBeenCalledTimes(1);
    expect(orchestration.finalize).not.toHaveBeenCalled();
    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
  });
});
