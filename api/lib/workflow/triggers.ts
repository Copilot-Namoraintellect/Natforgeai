import { getDb } from "../../queries/connection";
import {
  agentRuns,
  campaigns,
  businesses,
  approvalRequests,
  publishingQueue,
  creditTransactions,
  contentPosts,
  creativeGenerationClaims,
} from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { transitionCampaignState, createApprovalRequest } from "./engine";
import { resolveCreativeWorkflowState } from "./progress-logic";
import { runCreativeAgent } from "../agents/creative-agent";
import { runDistributionAgent } from "../agents/distribution-agent";
import { runAudienceAgent } from "../agents/audience-agent";
import { runAudienceIntelligenceAgent } from "../agents/audience-intelligence-agent";
import { terminaliseStaleStrategyRuns } from "../agents/stale-strategy-run";
import { checkAudienceAgentAccess } from "../audience/access";
import { canRunAutonomousWorkflow } from "../billing/cost-control";
import { isBullMQAvailable, removePublishingJob, schedulePublishingJob } from "../queue/bullmq";
import { ingestAudienceData } from "../audience/ingest";
import {
  acquireCreativeGenerationClaim,
  rearmCreativeGenerationClaim,
  generateOwnerToken,
  releaseClaimWithResult,
  calculateLeaseExpiresAt,
  createClaimHeartbeatController,
  type CreativeGenerationClaim,
  type CreativeGenerationClaimHeartbeatController,
} from "../creative/creative-generation-claim";
import { env } from "../env";
import {
  syncCreativeReleasePackageSafely,
} from "../creative/release-package";
import {
  getStrategyApprovalStatus,
  buildStrategyApprovalLineage,
  validateStrategyRunForCampaign,
} from "./strategy-approval";
import { getLaunchApprovalStatus, buildLaunchApprovalLineage } from "./launch-approval";
import { InMemoryWorkflowOperationRegistry } from "./workflow-operation";
import { resolveCreativeEntryStrategyAuthority } from "../creative/creative-entry-authority";
import { MARKETING_ACTION_APPROVAL_TYPE } from "../policy/marketing-action-approval";
import { resumeEngagementContinuationForApproval } from "../engagement/continuation";
import type { CreativeStrategySnapshotInput } from "../creative/strategy-snapshot-input";
import { getStrategySnapshotByStrategyRunId } from "../strategy/strategy-snapshot-db-store";
import {
  buildAudienceBillingIdentity,
  buildAudienceIntelligenceBillingIdentity,
  buildDistributionBillingIdentity,
} from "./agent-billing-identity";
import { isLearningPromotionApproval } from "../learning/promotion/promotion-decision";

interface StrategyReviewLineageLike {
  readonly strategyRunId?: unknown;
  readonly approvalRequestId?: unknown;
  readonly status?: unknown;
}

function readStrategyApprovalLineage(
  workflowContext: unknown
): StrategyReviewLineageLike | undefined {
  if (!workflowContext || typeof workflowContext !== "object") return undefined;
  const lineage = (workflowContext as Record<string, unknown>).strategyApprovalLineage;
  if (!lineage || typeof lineage !== "object") return undefined;
  return lineage as StrategyReviewLineageLike;
}

/**
 * Resolves the strategy run an approval request is bound to. The primary
 * binding is the campaign's strategyApprovalLineage (approvalRequestId ->
 * strategyRunId); a durable request-level context carrying strategyRunId is
 * honoured when present. Returns null when the binding cannot be determined.
 */
function resolveStrategyReviewRunId(
  request: { readonly id: number; readonly context?: unknown },
  lineage: StrategyReviewLineageLike | undefined
): number | null {
  const context = request.context as Record<string, unknown> | null;
  if (
    context &&
    Number.isFinite(Number(context.strategyRunId)) &&
    Number(context.strategyRunId) > 0
  ) {
    return Number(context.strategyRunId);
  }
  if (
    lineage &&
    lineage.approvalRequestId === request.id &&
    Number.isFinite(Number(lineage.strategyRunId))
  ) {
    return Number(lineage.strategyRunId);
  }
  return null;
}

