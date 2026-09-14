import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  collectImageRenderReconciliationEvidence,
  createDefaultImageRenderReconciliationEvidenceExecutor,
  type ImageRenderReconciliationClaimRow,
  type ImageRenderReconciliationContentPostRow,
  type ImageRenderReconciliationDeductionRow,
  type ImageRenderReconciliationEvidenceCollectionResult,
  type ImageRenderReconciliationEvidenceExecutor,
  type ImageRenderReconciliationEvidenceInput,
  type ImageRenderReconciliationGeneratedImageRow,
} from "./image-render-reconciliation-evidence";
import { classifyImageRenderReconciliation } from "./image-render-reconciliation-classifier";
import { deriveImageRenderAttemptIdentity } from "./image-render-claim";
import { getDb } from "../../queries/connection";
import { creditTransactions, imageRenderClaims } from "@db/schema";

// ─── Deterministic read-only collector tests ───
//
// Injected executor fakes only: no database, filesystem, network, timers, or
// environment mutation. C4A is invoked only by TESTS for compatibility proof.

const viMock = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../../queries/connection", () => ({ getDb: viMock.getDb }));

const here = path.dirname(fileURLToPath(import.meta.url));
const collectorSource = readFileSync(
  path.resolve(here, "./image-render-reconciliation-evidence.ts"),
  "utf8"
);

const IDENTITY = deriveImageRenderAttemptIdentity({
  userId: 7,
  contentPostId: 13,
  attempt: { clientAttemptId: "attempt-token-1" },
});

function makeInput(
  overrides: Partial<ImageRenderReconciliationEvidenceInput> = {}
): ImageRenderReconciliationEvidenceInput {
  return {
    upstream: "completed_replayable",
    claimId: 42,
    userId: 7,
    contentPostId: 13,
    requestAttemptKey: IDENTITY.requestAttemptKey,
    intentFingerprint: IDENTITY.intentFingerprint,
    deductionKey: IDENTITY.deductionKey,
    ...overrides,
  };
}

const CLAIM_ROW: ImageRenderReconciliationClaimRow = {
  generatedImageId: 555,
  resultImageUrl: "https://cdn.example.com/asset.png",
  resultProvider: "premium-v2",
  resultProviderJobId: "job-9",
  resultCreditsCharged: 12,
  resultQualityTier: "premium",
  resultQualityLabel: "Premium Marketing Leaflet",
  resultIsDraft: false,
  completedAt: new Date("2026-06-01T00:00:00.000Z"),
};

const IMAGE_ROW: ImageRenderReconciliationGeneratedImageRow = {
  id: 555,
  userId: 7,
  contentPostId: 13,
  provider: "premium-v2",
  providerJobId: "job-9",
  url: "https://cdn.example.com/asset.png",
  creditsCharged: 12,
  metadata: { assetTier: "premium" },
};

function postMetadata(overrides: Record<string, unknown> = {}) {
  return {
    currentVersionId: 555,
    imageCurrentVersionId: 555,
    imageUrl: "https://cdn.example.com/asset.png",
    imageProvider: "premium-v2",
    imageJobId: "job-9",
    imageStatus: "ready",
    imageCreditsCharged: 12,
    imageSource: "premium",
    source: "premium",
    ...overrides,
  };
}

const POST_ROW: ImageRenderReconciliationContentPostRow = {
  id: 13,
  metadata: postMetadata(),
};

const DEDUCTION_ROW: ImageRenderReconciliationDeductionRow = {
  id: 901,
  userId: 7,
  type: "image_generation",
  amount: -12,
  idempotencyKey: IDENTITY.deductionKey,
};

type RowOrError<T> = T | null | Error;

function makeExecutor(script: {
  claim?: RowOrError<ImageRenderReconciliationClaimRow>;
  image?: RowOrError<ImageRenderReconciliationGeneratedImageRow>;
  post?: RowOrError<ImageRenderReconciliationContentPostRow>;
  deduction?: RowOrError<ImageRenderReconciliationDeductionRow>;
}) {
  const counts = { claim: 0, image: 0, post: 0, deduction: 0 };
  const args: { claim: unknown[]; image: unknown[]; post: unknown[]; deduction: unknown[] } = {
    claim: [],
    image: [],
    post: [],
    deduction: [],
  };
  const resolve = <T,>(value: RowOrError<T> | undefined, fallback: T | null): Promise<T | null> => {
    const chosen = value === undefined ? fallback : value;
    if (chosen instanceof Error) return Promise.reject(chosen);
    return Promise.resolve(chosen);
  };
  const deps: ImageRenderReconciliationEvidenceExecutor = {
    findExactClaim: (a) => {
      counts.claim += 1;
      args.claim.push(a);
      return resolve(script.claim, CLAIM_ROW);
    },
    findGeneratedImageById: (a) => {
      counts.image += 1;
      args.image.push(a);
      return resolve(script.image, IMAGE_ROW);
    },
    findContentPostById: (a) => {
      counts.post += 1;
      args.post.push(a);
      return resolve(script.post, POST_ROW);
    },
    findDeductionByKey: (a) => {
      counts.deduction += 1;
      args.deduction.push(a);
      return resolve(script.deduction, DEDUCTION_ROW);
    },
  };
  return { deps, counts, args };
}

