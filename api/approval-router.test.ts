import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/workflow/triggers", () => ({
  onApprovalResolved: vi.fn(async () => undefined),
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

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string | undefined;
}

function createMockDb({
  campaign = {
    id: 42,
    userId: 18,
    workflowState: "strategy_generated",
    workflowContext: { strategyFingerprint: "fp-current" },
  } as any,
  approvals = [] as any[],
  agentRuns = [] as any[],
} = {}) {
  const state = {
    updatedApprovals: [] as any[],
  };

  const db = {
    state,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = getTableName(table);
        const result =
          name === "approval_requests" ? approvals : name === "campaigns" ? [campaign] : name === "agent_runs" ? agentRuns : [];
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => result),
            })),
            limit: vi.fn(async () => result),
            then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
          })),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((payload: any) => ({
        where: vi.fn(async () => {
          if (getTableName(table) === "approval_requests") {
            state.updatedApprovals.push(payload);
          }
          return [];
        }),
      })),
    })),
  };

  return db;
}

function buildCtx() {
  return {
    resHeaders: new Headers(),
    user: { id: 18, tierSlug: "free" },
    session: { verified: true },
  } as any;
}

describe("approvalRouter.strategy_review lineage validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("approves strategy_review when the durable lineage matches the current brief, run and request", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: {
        id: 42,
        userId: 18,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyFingerprint: "fp-current",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-current",
            strategyRunId: 10,
            approvalRequestId: 1,
            status: "pending",
          },
        },
      },
      approvals: [
        {
          id: 1,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
        },
      ],
      agentRuns: [
        {
          id: 10,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    const result = await caller.approveAction({ approvalId: 1 });

    expect(result.success).toBe(true);
    expect(db.state.updatedApprovals).toHaveLength(1);
    expect(db.state.updatedApprovals[0].status).toBe("approved");
  });

  it("rejects strategy_review when the brief changed after generation", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: {
        id: 42,
        userId: 18,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyFingerprint: "fp-old",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-old",
            strategyRunId: 10,
            approvalRequestId: 1,
            status: "pending",
          },
        },
      },
      approvals: [
        {
          id: 1,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
        },
      ],
      agentRuns: [
        {
          id: 10,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await expect(caller.approveAction({ approvalId: 1 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(db.state.updatedApprovals).toHaveLength(0);
  });

  it("rejects approval of an older pending request when the current lineage points to a different request", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: {
        id: 42,
        userId: 18,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyFingerprint: "fp-current",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-current",
            strategyRunId: 10,
            approvalRequestId: 1,
            status: "pending",
          },
        },
      },
      approvals: [
        {
          id: 33,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
        },
      ],
      agentRuns: [
        {
          id: 10,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await expect(caller.approveAction({ approvalId: 33 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(db.state.updatedApprovals).toHaveLength(0);
  });

  it("rejects approval when the linked strategy run is missing or incomplete", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: {
        id: 42,
        userId: 18,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyFingerprint: "fp-current",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-current",
            strategyRunId: 10,
            approvalRequestId: 1,
            status: "pending",
          },
        },
      },
      approvals: [
        {
          id: 1,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
        },
      ],
      agentRuns: [
        {
          id: 10,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "failed",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await expect(caller.approveAction({ approvalId: 1 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(db.state.updatedApprovals).toHaveLength(0);
  });

  it("preserves historical approved request 33 when the brief changes", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: {
        id: 42,
        userId: 18,
        workflowState: "strategy_approved",
        workflowContext: {
          approvedStrategyFingerprint: "fp-old",
          strategyFingerprint: "fp-old",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-old",
            strategyRunId: 10,
            approvalRequestId: 33,
            status: "approved",
          },
        },
      },
      approvals: [
        {
          id: 33,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "approved",
          approvedAt: new Date("2026-01-01"),
        },
      ],
      agentRuns: [
        {
          id: 10,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());

    await expect(caller.approveAction({ approvalId: 33 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    expect(db.state.updatedApprovals).toHaveLength(0);
  });
});
