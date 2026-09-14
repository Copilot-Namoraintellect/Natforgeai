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

// The registry is partially mocked so the AI provider path is deterministic;
// the real fixture-backed V2 renderer is used for fresh renders (as in the
// premium-v2 suite), and the provider-failure test overrides it with a spy.
vi.mock("./registry", async () => {
  const actual = await vi.importActual<typeof import("./registry")>("./registry");
  return {
    ...actual,
    isOpenAiLeafletConfigured: vi.fn(() => false),
    getOpenAiLeafletRenderer: vi.fn(() => ({ name: "openai-hybrid", configured: true, render: vi.fn(async () => ({ success: false, error: "ai quality failed" })) })),
  };
});

import { generateText } from "ai";
import { TRPCError } from "@trpc/server";
import {
  generatePremiumLeaflet,
  __setImageRenderClaimOrchestrationForTests,
  __setImageRenderClaimHeartbeatFactoryForTests,
  type ImageRenderClaimOrchestration,
} from "./service";
import * as architect from "./campaign-message-architect";
import * as creditEngine from "../billing/credit-engine";
import * as registry from "./registry";
import { storeImageBuffer } from "./storage";
import { getPremiumImageInternalCredits } from "./costs";
import { ensureFixtureLogos, resolveFixtureLogoPath } from "./premium-v2/fixture-logos";
import { computeCreativeBriefFingerprint } from "./brief-grounding";
import { getEffectiveImageRenderClaimsMode } from "./image-render-claims-readiness";

const OWNER = Object.freeze({
  claimId: 777,
  ownerToken: "owner-secret-finalization-token",
  requestAttemptKey: "a".repeat(64),
  intentFingerprint: "b".repeat(64),
  deductionKey: `img-deduction:${"a".repeat(64)}`,
});

const REPLAY_RESPONSE = {
  success: true as const,
  imageUrl: "https://cdn.example.com/stored-replay.png",
  provider: "premium-v2",
  jobId: "job-replay-1",
  creditsCharged: 12,
  qualityTier: "premium",
  qualityLabel: "Premium Marketing Leaflet",
  isDraft: false,
};

interface DbLog {
  inserts: { table: string; values: Record<string, unknown> }[];
  updates: { table: string; patch: Record<string, unknown> }[];
  selectedTables: string[];
}

function tableNameOf(table: unknown): string {
  return String((table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] ?? "unknown");
}

const campaignFixture = {
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
    strategyApprovalLineage: {
      strategyRunId: 91,
      approvalRequestId: 92,
      approvedAt: "2026-08-01T00:00:00.000Z",
      status: "approved",
      creativeBriefFingerprint: "approved-print-strategy",
    },
  },
};

const CAMPAIGN_FINGERPRINT = computeCreativeBriefFingerprint(campaignFixture);

