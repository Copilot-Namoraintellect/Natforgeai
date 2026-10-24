/**
 * Policy Router (WBS-R5-E7).
 *
 * The server-side surface of the governed policy layer. Authority rules:
 * - the client may REQUEST evaluation of an action and supply the
 *   authoritative interpretation features; it can never supply risk,
 *   decision, approval or billing identity (zod strict + pure-contract
 *   guards reject smuggling, fail closed);
 * - business/campaign/publication ownership is re-verified server-side
 *   against durable rows on every call (cross-tenant requests fail closed);
 * - policy resolution, authority snapshots and persistence are all
 *   server-side;
 * - every accepted decision is durable, audited and explainable.
 *
 * No execution happens here: no provider calls, no charging, no publishing.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, and, desc } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { businesses, campaigns, publishingQueue, approvalRequests, policyDecisions } from "@db/schema";
import {
  buildMarketingActionRequest,
  MARKETING_ACTION_TYPES,
  MARKETING_PLATFORMS,
  ESTIMATED_COST_CLASSES,
  ActionRequestError,
} from "./lib/policy/action-request";
import {
  evaluateMarketingActionPolicy,
  type PolicyDecision,
  type PolicyEvaluationInput,
} from "./lib/policy/decision-engine";
import type { AuthoritativeIntelligence } from "./lib/policy/risk-classification";
import { INTELLIGENCE_SENTIMENTS, INTENT_CLASSES, validateAuthoritativeIntelligence } from "./lib/policy/risk-classification";
import {
  getActivePolicy,
  activatePolicyVersion,
  adoptDefaultPolicy,
} from "./lib/policy/policy-store";
import {
  recordPolicyDecision,
  getDecisionById,
  listDecisions,
  type PolicyDecisionDuplicateClassification,
} from "./lib/policy/policy-decision-store";
import {
  resolveCostAuthoritySnapshot,
  resolveVolumeAuthoritySnapshot,
  resolvePeriodAutonomousSpend,
  resolveProviderCapabilitySnapshot,
  resolveProviderRateSnapshot,
} from "./lib/policy/policy-authority-resolver";
import {
  buildMarketingActionApprovalCommand,
  type MarketingActionApprovalCommand,
} from "./lib/policy/marketing-action-approval";
import {
  buildPolicyDecisionAuditEvent,
  explainPolicyDecision,
} from "./lib/policy/policy-audit";
import { persistAuditEvent } from "./lib/audit/audit-store";
import { buildBusinessPolicyConfig, buildDefaultPolicyConfig } from "./lib/policy/policy-model";
import { POLICY_DECISIONS, RISK_TIERS } from "./lib/policy/policy-types";

const ACTION_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

const providerBindingSchema = z
  .object({
    integrationId: z.number().int().positive(),
    platform: z.enum(MARKETING_PLATFORMS),
    externalAccountRef: z.string().max(255).nullable().optional(),
  })
  .strict();

const intelligenceSchema = z
  .object({
    sourceInterpretationId: z.string().min(1).max(128),
    intelligenceVersion: z.string().min(1).max(128),
    sentiment: z.enum(INTELLIGENCE_SENTIMENTS),
    intentClass: z.enum(INTENT_CLASSES),
    confidence: z.number().min(0).max(1),
    containsPersonalData: z.boolean(),
    injectionSuspected: z.boolean(),
  })
  .strict();

const evaluateActionRequestInput = z
  .object({
    actionRequestId: z.string().regex(ACTION_REQUEST_ID_PATTERN),
    businessId: z.number().int().positive(),
    sourceSignalId: z.string().max(128).nullable().optional(),
    sourceInterpretationId: z.string().max(128).nullable().optional(),
    actionType: z.enum(MARKETING_ACTION_TYPES),
    platform: z.enum(MARKETING_PLATFORMS),
    providerAccountBinding: providerBindingSchema.nullable().optional(),
    campaignId: z.number().int().positive().nullable().optional(),
    publicationId: z.number().int().positive().nullable().optional(),
    estimatedCostClass: z.enum(ESTIMATED_COST_CLASSES),
    requestedAt: z.string(),
    contextVersion: z.string().min(1).max(128),
    intelligence: intelligenceSchema,
  })
  .strict();

function forbidden(message = "Insufficient permissions"): never {
  throw new TRPCError({ code: "FORBIDDEN", message });
}

function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/** Re-verify ownership of every referenced resource from durable rows. */
async function assertBusinessOwnership(userId: number, businessId: number): Promise<void> {
  const db = getDb();
  const [business] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(and(eq(businesses.id, businessId), eq(businesses.userId, userId)))
    .limit(1);
  if (!business) forbidden("Business not found or not owned by the authenticated user.");
}

