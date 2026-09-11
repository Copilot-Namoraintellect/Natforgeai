import { describe, it, expect, vi, afterEach } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// The connection module is mocked so no real database can ever be reached and
// so import-time laziness / supplied-executor bypass can be asserted.
const executeMock = vi.hoisted(() => vi.fn());
vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(() => ({ execute: executeMock })),
}));

import { getDb } from "../../queries/connection";
import {
  checkImageRenderClaimsReadiness,
  createDefaultImageRenderClaimsReadinessExecutor,
  createImageRenderClaimsReadinessChecker,
  getEffectiveImageRenderClaimsMode,
  IMAGE_RENDER_CLAIMS_REQUIRED_COLUMNS,
  IMAGE_RENDER_CLAIMS_REQUIRED_INDEXES,
  type ImageRenderClaimsReadiness,
  type ImageRenderClaimsReadinessExecutor,
} from "./image-render-claims-readiness";

const getDbMock = getDb as unknown as ReturnType<typeof vi.fn>;

// ─── Deterministic metadata fakes ───
//
// No real database, timers, sleeps, or global state. The injected clock is a
// plain function over a mutable millisecond value.

function fullColumns(): string[] {
  return [...IMAGE_RENDER_CLAIMS_REQUIRED_COLUMNS];
}

function fullIndexes(): { name: string; unique: boolean; columns: string[] }[] {
  return IMAGE_RENDER_CLAIMS_REQUIRED_INDEXES.map((index) => ({
    name: index.name,
    unique: index.unique,
    columns: [...index.columns],
  }));
}

function makeExecutor(overrides: {
  columns?: unknown;
  indexes?: unknown;
  columnBehavior?: "resolve" | "reject" | "deferred";
  indexBehavior?: "resolve" | "reject";
} = {}): {
  executor: ImageRenderClaimsReadinessExecutor;
  listClaimColumns: ReturnType<typeof vi.fn>;
  listClaimIndexes: ReturnType<typeof vi.fn>;
} {
  const listClaimColumns = vi.fn(() => {
    if (overrides.columnBehavior === "reject") {
      return Promise.reject(new Error("columns query failed"));
    }
    return Promise.resolve(overrides.columns ?? fullColumns());
  });
  const listClaimIndexes = vi.fn(() => {
    if (overrides.indexBehavior === "reject") {
      return Promise.reject(new Error("indexes query failed"));
    }
    return Promise.resolve(overrides.indexes ?? fullIndexes());
  });
  return {
    executor: Object.freeze({ listClaimColumns, listClaimIndexes }),
    listClaimColumns,
    listClaimIndexes,
  };
}

const SECRET_ERROR_TEXT =
  "mysql://app_user:hunter2@db.internal:3306/natforge_prod Access denied for user 'app_user'";

afterEach(() => {
  vi.restoreAllMocks();
  executeMock.mockReset();
  getDbMock.mockClear();
});

