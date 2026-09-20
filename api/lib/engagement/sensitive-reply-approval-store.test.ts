/**
 * Durable sensitive-reply approval store tests (WBS14B).
 *
 * Every test injects an in-memory executor: no real database is touched, and
 * the assertions below lock the replay/conflict contract of
 * createOrReuseSensitiveReplyApproval.
 */

import { describe, expect, it, vi } from "vitest";

// The default drizzle executor is never exercised here; pinning getDb keeps
// the no-real-database guarantee explicit even if a test regresses.
vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not be called when an executor is injected");
  }),
}));

import { buildSensitiveReplyApprovalRequest } from "./sensitive-reply-approval";
import {
  createOrReuseSensitiveReplyApproval,
  type SensitiveReplyApprovalExecutor,
  type SensitiveReplyApprovalInsert,
  type SensitiveReplyApprovalRecord,
} from "./sensitive-reply-approval-store";

const PROVIDER_EVENT_KEY = "meta:m_escalated_event_42";

function buildCommand(
  overrides: Partial<
    Parameters<typeof buildSensitiveReplyApprovalRequest>[0]
  > = {}
) {
  return buildSensitiveReplyApprovalRequest({
    userId: 42,
    campaignId: 7,
    threadId: 99,
    dedupKey: PROVIDER_EVENT_KEY,
    proposedReply: "Let me connect you with a specialist right away.",
    escalationReason: "Contact asked about a refund.",
    sentiment: "negative",
    ...overrides,
  });
}

function duplicateKeyError(): Error {
  const err = new Error(
    "Duplicate entry 'sr1:…' for key 'approval_requests_idempotency_key'"
  );
  (err as any).code = "ER_DUP_ENTRY";
  return err;
}

function createInMemoryExecutor() {
  const rows = new Map<string, SensitiveReplyApprovalRecord>();
  const inserts: SensitiveReplyApprovalInsert[] = [];
  let nextId = 1;

  const executor: SensitiveReplyApprovalExecutor = {
    async findByIdempotencyKey(idempotencyKey) {
      return rows.get(idempotencyKey) ?? null;
    },
    async insertPendingApproval(row) {
      inserts.push(row);
      if (rows.has(row.idempotencyKey)) throw duplicateKeyError();
      const record: SensitiveReplyApprovalRecord = {
        id: nextId++,
        userId: row.userId,
        campaignId: row.campaignId,
        approvalType: row.approvalType,
        title: row.title,
        description: row.description,
        aiRecommendation: row.aiRecommendation,
        riskLevel: row.riskLevel,
        status: "pending",
        idempotencyKey: row.idempotencyKey,
        context: row.context,
      };
      rows.set(row.idempotencyKey, record);
      return record.id;
    },
  };

  return { executor, rows, inserts };
}