function createMockDb(options: { previousImages?: unknown[]; businessLogo?: string | null } = {}) {
  const log: DbLog = { inserts: [], updates: [], selectedTables: [] };
  const campaignRow = campaignFixture;
  const businessRow = {
    id: 24,
    userId: 10,
    name: "3@1 Newmarket",
    displayName: "3@1 Newmarket",
    logo: options.businessLogo === undefined ? resolveFixtureLogoPath("3at1") : options.businessLogo,
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
          log.selectedTables.push(tableNameOf(table));
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

const validPack = {
  headline: "Fast printing for Newmarket businesses",
  subheadline: "Same-day quotes and reliable delivery for local businesses struggling with slow turnaround.",
  benefitBullets: ["Business cards", "Flyers", "Banners", "Courier"],
  cta: "Get a Quote",
  footerContact: { location: "Newmarket" },
  platformCaptions: [],
  messagePackSource: "user_structured_copy",
  validation: { passed: true, score: 90, rejections: [], warnings: [] },
  creativeBriefFingerprint: CAMPAIGN_FINGERPRINT,
} as const;

function makeV2Renderer(render?: () => Promise<unknown>) {
  return {
    name: "premium-v2",
    configured: true,
    render: render ?? (async () => { throw new Error("v2 render not implemented in fake"); }),
  };
}

interface OrchestrationConfig {
  mode?: "off" | "on";
  gate?: ImageRenderClaimOrchestration["evaluateGate"];
  finalize?: ImageRenderClaimOrchestration["finalize"];
  failThrows?: Error;
  events?: string[];
}

function makeOrchestration(config: OrchestrationConfig = {}) {
  const events = config.events ?? [];
  const orchestration: ImageRenderClaimOrchestration = {
    getEffectiveMode: vi.fn(async () => config.mode ?? "on"),
    evaluateGate: vi.fn(
      config.gate ??
        (async (input) => {
          events.push("gate");
          (orchestration as { lastGateInput?: unknown }).lastGateInput = input;
          return { status: "proceed" as const, owner: OWNER };
        })
    ) as ImageRenderClaimOrchestration["evaluateGate"],
    createFinalizationDeps: vi.fn(() => ({}) as never) as ImageRenderClaimOrchestration["createFinalizationDeps"],
    finalize: vi.fn(
      config.finalize ??
        (async (input) => {
          events.push("finalize");
          (orchestration as { lastFinalizeInput?: unknown }).lastFinalizeInput = input;
          return { status: "finalized" as const, generatedImageId: 4242, creditsCharged: input.charge.amount, newBalance: 88 };
        })
    ) as ImageRenderClaimOrchestration["finalize"],
    failClaim: vi.fn(async (args) => {
      events.push("fail");
      (orchestration as { lastFailArgs?: unknown }).lastFailArgs = args;
      if (config.failThrows) throw config.failThrows;
      return { transitioned: true, claim: {} as never };
    }) as ImageRenderClaimOrchestration["failClaim"],
  };
  return orchestration as ImageRenderClaimOrchestration & {
    lastGateInput?: any;
    lastFinalizeInput?: any;
    lastFailArgs?: any;
  };
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
  // Slice C1: every test gets a benign heartbeat double unless it installs
  // its own; the real controller/timer is never constructed in this suite.
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

async function runClaimService(
  orchestration: ImageRenderClaimOrchestration,
  options: { clientAttemptId?: string; db?: ReturnType<typeof createMockDb> } = {}
) {
  __setImageRenderClaimOrchestrationForTests(orchestration);
  const { getDb } = await import("../../queries/connection");
  const mock = options.db ?? createMockDb();
  vi.mocked(getDb).mockReturnValue(mock.db as never);
  vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack as never);
  vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(validPack as never);
  const result = await generatePremiumLeaflet({
    userId: 10,
    contentPostId: 100,
    provider: "v2",
    clientAttemptId: options.clientAttemptId,
  });
  return { result, mock };
}

describe("generatePremiumLeaflet — effective-on token rule", () => {
  it("rejects a missing token before gate/render/storage/billing", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    __setImageRenderClaimOrchestrationForTests(orchestration);
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb().db as never);

    await expect(
      generatePremiumLeaflet({ userId: 10, contentPostId: 100, provider: "v2" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "TOKEN_REQUIRED" });

    expect(orchestration.evaluateGate).not.toHaveBeenCalled();
    expect(orchestration.finalize).not.toHaveBeenCalled();
    expect(orchestration.failClaim).not.toHaveBeenCalled();
    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    expect(creditEngine.recordAiUsage).not.toHaveBeenCalled();
  });

  it("rejects a malformed token before the gate", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    __setImageRenderClaimOrchestrationForTests(orchestration);
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb().db as never);

    await expect(
      generatePremiumLeaflet({ userId: 10, contentPostId: 100, provider: "v2", clientAttemptId: "bad token" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "INVALID_TOKEN" });
    expect(orchestration.evaluateGate).not.toHaveBeenCalled();
  });

  it("configured-on + readiness-not-ready preserves the legacy path through the real mode layer", async () => {
    process.env.IMAGE_RENDER_CLAIMS_MODE = "on";
    const orchestration = makeOrchestration({
      mode: undefined,
    });
    // Real committed mode layer: configured on, readiness not ready → off.
    orchestration.getEffectiveMode = (async () =>
      getEffectiveImageRenderClaimsMode({
        readiness: { check: async () => ({ ready: false, reason: "claim_table_missing" }) },
      })) as ImageRenderClaimOrchestration["getEffectiveMode"];
    orchestration.evaluateGate = vi.fn(async () => {
      throw new Error("gate must not run when readiness is not ready");
    }) as ImageRenderClaimOrchestration["evaluateGate"];

    const { result, mock } = await runClaimService(orchestration, { clientAttemptId: "token-absent-client" });

    expect(result.status).toBe("completed");
    expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
    expect(orchestration.evaluateGate).not.toHaveBeenCalled();
    expect(mock.log.inserts.some((entry) => entry.table === "generated_images")).toBe(true);
  });
});

