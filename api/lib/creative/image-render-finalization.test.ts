import { describe, it, expect, vi, afterEach } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  classifyFinalizationTransactionError,
  finalizeImageRenderAttempt,
  IMAGE_RENDER_FINALIZATION_MAX_ATTEMPTS,
  IMAGE_RENDER_FINALIZATION_MAX_AUTOMATIC_RETRIES,
  type ImageRenderFinalizationDeps,
  type ImageRenderFinalizationInput,
  type ImageRenderFinalizationResult,
  type ImageRenderFinalizationTxRunner,
} from "./image-render-finalization";
import {
  deriveImageRenderAttemptIdentity,
  type CompleteImageRenderClaimWithResultResult,
  type GetCompletedImageRenderResultResult,
  type ImageRenderReplayResult,
  type TransitionImageRenderClaimResult,
} from "./image-render-claim";

// ─── Deterministic injected fakes ───
//
// No database, file storage, provider, rendering, environment mutation, or
// timers. The fake transaction runner owns scripted per-attempt transaction
// behaviour; the fake primitives record every call (including the executor
// identity) and consume per-call behaviour scripts.

interface RecordedCall {
  name: "deduct" | "marker" | "usage" | "complete" | "lookupClaim" | "findDeduction" | "getCompleted" | "fail";
  args: Record<string, unknown>;
}

type DeductBehavior =
  | { kind: "ok"; newBalance?: number }
  | { kind: "already"; newBalance: number }
  | { kind: "throw"; error: Error };
type MarkerBehavior = { kind: "ok" } | { kind: "reject" } | { kind: "throw"; error: Error };
type UsageBehavior = { kind: "ok" } | { kind: "throw"; error: Error };
type CompleteBehavior = { kind: "ok" } | { kind: "reject" };
type CompletedBehavior =
  | { kind: "replayable"; result: ImageRenderReplayResult }
  | { kind: "not-replayable"; reason: "not_completed_or_not_found" }
  | { kind: "throw"; error: Error };

interface TxScript {
  insertError?: Error;
  insertId?: number | string;
  updateError?: Error;
}

interface HarnessConfig {
  deduct?: readonly DeductBehavior[];
  marker?: readonly MarkerBehavior[];
  usage?: readonly UsageBehavior[];
  complete?: readonly CompleteBehavior[];
  claimState?: { status: "running" | "completed" | "failed" } | null;
  claimStateThrows?: Error;
  deductionRow?: boolean;
  deductionRowThrows?: Error;
  completed?: CompletedBehavior;
  failThrows?: Error;
  commitError?: Error;
  txScripts?: readonly TxScript[];
}

interface Harness {
  runner: ImageRenderFinalizationTxRunner & {
    runs: { tx: FakeTx; committed: boolean }[];
  };
  deps: ImageRenderFinalizationDeps;
  calls: RecordedCall[];
  events: string[];
}

