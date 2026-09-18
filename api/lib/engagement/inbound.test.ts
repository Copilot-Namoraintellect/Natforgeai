import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../agents/engagement-agent", () => ({
  handleNewMessage: vi.fn(),
}));

vi.mock("../logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../env", () => ({
  env: {
    metaAppSecret: "test-app-secret",
    isProduction: true,
  },
}));

vi.mock("../billing/credit-engine", () => ({
  isMySqlDuplicateKeyError: (err: unknown) =>
    !!err && typeof err === "object" && (err as any).code === "ER_DUP_ENTRY",
}));

// Tripwire: the inbound pipeline must never dispatch anything outbound.
vi.mock("../integrations/platforms", () => ({
  publishToFacebook: vi.fn(),
  publishToInstagram: vi.fn(),
  publishToLinkedIn: vi.fn(),
  publishToTwitter: vi.fn(),
  sendWhatsAppMessage: vi.fn(),
  sendEmail: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import { handleNewMessage } from "../agents/engagement-agent";
import {
  publishToFacebook,
  publishToInstagram,
  publishToLinkedIn,
  publishToTwitter,
  sendWhatsAppMessage,
  sendEmail,
} from "../integrations/platforms";
import {
  processInboundWebhook,
  recoverStaleEngagementEvents,
  normalizeMetaWebhookPayload,
  verifyMetaWebhookSignature,
  ENGAGEMENT_EVENT_CLAIM_LEASE_MS,
} from "./inbound";

const APP_SECRET = "test-app-secret";

function metaSignature(rawBody: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex")}`;
}

const metaMessagePayload = {
  object: "page",
  entry: [
    {
      id: "page-1",
      messaging: [
        {
          sender: { id: "user-9", name: "Ava" },
          message: { mid: "m-100", text: "Hi, do you deliver to Cape Town?" },
          timestamp: 1700000000,
        },
      ],
    },
  ],
};

interface SeededEvent {
  id?: number;
  provider: string;
  externalEventId: string;
  status?: string;
  claimExpiresAt?: Date | null;
  retryCount?: number;
  threadId?: number | null;
  error?: string | null;
  completedAt?: Date | null;
  integrationId?: number | null;
  campaignId?: number | null;
  userId?: number | null;
  payloadSummary?: Record<string, unknown>;
}

/**
 * Stateful fake for the slice of the database the inbound pipeline touches.
 * The engagement_webhook_events store honours the unique
 * (provider, externalEventId) key and the conditional claim transition, so
 * redelivery/recovery tests exercise real dedup and lease semantics.
 */
function createFakeDb(options: {
  integration?: Record<string, unknown> | null;
  business?: Record<string, unknown> | null;
  existingThread?: Record<string, unknown> | null;
  events?: SeededEvent[];
}) {
  const eventRows = new Map<number, any>();
  const eventKeyToId = new Map<string, number>();
  let nextEventId = 900;

  for (const seed of options.events ?? []) {
    const id = seed.id ?? nextEventId++;
    const row = {
      eventType: "message",
      status: "received",
      userId: null,
      integrationId: null,
      campaignId: null,
      threadId: null,
      actorId: null,
      payloadSummary: {},
      error: null,
      claimedAt: null,
      claimExpiresAt: null,
      completedAt: null,
      retryCount: 0,
      lastSeenAt: null,
      ...seed,
      id,
    };
    eventRows.set(id, row);
    eventKeyToId.set(`${row.provider}:${row.externalEventId}`, id);
  }

  const insertedRows: Array<{ table: string; values: any }> = [];
  const updatedRows: Array<{ table: string; set: any }> = [];

  const db = {
    eventRows,
    insertedRows,
    updatedRows,
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            const name = table[Symbol.for("drizzle:Name")];
            if (name === "social_integrations")
              return options.integration ? [options.integration] : [];
            if (name === "businesses")
              return options.business ? [options.business] : [];
            if (name === "conversation_threads")
              return options.existingThread ? [options.existingThread] : [];
            if (name === "engagement_webhook_events")
              return [...eventRows.values()];
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn((table: any) => ({
      values: vi.fn(async (values: any) => {
        const name = table[Symbol.for("drizzle:Name")];
        insertedRows.push({ table: name, values });
        if (name === "engagement_webhook_events") {
          const key = `${values.provider}:${values.externalEventId}`;
          if (eventKeyToId.has(key)) {
            const err: any = new Error(
              `Duplicate entry '${key}' for key 'engagement_webhook_events_provider_event_idx'`
            );
            err.code = "ER_DUP_ENTRY";
            throw err;
          }
          const id = nextEventId++;
          eventRows.set(id, { ...values, id });
          eventKeyToId.set(key, id);
          return [{ insertId: id }];
        }
        return [{ insertId: 601 }];
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((set: any) => ({
        where: vi.fn(async (cond: any) => {
          const name = table[Symbol.for("drizzle:Name")];
          updatedRows.push({ table: name, set });
          if (name === "engagement_webhook_events") {
            // Locate the row targeted by the where clause. All event updates
            // issued by the pipeline carry eq(id, <rowId>); walk the drizzle
            // condition tree and pick the matching numeric leaf.
            const rowId = findRowIdInCondition(cond, eventRows);
            const row =
              rowId != null ? eventRows.get(rowId) : [...eventRows.values()][0];
            if (!row) return [{ affectedRows: 0 }];
            if (set.status === "processing") {
              // Simulate the conditional claim UPDATE: only incomplete or
              // stale-claimed rows can transition to processing.
              const expired =
                row.claimExpiresAt &&
                new Date(row.claimExpiresAt).getTime() <= Date.now();
              const claimable =
                row.status === "received" ||
                row.status === "failed" ||
                (row.status === "processing" && expired);
              if (!claimable) return [{ affectedRows: 0 }];
            }
            Object.assign(row, set);
            return [{ affectedRows: 1 }];
          }
          return [{ affectedRows: 1 }];
        }),
      })),
    })),
  };
  return db;
}

function findRowIdInCondition(
  cond: any,
  rows: Map<number, any>
): number | null {
  const stack: any[] = [cond];
  const visited = new Set<any>();
  while (stack.length) {
    const node = stack.pop();
    if (node == null || typeof node === "function") continue;
    if (typeof node === "number" && rows.has(node)) return node;
    if (typeof node === "object") {
      if (visited.has(node)) continue;
      visited.add(node);
      if (Array.isArray(node)) stack.push(...node);
      else stack.push(...Object.values(node));
    }
  }
  return null;
}

const connectedIntegration = {
  id: 9,
  userId: 14,
  businessId: 24,
  platform: "facebook",
  status: "connected",
  pageId: "page-1",
  accountName: "Zuto Hub",
};

const business = {
  id: 24,
  name: "Zuto Hub",
  productOrService: "Payout platform",
  brandTone: "friendly",
  mainGoal: "More walk-ins",
};

function verifiedCall(rawBody: string) {
  return processInboundWebhook({
    platform: "facebook",
    rawBody,
    signature: metaSignature(rawBody),
  });
}

describe("engagement inbound webhook pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a valid verified webhook and completes processing exactly once", async () => {
    const rawBody = JSON.stringify(metaMessagePayload);
    const db = createFakeDb({ integration: connectedIntegration, business });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(handleNewMessage).mockResolvedValue({
      threadId: 55,
      result: { output: { shouldEscalate: false } },
    } as any);

    const outcome = await verifiedCall(rawBody);

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.received).toBe(true);
    expect(outcome.dispositions).toEqual([
      {
        kind: "accepted",
        externalEventId: "m-100",
        threadId: 55,
        escalated: false,
      },
    ]);
    expect(handleNewMessage).toHaveBeenCalledTimes(1);
    expect(handleNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 14,
        campaignId: null,
        platform: "facebook",
        externalThreadId: "meta:message:page-1:user-9",
        messageText: "Hi, do you deliver to Cape Town?",
        businessContext: expect.objectContaining({ name: "Zuto Hub" }),
        dedupKey: "facebook:m-100",
      })
    );

    // Lifecycle audit: received → processing → completed.
    const eventInsert = db.insertedRows.find(
      row => row.table === "engagement_webhook_events"
    );
    expect(eventInsert?.values.status).toBe("received");
    expect(eventInsert?.values.userId).toBe(14);
    expect(eventInsert?.values.integrationId).toBe(9);
    expect(eventInsert?.values.externalEventId).toBe("m-100");
    expect(eventInsert?.values.payloadSummary).toMatchObject({
      text: "Hi, do you deliver to Cape Town?",
      externalThreadId: "meta:message:page-1:user-9",
    });

    const claimUpdate = db.updatedRows.find(
      row =>
        row.table === "engagement_webhook_events" &&
        row.set.status === "processing"
    );
    expect(claimUpdate?.set.retryCount).toBe(1);
    expect(
      new Date(claimUpdate?.set.claimExpiresAt as any).getTime()
    ).toBeGreaterThan(Date.now() + ENGAGEMENT_EVENT_CLAIM_LEASE_MS - 60_000);

    const completionUpdate = db.updatedRows.find(
      row =>
        row.table === "engagement_webhook_events" &&
        row.set.status === "completed"
    );
    expect(completionUpdate?.set.threadId).toBe(55);
    expect(completionUpdate?.set.completedAt).toBeInstanceOf(Date);
    expect(completionUpdate?.set.claimExpiresAt).toBeNull();

    const finalRow = [...db.eventRows.values()][0];
    expect(finalRow.status).toBe("completed");
    expect(finalRow.retryCount).toBe(1);
    expect(finalRow.completedAt).toBeInstanceOf(Date);
  });

  it("prevents a simultaneous duplicate from double-processing while the first attempt is in flight", async () => {
    const rawBody = JSON.stringify(metaMessagePayload);
    const db = createFakeDb({ integration: connectedIntegration, business });
    vi.mocked(getDb).mockReturnValue(db as any);

    let releaseProcessing!: (value: any) => void;
    const processingGate = new Promise<any>(resolve => {
      releaseProcessing = resolve;
    });
    vi.mocked(handleNewMessage).mockImplementation(() => processingGate);

    const first = verifiedCall(rawBody);
    await vi.waitFor(() => expect(handleNewMessage).toHaveBeenCalledTimes(1));

    const second = await verifiedCall(rawBody);
    expect(second.dispositions).toEqual([
      {
        kind: "duplicate",
        externalEventId: "m-100",
        reason: "processing_in_flight",
      },
    ]);

    releaseProcessing({
      threadId: 55,
      result: { output: { shouldEscalate: false } },
    });
    const firstOutcome = await first;
    expect(firstOutcome.dispositions).toEqual([
      {
        kind: "accepted",
        externalEventId: "m-100",
        threadId: 55,
        escalated: false,
      },
    ]);

    // handleNewMessage ran at most once for provider + externalEventId.
    expect(handleNewMessage).toHaveBeenCalledTimes(1);
    const finalRow = [...db.eventRows.values()][0];
    expect(finalRow.status).toBe("completed");
  });

  it("acknowledges a redelivered completed event without reprocessing", async () => {
    const rawBody = JSON.stringify(metaMessagePayload);
    const db = createFakeDb({
      integration: connectedIntegration,
      business,
      events: [
        {
          id: 700,
          provider: "facebook",
          externalEventId: "m-100",
          status: "completed",
          threadId: 55,
          retryCount: 1,
          completedAt: new Date(Date.now() - 60_000),
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const outcome = await verifiedCall(rawBody);

    expect(outcome.dispositions).toEqual([
      { kind: "duplicate", externalEventId: "m-100", reason: "completed" },
    ]);
    expect(handleNewMessage).not.toHaveBeenCalled();
    // Duplicate evidence refreshed, no new claim attempted.
    const lastSeenUpdate = db.updatedRows.find(
      row =>
        row.table === "engagement_webhook_events" && "lastSeenAt" in row.set
    );
    expect(lastSeenUpdate).toBeDefined();
    expect(
      db.updatedRows.some(
        row =>
          row.table === "engagement_webhook_events" &&
          row.set.status === "processing"
      )
    ).toBe(false);
  });

  it("keeps legacy pre-recovery 'accepted' rows deduplicated (never reprocessed)", async () => {
    const rawBody = JSON.stringify(metaMessagePayload);
    const db = createFakeDb({
      integration: connectedIntegration,
      business,
      events: [
        {
          id: 701,
          provider: "facebook",
          externalEventId: "m-100",
          status: "accepted",
          threadId: 55,
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const outcome = await verifiedCall(rawBody);

    expect(outcome.dispositions).toEqual([
      { kind: "duplicate", externalEventId: "m-100", reason: "accepted" },
    ]);
    expect(handleNewMessage).not.toHaveBeenCalled();
  });

  it("recovers a failed attempt on redelivery: retries the event and completes it", async () => {
    const rawBody = JSON.stringify(metaMessagePayload);
    const db = createFakeDb({ integration: connectedIntegration, business });
    vi.mocked(getDb).mockReturnValue(db as any);

    vi.mocked(handleNewMessage).mockRejectedValueOnce(
      new Error("engagement agent unavailable")
    );
    vi.mocked(handleNewMessage).mockResolvedValueOnce({
      threadId: 55,
      result: { output: { shouldEscalate: false } },
    } as any);

    const first = await verifiedCall(rawBody);
    expect(first.dispositions).toEqual([
      {
        kind: "error",
        externalEventId: "m-100",
        reason: "engagement agent unavailable",
      },
    ]);

    const failedRow = [...db.eventRows.values()][0];
    expect(failedRow.status).toBe("failed");
    expect(failedRow.error).toBe("engagement agent unavailable");
    expect(failedRow.retryCount).toBe(1);

    const second = await verifiedCall(rawBody);
    expect(second.dispositions).toEqual([
      {
        kind: "accepted",
        externalEventId: "m-100",
        threadId: 55,
        escalated: false,
        recovered: true,
      },
    ]);

    // One processing attempt per delivery, never concurrent, always audited.
    expect(handleNewMessage).toHaveBeenCalledTimes(2);
    const finalRow = [...db.eventRows.values()][0];
    expect(finalRow.status).toBe("completed");
    expect(finalRow.retryCount).toBe(2);
    expect(finalRow.error).toBeNull();
    expect(finalRow.completedAt).toBeInstanceOf(Date);
  });

  it("recovers the crash window between acceptance and processing (stuck 'received' row)", async () => {
    const rawBody = JSON.stringify(metaMessagePayload);
    const db = createFakeDb({
      integration: connectedIntegration,
      business,
      events: [
        {
          id: 702,
          provider: "facebook",
          externalEventId: "m-100",
          status: "received",
          retryCount: 1,
          payloadSummary: {
            text: "Hi, do you deliver to Cape Town?",
            externalThreadId: "meta:message:page-1:user-9",
          },
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(handleNewMessage).mockResolvedValue({
      threadId: 55,
      result: { output: { shouldEscalate: false } },
    } as any);

    const outcome = await verifiedCall(rawBody);

    expect(outcome.dispositions).toEqual([
      {
        kind: "accepted",
        externalEventId: "m-100",
        threadId: 55,
        escalated: false,
        recovered: true,
      },
    ]);
    expect(handleNewMessage).toHaveBeenCalledTimes(1);
  });

  it("reclaims a stale processing claim whose lease expired", async () => {
    const rawBody = JSON.stringify(metaMessagePayload);
    const db = createFakeDb({
      integration: connectedIntegration,
      business,
      events: [
        {
          id: 703,
          provider: "facebook",
          externalEventId: "m-100",
          status: "processing",
          retryCount: 1,
          claimExpiresAt: new Date(Date.now() - 1_000),
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(handleNewMessage).mockResolvedValue({
      threadId: 55,
      result: { output: { shouldEscalate: false } },
    } as any);

    const outcome = await verifiedCall(rawBody);

    expect(outcome.dispositions).toEqual([
      {
        kind: "accepted",
        externalEventId: "m-100",
        threadId: 55,
        escalated: false,
        recovered: true,
      },
    ]);
    expect(handleNewMessage).toHaveBeenCalledTimes(1);
    const finalRow = [...db.eventRows.values()][0];
    expect(finalRow.status).toBe("completed");
    expect(finalRow.retryCount).toBe(2);
  });

  it("never steals a healthy in-flight processing claim", async () => {
    const rawBody = JSON.stringify(metaMessagePayload);
    const healthyLeaseUntil = new Date(Date.now() + 60_000);
    const db = createFakeDb({
      integration: connectedIntegration,
      business,
      events: [
        {
          id: 704,
          provider: "facebook",
          externalEventId: "m-100",
          status: "processing",
          retryCount: 1,
          claimExpiresAt: healthyLeaseUntil,
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const outcome = await verifiedCall(rawBody);

    expect(outcome.dispositions).toEqual([
      {
        kind: "duplicate",
        externalEventId: "m-100",
        reason: "processing_in_flight",
      },
    ]);
    expect(handleNewMessage).not.toHaveBeenCalled();
    const row = [...db.eventRows.values()][0];
    expect(row.retryCount).toBe(1);
    expect(row.claimExpiresAt).toEqual(healthyLeaseUntil);
  });

  it("rejects an invalid signature fail-closed in production", async () => {
    const rawBody = JSON.stringify(metaMessagePayload);
    const db = createFakeDb({ integration: connectedIntegration, business });
    vi.mocked(getDb).mockReturnValue(db as any);

    const outcome = await processInboundWebhook({
      platform: "facebook",
      rawBody,
      signature: "sha256=deadbeef",
    });

    expect(outcome.httpStatus).toBe(401);
    expect(outcome.received).toBe(false);
    expect(handleNewMessage).not.toHaveBeenCalled();
    const rejected = db.insertedRows.find(
      row =>
        row.table === "engagement_webhook_events" &&
        row.values.status === "rejected"
    );
    expect(rejected?.values.error).toBe("invalid_signature");
  });

  it("rejects unknown event shapes without invoking Engagement", async () => {
    const rawBody = JSON.stringify({ object: "page", entry: [{}] });
    const db = createFakeDb({ integration: connectedIntegration });
    vi.mocked(getDb).mockReturnValue(db as any);

    const outcome = await verifiedCall(rawBody);

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.received).toBe(true);
    expect(outcome.dispositions).toEqual([
      {
        kind: "rejected",
        externalEventId: expect.stringContaining("unknown-"),
        reason: "unknown_event",
      },
    ]);
    expect(handleNewMessage).not.toHaveBeenCalled();
    const rejected = db.insertedRows.find(
      row =>
        row.table === "engagement_webhook_events" &&
        row.values.status === "rejected"
    );
    expect(rejected?.values.error).toBe("unknown_event");
  });

  it("rejects events whose integration cannot be resolved", async () => {
    const rawBody = JSON.stringify(metaMessagePayload);
    const db = createFakeDb({ integration: null });
    vi.mocked(getDb).mockReturnValue(db as any);

    const outcome = await verifiedCall(rawBody);

    expect(outcome.dispositions).toEqual([
      {
        kind: "rejected",
        externalEventId: "m-100",
        reason: "no_connected_integration",
      },
    ]);
    expect(handleNewMessage).not.toHaveBeenCalled();
  });

  it("records escalated outcomes on the audit event row", async () => {
    const rawBody = JSON.stringify(metaMessagePayload);
    const db = createFakeDb({ integration: connectedIntegration, business });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(handleNewMessage).mockResolvedValue({
      threadId: 56,
      result: { output: { shouldEscalate: true } },
    } as any);

    const outcome = await verifiedCall(rawBody);

    expect(outcome.dispositions).toEqual([
      {
        kind: "accepted",
        externalEventId: "m-100",
        threadId: 56,
        escalated: true,
      },
    ]);
    const outcomeUpdate = db.updatedRows.find(
      row =>
        row.table === "engagement_webhook_events" &&
        row.set.status === "escalated"
    );
    expect(outcomeUpdate?.set.threadId).toBe(56);
    expect(outcomeUpdate?.set.completedAt).toBeInstanceOf(Date);
  });

  it("preserves campaign linkage from an existing conversation thread", async () => {
    const rawBody = JSON.stringify(metaMessagePayload);
    const db = createFakeDb({
      integration: connectedIntegration,
      business,
      existingThread: {
        id: 77,
        userId: 14,
        campaignId: 30,
        platform: "facebook",
        externalThreadId: "meta:message:page-1:user-9",
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(handleNewMessage).mockResolvedValue({
      threadId: 77,
      result: { output: { shouldEscalate: false } },
    } as any);

    await verifiedCall(rawBody);

    expect(handleNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: 30, userId: 14 })
    );
    const eventInsert = db.insertedRows.find(
      row => row.table === "engagement_webhook_events"
    );
    expect(eventInsert?.values.campaignId).toBe(30);
  });

  it("makes zero outbound platform calls while processing inbound events", async () => {
    const rawBody = JSON.stringify(metaMessagePayload);
    const db = createFakeDb({ integration: connectedIntegration, business });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(handleNewMessage).mockResolvedValue({
      threadId: 55,
      result: { output: { shouldEscalate: false } },
    } as any);

    await verifiedCall(rawBody);

    expect(publishToFacebook).not.toHaveBeenCalled();
    expect(publishToInstagram).not.toHaveBeenCalled();
    expect(publishToLinkedIn).not.toHaveBeenCalled();
    expect(publishToTwitter).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("recoverStaleEngagementEvents (explicit recovery pass)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reprocesses events stuck in 'received' after a crash before claim", async () => {
    const db = createFakeDb({
      integration: connectedIntegration,
      business,
      events: [
        {
          id: 800,
          provider: "facebook",
          externalEventId: "m-100",
          status: "received",
          retryCount: 0,
          integrationId: 9,
          payloadSummary: {
            text: "Hi, do you deliver to Cape Town?",
            externalThreadId: "meta:message:page-1:user-9",
            metadata: { pageId: "page-1", mid: "m-100" },
          },
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(handleNewMessage).mockResolvedValue({
      threadId: 55,
      result: { output: { shouldEscalate: false } },
    } as any);

    const summary = await recoverStaleEngagementEvents();

    expect(summary).toEqual({
      scanned: 1,
      recovered: 1,
      failed: 0,
      skipped: 0,
    });
    expect(handleNewMessage).toHaveBeenCalledTimes(1);
    expect(handleNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 14,
        platform: "facebook",
        externalThreadId: "meta:message:page-1:user-9",
        messageText: "Hi, do you deliver to Cape Town?",
        dedupKey: "facebook:m-100",
      })
    );
    const finalRow = [...db.eventRows.values()][0];
    expect(finalRow.status).toBe("completed");
    expect(finalRow.retryCount).toBe(1);
  });

  it("skips healthy in-flight claims without stealing them", async () => {
    const db = createFakeDb({
      integration: connectedIntegration,
      business,
      events: [
        {
          id: 801,
          provider: "facebook",
          externalEventId: "m-100",
          status: "processing",
          retryCount: 1,
          integrationId: 9,
          claimExpiresAt: new Date(Date.now() + 60_000),
          payloadSummary: {
            text: "Hi, do you deliver to Cape Town?",
            externalThreadId: "meta:message:page-1:user-9",
          },
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const summary = await recoverStaleEngagementEvents();

    expect(summary).toEqual({
      scanned: 1,
      recovered: 0,
      failed: 0,
      skipped: 1,
    });
    expect(handleNewMessage).not.toHaveBeenCalled();
    const row = [...db.eventRows.values()][0];
    expect(row.status).toBe("processing");
    expect(row.retryCount).toBe(1);
  });

  it("reclaims expired 'processing' claims and records incomplete payloads as failed", async () => {
    const db = createFakeDb({
      integration: connectedIntegration,
      business,
      events: [
        {
          id: 802,
          provider: "facebook",
          externalEventId: "m-100",
          status: "processing",
          retryCount: 2,
          integrationId: 9,
          claimExpiresAt: new Date(Date.now() - 1_000),
          payloadSummary: {
            text: "Hi, do you deliver to Cape Town?",
            externalThreadId: "meta:message:page-1:user-9",
          },
        },
        {
          id: 803,
          provider: "facebook",
          externalEventId: "m-200",
          status: "received",
          integrationId: 9,
          payloadSummary: {},
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(handleNewMessage).mockResolvedValue({
      threadId: 55,
      result: { output: { shouldEscalate: false } },
    } as any);

    const summary = await recoverStaleEngagementEvents();

    expect(summary).toEqual({
      scanned: 2,
      recovered: 1,
      failed: 1,
      skipped: 0,
    });
    expect(handleNewMessage).toHaveBeenCalledTimes(1);
    const staleRow = db.eventRows.get(802);
    expect(staleRow.status).toBe("completed");
    expect(staleRow.retryCount).toBe(3);
    const incompleteRow = db.eventRows.get(803);
    expect(incompleteRow.status).toBe("failed");
    expect(incompleteRow.error).toBe("recovery_payload_incomplete");
  });
});

describe("meta webhook primitives", () => {
  it("verifyMetaWebhookSignature accepts correct and rejects tampered signatures", () => {
    const body = JSON.stringify(metaMessagePayload);
    const good = metaSignature(body);
    expect(verifyMetaWebhookSignature(body, good, APP_SECRET)).toBe(true);
    expect(verifyMetaWebhookSignature(body, good, "other-secret")).toBe(false);
    expect(verifyMetaWebhookSignature(body, "", APP_SECRET)).toBe(false);
  });

  it("normalizeMetaWebhookPayload maps messaging and comment shapes", () => {
    const messaging = normalizeMetaWebhookPayload(
      "facebook",
      metaMessagePayload
    );
    expect(messaging).toHaveLength(1);
    expect(messaging[0]).toMatchObject({
      eventType: "message",
      externalEventId: "m-100",
      externalThreadId: "meta:message:page-1:user-9",
      actorId: "user-9",
      integrationPageId: "page-1",
    });

    const comments = normalizeMetaWebhookPayload("facebook", {
      object: "page",
      entry: [
        {
          id: "page-1",
          changes: [
            {
              field: "comments",
              value: {
                id: "c-5",
                from: { id: "user-9", name: "Ava" },
                message: "Great service!",
                post_id: "post-8",
                created_time: "2026-09-18T10:00:00Z",
              },
            },
          ],
        },
      ],
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      eventType: "comment",
      externalEventId: "comment-c-5",
      externalThreadId: "meta:comment:post-8:user-9",
    });

    expect(
      normalizeMetaWebhookPayload("facebook", { object: "page", entry: [{}] })
    ).toEqual([]);
  });
});
