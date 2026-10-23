import { beforeEach, describe, expect, it, vi } from "vitest";

const bullmqState = vi.hoisted(() => ({
  available: false,
  scheduledJobs: [] as Array<{ queueItemId: number; userId: number; platform: string }>,
  scheduleFailures: 0,
}));

vi.mock("../queue/bullmq", () => ({
  isBullMQAvailable: vi.fn(() => bullmqState.available),
  schedulePublishingJob: vi.fn(async (queueItemId: number, userId: number, platform: string) => {
    if (bullmqState.scheduleFailures > 0) {
      bullmqState.scheduleFailures -= 1;
      throw new Error("redis unavailable in fake");
    }
    bullmqState.scheduledJobs.push({ queueItemId, userId, platform });
  }),
}));

import { TRPCError } from "@trpc/server";
import { isBullMQAvailable, schedulePublishingJob } from "../queue/bullmq";
import {
  enqueueCalendarScheduledPublication,
  resolveCalendarIntakeSchedule,
} from "./calendar-schedule-convergence";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

// Operator-aware condition evaluator: drizzle `and(eq(..), ne(..), isNull(..))`
// chunks are walked in order and each column test is bound to ITS OWN operator
// token and parameter — a naive equality walker mispairs `ne`/`isNull` chunks.
function flattenSqlChunks(node: any): any[] {
  if (!node || typeof node !== "object" || !Array.isArray(node.queryChunks)) {
    return node === undefined ? [] : [node];
  }
  const out: any[] = [];
  for (const chunk of node.queryChunks) {
    out.push(...flattenSqlChunks(chunk));
  }
  return out;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (
    chunk &&
    typeof chunk === "object" &&
    (chunk as any).constructor?.name === "StringChunk"
  ) {
    return String((chunk as any).value ?? "");
  }
  return "";
}

function isParamChunk(chunk: unknown): boolean {
  return (
    !!chunk &&
    typeof chunk === "object" &&
    (chunk as any).constructor?.name === "Param" &&
    "value" in (chunk as any)
  );
}

function evaluateCondition(row: Record<string, unknown>, condition: unknown): boolean {
  const chunks = flattenSqlChunks(condition);
  const tests: Array<(r: Record<string, unknown>) => boolean> = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk || typeof chunk !== "object" || typeof (chunk as any).name !== "string") continue;
    const column = (chunk as any).name as string;
    let j = i + 1;
    while (j < chunks.length && chunkText(chunks[j]).trim() === "") j++;
    const opToken = chunkText(chunks[j]);
    if (/is\s+null/i.test(opToken)) {
      tests.push((r) => r[column] === null || r[column] === undefined);
      continue;
    }
    const param = chunks[j + 1];
    const value = isParamChunk(param) ? (param as any).value : undefined;
    if (opToken.includes("!=") || opToken.includes("<>")) {
      tests.push((r) => !valuesEqual(r[column], value));
    } else if (opToken.includes("=")) {
      tests.push((r) => valuesEqual(r[column], value));
    } else {
      // Unknown operator shape: fail closed rather than match blindly.
      return false;
    }
  }
  return tests.every((t) => t(row));
}

interface QueueRowSeed {
  id: number;
  userId: number;
  contentPostId: number;
  platform: string;
  scheduledAt: Date | null;
  status: string;
}

