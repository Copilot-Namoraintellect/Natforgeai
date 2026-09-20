import { env } from "../env";

/**
 * Central timeout authority for AI provider calls.
 *
 * Every call through the central runAgent boundary is governed here unless a
 * stricter caller deadline already applies (caller abort still wins over the
 * timeout, and the two compose via a single AbortController).
 *
 * The message deliberately contains "timeout" so the existing
 * provider/platform fault classification (refund + alert semantics in the
 * agent runner) keeps working without special-casing.
 */
export class ProviderTimeoutError extends Error {
  readonly code = "PROVIDER_TIMEOUT" as const;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`AI provider request timeout after ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isProviderTimeoutError(err: unknown): boolean {
  return (
    err instanceof ProviderTimeoutError ||
    (!!err && typeof err === "object" && (err as { code?: unknown }).code === "PROVIDER_TIMEOUT")
  );
}

export function getProviderTimeoutMs(): number {
  return env.aiProviderTimeoutMs;
}

export interface ProviderTimeoutOptions {
  signal?: AbortSignal | null;
  timeoutMs?: number;
}

/**
 * Run `fn` with an AbortSignal that fires when either the caller aborts or the
 * configured provider timeout elapses. The timeout timer is always cleared on
 * settle, so no unmanaged timer survives a completed or failed call.
 *
 * Rejection behaviour:
 * - caller abort (or a stricter caller deadline) wins: the original caller
 *   error is rethrown untouched;
 * - timeout fires first: rejects with a typed ProviderTimeoutError.
 */
export async function withProviderTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: ProviderTimeoutOptions = {}
): Promise<T> {
  const callerSignal = options.signal ?? null;
  const timeoutMs = options.timeoutMs ?? getProviderTimeoutMs();
  const controller = new AbortController();

  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    // Never keep the process alive solely for this timer.
    (timer as { unref?: () => void }).unref?.();
  }

  try {
    return await fn(controller.signal);
  } catch (error) {
    if (timedOut && !callerSignal?.aborted) {
      throw new ProviderTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
