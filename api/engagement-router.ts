/**
 * Engagement Router (WBS-R5-C surface).
 *
 * The authenticated tRPC surface for governed autonomous engagement.
 * Authority rules:
 *
 * - every procedure is authed; business ownership is re-verified from
 *   durable rows on every call (cross-tenant access fails closed);
 * - the client supplies ONLY: business id, signal/interpretation identities,
 *   action type, platform, and (for provider actions) the integration id.
 *   Risk/policy/approval/billing fields do not exist on this surface — they
 *   are server-derived and any smuggled field is rejected by strict schemas;
 * - planning runs the real R5-E engine; execution re-asserts the R5-E gate;
 * - the provider transport is env-gated OFF by default: with the transport
 *   disabled, provider-capable executions fail closed (blocked
 *   configuration). No live provider call can originate from this branch.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import {
  businesses,
  engagementExecutions,
  engagementResponseContents,
} from "@db/schema";
import { env } from "./lib/env";
import { ENGAGEMENT_ACTION_TYPES } from "./lib/engagement/action-request";
import { planEngagementAction } from "./lib/engagement/planning";
import {
  executeEngagementAction,
  reconcileEngagementExecution,
  EngagementExecutionError,
} from "./lib/engagement/execution";
import {
  createDrizzleSourceAuthority,
  EngagementSourceError,
  type EngagementSourceAuthority,
} from "./lib/engagement/source-loader";
import {
  createMetaEngagementGateway,
  createMetaTransport,
  type EngagementProviderGateway,
} from "./lib/engagement/provider-boundary";
import {
  getExecutionByActionRequest,
  getReceiptByExecutionId,
  type EngagementExecutionRecord,
  type EngagementReceiptRecord,
} from "./lib/engagement/execution-store";

const ENGAGEMENT_PLATFORMS = ["facebook", "instagram"] as const;

const planInput = z
  .object({
    businessId: z.number().int().positive(),
    signalId: z.string().min(1).max(128),
    interpretationId: z.string().min(1).max(64),
    actionType: z.enum(ENGAGEMENT_ACTION_TYPES),
    platform: z.enum(ENGAGEMENT_PLATFORMS),
    integrationId: z.number().int().positive().nullable().optional(),
    externalTarget: z.string().min(1).max(255).optional(),
    campaignId: z.number().int().positive().nullable().optional(),
    publicationId: z.number().int().positive().nullable().optional(),
  })
  .strict();

function forbidden(message = "Insufficient permissions"): never {
  throw new TRPCError({ code: "FORBIDDEN", message });
}

function notFound(message: string): never {
  throw new TRPCError({ code: "NOT_FOUND", message });
}

function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

function mapEngagementError(err: unknown): never {
  if (err instanceof EngagementExecutionError) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${err.code}: ${err.message}` });
  }
  const code = (err as { code?: string })?.code;
  if (code) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: (err as Error).message });
  }
  throw err;
}

async function assertBusinessOwnership(userId: number, businessId: number) {
  const db = getDb();
  const [business] = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      tone: businesses.tone,
      brandVoiceNotes: businesses.brandVoiceNotes,
      avoidWords: businesses.avoidWords,
    })
    .from(businesses)
    .where(and(eq(businesses.id, businessId), eq(businesses.userId, userId)))
    .limit(1);
  if (!business) forbidden("Business not found or not owned by the authenticated user.");
  return business;
}

/**
 * The provider gateway for this process. NULL unless the operator has
 * explicitly enabled the live transport — the fail-closed default keeps
 * every provider-capable execution on durable blocked-configuration state.
 */
let gatewaySingleton: EngagementProviderGateway | null | undefined;
function resolveGateway(): EngagementProviderGateway | null {
  if (gatewaySingleton !== undefined) return gatewaySingleton;
  gatewaySingleton = env.engagementProviderTransportEnabled
    ? createMetaEngagementGateway(createMetaTransport())
    : null;
  return gatewaySingleton;
}

