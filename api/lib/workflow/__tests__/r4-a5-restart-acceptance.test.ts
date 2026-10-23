/**
 * WBS-R4 A5 — Lifecycle restart acceptance.
 *
 * Simulates, end to end at router/trigger level, the restart windows called
 * out by the Core Lifecycle Contract:
 *
 *   R1 bootstrap + duplicate triggers (campaign idempotency, A2-2 review dedup)
 *   R2 restart between persistence and execution (entry-gate CONFLICT,
 *     decided-but-undispatched approval recovery)
 *   R3 restart after execution but before state update (dangling strategy-run
 *     completion sweep + lost creative-kickoff window)
 *   R4 delayed approval (decided later, matching fingerprint) and stale
 *     decision fail-closed (superseded review cannot clobber the new cycle)
 *   R5 budget pause/resume (bound provenance, exact continuation re-drive,
 *     duplicate/unbound decisions)
 *   R6 FINAL STREAM A ACCEPTANCE: one continuous fresh-business proof from
 *     bootstrap through creative entry, governed learning, promotion approval,
 *     deterministic next-cycle instruction, dispatched cycle 2 (immutable
 *     snapshot v2 with learningPromotionInputs + DNA lineage), the cycle N+1
 *     review, and the third-cycle replacement proof (A4-2).
 *
 * Harness replicated from r1.9-forward-autonomy-e2e.test.ts: fake db over
 * harness state, fake agents/queue/claims, real engine transitions, real
 * triggers/reconcilers. No live providers, no real database.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

import { buildGroundedCreativeBrief } from "../../creative/brief-grounding";
import { hashStrategySnapshotPayload } from "../../strategy/strategy-snapshot";
import {
  buildStrategyApprovalLineage,
  type StrategyApprovalLineage,
} from "../strategy-approval";
import { normaliseObservations } from "../../learning/contracts/observation";
import { runPostLiveMetricsObservationPass } from "../post-live-metrics-observation-pass";
import { triggerNextCycleAfterLearningPromotion } from "../next-cycle-trigger";
import { dispatchNextCycleInstruction } from "../next-cycle-dispatcher";
import {
  buildNextCycleIdentity,
  type ApprovedLearningStrategyInput,
} from "../../learning/learning-strategy-consumption";
import {
  buildLearningPromotionContext,
  buildLearningPromotionProposalFingerprint,
  type LearningPromotionCoordinates,
} from "../../learning/promotion/promotion-contract";
import { buildApprovedPromotionEnvelope } from "../../learning/promotion/promotion-envelope";
import { assertStrategyEntryGates } from "../../agents/strategy-entry-gates";
import { pauseWorkflowForCostLimit } from "../../billing/cost-control";
import { resumeWorkflowAfterApprovedCostIncrease } from "../budget-resume";
import {
  classifyApprovalContinuation,
  reconcileApprovalContinuation,
  reconcileDanglingStrategyRunCompletions,
} from "../approval-continuation";
import { COST_PAUSE_CONTEXT_KEY } from "../cost-pause";

// ── Hoisted harness state ──────────────────────────────────────────────────

const harness = vi.hoisted(() => ({
  campaign: undefined as any,
  business: undefined as any,
  agentRuns: [] as any[],
  approvalRequests: [] as any[],
  creditTransactions: [] as any[],
  publishingQueue: [] as any[],
  analytics: [] as any[],
  contentPosts: [] as any[],
  nextIds: {
    agent_runs: 6000,
    approval_requests: 9000,
    credit_transactions: 3000,
    publishing_queue: 5000,
    analytics: 7000,
    content_posts: 4000,
    campaigns: 100,
  } as Record<string, number>,
  creativeCalls: 0,
  runStrategyCalls: [] as Array<{ userId: number; campaignId: number }>,
  createStrategyReviewCalls: [] as Array<{ strategyRunId: number }>,
  usageIncrements: 0,
  campaignInserts: 0,
}));

// ── Module mocks (external boundaries only) ────────────────────────────────

vi.mock("../../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../../../lib/subscription", () => ({
  checkLimit: vi.fn(async () => ({ allowed: true })),
  incrementCampaignUsage: vi.fn(async () => {
    harness.usageIncrements += 1;
  }),
}));

vi.mock("../../agents/strategy-agent", () => ({
  validateStrategyOutputAgainstCampaign: vi.fn(() => ({ valid: true })),
}));

vi.mock("../../agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(async (input: any) => {
    harness.creativeCalls += 1;
    // Mimic the real agent's post-success keyed charge evidence so approval
    // replay idempotency is exercised through the real dedup guard.
    harness.creditTransactions.push({
      id: harness.nextIds.credit_transactions++,
      userId: input.userId,
      campaignId: input.campaignId,
      type: "agent_deduction",
      idempotencyKey: `creative-success:${input.campaignId}:approval:${input.generationOperation.id}`,
    });
    return { packRunId: 701 };
  }),
}));

vi.mock("../../agents/audience-agent", () => ({
  runAudienceAgent: vi.fn(async () => ({ runId: 710 })),
}));

vi.mock("../../agents/distribution-agent", () => ({
  runDistributionAgent: vi.fn(async () => ({ runId: 720 })),
}));

vi.mock("../../agents/audience-intelligence-agent", () => ({
  runAudienceIntelligenceAgent: vi.fn(async () => ({ runId: 730 })),
}));

vi.mock("../../audience/access", () => ({
  checkAudienceAgentAccess: vi.fn(async () => ({ allowed: false, reason: "no tiers in harness" })),
}));

// Partial mock: the REAL pauseWorkflowForCostLimit/recordWorkflowCostPause run
// (R5 exercises the A3-3 binding end to end); only the affordability gate is
// faked.
vi.mock("../../billing/cost-control", async () => {
  const actual =
    await vi.importActual<typeof import("../../billing/cost-control")>(
      "../../billing/cost-control"
    );
  return {
    ...actual,
    canRunAutonomousWorkflow: vi.fn(async () => ({ allowed: true })),
  };
});

vi.mock("../../queue/bullmq", () => ({
  isBullMQAvailable: vi.fn(() => false),
  schedulePublishingJob: vi.fn(async () => ({ id: "harness-job" })),
}));

vi.mock("../../../audience/ingest", () => ({
  ingestAudienceData: vi.fn(async () => {}),
}));

vi.mock("../../creative/creative-generation-claim", () => ({
  acquireCreativeGenerationClaim: vi.fn(async () => ({
    acquired: true,
    claim: { id: 1001, ownerToken: "harness-owner" },
  })),
  rearmCreativeGenerationClaim: vi.fn(async () => null),
  releaseClaimWithResult: vi.fn(async () => ({ released: true })),
  generateOwnerToken: vi.fn(() => "harness-owner-token"),
  calculateLeaseExpiresAt: vi.fn(() => new Date(Date.now() + 60_000)),
  createClaimHeartbeatController: vi.fn(() => ({ stop: async () => {} })),
}));

vi.mock("../../strategy/strategy-snapshot-db-store", () => ({
  getStrategySnapshotByStrategyRunId: vi.fn(),
}));

// Real engine transition semantics over the harness campaign, real
// createApprovalRequest; only the transaction/audit plumbing is bypassed.
vi.mock("../engine", async () => {
  const actual = await vi.importActual<typeof import("../engine")>("../engine");
  return {
    ...actual,
    transitionCampaignState: vi.fn(
      async (campaignId: number, userId: number, action: any) => {
        if (!harness.campaign || harness.campaign.id !== campaignId) {
          throw new Error("campaign not found");
        }
        const next = actual.resolveWorkflowTransition(harness.campaign.workflowState, action);
        if (!next) {
          throw new Error(`Invalid transition ${action} from ${harness.campaign.workflowState}`);
        }
        harness.campaign.workflowState = next;
        return next;
      }
    ),
  };
});

// ── Fake database over harness state ───────────────────────────────────────

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

const TABLE_ROWS: Record<string, () => any[]> = {
  campaigns: () => (harness.campaign ? [harness.campaign] : []),
  businesses: () => (harness.business ? [harness.business] : []),
  agent_runs: () => harness.agentRuns,
  approval_requests: () => harness.approvalRequests,
  credit_transactions: () => harness.creditTransactions,
  publishing_queue: () => harness.publishingQueue,
  analytics: () => harness.analytics,
  content_posts: () => harness.contentPosts,
};

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

function filterRows(rows: any[], condition: unknown): any[] {
  const filters = getColumnFilters(condition);
  return rows.filter((r) =>
    filters.every((f) => {
      // JSON_EXTRACT equality on workflowContext (bootstrap idempotency key):
      // the fake db emulates MySQL by matching the extracted key.
      if (f.name === "workflowContext" && typeof f.value === "string") {
        const ctx =
          r.workflowContext && typeof r.workflowContext === "object" ? r.workflowContext : {};
        return ctx.bootstrapIdempotencyKey === f.value;
      }
      // Date-window filter (e.g. completedAt >= cutoff) emulation.
      if (f.value instanceof Date) {
        const t = r[f.name] ? new Date(r[f.name] as any).getTime() : NaN;
        return !Number.isNaN(t) && t >= f.value.getTime();
      }
      return r[f.name] === f.value;
    })
  );
}

function createHarnessDb() {
  const insertCalls: Array<{ table: string; values: any }> = [];
  const db: any = {
    insertCalls,
    transaction: async (callback: (tx: any) => Promise<unknown>) => callback(db),
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const name = getTableName(table) ?? "";
          const base = TABLE_ROWS[name] ? TABLE_ROWS[name]() : [];
          const rows = name === "campaigns" || name === "businesses" ? base : filterRows(base, condition);
          return {
            orderBy: () => ({
              limit: async (_n: number) =>
                rows.slice().sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))),
            }),
            limit: async (_n: number) => rows.map((r: any) => ({ ...r })),
            then: (resolve: (value: any[]) => unknown) =>
              Promise.resolve(rows.map((r: any) => ({ ...r }))).then(resolve),
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: any) => {
        const name = getTableName(table) ?? "unknown";
        insertCalls.push({ table: name, values });
        const id = harness.nextIds[name] ?? 9999;
        harness.nextIds[name] = id + 1;
        const row = { id, ...values };
        if (name === "campaigns") {
          // Campaign rows live singly on the harness; the create replay must
          // never produce a second row. Merge workflowContext so seeded
          // authority (e.g. savedPosts evidence) survives the bootstrap write.
          harness.campaignInserts += 1;
          harness.campaign = {
            ...harness.campaign,
            ...row,
            workflowContext: {
              ...(harness.campaign?.workflowContext ?? {}),
              ...(row.workflowContext ?? {}),
            },
          };
        } else if (TABLE_ROWS[name]) {
          TABLE_ROWS[name]().push(row);
        }
        return [{ insertId: id }];
      },
    }),
    update: (table: unknown) => ({
      set: (payload: any) => ({
        where: async (condition: unknown) => {
          const name = getTableName(table) ?? "";
          if (name === "campaigns") {
            Object.assign(harness.campaign, payload);
            return [{ affectedRows: 1 }];
          }
          const rows = TABLE_ROWS[name] ? TABLE_ROWS[name]() : [];
          const filters = getColumnFilters(condition);
          let affected = 0;
          for (const row of rows) {
            if (filters.every((f) => row[f.name] === f.value)) {
              Object.assign(row, payload);
              affected += 1;
            }
          }
          return [{ affectedRows: affected }];
        },
      }),
    }),
  };
  return db;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const USER_ID = 42;
const CAMPAIGN_ID = 29;
const BUSINESS_ID = 5;

// Cycle-1 immutable strategy authority.
const STRATEGY_PAYLOAD = {
  coreMessage: "Restart-proof summer.",
  valueProposition: "Handmade boards, built locally.",
  positioning: "Premium local craft",
  campaignTheme: "Summer board drop",
  personas: [{ name: "Sipho", demographics: "18-40" }],
};
const STRATEGY_HASH = hashStrategySnapshotPayload(STRATEGY_PAYLOAD as any);

// Cycle-2 authority: distinct material (new core message) carrying the
// promoted learning inputs; the DNA lineage (snapshot id) stays intact.
const CYCLE2_PAYLOAD = {
  ...STRATEGY_PAYLOAD,
  coreMessage: "Restart-proof winter.",
  learningPromotionInputs: [
    { learningRecordId: 501, recommendationId: "rec_improve_hook_ctr" },
  ],
};
const CYCLE2_HASH = hashStrategySnapshotPayload(CYCLE2_PAYLOAD as any);

const SNAPSHOT_V1_ID = "snap_a5_v1";
const SNAPSHOT_V2_ID = "snap_a5_v2";
const BDNA_ID = "bdna_a5";

function seedFreshProfile() {
  harness.business = {
    id: BUSINESS_ID,
    userId: USER_ID,
    name: "Acme Surf Co",
    industry: "retail",
    location: "Cape Town",
    productOrService: "Handmade surfboards",
    targetCustomer: "Surfers 18-40",
    brandTone: "bold",
    mainGoal: "Increase online orders",
    monthlyBudget: 2000,
    preferredPlatforms: "instagram,facebook",
    website: "https://acme.example.com",
    websiteEvidence: null,
  };
  harness.campaign = {
    id: CAMPAIGN_ID,
    userId: USER_ID,
    businessId: BUSINESS_ID,
    name: "Summer Board Drop",
    goal: "Sell 100 boards",
    platforms: "instagram,facebook",
    budget: 2000,
    workflowState: "strategy_pending",
    status: "active",
    approvalMode: "assisted",
    autoPublish: false,
    workflowContext: { savedPosts: 4 },
  };
  harness.agentRuns = [
    {
      id: 600,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      agentType: "strategy",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    },
    {
      id: 701,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      agentType: "creative",
      status: "completed",
      startedAt: new Date().toISOString(),
    },
  ];
  harness.approvalRequests = [];
  harness.creditTransactions = [];
  harness.nextIds = {
    agent_runs: 6000,
    approval_requests: 9000,
    credit_transactions: 3000,
    publishing_queue: 5000,
    analytics: 7000,
    content_posts: 4000,
    campaigns: CAMPAIGN_ID,
  };
  harness.publishingQueue = [
    {
      id: 5001,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      contentPostId: 801,
      platform: "instagram",
      status: "approved",
      scheduledAt: new Date().toISOString(),
      publishedAt: null,
      externalPostId: null,
    },
  ];
  harness.analytics = [];
  harness.contentPosts = [];
  harness.creativeCalls = 0;
  harness.runStrategyCalls = [];
  harness.createStrategyReviewCalls = [];
  harness.usageIncrements = 0;
  harness.campaignInserts = 0;
}

function briefFingerprint(): string {
  return buildGroundedCreativeBrief({ campaign: harness.campaign, business: harness.business }).fingerprint;
}

/**
 * Mirrors the approval decision transaction (api/approval-router.ts): the
 * decision records the approved fingerprint, flips the lineage to "approved"
 * and advances the campaign to strategy_approved BEFORE the post-commit
 * trigger fires. `decidedAt` can be advanced to prove delayed decisions are
 * honoured while the fingerprint still matches.
 */
