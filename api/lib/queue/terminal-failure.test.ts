import { describe, expect, it, vi, beforeEach } from "vitest";
import { UnrecoverableError } from "bullmq";

vi.mock("../alerts", () => ({
  createAlert: vi.fn(async () => ({ id: 1 })),
}));

import {
  TerminalFailureIdentityConflictError,
  buildTerminalFailureKey,
  classifyQueueJobFailure,
  contentGenerationTerminalContext,
  handleTerminalContentGenerationFailure,
  handleTerminalPublishingFailure,
  isMySqlDuplicateKeyError,
  persistTerminalQueueFailure,
  publishingTerminalContext,
  runContainedTerminalPersistence,
  sanitizeErrorSummary,
} from "./terminal-failure";
import type { TerminalFailureExecutor } from "./terminal-failure";

/** In-memory executor: Map keyed by failureKey acts as the unique constraint. */
function createFakeExecutor(seedRows: any[] = []) {
  const rows = new Map<string, any>();
  for (const row of seedRows) rows.set(row.failureKey, { ...row });

  const insertValues = vi.fn(async (values: any) => {
    if (rows.has(values.failureKey)) {
      const err: any = new Error("Duplicate entry for key 'qtf_failure_key_idx'");
      err.code = "ER_DUP_ENTRY";
      err.errno = 1062;
      throw err;
    }
    const id = rows.size + 1;
    const row = {
      id,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      ...values,
    };
    rows.set(values.failureKey, row);
    return [{ insertId: id, affectedRows: 1 }];
  });

  const executor = {
    insert: vi.fn((_table: any) => ({ values: insertValues })),
    select: vi.fn((_table: any) => ({
      from: vi.fn((_t: any) => ({
        where: vi.fn((_cond: any) => ({
          limit: vi.fn(async (_n: number) => Array.from(rows.values())),
        })),
      })),
    })),
  } as unknown as TerminalFailureExecutor;

  return { executor, rows };
}

function baseInput(overrides: Partial<any> = {}) {
  return {
    queueName: "publishing" as const,
    bullmqJobId: "publish-5",
    terminalReason: "retries_exhausted" as const,
    attemptsMade: 3,
    attemptsConfigured: 3,
    userId: 18,
    campaignId: null,
    publishingQueueItemId: 5,
    agentRunId: null,
    errorName: "Error",
    errorCode: null,
    errorSummary: "boom",
    failedAt: new Date("2026-06-01T12:00:00.000Z"),
    ...overrides,
  };
}

describe("classifyQueueJobFailure", () => {
  it("ordinary error with attempts remaining is transient", () => {
    expect(
      classifyQueueJobFailure({ attemptsMade: 1, attemptsConfigured: 3, unrecoverable: false })
    ).toEqual({ terminal: false });
  });

  it("ordinary error with attempts exhausted is terminal retries_exhausted", () => {
    expect(
      classifyQueueJobFailure({ attemptsMade: 3, attemptsConfigured: 3, unrecoverable: false })
    ).toEqual({ terminal: true, terminalReason: "retries_exhausted" });
  });

  it("UnrecoverableError is terminal immediately even with attempts remaining", () => {
    expect(
      classifyQueueJobFailure({ attemptsMade: 1, attemptsConfigured: 3, unrecoverable: true })
    ).toEqual({ terminal: true, terminalReason: "unrecoverable" });
  });

  it("absent attemptsConfigured uses effective single-attempt semantics", () => {
    expect(classifyQueueJobFailure({ attemptsMade: 1, unrecoverable: false })).toEqual({
      terminal: true,
      terminalReason: "retries_exhausted",
    });
    expect(
      classifyQueueJobFailure({ attemptsMade: 1, attemptsConfigured: null, unrecoverable: false })
    ).toEqual({ terminal: true, terminalReason: "retries_exhausted" });
  });

  it("rejects malformed negative/NaN attempt data", () => {
    expect(() =>
      classifyQueueJobFailure({ attemptsMade: Number.NaN, attemptsConfigured: 3, unrecoverable: false })
    ).toThrow(TypeError);
    expect(() =>
      classifyQueueJobFailure({ attemptsMade: -1, attemptsConfigured: 3, unrecoverable: false })
    ).toThrow(TypeError);
    expect(() =>
      classifyQueueJobFailure({ attemptsMade: 1, attemptsConfigured: -2, unrecoverable: false })
    ).toThrow(TypeError);
    expect(() =>
      classifyQueueJobFailure({ attemptsMade: 1.5, attemptsConfigured: 3, unrecoverable: false })
    ).toThrow(TypeError);
  });
});

