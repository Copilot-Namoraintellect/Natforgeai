import { describe, it, expect, vi, afterEach } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  sweepStaleCreativeGenerationClaims,
  createDefaultCreativeStaleClaimSweepDeps,
  type SweepStaleCreativeClaimsDeps,
} from "./creative-stale-claim-sweep";
import type { CreativeGenerationClaim } from "./creative-generation-claim";

// ─── Deterministic dormant sweep coordinator tests ───
//
// Injected fakes only for the coordinator proofs: no database, provider,
// renderer, storage, timers, or environment mutation. The default-dependency
// probes run through mocked connection/claim modules.

const viMock = vi.hoisted(() => ({
  getDb: vi.fn(),
  classifyStaleCreativeGenerationClaims: vi.fn(),
  terminalizeStaleCreativeGenerationClaim: vi.fn(),
}));

vi.mock("../../queries/connection", () => ({ getDb: viMock.getDb }));

vi.mock("./creative-generation-claim", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./creative-generation-claim")>();
  return {
    ...original,
    classifyStaleCreativeGenerationClaims:
      viMock.classifyStaleCreativeGenerationClaims,
    terminalizeStaleCreativeGenerationClaim:
      viMock.terminalizeStaleCreativeGenerationClaim,
  };
});

import { getDb } from "../../queries/connection";
import { creativeGenerationClaims } from "@db/schema";

const OWNER_TOKEN = "secret-owner-token-must-never-leak";

function makeClaim(
  overrides: Partial<CreativeGenerationClaim> = {}
): CreativeGenerationClaim {
  return {
    id: 1,
    userId: 7,
    campaignId: 13,
    operationSource: "job",
    operationReferenceId: 99,
    activeClaimKey: "active:7:13:creative",
    ownerToken: OWNER_TOKEN,
    status: "running",
    heartbeatAt: null,
    leaseExpiresAt: new Date(Date.now() - 60_000),
    releasedAt: null,
    createdAt: new Date(Date.now() - 120_000),
    updatedAt: new Date(Date.now() - 90_000),
    ...overrides,
  };
}

interface FakeDepsConfig {
  expiredLeasedClaims?: CreativeGenerationClaim[];
  legacyOrUnleasedClaims?: CreativeGenerationClaim[];
  healthyCount?: number;
  listThrows?: Error;
  countThrows?: Error;
  terminalize?: (
    args: {
      claimId: number;
      userId: number;
      campaignId: number;
      staleBefore: Date;
    }
  ) => Promise<{ terminalized: boolean }>;
}