function recordStrategyApprovalDecision(reviewId: number, decidedAt?: Date) {
  const context = { ...harness.campaign.workflowContext };
  context.approvedStrategyFingerprint = briefFingerprint();
  const lineage = context.strategyApprovalLineage as Record<string, unknown> | undefined;
  if (lineage) {
    context.strategyApprovalLineage = { ...lineage, status: "approved", approvalRequestId: reviewId };
  }
  harness.campaign.workflowContext = context;
  harness.campaign.workflowState = "strategy_approved";
  const review = harness.approvalRequests.find((r) => r.id === reviewId);
  if (review) {
    review.status = "approved";
    review.approvedAt = decidedAt ?? new Date();
  }
}

async function wireSnapshotAuthority() {
  const { getStrategySnapshotByStrategyRunId } = await import(
    "../../strategy/strategy-snapshot-db-store"
  );
  vi.mocked(getStrategySnapshotByStrategyRunId).mockImplementation(async (runId: number) => {
    const cycle2 = runId === 800;
    const payload = cycle2 ? CYCLE2_PAYLOAD : STRATEGY_PAYLOAD;
    return {
      snapshotId: cycle2 ? SNAPSHOT_V2_ID : SNAPSHOT_V1_ID,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      businessId: BUSINESS_ID,
      strategyRunId: runId,
      version: cycle2 ? 2 : 1,
      creativeBriefFingerprint: briefFingerprint(),
      businessDnaSnapshotId: BDNA_ID,
      // The presented payload must hash to the recorded authority.
      strategyHashSha256: hashStrategySnapshotPayload(payload as any),
      snapshot: payload,
    } as any;
  });
}

