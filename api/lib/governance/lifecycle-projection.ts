/**
 * Canonical Campaign Lifecycle Status Projection (WBS-R4-F3).
 *
 * One authoritative, deterministic, READ-ONLY operational read model that
 * answers, for a campaign: "where is this campaign in its lifecycle, and
 * why is it not progressing?"
 *
 * Design invariants:
 * - Derived exclusively from existing durable authorities (campaign row +
 *   workflowContext, strategy snapshots, approval requests, creative
 *   claims, agent runs, publishing queue, terminal/replay tables, learning
 *   records, credit reservations, audit events). It introduces NO second
 *   mutable lifecycle state machine.
 * - Read-only: never writes anything, never transitions anything.
 * - Honest: missing authority surfaces as "unavailable", conflicting
 *   authority as "inconsistent" — never guessed.
 * - The blocker derivation is a pure function over normalized evidence
 *   (same shape as the existing recovery classifiers): deterministic,
 *   explicit-clock, zero I/O.
 * - Cross-user visibility is the caller's decision: the projection lib is
 *   actor-agnostic. The operator surface (admin) may read any campaign; the
 *   user surface must scope by owner BEFORE calling (see
 *   autonomous-workflow-router). The lib itself never trusts client
 *   ownership because it never receives it.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  agentRuns,
  analytics,
  approvalRequests,
  auditEvents,
  campaignAssets,
  campaigns,
  creativeGenerationClaims,
  creditReservations,
  learningRecords,
  publishingQueue,
  queueReplayRequests,
  queueTerminalFailures,
  strategySnapshots,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  parseCostPauseProvenance,
  type CostPauseProvenance,
} from "../workflow/cost-pause";
import {
  NEXT_CYCLE_INSTRUCTION_STATUSES,
  parseNextCycleInstruction,
} from "../learning/learning-strategy-consumption";
import type { WorkflowState } from "../workflow/engine";

// ─── Public vocabulary ───

export const LIFECYCLE_PROJECTION_HEALTH = [
  "ok",
  "blocked",
  "inconsistent",
  "unavailable",
] as const;

export type LifecycleProjectionHealth = (typeof LIFECYCLE_PROJECTION_HEALTH)[number];

export const BLOCKER_RECOVERABILITIES = [
  "not_blocked",
  "recoverable_operator_action",
  "recoverable_user_approval",
  "recoverable_budget_resume",
  "blocked_awaiting_user",
  "inconsistent_authority",
  "unavailable",
] as const;

export type BlockerRecoverability = (typeof BLOCKER_RECOVERABILITIES)[number];

/** Actions the operator control plane can actually surface. */
export const SAFE_NEXT_ACTIONS = [
  "none",
  "inspect_pending_approval",
  "request_terminal_replay",
  "await_terminal_replay",
  "resume_budget_continuation",
  "await_budget_approval",
  "inspect_publishing_queue",
  "sweep_stale_creative_claims",
  "review_inconsistent_authority",
] as const;

export type SafeNextAction = (typeof SAFE_NEXT_ACTIONS)[number];

export interface LifecycleBlocker {
  readonly classification: "none" | "blocked" | "inconsistent" | "unavailable";
  readonly reason: string | null;
  readonly recoverability: BlockerRecoverability;
  readonly safeNextAction: SafeNextAction;
}

export const NO_BLOCKER: LifecycleBlocker = {
  classification: "none",
  reason: null,
  recoverability: "not_blocked",
  safeNextAction: "none",
};

// ─── Normalized evidence (pure-function input) ───

export const STRATEGY_LINEAGE_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "stale",
] as const;

export interface LifecycleEvidence {
  readonly campaignFound: boolean;
  readonly contextParseable: boolean;
  readonly workflowState: string | null;
  readonly campaignStatus: string | null;
  readonly costPause: {
    readonly present: boolean;
    readonly valid: boolean;
    readonly kind: string | null;
    readonly reason: string | null;
  };
  readonly nextCycle: {
    readonly present: boolean;
    readonly valid: boolean;
    readonly status: string | null;
  };
  readonly strategy: {
    readonly snapshotsFound: number;
    readonly approvalLineageStatus: string | null;
    readonly lineageParseable: boolean;
  };
  readonly approvals: {
    readonly pendingTypes: readonly string[];
    readonly approvedBudgetIncreasePresent: boolean;
  };
  readonly creative: {
    readonly runningClaims: number;
    readonly staleRunningClaims: number;
  };
  readonly distribution: {
    readonly queueCounts: Readonly<Record<string, number>>;
    readonly openTerminalFailures: number;
    readonly openReplayRequests: number;
  };
  readonly postLive: {
    readonly liveAt: string | null;
  };
  /** Names of evidence areas whose authority could not be read. */
  readonly areasUnavailable: readonly string[];
}

