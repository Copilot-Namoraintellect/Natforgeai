/**
 * WBS-R1.9 — Connected autonomous E2E harness.
 *
 * Proves the fresh-profile forward chain end to end with controlled fakes at
 * every external boundary (LLM agents, provider platform, Redis/BullMQ,
 * database) and REAL internal wiring everywhere else:
 *
 *   Business/Profile → Business DNA → Campaign → Strategy → governed
 *   strategy_review approval → Creative → Audience → Distribution →
 *   Publishing (launch authority) → observation → KPI → Learning grounding →
 *   approved promotion envelope → next-cycle instruction → new governed
 *   Strategy cycle
 *
 * Retry/idempotency assertions sit at the financially/lifecycle-sensitive
 * boundaries: creative-success charge replay, audience/distribution billing
 * identity stability, observation due-window, next-cycle trigger replay and
 * dispatcher exact-once.
 *
 * No live provider calls, no production database, no schedulers.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import { buildGroundedCreativeBrief } from "../../creative/brief-grounding";
import { hashStrategySnapshotPayload } from "../../strategy/strategy-snapshot";
import {
  buildLearningPromotionContext,
  buildLearningPromotionProposalFingerprint,
  LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE,
  type LearningPromotionCoordinates,
} from "../../learning/promotion/promotion-contract";
import { buildApprovedPromotionEnvelope } from "../../learning/promotion/promotion-envelope";
import {
  buildNextCycleIdentity,
  type ApprovedLearningStrategyInput,
} from "../../learning/learning-strategy-consumption";
import { normaliseObservations } from "../../learning/contracts/observation";
import { runPostLiveMetricsObservationPass } from "../post-live-metrics-observation-pass";
import { triggerNextCycleAfterLearningPromotion } from "../next-cycle-trigger";
import { dispatchNextCycleInstruction } from "../next-cycle-dispatcher";
import {
  buildStrategyApprovalLineage,
  type StrategyApprovalLineage,
} from "../strategy-approval";
import {
  buildAudienceBillingIdentity,
  buildDistributionBillingIdentity,
} from "../agent-billing-identity";

// ── Hoisted shared harness state (safe to reference inside vi.mock factories) ──

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
  } as Record<string, number>,
  audienceBillingIdentities: [] as any[],
  distributionBillingIdentities: [] as any[],
  creativeCalls: 0,
  runStrategyCalls: 0 as Array<{ userId: number; campaignId: number }>,
  createStrategyReviewCalls: 0 as Array<{ strategyRunId: number }>,
}));

// ── Module mocks (external boundaries only) ────────────────────────────────

vi.mock("../../../queries/connection", () => ({
  getDb: vi.fn(),
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
  runAudienceAgent: vi.fn(async (input: any) => {
    harness.audienceBillingIdentities.push(input.billingIdentity ?? null);
    // Register the run the real agent would have inserted.
    harness.agentRuns.push({ id: 710, userId: 42, campaignId: 29, agentType: "audience", status: "completed", startedAt: new Date().toISOString() });
    return { runId: 710 };
  }),
}));

vi.mock("../../agents/distribution-agent", () => ({
  runDistributionAgent: vi.fn(async (input: any) => {
    harness.distributionBillingIdentities.push(input.billingIdentity ?? null);
    harness.agentRuns.push({ id: 720, userId: 42, campaignId: 29, agentType: "distribution", status: "completed", startedAt: new Date().toISOString() });
    return { runId: 720 };
  }),
}));

vi.mock("../../agents/audience-intelligence-agent", () => ({
  runAudienceIntelligenceAgent: vi.fn(async () => ({ runId: 730 })),
}));

vi.mock("../../../audience/access", () => ({
  checkAudienceAgentAccess: vi.fn(async () => ({ allowed: false, reason: "no tiers in harness" })),
}));

vi.mock("../../billing/cost-control", () => ({
  canRunAutonomousWorkflow: vi.fn(async () => ({ allowed: true })),
}));

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
  if (!sql || typeof sql !== "object" || !Array.isArray(sql.queryChunks)) {
    return [];
  }
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
  return rows.filter((r) => filters.every((f) => r[f.name] === f.value));
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
            then: (resolve: (value: any[]) => unknown) => Promise.resolve(rows.map((r: any) => ({ ...r }))).then(resolve),
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
        if (TABLE_ROWS[name]) TABLE_ROWS[name]().push(row);
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
// The persisted strategy snapshot payload and its REAL canonical hash — the
// mocked snapshot store must present a payload whose hash matches the
// authority or the creative entry authority fails closed.
const STRATEGY_PAYLOAD = {
  coreMessage: "Ride the summer.",
  valueProposition: "Handmade boards, built locally.",
  positioning: "Premium local craft",
  campaignTheme: "Summer board drop",
  personas: [{ name: "Sipho", demographics: "18-40" }],
};
const STRATEGY_HASH = hashStrategySnapshotPayload(STRATEGY_PAYLOAD as any);
const SNAPSHOT_ID = "snap_r19";
const BDNA_ID = "bdna_r19";

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
    // The completed creative run saved four posts (real creative projection).
    workflowContext: { savedPosts: 4 },
  };
  harness.agentRuns = [
    { id: 600, userId: USER_ID, campaignId: CAMPAIGN_ID, agentType: "strategy", status: "completed", startedAt: new Date().toISOString() },
    { id: 701, userId: USER_ID, campaignId: CAMPAIGN_ID, agentType: "creative", status: "completed", startedAt: new Date().toISOString() },
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
  };
  harness.publishingQueue = [
    { id: 5001, userId: USER_ID, campaignId: CAMPAIGN_ID, contentPostId: 801, platform: "instagram", status: "approved", scheduledAt: new Date().toISOString(), publishedAt: null, externalPostId: null },
  ];
  harness.analytics = [];
  harness.contentPosts = [];
  harness.audienceBillingIdentities = [];
  harness.distributionBillingIdentities = [];
  harness.creativeCalls = 0;
  harness.runStrategyCalls = [];
  harness.createStrategyReviewCalls = [];
}

function briefFingerprint(): string {
  return buildGroundedCreativeBrief({ campaign: harness.campaign, business: harness.business }).fingerprint;
}

/**
 * Mirrors the approval decision transaction (api/approval-router.ts): before
 * onApprovalResolved fires post-commit, the decision records the approved
 * fingerprint and flips the strategy_review lineage to "approved" on the
 * campaign context. The harness drives the decision boundary directly.
 */