describe("createOrReuseSensitiveReplyApproval", () => {
  it("creates exactly one pending sensitive_reply request on first escalation", async () => {
    const { executor, rows, inserts } = createInMemoryExecutor();
    const command = buildCommand();

    const result = await createOrReuseSensitiveReplyApproval(command, executor);

    expect(result).toEqual({ outcome: "created", approvalRequestId: 1 });
    expect(inserts).toHaveLength(1);
    expect(rows.size).toBe(1);

    const row = rows.get(command.idempotencyKey)!;
    expect(row.status).toBe("pending");
    expect(row.approvalType).toBe("sensitive_reply");
    // The proposed reply remains the recommendation — a proposal only.
    expect(row.aiRecommendation).toBe(command.aiRecommendation);
    expect(row.campaignId).toBe(7);
    expect(row.idempotencyKey).toBe(command.idempotencyKey);
    expect(row.idempotencyKey).toMatch(/^sr1:[0-9a-f]{64}$/);
  });

  it("persists recoverable thread/campaign lineage in structured context", async () => {
    const { executor, rows } = createInMemoryExecutor();
    const command = buildCommand();

    await createOrReuseSensitiveReplyApproval(command, executor);

    const row = rows.get(command.idempotencyKey)!;
    expect(row.context).toEqual({
      source: "engagement_inbound",
      contractVersion: "engagement/sensitive-reply@v1",
      threadId: 99,
      sentiment: "negative",
      escalationReason: "Contact asked about a refund.",
    });
  });

  it("never persists the raw provider event dedupKey", async () => {
    const { executor, rows, inserts } = createInMemoryExecutor();
    const command = buildCommand();

    await createOrReuseSensitiveReplyApproval(command, executor);

    const row = rows.get(command.idempotencyKey)!;
    expect(JSON.stringify(row)).not.toContain(PROVIDER_EVENT_KEY);
    expect(JSON.stringify(inserts[0])).not.toContain(PROVIDER_EVENT_KEY);
    expect((row.context as Record<string, unknown>).dedupKey).toBeUndefined();
    expect((row.context as Record<string, unknown>).eventKey).toBeUndefined();
  });

  it("reuses the same request on exact webhook/recovery replay", async () => {
    const { executor, rows, inserts } = createInMemoryExecutor();
    const command = buildCommand();

    const first = await createOrReuseSensitiveReplyApproval(command, executor);
    const replay = await createOrReuseSensitiveReplyApproval(
      buildCommand(),
      executor
    );

    expect(first.outcome).toBe("created");
    expect(replay).toEqual({
      outcome: "reused",
      approvalRequestId: 1,
      existingStatus: "pending",
    });
    // No second insert, and the original row is untouched.
    expect(inserts).toHaveLength(1);
    expect(rows.size).toBe(1);
    expect(rows.get(command.idempotencyKey)!.status).toBe("pending");
  });

  it("fails closed when the same idempotency key carries a materially different payload", async () => {
    const { executor, rows, inserts } = createInMemoryExecutor();
    const command = buildCommand();

    await createOrReuseSensitiveReplyApproval(command, executor);

    const conflicting = buildCommand({
      proposedReply: "A totally different reply for the same event.",
    });
    await expect(
      createOrReuseSensitiveReplyApproval(conflicting, executor)
    ).rejects.toThrow(/different approval payload/);

    // The stored row is neither rewritten nor duplicated.
    expect(rows.size).toBe(1);
    expect(rows.get(command.idempotencyKey)!.aiRecommendation).toBe(
      command.aiRecommendation
    );
    expect(inserts).toHaveLength(1);
  });

  it("fails closed when lineage differs under the same idempotency key", async () => {
    const { executor } = createInMemoryExecutor();
    const command = buildCommand();

    await createOrReuseSensitiveReplyApproval(command, executor);

    const conflicting = buildCommand({ sentiment: "urgent" });
    await expect(
      createOrReuseSensitiveReplyApproval(conflicting, executor)
    ).rejects.toThrow(/sentiment/);

    const movedThreads = buildCommand({ threadId: 100 });
    await expect(
      createOrReuseSensitiveReplyApproval(movedThreads, executor)
    ).rejects.toThrow(/threadId/);
  });

  it("never rewrites a rejected historical request back to pending", async () => {
    const { executor, rows } = createInMemoryExecutor();
    const command = buildCommand();

    await createOrReuseSensitiveReplyApproval(command, executor);
    rows.get(command.idempotencyKey)!.status = "rejected";

    const replay = await createOrReuseSensitiveReplyApproval(
      buildCommand(),
      executor
    );

    expect(replay).toEqual({
      outcome: "reused",
      approvalRequestId: 1,
      existingStatus: "rejected",
    });
    expect(rows.get(command.idempotencyKey)!.status).toBe("rejected");
  });

  it("never rewrites an approved historical request back to pending", async () => {
    const { executor, rows } = createInMemoryExecutor();
    const command = buildCommand();

    await createOrReuseSensitiveReplyApproval(command, executor);
    rows.get(command.idempotencyKey)!.status = "approved";

    const replay = await createOrReuseSensitiveReplyApproval(
      buildCommand(),
      executor
    );

    if (replay.outcome !== "reused") {
      throw new Error("expected the approved request to be reused");
    }
    expect(replay.existingStatus).toBe("approved");
    expect(rows.get(command.idempotencyKey)!.status).toBe("approved");
  });

  it("keeps campaignId null instead of inventing a fake campaign", async () => {
    const { executor, rows } = createInMemoryExecutor();
    const command = buildCommand({ campaignId: null });

    await createOrReuseSensitiveReplyApproval(command, executor);

    const row = rows.get(command.idempotencyKey)!;
    expect(row.campaignId).toBeNull();
    expect(command.description).toContain("Campaign: Unassigned");
  });

  it("reuses the winner's row when the create race loses on the unique key", async () => {
    const { executor, rows } = createInMemoryExecutor();
    const command = buildCommand();

    // Simulate a concurrent creator winning between our find and insert:
    // insert always reports the unique-key violation, the row is reloadable.
    const racingExecutor: SensitiveReplyApprovalExecutor = {
      findByIdempotencyKey: executor.findByIdempotencyKey,
      insertPendingApproval: async row => {
        await executor.insertPendingApproval(row);
        throw duplicateKeyError();
      },
    };

    const result = await createOrReuseSensitiveReplyApproval(
      command,
      racingExecutor
    );

    expect(result).toEqual({
      outcome: "reused",
      approvalRequestId: 1,
      existingStatus: "pending",
    });
    expect(rows.size).toBe(1);
  });

  it("fails closed when the raced insert leaves no reloadable row", async () => {
    const ghostExecutor: SensitiveReplyApprovalExecutor = {
      findByIdempotencyKey: async () => null,
      insertPendingApproval: async () => {
        throw duplicateKeyError();
      },
    };

    await expect(
      createOrReuseSensitiveReplyApproval(buildCommand(), ghostExecutor)
    ).rejects.toThrow(/no row can be reloaded/);
  });

  it("fails closed on a same-key row with missing lineage context", async () => {
    const { executor, rows } = createInMemoryExecutor();
    const command = buildCommand();

    await createOrReuseSensitiveReplyApproval(command, executor);
    // Legacy/manual tampering: context stripped after creation.
    rows.get(command.idempotencyKey)!.context = null;

    await expect(
      createOrReuseSensitiveReplyApproval(buildCommand(), executor)
    ).rejects.toThrow(/different approval payload/);
  });

  it("rejects commands that are not sensitive_reply approvals", async () => {
    const { executor } = createInMemoryExecutor();
    const command = {
      ...buildCommand(),
      approvalType: "campaign_launch",
    } as unknown as Parameters<typeof createOrReuseSensitiveReplyApproval>[0];

    await expect(
      createOrReuseSensitiveReplyApproval(command, executor)
    ).rejects.toThrow(/unsupported approvalType/);
  });

  it("requires a command with an idempotency key", async () => {
    const { executor } = createInMemoryExecutor();

    await expect(
      createOrReuseSensitiveReplyApproval(
        { approvalType: "sensitive_reply" } as any,
        executor
      )
    ).rejects.toThrow(/idempotencyKey is required/);
  });
});
