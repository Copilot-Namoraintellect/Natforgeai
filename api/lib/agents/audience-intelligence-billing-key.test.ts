import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

vi.mock("./runner", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import { runAgent } from "./runner";
import { runAudienceIntelligenceAgent } from "./audience-intelligence-agent";
import { buildAudienceIntelligenceBillingIdentity } from "../workflow/agent-billing-identity";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

const RAW_OUTPUT = {
  executiveSummary: "Solid engagement",
  discoveredProfiles: [],
  scoredLeads: [
    {
      externalIdentifier: "fb:1",
      platform: "facebook",
      handle: null,
      displayName: "Jane Doe",
      score: 88,
      confidence: "high",
      signals: ["commented twice"],
      recommendedAction: "reach_out",
      explanation: "Highly engaged",
      outreachAngles: [
        { channel: "facebook_dm", hook: "Hi Jane", cta: "Book a call", expectedOutcome: "Reply" },
      ],
    },
  ],
  contentResonance: [],
  nextSteps: ["Follow up this week"],
};

function expectedBillingKey(campaignId: number, continuationId: number): string {
  const digest = createHash("sha256")
    .update(`workflow/agent-billing@v1:audience-intel:${campaignId}:${continuationId}`, "utf8")
    .digest("hex");
  return `agent-audience-intel-${digest}`;
}

/**
 * Full fake DB for the billable audience-intelligence path (source data
 * present). Captures the workflow-context writes so tests can prove the
 * billing identity is persisted next to the durable result coordinates.
 */
function createBillableDb({
  campaign,
  recordedRun,
  recordedRunVisible = true,
}: {
  campaign: Record<string, unknown>;
  recordedRun?: Record<string, unknown> | null;
  /**
   * Models the scoped agentRuns ownership filter: a row owned by another user
   * is invisible to the replay-guard lookup and therefore never matches.
   */
  recordedRunVisible?: boolean;
}) {
  const updates: Array<{ table: string; values: unknown }> = [];
  const inserts: Array<{ table: string; values: unknown }> = [];

  const thenableValues = (values: unknown) => {
    const chain: Record<string, unknown> = {
      onDuplicateKeyUpdate: () => chain,
    };
    const thenable = Promise.resolve([{ insertId: 77 }]);
    Object.assign(chain, {
      then: (resolve: (v: unknown) => unknown) => thenable.then(resolve),
    });
    void values;
    return chain;
  };

  const whereResult = (table: unknown) => {
    const name = getTableName(table) ?? "";
    let limitResult: unknown[] = [];

    if (name === "campaigns") limitResult = [campaign];
    else if (name === "agent_runs") limitResult = recordedRun && recordedRunVisible ? [recordedRun] : [];
    else if (name === "campaign_interest_signals")
      limitResult = [
        {
          id: 1,
          externalIdentifier: "fb:1",
          signalType: "facebook",
          strength: 5,
          sourceEventIds: [],
          contextSnippet: "Loved this",
          socialProfileId: null,
        },
      ];
    else if (name === "lead_scores")
      limitResult = [
        {
          id: 77,
          leadId: null,
        },
      ];
    else if (name === "leads") limitResult = [];

    const count =
      name === "social_integrations" || name === "social_profiles" ? 1 : name === "social_engagement_events" || name === "campaign_interest_signals" ? 1 : 0;

    return {
      limit: vi.fn(async () => limitResult),
      orderBy: vi.fn(() => ({
        limit: vi.fn(async () => []),
        then: (resolve: (value: unknown[]) => unknown) => resolve([]),
      })),
      then: (resolve: (value: unknown[]) => unknown) => resolve([{ count }]),
    };
  };

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => whereResult(table)),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        inserts.push({ table: getTableName(table) ?? "unknown", values });
        return thenableValues(values);
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn(async () => {
          updates.push({ table: getTableName(table) ?? "unknown", values });
          return [];
        }),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
  } as never;

  return { db, updates, inserts };
}

function baseCampaign(workflowContext: Record<string, unknown>) {
  return {
    id: 29,
    userId: 42,
    businessId: null,
    name: "Summer drop",
    goal: "awareness",
    targetAudience: null,
    productOrService: null,
    offerDetails: null,
    primaryOutcome: null,
    coreMessage: null,
    workflowContext,
  };
}

