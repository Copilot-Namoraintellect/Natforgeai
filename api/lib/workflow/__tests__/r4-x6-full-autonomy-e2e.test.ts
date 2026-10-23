/**
 * WBS-R4 Stream X6 — FULL AUTONOMY connected end-to-end acceptance harness.
 *
 * ONE connected deterministic run over REAL internal wiring with controlled
 * fakes ONLY at the external boundaries (LLM runner via the `ai` generateObject
 * seam and the agent runner seam, provider platform functions, audience
 * provider adapters, Redis/BullMQ, and the database — an in-memory fake
 * implementing the drizzle query surface):
 *
 *   fresh business + Business DNA → campaign.create (real campaignRouter,
 *   bootstrap idempotency key) → Strategy generation (real runStrategyAgent
 *   path, LLM faked) → strategy_review approval (real approvalRouter decision
 *   → onApprovalResolved → onStrategyApproved) → creative generation
 *   completing → release package sealed (real syncCreativeReleasePackage) →
 *   audience intelligence (real runAudienceIntelligenceAgent, keyed billing
 *   identity) → distribution (real runDistributionAgent) → launch approval
 *   (real launch authority) → publish package build → queue row → due
 *   execution → provider fake → durable publication receipt → post-live
 *   metrics observation pass (real pass, fake provider metric binding) →
 *   engagement ingest (real ingest path) → KPI/performance dataset (real
 *   loader + dataset builder) → governed learning cycle → promotion proposal
 *   → promotion approval decision → sealed approved envelope → next-cycle
 *   instruction (real Stream A dispatch path) → Strategy N+1 generation
 *   consuming the sealed learning evidence → new strategy_review approval.
 *
 * THREE governed cycles are driven. Per-cycle assertions pin exactly one
 * authoritative effect per logical operation; learning influences ONLY the
 * new Strategy cycle (cycle N+1 snapshot carries the learning lineage,
 * previous cycles' governed records stay byte-identical).
 *
 * No network, no live providers, no schedulers, no migrations. Clock pinned
 * (Date faked only); all other timers are real.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { TRPCError } from "@trpc/server";

process.env.PUBLIC_APP_URL = "https://natforgeai.com";

// ── Hoisted harness state ──────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  // Durable tables (the fake database).
  campaigns: [] as any[],
  businesses: [] as any[],
  agentRuns: [] as any[],
  approvalRequests: [] as any[],
  publishingQueue: [] as any[],
  contentPosts: [] as any[],
  campaignAssets: [] as any[],
  generatedImages: [] as any[],
  creativeGenerationClaims: [] as any[],
  creditTransactions: [] as any[],
  creditWallets: [] as any[],
  creditReservations: [] as any[],
  auditEvents: [] as any[],
  learningRecords: [] as any[],
  analytics: [] as any[],
  socialIntegrations: [] as any[],
  socialProfiles: [] as any[],
  socialEngagementEvents: [] as any[],
  campaignInterestSignals: [] as any[],
  leads: [] as any[],
  leadScores: [] as any[],
  outreachRecommendations: [] as any[],
  schedules: [] as any[],
  strategySnapshots: [] as any[],
  businessDnaSnapshots: [] as any[],
  aiUsage: [] as any[],
  nextIds: {} as Record<string, number>,
  // External-boundary behaviors.
  llmQueue: [] as Array<() => any>,
  runAgentQueue: [] as Array<(call: number) => any>,
  runAgentCalls: [] as any[],
  facebookBehavior: [] as Array<Record<string, unknown>>,
  providerCalls: [] as any[],
  scheduledJobs: [] as any[],
  bullmqAvailable: true,
  creativeShouldFail: false,
  creativeGenerations: 0,
  creativeCalls: [] as any[],
  audienceAgentCalls: [] as any[],
  metaEvents: null as null | { profiles: any[]; events: any[]; warnings: string[] },
  linkedinEvents: null as null | { profiles: any[]; events: any[]; warnings: string[] },
  subscriptionCalls: [] as any[],
}));

// ── Module mocks (external boundaries only) ───────────────────────────────

vi.mock("../../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("ai", () => {
  class MockNoObjectGeneratedError extends Error {
    static isInstance(error: unknown): error is MockNoObjectGeneratedError {
      return error instanceof MockNoObjectGeneratedError;
    }
  }
  class MockTypeValidationError extends Error {
    static isInstance(error: unknown): error is MockTypeValidationError {
      return error instanceof MockTypeValidationError;
    }
  }
  return {
    generateObject: vi.fn(async () => {
      const behavior = h.llmQueue.shift();
      if (!behavior) throw new Error("harness: generateObject behavior not queued");
      const outcome = behavior();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
    NoObjectGeneratedError: MockNoObjectGeneratedError,
    TypeValidationError: MockTypeValidationError,
  };
});

// LLM runner boundary for the audience / distribution agents. Mirrors the
// real runner's durable run record so the agents' replay guards observe the
// same world they would in production.
vi.mock("../../agents/runner", () => ({
  runAgent: vi.fn(async (input: any) => {
    h.runAgentCalls.push(input);
    const runId = h.nextIds.agent_runs++;
    const behavior = h.runAgentQueue.shift();
    if (!behavior) {
      throw new Error("harness: runAgent behavior not queued for " + input.agentType);
    }
    const outcome = behavior(h.runAgentCalls.length - 1);
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

// Creative LLM agent boundary: persists the durable artefacts the real agent
// persists (master leaflet post, message pack, hashtag set), lineage-bound,
// and records the governed success charge evidence the approval dedup reads.
vi.mock("../../agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(async (input: any) => {
    h.creativeCalls.push(input);
    if (h.creativeShouldFail) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Generated content did not meet quality standards: invented offer",
      });
    }
    const campaignId = input.campaignId;
    const userId = input.userId;
    const generation = ++h.creativeGenerations;
    const packRunId = 6000 + generation * 10;
    const fingerprint = input.strategyInput?.authority?.creativeBriefFingerprint ?? "fp";
    const authority = input.strategyInput?.authority ?? {};
    const postId = 4000 + generation * 10;
    const assetBase = 4500 + generation * 10;

    h.agentRuns.push({
      id: packRunId,
      userId,
      campaignId,
      agentType: "creative",
      status: "completed",
      output: {},
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    h.contentPosts.push({
      id: postId,
      userId,
      campaignId,
      title: `Master Campaign Post (gen ${generation})`,
      type: "social_post",
      status: "draft",
      hook: "HOOK::x6::",
      caption: "CAPTION::x6 body::",
      cta: "CTA::x6 call::",
      createdAt: new Date(Date.now() + generation * 60_000).toISOString(),
      metadata: {
        assetType: "leaflet",
        assetKind: "master_campaign_post",
        generationRunId: `pack-${packRunId}`,
        creativeBriefFingerprint: fingerprint,
        ...authority,
      },
    });
    h.campaignAssets.push(
      {
        id: assetBase,
        userId,
        campaignId,
        assetType: "message_pack",
        title: `Campaign Message Pack (gen ${generation})`,
        status: "approved",
        createdAt: new Date(Date.now() + generation * 60_000).toISOString(),
        metadata: { passed: true, creativeBriefFingerprint: fingerprint, ...authority },
      },
      {
        id: assetBase + 1,
        userId,
        campaignId,
        assetType: "hashtag_set",
        title: `Master Hashtag Set (gen ${generation})`,
        status: "ready",
        createdAt: new Date(Date.now() + generation * 60_000).toISOString(),
        metadata: { creativeBriefFingerprint: fingerprint, ...authority },
      }
    );
    const campaign = h.campaigns.find((c) => c.id === campaignId);
    if (campaign) {
      campaign.workflowContext = {
        ...(campaign.workflowContext || {}),
        creativeGeneratedAt: new Date().toISOString(),
        creativeRunId: packRunId,
        savedPosts: 1,
        savedAssets: 2,
        premiumPack: true,
      };
    }
    // Governed post-success charge evidence (mirrors the real agent) under
    // the approval-bound idempotency key.
    h.creditTransactions.push({
      id: h.nextIds.credit_transactions++,
      userId,
      walletId: 1,
      type: "agent_deduction",
      amount: -150,
      balanceAfter: 0,
      description: "creative agent execution (post-success)",
      metadata: {
        campaignId,
        generationSource: "approval",
        generationOperationId: input.generationOperation?.id ?? null,
        agentType: "creative",
      },
      idempotencyKey: `creative-success:${campaignId}:approval:${input.generationOperation?.id}`,
    });
    return { packRunId, assetsRunId: null, savedPosts: 1, savedAssets: 2 };
  }),
}));

// Audience-agent boundary (trigger-fired only in this harness; the audience
// INTELLIGENCE agent is the real module under test).
vi.mock("../../agents/audience-agent", () => ({
  runAudienceAgent: vi.fn(async (input: any) => {
    h.audienceAgentCalls.push(input);
    const runId = h.nextIds.agent_runs++;
    h.agentRuns.push({
      id: runId,
      userId: input.userId,
      campaignId: input.campaignId,
      agentType: "audience",
      status: "completed",
      output: {},
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    return { runId };
  }),
}));

vi.mock("../../../audience/access", () => ({
  checkAudienceAgentAccess: vi.fn(async () => ({
    allowed: false,
    reason: "harness: no tier provisioned",
  })),
}));

vi.mock("../../queue/bullmq", () => ({
  isBullMQAvailable: vi.fn(() => h.bullmqAvailable),
  schedulePublishingJob: vi.fn(
    async (queueItemId: number, userId: number, platform: string, scheduledAt: Date | null) => {
      h.scheduledJobs.push({ queueItemId, userId, platform, scheduledAt });
      return { id: `publish-${queueItemId}` };
    }
  ),
  removePublishingJob: vi.fn(async () => {}),
  removePublishingJobById: vi.fn(async () => {}),
  inspectPublishingJob: vi.fn(async () => null),
  PUBLISHING_QUEUE_NAME: "publishing-jobs",
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

vi.mock("../../safety/checker", () => ({
  checkContentSafety: vi.fn(async () => ({ riskLevel: "low", reasons: [], suggestedFixes: [] })),
}));

vi.mock("../../alerts", () => ({
  createAlert: vi.fn(async () => {}),
}));

vi.mock("../../rate-limiter", () => ({
  rateLimitUser: vi.fn(async () => {}),
}));

vi.mock("../../subscription", () => ({
  checkLimit: vi.fn(async () => ({ allowed: true, current: 0, limit: 999 })),
  incrementCampaignUsage: vi.fn(async (userId: number) => {
    h.subscriptionCalls.push({ kind: "campaign", userId });
  }),
  incrementResultUsage: vi.fn(async (userId: number) => {
    h.subscriptionCalls.push({ kind: "result", userId });
  }),
  getUserTier: vi.fn(async () => null),
}));

// Audience provider adapter boundary for the REAL engagement ingest path.
vi.mock("../../audience/adapters/meta-adapter", () => ({
  fetchMetaAudienceData: vi.fn(async () => {
    const payload = h.metaEvents ?? { profiles: [], events: [], warnings: [] };
    h.metaEvents = null;
    return payload;
  }),
}));

vi.mock("../../audience/adapters/linkedin-adapter", () => ({
  fetchLinkedInAudienceData: vi.fn(async () => {
    const payload = h.linkedinEvents ?? { profiles: [], events: [], warnings: [] };
    h.linkedinEvents = null;
    return payload;
  }),
}));

import { getDb } from "../../../queries/connection";
import { buildGroundedCreativeBrief } from "../../creative/brief-grounding";
import { deriveCreativeArtifactLineageFingerprint } from "../../creative/artifact-lineage";
import {
  serializePublishPackageForQueue,
  assertQueuePublishPackageIntegrity,
} from "../../publish/publish-package-queue-store";
import { loadQueuePublishPackagePlan } from "../../publish/publish-package-queue-persistence";
import {
  buildPublishPackage,
  type PublishPackageBuildInput,
} from "../../publish/publish-package-builder";
import type { PublishPackage } from "../../publish/publish-package-contract";
import { reserveWalletCredits, settleWalletCredits } from "../../billing/credit-reservation-engine";
import { reapStaleCreditReservations } from "../../billing/stale-reservation-reaper";

// ── Fake database implementing the drizzle query surface ───────────────────

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function tableRows(name: string): any[] {
  switch (name) {
    case "campaigns":
      return h.campaigns;
    case "businesses":
      return h.businesses;
    case "agent_runs":
      return h.agentRuns;
    case "approval_requests":
      return h.approvalRequests;
    case "publishing_queue":
      return h.publishingQueue;
    case "content_posts":
      return h.contentPosts;
    case "campaign_assets":
      return h.campaignAssets;
    case "generated_images":
      return h.generatedImages;
    case "creative_generation_claims":
      return h.creativeGenerationClaims;
    case "credit_transactions":
      return h.creditTransactions;
    case "credit_wallets":
      return h.creditWallets;
    case "credit_reservations":
      return h.creditReservations;
    case "audit_events":
      return h.auditEvents;
    case "learning_records":
      return h.learningRecords;
    case "analytics":
      return h.analytics;
    case "social_integrations":
      return h.socialIntegrations;
    case "social_profiles":
      return h.socialProfiles;
    case "social_engagement_events":
      return h.socialEngagementEvents;
    case "campaign_interest_signals":
      return h.campaignInterestSignals;
    case "leads":
      return h.leads;
    case "lead_scores":
      return h.leadScores;
    case "outreach_recommendations":
      return h.outreachRecommendations;
    case "schedules":
      return h.schedules;
    case "strategy_snapshots":
      return h.strategySnapshots;
    case "business_dna_snapshots":
      return h.businessDnaSnapshots;
    case "ai_usage":
      return h.aiUsage;
    default:
      return [];
  }
}

// Emulated unique constraints (natural keys) per table.
const UNIQUE_KEYS: Record<string, string[][]> = {
  credit_transactions: [["idempotencyKey"]],
  credit_reservations: [["reservationId"], ["idempotencyKey"], ["userId", "reservationReference"]],
  creative_generation_claims: [["activeClaimKey"]],
  analytics: [["observationId"]],
  social_engagement_events: [["dedupHash"]],
  campaign_interest_signals: [["campaignId", "externalIdentifier"]],
  lead_scores: [["userId", "campaignId", "externalIdentifier"]],
};

const MANAGED_TABLES = [
  "campaigns",
  "businesses",
  "agent_runs",
  "approval_requests",
  "publishing_queue",
  "content_posts",
  "campaign_assets",
  "generated_images",
  "creative_generation_claims",
  "credit_transactions",
  "credit_wallets",
  "credit_reservations",
  "audit_events",
  "learning_records",
  "analytics",
  "social_integrations",
  "social_profiles",
  "social_engagement_events",
  "campaign_interest_signals",
  "leads",
  "lead_scores",
  "outreach_recommendations",
  "schedules",
  "strategy_snapshots",
  "business_dna_snapshots",
  "ai_usage",
];

function duplicateKeyError(key: string): Error {
  const err = new Error(`Duplicate entry 'x' for key '${key}'`) as Error & {
    code: string;
    errno: number;
  };
  err.code = "ER_DUP_ENTRY";
  err.errno = 1062;
  return err;
}

// ── Condition evaluation over drizzle SQL chunk trees ─────────────────────

function chunkText(chunk: unknown): string {
  const c = chunk as { value?: unknown; constructor?: { name?: string } } | null;
  if (
    c &&
    typeof c === "object" &&
    Array.isArray(c.value) &&
    c.constructor?.name === "StringChunk"
  ) {
    return (c.value as string[]).join("");
  }
  return "";
}

function flattenChunks(sql: any): any[] {
  if (!sql || typeof sql !== "object") return [sql];
  if (Array.isArray(sql)) {
    const out: any[] = [];
    for (const el of sql) out.push(...flattenChunks(el));
    return out;
  }
  if (Array.isArray(sql.queryChunks)) return flattenChunks(sql.queryChunks);
  return [sql];
}

function getPathValue(row: any, column: string, path: string): unknown {
  let value: any = row?.[column];
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  for (const segment of path.split(".")) {
    if (value === null || value === undefined) return undefined;
    value = value[segment];
  }
  return value;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const aTime = a instanceof Date ? a.getTime() : null;
  const bTime = b instanceof Date ? b.getTime() : null;
  if (aTime !== null || bTime !== null) {
    const av = aTime ?? new Date(String(a)).getTime();
    const bv = bTime ?? new Date(String(b)).getTime();
    return av === bv;
  }
  return false;
}

function compareValues(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (a instanceof Date || b instanceof Date) {
    const av = a instanceof Date ? a.getTime() : new Date(String(a)).getTime();
    const bv = b instanceof Date ? b.getTime() : new Date(String(b)).getTime();
    return av === bv ? 0 : av < bv ? -1 : 1;
  }
  const av = Number(a);
  const bv = Number(b);
  if (Number.isNaN(av) || Number.isNaN(bv)) return null;
  return av === bv ? 0 : av < bv ? -1 : 1;
}

/** Evaluates one flattened atomic condition chunk list against a row. */
function evalAtomic(flat: any[], row: any): boolean {
  const text = flat.map(chunkText).join("");
  const lower = text.toLowerCase();
  const columns = flat.filter(
    (ch) =>
      ch &&
      typeof ch === "object" &&
      typeof (ch as any).name === "string" &&
      !Array.isArray((ch as any).value) &&
      !(ch as any).queryChunks
  );
  const params: unknown[] = [];
  for (const ch of flat) {
    if (Array.isArray(ch)) {
      for (const el of ch) {
        if (el && (el as any).constructor?.name === "Param") params.push((el as any).value);
      }
    } else if (ch && (ch as any).constructor?.name === "Param") {
      const value = (ch as any).value;
      if (Array.isArray(value)) params.push(...value);
      else params.push(value);
    } else if (typeof ch === "string" || typeof ch === "number" || typeof ch === "boolean") {
      // eq(sqlFragment, value) leaves the value as a raw primitive chunk
      // (drizzle only wraps Params against encoder columns).
      if (ch !== "") params.push(ch);
    }
  }

  // JSON_EXTRACT conditions (workflowContext JSON authority columns).
  const jsonPath = /\$\.([A-Za-z0-9_.]+)'/.exec(text)?.[1];
  if (jsonPath && columns.length > 0) {
    const value = getPathValue(row, (columns[0] as any).name, jsonPath);
    if (lower.includes(" is null")) return value === null || value === undefined;
    if (lower.includes(" is not null")) return value !== null && value !== undefined;
    return String(value) === String(params[0]);
  }

  if (columns.length === 0) return true;
  const col = (columns[columns.length - 1] as any).name;
  const rowValue = row?.[col];

  if (lower.includes(" is not null")) return rowValue !== null && rowValue !== undefined;
  if (lower.includes(" is null")) return rowValue === null || rowValue === undefined;
  if (lower.includes(" in (")) return params.some((p) => valuesEqual(p, rowValue));
  if (lower.includes(">=")) return (compareValues(rowValue, params[0]) ?? -1) >= 0;
  if (lower.includes("<=")) return (compareValues(rowValue, params[0]) ?? 1) <= 0;
  if (lower.includes("!=") || lower.includes("<>")) return !valuesEqual(rowValue, params[0]);
  if (lower.includes("<")) return (compareValues(rowValue, params[0]) ?? 1) < 0;
  if (lower.includes(">")) return (compareValues(rowValue, params[0]) ?? -1) > 0;
  if (lower.includes("=")) return valuesEqual(rowValue, params[0]);
  return true;
}