describe("generatePremiumLeaflet — claim gate orchestration", () => {
  it("invokes the gate exactly once with authoritative ids, complete intent, secure token and lease", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    const { result } = await runClaimService(orchestration, { clientAttemptId: "attempt-token-abc" });

    if (result.status !== "completed") console.log("ZZ-DEBUG:", JSON.stringify(result).slice(0, 400));
    expect(result.status).toBe("completed");
    expect(orchestration.evaluateGate).toHaveBeenCalledTimes(1);
    const gateInput = orchestration.lastGateInput;
    expect(gateInput.userId).toBe(10);
    expect(gateInput.contentPostId).toBe(100);
    expect(gateInput.clientAttemptId).toBe("attempt-token-abc");
    expect(gateInput.intent).toEqual({
      regenerate: false,
      forceRegenerate: false,
      refinementInstruction: null,
      creativeGuidance: null,
      strongerBrandFit: false,
      provider: "v2",
      templateId: null,
      brandColors: null,
      creativeType: "leaflet",
      allowNoLogo: false,
    });
    expect(gateInput.ownerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(gateInput.ownerToken).not.toBe("attempt-token-abc");
    expect(gateInput.leaseExpiresAt).toBeInstanceOf(Date);
    expect(gateInput.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("fails ownership before the gate when the post is unknown", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    __setImageRenderClaimOrchestrationForTests(orchestration);
    const { getDb } = await import("../../queries/connection");
    const empty = createMockDb();
    const emptyDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
      })),
      insert: empty.db.insert,
      update: empty.db.update,
    };
    vi.mocked(getDb).mockReturnValue(emptyDb as never);

    await expect(
      generatePremiumLeaflet({ userId: 10, contentPostId: 404, provider: "v2", clientAttemptId: "attempt-token-abc" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(orchestration.evaluateGate).not.toHaveBeenCalled();
    expect(orchestration.finalize).not.toHaveBeenCalled();
  });

  it("fails affordability before acquisition and never reaches the gate", async () => {
    affordabilityState.allowed = false;
    const orchestration = makeOrchestration({ mode: "on" });
    __setImageRenderClaimOrchestrationForTests(orchestration);
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb().db as never);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack as never);

    await expect(
      generatePremiumLeaflet({ userId: 10, contentPostId: 100, provider: "v2", clientAttemptId: "attempt-token-abc" })
    ).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });

    expect(orchestration.evaluateGate).not.toHaveBeenCalled();
    expect(orchestration.failClaim).not.toHaveBeenCalled();
    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    expect(creditEngine.recordAiUsage).not.toHaveBeenCalled();
  });

  it("acquired (and rearmed) proceed outcomes enter fresh render and finalize exactly once", async () => {
    for (const label of ["acquired", "rearmed"]) {
      vi.mocked(storeImageBuffer).mockClear();
      vi.mocked(creditEngine.deductCredits).mockClear();
      vi.mocked(creditEngine.recordAiUsage).mockClear();
      const orchestration = makeOrchestration({ mode: "on" });
      const { result } = await runClaimService(orchestration, { clientAttemptId: `attempt-${label}` });
      expect(result.status, label).toBe("completed");
      expect(storeImageBuffer, label).toHaveBeenCalledTimes(1);
      expect(orchestration.finalize, label).toHaveBeenCalledTimes(1);
      expect(creditEngine.deductCredits, label).not.toHaveBeenCalled();
      expect(creditEngine.recordAiUsage, label).not.toHaveBeenCalled();
    }
  });

  it("gate replay returns the exact stored response and performs zero render/storage/billing/caption work", async () => {
    const events: string[] = [];
    const orchestration = makeOrchestration({
      mode: "on",
      events,
      gate: async () => ({ status: "replay" as const, response: REPLAY_RESPONSE }),
    });
    const { result, mock } = await runClaimService(orchestration, { clientAttemptId: "attempt-replay" });
    await flushAsyncWork();

    expect(result).toEqual({
      jobId: "job-replay-1",
      provider: "premium-v2",
      status: "completed",
      imageUrl: "https://cdn.example.com/stored-replay.png",
      extension: "png",
      creditsCharged: 12,
      qualityTier: "premium",
      qualityLabel: "Premium Marketing Leaflet",
      isDraft: false,
      usingFallback: false,
    });
    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(orchestration.finalize).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    expect(creditEngine.recordAiUsage).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(mock.log.inserts).toHaveLength(0);
    expect(mock.log.updates).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(OWNER.ownerToken);
  });

  it("every gate blocked reason maps to its sanitized machine code and exits before side effects", async () => {
    const cases: [string, string, string][] = [
      ["already_running", "CONFLICT", "ALREADY_RUNNING"],
      ["stale_blocked", "CONFLICT", "STALE_BLOCKED"],
      ["intent_conflict", "CONFLICT", "INTENT_CONFLICT"],
      ["active_post_conflict", "CONFLICT", "ACTIVE_POST_CONFLICT"],
      ["ambiguous_deduction_blocked", "CONFLICT", "AMBIGUOUS_BLOCKED"],
      ["legacy_attempt_blocked", "CONFLICT", "AMBIGUOUS_BLOCKED"],
      ["completed_without_result", "CONFLICT", "AMBIGUOUS_BLOCKED"],
      ["linked_result_missing_or_mismatched", "CONFLICT", "AMBIGUOUS_BLOCKED"],
      ["completed_result_not_found", "CONFLICT", "AMBIGUOUS_BLOCKED"],
    ];
    for (const [reason, code, message] of cases) {
      const orchestration = makeOrchestration({
        mode: "on",
        gate: (async () => ({ status: "blocked" as const, reason: reason as never })) as ImageRenderClaimOrchestration["evaluateGate"],
      });
      __setImageRenderClaimOrchestrationForTests(orchestration);
      const { getDb } = await import("../../queries/connection");
      vi.mocked(getDb).mockReturnValue(createMockDb().db as never);
      vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack as never);

      let caught: unknown = null;
      try {
        await generatePremiumLeaflet({ userId: 10, contentPostId: 100, provider: "v2", clientAttemptId: `attempt-${reason}` });
      } catch (err) {
        caught = err;
      }
      expect((caught as { code?: string })?.code, reason).toBe(code);
      expect((caught as { message?: string })?.message, reason).toBe(message);
      // No internal reason/key/token leaks into the serialized public error.
      const serialized = JSON.stringify(caught);
      expect(serialized, reason).not.toContain(OWNER.ownerToken);
      expect(serialized, reason).not.toContain("ambiguous_deduction_blocked");
      expect(serialized, reason).not.toContain(OWNER.requestAttemptKey);
      expect(serialized, reason).not.toContain(OWNER.deductionKey);

      expect(orchestration.evaluateGate).toHaveBeenCalledTimes(1);
      expect(orchestration.finalize).not.toHaveBeenCalled();
      expect(orchestration.failClaim).not.toHaveBeenCalled();
      expect(storeImageBuffer).not.toHaveBeenCalled();
      expect(creditEngine.deductCredits).not.toHaveBeenCalled();
      expect(creditEngine.recordAiUsage).not.toHaveBeenCalled();
      vi.mocked(storeImageBuffer).mockClear();
      vi.mocked(creditEngine.deductCredits).mockClear();
      vi.mocked(creditEngine.recordAiUsage).mockClear();
    }
  });

  it("gate unavailable maps to CLAIM_SUBSYSTEM_UNAVAILABLE and exits before side effects", async () => {
    const orchestration = makeOrchestration({
      mode: "on",
      gate: (async () => ({ status: "unavailable" as const, reason: "claim_subsystem_unavailable" as const })) as ImageRenderClaimOrchestration["evaluateGate"],
    });
    __setImageRenderClaimOrchestrationForTests(orchestration);
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb().db as never);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack as never);

    await expect(
      generatePremiumLeaflet({ userId: 10, contentPostId: 100, provider: "v2", clientAttemptId: "attempt-unavailable" })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "CLAIM_SUBSYSTEM_UNAVAILABLE" });

    expect(orchestration.evaluateGate).toHaveBeenCalledTimes(1);
    expect(orchestration.finalize).not.toHaveBeenCalled();
    expect(orchestration.failClaim).not.toHaveBeenCalled();
    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    expect(creditEngine.recordAiUsage).not.toHaveBeenCalled();
  });

  it("bypasses generic existing-image reuse in effective-on mode", async () => {
    const existingImage = {
      id: 999,
      url: "https://cdn.example.com/old-reusable.png",
      provider: "premium-v2",
      providerJobId: "job-old",
      metadata: { assetTier: "premium", approvedMessagePack: validPack, qualityTier: "premium", qualityLabel: "Premium Marketing Leaflet", qualityScore: 95 },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const orchestration = makeOrchestration({ mode: "on" });
    const { result } = await runClaimService(orchestration, {
      clientAttemptId: "attempt-fresh",
      db: createMockDb({ previousImages: [existingImage] }),
    });

    expect(result.status).toBe("completed");
    expect(storeImageBuffer).toHaveBeenCalledTimes(1);
    expect(result.imageUrl).toBe("https://example.com/v2-image.png");
    expect(result.imageUrl).not.toBe(existingImage.url);
  });
});

