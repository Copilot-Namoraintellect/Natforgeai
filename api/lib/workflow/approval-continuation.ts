/**
 * Approval continuation reconciliation (WBS-R4 A3).
 *
 * A decided approval (approved/rejected) normally hands off to a post-commit
 * continuation: onApprovalResolved drives strategy/launch continuations,
 * resumeWorkflowAfterApprovedCostIncrease drives budget resumes, and the
 * learning-promotion trigger/dispatch pair seeds the next governed cycle. A
 * crash between the decision commit and the dispatch loses that handoff; the
 * campaign then sits in a decided-but-stuck state until something re-dispatches.
 *
 * This module is the crash-recovery authority for those dangling continuations:
 *
 * - classifyApprovalContinuation is a PURE function that maps an approval row
 *   plus its campaign to exactly one ContinuationExpectation. Every branch is
 *   corroborated by durable workflowContext evidence (strategy/launch lineage,
 *   cost-pause provenance, the nextCycle envelope) so a stale or superseded
 *   decision never re-dispatches — governance is preserved, never fabricated.
 * - reconcileApprovalContinuation loads the approval and its owner-scoped
 *   campaign, classifies, and re-dispatches BY DELEGATION through the existing
 *   idempotent entry points (never duplicating their logic). It never throws
 *   past the caller: failures are logged and reported as { reconciled: false }.
 * - reconcileDanglingStrategyRunCompletions (WBS-R4 A5-2) closes the
 *   "restart after execution but before state update" gap: a completed
 *   strategy run whose campaign never advanced (or advanced without a bound
 *   review) is re-driven through onAgentRunComplete, rolling back the
 *   dangling strategy_generated transition through the governed engine action
 *   when review creation was lost.
 * - runApprovalContinuationSweep reconciles both scans sequentially with
 *   per-item error isolation and is wired once at boot as a fire-and-forget
 *   recovery sweep.
 *
 * This module performs NO schema or migration change and mutates nothing
 * itself; the delegated entry points keep their own governance semantics.
 */

import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import { agentRuns, approvalRequests, campaigns } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  COST_PAUSE_CONTEXT_KEY,
  parseCostPauseProvenance,
} from "./cost-pause";
import { readLaunchApprovalLineage } from "./launch-approval";
import {
  parseNextCycleInstruction,
  type NextCycleInstruction,
} from "../learning/learning-strategy-consumption";
import { isLearningPromotionApproval } from "../learning/promotion/promotion-decision";
import type { ResumeWorkflowOutcome } from "./budget-resume";
import type { NextCycleTriggerResult } from "./next-cycle-trigger";
import type { NextCycleDispatchResult } from "./next-cycle-dispatcher";

/** Minimal approval row shape the classifier needs. */
export interface ApprovalContinuationApproval {
  id: number;
  userId: number;
  campaignId: number | null;
  approvalType: string;
  status: string;
  context?: unknown;
}

/** Minimal campaign row shape the classifier needs. */
export interface ApprovalContinuationCampaign {
  id: number;
  userId: number;
  workflowState: string;
  workflowContext?: unknown;
}

export type ContinuationExpectation =
  | { kind: "none" }
  | { kind: "strategy_approved_continuation"; campaignId: number; userId: number; approvalId: number }
  | { kind: "strategy_approved_kickoff_continuation"; campaignId: number; userId: number; approvalId: number }
  | { kind: "strategy_rejected_continuation"; campaignId: number; userId: number; approvalId: number }
  | { kind: "launch_approved_continuation"; campaignId: number; userId: number; approvalId: number }
  | { kind: "launch_rejected_continuation"; campaignId: number; userId: number; approvalId: number }
  | { kind: "budget_resume_continuation"; campaignId: number; userId: number; approvalId: number }
  | { kind: "next_cycle_continuation"; campaignId: number; userId: number; approvalId: number };