function expectFrozenResult(result: ImageRenderReconciliationEvidenceCollectionResult) {
  expect(Object.isFrozen(result)).toBe(true);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("collectImageRenderReconciliationEvidence — input and claim", () => {
  it.each([
    ["claimId", { claimId: 0 }],
    ["userId", { userId: -1 }],
    ["contentPostId", { contentPostId: 1.5 }],
    ["requestAttemptKey", { requestAttemptKey: "bad" }],
    ["intentFingerprint", { intentFingerprint: "BAD" }],
    ["deductionKey length", { deductionKey: "x".repeat(192) }],
  ])("rejects invalid %s before any read", async (_label, overrides) => {
    const { deps, counts } = makeExecutor({});
    await expect(
      collectImageRenderReconciliationEvidence(makeInput(overrides), deps)
    ).rejects.toThrow();
    expect(counts.claim + counts.image + counts.post + counts.deduction).toBe(0);
  });

  it("rejects a non-derived deduction key before any read", async () => {
    const { deps, counts } = makeExecutor({});
    await expect(
      collectImageRenderReconciliationEvidence(
        makeInput({ deductionKey: `img-deduction:${"f".repeat(64)}` }),
        deps
      )
    ).rejects.toThrow(/does not match the derived attempt identity/);
    expect(counts.claim).toBe(0);
  });

  it("exact claim lookup carries the full immutable identity", async () => {
    const { deps, args } = makeExecutor({});
    await collectImageRenderReconciliationEvidence(makeInput(), deps);
    expect(args.claim).toEqual([
      {
        claimId: 42,
        userId: 7,
        contentPostId: 13,
        requestAttemptKey: IDENTITY.requestAttemptKey,
        intentFingerprint: IDENTITY.intentFingerprint,
        deductionKey: IDENTITY.deductionKey,
      },
    ]);
  });

  it("claim lookup failure blocks with claim_lookup_failed and performs zero further reads", async () => {
    const { deps, counts } = makeExecutor({ claim: new Error("db exploded") });
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    expect(result).toEqual({ status: "blocked", reason: "claim_lookup_failed" });
    expect(counts.claim).toBe(1);
    expect(counts.image + counts.post + counts.deduction).toBe(0);
    expectFrozenResult(result);
  });

  it("no exact claim blocks with claim_not_found_or_identity_mismatch and stops", async () => {
    const { deps, counts } = makeExecutor({ claim: null });
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    expect(result).toEqual({ status: "blocked", reason: "claim_not_found_or_identity_mismatch" });
    expect(counts.claim).toBe(1);
    expect(counts.image + counts.post + counts.deduction).toBe(0);
  });
});

describe("collectImageRenderReconciliationEvidence — generated image", () => {
  it("null generatedImageId yields absent with zero image reads", async () => {
    const { deps, counts } = makeExecutor({ claim: { ...CLAIM_ROW, generatedImageId: null } });
    const result = await collectImageRenderReconciliationEvidence(
      makeInput({ upstream: "completed_without_result" }),
      deps
    );
    expect(counts.image).toBe(0);
    if (result.status === "collected") {
      expect(result.evidence.generatedImage).toEqual({ kind: "absent" });
    } else {
      throw new Error("expected collected");
    }
  });

  it("exact id row yields present with all match flags true", async () => {
    const { deps } = makeExecutor({});
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.generatedImage).toEqual({
      kind: "present",
      matchesClaimGeneratedImageId: true,
      matchesUser: true,
      matchesContentPost: true,
      matchesClaimSnapshot: true,
    });
  });

  it("missing exact id row yields absent", async () => {
    const { deps } = makeExecutor({ image: null });
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.generatedImage).toEqual({ kind: "absent" });
  });

  it("query failure yields lookup_failed and the remaining reads continue", async () => {
    const { deps, counts } = makeExecutor({ image: new Error("image table down") });
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.generatedImage).toEqual({ kind: "lookup_failed" });
    expect(counts.post).toBe(1);
    expect(counts.deduction).toBe(1);
  });

  it.each([
    ["user", { ...IMAGE_ROW, userId: 99 }, { matchesUser: false }],
    ["post", { ...IMAGE_ROW, contentPostId: 55 }, { matchesContentPost: false }],
    ["url", { ...IMAGE_ROW, url: "https://cdn.example.com/other.png" }, { matchesClaimSnapshot: false }],
    ["provider", { ...IMAGE_ROW, provider: "internal" }, { matchesClaimSnapshot: false }],
    ["job", { ...IMAGE_ROW, providerJobId: "job-other" }, { matchesClaimSnapshot: false }],
    ["credits", { ...IMAGE_ROW, creditsCharged: 99 }, { matchesClaimSnapshot: false }],
  ])("generated-image %s mismatch normalizes to the correct flag", async (_label, image, flag) => {
    const { deps } = makeExecutor({ image });
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    const evidence = result.evidence.generatedImage;
    if (evidence.kind !== "present") throw new Error("expected present");
    expect(evidence).toMatchObject({ kind: "present", ...flag });
  });

  it("lookup is by exact claim id only — never by ownership predicates", async () => {
    const { deps, args } = makeExecutor({});
    await collectImageRenderReconciliationEvidence(makeInput(), deps);
    expect(args.image).toEqual([{ id: 555 }]);
  });
});