describe("generatePremiumLeaflet — proceed/finalization integration", () => {
  it("passes the exact owner context, stored result snapshot and positive charge to finalization", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    const { result } = await runClaimService(orchestration, { clientAttemptId: "attempt-finalize" });

    expect(result.status).toBe("completed");
    const input = orchestration.lastFinalizeInput;
    expect(input.claim).toEqual({ ...OWNER, userId: 10, contentPostId: 100 });
    expect(input.charge.amount).toBe(getPremiumImageInternalCredits());
    expect(input.charge.idempotencyKey ?? null).toBeNull();
    expect(input.charge.description).toContain("Premium Marketing Leaflet");
    expect(input.result).toMatchObject({
      provider: "premium-v2",
      imageUrl: "https://example.com/v2-image.png",
      qualityTier: "premium",
      isDraft: false,
    });
    expect(typeof input.result.providerJobId === "string" || input.result.providerJobId === null).toBe(true);
    expect(input.generatedImage).toMatchObject({
      url: "https://example.com/v2-image.png",
      provider: "premium-v2",
    });
    expect(input.claim.contentPostId).toBe(100);
    expect(input.generatedImage.metadata.assetTier).toBe("premium");
    expect(input.buildContentPostPatch).toBeTypeOf("function");
  });

  it("never runs legacy deduction/usage/image-insert/post-update on a fresh claims-on success", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    const { result, mock } = await runClaimService(orchestration, { clientAttemptId: "attempt-clean" });
    await flushAsyncWork();

    expect(result.status).toBe("completed");
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    expect(creditEngine.recordAiUsage).not.toHaveBeenCalled();
    expect(mock.log.inserts.filter((entry) => entry.table === "generated_images")).toHaveLength(0);
    // The legacy FINAL content-post update never runs; the only content-post
    // write is the pre-render "generating" status marker.
    const finalPostUpdates = mock.log.updates.filter(
      (entry) => entry.table === "content_posts" && ("currentVersionId" in entry.patch || entry.patch.imageStatus === "ready")
    );
    expect(finalPostUpdates).toHaveLength(0);
    // The only generated_images read is the pre-gate previous-images load —
    // no latest-image inference select exists on this path.
    expect(mock.log.selectedTables.filter((table) => table === "generated_images")).toHaveLength(1);
  });

  it("schedules caption generation only after committed finalization", async () => {
    const events: string[] = [];
    const orchestration = makeOrchestration({ mode: "on", events });
    const { result } = await runClaimService(orchestration, { clientAttemptId: "attempt-caption" });
    await flushAsyncWork();

    expect(result.status).toBe("completed");
    const generateTextMock = vi.mocked(generateText);
    expect(generateTextMock).toHaveBeenCalled();
    expect(events.indexOf("finalize")).toBeGreaterThanOrEqual(0);
    // Caption work (generateText) is triggered strictly after finalization.
    expect(generateTextMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      (orchestration.finalize as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    );
  });

  it("service callback builds the metadata payload (not a wrapped assignment) for the coordinator to persist", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    const { result } = await runClaimService(orchestration, { clientAttemptId: "attempt-metadata-contract" });

    expect(result?.status).toBe("completed");
    const input = orchestration.lastFinalizeInput;
    const expectedCredits = getPremiumImageInternalCredits();

    // Invoke the seam exactly as the coordinator does, with a deterministic id.
    const metadata = input.buildContentPostPatch({
      generatedImageId: 4242,
      creditsCharged: expectedCredits,
    });

    // The service returns the METADATA CONTENTS for the physical
    // content_posts.metadata column — never a top-level wrapper.
    expect(metadata).not.toHaveProperty("metadata");
    expect(metadata).toMatchObject({
      currentVersionId: 4242,
      imageCurrentVersionId: 4242,
      imageUrl: "https://example.com/v2-image.png",
      imageProvider: "premium-v2",
      imageStatus: "ready",
      imageCreditsCharged: expectedCredits,
      imageSource: "premium",
      source: "premium",
      imageIsDraft: false,
      isDraft: false,
    });
  });

  it("finalization replay rerenders nothing and captions nothing", async () => {
    const orchestration = makeOrchestration({
      mode: "on",
      finalize: (async () => ({ status: "replay" as const, response: REPLAY_RESPONSE })) as ImageRenderClaimOrchestration["finalize"],
    });
    const { result } = await runClaimService(orchestration, { clientAttemptId: "attempt-freplay" });
    await flushAsyncWork();

    expect(result).toMatchObject({ status: "completed", imageUrl: REPLAY_RESPONSE.imageUrl, creditsCharged: 12 });
    expect(generateText).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
  });

  it("finalization blocked maps both reasons to CONFLICT/AMBIGUOUS_BLOCKED with zero new work", async () => {
    for (const [label, blockedReason] of [
      ["ambiguous_deduction_blocked", "ambiguous_deduction_blocked"],
      ["integrity_blocked", "integrity_blocked"],
    ] as const) {
      const orchestration = makeOrchestration({
        mode: "on",
        finalize: (async () => ({ status: "blocked" as const, reason: blockedReason as never })) as ImageRenderClaimOrchestration["finalize"],
      });
      __setImageRenderClaimOrchestrationForTests(orchestration);
      const { getDb } = await import("../../queries/connection");
      vi.mocked(getDb).mockReturnValue(createMockDb().db as never);
      vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack as never);

      let caught: unknown = null;
      try {
        await generatePremiumLeaflet({
          userId: 10, contentPostId: 100, provider: "v2", clientAttemptId: `attempt-final-${label}`,
        });
      } catch (err) {
        caught = err;
      }

      expect((caught as { code?: string })?.code, label).toBe("CONFLICT");
      expect((caught as { message?: string })?.message, label).toBe("AMBIGUOUS_BLOCKED");
      const serialized = JSON.stringify(caught);
      expect(serialized, label).not.toContain(blockedReason);
      expect(serialized, label).not.toContain(OWNER.ownerToken);
      expect(serialized, label).not.toContain(OWNER.deductionKey);

      // No refund, no rerender, no second failure transition, no billing.
      expect(orchestration.failClaim, label).not.toHaveBeenCalled();
      expect(orchestration.finalize, label).toHaveBeenCalledTimes(1);
      expect(creditEngine.deductCredits, label).not.toHaveBeenCalled();
      expect(creditEngine.recordAiUsage, label).not.toHaveBeenCalled();
      expect(vi.mocked(generateText).mock.calls.length, label).toBe(0);
      vi.mocked(storeImageBuffer).mockClear();
      vi.mocked(creditEngine.deductCredits).mockClear();
      vi.mocked(creditEngine.recordAiUsage).mockClear();
    }
  });

  it("finalization failed keeps the existing legacy failed result with no second claim-failure transition", async () => {
    const orchestration = makeOrchestration({
      mode: "on",
      finalize: (async () => ({ status: "failed" as const, reason: "insufficient_credits" as const })) as ImageRenderClaimOrchestration["finalize"],
    });
    __setImageRenderClaimOrchestrationForTests(orchestration);
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb().db as never);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack as never);

    const result = await generatePremiumLeaflet({
      userId: 10, contentPostId: 100, provider: "v2", clientAttemptId: "attempt-finalfailed",
    });

    expect(result.status).toBe("failed");
    expect(String(result.errorMessage)).toContain("IMAGE_RENDER_FINALIZATION_NOT_COMMITTED");
    expect(orchestration.failClaim).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
  });
});