function readWorkflowContext(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

interface StrategyLineageLike {
  approvalRequestId?: unknown;
  strategyRunId?: unknown;
  status?: unknown;
}

function readStrategyApprovalLineage(context: Record<string, unknown>): StrategyLineageLike | null {
  const raw = context.strategyApprovalLineage;
  if (!raw || typeof raw !== "object") return null;
  return raw as StrategyLineageLike;
}

/**
 * PURE classifier: which continuation (if any) a decided approval still owes.
 *
 * Fail-closed throughout — every non-"none" expectation is corroborated by
 * durable campaign evidence so re-dispatch can never double-run a continuation
 * that already applied or clobber a newer cycle:
 * - strategy_review: approved decisions require the lineage to identify THIS
 *   request. While the campaign is still in strategy_generated with the
 *   lineage not yet "approved", the decision continuation itself never
 *   applied (strategy_approved_continuation). While the campaign is in
 *   strategy_approved with the lineage already "approved", onStrategyApproved
 *   persisted the approval but its creative kickoff was lost
 *   (strategy_approved_kickoff_continuation) — re-dispatch is safe because the
 *   callee's own dedup is the authority: it early-no-ops on the
 *   creative-success charge key and refuses to double-run an in-progress
 *   claim. The classifier is PURE: it cannot see credit_transactions, so a
 *   kickoff that already produced its success marker still classifies here
 *   and relies on that callee dedup to no-op. Rejected re-applies
 *   request_strategy_changes while still in strategy_generated. A lineage
 *   bound to a newer request supersedes this decision entirely.
 * - campaign_launch: only while still in launch_approval_required, with the
 *   same superseding guard on the launch lineage.
 * - budget_increase: only an APPROVED decision, and only while a parseable
 *   cost pause exists that either predates approval binding (legacy) or is
 *   bound to exactly this approval.
 * - high_value_proposal: only an approved learning promotion whose envelope was
 *   sealed in the decision transaction but whose next-cycle trigger never ran
 *   (no workflowContext.nextCycle envelope yet). Plain carrier-type rows have
 *   no continuation.
 */
export function classifyApprovalContinuation(
  approval: ApprovalContinuationApproval,
  campaign: ApprovalContinuationCampaign | null | undefined
): ContinuationExpectation {
  const base = {
    campaignId: approval.campaignId ?? 0,
    userId: approval.userId,
    approvalId: approval.id,
  };

  // Only terminal human decisions can owe a continuation.
  if (approval.status !== "approved" && approval.status !== "rejected") {
    return { kind: "none" };
  }
  // Every continuation entry point drives a campaign; without one there is
  // nothing to re-dispatch.
  if (approval.campaignId == null || !campaign) {
    return { kind: "none" };
  }

  const approvalType = approval.approvalType;

  // Types that never carry a workflow continuation.
  if (
    approvalType === "sensitive_reply" ||
    approvalType === "ad_spend" ||
    approvalType === "shutdown" ||
    approvalType === "brand_risk"
  ) {
    return { kind: "none" };
  }

  const context = readWorkflowContext(campaign.workflowContext);

  if (approvalType === "high_value_proposal") {
    // Only learning promotions seed a next cycle; a rejection seals no
    // envelope and is never consumable.
    if (approval.status !== "approved") return { kind: "none" };
    if (
      !isLearningPromotionApproval({
        approvalType: approval.approvalType,
        context: approval.context,
      })
    ) {
      return { kind: "none" };
    }
    // The trigger persists the durable nextCycle envelope; an existing one
    // means the trigger already ran (ready/dispatched) or was consumed/failed.
    if (context.nextCycle !== undefined) return { kind: "none" };
    return { kind: "next_cycle_continuation", ...base };
  }

  if (approvalType === "strategy_review") {
    const lineage = readStrategyApprovalLineage(context);
    // Superseded: a lineage bound to a newer request means this decision must
    // never clobber the newer cycle.
    if (lineage && lineage.approvalRequestId !== undefined && lineage.approvalRequestId !== approval.id) {
      return { kind: "none" };
    }
    if (approval.status === "approved") {
      // Both approved expectations require the durable lineage to identify
      // THIS request.
      if (!lineage || lineage.approvalRequestId !== approval.id) return { kind: "none" };
      if (campaign.workflowState === "strategy_generated") {
        // lineage.status "approved" means onStrategyApproved already ran or is
        // running (it persists that marker before any other side effect).
        if (lineage.status === "approved") return { kind: "none" };
        // Approved while still in strategy_generated with a pending lineage:
        // the post-commit continuation never applied.
        return { kind: "strategy_approved_continuation", ...base };
      }
      if (campaign.workflowState === "strategy_approved") {
        // WBS-R4 A5-1: the approve_strategy transition and lineage approval
        // were applied, but the creative kickoff that follows was lost. The
        // re-dispatch re-enters onStrategyApproved, whose own dedup (success
        // charge key, in-progress claim) no-ops when the kickoff already
        // happened — the classifier cannot see that evidence itself.
        if (lineage.status === "approved") {
          return { kind: "strategy_approved_kickoff_continuation", ...base };
        }
        return { kind: "none" };
      }
      return { kind: "none" };
    }
    // Rejected while still in strategy_generated: request_strategy_changes
    // never applied.
    if (campaign.workflowState !== "strategy_generated") return { kind: "none" };
    return { kind: "strategy_rejected_continuation", ...base };
  }

  if (approvalType === "campaign_launch") {
    if (campaign.workflowState !== "launch_approval_required") return { kind: "none" };
    const lineage = readLaunchApprovalLineage(context);
    if (lineage && lineage.approvalRequestId !== approval.id) return { kind: "none" };
    if (approval.status === "approved") {
      if (!lineage || lineage.approvalRequestId !== approval.id) return { kind: "none" };
      return { kind: "launch_approved_continuation", ...base };
    }
    return { kind: "launch_rejected_continuation", ...base };
  }

  if (approvalType === "budget_increase") {
    // A rejection changes nothing for the pause.
    if (approval.status !== "approved") return { kind: "none" };
    const costPause = parseCostPauseProvenance(context[COST_PAUSE_CONTEXT_KEY]);
    if (!costPause) return { kind: "none" };
    // Exact binding (WBS-R4 A3-3): a pause bound to a different approval is
    // not resumable by this decision; legacy unbound pauses resume.
    if (
      costPause.budgetIncreaseApprovalId !== undefined &&
      costPause.budgetIncreaseApprovalId !== approval.id
    ) {
      return { kind: "none" };
    }
    return { kind: "budget_resume_continuation", ...base };
  }

  return { kind: "none" };
}

// ── Learning-promotion trigger → dispatch glue (shared by the approval   ──
// ── resolver branch and the reconciler; delegates keep their own dedup). ──

export interface NextCycleContinuationDeps {
  /** Boundary for triggerNextCycleAfterLearningPromotion. */
  triggerNextCycle?: (input: {
    userId: number;
    campaignId: number;
  }) => Promise<NextCycleTriggerResult | null>;
  /** Boundary for dispatchNextCycleInstruction. */
  dispatchNextCycle?: (input: {
    userId: number;
    campaignId: number;
    instructionId: string;
  }) => Promise<NextCycleDispatchResult>;
  /** Reads the campaign's durable next-cycle instruction (null when absent). */
  readNextCycleInstruction?: (input: {
    userId: number;
    campaignId: number;
  }) => Promise<NextCycleInstruction | null>;
}

async function defaultTriggerNextCycle(input: {
  userId: number;
  campaignId: number;
}): Promise<NextCycleTriggerResult | null> {
  const { triggerNextCycleAfterLearningPromotion } = await import("./next-cycle-trigger");
  return triggerNextCycleAfterLearningPromotion(input);
}

async function defaultDispatchNextCycle(input: {
  userId: number;
  campaignId: number;
  instructionId: string;
}): Promise<NextCycleDispatchResult> {
  const { dispatchNextCycleInstruction } = await import("./next-cycle-dispatcher");
  return dispatchNextCycleInstruction(input);
}

async function defaultReadNextCycleInstruction(input: {
  userId: number;
  campaignId: number;
}): Promise<NextCycleInstruction | null> {
  const db = getDb();
  const [campaign] = await db
    .select({ workflowContext: campaigns.workflowContext })
    .from(campaigns)
    .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.userId, input.userId)))
    .limit(1);
  if (!campaign) return null;
  const nextCycle = readWorkflowContext(campaign.workflowContext).nextCycle;
  if (nextCycle === undefined) return null;
  return parseNextCycleInstruction(nextCycle);
}