function buildExecutor(existingRows: QueueRowSeed[] = []) {
  const insertedRows: Record<string, unknown[]> = {};
  let nextId = 5000;

  const selectFrom = vi.fn((table: unknown) => {
    const tableName = getTableName(table);
    const chainable: {
      limit: ReturnType<typeof vi.fn>;
      where: ReturnType<typeof vi.fn>;
    } = {
      limit: vi.fn(async (n?: number) => {
        let rows: unknown[] = [];
        if (tableName === "publishing_queue") rows = [...existingRows];
        const condition = (chainable.limit as any)._condition ?? (chainable.where as any)._last;
        if (condition) rows = rows.filter((row) => evaluateCondition(row as Record<string, unknown>, condition));
        return n === 1 ? rows.slice(0, 1) : rows;
      }),
      where: vi.fn((condition: unknown) => {
        (chainable.limit as any)._condition = condition;
        return chainable;
      }),
    };
    return chainable;
  });

  return {
    executor: {
      select: vi.fn(() => ({ from: selectFrom })),
      insert: vi.fn((table: unknown) => {
        const tableName = getTableName(table) ?? "unknown";
        return {
          values: vi.fn(async (vals: any) => {
            const arr = Array.isArray(vals) ? vals : [vals];
            insertedRows[tableName] = [...(insertedRows[tableName] || []), ...arr];
            const id = nextId++;
            // Make the row visible to subsequent replay lookups.
            if (tableName === "publishing_queue") {
              existingRows.push({ id, status: "approved", ...arr[0] } as QueueRowSeed);
            }
            return [{ insertId: id }];
          }),
        };
      }),
    },
    insertedRows,
  };
}

// Fixed reference clock: all canonical instants below are in the future
// relative to it, and DST behaviour of the chosen zones is stable.
const NOW = new Date("2026-06-24T12:00:00Z");

const BASE_INPUT = {
  userId: 18,
  campaignId: 28,
  contentPostId: 125,
  platform: "Instagram",
  scheduledDate: "2027-03-15",
  scheduledTime: "09:30",
  timezone: "UTC",
};

describe("resolveCalendarIntakeSchedule", () => {
  it("resolves wall time in a non-UTC zone to the canonical UTC instant", () => {
    const schedule = resolveCalendarIntakeSchedule({
      ...BASE_INPUT,
      timezone: "America/New_York", // UTC-4 on 2027-03-15 (DST)
      now: NOW,
    });
    expect(schedule.mode).toBe("scheduled");
    expect(schedule.scheduledAtUtcIso).toBe("2027-03-15T13:30:00.000Z");
  });

  it("defaults a missing timezone to UTC", () => {
    const schedule = resolveCalendarIntakeSchedule({
      scheduledDate: "2027-03-15",
      scheduledTime: "09:30",
      now: NOW,
    });
    expect(schedule.scheduledAtUtcIso).toBe("2027-03-15T09:30:00.000Z");
  });

  it("treats a missing wall time as an explicit immediate publication", () => {
    const schedule = resolveCalendarIntakeSchedule({
      scheduledDate: "2027-03-15",
      now: NOW,
    });
    expect(schedule.mode).toBe("immediate");
    expect(schedule.scheduledAtUtcIso).toBeNull();
  });

  it("fails closed on a past instant (not-before policy)", () => {
    expect(() =>
      resolveCalendarIntakeSchedule({
        scheduledDate: "2026-01-01",
        scheduledTime: "09:30",
        timezone: "UTC",
        now: NOW,
      })
    ).toThrow(TRPCError);
  });

  it("fails closed on an unknown timezone", () => {
    expect(() =>
      resolveCalendarIntakeSchedule({
        scheduledDate: "2027-03-15",
        scheduledTime: "09:30",
        timezone: "Mars/Olympus_Mons",
        now: NOW,
      })
    ).toThrow(/invalid timezone/i);
  });

  it("fails closed on a nonexistent wall time (DST gap)", () => {
    // 2027-03-14 02:30 does not exist in America/New_York (spring-forward).
    expect(() =>
      resolveCalendarIntakeSchedule({
        scheduledDate: "2027-03-14",
        scheduledTime: "02:30",
        timezone: "America/New_York",
        now: NOW,
      })
    ).toThrow(/does not exist/);
  });
});

