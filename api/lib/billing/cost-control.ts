import { getDb } from "../../queries/connection";
import { aiUsage, creditWallets, campaigns, approvalRequests } from "@db/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import { checkCredits } from "./credit-engine";
import { env } from "../env";
import { getSystemSetting } from "../system-settings";
import {
  buildCostPauseProvenance,
  recordWorkflowCostPause,
  type WorkflowContinuationKind,
} from "../workflow/cost-pause";

export interface CostContinuation {
  kind: WorkflowContinuationKind;
  continuationId: number;
}

interface CostControlResult {
  allowed: boolean;
  reason?: string;
  daily: number;
  monthly: number;
  balance: number;
}

async function getSystemAiLimits(): Promise<{ daily: number; monthly: number }> {
  const [dailyRaw, monthlyRaw] = await Promise.all([
    getSystemSetting("daily_ai_credit_limit"),
    getSystemSetting("monthly_ai_credit_limit"),
  ]);

  const daily = dailyRaw ? parseInt(dailyRaw, 10) : env.dailyAiCreditLimit;
  const monthly = monthlyRaw ? parseInt(monthlyRaw, 10) : env.monthlyAiCreditLimit;

  return {
    daily: Number.isFinite(daily) && daily > 0 ? daily : env.dailyAiCreditLimit,
    monthly: Number.isFinite(monthly) && monthly > 0 ? monthly : env.monthlyAiCreditLimit,
  };
}

/**
 * Get daily and monthly AI credit spend for a user.
 */
export async function getCreditSpend(userId: number): Promise<{
  daily: number;
  monthly: number;
  balance: number;
}> {
  const db = getDb();
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [dailyResult] = await db
    .select({ total: sql<number>`COALESCE(SUM(${aiUsage.creditsDeducted}), 0)` })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), gte(aiUsage.createdAt, startOfDay)));

  const [monthlyResult] = await db
    .select({ total: sql<number>`COALESCE(SUM(${aiUsage.creditsDeducted}), 0)` })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), gte(aiUsage.createdAt, startOfMonth)));

  const [wallet] = await db
    .select({ balance: creditWallets.balance })
    .from(creditWallets)
    .where(eq(creditWallets.userId, userId))
    .limit(1);

  return {
    daily: Number(dailyResult?.total ?? 0),
    monthly: Number(monthlyResult?.total ?? 0),
    balance: Number(wallet?.balance ?? 0),
  };
}

/**
 * Enforce cost controls before an AI action.
 * Checks: balance, daily system limit, monthly system limit.
 */
export async function enforceCostControl(
  userId: number,
  estimatedCost: number,
  options?: {
    dailyLimit?: number;
    monthlyLimit?: number;
  }
): Promise<CostControlResult> {
  const spend = await getCreditSpend(userId);
  const systemLimits = await getSystemAiLimits();

  // Check balance first (user credits)
  const balanceCheck = await checkCredits(userId, estimatedCost);
  if (!balanceCheck.hasCredits) {
    return {
      allowed: false,
      reason: `Insufficient credits. Balance: ${spend.balance}. Required: ${estimatedCost}.`,
      ...spend,
    };
  }

  // Check daily system limit
  const dailyLimit = options?.dailyLimit ?? systemLimits.daily;
  if (spend.daily + estimatedCost > dailyLimit) {
    return {
      allowed: false,
      reason: `System AI generation limit reached. Daily limit: ${dailyLimit}. Spent today: ${spend.daily}. Please contact admin or increase the daily AI limit.`,
      ...spend,
    };
  }

  // Check monthly system limit
  const monthlyLimit = options?.monthlyLimit ?? systemLimits.monthly;
  if (spend.monthly + estimatedCost > monthlyLimit) {
    return {
      allowed: false,
      reason: `System AI generation limit reached. Monthly limit: ${monthlyLimit}. Spent this month: ${spend.monthly}. Please contact admin or increase the monthly AI limit.`,
      ...spend,
    };
  }

  return { allowed: true, ...spend };
}