interface FakeTx {
  ops: { op: string; payload?: unknown }[];
  rolledBack: boolean;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

function take<T>(script: T[] | undefined, fallback: T): T {
  if (!script || script.length === 0) return fallback;
  return script.shift() as T;
}

function makeHarness(config: HarnessConfig = {}): Harness {
  const calls: RecordedCall[] = [];
  const events: string[] = [];
  const txScripts = [...(config.txScripts ?? [])];
  const deductScripts = config.deduct ? [...config.deduct] : undefined;
  const markerScripts = config.marker ? [...config.marker] : undefined;
  const usageScripts = config.usage ? [...config.usage] : undefined;
  const completeScripts = config.complete ? [...config.complete] : undefined;

  const record = (name: RecordedCall["name"], args: Record<string, unknown>) => {
    calls.push({ name, args });
    events.push(name);
  };

  function makeFakeTx(script: TxScript): FakeTx {
    const tx: FakeTx = {
      ops: [],
      rolledBack: false,
      insert: vi.fn((_table: unknown) => ({
        values: async (values: Record<string, unknown>) => {
          tx.ops.push({ op: "insert-image", payload: values });
          events.push("insert-image");
          if (script.insertError) throw script.insertError;
          return [{ insertId: script.insertId ?? 4242 }];
        },
      })),
      update: vi.fn((_table: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: async (_cond: unknown) => {
            tx.ops.push({ op: "update-post", payload: patch });
            events.push("update-post");
            if (script.updateError) throw script.updateError;
            return [{ affectedRows: 1 }];
          },
        }),
      })),
      select: vi.fn(),
      execute: vi.fn(),
    };
    return tx;
  }

  const runner = {
    runs: [] as { tx: FakeTx; committed: boolean }[],
    run: vi.fn(async (fn: (tx: FakeTx) => Promise<unknown>) => {
      const tx = makeFakeTx(txScripts.length > 0 ? (txScripts.shift() as TxScript) : {});
      runner.runs.push({ tx, committed: false });
      events.push("tx-run");
      try {
        const result = await fn(tx);
        if (config.commitError) throw config.commitError;
        runner.runs[runner.runs.length - 1].committed = true;
        events.push("tx-commit");
        return result;
      } catch (err) {
        tx.rolledBack = true;
        events.push("tx-rollback");
        throw err;
      }
    }),
  };

  const deps: ImageRenderFinalizationDeps = {
    txRunner: runner as unknown as ImageRenderFinalizationTxRunner,
    deductCredits: vi.fn(async (args) => {
      record("deduct", args);
      const behavior = take(deductScripts, { kind: "ok", newBalance: 77 } as DeductBehavior);
      if (behavior.kind === "throw") throw behavior.error;
      return { newBalance: behavior.newBalance ?? 77, alreadyDeducted: behavior.kind === "already" ? true : undefined };
    }),
    markImageRenderDeductionRecorded: vi.fn(async (args) => {
      record("marker", args);
      const behavior = take(markerScripts, { kind: "ok" } as MarkerBehavior);
      if (behavior.kind === "throw") throw behavior.error;
      return behavior.kind === "reject"
        ? { recorded: false, reason: "not_found_or_unauthorized" as const }
        : { recorded: true };
    }),
    recordAiUsage: vi.fn(async (args) => {
      record("usage", args);
      const behavior = take(usageScripts, { kind: "ok" } as UsageBehavior);
      if (behavior.kind === "throw") throw behavior.error;
    }),
    completeImageRenderClaimWithResult: vi.fn(
      async (args): Promise<CompleteImageRenderClaimWithResultResult> => {
        record("complete", args);
        const behavior = take(completeScripts, { kind: "ok" } as CompleteBehavior);
        return behavior.kind === "reject"
          ? { completed: false, reason: "identity_mismatch" as const }
          : { completed: true, claim: {} as never };
      }
    ),
    lookupClaimState: vi.fn(async (args) => {
      record("lookupClaim", args);
      if (config.claimStateThrows) throw config.claimStateThrows;
      return config.claimState ?? { status: "running" as const };
    }),
    findDeductionRow: vi.fn(async (args) => {
      record("findDeduction", args);
      if (config.deductionRowThrows) throw config.deductionRowThrows;
      return config.deductionRow ?? false;
    }),
    getCompletedImageRenderResult: vi.fn(
      async (args): Promise<GetCompletedImageRenderResultResult> => {
        record("getCompleted", args);
        const behavior = config.completed ?? { kind: "not-replayable", reason: "not_completed_or_not_found" as const };
        if (behavior.kind === "throw") throw behavior.error;
        if (behavior.kind === "replayable") {
          return { replayable: true, result: behavior.result };
        }
        return { replayable: false, reason: behavior.reason };
      }
    ),
    failImageRenderClaim: vi.fn(
      async (args): Promise<TransitionImageRenderClaimResult> => {
        record("fail", args);
        if (config.failThrows) throw config.failThrows;
        return { transitioned: true, claim: {} as never };
      }
    ),
  };

  return {
    runner: runner as unknown as ImageRenderFinalizationTxRunner & {
      runs: { tx: FakeTx; committed: boolean }[];
    },
    deps,
    calls,
    events,
  };
}

// ─── Fixtures ───

const SECRETS = {
  ownerToken: "owner-token-finalization",
  errorText: "ER_ACCESS_DENIED mysql://u:p@db.internal/natforge_prod SELECT * FROM t",
};

function makeIdentity(overrides: Record<string, unknown> = {}) {
  const identity = deriveImageRenderAttemptIdentity({
    userId: 7,
    contentPostId: 13,
    attempt: { clientAttemptId: "attempt-token-1" },
  });
  return {
    claimId: 42,
    userId: 7,
    contentPostId: 13,
    ownerToken: SECRETS.ownerToken,
    requestAttemptKey: identity.requestAttemptKey,
    intentFingerprint: identity.intentFingerprint,
    deductionKey: identity.deductionKey,
    ...overrides,
  };
}

