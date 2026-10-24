import { generateObject } from "ai";
import { z } from "zod";
import { defaultModel } from "./openai";
import { getDb } from "../../queries/connection";
import { agentRuns } from "@db/schema";
import { eq } from "drizzle-orm";
import { deductCredits, recordAiUsage, checkCredits, adminAdjustCredits } from "../billing/credit-engine";
import {
  releaseWalletCredits,
  reserveWalletCredits,
  settleWalletCredits,
} from "../billing/credit-reservation-engine";
import { CreditReservationError } from "../billing/credit-reservation";
import { getEstimatedAgentCost, calculateTokenCost } from "../billing/cost-tracker";
import { enforceCostControl } from "../billing/cost-control";
import { TRPCError } from "@trpc/server";
import {
  isInsufficientQuotaError,
  isProviderOrPlatformError,
  emitAgentProviderAlert,
} from "./provider-error";
import { withProviderTimeout } from "../reliability/provider-timeout";

export function isTestMode(): boolean {
  return (
    process.env.NATFORGE_TEST_MODE === "true" ||
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test"
  );
}

export type AgentType =
  | "strategy"
  | "creative"
  | "audience"
  | "distribution"
  | "engagement"
  | "sales"
  | "optimisation"
  | "interpretation";

export interface AgentRunOptions<TOutput> {
  userId: number;
  campaignId?: number;
  agentType: AgentType;
  prompt: string;
  schema: z.ZodSchema<TOutput>;
  system?: string;
  skipBilling?: boolean;
  abortSignal?: AbortSignal;
  /**
   * Caller-stable billing identity (minted at the workflow trigger boundary).
   * When provided, the deduction is recorded under this idempotency key so
   * retries of the same logical step collapse onto one durable charge.
   * When omitted, the legacy unkeyed deduction behaviour is preserved.
   */
  billingIdempotencyKey?: string;
}

export interface AgentRunResult<TOutput> {
  runId: number;
  output: TOutput;
  promptTokens?: number;
  completionTokens?: number;
  actualCostUsdMicro?: number;
  estimatedCostUsdMicro?: number;
}

/**
 * Deterministic settle/release keys for the governed reservation authority
 * (WBS-R3.1 / GAP18). Pure functions of the caller-stable billing identity,
 * so a retried logical step reconciles the same reservation at most once.
 */
export function buildAgentRunBillingSettleKey(billingIdempotencyKey: string): string {
  return `${billingIdempotencyKey}:settle`;
}

export function buildAgentRunBillingReleaseKey(billingIdempotencyKey: string): string {
  return `${billingIdempotencyKey}:release`;
}

