import { z } from "zod";
import { createRouter, authedQuery, aiActionQuery } from "./middleware";
import { getDb } from "./queries/connection";
import {
  agentRuns,
  campaigns,
  businesses,
  socialProfiles,
  campaignInterestSignals,
  leadScores,
  outreachRecommendations,
  leads,
  leadActivities,
  contentPosts,
} from "@db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { runStrategyAgent } from "./lib/agents/strategy-agent";
import { runCreativeAgent } from "./lib/agents/creative-agent";
import { logError } from "./lib/logger";
import { runDistributionAgent } from "./lib/agents/distribution-agent";
import { runAudienceAgent } from "./lib/agents/audience-agent";
import { runAudienceIntelligenceAgent } from "./lib/agents/audience-intelligence-agent";
import { ingestAudienceData } from "./lib/audience/ingest";
import { checkAudienceAgentAccess } from "./lib/audience/access";
import { generateReply } from "./lib/agents/engagement-agent";
import { generateFollowUpSequence, generateProposal, generateMeetingPrompt } from "./lib/agents/sales-agent";
import { onAgentRunComplete } from "./lib/workflow/triggers";
import { transitionCampaignState } from "./lib/workflow/engine";
import { TRPCError } from "@trpc/server";
import {
  acquireCreativeGenerationClaim,
  attachCreativeGenerationOperationReference,
  generateOwnerToken,
  releaseClaimWithResult,
  calculateLeaseExpiresAt,
  createClaimHeartbeatController,
  type CreativeGenerationClaimHeartbeatController,
} from "./lib/creative/creative-generation-claim";
import { env } from "./lib/env";