const STORED_RESULT: ImageRenderReplayResult = {
  generatedImageId: 4242,
  imageUrl: "/generated/images/5/img_x.png",
  provider: "premium-v2-hybrid",
  providerJobId: null,
  creditsCharged: 12,
  qualityTier: "premium",
  qualityLabel: "Premium Marketing Leaflet",
  isDraft: false,
  completedAt: new Date("2026-06-01T00:00:00.000Z"),
};

function makeInput(overrides: Record<string, unknown> = {}): ImageRenderFinalizationInput {
  return {
    claim: makeIdentity(),
    charge: {
      amount: 12,
      description: "Premium Marketing Leaflet (premium-v2-hybrid)",
      metadata: { source: "premium" },
    },
    usage: {
      campaignId: 5,
      agentType: "image_generation",
      model: "premium-v2-template",
      promptTokens: 500,
      completionTokens: 100,
      actualCostUsdMicro: 0,
      estimatedCostUsdMicro: 0,
      metadata: { source: "premium" },
    },
    result: {
      provider: "premium-v2-hybrid",
      providerJobId: "job-9",
      imageUrl: "/generated/images/5/img_x.png",
      qualityTier: "premium",
      qualityLabel: "Premium Marketing Leaflet",
      isDraft: false,
      completedAt: new Date("2026-06-01T00:00:00.000Z"),
    },
    generatedImage: {
      campaignId: 5,
      businessId: 6,
      provider: "premium-v2-hybrid",
      providerJobId: "job-9",
      prompt: "Spring promo headline",
      url: "/generated/images/5/img_x.png",
      aspectRatio: "1:1",
      style: null,
      providerCostUsd: 0,
      metadata: { assetTier: "premium" },
    },
    buildContentPostPatch: ({ generatedImageId, creditsCharged }) => ({
      currentVersionId: generatedImageId,
      imageCurrentVersionId: generatedImageId,
      imageCreditsCharged: creditsCharged,
    }),
    ...overrides,
  } as ImageRenderFinalizationInput;
}

