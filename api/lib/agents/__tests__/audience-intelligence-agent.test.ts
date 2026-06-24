import { describe, it, expect, vi, beforeEach } from "vitest";
import { normaliseOutput } from "../audience-intelligence-normalise";

vi.mock("../runner", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../../../queries/connection", () => ({
  getDb: vi.fn(),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string | undefined;
}

function createMockDb({
  campaign,
  counts = { integrations: 0, profiles: 0, events: 0, signals: 0 },
}: {
  campaign: Record<string, unknown>;
  counts?: { integrations: number; profiles: number; events: number; signals: number };
}) {
  const whereResult = (table: unknown) => {
    let limitResult: unknown[] = [];
    let count = 0;

    const tableName = getTableName(table);

    if (tableName === "campaigns") {
      limitResult = campaign ? [campaign] : [];
    } else if (tableName === "businesses") {
      limitResult = [];
    } else if (tableName === "social_integrations") {
      count = counts.integrations;
    } else if (tableName === "social_profiles") {
      count = counts.profiles;
    } else if (tableName === "social_engagement_events") {
      count = counts.events;
    } else if (tableName === "campaign_interest_signals") {
      count = counts.signals;
    }

    return {
      limit: vi.fn(async () => limitResult),
      orderBy: vi.fn(() => ({
        limit: vi.fn(async () => []),
        then: (resolve: (value: unknown[]) => void) => resolve([]),
      })),
      then: (resolve: (value: unknown[]) => void) => resolve([{ count }]),
    };
  };

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => whereResult(table)),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async () => [{ insertId: 123 }]),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })),
  };
}

describe("normaliseOutput", () => {
  it("fills missing fields with safe defaults", () => {
    const result = normaliseOutput({
      executiveSummary: "Great engagement",
      scoredLeads: [
        {
          externalIdentifier: "fb:123",
          platform: "facebook",
          score: 85,
          confidence: "high",
          recommendedAction: "reach_out",
          explanation: "Highly engaged",
          outreachAngles: [{ channel: "facebook_dm", hook: "Hi" }],
        },
      ],
    });

    expect(result.executiveSummary).toBe("Great engagement");
    expect(result.scoredLeads).toHaveLength(1);
    expect(result.scoredLeads[0].handle).toBeNull();
    expect(result.scoredLeads[0].signals).toEqual([]);
    expect(result.scoredLeads[0].outreachAngles[0].cta).toBe("");
    expect(result.discoveredProfiles).toEqual([]);
    expect(result.contentResonance).toEqual([]);
    expect(result.nextSteps).toEqual([]);
  });

  it("normalises invalid enum values to defaults", () => {
    const result = normaliseOutput({
      scoredLeads: [
        {
          externalIdentifier: "li:456",
          platform: "linkedin",
          score: 110,
          confidence: "invalid",
          recommendedAction: "unknown",
          outreachAngles: [{ channel: "invalid_channel" }],
        },
      ],
    });

    expect(result.scoredLeads[0].score).toBe(100);
    expect(result.scoredLeads[0].confidence).toBe("low");
    expect(result.scoredLeads[0].recommendedAction).toBe("ignore");
    expect(result.scoredLeads[0].outreachAngles[0].channel).toBe("email");
  });

  it("returns defaults for non-object input", () => {
    const result = normaliseOutput(null);
    expect(result.scoredLeads).toEqual([]);
    expect(result.executiveSummary).toBe("");
  });
});

describe("runAudienceIntelligenceAgent no-data guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not call runAgent and returns empty output when no audience source data exists", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runAudienceIntelligenceAgent } = await import("../audience-intelligence-agent");

    const campaign = {
      id: 27,
      userId: 14,
      businessId: null,
      name: "Test campaign",
      goal: "awareness",
      targetAudience: null,
      productOrService: null,
      offerDetails: null,
      primaryOutcome: null,
      coreMessage: null,
      workflowContext: {},
    };

    vi.mocked(getDb).mockReturnValue(
      createMockDb({ campaign, counts: { integrations: 0, profiles: 0, events: 0, signals: 0 } }) as any
    );

    const result = await runAudienceIntelligenceAgent({ userId: 14, campaignId: 27 });

    expect(runAgent).not.toHaveBeenCalled();
    expect(result.output.scoredLeads).toEqual([]);
    expect(result.output.discoveredProfiles).toEqual([]);
    expect(result.output.contentResonance).toEqual([]);
    expect(result.output.nextSteps).toEqual([]);
    expect(result.output.executiveSummary).toBe("");
    expect(result.createdLeadIds).toEqual([]);
  });
});