export const agentRouter = createRouter({
  runStrategyAgent: aiActionQuery
    .input(
      z.object({
        campaignId: z.number(),
        strategyText: z.string().optional(),
        generate: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      // Verify campaign ownership
      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, input.campaignId),
            eq(campaigns.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      // Get business info
      const [business] = campaign.businessId
        ? await db
            .select()
            .from(businesses)
            .where(eq(businesses.id, campaign.businessId))
            .limit(1)
        : [null];

      if (!business) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Campaign must be linked to a business",
        });
      }

      // Confidence / evidence gate: do not generate strategy from unvalidated website data.
      const evidence = (business.websiteEvidence || null) as {
        businessCategory?: string;
        productsServices?: string[];
        confidence?: number;
      } | null;
      const confidence = evidence?.confidence ?? 0;
      if (evidence && confidence < 0.6) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Website understanding is not confident enough to generate strategy. " +
            "Please confirm your business category and products/services in the business profile.",
        });
      }

      // Prevent duplicate strategy runs
      const blockedStates = [
        "strategy_generated",
        "strategy_approved",
        "creatives_generating",
        "creatives_ready",
        "audience_generating",
        "audience_ready",
        "schedule_generated",
        "launch_approval_required",
        "campaign_live",
        "engagement_active",
        "leads_converting",
        "optimisation_active",
        "completed",
      ];
      if (blockedStates.includes(campaign.workflowState)) {
        return {
          success: true,
          skipped: true,
          reason: `Strategy already generated. Campaign is in "${campaign.workflowState}" state.`,
          runId: null,
          output: null,
        };
      }

      // Check for existing running or completed strategy run
      const existingRun = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, input.campaignId),
            eq(agentRuns.agentType, "strategy"),
            eq(agentRuns.userId, ctx.user.id)
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      if (existingRun.length > 0 && ["running", "completed"].includes(existingRun[0].status)) {
        // If completed but workflow wasn't advanced (e.g. onAgentRunComplete missed), trigger it now
        if (existingRun[0].status === "completed") {
          await onAgentRunComplete(existingRun[0].id);
        }
        return {
          success: true,
          skipped: true,
          reason: `A strategy agent run already exists with status "${existingRun[0].status}".`,
          runId: existingRun[0].id,
          output: existingRun[0].output as any,
        };
      }

      // Run strategy agent
      const result = await runStrategyAgent({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        business: {
          name: business.name,
          industry: business.industry,
          location: business.location,
          productOrService: business.productOrService,
          targetCustomer: business.targetCustomer,
          brandTone: business.brandTone,
          mainGoal: business.mainGoal,
          monthlyBudget: business.monthlyBudget,
          preferredPlatforms: business.preferredPlatforms,
          website: business.website,
          websiteEvidence: business.websiteEvidence,
        },
        strategyText: input.strategyText,
      });

      // Trigger workflow advancement
      await onAgentRunComplete(result.runId);

      return { success: true, runId: result.runId, output: result.output };
    }),

  runCreativeAgent: aiActionQuery
    .input(
      z.object({
        campaignId: z.number(),
        assetTypes: z
          .array(
            z.enum([
              "image",
              "video_script",
              "carousel",
              "ad_copy",
              "caption",
              "hashtag_set",
              "cta_variant",
              "email_copy",
              "whatsapp_copy",
              "video_concept",
              "reel_script",
              "carousel_ad",
              "whatsapp_promo",
              "lead_gen_ad",
              "launch_pack",
            ])
          )
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, input.campaignId),
            eq(campaigns.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      // Authoritative atomic claim for this direct creative-agent call.
      const ownerToken = generateOwnerToken();
      const claimResult = await acquireCreativeGenerationClaim({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        operationSource: "agent",
        ownerToken,
        leaseExpiresAt: calculateLeaseExpiresAt(env.creativeGenerationRunningLeaseSeconds),
      });

      if (!claimResult.acquired) {
        const existingRunId = claimResult.existingClaim.operationReferenceId;
        return {
          success: true,
          skipped: true,
          reason: claimResult.existingClaim.operationReferenceId
            ? `A creative agent run already exists (operation ${existingRunId}).`
            : "A creative generation operation is already being prepared for this campaign.",
          packRunId: existingRunId,
          assetsRunId: null,
          pack: null,
          assets: null,
          savedPosts: 0,
          savedAssets: 0,
        };
      }

      const claim = claimResult.claim;
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
          context: "agentRouter.runCreativeAgent",
        });
      };

      const attachAndReleaseShortcutClaim = async (
        operationReferenceId: number,
        terminalStatus: "completed" | "failed"
      ) => {
        if (released) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Operation claim was already released; cannot complete shortcut.",
          });
        }

        let attachSucceeded = false;
        try {
          const attachResult = await attachCreativeGenerationOperationReference({
            claimId: claim.id,
            ownerToken,
            operationReferenceId,
          });
          attachSucceeded = attachResult.attached;
        } catch (attachErr) {
          logError(
            "[agentRouter.runCreativeAgent] failed to attach operation reference before shortcut release",
            {
              campaignId: input.campaignId,
              userId: ctx.user.id,
              claimId: claim.id,
              operationReferenceId,
              error: attachErr instanceof Error ? attachErr.message : String(attachErr),
            }
          );
        }

        if (!attachSucceeded) {
          // Attachment failed or reported a collision. Fail closed: release the
          // newly acquired claim as failed and do not return a successful/skipped
          // shortcut or continue to the normal terminal release.
          await releaseClaimOnce("failed");
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "Could not record the operation reference for this generation request. Please retry.",
          });
        }

        const releaseResult = await releaseClaimOnce(terminalStatus);
        if (!releaseResult.released) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "The operation could not be closed cleanly. Please retry.",
          });
        }
      };

      try {
        // Advisory dedup: an existing controlling creative operation may already be
        // active, or may have completed and produced durable content. Nested inner
        // runAgent rows also have agentType="creative" but are not authoritative
        // controlling operations, so they must not satisfy this guard.
        const existingCreative = await db
          .select()
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.campaignId, input.campaignId),
              eq(agentRuns.agentType, "creative"),
              eq(agentRuns.userId, ctx.user.id)
            )
          )
          .orderBy(desc(agentRuns.createdAt));

        const existingRun = existingCreative.find((run) => {
          const runInput = (run as any).input as Record<string, unknown> | undefined;
          // Only outer controlling operations are authoritative. Rows with no input,
          // malformed input, or inner runAgent input shapes must not suppress
          // generation; they fail open for retry.
          return runInput?.jobType === "content_generation_job";
        });

        const contentPostRows = await db
          .select({ id: contentPosts.id })
          .from(contentPosts)
          .where(
            and(
              eq(contentPosts.userId, ctx.user.id),
              eq(contentPosts.campaignId, input.campaignId),
              eq(contentPosts.aiGenerated, true)
            )
          );
        const contentPostCount = contentPostRows.length;
        const runOutput = (existingRun?.output as Record<string, unknown> | undefined) ?? {};
        const outputSavedPosts =
          typeof runOutput.savedPosts === "number" ? runOutput.savedPosts : null;

        if (existingRun) {
          if (existingRun.status === "running") {
            // No durable output exists yet; release the no-work claim as failed and
            // record the running operation reference.
            await attachAndReleaseShortcutClaim(existingRun.id, "failed");
            return {
              success: true,
              skipped: true,
              reason: "A creative generation operation is already in progress.",
              packRunId: existingRun.id,
              assetsRunId: null,
              pack: null,
              assets: null,
              savedPosts: 0,
              savedAssets: 0,
            };
          }

          if (
            existingRun.status === "completed" &&
            outputSavedPosts !== null &&
            outputSavedPosts > 0 &&
            contentPostCount >= outputSavedPosts
          ) {
            // Durable output and matching persisted posts exist; safe reuse.
            await attachAndReleaseShortcutClaim(existingRun.id, "completed");
            return {
              success: true,
              skipped: true,
              reason: "Creative content already exists for this campaign.",
              packRunId: existingRun.id,
              assetsRunId: null,
              pack: null,
              assets: null,
              savedPosts: 0,
              savedAssets: 0,
            };
          }

          // completed with zero/missing saved posts, or failed → allow retry
        }

        // Keep the claim alive during the long-running creative generation. Started
        // after advisory dedup so short-circuit paths do not schedule heartbeats.
        heartbeatController = createClaimHeartbeatController({
          claimId: claim.id,
          ownerToken,
          leaseSeconds: env.creativeGenerationRunningLeaseSeconds,
          heartbeatIntervalSeconds: env.creativeGenerationHeartbeatIntervalSeconds,
        });

        // Persist an outer creative-operation row so billing and dedup have a stable
        // identity for this direct-agent call that is distinct from the nested
        // model-execution run rows created by runAgent inside runCreativeAgent.
        const [operationInsert] = await db.insert(agentRuns).values({
          userId: ctx.user.id,
          campaignId: input.campaignId,
          agentType: "creative",
          status: "running",
          input: {
            jobType: "content_generation_job",
            source: "agent_router",
          } as any,
          startedAt: new Date(),
        });
        const operationRowId = Number((operationInsert as any).insertId);

        const attachResult = await attachCreativeGenerationOperationReference({
          claimId: claim.id,
          ownerToken,
          operationReferenceId: operationRowId,
        });

        if (!attachResult.attached) {
          // The outer row id collided with an existing operation reference.
          // Release our row and claim, then report reuse.
          await db
            .update(agentRuns)
            .set({ status: "failed", error: "operation reference collision", completedAt: new Date() })
            .where(eq(agentRuns.id, operationRowId));
          const releaseResult = await releaseClaimOnce("failed");
          if (!releaseResult.released) {
            logError("[agentRouter.runCreativeAgent] failed-release failed after reference collision", {
              campaignId: input.campaignId,
              userId: ctx.user.id,
              claimId: claim.id,
              releaseError: releaseResult.error.message,
            });
          }
          return {
            success: false,
            skipped: true,
            packRunId: attachResult.existingClaim.operationReferenceId ?? null,
          };
        }

        // Transition campaign to creatives_generating before starting
        try {
          await transitionCampaignState(input.campaignId, ctx.user.id, "generate_creatives");
        } catch {
          // If transition fails (wrong current state), continue anyway and let the agent run
        }

        let result: Awaited<ReturnType<typeof runCreativeAgent>> | undefined;
        try {
          result = await runCreativeAgent({
            userId: ctx.user.id,
            campaignId: input.campaignId,
            generationOperation: { source: "agent", id: operationRowId },
            claimContext: heartbeatController,
          });
        } catch (err: any) {
          await db
            .update(agentRuns)
            .set({
              status: "failed",
              error: err?.message || String(err),
              completedAt: new Date(),
            })
            .where(eq(agentRuns.id, operationRowId));
          // Release failure is logged without ownerToken; preserve the original
          // generation error as the primary failure returned to the caller.
          await releaseClaimOnce("failed");
          throw err;
        }

        await db
          .update(agentRuns)
          .set({
            status: "completed",
            completedAt: new Date(),
            output: {
              success: true,
              packRunId: result!.packRunId,
              savedPosts: result!.savedPosts,
              savedAssets: result!.savedAssets,
            } as any,
          })
          .where(eq(agentRuns.id, operationRowId));

        const releaseResult = await releaseClaimOnce("completed");
        if (!releaseResult.released) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "Creative generation completed, but the operation could not be closed cleanly. Please retry.",
          });
        }

        // Trigger workflow advancement asynchronously so the HTTP response is fast
        Promise.resolve().then(() =>
          onAgentRunComplete(result.packRunId).catch((err) => {
            console.error("[AgentRouter] onAgentRunComplete failed:", err.message);
          })
        );

        return { success: true, skipped: false, ...result };
      } catch (err) {
        // Ensure the claim is released on any unexpected error path not handled above.
        // Preserve the original error; release failure is logged without ownerToken.
        await releaseClaimOnce("failed");
        throw err;
      }
    }),

  runAudienceAgent: aiActionQuery
    .input(
      z.object({
        campaignId: z.number(),
        isB2B: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, input.campaignId),
            eq(campaigns.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      // Deduplication guard
      const existingAudience = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, input.campaignId),
            eq(agentRuns.agentType, "audience"),
            eq(agentRuns.userId, ctx.user.id)
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      if (existingAudience.length > 0 && ["running", "completed"].includes(existingAudience[0].status)) {
        return {
          success: true,
          skipped: true,
          reason: `An audience agent run already exists with status "${existingAudience[0].status}".`,
          runId: existingAudience[0].id,
          output: existingAudience[0].output as any,
        };
      }

      const result = await runAudienceAgent({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        isB2B: input.isB2B,
      });

      // Trigger workflow advancement asynchronously
      Promise.resolve().then(() =>
        onAgentRunComplete(result.runId).catch((err) => {
          console.error("[AgentRouter] onAgentRunComplete failed:", err.message);
        })
      );

      return { success: true, ...result };
    }),

  runDistributionAgent: aiActionQuery
    .input(z.object({ campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, input.campaignId),
            eq(campaigns.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      // Deduplication guard
      const existingDist = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, input.campaignId),
            eq(agentRuns.agentType, "distribution"),
            eq(agentRuns.userId, ctx.user.id)
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      if (existingDist.length > 0 && ["running", "completed"].includes(existingDist[0].status)) {
        return {
          success: true,
          skipped: true,
          reason: `A distribution agent run already exists with status "${existingDist[0].status}".`,
          runId: existingDist[0].id,
          output: existingDist[0].output as any,
        };
      }

      const result = await runDistributionAgent({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        approvalMode: campaign.approvalMode as "assisted" | "autonomous",
      });

      // Trigger workflow advancement asynchronously
      Promise.resolve().then(() =>
        onAgentRunComplete(result.runId).catch((err) => {
          console.error("[AgentRouter] onAgentRunComplete failed:", err.message);
        })
      );

      return { success: true, ...result };
    }),

  runEngagementAgent: aiActionQuery
    .input(
      z.object({
        campaignId: z.number().optional(),
        threadId: z.number().optional(),
        messageText: z.string().optional(),
        platform: z.string().optional(),
        externalThreadId: z.string().optional(),
        businessName: z.string().optional(),
        productOrService: z.string().optional(),
        brandTone: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.threadId && input.messageText) {
        const result = await generateReply({
          userId: ctx.user.id,
          campaignId: input.campaignId || 0,
          threadId: input.threadId,
          messageText: input.messageText,
          platform: input.platform || "general",
          businessContext: {
            name: input.businessName || "Your Business",
            productOrService: input.productOrService,
            brandTone: input.brandTone,
          },
        });
        return { success: true, ...result };
      }

      return { success: false, message: "Provide threadId and messageText" };
    }),

  runSalesAgent: aiActionQuery
    .input(
      z.object({
        campaignId: z.number(),
        leadId: z.number(),
        action: z.enum(["follow_up", "proposal", "meeting"]).default("follow_up"),
        channel: z.enum(["email", "whatsapp", "sms"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.action === "follow_up") {
        const result = await generateFollowUpSequence({
          userId: ctx.user.id,
          campaignId: input.campaignId,
          leadId: input.leadId,
          channel: input.channel || "email",
        });
        return { success: true, ...result };
      }

      if (input.action === "proposal") {
        const result = await generateProposal({
          userId: ctx.user.id,
          campaignId: input.campaignId,
          leadId: input.leadId,
        });
        return { success: true, ...result };
      }

      if (input.action === "meeting") {
        const result = await generateMeetingPrompt({
          userId: ctx.user.id,
          campaignId: input.campaignId,
          leadId: input.leadId,
        });
        return { success: true, ...result };
      }

      return { success: false, message: "Unknown action" };
    }),

  runOptimisationAgent: aiActionQuery
    .input(z.object({ campaignId: z.number().optional() }))
    .mutation(async () => {
      // Stub for Phase 5
      return { success: false, message: "Optimisation Agent coming in Phase 5" };
    }),

  runAudienceIntelligence: aiActionQuery
    .input(
      z.object({
        campaignId: z.number(),
        ingest: z.boolean().default(true),
        autoCreateLeads: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, input.campaignId),
            eq(campaigns.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      // Tier / admin gate
      const access = await checkAudienceAgentAccess(ctx.user.id, ctx.user.role);
      if (!access.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: access.reason || "Audience Intelligence is not available on your plan.",
        });
      }

      // Deduplication guard
      const existingRun = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, input.campaignId),
            eq(agentRuns.agentType, "audience"),
            eq(agentRuns.userId, ctx.user.id),
            eq(agentRuns.status, "running")
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      if (existingRun.length > 0) {
        return {
          success: true,
          skipped: true,
          reason: "An audience intelligence run is already in progress.",
          runId: existingRun[0].id,
        };
      }

      // Ingest permissioned data
      let ingestionSummary: {
        profilesSynced: number;
        eventsSynced: number;
        signalsGenerated: number;
        warnings: string[];
      } = { profilesSynced: 0, eventsSynced: 0, signalsGenerated: 0, warnings: [] };

      if (input.ingest) {
        ingestionSummary = await ingestAudienceData({
          userId: ctx.user.id,
          businessId: campaign.businessId,
          campaignId: input.campaignId,
        });
      }

      // Run the agent
      const result = await runAudienceIntelligenceAgent({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        autoCreateLeads: input.autoCreateLeads,
      });

      return {
        success: true,
        runId: result.runId,
        output: result.output,
        createdLeadIds: result.createdLeadIds,
        ingestionSummary,
      };
    }),

  getAudienceIntelligence: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, input.campaignId),
            eq(campaigns.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      // Tier / admin gate: return locked state instead of crashing
      const access = await checkAudienceAgentAccess(ctx.user.id, ctx.user.role);
      if (!access.allowed) {
        return {
          campaign,
          latestRun: null,
          profiles: [],
          signals: [],
          scores: [],
          recommendations: [],
          createdLeads: [],
          locked: true,
          reason: access.reason || "Audience Intelligence is not available on your plan.",
        };
      }

      const [latestRun] = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, input.campaignId),
            eq(agentRuns.agentType, "audience"),
            eq(agentRuns.userId, ctx.user.id)
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      const profiles = await db
        .select()
        .from(socialProfiles)
        .where(
          and(
            eq(socialProfiles.userId, ctx.user.id),
            eq(socialProfiles.campaignId, input.campaignId)
          )
        );

      const signals = await db
        .select()
        .from(campaignInterestSignals)
        .where(
          and(
            eq(campaignInterestSignals.userId, ctx.user.id),
            eq(campaignInterestSignals.campaignId, input.campaignId)
          )
        )
        .orderBy(campaignInterestSignals.strength);

      const scores = await db
        .select()
        .from(leadScores)
        .where(
          and(
            eq(leadScores.userId, ctx.user.id),
            eq(leadScores.campaignId, input.campaignId)
          )
        )
        .orderBy(leadScores.score);

      const recommendations = await db
        .select()
        .from(outreachRecommendations)
        .where(
          and(
            eq(outreachRecommendations.userId, ctx.user.id),
            eq(outreachRecommendations.campaignId, input.campaignId)
          )
        )
        .orderBy(outreachRecommendations.priority);

      const createdLeadIds = scores.map((s) => s.leadId).filter(Boolean) as number[];
      const createdLeads = createdLeadIds.length
        ? await db
            .select()
            .from(leads)
            .where(
              and(
                eq(leads.userId, ctx.user.id),
                inArray(leads.id, createdLeadIds)
              )
            )
        : [];

      return {
        campaign,
        latestRun,
        profiles,
        signals,
        scores,
        recommendations,
        createdLeads,
      };
    }),

  acceptRecommendation: aiActionQuery
    .input(z.object({ recommendationId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [recommendation] = await db
        .select()
        .from(outreachRecommendations)
        .where(
          and(
            eq(outreachRecommendations.id, input.recommendationId),
            eq(outreachRecommendations.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!recommendation) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Recommendation not found" });
      }

      if (recommendation.acceptedAt) {
        return { success: true, leadId: recommendation.leadId };
      }

      const [score] = await db
        .select()
        .from(leadScores)
        .where(
          and(
            eq(leadScores.id, recommendation.leadScoreId),
            eq(leadScores.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!score) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Lead score not found" });
      }

      let leadId = recommendation.leadId;

      if (!leadId) {
        // Check for existing lead by external identifier
        const existing = await db
          .select()
          .from(leads)
          .where(
            and(
              eq(leads.userId, ctx.user.id),
              eq(leads.campaignId, recommendation.campaignId)
            )
          );

        const matched = existing.find(
          (l) =>
            (l.customFields as Record<string, unknown> | null)?.externalIdentifier ===
            score.externalIdentifier
        );

        if (matched) {
          leadId = matched.id;
        } else {
          const [insertResult] = await db.insert(leads).values({
            userId: ctx.user.id,
            businessId: recommendation.businessId,
            campaignId: recommendation.campaignId,
            name: score.displayName || score.handle || `Lead from ${score.platform}`,
            source: score.platform,
            score: score.score,
            status: "new",
            notes: score.explanation,
            customFields: {
              externalIdentifier: score.externalIdentifier,
              handle: score.handle,
              platform: score.platform,
              discoveredBy: "audience_intelligence_agent",
            },
          });
          leadId = Number(insertResult.insertId);

          await db.insert(leadActivities).values({
            leadId,
            type: "note",
            description: `Accepted from Audience Intelligence recommendation (score ${score.score}, confidence ${score.confidence}). ${score.explanation}`,
          });
        }
      }

      await db
        .update(outreachRecommendations)
        .set({ acceptedAt: new Date(), leadId })
        .where(eq(outreachRecommendations.id, recommendation.id));

      await db
        .update(leadScores)
        .set({ leadId })
        .where(eq(leadScores.id, score.id));

      return { success: true, leadId };
    }),

  getAgentRuns: authedQuery
    .input(
      z
        .object({
          campaignId: z.number().optional(),
          agentType: z
            .enum([
              "strategy",
              "creative",
              "audience",
              "distribution",
              "engagement",
              "sales",
              "optimisation",
            ])
            .optional(),
          status: z.enum(["pending", "running", "completed", "failed"]).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      let query = db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.userId, ctx.user.id))
        .orderBy(desc(agentRuns.createdAt));

      // Note: Drizzle doesn't support dynamic WHERE chaining easily without query builder
      // For simplicity, we fetch all and filter in memory
      const results = await query;

      return results.filter((run) => {
        if (input?.campaignId && run.campaignId !== input.campaignId) return false;
        if (input?.agentType && run.agentType !== input.agentType) return false;
        if (input?.status && run.status !== input.status) return false;
        return true;
      });
    }),
});
