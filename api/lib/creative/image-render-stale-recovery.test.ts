import { describe, it, expect, vi, afterEach } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  createDefaultImageRenderStaleRecoveryDeps,
  recoverStaleImageRenderClaim,
  type ImageRenderStaleRecoveryDeps,
  type ImageRenderStaleRecoveryInput,
} from "./image-render-stale-recovery";
import { deriveImageRenderAttemptIdentity } from "./image-render-claim";

// ─── Deterministic dormant recovery coordinator tests ───
//
// Pure injected fakes only: no database, provider, renderer, storage, timers,
// or environment mutation. The default-dependency probe is exercised through
// a mocked connection module.

const viMock = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../../queries/connection", () => ({ getDb: viMock.getDb }));

import { getDb } from "../../queries/connection";
import { creditTransactions } from "@db/schema";

function makeInput(
  overrides: Partial<ImageRenderStaleRecoveryInput> = {}
): ImageRenderStaleRecoveryInput {
  const identity = deriveImageRenderAttemptIdentity({
    userId: 7,
    contentPostId: 13,
    attempt: { clientAttemptId: "attempt-token-1" },
  });
  return {
    claimId: 1,
    userId: 7,
    contentPostId: 13,
    requestAttemptKey: identity.requestAttemptKey,
    intentFingerprint: identity.intentFingerprint,
    deductionKey: identity.deductionKey,
    ...overrides,
  };
}

