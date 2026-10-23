/**
 * Governed budget resume service (WBS-R1.4).
 *
 * resumeWorkflowAfterApprovedCostIncrease is the single central continuation
 * entry point after a budget_increase approval has been approved and the
 * user's credits were increased. It turns a durable cost pause back into
 * forward progress:
 *
 * - Affordability recheck: the SAME cost gate that paused the workflow
 *   (canRunAutonomousWorkflow) is re-evaluated first; if the workflow is
 *   still unaffordable the pause stays and no continuation runs.
 * - Exact continuation identity: the resume claims the pause by clearing
 *   workflowContext.costPause with a conditional UPDATE matched on the exact
 *   recorded kind + continuationId, restoring the pre-pause workflowState and
 *   active status in the same write. At most one resumer wins; a zero-row
 *   UPDATE is reconciled by rereading — a cleared pause means another resumer
 *   already continued (idempotent already_resumed), anything else fails
 *   closed.
 * - Post-approval continuation: the winning resumer dispatches exactly one
 *   continuation through the EXISTING trigger pathways, which keep their own
 *   dedupe and governance semantics:
 *     - agent_run_complete(runId)            → onAgentRunComplete(runId)
 *     - strategy_approval(approvalId)        → onStrategyApproved(campaignId, userId, approvalId)
 *     - launch_audience_intelligence(id)     → access check + runAudienceIntelligenceAgent
 *   Because the pause is cleared BEFORE dispatch, a crash mid-dispatch can at
 *   most lose the continuation, never double-execute it; every target is
 *   itself idempotent or dedup-guarded.
 *
 * No approval is created or mutated here — this service only consumes the
 * approved budget_increase decision.
 */

import { and, eq, sql } from "drizzle-orm";
import { campaigns } from "@db/schema";
import { getDb } from "../../queries/connection";
import { canRunAutonomousWorkflow } from "../billing/cost-control";
import { checkAudienceAgentAccess } from "../audience/access";
import { runAudienceIntelligenceAgent } from "../agents/audience-intelligence-agent";
import { buildAudienceIntelligenceBillingIdentity } from "./agent-billing-identity";
import { onAgentRunComplete, onStrategyApproved } from "./triggers";
import {
  COST_PAUSE_CONTEXT_KEY,
  parseCostPauseProvenance,
  type WorkflowContinuationKind,
} from "./cost-pause";
import type { NextCycleDbExecutor } from "./next-cycle-persistence";

export interface ResumeWorkflowDeps {
  /** Executor for campaign authority reads and the claiming write. */
  executor?: NextCycleDbExecutor;
  /** Affordability gate (defaults to the existing cost-control gate). */
  canRun?: (userId: number, campaignId: number) => Promise<{ allowed: boolean; reason?: string }>;
  /** Continuation boundaries (default to the existing trigger pathways). */
  onAgentRunComplete?: (runId: number) => Promise<void>;
  onStrategyApproved?: (campaignId: number, userId: number, approvalId: number) => Promise<void>;
  runLaunchAudienceIntelligence?: (input: {
    userId: number;
    campaignId: number;
    /** Durable cost-pause continuation id; mints the stable billing identity (Stream E §2). */
    continuationId?: number;
  }) => Promise<void>;
}

export type ResumeWorkflowOutcome =
  | { outcome: "resumed"; kind: WorkflowContinuationKind; continuationId: number }
  | { outcome: "still_blocked"; reason: string }
  | { outcome: "already_resumed" }
  | { outcome: "not_bound" };