function countCalls(calls: RecordedCall[], name: RecordedCall["name"]) {
  return calls.filter((call) => call.name === name).length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finalizeImageRenderAttempt — positive-credit success", () => {
  it("uses exactly one caller-owned transaction, commits, and captures the exact insertId", async () => {
    const { runner, deps, calls } = makeHarness();
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({
      status: "finalized",
      generatedImageId: 4242,
      creditsCharged: 12,
      newBalance: 77,
    });
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0].committed).toBe(true);
    expect(runner.runs[0].tx.rolledBack).toBe(false);

    const insert = runner.runs[0].tx.ops[0];
    expect(insert.op).toBe("insert-image");
    const completion = calls.find((call) => call.name === "complete");
    expect((completion?.args.result as Record<string, unknown>).generatedImageId).toBe(4242);
    // The coordinator wraps the caller-built payload under the physical
    // metadata column; it is never spread as top-level update fields.
    expect(runner.runs[0].tx.ops[1]).toEqual({
      op: "update-post",
      payload: {
        metadata: {
          currentVersionId: 4242,
          imageCurrentVersionId: 4242,
          imageCreditsCharged: 12,
        },
      },
    });
  });

  it("persists the caller-built payload under the physical metadata column with no top-level image keys", async () => {
    const callbackArgs: Array<{ generatedImageId: number; creditsCharged: number }> = [];
    const callbackResults: Record<string, unknown>[] = [];
    const input = makeInput();
    const recordingInput: ImageRenderFinalizationInput = {
      ...input,
      buildContentPostPatch: (args) => {
        callbackArgs.push(args);
        const result = input.buildContentPostPatch(args);
        callbackResults.push(result);
        return result;
      },
    };

    const { runner, deps } = makeHarness();
    const result = await finalizeImageRenderAttempt(recordingInput, deps);

    expect(result.status).toBe("finalized");
    // Exactly one content-post update.
    const postUpdates = runner.runs[0].tx.ops.filter((op) => op.op === "update-post");
    expect(postUpdates).toHaveLength(1);
    const updateValue = postUpdates[0].payload as Record<string, unknown>;
    // Exact physical outer shape: { metadata: <callback result> }.
    expect(Object.keys(updateValue).sort()).toEqual(["metadata"]);
    expect(updateValue.metadata).toEqual(callbackResults[0]);
    expect(typeof updateValue.metadata).toBe("object");
    // The callback saw the exact insertId and the finalization charge.
    expect(callbackArgs).toEqual([{ generatedImageId: 4242, creditsCharged: 12 }]);
    // None of the metadata fields appear as top-level update keys.
    for (const forbidden of [
      "currentVersionId",
      "imageCurrentVersionId",
      "imageUrl",
      "imageProvider",
      "imageJobId",
      "imageStatus",
      "imageCreditsCharged",
    ]) {
      expect(updateValue, forbidden).not.toHaveProperty(forbidden);
    }
  });

  it("zero-credit path uses the same physical metadata wrapper", async () => {
    const input = makeInput();
    const zeroCredit: ImageRenderFinalizationInput = {
      ...input,
      charge: { ...input.charge, amount: 0 },
    };
    const { runner, deps } = makeHarness();
    const result = await finalizeImageRenderAttempt(zeroCredit, deps);

    expect(result).toMatchObject({ status: "finalized", creditsCharged: 0 });
    const postUpdates = runner.runs[0].tx.ops.filter((op) => op.op === "update-post");
    expect(postUpdates).toHaveLength(1);
    const updateValue = postUpdates[0].payload as Record<string, unknown>;
    expect(Object.keys(updateValue).sort()).toEqual(["metadata"]);
    expect((updateValue.metadata as Record<string, unknown>).imageCreditsCharged).toBe(0);
  });

  it("a content-post update failure rolls back with the existing failure semantics", async () => {
    const { runner, deps, calls } = makeHarness({
      txScripts: [{ updateError: new Error("post boom") }],
    });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({ status: "failed", reason: "content_post_update_failed" });
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0].committed).toBe(false);
    expect(runner.runs[0].tx.rolledBack).toBe(true);
    expect(countCalls(calls, "deduct")).toBe(0);
    expect(countCalls(calls, "usage")).toBe(0);
    expect(countCalls(calls, "complete")).toBe(0);
  });

  it("runs the exact required order and passes the same transaction executor to every primitive", async () => {
    const { runner, deps, events, calls } = makeHarness();
    await finalizeImageRenderAttempt(makeInput(), deps);

    expect(events).toEqual([
      "tx-run",
      "insert-image",
      "update-post",
      "deduct",
      "marker",
      "usage",
      "complete",
      "tx-commit",
    ]);
    const tx = runner.runs[0].tx;
    for (const name of ["deduct", "marker", "usage", "complete"] as const) {
      const call = calls.find((entry) => entry.name === name);
      expect(call?.args.executor, name).toBe(tx);
    }
    const deduct = calls.find((call) => call.name === "deduct");
    expect(deduct?.args.idempotencyKey).toBe(makeIdentity().deductionKey);
    expect(deduct?.args.amount).toBe(12);
    expect(tx.select).not.toHaveBeenCalled();
  });

  it("honours a non-default driver insertId end to end", async () => {
    const { runner, deps, calls } = makeHarness({ txScripts: [{ insertId: 98765 }] });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toMatchObject({ status: "finalized", generatedImageId: 98765 });
    const completion = calls.find((call) => call.name === "complete");
    expect((completion?.args.result as Record<string, unknown>).generatedImageId).toBe(98765);
    expect(runner.runs[0].tx.ops[1].payload).toMatchObject({
      metadata: { currentVersionId: 98765 },
    });
  });
});

describe("finalizeImageRenderAttempt — zero-credit success", () => {
  function zeroCreditInput(): ImageRenderFinalizationInput {
    const input = makeInput();
    return { ...input, charge: { ...input.charge, amount: 0 } };
  }

  it("skips deduction and marker, still writes usage with zero credits and completes the claim", async () => {
    const { runner, deps, calls, events } = makeHarness();
    const result = await finalizeImageRenderAttempt(zeroCreditInput(), deps);

    expect(result).toEqual({
      status: "finalized",
      generatedImageId: 4242,
      creditsCharged: 0,
      newBalance: null,
    });
    expect(runner.runs[0].committed).toBe(true);
    expect(countCalls(calls, "deduct")).toBe(0);
    expect(countCalls(calls, "marker")).toBe(0);
    expect(events).toEqual([
      "tx-run",
      "insert-image",
      "update-post",
      "usage",
      "complete",
      "tx-commit",
    ]);
    const usage = calls.find((call) => call.name === "usage");
    expect(usage?.args.creditsDeducted).toBe(0);
    const completion = calls.find((call) => call.name === "complete");
    expect((completion?.args.result as Record<string, unknown>).creditsCharged).toBe(0);
  });
});

