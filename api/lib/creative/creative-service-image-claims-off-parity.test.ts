import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";

// Off-parity harness: identical mocks to the claim-mode suite, with the REAL
// committed mode layer (never a stubbed mode result) so configured-off and
// configured-on+not-ready both exercise the true default-off decision path.

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../billing/cost-control", () => ({
  enforceCostControl: vi.fn(async () => ({ allowed: true, daily: 0, monthly: 0, balance: 100 })),
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

vi.mock("../env", async () => {
  const actual = await vi.importActual<typeof import("../env")>("../env");
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableHybridLeafletPipeline() {
        return hybridState.enabled;
      },
    },
  };
});

vi.mock("./premium-v2/hybrid-pipeline", () => ({
  runHybridPipeline: vi.fn(),
}));

import { generateText } from "ai";
import {
  generatePremiumLeaflet,
  __setImageRenderClaimOrchestrationForTests,
  type ImageRenderClaimOrchestration,
} from "./service";
import * as architect from "./campaign-message-architect";
import * as creditEngine from "../billing/credit-engine";
import { storeImageBuffer } from "./storage";
import { ensureFixtureLogos, resolveFixtureLogoPath } from "./premium-v2/fixture-logos";
import {
  getEffectiveImageRenderClaimsMode,
  type ImageRenderClaimsReadiness,
  type ImageRenderClaimsReadinessChecker,
} from "./image-render-claims-readiness";

const THROWING_READINESS = {
  check: async (): Promise<never> => {
    throw new Error("readiness must never be probed when the configured mode is off");
  },
};

interface OffOrchestration extends ImageRenderClaimOrchestration {
  gateCalls: number;
  finalizeCalls: number;
  failCalls: number;
}

function makeOffOrchestration(
  readiness?: ImageRenderClaimsReadinessChecker
): OffOrchestration {
  const orchestration: OffOrchestration = {
    gateCalls: 0,
    finalizeCalls: 0,
    failCalls: 0,
    getEffectiveMode: (async () =>
      getEffectiveImageRenderClaimsMode({
        readiness: readiness ?? THROWING_READINESS,
      })) as ImageRenderClaimOrchestration["getEffectiveMode"],
    evaluateGate: vi.fn(async () => {
      orchestration.gateCalls += 1;
      throw new Error("claim gate must never run when image claims are effectively off");
    }) as ImageRenderClaimOrchestration["evaluateGate"],
    createFinalizationDeps: vi.fn(() => {
      throw new Error("finalization deps must never be constructed when effectively off");
    }) as ImageRenderClaimOrchestration["createFinalizationDeps"],
    finalize: vi.fn(async () => {
      orchestration.finalizeCalls += 1;
      throw new Error("finalization must never run when image claims are effectively off");
    }) as ImageRenderClaimOrchestration["finalize"],
    failClaim: vi.fn(async () => {
      orchestration.failCalls += 1;
      throw new Error("claim fail transition must never run when effectively off");
    }) as ImageRenderClaimOrchestration["failClaim"],
  };
  return orchestration;
}

interface DbLog {
  inserts: { table: string; values: Record<string, unknown> }[];
  updates: { table: string; patch: Record<string, unknown> }[];
  selectedTables: string[];
}

function tableNameOf(table: unknown): string {
  return String((table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] ?? "unknown");
}