function makeDeps(config: {
  deductionPresent?: boolean;
  lookupThrows?: Error;
  terminalized?: boolean;
  terminalizeThrows?: Error;
}): {
  deps: ImageRenderStaleRecoveryDeps;
  counts: { lookup: number; terminalize: number };
  terminalizeArgs: ImageRenderStaleRecoveryInput[];
} {
  const counts = { lookup: 0, terminalize: 0 };
  const terminalizeArgs: ImageRenderStaleRecoveryInput[] = [];
  return {
    counts,
    terminalizeArgs,
    deps: {
      findDeductionRow: vi.fn(async () => {
        counts.lookup += 1;
        if (config.lookupThrows) throw config.lookupThrows;
        return config.deductionPresent ?? false;
      }),
      terminalizeStaleClaim: vi.fn(async (args: ImageRenderStaleRecoveryInput) => {
        counts.terminalize += 1;
        terminalizeArgs.push(args);
        if (config.terminalizeThrows) throw config.terminalizeThrows;
        return { terminalized: config.terminalized ?? true };
      }),
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("recoverStaleImageRenderClaim", () => {
  it("terminalizes exactly once when no deduction row exists and reports terminalized", async () => {
    const input = makeInput();
    const { deps, counts, terminalizeArgs } = makeDeps({ terminalized: true });

    const result = await recoverStaleImageRenderClaim(input, deps);

    expect(result).toEqual({ status: "terminalized" });
    expect(counts.lookup).toBe(1);
    expect(counts.terminalize).toBe(1);
    expect(terminalizeArgs).toEqual([input]);
  });

  it("blocks with zero claim mutation when a deduction row exists", async () => {
    const { deps, counts } = makeDeps({ deductionPresent: true });

    const result = await recoverStaleImageRenderClaim(makeInput(), deps);

    expect(result).toEqual({
      status: "blocked",
      reason: "deduction_evidence_present",
    });
    expect(counts.lookup).toBe(1);
    expect(counts.terminalize).toBe(0);
  });

  it("blocks with zero claim mutation when the deduction lookup throws", async () => {
    const { deps, counts } = makeDeps({ lookupThrows: new Error("db down") });

    const result = await recoverStaleImageRenderClaim(makeInput(), deps);

    expect(result).toEqual({
      status: "blocked",
      reason: "deduction_lookup_failed",
    });
    expect(counts.terminalize).toBe(0);
  });

  it("blocks without retry when the primitive returns false (heartbeat-renewal race)", async () => {
    const { deps, counts } = makeDeps({ terminalized: false });

    const result = await recoverStaleImageRenderClaim(makeInput(), deps);

    expect(result).toEqual({
      status: "blocked",
      reason: "state_changed_or_not_recoverable",
    });
    expect(counts.terminalize).toBe(1);
    expect(counts.lookup).toBe(1);
  });

  it("blocks without retry when the primitive throws (finalization-won race)", async () => {
    const { deps, counts } = makeDeps({ terminalizeThrows: new Error(" raced") });

    const result = await recoverStaleImageRenderClaim(makeInput(), deps);

    expect(result).toEqual({
      status: "blocked",
      reason: "state_changed_or_not_recoverable",
    });
    expect(counts.terminalize).toBe(1);
    expect(counts.lookup).toBe(1);
  });

  it.each([
    ["claimId", { claimId: 0 }],
    ["userId", { userId: -1 }],
    ["contentPostId", { contentPostId: 1.5 }],
    ["requestAttemptKey", { requestAttemptKey: "bad" }],
    ["intentFingerprint", { intentFingerprint: "BAD" }],
    ["deductionKey", { deductionKey: "x".repeat(192) }],
  ])("rejects invalid %s before any dependency call", async (_label, overrides) => {
    const { deps, counts } = makeDeps({});

    await expect(
      recoverStaleImageRenderClaim(makeInput(overrides), deps)
    ).rejects.toThrow();

    expect(counts.lookup).toBe(0);
    expect(counts.terminalize).toBe(0);
  });

  it("rejects a deductionKey that does not derive from the attempt key", async () => {
    const { deps, counts } = makeDeps({});

    await expect(
      recoverStaleImageRenderClaim(
        makeInput({ deductionKey: `img-deduction:${"f".repeat(64)}` }),
        deps
      )
    ).rejects.toThrow(/does not match the derived attempt identity/);

    expect(counts.lookup).toBe(0);
    expect(counts.terminalize).toBe(0);
  });

  it("exposes no recovery dependencies beyond lookup and conditional terminalization", () => {
    const deps = createDefaultImageRenderStaleRecoveryDeps();
    expect(Object.keys(deps).sort()).toEqual([
      "findDeductionRow",
      "terminalizeStaleClaim",
    ]);
    for (const key of Object.keys(deps)) {
      expect(typeof (deps as unknown as Record<string, unknown>)[key]).toBe("function");
    }
  });

  it("serialized results contain no internal credentials", async () => {
    const input = makeInput();
    const scenarios = [
      makeDeps({ terminalized: true }),
      makeDeps({ terminalized: false }),
      makeDeps({ deductionPresent: true }),
      makeDeps({ lookupThrows: new Error("boom") }),
    ];
    for (const { deps } of scenarios) {
      const result = await recoverStaleImageRenderClaim(input, deps);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(input.requestAttemptKey);
      expect(serialized).not.toContain(input.intentFingerprint);
      expect(serialized).not.toContain(input.deductionKey);
      expect(serialized).not.toContain("owner");
      expect(serialized).not.toContain("boom");
    }
  });
});

describe("createDefaultImageRenderStaleRecoveryDeps — deduction probe", () => {
  function mockDeductionSelect(rows: unknown[]) {
    const limit = vi.fn(async () => rows);
    const where = vi.fn((_cond?: unknown) => ({ limit }));
    const from = vi.fn((_table?: unknown) => ({ where }));
    const select = vi.fn((_fields?: unknown) => ({ from }));
    viMockedGetDb().mockReturnValue({ select } as never);
    return { select, from, where, limit };
  }

  function viMockedGetDb() {
    return vi.mocked(getDb);
  }

  it("uses the established credit_transactions idempotencyKey evidence and returns true when present", async () => {
    const db = mockDeductionSelect([{ id: 901 }]);
    const deps = createDefaultImageRenderStaleRecoveryDeps();

    const present = await deps.findDeductionRow({ deductionKey: "img-deduction:abc" });

    expect(present).toBe(true);
    expect(db.select).toHaveBeenCalledTimes(1);
    // The probe targeted the credit transactions table.
    expect(db.from.mock.calls[0][0]).toBe(creditTransactions);
    // The predicate carried the exact idempotency key evidence.
    const compiled = new MySqlDialect().sqlToQuery(db.where.mock.calls[0][0] as never);
    expect(compiled.sql).toContain("idempotencyKey");
    expect(compiled.params).toContain("img-deduction:abc");
  });

  it("returns false when no row exists", async () => {
    mockDeductionSelect([]);
    const deps = createDefaultImageRenderStaleRecoveryDeps();

    await expect(
      deps.findDeductionRow({ deductionKey: "img-deduction:missing" })
    ).resolves.toBe(false);
  });
});