describe("finalizeImageRenderAttempt — definite rollback handling", () => {
  it.each([
    [
      "generated_images insert failure",
      { txScripts: [{ insertError: new Error("insert boom") }] },
      "generated_image_insert_failed",
    ],
    [
      "content_posts update failure",
      { txScripts: [{ updateError: new Error("update boom") }] },
      "content_post_update_failed",
    ],
    [
      "insufficient credits",
      { deduct: [{ kind: "throw", error: new TRPCError({ code: "PAYMENT_REQUIRED", message: "Insufficient credits" }) }] },
      "insufficient_credits",
    ],
    [
      "deduction marker rejection",
      { marker: [{ kind: "reject" }] },
      "deduction_marker_rejected",
    ],
    [
      "AI-usage insert failure",
      { usage: [{ kind: "throw", error: new Error("usage boom") }] },
      "ai_usage_record_failed",
    ],
    [
      "claim completion rejection",
      { complete: [{ kind: "reject" }] },
      "claim_completion_rejected",
    ],
  ] as const)(
    "%s rolls back everything, retries zero times, and fails the claim outside the transaction",
    async (_label, config, reason) => {
      const { runner, deps, calls, events } = makeHarness(config);
      const input = makeInput();
      const result = await finalizeImageRenderAttempt(input, deps);

      expect(result).toEqual({ status: "failed", reason });
      expect(runner.runs).toHaveLength(1);
      expect(runner.runs[0].committed).toBe(false);
      expect(runner.runs[0].tx.rolledBack).toBe(true);
      // Fail transition attempted exactly once, outside the transaction.
      expect(countCalls(calls, "fail")).toBe(1);
      const fail = calls.find((call) => call.name === "fail");
      expect(fail?.args).toEqual({ claimId: 42, ownerToken: SECRETS.ownerToken });
      expect(events.indexOf("fail")).toBeGreaterThan(events.indexOf("tx-rollback"));
      // No read-only resolution ran for a definite rollback.
      expect(countCalls(calls, "lookupClaim")).toBe(0);
    }
  );

  it("treats a non-numeric insertId as a failed insert with no retry", async () => {
    const { runner, deps, calls } = makeHarness({ txScripts: [{ insertId: "not-a-number" }] });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({ status: "failed", reason: "invalid_generated_image_id" });
    expect(runner.runs).toHaveLength(1);
    expect(countCalls(calls, "fail")).toBe(1);
  });

  it("performs no additional mutation when the fail transition itself fails", async () => {
    const { runner, deps, calls } = makeHarness({
      txScripts: [{ updateError: new Error("update boom") }],
      failThrows: new Error("fail transition down"),
    });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({ status: "failed", reason: "fail_transition_failed" });
    expect(runner.runs).toHaveLength(1);
    expect(countCalls(calls, "fail")).toBe(1);
    expect(countCalls(calls, "deduct")).toBe(0);
    expect(countCalls(calls, "lookupClaim")).toBe(0);
  });
});

