import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { readFileSync } from "node:fs";
import type { User } from "@db/schema";

const loggedEvents: any[] = [];

vi.mock("./lib/logger", () => ({
  logInfo: vi.fn((message: string, fields?: any) => {
    loggedEvents.push({ level: "info", message, fields });
  }),
  logError: vi.fn((message: string, fields?: any) => {
    loggedEvents.push({ level: "error", message, fields });
  }),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("ioredis", () => ({
  Redis: class {
    constructor() {
      throw new Error("real Redis must never be constructed in admin replay tests");
    }
  },
}));

// Authority mocks: the router must delegate, never reimplement.
vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/queue/terminal-replay", () => ({
  requestTerminalFailureReplay: vi.fn(),
  TerminalReplayTargetNotFoundError: class extends Error {
    readonly terminalFailureId: number;
    constructor(id: number) {
      super(`Terminal failure ${id} does not exist`);
      this.name = "TerminalReplayTargetNotFoundError";
      this.terminalFailureId = id;
    }
  },
  TerminalReplayRequestNotFoundError: class extends Error {
    constructor(id: number) {
      super(`Replay request ${id} does not exist`);
      this.name = "TerminalReplayRequestNotFoundError";
    }
  },
  TerminalReplayKeyConflictError: class extends Error {
    readonly replayKey: string;
    constructor(key: string) {
      super(`Replay key ${key} conflict`);
      this.name = "TerminalReplayKeyConflictError";
      this.replayKey = key;
    }
  },
  TerminalReplayInvalidTransitionError: class extends Error {
    constructor() {
      super("invalid transition");
      this.name = "TerminalReplayInvalidTransitionError";
    }
  },
}));

vi.mock("./lib/queue/terminal-replay-executor", () => ({
  executePublishingTerminalReplay: vi.fn(),
  PublishingReplayValidationError: class extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "PublishingReplayValidationError";
      this.code = code;
    }
  },
}));

vi.mock("./lib/queue/terminal-content-replay-executor", () => ({
  executeContentTerminalReplay: vi.fn(),
  ContentReplayValidationError: class extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "ContentReplayValidationError";
      this.code = code;
    }
  },
}));

vi.mock("./lib/queue/terminal-replay-reconciliation-batch", () => ({
  reconcileTerminalReplayBatch: vi.fn(),
}));

import { adminRouter } from "./admin-router";
import { requestTerminalFailureReplay } from "./lib/queue/terminal-replay";
import { executePublishingTerminalReplay } from "./lib/queue/terminal-replay-executor";
import { executeContentTerminalReplay } from "./lib/queue/terminal-content-replay-executor";
import { reconcileTerminalReplayBatch } from "./lib/queue/terminal-replay-reconciliation-batch";
import { getDb } from "./queries/connection";

const mockedRequest = vi.mocked(requestTerminalFailureReplay);
const mockedPublishExec = vi.mocked(executePublishingTerminalReplay);
const mockedContentExec = vi.mocked(executeContentTerminalReplay);
const mockedBatch = vi.mocked(reconcileTerminalReplayBatch);
const mockedGetDb = vi.mocked(getDb);

/* ── Fake DB (queue_terminal_failures list + replay-request lookup) ── */

function evalEq(cond: any, row: any): boolean {
  const chunks: any[] = cond?.queryChunks ?? [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk && Array.isArray(chunk.queryChunks)) {
      if (!evalEq(chunk, row)) return false;
      continue;
    }
    if (chunk && typeof chunk === "object" && typeof chunk.name === "string" && chunk.table) {
      const param = chunks[i + 2];
      const value = param && typeof param === "object" && "value" in param ? param.value : param;
      if (row[chunk.name] !== value) return false;
      i += 2;
    }
  }
  return true;
}

function orderSpec(order: any): { column: string; dir: "asc" | "desc" } {
  const chunks = order?.queryChunks ?? [];
  const col = chunks.find(
    (c: any) => c && typeof c === "object" && typeof c.name === "string" && c.table
  );
  const tail = chunks
    .map((c: any) => String(c?.value?.[0] ?? ""))
    .join(" ")
    .toLowerCase();
  return { column: col?.name ?? "id", dir: tail.includes("desc") ? "desc" : "asc" };
}