function evalCondition(condition: unknown, row: any): boolean {
  if (!condition) return true;
  const chunks = Array.isArray((condition as any).queryChunks)
    ? ((condition as any).queryChunks as any[])
    : [condition];
  // Split on top-level boolean connectors (drizzle and()/or() wrap their
  // operands in parens with " and "/" or " StringChunk separators).
  const parts: any[][] = [[]];
  const seps: string[] = [];
  for (const ch of chunks) {
    const t = chunkText(ch);
    if (t === " and " || t === " or ") {
      seps.push(t.trim());
      parts.push([]);
      continue;
    }
    parts[parts.length - 1].push(ch);
  }
  if (seps.length === 0) {
    return evalGroup(parts[0], row);
  }
  const results = parts.map((part) => evalGroup(part, row));
  return results.reduce(
    (acc, value, index) =>
      index === 0 ? value : seps[index - 1] === "and" ? acc && value : acc || value,
    true as boolean
  );
}

function evalGroup(group: any[], row: any): boolean {
  // Drop drizzle's parenthesis wrapper chunks: a group holding exactly one
  // nested SQL object is a sub-condition (recurse); anything else is atomic.
  const meaningful = group.filter((ch) => {
    const text = chunkText(ch);
    return text !== "(" && text !== ")";
  });
  if (
    meaningful.length === 1 &&
    meaningful[0] &&
    typeof meaningful[0] === "object" &&
    Array.isArray((meaningful[0] as any).queryChunks)
  ) {
    return evalCondition(meaningful[0], row);
  }
  return evalAtomic(flattenChunks(meaningful), row);
}

function columnName(column: unknown): string {
  return String((column as { name?: string }).name ?? "");
}

function orderSpec(col: unknown): { name: string; desc: boolean } {
  if (col && typeof col === "object" && (col as any).queryChunks) {
    const flat = flattenChunks(col);
    const name = flat.find((ch) => ch && typeof (ch as any).name === "string");
    const text = flat.map(chunkText).join("").toLowerCase();
    return { name: columnName(name), desc: /\bdesc\b/.test(text) };
  }
  if (col && typeof col === "object" && (col as any).desc) {
    return { name: columnName((col as any).desc), desc: true };
  }
  return { name: columnName(col), desc: false };
}

function projectRows(fields: unknown, rows: any[]): any[] {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return rows.map((r) => ({ ...r }));
  }
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0) return rows.map((r) => ({ ...r }));

  // Aggregate projection (count(*) / SUM(col) / COUNT(col)) collapses to a
  // single row over the filtered set.
  const aggregate = entries.find(([, col]) => {
    if (!col || typeof col !== "object") return false;
    if ((col as any).queryChunks || Array.isArray((col as any).value)) {
      const text = flattenChunks(col)
        .map(chunkText)
        .join("")
        .replace(/\s+/g, " ");
      return /(count|sum)\s*\(/i.test(text);
    }
    return false;
  });
  if (aggregate) {
    const out: Record<string, unknown> = {};
    for (const [alias, col] of entries) {
      const text = flattenChunks(col)
        .map(chunkText)
        .join("")
        .replace(/\s+/g, " ");
      if (/count\s*\(\s*\*/i.test(text)) {
        out[alias] = rows.length;
        continue;
      }
      const countCol = /count\s*\(\s*([A-Za-z_]+)\s*\)/i.exec(text)?.[1];
      if (countCol) {
        out[alias] = rows.filter((r) => r[countCol] !== null && r[countCol] !== undefined).length;
        continue;
      }
      const sumCol =
        /sum\s*\(\s*([A-Za-z_]+)\s*\)/i.exec(text)?.[1] ??
        /sum\s*\(\s*abs\s*\(\s*([A-Za-z_]+)\s*\)\s*\)/i.exec(text)?.[1];
      if (sumCol) {
        out[alias] = rows.reduce((acc, r) => acc + Number(r[sumCol] ?? 0), 0);
        continue;
      }
      out[alias] = rows[0] ? rows[0][columnName(col)] ?? null : null;
    }
    return [out];
  }

  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [alias, col] of entries) {
      out[alias] = row[columnName(col)] ?? null;
    }
    return out;
  });
}

function isSqlFragment(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Boolean((value as { queryChunks?: unknown }).queryChunks)
  );
}