describe("terminal failure identity", () => {
  it("failureKey is deterministic", () => {
    expect(buildTerminalFailureKey("publishing", "publish-5")).toBe(
      buildTerminalFailureKey("publishing", "publish-5")
    );
    expect(buildTerminalFailureKey("publishing", "publish-5")).toBe("qtf:v1:publishing:publish-5");
  });

  it("queue namespaces prevent cross-queue collision for identical textual job ids", () => {
    const publishing = buildTerminalFailureKey("publishing", "42");
    const content = buildTerminalFailureKey("content_generation", "42");
    expect(publishing).not.toBe(content);
  });
});

describe("sanitizeErrorSummary", () => {
  it("redacts tokens, bearer values, and credential material", () => {
    const summary = sanitizeErrorSummary(
      'OpenAI error token=sk-live-abc123def456ghi789 Bearer eyJhbGciOiJIUzI1NiJ9.api_key: "abc" password: hunter2 Authorization: Bearer tok123 credential=secretvalue'
    );
    expect(summary).not.toContain("sk-live-abc123def456ghi789");
    expect(summary).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(summary).not.toContain("hunter2");
    expect(summary).not.toContain("tok123");
    expect(summary).toContain("[redacted]");
  });

  it("bounds length and returns null for empty input", () => {
    expect(sanitizeErrorSummary("x".repeat(5000))!.length).toBeLessThanOrEqual(1011);
    expect(sanitizeErrorSummary(null)).toBeNull();
    expect(sanitizeErrorSummary("")).toBeNull();
  });

  it("never persists stack traces", () => {
    const err = new Error("provider exploded");
    err.stack = "Error: provider exploded\n    at evil (/app/node_modules/pkg/index.js:1:1)";
    const summary = sanitizeErrorSummary(err.message);
    expect(summary).toBe("provider exploded");
    expect(summary).not.toContain("at evil");
  });
});

describe("persistTerminalQueueFailure", () => {
  it("first terminal event creates exactly one open record with controlled identifiers", async () => {
    const { executor, rows } = createFakeExecutor();

    const { record, alreadyRecorded } = await persistTerminalQueueFailure(
      baseInput(),
      executor
    );

    expect(alreadyRecorded).toBe(false);
    expect(rows.size).toBe(1);
    expect(record.status).toBe("open");
    expect(record.failureKey).toBe("qtf:v1:publishing:publish-5");
    expect(record.queueName).toBe("publishing");
    expect(record.userId).toBe(18);
    expect(record.publishingQueueItemId).toBe(5);
    expect(record.agentRunId).toBeNull();
  });

  it("exact duplicate replay reuses the existing row", async () => {
    const { executor, rows } = createFakeExecutor();

    const first = await persistTerminalQueueFailure(baseInput(), executor);
    const second = await persistTerminalQueueFailure(baseInput(), executor);

    expect(first.alreadyRecorded).toBe(false);
    expect(second.alreadyRecorded).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(rows.size).toBe(1);
  });

  it("duplicate-key race reuses the committed matching record", async () => {
    const key = buildTerminalFailureKey("publishing", "publish-9");
    const committed = {
      ...baseInput({ bullmqJobId: "publish-9", failureKey: key, userId: 7 }),
      id: 55,
    };
    const { executor, rows } = createFakeExecutor([committed]);

    const result = await persistTerminalQueueFailure(
      baseInput({ bullmqJobId: "publish-9", userId: 7 }),
      executor
    );

    expect(result.alreadyRecorded).toBe(true);
    expect(result.record.id).toBe(55);
    expect(rows.size).toBe(1);
  });

  it("conflicting identity for the same failureKey fails closed", async () => {
    const key = buildTerminalFailureKey("publishing", "publish-9");
    const committed = {
      ...baseInput({ bullmqJobId: "publish-9", failureKey: key, userId: 7 }),
      id: 55,
    };
    const { executor } = createFakeExecutor([committed]);

    await expect(
      persistTerminalQueueFailure(baseInput({ bullmqJobId: "publish-9", userId: 999 }), executor)
    ).rejects.toBeInstanceOf(TerminalFailureIdentityConflictError);
  });

  it("explicit failedAt survives unchanged", async () => {
    const { executor } = createFakeExecutor();
    const failedAt = new Date("2026-03-04T05:06:07.890Z");

    const first = await persistTerminalQueueFailure(baseInput({ failedAt }), executor);
    const replay = await persistTerminalQueueFailure(baseInput({ failedAt }), executor);

    expect(first.record.failedAt).toEqual(failedAt);
    expect(replay.record.failedAt).toEqual(failedAt);
  });

  it("isMySqlDuplicateKeyError detects ER_DUP_ENTRY including causes", () => {
    const err: any = new Error("dup");
    err.code = "ER_DUP_ENTRY";
    expect(isMySqlDuplicateKeyError(err)).toBe(true);
    const wrapped: any = new Error("outer", { cause: { errno: 1062 } });
    expect(isMySqlDuplicateKeyError(wrapped)).toBe(true);
    expect(isMySqlDuplicateKeyError(new Error("nope"))).toBe(false);
  });
});