describe("generatePremiumLeaflet — pre-finalization failure transitions", () => {
  it("provider failure after proceed fails the claim exactly once", async () => {
    const events: string[] = [];
    const orchestration = makeOrchestration({ mode: "on", events });
    __setImageRenderClaimOrchestrationForTests(orchestration);
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb().db as never);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack as never);
    const rendererSpy = vi.spyOn(registry, "getPremiumV2Renderer").mockReturnValue({
      name: "premium-v2",
      configured: true,
      render: vi.fn(async () => ({ success: false, error: "render boom" })),
    } as never);

    try {
      const result = await generatePremiumLeaflet({ userId: 10, contentPostId: 100, provider: "v2", clientAttemptId: "attempt-renderfail" });

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toMatch(/render boom/);
      expect(orchestration.failClaim).toHaveBeenCalledTimes(1);
      expect(orchestration.lastFailArgs).toEqual({ claimId: OWNER.claimId, ownerToken: OWNER.ownerToken });
      expect(orchestration.finalize).not.toHaveBeenCalled();
      expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    } finally {
      rendererSpy.mockRestore();
    }
  });

  it("message-pack failure after proceed fails the claim exactly once", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    __setImageRenderClaimOrchestrationForTests(orchestration);
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb().db as never);
    vi.mocked(architect.ensureApprovedMessagePack).mockRejectedValue(new Error("pack boom"));

    const result = await generatePremiumLeaflet({ userId: 10, contentPostId: 100, provider: "v2", clientAttemptId: "attempt-packfail" });

    expect(result.status).toBe("failed");
    expect(orchestration.failClaim).toHaveBeenCalledTimes(1);
    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
  });

  it("storage failure after proceed fails the claim exactly once", async () => {
    const orchestration = makeOrchestration({ mode: "on" });
    __setImageRenderClaimOrchestrationForTests(orchestration);
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb().db as never);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack as never);
    vi.mocked(storeImageBuffer).mockRejectedValueOnce(new Error("storage boom"));

    const result = await generatePremiumLeaflet({ userId: 10, contentPostId: 100, provider: "v2", clientAttemptId: "attempt-storefail" });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/storage boom/);
    expect(orchestration.failClaim).toHaveBeenCalledTimes(1);
    expect(orchestration.finalize).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
  });

  it("a failing fail-transition causes no additional mutation and no retry", async () => {
    const orchestration = makeOrchestration({ mode: "on", failThrows: new Error("fail transition down") });
    __setImageRenderClaimOrchestrationForTests(orchestration);
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb().db as never);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack as never);
    vi.mocked(storeImageBuffer).mockRejectedValueOnce(new Error("storage boom"));

    const result = await generatePremiumLeaflet({ userId: 10, contentPostId: 100, provider: "v2", clientAttemptId: "attempt-failcascade" });

    expect(result.status).toBe("failed");
    expect(orchestration.failClaim).toHaveBeenCalledTimes(1);
    expect(orchestration.finalize).not.toHaveBeenCalled();
    expect(storeImageBuffer).toHaveBeenCalledTimes(1);
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
  });

  it("zero-credit admin/free fallback still uses the gate and finalization with charge 0", async () => {
    freeFallbackState.enabled = true;
    try {
      const orchestration = makeOrchestration({ mode: "on" });
      __setImageRenderClaimOrchestrationForTests(orchestration);
      const { getDb } = await import("../../queries/connection");
      vi.mocked(getDb).mockReturnValue(createMockDb().db as never);
      vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack as never);
      vi.mocked(registry.isOpenAiLeafletConfigured).mockReturnValue(true);

      const result = await generatePremiumLeaflet({
        userId: 10, contentPostId: 100, provider: "ai", clientAttemptId: "attempt-zerocost",
      });

      expect(result.status).toBe("completed");
      expect(result.creditsCharged).toBe(0);
      expect(orchestration.evaluateGate).toHaveBeenCalledTimes(1);
      expect(orchestration.finalize).toHaveBeenCalledTimes(1);
      expect(orchestration.lastFinalizeInput.charge.amount).toBe(0);
      expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    } finally {
      freeFallbackState.enabled = false;
    }
  });
});

