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
 * - runApprovalContinuationSweep reconciles recently-decided approvals
 *   sequentially with per-item error isolation and is wired once at boot as a
 *   fire-and-forget recovery sweep.
 *
 * This module performs NO schema or migration change and mutates nothing
 * itself; the delegated entry points keep their own governance semantics.
 */

import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import { approvalRequests, campaigns } from "@db/schema";
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
 * - strategy_review: only while the campaign is still in strategy_generated.
 *   Approved requires the lineage to identify THIS request and not yet be
 *   "approved" (onStrategyApproved persists "approved" first, so an approved
 *   lineage means it ran or is running). Rejected re-applies
 *   request_strategy_changes. A lineage bound to a newer request supersedes
 *   this decision entirely.
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
    if (campaign.workflowState !== "strategy_generated") return { kind: "none" };
    const lineage = readStrategyApprovalLineage(context);
    // Superseded: a lineage bound to a newer request means this decision must
    // never clobber the newer cycle.
    if (lineage && lineage.approvalRequestId !== undefined && lineage.approvalRequestId !== approval.id) {
      return { kind: "none" };
    }
    if (approval.status === "approved") {
      // The approve continuation is only re-dispatched when the durable
      // lineage identifies THIS request and has not recorded the approval yet:
      // lineage.status "approved" means onStrategyApproved already ran or is
      // running (it persists that marker before any other side effect).
      if (!lineage || lineage.approvalRequestId !== approval.id) return { kind: "none" };
      if (lineage.status === "approved") return { kind: "none" };
      return { kind: "strategy_approved_continuation", ...base };
    }
    // Rejected while still in strategy_generated: request_strategy_changes
    // never applied.
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
 * owe a continuation. Sequential, per-item error isolated, and side-effect
 * free unless a dangling continuation is found. Wired once at boot; it must
 * never crash the server.
 */
export async function runApprovalContinuationSweep(input: {
  limit?: number;
  decidedWithinHours?: number;
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
      const result = await reconcileApprovalContinuation(row.id);
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

  return summary;
}