describe("queue context mapping", () => {
  it("publishing context maps controlled identifiers only", () => {
    const ctx = publishingTerminalContext(
      { id: "publish-5" },
      { queueItemId: 5, userId: 18, platform: "Instagram" }
    );
    expect(ctx).toEqual({
      queueName: "publishing",
      bullmqJobId: "publish-5",
      userId: 18,
      campaignId: null,
      publishingQueueItemId: 5,
      agentRunId: null,
    });
  });

  it("content-generation context maps controlled identifiers only", () => {
    const ctx = contentGenerationTerminalContext(
      { id: "content-generation-333" },
      {
        jobId: 333,
        userId: 18,
        campaignId: 30,
        regenerate: false,
        claimId: 91,
        ownerToken: "secret-token-that-must-not-be-persisted",
      }
    );
    expect(ctx).toEqual({
      queueName: "content_generation",
      bullmqJobId: "content-generation-333",
      userId: 18,
      campaignId: 30,
      publishingQueueItemId: null,
      agentRunId: 333,
    });
  });
});

describe("terminal failure handlers", () => {
  it("publishing transient failure does not persist", async () => {
    const { executor, rows } = createFakeExecutor();
    const outcome = await handleTerminalPublishingFailure({
      job: {
        id: "publish-5",
        attemptsMade: 1,
        opts: { attempts: 3 },
        data: { queueItemId: 5, userId: 18, platform: "Instagram" },
      },
      error: new Error("network blip"),
      executor,
    });
    expect(outcome).toEqual({ kind: "transient" });
    expect(rows.size).toBe(0);
  });

  it("publishing UnrecoverableError persists immediately with sanitized material", async () => {
    const { executor, rows } = createFakeExecutor();
    const err: any = new UnrecoverableError("precondition failed token=sk-supersecret");
    err.code = "ERR_CODE";
    err.stack = "UnrecoverableError: x\n    at hidden (file.js:1:1)";

    const outcome = await handleTerminalPublishingFailure({
      job: {
        id: "publish-5",
        attemptsMade: 1,
        opts: { attempts: 3 },
        data: { queueItemId: 5, userId: 18, platform: "Instagram" },
      },
      error: err,
      executor,
    });

    expect(outcome.kind).toBe("recorded");
    expect(rows.size).toBe(1);
    const row = Array.from(rows.values())[0];
    expect(row.terminalReason).toBe("unrecoverable");
    expect(row.attemptsMade).toBe(1);
    expect(row.attemptsConfigured).toBe(3);
    expect(row.errorSummary).not.toContain("sk-supersecret");
    expect(row.errorSummary).not.toContain("at hidden");
    expect(row.errorName).toBe("UnrecoverableError");
    expect(row.errorCode).toBe("ERR_CODE");
  });

  it("content-generation retry-exhausted failure persists with agentRunId identity", async () => {
    const { executor, rows } = createFakeExecutor();
    const outcome = await handleTerminalContentGenerationFailure({
      job: {
        id: "content-generation-333",
        attemptsMade: 1,
        opts: { attempts: 1 },
        data: { jobId: 333, userId: 18, campaignId: 30, regenerate: false },
      },
      error: new Error("model exploded"),
      executor,
    });

    expect(outcome.kind).toBe("recorded");
    const row = Array.from(rows.values())[0];
    expect(row.queueName).toBe("content_generation");
    expect(row.terminalReason).toBe("retries_exhausted");
    expect(row.agentRunId).toBe(333);
    expect(row.campaignId).toBe(30);
    expect(row.publishingQueueItemId).toBeNull();
  });

  it("missing job (stalled-and-removed) is treated as transient evidence-wise", async () => {
    const { executor, rows } = createFakeExecutor();
    const outcome = await handleTerminalPublishingFailure({
      job: undefined,
      error: new Error("stalled"),
      executor,
    });
    expect(outcome).toEqual({ kind: "transient" });
    expect(rows.size).toBe(0);
  });
});

describe("runContainedTerminalPersistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persistence failure is contained and emits a critical operational alert", async () => {
    const { createAlert } = await import("../alerts");
    const attempt = vi.fn(async () => {
      throw new Error("db unreachable");
    });

    await expect(
      runContainedTerminalPersistence(attempt, { queueName: "publishing", bullmqJobId: "publish-5" })
    ).resolves.toBeUndefined();

    expect(createAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "critical", category: "queue" })
    );
  });

  it("successful persistence emits no additional alert", async () => {
    const { createAlert } = await import("../alerts");
    await runContainedTerminalPersistence(async () => ({ kind: "transient" }), {
      queueName: "content_generation",
      bullmqJobId: "content-generation-1",
    });
    expect(createAlert).not.toHaveBeenCalled();
  });
});