/**
 * Runs the learning-promotion next-cycle continuation: mint/persist the
 * durable instruction through the governed trigger, then dispatch it ONLY
 * while the durable instruction is still "ready" (an already-dispatched or
 * failed instruction is never re-run from here). Both boundaries are the
 * existing idempotent entry points.
 */
export async function dispatchNextCycleAfterLearningPromotion(input: {
  userId: number;
  campaignId: number;
  deps?: NextCycleContinuationDeps;
}): Promise<{
  triggered: NextCycleTriggerResult | null;
  dispatched: NextCycleDispatchResult | null;
}> {
  const trigger = input.deps?.triggerNextCycle ?? defaultTriggerNextCycle;
  const dispatch = input.deps?.dispatchNextCycle ?? defaultDispatchNextCycle;
  const readInstruction = input.deps?.readNextCycleInstruction ?? defaultReadNextCycleInstruction;

  const triggered = await trigger({ userId: input.userId, campaignId: input.campaignId });
  if (
    !triggered ||
    (triggered.outcome !== "created" && triggered.outcome !== "already_present")
  ) {
    return { triggered, dispatched: null };
  }

  const instruction = await readInstruction({
    userId: input.userId,
    campaignId: input.campaignId,
  });
  if (
    !instruction ||
    instruction.instructionId !== triggered.instructionId ||
    instruction.status !== "ready"
  ) {
    return { triggered, dispatched: null };
  }

  const dispatched = await dispatch({
    userId: input.userId,
    campaignId: input.campaignId,
    instructionId: triggered.instructionId,
  });
  return { triggered, dispatched };
}