function createFakeDb(seed: { terminalFailures: any[]; replayRequests: any[] }) {
  const state = {
    terminalFailures: seed.terminalFailures.map((r) => ({ ...r })),
    replayRequests: seed.replayRequests.map((r) => ({ ...r })),
    mutations: 0,
  };
  const db: any = {
    select: vi.fn((fields?: any) => ({
      from: vi.fn((table: any) => {
        const name = table[Symbol.for("drizzle:Name") as symbol];
        const rows = () =>
          name === "queue_terminal_failures"
            ? state.terminalFailures
            : name === "queue_replay_requests"
              ? state.replayRequests
              : [];
        return {
          where: vi.fn((cond: any) => ({
            limit: vi.fn(async (n: number) =>
              rows()
                .filter((r) => evalEq(cond, r))
                .slice(0, n)
                .map((r) => {
                  if (!fields) return r;
                  const projected: any = {};
                  for (const [alias, col] of Object.entries(fields)) {
                    projected[alias] = r[(col as any).name];
                  }
                  return projected;
                })
            ),
            orderBy: vi.fn((...orders: any[]) => ({
              limit: vi.fn(async (n: number) => {
                const specs = orders.map(orderSpec);
                return rows()
                  .filter((r) => evalEq(cond, r))
                  .sort((a, b) => {
                    for (const spec of specs) {
                      const av = a[spec.column]?.valueOf?.() ?? a[spec.column] ?? 0;
                      const bv = b[spec.column]?.valueOf?.() ?? b[spec.column] ?? 0;
                      if (av !== bv) {
                        return spec.dir === "desc" ? bv - av : av - bv;
                      }
                    }
                    return 0;
                  })
                  .slice(0, n)
                  .map((r) => {
                    if (!fields) return r;
                    const projected: any = {};
                    for (const [alias, col] of Object.entries(fields)) {
                      projected[alias] = r[(col as any).name];
                    }
                    return projected;
                  });
              }),
            })),
          })),
        };
      }),
    })),
    update: vi.fn(() => {
      state.mutations++;
      throw new Error("admin replay control plane must not update business state");
    }),
    delete: vi.fn(() => {
      state.mutations++;
      throw new Error("admin replay control plane must not delete business state");
    }),
  };
  return { db, state };
}

/* ── Context helpers (canary precedent) ────────────────────────────── */

function buildCtx(user: Partial<User> | null, verified = true) {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user: user as User,
    session: { userId: user?.id ?? 1, type: "local" as const, verified },
  };
}

function makeCaller(user: Partial<User> | null = { id: 1, role: "admin" }, verified = true) {
  return adminRouter.createCaller(buildCtx(user, verified));
}

const failureRow = (overrides: Partial<any> = {}) => ({
  id: 501,
  failureKey: "qtf:v1:publishing:publish-5",
  queueName: "publishing",
  bullmqJobId: "publish-5",
  terminalReason: "retries_exhausted",
  userId: 18,
  campaignId: 4,
  publishingQueueItemId: 5,
  agentRunId: null,
  errorCode: "ERR_CODE",
  errorSummary: "raw provider text Bearer abc",
  ownerToken: "should-never-appear",
  failedAt: new Date("2026-06-01T10:00:00Z"),
  status: "open",
  ...overrides,
});

const replayRequestRow = (overrides: Partial<any> = {}) => ({
  id: 1000,
  replayMode: "publishing_requeue",
  ...overrides,
});

function seedDb(overrides: Partial<any> = {}) {
  const world = createFakeDb({
    terminalFailures: [failureRow()],
    replayRequests: [replayRequestRow()],
    ...overrides,
  });
  mockedGetDb.mockReturnValue(world.db as any);
  return world;
}

async function expectTrpcCode(promise: Promise<any>, code: string) {
  try {
    await promise;
  } catch (err: any) {
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code).toBe(code);
    return err as TRPCError;
  }
  throw new Error(`expected TRPCError ${code}, but the call resolved`);
}

/* ── Tests ─────────────────────────────────────────────────────────── */

