import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { campaigns, businesses, approvalRequests, agentRuns } from "@db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { checkLimit, incrementCampaignUsage } from "./lib/subscription";
import { transitionCampaignState, getWorkflowState } from "./lib/workflow/engine";
import {
  parseNextCycleInstruction,
  type NextCycleInstruction,
} from "./lib/learning/learning-strategy-consumption";

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

export const autonomousWorkflowRouter = createRouter({
  startCampaignWorkflow: authedQuery
    .input(
      z.object({
        businessId: z.number(),
        name: z.string().min(1),
        goal: z.string().min(1),
        strategyText: z.string().optional(),
        approvalMode: z.enum(["assisted", "autonomous"]).default("assisted"),
        autoPublish: z.boolean().default(false),
        idempotencyKey: z.string().min(8).max(128).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      // WBS-R4 A1-3: idempotent campaign bootstrap. A replayed start with a
      // previously persisted bootstrap key returns the original campaign
      // without inserting a row or consuming campaign usage.
      if (input.idempotencyKey) {
        const [existingBootstrap] = await db
          .select()
          .from(campaigns)
          .where(
            and(
              eq(campaigns.userId, ctx.user.id),
              sql`JSON_UNQUOTE(JSON_EXTRACT(${campaigns.workflowContext}, '$.bootstrapIdempotencyKey')) = ${input.idempotencyKey}`
            )
          )
          .limit(1);

        if (existingBootstrap) {
          const existingContext = parseWorkflowContextObject(
            existingBootstrap.workflowContext
          );
          if (existingContext.bootstrapIdempotencyKey === input.idempotencyKey) {
            return {
              id: existingBootstrap.id,
              success: true,
              idempotentReplay: true,
            };
          }
        }
      }

      // Check campaign limit
      const campaignCheck = await checkLimit(ctx.user.id, "campaign");
      if (!campaignCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: campaignCheck.reason!,
        });
      }

      // Verify business ownership
      const [business] = await db
        .select()
        .from(businesses)
        .where(and(eq(businesses.id, input.businessId), eq(businesses.userId, ctx.user.id)))
        .limit(1);

      if (!business) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Business not found" });
      }

      // Create campaign with workflow state
      const [camp] = await db.insert(campaigns).values({
        userId: ctx.user.id,
        businessId: input.businessId,
        name: input.name,
        goal: input.goal,
        status: "draft",
        workflowState: "strategy_pending",
        workflowContext: {
          startedAt: new Date().toISOString(),
          strategyText: input.strategyText,
          ...(input.idempotencyKey
            ? { bootstrapIdempotencyKey: input.idempotencyKey }
            : {}),
        } as any,
        approvalMode: input.approvalMode,
        autoPublish: input.autoPublish,
        aiGenerated: true,
      });

      await incrementCampaignUsage(ctx.user.id);

      const campaignId = Number(camp.insertId);

      // If strategy text provided, auto-trigger strategy agent
      if (input.strategyText) {
        // This will be triggered by the frontend or a background job
        // For now, we just set the state
      }

      return { id: campaignId, success: true };
    }),

  pauseCampaignWorkflow: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await transitionCampaignState(input.campaignId, ctx.user.id, "pause");
      return { success: true };
    }),

  resumeCampaignWorkflow: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await transitionCampaignState(input.campaignId, ctx.user.id, "resume");
      return { success: true };
    }),

  getWorkflowStatus: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();

      const workflow = await getWorkflowState(input.campaignId, ctx.user.id);

      // Get pending approvals
      const pendingApprovals = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.campaignId, input.campaignId),
            eq(approvalRequests.userId, ctx.user.id),
            eq(approvalRequests.status, "pending")
          )
        )
        .orderBy(desc(approvalRequests.createdAt));

      // Get recent agent runs
      const recentRuns = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, input.campaignId),
            eq(agentRuns.userId, ctx.user.id)
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(10);

      return {
        ...workflow,
        pendingApprovals,
        recentAgentRuns: recentRuns,
      };
    }),

  // WBS-R4 A4-3: governed recovery for a stuck next-cycle dispatch. A "ready"
  // instruction is dispatched directly; a "failed" instruction is CAS-retried
  // back to "ready" (exact instructionId) and then dispatched. Everything is
  // idempotent: retries collapse onto the durable instruction authority.
  retryNextCycleDispatch: authedQuery
    .input(z.object({ campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [campaign] = await db
        .select({ id: campaigns.id, workflowContext: campaigns.workflowContext })
        .from(campaigns)
        .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.userId, ctx.user.id)))
        .limit(1);

      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }

      const context = parseWorkflowContextObject(campaign.workflowContext);
      const rawNextCycle = context.nextCycle;
      if (rawNextCycle === undefined) {
        return { outcome: "noop" as const, status: null };
      }

      let instruction: NextCycleInstruction;
      try {
        instruction = parseNextCycleInstruction(rawNextCycle);
      } catch {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Campaign records a malformed next-cycle instruction; refusing to dispatch.",
        });
      }

      if (instruction.status === "dispatched") {
        return { outcome: "noop" as const, status: "dispatched" as const };
      }

      if (instruction.status === "ready") {
        try {
          const { dispatchNextCycleInstruction } = await import(
            "./lib/workflow/next-cycle-dispatcher"
          );
          const result = await dispatchNextCycleInstruction({
            userId: ctx.user.id,
            campaignId: input.campaignId,
            instructionId: instruction.instructionId,
          });
          if (result.outcome === "already_dispatched") {
            return { outcome: "noop" as const, status: "dispatched" as const };
          }
          return {
            outcome: "dispatched" as const,
            instructionId: result.instructionId,
            strategyRunId: result.strategyRunId,
            approvalRequestId: result.approvalRequestId,
          };
        } catch (err) {
          return {
            outcome: "dispatch_failed" as const,
            status: "ready" as const,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      // status === "failed": governed CAS retry to "ready", then dispatch.
      const { retryFailedNextCycleInstruction } = await import(
        "./lib/workflow/next-cycle-persistence"
      );
      const retry = await retryFailedNextCycleInstruction({
        userId: ctx.user.id,
        campaignId: input.campaignId,
        instructionId: instruction.instructionId,
      });
      if (!retry || !retry.retried) {
        return {
          outcome: "noop" as const,
          status: "failed" as const,
          reason: retry?.reason ?? "campaign not found",
        };
      }

      try {
        const { dispatchNextCycleInstruction } = await import(
          "./lib/workflow/next-cycle-dispatcher"
        );
        const result = await dispatchNextCycleInstruction({
          userId: ctx.user.id,
          campaignId: input.campaignId,
          instructionId: instruction.instructionId,
        });
        if (result.outcome === "already_dispatched") {
          return { outcome: "noop" as const, status: "dispatched" as const };
        }
        return {
          outcome: "retried_and_dispatched" as const,
          instructionId: result.instructionId,
          strategyRunId: result.strategyRunId,
          approvalRequestId: result.approvalRequestId,
        };
      } catch (err) {
        // The instruction is back to "ready": the dispatch can be retried.
        return {
          outcome: "retried_dispatch_failed" as const,
          status: "ready" as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
});
