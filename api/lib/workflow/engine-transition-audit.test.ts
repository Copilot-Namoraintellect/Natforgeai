import { describe, expect, it, vi } from "vitest";

// Never touch a real database: the default connection is replaced wholesale.
vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import { auditEvents, campaigns, type AuditEventRow } from "@db/schema";
import { createAuditEvent, buildAuditEventFingerprint } from "../audit/audit-event";
import { transitionCampaignState } from "./engine";

interface FakeWorkflowDbConfig {
  campaign: Record<string, unknown> | null;
  updateError?: Error;
  auditInsertError?: Error;
}

/**
 * In-memory DB fake with observable transaction semantics. Mutations apply to
 * working stores inside the transaction callback; they only become visible in
 * the committed snapshots if the callback succeeds.
 */
function createFakeWorkflowDb(config: FakeWorkflowDbConfig) {
  const state = {
    transactionCalls: 0,
    txSpawned: 0,
    committed: false,
    rolledBack: false,
    txOperations: [] as string[],
    campaignRows: config.campaign ? [{ ...config.campaign }] : ([] as Record<string, unknown>[]),
    auditRows: [] as AuditEventRow[],
    committedCampaignRows: null as Record<string, unknown>[] | null,
    committedAuditRows: null as AuditEventRow[] | null,
  };

  const buildTx = () => {
    const txId = `tx${++state.txSpawned}`;
    const log = (op: string) => state.txOperations.push(`${txId}:${op}`);
    return {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async (): Promise<Record<string, unknown>[]> => {
              log("select");
              if (table === campaigns) return state.campaignRows.map((r) => ({ ...r }));
              if (table === auditEvents) return state.auditRows.map((r) => ({ ...r }));
              return [];
            },
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            log("update");
            if (config.updateError) throw config.updateError;
            if (table === campaigns) {
              state.campaignRows = state.campaignRows.map((r) => ({ ...r, ...values }));
            }
            return Promise.resolve([{ affectedRows: 1 }]);
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          log("insert");
          if (config.auditInsertError) throw config.auditInsertError;
          if (table === auditEvents) {
            state.auditRows.push({
              id: state.auditRows.length + 1,
              createdAt: new Date("2026-07-01T00:00:00.000Z"),
              ...row,
            } as AuditEventRow);
          }
          return Promise.resolve([{ insertId: state.auditRows.length, affectedRows: 1 }]);
        },
      }),
    };
  };

  const db = {
    transaction: async (cb: (tx: ReturnType<typeof buildTx>) => Promise<unknown>) => {
      state.transactionCalls += 1;
      try {
        const result = await cb(buildTx());
        state.committed = true;
        state.committedCampaignRows = state.campaignRows.map((r) => ({ ...r }));
        state.committedAuditRows = state.auditRows.map((r) => ({ ...r }));
        return result;
      } catch (err) {
        state.rolledBack = true;
        throw err;
      }
    },
    // Non-transactional surfaces must never be used by transitionCampaignState;
    // they throw so any regression fails loudly here.
    select: () => {
      throw new Error("outer db.select must not be used by transitionCampaignState");
    },
    update: () => {
      throw new Error("outer db.update must not be used by transitionCampaignState");
    },
    insert: () => {
      throw new Error("outer db.insert must not be used by transitionCampaignState");
    },
  };

  return { db, state };
}

function installFakeDb(config: FakeWorkflowDbConfig) {
  const { db, state } = createFakeWorkflowDb(config);
  vi.mocked(getDb).mockReturnValue(db as never);
  return state;
}

const campaign = {
  id: 30,
  userId: 22,
  workflowState: "strategy_pending",
  workflowContext: { seed: true },
  businessId: 26,
};

function lastTransitionOf(row: Record<string, unknown>): {
  from: string;
  to: string;
  action: string;
  at: string;
} {
  return (row.workflowContext as { lastTransition: ReturnType<typeof lastTransitionOf> })
    .lastTransition;
}

