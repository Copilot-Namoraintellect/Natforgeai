import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared holder lets the mocked downstream trigger observe commit state at
// call time and lets individual tests force a downstream failure.
const h = vi.hoisted(() => ({
  readCommitted: undefined as undefined | (() => boolean),
  committedAtCall: [] as boolean[],
  failDownstream: false,
}));

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in approval audit tests");
  }),
}));

vi.mock("./lib/workflow/triggers", () => ({
  onApprovalResolved: vi.fn(async () => {
    h.committedAtCall.push(h.readCommitted?.() ?? false);
    if (h.failDownstream) throw new Error("downstream workflow exploded");
  }),
}));

vi.mock("./lib/agents/strategy-agent", () => ({
  validateStrategyOutputAgainstCampaign: vi.fn(() => ({ valid: true })),
}));

vi.mock("./lib/creative/brief-grounding", () => ({
  buildGroundedCreativeBrief: vi.fn(() => ({
    fingerprint: "fp-current",
    productOrService: "service",
    targetBuyer: "buyer",
    mainPainPoint: "pain",
    preferredCta: "cta",
    primaryOutcome: "outcome",
    targetAudience: "audience",
    coreMessage: "message",
    offerDetails: "",
    excludedOffers: "",
    referenceStyle: "",
    contentStyle: "",
    businessType: "B2B",
  })),
}));

import { getDb } from "./queries/connection";
import { onApprovalResolved } from "./lib/workflow/triggers";
import { approvalRouter } from "./approval-router";

const CREATED_AT = "2026-07-01T00:00:00.000Z";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string | undefined;
}

interface FakeConfig {
  approvals: Record<string, unknown>[];
  campaign?: Record<string, unknown> | null;
  agentRuns?: Record<string, unknown>[];
  auditInsertError?: Error;
  lineageUpdateError?: Error;
  /** Simulate a competing decision winning between the pre-check read and the guarded update. */
  concurrentWinnerStatus?: string;
  /** The authenticated userId every approval_requests read is scoped to. */
  approvalUserScope?: number;
}

function createDecisionDb(config: FakeConfig) {
  const state = {
    txOperations: [] as string[],
    transactions: 0,
    txSpawned: 0,
    committed: false,
    rolledBack: false,
    committedApprovals: null as Record<string, unknown>[] | null,
    committedCampaigns: null as Record<string, unknown>[] | null,
    committedAudits: null as Record<string, unknown>[] | null,
  };

  const working = {
    approvals: config.approvals.map((a) => ({ ...a })),
    campaigns: config.campaign ? [{ ...config.campaign }] : [],
    agentRuns: (config.agentRuns ?? []).map((r) => ({ ...r })),
    audits: [] as Record<string, unknown>[],
  };

  let lastApprovalSelectIds: number[] = [];
  let lastCampaignSelectIds: number[] = [];

  const buildTx = () => {
    const txId = `tx${++state.txSpawned}`;
    const log = (op: string) => state.txOperations.push(`${txId}:${op}`);
    return {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async (): Promise<Record<string, unknown>[]> => {
              log("select");
              const name = getTableName(table);
              if (name === "approval_requests") {
                const scope = config.approvalUserScope ?? 18;
                const rows = working.approvals.filter((r) => r.userId === scope).map((r) => ({ ...r }));
                lastApprovalSelectIds = rows.map((r) => r.id as number);
                return rows;
              }
              if (name === "campaigns") {
                const rows = working.campaigns.map((r) => ({ ...r }));
                lastCampaignSelectIds = rows.map((r) => r.id as number);
                return rows;
              }
              if (name === "agent_runs") return working.agentRuns.map((r) => ({ ...r }));
              if (name === "audit_events") return working.audits.map((r) => ({ ...r }));
              if (name === "businesses") return [];
              return [];
            },
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (payload: Record<string, unknown>) => ({
          where: () => {
            log("update");
            const name = getTableName(table);
            if (name === "approval_requests") {
              if (config.concurrentWinnerStatus) {
                for (const row of working.approvals) {
                  if (lastApprovalSelectIds.includes(row.id as number) && row.status === "pending") {
                    row.status = config.concurrentWinnerStatus;
                  }
                }
              }
              const affected = working.approvals.filter(
                (r) => lastApprovalSelectIds.includes(r.id as number) && r.status === "pending"
              );
              for (const row of affected) Object.assign(row, payload);
              return Promise.resolve([{ affectedRows: affected.length }]);
            }
            if (name === "campaigns") {
              if (config.lineageUpdateError) throw config.lineageUpdateError;
              const affected = working.campaigns.filter((r) => lastCampaignSelectIds.includes(r.id as number));
              for (const row of affected) Object.assign(row, payload);
              return Promise.resolve([{ affectedRows: affected.length }]);
            }
            return Promise.resolve([{ affectedRows: 0 }]);
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          log("insert");
          const name = getTableName(table);
          if (name === "audit_events") {
            if (config.auditInsertError) throw config.auditInsertError;
            working.audits.push({
              id: working.audits.length + 1,
              createdAt: new Date(CREATED_AT),
              ...row,
            });
          }
          return Promise.resolve([{ insertId: 500 + working.audits.length }]);
        },
      }),
    };
  };

  const db = {
    transaction: async (cb: (tx: ReturnType<typeof buildTx>) => Promise<unknown>) => {
      state.transactions += 1;
      try {
        const result = await cb(buildTx());
        state.committed = true;
        state.committedApprovals = working.approvals.map((a) => ({ ...a }));
        state.committedCampaigns = working.campaigns.map((c) => ({ ...c }));
        state.committedAudits = working.audits.map((a) => ({ ...a }));
        return result;
      } catch (err) {
        state.rolledBack = true;
        throw err;
      }
    },
    select: () => {
      throw new Error("outer db.select must not be used by approval decisions");
    },
    update: () => {
      throw new Error("outer db.update must not be used by approval decisions");
    },
    insert: () => {
      throw new Error("outer db.insert must not be used by approval decisions");
    },
  };

  return { db, state, working };
}

