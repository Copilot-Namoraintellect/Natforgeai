import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { imageRouter } from "./image-router";
import { getDb } from "./queries/connection";
import { adminAdjustCredits } from "./lib/billing/credit-engine";

// WBS12.4 image production authority closure guards.
//
// Two fail-closed router guards close the remaining unaudited authority
// relationships on the legacy image endpoints:
//
//   1. image.approveVersion may only approve a generated_images row that is a
//      version OF the target post (contentPostId binding). Legacy
//      image.create/image.update worker rows carry no approved-intent
//      relationship to any post and can never become a post's ready Creative
//      image; another post's image was rendered from different approved copy.
//
//   2. image.update is the legacy external-worker completion path for
//      image.create job rows (contentPostId IS NULL). Post-linked rows are
//      draft/premium artifacts persisted completed by their generation flows
//      (governed rows carry claim/finalization lineage) and must never be
//      rewritten through it.
//
//   3. image.approveVersion rebinds the post's creativeBriefFingerprint to
//      the approved version's own persisted fingerprint (top-level for
//      draft/claims-OFF rows, renderLineage.strategy for governed rows), so
//      approving an older version can never leave a stale image publish-ready
//      under a newer render's currency. A version with no persisted
//      fingerprint drops the key — the publication-readiness gate fails
//      closed rather than lending the previous image's authority forward.

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/rate-limiter", () => ({
  rateLimitUser: vi.fn().mockResolvedValue(undefined),
  rateLimitPublic: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, limit: 100, remaining: 99, resetAt: Date.now() + 60 * 60 * 1000 }),
  clearRateLimitStateForTests: vi.fn(),
}));

vi.mock("./lib/creative/service", () => ({
  generatePremiumLeaflet: vi.fn(),
  generateBasicDraftLeaflet: vi.fn(),
  generateCaptionPack: vi.fn(),
}));

vi.mock("./lib/billing/credit-engine", () => ({
  checkCredits: vi.fn(async () => ({ hasCredits: true, balance: 100 })),
  deductCredits: vi.fn(async () => ({ newBalance: 98 })),
  recordAiUsage: vi.fn(async () => {}),
  adminAdjustCredits: vi.fn(async () => ({})),
}));

function buildCtx(userId = 18) {
  return {
    resHeaders: new Headers(),
    user: { id: userId, tierSlug: "pro" },
    session: { verified: true },
  } as any;
}

interface MockDbOptions {
  // Each .limit(1) call shifts the next queued row array (in query order).
  selectQueue?: unknown[][];
}

