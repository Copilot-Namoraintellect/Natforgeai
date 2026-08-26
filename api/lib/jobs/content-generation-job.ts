import { TRPCError } from "@trpc/server";
import { and, count, desc, eq } from "drizzle-orm";
import { agentRuns, campaignAssets, campaigns, contentPosts } from "@db/schema";
import { getDb } from "../../queries/connection";
import { runCreativeAgent } from "../agents/creative-agent";
import { ensureApprovedMessagePack, saveApprovedMessagePack } from "../creative/campaign-message-architect";
import { logError, logInfo } from "../logger";
import { onAgentRunComplete } from "../workflow/triggers";
import {
  releaseClaimWithResult,
  createClaimHeartbeatController,
  type CreativeGenerationClaimHeartbeatController,
} from "../creative/creative-generation-claim";
import { env } from "../env";
import { assertApprovedStrategySemanticallyValid } from "../workflow/strategy-approval";
import { InMemoryWorkflowOperationRegistry } from "../workflow/workflow-operation";

export interface ContentGenerationJobInput {
  jobId: number;
  userId: number;
  campaignId: number;
  regenerate?: boolean;
  claimId?: number;
  ownerToken?: string;
}

export interface ContentGenerationDurations {
  messageArchitectDurationMs: number;
  creativeGenerationDurationMs: number;
  qualityRetryDurationMs: number;
  fallbackDurationMs: number;
  totalDurationMs: number;
}

function defaultDurations(): ContentGenerationDurations {
  return {
    messageArchitectDurationMs: 0,
    creativeGenerationDurationMs: 0,
    qualityRetryDurationMs: 0,
    fallbackDurationMs: 0,
    totalDurationMs: 0,
  };
}

function toSafeContentJobFailureMessage(err: unknown): string {
  if (err instanceof TRPCError) return err.message;
  const msg = (err as any)?.message ? String((err as any).message) : "";
  if (!msg) {
    return "Content generation failed before creatives were saved. No credits were charged. Please retry.";
  }
  return msg;
}

function validateClaimInput(
  input: ContentGenerationJobInput
): asserts input is ContentGenerationJobInput & { claimId: number; ownerToken: string } {
  if (
    typeof input.claimId !== "number" ||
    !Number.isFinite(input.claimId) ||
    !Number.isInteger(input.claimId) ||
    input.claimId <= 0
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Content generation job is missing a valid claimId",
    });
  }
  if (typeof input.ownerToken !== "string" || input.ownerToken.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Content generation job is missing a valid ownerToken",
    });
  }
}