function parseWorkflowContextObject(value: unknown): Record<string, unknown> {
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

async function defaultRunLaunchAudienceIntelligence(input: {
  userId: number;
  campaignId: number;
  continuationId?: number;
}): Promise<void> {
  const access = await checkAudienceAgentAccess(input.userId, null);
  if (!access.allowed) {
    throw new Error(access.reason || "Audience intelligence access denied.");
  }
  await runAudienceIntelligenceAgent({
    userId: input.userId,
    campaignId: input.campaignId,
    autoCreateLeads: false,
    // WBS-R4 C0.2: resume under the same stable billing identity as the
    // original launch dispatch so a recovered continuation cannot re-charge.
    ...(input.continuationId !== undefined
      ? {
          billingIdentity: buildAudienceIntelligenceBillingIdentity({
            campaignId: input.campaignId,
            continuationId: input.continuationId,
          }),
        }
      : {}),
  });
}

/**
 * Resumes the owner-scoped campaign's cost-paused workflow after an approved
 * cost increase. Returns null when the campaign does not exist or records no
 * cost pause.
 *
 * `approvalId` (WBS-R4 A3-3) is the budget_increase approval request whose
 * approval authorised this resume. When the pause provenance binds an exact
 * `budgetIncreaseApprovalId`, a resume attempted under any other approval is a
 * no-op ({ outcome: "not_bound" }): the decision is not bound to this pause
 * and must not mutate or dispatch anything. Provenance recorded before the
 * binding existed (no `budgetIncreaseApprovalId` field) resumes under any
 * approved budget_increase decision.
 */
export async function resumeWorkflowAfterApprovedCostIncrease(input: {
  userId: number;
  campaignId: number;
  approvalId?: number;
  deps?: ResumeWorkflowDeps;
}): Promise<ResumeWorkflowOutcome | null> {
  const executor = input.deps?.executor ?? getDb();

  // 1. Durable provenance authority.
  const [campaign] = await executor
    .select({
      id: campaigns.id,
      status: campaigns.status,
      workflowContext: campaigns.workflowContext,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.userId, input.userId)))
    .limit(1);

  if (!campaign) {
    return null;
  }

  const context = parseWorkflowContextObject(campaign.workflowContext);
  const rawProvenance = context[COST_PAUSE_CONTEXT_KEY];
  if (rawProvenance === undefined) {
    return null;
  }
  const provenance = parseCostPauseProvenance(rawProvenance);
  if (!provenance) {
    throw new Error(
      `campaign ${input.campaignId} records malformed cost pause provenance; refusing to resume`
    );
  }

  // WBS-R4 A3-3 exact binding: a pause recorded with a budgetIncreaseApprovalId
  // only resumes under that exact approval decision. Anything else is a
  // no-op — no state change, no dispatch.
  if (
    input.approvalId !== undefined &&
    provenance.budgetIncreaseApprovalId !== undefined &&
    provenance.budgetIncreaseApprovalId !== input.approvalId
  ) {
    return { outcome: "not_bound" };
  }

  // 2. Affordability recheck through the SAME gate that paused the workflow.
  const canRun = input.deps?.canRun ?? canRunAutonomousWorkflow;
  const affordability = await canRun(input.userId, input.campaignId);
  if (!affordability.allowed) {
    return {
      outcome: "still_blocked",
      reason: affordability.reason ?? "Workflow is still not affordable.",
    };
  }

  // 3. Exact-identity claim: clear the pause and restore the pre-pause state
  //    only when the pause is still the exact one we validated.
  const nextContext = { ...context };
  delete nextContext[COST_PAUSE_CONTEXT_KEY];

  const updateResult = await executor
    .update(campaigns)
    .set({
      status: "active",
      // The provenance state was captured from this same enum at pause time.
      workflowState: provenance.workflowState as typeof campaigns.$inferSelect.workflowState,
      workflowContext: nextContext as unknown,
    })
    .where(
      and(
        eq(campaigns.id, input.campaignId),
        eq(campaigns.userId, input.userId),
        eq(
          sql`JSON_UNQUOTE(JSON_EXTRACT(${campaigns.workflowContext}, '$.costPause.kind'))`,
          provenance.kind
        ),
        eq(
          sql`JSON_UNQUOTE(JSON_EXTRACT(${campaigns.workflowContext}, '$.costPause.continuationId'))`,
          provenance.continuationId
        )
      )
    );

  // MySQL2 returns [ResultSetHeader, ...] where affectedRows is on the first element.
  const affectedRows =
    (updateResult as unknown as [{ affectedRows?: number }?])?.[0]?.affectedRows ?? 0;

  if (affectedRows === 0) {
    // A concurrent resumer won the pause between our read and this write.
    const [winner] = await executor
      .select({ id: campaigns.id, workflowContext: campaigns.workflowContext })
      .from(campaigns)
      .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.userId, input.userId)))
      .limit(1);
    if (!winner) {
      throw new Error(
        `campaign ${input.campaignId} disappeared during cost pause resume reconciliation`
      );
    }
    if (parseWorkflowContextObject(winner.workflowContext)[COST_PAUSE_CONTEXT_KEY] === undefined) {
      // The pause was already claimed and cleared by another resumer.
      return { outcome: "already_resumed" };
    }
    throw new Error(
      `campaign ${input.campaignId} cost pause changed concurrently; refusing to resume`
    );
  }

  // 4. Dispatch exactly one continuation through the existing pathways.
  const dispatchAgentRunComplete = input.deps?.onAgentRunComplete ?? onAgentRunComplete;
  const dispatchStrategyApproved = input.deps?.onStrategyApproved ?? onStrategyApproved;
  const dispatchLaunchAudienceIntelligence =
    input.deps?.runLaunchAudienceIntelligence ?? defaultRunLaunchAudienceIntelligence;

  switch (provenance.kind) {
    case "agent_run_complete":
      await dispatchAgentRunComplete(provenance.continuationId);
      break;
    case "strategy_approval":
      await dispatchStrategyApproved(input.campaignId, input.userId, provenance.continuationId);
      break;
    case "launch_audience_intelligence":
      await dispatchLaunchAudienceIntelligence({
        userId: input.userId,
        campaignId: input.campaignId,
        continuationId: provenance.continuationId,
      });
      break;
  }

  return {
    outcome: "resumed",
    kind: provenance.kind,
    continuationId: provenance.continuationId,
  };
}