function makeDeps(config: FakeDepsConfig = {}) {
  const counts = { list: 0, count: 0, terminalize: 0 };
  const terminalizeArgs: Array<{
    claimId: number;
    userId: number;
    campaignId: number;
    staleBefore: Date;
  }> = [];
  const deps: SweepStaleCreativeClaimsDeps = {
    listStaleClaims: vi.fn(async () => {
      counts.list += 1;
      if (config.listThrows) throw config.listThrows;
      return {
        expiredLeasedClaims: config.expiredLeasedClaims ?? [],
        legacyOrUnleasedClaims: config.legacyOrUnleasedClaims ?? [],
      };
    }),
    countHealthyRunningClaims: vi.fn(async () => {
      counts.count += 1;
      if (config.countThrows) throw config.countThrows;
      return config.healthyCount ?? 0;
    }),
    terminalizeStaleClaim: vi.fn(async (args) => {
      counts.terminalize += 1;
      terminalizeArgs.push(args);
      if (config.terminalize) return config.terminalize(args);
      return { terminalized: true };
    }),
  };
  return { deps, counts, terminalizeArgs };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("sweepStaleCreativeGenerationClaims", () => {
  it("recovers every stale candidate and reports found/healthy/recovered evidence", async () => {
    const expired = makeClaim({ id: 11 });
    const legacy = makeClaim({
      id: 12,
      leaseExpiresAt: null,
    });
    const { deps, counts, terminalizeArgs } = makeDeps({
      expiredLeasedClaims: [expired],
      legacyOrUnleasedClaims: [legacy],
      healthyCount: 3,
    });
    const staleBefore = new Date();

    const report = await sweepStaleCreativeGenerationClaims({ staleBefore, deps });

    expect(report.staleBefore).toBe(staleBefore.toISOString());
    expect(report.found).toBe(2);
    expect(report.healthyIgnored).toBe(3);
    expect(report.recovered).toEqual([
      { claimId: 11, userId: 7, campaignId: 13, recoveryKind: "expired_lease" },
      { claimId: 12, userId: 7, campaignId: 13, recoveryKind: "legacy_unleased" },
    ]);
    expect(report.ambiguousLeftUntouched).toEqual([]);
    expect(counts.list).toBe(1);
    expect(counts.count).toBe(1);
    expect(counts.terminalize).toBe(2);
    for (const args of terminalizeArgs) {
      expect(args.staleBefore).toBe(staleBefore);
    }
  });

  it("recovers nothing when no stale claims exist", async () => {
    const { deps, counts } = makeDeps({ healthyCount: 4 });

    const report = await sweepStaleCreativeGenerationClaims({
      staleBefore: new Date(),
      deps,
    });

    expect(report.found).toBe(0);
    expect(report.healthyIgnored).toBe(4);
    expect(report.recovered).toEqual([]);
    expect(report.ambiguousLeftUntouched).toEqual([]);
    expect(counts.terminalize).toBe(0);
  });

  it("leaves a raced candidate untouched after a terminalization miss (renewed or released mid-sweep)", async () => {
    const raced = makeClaim({ id: 21 });
    const recovered = makeClaim({ id: 22 });
    const { deps, counts } = makeDeps({
      expiredLeasedClaims: [raced, recovered],
      terminalize: async (args) =>
        args.claimId === raced.id
          ? { terminalized: false }
          : { terminalized: true },
    });

    const report = await sweepStaleCreativeGenerationClaims({
      staleBefore: new Date(),
      deps,
    });

    expect(report.recovered).toEqual([
      { claimId: 22, userId: 7, campaignId: 13, recoveryKind: "expired_lease" },
    ]);
    expect(report.ambiguousLeftUntouched).toEqual([
      {
        claimId: 21,
        userId: 7,
        campaignId: 13,
        reason: "state_changed_or_not_recoverable",
      },
    ]);
    // Exactly one terminalization attempt per candidate: zero retries.
    expect(counts.terminalize).toBe(2);
  });

  it("records a terminalization error as ambiguous and continues with remaining candidates", async () => {
    const failing = makeClaim({ id: 31 });
    const ok = makeClaim({ id: 32 });
    const { deps, counts } = makeDeps({
      expiredLeasedClaims: [failing, ok],
      terminalize: async (args) => {
        if (args.claimId === failing.id) throw new Error("db gone");
        return { terminalized: true };
      },
    });

    const report = await sweepStaleCreativeGenerationClaims({
      staleBefore: new Date(),
      deps,
    });

    expect(report.recovered).toEqual([
      { claimId: 32, userId: 7, campaignId: 13, recoveryKind: "expired_lease" },
    ]);
    expect(report.ambiguousLeftUntouched).toEqual([
      {
        claimId: 31,
        userId: 7,
        campaignId: 13,
        reason: "state_changed_or_not_recoverable",
      },
    ]);
    expect(counts.terminalize).toBe(2);
  });

  it("screens out candidates the pure gate rejects without terminalizing them", async () => {
    // Simulates the listing/pure-gate disagreement window (e.g. local/DB
    // clock skew): the claim arrived with an active lease.
    const active = makeClaim({
      id: 41,
      leaseExpiresAt: new Date(Date.now() + 300_000),
    });
    const { deps, counts } = makeDeps({ expiredLeasedClaims: [active] });

    const report = await sweepStaleCreativeGenerationClaims({
      staleBefore: new Date(),
      deps,
    });

    expect(report.recovered).toEqual([]);
    expect(report.ambiguousLeftUntouched).toEqual([
      {
        claimId: 41,
        userId: 7,
        campaignId: 13,
        reason: "not_recoverable",
      },
    ]);
    expect(counts.terminalize).toBe(0);
  });

  it("is idempotent: a second sweep over recovered state finds nothing to do", async () => {
    const staleClaims = [makeClaim({ id: 51 })];
    const recoveredIds = new Set<number>();
    const deps: SweepStaleCreativeClaimsDeps = {
      listStaleClaims: vi.fn(async () => ({
        expiredLeasedClaims: staleClaims.filter((c) => !recoveredIds.has(c.id)),
        legacyOrUnleasedClaims: [],
      })),
      countHealthyRunningClaims: vi.fn(async () => 0),
      terminalizeStaleClaim: vi.fn(async (args) => {
        recoveredIds.add(args.claimId);
        return { terminalized: true };
      }),
    };

    const first = await sweepStaleCreativeGenerationClaims({
      staleBefore: new Date(),
      deps,
    });
    const second = await sweepStaleCreativeGenerationClaims({
      staleBefore: new Date(),
      deps,
    });

    expect(first.recovered).toHaveLength(1);
    expect(second.found).toBe(0);
    expect(second.recovered).toEqual([]);
    expect(second.ambiguousLeftUntouched).toEqual([]);
  });

  it("lets exactly one concurrent sweep win per claim (concurrent recovery attempts)", async () => {
    const staleClaims = [makeClaim({ id: 61 })];
    const terminalizedIds = new Set<number>();
    const makeSharedDeps = (): SweepStaleCreativeClaimsDeps => ({
      listStaleClaims: vi.fn(async () => ({
        expiredLeasedClaims: staleClaims,
        legacyOrUnleasedClaims: [],
      })),
      countHealthyRunningClaims: vi.fn(async () => 0),
      terminalizeStaleClaim: vi.fn(async (args) => {
        // The conditional UPDATE is the authority: the first attempt wins,
        // every later attempt (concurrent peer sweeps) sees zero rows.
        if (terminalizedIds.has(args.claimId)) return { terminalized: false };
        terminalizedIds.add(args.claimId);
        return { terminalized: true };
      }),
    });

    const [reportA, reportB] = await Promise.all([
      sweepStaleCreativeGenerationClaims({
        staleBefore: new Date(),
        deps: makeSharedDeps(),
      }),
      sweepStaleCreativeGenerationClaims({
        staleBefore: new Date(),
        deps: makeSharedDeps(),
      }),
    ]);

    const recoveredAcrossSweep = reportA.recovered.length + reportB.recovered.length;
    expect(recoveredAcrossSweep).toBe(1);
    const ambiguousAcrossSweeps =
      reportA.ambiguousLeftUntouched.length + reportB.ambiguousLeftUntouched.length;
    expect(ambiguousAcrossSweeps).toBe(1);
    expect(terminalizedIds.size).toBe(1);
  });

  it("rejects an invalid staleBefore before any dependency call", async () => {
    const { deps, counts } = makeDeps();

    await expect(
      sweepStaleCreativeGenerationClaims({
        staleBefore: new Date("invalid"),
        deps,
      })
    ).rejects.toThrow(/Invalid staleBefore/);

    expect(counts.list).toBe(0);
    expect(counts.count).toBe(0);
    expect(counts.terminalize).toBe(0);
  });

  it("aborts with zero mutations when the stale listing fails", async () => {
    const { deps, counts } = makeDeps({
      expiredLeasedClaims: [makeClaim({ id: 71 })],
      listThrows: new Error("db down"),
    });

    await expect(
      sweepStaleCreativeGenerationClaims({ staleBefore: new Date(), deps })
    ).rejects.toThrow("db down");

    expect(counts.terminalize).toBe(0);
  });

  it("aborts with zero mutations when the healthy count fails", async () => {
    const { deps, counts } = makeDeps({
      expiredLeasedClaims: [makeClaim({ id: 81 })],
      countThrows: new Error("db down"),
    });

    await expect(
      sweepStaleCreativeGenerationClaims({ staleBefore: new Date(), deps })
    ).rejects.toThrow("db down");

    expect(counts.terminalize).toBe(0);
  });

  it("serialized audit reports leak no owner tokens or dependency internals", async () => {
    const { deps } = makeDeps({
      expiredLeasedClaims: [makeClaim({ id: 91 })],
      legacyOrUnleasedClaims: [makeClaim({ id: 92, leaseExpiresAt: null })],
      terminalize: async (args) =>
        args.claimId === 91
          ? { terminalized: true }
          : Promise.reject(new Error("boom")),
    });

    const report = await sweepStaleCreativeGenerationClaims({
      staleBefore: new Date(),
      deps,
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(OWNER_TOKEN);
    expect(serialized).not.toContain("ownerToken");
    expect(serialized).not.toContain("boom");
    expect(report.recovered).toHaveLength(1);
    expect(report.ambiguousLeftUntouched).toHaveLength(1);
  });

  it("returns a frozen report", async () => {
    const { deps } = makeDeps({ expiredLeasedClaims: [makeClaim({ id: 95 })] });

    const report = await sweepStaleCreativeGenerationClaims({
      staleBefore: new Date(),
      deps,
    });

    expect(Object.isFrozen(report)).toBe(true);
  });
});

describe("createDefaultCreativeStaleClaimSweepDeps", () => {
  it("exposes exactly the listing, healthy-count and terminalization seams", () => {
    const deps = createDefaultCreativeStaleClaimSweepDeps();
    expect(Object.keys(deps).sort()).toEqual([
      "countHealthyRunningClaims",
      "listStaleClaims",
      "terminalizeStaleClaim",
    ]);
    for (const key of Object.keys(deps)) {
      expect(typeof (deps as unknown as Record<string, unknown>)[key]).toBe("function");
    }
  });

  it("wires listStaleClaims to the existing stale claim classifier", async () => {
    const canned = {
      expiredLeasedClaims: [makeClaim({ id: 101 })],
      legacyOrUnleasedClaims: [],
    };
    viMock.classifyStaleCreativeGenerationClaims.mockResolvedValue(canned);
    const deps = createDefaultCreativeStaleClaimSweepDeps();
    const staleBefore = new Date();

    const result = await deps.listStaleClaims({ staleBefore });

    expect(result).toBe(canned);
    expect(viMock.classifyStaleCreativeGenerationClaims).toHaveBeenCalledWith({
      staleBefore,
    });
  });

  it("wires terminalizeStaleClaim to the conditional terminalization primitive", async () => {
    viMock.terminalizeStaleCreativeGenerationClaim.mockResolvedValue({
      terminalized: true,
    });
    const deps = createDefaultCreativeStaleClaimSweepDeps();
    const args = {
      claimId: 102,
      userId: 7,
      campaignId: 13,
      staleBefore: new Date(),
    };

    const result = await deps.terminalizeStaleClaim(args);

    expect(result).toEqual({ terminalized: true });
    expect(viMock.terminalizeStaleCreativeGenerationClaim).toHaveBeenCalledWith(args);
  });

  it("healthy-count probe is a read-only count over running creative claims", async () => {
    const limit = vi.fn(async () => [{ value: 3 }]);
    const where = vi.fn((_cond?: unknown) => [{ value: 3 }]);
    const from = vi.fn((_table?: unknown) => ({ where }));
    const select = vi.fn((_fields?: unknown) => ({ from }));
    viMock.getDb.mockReturnValue({ select } as never);
    const deps = createDefaultCreativeStaleClaimSweepDeps();
    const staleBefore = new Date();

    const count = await deps.countHealthyRunningClaims({ staleBefore });

    expect(count).toBe(3);
    expect(select).toHaveBeenCalledTimes(1);
    expect(from.mock.calls[0][0]).toBe(creativeGenerationClaims);
    expect(limit).not.toHaveBeenCalled();
    const compiled = new MySqlDialect().sqlToQuery(where.mock.calls[0][0] as never);
    expect(compiled.sql).toContain("status");
    expect(compiled.sql).toContain("leaseExpiresAt");
    expect(compiled.sql).toContain("updatedAt");
    expect(compiled.params[0]).toBe("running");
    const expectedDate = staleBefore.toISOString().slice(0, 23).replace("T", " ");
    expect(compiled.params[1]).toBe(expectedDate);
  });
});