let sourceAuthoritySingleton: EngagementSourceAuthority | undefined;
function resolveSourceAuthority(): EngagementSourceAuthority {
  if (!sourceAuthoritySingleton) {
    sourceAuthoritySingleton = createDrizzleSourceAuthority();
  }
  return sourceAuthoritySingleton;
}

function summarizeExecution(row: EngagementExecutionRecord) {
  return {
    executionId: row.executionId,
    actionRequestId: row.actionRequestId,
    businessId: Number(row.businessId),
    signalId: row.signalId,
    interpretationId: row.interpretationId,
    policyDecisionId: row.policyDecisionId,
    approvalRequestId: row.approvalRequestId,
    responseContentId: row.responseContentId,
    responseContentVersion: row.responseContentVersion,
    provider: row.provider,
    platform: row.platform,
    actionType: row.actionType,
    externalTarget: row.externalTarget,
    status: row.status,
    attempt: row.attempt,
    providerOperationIdentity: row.providerOperationIdentity,
    reconciliationState: row.reconciliationState,
    failureClass: row.failureClass,
    lastError: row.lastError,
  };
}

function summarizeReceipt(row: EngagementReceiptRecord) {
  return {
    engagementReceiptId: row.engagementReceiptId,
    executionId: row.executionId,
    actionRequestId: row.actionRequestId,
    policyDecisionId: row.policyDecisionId,
    approvalRequestId: row.approvalRequestId,
    responseContentId: row.responseContentId,
    responseContentVersion: row.responseContentVersion,
    provider: row.provider,
    externalTarget: row.externalTarget,
    providerOperationIdentity: row.providerOperationIdentity,
    providerExternalReceipt: row.providerExternalReceipt,
    executedAt: row.executedAt,
    status: row.status,
    reconciliationState: row.reconciliationState,
  };
}