const POST_LIVE_STATES: ReadonlySet<string> = new Set([
  "campaign_live",
  "engagement_active",
  "leads_converting",
  "optimisation_active",
]);

/**
 * Pure, deterministic blocker derivation over normalized evidence.
 * Priority order is explicit and total: the first matching rule wins, so
 * the answer is stable for identical evidence.
 */
export function deriveLifecycleBlocker(evidence: LifecycleEvidence): LifecycleBlocker {
  if (!evidence.campaignFound) {
    return {
      classification: "unavailable",
      reason: "campaign_not_found",
      recoverability: "unavailable",
      safeNextAction: "none",
    };
  }

  if (evidence.areasUnavailable.length > 0) {
    return {
      classification: "unavailable",
      reason: `authority_unavailable:${evidence.areasUnavailable.join(",")}`,
      recoverability: "unavailable",
      safeNextAction: "none",
    };
  }

  if (!evidence.contextParseable) {
    return {
      classification: "inconsistent",
      reason: "workflow_context_malformed",
      recoverability: "inconsistent_authority",
      safeNextAction: "review_inconsistent_authority",
    };
  }

  // Malformed cost-pause provenance is conflicting authority: the durable
  // context claims a pause the strict parser rejects.
  if (evidence.costPause.present && !evidence.costPause.valid) {
    return {
      classification: "inconsistent",
      reason: "cost_pause_provenance_malformed",
      recoverability: "inconsistent_authority",
      safeNextAction: "review_inconsistent_authority",
    };
  }

  if (evidence.costPause.present) {
    if (evidence.approvals.approvedBudgetIncreasePresent) {
      return {
        classification: "blocked",
        reason: `cost_pause:${evidence.costPause.reason ?? evidence.costPause.kind ?? "recorded"}`,
        recoverability: "recoverable_budget_resume",
        safeNextAction: "resume_budget_continuation",
      };
    }
    return {
      classification: "blocked",
      reason: `cost_pause:${evidence.costPause.reason ?? evidence.costPause.kind ?? "recorded"}`,
      recoverability: "blocked_awaiting_user",
      safeNextAction: "await_budget_approval",
    };
  }

  // Strategy lineage must parse; an "approved" lineage without any durable
  // strategy snapshot is conflicting authority.
  if (!evidence.strategy.lineageParseable) {
    return {
      classification: "inconsistent",
      reason: "strategy_lineage_malformed",
      recoverability: "inconsistent_authority",
      safeNextAction: "review_inconsistent_authority",
    };
  }
  if (
    evidence.strategy.approvalLineageStatus === "approved" &&
    evidence.strategy.snapshotsFound === 0
  ) {
    return {
      classification: "inconsistent",
      reason: "approved_strategy_without_snapshot",
      recoverability: "inconsistent_authority",
      safeNextAction: "review_inconsistent_authority",
    };
  }

  // Post-live phases require the immutable live anchor.
  if (POST_LIVE_STATES.has(evidence.workflowState ?? "") && !evidence.postLive.liveAt) {
    return {
      classification: "inconsistent",
      reason: "post_live_anchor_missing",
      recoverability: "inconsistent_authority",
      safeNextAction: "review_inconsistent_authority",
    };
  }

  // Phase-gated pending approvals block forward progress.
  const pending = new Set(evidence.approvals.pendingTypes);
  if (
    (evidence.workflowState === "strategy_generated" ||
      evidence.workflowState === "strategy_pending") &&
    pending.has("strategy_review")
  ) {
    return {
      classification: "blocked",
      reason: "pending_strategy_review_approval",
      recoverability: "recoverable_user_approval",
      safeNextAction: "inspect_pending_approval",
    };
  }
  if (
    evidence.workflowState === "launch_approval_required" &&
    pending.has("campaign_launch")
  ) {
    return {
      classification: "blocked",
      reason: "pending_launch_approval",
      recoverability: "recoverable_user_approval",
      safeNextAction: "inspect_pending_approval",
    };
  }
  if (pending.has("budget_increase")) {
    return {
      classification: "blocked",
      reason: "pending_budget_increase_approval",
      recoverability: "recoverable_user_approval",
      safeNextAction: "await_budget_approval",
    };
  }

  // Terminal failures with governed replay available.
  if (evidence.distribution.openTerminalFailures > 0) {
    return {
      classification: "blocked",
      reason: "terminal_queue_failures_open",
      recoverability: "recoverable_operator_action",
      safeNextAction:
        evidence.distribution.openReplayRequests > 0
          ? "await_terminal_replay"
          : "request_terminal_replay",
    };
  }

  // Failed / retrying queue items block publication progress.
  const failedItems = evidence.distribution.queueCounts["failed"] ?? 0;
  if (failedItems > 0) {
    return {
      classification: "blocked",
      reason: "publishing_queue_failures",
      recoverability: "recoverable_operator_action",
      safeNextAction: "inspect_publishing_queue",
    };
  }

  // Stale creative claims block creative progress; the governed sweep is
  // the existing deliberate recovery path.
  if (evidence.workflowState === "creatives_generating" && evidence.creative.staleRunningClaims > 0) {
    return {
      classification: "blocked",
      reason: "stale_creative_generation_claims",
      recoverability: "recoverable_operator_action",
      safeNextAction: "sweep_stale_creative_claims",
    };
  }

  return NO_BLOCKER;
}