describe("admin terminal replay control plane — authorization", () => {
  beforeEach(() => {
    loggedEvents.length = 0;
    vi.clearAllMocks();
    delete process.env.TERMINAL_REPLAY_ADMIN_ENABLED;
  });

  it("1. unauthenticated caller is rejected", async () => {
    const caller = makeCaller(null);
    await expectTrpcCode(caller.terminalQueueFailures({}), "UNAUTHORIZED");
  });

  it("2. authenticated but unverified admin is rejected", async () => {
    const caller = makeCaller({ id: 1, role: "admin" }, false);
    await expectTrpcCode(caller.terminalQueueFailures({}), "UNAUTHORIZED");
  });

  it("3. verified non-admin is rejected", async () => {
    seedDb();
    const caller = makeCaller({ id: 2, role: "user" });
    await expectTrpcCode(caller.terminalQueueFailures({}), "FORBIDDEN");
  });

  it("4. verified admin may list terminal failures even when the switch is disabled", async () => {
    seedDb();
    const caller = makeCaller();
    const rows = await caller.terminalQueueFailures({});
    expect(rows).toHaveLength(1);
  });

  it("5. verified admin may access mutations when the switch is enabled", async () => {
    process.env.TERMINAL_REPLAY_ADMIN_ENABLED = "true";
    seedDb();
    mockedRequest.mockResolvedValue({
      record: {
        id: 1000,
        terminalFailureId: 501,
        replayMode: "publishing_requeue",
        status: "requested",
        requestedByUserId: 1,
        createdAt: new Date("2026-06-01T00:00:00Z"),
      },
      alreadyRequested: false,
    } as any);
    const caller = makeCaller();
    await expect(
      caller.requestTerminalReplay({
        terminalFailureId: 501,
        replayKey: "op:manual:1",
        reason: "operator approved",
      })
    ).resolves.toMatchObject({ replayRequestId: 1000 });
  });
});