describe("enqueueCalendarScheduledPublication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bullmqState.available = false;
    bullmqState.scheduledJobs = [];
    bullmqState.scheduleFailures = 0;
  });

  it("inserts one approved queue row with the canonical schedule and normalized platform", async () => {
    const { executor, insertedRows } = buildExecutor();

    const result = await enqueueCalendarScheduledPublication({
      executor: executor as any,
      ...BASE_INPUT,
      timezone: "Africa/Johannesburg", // UTC+2, no DST
      now: NOW,
    });

    expect(result.created).toBe(true);
    const rows = insertedRows.publishing_queue as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: 18,
      campaignId: 28,
      contentPostId: 125,
      platform: "instagram",
      status: "approved",
      approvalRequired: false,
    });
    expect(rows[0].scheduledAt.toISOString()).toBe("2027-03-15T07:30:00.000Z");
    expect(isBullMQAvailable()).toBe(false);
    expect(schedulePublishingJob).not.toHaveBeenCalled();
  });

  it("schedules the BullMQ job when Redis is available and swallows scheduling errors", async () => {
    bullmqState.available = true;
    const { executor } = buildExecutor();

    const result = await enqueueCalendarScheduledPublication({
      executor: executor as any,
      ...BASE_INPUT,
      now: NOW,
    });

    expect(schedulePublishingJob).toHaveBeenCalledTimes(1);
    expect(bullmqState.scheduledJobs[0]).toMatchObject({
      queueItemId: result.queueItemId,
      userId: 18,
      platform: "instagram",
    });

    // BullMQ failure must not fail the intake — the due-scan still executes it.
    bullmqState.scheduleFailures = 1;
    const second = buildExecutor();
    const replay = await enqueueCalendarScheduledPublication({
      executor: second.executor as any,
      ...BASE_INPUT,
      contentPostId: 126,
      now: NOW,
    });
    expect(replay.created).toBe(true);
    expect(bullmqState.scheduledJobs).toHaveLength(1); // first job only
  });

  it("does not schedule a BullMQ job for immediate rows (due-scan owns them)", async () => {
    bullmqState.available = true;
    const { executor } = buildExecutor();

    await enqueueCalendarScheduledPublication({
      executor: executor as any,
      ...BASE_INPUT,
      scheduledTime: null,
      now: NOW,
    });

    expect(schedulePublishingJob).not.toHaveBeenCalled();
  });

  it("collapses retries onto the same live queue row (idempotent replay)", async () => {
    const { executor, insertedRows } = buildExecutor();

    const first = await enqueueCalendarScheduledPublication({
      executor: executor as any,
      ...BASE_INPUT,
      now: NOW,
    });
    const retry = await enqueueCalendarScheduledPublication({
      executor: executor as any,
      ...BASE_INPUT,
      now: NOW,
    });

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.queueItemId).toBe(first.queueItemId);
    expect(insertedRows.publishing_queue).toHaveLength(1);
  });

  it("allows re-intake after a terminal failure (failed rows are excluded from the replay key)", async () => {
    const existing: QueueRowSeed[] = [
      {
        id: 41,
        userId: 18,
        contentPostId: 125,
        platform: "instagram",
        scheduledAt: new Date("2027-03-15T09:30:00Z"),
        status: "failed",
      },
    ];
    const { executor, insertedRows } = buildExecutor(existing);

    const result = await enqueueCalendarScheduledPublication({
      executor: executor as any,
      ...BASE_INPUT,
      now: NOW,
    });

    expect(result.created).toBe(true);
    expect(result.queueItemId).not.toBe(41);
    expect(insertedRows.publishing_queue).toHaveLength(1);
  });

  it("fails closed without inserting when the instant is in the past", async () => {
    const { executor, insertedRows } = buildExecutor();

    await expect(
      enqueueCalendarScheduledPublication({
        executor: executor as any,
        ...BASE_INPUT,
        scheduledDate: "2026-01-01",
        now: NOW,
      })
    ).rejects.toThrow(/in the past/i);

    expect(insertedRows.publishing_queue ?? []).toHaveLength(0);
  });
});