// ─── B2B-3D closure correction: post-proceed pre-finalization failure returns ───
//
// Every deterministic failure return between gate proceed and finalization
// must fail the owned claim exactly once (failOwnedClaimOnce) while preserving
// the exact legacy failure result, with zero finalization/billing activity.

describe("generatePremiumLeaflet — post-proceed failure returns fail the owned claim once", () => {
  function expectCleanClaimFailure(
    orchestration: ReturnType<typeof makeOrchestration>,
    result: { status: string; errorMessage?: string },
    messagePattern: RegExp
  ) {
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(messagePattern);
    expect(orchestration.failClaim).toHaveBeenCalledTimes(1);
    expect(orchestration.lastFailArgs).toEqual({
      claimId: OWNER.claimId,
      ownerToken: OWNER.ownerToken,
    });
    expect(orchestration.finalize).not.toHaveBeenCalled();
    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    expect(creditEngine.recordAiUsage).not.toHaveBeenCalled();
  }

  async function runFailureCase(
    pack: unknown,
    options: { businessLogo?: string | null } = {}
  ) {
    const orchestration = makeOrchestration({ mode: "on" });
    __setImageRenderClaimOrchestrationForTests(orchestration);
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(
      createMockDb({ businessLogo: options.businessLogo }).db as never
    );
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(pack as never);
    vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(pack as never);
    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "v2",
      clientAttemptId: "attempt-corrected-path",
    });
    return { orchestration, result };
  }

  it("campaign copy validation failure returns the same result and fails the claim exactly once", async () => {
    const rejectedPack = {
      ...validPack,
      validation: { passed: false, score: 10, rejections: ["Offer is not specific enough"], warnings: [] },
    };
    const { orchestration, result } = await runFailureCase(rejectedPack);
    expectCleanClaimFailure(orchestration, result, /Campaign copy did not pass quality validation/);
  });

  it("V2 brief quality gate failure returns the same result and fails the claim exactly once", async () => {
    const rawPainPointPack = {
      ...validPack,
      // Approved subheadline echoes the raw campaign pain point verbatim,
      // which the V2 brief quality gate rejects as customer-facing copy.
      subheadline: "Slow turnaround on print jobs",
    };
    const { orchestration, result } = await runFailureCase(rawPainPointPack);
    expectCleanClaimFailure(orchestration, result, /Premium V2 brief failed quality gate/);
  });

  it("brand asset gate failure returns the same result and fails the claim exactly once", async () => {
    const { orchestration, result } = await runFailureCase(validPack, {
      businessLogo: "/definitely/missing-logo-xyz.png",
    });
    expectCleanClaimFailure(orchestration, result, /Brand Asset Review Required/);
  });

  it("render copy validation failure returns the same result and fails the claim exactly once", async () => {
    const thinPack = {
      ...validPack,
      benefitBullets: ["Stuff"],
    };
    const { orchestration, result } = await runFailureCase(thinPack);
    expectCleanClaimFailure(orchestration, result, /Rendered copy failed quality validation/);
  });
});