export async function processContentGenerationJob(input: ContentGenerationJobInput): Promise<void> {
  validateClaimInput(input);

  const db = getDb();
  const totalStartedAt = Date.now();
  let released = false;
  let heartbeatController: CreativeGenerationClaimHeartbeatController | undefined;

  const releaseClaimOnce = async (status: "completed" | "failed") => {
    if (released) return { released: true } as const;
    released = true;
    if (heartbeatController) {
      await heartbeatController.stop();
    }
    return releaseClaimWithResult({
      claimId: input.claimId!,
      ownerToken: input.ownerToken!,
      status,
      context: "processContentGenerationJob",
    });
  };

  const markFailed = async (errorMessage: string, durations: ContentGenerationDurations) => {
    await db
      .update(agentRuns)
      .set({
        status: "failed",
        error: errorMessage,
        completedAt: new Date(),
        output: {
          success: false,
          campaignId: input.campaignId,
          jobType: "content_generation_job",
          durations,
        } as any,
      })
      .where(eq(agentRuns.id, input.jobId));
  };

  const durations = defaultDurations();

  // Load the campaign and verify the approved strategy still matches the
  // current brief before marking the job running. This keeps stale-strategy
  // rejections free of side effects on the job row.
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.userId, input.userId)))
    .limit(1);

  if (campaign) {
    await assertApprovedStrategySemanticallyValid(campaign, input.userId);
  }

  await db
    .update(agentRuns)
    .set({
      status: "running",
      startedAt: new Date(),
    })
    .where(eq(agentRuns.id, input.jobId));

  heartbeatController = createClaimHeartbeatController({
    claimId: input.claimId,
    ownerToken: input.ownerToken,
    leaseSeconds: env.creativeGenerationRunningLeaseSeconds,
    heartbeatIntervalSeconds: env.creativeGenerationHeartbeatIntervalSeconds,
  });

  try {
    if (!campaign) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Campaign not found or you do not have access to it.",
      });
    }

    const eligibleStates = ["strategy_approved", "creatives_generating", "creatives_ready"];
    if (!eligibleStates.includes(campaign.workflowState)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Cannot generate content while campaign is in \"${campaign.workflowState}\" state. Approve the strategy first.`,
      });
    }

    if (!campaign.businessId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Campaign is not linked to a business. Complete business onboarding first.",
      });
    }

    const personas = campaign.personas as any[] | null | undefined;
    const hasCreativeContext =
      campaign.coreMessage ||
      (campaign.workflowContext as any)?.coreMessage ||
      (campaign.workflowContext as any)?.valueProposition ||
      (personas && Array.isArray(personas) && personas.length > 0);

    if (!hasCreativeContext) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "Campaign is missing creative context (core message, personas, or approved strategy). Generate and approve a strategy first.",
      });
    }

    const workflowRegistry = new InMemoryWorkflowOperationRegistry();

    const [existingPostCountResult] = await db
      .select({ value: count() })
      .from(contentPosts)
      .where(and(eq(contentPosts.userId, input.userId), eq(contentPosts.campaignId, input.campaignId)));
    const existingPostCount = existingPostCountResult?.value ?? 0;

    const [existingMessagePack] =
      existingPostCount > 0
        ? await db
            .select({ metadata: campaignAssets.metadata })
            .from(campaignAssets)
            .where(
              and(
                eq(campaignAssets.userId, input.userId),
                eq(campaignAssets.campaignId, input.campaignId),
                eq(campaignAssets.assetType, "message_pack" as any)
              )
            )
            .orderBy(desc(campaignAssets.createdAt))
            .limit(1)
        : [null];

    const hasValidMessagePack =
      existingMessagePack?.metadata && (existingMessagePack.metadata as any)?.passed === true;

    if (existingPostCount > 0 && !input.regenerate) {
      if (campaign.workflowState === "creatives_generating") {
        await db
          .update(campaigns)
          .set({
            workflowState: "creatives_ready",
            workflowContext: {
              ...(campaign.workflowContext || {}),
              repairedAt: new Date().toISOString(),
              repairedReason: "existing_content_posts_found",
            } as any,
            updatedAt: new Date(),
          })
          .where(eq(campaigns.id, input.campaignId));
      }

      durations.totalDurationMs = Date.now() - totalStartedAt;
      await db
        .update(agentRuns)
        .set({
          status: "completed",
          completedAt: new Date(),
          output: {
            success: true,
            idempotent: true,
            postCount: existingPostCount,
            hasValidMessagePack,
            campaignId: input.campaignId,
            jobType: "content_generation_job",
            durations,
          } as any,
        })
        .where(eq(agentRuns.id, input.jobId));
      const releaseResult = await releaseClaimOnce("completed");
      if (!releaseResult.released) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Existing content was found, but the operation could not be closed cleanly. Please retry.",
        });
      }
      return;
    }

    if (input.regenerate && campaign.businessId) {
      const regenStart = Date.now();
      try {
        const freshPack = await ensureApprovedMessagePack({
          userId: input.userId,
          campaignId: input.campaignId,
          skipBilling: true,
          maxAttempts: 2,
          forceRebuild: true,
          registry: workflowRegistry,
        });
        if (freshPack.validation.passed) {
          await saveApprovedMessagePack(input.userId, input.campaignId, freshPack);
        }
      } catch (regenErr: any) {
        logError("[content.job] failed to regenerate message pack", {
          campaignId: input.campaignId,
          userId: input.userId,
          error: regenErr.message,
        });
      }
      durations.messageArchitectDurationMs += Date.now() - regenStart;
    }

    const creativeResult = await runCreativeAgent({
      userId: input.userId,
      campaignId: input.campaignId,
      generationOperation: { source: "job", id: input.jobId },
      claimContext: heartbeatController,
      registry: workflowRegistry,
    });

    if (creativeResult.savedPosts > 0 && campaign.workflowState !== "creatives_ready") {
      await db
        .update(campaigns)
        .set({
          workflowState: "creatives_ready",
          workflowContext: {
            ...(campaign.workflowContext || {}),
            creativeGeneratedAt: new Date().toISOString(),
            creativeRunId: creativeResult.packRunId,
            savedPosts: creativeResult.savedPosts,
            savedAssets: creativeResult.savedAssets,
          } as any,
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, input.campaignId));
    }

    try {
      await onAgentRunComplete(creativeResult.packRunId);
    } catch (triggerErr: any) {
      logError("[content.job] workflow trigger failed", {
        campaignId: input.campaignId,
        userId: input.userId,
        packRunId: creativeResult.packRunId,
        error: triggerErr.message || String(triggerErr),
      });
    }

    if (creativeResult.savedPosts === 0) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "The Creative Agent ran but no posts were saved. Please retry or contact support if the issue persists.",
      });
    }

    const agentMetrics = (creativeResult as any).metrics || {};
    durations.messageArchitectDurationMs += Number(agentMetrics.messageArchitectDurationMs || 0);
    durations.creativeGenerationDurationMs += Number(agentMetrics.creativeGenerationDurationMs || 0);
    durations.qualityRetryDurationMs += Number(agentMetrics.qualityRetryDurationMs || 0);
    durations.fallbackDurationMs += Number(agentMetrics.fallbackDurationMs || 0);
    durations.totalDurationMs = Date.now() - totalStartedAt;

    await db
      .update(agentRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        output: {
          success: true,
          campaignId: input.campaignId,
          postCount: creativeResult.savedPosts,
          savedAssets: creativeResult.savedAssets,
          creativeRunId: creativeResult.packRunId,
          jobType: "content_generation_job",
          durations,
        } as any,
      })
      .where(eq(agentRuns.id, input.jobId));

    logInfo("[content.job] completed", {
      campaignId: input.campaignId,
      userId: input.userId,
      jobId: input.jobId,
    });

    const releaseResult = await releaseClaimOnce("completed");
    if (!releaseResult.released) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "Content generation completed, but the operation could not be closed cleanly. Please retry.",
      });
    }
  } catch (err: any) {
    durations.totalDurationMs = Date.now() - totalStartedAt;
    const message = toSafeContentJobFailureMessage(err);
    logError("[content.job] failed", {
      campaignId: input.campaignId,
      userId: input.userId,
      jobId: input.jobId,
      error: err?.message || String(err),
      safeError: message,
    });
    await markFailed(message, durations);

    // Release failure is logged without ownerToken; preserve the original error.
    await releaseClaimOnce("failed");

    throw err instanceof Error ? err : new Error(message);
  }
}