// ─── Projection read model ───

export interface CampaignLifecycleProjection {
  readonly generatedAt: string;
  readonly campaign: {
    readonly id: number;
    readonly userId: number;
    readonly businessId: number | null;
    readonly name: string;
    readonly status: string;
    readonly workflowState: WorkflowState;
    readonly approvalMode: string;
    readonly autoPublish: boolean;
  } | null;
  readonly lifecycle: {
    readonly phase: WorkflowState | null;
    readonly phaseKnown: boolean;
  };
  readonly strategy: {
    readonly snapshotsFound: number;
    readonly latestVersion: number | null;
    readonly latestSnapshotId: string | null;
    readonly latestCapturedAt: string | null;
    readonly approvalLineageStatus: string | null;
  };
  readonly approvals: {
    readonly pendingCount: number;
    readonly pendingTypes: readonly string[];
    readonly latestDecision: { type: string; status: string } | null;
  };
  readonly creative: {
    readonly runningClaims: number;
    readonly staleRunningClaims: number;
    readonly failedClaims: number;
    readonly assetsByStatus: Readonly<Record<string, number>>;
  };
  readonly audience: {
    readonly latestAgentRunStatus: string | null;
    readonly latestAgentRunAt: string | null;
  };
  readonly distribution: {
    readonly queueCounts: Readonly<Record<string, number>>;
    readonly openTerminalFailures: number;
    readonly openReplayRequests: number;
  };
  readonly publication: {
    readonly publishedCount: number;
    readonly publishedWithExternalId: number;
    readonly retryingCount: number;
  };
  readonly postLive: {
    readonly liveAt: string | null;
    readonly lastObservedAt: string | null;
  };
  readonly learning: {
    readonly latestRecordAt: string | null;
    readonly latestConfidence: string | null;
  };
  readonly promotion: {
    readonly openProposalCount: number;
  };
  readonly nextCycle: {
    readonly present: boolean;
    readonly status: string | null;
  };
  readonly budget: {
    readonly costPaused: boolean;
    readonly costPause: CostPauseProvenance | null;
    readonly openReservations: number;
    readonly reservedCredits: number;
  };
  readonly lastAutonomousActivity: string | null;
  readonly blocker: LifecycleBlocker;
  readonly status: LifecycleProjectionHealth;
  readonly notes: readonly string[];
}

export interface ProjectCampaignLifecycleInput {
  readonly campaignId: number;
  /** Read-only executor seam (defaults to the shared connection). */
  readonly executor?: LifecycleProjectionExecutor;
  /** Explicit clock for staleness decisions; deterministic for tests. */
  readonly now?: Date;
}

/** Structural seam: the shared getDb() client satisfies this shape. */
export interface LifecycleProjectionExecutor {
  select: ReturnType<typeof getDb>["select"];
}

function parseContextObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parseContextObject(parsed);
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function countBy<T extends Record<string, unknown>>(rows: T[], key: keyof T): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key] ?? "unknown");
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/**
 * Build the deterministic, read-only lifecycle projection for one campaign.
 * Never mutates; never invents missing authority.
 */
export async function projectCampaignLifecycle(
  input: ProjectCampaignLifecycleInput
): Promise<CampaignLifecycleProjection> {
  if (
    typeof input.campaignId !== "number" ||
    !Number.isInteger(input.campaignId) ||
    input.campaignId <= 0
  ) {
    throw new TypeError("campaignId must be a positive integer");
  }
  const db = input.executor ?? getDb();
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const notes: string[] = [];
  const areasUnavailable: string[] = [];

  async function readAreaTagged<T>(
    area: string,
    fn: () => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      return { ok: true, value: await fn() };
    } catch {
      areasUnavailable.push(area);
      return { ok: false };
    }
  }

  /** Non-primary areas: an unreadable authority reads as null while the
   *  failure is recorded in areasUnavailable. */
  async function readArea<T>(area: string, fn: () => Promise<T>): Promise<T | null> {
    const result = await readAreaTagged(area, fn);
    return result.ok ? result.value : null;
  }

  // ── Campaign authority ──
  const campaignResult = await readAreaTagged("campaigns", async () => {
    const [row] = await db
      .select({
        id: campaigns.id,
        userId: campaigns.userId,
        businessId: campaigns.businessId,
        name: campaigns.name,
        status: campaigns.status,
        workflowState: campaigns.workflowState,
        workflowContext: campaigns.workflowContext,
        approvalMode: campaigns.approvalMode,
        autoPublish: campaigns.autoPublish,
      })
      .from(campaigns)
      .where(eq(campaigns.id, input.campaignId))
      .limit(1);
    return row ?? null;
  });

  if (!campaignResult.ok) {
    // The primary authority itself could not be read: surface the failure
    // honestly instead of guessing or masquerading as "not found".
    return {
      generatedAt,
      campaign: null,
      lifecycle: { phase: null, phaseKnown: false },
      strategy: { snapshotsFound: 0, latestVersion: null, latestSnapshotId: null, latestCapturedAt: null, approvalLineageStatus: null },
      approvals: { pendingCount: 0, pendingTypes: [], latestDecision: null },
      creative: { runningClaims: 0, staleRunningClaims: 0, failedClaims: 0, assetsByStatus: {} },
      audience: { latestAgentRunStatus: null, latestAgentRunAt: null },
      distribution: { queueCounts: {}, openTerminalFailures: 0, openReplayRequests: 0 },
      publication: { publishedCount: 0, publishedWithExternalId: 0, retryingCount: 0 },
      postLive: { liveAt: null, lastObservedAt: null },
      learning: { latestRecordAt: null, latestConfidence: null },
      promotion: { openProposalCount: 0 },
      nextCycle: { present: false, status: null },
      budget: { costPaused: false, costPause: null, openReservations: 0, reservedCredits: 0 },
      lastAutonomousActivity: null,
      blocker: {
        classification: "unavailable",
        reason: "authority_unavailable:campaigns",
        recoverability: "unavailable",
        safeNextAction: "none",
      },
      status: "unavailable",
      notes,
    };
  }

  const campaignRow = campaignResult.value;

  if (!campaignRow) {
    return {
      generatedAt,
      campaign: null,
      lifecycle: { phase: null, phaseKnown: false },
      strategy: { snapshotsFound: 0, latestVersion: null, latestSnapshotId: null, latestCapturedAt: null, approvalLineageStatus: null },
      approvals: { pendingCount: 0, pendingTypes: [], latestDecision: null },
      creative: { runningClaims: 0, staleRunningClaims: 0, failedClaims: 0, assetsByStatus: {} },
      audience: { latestAgentRunStatus: null, latestAgentRunAt: null },
      distribution: { queueCounts: {}, openTerminalFailures: 0, openReplayRequests: 0 },
      publication: { publishedCount: 0, publishedWithExternalId: 0, retryingCount: 0 },
      postLive: { liveAt: null, lastObservedAt: null },
      learning: { latestRecordAt: null, latestConfidence: null },
      promotion: { openProposalCount: 0 },
      nextCycle: { present: false, status: null },
      budget: { costPaused: false, costPause: null, openReservations: 0, reservedCredits: 0 },
      lastAutonomousActivity: null,
      blocker: {
        classification: "unavailable",
        reason: "campaign_not_found",
        recoverability: "unavailable",
        safeNextAction: "none",
      },
      status: "unavailable",
      notes,
    };
  }

  const context = parseContextObject(campaignRow.workflowContext);
  if (context === null) {
    notes.push("workflowContext is not parseable JSON authority");
  }

  // ── Context-carried authorities (single JSON authority, read once) ──
  let costPause: CostPauseProvenance | null = null;
  let costPausePresent = false;
  let costPauseValid = true;
  let nextCyclePresent = false;
  let nextCycleStatus: string | null = null;
  let nextCycleValid = true;
  let strategyLineageStatus: string | null = null;
  let strategyLineageParseable = true;
  let liveAt: string | null = null;
  let lastTransitionAt: string | null = null;

  if (context !== null) {
    if ("costPause" in context) {
      costPausePresent = true;
      const parsed = parseCostPauseProvenance(context.costPause);
      if (parsed === null) {
        costPauseValid = false;
      } else {
        costPause = parsed;
      }
    }
    if ("nextCycle" in context) {
      nextCyclePresent = true;
      try {
        const instruction = parseNextCycleInstruction(context.nextCycle);
        nextCycleStatus = instruction.status;
      } catch {
        nextCycleValid = false;
        nextCycleStatus = null;
        notes.push("nextCycle instruction failed strict parsing");
      }
      if (!NEXT_CYCLE_INSTRUCTION_STATUSES.includes(nextCycleStatus as never)) {
        nextCycleValid = false;
      }
    }
    const lineage = context.strategyApprovalLineage;
    if (lineage !== null && lineage !== undefined) {
      if (typeof lineage === "object" && !Array.isArray(lineage)) {
        const rawStatus = (lineage as Record<string, unknown>).status;
        if (rawStatus === null || rawStatus === undefined) {
          strategyLineageStatus = null;
        } else if (
          typeof rawStatus === "string" &&
          (STRATEGY_LINEAGE_STATUSES as readonly string[]).includes(rawStatus)
        ) {
          strategyLineageStatus = rawStatus;
        } else {
          strategyLineageParseable = false;
        }
      } else {
        strategyLineageParseable = false;
      }
    }
    if (!strategyLineageParseable) notes.push("strategyApprovalLineage status is not canonical");
    liveAt = iso(context.campaignLiveAt);
    const lastTransition = context.lastTransition;
    if (typeof lastTransition === "object" && lastTransition !== null) {
      lastTransitionAt = iso((lastTransition as Record<string, unknown>).at);
    }
  }

  // ── Strategy snapshots ──
  const snapshotRows = await readArea("strategy_snapshots", () =>
    db
      .select({
        version: strategySnapshots.version,
        snapshotId: strategySnapshots.snapshotId,
        capturedAt: strategySnapshots.capturedAt,
      })
      .from(strategySnapshots)
      .where(eq(strategySnapshots.campaignId, input.campaignId))
      .orderBy(desc(strategySnapshots.version))
      .limit(5)
  );
  const snapshotsFound = snapshotRows?.length ?? 0;
  const latestSnapshot = snapshotRows?.[0] ?? null;

  // ── Approvals ──
  const approvalRows = await readArea("approval_requests", () =>
    db
      .select({
        approvalType: approvalRequests.approvalType,
        status: approvalRequests.status,
        createdAt: approvalRequests.createdAt,
      })
      .from(approvalRequests)
      .where(eq(approvalRequests.campaignId, input.campaignId))
      .orderBy(desc(approvalRequests.createdAt))
      .limit(50)
  );
  const pendingTypes = (approvalRows ?? [])
    .filter((r) => r.status === "pending")
    .map((r) => r.approvalType);
  const latestDecisionRow = (approvalRows ?? []).find(
    (r) => r.status === "approved" || r.status === "rejected" || r.status === "edited"
  );
  const approvedBudgetIncreasePresent = (approvalRows ?? []).some(
    (r) => r.approvalType === "budget_increase" && (r.status === "approved" || r.status === "edited")
  );

  // ── Creative claims + assets ──
  const claimRows = await readArea("creative_generation_claims", () =>
    db
      .select({
        status: creativeGenerationClaims.status,
        leaseExpiresAt: creativeGenerationClaims.leaseExpiresAt,
      })
      .from(creativeGenerationClaims)
      .where(eq(creativeGenerationClaims.campaignId, input.campaignId))
      .limit(200)
  );
  const claims = claimRows ?? [];
  const runningClaims = claims.filter((c) => c.status === "running");
  const staleRunningClaims = runningClaims.filter((c) => {
    if (c.leaseExpiresAt === null || c.leaseExpiresAt === undefined) return true; // legacy unleased
    const expiry = c.leaseExpiresAt instanceof Date ? c.leaseExpiresAt : new Date(String(c.leaseExpiresAt));
    return !Number.isNaN(expiry.getTime()) && expiry.getTime() < now.getTime();
  }).length;

  const assetRows = await readArea("campaign_assets", () =>
    db
      .select({ status: campaignAssets.status })
      .from(campaignAssets)
      .where(eq(campaignAssets.campaignId, input.campaignId))
      .limit(500)
  );

  // ── Audience agent run ──
  const audienceRun = await readArea("agent_runs", async () => {
    const [row] = await db
      .select({
        status: agentRuns.status,
        createdAt: agentRuns.createdAt,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.campaignId, input.campaignId), eq(agentRuns.agentType, "audience")))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    return row ?? null;
  });

  // ── Publishing queue / terminal / replay ──
  const queueRows = await readArea("publishing_queue", () =>
    db
      .select({
        status: publishingQueue.status,
        externalPostId: publishingQueue.externalPostId,
      })
      .from(publishingQueue)
      .where(eq(publishingQueue.campaignId, input.campaignId))
      .limit(500)
  );
  const queueCounts = countBy(queueRows ?? [], "status");
  const publishedWithExternalId = (queueRows ?? []).filter(
    (r) => r.status === "published" && r.externalPostId !== null && r.externalPostId !== undefined && String(r.externalPostId).trim().length > 0
  ).length;

  const failureRows = await readArea("queue_terminal_failures", () =>
    db
      .select({ id: queueTerminalFailures.id })
      .from(queueTerminalFailures)
      .where(
        and(eq(queueTerminalFailures.campaignId, input.campaignId), eq(queueTerminalFailures.status, "open"))
      )
      .limit(200)
  );
  const openTerminalFailureIds = (failureRows ?? []).map((r) => r.id);
  const openReplayRows = await readArea("queue_replay_requests", async () => {
    if (openTerminalFailureIds.length === 0) return [];
    return db
      .select({ status: queueReplayRequests.status })
      .from(queueReplayRequests)
      .where(
        and(
          inArray(queueReplayRequests.terminalFailureId, openTerminalFailureIds),
          inArray(queueReplayRequests.status, ["requested", "claimed", "enqueued"])
        )
      )
      .limit(200);
  });

  // ── Learning + promotion ──
  const learningRow = await readArea("learning_records", async () => {
    const [row] = await db
      .select({
        evaluatedAt: learningRecords.evaluatedAt,
        confidence: learningRecords.confidence,
      })
      .from(learningRecords)
      .where(eq(learningRecords.campaignId, input.campaignId))
      .orderBy(desc(learningRecords.evaluatedAt))
      .limit(1);
    return row ?? null;
  });

  const promotionRows = await readArea("approval_requests", () =>
    db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.campaignId, input.campaignId),
          eq(approvalRequests.approvalType, "high_value_proposal"),
          eq(approvalRequests.status, "pending")
        )
      )
      .limit(50)
  );

  // ── Post-live observation + budget ──
  const analyticsRows = await readArea("analytics", () =>
    db
      .select({ date: analytics.date })
      .from(analytics)
      .where(eq(analytics.campaignId, input.campaignId))
      .limit(1000)
  );
  const lastObservedAt = (analyticsRows ?? []).reduce<string | null>((max, row) => {
    const value = iso(row.date);
    if (value === null) return max;
    return max === null || value > max ? value : max;
  }, null);

  const reservationRows = await readArea("credit_reservations", () =>
    db
      .select({
        state: creditReservations.state,
        reservedAmount: creditReservations.reservedAmount,
      })
      .from(creditReservations)
      .where(
        and(eq(creditReservations.campaignId, input.campaignId), eq(creditReservations.state, "reserved"))
      )
      .limit(500)
  );
  const reservedCredits = (reservationRows ?? []).reduce(
    (sum, row) => sum + (Number(row.reservedAmount) || 0),
    0
  );

  // ── Last autonomous activity (transition vs agent run vs audit ledger) ──
  const latestAuditRow = await readArea("audit_events", async () => {
    const [row] = await db
      .select({ occurredAt: auditEvents.occurredAt })
      .from(auditEvents)
      .where(eq(auditEvents.campaignId, input.campaignId))
      .orderBy(desc(auditEvents.occurredAt))
      .limit(1);
    return row ?? null;
  });
  const lastAutonomousActivity = [
    lastTransitionAt,
    iso(audienceRun?.createdAt),
    latestAuditRow?.occurredAt ?? null,
    iso(learningRow?.evaluatedAt),
  ].reduce<string | null>((max, value) => {
    if (value === null) return max;
    return max === null || value > max ? value : max;
  }, null);

  // ── Derive ──
  const evidence: LifecycleEvidence = {
    campaignFound: true,
    contextParseable: context !== null,
    workflowState: campaignRow.workflowState,
    campaignStatus: campaignRow.status,
    costPause: {
      present: costPausePresent,
      valid: costPauseValid,
      kind: costPause?.kind ?? null,
      reason: costPause?.reason ?? null,
    },
    nextCycle: { present: nextCyclePresent, valid: nextCycleValid, status: nextCycleStatus },
    strategy: {
      snapshotsFound,
      approvalLineageStatus: strategyLineageStatus,
      lineageParseable: strategyLineageParseable,
    },
    approvals: {
      pendingTypes,
      approvedBudgetIncreasePresent,
    },
    creative: {
      runningClaims: runningClaims.length,
      staleRunningClaims,
    },
    distribution: {
      queueCounts,
      openTerminalFailures: openTerminalFailureIds.length,
      openReplayRequests: (openReplayRows ?? []).length,
    },
    postLive: { liveAt },
    areasUnavailable,
  };

  const blocker = deriveLifecycleBlocker(evidence);

  const status: LifecycleProjectionHealth =
    blocker.classification === "none"
      ? "ok"
      : blocker.classification === "blocked"
        ? "blocked"
        : blocker.classification;

  return {
    generatedAt,
    campaign: {
      id: campaignRow.id,
      userId: campaignRow.userId,
      businessId: campaignRow.businessId ?? null,
      name: campaignRow.name,
      status: campaignRow.status,
      workflowState: campaignRow.workflowState,
      approvalMode: campaignRow.approvalMode,
      autoPublish: campaignRow.autoPublish,
    },
    lifecycle: { phase: campaignRow.workflowState, phaseKnown: true },
    strategy: {
      snapshotsFound,
      latestVersion: latestSnapshot?.version ?? null,
      latestSnapshotId: latestSnapshot?.snapshotId ?? null,
      latestCapturedAt: iso(latestSnapshot?.capturedAt),
      approvalLineageStatus: strategyLineageStatus,
    },
    approvals: {
      pendingCount: pendingTypes.length,
      pendingTypes,
      latestDecision: latestDecisionRow
        ? { type: latestDecisionRow.approvalType, status: latestDecisionRow.status }
        : null,
    },
    creative: {
      runningClaims: runningClaims.length,
      staleRunningClaims,
      failedClaims: claims.filter((c) => c.status === "failed").length,
      assetsByStatus: countBy(assetRows ?? [], "status"),
    },
    audience: {
      latestAgentRunStatus: audienceRun?.status ?? null,
      latestAgentRunAt: iso(audienceRun?.createdAt),
    },
    distribution: {
      queueCounts,
      openTerminalFailures: openTerminalFailureIds.length,
      openReplayRequests: (openReplayRows ?? []).length,
    },
    publication: {
      publishedCount: queueCounts["published"] ?? 0,
      publishedWithExternalId,
      retryingCount: queueCounts["retrying"] ?? 0,
    },
    postLive: { liveAt, lastObservedAt },
    learning: {
      latestRecordAt: iso(learningRow?.evaluatedAt),
      latestConfidence: learningRow?.confidence ?? null,
    },
    promotion: { openProposalCount: (promotionRows ?? []).length },
    nextCycle: { present: nextCyclePresent, status: nextCycleStatus },
    budget: {
      costPaused: costPausePresent && costPauseValid,
      costPause,
      openReservations: (reservationRows ?? []).length,
      reservedCredits,
    },
    lastAutonomousActivity,
    blocker,
    status,
    notes,
  };
}