function createHarnessDb() {
  const db: any = {
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        const name = getTableName(table) ?? "";
        let rows: any[] = tableRows(name).map((r) => ({ ...r }));
        const buildChain = () => {
          const chain: any = {
            where: (condition: unknown) => {
              rows = rows.filter((r) => evalCondition(condition, r));
              return chain;
            },
            orderBy: (...cols: unknown[]) => {
              const specs = cols.filter(Boolean).map(orderSpec);
              rows = [...rows].sort((a, b) => {
                for (const spec of specs) {
                  const av = a[spec.name];
                  const bv = b[spec.name];
                  const cmp = compareValues(av, bv);
                  if (cmp !== null && cmp !== 0) return spec.desc ? -cmp : cmp;
                  const sa = String(av ?? "");
                  const sb = String(bv ?? "");
                  if (sa !== sb) return spec.desc ? sb.localeCompare(sa) : sa.localeCompare(sb);
                }
                return 0;
              });
              return chain;
            },
            limit: async (_n: number) => projectRows(fields, rows),
            then: (resolve: (value: unknown[]) => unknown, reject?: (e: unknown) => void) => {
              try {
                resolve(projectRows(fields, rows));
              } catch (e) {
                reject?.(e);
              }
            },
          };
          return chain;
        };
        return buildChain();
      },
    }),
    insert: (table: unknown) => ({
      values: (values: any) => {
        const name = getTableName(table) ?? "unknown";
        const list = Array.isArray(values) ? values : [values];
        let duplicate: Error | null = null;
        const inserted: any[] = [];
        for (const value of list) {
          const uniqueSets = UNIQUE_KEYS[name] ?? [];
          const hitSet = uniqueSets.find(
            (keys) =>
              keys.every((k) => (value as any)[k] !== null && (value as any)[k] !== undefined) &&
              tableRows(name).some((row) => keys.every((k) => row[k] === (value as any)[k]))
          );
          if (hitSet) {
            duplicate = duplicateKeyError(`${name}.${hitSet.join("_")}`);
            continue;
          }
          const id = h.nextIds[name] ?? 1;
          h.nextIds[name] = id + 1;
          const defaults: Record<string, unknown> = { createdAt: new Date() };
          if (name === "learning_records") defaults.evaluatedAt = new Date();
          const row: any = { ...defaults, ...value, id };
          tableRows(name).push(row);
          inserted.push(row);
        }
        const chain: any = {
          onDuplicateKeyUpdate: ({ set }: any) => {
            if (duplicate) {
              const value = list[0];
              const uniqueSets = UNIQUE_KEYS[name] ?? [];
              const hitSet = uniqueSets.find((keys) =>
                tableRows(name).some((row) => keys.every((k) => row[k] === (value as any)[k]))
              );
              const existing = hitSet
                ? tableRows(name).find((row) => hitSet.every((k) => row[k] === (value as any)[k]))
                : undefined;
              if (existing && set) {
                for (const [key, setValue] of Object.entries(set)) {
                  (existing as any)[key] = isSqlFragment(setValue) ? (value as any)[key] : setValue;
                }
              }
              duplicate = null;
              return chain;
            }
            return chain;
          },
          then: (resolve: (value: unknown) => unknown, reject?: (e: unknown) => void) => {
            if (duplicate) {
              reject?.(duplicate);
              return;
            }
            resolve([{ insertId: inserted[inserted.length - 1]?.id ?? 0, affectedRows: inserted.length }]);
          },
        };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set: (payload: any) => ({
        where: (condition: unknown) => {
          const name = getTableName(table) ?? "";
          const rows = tableRows(name).filter((r) => evalCondition(condition, r));
          for (const row of rows) Object.assign(row, payload);
          return Promise.resolve([{ affectedRows: rows.length }]);
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (condition: unknown) => {
        const name = getTableName(table) ?? "";
        const rows = tableRows(name);
        let affected = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (evalCondition(condition, rows[i])) {
            rows.splice(i, 1);
            affected += 1;
          }
        }
        return Promise.resolve([{ affectedRows: affected }]);
      },
    }),
    // Emulated transaction rollback: on failure, truncate every managed table
    // back to its pre-transaction length (inserts roll back). In-place row
    // mutations never precede a throw on the harness's transaction paths.
    transaction: async (cb: any) => {
      const lengths = MANAGED_TABLES.map((name) => [name, tableRows(name).length] as const);
      try {
        return await cb(db);
      } catch (err) {
        for (const [name, length] of lengths) {
          const rows = tableRows(name);
          if (rows.length > length) rows.length = length;
        }
        throw err;
      }
    },
    execute: async (query: unknown) => {
      const compiled = new MySqlDialect().sqlToQuery(query as never);
      const sqlText = compiled.sql.replace(/\s+/g, " ");
      const p = compiled.params as any[];
      if (/FROM credit_wallets WHERE `?userId`? = \? FOR UPDATE/i.test(sqlText)) {
        const wallet = h.creditWallets.find((w) => w.userId === p[0]);
        return [wallet ? [wallet] : []];
      }
      if (/FROM credit_reservations/i.test(sqlText)) {
        const stateFilter = p.length > 1 ? p[1] : "reserved";
        const total = h.creditReservations
          .filter((r) => r.userId === p[0] && r.state === stateFilter)
          .reduce((acc, r) => acc + Number(r.reservedAmount ?? 0), 0);
        return [[{ total }]];
      }
      if (/UPDATE credit_wallets SET `?balance`? = `?balance`? - \?/i.test(sqlText)) {
        const wallet = h.creditWallets.find((w) => w.id === p[2]);
        if (!wallet || Number(wallet.balance) < Number(p[0])) return [{ affectedRows: 0 }];
        wallet.balance = Number(wallet.balance) - Number(p[0]);
        wallet.lifetimeSpent = Number(wallet.lifetimeSpent ?? 0) + Number(p[0]);
        wallet.updatedAt = new Date();
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE credit_reservations SET `?state`? = 'settled'/i.test(sqlText)) {
        const row = h.creditReservations.find((r) => r.id === p[3]);
        if (!row || row.state !== "reserved" || row.settleKey !== null) {
          return [{ affectedRows: 0 }];
        }
        row.state = "settled";
        row.settledAmount = Number(p[0]);
        row.settleKey = String(p[1]);
        row.settledAt = p[2] instanceof Date ? p[2] : new Date(String(p[2]));
        row.updatedAt = new Date();
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE credit_reservations SET `?state`? = 'released'/i.test(sqlText)) {
        const row = h.creditReservations.find((r) => r.id === p[3]);
        if (!row || row.state !== "reserved" || row.releaseKey !== null) {
          return [{ affectedRows: 0 }];
        }
        row.state = "released";
        row.releaseKey = String(p[0]);
        row.releaseReason = p[1] === null ? null : String(p[1]);
        row.releasedAt = p[2] instanceof Date ? p[2] : new Date(String(p[2]));
        row.updatedAt = new Date();
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    },
  };
  return db;
}

// ── World fixtures ─────────────────────────────────────────────────────────

const T0 = new Date("2026-06-01T08:00:00.000Z");
const USER_A = 14;
const USER_B = 999;
const ADMIN_ID = 1;
const BUSINESS_A = 24;
const CAMPAIGN_ID = 27;
const INTEGRATION_ID = 9;
const BOOTSTRAP_KEY = "bootstrap-x6-0123456789abcdef";

const WINDOWS = [
  { start: "2026-06-01", end: "2026-06-07" },
  { start: "2026-06-08", end: "2026-06-14" },
  { start: "2026-06-15", end: "2026-06-21" },
];
const OBSERVE_DATES = ["2026-06-03", "2026-06-10", "2026-06-17"];
const PUBLISH_AT = [
  "2026-06-01T13:00:00.000Z",
  "2026-06-08T13:00:00.000Z",
  "2026-06-15T13:00:00.000Z",
];

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

const APPROVED_COPY = {
  copyHashSha256: HASH_B,
  copySchemaVersion: "v2",
  approvedRevisionId: "rev-x6",
  assessmentHashSha256: HASH_C,
  contextLockId: "ctx-x6",
};

function approvedCopyFor(revisionId: string) {
  return { ...APPROVED_COPY, approvedRevisionId: revisionId };
}

const CAMPAIGN_BRIEF = {
  name: "Summer Board Drop",
  goal: "Sell 100 boards",
  targetAudience: "Surfers in Cape Town",
  coreMessage: "Handmade surfboards, built locally",
  platforms: "facebook",
  budget: 2000,
  primaryOutcome: "conversions",
  targetBuyer: "Surfers 18-40",
  mainPainPoint: "Mass-produced boards that don't last",
  productOrService: "Handmade surfboards",
  offerDetails: "",
  preferredCta: "Book a Demo",
  excludedOffers: "",
  referenceStyle: "",
  contentStyle: "",
};

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
  h.campaigns = [];
  h.businesses = [
    {
      id: BUSINESS_A,
      userId: USER_A,
      name: "Acme Surf Co",
      industry: "retail",
      location: "Cape Town",
      productOrService: "Handmade surfboards",
      targetCustomer: "Surfers 18-40",
      targetAudience: null,
      brandTone: "bold",
      preferredPlatforms: "facebook",
      mainGoal: "Increase online orders",
      monthlyBudget: 2000,
      website: "https://acme.example.com",
      websiteEvidence: null,
      isActive: true,
      onboardingComplete: true,
    },
  ];
  h.agentRuns = [];
  h.approvalRequests = [];
  h.publishingQueue = [];
  h.contentPosts = [];
  h.campaignAssets = [];
  h.generatedImages = [];
  h.creativeGenerationClaims = [];
  h.creditTransactions = [];
  h.creditWallets = [
    {
      id: 1,
      userId: USER_A,
      balance: 100000,
      lifetimeEarned: 100000,
      lifetimeSpent: 0,
      spendLimit: null,
      monthlyAllocation: 0,
      monthlyResetAt: null,
      updatedAt: new Date(),
    },
    {
      id: 2,
      userId: USER_B,
      balance: 0,
      lifetimeEarned: 0,
      lifetimeSpent: 0,
      spendLimit: null,
      monthlyAllocation: 0,
      monthlyResetAt: null,
      updatedAt: new Date(),
    },
  ];
  h.creditReservations = [];
  h.auditEvents = [];
  h.learningRecords = [];
  h.analytics = [];
  h.socialIntegrations = [
    {
      id: INTEGRATION_ID,
      userId: USER_A,
      platform: "facebook",
      status: "connected",
      accountName: "Test Page",
      pageId: "830205703508466",
      pageAccessTokenEncrypted: "page-token",
      accessTokenEncrypted: "user-token",
      instagramBusinessAccountId: null,
      businessId: null,
    },
  ];
  h.socialProfiles = [];
  h.socialEngagementEvents = [];
  h.campaignInterestSignals = [];
  h.leads = [];
  h.leadScores = [];
  h.outreachRecommendations = [];
  h.schedules = [];
  h.strategySnapshots = [];
  h.businessDnaSnapshots = [];
  h.aiUsage = [];
  h.nextIds = {
    campaigns: CAMPAIGN_ID,
    agent_runs: 6000,
    approval_requests: 9000,
    publishing_queue: 5000,
    content_posts: 4000,
    campaign_assets: 4500,
    generated_images: 4700,
    creative_generation_claims: 4800,
    credit_transactions: 3000,
    credit_wallets: 100,
    credit_reservations: 7000,
    audit_events: 8000,
    learning_records: 9500,
    analytics: 9600,
    leads: 3000,
    lead_scores: 3100,
    outreach_recommendations: 3200,
    social_profiles: 100,
    social_engagement_events: 200,
    campaign_interest_signals: 100,
    schedules: 100,
    strategy_snapshots: 100,
    business_dna_snapshots: 100,
    ai_usage: 100,
  };
  h.llmQueue = [];
  h.runAgentQueue = [];
  h.runAgentCalls = [];
  h.facebookBehavior = [];
  h.providerCalls = [];
  h.scheduledJobs = [];
  h.bullmqAvailable = true;
  h.creativeShouldFail = false;
  h.creativeGenerations = 0;
  h.creativeCalls = [];
  h.audienceAgentCalls = [];
  h.metaEvents = null;
  h.linkedinEvents = null;
  h.subscriptionCalls = [];
  vi.setSystemTime(T0);
}

function campaign(): any {
  return h.campaigns.find((c) => c.id === CAMPAIGN_ID);
}

function briefFingerprint(): string {
  return buildGroundedCreativeBrief({
    campaign: campaign(),
    business: h.businesses[0],
  }).fingerprint;
}

function ctxFor(userId: number, role: "user" | "admin" = "user") {
  return {
    resHeaders: new Headers(),
    user: { id: userId, role, tierSlug: "free", onboardingComplete: true },
    session: { verified: true },
  } as any;
}

async function flushBg(): Promise<void> {
  // Real timers (only Date is faked): one macrotask lets every pending
  // microtask chain (fire-and-forget background continuations) drain.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function installDb() {
  vi.mocked(getDb).mockReturnValue(createHarnessDb() as any);
}

function queueLlmSuccess() {
  h.llmQueue.push(() => ({
    object: {
      personas: [
        {
          name: "Surfer",
          demographics: "18-40",
          painPoints: ["Mass-produced boards that don't last"],
          goals: ["Book a Demo"],
          platforms: ["Facebook"],
        },
      ],
      positioning: "Handmade boards",
      valueProposition: "Built locally",
      coreMessage: "Handmade surfboards, built locally",
      campaignTheme: "Summer board drop",
      platformStrategy: [
        {
          platform: "Facebook",
          purpose: "Reach surfers",
          contentTypes: ["Posts"],
          postingFrequency: "3x per week",
        },
      ],
      funnelStages: [
        { stage: "awareness", goal: "Reach", tactics: ["Publish"], metrics: ["impressions"] },
        { stage: "consideration", goal: "Engage", tactics: ["Share"], metrics: ["engagement"] },
        { stage: "conversion", goal: "Convert", tactics: ["CTA"], metrics: ["conversions"] },
      ],
      offers: [],
      ctas: [{ stage: "awareness", cta: "Book a Demo", placement: "Facebook" }],
      budgetRecommendation: { total: 1000, allocation: [] },
    },
    usage: { promptTokens: 12, completionTokens: 34 },
  }));
}

// ── Chain drivers (REAL modules throughout) ────────────────────────────────

async function createCampaignViaRouter(input: Partial<typeof CAMPAIGN_BRIEF> & { idempotencyKey?: string } = {}) {
  const { campaignRouter } = await import("../../../campaign-router");
  const caller = campaignRouter.createCaller(ctxFor(USER_A));
  return caller.create({ ...CAMPAIGN_BRIEF, ...input });
}

/** Drives the strategy phase via the real campaignRouter create caller. */
async function driveBootstrap(idempotencyKey: string) {
  queueLlmSuccess();
  const created = await createCampaignViaRouter({ idempotencyKey });
  await flushBg();
  expect(created).toMatchObject({ id: CAMPAIGN_ID, success: true });
  const review = h.approvalRequests.find((r) => r.approvalType === "strategy_review");
  expect(review, "exactly one strategy_review request").toBeTruthy();
  expect(review.status).toBe("pending");
  const lineage = campaign().workflowContext.strategyApprovalLineage;
  expect(lineage).toMatchObject({ approvalRequestId: review.id, status: "pending" });
  expect(lineage.strategyHashSha256).toMatch(/^[0-9a-f]{64}$/);
  return { reviewId: review.id, strategyRunId: lineage.strategyRunId as number };
}

async function driveApprovalDecision(approvalId: number, decision: "approved" | "rejected", userId = USER_A) {
  const { approvalRouter } = await import("../../../approval-router");
  const caller = approvalRouter.createCaller(ctxFor(userId));
  const result =
    decision === "approved"
      ? await caller.approveAction({ approvalId })
      : await caller.rejectAction({ approvalId });
  await flushBg();
  return result;
}

async function driveRenderCompletionAndSeal() {
  const { syncCreativeReleasePackage } = await import("../../creative/release-package");
  const post = [...h.contentPosts]
    .filter((p) => p.metadata?.assetKind === "master_campaign_post")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  expect(post, "leaflet post must exist").toBeTruthy();
  const generation = post.metadata.generationRunId;
  h.generatedImages.push({
    id: h.nextIds.generated_images++,
    userId: USER_A,
    campaignId: CAMPAIGN_ID,
    contentPostId: post.id,
    status: "completed",
    url: "https://cdn.example.com/leaflet.png",
    createdAt: new Date().toISOString(),
    metadata: {
      renderLineage: {
        lineageSchemaVersion: 1,
        lineageFingerprintSha256: HASH_D,
        strategy: {
          strategySnapshotId: post.metadata.strategySnapshotId,
          strategyVersion: post.metadata.strategyVersion,
          businessDnaSnapshotId: post.metadata.businessDnaSnapshotId,
          strategyHashSha256: post.metadata.strategyHashSha256,
        },
      },
      creativeBriefFingerprint: post.metadata.creativeBriefFingerprint,
    },
  });
  post.metadata = {
    ...post.metadata,
    imageStatus: "ready",
    imageUrl: "https://cdn.example.com/leaflet.png",
  };
  await syncCreativeReleasePackage({ userId: USER_A, campaignId: CAMPAIGN_ID, sealedBy: "harness.render" });
  const authority = campaign().workflowContext.strategyApprovalLineage;
  const captionId = h.nextIds.campaign_assets++;
  h.campaignAssets.push({
    id: captionId,
    userId: USER_A,
    campaignId: CAMPAIGN_ID,
    assetType: "caption_pack",
    title: `Caption Pack ${generation}`,
    status: "ready",
    createdAt: new Date().toISOString(),
    metadata: {
      creativeBriefFingerprint: post.metadata.creativeBriefFingerprint,
      strategySnapshotId: authority.strategySnapshotId,
      strategyVersion: authority.strategyVersion,
      businessDnaSnapshotId: authority.businessDnaSnapshotId,
      strategyHashSha256: authority.strategyHashSha256,
    },
  });
  return syncCreativeReleasePackage({
    userId: USER_A,
    campaignId: CAMPAIGN_ID,
    sealedBy: "harness.caption-pack",
  });
}

async function driveCreativePhase(reviewId: number) {
  const before = h.creativeCalls.length;
  await driveApprovalDecision(reviewId, "approved");
  expect(h.creativeCalls.length).toBe(before + 1);
  expect(campaign().workflowState).toBe("creatives_ready");
  const seal = await driveRenderCompletionAndSeal();
  expect(seal.outcome).not.toBe("incomplete");
  return seal;
}

function seedAudienceSignal(externalIdentifier: string, sourceEventIds: number[] = []) {
  h.campaignInterestSignals.push({
    id: h.nextIds.campaign_interest_signals++,
    userId: USER_A,
    campaignId: CAMPAIGN_ID,
    externalIdentifier,
    signalType: "facebook",
    strength: 5,
    sourceEventIds,
    contextSnippet: "Loved this",
  });
}

async function runAudienceIntelligenceStep(continuationId: number) {
  const { runAudienceIntelligenceAgent } = await import("../../agents/audience-intelligence-agent");
  const { buildAudienceIntelligenceBillingIdentity } = await import("../agent-billing-identity");
  const billingIdentity = buildAudienceIntelligenceBillingIdentity({
    campaignId: CAMPAIGN_ID,
    continuationId,
  });
  h.runAgentQueue.push(() => ({ output: RAW_AUDIENCE_OUTPUT }));
  const result = await runAudienceIntelligenceAgent({
    userId: USER_A,
    campaignId: CAMPAIGN_ID,
    autoCreateLeads: false,
    billingIdentity,
  });
  expect(result.replayed).toBeUndefined();
  expect(campaign().workflowContext.audienceIntelligenceRunId).toBe(result.runId);
  expect(campaign().workflowContext.audienceIntelligenceBillingKey).toBe(billingIdentity);
  return { ...result, billingIdentity };
}

async function runDistributionStep(audienceRunId: number, scheduledAtIso: string) {
  const { runDistributionAgent } = await import("../../agents/distribution-agent");
  const { buildDistributionBillingIdentity } = await import("../agent-billing-identity");
  const billingIdentity = buildDistributionBillingIdentity({ campaignId: CAMPAIGN_ID, audienceRunId });
  h.runAgentQueue.push(() => {
    const leaflet = [...h.contentPosts]
      .filter((p) => p.metadata?.assetKind === "master_campaign_post")
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    return {
      output: {
        schedule: [{ contentPostId: leaflet.id, platform: "facebook", scheduledAt: scheduledAtIso }],
      },
    };
  });
  const result = await runDistributionAgent({
    userId: USER_A,
    campaignId: CAMPAIGN_ID,
    approvalMode: "autonomous",
    billingIdentity,
  });
  expect(result.replayed).toBe(false);
  expect(campaign().workflowContext.distributionBillingKey).toBe(billingIdentity);
  return { ...result, billingIdentity };
}

/** Advances lifecycle through the real governed engine. */
async function transition(action: string) {
  const { transitionCampaignState } = await import("../engine");
  return transitionCampaignState(CAMPAIGN_ID, USER_A, action as any);
}

function latestSnapshot(): any {
  return [...h.strategySnapshots].sort((a, b) => b.version - a.version)[0] ?? null;
}

function launchApproval() {
  return h.approvalRequests
    .filter((r) => r.approvalType === "campaign_launch")
    .sort((a, b) => b.id - a.id)[0];
}

async function driveLaunchPhase() {
  const launch = launchApproval();
  expect(launch, "campaign_launch approval must exist").toBeTruthy();
  expect(launch.status).toBe("pending");
  await driveApprovalDecision(launch.id, "approved");
  expect(campaign().workflowState).toBe("publication_pending");
  const lineage = campaign().workflowContext.launchApprovalLineage;
  expect(lineage).toMatchObject({ approvalRequestId: launch.id, status: "approved" });
  return launch.id;
}

function buildGovernedPackage(input: {
  contentPostId: number;
  strategy: {
    strategySnapshotId: string;
    strategyVersion: number;
    businessDnaSnapshotId: string;
    strategyHashSha256: string;
    strategyRunId: number;
    approvalRequestId: number;
    creativeBriefFingerprint: string;
  };
  approvedCopy: typeof APPROVED_COPY;
  launchApprovalId: number;
}): PublishPackage {
  const post = h.contentPosts.find((p) => p.id === input.contentPostId)!;
  const HOOK = "HOOK::x6::";
  const CAPTION = "CAPTION::x6 body::";
  const CTA = "CTA::x6 call::";
  const IMAGE_URL = "https://cdn.example.com/leaflet.png";
  const text = `${HOOK}\n\n${CAPTION}\n\n${CTA}`;
  const lineage = {
    lineageSchemaVersion: 1,
    artifactKind: "caption_pack" as const,
    artifactId: 501,
    lineageFingerprintSha256: deriveCreativeArtifactLineageFingerprint({
      artifactKind: "caption_pack",
      platform: null,
      parent: null,
      strategy: input.strategy,
      approvedCopy: input.approvedCopy,
    }),
    strategy: input.strategy,
    approvedCopy: input.approvedCopy,
  };
  return buildPublishPackage({
    campaignId: CAMPAIGN_ID,
    userId: USER_A,
    businessId: BUSINESS_A,
    destination: { platform: "facebook", integrationId: INTEGRATION_ID },
    intent: { mode: "immediate" },
    strategyAuthority: input.strategy,
    approvedCopy: input.approvedCopy,
    selectedContent: {
      contentPostId: input.contentPostId,
      artifactKind: "content_post",
      lineage: {
        lineageSchemaVersion: 1,
        artifactKind: "content_post",
        artifactId: input.contentPostId,
        lineageFingerprintSha256: HASH_E,
        strategy: input.strategy,
        approvedCopy: input.approvedCopy,
      },
    },
    captionArtifact: { artifactId: 501, artifactKind: "caption_pack", lineage },
    visualArtifact: {
      mediaKind: "image",
      generatedAssetId: 909,
      mediaUrl: IMAGE_URL,
      renderLineage: {
        lineageFingerprintSha256: HASH_C,
        strategy: input.strategy,
        approvedCopy: input.approvedCopy,
      },
    },
    evidence: { launchApprovalRequestId: input.launchApprovalId },
    payload: { text, mediaUrls: [IMAGE_URL], mediaType: "image" },
  } as PublishPackageBuildInput);
}

function attachPackageToQueueRow(queueItemId: number, pkg: PublishPackage) {
  const envelope = serializePublishPackageForQueue(pkg);
  const row = h.publishingQueue.find((r) => r.id === queueItemId);
  row.metadata = JSON.parse(JSON.stringify(envelope));
  row.integrationId = pkg.identity.destination.integrationId;
  if (pkg.identity.intent.mode === "immediate") {
    row.scheduledAt = null;
  }
  assertQueuePublishPackageIntegrity(row.metadata.publishPackage);
  return pkg;
}

async function executeQueueItem(queueItemId: number, pkg?: PublishPackage) {
  const { publishSinglePost } = await import("../publishing-runner");
  let publishPackage = pkg ?? null;
  if (!publishPackage) {
    const plan = await loadQueuePublishPackagePlan(queueItemId);
    if (plan.kind === "governed") publishPackage = plan.publishPackage;
  }
  return publishSinglePost(queueItemId, publishPackage ? { publishPackage } : undefined);
}

function publicationReceipts() {
  return h.auditEvents.filter(
    (a) =>
      a.eventType === "publication_success" &&
      a.metadata?.publicationReceipt?.operationId ===
        `publication:facebook:${a.metadata?.publicationReceipt?.queueItemId}`
  );
}

function publishingCharges() {
  return h.creditTransactions.filter(
    (c) => c.type === "publishing_deduction" && c.metadata?.queueItemId != null
  );
}

function strategyCharges() {
  return h.creditTransactions.filter(
    (c) =>
      c.type === "agent_deduction" &&
      typeof c.idempotencyKey === "string" &&
      c.idempotencyKey.startsWith("strategy-run-")
  );
}

// ── Post-live helpers ──────────────────────────────────────────────────────

async function runObservation(asOfDate: string) {
  const { runPostLiveMetricsObservationPass, createDefaultPostLiveMetricsObservationPassDeps } =
    await import("../post-live-metrics-observation-pass");
  const defaultDeps = createDefaultPostLiveMetricsObservationPassDeps();
  const report = await runPostLiveMetricsObservationPass({
    asOfDate,
    deps: {
      ...defaultDeps,
      resolveBinding: () => ({
        platform: "facebook" as const,
        fetchPostMetrics: async () => [
          { metricType: "impressions", value: 100 },
          { metricType: "clicks", value: 5 },
          { metricType: "conversions", value: 1 },
        ],
      }),
    },
  });
  return report;
}

function armEngagement(count: number, windowStart: string, offsetHours = 0) {
  const base = new Date(`${windowStart}T09:00:00.000Z`).getTime() + offsetHours * 60 * 60 * 1000;
  h.metaEvents = {
    profiles: [],
    events: Array.from({ length: count }, (_, index) => ({
      platform: "facebook",
      externalProfileId: "page-1",
      externalContentId: "post-9",
      eventType: "comment",
      actorExternalId: `actor-${index}-o${offsetHours}`,
      actorHandle: `@commenter-${index}-o${offsetHours}`,
      actorDisplayName: `Commenter ${index}`,
      messageText: `Engaged ${index}`,
      eventTimestamp: new Date(base + index * 60_000),
      metadata: undefined,
    })),
    warnings: [],
  };
}

async function runIngest() {
  const { ingestAudienceData } = await import("../../audience/ingest");
  return ingestAudienceData({ userId: USER_A, businessId: BUSINESS_A, campaignId: CAMPAIGN_ID });
}

async function runLearning(window: { start: string; end: string }) {
  const { runGovernedLearningCycle } = await import("../../learning/learning-cycle-service");
  const { loadCampaignPerformanceDataset } = await import("../../learning/performance/loader");
  return runGovernedLearningCycle({
    userId: USER_A,
    campaignId: CAMPAIGN_ID,
    windowStart: window.start,
    windowEnd: window.end,
    trigger: "api",
    deps: { loadDataset: { loadCampaignPerformanceDataset }, now: () => new Date() },
  });
}

function seedWonLead(windowStart: string) {
  h.leads.push({
    id: h.nextIds.leads++,
    userId: USER_A,
    campaignId: CAMPAIGN_ID,
    status: "won",
    createdAt: new Date(`${windowStart}T10:00:00.000Z`),
    customFields: {},
  });
}

async function drivePromotion(learningRecordId: number, recommendationId: string) {
  const { proposeLearningPromotion } = await import("../../learning/promotion/promotion-service");
  const proposed = await proposeLearningPromotion({
    userId: USER_A,
    learningRecordId,
    recommendationId,
  });
  expect(proposed.outcome).toBe("created");
  await driveApprovalDecision(proposed.proposal.approvalRequestId, "approved");
  return proposed;
}

function approvedEnvelopes() {
  return h.auditEvents.filter((a) => a.eventType === "learning_promotion_resolved");
}

function nextCycleInstruction() {
  const ctx = campaign().workflowContext ?? {};
  return (ctx as any).nextCycle ?? null;
}

function comparable(row: any): string {
  const normalize = (value: any): any => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      const out: any = {};
      for (const key of Object.keys(value).sort()) out[key] = normalize(value[key]);
      return out;
    }
    return value;
  };
  return JSON.stringify(normalize(row));
}