describe("finalizeImageRenderAttempt — bounded deadlock/lock-timeout retry", () => {
  const deadlock = new Error("deadlock") as Error & { code: string };
  deadlock.code = "ER_LOCK_DEADLOCK";
  const lockTimeout = new Error("lock wait") as Error & { errno: number };
  lockTimeout.errno = 1205;

  it.each([
    ["deadlock code", deadlock],
    ["lock-wait timeout errno", lockTimeout],
  ] as const)(
    "retries the transaction exactly once for %s and then succeeds",
    async (_label, error) => {
      const { runner, deps, calls } = makeHarness({
        deduct: [{ kind: "throw", error }, { kind: "ok", newBalance: 66 }],
      });
      const result = await finalizeImageRenderAttempt(makeInput(), deps);

      expect(result).toEqual({
        status: "finalized",
        generatedImageId: 4242,
        creditsCharged: 12,
        newBalance: 66,
      });
      expect(runner.runs).toHaveLength(2);
      expect(runner.runs[0].committed).toBe(false);
      expect(runner.runs[0].tx.rolledBack).toBe(true);
      expect(runner.runs[1].committed).toBe(true);
      expect(runner.runs[1].tx).not.toBe(runner.runs[0].tx);
      expect(countCalls(calls, "deduct")).toBe(2);
      expect(countCalls(calls, "fail")).toBe(0);
    }
  );

  it("stops after the second attempt when the retryable error repeats", async () => {
    const { runner, deps, calls } = makeHarness({
      deduct: [
        { kind: "throw", error: deadlock },
        { kind: "throw", error: lockTimeout },
      ],
    });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({ status: "failed", reason: "transaction_rolled_back" });
    expect(runner.runs).toHaveLength(IMAGE_RENDER_FINALIZATION_MAX_ATTEMPTS);
    expect(countCalls(calls, "deduct")).toBe(2);
    expect(countCalls(calls, "fail")).toBe(1);
  });

  it("never retries non-deadlock failures", async () => {
    const { runner, deps, calls } = makeHarness({
      deduct: [{ kind: "throw", error: new Error("ordinary failure") }],
    });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({ status: "failed", reason: "transaction_rolled_back" });
    expect(runner.runs).toHaveLength(1);
    expect(countCalls(calls, "deduct")).toBe(1);
  });

  it("declares a constant retry budget of exactly one automatic retry", () => {
    expect(IMAGE_RENDER_FINALIZATION_MAX_ATTEMPTS).toBe(2);
    expect(IMAGE_RENDER_FINALIZATION_MAX_AUTOMATIC_RETRIES).toBe(1);
  });
});

describe("finalizeImageRenderAttempt — alreadyDeducted duplicate resolution", () => {
  it("aborts the transaction and writes no marker/usage/completion", async () => {
    const { runner, deps, calls } = makeHarness({
      deduct: [{ kind: "already", newBalance: 88 }],
      completed: { kind: "not-replayable", reason: "not_completed_or_not_found" },
    });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({ status: "blocked", reason: "ambiguous_deduction_blocked" });
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0].committed).toBe(false);
    expect(runner.runs[0].tx.rolledBack).toBe(true);
    expect(countCalls(calls, "marker")).toBe(0);
    expect(countCalls(calls, "usage")).toBe(0);
    expect(countCalls(calls, "complete")).toBe(0);
    expect(countCalls(calls, "fail")).toBe(0);
    expect(countCalls(calls, "getCompleted")).toBe(1);
  });

  it("returns a verified replay when the exact completed result exists", async () => {
    const { deps, calls } = makeHarness({
      deduct: [{ kind: "already", newBalance: 88 }],
      completed: { kind: "replayable", result: STORED_RESULT },
    });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({
      status: "replay",
      response: {
        success: true,
        imageUrl: STORED_RESULT.imageUrl,
        provider: STORED_RESULT.provider,
        jobId: "premium",
        creditsCharged: 12,
        qualityTier: "premium",
        qualityLabel: "Premium Marketing Leaflet",
        isDraft: false,
      },
    });
    const lookup = calls.find((call) => call.name === "getCompleted");
    expect(lookup?.args).toEqual({
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: makeIdentity().requestAttemptKey,
      intentFingerprint: makeIdentity().intentFingerprint,
    });
  });

  it("fails closed to ambiguous when the completed-result lookup itself fails", async () => {
    const { deps, calls } = makeHarness({
      deduct: [{ kind: "already", newBalance: 88 }],
      completed: { kind: "throw", error: new Error("lookup down") },
    });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({ status: "blocked", reason: "ambiguous_deduction_blocked" });
    expect(countCalls(calls, "fail")).toBe(0);
  });
});