async function assertCampaignOwnership(
  userId: number,
  businessId: number,
  campaignId: number
): Promise<void> {
  const db = getDb();
  const [campaign] = await db
    .select({ id: campaigns.id, businessId: campaigns.businessId })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);
  if (!campaign) forbidden("Campaign not found or not owned by the authenticated user.");
  if (campaign.businessId !== businessId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "OWNERSHIP_MISMATCH: campaign belongs to a different business.",
    });
  }
}

async function assertPublicationOwnership(userId: number, publicationId: number): Promise<void> {
  const db = getDb();
  const [item] = await db
    .select({ id: publishingQueue.id })
    .from(publishingQueue)
    .where(and(eq(publishingQueue.id, publicationId), eq(publishingQueue.userId, userId)))
    .limit(1);
  if (!item) forbidden("Publication not found or not owned by the authenticated user.");
}

function isDuplicateKeyError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const message = (err as { message?: string })?.message ?? "";
  return code === "ER_DUP_ENTRY" || /Duplicate entry/i.test(message);
}

/**
 * Persist the governed approval/escalation row for a decision. The
 * deterministic idempotency key guarantees one row per decision: duplicate
 * passes (retries, replays, re-evaluations) converge to the existing row.
 */
async function persistMarketingActionApproval(
  command: MarketingActionApprovalCommand
): Promise<number> {
  const db = getDb();
  try {
    const [result] = await db.insert(approvalRequests).values({
      userId: command.userId,
      campaignId: command.campaignId,
      approvalType: command.approvalType,
      title: command.title,
      description: command.description,
      aiRecommendation: command.aiRecommendation,
      riskLevel: command.riskLevel,
      status: "pending",
      idempotencyKey: command.idempotencyKey,
      context: command.context as unknown as Record<string, unknown>,
    });
    return Number((result as unknown as { insertId?: number | string }).insertId);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const [existing] = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(eq(approvalRequests.idempotencyKey, command.idempotencyKey))
      .limit(1);
    if (!existing) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Approval persistence conflict could not be resolved.",
      });
    }
    return existing.id;
  }
}

async function auditDecision(decision: PolicyDecision): Promise<void> {
  try {
    const event = buildPolicyDecisionAuditEvent({ decision, occurredAt: decision.evaluatedAt });
    await persistAuditEvent(event);
  } catch (err) {
    // Loud, retry-safe failure (R4 service-delegated audit pattern): the
    // decision stays durable; the audit ledger is fingerprint-deduplicated
    // so a later retry of the same event cannot duplicate it.
    console.error(
      `[Policy] Failed to persist policy_decision audit event for ${decision.policyDecisionId}:`,
      (err as Error)?.message
    );
  }
}

