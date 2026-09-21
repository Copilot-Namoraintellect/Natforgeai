import { describe, expect, it, vi, beforeEach } from "vitest";
import { UnrecoverableError } from "bullmq";

vi.mock("../alerts", () => ({
  createAlert: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { createAlert } from "../alerts";
import { getDb } from "../../queries/connection";
import {
  handleContentGenerationWorkerFailed,
  handlePublishingWorkerFailed,
} from "./bullmq";

/** In-memory db double: Map keyed by failureKey acts as the unique constraint. */
function createFakeDb(seedRows: any[] = []) {
  const rows = new Map<string, any>();
  for (const row of seedRows) rows.set(row.failureKey, { ...row });

  const db = {
    insert: vi.fn((_table: any) => ({
      values: vi.fn(async (values: any) => {
        if (rows.has(values.failureKey)) {
          const err: any = new Error("Duplicate entry for key 'qtf_failure_key_idx'");
          err.code = "ER_DUP_ENTRY";
          err.errno = 1062;
          throw err;
        }
        const id = rows.size + 1;
        rows.set(values.failureKey, {
          id,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
          ...values,
        });
        return [{ insertId: id, affectedRows: 1 }];
      }),
    })),
    select: vi.fn((_table: any) => ({
      from: vi.fn((_t: any) => ({
        where: vi.fn((_cond: any) => ({
          limit: vi.fn(async (_n: number) => Array.from(rows.values())),
        })),
      })),
    })),
  };

  return { db, rows };
}

function publishingJob(attemptsMade: number, attempts: number) {
  return {
    id: "publish-5",
    attemptsMade,
    opts: { attempts },
    data: { queueItemId: 5, userId: 18, platform: "Instagram" },
  } as any;
}

function contentJob(attemptsMade: number, attempts: number) {
  return {
    id: "content-generation-333",
    attemptsMade,
    opts: { attempts },
    data: { jobId: 333, userId: 18, campaignId: 30, regenerate: false },
  } as any;
}

describe("BullMQ failed listener terminal-failure integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishing transient failed event does NOT persist dead-letter evidence", async () => {
    const { db, rows } = createFakeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    await handlePublishingWorkerFailed(publishingJob(1, 3), new Error("network blip"));

    expect(rows.size).toBe(0);
    // Existing warning alert behavior preserved, no critical alert added.
    expect(createAlert).toHaveBeenCalledTimes(1);
    expect(createAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "warning", category: "worker" })
    );
  });

  it("publishing retry-exhausted failed event persists exactly one durable record", async () => {
    const { db, rows } = createFakeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    await handlePublishingWorkerFailed(publishingJob(3, 3), new Error("kept failing"));

    expect(rows.size).toBe(1);
    const row = Array.from(rows.values())[0];
    expect(row.queueName).toBe("publishing");
    expect(row.bullmqJobId).toBe("publish-5");
    expect(row.terminalReason).toBe("retries_exhausted");
    expect(row.attemptsMade).toBe(3);
    expect(row.attemptsConfigured).toBe(3);
    expect(row.userId).toBe(18);
    expect(row.publishingQueueItemId).toBe(5);
    expect(row.agentRunId).toBeNull();
    expect(row.status).toBe("open");
  });

  it("publishing UnrecoverableError persists immediately even with attempts remaining", async () => {
    const { db, rows } = createFakeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    await handlePublishingWorkerFailed(
      publishingJob(1, 3),
      new UnrecoverableError("permanent readiness rejection")
    );

    expect(rows.size).toBe(1);
    const row = Array.from(rows.values())[0];
    expect(row.terminalReason).toBe("unrecoverable");
    expect(row.attemptsMade).toBe(1);
  });

  it("content-generation transient failed event does NOT persist dead-letter evidence", async () => {
    const { db, rows } = createFakeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    await handleContentGenerationWorkerFailed(contentJob(1, 3), new Error("rate limited"));

    expect(rows.size).toBe(0);
    expect(createAlert).toHaveBeenCalledTimes(1);
  });

  it("content-generation retry-exhausted failed event persists exactly one durable record", async () => {
    const { db, rows } = createFakeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    await handleContentGenerationWorkerFailed(contentJob(1, 1), new Error("model exploded"));

    expect(rows.size).toBe(1);
    const row = Array.from(rows.values())[0];
    expect(row.queueName).toBe("content_generation");
    expect(row.terminalReason).toBe("retries_exhausted");
    expect(row.agentRunId).toBe(333);
    expect(row.campaignId).toBe(30);
    expect(row.publishingQueueItemId).toBeNull();
  });

  it("duplicate terminal callback does not create duplicate durable evidence", async () => {
    const { db, rows } = createFakeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    await handlePublishingWorkerFailed(publishingJob(3, 3), new Error("kept failing"));
    await handlePublishingWorkerFailed(publishingJob(3, 3), new Error("kept failing"));

    expect(rows.size).toBe(1);
  });

  it("persistence failure is contained and emits a critical operational alert", async () => {
    const failingDb = {
      insert: vi.fn((_table: any) => ({
        values: vi.fn(async () => {
          throw new Error("connection lost");
        }),
      })),
      select: vi.fn(),
    };
    vi.mocked(getDb).mockReturnValue(failingDb as any);

    await expect(
      handlePublishingWorkerFailed(publishingJob(3, 3), new Error("kept failing"))
    ).resolves.toBeUndefined();

    const alerts = vi.mocked(createAlert).mock.calls.map((c) => c[0] as any);
    expect(alerts.some((a) => a.severity === "critical" && a.category === "queue")).toBe(true);
  });

  it("failed event with undefined job preserves existing alert and persists nothing", async () => {
    const { db, rows } = createFakeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    await handlePublishingWorkerFailed(undefined, new Error("stalled past limit"));

    expect(rows.size).toBe(0);
    expect(createAlert).toHaveBeenCalledTimes(1);
  });
});