describe("runAudienceIntelligenceAgent billing identity plumbing (WBS-R4 C0.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the caller-stable billing key to the governed runner path and persists it with the durable result", async () => {
    const campaign = baseCampaign({});
    const { db, updates } = createBillableDb({ campaign });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({ runId: 555, output: RAW_OUTPUT } as any);

    const billingIdentity = buildAudienceIntelligenceBillingIdentity({
      campaignId: 29,
      continuationId: 9001,
    });

    const result = await runAudienceIntelligenceAgent({
      userId: 42,
      campaignId: 29,
      billingIdentity,
    });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0][0]).toMatchObject({
      userId: 42,
      campaignId: 29,
      agentType: "audience",
      billingIdempotencyKey: billingIdentity,
    });
    expect(result.runId).toBe(555);
    expect(result.replayed).toBeUndefined();

    const campaignUpdate = updates.find((u) => u.table === "campaigns");
    expect(campaignUpdate).toBeDefined();
    const context = (campaignUpdate!.values as { workflowContext: Record<string, unknown> })
      .workflowContext;
    expect(context.audienceIntelligenceRunId).toBe(555);
    expect(context.audienceIntelligenceBillingKey).toBe(billingIdentity);
  });

  it("collapses a duplicate trigger onto the authoritative completed result (no second run, no second charge)", async () => {
    const billingIdentity = expectedBillingKey(29, 9001);
    const campaign = baseCampaign({
      audienceIntelligenceRunId: 555,
      audienceIntelligenceBillingKey: billingIdentity,
    });
    const recordedRun = {
      id: 555,
      userId: 42,
      campaignId: 29,
      agentType: "audience",
      status: "completed",
      output: RAW_OUTPUT,
    };
    const { db } = createBillableDb({ campaign, recordedRun });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await runAudienceIntelligenceAgent({
      userId: 42,
      campaignId: 29,
      billingIdentity,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(result.replayed).toBe(true);
    expect(result.runId).toBe(555);
    expect(result.output.executiveSummary).toBe("Solid engagement");
    expect(result.createdLeadIds).toEqual([]);
  });

  it("does not let the replay guard block a genuinely new keyed operation (new continuation id)", async () => {
    const oldKey = expectedBillingKey(29, 9001);
    const campaign = baseCampaign({
      audienceIntelligenceRunId: 555,
      audienceIntelligenceBillingKey: oldKey,
    });
    const recordedRun = {
      id: 555,
      userId: 42,
      campaignId: 29,
      agentType: "audience",
      status: "completed",
      output: RAW_OUTPUT,
    };
    const { db } = createBillableDb({ campaign, recordedRun });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({ runId: 556, output: RAW_OUTPUT } as any);

    const newKey = buildAudienceIntelligenceBillingIdentity({
      campaignId: 29,
      continuationId: 9002,
    });
    const result = await runAudienceIntelligenceAgent({
      userId: 42,
      campaignId: 29,
      billingIdentity: newKey,
    });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0][0]).toMatchObject({
      billingIdempotencyKey: newKey,
    });
    expect(result.runId).toBe(556);
  });

  it("keeps manual (unkeyed) invocations executable even when a keyed result exists", async () => {
    const billingIdentity = expectedBillingKey(29, 9001);
    const campaign = baseCampaign({
      audienceIntelligenceRunId: 555,
      audienceIntelligenceBillingKey: billingIdentity,
    });
    const recordedRun = {
      id: 555,
      userId: 42,
      campaignId: 29,
      agentType: "audience",
      status: "completed",
      output: RAW_OUTPUT,
    };
    const { db } = createBillableDb({ campaign, recordedRun });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({ runId: 557, output: RAW_OUTPUT } as any);

    const result = await runAudienceIntelligenceAgent({ userId: 42, campaignId: 29 });

    // Manual click = new billable operation by design (Stream E §6): the
    // runner is invoked without a key (legacy path), never blocked by the
    // keyed replay guard.
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0][0]).not.toHaveProperty("billingIdempotencyKey");
    expect(result.runId).toBe(557);
    expect(result.replayed).toBeUndefined();
  });

  it("treats a non-completed recorded run as not authoritative and re-enters (fail-closed retry)", async () => {
    const billingIdentity = expectedBillingKey(29, 9001);
    const campaign = baseCampaign({
      audienceIntelligenceRunId: 555,
      audienceIntelligenceBillingKey: billingIdentity,
    });
    const recordedRun = {
      id: 555,
      userId: 42,
      campaignId: 29,
      agentType: "audience",
      status: "failed",
      output: null,
    };
    const { db } = createBillableDb({ campaign, recordedRun });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({ runId: 558, output: RAW_OUTPUT } as any);

    const result = await runAudienceIntelligenceAgent({
      userId: 42,
      campaignId: 29,
      billingIdentity,
    });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(result.runId).toBe(558);
  });

  it("cross-user replay is rejected: a key recorded by another user's run never matches", async () => {
    const billingIdentity = expectedBillingKey(29, 9001);
    // Same campaign context (defensive), but the recorded run belongs to a
    // different user — the scoped agentRuns lookup must not match it.
    const campaign = baseCampaign({
      audienceIntelligenceRunId: 555,
      audienceIntelligenceBillingKey: billingIdentity,
    });
    const recordedRun = {
      id: 555,
      userId: 999,
      campaignId: 29,
      agentType: "audience",
      status: "completed",
      output: RAW_OUTPUT,
    };
    const { db } = createBillableDb({ campaign, recordedRun, recordedRunVisible: false });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({ runId: 559, output: RAW_OUTPUT } as any);

    const result = await runAudienceIntelligenceAgent({
      userId: 42,
      campaignId: 29,
      billingIdentity,
    });

    // The other user's recorded run is invisible to the owner-scoped lookup,
    // so the guard cannot match it: the operation re-enters under its own key.
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(result.runId).toBe(559);
  });
});