describe("collectImageRenderReconciliationEvidence — content post", () => {
  it("exact metadata ids produce matches_generated_image", async () => {
    const { deps } = makeExecutor({});
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.contentPost).toEqual({ kind: "matches_generated_image" });
  });

  it("both metadata link ids absent produce no_generated_image_link", async () => {
    const { deps } = makeExecutor({
      claim: { ...CLAIM_ROW, generatedImageId: null },
      post: { id: 13, metadata: postMetadata({ currentVersionId: null, imageCurrentVersionId: null }) },
    });
    const result = await collectImageRenderReconciliationEvidence(
      makeInput({ upstream: "completed_without_result" }),
      deps
    );
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.contentPost).toEqual({ kind: "no_generated_image_link" });
  });

  it("one link absent and one present produces mismatch", async () => {
    const { deps } = makeExecutor({
      post: { id: 13, metadata: postMetadata({ currentVersionId: null }) },
    });
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.contentPost).toEqual({ kind: "mismatch" });
  });

  it.each([
    ["currentVersionId", { currentVersionId: 556 }],
    ["imageCurrentVersionId", { imageCurrentVersionId: 556 }],
    ["imageStatus", { imageStatus: "generating" }],
    ["imageUrl", { imageUrl: "https://cdn.example.com/wrong.png" }],
    ["imageProvider", { imageProvider: "internal" }],
    ["imageJobId", { imageJobId: "job-wrong" }],
    ["imageCreditsCharged", { imageCreditsCharged: 99 }],
  ])("metadata %s mismatch produces mismatch", async (_label, metadataOverrides) => {
    const { deps } = makeExecutor({ post: { id: 13, metadata: postMetadata(metadataOverrides) } });
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.contentPost).toEqual({ kind: "mismatch" });
  });

  it("numeric-string link ids are not coerced (mismatch)", async () => {
    const { deps } = makeExecutor({
      post: { id: 13, metadata: postMetadata({ currentVersionId: "555", imageCurrentVersionId: "555" }) },
    });
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.contentPost).toEqual({ kind: "mismatch" });
  });

  it("missing post row produces mismatch", async () => {
    const { deps } = makeExecutor({ post: null });
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.contentPost).toEqual({ kind: "mismatch" });
  });

  it("post query failure produces lookup_failed and the deduction read continues", async () => {
    const { deps, counts } = makeExecutor({ post: new Error("post table down") });
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.contentPost).toEqual({ kind: "lookup_failed" });
    expect(counts.deduction).toBe(1);
  });

  it("null claim link with a usable post link produces mismatch", async () => {
    const { deps } = makeExecutor({ claim: { ...CLAIM_ROW, generatedImageId: null } });
    const result = await collectImageRenderReconciliationEvidence(
      makeInput({ upstream: "completed_without_result" }),
      deps
    );
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.contentPost).toEqual({ kind: "mismatch" });
  });
});