describe("admin terminal replay control plane — kill switch", () => {
  beforeEach(() => {
    loggedEvents.length = 0;
    vi.clearAllMocks();
    delete process.env.TERMINAL_REPLAY_ADMIN_ENABLED;
    seedDb();
  });

  it("6-8. requestTerminalReplay: missing / 'false' / '1' are SERVICE_UNAVAILABLE", async () => {
    const caller = makeCaller();
    for (const value of [undefined, "false", "1"] as const) {
      if (value === undefined) delete process.env.TERMINAL_REPLAY_ADMIN_ENABLED;
      else process.env.TERMINAL_REPLAY_ADMIN_ENABLED = value;
      const err = await expectTrpcCode(
        caller.requestTerminalReplay({
          terminalFailureId: 501,
          replayKey: "op:k",
          reason: "r",
        }),
        "SERVICE_UNAVAILABLE"
      );
      expect(err.message).toBe("Terminal replay administration is disabled.");
      expect(mockedRequest).not.toHaveBeenCalled();
    }
  });

  it("9. requestTerminalReplay: exact 'true' permits execution", async () => {
    process.env.TERMINAL_REPLAY_ADMIN_ENABLED = "true";
    mockedRequest.mockResolvedValue({
      record: {
        id: 1000,
        terminalFailureId: 501,
        replayMode: "publishing_requeue",
        status: "requested",
        requestedByUserId: 1,
        createdAt: new Date(),
      },
      alreadyRequested: false,
    } as any);
    const caller = makeCaller();
    await caller.requestTerminalReplay({
      terminalFailureId: 501,
      replayKey: "op:k",
      reason: "r",
    });
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it("10/11. executeTerminalReplay: missing switch blocks; 'true' permits", async () => {
    const caller = makeCaller();
    await expectTrpcCode(caller.executeTerminalReplay({ replayRequestId: 1000 }), "SERVICE_UNAVAILABLE");
    expect(mockedPublishExec).not.toHaveBeenCalled();

    process.env.TERMINAL_REPLAY_ADMIN_ENABLED = "true";
    mockedPublishExec.mockResolvedValue({ outcome: "enqueued", replayRequestId: 1000, replayBullmqJobId: "publish-5" });
    await caller.executeTerminalReplay({ replayRequestId: 1000 });
    expect(mockedPublishExec).toHaveBeenCalledTimes(1);
  });

  it("12/13. reconcileTerminalReplays: missing switch blocks; 'true' permits", async () => {
    const caller = makeCaller();
    await expectTrpcCode(caller.reconcileTerminalReplays({}), "SERVICE_UNAVAILABLE");
    expect(mockedBatch).not.toHaveBeenCalled();

    process.env.TERMINAL_REPLAY_ADMIN_ENABLED = "true";
    mockedBatch.mockResolvedValue({
      selectedCount: 0,
      attemptedCount: 0,
      resolvedCount: 0,
      failedCount: 0,
      pendingCount: 0,
      alreadyTerminalCount: 0,
      errorCount: 0,
      limit: 25,
      items: [],
    });
    await caller.reconcileTerminalReplays({});
    expect(mockedBatch).toHaveBeenCalledTimes(1);
  });
});

describe("admin.terminalQueueFailures", () => {
  beforeEach(() => {
    loggedEvents.length = 0;
    vi.clearAllMocks();
    delete process.env.TERMINAL_REPLAY_ADMIN_ENABLED; // read-only: no switch needed
  });

  it("15/16. default limit 50 and explicit valid limit honored", async () => {
    const world = createFakeDb({
      terminalFailures: Array.from({ length: 60 }, (_, i) =>
        failureRow({ id: i + 1, failedAt: new Date(2026, 0, 1, 0, 0, i) })
      ),
      replayRequests: [],
    });
    mockedGetDb.mockReturnValue(world.db as any);
    const caller = makeCaller();

    expect((await caller.terminalQueueFailures({})).length).toBeLessThanOrEqual(50);
    expect(await caller.terminalQueueFailures({ limit: 7 })).toHaveLength(7);
  });

  it("17/18. invalid limits rejected", async () => {
    seedDb();
    const caller = makeCaller();
    await expect(caller.terminalQueueFailures({ limit: 0 })).rejects.toThrow();
    await expect(caller.terminalQueueFailures({ limit: -2 })).rejects.toThrow();
    await expect(caller.terminalQueueFailures({ limit: 101 })).rejects.toThrow();
    await expect(caller.terminalQueueFailures({ limit: 2.5 })).rejects.toThrow();
  });

  it("19/20. queueName and terminalReason filters honored", async () => {
    const world = createFakeDb({
      terminalFailures: [
        failureRow({ id: 1, queueName: "publishing", terminalReason: "unrecoverable" }),
        failureRow({ id: 2, queueName: "content_generation", terminalReason: "retries_exhausted" }),
      ],
      replayRequests: [],
    });
    mockedGetDb.mockReturnValue(world.db as any);
    const caller = makeCaller();

    const pub = await caller.terminalQueueFailures({ queueName: "publishing" });
    expect(pub.map((r: any) => r.id)).toEqual([1]);
    const exhausted = await caller.terminalQueueFailures({ terminalReason: "retries_exhausted" });
    expect(exhausted.map((r: any) => r.id)).toEqual([2]);
  });

  it("21. deterministic failedAt DESC / id DESC ordering", async () => {
    const world = createFakeDb({
      terminalFailures: [
        failureRow({ id: 1, failedAt: new Date("2026-06-01T10:00:00Z") }),
        failureRow({ id: 2, failedAt: new Date("2026-06-03T10:00:00Z") }),
        failureRow({ id: 3, failedAt: new Date("2026-06-03T10:00:00Z") }),
        failureRow({ id: 4, failedAt: new Date("2026-05-01T10:00:00Z") }),
      ],
      replayRequests: [],
    });
    mockedGetDb.mockReturnValue(world.db as any);
    const caller = makeCaller();

    const rows = await caller.terminalQueueFailures({ limit: 10 });
    expect(rows.map((r: any) => r.id)).toEqual([3, 2, 1, 4]);
  });

  it("22-25. response carries only safe fields; raw errors/credentials omitted; zero mutation", async () => {
    const world = seedDb();
    const caller = makeCaller();

    const rows = await caller.terminalQueueFailures({});
    const row = rows[0] as any;

    expect(Object.keys(row).sort()).toEqual(
      [
        "agentRunId",
        "bullmqJobId",
        "campaignId",
        "errorCode",
        "failedAt",
        "failureKey",
        "id",
        "publishingQueueItemId",
        "queueName",
        "status",
        "terminalReason",
        "userId",
      ].sort()
    );
    expect(JSON.stringify(rows)).not.toContain("raw provider text");
    expect(JSON.stringify(rows)).not.toContain("Bearer");
    expect(JSON.stringify(rows)).not.toContain("should-never-appear");
    expect(world.state.mutations).toBe(0);
  });
});

describe("admin.requestTerminalReplay", () => {
  beforeEach(() => {
    loggedEvents.length = 0;
    vi.clearAllMocks();
    process.env.TERMINAL_REPLAY_ADMIN_ENABLED = "true";
  });

  const validInput = {
    terminalFailureId: 501,
    replayKey: "op:manual:501",
    reason: "operator approved replay",
  };

  function mockD1(alreadyRequested = false) {
    mockedRequest.mockResolvedValue({
      record: {
        id: 1000,
        terminalFailureId: 501,
        replayMode: "publishing_requeue",
        status: "requested",
        requestedByUserId: 1,
        createdAt: new Date("2026-06-01T00:00:00Z"),
        contentRecoveryOwnerTokenHash: "secret-hash",
        lastErrorSummary: "raw error",
      },
      alreadyRequested,
    } as any);
  }

  it("26/27. requestedByUserId always comes from ctx.user.id; client cannot supply it", async () => {
    seedDb();
    mockD1();
    const caller = makeCaller({ id: 7, role: "admin" });

    await caller.requestTerminalReplay(validInput as any);

    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalFailureId: 501,
        replayKey: "op:manual:501",
        reason: "operator approved replay",
        requestedByUserId: 7,
      })
    );
    expect(mockedRequest.mock.calls[0][0]).not.toHaveProperty("requestedByUserId", undefined);
  });

  it("35/36/37. alreadyRequested surfaced; response omits hash and lastErrorSummary", async () => {
    seedDb();
    mockD1(true);
    const caller = makeCaller();

    const result = await caller.requestTerminalReplay(validInput);

    expect(result.alreadyRequested).toBe(true);
    expect(Object.keys(result).sort()).toEqual(
      [
        "alreadyRequested",
        "createdAt",
        "replayMode",
        "replayRequestId",
        "requestedByUserId",
        "status",
        "terminalFailureId",
      ].sort()
    );
    expect(JSON.stringify(result)).not.toContain("secret-hash");
    expect(JSON.stringify(result)).not.toContain("raw error");
  });

  it("31-34. invalid replayKey/reason rejected", async () => {
    seedDb();
    mockD1();
    const caller = makeCaller();
    await expect(
      caller.requestTerminalReplay({ ...validInput, replayKey: "" })
    ).rejects.toThrow();
    await expect(
      caller.requestTerminalReplay({ ...validInput, replayKey: "x".repeat(256) })
    ).rejects.toThrow();
    await expect(caller.requestTerminalReplay({ ...validInput, reason: "" })).rejects.toThrow();
    await expect(
      caller.requestTerminalReplay({ ...validInput, reason: "x".repeat(1001) })
    ).rejects.toThrow();
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it("38. unknown terminal failure maps to NOT_FOUND without raw material", async () => {
    seedDb();
    const { TerminalReplayTargetNotFoundError } = await import("./lib/queue/terminal-replay");
    mockedRequest.mockRejectedValue(new TerminalReplayTargetNotFoundError(501));
    const caller = makeCaller();

    const err = await expectTrpcCode(caller.requestTerminalReplay(validInput), "NOT_FOUND");
    expect(err.message).toBe("Terminal failure not found.");
  });

  it("39. replay-key conflict maps to CONFLICT safely", async () => {
    seedDb();
    const { TerminalReplayKeyConflictError } = await import("./lib/queue/terminal-replay");
    mockedRequest.mockRejectedValue(new TerminalReplayKeyConflictError("op:manual:501"));
    const caller = makeCaller();

    const err = await expectTrpcCode(caller.requestTerminalReplay(validInput), "CONFLICT");
    expect(err.message).toBe("Replay key conflict.");
  });

  it("40. unknown internal error does not leak the raw message", async () => {
    seedDb();
    mockedRequest.mockRejectedValue(new Error("connection lost password=hunter2"));
    const caller = makeCaller();

    const err = await expectTrpcCode(caller.requestTerminalReplay(validInput), "INTERNAL_SERVER_ERROR");
    expect(err.message).toBe("Terminal replay operation failed.");
    expect(err.message).not.toContain("hunter2");
  });
});

describe("admin.executeTerminalReplay", () => {
  beforeEach(() => {
    loggedEvents.length = 0;
    vi.clearAllMocks();
    process.env.TERMINAL_REPLAY_ADMIN_ENABLED = "true";
  });

  it("41/42/44. publishing mode dispatches ONLY D2A with ctx.user.id", async () => {
    seedDb();
    mockedPublishExec.mockResolvedValue({ outcome: "enqueued", replayRequestId: 1000, replayBullmqJobId: "publish-5" });
    const caller = makeCaller({ id: 9, role: "admin" });

    const result = await caller.executeTerminalReplay({ replayRequestId: 1000 });

    expect(mockedPublishExec).toHaveBeenCalledWith({ replayRequestId: 1000, requestedByUserId: 9 });
    expect(mockedContentExec).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "enqueued" });
  });

  it("43/45. content mode dispatches ONLY D2B with ctx.user.id", async () => {
    seedDb({ replayRequests: [replayRequestRow({ replayMode: "content_domain_recovery" })] });
    mockedContentExec.mockResolvedValue({ outcome: "already_enqueued", replayRequestId: 1000, replayBullmqJobId: "content-generation-333" });
    const caller = makeCaller({ id: 9, role: "admin" });

    await caller.executeTerminalReplay({ replayRequestId: 1000 });

    expect(mockedContentExec).toHaveBeenCalledWith({ replayRequestId: 1000, requestedByUserId: 9 });
    expect(mockedPublishExec).not.toHaveBeenCalled();
  });

  it("46. unknown replay id -> NOT_FOUND before any dispatch", async () => {
    seedDb({ replayRequests: [] });
    const caller = makeCaller();

    await expectTrpcCode(caller.executeTerminalReplay({ replayRequestId: 4242 }), "NOT_FOUND");
    expect(mockedPublishExec).not.toHaveBeenCalled();
    expect(mockedContentExec).not.toHaveBeenCalled();
  });

  it("47. unknown replay mode fails closed", async () => {
    seedDb({ replayRequests: [replayRequestRow({ replayMode: "bogus" })] });
    const caller = makeCaller();

    await expectTrpcCode(caller.executeTerminalReplay({ replayRequestId: 1000 }), "BAD_REQUEST");
    expect(mockedPublishExec).not.toHaveBeenCalled();
    expect(mockedContentExec).not.toHaveBeenCalled();
  });

  it("48. D2 operator mismatch maps to FORBIDDEN", async () => {
    seedDb();
    const { PublishingReplayValidationError } = await import("./lib/queue/terminal-replay-executor");
    mockedPublishExec.mockRejectedValue(new PublishingReplayValidationError("operator_mismatch", "raw"));
    const caller = makeCaller();

    await expectTrpcCode(caller.executeTerminalReplay({ replayRequestId: 1000 }), "FORBIDDEN");
  });

  it("49. publishing executor error exposes no raw Redis/provider material", async () => {
    seedDb();
    const { PublishingReplayValidationError } = await import("./lib/queue/terminal-replay-executor");
    mockedPublishExec.mockRejectedValue(
      new PublishingReplayValidationError("state_not_replayable", "ECONNREFUSED 127.0.0.1:6379 token=abc")
    );
    const caller = makeCaller();

    const err = await expectTrpcCode(caller.executeTerminalReplay({ replayRequestId: 1000 }), "BAD_REQUEST");
    expect(err.message).toBe("Terminal replay operation failed.");
    expect(JSON.stringify(err)).not.toContain("ECONNREFUSED");
  });

  it("50. content executor error exposes no ownerToken", async () => {
    seedDb({ replayRequests: [replayRequestRow({ replayMode: "content_domain_recovery" })] });
    mockedContentExec.mockRejectedValue(new Error("claim token abcdef0123 exploded"));
    const caller = makeCaller();

    const err = await expectTrpcCode(caller.executeTerminalReplay({ replayRequestId: 1000 }), "INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(err)).not.toContain("abcdef0123");
  });

  it("52. successful return shape carries no claim credentials", async () => {
    seedDb();
    mockedPublishExec.mockResolvedValue({ outcome: "terminal", replayRequestId: 1000, status: "failed" });
    const caller = makeCaller();

    const result = await caller.executeTerminalReplay({ replayRequestId: 1000 });
    expect(JSON.stringify(result)).not.toContain("ownerToken");
    expect(JSON.stringify(result)).not.toContain("claim");
  });
});