// ── Reconciliation ─────────────────────────────────────────────────────────

export interface ReconcileApprovalContinuationDeps {
  loadApproval?: (approvalId: number) => Promise<ApprovalContinuationApproval | null>;
  loadCampaign?: (input: {
    campaignId: number;
    userId: number;
  }) => Promise<ApprovalContinuationCampaign | null>;
  onApprovalResolved?: (
    approvalId: number,
    decision: "approved" | "rejected",
    userId: number
  ) => Promise<void>;
  resumeBudgetIncrease?: (input: {
    userId: number;
    campaignId: number;
    approvalId: number;
  }) => Promise<ResumeWorkflowOutcome | null>;
  nextCycle?: NextCycleContinuationDeps;
}

export interface ReconcileApprovalContinuationResult {
  reconciled: boolean;
  kind: ContinuationExpectation["kind"];
  outcome?: string;
  error?: string;
}

async function defaultLoadApproval(
  approvalId: number
): Promise<ApprovalContinuationApproval | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalId))
    .limit(1);
  return row ?? null;
}

async function defaultLoadCampaign(input: {
  campaignId: number;
  userId: number;
}): Promise<ApprovalContinuationCampaign | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: campaigns.id,
      userId: campaigns.userId,
      workflowState: campaigns.workflowState,
      workflowContext: campaigns.workflowContext,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.userId, input.userId)))
    .limit(1);
  return row ?? null;
}

async function defaultOnApprovalResolved(
  approvalId: number,
  decision: "approved" | "rejected",
  userId: number
): Promise<void> {
  const { onApprovalResolved } = await import("./triggers");
  await onApprovalResolved(approvalId, decision, userId);
}

async function defaultResumeBudgetIncrease(input: {
  userId: number;
  campaignId: number;
  approvalId: number;
}): Promise<ResumeWorkflowOutcome | null> {
  const { resumeWorkflowAfterApprovedCostIncrease } = await import("./budget-resume");
  return resumeWorkflowAfterApprovedCostIncrease(input);
}

/**
 * Re-dispatches the continuation owed by one decided approval, BY DELEGATION
 * through the existing idempotent entry points. Never throws: every failure
 * is logged and returned as { reconciled: false, ... }.
 */
