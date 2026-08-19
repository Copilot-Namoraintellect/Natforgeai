import { createAlert } from "../alerts";

/**
 * Detect OpenAI quota, rate-limit or billing exhaustion errors.
 * Mirrors the canonical classification previously inline in runner.ts.
 */
export function isInsufficientQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const error = err as any;
  const statusCode = error.statusCode ?? error.status ?? error.response?.status;
  const code = error.code ?? error.error?.code ?? error.response?.data?.error?.code;
  const message = error.message || error.error?.message || "";
  return (
    statusCode === 429 ||
    code === "insufficient_quota" ||
    message.toLowerCase().includes("insufficient_quota") ||
    message.toLowerCase().includes("exceeded your current quota") ||
    message.toLowerCase().includes("billing")
  );
}

/**
 * Detect provider/platform failures (OpenAI, fetch, timeout, connection refused,
 * HTTP 5xx). Does not include quota errors; classify quota separately.
 */
export function isProviderOrPlatformError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const error = err as any;
  return (
    error.message?.includes("OpenAI") ||
    error.message?.includes("fetch") ||
    error.message?.includes("timeout") ||
    error.message?.includes("ECONNREFUSED") ||
    error.statusCode >= 500
  );
}

/**
 * Emit the canonical openai provider/quota alert used by agent runners.
 * Mirrors the alert behaviour previously inline in runner.ts.
 * Safe to await with .catch(() => {}) so alert failure never hides the
 * original agent error.
 */
export async function emitAgentProviderAlert({
  agentType,
  runId,
  userId,
  error,
}: {
  agentType: string;
  runId: number;
  userId: number;
  error: unknown;
}): Promise<void> {
  if (!error || typeof error !== "object") return;
  const err = error as any;
  const isQuotaError = isInsufficientQuotaError(error);
  const isProviderError = isProviderOrPlatformError(error);

  if (isQuotaError) {
    await createAlert({
      severity: "critical",
      category: "openai",
      message: `OpenAI quota/billing exhausted: ${err.message || String(err)}`,
      details: {
        agentType,
        runId,
        userId,
        errorCode: err.code,
        statusCode: err.statusCode ?? err.status,
      },
    }).catch(() => {});
  } else if (isProviderError) {
    await createAlert({
      severity: "critical",
      category: "openai",
      message: `AI provider error: ${err.message || String(err)}`,
      details: { agentType, runId, userId },
    }).catch(() => {});
  }
}