function recordStrategyApprovalDecision(reviewId: number) {
  const context = { ...harness.campaign.workflowContext };
  context.approvedStrategyFingerprint = briefFingerprint();
  const lineage = context.strategyApprovalLineage as Record<string, unknown> | undefined;
  if (lineage) {
    context.strategyApprovalLineage = { ...lineage, status: "approved", approvalRequestId: reviewId };
  }
  harness.campaign.workflowContext = context;
  // The synchronous decision router also advances the workflow to
  // strategy_approved before the async trigger fires; the trigger itself only
  // performs that transition when IT persists the approval.
  harness.campaign.workflowState = "strategy_approved";
}

async function wireSnapshotAuthority() {
  const { getStrategySnapshotByStrategyRunId } = await import("../../strategy/strategy-snapshot-db-store");
  vi.mocked(getStrategySnapshotByStrategyRunId).mockImplementation(async (runId: number) => ({
    snapshotId: SNAPSHOT_ID,
    userId: USER_ID,
    campaignId: CAMPAIGN_ID,
    businessId: BUSINESS_ID,
    strategyRunId: runId,
    version: 2,
    creativeBriefFingerprint: briefFingerprint(),
    businessDnaSnapshotId: BDNA_ID,
    strategyHashSha256: STRATEGY_HASH,
    snapshot: STRATEGY_PAYLOAD,
  }) as any);
}

async function installDb() {
  const { getDb } = await import("../../../queries/connection");
  vi.mocked(getDb).mockReturnValue(createHarnessDb() as any);
}

async function triggers() {
  const mod = await import("../triggers");
  return mod;
}