export async function reconcileApprovalContinuation(
  approvalId: number,
  deps?: ReconcileApprovalContinuationDeps
): Promise<ReconcileApprovalContinuationResult> {
  let kind: ContinuationExpectation["kind"] = "none";
  try {
    const loadApproval = deps?.loadApproval ?? defaultLoadApproval;
    const approval = await loadApproval(approvalId);
    if (!approval) {
      return { reconciled: false, kind: "none" };
    }

    const loadCampaign = deps?.loadCampaign ?? defaultLoadCampaign;
    const campaign =
      approval.campaignId == null
        ? null
        : await loadCampaign({ campaignId: approval.campaignId, userId: approval.userId });

    const expectation = classifyApprovalContinuation(approval, campaign);
    kind = expectation.kind;
    if (expectation.kind === "none") {
      return { reconciled: false, kind: "none" };
    }

    const { campaignId, userId } = expectation;

    switch (expectation.kind) {
      case "strategy_approved_continuation":
      case "strategy_approved_kickoff_continuation":
      case "launch_approved_continuation": {
        const dispatchApproval = deps?.onApprovalResolved ?? defaultOnApprovalResolved;
        await dispatchApproval(approvalId, "approved", userId);
        return { reconciled: true, kind: expectation.kind, outcome: "dispatched" };
      }
      case "strategy_rejected_continuation":
      case "launch_rejected_continuation": {
        const dispatchApproval = deps?.onApprovalResolved ?? defaultOnApprovalResolved;
        await dispatchApproval(approvalId, "rejected", userId);
        return { reconciled: true, kind: expectation.kind, outcome: "dispatched" };
      }
      case "budget_resume_continuation": {
        const resume = deps?.resumeBudgetIncrease ?? defaultResumeBudgetIncrease;
        const outcome = await resume({ userId, campaignId, approvalId });
        return {
          reconciled: true,
          kind: expectation.kind,
          outcome: outcome?.outcome ?? "missing",
        };
      }
      case "next_cycle_continuation": {
        const result = await dispatchNextCycleAfterLearningPromotion({
          userId,
          campaignId,
          deps: deps?.nextCycle,
        });
        const outcome = result.dispatched
          ? result.dispatched.outcome
          : (result.triggered?.outcome ?? "error");
        return { reconciled: true, kind: expectation.kind, outcome };
      }
      default:
        return { reconciled: false, kind: "none" };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[ApprovalContinuation] Reconcile failed for approval ${approvalId}:`,
      message
    );
    return { reconciled: false, kind, error: message };
  }
}

// ── Dangling strategy-run completion reconciliation (WBS-R4 A5-2) ──────────

/** Minimal agent run row shape the run-completion reconciler needs. */
export interface DanglingStrategyRunLike {
  id: number;
  userId: number;
  campaignId: number | null;
  agentType: string;
  status: string;
  completedAt?: unknown;
}

export interface ReconcileDanglingStrategyRunDeps {
  /** Lists recent completed strategy runs (default: completedAt within window). */
  listCompletedStrategyRuns?: (input: {
    cutoff: Date;
    limit: number;
  }) => Promise<DanglingStrategyRunLike[]>;
  /** Owner-scoped campaign load (default: getDb read). */
  loadCampaign?: (input: {
    campaignId: number;
    userId: number;
  }) => Promise<ApprovalContinuationCampaign | null>;
  /** strategy_review approvals for the campaign (any status). */
  listStrategyReviews?: (input: {
    campaignId: number;
    userId: number;
  }) => Promise<ApprovalContinuationApproval[]>;
  /** Continuation boundary (default: the real onAgentRunComplete trigger). */
  onRunComplete?: (runId: number) => Promise<void>;
  /**
   * Governed rollback of a dangling strategy_generated transition
   * (default: transitionCampaignState request_strategy_changes). Only invoked
   * for the strategy_generated-without-bound-review case, before the
   * re-drive, so the existing strategy_pending pathway can recreate the
   * review + lineage exactly once (A2-2 dedup).
   */
  rollbackStrategyTransition?: (input: {
    campaignId: number;
    userId: number;
  }) => Promise<void>;
}

/**
 * True when a pending/approved strategy_review approval is durably bound to
 * this run: either via the request-level context strategyRunId or via the
 * campaign lineage (approvalRequestId -> strategyRunId). Rejected requests
 * are superseded evidence and never count as bound.
 */
function hasBoundStrategyReview(
  run: DanglingStrategyRunLike,
  context: Record<string, unknown>,
  reviews: ApprovalContinuationApproval[]
): boolean {
  const lineage = readStrategyApprovalLineage(context);
  for (const review of reviews) {
    if (review.approvalType !== "strategy_review") continue;
    if (review.status !== "pending" && review.status !== "approved") continue;
    const reviewContext =
      review.context && typeof review.context === "object"
        ? (review.context as Record<string, unknown>)
        : null;
    if (reviewContext && Number(reviewContext.strategyRunId) === run.id) return true;
    if (
      lineage &&
      lineage.approvalRequestId === review.id &&
      Number(lineage.strategyRunId) === run.id
    ) {
      return true;
    }
  }
  return false;
}

async function defaultListCompletedStrategyRuns(input: {
  cutoff: Date;
  limit: number;
}): Promise<DanglingStrategyRunLike[]> {
  const db = getDb();
  return db
    .select({
      id: agentRuns.id,
      userId: agentRuns.userId,
      campaignId: agentRuns.campaignId,
      agentType: agentRuns.agentType,
      status: agentRuns.status,
      completedAt: agentRuns.completedAt,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.agentType, "strategy"),
        eq(agentRuns.status, "completed"),
        gte(agentRuns.completedAt, input.cutoff)
      )
    )
    .orderBy(desc(agentRuns.completedAt))
    .limit(input.limit) as Promise<DanglingStrategyRunLike[]>;
}

async function defaultRollbackStrategyTransition(input: {
  campaignId: number;
  userId: number;
}): Promise<void> {
  const { transitionCampaignState } = await import("./engine");
  await transitionCampaignState(input.campaignId, input.userId, "request_strategy_changes");
}

/**
 * Re-drives strategy runs whose completion persisted but whose forward state
 * update was lost ("restart after execution but before state update"):
 *
 * - campaign still in strategy_pending: the completion trigger never ran —
 *   re-drive onAgentRunComplete (state-guarded branch + A2-2 review dedup).
 * - campaign in strategy_generated with NO strategy_review approval bound to
 *   the run: the transition applied but review creation/lineage binding was
 *   lost — roll the dangling transition back through the governed
 *   request_strategy_changes action, then re-drive (which recreates the
 *   review + lineage exactly once).
 *
 * Everything else (advanced state, bound review, missing campaign) is
 * skipped. Sequential with per-item error isolation; never throws past the
 * caller.
 */
export async function reconcileDanglingStrategyRunCompletions(input: {
  windowHours?: number;
  limit?: number;
  deps?: ReconcileDanglingStrategyRunDeps;
} = {}): Promise<ApprovalContinuationSweepSummary> {
  const windowHours = input.windowHours ?? 24;
  const limit = input.limit ?? 200;
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const listRuns = input.deps?.listCompletedStrategyRuns ?? defaultListCompletedStrategyRuns;
  const loadCampaign = input.deps?.loadCampaign ?? defaultLoadCampaign;
  const listReviews =
    input.deps?.listStrategyReviews ?? defaultListStrategyReviews;
  const onRunComplete = input.deps?.onRunComplete ?? defaultOnRunComplete;
  const rollback =
    input.deps?.rollbackStrategyTransition ?? defaultRollbackStrategyTransition;

  const runs = await listRuns({ cutoff, limit });
  const summary: ApprovalContinuationSweepSummary = {
    scanned: runs.length,
    reconciled: 0,
    failed: 0,
    skipped: 0,
  };

  for (const run of runs) {
    try {
      if (run.agentType !== "strategy" || run.status !== "completed" || !run.campaignId) {
        summary.skipped += 1;
        continue;
      }
      const campaign = await loadCampaign({ campaignId: run.campaignId, userId: run.userId });
      if (!campaign) {
        summary.skipped += 1;
        continue;
      }

      if (campaign.workflowState === "strategy_pending") {
        await onRunComplete(run.id);
        summary.reconciled += 1;
        continue;
      }

      if (campaign.workflowState === "strategy_generated") {
        const context = readWorkflowContext(campaign.workflowContext);
        const reviews = await listReviews({
          campaignId: campaign.id,
          userId: campaign.userId,
        });
        if (hasBoundStrategyReview(run, context, reviews)) {
          summary.skipped += 1;
          continue;
        }
        // The transition applied but its review/lineage side effects did not:
        // roll the dangling transition back, then re-drive the existing
        // strategy_pending pathway. A2-2 dedup keeps the re-drive exactly-once
        // even under a concurrent recovery.
        await rollback({ campaignId: campaign.id, userId: campaign.userId });
        await onRunComplete(run.id);
        summary.reconciled += 1;
        continue;
      }

      summary.skipped += 1;
    } catch (error) {
      summary.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[ApprovalContinuation] Dangling strategy-run reconcile failed for run ${run.id}:`,
        message
      );
    }
  }

  return summary;
}