describe("transitionCampaignState atomic audit (WBS7C1)", () => {
  it("persists exactly one canonical workflow_transition audit event in the same transaction", async () => {
    const state = installFakeDb({ campaign });

    const result = await transitionCampaignState(30, 22, "generate_strategy");

    expect(result).toBe("strategy_generated");
    expect(state.transactionCalls).toBe(1);
    expect(state.txSpawned).toBe(1); // one executor for campaign + audit
    expect(state.txOperations).toEqual([
      "tx1:select", // campaign read
      "tx1:update", // governed mutation
      "tx1:select", // audit pre-check
      "tx1:insert", // audit row
      "tx1:select", // audit durability read
    ]);
    expect(state.committed).toBe(true);
    expect(state.rolledBack).toBe(false);

    const committedCampaign = state.committedCampaignRows![0]!;
    const lastTransition = lastTransitionOf(committedCampaign);
    expect(lastTransition).toEqual({
      from: "strategy_pending",
      to: "strategy_generated",
      action: "generate_strategy",
      at: expect.any(String),
    });

    // Exactly one durable audit row; no second event from this authority.
    expect(state.committedAuditRows).toHaveLength(1);
    const audit = state.committedAuditRows![0]!;
    expect(audit.eventFingerprint).toHaveLength(64);
    expect(audit.eventType).toBe("workflow_transition");
    expect(audit.source).toBe("workflow");
    expect(audit.outcome).toBe("succeeded");
    expect(audit.occurredAt).toBe(lastTransition.at); // exact shared transitionAt
    expect(audit.userId).toBe(22);
    expect(audit.campaignId).toBe(30);
    expect(audit.businessId).toBe(26);
    expect(audit.workflowOperationId).toBeNull();
    expect(audit.workflowAttemptId).toBeNull();
    expect(audit.approvalRequestId).toBeNull();
    expect(audit.artifactId).toBeNull();
    expect(audit.packageId).toBeNull();
    expect(audit.contentId).toBeNull();
    expect(audit.metadata).toEqual({
      action: "generate_strategy",
      fromState: "strategy_pending",
      toState: "strategy_generated",
    });

    // The stored row is byte-identical to what the canonical WBS7A store
    // would persist for the same material event.
    const canonical = createAuditEvent({
      eventType: "workflow_transition",
      occurredAt: lastTransition.at,
      userId: 22,
      source: "workflow",
      outcome: "succeeded",
      campaignId: 30,
      businessId: 26,
      metadata: {
        fromState: "strategy_pending",
        toState: "strategy_generated",
        action: "generate_strategy",
      },
    });
    expect(audit.eventFingerprint).toBe(buildAuditEventFingerprint(canonical));
    expect(audit.metadata).toEqual(canonical.metadata);
  });

  it("records null business lineage when the campaign has no businessId", async () => {
    const state = installFakeDb({ campaign: { ...campaign, businessId: null } });

    await transitionCampaignState(30, 22, "generate_strategy");

    const audit = state.committedAuditRows![0]!;
    expect(audit.businessId).toBeNull();
    expect(audit.userId).toBe(22);
    expect(audit.campaignId).toBe(30);
  });

  it("rejects an invalid transition without campaign update or audit persistence", async () => {
    const state = installFakeDb({ campaign });

    await expect(transitionCampaignState(30, 22, "pause")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Invalid transition"),
    });
    expect(state.txOperations).toEqual(["tx1:select"]);
    expect(state.committed).toBe(false);
    expect(state.rolledBack).toBe(true);
    expect(state.committedCampaignRows).toBeNull();
    expect(state.committedAuditRows).toBeNull();
  });

  it("rejects a missing campaign without mutation or audit persistence", async () => {
    const state = installFakeDb({ campaign: null });

    await expect(transitionCampaignState(30, 22, "generate_strategy")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(state.txOperations).toEqual(["tx1:select"]);
    expect(state.committed).toBe(false);
    expect(state.rolledBack).toBe(true);
    expect(state.committedCampaignRows).toBeNull();
    expect(state.committedAuditRows).toBeNull();
  });

  it("rolls the campaign mutation back when audit persistence fails", async () => {
    const auditFailure = new Error("audit insert failed");
    const state = installFakeDb({ campaign, auditInsertError: auditFailure });

    await expect(transitionCampaignState(30, 22, "generate_strategy")).rejects.toBe(auditFailure);
    expect(state.txOperations).toEqual(["tx1:select", "tx1:update", "tx1:select", "tx1:insert"]);
    expect(state.committed).toBe(false);
    expect(state.rolledBack).toBe(true);
    // The working store was mutated, but nothing durable survived.
    expect(state.committedCampaignRows).toBeNull();
    expect(state.committedAuditRows).toBeNull();
  });

  it("writes no audit row when the campaign update fails", async () => {
    const updateFailure = new Error("campaign update failed");
    const state = installFakeDb({ campaign, updateError: updateFailure });

    await expect(transitionCampaignState(30, 22, "generate_strategy")).rejects.toBe(updateFailure);
    expect(state.txOperations).toEqual(["tx1:select", "tx1:update"]);
    expect(state.committed).toBe(false);
    expect(state.rolledBack).toBe(true);
    expect(state.committedAuditRows).toBeNull();
  });
});