describe("checkImageRenderClaimsReadiness — exact committed schema", () => {
  it("exact complete schema resolves ready", async () => {
    const { executor, listClaimColumns, listClaimIndexes } = makeExecutor();
    await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({ ready: true });
    // Bounded probe: exactly one columns query and one indexes query.
    expect(listClaimColumns).toHaveBeenCalledTimes(1);
    expect(listClaimIndexes).toHaveBeenCalledTimes(1);
  });

  it("extra unexpected columns and indexes are allowed", async () => {
    const { executor } = makeExecutor({
      columns: [...fullColumns(), "somethingExtra"],
      indexes: [...fullIndexes(), { name: "future_idx", unique: false, columns: ["id"] }],
    });
    await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({ ready: true });
  });

  it("works against a frozen executor (no mutation of the dependency)", async () => {
    const { executor } = makeExecutor();
    expect(Object.isFrozen(executor)).toBe(true);
    await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({ ready: true });
  });

  it("empty column metadata means the table is missing", async () => {
    const { executor, listClaimIndexes } = makeExecutor({ columns: [] });
    await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({
      ready: false,
      reason: "claim_table_missing",
    });
    // Fail-fast: the probe is bounded to a single query.
    expect(listClaimIndexes).not.toHaveBeenCalled();
  });

  it.each(IMAGE_RENDER_CLAIMS_REQUIRED_COLUMNS.map((column) => [column, column] as const))(
    "missing column %s resolves claim_column_missing",
    async (_label, column) => {
      const { executor, listClaimIndexes } = makeExecutor({
        columns: fullColumns().filter((name) => name !== column),
      });
      await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({
        ready: false,
        reason: "claim_column_missing",
      });
      expect(listClaimIndexes).not.toHaveBeenCalled();
    }
  );

  it.each(IMAGE_RENDER_CLAIMS_REQUIRED_INDEXES.map((index) => [index.name, index.name] as const))(
    "missing index %s resolves claim_index_missing",
    async (_label, name) => {
      const { executor } = makeExecutor({
        indexes: fullIndexes().filter((index) => index.name !== name),
      });
      await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({
        ready: false,
        reason: "claim_index_missing",
      });
    }
  );

  it.each(IMAGE_RENDER_CLAIMS_REQUIRED_INDEXES.map((index) => [index.name, index.name] as const))(
    "wrong uniqueness on %s resolves claim_index_invalid",
    async (_label, name) => {
      const { executor } = makeExecutor({
        indexes: fullIndexes().map((index) =>
          index.name === name ? { ...index, unique: !index.unique } : index
        ),
      });
      await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({
        ready: false,
        reason: "claim_index_invalid",
      });
    }
  );

  it.each(IMAGE_RENDER_CLAIMS_REQUIRED_INDEXES.map((index) => [index.name, index.name] as const))(
    "wrong indexed column on %s resolves claim_index_invalid",
    async (_label, name) => {
      const { executor } = makeExecutor({
        indexes: fullIndexes().map((index) =>
          index.name === name
            ? { ...index, columns: ["notTheRightColumn"] }
            : index
        ),
      });
      await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({
        ready: false,
        reason: "claim_index_invalid",
      });
    }
  );

  it("reversed ordered columns on irc_user_post_idx resolve claim_index_invalid", async () => {
    const { executor } = makeExecutor({
      indexes: fullIndexes().map((index) =>
        index.name === "irc_user_post_idx"
          ? { ...index, columns: [...index.columns].reverse() }
          : index
      ),
    });
    await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({
      ready: false,
      reason: "claim_index_invalid",
    });
  });

  it("truncated ordered columns on irc_user_post_idx resolve claim_index_invalid", async () => {
    const { executor } = makeExecutor({
      indexes: fullIndexes().map((index) =>
        index.name === "irc_user_post_idx" ? { ...index, columns: ["userId"] } : index
      ),
    });
    await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({
      ready: false,
      reason: "claim_index_invalid",
    });
  });

  it("duplicate identical column rows are tolerated", async () => {
    const { executor } = makeExecutor({ columns: [...fullColumns(), "id", "userId"] });
    await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({ ready: true });
  });

  it("duplicate identical index rows are tolerated", async () => {
    const indexes = fullIndexes();
    const { executor } = makeExecutor({ indexes: [...indexes, { ...indexes[0] }] });
    await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({ ready: true });
  });

  it("duplicate conflicting index rows resolve claim_metadata_malformed", async () => {
    const indexes = fullIndexes();
    const { executor } = makeExecutor({
      indexes: [...indexes, { ...indexes[0], unique: false }],
    });
    await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({
      ready: false,
      reason: "claim_metadata_malformed",
    });
  });

  it.each([
    ["columns not an array", "not-an-array"],
    ["columns with non-string entry", [1, 2, 3]],
    ["columns with empty-string entry", ["id", ""]],
  ])("malformed column metadata (%s) resolves claim_metadata_malformed", async (_label, columns) => {
    const { executor, listClaimIndexes } = makeExecutor({ columns });
    await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({
      ready: false,
      reason: "claim_metadata_malformed",
    });
    expect(listClaimIndexes).not.toHaveBeenCalled();
  });

  it.each([
    ["indexes not an array", { not: "an array" }],
    ["index entry not an object", [42]],
    ["index missing unique flag", [{ name: "irc_active_claim_key_idx", columns: ["activeClaimKey"] }]],
    ["index with non-boolean unique", [{ name: "irc_active_claim_key_idx", unique: "yes", columns: ["activeClaimKey"] }]],
    ["index missing columns", [{ name: "irc_active_claim_key_idx", unique: true }]],
    ["index empty columns", [{ name: "irc_active_claim_key_idx", unique: true, columns: [] }]],
    ["index non-string column entry", [{ name: "irc_active_claim_key_idx", unique: true, columns: [7] }]],
    ["index entry with empty name", [{ name: "", unique: true, columns: ["a"] }]],
  ])("malformed index metadata (%s) resolves claim_metadata_malformed", async (_label, indexes) => {
    const { executor } = makeExecutor({ indexes });
    await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({
      ready: false,
      reason: "claim_metadata_malformed",
    });
  });
});