async function defaultListStrategyReviews(input: {
  campaignId: number;
  userId: number;
}): Promise<ApprovalContinuationApproval[]> {
  const db = getDb();
  return db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.campaignId, input.campaignId),
        eq(approvalRequests.userId, input.userId),
        eq(approvalRequests.approvalType, "strategy_review")
      )
    ) as Promise<ApprovalContinuationApproval[]>;
}

async function defaultOnRunComplete(runId: number): Promise<void> {
  const { onAgentRunComplete } = await import("./triggers");
  await onAgentRunComplete(runId);
}

// ── Boot-time recovery sweep ───────────────────────────────────────────────

/** Approval types worth classifying in the sweep (the rest are always none). */
const CONTINUATION_SWEEP_APPROVAL_TYPES = [
  "campaign_launch",
  "strategy_review",
  "budget_increase",
  "high_value_proposal",
  "brand_risk",
] as const;

export interface ApprovalContinuationSweepSummary {
  scanned: number;
  reconciled: number;
  failed: number;
  skipped: number;
}

/**
 * Crash-recovery sweep: reconcile every recently-decided approval that could
 * owe a continuation AND every dangling strategy-run completion ("restart
 * after execution but before state update"). Sequential, per-item error
 * isolated, and side-effect free unless a dangling continuation is found.
 * Wired once at boot; it must never crash the server.
 */
