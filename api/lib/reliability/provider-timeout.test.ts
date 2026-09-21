import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderTimeoutError,
  getProviderTimeoutMs,
  isProviderTimeoutError,
  withProviderTimeout,
} from "./provider-timeout";
import {
  isInsufficientQuotaError,
  isProviderOrPlatformError,
} from "../agents/provider-error";

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

/** Simulates a provider call that hangs until its signal aborts. */
function hungProvider<T>() {
  return (signal: AbortSignal) =>
    new Promise<T>((_resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
}

describe("withProviderTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("provider resolving before the timeout succeeds and leaves no pending timer", async () => {
    let governedSignal: AbortSignal | undefined;
    const result = await withProviderTimeout(
      async (signal) => {
        governedSignal = signal;
        return "ok";
      },
      { timeoutMs: 1000 }
    );

    expect(result).toBe("ok");
    expect(governedSignal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("provider exceeding the timeout rejects with a typed, classifiable timeout error", async () => {
    const promise = withProviderTimeout(hungProvider<string>(), { timeoutMs: 1000 });
    const handled = promise.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);

    const error = await handled;
    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect(isProviderTimeoutError(error)).toBe(true);
    expect(error.code).toBe("PROVIDER_TIMEOUT");
    expect(error.timeoutMs).toBe(1000);
    // Must classify as a provider/platform fault (not a quota error) so the
    // existing agent refund/alert semantics apply unchanged.
    expect(isProviderOrPlatformError(error)).toBe(true);
    expect(isInsufficientQuotaError(error)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caller abort wins over the timeout and rethrows the original error", async () => {
    const caller = new AbortController();
    const promise = withProviderTimeout(hungProvider<string>(), {
      signal: caller.signal,
      timeoutMs: 1000,
    });

    caller.abort();
    const error = await promise.catch((e) => e);

    expect(error).not.toBeInstanceOf(ProviderTimeoutError);
    expect(isProviderTimeoutError(error)).toBe(false);
    expect(error.name).toBe("AbortError");
    // Caller abort must cancel the timeout timer as well.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an already-aborted caller signal rejects immediately without starting a timer", async () => {
    const caller = new AbortController();
    caller.abort();

    const error = await withProviderTimeout(hungProvider<string>(), {
      signal: caller.signal,
      timeoutMs: 1000,
    }).catch((e) => e);

    expect(error.name).toBe("AbortError");
    expect(isProviderTimeoutError(error)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("non-positive timeout disables the timer while the governed signal still applies", async () => {
    const result = await withProviderTimeout(async () => "ok", { timeoutMs: 0 });
    expect(result).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("default timeout is centrally configured and finite", () => {
    const timeoutMs = getProviderTimeoutMs();
    expect(Number.isFinite(timeoutMs)).toBe(true);
    expect(timeoutMs).toBeGreaterThan(0);
  });
});
