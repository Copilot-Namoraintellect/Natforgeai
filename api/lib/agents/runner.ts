import { generateObject } from "ai";
import { z } from "zod";
import { defaultModel } from "./openai";
import { getDb } from "../../queries/connection";
import { agentRuns } from "@db/schema";
import { eq } from "drizzle-orm";
import { deductCredits, recordAiUsage, checkCredits, adminAdjustCredits } from "../billing/credit-engine";
import { getEstimatedAgentCost, calculateTokenCost } from "../billing/cost-tracker";
import { enforceCostControl } from "../billing/cost-control";
import { TRPCError } from "@trpc/server";
import {
  isInsufficientQuotaError,
  isProviderOrPlatformError,
  emitAgentProviderAlert,
} from "./provider-error";

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
  | "optimisation";

export interface AgentRunOptions<TOutput> {
  userId: number;
  campaignId?: number;
  agentType: AgentType;
  prompt: string;
  schema: z.ZodSchema<TOutput>;
  system?: string;
  skipBilling?: boolean;
  abortSignal?: AbortSignal;
}

export interface AgentRunResult<TOutput> {
  runId: number;
  output: TOutput;
  promptTokens?: number;
  completionTokens?: number;
  actualCostUsdMicro?: number;
  estimatedCostUsdMicro?: number;
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
}: AgentRunOptions<TOutput>): Promise<AgentRunResult<TOutput>> {
  const db = getDb();

  // In test mode, never charge a live wallet unless explicitly requested.
  const shouldSkipBilling = skipBilling ?? isTestMode();

  // Pre-flight billing check with cost control enforcement
  let creditsDeducted = 0;
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
    const result = await generateObject({
      model: defaultModel,
      system:
        system ??
        "You are an expert marketing AI agent. Respond with structured, actionable output.",
      prompt,
      schema,
      abortSignal,
    });

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

    if ((isSchemaError || isProviderError) && creditsDeducted > 0 && !shouldSkipBilling) {
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
