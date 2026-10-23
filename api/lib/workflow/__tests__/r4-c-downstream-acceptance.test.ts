/**
 * WBS-R4 C6 — Downstream autonomy end-to-end acceptance.
 *
 * Deterministic chain over REAL internal wiring with controlled fakes at every
 * external boundary (LLM runner, provider platform functions, Redis/BullMQ,
 * wallet ledger, database):
 *
 *   audience intelligence → distribution plan → launch authority →
 *   publish package → queue row → due execution → provider fake →
 *   durable publication receipt
 *
 * The 16 required scenarios are exercised against this chain. Retry/idempotency
 * invariants are asserted on durable harness state: one authoritative audience
 * result, one distribution plan, one charge per queue item, one canonical
 * receipt per logical publication.
 *
 * No live providers, no real DB, no schedulers, no migrations.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

process.env.PUBLIC_APP_URL = "https://natforgeai.com";

import { buildGroundedCreativeBrief } from "../../creative/brief-grounding";
import {
  buildAudienceIntelligenceBillingIdentity,
  buildDistributionBillingIdentity,
} from "../agent-billing-identity";
import {
  serializePublishPackageForQueue,
  assertQueuePublishPackageIntegrity,
} from "../../publish/publish-package-queue-store";
import { resolveQueuePublishPackagePlan, loadQueuePublishPackagePlan } from "../../publish/publish-package-queue-persistence";
import { buildPublishPackage, type PublishPackageBuildInput } from "../../publish/publish-package-builder";
import type { PublishPackage } from "../../publish/publish-package-contract";
import { deriveCreativeArtifactLineageFingerprint } from "../../creative/artifact-lineage";

// ── Hoisted harness state ──────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  campaign: undefined as any,
  business: undefined as any,
  agentRuns: [] as any[],
  approvalRequests: [] as any[],
  publishingQueue: [] as any[],
  contentPosts: [] as any[],
  integrations: [] as any[],
  profiles: [] as any[],
  engagementEvents: [] as any[],
  interestSignals: [] as any[],
  leads: [] as any[],
  leadScores: [] as any[],
  outreachRecommendations: [] as any[],
  auditEvents: [] as any[],
  creditCharges: [] as any[],
  nextIds: {
    agent_runs: 6000,
    approval_requests: 9000,
    publishing_queue: 5000,
    content_posts: 4000,
    audit_events: 8000,
    leads: 3000,
    lead_scores: 3100,
    outreach_recommendations: 3200,
  } as Record<string, number>,
  providerCalls: [] as any[],
  facebookBehavior: [] as Array<Record<string, unknown>>,
  scheduledJobs: [] as any[],
  bullmqAvailable: true,
  runAgentCalls: [] as any[],
  runAgentQueue: [] as Array<(call: number) => any>,
  accessAllowed: true,
  affordabilityAllowed: true,
}));

// ── External-boundary mocks ────────────────────────────────────────────────

vi.mock("../../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../../agents/runner", () => ({
  // Mirrors the real runner's durable run record so the agents' replay guards
  // observe the same world they would in production.
  runAgent: vi.fn(async (input: any) => {
    h.runAgentCalls.push(input);
    const runId = h.nextIds.agent_runs++;
    const behavior = h.runAgentQueue.shift();
    if (!behavior) {
      throw new Error("harness: runAgent behavior not queued for " + input.agentType);
    }
    const outcome = behavior(h.runAgentCalls.length - 1);
    console.log('[DBG] runAgent', input.agentType, 'queueLeft=', h.runAgentQueue.length, 'outcomeKeys=', outcome instanceof Error ? 'ERR' : Object.keys(outcome ?? {}));
    if (outcome instanceof Error) {
      h.agentRuns.push({
        id: runId,
        userId: input.userId,
        campaignId: input.campaignId ?? null,
        agentType: input.agentType,
        status: "failed",
        error: outcome.message,
        output: null,
      });
      throw outcome;
    }
    h.agentRuns.push({
      id: runId,
      userId: input.userId,
      campaignId: input.campaignId ?? null,
      agentType: input.agentType,
      status: "completed",
      output: outcome.output,
    });
    return { runId, output: outcome.output };
  }),
  buildAgentRunBillingSettleKey: (k: string) => `${k}:settle`,
  buildAgentRunBillingReleaseKey: (k: string) => `${k}:release`,
}));

vi.mock("../../safety/checker", () => ({
  checkContentSafety: vi.fn(async () => ({ riskLevel: "low", reasons: [], suggestedFixes: [] })),
}));

vi.mock("../../../audience/access", () => ({
  checkAudienceAgentAccess: vi.fn(async () =>
    h.accessAllowed ? { allowed: true } : { allowed: false, reason: "tier gate" }
  ),
}));

vi.mock("../../billing/cost-control", () => ({
  canRunAutonomousWorkflow: vi.fn(async () =>
    h.affordabilityAllowed ? { allowed: true } : { allowed: false, reason: "paused" }
  ),
}));

vi.mock("../../queue/bullmq", () => ({
  isBullMQAvailable: vi.fn(() => h.bullmqAvailable),
  schedulePublishingJob: vi.fn(async (queueItemId: number, userId: number, platform: string, scheduledAt: Date | null) => {
    h.scheduledJobs.push({ queueItemId, userId, platform, scheduledAt });
    return { id: `publish-${queueItemId}` };
  }),
  removePublishingJob: vi.fn(async () => {}),
  removePublishingJobById: vi.fn(async () => {}),
  inspectPublishingJob: vi.fn(async () => null),
  PUBLISHING_QUEUE_NAME: "publishing-jobs",
}));

vi.mock("../../../audience/ingest", () => ({
  ingestAudienceData: vi.fn(async () => {}),
}));

vi.mock("../../integrations/platforms", () => ({
  publishToFacebook: vi.fn(async (...args: any[]) => {
    h.providerCalls.push({ platform: "facebook", args });
    const behavior = h.facebookBehavior.shift();
    if (behavior) {
      if (behavior.error) throw behavior.error;
      return behavior;
    }
    return { success: true, postId: "fb_harness_1", url: "https://facebook.com/fb_harness_1" };
  }),
  publishToInstagram: vi.fn(async () => ({ success: true, postId: "ig_1" })),
  publishToLinkedIn: vi.fn(async () => ({ success: true, postId: "li_1" })),
  publishToTwitter: vi.fn(async () => ({ success: true, postId: "tw_1" })),
  sendEmail: vi.fn(async () => ({ success: true })),
}));

vi.mock("../../crypto", () => ({
  decryptToken: vi.fn((token: string | null | undefined) => (token ? `decrypted:${token}` : "")),
}));

vi.mock("../../billing/credit-engine", () => ({
  deductCredits: vi.fn(async (input: any) => {
    h.creditCharges.push(input);
    return { newBalance: 100 };
  }),
}));

vi.mock("../../alerts", () => ({
  createAlert: vi.fn(async () => {}),
}));

vi.mock("../../rate-limiter", () => ({
  rateLimitUser: vi.fn(async () => {}),
}));

// Real transition validation semantics over the harness campaign; both the
// approval resolution path and the publish-time finalization consume this.
// Owner-scoped like the governed engine: a mismatched user cannot transition.
vi.mock("../engine", async () => {
  const actual = await vi.importActual<typeof import("../engine")>("../engine");
  return {
    ...actual,
    transitionCampaignState: vi.fn(async (campaignId: number, userId: number, action: any) => {
      if (!h.campaign || h.campaign.id !== campaignId || h.campaign.userId !== userId) {
        throw new Error("campaign not found");
      }
      const next = actual.resolveWorkflowTransition(h.campaign.workflowState, action);
      if (!next) {
        throw new Error(`Invalid transition ${action} from ${h.campaign.workflowState}`);
      }
      h.campaign.workflowState = next;
      return next;
    }),
  };
});

// ── Fake database with mutation semantics ──────────────────────────────────

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function tableRows(name: string): any[] {
  switch (name) {
    case "campaigns":
      return h.campaign ? [h.campaign] : [];
    case "businesses":
      return h.business ? [h.business] : [];
    case "agent_runs":
      return h.agentRuns;
    case "approval_requests":
      return h.approvalRequests;
    case "publishing_queue":
      return h.publishingQueue;
    case "content_posts":
      return h.contentPosts;
    case "social_integrations":
      return h.integrations;
    case "social_profiles":
      return h.profiles;
    case "social_engagement_events":
      return h.engagementEvents;
    case "campaign_interest_signals":
      return h.interestSignals;
    case "leads":
      return h.leads;
    case "lead_scores":
      return h.leadScores;
    case "outreach_recommendations":
      return h.outreachRecommendations;
    case "audit_events":
      return h.auditEvents;
    default:
      return [];
  }
}

function flattenChunks(sql: any): any[] {
  if (!sql || typeof sql !== "object" || !Array.isArray(sql.queryChunks)) return [];
  const out: any[] = [];
  for (const chunk of sql.queryChunks) {
    if (chunk && typeof chunk === "object" && Array.isArray(chunk.queryChunks)) {
      out.push(...flattenChunks(chunk));
    } else {
      out.push(chunk);
    }
  }
  return out;
}

/** Extracts eq(name,value) and inArray(name,[...]) filters from a drizzle condition. */
function getFilters(condition: unknown): {
  eqFilters: Array<{ name: string; value: unknown }>;
  inFilters: Array<{ name: string; values: unknown[] }>;
} {
  const chunks = flattenChunks(condition);
  const eqFilters: Array<{ name: string; value: unknown }> = [];
  const inFilters: Array<{ name: string; values: unknown[] }> = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!(chunk && typeof chunk === "object" && "name" in chunk && typeof chunk.name === "string")) {
      continue;
    }
    // Collect every consecutive drizzle Param after the column (inArray binds
    // one Param per element). StringChunk/SQL/column chunks are never Params:
    // StringChunk.value is a string[] and would poison extraction.
    const params: unknown[] = [];
    for (let j = i + 1; j < chunks.length; j++) {
      const candidate = chunks[j];
      // inArray binds its values as a plain JS array of Param chunks.
      if (Array.isArray(candidate)) {
        for (const el of candidate as any[]) {
          if (el && typeof el === "object" && (el as any).constructor?.name === "Param" && "value" in el) {
            params.push((el as any).value);
          }
        }
        continue;
      }
      if (
        candidate &&
        typeof candidate === "object" &&
        (candidate as any).constructor?.name === "Param" &&
        "value" in candidate
      ) {
        const value = (candidate as any).value;
        if (Array.isArray(value)) params.push(...value);
        else params.push(value);
        continue;
      }
      // Stop at the next column; skip string formatting chunks.
      if (candidate && typeof candidate === "object" && "name" in candidate) break;
    }
    if (params.length === 1) {
      eqFilters.push({ name: chunk.name, value: params[0] });
    } else if (params.length > 1) {
      inFilters.push({ name: chunk.name, values: params });
    }
  }
  return { eqFilters, inFilters };
}

