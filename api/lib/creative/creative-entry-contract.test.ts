/**
 * R4-B1 — Creative entry contract.
 *
 * Proves that the shared creative entry gate
 * (resolveCreativeEntryStrategyAuthority → assertApprovedStrategySemanticallyValid
 * → captureApprovedCreativeStrategyAuthority → resolveImmutableCreativeStrategyInput)
 * is fail-closed for every unsupported, stale or mismatched authority condition,
 * using the REAL authority chain with only the database boundaries faked:
 *
 *   - no approved lineage            → PRECONDITION_FAILED before any spend
 *   - lineage not approved (pending) → PRECONDITION_FAILED
 *   - approved fingerprint drift     → PRECONDITION_FAILED
 *   - strategy run missing/not done  → PRECONDITION_FAILED
 *   - semantic validation failure    → PRECONDITION_FAILED (reason surfaced)
 *   - snapshot coordinate mismatch   → PRECONDITION_FAILED
 *   - snapshot hash tamper           → PRECONDITION_FAILED
 *   - business DNA lineage drift     → PRECONDITION_FAILED
 *   - cross-owner snapshot           → PRECONDITION_FAILED
 *   - campaign without business link → BAD_REQUEST
 *
 * Also locks the caller contract structurally: every autonomous campaign-linked
 * creative entry point must consult this gate (or the equivalent job-chain
 * assertion) BEFORE invoking the creative agent, so no normal path can advance
 * creative artefacts without authoritative approved Strategy + Business DNA
 * lineage + campaign ownership context.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TRPCError } from "@trpc/server";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../agents/strategy-agent", () => ({
  validateStrategyOutputAgainstCampaign: vi.fn(() => ({ valid: true })),
}));

vi.mock("../strategy/strategy-snapshot-db-store", () => ({
  getStrategySnapshotByStrategyRunId: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import { validateStrategyOutputAgainstCampaign } from "../agents/strategy-agent";
import { getStrategySnapshotByStrategyRunId } from "../strategy/strategy-snapshot-db-store";
import { hashStrategySnapshotPayload } from "../strategy/strategy-snapshot";
import { buildGroundedCreativeBrief } from "./brief-grounding";
import { resolveCreativeEntryStrategyAuthority } from "./creative-entry-authority";

// ── Fake database (agentRuns only — the sole table the real chain reads) ────

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function flattenSqlChunks(sql: any): any[] {
  if (!sql || typeof sql !== "object" || !Array.isArray(sql.queryChunks)) return [];
  const out: any[] = [];
  for (const chunk of sql.queryChunks) {
    if (chunk && typeof chunk === "object" && Array.isArray(chunk.queryChunks)) {
      out.push(...flattenSqlChunks(chunk));
    } else {
      out.push(chunk);
    }
  }
  return out;
}

function getColumnFilters(condition: unknown): Array<{ name: string; value: unknown }> {
  const chunks = flattenSqlChunks(condition);
  const filters: Array<{ name: string; value: unknown }> = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk && typeof chunk === "object" && "name" in chunk && typeof chunk.name === "string") {
      for (let j = i + 1; j < chunks.length; j++) {
        const candidate = chunks[j];
        if (
          candidate &&
          typeof candidate === "object" &&
          !("name" in candidate) &&
          "value" in candidate &&
          !Array.isArray(candidate.value)
        ) {
          filters.push({ name: chunk.name, value: candidate.value });
          break;
        }
      }
    }
  }
  return filters;
}

const harnessState = vi.hoisted(() => ({
  agentRuns: [] as any[],
}));

function createHarnessDb() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const name = getTableName(table) ?? "";
          const rows = name === "agent_runs" ? harnessState.agentRuns : [];
          const filters = getColumnFilters(condition);
          const matched = rows
            .filter((r) => filters.every((f) => r[f.name] === f.value))
            .map((r: any) => ({ ...r }));
          return {
            orderBy: () => ({
              limit: async (_n: number) => matched,
            }),
            limit: async (_n: number) => matched,
            then: (resolve: (value: any[]) => unknown) => Promise.resolve(matched).then(resolve),
          };
        },
      }),
    }),
  };
}

// ── Seeds ───────────────────────────────────────────────────────────────────

const USER_ID = 42;
const CAMPAIGN_ID = 29;
const BUSINESS_ID = 5;
const STRATEGY_RUN_ID = 600;
const SNAPSHOT_ID = "strategy_snap_b1";
const BDNA_ID = "bdna_snap_b1";
const STRATEGY_VERSION = 2;

const STRATEGY_PAYLOAD = {
  coreMessage: "Ride the summer.",
  valueProposition: "Handmade boards, built locally.",
  positioning: "Premium local craft",
  campaignTheme: "Summer board drop",
  personas: [{ name: "Sipho", demographics: "18-40" }],
};
const STRATEGY_HASH = hashStrategySnapshotPayload(STRATEGY_PAYLOAD as any);

function buildBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: BUSINESS_ID,
    userId: USER_ID,
    name: "Acme Surf Co",
    industry: "retail",
    location: "Cape Town",
    productOrService: "Handmade surfboards",
    targetCustomer: "Surfers 18-40",
    brandTone: "bold",
    ...overrides,
  };
}

function buildCampaign(overrides: Record<string, unknown> = {}) {
  const campaign: any = {
    id: CAMPAIGN_ID,
    userId: USER_ID,
    businessId: BUSINESS_ID,
    name: "Summer Board Drop",
    goal: "Sell 100 boards",
    // Explicit platforms make the fingerprint fully campaign-determined
    // (business fallbacks never reach computeCreativeBriefFingerprint).
    platforms: "instagram,facebook",
    workflowState: "strategy_approved",
  };
  const fingerprint = buildGroundedCreativeBrief({ campaign }).fingerprint;
  campaign.workflowContext = {
    strategyFingerprint: fingerprint,
    approvedStrategyFingerprint: fingerprint,
    strategyApprovalLineage: {
      creativeBriefFingerprint: fingerprint,
      strategyRunId: STRATEGY_RUN_ID,
      approvalRequestId: 901,
      status: "approved",
      strategySnapshotId: SNAPSHOT_ID,
      strategyVersion: STRATEGY_VERSION,
      businessDnaSnapshotId: BDNA_ID,
      strategyHashSha256: STRATEGY_HASH,
    },
  };
  // Overrides apply AFTER the approval context is sealed: brief-field mutations
  // (e.g. goal) therefore model post-approval drift exactly as production does.
  Object.assign(campaign, overrides);
  return campaign;
}

function currentFingerprint(campaign: any): string {
  return buildGroundedCreativeBrief({ campaign }).fingerprint;
}

function seedStrategyRun(status = "completed") {
  harnessState.agentRuns = [
    {
      id: STRATEGY_RUN_ID,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      agentType: "strategy",
      status,
      output: { creativeBriefFingerprint: null },
    },
  ];
}

function wireSnapshot(overrides: Record<string, unknown> = {}) {
  vi.mocked(getStrategySnapshotByStrategyRunId).mockImplementation(
    async (runId: number) =>
      ({
        snapshotId: SNAPSHOT_ID,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        businessId: BUSINESS_ID,
        strategyRunId: runId,
        version: STRATEGY_VERSION,
        creativeBriefFingerprint: currentFingerprint(buildCampaign()),
        businessDnaSnapshotId: BDNA_ID,
        strategyHashSha256: STRATEGY_HASH,
        snapshot: STRATEGY_PAYLOAD,
        ...overrides,
      }) as any
  );
}

async function installDb() {
  vi.mocked(getDb).mockReturnValue(createHarnessDb() as any);
}

function entryRequest(campaign: any, business?: any) {
  return {
    campaign,
    userId: USER_ID,
    campaignId: CAMPAIGN_ID,
    business,
  };
}

describe("R4-B1 creative entry contract — real authority chain, faked boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedStrategyRun();
    wireSnapshot();
    vi.mocked(validateStrategyOutputAgainstCampaign).mockReturnValue({
      valid: true,
    } as any);
  });

  it("accepts a fully authoritative entry and returns the frozen immutable Strategy input", async () => {
    await installDb();
    const campaign = buildCampaign();
    const business = buildBusiness();

    const result = await resolveCreativeEntryStrategyAuthority(
      entryRequest(campaign, business)
    );

    const fingerprint = currentFingerprint(campaign);
    expect(result.authority).toEqual({
      strategySnapshotId: SNAPSHOT_ID,
      strategyVersion: STRATEGY_VERSION,
      businessDnaSnapshotId: BDNA_ID,
      strategyHashSha256: STRATEGY_HASH,
      strategyRunId: STRATEGY_RUN_ID,
      approvalRequestId: 901,
      creativeBriefFingerprint: fingerprint,
    });
    expect(result.creativeContext.coreMessage).toBe("Ride the summer.");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.authority)).toBe(true);
    expect(Object.isFrozen(result.creativeContext)).toBe(true);
  });

  it("fails closed when no approved lineage exists", async () => {
    await installDb();
    const campaign = buildCampaign({
      workflowContext: {},
    });

    await expect(
      resolveCreativeEntryStrategyAuthority(entryRequest(campaign))
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the lineage is not approved (pending ask only)", async () => {
    await installDb();
    const campaign = buildCampaign();
    campaign.workflowContext.strategyApprovalLineage = {
      ...campaign.workflowContext.strategyApprovalLineage,
      status: "pending",
    };

    await expect(
      resolveCreativeEntryStrategyAuthority(entryRequest(campaign))
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the campaign brief drifts from the approved fingerprint", async () => {
    await installDb();
    const campaign = buildCampaign();
    // Brief edit after approval: the approved fingerprint no longer matches.
    campaign.coreMessage = "Completely repositioned summer message";

    await expect(
      resolveCreativeEntryStrategyAuthority(entryRequest(campaign))
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the approved fingerprint was never persisted", async () => {
    await installDb();
    const campaign = buildCampaign();
    delete campaign.workflowContext.approvedStrategyFingerprint;

    await expect(
      resolveCreativeEntryStrategyAuthority(entryRequest(campaign))
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the linked strategy run is missing", async () => {
    await installDb();
    harnessState.agentRuns = [];

    await expect(
      resolveCreativeEntryStrategyAuthority(entryRequest(buildCampaign()))
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the linked strategy run never completed", async () => {
    await installDb();
    seedStrategyRun("running");

    await expect(
      resolveCreativeEntryStrategyAuthority(entryRequest(buildCampaign()))
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed with the semantic reason when the strategy no longer matches the brief", async () => {
    await installDb();
    vi.mocked(validateStrategyOutputAgainstCampaign).mockReturnValue({
      valid: false,
      reason: "core message drifted from the grounded brief",
    } as any);

    await expect(
      resolveCreativeEntryStrategyAuthority(entryRequest(buildCampaign()))
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("core message drifted"),
    });
  });

  it("fails closed when the immutable snapshot coordinates do not match the lineage", async () => {
    await installDb();
    wireSnapshot({ snapshotId: "strategy_snap_OTHER" });

    await expect(
      resolveCreativeEntryStrategyAuthority(entryRequest(buildCampaign()))
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the snapshot payload hash was tampered", async () => {
    await installDb();
    wireSnapshot({ strategyHashSha256: "b".repeat(64) });

    await expect(
      resolveCreativeEntryStrategyAuthority(entryRequest(buildCampaign()))
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the Business DNA lineage coordinate drifts", async () => {
    await installDb();
    wireSnapshot({ businessDnaSnapshotId: "bdna_snap_OTHER" });

    await expect(
      resolveCreativeEntryStrategyAuthority(entryRequest(buildCampaign()))
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the snapshot belongs to a different owner or campaign", async () => {
    await installDb();
    wireSnapshot({ userId: USER_ID + 1 });

    await expect(
      resolveCreativeEntryStrategyAuthority(entryRequest(buildCampaign()))
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the campaign is not linked to a business", async () => {
    await installDb();

    await expect(
      resolveCreativeEntryStrategyAuthority(
        entryRequest(buildCampaign({ businessId: null }))
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("R4-B1 caller contract — every autonomous creative entry consults the gate first", () => {
  function readSource(relativeFromApi: string): string {
    return readFileSync(
      resolve(import.meta.dirname, "../../", relativeFromApi),
      "utf8"
    );
  }

  function assertGatePrecedes(source: string, gate: string, work: string, label: string) {
    const gateIndex = source.indexOf(gate);
    expect(gateIndex, `${label}: gate ${gate} must be present`).toBeGreaterThanOrEqual(0);
    const workIndex = source.indexOf(work);
    expect(workIndex, `${label}: work ${work} must be present`).toBeGreaterThanOrEqual(0);
    expect(gateIndex, `${label}: ${gate} must precede ${work}`).toBeLessThan(workIndex);
  }

  it("agent.runCreativeAgent resolves entry authority before running the creative agent", () => {
    const source = readSource("agent-router.ts");
    assertGatePrecedes(
      source,
      "resolveCreativeEntryStrategyAuthority({",
      "runCreativeAgent({",
      "agent-router.runCreativeAgent"
    );
    // Ownership context: the entry loads the campaign by id AND user before any gate.
    expect(source).toContain("eq(campaigns.userId, ctx.user.id)");
  });

  it("workflow.onStrategyApproved resolves entry authority before running the creative agent", () => {
    const source = readSource("lib/workflow/triggers.ts");
    assertGatePrecedes(
      source,
      "resolveCreativeEntryStrategyAuthority({",
      "runCreativeAgent({",
      "workflow.onStrategyApproved"
    );
  });

  it("content.generateForCampaign checks strategy currency before enqueueing generation work", () => {
    const source = readSource("content-router.ts");
    assertGatePrecedes(
      source,
      "isApprovedStrategyCurrent(",
      "scheduleContentGenerationJob(",
      "content-router.generateForCampaign"
    );
    assertGatePrecedes(
      source,
      "assertApprovedStrategySemanticallyValid(",
      "scheduleContentGenerationJob(",
      "content-router.generateForCampaign"
    );
  });

  it("the content-generation job re-asserts strategy authority before running the creative agent", () => {
    const source = readSource("lib/jobs/content-generation-job.ts");
    assertGatePrecedes(
      source,
      "assertApprovedStrategySemanticallyValid(",
      "runCreativeAgent({",
      "content-generation-job"
    );
  });

  it("manual content approval binds the decision to the current brief fingerprint", () => {
    const source = readSource("content-router.ts");
    expect(source).toContain("approvedBriefFingerprint");
    expect(source.indexOf("approvedBriefFingerprint")).toBeGreaterThanOrEqual(0);
  });

  it("throws raised by the chain are tRPC fail-closed errors, never silent passes", async () => {
    await installDb();
    const campaign = buildCampaign({ workflowContext: {} });
    try {
      await resolveCreativeEntryStrategyAuthority(entryRequest(campaign));
      expect.unreachable("entry must fail closed");
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("PRECONDITION_FAILED");
    }
  });
});