describe("finalizeImageRenderAttempt — unknown commit outcome", () => {
  const commitLost = new Error("connection lost") as Error & { code: string };
  commitLost.code = "PROTOCOL_CONNECTION_LOST";

  function unknownOutcomeHarness(extra: Partial<HarnessConfig> = {}) {
    return makeHarness({ commitError: commitLost, ...extra });
  }

  it("performs only bounded read-only resolution with no additional mutation or retry", async () => {
    const { runner, deps, calls, events } = unknownOutcomeHarness({
      claimState: { status: "running" },
      deductionRow: true,
    });
    await finalizeImageRenderAttempt(makeInput(), deps);

    // The single uncertain transaction ran exactly once — never retried.
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0].committed).toBe(false);
    // The in-transaction work happened exactly once (that is why the outcome
    // is unknown); nothing mutated again afterwards.
    expect(countCalls(calls, "deduct")).toBe(1);
    expect(countCalls(calls, "marker")).toBe(1);
    expect(countCalls(calls, "usage")).toBe(1);
    expect(countCalls(calls, "complete")).toBe(1);
    expect(countCalls(calls, "lookupClaim")).toBe(1);
    expect(countCalls(calls, "findDeduction")).toBe(1);
    expect(countCalls(calls, "fail")).toBe(0);
    // Every event after the rollback is read-only resolution.
    const afterRollback = events.slice(events.indexOf("tx-rollback") + 1);
    expect(afterRollback.every((name) => name === "lookupClaim" || name === "findDeduction")).toBe(true);
  });

  it("completed + valid linked result returns replay", async () => {
    const { deps } = unknownOutcomeHarness({
      claimState: { status: "completed" },
      deductionRow: true,
      completed: { kind: "replayable", result: STORED_RESULT },
    });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result.status).toBe("replay");
    expect(result).toMatchObject({ status: "replay", response: { creditsCharged: 12 } });
  });

  it("completed + missing/invalid linked result blocks as an integrity fault", async () => {
    const { deps } = unknownOutcomeHarness({
      claimState: { status: "completed" },
      completed: { kind: "not-replayable", reason: "not_completed_or_not_found" },
    });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({ status: "blocked", reason: "integrity_blocked" });
  });

  it("running + deduction row present blocks ambiguous for Slice C", async () => {
    const { deps, calls } = unknownOutcomeHarness({
      claimState: { status: "running" },
      deductionRow: true,
    });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({ status: "blocked", reason: "ambiguous_deduction_blocked" });
    expect(countCalls(calls, "fail")).toBe(0);
  });

  it("running + no deduction row follows safe rollback/failure handling", async () => {
    const { deps, calls } = unknownOutcomeHarness({
      claimState: { status: "running" },
      deductionRow: false,
    });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({ status: "failed", reason: "transaction_rolled_back" });
    expect(countCalls(calls, "fail")).toBe(1);
  });

  it("failed + deduction row present blocks as inconsistent", async () => {
    const { deps } = unknownOutcomeHarness({
      claimState: { status: "failed" },
      deductionRow: true,
    });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({ status: "blocked", reason: "ambiguous_deduction_blocked" });
  });

  it("failed + no deduction row reports the normal rearmable failed state", async () => {
    const { deps, calls } = unknownOutcomeHarness({
      claimState: { status: "failed" },
      deductionRow: false,
    });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({ status: "failed", reason: "already_failed_rearmable" });
    expect(countCalls(calls, "fail")).toBe(0);
  });

  it("read-only resolution failure fails closed without additional mutation or retry", async () => {
    const { runner, deps, calls } = unknownOutcomeHarness({
      claimStateThrows: new Error("resolution down"),
    });
    const result = await finalizeImageRenderAttempt(makeInput(), deps);

    expect(result).toEqual({ status: "blocked", reason: "integrity_blocked" });
    expect(runner.runs).toHaveLength(1);
    expect(countCalls(calls, "findDeduction")).toBe(0);
    expect(countCalls(calls, "fail")).toBe(0);
    // The single in-transaction deduction is the uncertain one; none was added.
    expect(countCalls(calls, "deduct")).toBe(1);
  });
});