describe("collectImageRenderReconciliationEvidence — deduction", () => {
  it("exact deduction row yields present with exactAttemptKeyMatch true", async () => {
    const { deps } = makeExecutor({});
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.deduction).toEqual({
      kind: "present",
      exactAttemptKeyMatch: true,
      expectedCreditsMatch: true,
    });
  });

  it("no row yields absent", async () => {
    const { deps } = makeExecutor({ deduction: null });
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.deduction).toEqual({ kind: "absent" });
  });

  it("lookup failure yields lookup_failed", async () => {
    const { deps } = makeExecutor({ deduction: new Error("ledger down") });
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.deduction).toEqual({ kind: "lookup_failed" });
  });

  it.each([
    ["amount", { ...DEDUCTION_ROW, amount: -99 }],
    ["user", { ...DEDUCTION_ROW, userId: 99 }],
    ["type", { ...DEDUCTION_ROW, type: "refund" }],
    ["key", { ...DEDUCTION_ROW, idempotencyKey: "img-deduction:other" }],
  ])("wrong %s yields expectedCreditsMatch false (and fails closed on key)", async (_label, row) => {
    const { deps } = makeExecutor({ deduction: row });
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    const deduction = result.evidence.deduction;
    if (deduction.kind !== "present") throw new Error("expected present");
    expect(deduction.expectedCreditsMatch).toBe(false);
    expect(deduction.exactAttemptKeyMatch).toBe(row.idempotencyKey === IDENTITY.deductionKey);
  });

  it("null resultCreditsCharged yields expectedCreditsMatch unknown", async () => {
    const { deps } = makeExecutor({ claim: { ...CLAIM_ROW, resultCreditsCharged: null } });
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    const deduction = result.evidence.deduction;
    if (deduction.kind !== "present") throw new Error("expected present");
    expect(deduction.expectedCreditsMatch).toBe("unknown");
  });

  it("zero-credit claim with an unexpected deduction row still emits it", async () => {
    const { deps } = makeExecutor({ claim: { ...CLAIM_ROW, resultCreditsCharged: 0 } });
    const result = await collectImageRenderReconciliationEvidence(
      makeInput({ upstream: "completed_replayable" }),
      deps
    );
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.deduction.kind).toBe("present");
    expect(result.evidence.resultCreditsCharged).toBe(0);
  });
});

describe("collectImageRenderReconciliationEvidence — AI usage and security", () => {
  it("usageObservation is always not_checked and no usage read exists", async () => {
    const { deps } = makeExecutor({});
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    expect(result.evidence.usageObservation).toBe("not_checked");
    expect(Object.keys(deps).sort()).toEqual([
      "findContentPostById",
      "findDeductionByKey",
      "findExactClaim",
      "findGeneratedImageById",
    ]);
  });

  it("serialized collected results contain no identities, urls, keys, or raw errors", async () => {
    const scenarios = [
      makeExecutor({}),
      makeExecutor({ image: new Error(`ER_ACCESS_DENIED mysql://u:p@h/db ${IDENTITY.deductionKey}`) }),
      makeExecutor({ claim: new Error("claim boom") }),
    ];
    const forbidden = [
      "ownerToken",
      "claimId",
      "userId",
      "contentPostId",
      "requestAttemptKey",
      "intentFingerprint",
      "deductionKey",
      "generatedImageId",
      "imageUrl",
      "providerJobId",
      "idempotencyKey",
      "ER_ACCESS_DENIED",
      "mysql://",
    ];
    for (const { deps } of scenarios) {
      const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
      const serialized = JSON.stringify(result);
      for (const token of forbidden) {
        expect(serialized).not.toContain(token);
      }
    }
  });
});