export async function onAgentRunComplete(runId: number) {
  const db = getDb();
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);

  if (!run || run.status !== "completed" || !run.campaignId) return;

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, run.campaignId))
    .limit(1);

  if (!campaign) return;

  // WBS-R1.6 forward reliability: terminalise strategy runs orphaned by a
  // crash (stuck "running") for THIS campaign so status-based dedup and the
  // workflow status stay sound. Best-effort: a sweep failure must not block
  // the completion that is already durably recorded.
  try {
    const sweep = await terminaliseStaleStrategyRuns({
      userId: run.userId,
      campaignId: run.campaignId,
    });
    if (sweep.terminalised > 0) {
      console.log(
        `[Workflow] Terminalised ${sweep.terminalised} stale strategy run(s) for campaign ${run.campaignId}.`
      );
    }
  } catch (error) {
    console.error(
      `[Workflow] Stale strategy-run sweep failed for campaign ${run.campaignId}:`,
      error instanceof Error ? error.message : error
    );
  }

  const [business] = campaign.businessId
    ? await db
        .select()
        .from(businesses)
        .where(and(eq(businesses.id, campaign.businessId), eq(businesses.userId, run.userId)))
        .limit(1)
    : [null];

  // Check cost control before auto-advancing
  const autoCheck = await canRunAutonomousWorkflow(run.userId, run.campaignId, {
    kind: "agent_run_complete",
    continuationId: run.id,
  });
  if (!autoCheck.allowed) {
    console.log(`[Workflow] Auto-advance blocked for campaign ${run.campaignId}: ${autoCheck.reason}`);
    return;
  }

  const state = campaign.workflowState;

  // Auto-advance workflow based on agent completion
  if (state === "strategy_pending" && run.agentType === "strategy") {
    await transitionCampaignState(run.campaignId, run.userId, "generate_strategy");

    // Create strategy approval request
    const [updatedCampaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, run.campaignId))
      .limit(1);

    if (updatedCampaign) {
      // WBS-R4 A2-2: idempotent strategy_review creation. A replay of this
      // trigger for the same strategy run (e.g. the state rolled back to
      // strategy_pending after a crash) must never create a duplicate review.
      // A pending request already bound to THIS run is reused; pending
      // requests bound to a different run are superseded with the exact
      // mechanism the next-cycle dispatcher uses.
      const existingLineage = readStrategyApprovalLineage(
        updatedCampaign.workflowContext
      );

      const pendingStrategyReviews = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.campaignId, run.campaignId),
            eq(approvalRequests.userId, run.userId),
            eq(approvalRequests.approvalType, "strategy_review"),
            eq(approvalRequests.status, "pending")
          )
        );

      const sameRunRequest = pendingStrategyReviews.find(
        (request) => resolveStrategyReviewRunId(request, existingLineage) === run.id
      );

      let approvalRequestId: number;
      if (sameRunRequest) {
        approvalRequestId = sameRunRequest.id;
        console.log(
          `[Workflow] Reusing pending strategy_review request ${approvalRequestId} already bound to strategy run ${run.id} for campaign ${run.campaignId}.`
        );
      } else {
        for (const oldRequest of pendingStrategyReviews) {
          await db
            .update(approvalRequests)
            .set({
              status: "rejected",
              rejectedAt: new Date(),
              description: `${oldRequest.description || ""}\n\nSuperseded: a new strategy was generated for the next governed cycle.`.trim(),
            })
            .where(eq(approvalRequests.id, oldRequest.id));
        }

        const { id } = await createApprovalRequest({
          userId: run.userId,
          campaignId: run.campaignId,
          approvalType: "strategy_review",
          title: `Approve Strategy: ${updatedCampaign.name}`,
          description: `The strategy for "${updatedCampaign.name}" has been generated. Review and approve to continue to creative content generation.`,
          aiRecommendation: "Based on the campaign goal and target audience, this strategy aligns with best practices for the selected platforms.",
          riskLevel: "low",
        });
        approvalRequestId = id;
      }

      // Bind the approval lineage to the EXACT immutable Strategy snapshot
      // authority persisted for this completed Strategy run. Fail closed
      // when that authority is missing or does not match the run/campaign/
      // current brief — mutable campaign fields are never used as authority.
      const snapshotAuthority = await getStrategySnapshotByStrategyRunId(run.id);
      const status = getStrategyApprovalStatus(updatedCampaign, business);
      if (
        !snapshotAuthority ||
        snapshotAuthority.userId !== run.userId ||
        snapshotAuthority.campaignId !== run.campaignId ||
        snapshotAuthority.creativeBriefFingerprint !== status.currentFingerprint
      ) {
        console.error(
          `[Workflow] Strategy run ${run.id} for campaign ${run.campaignId} completed without matching immutable Strategy snapshot authority; strategy approval lineage was not recorded.`
        );
        return;
      }

      const lineageAlreadyBound =
        !!sameRunRequest &&
        existingLineage?.strategyRunId === run.id &&
        existingLineage?.approvalRequestId === approvalRequestId &&
        existingLineage?.status === "pending";
      if (lineageAlreadyBound) {
        // Fully idempotent replay: the pending review exists and the lineage
        // is already bound to it. Nothing further to write.
        return;
      }

      await db
        .update(campaigns)
        .set({
          workflowContext: {
            ...(updatedCampaign.workflowContext || {}),
            strategyApprovalLineage: buildStrategyApprovalLineage(
              status.currentFingerprint,
              run.id,
              approvalRequestId,
              "pending",
              {
                strategySnapshotId: snapshotAuthority.snapshotId,
                strategyVersion: snapshotAuthority.version,
                businessDnaSnapshotId: snapshotAuthority.businessDnaSnapshotId,
                strategyHashSha256: snapshotAuthority.strategyHashSha256,
              }
            ),
          } as any,
        })
        .where(eq(campaigns.id, run.campaignId));
    }
  } else if (["strategy_approved", "creatives_generating"].includes(state) && run.agentType === "creative") {
    if (state === "strategy_approved") {
      await transitionCampaignState(run.campaignId, run.userId, "generate_creatives");
    }

    const [latestCampaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, run.campaignId))
      .limit(1);

    // Verify that the creative agent actually saved posts before transitioning
    const ctx = ((latestCampaign?.workflowContext || campaign.workflowContext) || {}) as any;
    const savedPosts = ctx.savedPosts ?? 0;
    if (savedPosts === 0) {
      console.error(`[Workflow] Creative agent for campaign ${run.campaignId} completed but savedPosts=0. Not transitioning state.`);
      return;
    }

    const resolvedCreativeState = resolveCreativeWorkflowState({
      currentState: state,
      strategyApproved: state === "strategy_approved" || state === "creatives_generating",
      creativeRunStatus: "completed",
      savedPosts,
    });

    if (resolvedCreativeState === "creatives_ready") {
      await transitionCampaignState(run.campaignId, run.userId, "creatives_complete");

      // R4-B2: the creative pipeline reached its readiness state — attempt to
      // seal the immutable creative release package from durable evidence.
      // Best-effort: sealing never blocks workflow advancement, and an
      // incomplete evidence set simply defers the seal to a later completion
      // (e.g. the post-hoc leaflet render / caption pack generation).
      await syncCreativeReleasePackageSafely({
        userId: run.userId,
        campaignId: run.campaignId,
        sealedBy: "workflow.onAgentRunComplete",
      });
    }

    // Auto-trigger audience agent after creatives are ready — with dedup guard
    try {
      const existingAudience = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, run.campaignId),
            eq(agentRuns.agentType, "audience"),
            eq(agentRuns.userId, run.userId)
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      if (existingAudience.length > 0 && ["running", "completed"].includes(existingAudience[0].status)) {
        console.log(`[Workflow] Skipping duplicate audience run for campaign ${run.campaignId}. Existing run ${existingAudience[0].id} is ${existingAudience[0].status}.`);
      } else {
        // WBS-R1.3: mint the caller-stable billing identity at the trigger
        // boundary so retries of this logical step never double-charge.
        const audienceResult = await runAudienceAgent({
          userId: run.userId,
          campaignId: run.campaignId,
          billingIdentity: buildAudienceBillingIdentity({
            campaignId: run.campaignId,
            creativeRunId: run.id,
          }),
        });
        await onAgentRunComplete(audienceResult.runId);
      }
    } catch (err: any) {
      console.error("[Workflow] Auto-audience failed:", err.message);
    }
  } else if (state === "audience_generating" && run.agentType === "audience") {
    await transitionCampaignState(run.campaignId, run.userId, "audience_complete");

    // Auto-trigger distribution agent after audience is ready — with dedup guard
    try {
      const existingDist = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, run.campaignId),
            eq(agentRuns.agentType, "distribution"),
            eq(agentRuns.userId, run.userId)
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      if (existingDist.length > 0 && ["running", "completed"].includes(existingDist[0].status)) {
        console.log(`[Workflow] Skipping duplicate distribution run for campaign ${run.campaignId}. Existing run ${existingDist[0].id} is ${existingDist[0].status}.`);
      } else {
        // WBS-R1.3: mint the caller-stable billing identity at the trigger
        // boundary so retries of this logical step never double-charge.
        const distResult = await runDistributionAgent({
          userId: run.userId,
          campaignId: run.campaignId,
          approvalMode: campaign.approvalMode as "assisted" | "autonomous",
          billingIdentity: buildDistributionBillingIdentity({
            campaignId: run.campaignId,
            audienceRunId: run.id,
          }),
        });
        await onAgentRunComplete(distResult.runId);
      }
    } catch (err: any) {
      console.error("[Workflow] Auto-distribution failed:", err.message);
    }
  } else if (state === "schedule_generated" && run.agentType === "distribution") {
    // Create launch approval request and record the durable launch lineage so
    // the approval is linked to the current brief (G-04 fail-closed).
    const { id: launchApprovalRequestId } = await createApprovalRequest({
      userId: run.userId,
      campaignId: run.campaignId,
      approvalType: "campaign_launch",
      title: `Approve Launch: ${campaign.name}`,
      description: `The campaign "${campaign.name}" is ready to launch. All strategy, creative, audience, and schedule assets have been generated.`,
      aiRecommendation: "Based on the generated strategy and content, this campaign is ready to go live. Expected reach aligns with budget allocation.",
      riskLevel: "low",
    });
    await db
      .update(campaigns)
      .set({
        workflowContext: {
          ...(campaign.workflowContext || {}),
          launchApprovalLineage: buildLaunchApprovalLineage(
            getLaunchApprovalStatus(campaign, business).currentFingerprint,
            launchApprovalRequestId,
            "pending"
          ),
        } as any,
      })
      .where(eq(campaigns.id, run.campaignId));
    await transitionCampaignState(run.campaignId, run.userId, "request_launch_approval");
  }
}