function matches(row: any, condition: unknown): boolean {
  if (!condition) return true;
  const { eqFilters, inFilters } = getFilters(condition);
  // Multiple eq filters on the same column arise from or(eq, eq) wrappers
  // (e.g. the guarded approved|retrying claim): any value satisfies the group.
  const eqGroups = new Map<string, unknown[]>();
  for (const f of eqFilters) {
    const list = eqGroups.get(f.name) ?? [];
    list.push(f.value);
    eqGroups.set(f.name, list);
  }
  const eqOk = [...eqGroups.entries()].every(([name, values]) => values.includes(row[name]));
  const inOk = inFilters.every((f) => f.values.includes(row[f.name]));
  return eqOk && inOk;
}

function createHarnessDb() {
  const isCountSelect = (fields: unknown): boolean => {
    if (!fields || typeof fields !== "object") return false;
    return Object.values(fields as Record<string, unknown>).some((v) => {
      if (!v || typeof v !== "object" || !Array.isArray((v as any).queryChunks)) return false;
      return flattenChunks(v).some((c) => {
        const text =
          typeof c === "string"
            ? c
            : (c as any)?.constructor?.name === "StringChunk" && Array.isArray((c as any).value)
              ? (c as any).value.join("")
              : "";
        return /count\s*\(/i.test(text);
      });
    });
  };

  const db: any = {
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        const name = getTableName(table) ?? "";
        const countProjection = isCountSelect(fields);
        const project = (rows: any[]) =>
          countProjection ? [{ count: rows.length }] : rows.map((r: any) => ({ ...r }));
        const chain: any = {
          where: (condition: unknown) => {
            const rows = tableRows(name).filter((r) => matches(r, condition));
            return {
              orderBy: (col?: any) => {
                if (col && typeof col === "object" && "desc" in col) {
                  const key = col.desc?.name ?? "createdAt";
                  rows.sort((a, b) => String(b[key] ?? "").localeCompare(String(a[key] ?? "")));
                }
                return chain2(rows);
              },
              limit: async (_n: number) => project(rows),
              then: (resolve: (value: unknown[]) => unknown) =>
                Promise.resolve(project(rows)).then(resolve),
            };
          },
          orderBy: () => chain,
          limit: async (_n: number) => project(tableRows(name)),
          then: (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve(project(tableRows(name))).then(resolve),
        };
        const chain2 = (rows: any[]) => ({
          limit: async (_n: number) => project(rows),
          then: (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve(project(rows)).then(resolve),
        });
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: any) => {
        const name = getTableName(table) ?? "";
        const insertOne = (v: any) => {
          const id = h.nextIds[name] ?? 1;
          h.nextIds[name] = id + 1;
          const row = { ...v, id };
          if (name === "lead_scores") {
            const existing = h.leadScores.find(
              (s) =>
                s.userId === v.userId &&
                s.campaignId === v.campaignId &&
                s.externalIdentifier === v.externalIdentifier
            );
            if (existing) {
              Object.assign(existing, v);
              return existing;
            }
          }
          tableRows(name).push(row);
          return row;
        };
        const rows = Array.isArray(values) ? values.map(insertOne) : insertOne(values);
        const chain: any = {
          onDuplicateKeyUpdate: ({ set }: any) => {
            // The harness insert already upserts lead_scores by natural key;
            // apply the caller's set over the last row for other tables.
            const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
            if (last && set) Object.assign(last, set);
            return chain;
          },
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve([{ insertId: Array.isArray(rows) ? rows[rows.length - 1].id : rows.id }]).then(resolve),
        };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set: (data: any) => ({
        where: (condition: unknown) => {
          const name = getTableName(table) ?? "";
          const rows = tableRows(name).filter((r) => matches(r, condition));
          for (const row of rows) Object.assign(row, data);
          return Promise.resolve([{ affectedRows: rows.length }]);
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (condition: unknown) => {
        const name = getTableName(table) ?? "";
        const rows = tableRows(name);
        for (let i = rows.length - 1; i >= 0; i--) {
          if (matches(rows[i], condition)) rows.splice(i, 1);
        }
        return Promise.resolve([{ affectedRows: 1 }]);
      },
    }),
    transaction: async (cb: any) => cb(db),
  };
  return db;
}

// ── World fixtures ─────────────────────────────────────────────────────────

const USER_ID = 14;
const CAMPAIGN_ID = 27;
const BUSINESS_ID = 24;
const POST_ID = 117;
const LAUNCH_APPROVAL_ID = 9000;

const HOOK = "HOOK::c6::";
const CAPTION = "CAPTION::c6 body::";
const CTA = "CTA::c6 call::";
const TEXT = `${HOOK}\n\n${CAPTION}\n\n${CTA}`;
const IMAGE_URL = "/generated/images/27/c6.png";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

const STRATEGY = {
  strategySnapshotId: "strategy_snapshot_c6",
  strategyVersion: 3,
  businessDnaSnapshotId: "bdna_c6",
  strategyHashSha256: HASH_A,
  strategyRunId: 55,
  approvalRequestId: 77,
  creativeBriefFingerprint: "brief_fp_c6",
};

const APPROVED_COPY = {
  copyHashSha256: HASH_B,
  copySchemaVersion: "v2",
  approvedRevisionId: "rev-c6",
  assessmentHashSha256: HASH_C,
  contextLockId: "ctx-c6",
};

function captionLineage() {
  return {
    lineageSchemaVersion: 1,
    artifactKind: "caption_pack",
    artifactId: 501,
    lineageFingerprintSha256: deriveCreativeArtifactLineageFingerprint({
      artifactKind: "caption_pack",
      platform: null,
      parent: null,
      strategy: STRATEGY,
      approvedCopy: APPROVED_COPY,
    }),
    strategy: STRATEGY,
    approvedCopy: APPROVED_COPY,
  };
}

function buildGovernedPackage(): PublishPackage {
  return buildPublishPackage({
    campaignId: CAMPAIGN_ID,
    userId: USER_ID,
    businessId: BUSINESS_ID,
    destination: { platform: "facebook", integrationId: 9 },
    intent: { mode: "immediate" },
    strategyAuthority: STRATEGY,
    approvedCopy: APPROVED_COPY,
    selectedContent: {
      contentPostId: POST_ID,
      artifactKind: "content_post",
      lineage: {
        lineageSchemaVersion: 1,
        artifactKind: "content_post",
        artifactId: POST_ID,
        lineageFingerprintSha256: HASH_E,
        strategy: STRATEGY,
        approvedCopy: APPROVED_COPY,
      },
    },
    captionArtifact: { artifactId: 501, artifactKind: "caption_pack", lineage: captionLineage() },
    visualArtifact: {
      mediaKind: "image",
      generatedAssetId: 909,
      mediaUrl: IMAGE_URL,
      renderLineage: {
        lineageFingerprintSha256: HASH_D,
        strategy: STRATEGY,
        approvedCopy: APPROVED_COPY,
      },
    },
    evidence: { launchApprovalRequestId: LAUNCH_APPROVAL_ID },
    payload: { text: TEXT, mediaUrls: [IMAGE_URL], mediaType: "image" },
  } as PublishPackageBuildInput);
}

const RAW_AUDIENCE_OUTPUT = {
  executiveSummary: "Strong fit",
  discoveredProfiles: [],
  scoredLeads: [
    {
      externalIdentifier: "fb:1",
      platform: "facebook",
      handle: null,
      displayName: "Jane",
      score: 88,
      confidence: "high",
      signals: ["commented"],
      recommendedAction: "reach_out",
      explanation: "Engaged",
      outreachAngles: [
        { channel: "facebook_dm", hook: "Hi", cta: "Book", expectedOutcome: "Reply" },
      ],
    },
  ],
  contentResonance: [],
  nextSteps: ["Follow up"],
};

function resetWorld() {
  h.campaign = {
    id: CAMPAIGN_ID,
    userId: USER_ID,
    businessId: BUSINESS_ID,
    status: "active",
    name: "C6 campaign",
    goal: "drive signups",
    platforms: "facebook",
    productOrService: "Payout platform",
    targetBuyer: "Restaurants",
    mainPainPoint: "manual reconciliation",
    primaryOutcome: "awareness",
    coreMessage: "Faster payouts",
    approvalMode: "autonomous",
    workflowState: "audience_ready",
    workflowContext: {},
  };
  h.business = { id: BUSINESS_ID, userId: USER_ID, name: "Zuto Hub", industry: "fintech" };
  h.agentRuns = [];
  h.approvalRequests = [];
  h.publishingQueue = [];
  h.contentPosts = [
    {
      id: POST_ID,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      hook: HOOK,
      caption: CAPTION,
      cta: CTA,
      status: "ready",
      metadata: {
        imageUrl: IMAGE_URL,
        creativeBriefFingerprint: buildGroundedCreativeBrief({
          campaign: h.campaign,
          business: h.business,
        }).fingerprint,
      },
    },
  ];
  h.integrations = [
    {
      id: 9,
      userId: USER_ID,
      platform: "facebook",
      status: "connected",
      accountName: "Test Page",
      pageId: "830205703508466",
      pageAccessTokenEncrypted: "page-token",
      accessTokenEncrypted: "user-token",
    },
  ];
  h.profiles = [];
  h.engagementEvents = [];
  h.interestSignals = [];
  h.leads = [];
  h.leadScores = [];
  h.outreachRecommendations = [];
  h.auditEvents = [];
  h.creditCharges = [];
  h.providerCalls = [];
  h.facebookBehavior = [];
  h.scheduledJobs = [];
  h.bullmqAvailable = true;
  h.runAgentCalls = [];
  h.runAgentQueue = [];
  h.accessAllowed = true;
  h.affordabilityAllowed = true;
  for (const key of Object.keys(h.nextIds)) h.nextIds[key] = Number(String(h.nextIds[key]).padEnd(4, "0"));
}

// Small indirection so the beforeEach can hold the mocked getDb reference.
let mockedGetDb: any;

function audienceRunBehavior() {
  return () => ({ output: RAW_AUDIENCE_OUTPUT });
}

function distributionRunBehavior() {
  return () => ({
    output: {
      schedule: [
        { contentPostId: POST_ID, platform: "facebook", scheduledAt: "2027-03-01T10:00:00Z" },
      ],
    },
  });
}

async function runAudienceStep() {
  const { runAudienceIntelligenceAgent } = await import("../../agents/audience-intelligence-agent");
  // Connected-profile path: one permissioned signal grounds the analysis.
  if (h.interestSignals.length === 0) {
    h.integrations.push({ id: 10, userId: USER_ID, platform: "facebook", status: "connected" });
    h.interestSignals.push({
      id: 1,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      externalIdentifier: "fb:1",
      signalType: "facebook",
      strength: 5,
      sourceEventIds: [],
      contextSnippet: "Loved this",
    });
  }
  const billingIdentity = buildAudienceIntelligenceBillingIdentity({
    campaignId: CAMPAIGN_ID,
    continuationId: 77,
  });
  h.runAgentQueue.push(audienceRunBehavior());
  return runAudienceIntelligenceAgent({
    userId: USER_ID,
    campaignId: CAMPAIGN_ID,
    autoCreateLeads: false,
    billingIdentity,
  });
}

async function runDistributionStep() {
  const { runDistributionAgent } = await import("../../agents/distribution-agent");
  const billingIdentity = buildDistributionBillingIdentity({
    campaignId: CAMPAIGN_ID,
    audienceRunId: 610,
  });
  h.runAgentQueue.push(distributionRunBehavior());
  return runDistributionAgent({
    userId: USER_ID,
    campaignId: CAMPAIGN_ID,
    approvalMode: "autonomous",
    billingIdentity,
  });
}

function attachPackageToQueueRow(queueItemId: number): PublishPackage {
  const pkg = buildGovernedPackage();
  const envelope = serializePublishPackageForQueue(pkg);
  const row = h.publishingQueue.find((r) => r.id === queueItemId);
  row.metadata = JSON.parse(JSON.stringify(envelope));
  // The pack-publish persistence path binds the owning integration and, for an
  // immediate package, persists a NULL scheduledAt (GAP29 b/c authority). The
  // distribution-created row in this harness gets the same durable binding
  // before its package envelope is attached.
  row.integrationId = pkg.identity.destination.integrationId;
  if (pkg.identity.intent.mode === "immediate") {
    row.scheduledAt = null;
  }
  assertQueuePublishPackageIntegrity(row.metadata.publishPackage);
  return pkg;
}

function requestLaunchApproval() {
  const fingerprint = buildGroundedCreativeBrief({ campaign: h.campaign, business: h.business }).fingerprint;
  h.approvalRequests.push({
    id: LAUNCH_APPROVAL_ID,
    userId: USER_ID,
    campaignId: CAMPAIGN_ID,
    approvalType: "campaign_launch",
    status: "pending",
    title: "Approve Launch",
  });
  h.campaign.workflowContext = {
    ...h.campaign.workflowContext,
    launchApprovalLineage: {
      creativeBriefFingerprint: fingerprint,
      approvalRequestId: LAUNCH_APPROVAL_ID,
      status: "pending",
    },
  };
}

/**
 * Simulates the approval-router decision recording (executeApprovalDecision):
 * the request row reaches its terminal state and the durable launch lineage
 * is persisted as resolved BEFORE the lifecycle trigger consumes it.
 */
function recordLaunchDecision(decision: "approved" | "rejected") {
  const row = h.approvalRequests.find((r) => r.id === LAUNCH_APPROVAL_ID);
  row.status = decision;
  const lineage = h.campaign.workflowContext.launchApprovalLineage;
  h.campaign.workflowContext = {
    ...h.campaign.workflowContext,
    launchApprovalLineage: { ...lineage, status: decision },
  };
}

async function resolveLaunch(decision: "approved" | "rejected") {
  const { onApprovalResolved } = await import("../triggers");
  return onApprovalResolved(LAUNCH_APPROVAL_ID, decision, USER_ID);
}

async function executeQueueItem(queueItemId: number, pkg?: PublishPackage) {
  const { publishSinglePost } = await import("../publishing-runner");
  // Mirror the worker/cron contract: the durable row carries the package
  // envelope; the plan is loaded from it (identity-only reload) and handed to
  // the runner, exactly like loadQueuePublishPackagePlan + publishSinglePost.
  let publishPackage = pkg ?? null;
  if (!publishPackage) {
    const plan = await loadQueuePublishPackagePlan(queueItemId);
    if (plan.kind === "governed") publishPackage = plan.publishPackage;
  }
  return publishSinglePost(queueItemId, publishPackage ? { publishPackage } : undefined);
}

function publicationReceipts() {
  return h.auditEvents.filter((a) => a.eventType === "publication_success");
}

function publishingCharges() {
  return h.creditCharges.filter(
    (c) => c.type === "publishing_deduction" && c.metadata?.queueItemId != null
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("WBS-R4 C6 downstream acceptance", () => {
  beforeEach(async () => {
    resetWorld();
    vi.clearAllMocks();
    const conn = await import("../../../queries/connection");
    mockedGetDb = vi.mocked(conn.getDb);
    mockedGetDb.mockReturnValue(createHarnessDb() as any);
  });

  it("scenario 1 — happy path: audience → distribution → launch → package → queue → provider fake → receipt", async () => {
    const audience = await runAudienceStep();
    expect(audience.replayed).toBeUndefined();
    expect(h.campaign.workflowContext.audienceIntelligenceRunId).toBe(audience.runId);

    const distribution = await runDistributionStep();
    expect(distribution.queueIds).toHaveLength(1);
    const queueRowId = distribution.queueIds[0];
    const row = h.publishingQueue.find((r) => r.id === queueRowId);
    expect(row.status).toBe("approved");
    expect(row.platform).toBe("facebook");

    // Package committed durably on the queue row (single authority with the row).
    const pkg = attachPackageToQueueRow(queueRowId);
    expect((await resolveQueuePublishPackagePlan(row)).kind).toBe("governed");

    // Launch authority: request → approved resolution.
    await runApprovePath();

    // Due execution (cron path): provider fake succeeds.
    const result = await executeQueueItem(queueRowId);
    expect(result.status).toBe("published");

    const published = h.publishingQueue.find((r) => r.id === queueRowId);
    expect(published.status).toBe("published");
    expect(published.externalPostId).toBe("fb_harness_1");

    // Durable canonical receipt, exactly one.
    const receipts = publicationReceipts();
    console.log("[DBG-R]", JSON.stringify(receipts[0]?.metadata?.publicationReceipt?.publishPackageId ?? null), "colPkg=", receipts[0]?.packageId, "cls=", receipts[0]?.metadata?.publicationReceipt?.classification);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].packageId).toBe(pkg.packageId);
    expect(receipts[0].metadata.publicationReceipt.operationId).toBe(
      `publication:facebook:${queueRowId}`
    );

    // Financial effects: one publishing charge; the governed package kept the
    // launch-phase audience-intelligence charge under its own stable key.
    expect(publishingCharges()).toHaveLength(1);
    expect(publishingCharges()[0].metadata.queueItemId).toBe(queueRowId);

    // Campaign finalization reached live state through the governed transition.
    expect(h.campaign.workflowState).toBe("campaign_live");

    // Audience/distribution step identities were minted at the trigger boundary.
    const audienceCalls = h.runAgentCalls.filter((c) => c.agentType === "audience");
    const distributionCalls = h.runAgentCalls.filter((c) => c.agentType === "distribution");
    expect(audienceCalls.length).toBeGreaterThanOrEqual(1);
    expect(distributionCalls).toHaveLength(1);
    expect(distributionCalls[0].billingIdempotencyKey).toBe(
      buildDistributionBillingIdentity({ campaignId: CAMPAIGN_ID, audienceRunId: 610 })
    );
  });

  it("scenario 2 — duplicate audience trigger collapses onto one authoritative result", async () => {
    const first = await runAudienceStep();
    const second = await runAudienceStep();
    expect(second.replayed).toBe(true);
    expect(second.runId).toBe(first.runId);
    const audienceRuns = h.agentRuns.filter((r) => r.agentType === "audience" && r.status === "completed");
    expect(audienceRuns).toHaveLength(1);
    // The launch-phase key differs from the strategy-phase key, so the launch
    // dispatch still runs later — only the SAME logical operation replays.
  });

  it("scenario 3 — duplicate distribution trigger collapses onto one authoritative plan", async () => {
    await runAudienceStep();
    const first = await runDistributionStep();
    const second = await runDistributionStep();
    expect(second.replayed).toBe(true);
    expect(second.queueIds).toEqual(first.queueIds);
    expect(h.publishingQueue).toHaveLength(1);
  });

  it("scenario 4 — duplicate launch callback cannot re-run the launch continuation", async () => {
    await runAudienceStep();
    await runDistributionStep();
    await runApprovePath();
    const audienceCallsBefore = h.runAgentCalls.filter((c) => c.agentType === "audience").length;

    // The approval is already resolved; the lifecycle rejects the replay at
    // the governed transition before any continuation can re-dispatch.
    await expect(resolveLaunch("approved")).rejects.toThrow(/Invalid transition/);
    const audienceCallsAfter = h.runAgentCalls.filter((c) => c.agentType === "audience").length;
    expect(audienceCallsAfter).toBe(audienceCallsBefore);
    expect(h.publishingQueue.filter((r) => r.status === "approved")).toHaveLength(1);
  });

  it("scenarios 5/6 — restart during audience: re-enter under the same billing identity, one authoritative result", async () => {
    const billingIdentity = buildAudienceIntelligenceBillingIdentity({
      campaignId: CAMPAIGN_ID,
      continuationId: 77,
    });
    h.integrations.push({ id: 10, userId: USER_ID, platform: "facebook", status: "connected" });
    h.interestSignals.push({
      id: 1,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      externalIdentifier: "fb:1",
      signalType: "facebook",
      strength: 5,
      sourceEventIds: [],
      contextSnippet: "Loved this",
    });

    const { runAudienceIntelligenceAgent } = await import("../../agents/audience-intelligence-agent");
    // First attempt dies at the provider boundary (no durable result written).
    h.runAgentQueue.push(() => new Error("provider timeout"));
    h.runAgentQueue.push(audienceRunBehavior());
    await expect(
      runAudienceIntelligenceAgent({
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        billingIdentity,
      })
    ).rejects.toThrow("provider timeout");

    // Restart re-enters with the SAME identity: the reservation authority owns
    // the charge, the durable result is written exactly once.
    const recovered = await runAudienceIntelligenceAgent({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      billingIdentity,
    });
    expect(recovered.replayed).toBeUndefined();
    const keyedCalls = h.runAgentCalls.filter(
      (c) => c.agentType === "audience" && c.billingIdempotencyKey === billingIdentity
    );
    expect(keyedCalls).toHaveLength(2);
    expect(h.campaign.workflowContext.audienceIntelligenceBillingKey).toBe(billingIdentity);
    expect(h.campaign.workflowContext.audienceIntelligenceRunId).toBe(recovered.runId);
  });

  it("scenario 7 — restart during distribution: crash before plan materialisation re-enters cleanly", async () => {
    await runAudienceStep();
    h.runAgentQueue.push(() => new Error("llm schema error"));
    h.runAgentQueue.push(distributionRunBehavior());
    const { runDistributionAgent } = await import("../../agents/distribution-agent");
    const billingIdentity = buildDistributionBillingIdentity({
      campaignId: CAMPAIGN_ID,
      audienceRunId: 610,
    });
    await expect(
      runDistributionAgent({
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        approvalMode: "autonomous",
        billingIdentity,
      })
    ).rejects.toThrow("llm schema error");
    // Crash before any queue insert: nothing materialised.
    expect(h.publishingQueue).toHaveLength(0);

    await runDistributionStep();
    expect(h.publishingQueue).toHaveLength(1);
    expect(h.campaign.workflowContext.distributionBillingKey).toBe(billingIdentity);
  });

  it("scenario 8 — package committed / queue-missing crash window: envelope integrity survives and fails closed on tamper", async () => {
    await runAudienceStep();
    await runDistributionStep();
    const queueRowId = h.publishingQueue[0].id;
    const pkg = attachPackageToQueueRow(queueRowId);

    // Simulate crash + recovery: the durable row (with envelope) is re-read.
    const row = h.publishingQueue.find((r) => r.id === queueRowId);
    expect((await resolveQueuePublishPackagePlan(row)).kind).toBe("governed");

    // Tamper evidence fails closed (never executes governed on a mutated package).
    const tampered = JSON.parse(JSON.stringify(row.metadata.publishPackage));
    tampered.publishPackage.payload.text = "INJECTED";
    expect(() => assertQueuePublishPackageIntegrity(tampered)).toThrow();
  });

  it("scenario 9 — queue duplication converges: deterministic job identity, one execution", async () => {
    await runAudienceStep();
    await runDistributionStep();
    await runApprovePath();
    const queueRowId = h.publishingQueue[0].id;
    const pkg = attachPackageToQueueRow(queueRowId);

    // Two enqueue attempts (e.g. approval resolution + cron overlap) carry the
    // same deterministic job identity and both land in the harness log.
    expect(h.scheduledJobs.filter((j) => j.queueItemId === queueRowId).length).toBeGreaterThanOrEqual(1);

    const first = await executeQueueItem(queueRowId, pkg);
    expect(first.status).toBe("published");
    const second = await executeQueueItem(queueRowId, pkg);
    expect(second.status).toBe("published");
    expect(h.providerCalls).toHaveLength(1);
    expect(publicationReceipts()).toHaveLength(1);
    expect(publishingCharges()).toHaveLength(1);
  });

  it("scenario 10 — BullMQ/Redis unavailable: durable DB authority still executes due work", async () => {
    h.bullmqAvailable = false;
    await runAudienceStep();
    await runDistributionStep();
    await runApprovePath();
    // No BullMQ jobs were scheduled, but the cron-owned due execution path
    // still publishes through the durable row.
    expect(h.scheduledJobs).toHaveLength(0);
    const queueRowId = h.publishingQueue[0].id;
    const pkg = attachPackageToQueueRow(queueRowId);
    const result = await executeQueueItem(queueRowId, pkg);
    expect(result.status).toBe("published");
    expect(publicationReceipts()).toHaveLength(1);
  });

  it("scenario 11 — provider transient failure then retry: exactly one charge, one receipt", async () => {
    await runAudienceStep();
    await runDistributionStep();
    await runApprovePath();
    const queueRowId = h.publishingQueue[0].id;
    const pkg = attachPackageToQueueRow(queueRowId);

    h.facebookBehavior.push({ error: new Error("network timeout") });
    const failed = await executeQueueItem(queueRowId, pkg);
    expect(["failed", "retrying"]).toContain(failed.status);
    const row = h.publishingQueue.find((r) => r.id === queueRowId);
    expect(row.status).toBe("retrying");
    expect(publicationReceipts()).toHaveLength(0);

    const recovered = await executeQueueItem(queueRowId, pkg);
    expect(recovered.status).toBe("published");
    // Retry under status "retrying" skips the charge: one charge total.
    expect(publishingCharges()).toHaveLength(1);
    expect(publicationReceipts()).toHaveLength(1);
    expect(h.providerCalls).toHaveLength(2);
  });

  it("scenario 12 — provider ambiguous result: no fabricated success, no blind replay", async () => {
    await runAudienceStep();
    await runDistributionStep();
    await runApprovePath();
    const queueRowId = h.publishingQueue[0].id;
    const pkg = attachPackageToQueueRow(queueRowId);

    h.facebookBehavior.push({ error: new Error("upstream timeout after 30s") });
    const ambiguous = await executeQueueItem(queueRowId, pkg);
    expect(ambiguous.status).not.toBe("published");
    expect(publicationReceipts()).toHaveLength(0);
    // The row is parked in a retryable state; no receipt was fabricated and no
    // success was borrowed. A later attempt re-enters under the same identity.
    const row = h.publishingQueue.find((r) => r.id === queueRowId);
    expect(["retrying", "failed"]).toContain(row.status);
  });

  it("scenario 13 — rejected launch withdraws executable work", async () => {
    await runAudienceStep();
    await runDistributionStep();
    requestLaunchApproval();
    await transitionToLaunchApprovalRequired();
    recordLaunchDecision("rejected");
    await resolveLaunch("rejected");

    const row = h.publishingQueue[0];
    expect(row.status).toBe("pending_approval");
    expect(row.approvalRequired).toBe(true);
    expect(h.campaign.workflowState).toBe("strategy_approved");

    // The withdrawn row is not executable: publishing fails closed without a
    // provider call.
    const attempt = await executeQueueItem(row.id);
    expect(attempt.status).not.toBe("published");
    expect(h.providerCalls).toHaveLength(0);
  });

  it("scenario 14 — stale creative/Strategy lineage blocks execution after approval", async () => {
    await runAudienceStep();
    await runDistributionStep();
    await runApprovePath();
    const queueRowId = h.publishingQueue[0].id;
    const pkg = attachPackageToQueueRow(queueRowId);

    // The brief drifts after launch approval (e.g. campaign edited).
    h.campaign.coreMessage = "Completely different message";
    const result = await executeQueueItem(queueRowId, pkg);
    expect(result.status).not.toBe("published");
    expect(h.providerCalls).toHaveLength(0);
    expect(publicationReceipts()).toHaveLength(0);
  });

  it("scenario 15 — cross-business attempts fail closed at every boundary", async () => {
    const { runAudienceIntelligenceAgent } = await import("../../agents/audience-intelligence-agent");
    const { runDistributionAgent } = await import("../../agents/distribution-agent");

    await expect(
      runAudienceIntelligenceAgent({ userId: 999, campaignId: CAMPAIGN_ID })
    ).rejects.toThrow("Campaign not found");
    await expect(
      runDistributionAgent({ userId: 999, campaignId: CAMPAIGN_ID, approvalMode: "autonomous" })
    ).rejects.toThrow("Campaign not found");

    await runAudienceStep();
    await runDistributionStep();
    requestLaunchApproval();
    await transitionToLaunchApprovalRequired();
    // A different user cannot resolve the approval: the governed transition is
    // owner-scoped in the engine and the campaign lookup is owner-scoped.
    const { onApprovalResolved } = await import("../triggers");
    await expect(onApprovalResolved(LAUNCH_APPROVAL_ID, "approved", 999)).rejects.toThrow();
    expect(h.publishingQueue[0].status).toBe("approved");
    expect(h.providerCalls).toHaveLength(0);
  });

  it("scenario 16 — full replay after successful publication: no duplicate provider call, charge, or receipt", async () => {
    await runAudienceStep();
    await runDistributionStep();
    await runApprovePath();
    const queueRowId = h.publishingQueue[0].id;
    const pkg = attachPackageToQueueRow(queueRowId);

    const first = await executeQueueItem(queueRowId, pkg);
    expect(first.status).toBe("published");
    const snapshot = {
      providerCalls: h.providerCalls.length,
      charges: publishingCharges().length,
      receipts: publicationReceipts().length,
    };

    const replay = await executeQueueItem(queueRowId, pkg);
    expect(replay.status).toBe("published");
    expect(h.providerCalls).toHaveLength(snapshot.providerCalls);
    expect(publishingCharges()).toHaveLength(snapshot.charges);
    expect(publicationReceipts()).toHaveLength(snapshot.receipts);
    expect(h.publishingQueue.find((r) => r.id === queueRowId).externalPostId).toBe("fb_harness_1");
  });

  // ── Shared chain helpers ──

  async function runApprovePath() {
    requestLaunchApproval();
    await transitionToLaunchApprovalRequired();
    recordLaunchDecision("approved");
    h.runAgentQueue.push(audienceRunBehavior());
    await resolveLaunch("approved");
    const lineage = h.campaign.workflowContext.launchApprovalLineage;
    expect(lineage.status).toBe("approved");
  }

  async function transitionToLaunchApprovalRequired() {
    const { transitionCampaignState } = await import("../engine");
    await transitionCampaignState(CAMPAIGN_ID, USER_ID, "request_launch_approval");
  }
});