function createMockDb(options: { previousImages?: unknown[] } = {}) {
  const log: DbLog = { inserts: [], updates: [], selectedTables: [] };
  const campaignRow = {
    id: 28, userId: 10, businessId: 24, name: "Print Campaign",
    productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier",
    targetBuyer: "Local businesses", mainPainPoint: "Slow turnaround on print jobs",
    offerDetails: "10% off first order", excludedOffers: "", preferredCta: "Get a Quote",
    platforms: "Instagram, Facebook", primaryOutcome: "Leads", coreMessage: "Fast local printing",
    contentStyle: null,
  };
  const businessRow = {
    id: 24, userId: 10, name: "3@1 Newmarket", displayName: "3@1 Newmarket",
    logo: resolveFixtureLogoPath("3at1"), industry: "Print and courier", location: "Newmarket",
    phone: "011 123 9999", website: "https://3at1newmarket.test",
    productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier, Business cards, Banners, Canvas",
    targetCustomer: "Local businesses and students", brandColors: ["#0047AB", "#FFD700", "#FFFFFF"],
    visualStyle: "modern",
    websiteEvidence: { businessCategory: "print and courier", productsServices: ["Printing"] },
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
} as const;

const REUSABLE_IMAGE = {
  id: 999,
  url: "https://cdn.example.com/old-reusable.png",
  provider: "premium-v2",
  providerJobId: "job-old",
  metadata: {
    assetTier: "premium",
    approvedMessagePack: validPack,
    qualityTier: "premium",
    qualityLabel: "Premium Marketing Leaflet",
    qualityScore: 95,
  },
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function flushAsyncWork() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

beforeAll(async () => {
  await ensureFixtureLogos();
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  __setImageRenderClaimOrchestrationForTests(null);
  if (process.env.IMAGE_RENDER_CLAIMS_MODE !== undefined) {
    delete process.env.IMAGE_RENDER_CLAIMS_MODE;
  }
});

async function runOffService(
  orchestration: OffOrchestration,
  options: { clientAttemptId?: string; previousImages?: unknown[] } = {}
) {
  __setImageRenderClaimOrchestrationForTests(orchestration);
  const { getDb } = await import("../../queries/connection");
  const mock = createMockDb({ previousImages: options.previousImages });
  vi.mocked(getDb).mockReturnValue(mock.db as never);
  vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack as never);
  vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(validPack as never);
  const result = await generatePremiumLeaflet({
    userId: 10,
    contentPostId: 100,
    provider: "v2",
    clientAttemptId: options.clientAttemptId,
  });
  await flushAsyncWork();
  return { result, mock };
}

describe("effective-off parity — token absent vs token present (configured off)", () => {
  it("produces byte-identical legacy behavior whether or not a clientAttemptId is supplied", async () => {
    const withoutToken = await runOffService(makeOffOrchestration(), {});
    const orchestrationWithToken = makeOffOrchestration();
    const withToken = await runOffService(orchestrationWithToken, { clientAttemptId: "token-present-client" });

    // Returned object deep equality (jobId embeds a run timestamp from the
    // real renderer, so it is compared by shape).
    const normalize = (value: unknown): Record<string, unknown> => {
      const record = value as Record<string, unknown>;
      return {
        ...record,
        jobId: String(record.jobId).replace(/premium-v2-\d+/, "premium-v2"),
      };
    };
    expect(normalize(withToken.result)).toEqual(normalize(withoutToken.result));
    expect(withToken.result.status).toBe("completed");
    expect(withToken.result.imageUrl).toBe("https://example.com/v2-image.png");
    expect(String(withToken.result.jobId)).toMatch(/^premium-v2-\d+$/);

    // Provider render + storage parity.
    expect(storeImageBuffer).toHaveBeenCalledTimes(2); // one per run
    expect(vi.mocked(storeImageBuffer).mock.calls[0]?.[0]).toEqual(vi.mocked(storeImageBuffer).mock.calls[1]?.[0]);

    // Legacy billing parity (count + amounts). The renderer embeds a run
    // timestamp in providerJobId, so that one field is normalized.
    const stripRunIds = (value: unknown): unknown =>
      JSON.parse(
        JSON.stringify(value ?? null).replace(/premium-v2-\d+/g, "premium-v2")
      );
    expect(creditEngine.deductCredits).toHaveBeenCalledTimes(2);
    expect(stripRunIds(vi.mocked(creditEngine.deductCredits).mock.calls[0]?.[0])).toEqual(
      stripRunIds(vi.mocked(creditEngine.deductCredits).mock.calls[1]?.[0])
    );
    expect(creditEngine.recordAiUsage).toHaveBeenCalledTimes(2);
    expect(stripRunIds(vi.mocked(creditEngine.recordAiUsage).mock.calls[0]?.[0])).toEqual(
      stripRunIds(vi.mocked(creditEngine.recordAiUsage).mock.calls[1]?.[0])
    );

    // Legacy persistence parity: one generated image insert + content post
    // update per run, with identical stable payloads.
    for (const mock of [withoutToken.mock, withToken.mock]) {
      const imageInserts = mock.log.inserts.filter((entry) => entry.table === "generated_images");
      expect(imageInserts).toHaveLength(1);
      expect(imageInserts[0].values).toMatchObject({
        userId: 10,
        contentPostId: 100,
        provider: "premium-v2",
        status: "completed",
        url: "https://example.com/v2-image.png",
      });
      const postUpdates = mock.log.updates.filter((entry) => entry.table === "content_posts");
      const readyUpdate = postUpdates.find(
        (entry) => ((entry.patch as Record<string, unknown>).metadata as Record<string, unknown> | undefined)?.imageStatus === "ready"
      );
      expect(readyUpdate).toBeDefined();
      expect((readyUpdate?.patch as Record<string, unknown>).metadata).toMatchObject({
        imageStatus: "ready",
        imageUrl: "https://example.com/v2-image.png",
      });
    }

    // Caption-pack behavior parity (identical fire-and-forget pattern per
    // run; the real caption helper invokes generateText twice per run).
    const generateTextMock = vi.mocked(generateText);
    expect(generateTextMock).toHaveBeenCalledTimes(4);
    expect(stripRunIds(generateTextMock.mock.calls[0])).toEqual(stripRunIds(generateTextMock.mock.calls[2]));
    expect(stripRunIds(generateTextMock.mock.calls[1])).toEqual(stripRunIds(generateTextMock.mock.calls[3]));

    // Zero claim activity in both runs: no gate, no finalization, no fail
    // transition, and no claim-table access.
    expect(orchestrationWithToken.gateCalls).toBe(0);
    expect(orchestrationWithToken.finalizeCalls).toBe(0);
    expect(orchestrationWithToken.failCalls).toBe(0);
    for (const mock of [withoutToken.mock, withToken.mock]) {
      expect(mock.log.selectedTables).not.toContain("image_render_claims");
    }
  });

  it("configured-off performs zero readiness probes (throwing readiness dependency)", async () => {
    const orchestration = makeOffOrchestration();
    const { result } = await runOffService(orchestration, {});
    expect(result.status).toBe("completed");
    expect(orchestration.gateCalls).toBe(0);
    expect(orchestration.finalizeCalls).toBe(0);
  });
});

describe("effective-off parity — configured on + readiness not ready", () => {
  it("executes the exact legacy path while never running gate/finalization", async () => {
    process.env.IMAGE_RENDER_CLAIMS_MODE = "on";
    const orchestration = makeOffOrchestration({
      check: async (): Promise<ImageRenderClaimsReadiness> => ({
        ready: false,
        reason: "claim_table_missing",
      }),
    });
    const { result, mock } = await runOffService(orchestration, { clientAttemptId: "old-client-no-schema" });

    expect(result.status).toBe("completed");
    expect(result.imageUrl).toBe("https://example.com/v2-image.png");
    // Legacy billing ran exactly once for the single request.
    expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
    expect(creditEngine.recordAiUsage).toHaveBeenCalledTimes(1);
    expect(mock.log.inserts.filter((entry) => entry.table === "generated_images")).toHaveLength(1);
    expect(orchestration.gateCalls).toBe(0);
    expect(orchestration.finalizeCalls).toBe(0);
    expect(orchestration.failCalls).toBe(0);
    expect(mock.log.selectedTables).not.toContain("image_render_claims");
  });
});

describe("effective-off parity — existing-image reuse remains byte-for-byte legacy", () => {
  it("returns the reusable existing premium asset with zero render/storage/billing when claims are off", async () => {
    const orchestration = makeOffOrchestration();
    const { result, mock } = await runOffService(orchestration, { previousImages: [REUSABLE_IMAGE] });

    expect(result).toEqual({
      jobId: "job-old",
      provider: "premium-v2",
      status: "completed",
      imageUrl: "https://cdn.example.com/old-reusable.png",
      extension: "png",
      creditsCharged: 0,
      qualityTier: "premium",
      qualityLabel: "Premium Marketing Leaflet",
      isDraft: false,
      usingFallback: false,
    });
    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    expect(creditEngine.recordAiUsage).not.toHaveBeenCalled();
    expect(mock.log.inserts.filter((entry) => entry.table === "generated_images")).toHaveLength(0);
    // Reuse still marks the post ready through the legacy update.
    const postUpdates = mock.log.updates.filter((entry) => entry.table === "content_posts");
    expect(postUpdates.length).toBeGreaterThanOrEqual(1);
    expect(orchestration.gateCalls).toBe(0);
    expect(orchestration.finalizeCalls).toBe(0);
    expect(mock.log.selectedTables).not.toContain("image_render_claims");
  });
});