async function enqueueApprovedPublishingRows(
  campaignId: number,
  userId: number
): Promise<{ attempted: number; scheduled: number; failed: number }> {
  const db = getDb();

  const approvedQueueItems = await db
    .select()
    .from(publishingQueue)
    .where(
      and(
        eq(publishingQueue.campaignId, campaignId),
        eq(publishingQueue.userId, userId),
        eq(publishingQueue.status, "approved")
      )
    );

  let scheduled = 0;
  let failed = 0;

  for (const item of approvedQueueItems) {
    try {
      await schedulePublishingJob(
        item.id,
        item.userId,
        item.platform,
        item.scheduledAt ? new Date(item.scheduledAt) : new Date()
      );
      scheduled += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[Workflow] Failed to enqueue publishing queue item ${item.id} for campaign ${campaignId}: ${message}`
      );
    }
  }

  return {
    attempted: approvedQueueItems.length,
    scheduled,
    failed,
  };
}

/**
 * WBS-R3.4 / GAP29(a): launch rejection withdraws publication authority.
 * Distribution-created queue rows that sit in an executable state
 * (`approved`, or `retrying` with a pending re-attempt) were created under
 * the assumption the launch would be approved. Left live, the due-scan and
 * any already-enqueued BullMQ jobs would re-attempt them every cycle and
 * churn them toward terminal failure — execution-time readiness would fail
 * closed, but only after wasted attempts and durable failure noise. Park
 * them back in the gated `pending_approval` state (the established
 * non-executable authority state, mirroring the brand_risk reject policy)
 * and cancel scheduled BullMQ jobs best-effort.
 */
async function withdrawApprovedPublishingRows(
  campaignId: number,
  userId: number
): Promise<{ withdrawn: number }> {
  const db = getDb();

  const campaignRows = await db
    .select()
    .from(publishingQueue)
    .where(
      and(
        eq(publishingQueue.campaignId, campaignId),
        eq(publishingQueue.userId, userId)
      )
    );

  let withdrawn = 0;
  for (const row of campaignRows) {
    if (row.status !== "approved" && row.status !== "retrying") continue;
    await db
      .update(publishingQueue)
      .set({ status: "pending_approval", approvalRequired: true })
      .where(eq(publishingQueue.id, row.id));
    withdrawn += 1;

    if (isBullMQAvailable()) {
      try {
        await removePublishingJob(row.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[Workflow] Failed to remove publishing job for withdrawn queue item ${row.id}: ${message}`
        );
      }
    }
  }

  return { withdrawn };
}
export async function onApprovalResolved(approvalId: number, decision: "approved" | "rejected", userId: number) {
  const db = getDb();

  // Ownership-scoped re-read (WBS-R4 A3-2): the approval is only ever driven
  // for the user whose decision resolved it.
  const [request] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, approvalId), eq(approvalRequests.userId, userId)))
    .limit(1);

  if (!request) {
    throw new Error("Approval request not found");
  }

  // WBS-R5-C: a resolved marketing_action approval resumes (approved) or
  // permanently blocks (rejected) the bound engagement action through the
  // full gated execution path — the R5-E gate re-validates the exact binding
  // at execution time. Engagement approvals carry no campaignId, so this
  // branch runs before the campaign-scoped continuations below. Failures are
  // logged loud and never break the approval decision flow.
  if (request.approvalType === MARKETING_ACTION_APPROVAL_TYPE) {
    try {
      await resumeEngagementContinuationForApproval({
        approvalRequestId: approvalId,
        userId,
        decision,
      });
    } catch (err) {
      console.error(
        `[Engagement] Approval continuation failed for approval ${approvalId}:`,
        err instanceof Error ? err.message : err
      );
    }
    return;
  }

  const campaignId = request.campaignId;
  if (!campaignId) return;

  if (request.approvalType === "campaign_launch") {
    if (decision === "approved") {
      await transitionCampaignState(campaignId, userId, "approve_launch");

      // Launch approval grants publication authority but does not mean the
      // campaign is live. Distribution already created the durable queue rows.
      // Enqueue only independently approved rows; publishSinglePost performs
      // the authoritative launch/readiness check again before side effects.
      if (isBullMQAvailable()) {
        await enqueueApprovedPublishingRows(campaignId, userId);
      }

      // Optional: auto-run audience intelligence after launch approval
      try {
        const access = await checkAudienceAgentAccess(userId, null);
        const autoCheck = await canRunAutonomousWorkflow(userId, campaignId, {
          kind: "launch_audience_intelligence",
          continuationId: approvalId,
        });
        if (access.allowed && autoCheck.allowed) {
          // WBS-R4 C0.2: mint the caller-stable audience-intelligence billing
          // identity at the trigger boundary (Stream E contract §2) so a
          // replayed/resumed launch continuation cannot re-charge the same
          // logical operation.
          await runAudienceIntelligenceAgent({
            userId,
            campaignId,
            autoCreateLeads: false,
            billingIdentity: buildAudienceIntelligenceBillingIdentity({
              campaignId,
              continuationId: approvalId,
            }),
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Workflow] Auto audience-intelligence failed for campaign ${campaignId}:`, message);
      }
    } else {
      await transitionCampaignState(campaignId, userId, "reject_launch");
      // GAP29(a): executable queue rows outlive the rejected launch; withdraw
      // them so no runner path can attempt publication without authority.
      await withdrawApprovedPublishingRows(campaignId, userId);
    }
  } else if (request.approvalType === "brand_risk") {
    // Find associated publishing queue items for this campaign that are safety_blocked or pending_approval
    const queueItems = await db
      .select()
      .from(publishingQueue)
      .where(
        and(
          eq(publishingQueue.campaignId, campaignId),
          eq(publishingQueue.userId, userId),
          eq(publishingQueue.status, "pending_approval")
        )
      );

    if (decision === "approved") {
      for (const item of queueItems) {
        await db
          .update(publishingQueue)
          .set({ status: "approved", approvalRequired: false })
          .where(eq(publishingQueue.id, item.id));
      }

      // A post-level approval may resolve after the launch approval. In that
      // case production BullMQ must receive the newly approved durable row.
      // Before launch authority exists, leave it approved but unscheduled;
      // the later campaign_launch resolution will enqueue it.
      if (isBullMQAvailable()) {
        const [campaign] = await db
          .select()
          .from(campaigns)
          .where(
            and(
              eq(campaigns.id, campaignId),
              eq(campaigns.userId, userId)
            )
          )
          .limit(1);

        if (
          campaign &&
          ["publication_pending", "campaign_live"].includes(
            campaign.workflowState
          )
        ) {
          await enqueueApprovedPublishingRows(campaignId, userId);
        }
      }
    }
    // If rejected, leave them as pending_approval / safety_blocked
  } else if (request.approvalType === "strategy_review") {
    if (decision === "approved") {
      await onStrategyApproved(campaignId, userId, approvalId);
    } else {
      await transitionCampaignState(campaignId, userId, "request_strategy_changes");
    }
  } else if (request.approvalType === "budget_increase") {
    if (decision === "approved") {
      // WBS-R1.4: an approved cost increase resumes the cost-paused workflow
      // at its durable continuation point. Imported lazily to keep the
      // module graph acyclic (budget-resume drives the trigger pathways).
      // WBS-R4 A3-3: the approval id is passed through so the resume is bound
      // to the exact approval that authorised it (provenance recorded with a
      // budgetIncreaseApprovalId refuses any other decision).
      const { resumeWorkflowAfterApprovedCostIncrease } = await import("./budget-resume");
      await resumeWorkflowAfterApprovedCostIncrease({ userId, campaignId, approvalId });
    }
  } else if (
    request.approvalType === "high_value_proposal" &&
    isLearningPromotionApproval(request) &&
    decision === "approved" &&
    campaignId
  ) {
    // WBS-R4 A4-1: an approved learning promotion (envelope sealed in the
    // decision transaction) seeds the next governed Strategy cycle. The glue
    // mints/persists the durable next-cycle instruction through the governed
    // trigger and dispatches it only while it is still "ready". Failures are
    // logged per-item: they must never reject the approval resolution.
    try {
      const { dispatchNextCycleAfterLearningPromotion } = await import("./approval-continuation");
      const { triggered, dispatched } = await dispatchNextCycleAfterLearningPromotion({
        userId,
        campaignId,
      });
      console.log(
        `[Workflow] Learning-promotion next-cycle trigger for approval ${approvalId} (campaign ${campaignId}): ${triggered?.outcome ?? "null"}`
      );
      if (dispatched) {
        console.log(
          `[Workflow] Learning-promotion next-cycle dispatch for approval ${approvalId} (campaign ${campaignId}): ${dispatched.outcome}`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[Workflow] Next-cycle continuation after promotion approval ${approvalId} failed for campaign ${campaignId}:`,
        message
      );
    }
  }
}

async function hasSuccessfulCreativeGenerationForApproval(
  userId: number,
  campaignId: number,
  approvalId: number,
  currentFingerprint: string
): Promise<boolean> {
  const db = getDb();

  // Fast path: a successful creative charge already recorded for this exact approval.
  const idempotencyKey = `creative-success:${campaignId}:approval:${approvalId}`;
  const [existingCharge] = await db
    .select()
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.userId, userId),
        eq(creditTransactions.type, "agent_deduction"),
        eq(creditTransactions.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);

  if (existingCharge) {
    return true;
  }

  // Fallback: a completed creative run whose saved posts reference this fingerprint.
  const completedRuns = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        eq(agentRuns.campaignId, campaignId),
        eq(agentRuns.agentType, "creative"),
        eq(agentRuns.status, "completed")
      )
    );

  if (completedRuns.length === 0) {
    return false;
  }

  const posts = await db
    .select()
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.userId, userId),
        eq(contentPosts.campaignId, campaignId)
      )
    );

  for (const run of completedRuns) {
    const runIdTag = `pack-${run.id}`;
    for (const post of posts) {
      const metadata = (post.metadata ?? {}) as Record<string, unknown>;
      if (
        metadata.generationRunId === runIdTag &&
        metadata.creativeBriefFingerprint === currentFingerprint
      ) {
        return true;
      }
    }
  }

  return false;
}

