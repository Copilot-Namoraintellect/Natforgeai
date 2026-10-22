import { describe, expect, it, vi } from "vitest";

vi.mock("./runner", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../billing/cost-control", () => ({
  enforceCostControl: vi.fn(),
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import { runAgent } from "./runner";
import { enforceCostControl } from "../billing/cost-control";
import { runAudienceIntelligenceAgent } from "./audience-intelligence-agent";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

const COUNT_TABLES = new Set([
  "social_integrations",
  "social_profiles",
  "social_engagement_events",
  "campaign_interest_signals",
]);

function createNoDataDb(campaign: unknown, business: unknown) {
  let nextRunId = 880;
  const insertedRows: Array<{ table: string; values: unknown }> = [];

  const rowsFor = (table: unknown): unknown[] => {
    const name = getTableName(table) ?? "";
    if (name === "campaigns") return [campaign];
    if (name === "businesses") return [business];
    if (COUNT_TABLES.has(name)) return [{ count: 0 }];
    return [];
  };

  const whereResult = (rows: unknown[]) => ({
    limit: async (_n: number) => rows,
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  });

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => whereResult(rowsFor(table)),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => ({
        // The no-data path destructures [insertResult] from the awaited chain.
        then: (resolve: (value: unknown[]) => unknown) => {
          insertedRows.push({ table: getTableName(table) ?? "unknown", values });
          return Promise.resolve([{ insertId: nextRunId++ }]).then(resolve);
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => [],
      }),
    }),
  } as never;

  return { db, insertedRows };
}

describe("runAudienceIntelligenceAgent fresh-profile no-data guard (WBS-R1.3)", () => {
  it("exits before billable execution: no cost control, no deduction, no LLM run", async () => {
    const campaign = { id: 29, userId: 42, businessId: 5, workflowContext: {} };
    const business = { id: 5, userId: 42, name: "Acme" };
    const { db, insertedRows } = createNoDataDb(campaign, business);
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await runAudienceIntelligenceAgent({ userId: 42, campaignId: 29 });

    // A completed telemetry row records the no-data exit...
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].table).toBe("agent_runs");
    expect((insertedRows[0].values as { input: { reason: string } }).input.reason).toBe(
      "no_audience_source_data"
    );
    expect(result.output.noData).toBe(true);

    // ...but nothing billable happened: the LLM runner and cost control were
    // never invoked.
    expect(runAgent).not.toHaveBeenCalled();
    expect(enforceCostControl).not.toHaveBeenCalled();
  });
});