describe("admin.reconcileTerminalReplays", () => {
  beforeEach(() => {
    loggedEvents.length = 0;
    vi.clearAllMocks();
    process.env.TERMINAL_REPLAY_ADMIN_ENABLED = "true";
  });

  const report = {
    selectedCount: 1,
    attemptedCount: 1,
    resolvedCount: 1,
    failedCount: 0,
    pendingCount: 0,
    alreadyTerminalCount: 0,
    errorCount: 0,
    limit: 25,
    items: [{ replayRequestId: 1000, outcome: "resolved", mode: "publishing_requeue" }],
  };

  it("53/55/57. invokes D3B exactly once; omitted limit preserves the D3B default; report returned", async () => {
    seedDb();
    mockedBatch.mockResolvedValue(report as any);
    const caller = makeCaller();

    const result = await caller.reconcileTerminalReplays({});

    expect(mockedBatch).toHaveBeenCalledTimes(1);
    expect(mockedBatch).toHaveBeenCalledWith({});
    expect(result).toEqual(report);
  });

  it("54. explicit limit is passed through", async () => {
    seedDb();
    mockedBatch.mockResolvedValue(report as any);
    const caller = makeCaller();

    await caller.reconcileTerminalReplays({ limit: 7 });

    expect(mockedBatch).toHaveBeenCalledWith({ limit: 7 });
  });

  it("56. invalid limit rejected before D3B invocation", async () => {
    seedDb();
    const caller = makeCaller();
    await expect(caller.reconcileTerminalReplays({ limit: 0 })).rejects.toThrow();
    await expect(caller.reconcileTerminalReplays({ limit: 101 })).rejects.toThrow();
    expect(mockedBatch).not.toHaveBeenCalled();
  });

  it("58. D3B unexpected error is safely mapped", async () => {
    seedDb();
    mockedBatch.mockRejectedValue(new Error("raw db exploded password=xyz"));
    const caller = makeCaller();

    const err = await expectTrpcCode(caller.reconcileTerminalReplays({}), "INTERNAL_SERVER_ERROR");
    expect(err.message).toBe("Terminal replay reconciliation failed.");
    expect(JSON.stringify(err)).not.toContain("xyz");
  });
});

describe("admin terminal replay control plane — structural boundaries", () => {
  it("60-67. adminQuery surface; no scheduler/worker/queue authority; no credential strings", () => {
    const source = readFileSync(new URL("./admin-router.ts", import.meta.url), "utf8");
    for (const name of [
      "terminalQueueFailures",
      "requestTerminalReplay",
      "executeTerminalReplay",
      "reconcileTerminalReplays",
    ]) {
      expect(source).toContain(`${name}: adminQuery`);
    }
    expect(source).not.toContain("setInterval");
    expect(source).not.toContain("setTimeout");
    expect(source).not.toContain("new Worker(");
    expect(source).not.toContain("startContentGenerationWorker");
    expect(source).not.toContain("startPublishingWorker");
    expect(source).not.toContain(".add(");
    expect(source).not.toContain(".remove(");
    expect(source).not.toContain(".retry(");
    expect(source).not.toContain("ownerToken");
    expect(source).not.toContain("publicQuery");
  });
});