async function hasInProgressCreativeGeneration(
  userId: number,
  campaignId: number,
  approvalId: number
): Promise<boolean> {
  const db = getDb();

  const runningClaim = await db
    .select()
    .from(creativeGenerationClaims)
    .where(
      and(
        eq(creativeGenerationClaims.userId, userId),
        eq(creativeGenerationClaims.campaignId, campaignId),
        eq(creativeGenerationClaims.operationSource, "approval"),
        eq(creativeGenerationClaims.operationReferenceId, approvalId),
        eq(creativeGenerationClaims.status, "running")
      )
    )
    .limit(1);

  if (runningClaim.length > 0) {
    return true;
  }

  const runningRun = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        eq(agentRuns.campaignId, campaignId),
        eq(agentRuns.agentType, "creative"),
        eq(agentRuns.status, "running")
      )
    )
    .limit(1);

  return runningRun.length > 0;
}

export async function onStrategyApproved(
  campaignId: number,
  userId: number,
  approvalId: number
) {
  const db = getDb();
  let [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  if (!campaign) return;

  const [business] = campaign.businessId
    ? await db
        .select()
        .from(businesses)
        .where(and(eq(businesses.id, campaign.businessId), eq(businesses.userId, userId)))
        .limit(1)
    : [null];

  // Defence in depth: the synchronous approval router already validates, but
  // the async trigger may run after a brief edit. Reject stale strategy
  // approvals before any credits or claims are consumed.
  const status = getStrategyApprovalStatus(campaign, business);
  const lineage = status.lineage;
  const currentFingerprint = status.currentFingerprint;

  if (!lineage) {
    console.error(`[Workflow] No strategy approval lineage for campaign ${campaignId}. Refusing to authorise creative generation.`);
    return;
  }

  if (lineage.approvalRequestId !== approvalId) {
    console.error(
      `[Workflow] Strategy approval lineage mismatch for campaign ${campaignId}: expected request ${lineage.approvalRequestId}, got ${approvalId}.`
    );
    return;
  }

  if (lineage.creativeBriefFingerprint !== currentFingerprint) {
    console.error(
      `[Workflow] Strategy approval fingerprint mismatch for campaign ${campaignId}. Refusing to authorise creative generation.`
    );
    return;
  }

  const [run] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, lineage.strategyRunId),
        eq(agentRuns.campaignId, campaignId),
        eq(agentRuns.userId, userId),
        eq(agentRuns.agentType, "strategy")
      )
    )
    .limit(1);

  if (!run || run.status !== "completed") {
    console.error(
      `[Workflow] Linked strategy run ${lineage.strategyRunId} is missing or not completed for campaign ${campaignId}. Refusing to authorise creative generation.`
    );
    return;
  }

  // A fingerprint match is not sufficient: the linked strategy output must still
  // be semantically grounded in the current brief. Pass the already-loaded run
  // to avoid a duplicate database query.
  const semanticValidation = await validateStrategyRunForCampaign(campaign, userId, run, business);
  if (!semanticValidation.valid) {
    console.error(
      `[Workflow] Linked strategy run ${lineage.strategyRunId} failed semantic validation for campaign ${campaignId}: ${semanticValidation.reason}. Refusing to authorise creative generation.`
    );
    return;
  }

  // 1. Persist the approved lineage and authorised fingerprint FIRST so the
  // function becomes idempotent: subsequent calls see an approved lineage and
  // will not double-spend credits or double-generate content.
  const needsApprovalPersistence =
    status.approvedStrategyFingerprint !== currentFingerprint ||
    lineage.status !== "approved";

  if (needsApprovalPersistence) {
    await db
      .update(campaigns)
      .set({
        workflowContext: {
          ...(campaign.workflowContext || {}),
          approvedStrategyFingerprint: currentFingerprint,
          strategyApprovalLineage: {
            ...lineage,
            status: "approved",
          },
        } as any,
      })
      .where(eq(campaigns.id, campaignId));

    // Only transition from the state that the approval action is valid for.
    // If the campaign has already advanced (e.g. a retry after partial failure),
    // the persisted lineage/fingerprint above is sufficient evidence.
    if (campaign.workflowState === "strategy_generated") {
      await transitionCampaignState(campaignId, userId, "approve_strategy");
    }

    const [reloadedCampaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    if (reloadedCampaign) {
      campaign = reloadedCampaign;
    }
  }

  // 2. Idempotent dedup: skip if creative generation has already succeeded for
  // THIS specific approval. The unique creative-success charge idempotency key is
  // the authoritative evidence; the content-post fallback covers pre-idempotency
  // historical runs.
  const alreadyGenerated = await hasSuccessfulCreativeGenerationForApproval(
    userId,
    campaignId,
    approvalId,
    currentFingerprint
  );
  if (alreadyGenerated) {
    console.log(`[Workflow] Successful creative generation already recorded for approval ${approvalId}; skipping duplicate`);
    return;
  }

  // 3. In-progress dedup: do not start a second concurrent generation for the
  // same approval.
  const inProgress = await hasInProgressCreativeGeneration(userId, campaignId, approvalId);
  if (inProgress) {
    console.log(`[Workflow] Creative generation already in progress for approval ${approvalId}; skipping duplicate`);
    return;
  }

  // 4. Cost control check BEFORE acquiring or re-arming a claim. A negative
  // result returns without touching claim state.
  const autoCheck = await canRunAutonomousWorkflow(userId, campaignId, {
    kind: "strategy_approval",
    continuationId: approvalId,
  });
  if (!autoCheck.allowed) {
    console.log(`[Workflow] Auto-creative blocked for campaign ${campaignId}: ${autoCheck.reason}`);
    return;
  }

  // 5. Governed immutable Strategy authority: resolve and verify the exact
  // approved WBS11 snapshot before any claim, provider spend or billing. This
  // is the same fail-closed chain the content-generation job runs; a failure
  // here refuses creative generation without consuming credits.
  let immutableStrategyInput: CreativeStrategySnapshotInput;
  try {
    immutableStrategyInput = await resolveCreativeEntryStrategyAuthority({
      campaign,
      userId,
      campaignId,
      business,
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(
      `[Workflow] Immutable Strategy authority resolution failed for campaign ${campaignId}: ${errorMessage}. Refusing to authorise creative generation.`
    );
    return;
  }

  // 6. Authoritative atomic claim for the auto-creative step of this approval.
  //    First try to re-arm a terminal orphan claim so historical evidence is
  //    preserved.  A terminal claim is only an orphan if no success evidence was
  //    found above; otherwise we would have already returned.
  const ownerToken = generateOwnerToken();
  const leaseExpiresAt = calculateLeaseExpiresAt(env.creativeGenerationRunningLeaseSeconds);

  const rearmResult = await rearmCreativeGenerationClaim({
    userId,
    campaignId,
    operationSource: "approval",
    operationReferenceId: approvalId,
    ownerToken,
    leaseExpiresAt,
  });

  let claim: CreativeGenerationClaim;
  if (rearmResult) {
    claim = rearmResult.claim;
    console.log(`[Workflow] Re-armed orphan creative generation claim ${claim.id} for campaign ${campaignId}; proceeding with recovery`);
  } else {
    const claimResult = await acquireCreativeGenerationClaim({
      userId,
      campaignId,
      operationSource: "approval",
      operationReferenceId: approvalId,
      ownerToken,
      leaseExpiresAt,
    });

    if (!claimResult.acquired) {
      // A concurrent caller may have re-armed the claim between our checks.
      // Only return an idempotent no-op if there is genuinely running work.
      const nowInProgress = await hasInProgressCreativeGeneration(userId, campaignId, approvalId);
      if (nowInProgress) {
        console.log(`[Workflow] Creative generation already in progress for approval ${approvalId}; skipping duplicate`);
        return;
      }
      // The existing terminal claim is still terminal and could not be re-armed.
      // This should not happen after the checks above, but we fail closed.
      throw new Error(
        `Unable to acquire or re-arm creative generation claim for campaign ${campaignId}: existing claim ${claimResult.existingClaim.id} is terminal with no success evidence`
      );
    }

    claim = claimResult.claim;
  }
  let released = false;
  let heartbeatController: CreativeGenerationClaimHeartbeatController | undefined;

  const releaseClaimOnce = async (status: "completed" | "failed") => {
    if (released) return { released: true } as const;
    released = true;
    if (heartbeatController) {
      await heartbeatController.stop();
    }
    return releaseClaimWithResult({
      claimId: claim.id,
      ownerToken,
      status,
      context: "workflow.onStrategyApproved",
    });
  };

  try {
    // Run Audience Intelligence after strategy approval to refine audience segments
    // before content generation. This is credit-safe: if no permissioned source data
    // exists, the agent returns early without calling the LLM.
    try {
      const access = await checkAudienceAgentAccess(userId, null);
      if (access.allowed) {
        const existingAiRun = await db
          .select()
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.campaignId, campaignId),
              eq(agentRuns.agentType, "audience"),
              eq(agentRuns.userId, userId)
            )
          )
          .orderBy(desc(agentRuns.createdAt))
          .limit(1);

        if (existingAiRun.length > 0 && ["running", "completed"].includes(existingAiRun[0].status)) {
          console.log(`[Workflow] Skipping duplicate audience-intelligence run for campaign ${campaignId}.`);
        } else {
          console.log(`[Workflow] Running audience-intelligence for campaign ${campaignId} before creative generation.`);
          await ingestAudienceData({ userId, businessId: campaign.businessId, campaignId });
          // WBS-R4 C0.2: stable billing identity for the strategy-approval
          // dispatch (Stream E contract §2); a restarted/replayed strategy
          // continuation re-enters under the same key and cannot double-charge.
          await runAudienceIntelligenceAgent({
            userId,
            campaignId,
            autoCreateLeads: false,
            billingIdentity: buildAudienceIntelligenceBillingIdentity({
              campaignId,
              continuationId: approvalId,
            }),
          });
        }
      }
    } catch (err: any) {
      console.error(`[Workflow] Audience-intelligence pre-creative failed for campaign ${campaignId}:`, err.message);
      // Continue to creative generation even if audience intelligence fails
    }

    // Transition to creatives_generating before running the creative agent
    await transitionCampaignState(campaignId, userId, "generate_creatives");

    // Keep the claim alive during the long-running creative generation.
    heartbeatController = createClaimHeartbeatController({
      claimId: claim.id,
      ownerToken,
      leaseSeconds: env.creativeGenerationRunningLeaseSeconds,
      heartbeatIntervalSeconds: env.creativeGenerationHeartbeatIntervalSeconds,
    });

    const workflowRegistry = new InMemoryWorkflowOperationRegistry();

    // Auto-trigger creative agent
    try {
      const result = await runCreativeAgent({
        userId,
        campaignId,
        generationOperation: { source: "approval", id: approvalId },
        strategyInput: immutableStrategyInput,
        claimContext: heartbeatController,
        registry: workflowRegistry,
      });
      await onAgentRunComplete(result.packRunId);
      const releaseResult = await releaseClaimOnce("completed");
      if (!releaseResult.released) {
        throw new Error(`Creative generation completed but the operation claim could not be released for campaign ${campaignId}.`);
      }
    } catch (err: any) {
      console.error(`[Workflow] Auto-creative failed | campaignId=${campaignId} | error="${err.message}"`);
      // Release failure is logged without ownerToken; preserve the original error.
      await releaseClaimOnce("failed");
    }
  } catch (err: any) {
    console.error(`[Workflow] onStrategyApproved failed | campaignId=${campaignId} | error="${err.message}"`);
    // Release failure is logged without ownerToken; preserve the original error.
    await releaseClaimOnce("failed");
  }
}