function mockDb(options: MockDbOptions = {}) {
  const updates: any[] = [];
  const queue = [...(options.selectQueue ?? [])];
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => queue.shift() ?? []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: any) => {
        updates.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
  } as any);
  return updates;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("imageRouter.approveVersion — WBS12.4 post-binding guard", () => {
  it("approves a completed image that is a version of the target post (intended behavior retained)", async () => {
    const updates = mockDb({
      selectQueue: [
        [{
          id: 7,
          userId: 18,
          contentPostId: 100,
          status: "completed",
          url: "https://cdn.example/x.png",
          metadata: { qualityScore: 91 },
        }],
        [{ metadata: { existing: 1 } }],
      ],
    });

    const result = await imageRouter
      .createCaller(buildCtx())
      .approveVersion({ contentPostId: 100, generatedImageId: 7 });

    expect(result).toEqual({ success: true, imageUrl: "https://cdn.example/x.png" });
    expect(updates).toHaveLength(1);
    const meta = JSON.parse(updates[0].metadata);
    expect(meta.imageUrl).toBe("https://cdn.example/x.png");
    expect(meta.imageStatus).toBe("ready");
    expect(meta.currentVersionId).toBe(7);
    expect(meta.imageCurrentVersionId).toBe(7);
    expect(meta.imageQualityScore).toBe(91);
    expect(meta.existing).toBe(1);
  });

  it("fails closed when the image belongs to a different post", async () => {
    // The post-scoped query filters the other post's row out, exactly as the
    // real database does with the contentPostId binding.
    const updates = mockDb({ selectQueue: [[]] });

    await expect(
      imageRouter.createCaller(buildCtx()).approveVersion({ contentPostId: 100, generatedImageId: 7 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(updates).toHaveLength(0);
  });

  it("fails closed for a legacy image.create/image.update worker row (no post link)", async () => {
    // Legacy job-tracker rows have contentPostId NULL; the scoped query never
    // returns them, so an arbitrary worker-supplied URL can never be approved
    // onto a post as its ready Creative image.
    const updates = mockDb({ selectQueue: [[]] });

    await expect(
      imageRouter.createCaller(buildCtx()).approveVersion({ contentPostId: 100, generatedImageId: 7 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(updates).toHaveLength(0);
  });

  it("still rejects a non-completed image of the same post", async () => {
    const updates = mockDb({
      selectQueue: [
        [{ id: 7, userId: 18, contentPostId: 100, status: "pending", url: "", metadata: {} }],
        [{ metadata: {} }],
      ],
    });

    await expect(
      imageRouter.createCaller(buildCtx()).approveVersion({ contentPostId: 100, generatedImageId: 7 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(updates).toHaveLength(0);
  });

  it("source guard: the approveVersion image query is scoped by contentPostId", () => {
    const source = readFileSync(join(REPO_ROOT, "api/image-router.ts"), "utf8");
    const procedure = source.slice(source.indexOf("approveVersion:"));
    expect(procedure).toContain("eq(generatedImages.contentPostId, input.contentPostId)");
  });
});

describe("imageRouter.approveVersion — WBS12.4 brief-fingerprint rebind", () => {
  function queueApprove(updates: any[], imageMetadata: unknown, postMetadata: unknown) {
    return mockDb({
      selectQueue: [
        [{ id: 7, userId: 18, contentPostId: 100, status: "completed", url: "https://cdn.example/v7.png", metadata: imageMetadata }],
        [{ metadata: postMetadata }],
      ],
    });
  }

  it("rebinds the post fingerprint to the approved version's own (draft/claims-OFF top-level) fingerprint", async () => {
    // The post currently carries a NEWER render's currency; approving the
    // older version must move the fingerprint back to that version's own, so
    // the publication gate evaluates the approved image, not the latest one.
    const updates = queueApprove([], { qualityScore: 80, creativeBriefFingerprint: "fp-old" }, { creativeBriefFingerprint: "fp-new", keep: 1 });

    const result = await imageRouter
      .createCaller(buildCtx())
      .approveVersion({ contentPostId: 100, generatedImageId: 7 });

    expect(result).toEqual({ success: true, imageUrl: "https://cdn.example/v7.png" });
    expect(updates).toHaveLength(1);
    const meta = JSON.parse(updates[0].metadata);
    expect(meta.creativeBriefFingerprint).toBe("fp-old");
    expect(meta.keep).toBe(1);
  });

  it("rebinds from the governed renderLineage.strategy fingerprint", async () => {
    const updates = queueApprove(
      [],
      { renderLineage: { lineageSchemaVersion: 1, strategy: { creativeBriefFingerprint: "fp-governed" }, approvedCopy: null } },
      { creativeBriefFingerprint: "fp-new" }
    );

    await imageRouter.createCaller(buildCtx()).approveVersion({ contentPostId: 100, generatedImageId: 7 });

    expect(updates).toHaveLength(1);
    const meta = JSON.parse(updates[0].metadata);
    expect(meta.creativeBriefFingerprint).toBe("fp-governed");
  });

  it("fails closed: a version with no persisted fingerprint drops the stored one", async () => {
    // No fingerprint on the row → the key is omitted from the stored JSON →
    // the publication-readiness gate reports the selected output stale
    // instead of lending the previous image's authority to this version.
    const updates = queueApprove([], { qualityScore: 80 }, { creativeBriefFingerprint: "fp-new" });

    await imageRouter.createCaller(buildCtx()).approveVersion({ contentPostId: 100, generatedImageId: 7 });

    expect(updates).toHaveLength(1);
    const meta = JSON.parse(updates[0].metadata);
    expect("creativeBriefFingerprint" in meta).toBe(false);
    expect(meta.imageStatus).toBe("ready");
  });

  it("treats a whitespace-only fingerprint as absent (fail closed)", async () => {
    const updates = queueApprove([], { creativeBriefFingerprint: "   " }, { creativeBriefFingerprint: "fp-new" });

    await imageRouter.createCaller(buildCtx()).approveVersion({ contentPostId: 100, generatedImageId: 7 });

    expect(updates).toHaveLength(1);
    const meta = JSON.parse(updates[0].metadata);
    expect("creativeBriefFingerprint" in meta).toBe(false);
  });

  it("source guard: approveVersion rebinds creativeBriefFingerprint from the approved row", () => {
    const source = readFileSync(join(REPO_ROOT, "api/image-router.ts"), "utf8");
    const procedure = source.slice(source.indexOf("approveVersion:"));
    expect(procedure).toContain("creativeBriefFingerprint: approvedBriefFingerprint");
    expect(procedure).toContain("renderLineage?.strategy?.creativeBriefFingerprint");
  });
});

describe("imageRouter.update — WBS12.4 governed-artifact immutability guard", () => {
  it("refuses to rewrite a post-linked (draft/premium) row's url", async () => {
    const updates = mockDb({
      selectQueue: [
        [{ id: 9, userId: 18, contentPostId: 100, status: "completed", url: "https://cdn.example/governed.png", creditsCharged: 20 }],
      ],
    });

    await expect(
      imageRouter.createCaller(buildCtx()).update({ id: 9, url: "https://attacker.example/x.png" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(updates).toHaveLength(0);
    expect(adminAdjustCredits).not.toHaveBeenCalled();
  });

  it("refuses status-only changes on post-linked rows", async () => {
    const updates = mockDb({
      selectQueue: [
        [{ id: 9, userId: 18, contentPostId: 100, status: "completed", url: "https://cdn.example/governed.png", creditsCharged: 20 }],
      ],
    });

    await expect(
      imageRouter.createCaller(buildCtx()).update({ id: 9, status: "failed" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(updates).toHaveLength(0);
    // No refund either: the legacy pending→failed refund only applies to
    // legacy job rows, never to governed artifacts.
    expect(adminAdjustCredits).not.toHaveBeenCalled();
  });

  it("retains the legacy worker completion flow for image.create job rows", async () => {
    const updates = mockDb({
      selectQueue: [
        [{ id: 5, userId: 18, contentPostId: null, status: "pending", url: "", creditsCharged: 2 }],
      ],
    });

    const result = await imageRouter
      .createCaller(buildCtx())
      .update({ id: 5, url: "https://worker.example/done.png", status: "completed" });

    expect(result).toEqual({ success: true });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ url: "https://worker.example/done.png", status: "completed" });
    expect(adminAdjustCredits).not.toHaveBeenCalled();
  });

  it("retains the legacy pending→failed refund for image.create job rows", async () => {
    const updates = mockDb({
      selectQueue: [
        [{ id: 5, userId: 18, contentPostId: null, status: "pending", url: "", creditsCharged: 2 }],
      ],
    });

    const result = await imageRouter.createCaller(buildCtx()).update({ id: 5, status: "failed" });

    expect(result).toEqual({ success: true });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ status: "failed" });
    expect(adminAdjustCredits).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adminAdjustCredits).mock.calls[0][0]).toMatchObject({ userId: 18, amount: 2 });
  });

  it("source guard: image.update fails closed on post-linked rows before any write", () => {
    const source = readFileSync(join(REPO_ROOT, "api/image-router.ts"), "utf8");
    const procedure = source.slice(source.indexOf("update: authedQuery"), source.indexOf("premiumTemplateStatus:"));
    const guardIndex = procedure.indexOf("existing.contentPostId != null");
    const writeIndex = procedure.indexOf(".update(generatedImages)");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(writeIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(writeIndex);
  });
});

// ─── WBS12.4 production image-path inventory guard ───
//
// Fails if any production code path inserts/updates/deletes generated_images
// outside the audited inventory:
//
//   api/image-router.ts                              — legacy job tracker (create/update; update is worker-only after the guard)
//   api/lib/creative/service.ts                      — basic draft insert + claims-OFF premium legacy insert
//   api/lib/creative/image-render-finalization.ts    — governed claim/finalization insert (claims ON)
//   api/admin-router.ts                              — delete only (admin user cascade)
//
// scripts/ is non-production (direct-db operator tooling) and tracked
// separately so a new production write can never hide there.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXPECTED_PRODUCTION_WRITE_FILES = [
  "api/image-router.ts",
  "api/lib/creative/image-render-finalization.ts",
  "api/lib/creative/service.ts",
];
const EXPECTED_PRODUCTION_DELETE_FILES = ["api/admin-router.ts"];
const EXPECTED_SCRIPT_WRITE_FILES = ["scripts/refund-campaign-credits.ts"];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];
const WRITE_PATTERN = /\b(?:insert|update)\s*\(\s*generatedImages\s*\)/;
const DELETE_PATTERN = /\bdelete\s*\(\s*generatedImages\s*\)/;

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSources(full));
      continue;
    }
    if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
    if (entry.name.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}

function findGeneratedImageWriteSites(roots: string[]) {
  const writes = new Set<string>();
  const deletes = new Set<string>();
  for (const root of roots) {
    for (const file of walkSources(join(REPO_ROOT, root))) {
      const source = readFileSync(file, "utf8");
      const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (WRITE_PATTERN.test(source)) writes.add(rel);
      if (DELETE_PATTERN.test(source)) deletes.add(rel);
    }
  }
  return { writes: [...writes].sort(), deletes: [...deletes].sort() };
}

describe("WBS12.4 production image-path inventory", () => {
  // The recursive source walk is I/O-bound and can exceed the default timeout
  // on cold filesystems; the inventory itself is pure source scanning.
  it("covers every production generated_images insert/update site", { timeout: 120_000 }, () => {
    const { writes } = findGeneratedImageWriteSites(["api", "src"]);
    expect(writes).toEqual(EXPECTED_PRODUCTION_WRITE_FILES);
  });

  it("covers every production generated_images delete site", { timeout: 120_000 }, () => {
    const { deletes } = findGeneratedImageWriteSites(["api", "src"]);
    expect(deletes).toEqual(EXPECTED_PRODUCTION_DELETE_FILES);
  });

  it("tracks the only non-production (script) write site", () => {
    const { writes, deletes } = findGeneratedImageWriteSites(["scripts"]);
    expect(writes).toEqual(EXPECTED_SCRIPT_WRITE_FILES);
    expect(deletes).toEqual([]);
  });
});