describe.sequential("R1.9 connected autonomous E2E — fresh-profile forward chain", () => {
  beforeEach(async () => {
    // NOTE: no clearAllMocks here — it would strip the vi.mock factory
    // implementations (claims, cost gate, agents). Harness state is fully
    // reset per phase and assertions read harness counters, not mock
    // histories.
    seedFreshProfile();
    await installDb();
    await wireSnapshotAuthority();
  });

  it("phase 1-2: Business/Profile + Business DNA + Campaign + Strategy produce a governed strategy_review approval", async () => {
    const { onAgentRunComplete } = await triggers();
    expect(harness.business.name).toBe("Acme Surf Co");
    expect(harness.campaign.workflowState).toBe("strategy_pending");

    await onAgentRunComplete(600);

    expect(harness.campaign.workflowState).toBe("strategy_generated");
    const review = harness.approvalRequests.find((r) => r.approvalType === "strategy_review");
    expect(review).toBeTruthy();
    expect(review.status).toBe("pending");
    const lineage = harness.campaign.workflowContext.strategyApprovalLineage;
    expect(lineage).toMatchObject({
      strategySnapshotId: SNAPSHOT_ID,
      strategyHashSha256: STRATEGY_HASH,
      strategyRunId: 600,
      approvalRequestId: review.id,
      status: "pending",
    });
  });

  it("phase 3: strategy_review approval drives Creative, then the chain auto-fires Audience with a stable billing identity", async () => {
    const { onAgentRunComplete, onApprovalResolved } = await triggers();
    await onAgentRunComplete(600);
    const review = harness.approvalRequests.find((r) => r.approvalType === "strategy_review")!;
    recordStrategyApprovalDecision(review.id);

    await onApprovalResolved(review.id, "approved", USER_ID);

    expect(harness.campaign.workflowState).toBe("creatives_ready");
    expect(harness.creativeCalls).toBe(1);
    // Creative success charge evidence recorded (financial boundary).
    expect(
      harness.creditTransactions.some(
        (t) => t.idempotencyKey === `creative-success:${CAMPAIGN_ID}:approval:${review.id}`
      )
    ).toBe(true);
    // Audience fired with the deterministic trigger-boundary billing identity.
    expect(harness.audienceBillingIdentities).toEqual([
      buildAudienceBillingIdentity({ campaignId: CAMPAIGN_ID, creativeRunId: 701 }),
    ]);

    // Replay idempotency: re-driving the creative completion must NOT re-fire
    // the audience agent (dedup guard sees the completed audience run).
    await onAgentRunComplete(701);
    expect(harness.audienceBillingIdentities).toHaveLength(1);
  });

  it("phase 4: Audience completion drives Distribution with a stable billing identity", async () => {
    const { onAgentRunComplete, onApprovalResolved } = await triggers();
    const { transitionCampaignState } = await import("../engine");
    await onAgentRunComplete(600);
    const review = harness.approvalRequests.find((r) => r.approvalType === "strategy_review")!;
    recordStrategyApprovalDecision(review.id);
    await onApprovalResolved(review.id, "approved", USER_ID);

    // Mirror the audience-start API boundary (engine transition).
    await transitionCampaignState(CAMPAIGN_ID, USER_ID, "generate_audience");
    await onAgentRunComplete(710);

    expect(harness.campaign.workflowState).toBe("audience_ready");
    expect(harness.distributionBillingIdentities).toEqual([
      buildDistributionBillingIdentity({ campaignId: CAMPAIGN_ID, audienceRunId: 710 }),
    ]);
    // Billing identity is stable across a retry of the same logical step.
    const retryIdentity = buildDistributionBillingIdentity({ campaignId: CAMPAIGN_ID, audienceRunId: 710 });
    expect(harness.distributionBillingIdentities[0]).toBe(retryIdentity);
  });

  it("phase 5-6: Distribution completion creates durable launch authority; approval reaches publication_pending", async () => {
    const { onAgentRunComplete, onApprovalResolved } = await triggers();
    const { transitionCampaignState } = await import("../engine");
    await onAgentRunComplete(600);
    const review = harness.approvalRequests.find((r) => r.approvalType === "strategy_review")!;
    recordStrategyApprovalDecision(review.id);
    await onApprovalResolved(review.id, "approved", USER_ID);
    await transitionCampaignState(CAMPAIGN_ID, USER_ID, "generate_audience");
    await onAgentRunComplete(710);
    await transitionCampaignState(CAMPAIGN_ID, USER_ID, "generate_schedule");

    await onAgentRunComplete(720);

    expect(harness.campaign.workflowState).toBe("launch_approval_required");
    const launch = harness.approvalRequests.find((r) => r.approvalType === "campaign_launch");
    expect(launch).toBeTruthy();
    const launchLineage = harness.campaign.workflowContext.launchApprovalLineage;
    expect(launchLineage?.approvalRequestId ?? launch?.id).toBeTruthy();

    await onApprovalResolved(launch!.id, "approved", USER_ID);

    expect(harness.campaign.workflowState).toBe("publication_pending");
    // BullMQ unavailable in harness: the approved queue row stays approved
    // and is left for the due-runner path (publishing authority unchanged).
    expect(harness.publishingQueue.find((q) => q.id === 5001)?.status).toBe("approved");
  });

  it("phase 7-8: observation pass records KPI metrics once per due window and grounds Learning observations", async () => {
    // Publish the seeded queue row (durable publication authority).
    harness.publishingQueue[0].status = "published";
    harness.publishingQueue[0].publishedAt = new Date().toISOString();
    harness.publishingQueue[0].externalPostId = "ext-r19";

    const persisted: any[] = [];
    const deps = {
      listPublishedCandidates: async () => [
        {
          queueItemId: 5001,
          userId: USER_ID,
          campaignId: CAMPAIGN_ID,
          platform: "instagram",
          publishedAt: harness.publishingQueue[0].publishedAt,
          externalPostId: "ext-r19",
        },
      ],
      loadLastObservedAt: async () => harness.analytics.length > 0 ? new Date().toISOString() : null,
      resolveBinding: () => ({
        platform: "instagram" as const,
        fetchPostMetrics: async () => [
          { metricType: "impressions", value: 800 },
          { metricType: "clicks", value: 42 },
        ],
      }),
      persistObservations: async (input: any) => persisted.push(input),
    };

    const first = await runPostLiveMetricsObservationPass({ asOfDate: "2026-06-12", deps });
    expect(first).toMatchObject({ due: 1, observed: 1 });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].metrics).toEqual([
      { metricType: "clicks", value: 42 },
      { metricType: "impressions", value: 800 },
    ]);
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

    // Retry inside the due window: not_due, no duplicate persistence.
    const retry = await runPostLiveMetricsObservationPass({ asOfDate: "2026-06-12", deps });
    expect(retry).toMatchObject({ due: 0, notDue: 1, observed: 0 });
    expect(persisted).toHaveLength(1);

    // Learning grounding: the persisted analytics rows normalise into
    // provenance-carrying observations (KPI → Learning hand-off).
    const { observations } = normaliseObservations(
      harness.analytics.map((a) => ({ id: a.id, metricType: a.metricType, platform: a.platform, value: a.value, date: a.date })),
      "2026-06-12",
      "2026-06-12"
    );
    expect(observations).toHaveLength(2);
    expect(observations.every((o) => o.provenance.kind === "analytics")).toBe(true);
  });

  it("phase 9: the learning promotion is sealed as a durable approved envelope", async () => {
    const coordinates: LearningPromotionCoordinates = {
      learningRecordId: 501,
      campaignId: CAMPAIGN_ID,
      evaluationVersion: "learning-v2",
      learningEngine: "learning-engine",
      learningEngineVersion: "learning-v2",
      learningInputDigest: "digest-501",
      recommendationId: "rec_improve_hook_ctr",
      targetEngine: "creative",
      adjustmentType: "improve_hook_ctr",
      summary: "Strengthen hooks",
      rationale: "Weak CTR",
      evidenceRefs: ["ao:1"],
    };
    const fingerprint = buildLearningPromotionProposalFingerprint(coordinates);
    const context = buildLearningPromotionContext({ coordinates, proposalFingerprint: fingerprint });
    const envelope = buildApprovedPromotionEnvelope({
      context,
      approvalRequestId: 901,
      decidedAt: "2026-06-12T00:00:00.000Z",
      decidedByUserId: USER_ID,
      recordEvidence: [{ kind: "observation", ref: "ao:1", note: "clicks=42 (analytics row)" }],
    });

    expect(envelope.decision).toBe("approved");
    expect(envelope.proposalFingerprint).toBe(fingerprint);
    expect(envelope.promoted.provenanceClass).toBe("approved_recommendation");
    expect(envelope.approvalRequestId).toBe(901);

    // Stash for the next phase.
    (harness as any).promotionEnvelope = envelope;
  });

  it("phase 10: approved promotion deterministically triggers the next-cycle instruction; replay cannot duplicate it", async () => {
    const envelope = (harness as any).promotionEnvelope;
    // The strategy cycle wrote the authoritative hash into campaign context.
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

    const first = await triggerNextCycleAfterLearningPromotion({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      deps: { resolveApprovedPromotions },
    });
    const expectedIdentity = buildNextCycleIdentity({
      campaignId: CAMPAIGN_ID,
      strategyHashSha256: STRATEGY_HASH,
      proposalFingerprints: [envelope.proposalFingerprint],
    });
    expect(first).toEqual({ outcome: "created", instructionId: expectedIdentity });
    expect(harness.campaign.workflowContext.nextCycle).toEqual({
      instructionId: expectedIdentity,
      status: "ready",
    });

    const replay = await triggerNextCycleAfterLearningPromotion({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      deps: { resolveApprovedPromotions },
    });
    expect(replay).toEqual({ outcome: "already_present", instructionId: expectedIdentity });
  });

  it("phase 11: the governed dispatcher consumes the instruction exactly once and produces a new Strategy cycle with strategy_review governance", async () => {
    const envelope = (harness as any).promotionEnvelope;
    harness.campaign.workflowContext.strategyHashSha256 = STRATEGY_HASH;
    const instructionId = buildNextCycleIdentity({
      campaignId: CAMPAIGN_ID,
      strategyHashSha256: STRATEGY_HASH,
      proposalFingerprints: [envelope.proposalFingerprint],
    });
    harness.campaign.workflowContext.nextCycle = { instructionId, status: "ready" };

    const runStrategy = async (input: any) => {
      harness.runStrategyCalls.push({ userId: input.userId, campaignId: input.campaignId });
      return { runId: 800 };
    };
    const lineage: StrategyApprovalLineage = buildStrategyApprovalLineage(
      briefFingerprint(),
      800,
      910,
      "pending",
      {
        strategySnapshotId: "snap_r19_v3",
        strategyVersion: 3,
        businessDnaSnapshotId: BDNA_ID,
        strategyHashSha256: STRATEGY_HASH,
      }
    );
    const createStrategyReview = async (input: any) => {
      harness.createStrategyReviewCalls.push({ strategyRunId: input.strategyRunId });
      return { approvalRequestId: 910, lineage };
    };

    const first = await dispatchNextCycleInstruction({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      instructionId,
      deps: { runStrategy, createStrategyReview },
    });
    expect(first).toEqual({
      outcome: "dispatched",
      instructionId,
      strategyRunId: 800,
      approvalRequestId: 910,
    });
    expect(harness.runStrategyCalls).toHaveLength(1);
    expect(harness.createStrategyReviewCalls).toEqual([{ strategyRunId: 800 }]);
    expect(harness.campaign.workflowContext.nextCycle).toEqual({
      instructionId,
      status: "dispatched",
    });
    expect(harness.campaign.workflowContext.strategyApprovalLineage).toEqual(lineage);

    // Exact-once: a duplicate dispatch must not re-run the strategy pathway.
    const replay = await dispatchNextCycleInstruction({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      instructionId,
      deps: { runStrategy, createStrategyReview },
    });
    expect(replay).toEqual({ outcome: "already_dispatched", instructionId });
    expect(harness.runStrategyCalls).toHaveLength(1);
    expect(harness.createStrategyReviewCalls).toHaveLength(1);
  });
});