function buildCtx() {
  return {
    resHeaders: new Headers(),
    user: { id: 18, tierSlug: "free" },
    session: { verified: true },
  } as never;
}

const launchCampaign = (workflowContext: Record<string, unknown> = {}, businessId: number | null = null) => ({
  id: 42,
  userId: 18,
  aiGenerated: true,
  name: "Launch Campaign",
  platforms: "facebook",
  businessId,
  workflowState: "launch_approval_required",
  workflowContext,
});

const launchApproval = (id: number, status = "pending") => ({
  id,
  userId: 18,
  campaignId: 42,
  approvalType: "campaign_launch",
  status,
});

function auditMetadata(audit: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(audit.metadata)) as Record<string, unknown>;
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("approval decision atomic audit (WBS7C2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.readCommitted = undefined;
    h.committedAtCall = [];
    h.failDownstream = false;
  });

  it("approve: approved status, shared decision timestamp, one audit event in one transaction", async () => {
    const { db, state } = createDecisionDb({
      approvals: [
        { ...launchApproval(7), approvalType: "budget_increase", campaignId: 42 },
      ],
      campaign: { id: 42, userId: 18, businessId: 26, workflowState: "campaign_live", workflowContext: {} },
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;

    const result = await approvalRouter.createCaller(buildCtx()).approveAction({ approvalId: 7 });

    expect(result).toEqual({ success: true, campaignId: 42, approvalType: "budget_increase" });
    expect(state.transactions).toBe(1);
    expect(state.txSpawned).toBe(1);
    expect(state.txOperations).toEqual([
      "tx1:select", // request pre-check
      "tx1:update", // guarded terminal mutation
      "tx1:select", // campaign read for business lineage
      "tx1:select", // audit pre-check
      "tx1:insert", // durable audit row
      "tx1:select", // audit durability read
    ]);

    const approval = state.committedApprovals![0]!;
    expect(approval.status).toBe("approved");
    const audit = state.committedAudits![0]!;
    expect(audit.eventType).toBe("approval_resolved");
    expect(audit.source).toBe("user");
    expect(audit.outcome).toBe("succeeded");
    expect(audit.occurredAt).toBe((approval.approvedAt as Date).toISOString());
    expect(audit.userId).toBe(18);
    expect(audit.campaignId).toBe(42);
    expect(audit.approvalRequestId).toBe(7);
    expect(audit.businessId).toBe(26);
    expect(audit.workflowOperationId).toBeNull();
    expect(audit.workflowAttemptId).toBeNull();
    expect(audit.artifactId).toBeNull();
    expect(audit.packageId).toBeNull();
    expect(audit.contentId).toBeNull();
    expect(auditMetadata(audit)).toEqual({
      approvalType: "budget_increase",
      decision: "approved",
      resolutionMode: "direct",
    });
    expect(state.committedAudits).toHaveLength(1);
  });

  it("reject: rejected status, shared decision timestamp, one audit event", async () => {
    const { db, state } = createDecisionDb({
      approvals: [{ ...launchApproval(7), approvalType: "budget_increase" }],
      campaign: { id: 42, userId: 18, businessId: null, workflowState: "campaign_live", workflowContext: {} },
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;

    const result = await approvalRouter.createCaller(buildCtx()).rejectAction({ approvalId: 7, notes: "not on brief" });

    expect(result.success).toBe(true);
    const approval = state.committedApprovals![0]!;
    expect(approval.status).toBe("rejected");
    expect(String(approval.description)).toContain("Rejection reason: not on brief");
    const audit = state.committedAudits![0]!;
    expect(audit.occurredAt).toBe((approval.rejectedAt as Date).toISOString());
    expect(audit.businessId).toBeNull();
    expect(auditMetadata(audit)).toEqual({
      approvalType: "budget_increase",
      decision: "rejected",
      resolutionMode: "direct",
    });
    expect(state.committedAudits).toHaveLength(1);
  });

  it("edit-and-approve: edited status, semantic approval, edited resolutionMode, no payload/notes in audit metadata", async () => {
    const { db, state } = createDecisionDb({
      approvals: [{ ...launchApproval(7), approvalType: "budget_increase", description: "base" }],
      campaign: { id: 42, userId: 18, businessId: null, workflowState: "campaign_live", workflowContext: {} },
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;

    const result = await approvalRouter
      .createCaller(buildCtx())
      .editAndApproveAction({
        approvalId: 7,
        editedPayload: { headline: "new headline" },
        notes: "tweak the hook",
      });

    expect(result.success).toBe(true);
    const approval = state.committedApprovals![0]!;
    expect(approval.status).toBe("edited");
    expect(auditOccurredAt(approval)).toBeTruthy();
    // Request-side persistence still records the edit (existing behaviour)…
    expect(String(approval.description)).toContain("Edited by user");
    expect(String(approval.description)).toContain("tweak the hook");
    // …but the audit metadata must not carry it.
    const audit = state.committedAudits![0]!;
    expect(audit.occurredAt).toBe((approval.approvedAt as Date).toISOString());
    const metadata = auditMetadata(audit);
    expect(metadata).toEqual({
      approvalType: "budget_increase",
      decision: "approved",
      resolutionMode: "edited",
    });
    expect("editedPayload" in metadata).toBe(false);
    expect("notes" in metadata).toBe(false);
  });

  it("campaign_launch approve: terminal approval, approved lineage and audit commit as one unit", async () => {
    const { db, state } = createDecisionDb({
      approvals: [launchApproval(7)],
      campaign: launchCampaign({
        launchApprovalLineage: { creativeBriefFingerprint: "fp-current", approvalRequestId: 7, status: "pending" },
      }),
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;

    await approvalRouter.createCaller(buildCtx()).approveAction({ approvalId: 7 });

    expect(state.committedApprovals![0]!.status).toBe("approved");
    const context = state.committedCampaigns![0]!.workflowContext as {
      launchApprovalLineage: Record<string, unknown>;
    };
    expect(context.launchApprovalLineage).toEqual({
      creativeBriefFingerprint: "fp-current",
      approvalRequestId: 7,
      status: "approved",
    });
    expect(state.committedAudits).toHaveLength(1);
    expect(auditMetadata(state.committedAudits![0]!)).toEqual({
      approvalType: "campaign_launch",
      decision: "approved",
      resolutionMode: "direct",
    });
  });

  it("campaign_launch reject: terminal approval, rejected lineage and audit commit as one unit", async () => {
    const { db, state } = createDecisionDb({
      approvals: [launchApproval(7)],
      campaign: launchCampaign({
        launchApprovalLineage: { creativeBriefFingerprint: "fp-current", approvalRequestId: 7, status: "pending" },
      }),
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;

    await approvalRouter.createCaller(buildCtx()).rejectAction({ approvalId: 7 });

    expect(state.committedApprovals![0]!.status).toBe("rejected");
    const context = state.committedCampaigns![0]!.workflowContext as {
      launchApprovalLineage: Record<string, unknown>;
    };
    expect(context.launchApprovalLineage).toEqual({
      creativeBriefFingerprint: "fp-current",
      approvalRequestId: 7,
      status: "rejected",
    });
    expect(state.committedAudits).toHaveLength(1);
    expect(auditMetadata(state.committedAudits![0]!)).toEqual({
      approvalType: "campaign_launch",
      decision: "rejected",
      resolutionMode: "direct",
    });
  });

  it("strategy_review still validates lineage before the decision and audits a valid approval", async () => {
    const staleDb = createDecisionDb({
      approvals: [{ ...launchApproval(3), approvalType: "strategy_review" }],
      campaign: {
        id: 42,
        userId: 18,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyFingerprint: "fp-old",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-old",
            strategyRunId: 10,
            approvalRequestId: 3,
            status: "pending",
          },
        },
      },
      agentRuns: [{ id: 10, userId: 18, campaignId: 42, agentType: "strategy", status: "completed" }],
    });
    vi.mocked(getDb).mockReturnValue(staleDb.db as never);
    h.readCommitted = () => staleDb.state.committed;

    await expect(
      approvalRouter.createCaller(buildCtx()).approveAction({ approvalId: 3 })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(staleDb.state.txOperations).toEqual(["tx1:select", "tx1:select"]); // request + campaign, no update
    expect(staleDb.state.committedApprovals).toBeNull();
    expect(staleDb.state.committedAudits).toBeNull();

    const validDb = createDecisionDb({
      approvals: [{ ...launchApproval(3), approvalType: "strategy_review" }],
      campaign: {
        id: 42,
        userId: 18,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyFingerprint: "fp-current",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-current",
            strategyRunId: 10,
            approvalRequestId: 3,
            status: "pending",
          },
        },
      },
      agentRuns: [
        { id: 10, userId: 18, campaignId: 42, agentType: "strategy", status: "completed", output: { ok: true } },
      ],
    });
    vi.mocked(getDb).mockReturnValue(validDb.db as never);
    h.readCommitted = () => validDb.state.committed;

    await approvalRouter.createCaller(buildCtx()).approveAction({ approvalId: 3 });

    expect(validDb.state.committedApprovals![0]!.status).toBe("approved");
    expect(validDb.state.committedAudits).toHaveLength(1);
    expect(auditMetadata(validDb.state.committedAudits![0]!)).toEqual({
      approvalType: "strategy_review",
      decision: "approved",
      resolutionMode: "direct",
    });
  });

  it("stale launch lineage: no status mutation, no lineage terminalisation, no audit", async () => {
    const { db, state } = createDecisionDb({
      approvals: [launchApproval(7)],
      campaign: launchCampaign({
        launchApprovalLineage: { creativeBriefFingerprint: "fp-old", approvalRequestId: 7, status: "pending" },
      }),
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;

    await expect(approvalRouter.createCaller(buildCtx()).approveAction({ approvalId: 7 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(state.txOperations.every((op) => !op.endsWith(":update") && !op.endsWith(":insert"))).toBe(true);
    expect(state.committedApprovals).toBeNull();
    expect(state.committedCampaigns).toBeNull();
    expect(state.committedAudits).toBeNull();
  });

  it("audit persistence failure rolls back the approval mutation and launch lineage, and dispatches nothing", async () => {
    const { db, state } = createDecisionDb({
      approvals: [launchApproval(7)],
      campaign: launchCampaign({
        launchApprovalLineage: { creativeBriefFingerprint: "fp-current", approvalRequestId: 7, status: "pending" },
      }),
      auditInsertError: new Error("audit insert exploded"),
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;

    await expect(approvalRouter.createCaller(buildCtx()).approveAction({ approvalId: 7 })).rejects.toMatchObject({
      message: "audit insert exploded",
    });
    expect(state.rolledBack).toBe(true);
    expect(state.committedApprovals).toBeNull();
    expect(state.committedCampaigns).toBeNull();
    expect(state.committedAudits).toBeNull();
    await flushMicrotasks();
    expect(onApprovalResolved).not.toHaveBeenCalled();
  });

  it("launch-lineage write failure rolls back the approval mutation, writes no audit, dispatches nothing", async () => {
    const { db, state } = createDecisionDb({
      approvals: [launchApproval(7)],
      campaign: launchCampaign({
        launchApprovalLineage: { creativeBriefFingerprint: "fp-current", approvalRequestId: 7, status: "pending" },
      }),
      lineageUpdateError: new Error("lineage write exploded"),
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;

    await expect(approvalRouter.createCaller(buildCtx()).approveAction({ approvalId: 7 })).rejects.toMatchObject({
      message: "lineage write exploded",
    });
    expect(state.rolledBack).toBe(true);
    expect(state.committedApprovals).toBeNull();
    expect(state.txOperations.filter((op) => op.endsWith(":insert"))).toHaveLength(0);
    await flushMicrotasks();
    expect(onApprovalResolved).not.toHaveBeenCalled();
  });

  it("concurrent approve vs reject: exactly one guarded mutation wins, loser fails closed with no audit", async () => {
    const { db, state, working } = createDecisionDb({
      approvals: [launchApproval(7)],
      campaign: { id: 42, userId: 18, businessId: null, workflowState: "campaign_live", workflowContext: {} },
      concurrentWinnerStatus: "approved",
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;

    await expect(approvalRouter.createCaller(buildCtx()).rejectAction({ approvalId: 7 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Approval request is already approved",
    });
    expect(state.txOperations).toEqual(["tx1:select", "tx1:update", "tx1:select"]); // pre-check, guarded update, same-tx reread
    expect(working.audits).toHaveLength(0);
    expect(working.approvals[0]!.status).toBe("approved"); // winner preserved, not overwritten
  });

  it("already-terminal request: no second audit event, no terminal rewrite, no dispatch", async () => {
    const { db, state } = createDecisionDb({
      approvals: [{ ...launchApproval(7), status: "approved", approvedAt: new Date("2026-01-01") }],
      campaign: { id: 42, userId: 18, businessId: null, workflowState: "campaign_live", workflowContext: {} },
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;

    await expect(approvalRouter.createCaller(buildCtx()).approveAction({ approvalId: 7 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(state.txOperations).toEqual(["tx1:select"]);
    await flushMicrotasks();
    expect(onApprovalResolved).not.toHaveBeenCalled();
  });

  it("approval belonging to another user is blocked with no audit", async () => {
    const { db, state } = createDecisionDb({
      approvals: [{ ...launchApproval(7), userId: 99 }],
      campaign: { id: 42, userId: 99, businessId: null, workflowState: "campaign_live", workflowContext: {} },
    });
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(approvalRouter.createCaller(buildCtx()).approveAction({ approvalId: 7 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(state.txOperations).toEqual(["tx1:select"]);
    expect(state.committedAudits).toBeNull();
  });

  it("missing request is blocked with no audit", async () => {
    const { db, state } = createDecisionDb({ approvals: [] });
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(approvalRouter.createCaller(buildCtx()).rejectAction({ approvalId: 404 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(state.txOperations).toEqual(["tx1:select"]);
    expect(state.committedAudits).toBeNull();
  });

  it("downstream onApprovalResolved runs only after commit; its failure does not roll back the decision", async () => {
    const { db, state } = createDecisionDb({
      approvals: [{ ...launchApproval(7), approvalType: "budget_increase" }],
      campaign: { id: 42, userId: 18, businessId: null, workflowState: "campaign_live", workflowContext: {} },
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;
    h.failDownstream = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await approvalRouter.createCaller(buildCtx()).approveAction({ approvalId: 7 });
    expect(result.success).toBe(true);

    await flushMicrotasks();
    expect(onApprovalResolved).toHaveBeenCalledTimes(1);
    expect(onApprovalResolved).toHaveBeenCalledWith(7, "approved", 18);
    expect(h.committedAtCall).toEqual([true]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Async workflow trigger failed"),
      "downstream workflow exploded"
    );
    // Decision and audit evidence remain committed despite downstream failure.
    expect(state.committedApprovals![0]!.status).toBe("approved");
    expect(state.committedAudits).toHaveLength(1);
    errorSpy.mockRestore();
  });
});

function auditOccurredAt(row: Record<string, unknown>): boolean {
  return "approvedAt" in row || "rejectedAt" in row;
}