describe("finalizeImageRenderAttempt — input validation before any dependency call", () => {
  it.each([
    ["mismatched deductionKey derivation", (input: ImageRenderFinalizationInput) => ({
      ...input,
      claim: { ...input.claim, deductionKey: "img-deduction:" + "f".repeat(64) },
    })],
    ["invalid userId", (input: ImageRenderFinalizationInput) => ({
      ...input,
      claim: { ...input.claim, userId: 0 },
    })],
    ["invalid requestAttemptKey", (input: ImageRenderFinalizationInput) => ({
      ...input,
      claim: { ...input.claim, requestAttemptKey: "bad" },
    })],
    ["negative charge", (input: ImageRenderFinalizationInput) => ({
      ...input,
      charge: { ...input.charge, amount: -1 },
    })],
    ["invalid completedAt", (input: ImageRenderFinalizationInput) => ({
      ...input,
      result: { ...input.result, completedAt: new Date(Number.NaN) },
    })],
    ["invalid usage tokens", (input: ImageRenderFinalizationInput) => ({
      ...input,
      usage: { ...input.usage, promptTokens: -5 },
    })],
  ])("rejects %s before touching any dependency", async (_label, mutate) => {
    const { runner, deps, calls } = makeHarness();
    await expect(finalizeImageRenderAttempt(mutate(makeInput()), deps)).rejects.toThrow();

    expect(runner.runs).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("finalizeImageRenderAttempt — security and shape", () => {
  it("serializes every result variant without internal credentials or raw errors", async () => {
    const identity = makeIdentity();
    const variants: ImageRenderFinalizationResult[] = [
      { status: "finalized", generatedImageId: 1, creditsCharged: 12, newBalance: 77 },
      { status: "replay", response: {
        success: true, imageUrl: "u", provider: "p", jobId: "premium",
        creditsCharged: 12, qualityTier: "t", qualityLabel: "l", isDraft: false,
      } },
      { status: "failed", reason: "insufficient_credits" },
      { status: "blocked", reason: "ambiguous_deduction_blocked" },
      { status: "blocked", reason: "integrity_blocked" },
    ];
    const forbidden = [
      identity.ownerToken,
      identity.requestAttemptKey,
      identity.intentFingerprint,
      identity.deductionKey,
      SECRETS.errorText,
      "ownerToken",
      "requestAttemptKey",
      "intentFingerprint",
      "deductionKey",
      "activeClaimKey",
      "ER_ACCESS_DENIED",
    ];
    for (const variant of variants) {
      const serialized = JSON.stringify(variant);
      for (const secret of forbidden) {
        expect(serialized, `${variant.status}:${secret}`).not.toContain(secret);
      }
    }
  });

  it("dependency surface contains no provider/render/storage members to retry", async () => {
    const { deps } = makeHarness();
    const keys = Object.keys(deps).sort();
    expect(keys).toEqual([
      "completeImageRenderClaimWithResult",
      "deductCredits",
      "failImageRenderClaim",
      "findDeductionRow",
      "getCompletedImageRenderResult",
      "lookupClaimState",
      "markImageRenderDeductionRecorded",
      "recordAiUsage",
      "txRunner",
    ]);
  });
});

describe("classifyFinalizationTransactionError", () => {
  it.each([
    ["ER_LOCK_DEADLOCK code", { code: "ER_LOCK_DEADLOCK" }, "retryable"],
    ["errno 1213", { errno: 1213 }, "retryable"],
    ["ER_LOCK_WAIT_TIMEOUT code", { code: "ER_LOCK_WAIT_TIMEOUT" }, "retryable"],
    ["errno 1205", { errno: 1205 }, "retryable"],
    ["wrapped deadlock cause", { message: "x", cause: { errno: 1213 } }, "retryable"],
    ["PROTOCOL_CONNECTION_LOST", { code: "PROTOCOL_CONNECTION_LOST" }, "unknown_commit"],
    ["ECONNRESET", { code: "ECONNRESET" }, "unknown_commit"],
    ["wrapped connection loss", { cause: { code: "PROTOCOL_CONNECTION_LOST" } }, "unknown_commit"],
    ["ordinary error", { message: "boom" }, "definite"],
    ["TRPCError payment required", "TRPCError:PAYMENT_REQUIRED", "definite"],
    ["cyclic cause chain", "cyclic", "definite"],
  ] as const)("classifies %s as %s", (_label, fixture, expected) => {
    let err: unknown;
    if (fixture === "TRPCError:PAYMENT_REQUIRED") {
      err = new TRPCError({ code: "PAYMENT_REQUIRED", message: "insufficient" });
    } else if (fixture === "cyclic") {
      const a: Record<string, unknown> = { code: "X" };
      const b: Record<string, unknown> = { cause: a };
      a.cause = b;
      err = b;
    } else {
      err = fixture;
    }
    expect(classifyFinalizationTransactionError(err)).toBe(expected);
  });
});