// ── Full-cycle driver ──────────────────────────────────────────────────────

interface LiveFacts {
  reviewId: number;
  strategyRunId: number;
  queueRowId: number;
  launchApprovalId: number;
  leafletId: number;
}

async function driveToLive(
  n: number,
  bootstrap: { reviewId: number; strategyRunId: number } | null,
  opts: { execute?: boolean } = {}
): Promise<LiveFacts> {
  const window = WINDOWS[n - 1];
  let reviewId: number;
  let strategyRunId: number;
  if (bootstrap) {
    reviewId = bootstrap.reviewId;
    strategyRunId = bootstrap.strategyRunId;
  } else {
    const review = h.approvalRequests
      .filter((r) => r.approvalType === "strategy_review" && r.status === "pending")
      .sort((a, b) => b.id - a.id)[0];
    expect(review, `cycle ${n}: pending strategy_review from the next-cycle dispatch`).toBeTruthy();
    reviewId = review.id;
    strategyRunId = campaign().workflowContext.strategyApprovalLineage.strategyRunId;
  }

  // Creative phase (real approval decision → onStrategyApproved → real claim,
  // creative agent boundary, completion trigger, real release-package seal).
  if (n > 1) {
    // Governed re-entry: campaign_live → strategy_approved (engine `pause`).
    await transition("pause");
  }
  await driveCreativePhase(reviewId);

  // Audience intelligence (real agent, caller-stable billing identity).
  seedAudienceSignal(`fb:cycle-${n}`);
  const ai = await runAudienceIntelligenceStep(reviewId);

  // Distribution (real agent) — governed engine transitions like the API boundary.
  await transition("generate_audience");
  await transition("audience_complete");
  await transition("generate_schedule");
  const dist = await runDistributionStep(ai.runId, `${window.start}T12:00:00.000Z`);
  expect(dist.queueIds).toHaveLength(1);
  const queueRowId = dist.queueIds[0];
  const row = h.publishingQueue.find((r) => r.id === queueRowId);
  expect(row).toMatchObject({ userId: USER_A, campaignId: CAMPAIGN_ID, platform: "facebook", status: "approved" });

  const { onAgentRunComplete } = await import("../triggers");
  await onAgentRunComplete(dist.runId);
  expect(campaign().workflowState).toBe("launch_approval_required");

  const launchApprovalId = await driveLaunchPhase();

  // Governed publish package build + durable queue binding + due execution.
  const leaflet = [...h.contentPosts]
    .filter((p) => p.metadata?.assetKind === "master_campaign_post")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const lineage = campaign().workflowContext.strategyApprovalLineage;
  const pkg = buildGovernedPackage({
    contentPostId: leaflet.id,
    strategy: {
      strategySnapshotId: lineage.strategySnapshotId,
      strategyVersion: lineage.strategyVersion,
      businessDnaSnapshotId: lineage.businessDnaSnapshotId,
      strategyHashSha256: lineage.strategyHashSha256,
      strategyRunId: lineage.strategyRunId,
      approvalRequestId: lineage.approvalRequestId,
      creativeBriefFingerprint: lineage.creativeBriefFingerprint,
    },
    approvedCopy: approvedCopyFor(`rev-x6-${n}`),
    launchApprovalId,
  });
  armEngagement(2, window.start);
  attachPackageToQueueRow(queueRowId, pkg);
  if (opts.execute !== false) {
    vi.setSystemTime(new Date(PUBLISH_AT[n - 1]));
    const exec = await executeQueueItem(queueRowId);
    expect(exec.status).toBe("published");
    expect(campaign().workflowState).toBe("campaign_live");
    await flushBg();
  }

  return { reviewId, strategyRunId, queueRowId, launchApprovalId, leafletId: leaflet.id };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe.sequential("WBS-R4 Stream X6 — FULL AUTONOMY connected E2E", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.clearAllMocks();
    resetWorld();
    installDb();
    // Warm every lazily-imported module on the continuation paths: the
    // approval trigger loads budget-resume / approval-continuation /
    // next-cycle trigger+dispatcher via dynamic import(), whose first load
    // resolves through real I/O (a macrotask) and would race the harness
    // flush. Cached, they resolve in pure microtasks.
    await Promise.all([
      import("../triggers"),
      import("../budget-resume"),
      import("../approval-continuation"),
      import("../next-cycle-trigger"),
      import("../next-cycle-dispatcher"),
      import("../engine"),
      import("../../audience/ingest"),
      import("../../learning/performance/loader"),
      import("../../governance/lifecycle-projection"),
      import("../publishing-runner"),
      import("../../../approval-router"),
      import("../../../admin-router"),
      import("../../../campaign-router"),
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("S0 — campaign bootstrap idempotency: replayed create returns the original campaign and consumes usage exactly once", async () => {
    queueLlmSuccess();
    const first = await createCampaignViaRouter({ idempotencyKey: BOOTSTRAP_KEY });
    expect(first).toMatchObject({ id: CAMPAIGN_ID, success: true });
    expect(h.campaigns).toHaveLength(1);
    expect(h.campaigns[0].workflowContext).toMatchObject({ bootstrapIdempotencyKey: BOOTSTRAP_KEY });
    expect(h.subscriptionCalls.filter((c) => c.kind === "campaign")).toHaveLength(1);

    const replay = await createCampaignViaRouter({ idempotencyKey: BOOTSTRAP_KEY });
    expect(replay).toMatchObject({ id: CAMPAIGN_ID, success: true, idempotentReplay: true });
    expect(h.campaigns).toHaveLength(1);
    expect(h.subscriptionCalls.filter((c) => c.kind === "campaign")).toHaveLength(1);
    await flushBg();
  });

  it("happy path — three connected governed cycles with exactly one authoritative effect per operation", async () => {
    const instructionIds: string[] = [];
    const recordSnapshots = new Map<number, string>();
    const snapshotSnapshots = new Map<number, string>();
    const envelopeSnapshots: string[] = [];
    const sealedFingerprints: string[] = [];
    const cycleHashes: string[] = [];

    for (let n = 1; n <= 3; n++) {
      const window = WINDOWS[n - 1];
      const bootstrap = n === 1 ? await driveBootstrap(`${BOOTSTRAP_KEY}-c1`) : null;
      if (n === 1) {
        expect(h.campaigns).toHaveLength(1);
        expect(h.subscriptionCalls.filter((c) => c.kind === "campaign")).toHaveLength(1);
      }

      const snapshotBefore = latestSnapshot();
      expect(snapshotBefore.version).toBe(n);
      cycleHashes.push(snapshotBefore.strategyHashSha256);
      // Freeze the governed snapshot rows of all previous cycles for the
      // byte-identical immutability assertion (previous cycles never mutate).
      for (let k = 1; k < n; k++) {
        if (!snapshotSnapshots.has(k)) {
          snapshotSnapshots.set(k, comparable(h.strategySnapshots.find((row) => row.version === k)));
        }
      }

      // ── KPI/performance dataset over the REAL loader (before the cycle's
      //    own observations exist for this window, the loader must still
      //    resolve authority) ──
      const live = await driveToLive(n, bootstrap);

      // ── post-live metrics observation pass (real pass, fake binding) ──
      vi.setSystemTime(new Date(`${OBSERVE_DATES[n - 1]}T12:00:00.000Z`));
      const report = await runObservation(OBSERVE_DATES[n - 1]);
      // The due window is campaign+platform scoped (real wiring): exactly one
      // observation set per window; the remaining candidates read not_due.
      expect(report.observed).toBe(1);
      expect(report.results.filter((r) => r.status === "not_due").length).toBe(n - 1);
      const dayRows = h.analytics.filter(
        (a) => a.observationId != null && a.date instanceof Date && a.date.toISOString().slice(0, 10) === OBSERVE_DATES[n - 1]
      );
      expect(dayRows).toHaveLength(3); // one observation set (post × metric × day)
      expect(new Set(dayRows.map((r) => r.observationId)).size).toBe(3);
      const observationRowCount = h.analytics.filter((a) => a.observationId != null).length;

      // ── engagement ingest (real ingest path, provider adapter faked) ──
      // driveToLive armed batch 1 (consumed by the fire-and-forget
      // post-publish ingest). Batch 2 (distinct timestamps → distinct
      // dedupHashes) is consumed by this explicit cycle ingest; replaying the
      // same provider payload collapses onto the same durable rows.
      armEngagement(2, window.start, 2);
      await runIngest();
      await flushBg();
      expect(h.socialEngagementEvents).toHaveLength(4 * n);
      const replayIngest = await runIngest(); // adapter now empty → pure replay
      await flushBg();
      expect(h.socialEngagementEvents).toHaveLength(4 * n);
      expect(replayIngest.eventsSynced).toBe(0);

      // ── governed learning cycle (real loader + dataset builder) ──
      seedWonLead(window.start);
      const cycle = await runLearning(window);
      expect(cycle.status).toBe("recorded");
      if (cycle.status !== "recorded") return;
      expect(cycle.idempotentReplay).toBe(false);
      const replayCycle = await runLearning(window);
      expect(replayCycle.status).toBe("recorded");
      if (replayCycle.status !== "recorded") return;
      expect(replayCycle.idempotentReplay).toBe(true);
      expect(replayCycle.record.id).toBe(cycle.record.id);
      expect(h.learningRecords).toHaveLength(n);
      const stored = h.learningRecords.find((r) => r.id === cycle.record.id);
      recordSnapshots.set(n, comparable(stored));
      const provenance = stored.provenance as { wbs15?: { strategyAuthority?: { strategyHashSha256?: string } } };
      expect(provenance.wbs15?.strategyAuthority?.strategyHashSha256).toBe(cycleHashes[n - 1]);

      // ── promotion proposal → governed approval → sealed envelope ──
      const recommendation = cycle.record.recommendedAdjustments.find(
        (r) => r.governance.autoApply === false && r.governance.requiresApproval === true
      );
      expect(recommendation, "governed recommendation required").toBeTruthy();
      if (!recommendation) return;
      if (n < 3) {
        // A real optimisation cycle refreshes the brief before the next
        // governed Strategy is seeded: the dispatched Strategy N+1 binds the
        // NEW brief fingerprint, so creative regeneration is genuinely
        // required (the approval-scoped dedup cannot reuse cycle N artefacts).
        const camp = campaign();
        camp.coreMessage = `${camp.coreMessage} — refreshed for cycle ${n + 1}`;
      }
      queueLlmSuccess(); // the N+1 Strategy run inside the dispatch consumes this
      const proposed = await drivePromotion(cycle.record.id, recommendation.id);
      expect(approvedEnvelopes()).toHaveLength(n);
      envelopeSnapshots.push(comparable(approvedEnvelopes()[n - 1]));
      expect(proposed.proposal.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);
      sealedFingerprints.push(proposed.proposal.proposalFingerprint);

      // ── Stream A next-cycle dispatch (real trigger + dispatcher) ──
      const instruction = nextCycleInstruction();
      expect(instruction).toBeTruthy();
      expect(instruction.status).toBe("dispatched");
      instructionIds.push(instruction.instructionId);
      const newPending = h.approvalRequests.filter(
        (r) => r.approvalType === "strategy_review" && r.status === "pending"
      );
      expect(newPending).toHaveLength(1); // exactly one new review for the N+1 cycle
      // The new cycle consumed every sealed envelope from previous cycles,
      // in governed approval-request order — and nothing else.
      expect(
        (campaign().workflowContext.learningPromotionInputs ?? []).map(
          (entry: any) => entry.proposalFingerprint
        )
      ).toEqual(sealedFingerprints);

      // ── Strategy N+1 consumed the sealed learning evidence ──
      const nextSnapshot = latestSnapshot();
      expect(nextSnapshot.version).toBe(n + 1);
      const payload = nextSnapshot.snapshot as { learningPromotionInputs?: Array<{ proposalFingerprint: string; promotedProvenanceClass: string }> };
      expect(payload.learningPromotionInputs?.map((entry) => entry.proposalFingerprint)).toEqual(sealedFingerprints);
      expect(payload.learningPromotionInputs?.[0]?.promotedProvenanceClass).toBe("approved_recommendation");

      // ── per-cycle one-effect assertions ──
      if (n > 1) {
        // Stream A/E charge contract (X3.2): the next-cycle dispatcher itself
        // charges the fresh strategy run exactly once under the stable
        // server-derived identity strategy-run-${runId} (E contract §5, now
        // enforced in next-cycle-dispatcher). Reconciliation therefore finds
        // the durable charge already present — and stays idempotent on replay.
        const { reconcileStrategyRunCharge } = await import("../../agents/strategy-agent");
        const reconcile = await reconcileStrategyRunCharge(USER_A, CAMPAIGN_ID, live.strategyRunId);
        expect(reconcile.alreadyCharged).toBe(true);
        const replayReconcile = await reconcileStrategyRunCharge(USER_A, CAMPAIGN_ID, live.strategyRunId);
        expect(replayReconcile.alreadyCharged).toBe(true);
      }
      expect(strategyCharges().filter((c) => c.metadata?.runId === live.strategyRunId)).toHaveLength(1);
      expect(new Set(strategyCharges().map((c) => c.idempotencyKey)).size).toBe(strategyCharges().length);
      const aiRuns = h.agentRuns.filter(
        (r) =>
          r.agentType === "audience" &&
          r.status === "completed" &&
          r.campaignId === CAMPAIGN_ID &&
          r.output?.executiveSummary === "Strong fit"
      );
      expect(aiRuns).toHaveLength(n);
      const aiBillingKeys = h.runAgentCalls.filter((c) => c.agentType === "audience" && c.billingIdempotencyKey);
      expect(new Set(aiBillingKeys.map((c) => c.billingIdempotencyKey)).size).toBe(n);
      const liveRows = h.publishingQueue.filter((r) => r.userId === USER_A && r.campaignId === CAMPAIGN_ID);
      expect(new Set(liveRows.map((r) => `${r.contentPostId}:${r.platform}`)).size).toBe(liveRows.length);
      expect(publicationReceipts()).toHaveLength(n);
      for (const receipt of publicationReceipts()) {
        expect(receipt.metadata.publicationReceipt.operationId).toBe(
          `publication:facebook:${receipt.metadata.publicationReceipt.queueItemId}`
        );
      }
      expect(publishingCharges()).toHaveLength(n);

      // ── durable governed artefacts of previous cycles stay byte-identical ──
      for (let prev = 1; prev < n; prev++) {
        const prevRecord = h.learningRecords.find((r) => r.id === JSON.parse(recordSnapshots.get(prev)!).id);
        expect(comparable(prevRecord)).toBe(recordSnapshots.get(prev));
        const prevSnapshot = h.strategySnapshots.find((s) => s.version === prev);
        expect(comparable(prevSnapshot)).toBe(snapshotSnapshots.get(prev));
        expect(comparable(approvedEnvelopes()[prev - 1])).toBe(envelopeSnapshots[prev - 1]);
      }
      // Same-day re-observation cannot duplicate the observation set.
      const reobserve = await runObservation(OBSERVE_DATES[n - 1]);
      expect(reobserve.results.every((r) => r.status === "not_due")).toBe(true);
      expect(h.analytics.filter((a) => a.observationId != null)).toHaveLength(observationRowCount);
    }

    // ── three cycles, three distinct instruction identities + hashes ──
    expect(new Set(instructionIds).size).toBe(3);
    expect(new Set(cycleHashes).size).toBe(3);
    expect(h.learningRecords).toHaveLength(3);
    expect(approvedEnvelopes()).toHaveLength(3);
    expect(publicationReceipts()).toHaveLength(3);
    // One durable strategy charge per strategy run, each exactly once:
    // bootstrap run (campaign create) + three dispatched next-cycle runs —
    // the final dispatch proves the N+1 Strategy was generated and is billed
    // (Stream E §5 charge treatment enforced in next-cycle-dispatcher).
    expect(strategyCharges()).toHaveLength(4);
    // Only the final instruction remains on the campaign (A4-2 replacement).
    expect(nextCycleInstruction().instructionId).toBe(instructionIds[2]);
  });

  // ── Scenario injections ────────────────────────────────────────────────

  it("S1 — duplicate trigger at every major boundary collapses onto one authoritative effect", async () => {
    const { reviewId, strategyRunId } = await driveBootstrap(`${BOOTSTRAP_KEY}-s1`);

    // (a) Duplicate run-completion trigger for the same strategy run.
    const { onAgentRunComplete } = await import("../triggers");
    await onAgentRunComplete(strategyRunId);
    await onAgentRunComplete(strategyRunId);
    expect(
      h.approvalRequests.filter((r) => r.approvalType === "strategy_review" && r.status === "pending")
    ).toHaveLength(1);
    expect(strategyCharges()).toHaveLength(1);

    // (b) Duplicate approval resolution for the same review.
    await driveApprovalDecision(reviewId, "approved");
    expect(h.creativeCalls).toHaveLength(1);
    const beforeClaims = h.creativeGenerationClaims.length;
    const { approvalRouter } = await import("../../../approval-router");
    await expect(
      approvalRouter.createCaller(ctxFor(USER_A)).approveAction({ approvalId: reviewId })
    ).rejects.toThrow(/already approved/);
    await flushBg();
    expect(h.creativeCalls).toHaveLength(1);
    expect(h.creativeGenerationClaims.length).toBe(beforeClaims);

    // (c) Duplicate next-cycle continuation dispatch.
    await driveRenderCompletionAndSeal();
    await transition("generate_audience");
    await transition("audience_complete");
    await transition("generate_schedule");
    const ai = await runAudienceIntelligenceStep(reviewId);
    const dist = await runDistributionStep(ai.runId, `${WINDOWS[0].start}T12:00:00.000Z`);
    await onAgentRunComplete(dist.runId);
    await driveLaunchPhase();
    const leaflet = [...h.contentPosts]
      .filter((p) => p.metadata?.assetKind === "master_campaign_post")
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const lineage = campaign().workflowContext.strategyApprovalLineage;
    attachPackageToQueueRow(
      dist.queueIds[0],
      buildGovernedPackage({
        contentPostId: leaflet.id,
        strategy: { ...lineage, strategyRunId: lineage.strategyRunId },
        approvedCopy: approvedCopyFor("rev-s1"),
        launchApprovalId: launchApproval().id,
      })
    );
    vi.setSystemTime(new Date(PUBLISH_AT[0]));
    const exec = await executeQueueItem(dist.queueIds[0]);
    expect(exec.status).toBe("published");

    await runObservation(OBSERVE_DATES[0]);
    seedWonLead(WINDOWS[0].start);
    const cycle = await runLearning(WINDOWS[0]);
    if (cycle.status !== "recorded") throw new Error("expected a recorded learning cycle");
    const recommendation = cycle.record.recommendedAdjustments.find(
      (r) => r.governance.autoApply === false && r.governance.requiresApproval === true
    )!;
    queueLlmSuccess(); // the N+1 Strategy run inside the dispatch consumes this
    const proposed = await drivePromotion(cycle.record.id, recommendation.id);
    expect(proposed.outcome).toBe("created");
    const strategyRunsBefore = h.agentRuns.filter((r) => r.agentType === "strategy").length;
    const reviewsBefore = h.approvalRequests.filter((r) => r.approvalType === "strategy_review").length;

    // The trigger-level replay sees the already-dispatched instruction for
    // the SAME material and never re-dispatches it.
    const instructionId = nextCycleInstruction().instructionId;
    const { dispatchNextCycleInstruction } = await import("../next-cycle-dispatcher");
    const duplicate = await dispatchNextCycleInstruction({
      userId: USER_A,
      campaignId: CAMPAIGN_ID,
      instructionId,
    });
    expect(duplicate.outcome).toBe("already_dispatched");
    expect(h.agentRuns.filter((r) => r.agentType === "strategy").length).toBe(strategyRunsBefore);
    expect(h.approvalRequests.filter((r) => r.approvalType === "strategy_review").length).toBe(reviewsBefore);
    expect(nextCycleInstruction().status).toBe("dispatched");
  });

  it("S2 — process restart: boot continuation sweep re-dispatches a lost decision continuation exactly once", async () => {
    // (a) Decision committed but the post-commit continuation was lost.
    const { reviewId } = await driveBootstrap(`${BOOTSTRAP_KEY}-s2a`);
    const review = h.approvalRequests.find((r) => r.id === reviewId)!;
    review.status = "approved";
    review.approvedAt = new Date();
    expect(campaign().workflowState).toBe("strategy_generated");

    const { runApprovalContinuationSweep } = await import("../approval-continuation");
    const first = await runApprovalContinuationSweep({});
    expect(first.reconciled).toBe(1);
    await flushBg();
    expect(h.creativeCalls).toHaveLength(1);
    expect(campaign().workflowState).toBe("creatives_ready");

    const second = await runApprovalContinuationSweep({});
    expect(second.reconciled).toBe(0);
    await flushBg();
    expect(h.creativeCalls).toHaveLength(1);
    expect(h.creativeGenerationClaims).toHaveLength(1);
    expect(strategyCharges()).toHaveLength(1);

    // (b) Dangling strategy-run completion: completion persisted, review creation lost.
    resetWorld();
    installDb();
    await driveBootstrap(`${BOOTSTRAP_KEY}-s2b`);
    // Remove the review and roll the campaign back to strategy_pending with
    // no lineage — exactly the crash window A5-2 reconciles.
    h.approvalRequests = [];
    const camp = campaign();
    camp.workflowState = "strategy_pending";
    camp.workflowContext = {};
    const sweepB = await runApprovalContinuationSweep({});
    expect(sweepB.reconciled).toBeGreaterThanOrEqual(1);
    await flushBg();
    const reviews = h.approvalRequests.filter((r) => r.approvalType === "strategy_review");
    expect(reviews).toHaveLength(1);
    expect(campaign().workflowState).toBe("strategy_generated");
    expect(campaign().workflowContext.strategyApprovalLineage.status).toBe("pending");
    const sweepB2 = await runApprovalContinuationSweep({});
    expect(sweepB2.reconciled).toBe(0);
    expect(
      h.approvalRequests.filter((r) => r.approvalType === "strategy_review")
    ).toHaveLength(1);
  });

  it("S3 — delayed approval decision resumes correctly long after creation", async () => {
    const { reviewId } = await driveBootstrap(`${BOOTSTRAP_KEY}-s3`);
    const delayed = new Date(T0.getTime() + 48 * 60 * 60 * 1000);
    vi.setSystemTime(delayed);
    await driveApprovalDecision(reviewId, "approved");
    expect(h.creativeCalls).toHaveLength(1);
    expect(campaign().workflowState).toBe("creatives_ready");
    const resolved = h.auditEvents.find(
      (a) => a.eventType === "approval_resolved" && a.approvalRequestId === reviewId
    );
    expect(resolved).toBeTruthy();
    expect(new Date(resolved.occurredAt).getTime()).toBeGreaterThanOrEqual(delayed.getTime());
  });

  it("S4 — rejected strategy_review: no creative dispatch, campaign does not advance, auditable", async () => {
    const { reviewId } = await driveBootstrap(`${BOOTSTRAP_KEY}-s4`);
    await driveApprovalDecision(reviewId, "rejected");
    expect(h.creativeCalls).toHaveLength(0);
    expect(h.creativeGenerationClaims).toHaveLength(0);
    expect(campaign().workflowState).toBe("strategy_pending");
    expect(
      h.creditTransactions.filter((c) => String(c.idempotencyKey ?? "").startsWith("creative-success:"))
    ).toHaveLength(0);
    const resolved = h.auditEvents.find(
      (a) => a.eventType === "approval_resolved" && a.approvalRequestId === reviewId
    );
    expect(resolved?.metadata?.decision).toBe("rejected");
  });

  it("S5 — budget pause at a forward dispatch → governed resume restores pre-pause state, one continuation, no double charge", async () => {
    const { reviewId } = await driveBootstrap(`${BOOTSTRAP_KEY}-s5`);
    await driveCreativePhase(reviewId);
    await transition("generate_audience");
    const audienceRun = [...h.agentRuns]
      .filter((r) => r.agentType === "audience" && r.status === "completed")
      .sort((a, b) => b.id - a.id)[0];
    const deductionsBefore = h.creditTransactions.filter((c) => c.amount < 0).length;

    // Force insufficient credits at the forward dispatch boundary.
    h.creditWallets[0].balance = 0;
    const { onAgentRunComplete } = await import("../triggers");
    await onAgentRunComplete(audienceRun.id);
    expect(campaign().status).toBe("paused");
    expect(campaign().workflowState).toBe("launch_approval_required");
    const costPause = campaign().workflowContext.costPause;
    expect(costPause).toMatchObject({
      kind: "agent_run_complete",
      continuationId: audienceRun.id,
      workflowState: "audience_generating",
    });
    expect(costPause.budgetIncreaseApprovalId).toBeGreaterThan(0);
    const budgetApproval = h.approvalRequests.find(
      (r) => r.approvalType === "budget_increase" && r.status === "pending"
    );
    expect(budgetApproval).toBeTruthy();

    // Operator tops up credits and approves the exact bound budget increase.
    h.creditWallets[0].balance = 100;
    h.runAgentQueue.push(() => ({
      output: {
        schedule: [
          {
            contentPostId: [...h.contentPosts].filter((p) => p.metadata?.assetKind === "master_campaign_post").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0].id,
            platform: "facebook",
            scheduledAt: `${WINDOWS[0].start}T12:00:00.000Z`,
          },
        ],
      },
    }));
    await driveApprovalDecision(budgetApproval!.id, "approved");
    expect(campaign().status).toBe("active");
    expect(campaign().workflowContext.costPause).toBeUndefined();
    // The single dispatched continuation ran the paused audience step to
    // completion and advanced through distribution to the launch ask.
    expect(campaign().workflowState).toBe("launch_approval_required");
    expect(h.approvalRequests.some((r) => r.approvalType === "campaign_launch" && r.status === "pending")).toBe(true);
    // Exactly one continuation dispatched: the distribution plan materialised once.
    expect(h.publishingQueue.filter((r) => r.userId === USER_A && r.campaignId === CAMPAIGN_ID)).toHaveLength(1);
    // No double charge anywhere: the same ledger rows exist as before the pause.
    expect(h.creditTransactions.filter((c) => c.amount < 0).length).toBe(deductionsBefore);

    // The boot sweep finds nothing further to reconcile.
    const { runApprovalContinuationSweep } = await import("../approval-continuation");
    const sweep = await runApprovalContinuationSweep({});
    expect(sweep.reconciled).toBe(0);
  });

  it("S6 — insufficient wallet: agent-run reservation fails closed before any provider/LLM call", async () => {
    // USER_B's wallet is empty (seeded at 0).
    await expect(
      reserveWalletCredits({
        userId: USER_B,
        amount: 5,
        reservationReference: "harness:agent-run:1",
        reason: "agent_run",
      })
    ).rejects.toThrow(/Insufficient available credit capacity/);
    expect(h.creditReservations).toHaveLength(0);
    expect(h.creditTransactions).toHaveLength(0);
    expect(h.runAgentCalls).toHaveLength(0);
    expect(h.providerCalls).toHaveLength(0);

    // Overcommit against an existing hold fails closed too; the hold survives.
    const first = await reserveWalletCredits({
      userId: USER_A,
      amount: 5,
      reservationReference: "harness:agent-run:a",
      reason: "agent_run",
    });
    expect(first.duplicateClassification).toBe("none");
    await expect(
      reserveWalletCredits({
        userId: USER_A,
        amount: 999_995,
        reservationReference: "harness:agent-run:b",
        reason: "agent_run",
      })
    ).rejects.toThrow(/Insufficient available credit capacity/);
    expect(h.creditReservations).toHaveLength(1);
    const available = await (
      await import("../../billing/credit-reservation-engine")
    ).getAvailableCreditBalance(USER_A);
    expect(available.reservedAmount).toBe(5);
    expect(available.availableBalance).toBe(100000 - 5);
  });

  it("S7 — transient creative failure: claim released failed, no charge, lifecycle does not advance; one package after recovery", async () => {
    const { reviewId } = await driveBootstrap(`${BOOTSTRAP_KEY}-s7`);
    h.creativeShouldFail = true;
    await driveApprovalDecision(reviewId, "approved");
    expect(h.creativeCalls).toHaveLength(1);
    expect(h.creativeGenerationClaims.map((c) => c.status)).toEqual(["failed"]);
    expect(campaign().workflowState).toBe("creatives_generating");
    expect(
      h.creditTransactions.filter((c) => String(c.idempotencyKey ?? "").startsWith("creative-success:"))
    ).toHaveLength(0);

    // Recovery under the same approved authority: a fresh governed operation
    // claim + creative run (the entry path the creative router uses) — exactly
    // one successful generation and one success charge.
    h.creativeShouldFail = false;
    const {
      acquireCreativeGenerationClaim,
      releaseClaimWithResult,
      generateOwnerToken,
    } = await import("../../creative/creative-generation-claim");
    const { resolveCreativeEntryStrategyAuthority } = await import(
      "../../creative/creative-entry-authority"
    );
    const { runCreativeAgent } = await import("../../agents/creative-agent");
    const { onAgentRunComplete } = await import("../triggers");
    const ownerToken = generateOwnerToken();
    const claim = await acquireCreativeGenerationClaim({
      userId: USER_A,
      campaignId: CAMPAIGN_ID,
      operationSource: "agent",
      ownerToken,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(claim.acquired).toBe(true);
    if (!claim.acquired) return;
    const creative = await runCreativeAgent({
      userId: USER_A,
      campaignId: CAMPAIGN_ID,
      generationOperation: { source: "agent", id: reviewId },
      strategyInput: await resolveCreativeEntryStrategyAuthority({
        campaign: campaign(),
        userId: USER_A,
        campaignId: CAMPAIGN_ID,
      }),
    });
    await releaseClaimWithResult({
      claimId: claim.claim.id,
      ownerToken,
      status: "completed",
      context: "harness",
    });
    await onAgentRunComplete(creative.packRunId);
    expect(h.creativeCalls).toHaveLength(2);
    expect(campaign().workflowState).toBe("creatives_ready");
    expect(
      h.creditTransactions.filter((c) => String(c.idempotencyKey ?? "").startsWith("creative-success:"))
    ).toHaveLength(1);
    const seal = await driveRenderCompletionAndSeal();
    expect(seal.outcome).not.toBe("incomplete");
  });

  it("S8 — queue unavailable: BullMQ down, future row is not executed by the due scan and is not charged", async () => {
    h.bullmqAvailable = false;
    const { reviewId } = await driveBootstrap(`${BOOTSTRAP_KEY}-s8`);
    await driveCreativePhase(reviewId);
    seedAudienceSignal("fb:s8");
    const ai = await runAudienceIntelligenceStep(reviewId);
    await transition("generate_audience");
    await transition("audience_complete");
    await transition("generate_schedule");
    const dist = await runDistributionStep(ai.runId, `${WINDOWS[0].start}T12:00:00.000Z`);
    const { onAgentRunComplete } = await import("../triggers");
    await onAgentRunComplete(dist.runId);
    const launch = launchApproval();
    await driveApprovalDecision(launch.id, "approved");
    // No BullMQ job was ever scheduled; the durable row is not yet due.
    expect(h.scheduledJobs).toHaveLength(0);
    const row = h.publishingQueue.find((r) => r.id === dist.queueIds[0]);
    expect(row.status).toBe("approved");
    expect(new Date(row.scheduledAt).getTime()).toBeGreaterThan(Date.now());

    const { publishDuePosts } = await import("../publishing-runner");
    const results = await publishDuePosts();
    expect(results).toHaveLength(0);
    expect(h.providerCalls).toHaveLength(0);
    expect(publishingCharges()).toHaveLength(0);
    expect(publicationReceipts()).toHaveLength(0);
    expect(h.publishingQueue.find((r) => r.id === row.id).status).toBe("approved");
  });

  it("S9 — Redis lease interruption: second observation pass while the first holds the lease → lease_contended, no double observation", async () => {
    const bootstrap = await driveBootstrap(`${BOOTSTRAP_KEY}-s9`);
    const live = await driveToLive(1, bootstrap, { execute: false });
    vi.setSystemTime(new Date(PUBLISH_AT[0]));
    const exec = await executeQueueItem(live.queueRowId);
    expect(exec.status).toBe("published");

    const {
      runLeaseProtectedPostLiveMetricsObservationPass,
      createInProcessMetricsObservationLeaseStore,
    } = await import("../post-live-metrics-observation-leased-pass");
    const { createDefaultPostLiveMetricsObservationPassDeps } = await import(
      "../post-live-metrics-observation-pass"
    );
    const leaseStore = createInProcessMetricsObservationLeaseStore();
    const samples = [
      { metricType: "impressions", value: 100 },
      { metricType: "clicks", value: 5 },
      { metricType: "conversions", value: 1 },
    ];
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const makeDeps = (gateFetch: boolean) => ({
      leaseStore,
      passDeps: {
        ...createDefaultPostLiveMetricsObservationPassDeps(),
        resolveBinding: () => ({
          platform: "facebook" as const,
          fetchPostMetrics: async () => {
            if (gateFetch) await fetchGate; // first pass holds the lease in flight
            return samples;
          },
        }),
      },
      createOwnerToken: () => "owner-1",
      startInterval: vi.fn(() => 0 as unknown as ReturnType<typeof setInterval>),
      stopInterval: vi.fn(),
    });

    // Pass 1 acquires the lease and blocks inside the provider fetch while
    // still holding it; pass 2 must observe lease_contended and observe nothing.
    const firstPromise = runLeaseProtectedPostLiveMetricsObservationPass({
      asOfDate: OBSERVE_DATES[0],
      deps: makeDeps(true),
    });
    const second = await runLeaseProtectedPostLiveMetricsObservationPass({
      asOfDate: OBSERVE_DATES[0],
      deps: makeDeps(false),
    });
    expect(second.status).toBe("lease_contended");
    expect(second.ran).toBe(false);
    expect(h.analytics.filter((a) => a.observationId != null)).toHaveLength(0);

    releaseFetch();
    const first = await firstPromise;
    if (first.status === "lease_contended") throw new Error("first pass must own the lease");
    expect(first.status).toBe("completed");
    expect(first.ran).toBe(true);
    expect(first.releaseSucceeded).toBe(true);
    const rowsAfterFirst = h.analytics.filter((a) => a.observationId != null);
    expect(rowsAfterFirst).toHaveLength(3); // one observation set for the one live post

    // Once released, a later pass observes normally (and same-day re-run is
    // not_due — no double observation).
    const third = await runLeaseProtectedPostLiveMetricsObservationPass({
      asOfDate: OBSERVE_DATES[0],
      deps: makeDeps(false),
    });
    if (third.status === "lease_contended") throw new Error("third pass must own the lease");
    expect(third.report.results.every((r) => r.status === "not_due")).toBe(true);
    expect(h.analytics.filter((a) => a.observationId != null)).toHaveLength(3);
  });

  it("S10 — provider transient failure: row retryable, no receipt minted, exactly one charge under attempt-reservation semantics", async () => {
    const bootstrap = await driveBootstrap(`${BOOTSTRAP_KEY}-s10`);
    const live = await driveToLive(1, bootstrap, { execute: false });
    h.facebookBehavior.push({ error: new Error("network timeout") });

    const failed = await executeQueueItem(live.queueRowId);
    expect(failed.status).toBe("retrying");
    const row = h.publishingQueue.find((r) => r.id === live.queueRowId);
    expect(row.status).toBe("retrying");
    expect(publicationReceipts()).toHaveLength(0);
    expect(publishingCharges()).toHaveLength(1); // the single attempt reservation

    const recovered = await executeQueueItem(live.queueRowId);
    expect(recovered.status).toBe("published");
    expect(publicationReceipts()).toHaveLength(1);
    expect(publishingCharges()).toHaveLength(1); // retrying skips the re-charge
    expect(h.providerCalls).toHaveLength(2);
    expect(h.creditWallets[0].balance).toBe(100000 - 3 - 1);
  });

  it("S11 — provider ambiguous result: row parks retryable under the same operationId; exactly one charge and one receipt eventually", async () => {
    const bootstrap = await driveBootstrap(`${BOOTSTRAP_KEY}-s11`);
    const live = await driveToLive(1, bootstrap, { execute: false });
    h.facebookBehavior.push({ error: new Error("upstream timeout after 30s") });

    const ambiguous = await executeQueueItem(live.queueRowId);
    expect(ambiguous.status).not.toBe("published");
    expect(publicationReceipts()).toHaveLength(0);
    const row = h.publishingQueue.find((r) => r.id === live.queueRowId);
    expect(["retrying", "failed"]).toContain(row.status);
    // No fabricated success and no borrowed receipt: the durable operation
    // identity stays publication:facebook:{queueItemId}.
    expect(publishingCharges().map((c) => c.idempotencyKey)).toEqual([`publishing:${live.queueRowId}`]);

    const settled = await executeQueueItem(live.queueRowId);
    expect(settled.status).toBe("published");
    expect(publicationReceipts()).toHaveLength(1);
    expect(publishingCharges()).toHaveLength(1);
    expect(publicationReceipts()[0].metadata.publicationReceipt.operationId).toBe(
      `publication:facebook:${live.queueRowId}`
    );
  });

  it("S12 — duplicate billing settle under the same key settles exactly once", async () => {
    const { buildSettleDeductionIdempotencyKey } = await import(
      "../../billing/credit-reservation-engine"
    );
    const reserved = await reserveWalletCredits({
      userId: USER_A,
      amount: 4,
      reservationReference: "harness:settle:1",
      reason: "agent_run",
    });
    const reservationId = reserved.reservation.reservationId;
    const first = await settleWalletCredits({
      reservationId,
      settleKey: "settle-A",
      settledAmount: 4,
    });
    expect(first.duplicateClassification).toBe("none");
    expect(first.alreadyDeducted).not.toBe(true);

    const second = await settleWalletCredits({
      reservationId,
      settleKey: "settle-A",
      settledAmount: 4,
    });
    expect(second.duplicateClassification).toBe("idempotent_replay");
    expect(second.alreadyDeducted).toBe(true);

    const settleKey = buildSettleDeductionIdempotencyKey(reservationId, "settle-A");
    const deductions = h.creditTransactions.filter(
      (c) => c.idempotencyKey === settleKey && c.amount < 0
    );
    expect(deductions).toHaveLength(1);
    expect(h.creditWallets[0].balance).toBe(100000 - 4);
  });

  it("S13 — duplicate reservation under the same key holds exactly once", async () => {
    const input = {
      userId: USER_A,
      amount: 5,
      reservationReference: "harness:reserve:dup",
      reason: "agent_run",
    };
    const first = await reserveWalletCredits(input);
    expect(first.duplicateClassification).toBe("none");
    expect(first.reservedAmount).toBe(5);
    const second = await reserveWalletCredits(input);
    expect(second.duplicateClassification).toBe("idempotent_replay");
    expect(second.reservation.reservationId).toBe(first.reservation.reservationId);
    expect(h.creditReservations).toHaveLength(1);
    expect(h.creditReservations[0].state).toBe("reserved");
    expect(second.reservedAmount).toBe(5); // the replay never double-counts its hold
  });

  it("S14 — stale authority: stale strategy snapshot hash refuses creative generation; tampered publish package refuses publication", async () => {
    // (a) Stale immutable Strategy snapshot hash.
    const { reviewId } = await driveBootstrap(`${BOOTSTRAP_KEY}-s14a`);
    h.strategySnapshots[0].strategyHashSha256 = HASH_A; // drift the authority
    const { assertApprovedStrategySemanticallyValid } = await import("../strategy-approval");
    await expect(
      assertApprovedStrategySemanticallyValid(campaign(), USER_A, h.businesses[0])
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // The governed decision path itself refuses to approve against drifted
    // immutable authority — before any creative claim can be consumed.
    let rejection: any = null;
    try {
      await driveApprovalDecision(reviewId, "approved");
    } catch (err) {
      rejection = err;
    }
    expect(rejection?.message).toMatch(/immutable Strategy snapshot/);
    expect(h.creativeCalls).toHaveLength(0);
    expect(h.creativeGenerationClaims).toHaveLength(0);
    expect(
      h.creditTransactions.filter((c) => String(c.idempotencyKey ?? "").startsWith("creative-success:"))
    ).toHaveLength(0);

    // (b) Tampered publish package at the execution boundary.
    resetWorld();
    installDb();
    const bootstrap = await driveBootstrap(`${BOOTSTRAP_KEY}-s14b`);
    const live = await driveToLive(1, bootstrap, { execute: false });
    const lineage = campaign().workflowContext.strategyApprovalLineage;
    const pkg = buildGovernedPackage({
      contentPostId: live.leafletId,
      strategy: { ...lineage },
      approvedCopy: approvedCopyFor("rev-s14"),
      launchApprovalId: live.launchApprovalId,
    });
    const tampered = JSON.parse(JSON.stringify(pkg)) as PublishPackage;
    (tampered.payload as { text: string }).text = "INJECTED BY ATTACKER";
    expect(() => assertQueuePublishPackageIntegrity(tampered)).toThrow();
    const attemptsBefore = h.providerCalls.length;
    const attempt = await executeQueueItem(live.queueRowId, tampered);
    expect(attempt.status).not.toBe("published");
    expect(h.providerCalls).toHaveLength(attemptsBefore);
    expect(publicationReceipts()).toHaveLength(0);
  });

  it("S15 — cross-business attack: user B is rejected or inert on every user-scoped surface", async () => {
    const { reviewId } = await driveBootstrap(`${BOOTSTRAP_KEY}-s15`);

    const { runAudienceIntelligenceAgent } = await import("../../agents/audience-intelligence-agent");
    await expect(
      runAudienceIntelligenceAgent({ userId: USER_B, campaignId: CAMPAIGN_ID })
    ).rejects.toThrow("Campaign not found");
    const { runDistributionAgent } = await import("../../agents/distribution-agent");
    await expect(
      runDistributionAgent({ userId: USER_B, campaignId: CAMPAIGN_ID, approvalMode: "autonomous" })
    ).rejects.toThrow("Campaign not found");

    const { approvalRouter } = await import("../../../approval-router");
    await expect(
      approvalRouter.createCaller(ctxFor(USER_B)).approveAction({ approvalId: reviewId })
    ).rejects.toThrow();
    const { onApprovalResolved } = await import("../triggers");
    await expect(onApprovalResolved(reviewId, "approved", USER_B)).rejects.toThrow(
      "Approval request not found"
    );

    const { campaignRouter } = await import("../../../campaign-router");
    const bCaller = campaignRouter.createCaller(ctxFor(USER_B));
    expect(await bCaller.get({ id: CAMPAIGN_ID })).toBeNull();
    expect(await bCaller.list()).toHaveLength(0);

    // X6 close-out: a business id owned by another user must not be linkable
    // to a new campaign (previously stored cross-tenant and read by the
    // auto-start path).
    h.businesses.push({
      id: 4242,
      userId: USER_B,
      name: "Victim Biz",
      industry: "retail",
      location: "Nowhere",
      productOrService: "Other",
      targetCustomer: "N/A",
      targetAudience: null,
      brandTone: "calm",
      preferredPlatforms: "instagram",
      mainGoal: "N/A",
      monthlyBudget: 0,
      website: null,
      websiteEvidence: null,
      isActive: true,
      onboardingComplete: true,
    });
    const campaignsBefore = h.campaigns.length;
    await expect(
      campaignRouter
        .createCaller(ctxFor(USER_A))
        .create({ ...CAMPAIGN_BRIEF, name: "Cross-tenant attempt", businessId: 4242 })
    ).rejects.toThrow(/PRECONDITION_FAILED|Business profile not found/i);
    expect(h.campaigns).toHaveLength(campaignsBefore);
    expect(
      h.campaigns.some((c: any) => c.businessId === 4242 && c.userId === USER_A)
    ).toBe(false);

    const { runGovernedLearningCycle } = await import("../../learning/learning-cycle-service");
    await expect(
      runGovernedLearningCycle({ userId: USER_B, campaignId: CAMPAIGN_ID })
    ).rejects.toThrow("Campaign not found");

    const { resumeWorkflowAfterApprovedCostIncrease } = await import("../budget-resume");
    expect(
      await resumeWorkflowAfterApprovedCostIncrease({ userId: USER_B, campaignId: CAMPAIGN_ID })
    ).toBeNull();

    // User A's world is untouched by every attempt above.
    expect(h.approvalRequests.find((r) => r.id === reviewId)?.status).toBe("pending");
    expect(campaign().workflowState).toBe("strategy_generated");
    expect(h.providerCalls).toHaveLength(0);
    expect(h.agentRuns.filter((r) => r.agentType === "strategy")).toHaveLength(1);
  });

  it("S16 — replay after successful publication: replay_success, zero provider calls, zero charges", async () => {
    const bootstrap = await driveBootstrap(`${BOOTSTRAP_KEY}-s16`);
    const live = await driveToLive(1, bootstrap);
    const first = await executeQueueItem(live.queueRowId);
    expect(first.status).toBe("published");
    const snapshot = {
      providerCalls: h.providerCalls.length,
      charges: publishingCharges().length,
      receipts: publicationReceipts().length,
    };
    expect(snapshot).toEqual({ providerCalls: 1, charges: 1, receipts: 1 });

    const replay = await executeQueueItem(live.queueRowId);
    expect(replay.status).toBe("published");
    expect(h.providerCalls).toHaveLength(snapshot.providerCalls);
    expect(publishingCharges()).toHaveLength(snapshot.charges);
    expect(publicationReceipts()).toHaveLength(snapshot.receipts);
    expect(h.publishingQueue.find((r) => r.id === live.queueRowId).externalPostId).toBe("fb_harness_1");
  });

  it("S17 — stale/recoverable operation auto-heal: stale reservation reaped; due row with a lost BullMQ job discovered by the due scan", async () => {
    // (a) Stale reservation reaped through the governed release authority.
    h.creditReservations.push({
      id: 7001,
      reservationId: "res-stale-1",
      idempotencyKey: "k-stale-1",
      reservationReference: "ref-stale-1",
      userId: USER_A,
      campaignId: null,
      workflowOperationId: null,
      workflowAttemptId: null,
      stageId: null,
      artifactId: null,
      packageId: null,
      agentType: null,
      model: null,
      provider: null,
      reservedAmount: 7,
      settledAmount: null,
      state: "reserved",
      reason: "agent_run",
      settleKey: null,
      releaseKey: null,
      releaseReason: null,
      reservedAt: new Date(T0.getTime() - 25 * 60 * 60 * 1000),
      settledAt: null,
      releasedAt: null,
      createdAt: new Date(T0.getTime() - 25 * 60 * 60 * 1000),
      updatedAt: new Date(T0.getTime() - 25 * 60 * 60 * 1000),
    });
    const reap = await reapStaleCreditReservations({ now: new Date(T0) });
    expect(reap.released).toBe(1);
    expect(h.creditReservations[0].state).toBe("released");
    expect(h.creditReservations[0].releaseKey).toBe("stale-reap:res-stale-1");
    expect(h.creditWallets[0].balance).toBe(100000); // release never touches the wallet
    const reapAgain = await reapStaleCreditReservations({ now: new Date(T0) });
    expect(reapAgain.released).toBe(0);

    // (b) Due row whose BullMQ job was lost (BullMQ down at launch) is
    // discovered and executed by the DB-authority due scan.
    resetWorld();
    installDb();
    h.bullmqAvailable = false;
    const bootstrap = await driveBootstrap(`${BOOTSTRAP_KEY}-s17b`);
    const live = await driveToLive(1, bootstrap, { execute: false });
    expect(h.scheduledJobs).toHaveLength(0);
    expect(h.publishingQueue.find((r) => r.id === live.queueRowId).status).toBe("approved");

    const { publishDuePosts } = await import("../publishing-runner");
    const results = await publishDuePosts();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("published");
    expect(publicationReceipts()).toHaveLength(1);
    expect(publishingCharges()).toHaveLength(1);
    expect(h.scheduledJobs).toHaveLength(0); // BullMQ stayed out of the loop
  });

  it("S18 — operator inspection: lifecycle projection reports the budget-paused campaign and recovers to clear after resume", async () => {
    const { reviewId } = await driveBootstrap(`${BOOTSTRAP_KEY}-s18`);
    await driveCreativePhase(reviewId);
    await transition("generate_audience");
    const audienceRun = [...h.agentRuns]
      .filter((r) => r.agentType === "audience" && r.status === "completed")
      .sort((a, b) => b.id - a.id)[0];
    h.creditWallets[0].balance = 0;
    const { onAgentRunComplete } = await import("../triggers");
    await onAgentRunComplete(audienceRun.id);
    expect(campaign().status).toBe("paused");

    const { projectCampaignLifecycle } = await import("../../governance/lifecycle-projection");
    const blocked = await projectCampaignLifecycle({ campaignId: CAMPAIGN_ID, now: new Date() });
    expect(blocked.status).toBe("blocked");
    expect(blocked.blocker.classification).toBe("blocked");
    expect(blocked.blocker.reason).toMatch(/^cost_pause:/);
    expect(blocked.blocker.recoverability).toBe("blocked_awaiting_user");
    expect(blocked.blocker.safeNextAction).toBe("await_budget_approval");
    expect(blocked.budget.costPaused).toBe(true);
    expect(blocked.campaign?.status).toBe("paused");

    // Governed resume (operator tops up + user approves the bound increase).
    h.creditWallets[0].balance = 100;
    h.runAgentQueue.push(() => ({
      output: {
        schedule: [
          {
            contentPostId: [...h.contentPosts].filter((p) => p.metadata?.assetKind === "master_campaign_post").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0].id,
            platform: "facebook",
            scheduledAt: `${WINDOWS[0].start}T12:00:00.000Z`,
          },
        ],
      },
    }));
    const budgetApproval = h.approvalRequests.find(
      (r) => r.approvalType === "budget_increase" && r.status === "pending"
    )!;
    await driveApprovalDecision(budgetApproval.id, "approved");
    expect(campaign().status).toBe("active");
    // The budget blocker is gone; the only remaining ask is the launch
    // approval the resumed continuation legitimately created.
    const interim = await projectCampaignLifecycle({ campaignId: CAMPAIGN_ID, now: new Date() });
    expect(interim.budget.costPaused).toBe(false);
    expect(interim.blocker.reason).not.toMatch(/^cost_pause:/);

    const launchAsk = h.approvalRequests.find(
      (r) => r.approvalType === "campaign_launch" && r.status === "pending"
    )!;
    await driveApprovalDecision(launchAsk.id, "approved");
    const cleared = await projectCampaignLifecycle({ campaignId: CAMPAIGN_ID, now: new Date() });
    expect(cleared.status).toBe("ok");
    expect(cleared.blocker.classification).toBe("none");
    expect(cleared.budget.costPaused).toBe(false);
  });

  it("S19 — governed operator recovery: admin.resumeBudgetPausedCampaign resumes idempotently (already_resumed on the racing second call)", async () => {
    const { reviewId } = await driveBootstrap(`${BOOTSTRAP_KEY}-s19`);
    await driveCreativePhase(reviewId);
    await transition("generate_audience");
    const audienceRun = [...h.agentRuns]
      .filter((r) => r.agentType === "audience" && r.status === "completed")
      .sort((a, b) => b.id - a.id)[0];
    const distributionBehavior = () => ({
      output: {
        schedule: [
          {
            contentPostId: [...h.contentPosts].filter((p) => p.metadata?.assetKind === "master_campaign_post").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0].id,
            platform: "facebook",
            scheduledAt: `${WINDOWS[0].start}T12:00:00.000Z`,
          },
        ],
      },
    });

    h.creditWallets[0].balance = 0;
    const { onAgentRunComplete } = await import("../triggers");
    await onAgentRunComplete(audienceRun.id);
    expect(campaign().status).toBe("paused");

    const { adminRouter } = await import("../../../admin-router");
    const adminCaller = adminRouter.createCaller(ctxFor(ADMIN_ID, "admin"));
    h.creditWallets[0].balance = 100;
    h.runAgentQueue.push(distributionBehavior);
    const first = await adminCaller.resumeBudgetPausedCampaign({ campaignId: CAMPAIGN_ID });
    expect(first.outcome).toBe("resumed");
    expect(campaign().status).toBe("active");
    expect(campaign().workflowContext.costPause).toBeUndefined();
    expect(h.publishingQueue.filter((r) => r.userId === USER_A && r.campaignId === CAMPAIGN_ID)).toHaveLength(1);
    const adminAudits = () =>
      h.auditEvents.filter((a) => (a.metadata as any)?.action === "admin.campaign_budget_resume");
    expect(adminAudits()).toHaveLength(1);

    // Second sequential admin call is inert (nothing left to resume).
    const inert = await adminCaller.resumeBudgetPausedCampaign({ campaignId: CAMPAIGN_ID });
    expect(inert.outcome).toBe("no_cost_pause");
    expect(adminAudits()).toHaveLength(1);

    // Deterministic race: two resumers read the SAME pause; exactly one wins
    // the claim, the other receives the durable already_resumed outcome.
    h.creditWallets[0].balance = 0;
    await onAgentRunComplete(audienceRun.id); // pause again at the same coordinates
    expect(campaign().status).toBe("paused");
    h.creditWallets[0].balance = 100;
    h.runAgentQueue.push(distributionBehavior);
    const { resumeWorkflowAfterApprovedCostIncrease } = await import("../budget-resume");
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const racing = resumeWorkflowAfterApprovedCostIncrease({
      userId: USER_A,
      campaignId: CAMPAIGN_ID,
      deps: { canRun: async () => ({ allowed: await gate.then(() => true) }) },
    });
    const winning = await adminCaller.resumeBudgetPausedCampaign({ campaignId: CAMPAIGN_ID });
    expect(winning.outcome).toBe("resumed");
    openGate();
    const racedOutcome = await racing;
    expect(racedOutcome?.outcome).toBe("already_resumed");
    // One continuation only: the distribution plan did not duplicate.
    expect(h.publishingQueue.filter((r) => r.userId === USER_A && r.campaignId === CAMPAIGN_ID)).toHaveLength(1);
  });
});