export const engagementRouter = createRouter({
  /**
   * Plan one governed engagement action: canonical action request → R5-E
   * policy evaluation → governed generation (when executable) → durable
   * execution row. Idempotent under duplicate calls.
   */
  plan: authedQuery.input(planInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.user.id;
    const business = await assertBusinessOwnership(userId, input.businessId);

    const authority = resolveSourceAuthority();
    let signal;
    let interpretation;
    try {
      signal = await authority.loadSignal(input.signalId, userId);
      interpretation = await authority.loadInterpretation(input.interpretationId, userId);
    } catch (err) {
      if (err instanceof EngagementSourceError) badRequest(`${err.code}: ${err.message}`);
      throw err;
    }
    if (!signal) notFound("Signal not found or not owned by the authenticated user.");
    if (!interpretation) notFound("Interpretation not found or not owned by the authenticated user.");

    try {
      const plan = await planEngagementAction({
        userId,
        businessId: input.businessId,
        signal,
        interpretation,
        actionType: input.actionType,
        platform: input.platform,
        integrationId: input.integrationId ?? null,
        externalTarget: input.externalTarget ?? "",
        campaignId: input.campaignId ?? null,
        publicationId: input.publicationId ?? null,
        brand: {
          businessName: business.name,
          tone: business.tone,
          brandVoiceNotes: business.brandVoiceNotes,
          avoidWords: business.avoidWords,
        },
      });

      return {
        actionRequestId: plan.actionRequestId,
        responseContextVersion: plan.responseContextVersion,
        decision: plan.decision.decision,
        riskClass: plan.decision.riskClass,
        reasonCodes: plan.decision.reasonCodes,
        policyDecisionId: plan.decision.policyDecisionId,
        approvalRequired: plan.decision.approvalRequired,
        approvalRequestId: plan.approvalRequestId,
        billingIdentity: plan.decision.billingIdentity,
        responseContentId: plan.responseContentId,
        responseContentVersion: plan.responseContentVersion,
        execution: plan.execution ? summarizeExecution(plan.execution) : null,
        duplicateClassification: plan.duplicateClassification,
      };
    } catch (err) {
      mapEngagementError(err);
    }
  }),

  /**
   * Drive one execution now. For ALLOW_AUTONOMOUS decisions this executes
   * immediately; for approval-bound actions it no-ops with the gate reason
   * until the exact approval lands. Idempotent; concurrency-safe.
   */
  execute: authedQuery
    .input(z.object({ actionRequestId: z.string().min(1).max(128) }).strict())
    .mutation(async ({ ctx, input }) => {
      const execution = await getExecutionByActionRequest(input.actionRequestId);
      if (!execution || Number(execution.userId) !== ctx.user.id) {
        notFound("Engagement execution not found.");
      }
      try {
        const outcome = await executeEngagementAction(
          { actionRequestId: input.actionRequestId },
          { gateway: resolveGateway() ?? undefined }
        );
        const receipt = await getReceiptByExecutionId(execution.executionId);
        return {
          outcome: outcome.kind,
          execution: summarizeExecution(
            (await getExecutionByActionRequest(input.actionRequestId)) ?? execution
          ),
          receipt: receipt ? summarizeReceipt(receipt) : null,
        };
      } catch (err) {
        mapEngagementError(err);
      }
    }),

  /** Reconcile an ambiguous/crashed execution (owner-scoped). */
  reconcile: authedQuery
    .input(z.object({ actionRequestId: z.string().min(1).max(128) }).strict())
    .mutation(async ({ ctx, input }) => {
      const execution = await getExecutionByActionRequest(input.actionRequestId);
      if (!execution || Number(execution.userId) !== ctx.user.id) {
        notFound("Engagement execution not found.");
      }
      try {
        const outcome = await reconcileEngagementExecution(
          { executionId: execution.executionId },
          { gateway: resolveGateway() ?? undefined }
        );
        const receipt = await getReceiptByExecutionId(execution.executionId);
        return {
          outcome: outcome.kind,
          receipt: receipt ? summarizeReceipt(receipt) : null,
        };
      } catch (err) {
        mapEngagementError(err);
      }
    }),

  /** Owner-scoped execution detail incl. receipt. */
  get: authedQuery
    .input(z.object({ actionRequestId: z.string().min(1).max(128) }).strict())
    .query(async ({ ctx, input }) => {
      const execution = await getExecutionByActionRequest(input.actionRequestId);
      if (!execution || Number(execution.userId) !== ctx.user.id) {
        notFound("Engagement execution not found.");
      }
      const receipt = await getReceiptByExecutionId(execution.executionId);
      const [content] = await getDb()
        .select({
          responseContentId: engagementResponseContents.responseContentId,
          version: engagementResponseContents.version,
          contentHash: engagementResponseContents.contentHash,
          status: engagementResponseContents.status,
        })
        .from(engagementResponseContents)
        .where(
          and(
            eq(engagementResponseContents.responseContentId, execution.responseContentId),
            eq(engagementResponseContents.version, execution.responseContentVersion)
          )
        )
        .limit(1);
      return {
        execution: summarizeExecution(execution),
        receipt: receipt ? summarizeReceipt(receipt) : null,
        content: content ?? null,
      };
    }),

  /** Owner-scoped execution listing for the business. */
  list: authedQuery
    .input(
      z
        .object({
          businessId: z.number().int().positive(),
          status: z.string().min(1).max(24).optional(),
          limit: z.number().int().positive().max(200).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      await assertBusinessOwnership(ctx.user.id, input.businessId);
      const db = getDb();
      const conditions = [eq(engagementExecutions.businessId, input.businessId)];
      if (input.status) conditions.push(eq(engagementExecutions.status, input.status));
      const rows = await db
        .select()
        .from(engagementExecutions)
        .where(and(...conditions))
        .orderBy(desc(engagementExecutions.createdAt))
        .limit(Math.min(input.limit ?? 50, 200));
      return rows.map(summarizeExecution);
    }),
});
