import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../runner", () => ({
  runAgent: vi.fn(),
}));

import { getDb } from "../../../queries/connection";
import { runAgent } from "../runner";
import { handleNewMessage } from "../engagement-agent";

function createMockDb(overrides?: {
  existingThread?: Record<string, unknown> | null;
}) {
  const insertedRows: Array<{ table: string; values: any }> = [];
  const updatedRows: Array<{ table: string; set: any }> = [];
  // Simulated unique (threadId, dedupKey) constraint on conversation_messages.
  const messageKeys = new Set<string>();
  // Simulated leads table keyed by email for the existing-lead lookup.
  const leadsByEmail = new Map<string, any>();

  const db = {
    insertedRows,
    updatedRows,
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => {
              const name = table[Symbol.for("drizzle:Name")];
              if (name === "conversation_threads") {
                return overrides?.existingThread
                  ? [overrides.existingThread]
                  : [];
              }
              if (name === "conversation_messages") return [];
              if (name === "leads") return [...leadsByEmail.values()];
              return [];
            }),
          })),
          limit: vi.fn(async () => {
            const name = table[Symbol.for("drizzle:Name")];
            if (name === "conversation_threads") {
              return overrides?.existingThread
                ? [overrides.existingThread]
                : [];
            }
            if (name === "leads") return [...leadsByEmail.values()];
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn((table: any) => ({
      values: vi.fn(async (values: any) => {
        const name = table[Symbol.for("drizzle:Name")];
        if (name === "conversation_messages" && values.dedupKey != null) {
          const key = `${values.threadId}:${values.dedupKey}`;
          if (messageKeys.has(key)) {
            const err: any = new Error(
              `Duplicate entry '${key}' for key 'conversation_messages_thread_dedup_idx'`
            );
            err.code = "ER_DUP_ENTRY";
            throw err;
          }
          messageKeys.add(key);
        }
        if (name === "leads" && values.email) {
          leadsByEmail.set(values.email, values);
        }
        insertedRows.push({ table: name, values });
        return [{ insertId: 321 }];
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((set: any) => ({
        where: vi.fn(async () => {
          updatedRows.push({ table: table[Symbol.for("drizzle:Name")], set });
          return [];
        }),
      })),
    })),
  };
  return db;
}

const businessContext = {
  name: "Zuto Hub",
  productOrService: "Payout platform",
  brandTone: "friendly",
  mainGoal: "More walk-ins",
};

const baseInput = {
  userId: 14,
  campaignId: null as number | null,
  platform: "facebook",
  externalThreadId: "meta:message:page-1:user-9",
  messageText: "Hi, do you deliver to Cape Town?",
  businessContext,
};

describe("handleNewMessage (inbound engagement processing)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists the inbound message and an AI reply proposal without any outbound dispatch", async () => {
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({
      runId: 900,
      output: {
        reply: "Hi! Yes, we deliver across Cape Town.",
        shouldQualify: false,
        shouldEscalate: false,
        sentiment: "positive",
      },
    } as any);

    const { threadId, result } = await handleNewMessage(baseInput);

    expect(threadId).toBe(321);
    expect(result.output.reply).toContain("Cape Town");

    // Exactly one engagement agent run — the LLM boundary is the only call.
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 14,
        agentType: "engagement",
        campaignId: undefined,
      })
    );

    const threadInsert = db.insertedRows.find(
      row => row.table === "conversation_threads"
    );
    expect(threadInsert?.values).toMatchObject({
      userId: 14,
      campaignId: null,
      platform: "facebook",
      externalThreadId: "meta:message:page-1:user-9",
      status: "open",
    });

    const inboundMessage = db.insertedRows.find(
      row =>
        row.table === "conversation_messages" &&
        row.values.senderType === "lead"
    );
    expect(inboundMessage?.values.messageText).toBe(
      "Hi, do you deliver to Cape Town?"
    );

    const aiReply = db.insertedRows.find(
      row =>
        row.table === "conversation_messages" && row.values.senderType === "ai"
    );
    expect(aiReply?.values).toMatchObject({
      threadId: 321,
      aiGenerated: true,
      sentiment: "positive",
    });

    const threadUpdate = db.updatedRows.find(
      row => row.table === "conversation_threads"
    );
    expect(threadUpdate?.set.aiHandled).toBe(true);
  });

  it("marks the thread escalated when the reply proposal requests escalation", async () => {
    const db = createMockDb({
      existingThread: {
        id: 77,
        userId: 14,
        campaignId: 30,
        platform: "facebook",
        externalThreadId: "meta:message:page-1:user-9",
        status: "open",
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({
      runId: 901,
      output: {
        reply: "Let me connect you with our team.",
        shouldQualify: false,
        shouldEscalate: true,
        escalationReason: "pricing complaint",
        sentiment: "negative",
      },
    } as any);

    const { threadId, result } = await handleNewMessage({
      ...baseInput,
      campaignId: 30,
    });

    expect(threadId).toBe(77);
    expect(result.output.shouldEscalate).toBe(true);

    // No new thread for an existing conversation.
    expect(
      db.insertedRows.find(row => row.table === "conversation_threads")
    ).toBeUndefined();

    const threadUpdate = db.updatedRows.find(
      row => row.table === "conversation_threads"
    );
    expect(threadUpdate?.set).toMatchObject({
      aiHandled: true,
      status: "escalated",
      escalationRequired: true,
    });
  });

  it("creates a lead with an activity log when the reply proposal qualifies the contact", async () => {
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({
      runId: 902,
      output: {
        reply: "Thanks Ava! I'll send you our pricing.",
        shouldQualify: true,
        leadScore: 82,
        shouldEscalate: false,
        sentiment: "positive",
        extractedData: {
          name: "Ava Naidoo",
          email: "ava@example.com",
          company: "Cape Eats",
          interest: "delivery partnership",
        },
      },
    } as any);

    await handleNewMessage(baseInput);

    const leadInsert = db.insertedRows.find(row => row.table === "leads");
    expect(leadInsert?.values).toMatchObject({
      userId: 14,
      name: "Ava Naidoo",
      email: "ava@example.com",
      source: "facebook",
      status: "new",
      score: 82,
    });

    const threadLeadUpdate = db.updatedRows.find(
      row => row.table === "conversation_threads" && "leadId" in row.set
    );
    expect(threadLeadUpdate?.set.leadId).toBe(321);

    const activity = db.insertedRows.find(
      row => row.table === "lead_activities"
    );
    expect(activity?.values).toMatchObject({ leadId: 321, type: "note" });
  });
});

describe("handleNewMessage recovery idempotency (event-scoped dedupKey)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const qualifyingOutput = {
    runId: 903,
    output: {
      reply: "Thanks Ava! I'll send you our pricing.",
      shouldQualify: true,
      leadScore: 82,
      shouldEscalate: false,
      sentiment: "positive",
      extractedData: {
        name: "Ava Naidoo",
        email: "ava@example.com",
        company: "Cape Eats",
        interest: "delivery partnership",
      },
    },
  } as any;

  const thread = {
    id: 77,
    userId: 14,
    campaignId: 30,
    platform: "facebook",
    externalThreadId: "meta:message:page-1:user-9",
    status: "open",
  };

  const countRows = (
    db: ReturnType<typeof createMockDb>,
    table: string,
    match: (v: any) => boolean
  ) =>
    db.insertedRows.filter(row => row.table === table && match(row.values))
      .length;

  it("a retry after an AI failure does not duplicate the inbound message, AI proposal or lead", async () => {
    const db = createMockDb({ existingThread: thread });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent)
      .mockRejectedValueOnce(new Error("openai timeout"))
      .mockResolvedValueOnce(qualifyingOutput);

    const dedupedInput = {
      ...baseInput,
      campaignId: 30,
      dedupKey: "facebook:m-100",
    };

    // First attempt: inbound message persisted, then the AI call fails.
    await expect(handleNewMessage(dedupedInput)).rejects.toThrow(
      "openai timeout"
    );
    expect(
      countRows(db, "conversation_messages", v => v.senderType === "lead")
    ).toBe(1);
    expect(
      countRows(db, "conversation_messages", v => v.senderType === "ai")
    ).toBe(0);

    // Recovery retry: completes processing without duplicating any effect.
    const { threadId, result } = await handleNewMessage(dedupedInput);
    expect(threadId).toBe(77);
    expect(result.output.shouldQualify).toBe(true);

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(
      countRows(db, "conversation_messages", v => v.senderType === "lead")
    ).toBe(1);
    expect(
      countRows(db, "conversation_messages", v => v.senderType === "ai")
    ).toBe(1);
    expect(countRows(db, "leads", () => true)).toBe(1);
    expect(countRows(db, "lead_activities", () => true)).toBe(1);

    const inbound = db.insertedRows.find(
      row =>
        row.table === "conversation_messages" &&
        row.values.senderType === "lead"
    );
    expect(inbound?.values.dedupKey).toBe("facebook:m-100");
    const aiReply = db.insertedRows.find(
      row =>
        row.table === "conversation_messages" && row.values.senderType === "ai"
    );
    expect(aiReply?.values.dedupKey).toBe("facebook:m-100:ai-reply");
  });

  it("a reclaim retry after a completed-but-unconfirmed attempt reuses persisted effects", async () => {
    const db = createMockDb({ existingThread: thread });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue(qualifyingOutput);

    const dedupedInput = {
      ...baseInput,
      campaignId: 30,
      dedupKey: "facebook:m-100",
    };

    // First attempt completes (the crash scenario is the lost completion
    // bookkeeping, not lost processing).
    await handleNewMessage(dedupedInput);
    expect(countRows(db, "leads", () => true)).toBe(1);

    // Redriven claim for the same event: no duplicate message, proposal or lead.
    await handleNewMessage(dedupedInput);

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(
      countRows(db, "conversation_messages", v => v.senderType === "lead")
    ).toBe(1);
    expect(
      countRows(db, "conversation_messages", v => v.senderType === "ai")
    ).toBe(1);
    expect(countRows(db, "leads", () => true)).toBe(1);
    expect(countRows(db, "lead_activities", () => true)).toBe(1);
  });

  it("still writes effects normally when no dedupKey is provided (manual/agent-router path)", async () => {
    const db = createMockDb({ existingThread: thread });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue(qualifyingOutput);

    await handleNewMessage({ ...baseInput, campaignId: 30 });
    await handleNewMessage({ ...baseInput, campaignId: 30 });

    // No dedupKey: every call persists its own message (unchanged legacy behavior).
    expect(
      countRows(db, "conversation_messages", v => v.senderType === "lead")
    ).toBe(2);
    expect(countRows(db, "leads", () => true)).toBe(1); // email-guarded
  });
});