export async function runAgent<TOutput>({
  userId,
  campaignId,
  agentType,
  prompt,
  schema,
  system,
  skipBilling,
  abortSignal,
  billingIdempotencyKey,
}: AgentRunOptions<TOutput>): Promise<AgentRunResult<TOutput>> {
  const db = getDb();

  // In test mode, never charge a live wallet unless explicitly requested.
  const shouldSkipBilling = skipBilling ?? isTestMode();

  // Pre-flight billing check with cost control enforcement
  let creditsDeducted = 0;
  let reservationId: string | null = null;
  if (!shouldSkipBilling) {
    const estimatedCost = getEstimatedAgentCost(agentType);

    // Enforce daily/monthly limits
    const costControl = await enforceCostControl(userId, estimatedCost);
    if (!costControl.allowed) {
      throw new TRPCError({
        code: "PAYMENT_REQUIRED",
        message: costControl.reason || `Insufficient credits.`,
      });
    }

    if (billingIdempotencyKey) {
      // Governed hold for the caller-stable forward billing identity
      // (WBS-R3.1 / GAP18): reserve -> settle on chargeable completion or
      // release on the existing refund classes. Replaces the legacy up-front
      // keyed deduction on this path only; settlement still deducts through
      // the accepted deductCredits ledger inside settleWalletCredits.
      try {
        const { reservation } = await reserveWalletCredits({
          userId,
          campaignId: campaignId ?? null,
          reservationReference: billingIdempotencyKey,
          externalIdempotencyKey: billingIdempotencyKey,
          amount: estimatedCost,
          reason: `${agentType} agent execution`,
          agentType,
          asOf: new Date().toISOString(),
        });
        reservationId = reservation.reservationId;
      } catch (error) {
        if (error instanceof CreditReservationError) {
          throw new TRPCError({
            code: "PAYMENT_REQUIRED",
            message: error.message,
          });
        }
        throw error;
      }
    } else {
      const preCheck = await checkCredits(userId, estimatedCost);
      if (!preCheck.hasCredits) {
        throw new TRPCError({
          code: "PAYMENT_REQUIRED",
          message: `Insufficient credits. You have ${preCheck.balance} credits. This operation requires ${estimatedCost} credits. Upgrade your plan or purchase more credits.`,
        });
      }
      await deductCredits({
        userId,
        amount: estimatedCost,
        type: "agent_deduction",
        description: `${agentType} agent execution`,
        metadata: { agentType, campaignId, estimatedCost },
      });
      creditsDeducted = estimatedCost;
    }
  }

  // Create agent run record
  const [insertResult] = await db.insert(agentRuns).values({
    userId,
    campaignId: campaignId ?? null,
    agentType,
    status: "running",
    input: { prompt, system },
    startedAt: new Date(),
  });

  const runId = Number(insertResult.insertId);

  try {
    const result = await withProviderTimeout(
      (signal) =>
        generateObject({
          model: defaultModel,
          system:
            system ??
            "You are an expert marketing AI agent. Respond with structured, actionable output.",
          prompt,
          schema,
          abortSignal: signal,
        }),
      { signal: abortSignal }
    );

    const object = result.object;
    const usage = (result as any).usage;

    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;

    // Calculate actual cost
    const { actualCostUsdMicro, estimatedCostUsdMicro } = calculateTokenCost(
      defaultModel as any,
      promptTokens,
      completionTokens
    );

    // Record AI usage
    if (!shouldSkipBilling) {
      if (reservationId && billingIdempotencyKey) {
        // Chargeable completion: settle the governed hold. The deduction is
        // idempotent under the deterministic settle key; a failure here is
        // propagated (fail closed) — the hold stays reserved and is
        // reconciled by an idempotent retry of the same billing identity.
        const { reservation } = await settleWalletCredits({
          reservationId,
          settleKey: buildAgentRunBillingSettleKey(billingIdempotencyKey),
          description: `${agentType} agent execution`,
          asOf: new Date().toISOString(),
        });
        creditsDeducted = reservation.settledAmount ?? creditsDeducted;
      }
      await recordAiUsage({
        userId,
        campaignId,
        agentType,
        model: "gpt-4o-mini",
        promptTokens,
        completionTokens,
        actualCostUsdMicro,
        estimatedCostUsdMicro,
        creditsDeducted,
        metadata: { runId },
      });
    }

    // Update run as completed
    await db
      .update(agentRuns)
      .set({
        status: "completed",
        output: object as any,
        completedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));

    return {
      runId,
      output: object,
      promptTokens,
      completionTokens,
      actualCostUsdMicro,
      estimatedCostUsdMicro,
    };
  } catch (error: any) {
    // Update run as failed
    await db
      .update(agentRuns)
      .set({
        status: "failed",
        error: error.message || String(error),
        completedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));

    // Determine if this is an internal/platform fault (refund) or user fault (no refund)
    const isSchemaError =
      error.message?.includes("schema") ||
      error.message?.includes("response_format") ||
      error.message?.includes("Missing required") ||
      error.message?.includes("Invalid schema");
    const isProviderError = isProviderOrPlatformError(error);

    const isQuotaError = isInsufficientQuotaError(error);

    if (billingIdempotencyKey && reservationId) {
      // Governed reconciliation (WBS-R3.1 / GAP18): mirror the legacy refund
      // classes exactly — provider/schema failures release the hold (no
      // charge); any other failure settles (charge retained, as the legacy
      // path retained the up-front deduction). Best-effort + logged, matching
      // the existing refund convention; the original error always propagates.
      try {
        if (isSchemaError || isProviderError) {
          await releaseWalletCredits({
            reservationId,
            releaseKey: buildAgentRunBillingReleaseKey(billingIdempotencyKey),
            reason: isQuotaError
              ? "provider_quota_error"
              : isProviderError
                ? "provider_error"
                : "schema_error",
            asOf: new Date().toISOString(),
          });
        } else {
          await settleWalletCredits({
            reservationId,
            settleKey: buildAgentRunBillingSettleKey(billingIdempotencyKey),
            description: `${agentType} agent execution`,
            asOf: new Date().toISOString(),
          });
        }
      } catch (billingErr: any) {
        console.error(
          `[AgentRunner] Reservation reconciliation failed for user ${userId}:`,
          billingErr?.message
        );
      }
    } else if ((isSchemaError || isProviderError) && creditsDeducted > 0 && !shouldSkipBilling) {
      // Refund credits for internal failures
      try {
        await adminAdjustCredits({
          userId,
          amount: creditsDeducted,
          description: `Refund for failed ${agentType} agent run (#${runId}) due to ${isSchemaError ? "schema error" : isQuotaError ? "OpenAI quota/billing error" : "provider error"}`,
          adminUserId: 0, // system refund
        });
        console.log(`[AgentRunner] Refunded ${creditsDeducted} credits to user ${userId} for failed ${agentType} run ${runId}`);
      } catch (refundErr: any) {
        console.error(`[AgentRunner] Credit refund failed for user ${userId}:`, refundErr.message);
      }
    }

    if (isQuotaError || isProviderError) {
      await emitAgentProviderAlert({ agentType, runId, userId, error }).catch(() => {});
    }

    throw error;
  }
}