export async function runApprovalContinuationSweep(input: {
  limit?: number;
  decidedWithinHours?: number;
  deps?: ReconcileApprovalContinuationDeps & ReconcileDanglingStrategyRunDeps;
} = {}): Promise<ApprovalContinuationSweepSummary> {
  const limit = input.limit ?? 200;
  const decidedWithinHours = input.decidedWithinHours ?? 24;
  const cutoff = new Date(Date.now() - decidedWithinHours * 60 * 60 * 1000);

  const db = getDb();
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        inArray(approvalRequests.status, ["approved", "rejected"]),
        inArray(approvalRequests.approvalType, [...CONTINUATION_SWEEP_APPROVAL_TYPES]),
        or(gte(approvalRequests.approvedAt, cutoff), gte(approvalRequests.rejectedAt, cutoff))
      )
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(limit);

  const summary: ApprovalContinuationSweepSummary = {
    scanned: rows.length,
    reconciled: 0,
    failed: 0,
    skipped: 0,
  };

  for (const row of rows) {
    try {
      const result = await reconcileApprovalContinuation(row.id, input.deps);
      if (result.reconciled) {
        summary.reconciled += 1;
      } else if (result.error) {
        summary.failed += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      // reconcile already never throws; isolate per-item regardless.
      summary.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[ApprovalContinuation] Sweep item approval ${row.id} failed:`,
        message
      );
    }
  }

  const runSummary = await reconcileDanglingStrategyRunCompletions({
    windowHours: decidedWithinHours,
    limit,
    deps: input.deps,
  });
  summary.scanned += runSummary.scanned;
  summary.reconciled += runSummary.reconciled;
  summary.failed += runSummary.failed;
  summary.skipped += runSummary.skipped;

  return summary;
}