/**
 * Pause a campaign's autonomous workflow and create an approval request
 * when cost limits are exceeded.
 *
 * When `continuation` is supplied, the durable cost-pause provenance
 * (workflowContext.costPause) is recorded BEFORE the workflow state is
 * mutated, capturing the exact continuation coordinates and the pre-pause
 * workflowState so an approved cost increase can resume at the same point.
 */
export async function pauseWorkflowForCostLimit(
  userId: number,
  campaignId: number,
  reason: string,
  continuation?: CostContinuation
): Promise<void> {
  const db = getDb();

  // Capture the pre-pause authority BEFORE mutating the campaign: the resume
  // path restores this state and dispatches these exact coordinates.
  const [campaign] = await db
    .select({
      workflowState: campaigns.workflowState,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);

  // Record the durable resume provenance BEFORE clobbering the workflow
  // state. A crash after this write leaves a restorable pause (the resume
  // claim restores the recorded state and re-dispatches idempotent targets);
  // a crash between a state clobber and a later provenance record would
  // strand the campaign paused with no continuation coordinates at all.
  if (continuation) {
    await recordWorkflowCostPause({
      userId,
      campaignId,
      provenance: buildCostPauseProvenance({
        kind: continuation.kind,
        continuationId: continuation.continuationId,
        reason,
        workflowState: campaign?.workflowState ?? "strategy_pending",
      }),
    });
  }

  // Update campaign workflow state
  await db
    .update(campaigns)
    .set({
      workflowState: "launch_approval_required",
      status: "paused",
    })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)));

  // Create a budget_increase approval request. Concurrent triggers can all
  // observe insufficient credits in the same instant; only the first pending
  // request is created so a campaign never accumulates duplicate budget asks
  // for a single pause. (Best-effort under a true insert race — the unique
  // authorities live on the billing ledger, not on governance rows.)
  const [existingPendingBudgetApproval] = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.userId, userId),
        eq(approvalRequests.campaignId, campaignId),
        eq(approvalRequests.approvalType, "budget_increase"),
        eq(approvalRequests.status, "pending")
      )
    )
    .limit(1);

  if (!existingPendingBudgetApproval) {
    await db.insert(approvalRequests).values({
      userId,
      campaignId,
      approvalType: "budget_increase",
      title: "Autonomous Workflow Paused: Credit Limit Reached",
      description: `The autonomous workflow for this campaign has been paused because: ${reason}. Please review your credit balance or upgrade your plan to resume autonomous operations.`,
      aiRecommendation: "Consider upgrading to a higher tier or purchasing additional credits.",
      riskLevel: "medium",
      status: "pending",
    });
  }
}

/**
 * Check if autonomous workflow can run for a campaign.
 */
export async function canRunAutonomousWorkflow(
  userId: number,
  campaignId: number,
  continuation?: CostContinuation
): Promise<{ allowed: boolean; reason?: string }> {
  const db = getDb();

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);

  if (!campaign) {
    return { allowed: false, reason: "Campaign not found" };
  }

  // Forward-dispatch gates — every caller that drives NEW autonomous work
  // passes a continuation — must never run a paused campaign. Calls without
  // a continuation are bare affordability probes (the budget-resume
  // affordability recheck runs while the campaign is still cost-paused); for
  // them the paused status is not a rejection reason, otherwise an approved
  // budget increase could never resume a paused workflow.
  if (continuation && campaign.status === "paused") {
    return { allowed: false, reason: "Campaign is paused" };
  }

  // Check credit availability for at least one agent run
  const balanceCheck = await checkCredits(userId, 5); // minimum for one agent
  if (!balanceCheck.hasCredits) {
    await pauseWorkflowForCostLimit(
      userId,
      campaignId,
      "Insufficient credits for autonomous workflow",
      continuation
    );
    return { allowed: false, reason: "Insufficient credits. Workflow paused." };
  }

  return { allowed: true };
}