describe("checkImageRenderClaimsReadiness — database failure and security", () => {
  it("columns executor throw resolves claim_database_unavailable and skips second query", async () => {
    const { executor, listClaimColumns, listClaimIndexes } = makeExecutor({
      columnBehavior: "reject",
    });
    listClaimColumns.mockImplementation(() => Promise.reject(new Error("boom")));
    await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({
      ready: false,
      reason: "claim_database_unavailable",
    });
    expect(listClaimColumns).toHaveBeenCalledTimes(1);
    expect(listClaimIndexes).not.toHaveBeenCalled();
  });

  it("indexes executor throw resolves claim_database_unavailable", async () => {
    const { executor, listClaimColumns, listClaimIndexes } = makeExecutor();
    listClaimIndexes.mockImplementation(() => Promise.reject(new Error("boom")));
    await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({
      ready: false,
      reason: "claim_database_unavailable",
    });
    expect(listClaimColumns).toHaveBeenCalledTimes(1);
    expect(listClaimIndexes).toHaveBeenCalledTimes(1);
  });

  it("raw executor error text (credentials/host/db/SQL) is never exposed", async () => {
    const { executor, listClaimColumns } = makeExecutor();
    listClaimColumns.mockImplementation(() =>
      Promise.reject(new Error(`ER_ACCESS_DENIED: ${SECRET_ERROR_TEXT}; SQL: SELECT * FROM t`))
    );
    const result: ImageRenderClaimsReadiness = await checkImageRenderClaimsReadiness(executor);
    expect(result).toEqual({ ready: false, reason: "claim_database_unavailable" });
    const serialized = JSON.stringify(result);
    for (const secret of [
      "mysql://",
      "hunter2",
      "db.internal",
      "natforge_prod",
      "app_user",
      "SELECT * FROM",
      "ER_ACCESS_DENIED",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("result union carries only stable keys", async () => {
    const { executor } = makeExecutor();
    const ready = await checkImageRenderClaimsReadiness(executor);
    expect(Object.keys(ready).sort()).toEqual(["ready"]);
    const unavailable = await checkImageRenderClaimsReadiness(
      makeExecutor({ columnBehavior: "reject" }).executor
    );
    expect(Object.keys(unavailable).sort()).toEqual(["ready", "reason"]);
  });

  it("supplied executor bypasses getDb completely", async () => {
    getDbMock.mockClear();
    const { executor } = makeExecutor();
    await checkImageRenderClaimsReadiness(executor);
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("importing the readiness module performs zero database work", async () => {
    vi.resetModules();
    getDbMock.mockClear();
    await import("./image-render-claims-readiness");
    expect(getDbMock).not.toHaveBeenCalled();
  });
});

describe("createDefaultImageRenderClaimsReadinessExecutor — read-only INFORMATION_SCHEMA wiring", () => {
  it("obtains the database lazily, only when invoked", async () => {
    const executor = createDefaultImageRenderClaimsReadinessExecutor();
    expect(getDbMock).not.toHaveBeenCalled();
    executeMock.mockResolvedValueOnce([[{ name: "id" }, { name: "userId" }]]);
    await expect(executor.listClaimColumns()).resolves.toEqual(["id", "userId"]);
    expect(getDbMock).toHaveBeenCalledTimes(1);
  });

  it("columns query targets INFORMATION_SCHEMA for image_render_claims", async () => {
    const executor = createDefaultImageRenderClaimsReadinessExecutor();
    executeMock.mockResolvedValueOnce([[{ name: "id" }]]);
    await executor.listClaimColumns();
    const query = executeMock.mock.calls[0][0];
    const text = new MySqlDialect().sqlToQuery(query as never).sql;
    expect(text).toContain("INFORMATION_SCHEMA");
    expect(text).toContain("image_render_claims");
    expect(text).not.toContain("DATABASE_URL");
    expect(text).not.toContain("INSERT");
    expect(text).not.toContain("UPDATE");
    expect(text).not.toContain("DELETE");
    expect(text).not.toContain("DROP");
    expect(text).not.toContain("ALTER");
  });

  it("aggregates STATISTICS rows into ordered unique index metadata", async () => {
    const executor = createDefaultImageRenderClaimsReadinessExecutor();
    executeMock.mockResolvedValueOnce([
      [
        { name: "irc_active_claim_key_idx", nonUnique: 0, columnName: "activeClaimKey" },
        { name: "irc_user_post_idx", nonUnique: 1, columnName: "userId" },
        { name: "irc_user_post_idx", nonUnique: 1, columnName: "contentPostId" },
      ],
    ]);
    await expect(executor.listClaimIndexes()).resolves.toEqual([
      { name: "irc_active_claim_key_idx", unique: true, columns: ["activeClaimKey"] },
      { name: "irc_user_post_idx", unique: false, columns: ["userId", "contentPostId"] },
    ]);
  });

  it("end-to-end readiness succeeds against driver-shaped INFORMATION_SCHEMA results", async () => {
    const executor = createDefaultImageRenderClaimsReadinessExecutor();
    executeMock
      .mockResolvedValueOnce([fullColumns().map((name) => ({ name }))])
      .mockResolvedValueOnce([
        fullIndexes().flatMap((index) =>
          index.columns.map((columnName, seq) => ({
            name: index.name,
            nonUnique: index.unique ? 0 : 1,
            columnName,
            seq,
          }))
        ),
      ]);
    await expect(checkImageRenderClaimsReadiness(executor)).resolves.toEqual({ ready: true });
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("driver failure surfaces as unavailable without raw error exposure", async () => {
    const executor = createDefaultImageRenderClaimsReadinessExecutor();
    executeMock.mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${SECRET_ERROR_TEXT}`));
    const result = await checkImageRenderClaimsReadiness(executor);
    expect(result).toEqual({ ready: false, reason: "claim_database_unavailable" });
    expect(JSON.stringify(result)).not.toContain("natforge_prod");
  });
});

describe("createImageRenderClaimsReadinessChecker — deterministic cache policy", () => {
  function makeClock() {
    let nowMs = 0;
    return { now: () => nowMs, advance: (delta: number) => void (nowMs += delta) };
  }

  it("ready=true is cached for the process lifetime without re-probing", async () => {
    const clock = makeClock();
    const { executor, listClaimColumns } = makeExecutor();
    const checker = createImageRenderClaimsReadinessChecker({ executor, now: clock.now });
    await expect(checker.check()).resolves.toEqual({ ready: true });
    clock.advance(Number.MAX_SAFE_INTEGER / 2);
    await expect(checker.check()).resolves.toEqual({ ready: true });
    expect(listClaimColumns).toHaveBeenCalledTimes(1);
  });

  it("negative cache expires, recovers, and heals without restart", async () => {
    const clock = makeClock();
    let columns = fullColumns().filter((name) => name !== "completedAt");
    const listClaimColumns = vi.fn(async () => columns);
    const listClaimIndexes = vi.fn(async () => fullIndexes());
    const checker = createImageRenderClaimsReadinessChecker({
      executor: Object.freeze({ listClaimColumns, listClaimIndexes }),
      now: clock.now,
      negativeCacheMs: 1_000,
    });
    await expect(checker.check()).resolves.toEqual({
      ready: false,
      reason: "claim_column_missing",
    });
    expect(listClaimColumns).toHaveBeenCalledTimes(1);

    clock.advance(500);
    await expect(checker.check()).resolves.toEqual({
      ready: false,
      reason: "claim_column_missing",
    });
    expect(listClaimColumns).toHaveBeenCalledTimes(1);

    // Migrations land during the negative-cache window; one expiry later the
    // SAME checker re-probes, heals, and caches ready=true permanently —
    // no process restart required.
    columns = fullColumns();
    clock.advance(501);
    await expect(checker.check()).resolves.toEqual({ ready: true });
    expect(listClaimColumns).toHaveBeenCalledTimes(2);
    clock.advance(Number.MAX_SAFE_INTEGER / 2);
    await expect(checker.check()).resolves.toEqual({ ready: true });
    expect(listClaimColumns).toHaveBeenCalledTimes(2);
  });

  it("transient probe failure expires and recovers automatically", async () => {
    const clock = makeClock();
    let fail = true;
    const listClaimColumns = vi.fn(() =>
      fail
        ? Promise.reject(new Error("transient: " + SECRET_ERROR_TEXT))
        : Promise.resolve(fullColumns())
    );
    const listClaimIndexes = vi.fn(async () => fullIndexes());
    const checker = createImageRenderClaimsReadinessChecker({
      executor: Object.freeze({ listClaimColumns, listClaimIndexes }),
      now: clock.now,
      negativeCacheMs: 100,
    });
    await expect(checker.check()).resolves.toEqual({
      ready: false,
      reason: "claim_database_unavailable",
    });
    fail = false;
    clock.advance(101);
    await expect(checker.check()).resolves.toEqual({ ready: true });
  });

  it("concurrent check() calls share a single in-flight probe", async () => {
    const clock = makeClock();
    let resolveProbe!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      resolveProbe = resolve;
    });
    const listClaimColumns = vi.fn(() => gate);
    const listClaimIndexes = vi.fn(async () => fullIndexes());
    const checker = createImageRenderClaimsReadinessChecker({
      executor: Object.freeze({ listClaimColumns, listClaimIndexes }),
      now: clock.now,
    });
    const first = checker.check();
    const second = checker.check();
    expect(listClaimColumns).toHaveBeenCalledTimes(1);
    resolveProbe(fullColumns());
    await expect(first).resolves.toEqual({ ready: true });
    await expect(second).resolves.toEqual({ ready: true });
    expect(listClaimColumns).toHaveBeenCalledTimes(1);
  });

  it("a rejected probe clears the in-flight slot and never poisons later checks", async () => {
    const clock = makeClock();
    let fail = true;
    const listClaimColumns = vi.fn(() =>
      fail ? Promise.reject(new Error("down")) : Promise.resolve(fullColumns())
    );
    const listClaimIndexes = vi.fn(async () => fullIndexes());
    const checker = createImageRenderClaimsReadinessChecker({
      executor: Object.freeze({ listClaimColumns, listClaimIndexes }),
      now: clock.now,
      negativeCacheMs: 10,
    });
    await expect(checker.check()).resolves.toEqual({
      ready: false,
      reason: "claim_database_unavailable",
    });
    fail = false;
    await expect(checker.check()).resolves.toEqual({
      ready: false,
      reason: "claim_database_unavailable",
    });
    expect(listClaimColumns).toHaveBeenCalledTimes(1);
    clock.advance(11);
    await expect(checker.check()).resolves.toEqual({ ready: true });
    expect(listClaimColumns).toHaveBeenCalledTimes(2);
  });
});

describe("getEffectiveImageRenderClaimsMode — off mode never touches readiness", () => {
  function throwingReadiness() {
    return {
      check: vi.fn(() => {
        throw new Error("readiness must never be invoked");
      }),
    };
  }

  it.each([
    ["off", "off"],
    ["empty", ""],
    ["whitespace", "   "],
    ["missing", null],
    ["invalid", "sometimes"],
  ])("configured %s resolves off with zero readiness calls", async (_label, rawMode) => {
    const readiness = throwingReadiness();
    await expect(
      getEffectiveImageRenderClaimsMode({ rawMode, warn: vi.fn(), readiness })
    ).resolves.toBe("off");
    expect(readiness.check).not.toHaveBeenCalled();
  });

  it("configured on invokes readiness once and maps ready to on", async () => {
    const readiness = {
      check: vi.fn(async (): Promise<ImageRenderClaimsReadiness> => ({ ready: true })),
    };
    await expect(getEffectiveImageRenderClaimsMode({ rawMode: "on", readiness })).resolves.toBe("on");
    expect(readiness.check).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not_ready", { ready: false, reason: "claim_table_missing" as const }],
    ["unavailable union", { ready: false, reason: "claim_database_unavailable" as const }],
  ])("configured on + %s resolves off", async (_label, readinessResult) => {
    const readiness = { check: vi.fn(async () => readinessResult) };
    await expect(getEffectiveImageRenderClaimsMode({ rawMode: "on", readiness })).resolves.toBe("off");
  });

  it("a throwing readiness dependency resolves off (fail closed)", async () => {
    const readiness = {
      check: vi.fn(async () => {
        throw new Error("readiness subsystem exploded with mysql://secret");
      }),
    };
    await expect(getEffectiveImageRenderClaimsMode({ rawMode: "on", readiness })).resolves.toBe("off");
  });
});