async function installDb() {
  const { getDb } = await import("../../../queries/connection");
  vi.mocked(getDb).mockReturnValue(createHarnessDb() as any);
}

async function triggers() {
  return import("../triggers");
}

function strategyReviews() {
  return harness.approvalRequests.filter((r) => r.approvalType === "strategy_review");
}

// ── Phases ─────────────────────────────────────────────────────────────────

describe.sequential("R4-A5 lifecycle restart acceptance", () => {
  beforeEach(async () => {
    // No clearAllMocks: it would strip the vi.mock factory implementations.
    // Harness state is fully reset per phase.
    seedFreshProfile();
    await installDb();
    await wireSnapshotAuthority();
  });

  it("R1: bootstrap durable authority + duplicate triggers collapse idempotently", async () => {
    const { onAgentRunComplete } = await triggers();

    // Business facts are the durable DNA authority (synthetic, sufficient).
    expect(harness.business.name).toBe("Acme Surf Co");
    expect(harness.business.productOrService).toBe("Handmade surfboards");
    expect(harness.business.targetCustomer).toBe("Surfers 18-40");
    expect(typeof briefFingerprint()).toBe("string");

    // Campaign bootstrap through the public router with idempotency key K.
    const { autonomousWorkflowRouter } = await import("../../../autonomous-workflow-router");
    const caller = autonomousWorkflowRouter.createCaller({
      resHeaders: new Headers(),
      user: { id: USER_ID, tierSlug: "free" },
      session: { verified: true },
    } as any);

    const first = await caller.startCampaignWorkflow({
      businessId: BUSINESS_ID,
      name: "Summer Board Drop",
      goal: "Sell 100 boards",
      idempotencyKey: "boot-key-r1",
    });
    expect(first).toEqual({ id: CAMPAIGN_ID, success: true });
    expect(harness.campaignInserts).toBe(1);
    expect(harness.usageIncrements).toBe(1);
    expect(harness.campaign.workflowContext.bootstrapIdempotencyKey).toBe("boot-key-r1");

    // Replay with the same K: same campaign, no second row, no extra usage.
    const replay = await caller.startCampaignWorkflow({
      businessId: BUSINESS_ID,
      name: "Summer Board Drop",
      goal: "Sell 100 boards",
      idempotencyKey: "boot-key-r1",
    });
    expect(replay).toEqual({
      id: first.id,
      success: true,
      idempotentReplay: true,
    });
    expect(harness.campaignInserts).toBe(1);
    expect(harness.usageIncrements).toBe(1);

    // Duplicate strategy-run completion with the state rolled back between
    // fires (the crash window): exactly ONE review, lineage bound once (A2-2).
    await onAgentRunComplete(600);
    expect(strategyReviews()).toHaveLength(1);
    const lineageAfterFirst = { ...harness.campaign.workflowContext.strategyApprovalLineage };

    harness.campaign.workflowState = "strategy_pending";
    await onAgentRunComplete(600);

    expect(strategyReviews()).toHaveLength(1);
    expect(harness.campaign.workflowContext.strategyApprovalLineage).toEqual(lineageAfterFirst);
    expect(harness.campaign.workflowState).toBe("strategy_generated");
  });

  it("R2: restart between persistence and execution — entry CONFLICT + decided-but-undispatched recovery", async () => {
    const { onAgentRunComplete } = await triggers();

    // A live (running) strategy run blocks re-entry with CONFLICT; the gate
    // fires before any second run row is created.
    expect(() =>
      assertStrategyEntryGates({
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        campaign: { id: CAMPAIGN_ID, businessId: BUSINESS_ID },
        strategyRuns: [
          {
            id: 600,
            agentType: "strategy",
            status: "running",
            startedAt: new Date().toISOString(),
          },
        ],
      })
    ).toThrowError(
      expect.objectContaining({ code: "CONFLICT" }) as unknown as TRPCError
    );

    // Approval decided (transaction applied) but onApprovalResolved never ran.
    await onAgentRunComplete(600);
    const review = strategyReviews()[0]!;
    recordStrategyApprovalDecision(review.id);
    expect(harness.creativeCalls).toBe(0);

    // The real reconciler recovers the continuation through the real trigger.
    const first = await reconcileApprovalContinuation(review.id);
    expect(first.reconciled).toBe(true);
    expect(first.kind).toBe("strategy_approved_kickoff_continuation");
    expect(harness.creativeCalls).toBe(1);

    // Second reconcile: the campaign advanced; no double execution.
    const second = await reconcileApprovalContinuation(review.id);
    expect(second.reconciled).toBe(false);
    expect(second.kind).toBe("none");
    expect(harness.creativeCalls).toBe(1);
  });

  it("R3: restart after execution but before state update — dangling run completion + lost creative kickoff", async () => {
    // (a) Run completed + snapshot persisted; the forward state update was
    // lost (onAgentRunComplete never ran). The sweep re-drives it. Only
    // strategy runs are selected (the seeded creative run 701 is ignored).
    expect(harness.campaign.workflowState).toBe("strategy_pending");
    const sweep1 = await reconcileDanglingStrategyRunCompletions({ windowHours: 24, limit: 50 });
    expect(sweep1.scanned).toBe(1);
    expect(sweep1.reconciled).toBe(1);
    expect(harness.campaign.workflowState).toBe("strategy_generated");
    expect(strategyReviews()).toHaveLength(1);

    // Second sweep: review bound, campaign advanced — nothing re-driven.
    const sweep2 = await reconcileDanglingStrategyRunCompletions({ windowHours: 24, limit: 50 });
    expect(sweep2.reconciled).toBe(0);
    expect(sweep2.skipped).toBe(1);
    expect(strategyReviews()).toHaveLength(1);

    // (b) Creative-kickoff window: approval transition + lineage applied,
    // kickoff lost. The classifier expectation + reconcile re-invoke the
    // continuation exactly once.
    const review = strategyReviews()[0]!;
    recordStrategyApprovalDecision(review.id);
    const expectation = classifyApprovalContinuation(
      { ...review, status: "approved" },
      {
        id: harness.campaign.id,
        userId: USER_ID,
        workflowState: harness.campaign.workflowState,
        workflowContext: harness.campaign.workflowContext,
      }
    );
    expect(expectation.kind).toBe("strategy_approved_kickoff_continuation");

    const recovered = await reconcileApprovalContinuation(review.id);
    expect(recovered.reconciled).toBe(true);
    expect(harness.creativeCalls).toBe(1);
    const again = await reconcileApprovalContinuation(review.id);
    expect(again.reconciled).toBe(false);
    expect(harness.creativeCalls).toBe(1);
  });

  it("R4: delayed approval continues normally; a superseded decision fails closed", async () => {
    const { onAgentRunComplete, onApprovalResolved } = await triggers();

    // Stale-decision setup: review1 is still PENDING when a NEW strategy run
    // completes for a regenerated cycle.
    await onAgentRunComplete(600);
    const review1 = strategyReviews()[0]!;
    expect(review1.status).toBe("pending");

    harness.agentRuns.push({
      id: 601,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      agentType: "strategy",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    // The cycle rolls back to strategy_pending before the new completion.
    harness.campaign.workflowState = "strategy_pending";
    await onAgentRunComplete(601);

    const reviews = strategyReviews();
    expect(reviews).toHaveLength(2);
    const oldReview = reviews.find((r) => r.id === review1.id)!;
    const newReview = reviews.find((r) => r.id !== review1.id)!;
    expect(oldReview.status).toBe("rejected");
    expect(String(oldReview.description)).toContain("Superseded");
    expect(newReview.status).toBe("pending");
    expect(harness.campaign.workflowContext.strategyApprovalLineage).toMatchObject({
      approvalRequestId: newReview.id,
      strategyRunId: 601,
      status: "pending",
    });

    // Attempting to decide the OLD approval fails closed at every boundary:
    // the classifier refuses (lineage moved on)…
    const expectation = classifyApprovalContinuation(
      { ...oldReview, status: "approved" },
      {
        id: harness.campaign.id,
        userId: USER_ID,
        workflowState: harness.campaign.workflowState,
        workflowContext: harness.campaign.workflowContext,
      }
    );
    expect(expectation.kind).toBe("none");
    // …and the real trigger refuses too (lineage.approvalRequestId mismatch),
    // so the new cycle is never clobbered.
    await onApprovalResolved(oldReview.id, "approved", USER_ID);
    expect(harness.creativeCalls).toBe(0);
    expect(newReview.status).toBe("pending");
    expect(harness.campaign.workflowContext.strategyApprovalLineage.approvalRequestId).toBe(
      newReview.id
    );

    // Delayed approval: review2 decided LATER (advanced decidedAt) with a
    // matching fingerprint drives the normal continuation to the creative
    // boundary exactly once.
    recordStrategyApprovalDecision(newReview.id, new Date("2026-08-01T00:00:00Z"));
    await onApprovalResolved(newReview.id, "approved", USER_ID);
    expect(harness.creativeCalls).toBe(1);
    expect(
      harness.creditTransactions.some(
        (t) => t.idempotencyKey === `creative-success:${CAMPAIGN_ID}:approval:${newReview.id}`
      )
    ).toBe(true);
  });

  it("R5: budget pause/resume — bound provenance, exact continuation re-drive, duplicate/unbound decisions", async () => {
    const { onApprovalResolved } = await triggers();

    // The real affordability gate calls this same governed pause authority.
    await pauseWorkflowForCostLimit(USER_ID, CAMPAIGN_ID, "Insufficient credits for autonomous workflow", {
      kind: "agent_run_complete",
      continuationId: 600,
    });

    expect(harness.campaign.workflowState).toBe("launch_approval_required");
    expect(harness.campaign.status).toBe("paused");
    const pauseApproval = harness.approvalRequests.find((r) => r.approvalType === "budget_increase")!;
    expect(pauseApproval.status).toBe("pending");
    // WBS-R4 A3-3: the pause provenance is bound to its approval.
    const provenance = harness.campaign.workflowContext[COST_PAUSE_CONTEXT_KEY];
    expect(provenance).toMatchObject({
      kind: "agent_run_complete",
      continuationId: 600,
      budgetIncreaseApprovalId: pauseApproval.id,
    });

    // An unbound second budget decision cannot resume this pause.
    harness.approvalRequests.push({
      id: 9500,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      approvalType: "budget_increase",
      status: "pending",
    });
    const unbound = await resumeWorkflowAfterApprovedCostIncrease({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      approvalId: 9500,
    });
    expect(unbound).toEqual({ outcome: "not_bound" });
    expect(harness.campaign.workflowState).toBe("launch_approval_required");
    expect(harness.campaign.workflowContext[COST_PAUSE_CONTEXT_KEY]).toBeTruthy();

    // Approving the BOUND approval resumes at the exact continuation point.
    pauseApproval.status = "approved";
    await onApprovalResolved(pauseApproval.id, "approved", USER_ID);

    expect(harness.campaign.status).toBe("active");
    expect(harness.campaign.workflowContext[COST_PAUSE_CONTEXT_KEY]).toBeUndefined();
    expect(harness.campaign.workflowState).toBe("strategy_generated");
    expect(strategyReviews()).toHaveLength(1);

    // Duplicate decision on the same approval: the pause is already claimed;
    // nothing re-runs.
    await onApprovalResolved(pauseApproval.id, "approved", USER_ID);
    expect(strategyReviews()).toHaveLength(1);
    expect(harness.creativeCalls).toBe(0);
  });

  it("R6: FINAL STREAM A ACCEPTANCE — continuous fresh-profile proof through repeated governed cycles", async () => {
    const { onAgentRunComplete, onApprovalResolved } = await triggers();

    // (1) Fresh business DNA authority + campaign bootstrap via the router.
    const { autonomousWorkflowRouter } = await import("../../../autonomous-workflow-router");
    const caller = autonomousWorkflowRouter.createCaller({
      resHeaders: new Headers(),
      user: { id: USER_ID, tierSlug: "free" },
      session: { verified: true },
    } as any);
    const created = await caller.startCampaignWorkflow({
      businessId: BUSINESS_ID,
      name: "Summer Board Drop",
      goal: "Sell 100 boards",
      idempotencyKey: "boot-key-r6",
    });
    expect(created.success).toBe(true);
    expect(harness.usageIncrements).toBe(1);

    // (2) Strategy run completion → immutable snapshot v1 lineage + review.
    await onAgentRunComplete(600);
    expect(harness.campaign.workflowState).toBe("strategy_generated");
    const review1 = strategyReviews()[0]!;
    expect(review1.status).toBe("pending");
    const lineageV1 = harness.campaign.workflowContext.strategyApprovalLineage;
    expect(lineageV1).toMatchObject({
      strategySnapshotId: SNAPSHOT_V1_ID,
      strategyVersion: 1,
      businessDnaSnapshotId: BDNA_ID,
      strategyHashSha256: STRATEGY_HASH,
      strategyRunId: 600,
      approvalRequestId: review1.id,
      status: "pending",
    });

    // (3) Approval → autonomous creative-entry boundary (Stream A/C hand-off).
    recordStrategyApprovalDecision(review1.id);
    await onApprovalResolved(review1.id, "approved", USER_ID);
    expect(harness.campaign.workflowState).toBe("creatives_ready");
    expect(harness.creativeCalls).toBe(1);
    expect(
      harness.creditTransactions.some(
        (t) => t.idempotencyKey === `creative-success:${CAMPAIGN_ID}:approval:${review1.id}`
      )
    ).toBe(true);

    // (4) Governed learning: observation pass → grounded observations →
    // learning record facts → promotion proposed (real contract builders).
    harness.publishingQueue[0].status = "published";
    harness.publishingQueue[0].publishedAt = new Date().toISOString();
    harness.publishingQueue[0].externalPostId = "ext-a5";
    const persisted: any[] = [];
    const observation = await runPostLiveMetricsObservationPass({
      asOfDate: "2026-06-12",
      deps: {
        listPublishedCandidates: async () => [
          {
            queueItemId: 5001,
            userId: USER_ID,
            campaignId: CAMPAIGN_ID,
            platform: "instagram",
            publishedAt: harness.publishingQueue[0].publishedAt,
            externalPostId: "ext-a5",
          },
        ],
        loadLastObservedAt: async () =>
          harness.analytics.length > 0 ? new Date().toISOString() : null,
        resolveBinding: () => ({
          platform: "instagram" as const,
          fetchPostMetrics: async () => [
            { metricType: "impressions", value: 800 },
            { metricType: "clicks", value: 42 },
          ],
        }),
        persistObservations: async (input: any) => {
          persisted.push(input);
        },
      },
    });
    expect(observation).toMatchObject({ due: 1, observed: 1 });
    persisted[0].metrics.forEach((m: any) =>
      harness.analytics.push({
        id: harness.nextIds.analytics++,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        platform: "instagram",
        metricType: m.metricType,
        value: m.value,
        date: "2026-06-12",
      })
    );
    const { observations } = normaliseObservations(
      harness.analytics.map((a: any) => ({
        id: a.id,
        metricType: a.metricType,
        platform: a.platform,
        value: a.value,
        date: a.date,
      })),
      "2026-06-12",
      "2026-06-12"
    );
    expect(observations.every((o) => o.provenance.kind === "analytics")).toBe(true);

    // Learning record + proposal coordinates (governed evaluation output).
    const coordinates: LearningPromotionCoordinates = {
      learningRecordId: 501,
      campaignId: CAMPAIGN_ID,
      evaluationVersion: "learning-v2",
      learningEngine: "learning-engine",
      learningEngineVersion: "learning-v2",
      learningInputDigest: "digest-501",
      recommendationId: "rec_improve_hook_ctr",
      targetEngine: "strategy",
      adjustmentType: "improve_hook_ctr",
      summary: "Strengthen hooks",
      rationale: "Weak CTR",
      evidenceRefs: ["ao:1"],
    };
    const proposalFingerprint = buildLearningPromotionProposalFingerprint(coordinates);
    const context = buildLearningPromotionContext({ coordinates, proposalFingerprint });
    const envelope = buildApprovedPromotionEnvelope({
      context,
      approvalRequestId: 901,
      decidedAt: "2026-06-12T00:00:00.000Z",
      decidedByUserId: USER_ID,
      recordEvidence: [{ kind: "observation", ref: "ao:1", note: "clicks=42 (analytics row)" }],
    });
    expect(envelope.decision).toBe("approved");

    // (5) Promotion approval → deterministic next-cycle instruction.
    harness.campaign.workflowContext.strategyHashSha256 = STRATEGY_HASH;
    const approvedInput: ApprovedLearningStrategyInput = {
      scope: "same-campaign",
      businessId: BUSINESS_ID,
      promotions: [
        {
          sourceCampaignId: CAMPAIGN_ID,
          learningRecordId: envelope.learningRecordId,
          evaluationVersion: envelope.evaluationVersion,
          learningEngineVersion: envelope.learningAuthority.engineVersion,
          recommendationId: envelope.promoted.recommendationId,
          targetEngine: envelope.promoted.targetEngine,
          adjustmentType: envelope.promoted.adjustmentType,
          summary: envelope.promoted.summary,
          rationale: envelope.promoted.rationale,
          evidenceRefs: [...envelope.promoted.evidenceRefs],
          approvalRequestId: envelope.approvalRequestId,
          proposalFingerprint: envelope.proposalFingerprint,
          decidedAt: envelope.decidedAt,
          promotedProvenanceClass: "approved_recommendation",
        },
      ],
    };
    const resolveApprovedPromotions = async () => approvedInput;
    const trigger1 = await triggerNextCycleAfterLearningPromotion({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      deps: { resolveApprovedPromotions },
    });
    const instructionN1 = buildNextCycleIdentity({
      campaignId: CAMPAIGN_ID,
      strategyHashSha256: STRATEGY_HASH,
      proposalFingerprints: [proposalFingerprint],
    });
    expect(trigger1).toEqual({ outcome: "created", instructionId: instructionN1 });
    expect(harness.campaign.workflowContext.nextCycle).toEqual({
      instructionId: instructionN1,
      status: "ready",
    });

    // (6) Dispatch → runStrategyAgent for cycle 2 → immutable snapshot v2.
    harness.agentRuns.push({
      id: 800,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      agentType: "strategy",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    const runStrategy = async (input: any) => {
      harness.runStrategyCalls.push({ userId: input.userId, campaignId: input.campaignId });
      // The new cycle writes its own authoritative hash into context.
      harness.campaign.workflowContext = {
        ...harness.campaign.workflowContext,
        strategyHashSha256: CYCLE2_HASH,
      };
      return { runId: 800 };
    };
    const { createApprovalRequest } = await import("../engine");
    const createStrategyReview = async (input: any) => {
      harness.createStrategyReviewCalls.push({ strategyRunId: input.strategyRunId });
      const { id: approvalRequestId } = await createApprovalRequest({
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        approvalType: "strategy_review",
        title: `Approve Strategy: ${harness.campaign.name}`,
        description: "Next governed cycle strategy.",
        aiRecommendation: "Aligned with the current goal and approved Learning recommendations.",
        riskLevel: "low",
      });
      const lineage: StrategyApprovalLineage = buildStrategyApprovalLineage(
        briefFingerprint(),
        input.strategyRunId,
        approvalRequestId,
        "pending",
        {
          strategySnapshotId: SNAPSHOT_V2_ID,
          strategyVersion: 2,
          businessDnaSnapshotId: BDNA_ID,
          strategyHashSha256: CYCLE2_HASH,
        }
      );
      return { approvalRequestId, lineage };
    };

    const dispatch1 = await dispatchNextCycleInstruction({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      instructionId: instructionN1,
      deps: { runStrategy, createStrategyReview },
    });
    expect(dispatch1).toMatchObject({ outcome: "dispatched", strategyRunId: 800 });
    expect(harness.runStrategyCalls).toEqual([{ userId: USER_ID, campaignId: CAMPAIGN_ID }]);
    expect(harness.createStrategyReviewCalls).toEqual([{ strategyRunId: 800 }]);
    expect(harness.campaign.workflowContext.nextCycle).toEqual({
      instructionId: instructionN1,
      status: "dispatched",
    });

    // Immutable snapshot v2: version 2, distinct hash, learningPromotionInputs
    // lineage retained, DNA lineage intact.
    expect(CYCLE2_HASH).not.toBe(STRATEGY_HASH);
    expect(CYCLE2_PAYLOAD.learningPromotionInputs).toEqual([
      { learningRecordId: 501, recommendationId: "rec_improve_hook_ctr" },
    ]);
    const lineageV2 = harness.campaign.workflowContext.strategyApprovalLineage;
    expect(lineageV2).toMatchObject({
      strategySnapshotId: SNAPSHOT_V2_ID,
      strategyVersion: 2,
      businessDnaSnapshotId: BDNA_ID,
      strategyHashSha256: CYCLE2_HASH,
      strategyRunId: 800,
      status: "pending",
    });
    // Normal strategy_review governance for cycle N+1.
    if (dispatch1.outcome !== "dispatched") throw new Error("expected a dispatched cycle 2");
    const review2 = strategyReviews().find((r) => r.id === dispatch1.approvalRequestId)!;
    expect(review2.status).toBe("pending");
    expect(lineageV2.approvalRequestId).toBe(review2.id);

    // (7) Third cycle is NOT blocked: a new promotion mints a different
    // instruction over the new cycle material and REPLACES the dispatched one
    // (WBS-R4 A4-2 repeated-cycle semantics).
    const coordinates2: LearningPromotionCoordinates = {
      ...coordinates,
      recommendationId: "rec_sharpen_offer",
      adjustmentType: "sharpen_offer_alignment",
      summary: "Sharpen the offer",
      rationale: "Weak conversion",
    };
    const proposalFingerprint2 = buildLearningPromotionProposalFingerprint(coordinates2);
    expect(proposalFingerprint2).not.toBe(proposalFingerprint);
    const context2 = buildLearningPromotionContext({
      coordinates: coordinates2,
      proposalFingerprint: proposalFingerprint2,
    });
    const envelope2 = buildApprovedPromotionEnvelope({
      context: context2,
      approvalRequestId: 902,
      decidedAt: "2026-06-13T00:00:00.000Z",
      decidedByUserId: USER_ID,
      recordEvidence: [{ kind: "observation", ref: "ao:2", note: "conversions=1" }],
    });
    const approvedInput2: ApprovedLearningStrategyInput = {
      scope: "same-campaign",
      businessId: BUSINESS_ID,
      promotions: [
        {
          sourceCampaignId: CAMPAIGN_ID,
          learningRecordId: envelope2.learningRecordId,
          evaluationVersion: envelope2.evaluationVersion,
          learningEngineVersion: envelope2.learningAuthority.engineVersion,
          recommendationId: envelope2.promoted.recommendationId,
          targetEngine: envelope2.promoted.targetEngine,
          adjustmentType: envelope2.promoted.adjustmentType,
          summary: envelope2.promoted.summary,
          rationale: envelope2.promoted.rationale,
          evidenceRefs: [...envelope2.promoted.evidenceRefs],
          approvalRequestId: envelope2.approvalRequestId,
          proposalFingerprint: envelope2.proposalFingerprint,
          decidedAt: envelope2.decidedAt,
          promotedProvenanceClass: "approved_recommendation",
        },
      ],
    };
    const trigger2 = await triggerNextCycleAfterLearningPromotion({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      deps: { resolveApprovedPromotions: async () => approvedInput2 },
    });
    const instructionN2 = buildNextCycleIdentity({
      campaignId: CAMPAIGN_ID,
      strategyHashSha256: CYCLE2_HASH,
      proposalFingerprints: [proposalFingerprint2],
    });
    expect(instructionN2).not.toBe(instructionN1);
    expect(trigger2).toEqual({ outcome: "created", instructionId: instructionN2 });
    expect(harness.campaign.workflowContext.nextCycle).toEqual({
      instructionId: instructionN2,
      status: "ready",
    });
  });
});