describe("collectImageRenderReconciliationEvidence — read-only boundary", () => {
  it("source exposes no write, timer, environment, or inference capability", () => {
    for (const forbidden of [
      ".insert(",
      ".update(",
      ".delete(",
      ".transaction(",
      "deductCredits",
      "refundCredits",
      "recordAiUsage",
      "rearmFailedImageRenderClaim",
      "terminalizeStaleImageRenderClaim",
      "completeImageRenderClaimWithResult",
      "failImageRenderClaim",
      "generateImage",
      "storeImageBuffer",
      "setTimeout",
      "setInterval",
      "console.",
      "process.env",
      "orderBy",
      "desc(",
      "aiUsage",
      "ai_usage",
    ]) {
      expect(collectorSource).not.toContain(forbidden);
    }
  });

  it("importing the module performs zero database work and the default executor is lazy", async () => {
    expect(viMock.getDb).not.toHaveBeenCalled();
    const executor = createDefaultImageRenderReconciliationEvidenceExecutor();
    expect(viMock.getDb).not.toHaveBeenCalled();
    expect(Object.keys(executor).sort()).toEqual([
      "findContentPostById",
      "findDeductionByKey",
      "findExactClaim",
      "findGeneratedImageById",
    ]);
  });

  it("default claim query selects exactly the reconciliation fields and never the owner credential", async () => {
    const where = vi.fn((_cond?: unknown) => ({ limit: vi.fn(async () => [CLAIM_ROW]) }));
    const from = vi.fn((_table?: unknown) => ({ where }));
    const select = vi.fn((_fields?: unknown) => ({ from }));
    vi.mocked(getDb).mockReturnValue({ select } as never);

    const executor = createDefaultImageRenderReconciliationEvidenceExecutor();
    await executor.findExactClaim({
      claimId: 42,
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: IDENTITY.requestAttemptKey,
      intentFingerprint: IDENTITY.intentFingerprint,
      deductionKey: IDENTITY.deductionKey,
    });

    expect(from.mock.calls[0][0]).toBe(imageRenderClaims);
    const fields = select.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual([
      "completedAt",
      "generatedImageId",
      "resultCreditsCharged",
      "resultImageUrl",
      "resultIsDraft",
      "resultProvider",
      "resultProviderJobId",
      "resultQualityLabel",
      "resultQualityTier",
    ]);
    expect(Object.keys(fields)).not.toContain("ownerToken");
    const compiled = new MySqlDialect().sqlToQuery(where.mock.calls[0][0] as never);
    expect(compiled.sql).toContain("requestAttemptKey");
    expect(compiled.sql).toContain("intentFingerprint");
    expect(compiled.sql).toContain("deductionKey");
    expect(compiled.params).toEqual(
      expect.arrayContaining([
        42,
        7,
        13,
        IDENTITY.requestAttemptKey,
        IDENTITY.intentFingerprint,
        IDENTITY.deductionKey,
      ])
    );
  });

  it("default deduction probe uses the exact idempotency key evidence", async () => {
    const where = vi.fn((_cond?: unknown) => ({ limit: vi.fn(async () => [DEDUCTION_ROW]) }));
    const from = vi.fn((_table?: unknown) => ({ where }));
    const select = vi.fn((_fields?: unknown) => ({ from }));
    vi.mocked(getDb).mockReturnValue({ select } as never);

    const executor = createDefaultImageRenderReconciliationEvidenceExecutor();
    const row = await executor.findDeductionByKey({ deductionKey: IDENTITY.deductionKey });

    expect(from.mock.calls[0][0]).toBe(creditTransactions);
    expect(row?.idempotencyKey).toBe(IDENTITY.deductionKey);
    const compiled = new MySqlDialect().sqlToQuery(where.mock.calls[0][0] as never);
    expect(compiled.sql).toContain("idempotencyKey");
    expect(compiled.params).toContain(IDENTITY.deductionKey);
  });
});

describe("collectImageRenderReconciliationEvidence — C4A integration shape", () => {
  async function collectAndClassify(script: Parameters<typeof makeExecutor>[0]) {
    const { deps } = makeExecutor(script);
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    return classifyImageRenderReconciliation(result.evidence);
  }

  it("collected evidence is accepted unchanged by C4A", async () => {
    const { deps } = makeExecutor({});
    const result = await collectImageRenderReconciliationEvidence(makeInput(), deps);
    if (result.status !== "collected") throw new Error("expected collected");
    expect(() => classifyImageRenderReconciliation(result.evidence)).not.toThrow();
  });

  it("verified paid durable state yields C4A verified_committed_success", async () => {
    const classification = await collectAndClassify({});
    expect(classification).toEqual({
      classification: "verified_committed_success",
      operatorReviewRequired: false,
      mutationAuthorized: false,
    });
  });

  it("missing paid deduction yields verified_result_without_expected_deduction", async () => {
    const classification = await collectAndClassify({ deduction: null });
    expect(classification.classification).toBe("verified_result_without_expected_deduction");
  });

  it("exact deduction + absent image yields deduction_without_verified_result", async () => {
    const classification = await collectAndClassify({ image: null });
    expect(classification.classification).toBe("deduction_without_verified_result");
  });

  it("post mismatch yields content_post_linkage_mismatch", async () => {
    const classification = await collectAndClassify({
      post: { id: 13, metadata: postMetadata({ imageStatus: "failed" }) },
    });
    expect(classification.classification).toBe("content_post_linkage_mismatch");
  });

  it("generated-image mismatch yields claim_result_linkage_mismatch", async () => {
    const classification = await collectAndClassify({
      image: { ...IMAGE_ROW, creditsCharged: 99 },
    });
    expect(classification.classification).toBe("claim_result_linkage_mismatch");
  });

  it("authoritative lookup failure yields authoritative_evidence_unavailable", async () => {
    const classification = await collectAndClassify({ deduction: new Error("ledger down") });
    expect(classification.classification).toBe("authoritative_evidence_unavailable");
  });
});