// ─── Slice C1: heartbeat integration and ownership-loss guard ───

describe("generatePremiumLeaflet — Slice C1 heartbeat integration", () => {
  function makeHeartbeatFactory(config: { loseAtAssert?: number; lostImmediately?: boolean } = {}) {
    const state = {
      created: 0,
      stopCount: 0,
      assertCount: 0,
      lost: config.lostImmediately ?? false,
      owners: [] as Array<{ claimId: number; ownerToken: string }>,
      handles: [] as Array<{ stop: ReturnType<typeof vi.fn>; assertStillOwned: ReturnType<typeof vi.fn> }>,
    };
    const factory = vi.fn(({ claimId, ownerToken }: { claimId: number; ownerToken: string }) => {
      state.created += 1;
      state.owners.push({ claimId, ownerToken });
      const handle = {
        get lostOwnership() {
          return state.lost;
        },
        assertStillOwned: vi.fn(async () => {
          state.assertCount += 1;
          if (
            state.lost ||
            (config.loseAtAssert !== undefined && state.assertCount >= config.loseAtAssert)
          ) {
            state.lost = true;
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "CLAIM_SUBSYSTEM_UNAVAILABLE",
            });
          }
        }),
        stop: vi.fn(async () => {
          state.stopCount += 1;
        }),
      };
      state.handles.push(handle);
      return handle;
    });
    return { factory, state };
  }

  async function runWithFactory(
    factory: ReturnType<typeof makeHeartbeatFactory>["factory"],
    orchestration: ImageRenderClaimOrchestration,
    clientAttemptId = "attempt-heartbeat"
  ) {
    __setImageRenderClaimHeartbeatFactoryForTests(factory);
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb().db as never);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack as never);
    vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(validPack as never);
    __setImageRenderClaimOrchestrationForTests(orchestration);
    let result: Awaited<ReturnType<typeof generatePremiumLeaflet>> | null = null;
    let caught: unknown = null;
    try {
      result = await generatePremiumLeaflet({
        userId: 10,
        contentPostId: 100,
        provider: "v2",
        clientAttemptId,
      });
    } catch (err) {
      caught = err;
    }
    return { result, caught };
  }

  it("gate proceed starts exactly one heartbeat with the exact gate owner identity, stopped before finalization", async () => {
    const { factory, state } = makeHeartbeatFactory();
    const orchestration = makeOrchestration({ mode: "on" });

    const { result } = await runWithFactory(factory, orchestration);

    expect(result?.status).toBe("completed");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(state.owners).toEqual([{ claimId: OWNER.claimId, ownerToken: OWNER.ownerToken }]);
    expect(state.stopCount).toBe(1);
    // stop ran strictly before finalization.
    expect(state.handles[0].stop.mock.invocationCallOrder[0]).toBeLessThan(
      (orchestration.finalize as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    );
    expect(orchestration.failClaim).not.toHaveBeenCalled();
  });

  it.each([
    ["gate replay", { mode: "on", gate: async () => ({ status: "replay" as const, response: REPLAY_RESPONSE }) }, "completed"],
    ["gate blocked", { mode: "on", gate: async () => ({ status: "blocked" as const, reason: "already_running" as const }) }, "error"],
    ["gate unavailable", { mode: "on", gate: async () => ({ status: "unavailable" as const, reason: "claim_subsystem_unavailable" as const }) }, "error"],
    ["effective off", { mode: "off" }, "completed"],
  ] as const)("%s constructs no heartbeat", async (_label, config, expectation) => {
    const { factory, state } = makeHeartbeatFactory();
    const orchestration = makeOrchestration(config as Parameters<typeof makeOrchestration>[0]);
    if (config.mode === "off") {
      // Off mode must not even reach the gate; a throwing gate proves it.
      orchestration.evaluateGate = vi.fn(async () => {
        throw new Error("gate must not run when effective off");
      }) as ImageRenderClaimOrchestration["evaluateGate"];
    }
    const { result, caught } = await runWithFactory(factory, orchestration);
    if (expectation === "completed") {
      expect(result?.status).toBe("completed");
      if (config.mode === "off") {
        expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
      }
    } else {
      expect((caught as { code?: string })?.code).toBeDefined();
    }
    expect(state.created).toBe(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it("missing and invalid tokens construct no heartbeat", async () => {
    for (const clientAttemptId of [undefined, "bad token"] as const) {
      const { factory, state } = makeHeartbeatFactory();
      __setImageRenderClaimHeartbeatFactoryForTests(factory);
      const { getDb } = await import("../../queries/connection");
      vi.mocked(getDb).mockReturnValue(createMockDb().db as never);
      const orchestration = makeOrchestration({ mode: "on" });
      __setImageRenderClaimOrchestrationForTests(orchestration);

      await expect(
        generatePremiumLeaflet({
          userId: 10,
          contentPostId: 100,
          provider: "v2",
          clientAttemptId,
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(state.created).toBe(0);
      expect(orchestration.evaluateGate).not.toHaveBeenCalled();
    }
  });

  it("ownership loss before storage prevents storage/finalization/billing and never force-fails", async () => {
    const { factory, state } = makeHeartbeatFactory({ lostImmediately: true });
    const orchestration = makeOrchestration({ mode: "on" });

    const { caught } = await runWithFactory(factory, orchestration, "attempt-lost-before-storage");

    expect((caught as { code?: string })?.code).toBe("INTERNAL_SERVER_ERROR");
    expect((caught as { message?: string })?.message).toBe("CLAIM_SUBSYSTEM_UNAVAILABLE");
    const serialized = JSON.stringify(caught);
    expect(serialized).not.toContain(OWNER.ownerToken);
    expect(serialized).not.toContain(OWNER.deductionKey);

    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(orchestration.finalize).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    expect(creditEngine.recordAiUsage).not.toHaveBeenCalled();
    // Stale authority is never used to force-fail; fail closed.
    expect(orchestration.failClaim).not.toHaveBeenCalled();
    expect(state.stopCount).toBe(1);
  });

  it("ownership loss before finalization prevents finalization and all billing without render retry", async () => {
    const { factory, state } = makeHeartbeatFactory({ loseAtAssert: 2 });
    const orchestration = makeOrchestration({ mode: "on" });

    const { caught } = await runWithFactory(factory, orchestration, "attempt-lost-before-finalize");

    expect((caught as { message?: string })?.message).toBe("CLAIM_SUBSYSTEM_UNAVAILABLE");
    // Storage happened exactly once (no retry); finalization never ran.
    expect(storeImageBuffer).toHaveBeenCalledTimes(1);
    expect(orchestration.finalize).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    expect(creditEngine.recordAiUsage).not.toHaveBeenCalled();
    expect(orchestration.failClaim).not.toHaveBeenCalled();
    // stop ran before finalization, and the fail-closed catch stopped again
    // (idempotent) without ever force-failing stale authority.
    expect(state.stopCount).toBe(2);
  });

  it("pre-finalization failure stops the heartbeat and still fails the owned claim once", async () => {
    const { factory, state } = makeHeartbeatFactory();
    const orchestration = makeOrchestration({ mode: "on" });
    __setImageRenderClaimHeartbeatFactoryForTests(factory);
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb().db as never);
    vi.mocked(architect.ensureApprovedMessagePack).mockRejectedValue(new Error("pack boom"));
    __setImageRenderClaimOrchestrationForTests(orchestration);

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "v2",
      clientAttemptId: "attempt-hb-packfail",
    });

    expect(result.status).toBe("failed");
    expect(state.stopCount).toBe(1);
    expect(orchestration.failClaim).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["replay", { status: "replay" as const, response: REPLAY_RESPONSE }],
    ["blocked", { status: "blocked" as const, reason: "ambiguous_deduction_blocked" as const }],
    ["failed", { status: "failed" as const, reason: "insufficient_credits" as const }],
  ] as const)("finalization %s leaves the heartbeat stopped exactly once", async (_label, outcome) => {
    const { factory, state } = makeHeartbeatFactory();
    const orchestration = makeOrchestration({
      mode: "on",
      finalize: (async () => outcome) as ImageRenderClaimOrchestration["finalize"],
    });
    __setImageRenderClaimHeartbeatFactoryForTests(factory);
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb().db as never);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack as never);
    __setImageRenderClaimOrchestrationForTests(orchestration);

    if (outcome.status === "blocked") {
      await expect(
        generatePremiumLeaflet({ userId: 10, contentPostId: 100, provider: "v2", clientAttemptId: "attempt-hb-blocked" })
      ).rejects.toMatchObject({ code: "CONFLICT", message: "AMBIGUOUS_BLOCKED" });
    } else if (outcome.status === "failed") {
      const result = await generatePremiumLeaflet({ userId: 10, contentPostId: 100, provider: "v2", clientAttemptId: "attempt-hb-failed" });
      expect(result.status).toBe("failed");
    } else {
      const result = await generatePremiumLeaflet({ userId: 10, contentPostId: 100, provider: "v2", clientAttemptId: "attempt-hb-replay" });
      expect(result.status).toBe("completed");
    }

    expect(state.stopCount).toBe(1);
    expect(state.stopCount).toBe(1);
  });
});
