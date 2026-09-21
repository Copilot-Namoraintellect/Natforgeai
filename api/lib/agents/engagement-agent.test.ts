/**
 * Engagement agent — sensitive-reply approval bridge tests (WBS14B).
 *
 * The database is a stateful in-memory fake (getDb is mocked) and the durable
 * approval store runs on an injected in-memory executor, so no real database
 * is mutated and the zero-outbound invariant can be asserted directly against
 * the platform-sender tripwire mocks.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./runner", () => ({
  runAgent: vi.fn(),
}));

// Tripwire: the engagement pipeline must never dispatch anything outbound.
vi.mock("../integrations/platforms", () => ({
  publishToFacebook: vi.fn(),
  publishToInstagram: vi.fn(),
  publishToLinkedIn: vi.fn(),
  publishToTwitter: vi.fn(),
  sendWhatsAppMessage: vi.fn(),
  sendEmail: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import { runAgent } from "./runner";
import {
  publishToFacebook,
  publishToInstagram,
  publishToLinkedIn,
  publishToTwitter,
  sendWhatsAppMessage,
  sendEmail,
} from "../integrations/platforms";
import { conversationThreads, conversationMessages } from "@db/schema";
import { handleNewMessage, generateReply } from "./engagement-agent";
import type { SensitiveReplyApprovalExecutor } from "../engagement/sensitive-reply-approval-store";

const EVENT_DEDUP_KEY = "meta:m_agent_bridge_event_1";

function duplicateKeyError(): Error {
  const err = new Error("Duplicate entry for key 'thread_dedup'");
  (err as any).code = "ER_DUP_ENTRY";
  return err;
}

/** Stateful fake for the slice of the database the engagement agent touches. */
function createFakeEngagementDb() {
  const threads = new Map<number, any>();
  const messages: any[] = [];
  const messageKeys = new Set<string>();
  let nextThreadId = 500;
  let nextMessageId = 1;
  let currentThreadId: number | null = null;

  const selectRows = (table: unknown): any[] => {
    if (table === conversationThreads) return [...threads.values()];
    if (table === conversationMessages) return [...messages];
    return [];
  };

  const insertInto = async (table: unknown, row: any) => {
    if (table === conversationThreads) {
      const id = nextThreadId++;
      threads.set(id, {
        id,
        aiHandled: false,
        escalationRequired: false,
        ...row,
      });
      currentThreadId = id;
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (table === conversationMessages) {
      if (row.dedupKey != null) {
        const key = `${row.threadId}:${row.dedupKey}`;
        if (messageKeys.has(key)) throw duplicateKeyError();
        messageKeys.add(key);
      }
      messages.push({ id: nextMessageId++, ...row });
      return [{ insertId: nextMessageId - 1, affectedRows: 1 }];
    }
    return [{ insertId: 1, affectedRows: 1 }];
  };

  const fakeDb: any = {
    select: () => ({
      from: (table: unknown) => {
        const chain: any = {
          where: () => chain,
          orderBy: () => chain,
          limit: async () => selectRows(table),
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: (row: any) => insertInto(table, row),
    }),
    update: (table: unknown) => ({
      set: (patch: any) => ({
        where: async () => {
          if (table === conversationThreads && currentThreadId != null) {
            const thread = threads.get(currentThreadId);
            if (thread) Object.assign(thread, patch);
          }
          return [{ affectedRows: 1 }];
        },
      }),
    }),
  };

  return { fakeDb, threads, messages };
}

/** In-memory approval executor mirroring the durable store's contract. */
function createApprovalExecutorSpy() {
  const rows = new Map<string, Record<string, unknown>>();
  let nextId = 1;
  let inserts = 0;

  const executor: SensitiveReplyApprovalExecutor & {
    insertCount: () => number;
    rowCount: () => number;
  } = {
    async findByIdempotencyKey(idempotencyKey) {
      return (rows.get(idempotencyKey) as never) ?? null;
    },
    async insertPendingApproval(row) {
      inserts += 1;
      rows.set(row.idempotencyKey, {
        id: nextId++,
        status: "pending",
        ...row,
        context: row.context,
      });
      return nextId - 1;
    },
    insertCount() {
      return inserts;
    },
    rowCount() {
      return rows.size;
    },
  };

  return { executor, rows };
}

function escalateOutput() {
  return {
    output: {
      reply:
        "I am sorry about this — let me bring in a specialist to help you.",
      shouldQualify: false,
      shouldEscalate: true,
      escalationReason: "Contact is unhappy and asked for a manager.",
      sentiment: "negative",
      extractedData: undefined,
    },
  };
}

function calmOutput() {
  return {
    output: {
      reply: "Yes, we deliver to Cape Town every weekday.",
      shouldQualify: false,
      shouldEscalate: false,
      escalationReason: undefined,
      sentiment: "positive",
      extractedData: undefined,
    },
  };
}

describe("engagement agent sensitive-reply approval bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates exactly one pending approval for an escalated inbound event", async () => {
    const { fakeDb, messages } = createFakeEngagementDb();
    vi.mocked(getDb).mockReturnValue(fakeDb);
    vi.mocked(runAgent).mockResolvedValue(escalateOutput() as any);
    const { executor, rows } = createApprovalExecutorSpy();

    await handleNewMessage({
      userId: 42,
      campaignId: null,
      platform: "instagram",
      externalThreadId: "meta:message:page-1:user-9",
      messageText: "I want to speak to a manager!",
      businessContext: { name: "Test Business" },
      dedupKey: EVENT_DEDUP_KEY,
      approvalExecutor: executor,
    });

    expect(executor.rowCount()).toBe(1);
    expect(executor.insertCount()).toBe(1);

    const stored = [...rows.values()][0] as any;
    expect(stored.approvalType).toBe("sensitive_reply");
    expect(stored.status).toBe("pending");
    expect(stored.campaignId).toBeNull();
    expect(stored.aiRecommendation).toBe(
      "I am sorry about this — let me bring in a specialist to help you."
    );
    expect(stored.idempotencyKey).toMatch(/^sr1:[0-9a-f]{64}$/);
    expect(stored.context).toEqual({
      source: "engagement_inbound",
      contractVersion: "engagement/sensitive-reply@v1",
      threadId: 500,
      sentiment: "negative",
      escalationReason: "Contact is unhappy and asked for a manager.",
    });
    // The proposed reply was persisted as an AI proposal message.
    expect(
      messages.some(m => m.senderType === "ai" && m.aiGenerated === true)
    ).toBe(true);
  });

  it("creates no approval for a non-escalated event", async () => {
    const { fakeDb } = createFakeEngagementDb();
    vi.mocked(getDb).mockReturnValue(fakeDb);
    vi.mocked(runAgent).mockResolvedValue(calmOutput() as any);
    const { executor } = createApprovalExecutorSpy();

    await handleNewMessage({
      userId: 42,
      campaignId: null,
      platform: "instagram",
      externalThreadId: "meta:message:page-1:user-9",
      messageText: "Do you deliver to Cape Town?",
      businessContext: { name: "Test Business" },
      dedupKey: "meta:m_calm_event",
      approvalExecutor: executor,
    });

    expect(executor.rowCount()).toBe(0);
    expect(executor.insertCount()).toBe(0);
  });

  it("inbound recovery replay does not duplicate the approval", async () => {
    const { fakeDb } = createFakeEngagementDb();
    vi.mocked(getDb).mockReturnValue(fakeDb);
    vi.mocked(runAgent).mockResolvedValue(escalateOutput() as any);
    const { executor } = createApprovalExecutorSpy();

    const invoke = () =>
      handleNewMessage({
        userId: 42,
        campaignId: null,
        platform: "instagram",
        externalThreadId: "meta:message:page-1:user-9",
        messageText: "I want to speak to a manager!",
        businessContext: { name: "Test Business" },
        dedupKey: EVENT_DEDUP_KEY,
        approvalExecutor: executor,
      });

    await invoke();
    await invoke(); // recovery retry of the same event

    expect(executor.insertCount()).toBe(1);
    expect(executor.rowCount()).toBe(1);
  });

  it("creates one approval per distinct escalated event in the same thread", async () => {
    const { fakeDb } = createFakeEngagementDb();
    vi.mocked(getDb).mockReturnValue(fakeDb);
    vi.mocked(runAgent).mockResolvedValue(escalateOutput() as any);
    const { executor } = createApprovalExecutorSpy();

    const invoke = (dedupKey: string) =>
      handleNewMessage({
        userId: 42,
        campaignId: null,
        platform: "instagram",
        externalThreadId: "meta:message:page-1:user-9",
        messageText: "I want to speak to a manager!",
        businessContext: { name: "Test Business" },
        dedupKey,
        approvalExecutor: executor,
      });

    await invoke("meta:m_event_a");
    await invoke("meta:m_event_b");

    expect(executor.rowCount()).toBe(2);
  });

  it("skips the bridge when no event-scoped dedupKey exists", async () => {
    const { fakeDb } = createFakeEngagementDb();
    vi.mocked(getDb).mockReturnValue(fakeDb);
    vi.mocked(runAgent).mockResolvedValue(escalateOutput() as any);
    const { executor } = createApprovalExecutorSpy();

    // Mirrors the manual runEngagementAgent path, which passes no dedupKey.
    await generateReply({
      userId: 42,
      campaignId: 0,
      threadId: 77,
      messageText: "I want to speak to a manager!",
      platform: "general",
      businessContext: { name: "Test Business" },
      approvalExecutor: executor,
    });

    expect(executor.rowCount()).toBe(0);
    expect(executor.insertCount()).toBe(0);
  });

  it("keeps the proposed reply as a proposal and dispatches nothing outbound", async () => {
    const { fakeDb, messages } = createFakeEngagementDb();
    vi.mocked(getDb).mockReturnValue(fakeDb);
    vi.mocked(runAgent).mockResolvedValue(escalateOutput() as any);
    const { executor } = createApprovalExecutorSpy();

    const { threadId, result } = await handleNewMessage({
      userId: 42,
      campaignId: null,
      platform: "facebook",
      externalThreadId: "meta:message:page-1:user-9",
      messageText: "I want to speak to a manager!",
      businessContext: { name: "Test Business" },
      dedupKey: EVENT_DEDUP_KEY,
      approvalExecutor: executor,
    });

    // The reply exists only as a persisted AI proposal on the thread.
    const reply = result.output.reply as string;
    const proposal = messages.find(
      m => m.threadId === threadId && m.senderType === "ai"
    );
    expect(proposal.messageText).toBe(reply);
    expect(proposal.aiGenerated).toBe(true);

    // Zero outbound dispatch across every platform sender.
    expect(publishToFacebook).not.toHaveBeenCalled();
    expect(publishToInstagram).not.toHaveBeenCalled();
    expect(publishToLinkedIn).not.toHaveBeenCalled();
    expect(publishToTwitter).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