export const policyRouter = createRouter({
  /**
   * Evaluate one marketing action request and durably record the decision.
   * Idempotent: retries converge to the same durable decision.
   */
  evaluateActionRequest: authedQuery.input(evaluateActionRequestInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.user.id;
    await assertBusinessOwnership(userId, input.businessId);
    if (input.campaignId != null) {
      await assertCampaignOwnership(userId, input.businessId, input.campaignId);
    }
    if (input.publicationId != null) {
      await assertPublicationOwnership(userId, input.publicationId);
    }

    let request;
    try {
      request = buildMarketingActionRequest({
        actionRequestId: input.actionRequestId,
        businessId: input.businessId,
        sourceSignalId: input.sourceSignalId ?? null,
        sourceInterpretationId: input.sourceInterpretationId ?? null,
        actionType: input.actionType,
        platform: input.platform,
        providerAccountBinding: input.providerAccountBinding
          ? {
              integrationId: input.providerAccountBinding.integrationId,
              platform: input.providerAccountBinding.platform,
              externalAccountRef: input.providerAccountBinding.externalAccountRef ?? null,
            }
          : null,
        campaignId: input.campaignId ?? null,
        publicationId: input.publicationId ?? null,
        estimatedCostClass: input.estimatedCostClass,
        requestedAt: input.requestedAt,
        contextVersion: input.contextVersion,
      });
    } catch (err) {
      if (err instanceof ActionRequestError) badRequest(err.message);
      throw err;
    }

    let intelligence: AuthoritativeIntelligence;
    try {
      intelligence = validateAuthoritativeIntelligence(input.intelligence);
    } catch (err) {
      badRequest((err as Error).message);
    }

    const policy = await getActivePolicy(input.businessId);
    const [cost, volume, providerCapability, providerRate, periodAutonomousSpend] = await Promise.all([
      resolveCostAuthoritySnapshot(userId),
      resolveVolumeAuthoritySnapshot(input.businessId, input.platform),
      resolveProviderCapabilitySnapshot({ userId, businessId: input.businessId, request }),
      resolveProviderRateSnapshot(request),
      resolvePeriodAutonomousSpend(input.businessId),
    ]);
    cost.periodAutonomousSpend = periodAutonomousSpend;

    const evaluationInput: PolicyEvaluationInput = {
      request,
      userId,
      policy,
      intelligence,
      cost,
      volume,
      providerRate,
      providerCapability,
      now: new Date().toISOString(),
    };
    const decision = evaluateMarketingActionPolicy(evaluationInput);

    const recorded = await recordPolicyDecision(decision);
    let approvalRequestId: number | null = null;
    if (recorded.duplicateClassification === "none") {
      if (decision.decision === "REQUIRE_APPROVAL" && decision.approvalBinding) {
        const command = buildMarketingActionApprovalCommand({ decision, userId, mode: "approval" });
        approvalRequestId = await persistMarketingActionApproval(command);
      } else if (decision.decision === "ESCALATE") {
        const command = buildMarketingActionApprovalCommand({ decision, userId, mode: "escalation" });
        approvalRequestId = await persistMarketingActionApproval(command);
      }
    }

    await auditDecision(recorded.decision);

    return {
      decision: recorded.decision,
      duplicateClassification: recorded.duplicateClassification as PolicyDecisionDuplicateClassification,
      approvalRequestId,
    };
  }),

  getDecision: authedQuery
    .input(z.object({ policyDecisionId: z.string().min(1).max(64) }).strict())
    .query(async ({ ctx, input }) => {
      const decision = await getDecisionById(input.policyDecisionId);
      if (!decision || decision.userId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Policy decision not found." });
      }
      return decision;
    }),

  explainDecision: authedQuery
    .input(z.object({ policyDecisionId: z.string().min(1).max(64) }).strict())
    .query(async ({ ctx, input }) => {
      const decision = await getDecisionById(input.policyDecisionId);
      if (!decision || decision.userId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Policy decision not found." });
      }
      return explainPolicyDecision(decision);
    }),

  listDecisions: authedQuery
    .input(
      z
        .object({
          businessId: z.number().int().positive(),
          decision: z.enum(POLICY_DECISIONS).optional(),
          limit: z.number().int().positive().max(500).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      await assertBusinessOwnership(ctx.user.id, input.businessId);
      return listDecisions({
        businessId: input.businessId,
        decision: input.decision,
        limit: input.limit,
      });
    }),

  getPolicy: authedQuery
    .input(z.object({ businessId: z.number().int().positive() }).strict())
    .query(async ({ ctx, input }) => {
      await assertBusinessOwnership(ctx.user.id, input.businessId);
      const policy = await getActivePolicy(input.businessId);
      return {
        policy,
        isDefaultAdopted: policy !== null,
        availableDefaults: buildDefaultPolicyConfig(),
      };
    }),

  adoptDefaultPolicy: authedQuery
    .input(z.object({ businessId: z.number().int().positive() }).strict())
    .mutation(async ({ ctx, input }) => {
      await assertBusinessOwnership(ctx.user.id, input.businessId);
      return adoptDefaultPolicy({ userId: ctx.user.id, businessId: input.businessId });
    }),

  /** Replace the business policy with a new validated version. */
  setPolicy: authedQuery
    .input(
      z
        .object({
          businessId: z.number().int().positive(),
          config: z.record(z.string(), z.unknown()),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await assertBusinessOwnership(ctx.user.id, input.businessId);
      let config;
      try {
        config = buildBusinessPolicyConfig(input.config);
      } catch (err) {
        badRequest((err as Error).message);
      }
      return activatePolicyVersion({
        userId: ctx.user.id,
        businessId: input.businessId,
        config,
      });
    }),

  /** Operator surface: cross-business decision visibility for admins. */
  adminListDecisions: adminQuery
    .input(
      z
        .object({
          decision: z.enum(POLICY_DECISIONS).optional(),
          riskClass: z.enum(RISK_TIERS).optional(),
          businessId: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(500).optional(),
        })
        .strict()
    )
    .query(async ({ input }) => {
      const limit = Math.min(input.limit ?? 200, 500);
      const db = getDb();
      const conditions = [];
      if (input.businessId) conditions.push(eq(policyDecisions.businessId, input.businessId));
      if (input.decision) conditions.push(eq(policyDecisions.decision, input.decision));
      // and() over an empty list yields undefined, which where() treats as
      // no-op, keeping a single query shape.
      const rows = await db
        .select()
        .from(policyDecisions)
        .where(and(...conditions))
        .orderBy(desc(policyDecisions.evaluatedAt))
        .limit(limit);
      const filtered = input.riskClass ? rows.filter((r) => r.riskClass === input.riskClass) : rows;
      return filtered.map((r) => ({
        policyDecisionId: r.policyDecisionId,
        businessId: Number(r.businessId),
        actionType: r.actionType,
        platform: r.platform,
        decision: r.decision,
        riskClass: r.riskClass,
        reasonCodes: r.reasonCodes,
        evaluatedAt: r.evaluatedAt,
        expiresAt: r.expiresAt,
      }));
    }),
});
